import { basename, join } from "node:path";
import { coordinatorTrailingWaitMs } from "../core/lane/waits.ts";
import { COORDINATOR_PATH } from "../core/ledger/codec.ts";
import { claim, claimCoordinator, failAttempt, takeOverStale, type AdoptedPr, type LedgerEdit } from "../core/ledger/edits.ts";
import type { CoordinatorKind, CoordinatorUnit } from "../core/next/coordinator.ts";
import { next } from "../core/next/next.ts";
import { assembleSnapshot } from "../core/next/snapshot.ts";
import { err, ok, type Result } from "../core/result.ts";
import type { Lane } from "../core/schemas/host.ts";
import type { LaneOutcome, UnitJournalRecord } from "../core/schemas/journal.ts";
import { CoordinatorRecordSchema, type CoordinatorRecord, type LaneIdentity, type UnitRecord, type UnitState } from "../core/schemas/ledger.ts";
import type { Snapshot } from "../core/schemas/snapshot.ts";
import type { Agent } from "../ports/agent.ts";
import { isLaneStopKind, type CallOpts, type Forge, type ForgeResult } from "../ports/forge.ts";
import type { LaneStore } from "../ports/lane-store.ts";
import { startCoordinatorHeartbeat, startHeartbeat, type Heartbeat } from "./heartbeat.ts";
import { DEFAULT_CALL_TIMEOUT_MS, MAX_CLAIM_ROUNDS, readsPath, writtenRecord, type LaneProcessResult, type PrStepOutput } from "./lane-process.ts";
import { swapLedger, type Sleep } from "./ledger-cas.ts";
import { laneLayout, logFileName } from "./lane-store.ts";
import type { Waiter, WaitResult } from "./wait.ts";

/**
 * The coordinator process (FR4, AR9, AR14, AD-8, AD-13): one round per run,
 * like the builder's. `lane run` claims `coordinator.json` as its last start
 * check (`claimCoordinatorRecord`); the process then writes `lane.pid` and
 * starts a `coordinator.json` keeper at once, which beats every 5 minutes
 * through the round and the trailing wait and never releases. A lost or
 * lapsed claim aborts its signal and the run ends `failed`.
 *
 * After the STOP check and the snapshot (`role: coordinator`), `next` picks a
 * coordinator unit. Each unit kind's work is an injected step; a kind with
 * no step is not claimed, and the run ends `idle` naming the Story that adds
 * it. With a step, the unit is claimed (a stale `claimed` record taken
 * over), its own keeper starts, the step runs and one unit record is
 * journaled. A step that leaves its unit `merging` stops the unit's keeper:
 * coordinator-held `merging` records have no heartbeat (AD-6). The trailing
 * wait after `idle` is 10 min, matching the `reconcile` due rule; other
 * outcomes keep the builder's waits.
 */

/** What a coordinator step gets: the claimed unit and the snapshot it was picked from. */
export type CoordinatorStepInput = {
  readonly unit: CoordinatorUnit;
  /** The claimed ledger record. */
  readonly record: UnitRecord;
  readonly snapshot: Snapshot;
  /** `main`'s file texts as the snapshot read them (`readsPath`), by repo path. */
  readonly files: Readonly<Record<string, string>>;
  /** Aborted when the unit or the coordinator claim is lost. */
  readonly signal: AbortSignal;
  /** Writes a note to the unit log. */
  readonly log: (text: string) => void;
};

/** One coordinator unit kind's work. Never throws. */
export type CoordinatorStep = (input: CoordinatorStepInput) => Promise<PrStepOutput>;

export type CoordinatorSteps = Partial<Readonly<Record<CoordinatorKind, CoordinatorStep>>>;

/** The Story that wires each coordinator step. */
export const STEP_STORY: Readonly<Record<CoordinatorKind, string>> = {
  reconcile: "2.5",
  planning: "2.7",
  retro: "2.9",
  "retro-item": "2.10",
  checkpoint: "4.4",
};

