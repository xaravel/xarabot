import { describe, expect, test } from "bun:test";
import { checkRetroDiff, checkRetroResult, refusedGlobs, refusedItemGlobs, retroDocGlob, type RetroTree } from "../../../src/core/retro/validate.ts";
import { CONFIG_DEFAULTS } from "../../../src/core/schemas/config.ts";
import type { RetroResult } from "../../../src/core/schemas/session-result.ts";

const CONFIG = { ...CONFIG_DEFAULTS, manifests: { dir: "stories" }, standing_authority_path: "docs/standing-authority.md" };
const POLICY = { effective_protected_paths: [".xarabot/**", "docs/standing-authority.md", ".github/**", "secrets/**", "**/*.pem"] };
const STATUS = CONFIG_DEFAULTS.sprint_status_path;
const DOC = "_bmad-output/implementation-artifacts/epic-2-retro-2026-10-25.md";

const item = (id: string, globs: readonly string[] = ["src/x/**"]) => ({ id, text: `Do ${id}`, route: "lane" as const, blocking: false, globs: [...globs] });
const result = (items: ReturnType<typeof item>[], verdict: RetroResult["verdict"] = "accepted"): Pick<RetroResult, "verdict" | "items"> => ({ verdict, items });

describe("refusedItemGlobs", () => {
  test("the refused globs: graph inputs, status files, .xarabot, the Standing Authority, .github, agent config, live evidence, Protected Paths", () => {
    const r = refusedGlobs(CONFIG, POLICY);
    for (const g of [CONFIG_DEFAULTS.epics_path, ".xarabot/epics.yaml", "stories/*.md", STATUS, CONFIG_DEFAULTS.retro_gates_path, ".xarabot/**", "docs/standing-authority.md", ".github/**", "**/CLAUDE.md", "docs/maintainer/evidence/epic-*.md", "secrets/**", "**/*.pem"]) {
      expect([g, r.includes(g)]).toEqual([g, true]);
    }
    expect(new Set(r).size).toBe(r.length);
  });

  test.each([
    ["an ordinary source glob", "src/x/**", null],
    [".github/**", ".github/**", ".github/**"],
    ["a manifest glob", "stories/*.md", "stories/*.md"],
    ["** overlaps everything with a literal prefix", "**", CONFIG_DEFAULTS.epics_path],
    ["a glob over the status files", "_bmad-output/implementation-artifacts/*.yaml", STATUS],
    ["a glob inside .xarabot", ".xarabot/prompts/x.md", ".xarabot/**"],
    ["a glob over the planning artifacts", "_bmad-output/**", CONFIG_DEFAULTS.epics_path],
    ["case-folded .GitHub", ".GitHub/workflows/ci.yml", ".github/**"],
    ["the Standing Authority", "docs/standing-authority.md", "docs/standing-authority.md"],
    ["live evidence", "docs/maintainer/evidence/epic-3.md", "docs/maintainer/evidence/epic-*.md"],
    ["a nested CLAUDE.md (a wildcard-led refused glob matches its text)", "pkg/CLAUDE.md", "**/CLAUDE.md"],
    ["a case-folded nested .claude", "pkg/.Claude/settings.json", "**/.claude/**"],
    ["a .pem file", "certs/a.pem", "**/*.pem"],
    ["a glob that only names .claude-like text", "docs/claude-notes.md", null],
    ["a glob under a policy Protected Path", "secrets/key", "secrets/**"],
  ] as const)("%s → %p", (_name, glob, hit) => {
    const r = refusedItemGlobs([glob], CONFIG, POLICY);
    expect(r).toEqual(hit === null ? [] : [{ glob, refused: hit }]);
  });
});

describe("checkRetroResult", () => {
  test.each([
    ["two good items", [item("epic-2-retro-item-1-a"), item("epic-2-retro-item-2-b", [])], []],
    ["ids with _ and non-ASCII letters, as the stock slug makes them", [item("epic-2-retro-item-3-add-a-retro_result-test"), item("epic-2-retro-item-4-réviser-l-écran-日本")], []],
    ["an id of another Epic", [item("epic-3-retro-item-1-a")], ['item epic-3-retro-item-1-a: its id must start with "epic-2-"']],
    ["a repeated id", [item("epic-2-retro-item-1-a"), item("epic-2-retro-item-1-a")], ["item epic-2-retro-item-1-a: its id repeats"]],
    ["a glob that does not normalize", [item("epic-2-retro-item-1-a", ["../x"])], ['item epic-2-retro-item-1-a: glob "../x" must be repo-relative (no leading /, no backslash, no empty, . or .. path segment)']],
    [
      "bad globs: .github/**, stories/*.md, **",
      [item("epic-2-retro-item-1-a", [".github/**", "stories/*.md", "**"])],
      [
        'item epic-2-retro-item-1-a: glob ".github/**" is refused (it overlaps ".github/**")',
        'item epic-2-retro-item-1-a: glob "stories/*.md" is refused (it overlaps "stories/*.md")',
        `item epic-2-retro-item-1-a: glob "**" is refused (it overlaps "${CONFIG_DEFAULTS.epics_path}")`,
      ],
    ],
    ["a ./ glob is normalized before the refusal", [item("epic-2-retro-item-1-a", ["./.github/x"])], ['item epic-2-retro-item-1-a: glob ".github/x" is refused (it overlaps ".github/**")']],
  ] as const)("%s", (_name, items, want) => {
    expect(checkRetroResult(2, result([...items]), CONFIG, POLICY)).toEqual([...want]);
  });
});

