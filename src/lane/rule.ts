import { applyRuling } from "../core/ledger/edits.ts";
import { parseLedger } from "../core/ledger/codec.ts";
import { assembleSnapshot } from "../core/next/snapshot.ts";
import { err, ok, type Result } from "../core/result.ts";
import { HOST_RULING_ID, judgeRulings, rulingsEdit, type RulingEffect } from "../core/rulings/effects.ts";
import type { RulingVerb } from "../core/rulings/rulings.ts";
import type { LaneIdentity, Park } from "../core/schemas/ledger.ts";
import type { Forge } from "../ports/forge.ts";
import { swapLedger, type Sleep } from "./ledger-cas.ts";
import { readsPath } from "./session.ts";
import { DEFAULT_CALL_TIMEOUT_MS } from "./stop.ts";

/**
 * A host ruling (Story 2.5b): the Maintainer's `xarabot rule release|rebuild
 * <unit-id>`, run on the host as the lane user. One snapshot; the record must
 * exist and be `parked`. `rebuild` first closes the record's PR when the
 * snapshot shows it open, then both make one fenced `applyRuling` edit at the
 * record's generation: the edit re-checks the state and generation on every
 * re-fetched tip, so a record that moved on is refused and nothing is written.
 * Each forge call and the swap has its own deadline.
 *
 * Story 4.6: every other verb (`applyHostVerb`) is judged as the Maintainer
 * (`config.maintainer`) against one assembled snapshot, with the comment
 * rulings' rules (`judgeRulings`, source `host`), and swaps the same
 * `applyRuling` or `recordRulings` edit (`rulingsEdit`) without moving the
 * rulings cursor. A pending entry from the host is the Maintainer's, at the
 * snapshot's `now`, with `ruling` `xarabot-rule`.
 */

/** The verbs a host ruling takes on Story 2.5b's path. */
export type HostRuling = "release" | "rebuild";

export type HostRulingParams = {
  readonly forge: Forge;
  /** The writer of the edit. */
  readonly identity: LaneIdentity;
  readonly unit: string;
  readonly ruling: HostRuling;
  /** Each forge call's and the swap's deadline; default 60 000 ms. */
  readonly callTimeoutMs?: number;
  /** The swap's back-off sleep and jitter source (tests). */
  readonly sleep?: Sleep;
  readonly random?: () => number;
};

export type HostRulingReport = {
  readonly unit: string;
  /** The record's generation, unchanged by the ruling. */
  readonly generation: number;
  /** The park the ruling ended. */
  readonly park: Park;
  /** The PR `rebuild` closed, or `null`. */
  readonly closedPr: number | null;
};

export type HostRulingErrorKind = "refused" | "forge" | "ledger";

export async function applyHostRuling(p: HostRulingParams): Promise<Result<HostRulingReport, HostRulingErrorKind>> {
  const timeout = p.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const snap = await p.forge.snapshot({ signal: AbortSignal.timeout(timeout) });
  if (!snap.ok) return err("forge", `snapshot ${snap.error.kind}: ${snap.error.message}`);
  const ledger = parseLedger(snap.value.ledger.files);
  if (!ledger.ok) return err("ledger", `ledger ${ledger.error.kind}: ${ledger.error.message}`);
  const rec = ledger.value.units.get(p.unit);
  if (rec === undefined) return err("refused", `${p.unit} has no ledger record`);
  if (rec.state !== "parked" || rec.park === null) return err("refused", `${p.unit} is ${rec.state}, not parked`);

  // Close before the edit: a re-run after a failed edit finds the PR closed and skips this.
  let closedPr: number | null = null;
  if (p.ruling === "rebuild" && rec.pr !== null && snap.value.prs[p.unit]?.state === "open") {
    const closed = await p.forge.closePr(rec.pr, { signal: AbortSignal.timeout(timeout) });
    if (!closed.ok) return err("forge", `closePr #${rec.pr} ${closed.error.kind}: ${closed.error.message}; the ledger is unchanged`);
    closedPr = rec.pr;
  }

  const swapped = await swapLedger({
    forge: p.forge,
    edit: applyRuling({ unit: p.unit, by: p.identity, now: snap.value.now, generation: rec.generation, ruling: p.ruling }),
    signal: AbortSignal.timeout(timeout),
    ...(p.sleep !== undefined ? { sleep: p.sleep } : {}),
    ...(p.random !== undefined ? { random: p.random } : {}),
  });
  if (!swapped.ok) {
    const e = swapped.error;
    const closedNote = closedPr === null ? "" : ` (PR #${closedPr} was closed)`;
    return err("ledger", `applyRuling ${e.kind}${e.kind === "edit" ? ` ${e.edit}` : ""}: ${e.message}${closedNote}`);
  }
  return ok({ unit: p.unit, generation: rec.generation, park: rec.park, closedPr });
}

