import { EPICS_YAML_PATH } from "../config/load-repo-config.ts";
import { digestDue, digestSlot } from "../inbox/digest-time.ts";
import { ATTEMPTS_CAP, heldGlobs, isStale, planningPredecessor } from "../ledger/edits.ts";
import { globsOverlap } from "../manifests/globs.ts";
import { standingApproval } from "../reconcile/approval.ts";
import type { Config } from "../schemas/config.ts";
import { GRAPH_PSEUDO_GLOB, planningKindOf, planningSlug, unitKind, type PlanningKind, type UnitKind, type UnitRecord } from "../schemas/ledger.ts";
import { RETRO_ITEM_ID_PATTERN, type RetroItem } from "../schemas/retro-gates.ts";
import type { Snapshot } from "../schemas/snapshot.ts";
import { storyKey } from "../story-id.ts";
import { epicHolds } from "./epic-gates.ts";
import type { Reason } from "./reasons.ts";
import { epicContextPath, liveEvidenceGaps, liveEvidenceGlob } from "./snapshot.ts";

export { GRAPH_PSEUDO_GLOB, planningSlug, type PlanningKind };
export { digestDue, digestSlot };

/**
 * The coordinator's side of `next` (FR4, AR14, AD-8, AD-9, AD-13): the globs
 * each coordinator unit kind holds, when `reconcile` is due, and the
 * coordinator's order: `reconcile`, an open coordinator PR, then planning
 * (Story 2.7, graph before status), then retro (Story 2.9), then retro items
 * (Story 2.10). No `checkpoint` unit runs: `checkpoint:<epic>` is only a `go`
 * target (AR14). Pure.
 */

/** `reconcile` is due this long after its last run, by the forge's `now`. */
export const RECONCILE_EVERY_MS = 10 * 60 * 1000;

/** The unit kinds the coordinator works: every kind but `story` and `checkpoint` (only a `go` target). */
export type CoordinatorKind = Exclude<UnitKind, "story" | "checkpoint">;

const COORDINATOR_KINDS: Readonly<Record<CoordinatorKind, true>> = { reconcile: true, planning: true, retro: true, "retro-item": true };

/** Whether `kind` is a kind the coordinator works. */
export function isCoordinatorKind(kind: UnitKind): kind is CoordinatorKind {
  return Object.hasOwn(COORDINATOR_KINDS, kind);
}

/** What `coordinatorGlobs` needs to know about a coordinator unit. */
export type CoordinatorUnitSpec =
  | { readonly kind: "planning"; readonly planning: "graph" | "status" }
  | { readonly kind: "retro"; readonly epic: number }
  | { readonly kind: "retro-item"; readonly globs: readonly string[] }
  | { readonly kind: "reconcile" };

export type CoordinatorGlobsConfig = Pick<
  Config,
  "epics_path" | "sprint_status_path" | "retro_gates_path" | "epic_context_path" | "retro_doc_glob" | "manifests"
>;

/** The graph inputs: `epics_path`, `.xarabot/epics.yaml` and the manifests (when `manifests` is set). */
export function graphInputGlobs(config: Pick<Config, "epics_path" | "manifests">): string[] {
  const out = [config.epics_path, EPICS_YAML_PATH];
  if (config.manifests !== undefined) out.push(`${config.manifests.dir}/*.md`);
  return out;
}

/** The status files: `sprint_status_path` and `retro_gates_path`. */
export function statusFiles(config: Pick<Config, "sprint_status_path" | "retro_gates_path">): string[] {
  return [config.sprint_status_path, config.retro_gates_path];
}

/**
 * The globs a coordinator unit holds (AD-13). Graph planning: the graph
 * inputs and `xarabot:graph`. Status planning: the status files and every
 * Epic's context path. A retro: the status files, its Epic's context path
 * and retro document glob. A retro item: its own globs. `reconcile`: none.
 */
export function coordinatorGlobs(spec: CoordinatorUnitSpec, config: CoordinatorGlobsConfig): string[] {
  switch (spec.kind) {
    case "planning":
      if (spec.planning === "graph") return [...graphInputGlobs(config), GRAPH_PSEUDO_GLOB];
      return [...statusFiles(config), config.epic_context_path.replaceAll("<N>", "*")];
    case "retro":
      return [
        ...statusFiles(config),
        epicContextPath(config.epic_context_path, spec.epic),
        config.retro_doc_glob.replaceAll("<N>", String(spec.epic)),
      ];
    case "retro-item":
      return [...spec.globs];
    case "reconcile":
      return [];
  }
}

const RECONCILE_UNIT = /^reconcile:([1-9][0-9]*)$/;

/** The run number of a `reconcile:<n>` id, or `null`. */
export function reconcileNumber(unit: string): number | null {
  const m = RECONCILE_UNIT.exec(unit);
  return m === null ? null : Number(m[1]);
}

/**
 * A coordinator unit's PR branch: `<branches.xarabot>` plus the id with its
 * `:` as `-`, so `reconcile:<n>` is `reconcile-<n>` and `planning:<slug>.<n>`
 * is `planning-<slug>.<n>`.
 */
export function unitBranch(xarabotPrefix: string, unit: string): string {
  return `${xarabotPrefix}${unit.replace(":", "-")}`;
}

