import { describe, expect, test } from "bun:test";
import { AGENT_CONFIG_PATHS, MANDATORY_PROTECTED_PATHS } from "../../../src/core/config/protected-paths.ts";
import {
  checkWrite,
  COORDINATOR_WRITE_CLASSES,
  coordinatorWriteRules,
  epicContextMatch,
  statusLineOnly,
  WRITE_CLASSES,
  writeRules,
  type CoordinatorWriteClass,
  type CoordinatorWriteRules,
  type WriteChange,
  type WriteClass,
  type WriteRefusal,
  type WriteRules,
} from "../../../src/core/lane/write-check.ts";
import { coordinatorGlobs, type CoordinatorUnitSpec } from "../../../src/core/next/coordinator.ts";
import { CONFIG_DEFAULTS } from "../../../src/core/schemas/config.ts";
import type { AdapterName } from "../../../src/core/schemas/policy.ts";

// ------------------------------------------------------------------ rules

const SPRINT = CONFIG_DEFAULTS.sprint_status_path;
const RETRO = CONFIG_DEFAULTS.retro_gates_path;
const EPICS = CONFIG_DEFAULTS.epics_path;
const AUTHORITY = "docs/standing-authority.md";
const SPEC = "_bmad-output/implementation-artifacts/spec-2-3-x.md";
const STORY = "stories/2.3.md";

const RULES: WriteRules = writeRules({
  config: {
    sprint_status_path: SPRINT,
    retro_gates_path: RETRO,
    epics_path: EPICS,
    manifests: { dir: "stories" },
    standing_authority_path: AUTHORITY,
    epic_context_path: CONFIG_DEFAULTS.epic_context_path,
  },
  policy: { protected_paths: ["secrets/**", "**/*.pem"] },
  specPath: SPEC,
  storyFile: STORY,
  infrastructureApproved: false,
});

const manifest = (lines: readonly string[], body = "Body.\n") => `---\n${lines.join("\n")}\n---\n\n${body}`;
const M = ['story_id: "2.3"', "epic: 2", "title: The write check", "status: ready", 'globs: ["src/**"]'];
const M0 = manifest(M);
const withStatus = (s: string) => manifest(M.map((l) => (l.startsWith("status:") ? `status: ${s}` : l)));

// ------------------------------------------------------------------ table

/** The exceptions, as coverage tags. */
const EXCEPTIONS = ["own-spec", "own-manifest-status", "infrastructure"] as const;
type Tag = WriteClass | (typeof EXCEPTIONS)[number];

type Case = {
  readonly name: string;
  readonly covers: readonly Tag[];
  readonly rules?: Partial<WriteRules>;
  readonly changes: readonly WriteChange[];
  readonly refused: readonly WriteRefusal[];
};

const p = (path: string, storyFile?: { before: string; after: string }): WriteChange => (storyFile === undefined ? { path } : { path, storyFile });
const no = (path: string, cls: WriteClass): WriteRefusal => ({ path, class: cls });

