import { describe, expect, test } from "bun:test";
import { describeMissing, globCovers, missingGlobs, testCounterpart, WIRING_PAIRS } from "../../../src/core/manifests/coverage.ts";

describe("testCounterpart", () => {
  const cases: readonly [string, string | null][] = [
    ["src/a.ts", "test/a.test.ts"],
    ["src/core/manifests/globs.ts", "test/core/manifests/globs.test.ts"],
    ["src/core/manifests/**", "test/core/manifests/**"],
    ["src/**", "test/**"],
    ["src/types.d.ts", null],
    ["src/*.ts", null],
    ["src/a/*/b/**", null],
    ["src/README.md", null],
    ["lib/a.ts", null],
    ["test/a.test.ts", null],
  ];
  for (const [glob, expected] of cases) {
    test(`${glob} -> ${expected}`, () => {
      expect(testCounterpart(glob)).toBe(expected);
    });
  }
});

describe("globCovers", () => {
  const cases: readonly [string, string, boolean][] = [
    ["test/a.test.ts", "test/a.test.ts", true],
    ["test/**", "test/a.test.ts", true],
    ["test/*.test.ts", "test/a.test.ts", true],
    ["test/b.test.ts", "test/a.test.ts", false],
    ["test/core/**", "test/core/x/**", true],
    ["test/core/x/**", "test/core/x/**", true],
    ["**", "test/core/x/**", true],
    ["test/core/x/**", "test/core/**", false],
    ["test/core/x/y.test.ts", "test/core/x/**", false],
    ["test/co**", "test/core/x/**", false],
    ["test/*/x/**", "test/core/x/**", false],
    ["src/**", "src/adapters/forge/**", true],
  ];
  for (const [glob, wanted, expected] of cases) {
    test(`${glob} covers ${wanted}: ${expected}`, () => {
      expect(globCovers(glob, wanted)).toBe(expected);
    });
  }
});

