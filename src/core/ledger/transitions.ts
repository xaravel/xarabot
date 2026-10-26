import { err, ok, type Result } from "../result.ts";
import type { UnitState } from "../schemas/ledger.ts";

/** A diagram node: a unit state, or `none` for no record. */
export type LedgerNode = UnitState | "none";

/** Every `(from, to)` edge of the normative ledger state diagram (AD-7). */
export const LEDGER_EDGES: readonly (readonly [LedgerNode, LedgerNode])[] = [
  ["none", "claimed"],
  ["none", "parked"],
  ["released", "claimed"],
  ["released", "merged"],
  ["released", "none"],
  ["claimed", "claimed"],
  ["claimed", "merging"],
  ["claimed", "parked"],
  ["claimed", "released"],
  ["claimed", "merged"],
  ["merging", "merging"],
  ["merging", "merged"],
  ["merging", "claimed"],
  ["merging", "parked"],
  ["merging", "released"],
  ["parked", "merging"],
  ["parked", "parked"],
  ["parked", "merged"],
  ["parked", "released"],
  ["merged", "none"],
];

/** `ok` when `(from, to)` is a diagram edge, else `illegal-transition`. */
export function checkTransition(from: LedgerNode, to: LedgerNode): Result<null, "illegal-transition"> {
  if (LEDGER_EDGES.some(([f, t]) => f === from && t === to)) return ok(null);
  return err("illegal-transition", `ledger transition ${from} -> ${to} is not in the state diagram`);
}