const CLAUDE_CASES: readonly Case[] = [
  // Ordinary.
  { name: "an ordinary source edit", covers: [], changes: [p("src/a.ts")], refused: [] },
  { name: "no change at all", covers: [], changes: [], refused: [] },

  // coordinator-file.
  { name: "sprint status modified", covers: ["coordinator-file"], changes: [p(SPRINT)], refused: [no(SPRINT, "coordinator-file")] },
  { name: "epics.md deleted", covers: ["coordinator-file"], changes: [p(EPICS)], refused: [no(EPICS, "coordinator-file")] },
  { name: "retro-gates.yaml (any verdict, item or go change; see the git cases)", covers: ["coordinator-file"], changes: [p(RETRO)], refused: [no(RETRO, "coordinator-file")] },
  {
    name: "case-folded sprint status",
    covers: ["coordinator-file"],
    changes: [p("_BMAD-output/implementation-artifacts/Sprint-Status.yaml")],
    refused: [no("_BMAD-output/implementation-artifacts/Sprint-Status.yaml", "coordinator-file")],
  },
  {
    name: "a coordinator file inside .xarabot is reported as coordinator-file",
    covers: ["coordinator-file"],
    rules: { coordinatorFiles: [".xarabot/sprint-status.yaml", RETRO, EPICS] },
    changes: [p(".xarabot/sprint-status.yaml")],
    refused: [no(".xarabot/sprint-status.yaml", "coordinator-file")],
  },

  // xarabot.
  { name: ".xarabot/policy.yaml modified", covers: ["xarabot"], changes: [p(".xarabot/policy.yaml")], refused: [no(".xarabot/policy.yaml", "xarabot")] },
  { name: ".xarabot nested add", covers: ["xarabot"], changes: [p(".xarabot/prompts/x.md")], refused: [no(".xarabot/prompts/x.md", "xarabot")] },
  { name: "case-folded .Xarabot", covers: ["xarabot"], changes: [p(".Xarabot/config.yaml")], refused: [no(".Xarabot/config.yaml", "xarabot")] },
  { name: "a file named .xarabot-notes is not .xarabot/**", covers: [], changes: [p(".xarabot-notes")], refused: [] },
  { name: "a bare .xarabot entry (file or symlink)", covers: ["xarabot"], changes: [p(".xarabot"), p(".XARABOT")], refused: [no(".XARABOT", "xarabot"), no(".xarabot", "xarabot")] },
  { name: "a nested bare .xarabot is not .xarabot/**", covers: [], changes: [p("docs/.xarabot")], refused: [] },
  { name: "a bare .github entry (file or symlink)", covers: ["github"], changes: [p(".github"), p(".GitHub")], refused: [no(".GitHub", "github"), no(".github", "github")] },
  {
    name: "bare agent config folder names, top-level and nested (a file or symlink there)",
    covers: ["agent-config"],
    changes: [p(".claude"), p("pkg/.agents"), p("a/b/.codex"), p(".pi"), p("x/.Claude")],
    refused: [
      no(".claude", "agent-config"),
      no(".pi", "agent-config"),
      no("a/b/.codex", "agent-config"),
      no("pkg/.agents", "agent-config"),
      no("x/.Claude", "agent-config"),
    ],
  },
  { name: "names that only contain an agent config folder name are not agent config", covers: [], changes: [p("docs/.claude-notes"), p("x.pi")], refused: [] },

  // manifest.
  { name: "another Story's manifest", covers: ["manifest"], changes: [p("stories/1.1.md")], refused: [no("stories/1.1.md", "manifest")] },
  { name: "a new manifest added", covers: ["manifest"], changes: [p("stories/9.9.md")], refused: [no("stories/9.9.md", "manifest")] },
  { name: "case-folded manifest", covers: ["manifest"], changes: [p("Stories/2.4.MD")], refused: [no("Stories/2.4.MD", "manifest")] },
  { name: "a nested .md under the manifests dir is not a manifest", covers: [], changes: [p("stories/old/1.1.md")], refused: [] },
  { name: "a non-.md file in the manifests dir is not a manifest", covers: [], changes: [p("stories/notes.txt")], refused: [] },
  { name: "no manifests config: no manifests", covers: [], rules: { manifestsDir: null }, changes: [p("stories/1.1.md")], refused: [] },

  // standing-authority.
  { name: "the Standing Authority file", covers: ["standing-authority"], changes: [p(AUTHORITY)], refused: [no(AUTHORITY, "standing-authority")] },
  {
    name: "case-folded Standing Authority",
    covers: ["standing-authority"],
    changes: [p("Docs/Standing-Authority.md")],
    refused: [no("Docs/Standing-Authority.md", "standing-authority")],
  },
  {
    name: "a Standing Authority inside .github is reported as standing-authority",
    covers: ["standing-authority"],
    rules: { standingAuthorityPath: ".github/AUTHORITY.md" },
    changes: [p(".github/AUTHORITY.md")],
    refused: [no(".github/AUTHORITY.md", "standing-authority")],
  },

  // github.
  { name: "a workflow modified", covers: ["github"], changes: [p(".github/workflows/ci.yml")], refused: [no(".github/workflows/ci.yml", "github")] },
  { name: "case-folded .GitHub", covers: ["github"], changes: [p(".GitHub/workflows/x.yml")], refused: [no(".GitHub/workflows/x.yml", "github")] },
  { name: "a nested .github is not .github/**", covers: [], changes: [p("docs/.github/x.yml")], refused: [] },

  // agent-config.
  {
    name: "nested .claude added and CLAUDE.md edited",
    covers: ["agent-config"],
    changes: [p("pkg/.claude/settings.json"), p("CLAUDE.md")],
    refused: [no("CLAUDE.md", "agent-config"), no("pkg/.claude/settings.json", "agent-config")],
  },
  {
    name: "every agent config glob, top-level and nested",
    covers: ["agent-config"],
    changes: [
      p(".agents/skills/x/SKILL.md"),
      p("a/.codex/config.toml"),
      p("x/y/.pi/settings.json"),
      p(".mcp.json"),
      p("pkg/.mcp.json"),
      p("AGENTS.md"),
      p("a/b/AGENTS.md"),
      p(".claude/settings.json"),
    ],
    refused: [
      no(".agents/skills/x/SKILL.md", "agent-config"),
      no(".claude/settings.json", "agent-config"),
      no(".mcp.json", "agent-config"),
      no("AGENTS.md", "agent-config"),
      no("a/.codex/config.toml", "agent-config"),
      no("a/b/AGENTS.md", "agent-config"),
      no("pkg/.mcp.json", "agent-config"),
      no("x/y/.pi/settings.json", "agent-config"),
    ],
  },
  {
    name: "case-folded agent config",
    covers: ["agent-config"],
    changes: [p("Claude.md"), p("PKG/.Claude/x.json"), p("docs/agents.MD")],
    refused: [no("Claude.md", "agent-config"), no("PKG/.Claude/x.json", "agent-config"), no("docs/agents.MD", "agent-config")],
  },
  {
    name: "agent config under a policy Protected Path is reported as agent-config",
    covers: ["agent-config"],
    rules: { protectedPaths: ["src/**"] },
    changes: [p("src/CLAUDE.md")],
    refused: [no("src/CLAUDE.md", "agent-config")],
  },

  // protected-path.
  { name: "a policy Protected Path", covers: ["protected-path"], changes: [p("secrets/key")], refused: [no("secrets/key", "protected-path")] },
  { name: "a nested policy glob", covers: ["protected-path"], changes: [p("certs/a/server.pem")], refused: [no("certs/a/server.pem", "protected-path")] },
  { name: "case-folded Protected Path", covers: ["protected-path"], changes: [p("Secrets/Key"), p("x.PEM")], refused: [no("Secrets/Key", "protected-path"), no("x.PEM", "protected-path")] },

  // Full case folding (toUpperCase().toLowerCase(), as APFS folds): `ſ` folds to `s`, `K` (Kelvin) to `k`.
  { name: "full fold: ſ in the sprint status", covers: ["coordinator-file"], changes: [p(SPRINT.replace("sprint", "ſprint"))], refused: [no(SPRINT.replace("sprint", "ſprint"), "coordinator-file")] },
  { name: "full fold: ſ under .xarabot", covers: ["xarabot"], changes: [p(".XARABOT/epicſ.yaml")], refused: [no(".XARABOT/epicſ.yaml", "xarabot")] },
  { name: "full fold: ſ in the manifests dir", covers: ["manifest"], changes: [p("ſtories/1.1.md")], refused: [no("ſtories/1.1.md", "manifest")] },
  { name: "full fold: ſ in the Standing Authority", covers: ["standing-authority"], changes: [p("docſ/ſtanding-authority.md")], refused: [no("docſ/ſtanding-authority.md", "standing-authority")] },
  { name: "full fold: ſ under .github", covers: ["github"], changes: [p(".GITHUB/workflowſ/ci.yml")], refused: [no(".GITHUB/workflowſ/ci.yml", "github")] },
  {
    name: "full fold: .mcp.jſon, AGENTſ.md and AGENTſ.override.md",
    covers: ["agent-config"],
    changes: [p(".mcp.jſon"), p("pkg/AGENTſ.md"), p("AGENTſ.override.md")],
    refused: [no(".mcp.jſon", "agent-config"), no("AGENTſ.override.md", "agent-config"), no("pkg/AGENTſ.md", "agent-config")],
  },
  { name: "full fold: ſ and K in a Protected Path", covers: ["protected-path"], changes: [p("ſecretſ/Key")], refused: [no("ſecretſ/Key", "protected-path")] },
  {
    name: "AGENTS.override.md and CLAUDE.local.md at any depth are agent config",
    covers: ["agent-config"],
    changes: [p("AGENTS.override.md"), p("pkg/CLAUDE.local.md")],
    refused: [no("AGENTS.override.md", "agent-config"), no("pkg/CLAUDE.local.md", "agent-config")],
  },

  // Several at once: only the refused paths, in path order.
  {
    name: "a session that edits src, adds .claude/settings.json and changes the sprint status",
    covers: ["agent-config", "coordinator-file"],
    changes: [p("src/a.ts"), p(SPRINT), p(".claude/settings.json")],
    refused: [no(".claude/settings.json", "agent-config"), no(SPRINT, "coordinator-file")],
  },

  // Exception: the own spec file, exact path.
  { name: "the own spec file", covers: ["own-spec"], rules: { protectedPaths: ["_bmad-output/**"] }, changes: [p(SPEC)], refused: [] },
  {
    name: "own spec: another Story's spec is not excepted",
    covers: ["own-spec"],
    rules: { protectedPaths: ["_bmad-output/**"] },
    changes: [p("_bmad-output/implementation-artifacts/spec-2-4-y.md")],
    refused: [no("_bmad-output/implementation-artifacts/spec-2-4-y.md", "protected-path")],
  },
  {
    name: "own spec: a case variant of the spec path is not excepted",
    covers: ["own-spec"],
    rules: { protectedPaths: ["_bmad-output/**"] },
    changes: [p("_BMAD-output/implementation-artifacts/spec-2-3-x.md")],
    refused: [no("_BMAD-output/implementation-artifacts/spec-2-3-x.md", "protected-path")],
  },

  // Exception: the own manifest's status line.
  { name: "own manifest: only the status line changes", covers: ["own-manifest-status"], changes: [p(STORY, { before: M0, after: withStatus("done") })], refused: [] },
  {
    name: "own manifest: a status line added where there was none",
    covers: ["own-manifest-status"],
    changes: [p(STORY, { before: manifest(M.filter((l) => !l.startsWith("status:"))), after: M0 })],
    refused: [],
  },
  {
    name: "own manifest: the status line removed",
    covers: ["own-manifest-status"],
    changes: [p(STORY, { before: M0, after: manifest(M.filter((l) => !l.startsWith("status:"))) })],
    refused: [],
  },
  {
    name: "own manifest: the globs line changes",
    covers: ["own-manifest-status"],
    changes: [p(STORY, { before: M0, after: manifest(M.map((l) => (l.startsWith("globs:") ? 'globs: ["**"]' : l))) })],
    refused: [no(STORY, "manifest")],
  },
  {
    name: "own manifest: a title added next to the status",
    covers: ["own-manifest-status"],
    changes: [p(STORY, { before: M0, after: manifest([...M, "title2: x"]) })],
    refused: [no(STORY, "manifest")],
  },
  {
    name: "own manifest: two status lines",
    covers: ["own-manifest-status"],
    changes: [p(STORY, { before: M0, after: manifest([...M, "status: done"]) })],
    refused: [no(STORY, "manifest")],
  },
  {
    name: "own manifest: a body edit",
    covers: ["own-manifest-status"],
    changes: [p(STORY, { before: M0, after: manifest(M, "Body.\nstatus: done\n") })],
    refused: [no(STORY, "manifest")],
  },
  {
    name: "own manifest: no texts (not a regular file on both sides, or deleted)",
    covers: ["own-manifest-status"],
    changes: [p(STORY)],
    refused: [no(STORY, "manifest")],
  },
  {
    name: "own manifest: another Story's manifest with a status-only change",
    covers: ["own-manifest-status"],
    changes: [p("stories/1.1.md", { before: M0, after: withStatus("done") })],
    refused: [no("stories/1.1.md", "manifest")],
  },
  {
    name: "own manifest: a case variant of its path",
    covers: ["own-manifest-status"],
    changes: [p("Stories/2.3.md", { before: M0, after: withStatus("done") })],
    refused: [no("Stories/2.3.md", "manifest")],
  },

  // Exception: an approved Infrastructure Story.
  {
    name: "Infrastructure approved: .github, agent config, the Standing Authority and Protected Paths",
    covers: ["infrastructure"],
    rules: { infrastructureApproved: true },
    changes: [p(".github/workflows/ci.yml"), p("CLAUDE.md"), p(".claude/settings.json"), p(AUTHORITY), p("secrets/key")],
    refused: [],
  },
  {
    name: "Infrastructure approved never covers .xarabot",
    covers: ["infrastructure"],
    rules: { infrastructureApproved: true },
    changes: [p(".xarabot/policy.yaml")],
    refused: [no(".xarabot/policy.yaml", "xarabot")],
  },
  {
    name: "Infrastructure approved never covers manifests",
    covers: ["infrastructure"],
    rules: { infrastructureApproved: true },
    changes: [p("stories/1.1.md"), p(STORY, { before: M0, after: manifest([...M, "infrastructure: true"]) })],
    refused: [no("stories/1.1.md", "manifest"), no(STORY, "manifest")],
  },
  {
    name: "Infrastructure approved never covers coordinator files",
    covers: ["infrastructure"],
    rules: { infrastructureApproved: true },
    changes: [p(SPRINT), p(RETRO), p(EPICS)],
    refused: [no(RETRO, "coordinator-file"), no(SPRINT, "coordinator-file"), no(EPICS, "coordinator-file")],
  },
  {
    name: "Infrastructure not approved: .github is refused",
    covers: ["infrastructure"],
    rules: { infrastructureApproved: false },
    changes: [p(".github/workflows/ci.yml")],
    refused: [no(".github/workflows/ci.yml", "github")],
  },
];

