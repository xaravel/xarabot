import { describe, expect, test } from "bun:test";
import { staleMergingAction, type QueueView, type StaleMergingAction } from "../../../src/core/lane/takeover.ts";

describe("staleMergingAction", () => {
  test.each([
    ["merged, not queued", "merged", { state: "merged", queued: false }],
    ["merged, still listed as queued", "merged", { state: "merged", queued: true }],
    ["open and queued", "take-over", { state: "open", queued: true }],
    ["open, not queued (ejected)", "release", { state: "open", queued: false }],
    ["closed", "release", { state: "closed", queued: false }],
    ["closed, still listed as queued", "release", { state: "closed", queued: true }],
    ["not-found", "release", "not-found"],
  ] as const satisfies readonly (readonly [string, StaleMergingAction, QueueView | "not-found"])[])("%s → %s", (_name, action, q) => {
    expect(staleMergingAction(q)).toBe(action);
  });
});
