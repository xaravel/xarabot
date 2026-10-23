import { describe, expect, test } from "bun:test";
import { storySpecGlob } from "../../../src/core/config/story-spec-path.ts";
import { CONFIG_DEFAULTS } from "../../../src/core/schemas/config.ts";

const DEFAULT = CONFIG_DEFAULTS.story_spec_path;

describe("storySpecGlob", () => {
  const okCases: readonly [string, string, string][] = [
    [DEFAULT, "1.7", "_bmad-output/implementation-artifacts/spec-1-7-*.md"],
    [DEFAULT, "1.17a", "_bmad-output/implementation-artifacts/spec-1-17a-*.md"],
    [DEFAULT, "12.3", "_bmad-output/implementation-artifacts/spec-12-3-*.md"],
    ["specs/<epic>/<story>/<epic>.md", "2.4", "specs/2/4/2.md"],
  ];
  for (const [pattern, id, expected] of okCases) {
    test(`${pattern} with ${id}`, () => {
      expect(storySpecGlob(pattern, id)).toEqual({ ok: true, value: expected });
    });
  }

  const badIds = ["1", "1.", "1.7A", "1.7ab", "a.1", "1.2.3", " 1.7", "story:1.7", "", "0.7", "1.0", "01.7", "1.07"];
  for (const id of badIds) {
    test(`bad id ${JSON.stringify(id)}`, () => {
      const r = storySpecGlob(DEFAULT, id);
      expect(r.ok ? "ok" : r.error.kind).toBe("invalid");
    });
  }

  test("pattern without placeholders", () => {
    const r = storySpecGlob("spec-<epic>.md", "1.7");
    expect(r.ok ? "ok" : r.error.kind).toBe("invalid");
  });
});