/** The write-check table, per adapter; Epic 3 fills the other adapters. */
const TABLE: Partial<Record<AdapterName, readonly Case[]>> = {
  claude: CLAUDE_CASES,
};

for (const [adapter, cases] of Object.entries(TABLE)) {
  describe(`checkWrite (${adapter})`, () => {
    test.each((cases ?? []).map((c) => [c.name, c] as const))("%s", (_name, c) => {
      expect(checkWrite({ ...RULES, ...c.rules }, c.changes)).toEqual([...c.refused]);
    });
  });
}

describe("write-check table coverage", () => {
  test.each(Object.keys(TABLE))("%s: a refusing case for every class, and an excepted and a limit case for every exception", (adapter) => {
    const cases = TABLE[adapter as AdapterName] ?? [];
    for (const cls of WRITE_CLASSES) {
      const hit = cases.some((c) => c.covers.includes(cls) && c.refused.some((r) => r.class === cls));
      expect([cls, hit]).toEqual([cls, true]);
    }
    for (const ex of EXCEPTIONS) {
      const tagged = cases.filter((c) => c.covers.includes(ex));
      expect([ex, tagged.some((c) => c.refused.length === 0)]).toEqual([ex, true]);
      expect([ex, tagged.some((c) => c.refused.length > 0)]).toEqual([ex, true]);
    }
  });
});

