import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { heartbeat, release } from "../core/ledger/edits.ts";
import { parseLedger } from "../core/ledger/codec.ts";
import { err, ok, type Result } from "../core/result.ts";
import type { LaneIdentity } from "../core/schemas/ledger.ts";
import type { Forge } from "../ports/forge.ts";
import { swapLedger } from "./ledger-cas.ts";
import { laneLayout } from "./lane-store.ts";
import { killRecorded, type KillReport, type ProcessTable } from "./processes.ts";

/**
 * `xarabot wake`, `xarabot stop` and `xarabot stop --now` (FR15, AR3, AR23,
 * AR44, AD-7, AD-22). Every kill goes through `killRecorded`: the recorded
 * PID, checked for its start time and command, and nothing else.
 */

export const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** Writes a STOP marker (`stop\n`), creating its folder. */
export function writeStop(path: string): Result<void, "io"> {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "stop\n");
    return ok(undefined);
  } catch (e) {
    return err("io", `${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Ends the lane's wait: kills the `sleep` that `wait.pid` records, and nothing else. */
export function wakeLane(table: ProcessTable, laneDir: string): KillReport {
  return killRecorded(table, join(laneLayout(laneDir).laneDir, "wait.pid"), { first: true, expect: "sleep" });
}

export type ReleaseReport = {
  readonly released: readonly string[];
  /** `unit` is `null` for a failure before any record (the snapshot or the ledger). */
  readonly failed: readonly { readonly unit: string | null; readonly message: string }[];
};

export type StopNowReport = {
  readonly stop: Result<void, "io">;
  readonly kills: readonly { readonly name: "lane" | "agent" | "wait"; readonly report: KillReport }[];
  readonly release: ReleaseReport;
};

export type StopNowParams = {
  readonly laneDir: string;
  readonly table: ProcessTable;
  readonly release: () => Promise<ReleaseReport>;
};

/** Writes the lane's STOP, kills its lane, agent and wait in that order, then releases what it held. */
export async function stopNow(p: StopNowParams): Promise<StopNowReport> {
  const layout = laneLayout(p.laneDir);
  const stop = writeStop(layout.stop);
  const kills: { name: "lane" | "agent" | "wait"; report: KillReport }[] = [];
  for (const name of ["lane", "agent", "wait"] as const) {
    kills.push({ name, report: killRecorded(p.table, join(layout.laneDir, `${name}.pid`), { first: name === "wait" }) });
  }
  let released: ReleaseReport;
  try {
    released = await p.release();
  } catch (e) {
    released = { released: [], failed: [{ unit: null, message: `release threw: ${e instanceof Error ? e.message : String(e)}` }] };
  }
  return { stop, kills, release: released };
}

export type ReleaseHeldParams = {
  readonly forge: Forge;
  readonly identity: LaneIdentity;
  /** Each forge call's and ledger swap's deadline; default 60 000 ms. */
  readonly callTimeoutMs?: number;
};

/**
 * Releases every unit `identity` holds `claimed` or `merging`, with no
 * attempt counted. A `merging` record with a PR is fenced (a `heartbeat`
 * swap at its generation) and dequeued first; a failed fence or dequeue
 * leaves that record as it is.
 */
export async function releaseHeld(p: ReleaseHeldParams): Promise<ReleaseReport> {
  const timeout = p.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const released: string[] = [];
  const failed: { unit: string | null; message: string }[] = [];
  const snap = await p.forge.snapshot({ signal: AbortSignal.timeout(timeout) });
  if (!snap.ok) return { released, failed: [{ unit: null, message: `snapshot ${snap.error.kind}: ${snap.error.message}` }] };
  const ledger = parseLedger(snap.value.ledger.files);
  if (!ledger.ok) return { released, failed: [{ unit: null, message: `ledger ${ledger.error.kind}: ${ledger.error.message}` }] };
  const { owner, host, lane } = p.identity;
  const held = [...ledger.value.units.values()].filter(
    (r) => r.owner === owner && r.host === host && r.lane === lane && (r.state === "claimed" || r.state === "merging"),
  );
  for (const r of held) {
    if (r.state === "merging" && r.pr !== null) {
      // Fence first: a record another lane took over is neither dequeued nor released.
      const fenced = await swapLedger({
        forge: p.forge,
        edit: heartbeat({ unit: r.unit, by: p.identity, now: snap.value.now, generation: r.generation }),
        signal: AbortSignal.timeout(timeout),
      });
      if (!fenced.ok) {
        failed.push({ unit: r.unit, message: `dequeue fence ${fenced.error.kind}: ${fenced.error.message}` });
        continue;
      }
      const dq = await p.forge.dequeue(r.pr, { signal: AbortSignal.timeout(timeout) });
      if (!dq.ok) {
        failed.push({ unit: r.unit, message: `dequeue PR #${r.pr} ${dq.error.kind}: ${dq.error.message}` });
        continue;
      }
    }
    const swapped = await swapLedger({
      forge: p.forge,
      edit: release({ unit: r.unit, by: p.identity, now: snap.value.now, generation: r.generation }),
      signal: AbortSignal.timeout(timeout),
    });
    if (swapped.ok) released.push(r.unit);
    else failed.push({ unit: r.unit, message: `release ${swapped.error.kind}: ${swapped.error.message}` });
  }
  return { released, failed };
}
