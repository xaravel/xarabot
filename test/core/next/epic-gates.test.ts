import { describe, expect, test } from "bun:test";
import { isOpenItem } from "../../../src/core/next/epic-gates.ts";
import type { RetroItem } from "../../../src/core/schemas/retro-gates.ts";

describe("isOpenItem: the one open retro item rule (Epic 4 retro item 5)", () => {
  test.each([
    ["open", true],
    ["in-progress", true],
    ["waiting", true],
    ["deferred", false],
    ["done", false],
  ] as const)("%s is open: %p", (status: RetroItem["status"], open) => {
    expect(isOpenItem(status)).toBe(open);
  });
});
