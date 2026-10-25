import { checkGraphChange, type GraphDelta } from "../core/graph/graph-gate.ts";
import { parseLedger } from "../core/ledger/codec.ts";
import type { ForgePr, ForgeResult } from "../ports/forge.ts";
import type { GraphTrees } from "./graph-trees.ts";

/**
 * The graph-change gate (Story 2.8, FR2, NFR18, AR12, AR17), shared by the
 * builder merge step, the graph planning step and `reconcile`'s take: the
 * `GraphTrees` port gives `main`'s tree and the merge tree, `checkGraphChange`
 * compares them, and each removed Story id no other use refused is looked up
 * by `listPrsByBranch` (a PR in any state on its branch refuses it).
 */

export type GraphGateRequest = {
  /** The PR's head. */
  readonly headSha: string;
  /** The fresh `main`. */
  readonly mainSha: string;
  /** The fresh snapshot's ledger files, for the ledger records that make an id used. */
  readonly ledgerFiles: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  /** Every PR on `branch`, through the step's own forge call. */
  readonly listPrsByBranch: (branch: string) => Promise<ForgeResult<readonly ForgePr[]>>;
};

export type GraphGateOutcome =
  /** The merge result's hash equals `main`'s, and nothing is refused. */
  | { readonly kind: "pass"; readonly hash: string; readonly delta: GraphDelta }
  /** The graph changes, and nothing is refused: the Maintainer must approve the head. */
  | { readonly kind: "change"; readonly mainHash: string; readonly mergedHash: string; readonly delta: GraphDelta }
  /** The merge result is refused: park `blocked` `graph-invalid`. */
  | { readonly kind: "refuse"; readonly refusals: readonly string[] }
  /** The merge with `main` conflicts. */
  | { readonly kind: "conflict"; readonly paths: readonly string[] }
  /** `main` does not resolve, or a read failed. */
  | { readonly kind: "error"; readonly message: string };

/** Runs the gate. Never throws, except what `listPrsByBranch` throws (a lane stop). */
export async function gateGraph(trees: GraphTrees, r: GraphGateRequest): Promise<GraphGateOutcome> {
  let read: Awaited<ReturnType<GraphTrees>>;
  try {
    read = await trees({ headSha: r.headSha, mainSha: r.mainSha, signal: r.signal });
  } catch (e) {
    read = { ok: false, error: { kind: "transient", message: `graph trees threw: ${e instanceof Error ? e.message : String(e)}` } };
  }
  if (!read.ok) return { kind: "error", message: `graph trees ${read.error.kind}: ${read.error.message}` };
  if (read.value.kind === "conflict") return { kind: "conflict", paths: read.value.paths };

  const ledger = parseLedger(r.ledgerFiles);
  if (!ledger.ok) return { kind: "error", message: `ledger ${ledger.error.kind}: ${ledger.error.message}` };
  const checked = checkGraphChange({ main: read.value.main, merged: read.value.merged, ledgerUnits: [...ledger.value.units.keys()] });
  if (checked.kind === "main-invalid") return { kind: "error", message: checked.message };
  if (checked.kind === "invalid") return { kind: "refuse", refusals: [checked.message] };

  const refusals = [...checked.refusals];
  for (const c of checked.branchChecks) {
    const listed = await r.listPrsByBranch(c.branch);
    if (!listed.ok) return { kind: "error", message: `listPrsByBranch ${c.branch} ${listed.error.kind}: ${listed.error.message}` };
    if (listed.value.length > 0) {
      const prs = listed.value.map((p) => `#${p.number} (${p.state})`).join(", ");
      refusals.push(`Story ${c.id} is removed, but it is used: ${c.branch} has PR ${prs}`);
    }
  }
  if (refusals.length > 0) return { kind: "refuse", refusals };
  if (!checked.changed) return { kind: "pass", hash: checked.mergedHash, delta: checked.delta };
  return { kind: "change", mainHash: checked.mainHash, mergedHash: checked.mergedHash, delta: checked.delta };
}