/** The highest-numbered `reconcile:<n>` record in any state for which `keep` holds, or `null`. */
function highestReconcile(snapshot: Snapshot, keep: (r: UnitRecord) => boolean): UnitRecord | null {
  let best: UnitRecord | null = null;
  let bestN = 0;
  for (const r of snapshot.ledger.units) {
    const n = reconcileNumber(r.unit);
    if (n !== null && n > bestN && keep(r)) {
      best = r;
      bestN = n;
    }
  }
  return best;
}

/** The highest-numbered `merged` `reconcile:<n>` record: the last finished run. */
export function newestMergedReconcile(snapshot: Snapshot): UnitRecord | null {
  return highestReconcile(snapshot, (r) => r.state === "merged");
}

/** The next `reconcile` run's number: the highest number of any state, plus 1. */
export function nextReconcileNumber(snapshot: Snapshot): number {
  const top = highestReconcile(snapshot, () => true);
  return top === null ? 1 : (reconcileNumber(top.unit) as number) + 1;
}

/** A graph planning record: `planning:graph.<n>`, or another planning slug holding `xarabot:graph` (`planningKindOf`). */
export function isGraphPlanning(record: Pick<UnitRecord, "unit" | "globs">): boolean {
  return planningKindOf(record) === "graph";
}

const PLANNING_UNIT = /^planning:([a-z0-9]+(?:-[a-z0-9]+)*)\.([1-9][0-9]*)$/;

/** The run number of a `planning:<slug>.<n>` id, or `null`. */
export function planningNumber(unit: string): number | null {
  const m = PLANNING_UNIT.exec(unit);
  return m === null ? null : Number(m[2]);
}

/** The next `planning:<slug>.<n>` number: the highest `n` of that slug on the ledger, in any state, plus 1. */
export function nextPlanningNumber(snapshot: Snapshot, slug: PlanningKind): number {
  let top = 0;
  for (const r of snapshot.ledger.units) {
    if (planningSlug(r.unit) !== slug) continue;
    const n = planningNumber(r.unit) ?? 0;
    if (n > top) top = n;
  }
  return top + 1;
}

/** A `development_status` key the effective graph needs, and its Epic. */
export type StatusEntry = { readonly key: string; readonly epic: number };

/** An Epic's `development_status` key. */
export function epicStatusKey(epic: number): string {
  return `epic-${epic}`;
}

/**
 * The graph's `development_status` keys absent on `main`, in graph order:
 * each graph Epic's `epic-<N>`, then its manifests' `sprint_key`s in the
 * Epic's Story order (a manifest of no graph Epic last, by Epic). `[]` when
 * the graph did not resolve.
 */
export function missingStatusEntries(snapshot: Snapshot): StatusEntry[] {
  if (!snapshot.graph.ok) return [];
  const status = snapshot.sprint_status.development_status;
  const has = (key: string) => Object.hasOwn(status, key);
  const out: StatusEntry[] = [];
  const seen = new Set<string>();
  const add = (key: string, epic: number) => {
    if (has(key) || seen.has(key)) return;
    seen.add(key);
    out.push({ key, epic });
  };
  const epics = [...snapshot.graph.value.epics].sort((a, b) => a.number - b.number);
  const order = (epic: number, id: string): number => {
    const stories = epics.find((e) => e.number === epic)?.stories ?? [];
    const i = stories.findIndex((s) => storyKey(s) === storyKey(id));
    return i === -1 ? stories.length : i;
  };
  const byEpic = (epic: number) =>
    snapshot.manifests.filter((m) => m.epic === epic).sort((a, b) => order(epic, a.story_id) - order(epic, b.story_id));
  for (const e of epics) {
    add(epicStatusKey(e.number), e.number);
    for (const m of byEpic(e.number)) add(m.sprint_key, e.number);
  }
  const rest = [...new Set(snapshot.manifests.map((m) => m.epic))].filter((n) => !epics.some((e) => e.number === n)).sort((a, b) => a - b);
  for (const n of rest) for (const m of byEpic(n)) add(m.sprint_key, n);
  return out;
}

/**
 * Whether `record`'s unit is done on `main` (AD-9): a Story `done` in
 * `sprint-status.yaml` (through its manifest's `sprint_key`), a retro with a
 * recorded verdict, a retro item with status `done`, a checkpoint with its
 * go recorded, a status planning unit always, a graph planning unit once
 * every graph Epic's and manifest's key has a `development_status` entry
 * (the entries land through a later, disposable `reconcile` PR), and every
 * `merged` `reconcile` record but the newest `merged` one.
 */
