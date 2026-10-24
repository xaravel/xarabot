import { describe, expect, test } from "bun:test";
import { approvalPaths } from "../../../src/core/ci/approval.ts";

describe("approvalPaths", () => {
  const cases: [string, string[], string[], string[]][] = [
    ["** gates every path", ["src/a.ts", "README.md", ".github/x.yml"], ["**"], [".github/x.yml", "README.md", "src/a.ts"]],
    ["**/AGENTS.md matches a root AGENTS.md", ["AGENTS.md", "src/a.ts"], ["**/AGENTS.md"], ["AGENTS.md"]],
    ["**/AGENTS.md matches a nested one", ["docs/AGENTS.md"], ["**/AGENTS.md"], ["docs/AGENTS.md"]],
    ["case folds the path", [".GitHub/Workflows/ci.yml"], [".github/**"], [".GitHub/Workflows/ci.yml"]],
    ["case folds the glob", ["agents.md"], ["**/AGENTS.md"], ["agents.md"]],
    ["no match is empty", ["src/a.ts", "test/a.test.ts"], [".github/**", "docs/standing-authority.md"], []],
    ["no globs is empty", ["src/a.ts"], [], []],
    ["sorted, each path once across globs", ["b.md", "a.md", "a.md"], ["*.md", "a.md"], ["a.md", "b.md"]],
  ];
  test.each(cases)("%s", (_name, paths, globs, want) => {
    expect(approvalPaths(paths, globs)).toEqual(want);
  });
});
