import { describe, expect, test } from "bun:test";
import { digestDue, digestSlot } from "../../../src/core/inbox/digest-time.ts";
import * as coordinator from "../../../src/core/next/coordinator.ts";

describe("digestSlot", () => {
  test.each([
    ["the default slot, later that day", "2026-10-22T10:10:00Z", "08:00", "2026-10-22T08:00:00.000Z"],
    ["before the slot: still today's", "2026-10-22T07:00:00Z", "08:00", "2026-10-22T08:00:00.000Z"],
    ["an offset now is read in UTC", "2026-10-23T01:30:00+02:00", "17:30", "2026-10-22T17:30:00.000Z"],
    ["midnight", "2026-10-22T23:59:59Z", "00:00", "2026-10-22T00:00:00.000Z"],
  ] as const)("%s → %s", (_name, now, time, want) => {
    expect(digestSlot(now, time)).toBe(want);
  });
});

describe("digestDue", () => {
  test.each([
    ["before the slot", "2026-10-22T07:59:59Z", null, false],
    ["at the slot, never posted", "2026-10-22T08:00:00Z", null, true],
    ["after the slot, posted yesterday", "2026-10-22T10:00:00Z", "2026-10-21T08:00:00Z", true],
    ["after the slot, posted at it", "2026-10-22T10:00:00Z", "2026-10-22T08:00:00Z", false],
    ["after the slot, posted after it", "2026-10-22T10:00:00Z", "2026-10-22T09:00:00Z", false],
  ] as const)("%s → %p", (_name, now, posted, want) => {
    expect(digestDue(now, "08:00", posted)).toBe(want);
  });

  test("the coordinator side re-exports the leaf's functions", () => {
    expect(coordinator.digestDue).toBe(digestDue);
    expect(coordinator.digestSlot).toBe(digestSlot);
  });
});
