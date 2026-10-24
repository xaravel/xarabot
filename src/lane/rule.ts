import { applyRuling } from "../core/ledger/edits.ts";
import { parseLedger } from "../core/ledger/codec.ts";
import { err, ok, type Result } from "../core/result.ts";
import type { LaneIdentity, Park } from "../core/schemas/ledger.ts";
import type { Forge } from "../ports/forge.ts";
import { swapLedger, type Sleep } from "./ledger-cas.ts";
import { DEFAULT_CALL_TIMEOUT_MS } from "./stop.ts";

/**
 * A host ruling (Story 2.5b): the Maintainer's `xarabot rule release|rebuild
 * <unit-id>`, run on the host as the lane user. One snapshot; the record must
 * exist and be `parked`. `rebuild` first closes the record's PR when the
 * snapshot shows it open, then both make one fenced `applyRuling` edit at the
 * record's generation: the edit re-checks the state and generation on every
 * re-fetched tip, so a record that moved on is refused and nothing is written.
 * Each forge call and the swap has its own deadline.
 */

/** The verbs a host ruling takes before Story 4.6. */
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
