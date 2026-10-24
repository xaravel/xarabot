import { describe, expect, test } from "bun:test";
import { checkBuildSpec, expectedSpecStatus, pickSpec, specMatches, specStatus, type SpecMatch } from "../../../src/core/lane/build-check.ts";
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

describe("pickSpec", () => {
  type Outcome = BuildResult["outcome"];
  const DIR = "_bmad-output/implementation-artifacts";
  const m = (name: string, status: string | null): SpecMatch => ({ path: `${DIR}/${name}`, text: status === null ? null : spec(status, `Status: ${status}`) });
  const A_BLOCKED = m("spec-1-1-a.md", "blocked");
  const B_DONE = m("spec-1-1-b.md", "done");
  const C_DONE = m("spec-1-1-c.md", "done");
  const D_DRAFT = m("spec-1-1-d.md", "draft");
  const E_UNREADABLE = m("spec-1-1-e.md", null);
  const F_BLOCKED = m("spec-1-1-f.md", "blocked");
  const NO_FRONTMATTER: SpecMatch = { path: `${DIR}/spec-1-1-g.md`, text: "# Spec\n" };
  const BAD_YAML: SpecMatch = { path: `${DIR}/spec-1-1-h.md`, text: "---\nstatus: [\n---\n" };

  /** [name, outcome, matches, the spec picked (null: none), superseded] or [name, outcome, matches, an error fragment]. */
  const cases: readonly (readonly [string, Outcome, readonly SpecMatch[], SpecMatch | null, readonly SpecMatch[]] | readonly [string, Outcome, readonly SpecMatch[], string])[] = [
    // done
    ["done, 0 matches", "done", [], "0 files match"],
    ["done, 1 done match", "done", [B_DONE], B_DONE, []],
    ["done, 1 blocked match", "done", [A_BLOCKED], "exactly one"],
    ["done, blocked + done: the done one, the blocked one superseded", "done", [A_BLOCKED, B_DONE], B_DONE, [A_BLOCKED]],
    ["done, two blocked + done", "done", [A_BLOCKED, B_DONE, F_BLOCKED], B_DONE, [A_BLOCKED, F_BLOCKED]],
    ["done, two done", "done", [B_DONE, C_DONE], "exactly one"],
    ["done, two blocked", "done", [A_BLOCKED, F_BLOCKED], "exactly one"],
    ["done, done + draft", "done", [B_DONE, D_DRAFT], "draft"],
    ["done, done + an unreadable match", "done", [B_DONE, E_UNREADABLE], "(unreadable)"],
    ["done, an unreadable match alone", "done", [E_UNREADABLE], "(unreadable)"],
    ["done, done + a match with no frontmatter", "done", [B_DONE, NO_FRONTMATTER], "(no status)"],
    ["done, done + a match with bad YAML", "done", [B_DONE, BAD_YAML], "(no status)"],
    // no-op follows done
    ["no-op, 0 matches", "no-op", [], "0 files match"],
    ["no-op, 1 done match", "no-op", [B_DONE], B_DONE, []],
    ["no-op, blocked + done", "no-op", [A_BLOCKED, B_DONE], B_DONE, [A_BLOCKED]],
    ["no-op, two done", "no-op", [B_DONE, C_DONE], "exactly one"],
    // blocked
    ["blocked, 0 matches: no cross-check, no failure", "blocked", [], null, []],
    ["blocked, 1 blocked match: the spec", "blocked", [A_BLOCKED], A_BLOCKED, []],
    ["blocked, 1 done match: the spec, for checkBuildSpec to refuse", "blocked", [B_DONE], B_DONE, []],
    ["blocked, 1 unreadable match", "blocked", [E_UNREADABLE], "cannot be read"],
    ["blocked, 2 matches: no cross-check, no failure", "blocked", [A_BLOCKED, B_DONE], null, []],
    ["blocked, 3 matches with an unreadable one", "blocked", [A_BLOCKED, B_DONE, E_UNREADABLE], null, []],
  ];
  test.each(cases.map((c) => [c[0], c] as const))("%s", (_name, c) => {
    const [, outcome, matches, want] = c;
    const superseded = c.length === 5 ? c[4] : [];
    const r = pickSpec(outcome, matches);
    if (typeof want === "string") {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe("invalid");
        expect(r.error.message).toContain(want);
      }
      return;
    }
    expect(r).toEqual({
      ok: true,
      value: { spec: want === null ? null : { path: want.path, text: want.text as string }, superseded: superseded.map((x) => x.path) },
    });
  });

  test("a blocked result with one done spec: picked, then checkBuildSpec refuses it", () => {
    const r = pickSpec("blocked", [B_DONE]);
    if (!r.ok || r.value.spec === null) throw new Error("no spec picked");
    expect(checkBuildSpec("blocked", r.value.spec.text).ok).toBe(false);
  });
});

describe("specStatus", () => {
  test.each([
    ["a plain status", spec("done", null), "done"],
    ["a quoted status", spec("'blocked'", null), "blocked"],
    ["no text", null, null],
    ["no frontmatter", "# x\n", null],
    ["bad YAML", "---\nstatus: [\n---\n", null],
    ["a non-string status", "---\nstatus: [done]\n---\n", null],
    ["no status key", "---\ntitle: x\n---\n", null],
  ] as const)("%s", (_name, text, want) => {
    expect(specStatus(text)).toBe(want);
  });
});
