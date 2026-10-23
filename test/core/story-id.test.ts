import { describe, expect, test } from "bun:test";
import { compareStoryIds, STORY_ID_PATTERN, StoryId } from "../../src/core/story-id.ts";

describe("StoryId", () => {
  for (const id of ["1.1", "2.6a", "1.17a", "12.30", "0.0"]) {
    test(`accepts ${id}`, () => {
      expect(STORY_ID_PATTERN.test(id)).toBe(true);
      expect(StoryId.safeParse(id).success).toBe(true);
    });
  }
  for (const id of ["1.7A", "x", "1", "1.", ".1", "1.2.3", "1.2ab", " 1.2", "1.2 ", "story:1.2", ""]) {
    test(`rejects ${JSON.stringify(id)}`, () => {
      expect(StoryId.safeParse(id).success).toBe(false);
    });
  }
  test("rejects a YAML number with a quoting hint", () => {
    const r = StoryId.safeParse(1.1);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toContain("quoted string");
  });
});

describe("compareStoryIds", () => {
  const cases: readonly [string[], string[]][] = [
    [["2.10", "2.6a", "2.6"], ["2.6", "2.6a", "2.10"]],
    [["10.1", "2.1", "1.20", "1.3"], ["1.3", "1.20", "2.1", "10.1"]],
    [["1.1b", "1.1", "1.1a"], ["1.1", "1.1a", "1.1b"]],
    [["x", "1.2", "b", "1.1"], ["1.1", "1.2", "b", "x"]],
    [["1.1", "b", "1.2", "x"], ["1.1", "1.2", "b", "x"]],
  ];
  for (const [input, expected] of cases) {
    test(`${input.join(", ")}`, () => {
      expect([...input].sort(compareStoryIds)).toEqual(expected);
    });
  }
  test("fallback is antisymmetric in both argument orders", () => {
    const rows: readonly [string, string, number][] = [
      ["1.1", "x", -1],
      ["x", "1.1", 1],
      ["b", "x", -1],
      ["x", "b", 1],
      ["x", "x", 0],
    ];
    for (const [a, b, expected] of rows) expect(compareStoryIds(a, b)).toBe(expected);
  });
  test("equal ids compare 0", () => {
    expect(compareStoryIds("2.6a", "2.6a")).toBe(0);
  });
});