/** The idle reason for a unit kind with no step. */
export function missingStepReason(kind: CoordinatorKind): string {
  return `no ${kind} step (Story ${STEP_STORY[kind]})`;
}

export type CoordinatorDeps = {
  readonly forge: Forge;
  /** The lane's agent; the journal records its default model when the lane sets none. */
  readonly agent: Agent;
  readonly store: LaneStore;
  /** The lane folder (AR37). */
  readonly laneDir: string;
  /** `<owner>/<host>/coordinator`. */
  readonly identity: LaneIdentity;
  readonly lane: Lane;
  /** The `coordinator.json` record the start check wrote. */
  readonly claim: CoordinatorRecord;
  /** The step per unit kind; `lane run` wires `reconcile` (Story 2.5). */
  readonly steps: CoordinatorSteps;
  /** The PID `lane.pid` records; default `process.pid`. */
  readonly pid?: number;
  /** The host clock in epoch ms; default `Date.now`. */
  readonly now?: () => number;
  /** Each forge call's deadline; default 60 000 ms. */
  readonly callTimeoutMs?: number;
  /** The ledger swap's back-off sleep and jitter source (tests). */
  readonly sleep?: Sleep;
  readonly random?: () => number;
  /** The keepers' interval (default 5 min), retry wait (default 60 s) and sleep (tests). */
  readonly heartbeat?: { readonly everyMs?: number; readonly retryMs?: number; readonly sleep?: Sleep };
  /** Runs the trailing wait. */
  readonly waiter: Waiter;
  /** The command `lane.pid` records; default the basename of `process.execPath`. */
  readonly command?: string;
};

export type ClaimCoordinatorParams = {
  readonly forge: Forge;
  readonly identity: LaneIdentity;
  /** The forge's time. */
  readonly now: string;
  readonly callTimeoutMs?: number;
  readonly sleep?: Sleep;
  readonly random?: () => number;
};

/**
 * `lane run`'s last coordinator start check: `claimCoordinator` through the
 * ledger swap. `held` when another identity's claim is live (nothing is
 * written); the written record otherwise.
 */
export async function claimCoordinatorRecord(p: ClaimCoordinatorParams): Promise<Result<CoordinatorRecord, "held" | "failed">> {
  let r: Awaited<ReturnType<typeof swapLedger>>;
  try {
    r = await swapLedger({
      forge: p.forge,
      edit: claimCoordinator({ by: p.identity, now: p.now }),
      signal: AbortSignal.timeout(p.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS),
      ...(p.sleep !== undefined ? { sleep: p.sleep } : {}),
      ...(p.random !== undefined ? { random: p.random } : {}),
    });
  } catch (e) {
    return err("failed", `coordinator claim: ledger swap threw: ${message(e)}`);
  }
  if (!r.ok) {
    const e = r.error;
    if (e.kind === "edit" && e.edit === "precondition") return err("held", `coordinator claim refused: ${e.message}`);
    return err("failed", `coordinator claim: ledger ${e.kind}: ${e.message}`);
  }
  const text = r.value.commit?.writes[COORDINATOR_PATH];
  if (text === undefined) return err("failed", `coordinator claim: the swap wrote no ${COORDINATOR_PATH}`);
  try {
    const parsed = CoordinatorRecordSchema.safeParse(JSON.parse(text));
    return parsed.success ? ok(parsed.data) : err("failed", `coordinator claim: the written ${COORDINATOR_PATH} does not parse`);
  } catch (e) {
    return err("failed", `coordinator claim: ${message(e)}`);
  }
}

const ZERO_SHA = "0".repeat(40);

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Ends the run early with `outcome`. */
class Halt extends Error {
  constructor(
    readonly outcome: LaneOutcome,
    readonly reason: string,
  ) {
    super(reason);
  }
}

/** A host or lane STOP marker ends the run: the operator's choice, never a lane stop. */
class MarkerStop extends Halt {}

type Track = {
  readonly unit: CoordinatorUnit;
  readonly startedMs: number;
  readonly logName: string;
  record: UnitRecord | null;
  state: UnitState | null;
  reason: string | null;
};