// ------------------------------------------------------------- the parts

describe("writeRules", () => {
  test("takes the coordinator files, manifests dir, authority, policy paths and Epic context pattern from the config", () => {
    expect(RULES).toEqual({
      role: "builder",
      coordinatorFiles: [SPRINT, RETRO, EPICS],
      manifestsDir: "stories",
      standingAuthorityPath: AUTHORITY,
      protectedPaths: ["secrets/**", "**/*.pem"],
      epicContextPath: CONFIG_DEFAULTS.epic_context_path,
      specPath: SPEC,
      superseded: [],
      storyFile: STORY,
      infrastructureApproved: false,
    });
  });

  test("carries a re-run's superseded spec files", () => {
    const old = "_bmad-output/implementation-artifacts/spec-2-3-old.md";
    const config = {
      sprint_status_path: SPRINT,
      retro_gates_path: RETRO,
      epics_path: EPICS,
      manifests: { dir: "stories" },
      standing_authority_path: AUTHORITY,
      epic_context_path: CONFIG_DEFAULTS.epic_context_path,
    };
    expect(writeRules({ config, policy: { protected_paths: [] }, specPath: SPEC, superseded: [old], storyFile: STORY, infrastructureApproved: false }).superseded).toEqual([old]);
  });
});

describe("AGENT_CONFIG_PATHS", () => {
  test("the mandatory Protected Paths are .xarabot, .github, then the agent config globs, in order", () => {
    expect(MANDATORY_PROTECTED_PATHS).toEqual([".xarabot/**", ".github/**", ...AGENT_CONFIG_PATHS]);
    expect(AGENT_CONFIG_PATHS).toEqual([
      "**/.agents/**",
      "**/.claude/**",
      "**/.codex/**",
      "**/.pi/**",
      "**/.mcp.json",
      "**/AGENTS.md",
      "**/AGENTS.override.md",
      "**/CLAUDE.md",
      "**/CLAUDE.local.md",
    ]);
  });
});