export function doneOnMain(record: UnitRecord, snapshot: Snapshot): boolean {
  const kind = unitKind(record.unit);
  const body = record.unit.slice(record.unit.indexOf(":") + 1);
  const gates = snapshot.retro_gates.epics;
  switch (kind) {
    case "story": {
      const m = snapshot.manifests.find((x) => storyKey(x.story_id) === storyKey(body));
      if (m === undefined) return false;
      const status = snapshot.sprint_status.development_status;
      return Object.hasOwn(status, m.sprint_key) && status[m.sprint_key] === "done";
    }
    case "retro":
      return gates[body]?.retro !== undefined;
    case "retro-item": {
      const epic = RETRO_ITEM_ID_PATTERN.exec(body)?.[1];
      if (epic === undefined) return false;
      return (gates[epic]?.items ?? []).some((i) => i.id === body && i.status === "done");
    }
    case "checkpoint":
      return gates[body]?.checkpoint !== undefined;
    case "planning":
      if (!isGraphPlanning(record)) return true;
      return snapshot.graph.ok && missingStatusEntries(snapshot).length === 0;
    case "reconcile":
      return record.state === "merged" && newestMergedReconcile(snapshot)?.unit !== record.unit;
    case undefined:
      return false;
  }
}

export type ReconcileDue = {
  readonly due: boolean;
  /** Why it is due, or why not. */
  readonly why: string;
  /** The newest `merged` `reconcile:<n>` record, the last finished run. */
  readonly last: UnitRecord | null;
};

/**
 * Whether `record` is parked `awaiting-approval` with its PR open at the
 * parked head and the Maintainer's approval of that head standing in the
 * PR's snapshot `reviews` (Maintainer decision 2026-10-25, retro item 13).
 * The record must be one `reconcile` would try to take (`pr`, `pr_owner`
 * and `head_sha` set), and, as there, a coordinator re-park or a park with a
 * posted graph delta counts only an approval submitted after its
 * `heartbeat_at` (`approvalParkedAt`). As there, a record other than a
 * `reconcile:<n>` needs a `passed_sha` (Story 3.5): an unreviewed one is
 * never taken, so its approval is no work.
 */
export function maintainerApproved(record: UnitRecord, snapshot: Snapshot): boolean {
  if (record.state !== "parked" || record.park?.kind !== "awaiting-approval") return false;
  if (record.pr === null || record.pr_owner === null || record.head_sha === null) return false;
  if (record.passed_sha === null && unitKind(record.unit) !== "reconcile") return false;
  const pr = snapshot.prs[record.unit];
  if (pr?.state !== "open" || pr.head_sha !== record.head_sha) return false;
  return standingApproval(pr.reviews ?? [], { owner: snapshot.config.maintainer, head: record.head_sha, parkedAt: approvalParkedAt(record) }) !== null;
}

/**
 * When `record`'s awaiting-approval park began, for its approval: only an
 * approval submitted after it counts. Its `heartbeat_at` for a coordinator
 * re-park (`lane` `coordinator` with an `enqueued_sha`) and for a park with
 * `graph_posted`, written only once the runner's delta comment succeeded,
 * so an approval given before the delta was posted never takes a graph
 * change (retro item 33, Maintainer decision 2026-10-25). `null` for any
 * other park: any standing approval of the head counts.
 */
export function approvalParkedAt(record: UnitRecord): string | null {
  const reparked = record.lane === "coordinator" && record.enqueued_sha !== null;
  return reparked || record.park?.graph_posted !== undefined ? record.heartbeat_at : null;
}

/**
 * When `reconcile` is due (the Maintainer's 2026-10-24 decision, amended
 * 2026-10-25): the snapshot shows work (a record not `merged` whose PR
 * merged, a record parked awaiting an approval the Maintainer has given
 * (`maintainerApproved`), a `merged` record whose unit is done on `main`,
 * or, since Story 4.2, today's digest slot passed with no digest posted
 * (`digestDue` over `coordinator.json`'s `digest_posted_at`) and no `merged`
 * `reconcile:<n>` run at or after the slot), there is no
 * `merged` `reconcile:<n>` record, or `now` is 10 min or more past the
 * newest `merged` one's `heartbeat_at`.
 */
export function reconcileDue(snapshot: Snapshot): ReconcileDue {
  const last = newestMergedReconcile(snapshot);
  for (const r of snapshot.ledger.units) {
    const pr = snapshot.prs[r.unit];
    if (r.state !== "merged" && pr?.state === "merged") {
      return { due: true, why: `${r.unit} is ${r.state} but its PR #${pr.number} merged`, last };
    }
  }
  for (const r of snapshot.ledger.units) {
    if (maintainerApproved(r, snapshot)) {
      return { due: true, why: `${r.unit} is parked awaiting approval and the Maintainer approved PR #${r.pr} at ${r.head_sha}`, last };
    }
  }
  for (const r of snapshot.ledger.units) {
    if (r.state === "merged" && doneOnMain(r, snapshot)) return { due: true, why: `${r.unit} is merged and done on main`, last };
  }
  const posted = snapshot.ledger.coordinator?.digest_posted_at ?? null;
  const slot = digestSlot(snapshot.now, snapshot.config.digest_time);
  // Only until a run finishes past the slot: a run that failed to stamp leaves the 10-min rule in charge, so it never starves the rest.
  const ranSinceSlot = last !== null && Date.parse(last.heartbeat_at) >= Date.parse(slot);
  if (digestDue(snapshot.now, snapshot.config.digest_time, posted) && !ranSinceSlot) {
    return { due: true, why: `the digest slot ${slot} passed with no digest posted (last ${posted ?? "never"})`, last };
  }
  if (last === null) return { due: true, why: "no merged reconcile run on the ledger", last };
  const since = Date.parse(snapshot.now) - Date.parse(last.heartbeat_at);
  if (since >= RECONCILE_EVERY_MS) return { due: true, why: `${last.unit} ran at ${last.heartbeat_at}, 10 min or more ago`, last };
  return { due: false, why: `${last.unit} ran at ${last.heartbeat_at}, under 10 min ago, and the snapshot shows no reconcile work`, last };
}

