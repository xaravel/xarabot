import { describe, expect, test } from "bun:test";
import { checkTransition, LEDGER_EDGES, type LedgerNode } from "../../../src/core/ledger/transitions.ts";

const NODES: readonly LedgerNode[] = ["none", "claimed", "merging", "parked", "released", "merged"];

/** The diagram's edges, written out independently of LEDGER_EDGES. */
const DIAGRAM = new Set([
  "none>claimed",
  "none>parked",
  "released>claimed",
  "released>merged",
  "claimed>claimed",
  "claimed>merging",
  "claimed>parked",
  "claimed>released",
  "claimed>merged",
  "merging>merging",
  "merging>merged",
  "merging>claimed",
  "merging>parked",
  "merging>released",
  "parked>merging",
  "parked>merged",
  "parked>released",
  "merged>none",
]);

describe("checkTransition", () => {
  test("LEDGER_EDGES is the diagram", () => {
    expect(new Set(LEDGER_EDGES.map(([f, t]) => `${f}>${t}`))).toEqual(DIAGRAM);
    expect(LEDGER_EDGES.length).toBe(DIAGRAM.size);
  });
  let pairs = 0;
  for (const from of NODES) {
    for (const to of NODES) {
      pairs += 1;
      const legal = DIAGRAM.has(`${from}>${to}`);
      test(`${from} -> ${to} is ${legal ? "ok" : "illegal"}`, () => {
        const r = checkTransition(from, to);
        expect(r.ok).toBe(legal);
        if (!r.ok) expect(r.error.kind).toBe("illegal-transition");
      });
    }
  }
  test("covers all 36 pairs", () => {
    expect(pairs).toBe(36);
  });
});