describe("epicContextMatch", () => {
  const pattern = CONFIG_DEFAULTS.epic_context_path;
  const dir = "_bmad-output/implementation-artifacts";
  test.each([
    [`${dir}/epic-2-context.md`, true],
    [`${dir}/epic-12-context.md`, true],
    [`${dir}/EPIC-2-Context.md`, true],
    [`${dir}/epic-0-context.md`, false],
    [`${dir}/epic-02-context.md`, false],
    [`${dir}/epic-x-context.md`, false],
    [`${dir}/epic--context.md`, false],
    [`${dir}/epic-2-context.md.bak`, false],
    [`${dir}/old/epic-2-context.md`, false],
    [`x/${dir}/epic-2-context.md`, false],
  ] as const)("%s -> %p", (path, want) => {
    expect(epicContextMatch(pattern, path)).toBe(want);
  });

  test("every <N> must be the same number; regex characters in the pattern are literal", () => {
    expect(epicContextMatch("docs/epic-<N>/context-<N>.md", "docs/epic-2/context-2.md")).toBe(true);
    expect(epicContextMatch("docs/epic-<N>/context-<N>.md", "docs/epic-2/context-3.md")).toBe(false);
    expect(epicContextMatch("a.b/(epic)-<N>+.md", "a.b/(epic)-1+.md")).toBe(true);
    expect(epicContextMatch("a.b/(epic)-<N>+.md", "aXb/(epic)-1+.md")).toBe(false);
    expect(epicContextMatch("no-placeholder.md", "no-placeholder.md")).toBe(false);
  });
});