type Swapped =
  | { readonly kind: "ok"; readonly record: UnitRecord | null }
  | { readonly kind: "lost"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

export async function runCoordinatorProcess(deps: CoordinatorDeps): Promise<LaneProcessResult> {
  const { forge, store, identity, lane, agent } = deps;
  const clock = deps.now ?? Date.now;
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const layout = laneLayout(deps.laneDir);
  const iso = (ms: number) => new Date(ms).toISOString();
  const deadline = (): CallOpts => ({ signal: AbortSignal.timeout(callTimeoutMs) });
  const generation = deps.claim.generation;

  let mainSha: string | null = null;
  // The claim's stamp is the last forge time seen.
  let lastNow = deps.claim.heartbeat_at;
  let lastNowAt = clock();
  const seeNow = (now: string): void => {
    lastNow = now;
    lastNowAt = clock();
  };
  /** The last forge time seen, advanced by the host time since. */
  const estimatedNow = (): string => iso(Date.parse(lastNow) + Math.max(0, clock() - lastNowAt));

  let track: Track | null = null;
  const log = (text: string): void => {
    if (track !== null) store.appendLog(track.logName, text);
    else console.error(text.trimEnd());
  };
  const note = (text: string): void => log(`== ${iso(clock())} ${text} ==\n`);

  const reportStore = (r: { readonly ok: boolean; readonly error?: { readonly kind: string; readonly message: string } }, what: string): void => {
    if (r.ok || r.error === undefined) return;
    note(`lane store: ${what}: ${r.error.kind}: ${r.error.message}`);
  };

  const addReason = (t: Track, reason: string): void => {
    if (t.reason === null) t.reason = reason;
    else if (t.reason !== reason && !t.reason.endsWith(`; ${reason}`)) t.reason = `${t.reason}; ${reason}`;
  };

  /** Posts the alert (its failure ignored) and stops the lane. */
  const laneStop = async (condition: string, reason: string): Promise<never> => {
    try {
      await forge.alert(condition, mainSha ?? ZERO_SHA, deadline());
    } catch {
      // The alert is best effort; the lane stops either way.
    }
    throw new Halt("stop", `${condition}: ${reason}`);
  };

  /** One forge call under its own deadline; a lane-stop kind stops the lane. */
  const call = async <T>(operation: string, run: (opts: CallOpts) => Promise<ForgeResult<T>>): Promise<ForgeResult<T>> => {
    const r = await run(deadline());
    if (!r.ok && isLaneStopKind(r.error.kind)) await laneStop(`forge-${r.error.kind}`, `${operation}: ${r.error.message}`);
    return r;
  };

  /** A host or lane STOP marker (or one that can't be read) ends the run with `stop`. */
  const checkStop = (): void => {
    const s = store.stopMarkers();
    if (!s.ok) throw new Halt("stop", `STOP markers unreadable, stopping: ${s.error.message}`);
    if (s.value.host) throw new MarkerStop("stop", "host STOP marker present");
    if (s.value.lane) throw new MarkerStop("stop", "lane STOP marker present");
  };

  /** One ledger edit through the CAS loop under its own deadline. */
  const swap = async (edit: LedgerEdit, unit: string): Promise<Swapped> => {
    const r = await swapLedger({
      forge,
      edit,
      signal: AbortSignal.timeout(callTimeoutMs),
      ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
      ...(deps.random !== undefined ? { random: deps.random } : {}),
    });
    if (r.ok) return { kind: "ok", record: writtenRecord(r.value.commit, unit) };
    const e = r.error;
    if (e.kind === "edit" && e.edit === "stop") await laneStop("ledger-schema-version", e.message);
    if (e.kind === "forge" && isLaneStopKind(e.forge.kind)) await laneStop(`forge-${e.forge.kind}`, e.message);
    if (e.kind === "edit" && e.edit === "precondition") return { kind: "lost", message: e.message };
    return { kind: "failed", message: `ledger ${e.kind}: ${e.message}` };
  };

  const keeperOpts = {
    clock,
    forgeNow: estimatedNow,
    callTimeoutMs,
    ...(deps.heartbeat?.everyMs !== undefined ? { everyMs: deps.heartbeat.everyMs } : {}),
    ...(deps.heartbeat?.retryMs !== undefined ? { retryMs: deps.heartbeat.retryMs } : {}),
    ...(deps.heartbeat?.sleep !== undefined ? { sleep: deps.heartbeat.sleep } : {}),
    ...(deps.random !== undefined ? { random: deps.random } : {}),
    log: note,
  };

  let coordinatorKeeper: Heartbeat | null = null;
  let unitKeeper: Heartbeat | null = null;

  /**
   * Throws `failed` once the `coordinator.json` keeper lost the claim or let it
   * lapse. A keeper that met a lane-stop condition stops the lane instead.
   */
  const checkClaim = async (): Promise<void> => {
    const end = coordinatorKeeper?.end() ?? null;
    if (end === null || end.kind === "moved-on") return;
    if (end.kind === "stop") await laneStop(end.condition, `heartbeat: ${end.message}`);
    throw new Halt("failed", `coordinator claim: ${end.message}`);
  };

  /**
   * Throws `failed` once the unit keeper lost or released the unit; the state
   * follows the keeper's end. A keeper that met a lane-stop condition stops
   * the lane instead, the record left as it is.
   */
  const checkUnit = async (t: Track): Promise<void> => {
    const end = unitKeeper?.end() ?? null;
    if (end === null || end.kind === "moved-on") return;
    if (end.kind === "stop") await laneStop(end.condition, `heartbeat: ${end.message}`);
    if (end.kind === "released") {
      if (end.record !== null) t.record = end.record;
      t.state = "released";
    } else {
      t.state = null;
    }
    throw new Halt("failed", `heartbeat: ${end.message}`);
  };

  const idleSpan = (reason: string, startedMs: number): void => {
    const span = store.appendJournal({ schema_version: 1, type: "span", span: "idle", reason, started_at: iso(startedMs), ended_at: iso(clock()) });
    reportStore(span, "journal");
  };

  /** A failed attempt on the claimed unit: released, or parked at the attempts cap. */
  const failUnit = async (t: Track, reason: string): Promise<void> => {
    addReason(t, reason);
    const held = t.record;
    if (held === null || t.state !== "claimed") return;
    const r = await swap(failAttempt({ unit: t.unit.unit, by: identity, now: estimatedNow(), generation: held.generation }), t.unit.unit);
    if (r.kind === "ok") {
      if (r.record !== null) t.record = r.record;
      t.state = r.record?.state ?? null;
      return;
    }
    t.state = null;
    addReason(t, `failAttempt: ${r.message}`);
  };

  const body = async (): Promise<LaneOutcome> => {
    const pid = store.writePid("lane", deps.pid ?? process.pid, deps.command ?? basename(process.execPath));
    if (!pid.ok) throw new Halt("failed", `lane.pid: ${pid.error.message}`);
    coordinatorKeeper = startCoordinatorHeartbeat({ ...keeperOpts, forge, identity, generation, claimedMs: lastNowAt });

    for (let round = 1; round <= MAX_CLAIM_ROUNDS; round += 1) {
      track = null;
      checkStop();
      await checkClaim();
      const roundStart = clock();
      const snapped = await call("snapshot", (o) => forge.snapshot({ ...o, read: readsPath }));
      if (!snapped.ok) throw new Halt("failed", `snapshot ${snapped.error.kind}: ${snapped.error.message}`);
      const snap = snapped.value;
      mainSha = snap.main.sha;
      seeNow(snap.now);
      const claimNowAt = lastNowAt;
      const assembled = assembleSnapshot({
        repo: lane.repo,
        now: snap.now,
        tree: [...snap.main.tree],
        files: { ...snap.main.files },
        main_sha: snap.main.sha,
        blob_shas: snap.main.blob_shas,
        ledger_tip: snap.ledger.tip,
        ledger_files: snap.ledger.files,
        prs: snap.prs,
        escalations: null,
        lane: identity,
        role: "coordinator",
      });
      if (!assembled.ok) {
        if (assembled.error.kind === "stop") await laneStop("ledger-schema-version", assembled.error.message);
        throw new Halt("stop", `${assembled.error.kind}: ${assembled.error.message}`);
      }
      const view = assembled.value;
      const held = view.ledger.coordinator;
      if (held === null || held.owner !== identity.owner || held.host !== identity.host || held.lane !== identity.lane || held.generation !== generation) {
        const who = held === null ? "missing" : `held by ${held.owner}/${held.host}/${held.lane} at generation ${held.generation}`;
        throw new Halt("failed", `coordinator claim lost: ${COORDINATOR_PATH} is ${who}, not this lane at generation ${generation}`);
      }

      const picked = next(view, "coordinator");
      if (picked.kind === "stop") throw new Halt("stop", `next: ${picked.reason}`);
      if (picked.kind === "idle") {
        idleSpan(picked.reason, roundStart);
        return "idle";
      }
      const u = picked.unit;
      const step = deps.steps[u.kind];
      if (step === undefined) {
        // No step: the unit is not claimed.
        idleSpan(missingStepReason(u.kind), roundStart);
        return "idle";
      }

      const t: Track = {
        unit: u,
        startedMs: roundStart,
        logName: logFileName(u.unit, roundStart),
        record: null,
        state: view.ledger.units.find((r) => r.unit === u.unit)?.state ?? null,
        reason: null,
      };
      track = t;
      note(`round ${round}: next picked ${u.unit} (${u.why}) at main ${snap.main.sha}`);
      checkStop();

      const pr = u.pr === null ? undefined : snap.prs[u.unit];
      const adoptPr: AdoptedPr | null =
        u.pr !== null && pr !== undefined && pr.state === "open" ? { pr: u.pr, pr_owner: identity.owner, head_sha: pr.head_sha, base_sha: snap.main.sha } : null;
      const prFields = adoptPr !== null ? { adoptPr } : { baseSha: snap.main.sha };
      let edit: LedgerEdit;
      if (u.take_over === "claimed") {
        if (u.expect_generation === null) throw new Halt("failed", `next: a takeover of ${u.unit} with no generation`);
        edit = takeOverStale({ unit: u.unit, by: identity, now: snap.now, generation: u.expect_generation, globs: u.globs, ...prFields });
      } else {
        edit = claim({ unit: u.unit, by: identity, now: snap.now, globs: u.globs, expectGeneration: u.expect_generation, ...prFields });
      }
      const what = u.take_over === "claimed" ? "takeOverStale" : "claim";
      const claimed = await swap(edit, u.unit);
      if (claimed.kind === "lost") {
        note(`${what} lost: ${claimed.message}`);
        track = null;
        continue;
      }
      if (claimed.kind === "failed") throw new Halt("failed", `${what}: ${claimed.message}`);
      const record = claimed.record;
      if (record === null) throw new Halt("failed", `${what}: no record written`);
      t.record = record;
      t.state = record.state;
      note(`${what}: ${record.state} at generation ${record.generation}${adoptPr === null ? "" : ` (PR #${adoptPr.pr} open)`}`);
      if (record.state === "parked") {
        t.reason = `stale takeover parked blocked attempts-cap after ${record.attempts} attempts`;
        return "progress";
      }

      unitKeeper = startHeartbeat({ ...keeperOpts, forge, identity, unit: u.unit, generation: record.generation, claimedMs: claimNowAt });
      await checkClaim();
      const signal = AbortSignal.any([unitKeeper.signal, coordinatorKeeper.signal]);
      let out: PrStepOutput;
      try {
        out = await step({ unit: u, record, snapshot: view, files: snap.main.files, signal, log: note });
      } catch (e) {
        await failUnit(t, `${u.kind} step threw: ${message(e)}`);
        return "failed";
      }
      t.state = out.state;
      if (out.record !== undefined) t.record = out.record;
      if (out.reason !== undefined) addReason(t, out.reason);
      note(`${u.kind} step: ${out.outcome} (${out.state ?? "unknown"})`);
      await checkUnit(t);
      await checkClaim();
      if (out.state === "merging") {
        // A coordinator-held merging record has no heartbeat (AD-6): later reconcile runs check it.
        await unitKeeper.stop();
        note("the unit is merging: its keeper stopped");
      }
      return out.outcome;
    }
    track = null;
    throw new Halt("failed", `claim lost ${MAX_CLAIM_ROUNDS} rounds in a row`);
  };

  let outcome: LaneOutcome;
  /** The run ended on a host or lane STOP marker. */
  let markerStop = false;
  /** The reason of the `Halt` that ended the run, if one did. */
  let haltReason: string | null = null;
  try {
    outcome = await body();
  } catch (e) {
    outcome = "failed";
    const t = track as Track | null;
    if (e instanceof Halt) {
      outcome = e.outcome;
      haltReason = e.reason;
      if (e instanceof MarkerStop) markerStop = true;
      if (t !== null) addReason(t, e.reason);
      else note(e.reason);
    } else if (t !== null) {
      try {
        await failUnit(t, `unexpected error: ${message(e)}`);
      } catch (inner) {
        t.state = null;
        if (inner instanceof Halt) {
          outcome = inner.outcome;
          haltReason = inner.reason;
          addReason(t, inner.reason);
        }
      }
    } else {
      note(`unexpected error: ${message(e)}`);
    }
  }

  try {
    const t = track as Track | null;
    if (t !== null) {
      note(`outcome ${outcome}`);
      const endedMs = clock();
      const logged = store.appendLog(t.logName, "");
      const record: UnitJournalRecord = {
        schema_version: 1,
        type: "unit",
        unit: t.unit.unit,
        lane: identity.lane,
        generation: t.record?.generation ?? null,
        started_at: iso(t.startedMs),
        ended_at: iso(endedMs),
        duration_ms: Math.max(0, endedMs - t.startedMs),
        agent: lane.agent,
        model: lane.model ?? agent.defaultModel,
        effort: lane.effort,
        tokens: null,
        cost: null,
        sessions: 0,
        outcome,
        result: null,
        state: t.state,
        attempts: t.record?.attempts ?? 0,
        loopbacks: t.record?.loopbacks ?? 0,
        ci_fixes: t.record?.ci_fixes ?? 0,
        denied_actions: [],
        reason: t.reason,
        log: logged.ok ? logged.value : join(layout.logs, t.logName),
      };
      reportStore(store.appendJournal(record), "journal");
    }
    reportStore(store.writeOutcome(outcome), "outcome");

    // Both keepers beat on through the trailing wait, the unit's while its record is still claimed or merging,
    // unless the coordinator claim is lost or lapsed: then the unit is left to go stale for the new coordinator.
    const claimEnd = (coordinatorKeeper as Heartbeat | null)?.end() ?? null;
    if (claimEnd !== null && claimEnd.kind !== "moved-on") await (unitKeeper as Heartbeat | null)?.stop();
    const waitMs = coordinatorTrailingWaitMs(outcome);
    if (waitMs !== null) {
      let waited: WaitResult;
      try {
        waited = await deps.waiter.wait({ ms: waitMs });
      } catch (e) {
        waited = { end: "failed", message: message(e) };
      }
      if (waited.end === "failed") console.error(`lane wait failed: ${waited.message ?? "no message"}`);
    }
  } finally {
    await (unitKeeper as Heartbeat | null)?.stop();
    await (coordinatorKeeper as Heartbeat | null)?.stop();
  }
  reportStore(store.clearPid("lane"), "lane.pid");
  if (outcome !== "stop" || markerStop) return { outcome };
  const t = track as Track | null;
  return { outcome, laneStop: haltReason ?? t?.reason ?? "the run ended stop" };
}