/** A Story heading with no manifest, as the graph reports it. */
export type PlanningHeading = { readonly id: string; readonly epic: number; readonly line: number };

/** What is due for one planning kind, and why (or why not). */
export type PlanningKindDue = { readonly due: boolean; readonly why: string };

export type PlanningDue = {
  /** Graph planning: the headings in Epics not bootstrapped that have no manifest. */
  readonly graph: PlanningKindDue & { readonly headings: readonly PlanningHeading[] };
  /**
   * Status planning: the missing `development_status` entries of Epics not
   * bootstrapped that this unit is due on (none while a `merged` graph
   * planning record is not yet done on `main`: `reconcile` writes those
   * keys), and the Epics whose context file is due.
   */
  readonly status: PlanningKindDue & { readonly entries: readonly StatusEntry[]; readonly contexts: readonly number[] };
};

/**
 * What planning is due on `snapshot` (Story 2.7), per kind, for `next` and
 * for the session's prompt. Graph: the graph resolved, `manifests` is
 * configured and a Story heading in an Epic not in `bootstrapped_epics` has
 * no manifest. Status: a missing
 * `development_status` key of an Epic not bootstrapped (unless a `merged`
 * graph planning record is not yet done on `main`), or an Epic not
 * bootstrapped whose context is not `valid` (missing, invalid, or `stale`:
 * its source line is missing or differs from its `epics.md` section's hash,
 * retro item 12), which has a manifested Story
 * not `done` and which no `dependency-epic`, `retro-rejected`, `retro-item`
 * or `checkpoint` hold keeps back. Holds on records are not looked at here.
 */
export function planningDue(snapshot: Snapshot): PlanningDue {
  if (!snapshot.graph.ok) {
    const why = `the graph did not resolve: ${snapshot.graph.error.message}`;
    return { graph: { due: false, why, headings: [] }, status: { due: false, why, entries: [], contexts: [] } };
  }
  const graph = snapshot.graph.value;
  const { config } = snapshot;
  const bootstrapped = new Set(config.bootstrapped_epics);

  // With no `manifests` config there is no manifest directory to write to: graph planning is never due.
  const headings =
    config.manifests === undefined ? [] : graph.unmanifested.filter((u) => !bootstrapped.has(u.epic)).map((u) => ({ id: u.id, epic: u.epic, line: u.line }));
  const graphWhy =
    config.manifests === undefined
      ? "no manifests directory is configured"
      : headings.length === 0
        ? "every Story heading outside the bootstrapped Epics has a manifest"
        : headings.map((h) => `Story ${h.id} has a heading (${config.epics_path}:${h.line}) but no manifest`).join("; ");

  const pendingGraph = snapshot.ledger.units.find((r) => r.state === "merged" && isGraphPlanning(r) && !doneOnMain(r, snapshot));
  const missing = missingStatusEntries(snapshot).filter((e) => !bootstrapped.has(e.epic));
  const entries = pendingGraph === undefined ? missing : [];

  const status = snapshot.sprint_status.development_status;
  const notDone = (epic: number) =>
    snapshot.manifests.some((m) => m.epic === epic && !(Object.hasOwn(status, m.sprint_key) && status[m.sprint_key] === "done"));
  const holdsOf = epicHolds(snapshot);
  const contexts: number[] = [];
  const contextWhy: string[] = [];
  for (const e of [...graph.epics].sort((a, b) => a.number - b.number)) {
    const n = e.number;
    if (bootstrapped.has(n)) continue;
    const state = snapshot.epic_context[String(n)] ?? "missing";
    if (state === "valid" || !notDone(n) || holdsOf(n).length > 0) continue;
    contexts.push(n);
    contextWhy.push(`Epic ${n} context ${epicContextPath(config.epic_context_path, n)} is ${state}`);
  }

  const statusWhy: string[] = [];
  if (entries.length > 0) statusWhy.push(`${entries.map((e) => e.key).join(", ")} missing from ${config.sprint_status_path}`);
  statusWhy.push(...contextWhy);
  if (statusWhy.length === 0) {
    statusWhy.push(
      pendingGraph !== undefined && missing.length > 0
        ? `the missing status entries are ${pendingGraph.unit}'s, which reconcile writes`
        : "every status entry and due Epic context is in place",
    );
  }

  return {
    graph: { due: headings.length > 0, why: graphWhy, headings },
    status: { due: entries.length > 0 || contexts.length > 0, why: statusWhy.join("; "), entries, contexts },
  };
}

/** The coordinator unit `next` picked. */
export type CoordinatorUnit = {
  readonly unit: string;
  readonly kind: CoordinatorKind;
  readonly globs: readonly string[];
  /** The released or taken-over record's generation, or `null` for a unit with no record. */
  readonly expect_generation: number | null;
  /** `claimed` for a stale `claimed` record the coordinator takes over. */
  readonly take_over: "claimed" | null;
  /** The unit's open PR, or `null`. */
  readonly pr: number | null;
  /** Why it was picked. */
  readonly why: string;
};