/** The verbs `applyHostVerb` takes: every ruling verb but Story 2.5b's two. */
export type HostVerb = Exclude<RulingVerb, HostRuling>;

export type HostVerbParams = {
  readonly forge: Forge;
  /** The writer of the edit: the repo's coordinator lane for the verbs that write `coordinator.json`. */
  readonly identity: LaneIdentity;
  /** The repo slug, for the snapshot's config. */
  readonly repo: string;
  readonly unit: string;
  readonly verb: HostVerb;
  /** The snapshot's and the swap's deadline; default 60 000 ms. */
  readonly callTimeoutMs?: number;
  readonly sleep?: Sleep;
  readonly random?: () => number;
};

export type HostVerbReport = {
  readonly unit: string;
  readonly verb: HostVerb;
  /** What the ruling wrote. */
  readonly effect: RulingEffect;
};

/**
 * A host ruling of any verb but `release` and `rebuild` (Story 4.6): one
 * snapshot, assembled; the ruling judged as the Maintainer, so a refusal
 * names the comment ruling's reason; then one swap of its edit. The edit
 * re-checks its preconditions on every re-fetched tip.
 */
export async function applyHostVerb(p: HostVerbParams): Promise<Result<HostVerbReport, HostRulingErrorKind>> {
  const timeout = p.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const snap = await p.forge.snapshot({ signal: AbortSignal.timeout(timeout), read: readsPath });
  if (!snap.ok) return err("forge", `snapshot ${snap.error.kind}: ${snap.error.message}`);
  const s = snap.value;
  const assembled = assembleSnapshot({
    repo: p.repo,
    now: s.now,
    tree: [...s.main.tree],
    files: { ...s.main.files },
    main_sha: s.main.sha,
    blob_shas: s.main.blob_shas,
    ledger_tip: s.ledger.tip,
    ledger_files: s.ledger.files,
    prs: s.prs,
    escalations: null,
    lane: p.identity,
    role: p.identity.lane === "coordinator" ? "coordinator" : "builder",
  });
  if (!assembled.ok) return err("ledger", `snapshot ${assembled.error.kind}: ${assembled.error.message}`);
  const view = assembled.value;
  const maintainer = view.config.maintainer;
  const { judged } = judgeRulings(view, [{ author: maintainer, body: `/xarabot ${p.verb} ${p.unit}`, id: HOST_RULING_ID, created_at: view.now }], "host");
  const one = judged[0];
  if (one === undefined || one.judgement.kind === "ignored") return err("refused", `${p.verb} ${p.unit} is not a ruling`);
  if (one.judgement.kind === "refused" || one.effect === null) {
    return err("refused", one.judgement.kind === "refused" ? one.judgement.reason : `${p.verb} ${p.unit} has no effect`);
  }
  const effect = one.effect;
  const swapped = await swapLedger({
    forge: p.forge,
    edit: rulingsEdit({
      by: p.identity,
      now: view.now,
      coordinatorGeneration: view.ledger.coordinator?.generation ?? null,
      cursor: null,
      judged,
      drops: { pending: [], dismissals: [] },
    }),
    signal: AbortSignal.timeout(timeout),
    ...(p.sleep !== undefined ? { sleep: p.sleep } : {}),
    ...(p.random !== undefined ? { random: p.random } : {}),
  });
  if (!swapped.ok) {
    const e = swapped.error;
    return err("ledger", `${effect.kind === "ledger" ? "applyRuling" : "recordRulings"} ${e.kind}${e.kind === "edit" ? ` ${e.edit}` : ""}: ${e.message}`);
  }
  return ok({ unit: p.unit, verb: p.verb, effect });
}
