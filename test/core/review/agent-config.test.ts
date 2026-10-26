import { describe, expect, test } from "bun:test";
import { checkWrite, writeRules } from "../../../src/core/lane/write-check.ts";
import { isAgentConfigPath } from "../../../src/core/review/agent-config.ts";
import { CONFIG_DEFAULTS } from "../../../src/core/schemas/config.ts";

/** U+212A KELVIN SIGN: folds to `k`. */
const KELVIN = "\u212A";

const PATHS: readonly (readonly [string, boolean])[] = [
    ["CLAUDE.md", true],
    ["AGENTS.md", true],
    ["AGENTS.override.md", true],
    ["CLAUDE.local.md", true],
    [".mcp.json", true],
    ["docs/CLAUDE.md", true],
    ["a/b/AGENTS.md", true],
    [".claude/settings.json", true],
    [".claude/skills/x/SKILL.md", true],
    [".agents/skills/x/SKILL.md", true],
    [".codex/config.toml", true],
    [".pi/agent.json", true],
    ["src/.claude/hooks.json", true],
    // A bare agent config folder name: a file or symlink there.
    [".claude", true],
    // Full case folding (toUpperCase().toLowerCase(), as APFS folds): `ſ` folds to `s`, `K` (Kelvin) to `k`.
    [".mcp.jſon", true],
    ["pkg/AGENTſ.md", true],
    ["AGENTſ.override.md", true],
    ["ſrc/.claude/x", true],
    [`pkg/${KELVIN}it/CLAUDE.md`, true],
    [`${KELVIN}it/.codex`, true],
    [`${KELVIN}ey.md`, false],
    ["ſrc/claude.ts", false],
    ["src/.codex", true],
    [".pi", true],
    // Case-folded, as the checkout's filesystem folds names.
    ["claude.md", true],
    [".Claude/settings.json", true],
    ["Docs/Agents.MD", true],
    [".CODEX", true],
    // Not agent config.
    ["README.md", false],
    ["src/claude.ts", false],
    ["CLAUDE.md.bak", false],
    [".claudeignore", false],
    ["src/agents/x.ts", false],
    [".github/workflows/ci.yml", false],
    [".xarabot/policy.yaml", false],
    ["_bmad/bmm/config.yaml", false],
];

/** Builder write rules with no policy Protected Paths, and a spec and manifest the table never names. */
const RULES = writeRules({
  config: {
    sprint_status_path: CONFIG_DEFAULTS.sprint_status_path,
    retro_gates_path: CONFIG_DEFAULTS.retro_gates_path,
    epics_path: CONFIG_DEFAULTS.epics_path,
    manifests: { dir: "stories" },
    standing_authority_path: "docs/standing-authority.md",
    epic_context_path: CONFIG_DEFAULTS.epic_context_path,
    live_evidence_glob: CONFIG_DEFAULTS.live_evidence_glob,
  },
  policy: { protected_paths: [] },
  specPath: "_bmad-output/implementation-artifacts/spec-3-4-x.md",
  storyFile: "stories/3.4.md",
  infrastructureApproved: false,
});

describe("isAgentConfigPath", () => {
  test.each(PATHS)("%s: %p", (path, expected) => {
    expect(isAgentConfigPath(path)).toBe(expected);
  });

  test("parity with the write check: true exactly when a builder change to the path is refused as agent-config", () => {
    for (const [path] of PATHS) {
      const refusedAs = checkWrite(RULES, [{ path }]).map((r) => r.class);
      expect({ path, agentConfig: isAgentConfigPath(path) }).toEqual({ path, agentConfig: refusedAs.includes("agent-config") });
    }
  });
});
