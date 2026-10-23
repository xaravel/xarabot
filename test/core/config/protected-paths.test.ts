import { describe, expect, test } from "bun:test";
import { effectiveProtectedPaths, MANDATORY_PROTECTED_PATHS } from "../../../src/core/config/protected-paths.ts";

const AUTH = "docs/standing-authority.md";
const MANDATORY_WITH_AUTH = [
  ".xarabot/**",
  AUTH,
  ".github/**",
  "**/.agents/**",
  "**/.claude/**",
  "**/.codex/**",
  "**/.pi/**",
  "**/.mcp.json",
  "**/AGENTS.md",
  "**/CLAUDE.md",
];

describe("effectiveProtectedPaths", () => {
  test("the mandatory list is the AR22 list", () => {
    expect(MANDATORY_PROTECTED_PATHS).toEqual(MANDATORY_WITH_AUTH.filter((p) => p !== AUTH));
  });

  const cases: readonly [string, readonly string[], string, readonly string[]][] = [
    ["empty policy", [], AUTH, MANDATORY_WITH_AUTH],
    ["policy adds, duplicates dropped", ["src/**", ".github/**"], AUTH, [...MANDATORY_WITH_AUTH, "src/**"]],
    ["policy repeats its own entry", ["a/**", "a/**"], AUTH, [...MANDATORY_WITH_AUTH, "a/**"]],
    [
      "authority path already under .xarabot",
      [],
      ".xarabot/authority.md",
      MANDATORY_WITH_AUTH.map((p) => (p === AUTH ? ".xarabot/authority.md" : p)),
    ],
  ];
  for (const [name, policy, auth, expected] of cases) {
    test(name, () => {
      expect(effectiveProtectedPaths(policy, auth)).toEqual([...expected]);
    });
  }
});