/** `sprint-status.yaml` text with `action_items` holding `ids`. */
const statusText = (ids: readonly string[]) =>
  ["development_status:", "  epic-2: done", ids.length === 0 ? "action_items: []" : "action_items:", ...ids.flatMap((id) => [`  - id: "${id}"`, "    status: open"]), ""].join("\n");
const doc = (verdict: string) => `---\nepic: 2\nverdict: ${verdict}\n---\n\n# Epic 2 Retrospective\n`;
const side = (files: Record<string, string>): RetroTree => ({ tree: ["README.md", ...Object.keys(files)].sort(), files });

const OLD = "epic-1-retro-item-1-old";
const A = "epic-2-retro-item-1-a";
const B = "epic-2-retro-item-2-b";
const ONTO = side({ [STATUS]: statusText([OLD]) });
const HEAD = side({ [STATUS]: statusText([OLD, A, B]), [DOC]: doc("accepted") });

describe("checkRetroDiff", () => {
  const check = (r: Pick<RetroResult, "verdict" | "items">, onto: RetroTree = ONTO, head: RetroTree = HEAD) => checkRetroDiff({ epic: 2, result: r, config: CONFIG, onto, head });

  test("valid: 2 appended items, the doc's verdict accepted", () => {
    expect(check(result([item(A), item(B)]))).toEqual([]);
  });
  test("the items match as a set, whatever their order", () => {
    expect(check(result([item(B), item(A)]))).toEqual([]);
  });
  test("item mismatch: the result lists 1 of 2 appended ids", () => {
    expect(check(result([item(A)]))).toEqual([`the result's items (${A}) are not the action items the commit appends to ${STATUS} (${A}, ${B})`]);
  });
  test("an item not appended (already on main) does not count as appended", () => {
    expect(check(result([item(A), item(B), item("epic-2-retro-item-3-c")]))).toHaveLength(1);
  });
  test("no items and none appended", () => {
    expect(check(result([]), ONTO, side({ [STATUS]: statusText([OLD]), [DOC]: doc("accepted") }))).toEqual([]);
  });
  test("an absent status file on main has no items", () => {
    expect(check(result([item(A), item(B)]), side({}), side({ [STATUS]: statusText([A, B]), [DOC]: doc("accepted") }))).toEqual([]);
  });
  test("verdict mismatch: doc rejected, result accepted", () => {
    expect(check(result([item(A), item(B)], "accepted"), ONTO, side({ ...HEAD.files, [DOC]: doc("rejected") }))).toEqual([`${DOC}'s frontmatter verdict is "rejected", not the result's "accepted"`]);
  });
  test("a doc with no verdict", () => {
    expect(check(result([item(A), item(B)]), ONTO, side({ ...HEAD.files, [DOC]: "# no frontmatter\n" }))).toEqual([`${DOC}'s frontmatter verdict is missing, not the result's "accepted"`]);
  });
  test("no retro document added", () => {
    const head = side({ [STATUS]: statusText([OLD, A, B]) });
    expect(check(result([item(A), item(B)]), ONTO, head)).toEqual(["the commit adds or changes 0 retro documents matching _bmad-output/implementation-artifacts/epic-2-retro-*.md, not exactly one"]);
  });
  test("two retro documents added", () => {
    const other = "_bmad-output/implementation-artifacts/epic-2-retro-2026-10-26.md";
    const head = side({ ...HEAD.files, [other]: doc("accepted") });
    expect(check(result([item(A), item(B)]), ONTO, head)[0]).toContain("adds or changes 2 retro documents");
  });
  test("an unchanged older retro document does not count; a changed one does", () => {
    const old = "_bmad-output/implementation-artifacts/epic-2-retro-2026-01-01.md";
    const onto = side({ ...ONTO.files, [old]: doc("rejected") });
    expect(check(result([item(A), item(B)]), onto, side({ ...HEAD.files, [old]: doc("rejected") }))).toEqual([]);
    expect(check(result([item(A), item(B)]), onto, side({ ...HEAD.files, [old]: doc("accepted") }))[0]).toContain("adds or changes 2 retro documents");
  });
  test("another Epic's retro document does not count", () => {
    const head = side({ ...HEAD.files, "_bmad-output/implementation-artifacts/epic-3-retro-x.md": doc("accepted") });
    expect(check(result([item(A), item(B)]), ONTO, head)).toEqual([]);
  });
  test("an unparseable status file on the commit", () => {
    expect(check(result([]), ONTO, side({ [STATUS]: "action_items: [\n", [DOC]: doc("accepted") }))[0]).toContain(`the commit's ${STATUS}: invalid YAML`);
  });
  test("action_items not a list, or an item with no id", () => {
    expect(check(result([]), ONTO, side({ [STATUS]: "action_items: 3\n", [DOC]: doc("accepted") }))[0]).toContain("action_items must be a list");
    expect(check(result([]), ONTO, side({ [STATUS]: "action_items:\n  - status: open\n", [DOC]: doc("accepted") }))[0]).toContain("action_items[0] has no string id");
  });
  test("retroDocGlob sets <N>", () => {
    expect(retroDocGlob(CONFIG_DEFAULTS.retro_doc_glob, 12)).toBe("_bmad-output/implementation-artifacts/epic-12-retro-*.md");
  });
});
