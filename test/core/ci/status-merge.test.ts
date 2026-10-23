import { describe, expect, test } from "bun:test";
import { isLockfile, LOCKFILE_NAMES, mergeStatusYaml } from "../../../src/core/ci/status-merge.ts";

const BASE = ["# Sprint status", "development_status:", "  epic-1: in-progress", "  1-1-first: backlog", "  1-2-second: backlog", "  1-3-third: backlog", ""].join("\n");

const lines = (...l: string[]) => [...l, ""].join("\n");

describe("mergeStatusYaml", () => {
  const cases: [string, { base: string; pr: string; main: string }, string][] = [
    [
      "the PR's changed value is re-applied onto main's text, comments kept",
      {
        base: BASE,
        pr: BASE.replace("1-1-first: backlog", "1-1-first: done"),
        main: lines("# Sprint status (main)", "development_status:", "  epic-1: in-progress", "  # merged", "  1-1-first: backlog", "  1-2-second: done", "  1-3-third: backlog"),
      },
      lines("# Sprint status (main)", "development_status:", "  epic-1: in-progress", "  # merged", "  1-1-first: done", "  1-2-second: done", "  1-3-third: backlog"),
    ],
    [
      "an added entry goes after its PR predecessor",
      {
        base: BASE,
        pr: BASE.replace("  1-2-second: backlog\n", "  1-2-second: backlog\n  1-2a-extra: backlog\n"),
        main: BASE.replace("1-2-second: backlog", "1-2-second: done"),
      },
      BASE.replace("  1-2-second: backlog\n", "  1-2-second: done\n  1-2a-extra: backlog\n"),
    ],
    [
      "an added entry whose predecessor main deleted goes after the last entry",
      {
        base: BASE,
        pr: BASE.replace("  1-3-third: backlog\n", "  1-3-third: backlog\n  1-4-fourth: backlog\n"),
        main: BASE.replace("  1-3-third: backlog\n", "") + "# tail\n",
      },
      BASE.replace("  1-3-third: backlog\n", "  1-4-fourth: backlog\n") + "# tail\n",
    ],
    [
      "a deleted entry is deleted",
      { base: BASE, pr: BASE.replace("  1-3-third: backlog\n", ""), main: BASE.replace("epic-1: in-progress", "epic-1: done") },
      BASE.replace("epic-1: in-progress", "epic-1: done").replace("  1-3-third: backlog\n", ""),
    ],
    [
      "an entry both sides changed takes the PR's version",
      { base: BASE, pr: BASE.replace("1-1-first: backlog", "1-1-first: done"), main: BASE.replace("1-1-first: backlog", "1-1-first: review") },
      BASE.replace("1-1-first: backlog", "1-1-first: done"),
    ],
    [
      "a top-level entry the PR added goes after its predecessor",
      { base: BASE, pr: `${BASE}last_updated: today\n`, main: `${BASE}# end\n` },
      `${BASE}last_updated: today\n# end\n`,
    ],
    [
      "nothing the PR changed: main's text verbatim",
      { base: BASE, pr: BASE, main: `${BASE}\n# more\n` },
      `${BASE}\n# more\n`,
    ],
    [
      "nested mappings merge recursively at main's indent",
      {
        base: lines("a:", "  b:", "    c: 1", "    d: 1"),
        pr: lines("a:", "  b:", "    c: 2", "    d: 1"),
        main: lines("a:", "    b:", "        c: 1", "        d: 3"),
      },
      lines("a:", "    b:", "        c: 2", "        d: 3"),
    ],
    [
      "a block value is taken whole",
      {
        base: lines("notes: |", "  one", "x: 1"),
        pr: lines("notes: |", "  one", "  two", "x: 1"),
        main: lines("notes: |", "  one", "x: 2"),
      },
      lines("notes: |", "  one", "  two", "x: 2"),
    ],
    [
      "a file new on both sides: base empty",
      { base: "", pr: lines("a: 1", "b: 2"), main: lines("a: 1", "c: 3") },
      lines("a: 1", "b: 2", "c: 3"),
    ],
  ];
  test.each(cases)("%s", (_name, input, want) => {
    const r = mergeStatusYaml(input);
    expect(r).toEqual({ ok: true, value: want });
  });

  const errors: [string, { base: string; pr: string; main: string }][] = [
    ["flow style", { base: BASE, pr: "{a: 1}\n", main: BASE }],
    ["a tab indent", { base: BASE, pr: BASE, main: "a:\n\tb: 1\n" }],
    ["multiple documents", { base: BASE, pr: `${BASE}---\nb: 1\n`, main: BASE }],
    ["a top-level sequence", { base: BASE, pr: BASE, main: "- a\n- b\n" }],
    ["a duplicate key", { base: BASE, pr: BASE, main: "a: 1\na: 2\n" }],
    ["a result that does not parse", { base: "a: 1\n", pr: "a: [1\n", main: "a: 1\nb: 2\n" }],
  ];
  test.each(errors)("%s is an error", (_name, input) => {
    const r = mergeStatusYaml(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("invalid");
  });
});

describe("isLockfile", () => {
  test.each([
    ["bun.lock", true],
    ["package-lock.json", true],
    ["npm-shrinkwrap.json", true],
    ["pnpm-lock.yaml", true],
    ["yarn.lock", true],
    ["packages/app/bun.lock", true],
    ["bun.lockb", false],
    ["package.json", false],
    ["docs/yarn.lock.md", false],
  ])("%s → %p", (path, want) => {
    expect(isLockfile(path)).toBe(want);
  });

  test("the names", () => {
    expect([...LOCKFILE_NAMES]).toEqual(["bun.lock", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]);
  });
});