/** What the coordinator gets from `next`: never a Story. */
export type CoordinatorOutcome =
  | { readonly kind: "coordinator"; readonly unit: CoordinatorUnit; readonly reasons: readonly Reason[] }
  | { readonly kind: "idle"; readonly reason: string; readonly reasons: readonly Reason[] }
  | { readonly kind: "stop"; readonly reason: string };

const NOTHING_DUE = "no coordinator unit due";

/** The coordinator states an open coordinator PR's record may be in. */
const OPEN_PR_STATES: readonly UnitRecord["state"][] = ["claimed", "merging", "released"];

/** The prefix of an idle reason that waits on the Maintainer (a live evidence file missing on `main`, or lacking a required result). */
export const WAITING_ON_MAINTAINER = "waiting-on-maintainer: ";

/**
 * The coordinator's next unit from a validated snapshot whose graph resolved
 * (AD-13): `reconcile` when due, then an open coordinator PR, then planning
 * (`nextPlanning`), then retro (`nextRetro`), then retro items
 * (`nextRetroItem`), else `idle`. An idle outcome whose every reason
 * besides `reconcile-not-due` is a Maintainer cause (a `live-evidence` one)
 * starts `waiting-on-maintainer: ` and those reasons' messages (Story 4.2's
 * every-reason rule); one with any other reason beside them has no prefix.
 * Never a Story. The open-PR position never returns a `reconcile` record (a
 * released or dead run's PR is the next `reconcile` run's to close), but a
 * live one still makes later positions wait.
 */
export function nextCoordinator(snapshot: Snapshot): CoordinatorOutcome {
  const reasons: Reason[] = [];

  // 1. reconcile.
  const r = reconcileDue(snapshot);
  if (r.due) {
    const n = nextReconcileNumber(snapshot);
    const unit = { unit: `reconcile:${n}`, kind: "reconcile", globs: [], expect_generation: null, take_over: null, pr: null, why: r.why } as const;
    return { kind: "coordinator", unit, reasons };
  }
  reasons.push({ subject: r.last?.unit ?? "reconcile:1", code: "reconcile-not-due", message: `reconcile is not due: ${r.why}` });

  // 2. An open coordinator PR, in unit order.
  let open = false;
  for (const rec of snapshot.ledger.units) {
    const kind = unitKind(rec.unit);
    if (kind === undefined || !isCoordinatorKind(kind) || rec.lane !== "coordinator" || !OPEN_PR_STATES.includes(rec.state)) continue;
    const pr = snapshot.prs[rec.unit];
    if (pr?.state !== "open") continue;
    if (kind === "reconcile" && (rec.state === "released" || (rec.state === "claimed" && isStale(rec, snapshot.now)))) continue;
    open = true;
    if (kind === "reconcile") {
      reasons.push({ subject: rec.unit, code: "record-state", message: `${rec.unit} is ${rec.state} with reconcile PR #${pr.number} open` });
      continue;
    }
    const base = { unit: rec.unit, kind, globs: [...rec.globs], expect_generation: rec.generation, pr: pr.number } as const;
    if (rec.state === "released" || (rec.state === "claimed" && isStale(rec, snapshot.now))) {
      // The claim refuses an overlap with a held glob; a retro item's globs can overlap a Story's.
      const hits: string[] = [];
      for (const other of snapshot.ledger.units) {
        if (other.unit === rec.unit) continue;
        for (const held of heldGlobs(other)) {
          const hit = rec.globs.find((g) => globsOverlap(g, held));
          if (hit !== undefined) hits.push(`glob "${hit}" overlaps "${held}" held by ${other.unit}`);
        }
      }
      if (hits.length > 0) {
        reasons.push({ subject: rec.unit, code: "overlap", message: `${rec.unit} with PR #${pr.number} open ${hits.join(", ")}` });
        continue;
      }
    }
    if (rec.state === "released") {
      return { kind: "coordinator", unit: { ...base, take_over: null, why: `${rec.unit} is released with PR #${pr.number} open` }, reasons };
    }
    if (rec.state === "claimed" && isStale(rec, snapshot.now)) {
      const why = `${rec.unit} is claimed and stale (heartbeat ${rec.heartbeat_at}) with PR #${pr.number} open`;
      return { kind: "coordinator", unit: { ...base, take_over: "claimed", why }, reasons };
    }
    reasons.push({ subject: rec.unit, code: "record-state", message: `${rec.unit} is ${rec.state} with coordinator PR #${pr.number} open` });
  }
  if (open) return { kind: "idle", reason: ["waiting on an open coordinator PR", ...reasons.map((x) => x.message)].join("; "), reasons };

  // 3. Planning: graph before status.
  const planning = nextPlanning(snapshot, reasons);
  if (planning !== null) return { kind: "coordinator", unit: planning, reasons };

  // 4. Retro, Epics in ascending order.
  const retro = nextRetro(snapshot, reasons);
  if (retro !== null) return { kind: "coordinator", unit: retro, reasons };

  // 5. Retro items, Epics in ascending order, items in file order.
  const item = nextRetroItem(snapshot, reasons);
  if (item !== null) return { kind: "coordinator", unit: item, reasons };

  // Idle only for Maintainer causes: the reason says it waits on the Maintainer (Story 4.2's every-reason rule).
  // `reconcile-not-due` is in every idle outcome and holds nothing back, so it is no cause.
  const causes = reasons.filter((x) => x.code !== "reconcile-not-due");
  if (causes.length > 0 && causes.every((x) => x.maintainer === true)) {
    const head = `${WAITING_ON_MAINTAINER}${causes.map((x) => x.message).join("; ")}`;
    const rest = reasons.filter((x) => x.code === "reconcile-not-due").map((x) => x.message);
    return { kind: "idle", reason: [head, NOTHING_DUE, ...rest].join("; "), reasons };
  }
  return { kind: "idle", reason: [NOTHING_DUE, ...reasons.map((x) => x.message)].join("; "), reasons };
}