describe("statusLineOnly", () => {
  test.each([
    ["the status value changes", M0, withStatus("done"), true],
    ["nothing changes", M0, M0, true],
    ["a status line added", manifest(["a: 1"]), manifest(["a: 1", "status: done"]), true],
    ["the status line moves", manifest(["status: ready", "a: 1"]), manifest(["a: 1", "status: done"]), true],
    ["another field changes", M0, manifest(M.map((l) => (l === "epic: 2" ? "epic: 3" : l))), false],
    ["a field added", M0, manifest([...M, "x: 1"]), false],
    ["two status lines after", M0, manifest([...M, "status: done"]), false],
    ["two status lines before", manifest([...M, "status: done"]), M0, false],
    ["an indented status line is not top-level", manifest(["a:", "  status: x"]), manifest(["a:", "  status: y"]), false],
    ["a status line in the body", manifest(["a: 1"], "status: x\n"), manifest(["a: 1"], "status: y\n"), false],
    ["no frontmatter: a status line is body", "status: x\n", "status: y\n", false],
    ["no closing ---: not frontmatter", "---\nstatus: x\n", "---\nstatus: y\n", false],
    ["the frontmatter removed", M0, "Body.\n", false],
    ["a statusx: line is not a status line", manifest(["statusx: a"]), manifest(["statusx: b"]), false],
    ["a lone CR in the status line adds a key", M0, manifest(M.map((l) => (l.startsWith("status:") ? "status: done\rinfrastructure: true" : l))), false],
    ["a lone CR in the status line before", manifest(M.map((l) => (l.startsWith("status:") ? "status: x\ry: 1" : l))), M0, false],
    ["a trailing CR on the status line is fine", M0, manifest(M.map((l) => (l.startsWith("status:") ? "status: done\r" : l))), true],
    ["an indented line after an added status line becomes its continuation", manifest(["a: x", "  b"]), manifest(["a: x", "status: s", "  b"]), false],
    ["an indented line after a moved status line changes another field", manifest(["title: a", "status: s", "  b"]), manifest(["status: s", "title: a", "  b"]), false],
    ["an unclosed quote in the status value", M0, manifest(M.map((l) => (l.startsWith("status:") ? 'status: "done' : l))), false],
    ["a non-string status value", M0, manifest(M.map((l) => (l.startsWith("status:") ? "status: [done]" : l))), false],
    ["an empty frontmatter is not a mapping", "---\n---\nBody\n", "---\n---\nBody\n", false],
  ] as const)("%s -> %p", (_name, before, after, want) => {
    expect(statusLineOnly(before, after)).toBe(want);
  });
});

// ------------------------------------------------------------- coordinator

const COORD_CONFIG = { ...CONFIG_DEFAULTS, manifests: { dir: "stories" } };
const STATUS_UNIT: CoordinatorUnitSpec = { kind: "planning", planning: "status" };
const GRAPH_UNIT: CoordinatorUnitSpec = { kind: "planning", planning: "graph" };
const CONTEXT_2 = "_bmad-output/implementation-artifacts/epic-2-context.md";

/** The rules for a coordinator unit of `spec`. */
const coordRules = (spec: CoordinatorUnitSpec): CoordinatorWriteRules =>
  coordinatorWriteRules({ config: COORD_CONFIG, globs: coordinatorGlobs(spec, COORD_CONFIG), graphUnit: spec.kind === "planning" && spec.planning === "graph" });

type CoordCase = {
  readonly name: string;
  readonly unit: CoordinatorUnitSpec;
  /** A bare path is a regular file, mode `100644`. */
  readonly changes: readonly (string | WriteChange)[];
  readonly refused: readonly (readonly [string, CoordinatorWriteClass])[];
};

