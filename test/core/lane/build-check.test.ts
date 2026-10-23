import { describe, expect, test } from "bun:test";
import { checkBuildSpec, expectedSpecStatus, specMatches } from "../../../src/core/lane/build-check.ts";
import type { BuildResult } from "../../../src/core/schemas/session-result.ts";

const spec = (status: string, result: string | null, extra = "") =>
  `---\ntitle: 'Story 1.1'\nstatus: ${status}\n---\n\n# Story\n\nBody.\n${result === null ? "" : `\n## Auto Run Result\n\n${result}\n`}${extra}`;

describe("specMatches", () => {
  const paths = [
    "_bmad-output/implementation-artifacts/spec-1-1-first.md",
    "_bmad-output/implementation-artifacts/spec-1-10-tenth.md",
    "_bmad-output/implementation-artifacts/spec-1-1a-suffix.md",
    "_bmad-output/implementation-artifacts/old/spec-1-1-nested.md",
    "src/spec-1-1-x.md",
  ];
  test("keeps only the paths the glob matches, in order", () => {
    expect(specMatches("_bmad-output/implementation-artifacts/spec-1-1-*.md", paths)).toEqual([
      "_bmad-output/implementation-artifacts/spec-1-1-first.md",
    ]);
  });
  test("no match is an empty list", () => {
    expect(specMatches("_bmad-output/implementation-artifacts/spec-2-1-*.md", paths)).toEqual([]);
  });
});

describe("checkBuildSpec", () => {
  type Outcome = BuildResult["outcome"];
  const cases: readonly [string, Outcome, string, string | null][] = [
    ["done with status done", "done", spec("done", "Status: done"), null],
    ["quoted frontmatter status", "done", spec("'done'", "Status: done"), null],
    ["a bold label with the colon inside", "done", spec("done", "**Status:** done"), null],
    ["a bold label with the colon outside", "done", spec("done", "**Status**: done"), null],
    ["the Status line after other lines", "done", spec("done", "Some text.\n\nStatus: done\n\n**Summary:** x"), null],
    ["no-op checks against done", "no-op", spec("done", "Status: done"), null],
    ["blocked with status blocked", "blocked", spec("blocked", "Status: blocked"), null],
    ["done with frontmatter in-review", "done", spec("in-review", "Status: done"), "frontmatter status"],
    ["blocked with frontmatter done", "blocked", spec("done", "Status: done"), "frontmatter status"],
    ["no-op with frontmatter no-op", "no-op", spec("no-op", "Status: no-op"), "frontmatter status"],
    ["no status in the frontmatter", "done", "---\ntitle: x\n---\n\n## Auto Run Result\n\nStatus: done\n", "frontmatter status"],
    ["no frontmatter", "done", "# Story\n\n## Auto Run Result\n\nStatus: done\n", "no YAML frontmatter"],
    ["bad frontmatter YAML", "done", "---\nstatus: [\n---\n", "invalid YAML"],
    ["no Auto Run Result heading", "done", spec("done", null), "no \"## Auto Run Result\" heading"],
    ["a deeper heading is not the section", "done", spec("done", null, "\n### Auto Run Result\n\nStatus: done\n"), "heading"],
    ["no Status line in the section", "done", spec("done", "**Summary:** done"), "no Status: line"],
    ["a Status line only after the section ends", "done", spec("done", "Text.", "\n## Next\n\nStatus: done\n"), "no Status: line"],
    ["a Status line that differs", "done", spec("done", "Status: blocked"), "Status is \"blocked\""],
    ["blocked with the section done", "blocked", spec("blocked", "Status: done"), "Status is \"done\""],
  ];
  test.each(cases)("%s", (_name, outcome, text, error) => {
    const r = checkBuildSpec(outcome, text);
    if (error === null) {
      expect(r).toEqual({ ok: true, value: { status: expectedSpecStatus(outcome) } });
    } else {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe("invalid");
        expect(r.error.message).toContain(error);
      }
    }
  });
});