/** Whether Epic `epic` has a Story, no unmanifested heading, and every Story `done` (the done-check idiom of `epicHolds`). */
function allStoriesDone(snapshot: Snapshot, epic: number): boolean {
  if (!snapshot.graph.ok) return false;
  const graph = snapshot.graph.value;
  if (graph.unmanifested.some((u) => u.epic === epic)) return false;
  const stories = graph.epics.find((x) => x.number === epic)?.stories ?? [];
  if (stories.length === 0) return false;
  const status = snapshot.sprint_status.development_status;
  return stories.every((id) => {
    const m = snapshot.manifests.find((x) => storyKey(x.story_id) === storyKey(id));
    return m !== undefined && Object.hasOwn(status, m.sprint_key) && status[m.sprint_key] === "done";
  });
}

/** An Epic whose retro is due on `snapshot` (Story 2.9), with its live evidence state. */
export type RetroCandidate = {
  readonly epic: number;
  /** `live_evidence_glob` with `<N>` set to the Epic. */
  readonly evidence: string;
  /** Whether a `main` path matches `evidence`. */
  readonly evidenceOnMain: boolean;
  /**
   * The Epic's `live_evidence_checks` commands the evidence file does not
   * hold, and those it holds with no `0 fail` summary after them (retro item
   * 14); both empty when none are listed or the file is not on `main`.
   */
  readonly missingChecks: readonly string[];
  readonly failingChecks: readonly string[];
};

/**
 * The Epics whose retro is due on their Stories (Story 2.9), in ascending
 * order: not in `bootstrapped_epics`, with no `retro` entry in
 * `retro-gates.yaml`, with at least one Story, no unmanifested heading, and
 * every Story `done`. Each carries whether its live evidence file is on
 * `main` and which required live results it lacks; a retro is due only once
 * it is on `main` and lacks none. Records are not looked at here.
 */
export function retroCandidates(snapshot: Snapshot): RetroCandidate[] {
  if (!snapshot.graph.ok) return [];
  const bootstrapped = new Set(snapshot.config.bootstrapped_epics);
  const out: RetroCandidate[] = [];
  for (const e of [...snapshot.graph.value.epics].sort((a, b) => a.number - b.number)) {
    const n = e.number;
    if (bootstrapped.has(n)) continue;
    if (snapshot.retro_gates.epics[String(n)]?.retro !== undefined) continue;
    if (!allStoriesDone(snapshot, n)) continue;
    const evidenceOnMain = snapshot.live_evidence[String(n)] === true;
    const checks = snapshot.config.live_evidence_checks?.[String(n)] ?? [];
    const gaps = evidenceOnMain ? liveEvidenceGaps(snapshot.live_evidence_file[String(n)]?.text ?? "", checks) : { missing: [], failing: [] };
    out.push({
      epic: n,
      evidence: liveEvidenceGlob(snapshot.config.live_evidence_glob, n),
      evidenceOnMain,
      missingChecks: gaps.missing,
      failingChecks: gaps.failing,
    });
  }
  return out;
}

/** Whether a retro candidate's live evidence file is on `main` and holds each required result. */
function evidenceReady(c: RetroCandidate): boolean {
  return c.evidenceOnMain && c.missingChecks.length === 0 && c.failingChecks.length === 0;
}

/** Whether Epic `epic`'s retro is due: a retro candidate whose live evidence file is on `main` and holds each required result. */
export function retroDue(snapshot: Snapshot, epic: number): boolean {
  return retroCandidates(snapshot).some((c) => c.epic === epic && evidenceReady(c));
}

/** A `live-evidence` reason's text for a candidate whose file is on `main` but lacks a required result. */
function describeGaps(snapshot: Snapshot, c: RetroCandidate): string {
  const file = snapshot.live_evidence_file[String(c.epic)]?.path ?? c.evidence;
  const list = (cs: readonly string[]) => cs.map((x) => `\`${x}\``).join(", ");
  const parts = [
    ...(c.missingChecks.length === 0 ? [] : [`missing ${list(c.missingChecks)}`]),
    ...(c.failingChecks.length === 0 ? [] : [`no '0 fail' summary after ${list(c.failingChecks)}`]),
  ];
  return `retro:${c.epic} waits for the live evidence file ${file} on main to hold each required live result: ${parts.join("; ")}`;
}