const COORD_CASES: readonly CoordCase[] = [
  // A unit inside its own globs.
  { name: "status planning writes the status files and an Epic context", unit: STATUS_UNIT, changes: [SPRINT, RETRO, CONTEXT_2], refused: [] },
  { name: "graph planning writes the graph inputs", unit: GRAPH_UNIT, changes: [EPICS, ".xarabot/epics.yaml", "stories/2.4.md"], refused: [] },
  { name: "a graph unit is allowed its inputs, case-folded", unit: GRAPH_UNIT, changes: ["_BMAD-output/planning-artifacts/Epics.md", ".XARABOT/epics.YAML"], refused: [] },
  { name: "a retro writes its retro document", unit: { kind: "retro", epic: 2 }, changes: ["_bmad-output/implementation-artifacts/epic-2-retro-2026-10-24.md", RETRO], refused: [] },
  { name: "a retro item writes its own globs", unit: { kind: "retro-item", globs: ["src/x/**"] }, changes: ["src/x/a.ts"], refused: [] },
  // xarabot.
  { name: "under .xarabot but epics.yaml: xarabot", unit: GRAPH_UNIT, changes: [".xarabot/config.yaml"], refused: [[".xarabot/config.yaml", "xarabot"]] },
  { name: "xarabot comes first, case-folded", unit: { kind: "retro-item", globs: ["**"] }, changes: [".Xarabot/policy.yaml"], refused: [[".Xarabot/policy.yaml", "xarabot"]] },
  // graph-input.
  { name: "a status unit touching epics.md: graph-input", unit: STATUS_UNIT, changes: [EPICS], refused: [[EPICS, "graph-input"]] },
  { name: "a retro item whose globs cover a manifest: graph-input", unit: { kind: "retro-item", globs: ["stories/**"] }, changes: ["stories/2.1.md"], refused: [["stories/2.1.md", "graph-input"]] },
  { name: "a non-graph unit touching .xarabot/epics.yaml: graph-input", unit: STATUS_UNIT, changes: [".xarabot/epics.yaml"], refused: [[".xarabot/epics.yaml", "graph-input"]] },
  { name: "graph-input is case-folded", unit: STATUS_UNIT, changes: ["Stories/2.1.MD"], refused: [["Stories/2.1.MD", "graph-input"]] },
  // outside-unit.
  { name: "a status unit writing src/a.ts: outside-unit", unit: STATUS_UNIT, changes: ["src/a.ts"], refused: [["src/a.ts", "outside-unit"]] },
  { name: "reconcile holds nothing: outside-unit", unit: { kind: "reconcile" }, changes: ["README.md"], refused: [["README.md", "outside-unit"]] },
  { name: "a graph unit writing a status file: outside-unit", unit: GRAPH_UNIT, changes: [SPRINT], refused: [[SPRINT, "outside-unit"]] },
  { name: "outside-unit is case-folded: the unit's own file in other case passes", unit: STATUS_UNIT, changes: ["_bmad-output/IMPLEMENTATION-artifacts/Sprint-Status.yaml"], refused: [] },
  // graph-and-status.
  {
    name: "status files with no graph input in the diff: no graph-and-status",
    unit: { kind: "retro-item", globs: ["_bmad-output/**"] },
    changes: [SPRINT, RETRO, "_bmad-output/implementation-artifacts/notes.md"],
    refused: [],
  },
  {
    name: "graph-and-status: every graph input and status file left is refused",
    unit: GRAPH_UNIT,
    changes: [EPICS, "stories/2.4.md", SPRINT],
    refused: [
      ["_bmad-output/implementation-artifacts/sprint-status.yaml", "outside-unit"],
      [EPICS, "graph-and-status"],
      ["stories/2.4.md", "graph-and-status"],
    ],
  },
  {
    name: "graph-and-status in a status unit: the graph input is graph-input, the status files graph-and-status",
    unit: STATUS_UNIT,
    changes: [EPICS, SPRINT, RETRO, CONTEXT_2],
    refused: [
      [RETRO, "graph-and-status"],
      [SPRINT, "graph-and-status"],
      [EPICS, "graph-input"],
    ],
  },
  // mode: a status file or graph input must stay a regular file, `100644`.
  { name: "mode: a status file made executable", unit: STATUS_UNIT, changes: [{ path: SPRINT, mode: "100755" }], refused: [[SPRINT, "mode"]] },
  { name: "mode: a status file made a symlink", unit: STATUS_UNIT, changes: [{ path: SPRINT, mode: "120000" }], refused: [[SPRINT, "mode"]] },
  { name: "mode: a status file made a gitlink", unit: STATUS_UNIT, changes: [{ path: RETRO, mode: "160000" }], refused: [[RETRO, "mode"]] },
  { name: "mode: a status file deleted has no mode", unit: STATUS_UNIT, changes: [{ path: SPRINT, mode: "000000" }], refused: [[SPRINT, "mode"]] },
  { name: "mode: a change with no mode is refused", unit: STATUS_UNIT, changes: [{ path: SPRINT }], refused: [[SPRINT, "mode"]] },
  { name: "mode: 100644 passes", unit: STATUS_UNIT, changes: [{ path: SPRINT, mode: "100644" }, { path: RETRO, mode: "100644" }], refused: [] },
  { name: "mode: a graph input made executable", unit: GRAPH_UNIT, changes: [{ path: "stories/2.4.md", mode: "100755" }], refused: [["stories/2.4.md", "mode"]] },
  { name: "mode: only status files and graph inputs are checked", unit: STATUS_UNIT, changes: [{ path: CONTEXT_2, mode: "100755" }], refused: [] },
  { name: "mode: an earlier class is reported first", unit: STATUS_UNIT, changes: [{ path: EPICS, mode: "120000" }], refused: [[EPICS, "graph-input"]] },
  // Full case folding: `ſ` folds to `s`.
  { name: "full fold: .xarabot/epicſ.yaml is epics.yaml for a graph unit", unit: GRAPH_UNIT, changes: [".XARABOT/epicſ.yaml"], refused: [] },
  { name: "full fold: xarabot", unit: GRAPH_UNIT, changes: [".xarabot/ſettings.yaml"], refused: [[".xarabot/ſettings.yaml", "xarabot"]] },
  { name: "full fold: graph-input", unit: STATUS_UNIT, changes: ["ſtories/2.1.md"], refused: [["ſtories/2.1.md", "graph-input"]] },
  { name: "full fold: the unit's own file with ſ passes", unit: STATUS_UNIT, changes: [SPRINT.replace("sprint-status", "ſprint-ſtatus")], refused: [] },
  { name: "full fold: outside-unit", unit: { kind: "retro-item", globs: ["src/**"] }, changes: ["ſrc/a.ts", "lib/ſ.ts"], refused: [["lib/ſ.ts", "outside-unit"]] },
  {
    name: "full fold: graph-and-status in a status unit",
    unit: STATUS_UNIT,
    changes: [EPICS.replace("epics", "epicſ"), SPRINT.replace("sprint", "ſprint")],
    refused: [
      [EPICS.replace("epics", "epicſ"), "graph-input"],
      [SPRINT.replace("sprint", "ſprint"), "graph-and-status"],
    ],
  },
  { name: "full fold: mode", unit: STATUS_UNIT, changes: [{ path: SPRINT.replace("sprint", "ſprint"), mode: "100755" }], refused: [[SPRINT.replace("sprint", "ſprint"), "mode"]] },
];