describe("missingGlobs", () => {
  type Case = { readonly name: string; readonly globs: readonly string[]; readonly tree?: readonly string[]; readonly missing: readonly (readonly [string, string])[] };
  const cases: readonly Case[] = [
    { name: "no globs", globs: [], missing: [] },
    { name: "no src/ glob", globs: ["docs/x.md", "lib/**"], missing: [] },
    { name: "a src file with no test", globs: ["src/a.ts"], missing: [["test/a.test.ts", "src/a.ts"]] },
    { name: "a src file with its test", globs: ["src/a.ts", "test/a.test.ts"], missing: [] },
    { name: "a src file under a test dir glob", globs: ["src/a.ts", "test/**"], missing: [] },
    { name: "a src dir with no test dir", globs: ["src/core/x/**"], missing: [["test/core/x/**", "src/core/x/**"]] },
    { name: "a src dir under a wider test dir", globs: ["src/core/x/**", "test/core/**"], missing: [] },
    { name: "a src dir with one test file only", globs: ["src/core/x/**", "test/core/x/y.test.ts"], missing: [["test/core/x/**", "src/core/x/**"]] },
    { name: "a glob of another shape has no counterpart", globs: ["src/*.md"], missing: [] },
    {
      name: "the forge port: its tests, contract and adapter, and the adapter's tests",
      globs: ["src/ports/forge.ts", "test/ports/forge.test.ts"],
      missing: [
        ["test/contracts/forge.contract.ts", "src/ports/forge.ts"],
        ["src/adapters/forge/**", "src/ports/forge.ts"],
        ["test/adapters/forge/**", "src/adapters/forge/**"],
      ],
    },
    {
      name: "the forge port with all its wiring",
      globs: ["src/ports/forge.ts", "src/adapters/forge/**", "test/ports/forge.test.ts", "test/contracts/forge.contract.ts", "test/adapters/forge/**"],
      missing: [],
    },
    {
      name: "a port whose contract exists",
      globs: ["src/ports/agent.ts"],
      tree: ["src/ports/agent.ts", "test/contracts/agent.contract.ts"],
      missing: [
        ["test/ports/agent.test.ts", "src/ports/agent.ts"],
        ["test/contracts/agent.contract.ts", "src/ports/agent.ts"],
      ],
    },
    { name: "a new port with no contract", globs: ["src/ports/clock.ts", "test/ports/clock.test.ts"], tree: [], missing: [] },
    {
      name: "a missing glob an earlier missing glob covers is left out",
      globs: ["src/ports/**"],
      tree: ["src/ports/agent.ts", "src/ports/sandbox.ts"],
      missing: [["test/ports/**", "src/ports/**"]],
    },
    {
      name: "a src/ports/** glob names each port in the tree",
      globs: ["src/ports/**", "test/ports/**"],
      tree: ["src/ports/agent.ts", "src/ports/sandbox.ts", "test/contracts/agent.contract.ts"],
      missing: [["test/contracts/agent.contract.ts", "src/ports/agent.ts"]],
    },
    {
      name: "src/** and test/** cover every wiring",
      globs: ["src/**", "test/**"],
      tree: ["src/ports/forge.ts", "src/ports/agent.ts", "test/contracts/agent.contract.ts", "test/contracts/forge.contract.ts"],
      missing: [],
    },
    {
      name: "a new lane step needs lane run and its test",
      globs: ["src/lane/new-step.ts", "test/lane/new-step.test.ts"],
      tree: [],
      missing: [
        ["src/cli/lane-run.ts", "src/lane/new-step.ts"],
        ["test/cli/lane-run.test.ts", "src/lane/new-step.ts"],
      ],
    },
    { name: "an existing lane step needs no wiring", globs: ["src/lane/retro-step.ts", "test/lane/retro-step.test.ts"], tree: ["src/lane/retro-step.ts"], missing: [] },
    { name: "a new lane step with lane run wired", globs: ["src/lane/new-step.ts", "test/lane/**", "src/cli/lane-run.ts", "test/cli/**"], tree: [], missing: [] },
    { name: "a lane file that is not a step", globs: ["src/lane/helper.ts", "test/lane/helper.test.ts"], tree: [], missing: [] },
    {
      name: "each missing glob once, for the first path that needs it",
      globs: ["src/a.ts", "src/b/**", "src/lane/a-step.ts", "src/lane/b-step.ts"],
      tree: [],
      missing: [
        ["test/a.test.ts", "src/a.ts"],
        ["test/b/**", "src/b/**"],
        ["test/lane/a-step.test.ts", "src/lane/a-step.ts"],
        ["test/lane/b-step.test.ts", "src/lane/b-step.ts"],
        ["src/cli/lane-run.ts", "src/lane/a-step.ts"],
        ["test/cli/lane-run.test.ts", "src/lane/a-step.ts"],
      ],
    },
    {
      name: "Epic 3 retro item 14's own globs",
      globs: [
        "src/cli/graph-check.ts",
        "src/core/manifests/**",
        "src/core/prompt/template.ts",
        "src/lane/retro-step.ts",
        "test/cli/graph-check.test.ts",
        "test/core/manifests/**",
        "test/core/prompt/**",
        "test/lane/retro-step.test.ts",
      ],
      tree: ["src/cli/graph-check.ts", "src/core/manifests/globs.ts", "src/core/prompt/template.ts", "src/lane/retro-step.ts"],
      missing: [],
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      expect(missingGlobs(c.globs, c.tree ?? [])).toEqual(c.missing.map(([glob, f]) => ({ glob, for: f })));
    });
  }
});

describe("describeMissing", () => {
  test("names each glob and what needs it", () => {
    expect(describeMissing(missingGlobs(["src/a.ts", "src/b/**"], []))).toBe('"test/a.test.ts" (for src/a.ts), "test/b/**" (for src/b/**)');
  });
});

describe("WIRING_PAIRS", () => {
  test("the table starts with the forge port, any port and a new lane step", () => {
    expect(WIRING_PAIRS.map((w) => w.source.source)).toEqual(["^src\\/ports\\/forge\\.ts$", "^src\\/ports\\/([^/]+)\\.ts$", "^src\\/lane\\/[^/]+-step\\.ts$"]);
  });
});
