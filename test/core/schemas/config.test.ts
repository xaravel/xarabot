import { describe, expect, test } from "bun:test";
import { describeIssues } from "../../../src/core/schemas/common.ts";
import { ConfigSchema, GlobCoverageSchema } from "../../../src/core/schemas/config.ts";

const BASE = { schema_version: 1, runner_version: "v0.1.0", maintainer: "edanisko", standing_authority_path: "docs/authority.md" };

describe("ConfigSchema glob_coverage", () => {
  test("absent: the rule is off", () => {
    const c = ConfigSchema.parse(BASE);
    expect(c.glob_coverage).toBeUndefined();
  });

  test("accepted: tests and wiring, with the wiring defaults filled in", () => {
    const c = ConfigSchema.parse({
      ...BASE,
      glob_coverage: {
        tests: [{ path: "src/<p>.ts", test: "test/<p>.test.ts" }],
        wiring: [
          { path: "src/ports/forge.ts", needs: ["src/adapters/forge/**"] },
          { path: "src/ports/<x>.ts", needs_if_present: ["test/contracts/<x>.contract.ts"] },
          { path: "src/lane/<x>-step.ts", only_new: true, needs: ["src/cli/lane-run.ts"] },
        ],
      },
    });
    expect(c.glob_coverage).toEqual({
      tests: [{ path: "src/<p>.ts", test: "test/<p>.test.ts" }],
      wiring: [
        { path: "src/ports/forge.ts", needs: ["src/adapters/forge/**"], needs_if_present: [], only_new: false },
        { path: "src/ports/<x>.ts", needs: [], needs_if_present: ["test/contracts/<x>.contract.ts"], only_new: false },
        { path: "src/lane/<x>-step.ts", needs: ["src/cli/lane-run.ts"], needs_if_present: [], only_new: true },
      ],
    });
  });

  test("accepted: tests only, or wiring only", () => {
    expect(GlobCoverageSchema.safeParse({ tests: [{ path: "lib/<m>.rb", test: "spec/<m>_spec.rb" }] }).success).toBe(true);
    expect(GlobCoverageSchema.safeParse({ wiring: [{ path: "a.go", needs: ["b.go"] }] }).success).toBe(true);
  });

  const refused: readonly [string, unknown, string][] = [
    ["an empty table", {}, "set tests, wiring or both"],
    ["a list, not a mapping", [], "glob_coverage"],
    ["an unknown key", { tests: [{ path: "a.ts", test: "b.ts" }], other: 1 }, "other"],
    ["an empty tests list", { tests: [] }, "tests"],
    ["an empty wiring list", { wiring: [] }, "wiring"],
    ["a tests row with no test", { tests: [{ path: "a.ts" }] }, "tests.0.test"],
    ["a tests row with an unknown key", { tests: [{ path: "a.ts", test: "b.ts", needs: [] }] }, "needs"],
    ["a wiring row with nothing needed", { wiring: [{ path: "a.ts" }] }, "needs or needs_if_present must list at least one glob"],
    ["a wiring row with a non-boolean only_new", { wiring: [{ path: "a.ts", needs: ["b.ts"], only_new: "yes" }] }, "only_new"],
    ["an absolute path", { tests: [{ path: "/src/<p>.ts", test: "test/<p>.test.ts" }] }, "tests.0.path"],
    ["a .. segment", { tests: [{ path: "src/<p>.ts", test: "../test/<p>.test.ts" }] }, "tests.0.test"],
    ["a ./ prefix", { wiring: [{ path: "./a.ts", needs: ["b.ts"] }] }, "wiring.0.path"],
    ["a negation", { wiring: [{ path: "a.ts", needs: ["!b.ts"] }] }, "must not start with ! or ~"],
    ["a backtick", { wiring: [{ path: "a`.ts", needs: ["b.ts"] }] }, "no backtick"],
    ["a stray <", { tests: [{ path: "src/<p.ts", test: "test/p.test.ts" }] }, "only as <name> placeholders"],
    ["side-by-side placeholders", { tests: [{ path: "src/<a><b>.ts", test: "test/<a>.ts" }] }, "side by side"],
    ["a repeated placeholder", { tests: [{ path: "src/<a>/<a>.ts", test: "test/<a>.ts" }] }, "repeats the placeholder <a>"],
    ["a test using a placeholder its path lacks", { tests: [{ path: "src/<p>.ts", test: "test/<q>.test.ts" }] }, "tests.0.test.0: uses <q>"],
    ["a need using a placeholder its path lacks", { wiring: [{ path: "src/a.ts", needs_if_present: ["test/<x>.ts"] }] }, "wiring.0.needs_if_present.0: uses <x>"],
  ];
  for (const [name, coverage, fragment] of refused) {
    test(`refused: ${name}`, () => {
      const r = ConfigSchema.safeParse({ ...BASE, glob_coverage: coverage });
      expect(r.success).toBe(false);
      if (!r.success) expect(describeIssues(r.error)).toContain(fragment);
    });
  }
});