describe("checkWrite (coordinator)", () => {
  test.each(COORD_CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const got = checkWrite(coordRules(c.unit), c.changes.map((x) => (typeof x === "string" ? { path: x, mode: "100644" } : x)));
    const want = c.refused.map(([path, cls]) => ({ path, class: cls }));
    expect(got).toEqual([...want].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
  });

  test("a case refuses with every class", () => {
    for (const cls of COORDINATOR_WRITE_CLASSES) {
      const hit = COORD_CASES.some((c) => c.refused.some(([, x]) => x === cls));
      expect([cls, hit]).toEqual([cls, true]);
    }
  });

  test("graph-and-status needs both: a graph unit holding a status file glob", () => {
    const rules = coordinatorWriteRules({ config: COORD_CONFIG, globs: [EPICS, SPRINT], graphUnit: true });
    const r = (path: string): WriteChange => ({ path, mode: "100644" });
    expect(checkWrite(rules, [r(EPICS)])).toEqual([]);
    expect(checkWrite(rules, [r(SPRINT)])).toEqual([]);
    expect(checkWrite(rules, [r(EPICS), r(SPRINT.toUpperCase())])).toEqual([
      { path: SPRINT.toUpperCase(), class: "graph-and-status" },
      { path: EPICS, class: "graph-and-status" },
    ]);
  });

  test("coordinatorWriteRules takes the graph inputs and status files from the config", () => {
    expect(coordRules(STATUS_UNIT)).toEqual({
      role: "coordinator",
      globs: [SPRINT, RETRO, "_bmad-output/implementation-artifacts/epic-*-context.md"],
      graphUnit: false,
      graphInputs: [EPICS, ".xarabot/epics.yaml", "stories/*.md"],
      statusFiles: [SPRINT, RETRO],
    });
  });
});
