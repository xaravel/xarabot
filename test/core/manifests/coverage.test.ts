import { describe, expect, test } from "bun:test";
import { coverageRuleLines, describeMissing, missingGlobs } from "../../../src/core/manifests/coverage.ts";
import { GlobCoverageSchema, type GlobCoverage } from "../../../src/core/schemas/config.ts";

/** Xarabot's own table, as docs/maintainer/self-host.md shows it. */
const XARABOT: GlobCoverage = GlobCoverageSchema.parse({
  tests: [
    { path: "src/<p>.ts", test: "test/<p>.test.ts" },
    { path: "src/<dir>/**", test: "test/<dir>/**" },
  ],
  wiring: [
    { path: "src/ports/forge.ts", needs: ["test/ports/forge.test.ts", "test/contracts/forge.contract.ts", "src/adapters/forge/**"] },
    { path: "src/ports/<x>.ts", needs: ["test/ports/<x>.test.ts"], needs_if_present: ["test/contracts/<x>.contract.ts"] },
    { path: "src/lane/<x>-step.ts", only_new: true, needs: ["src/cli/lane-run.ts", "test/cli/lane-run.test.ts"] },
  ],
});

const TREE = [
  "src/core/manifests/globs.ts",
  "src/lane/retro-step.ts",
  "src/ports/agent.ts",
  "src/ports/forge.ts",
  "src/ports/sandbox.ts",
  "test/contracts/agent.contract.ts",
  "test/contracts/forge.contract.ts",
];

const missing = (globs: readonly string[], tree: readonly string[] = TREE, coverage: GlobCoverage = XARABOT): string[] =>
  missingGlobs(globs, coverage, tree).map((m) => m.glob);

describe("missingGlobs: Xarabot's table", () => {
  const cases: readonly [string, readonly string[], readonly string[]][] = [
    ["a file needs its test", ["src/core/manifests/globs.ts"], ["test/core/manifests/globs.test.ts"]],
    ["a file with its test", ["src/core/manifests/globs.ts", "test/core/manifests/globs.test.ts"], []],
    ["a test folder glob covers the test", ["src/core/manifests/globs.ts", "test/core/manifests/**"], []],
    ["a wider test glob covers it", ["src/core/manifests/globs.ts", "test/**"], []],
    ["a folder needs its test folder", ["src/core/manifests/**"], ["test/core/manifests/**"]],
    ["a folder with its test folder", ["src/core/manifests/**", "test/core/manifests/**"], []],
    ["a wider test folder covers it", ["src/core/manifests/**", "test/core/**"], []],
    ["a file under the test folder does not cover the folder", ["src/core/**", "test/core/a.test.ts"], ["test/core/**"]],
    ["a wildcard is kept in the counterpart", ["src/core/*.ts"], ["test/core/*.test.ts"]],
    [
      "the Forge port needs its test, contract and adapters",
      ["src/ports/forge.ts"],
      ["test/ports/forge.test.ts", "test/contracts/forge.contract.ts", "src/adapters/forge/**", "test/adapters/forge/**"],
    ],
    [
      "the Forge port with all its wiring",
      ["src/ports/forge.ts", "test/ports/forge.test.ts", "test/contracts/forge.contract.ts", "src/adapters/forge/**", "test/adapters/**"],
      [],
    ],
    ["a port with a contract on main needs it", ["src/ports/agent.ts"], ["test/ports/agent.test.ts", "test/contracts/agent.contract.ts"]],
    ["a port with no contract on main needs only its test", ["src/ports/sandbox.ts"], ["test/ports/sandbox.test.ts"]],
    [
      "a new step needs the lane-run wiring",
      ["src/lane/inbox2-step.ts", "test/lane/inbox2-step.test.ts"],
      ["src/cli/lane-run.ts", "test/cli/lane-run.test.ts"],
    ],
    ["an existing step needs no wiring", ["src/lane/retro-step.ts", "test/lane/retro-step.test.ts"], []],
    ["a step wildcard is no new file", ["src/lane/*-step.ts", "test/lane/*-step.test.ts"], []],
    ["a path no row matches needs nothing", ["docs/maintainer/self-host.md", "src"], []],
  ];
  for (const [name, globs, expected] of cases) {
    test(name, () => {
      expect(missing(globs)).toEqual([...expected]);
    });
  }
});