/**
 * The retro position (Story 2.9): for each retro candidate in Epic order, an
 * absent live evidence file, or one lacking a command of the Epic's
 * `live_evidence_checks` or its `0 fail` summary (retro item 14), is a
 * `live-evidence` reason and no unit; else
 * `retro:<N>`'s record decides. None: a new claim. `released`: a re-claim at
 * its generation. A stale `claimed` one with no open PR: a takeover. Any
 * other holds (`record-state`). A unit whose globs overlap another record's
 * held globs is passed over (`overlap`).
 */
function nextRetro(snapshot: Snapshot, reasons: Reason[]): CoordinatorUnit | null {
  for (const c of retroCandidates(snapshot)) {
    const unit = `retro:${c.epic}`;
    if (!c.evidenceOnMain) {
      reasons.push({ subject: unit, code: "live-evidence", message: `${unit} waits for the live evidence file ${c.evidence} on main`, maintainer: true });
      continue;
    }
    if (!evidenceReady(c)) {
      reasons.push({ subject: unit, code: "live-evidence", message: describeGaps(snapshot, c), maintainer: true });
      continue;
    }
    const rec = snapshot.ledger.units.find((r) => r.unit === unit);
    const stale = rec !== undefined && rec.state === "claimed" && isStale(rec, snapshot.now) && snapshot.prs[unit]?.state !== "open";
    if (rec !== undefined && rec.state !== "released" && !stale) {
      reasons.push({ subject: unit, code: "record-state", message: `${unit} is due but its record is ${describeHold(rec)}` });
      continue;
    }
    const globs = coordinatorGlobs({ kind: "retro", epic: c.epic }, snapshot.config);
    const hits: string[] = [];
    for (const other of snapshot.ledger.units) {
      if (other.unit === unit) continue;
      for (const held of heldGlobs(other)) {
        const hit = globs.find((g) => globsOverlap(g, held));
        if (hit !== undefined) hits.push(`glob "${hit}" overlaps "${held}" held by ${other.unit}`);
      }
    }
    if (hits.length > 0) {
      reasons.push({ subject: unit, code: "overlap", message: `${unit} ${hits.join(", ")}` });
      continue;
    }
    const checked = (snapshot.config.live_evidence_checks?.[String(c.epic)] ?? []).length > 0 ? " with each required live result" : "";
    const due = `Epic ${c.epic}'s Stories are all done, its retro is not recorded and ${c.evidence} is on main${checked}`;
    if (rec === undefined) return { unit, kind: "retro", globs, expect_generation: null, take_over: null, pr: null, why: `${unit} is due: ${due}` };
    if (rec.state === "released") {
      return { unit, kind: "retro", globs, expect_generation: rec.generation, take_over: null, pr: null, why: `${unit} is released and due: ${due}` };
    }
    const why = `${unit} is claimed and stale (heartbeat ${rec.heartbeat_at}) with no open PR`;
    return { unit, kind: "retro", globs, expect_generation: rec.generation, take_over: "claimed", pr: null, why };
  }
  return null;
}

/** An open retro item routed to a lane, and its Epic (Story 2.10). */
export type RetroItemCandidate = { readonly epic: number; readonly item: RetroItem };

/** A retro item's unit id: `retro-item:<id>`. */
export function retroItemUnit(id: string): string {
  return `retro-item:${id}`;
}

/**
 * The retro items a lane may work (Story 2.10): `status: open` items with
 * `route: lane`, Epics in ascending order, then items in file order. An item
 * with no globs is a candidate too; `next` reports it `unclaimable`. A
 * `route: maintainer` item, `waiting` or `open`, never is: it waits on the
 * Maintainer's ruling (Story 4.3). Records are not looked at here.
 */
export function retroItemCandidates(snapshot: Snapshot): RetroItemCandidate[] {
  const out: RetroItemCandidate[] = [];
  const epics = Object.keys(snapshot.retro_gates.epics)
    .map(Number)
    .sort((a, b) => a - b);
  for (const epic of epics) {
    for (const item of snapshot.retro_gates.epics[String(epic)]?.items ?? []) {
      // Narrower than `isOpenItem`: an `in-progress` or `waiting` item is open, and holds, but is no lane's to claim.
      if (item.status === "open" && item.route === "lane") out.push({ epic, item });
    }
  }
  return out;
}

/**
 * The retro-items position (Story 2.10, AD-13 step 5): for each candidate in
 * order, an item with no globs is an `unclaimable` reason and no unit; else
 * `retro-item:<id>`'s record decides, as in the retro position. None: a new
 * claim. `released`: a re-claim at its generation. A stale `claimed` one with
 * no open PR: a takeover. Any other holds (`record-state`). A unit whose globs
 * overlap another record's held globs is passed over (`overlap`).
 */
