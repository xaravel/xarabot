import { describe, expect, test } from "bun:test";
import { LOOPBACK_CAP, reviewNext } from "../../../src/core/review/gate.ts";

describe("reviewNext (Story 3.5)", () => {
  test("the cap is 2", () => {
    expect(LOOPBACK_CAP).toBe(2);
  });
  test.each([
    [0, false, "pass"],
    [0, true, "loopback"],
    [1, false, "pass"],
    [1, true, "loopback"],
    [2, true, "cap"],
    [2, false, "cap"],
    [3, false, "cap"],
    [3, true, "cap"],
  ] as const)("loopbacks %p, blocking %p: %s", (loopbacks, blocking, want) => {
    expect(reviewNext({ loopbacks, blocking })).toBe(want);
  });
});