describe("missingGlobs: the result", () => {
  test("each missing glob once, with the first glob that needs it", () => {
    expect(missingGlobs(["src/ports/forge.ts", "src/ports/**"], XARABOT, TREE)).toEqual([
      { glob: "test/ports/forge.test.ts", needed_by: "src/ports/forge.ts" },
      { glob: "test/contracts/forge.contract.ts", needed_by: "src/ports/forge.ts" },
      { glob: "src/adapters/forge/**", needed_by: "src/ports/forge.ts" },
      { glob: "test/ports/**", needed_by: "src/ports/**" },
      { glob: "test/adapters/forge/**", needed_by: "src/adapters/forge/**" },
    ]);
  });

  test("a table whose needs feed each other ends", () => {
    const table = GlobCoverageSchema.parse({ tests: [{ path: "<p>", test: "t/<p>" }] });
    expect(missing(["a"], [], table)).toEqual(["t/a", "t/t/a", "t/t/t/a", "t/t/t/t/a", "t/t/t/t/t/a"]);
  });

  test("an empty list misses nothing", () => {
    expect(missing([])).toEqual([]);
  });

  test("nothing of Xarabot's layout is built in: another table, another layout", () => {
    const other = GlobCoverageSchema.parse({ tests: [{ path: "lib/<m>.rb", test: "spec/<m>_spec.rb" }] });
    expect(missing(["lib/a/b.rb", "src/x.ts"], [], other)).toEqual(["spec/a/b_spec.rb"]);
    expect(missing(["lib/a/b.rb", "spec/a/b_spec.rb"], [], other)).toEqual([]);
  });

  test("a pattern's other characters match only themselves", () => {
    const table = GlobCoverageSchema.parse({ tests: [{ path: "src/*.ts", test: "test/all.test.ts" }] });
    expect(missing(["src/a.ts"], [], table)).toEqual([]);
    expect(missing(["src/*.ts"], [], table)).toEqual(["test/all.test.ts"]);
  });

  test("a needs_if_present glob matched by a tree file through a wildcard", () => {
    const table = GlobCoverageSchema.parse({ wiring: [{ path: "src/<x>.ts", needs_if_present: ["docs/<x>/*.md"] }] });
    expect(missing(["src/a.ts"], ["docs/a/intro.md"], table)).toEqual(["docs/a/*.md"]);
    expect(missing(["src/a.ts"], ["docs/b/intro.md"], table)).toEqual([]);
  });

  test("describeMissing names each glob and the glob that needs it", () => {
    expect(describeMissing(missingGlobs(["src/a.ts"], XARABOT, []))).toBe("`test/a.test.ts` (for `src/a.ts`)");
  });
});

describe("coverageRuleLines", () => {
  test("one line per row, tests first, generated from the table", () => {
    expect(coverageRuleLines(XARABOT)).toEqual([
      "- `src/<p>.ts` needs its tests, `test/<p>.test.ts`.",
      "- `src/<dir>/**` needs its tests, `test/<dir>/**`.",
      "- `src/ports/forge.ts` needs `test/ports/forge.test.ts`, `test/contracts/forge.contract.ts`, `src/adapters/forge/**`.",
      "- `src/ports/<x>.ts` needs `test/ports/<x>.test.ts`, and each of `test/contracts/<x>.contract.ts` that matches a file this repository has.",
      "- `src/lane/<x>-step.ts`, when it names a file this repository does not have yet, needs `src/cli/lane-run.ts`, `test/cli/lane-run.test.ts`.",
    ]);
  });

  test("a wiring-only table has no test line", () => {
    const table = GlobCoverageSchema.parse({ wiring: [{ path: "a/<x>.go", needs_if_present: ["b/<x>.go"] }] });
    expect(coverageRuleLines(table)).toEqual(["- `a/<x>.go` needs each of `b/<x>.go` that matches a file this repository has."]);
  });
});