function nextRetroItem(snapshot: Snapshot, reasons: Reason[]): CoordinatorUnit | null {
  for (const { epic, item } of retroItemCandidates(snapshot)) {
    const unit = retroItemUnit(item.id);
    if (item.globs.length === 0) {
      reasons.push({ subject: unit, code: "unclaimable", message: `${unit} is unclaimable: the item has no globs` });
      continue;
    }
    const rec = snapshot.ledger.units.find((r) => r.unit === unit);
    const stale = rec !== undefined && rec.state === "claimed" && isStale(rec, snapshot.now) && snapshot.prs[unit]?.state !== "open";
    if (rec !== undefined && rec.state !== "released" && !stale) {
      reasons.push({ subject: unit, code: "record-state", message: `${unit} is due but its record is ${describeHold(rec)}` });
      continue;
    }
    const globs = coordinatorGlobs({ kind: "retro-item", globs: item.globs }, snapshot.config);
    const hits: string[] = [];
    for (const other of snapshot.ledger.units) {
      if (other.unit === unit) continue;
      for (const held of heldGlobs(other)) {
        const hit = globs.find((g) => globsOverlap(g, held));
        if (hit !== undefined) hits.push(`glob "${hit}" overlaps "${held}" held by ${other.unit}`);
      }
    }
    if (hits.length > 0) {
      reasons.push({ subject: unit, code: "overlap", message: `${unit} ${hits.join(", ")}` });
      continue;
    }
    const due = `Epic ${epic}'s retro item is open and routed to a lane`;
    if (rec === undefined) return { unit, kind: "retro-item", globs, expect_generation: null, take_over: null, pr: null, why: `${unit} is due: ${due}` };
    if (rec.state === "released") {
      return { unit, kind: "retro-item", globs, expect_generation: rec.generation, take_over: null, pr: null, why: `${unit} is released and due: ${due}` };
    }
    const why = `${unit} is claimed and stale (heartbeat ${rec.heartbeat_at}) with no open PR`;
    return { unit, kind: "retro-item", globs, expect_generation: rec.generation, take_over: "claimed", pr: null, why };
  }
  return null;
}

const PLANNING_ORDER: readonly PlanningKind[] = ["graph", "status"];

/** How a record of a planning kind stands: holding the kind, a stale claim to take over, or neither. */
function planningHold(rec: UnitRecord, snapshot: Snapshot): "held" | "stale" | null {
  if (rec.state === "parked" || rec.state === "merging") return "held";
  if (rec.state !== "claimed") return null;
  return isStale(rec, snapshot.now) && snapshot.prs[rec.unit]?.state !== "open" ? "stale" : "held";
}

function describeHold(rec: UnitRecord): string {
  if (rec.state === "parked" && rec.park !== null) return `parked ${rec.park.kind}${rec.park.reason === null ? "" : ` ${rec.park.reason}`}`;
  return rec.state;
}

/**
 * The planning position (Story 2.7): for each kind, graph first, a parked,
 * `merging` or live `claimed` record of the kind holds it (no new unit until
 * it is released); a stale `claimed` one with no open PR is taken over, same
 * id; else a due kind gets `planning:<kind>.<n>`, which starts with the
 * `attempts` of the newest record of its kind when that one is `released`
 * (`planningPredecessor`, C4), so the third failed run in a row parks
 * `attempts-cap`. A unit whose globs overlap another record's held globs is
 * passed over with an `overlap` reason.
 */
function nextPlanning(snapshot: Snapshot, reasons: Reason[]): CoordinatorUnit | null {
  const due = planningDue(snapshot);
  for (const kind of PLANNING_ORDER) {
    const d = due[kind];
    const records = snapshot.ledger.units.filter((r) => planningKindOf(r) === kind);
    const holder = records.find((r) => planningHold(r, snapshot) === "held");
    if (holder !== undefined) {
      if (d.due) {
        reasons.push({
          subject: holder.unit,
          code: "planning-held",
          message: `${kind} planning is due (${d.why}) but held: ${holder.unit} is ${describeHold(holder)}`,
        });
      }
      continue;
    }
    const stale = records.find((r) => planningHold(r, snapshot) === "stale");
    if (stale === undefined && !d.due) continue;
    const unit = stale?.unit ?? `planning:${kind}.${nextPlanningNumber(snapshot, kind)}`;
    const globs = coordinatorGlobs({ kind: "planning", planning: kind }, snapshot.config);
    const hits: string[] = [];
    for (const other of snapshot.ledger.units) {
      if (other.unit === unit) continue;
      for (const held of heldGlobs(other)) {
        const hit = globs.find((g) => globsOverlap(g, held));
        if (hit !== undefined) hits.push(`glob "${hit}" overlaps "${held}" held by ${other.unit}`);
      }
    }
    if (hits.length > 0) {
      reasons.push({ subject: unit, code: "overlap", message: `${unit} ${hits.join(", ")}` });
      continue;
    }
    if (stale !== undefined) {
      const why = `${stale.unit} is claimed and stale (heartbeat ${stale.heartbeat_at}) with no open PR`;
      return { unit, kind: "planning", globs, expect_generation: stale.generation, take_over: "claimed", pr: null, why };
    }
    const carried = planningPredecessor(snapshot.ledger.units, unit, kind);
    const count = carried === undefined || carried.attempts === 0 ? "" : `; it starts at ${carried.attempts} of ${ATTEMPTS_CAP} attempts, from ${carried.unit}`;
    return { unit, kind: "planning", globs, expect_generation: null, take_over: null, pr: null, why: `${kind} planning is due: ${d.why}${count}` };
  }
  return null;
}
