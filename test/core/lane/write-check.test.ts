import { describe, expect, test } from "bun:test";
import { AGENT_CONFIG_PATHS, MANDATORY_PROTECTED_PATHS } from "../../../src/core/config/protected-paths.ts";
import {
  checkWrite,
  CONTENT_WRITE_CLASSES,
  COORDINATOR_WRITE_CLASSES,
  coordinatorWriteRules,
  epicContextMatch,
  sprintStatusRefusals,
  statusLineOnly,
  statusSession,
  STORY_STATUSES,
  symlinkTarget,
  WRITE_CLASSES,
  writeRules,
  type CoordinatorWriteClass,
  type CoordinatorWriteRules,
  type StatusSession,
  type WriteChange,
  type WriteClass,
  type WriteRefusal,
  type WriteRules,
} from "../../../src/core/lane/write-check.ts";
import { coordinatorGlobs, GRAPH_PSEUDO_GLOB, type CoordinatorUnitSpec } from "../../../src/core/next/coordinator.ts";
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
    live_evidence_glob: CONFIG_DEFAULTS.live_evidence_glob,
  },
  policy: { protected_paths: ["secrets/**", "**/*.pem"] },
  specPath: SPEC,
  storyFile: STORY,
  infrastructureApproved: false,
});

const manifest = (lines: readonly string[], body = "Body.\n") => `---\n${lines.join("\n")}\n---\n\n${body}`;
const M = ['story_id: "2.3"', "epic: 2", "title: The write check", "status: ready-for-dev", 'globs: ["src/**"]'];
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

  // live-evidence (Story 2.9).
  {
    name: "a live evidence file",
    covers: ["live-evidence"],
    changes: [p("docs/maintainer/evidence/epic-2.md")],
    refused: [no("docs/maintainer/evidence/epic-2.md", "live-evidence")],
  },
  {
    name: "a live evidence file, case-folded and any Epic",
    covers: ["live-evidence"],
    changes: [p("Docs/Maintainer/Evidence/EPIC-12.MD")],
    refused: [no("Docs/Maintainer/Evidence/EPIC-12.MD", "live-evidence")],
  },
  { name: "another file in the evidence folder is not live evidence", covers: [], changes: [p("docs/maintainer/evidence/notes.md")], refused: [] },
  {
    name: "Infrastructure approved never covers live evidence",
    covers: ["live-evidence"],
    rules: { infrastructureApproved: true },
    changes: [p("docs/maintainer/evidence/epic-2.md")],
    refused: [no("docs/maintainer/evidence/epic-2.md", "live-evidence")],
  },
  {
    name: "a live evidence file under a Protected Path is reported as live-evidence",
    covers: ["live-evidence"],
    rules: { protectedPaths: ["docs/**"] },
    changes: [p("docs/maintainer/evidence/epic-3.md")],
    refused: [no("docs/maintainer/evidence/epic-3.md", "live-evidence")],
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
  {
    name: "a file or symlink in place of a protected <dir>/** folder, case-folded",
    covers: ["protected-path"],
    rules: { protectedPaths: ["secrets/**", "docs/private/**"] },
    changes: [p("secrets"), p("Docs/Private")],
    refused: [no("Docs/Private", "protected-path"), no("secrets", "protected-path")],
  },
  {
    name: "only the protected folder itself: a sibling name or a parent folder is not refused",
    covers: [],
    rules: { protectedPaths: ["secrets/**", "docs/private/**"] },
    changes: [p("secrets2"), p("docs"), p("docs/privatex")],
    refused: [],
  },
  { name: "a glob not ending in /** is not widened", covers: [], changes: [p("x.pem.d")], refused: [] },

  // NFD before folding (as APFS compares names): a composed `é` and `e` with a combining accent are one name.
  {
    name: "nfd: a decomposed path in a composed Protected Path",
    covers: ["protected-path"],
    rules: { protectedPaths: ["café/**"] },
    changes: [p("café/menu"), p("CAFÉ/x")],
    refused: [no("CAFÉ/x", "protected-path"), no("café/menu", "protected-path")],
  },
  {
    name: "nfd: a composed path to a decomposed Standing Authority",
    covers: ["standing-authority"],
    rules: { standingAuthorityPath: "docs/autorité.md" },
    changes: [p("docs/autorité.md"), p("Docs/AUTORITÉ.md")],
    refused: [no("Docs/AUTORITÉ.md", "standing-authority"), no("docs/autorité.md", "standing-authority")],
  },
  {
    name: "nfd: the folder of a protected <dir>/** glob, decomposed",
    covers: ["protected-path"],
    rules: { protectedPaths: ["dépôt/**"] },
    changes: [p("dépôt")],
    refused: [no("dépôt", "protected-path")],
  },

  // Full case folding (toUpperCase().toLowerCase(), as APFS folds): `ſ` folds to `s`, `K` (Kelvin) to `k`.
  { name: "full fold: ſ in the sprint status", covers: ["coordinator-file"], changes: [p(SPRINT.replace("sprint", "ſprint"))], refused: [no(SPRINT.replace("sprint", "ſprint"), "coordinator-file")] },
  {
    name: "full fold: ſ in a live evidence file",
    covers: ["live-evidence"],
    changes: [p("Docſ/maintainer/evidence/epic-2.md")],
    refused: [no("Docſ/maintainer/evidence/epic-2.md", "live-evidence")],
  },
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
  {
    name: "own manifest: a status that is not a BMAD Story status",
    covers: ["own-manifest-status"],
    changes: [p(STORY, { before: M0, after: withStatus("shipped") })],
    refused: [no(STORY, "manifest")],
  },
  {
    name: 'own manifest: a quoted "status": key is not the status line (fails closed)',
    covers: ["own-manifest-status"],
    changes: [p(STORY, { before: manifest(M.map((l) => (l.startsWith("status:") ? '"status": ready-for-dev' : l))), after: manifest(M.map((l) => (l.startsWith("status:") ? '"status": done' : l))) })],
    refused: [no(STORY, "manifest")],
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

/**
 * The `codex` cases: every `claude` case (the write check is the runner's,
 * whatever agent made the diff), plus the paths codex itself writes or reads
 * its instructions and skills from.
 */
const CODEX_CASES: readonly Case[] = [
  ...CLAUDE_CASES,
  {
    name: "codex: a project .codex/config.toml (a trust entry) and a nested AGENTS.override.md",
    covers: ["agent-config"],
    changes: [p(".codex/config.toml"), p("src/AGENTS.override.md")],
    refused: [no(".codex/config.toml", "agent-config"), no("src/AGENTS.override.md", "agent-config")],
  },
  {
    name: "codex: a skill under .agents/skills, the tree codex reads natively",
    covers: ["agent-config"],
    changes: [p(".agents/skills/bmad-build-auto/SKILL.md"), p(".agents/skills/new-skill/SKILL.md")],
    refused: [no(".agents/skills/bmad-build-auto/SKILL.md", "agent-config"), no(".agents/skills/new-skill/SKILL.md", "agent-config")],
  },
  {
    name: "codex: the session's rollout files never reach the clone, but a copy there is ordinary",
    covers: [],
    changes: [p("sessions/2026/10/25/rollout-x.jsonl")],
    refused: [],
  },
  {
    name: "codex: a session that edits src, writes .codex/config.toml and changes the retro gates",
    covers: ["agent-config", "coordinator-file"],
    changes: [p("src/a.ts"), p(RETRO), p(".codex/config.toml")],
    refused: [no(".codex/config.toml", "agent-config"), no(RETRO, "coordinator-file")],
  },
];

/** The write-check table, per adapter; `pi` joins with its adapter, deferred to v1 (Story 3.2). */
const TABLE: Partial<Record<AdapterName, readonly Case[]>> = {
  claude: CLAUDE_CASES,
  codex: CODEX_CASES,
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

  test.each(Object.keys(TABLE))("%s: a full fold case refuses with every class", (adapter) => {
    const cases = TABLE[adapter as AdapterName] ?? [];
    for (const cls of WRITE_CLASSES) {
      const hit = cases.some((c) => c.name.startsWith("full fold:") && c.refused.some((r) => r.class === cls));
      expect([cls, hit]).toEqual([cls, true]);
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
      liveEvidenceGlob: "docs/maintainer/evidence/epic-*.md",
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
      live_evidence_glob: CONFIG_DEFAULTS.live_evidence_glob,
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
  test("the BMAD Story status values", () => {
    expect([...STORY_STATUSES]).toEqual(["backlog", "ready-for-dev", "in-progress", "review", "done"]);
  });

  test.each([...STORY_STATUSES])("the status set to %s passes", (status) => {
    expect(statusLineOnly(M0, withStatus(status))).toBe(true);
  });

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
    ["an indented line after a moved status line changes another field", manifest(["title: a", "status: done", "  b"]), manifest(["status: done", "title: a", "  b"]), false],
    ["an unclosed quote in the status value", M0, manifest(M.map((l) => (l.startsWith("status:") ? 'status: "done' : l))), false],
    ["a non-string status value", M0, manifest(M.map((l) => (l.startsWith("status:") ? "status: [done]" : l))), false],
    ["an empty status value", M0, withStatus(""), false],
    ["a quoted status value", M0, withStatus('"done"'), true],
    ["a status value with a comment", M0, withStatus("done # built"), true],
    ["a status that is not a BMAD Story status", M0, withStatus("shipped"), false],
    ["a status in another case", M0, withStatus("Done"), false],
    ["a status with inner spaces kept by quotes", M0, withStatus('"done "'), false],
    ["a spec status, not a Story status", M0, withStatus("in-review"), false],
    ["a legacy v6 status", M0, withStatus("drafted"), false],
    ["a non-BMAD status unchanged still fails", withStatus("shipped"), withStatus("shipped\r"), false],
    ["a non-BMAD status before may be set to a BMAD one", withStatus("shipped"), withStatus("review"), true],
    // 2.3 follow-up F2 (accepted, fails closed): only a bare `status:` key is the status line.
    ['a double-quoted "status": key', manifest(['"status": ready-for-dev', "a: 1"]), manifest(['"status": done', "a: 1"]), false],
    ["a single-quoted 'status': key", manifest(["'status': ready-for-dev", "a: 1"]), manifest(["'status': done", "a: 1"]), false],
    ['a quoted "status": key added', manifest(["a: 1"]), manifest(["a: 1", '"status": done']), false],
    ['a bare status: line replacing a quoted "status": key', manifest(['"status": ready-for-dev', "a: 1"]), manifest(["status: done", "a: 1"]), false],
    ["an empty frontmatter is not a mapping", "---\n---\nBody\n", "---\n---\nBody\n", false],
  ] as const)("%s -> %p", (_name, before, after, want) => {
    expect(statusLineOnly(before, after)).toBe(want);
  });
});

// ------------------------------------------------------------- coordinator

const COORD_CONFIG = { ...CONFIG_DEFAULTS, manifests: { dir: "stories" } };
const RETRO_UNIT: CoordinatorUnitSpec = { kind: "retro", epic: 2 };
const EMPTY_GATES = "schema_version: 1\nepics: {}\n";
const GO = '      go:\n        by: edanisko\n        at: "2026-10-21T00:00:00Z"\n        ruling: maintainer-pr\n';
const GATES_2 = [
  "schema_version: 1",
  "epics:",
  '  "2":',
  "    retro:",
  "      verdict: rejected",
  '      unit: "retro:2"',
  '      recorded_at: "2026-10-20T00:00:00Z"',
  GO.trimEnd(),
  "    items:",
  '      - id: "epic-2-retro-item-1-fix"',
  "        text: Fix it",
  "        route: lane",
  "        blocking: true",
  '        globs: ["src/x/**"]',
  "        status: open",
  "",
].join("\n");
const ITEM_2 = '      - id: "epic-2-retro-item-2-more"\n        text: More\n        route: maintainer\n        blocking: false\n        globs: []\n        status: open\n';
const CHECKPOINT_3 = '  "3":\n    checkpoint:\n      go:\n        by: edanisko\n        at: "2026-10-22T00:00:00Z"\n        ruling: maintainer-pr\n';
/** A regular-file change to `retro-gates.yaml` with its two texts. */
const gates = (before: string | null, after: string | null): WriteChange => ({ path: RETRO, mode: "100644", retroGates: { before, after } });
const STATUS_UNIT: CoordinatorUnitSpec = { kind: "planning", planning: "status" };
const GRAPH_UNIT: CoordinatorUnitSpec = { kind: "planning", planning: "graph" };
const CONTEXT_2 = "_bmad-output/implementation-artifacts/epic-2-context.md";
/** `retro-gates.yaml` with `ſ` for its `s`: the same file once fully folded. */
const RETRO_FOLDED = RETRO.replace("retro-gates", "retro-gateſ");
/** `sprint-status.yaml` with `ſ` for its first `s`. */
const SPRINT_FOLDED = SPRINT.replace("sprint", "ſprint");
/** A retro item holding every path, with no builder refusal: the coordinator classes alone, for paths in any case. */
const ANY_UNIT: CoordinatorUnitSpec = { kind: "retro-item", globs: ["**"] };

/** A unit id of `spec`'s kind: `commitSession` sets the rules' `unit` from the clone marker. */
function unitOf(spec: CoordinatorUnitSpec): string {
  switch (spec.kind) {
    case "planning":
      return `planning:${spec.planning}.1`;
    case "retro":
      return `retro:${spec.epic}`;
    case "retro-item":
      return "retro-item:epic-2-retro-item-1-fix";
    case "reconcile":
      return "reconcile:1";
  }
}

/** The rules for a coordinator unit of `spec`, with its unit set. */
const coordRules = (spec: CoordinatorUnitSpec): CoordinatorWriteRules => ({
  ...coordinatorWriteRules({ config: COORD_CONFIG, globs: coordinatorGlobs(spec, COORD_CONFIG), graphUnit: spec.kind === "planning" && spec.planning === "graph" }),
  unit: unitOf(spec),
});

/** A sprint status as BMAD writes it: an Epic, its Stories and retrospective, and Epic 1's action item. */
const S0 = [
  "generated: 10-22-2026 00:43",
  "last_updated: 10-22-2026 00:43",
  "project: xarabot",
  "development_status:",
  "  epic-2: in-progress",
  "  2-1-heartbeat: done",
  "  2-2-takeover: review",
  "  epic-2-retrospective: optional",
  "action_items:",
  '  - id: "epic-1-retro-item-1-x"',
  "    epic: 1",
  "    status: open",
  "",
].join("\n");
/** `S0` with `development_status` keys added after `epic-2-retrospective`. */
const withKeys = (...lines: readonly string[]) => S0.replace("  epic-2-retrospective: optional\n", `  epic-2-retrospective: optional\n${lines.map((l) => `  ${l}\n`).join("")}`);
/** `S0` with action items appended. */
const withItems = (...items: readonly (readonly [string, string])[]) => `${S0}${items.map(([id, epic]) => `  - id: "${id}"\n${epic === "" ? "" : `    epic: ${epic}\n`}    status: open\n`).join("")}`;
/** A regular-file change to `sprint-status.yaml` with its two texts. */
const sprint = (before: string | null, after: string | null, path: string = SPRINT): WriteChange => ({ path, mode: "100644", sprintStatus: { before, after } });
/** The refusal path of one key of `sprint-status.yaml`. */
const key = (k: string, path: string = SPRINT) => `${path}#${k}`;

type CoordCase = {
  readonly name: string;
  readonly unit: CoordinatorUnitSpec;
  /** A bare path is a regular file, mode `100644`. */
  readonly changes: readonly (string | WriteChange)[];
  readonly refused: readonly (readonly [string, CoordinatorWriteClass])[];
};

const COORD_CASES: readonly CoordCase[] = [
  // A unit inside its own globs.
  { name: "status planning writes the status files and an Epic context", unit: STATUS_UNIT, changes: [sprint(S0, withKeys("epic-3: backlog")), gates(null, EMPTY_GATES), CONTEXT_2], refused: [] },
  { name: "graph planning writes the graph inputs", unit: GRAPH_UNIT, changes: [EPICS, ".xarabot/epics.yaml", "stories/2.4.md"], refused: [] },
  {
    name: "a graph unit's inputs in another case are refused, never folded into its globs",
    unit: GRAPH_UNIT,
    changes: ["_BMAD-output/planning-artifacts/Epics.md", ".XARABOT/epics.YAML", "Stories/2.4.md"],
    refused: [
      [".XARABOT/epics.YAML", "xarabot"],
      ["Stories/2.4.md", "outside-unit"],
      ["_BMAD-output/planning-artifacts/Epics.md", "outside-unit"],
    ],
  },
  { name: "a retro writes its retro document", unit: { kind: "retro", epic: 2 }, changes: ["_bmad-output/implementation-artifacts/epic-2-retro-2026-10-24.md", gates(EMPTY_GATES, `${EMPTY_GATES}# a comment\n`)], refused: [] },
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
  { name: "outside-unit is exact: the unit's own file in another case is refused", unit: STATUS_UNIT, changes: ["_bmad-output/IMPLEMENTATION-artifacts/Sprint-Status.yaml"], refused: [["_bmad-output/IMPLEMENTATION-artifacts/Sprint-Status.yaml", "outside-unit"]] },
  // graph-and-status.
  {
    name: "status files with no graph input in the diff: no graph-and-status",
    unit: { kind: "retro-item", globs: ["_bmad-output/**"] },
    changes: [sprint(S0, S0), gates(GATES_2, GATES_2), "_bmad-output/implementation-artifacts/notes.md"],
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
  { name: "mode: 100644 passes", unit: STATUS_UNIT, changes: [sprint(S0, `# a comment\n${S0}`), gates(null, null)], refused: [] },
  // The retro records (Story 2.9): no agent diff changes a verdict, item or go, in any unit.
  { name: "retro-verdict: a verdict changed", unit: RETRO_UNIT, changes: [gates(GATES_2.replace(GO, ""), GATES_2.replace(GO, "").replace("verdict: rejected", "verdict: accepted"))], refused: [[RETRO, "retro-verdict"]] },
  { name: "retro-verdict: a retro added", unit: RETRO_UNIT, changes: [gates(null, GATES_2)], refused: [[RETRO, "retro-verdict"], [RETRO, "retro-item"], [RETRO, "retro-go"]] },
  { name: "retro-verdict: a recorded_at changed", unit: STATUS_UNIT, changes: [gates(GATES_2, GATES_2.replace("2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z"))], refused: [[RETRO, "retro-verdict"]] },
  { name: "retro-item: an item's status changed", unit: RETRO_UNIT, changes: [gates(GATES_2, GATES_2.replace("status: open", "status: done"))], refused: [[RETRO, "retro-item"]] },
  { name: "retro-item: an item appended", unit: STATUS_UNIT, changes: [gates(GATES_2, `${GATES_2}${ITEM_2}`)], refused: [[RETRO, "retro-item"]] },
  { name: "retro-go: a go removed", unit: RETRO_UNIT, changes: [gates(GATES_2, GATES_2.replace(GO, ""))], refused: [[RETRO, "retro-go"]] },
  { name: "retro-go: only the go changed is not retro-verdict", unit: RETRO_UNIT, changes: [gates(GATES_2, GATES_2.replace("by: edanisko", "by: alice"))], refused: [[RETRO, "retro-go"]] },
  { name: "checkpoint-go: a checkpoint go added", unit: RETRO_UNIT, changes: [gates(GATES_2, `${GATES_2}${CHECKPOINT_3}`)], refused: [[RETRO, "checkpoint-go"]] },
  { name: "retro-gates-invalid: the after side does not parse", unit: RETRO_UNIT, changes: [gates(GATES_2, "schema_version: 1\nepics: [\n")], refused: [[RETRO, "retro-gates-invalid"]] },
  { name: "retro-gates-invalid: the before side breaks the schema", unit: RETRO_UNIT, changes: [gates("schema_version: 2\nepics: {}\n", EMPTY_GATES)], refused: [[RETRO, "retro-gates-invalid"]] },
  { name: "retro-gates-invalid: a change with no texts", unit: RETRO_UNIT, changes: [{ path: RETRO, mode: "100644" }], refused: [[RETRO, "retro-gates-invalid"]] },
  { name: "retro-gates: a case variant is outside the retro's globs", unit: RETRO_UNIT, changes: [{ ...gates(GATES_2, GATES_2), path: RETRO.toUpperCase() }], refused: [[RETRO.toUpperCase(), "outside-unit"]] },
  { name: "retro-gates: case-folded path in a unit whose globs hold it", unit: ANY_UNIT, changes: [{ ...gates(GATES_2, GATES_2.replace("status: open", "status: done")), path: RETRO.toUpperCase() }], refused: [[RETRO.toUpperCase(), "retro-item"]] },
  { name: "retro-gates: an earlier class wins", unit: { kind: "retro-item", globs: ["src/**"] }, changes: [gates(GATES_2, EMPTY_GATES)], refused: [[RETRO, "outside-unit"]] },
  { name: "mode: a graph input made executable", unit: GRAPH_UNIT, changes: [{ path: "stories/2.4.md", mode: "100755" }], refused: [["stories/2.4.md", "mode"]] },
  { name: "mode: only status files and graph inputs are checked", unit: STATUS_UNIT, changes: [{ path: CONTEXT_2, mode: "100755" }], refused: [] },
  { name: "mode: an earlier class is reported first", unit: STATUS_UNIT, changes: [{ path: EPICS, mode: "120000" }], refused: [[EPICS, "graph-input"]] },
  // Full case folding: `ſ` folds to `s`.
  { name: "full fold: .xarabot/epicſ.yaml is not epics.yaml for a graph unit", unit: GRAPH_UNIT, changes: [".XARABOT/epicſ.yaml"], refused: [[".XARABOT/epicſ.yaml", "xarabot"]] },
  { name: "full fold: xarabot", unit: GRAPH_UNIT, changes: [".xarabot/ſettings.yaml"], refused: [[".xarabot/ſettings.yaml", "xarabot"]] },
  { name: "full fold: graph-input", unit: STATUS_UNIT, changes: ["ſtories/2.1.md"], refused: [["ſtories/2.1.md", "graph-input"]] },
  { name: "full fold: the unit's own file with ſ is outside-unit", unit: STATUS_UNIT, changes: [SPRINT.replace("sprint-status", "ſprint-ſtatus")], refused: [[SPRINT.replace("sprint-status", "ſprint-ſtatus"), "outside-unit"]] },
  { name: "full fold: outside-unit", unit: { kind: "retro-item", globs: ["src/**"] }, changes: ["ſrc/a.ts", "lib/ſ.ts"], refused: [["lib/ſ.ts", "outside-unit"], ["ſrc/a.ts", "outside-unit"]] },
  {
    name: "full fold: graph-and-status in a unit holding every path",
    unit: ANY_UNIT,
    changes: [EPICS.replace("epics", "epicſ"), SPRINT.replace("sprint", "ſprint")],
    refused: [
      [EPICS.replace("epics", "epicſ"), "graph-input"],
      [SPRINT.replace("sprint", "ſprint"), "graph-and-status"],
    ],
  },
  { name: "full fold: mode", unit: ANY_UNIT, changes: [{ path: SPRINT.replace("sprint", "ſprint"), mode: "100755" }], refused: [[SPRINT.replace("sprint", "ſprint"), "mode"]] },
  { name: "full fold: retro-verdict", unit: ANY_UNIT, changes: [{ ...gates(GATES_2.replace(GO, ""), GATES_2.replace(GO, "").replace("verdict: rejected", "verdict: accepted")), path: RETRO_FOLDED }], refused: [[RETRO_FOLDED, "retro-verdict"]] },
  { name: "full fold: retro-item", unit: ANY_UNIT, changes: [{ ...gates(GATES_2, GATES_2.replace("status: open", "status: done")), path: RETRO_FOLDED }], refused: [[RETRO_FOLDED, "retro-item"]] },
  { name: "full fold: retro-go", unit: ANY_UNIT, changes: [{ ...gates(GATES_2, GATES_2.replace(GO, "")), path: RETRO_FOLDED }], refused: [[RETRO_FOLDED, "retro-go"]] },
  { name: "full fold: checkpoint-go", unit: ANY_UNIT, changes: [{ ...gates(GATES_2, `${GATES_2}${CHECKPOINT_3}`), path: RETRO_FOLDED }], refused: [[RETRO_FOLDED, "checkpoint-go"]] },
  { name: "full fold: retro-gates-invalid", unit: ANY_UNIT, changes: [{ path: RETRO_FOLDED, mode: "100644" }], refused: [[RETRO_FOLDED, "retro-gates-invalid"]] },
  // sprint-status.yaml, by key (AR31, Epic 2 retro C5): status planning only adds keys.
  { name: "status planning adds missing keys and bumps last_updated", unit: STATUS_UNIT, changes: [sprint(S0, withKeys("epic-3: backlog", "3-1-x: backlog", "epic-3-retrospective: optional").replace("last_updated: 10-22-2026 00:43", "last_updated: 10-25-2026 10:00"))], refused: [] },
  { name: "status planning adds a top-level key", unit: STATUS_UNIT, changes: [sprint(S0, `${S0}story_location: x\n`)], refused: [] },
  { name: "status planning writes the whole file where none was", unit: STATUS_UNIT, changes: [sprint(null, S0.replace("2-1-heartbeat: done", "2-1-heartbeat: review"))], refused: [] },
  { name: "status planning fills an empty file", unit: STATUS_UNIT, changes: [sprint("", S0.replace("2-1-heartbeat: done", "2-1-heartbeat: review"))], refused: [] },
  { name: "status planning: comments and layout change no key", unit: STATUS_UNIT, changes: [sprint(S0, `# note\n${S0.replace("development_status:\n", "development_status:   \n")}`)], refused: [] },
  { name: "status-key: status planning changes a Story's value", unit: STATUS_UNIT, changes: [sprint(S0, S0.replace("2-2-takeover: review", "2-2-takeover: in-progress"))], refused: [[key("development_status.2-2-takeover"), "status-key"]] },
  { name: "status-key: status planning changes an Epic's value", unit: STATUS_UNIT, changes: [sprint(S0, S0.replace("epic-2: in-progress", "epic-2: done"))], refused: [[key("development_status.epic-2"), "status-key"]] },
  { name: "status-key: status planning removes a key", unit: STATUS_UNIT, changes: [sprint(S0, S0.replace("  2-1-heartbeat: done\n", ""))], refused: [[key("development_status.2-1-heartbeat"), "status-key"]] },
  { name: "status-key: status planning sets an existing key null", unit: STATUS_UNIT, changes: [sprint(S0, S0.replace("2-2-takeover: review", "2-2-takeover:"))], refused: [[key("development_status.2-2-takeover"), "status-key"]] },
  { name: "status-key: status planning changes another top-level value", unit: STATUS_UNIT, changes: [sprint(S0, S0.replace("generated: 10-22-2026 00:43", "generated: 10-25-2026 10:00"))], refused: [[key("generated"), "status-key"]] },
  { name: "status-key: status planning appends an action item", unit: STATUS_UNIT, changes: [sprint(S0, withItems(["epic-2-retro-item-1-y", "2"]))], refused: [[key("action_items"), "status-key"]] },
  { name: "status-key: one refusal per key, in key order", unit: STATUS_UNIT, changes: [sprint(S0, S0.replace("2-2-takeover: review", "2-2-takeover: backlog").replace("project: xarabot", "project: other"))], refused: [[key("development_status.2-2-takeover"), "status-key"], [key("project"), "status-key"]] },
  // A retro only appends its Epic's action items and sets its own retrospective key.
  { name: "a retro appends its Epic's action items, sets its retrospective and bumps last_updated", unit: RETRO_UNIT, changes: [sprint(S0, withItems(["epic-2-retro-item-1-y", "2"], ["epic-2-retro-item-2-z", "2"]).replace("epic-2-retrospective: optional", "epic-2-retrospective: done").replace("last_updated: 10-22-2026 00:43", "last_updated: 10-25-2026 10:00"))], refused: [] },
  { name: "a retro adds its retrospective key and the first action items", unit: RETRO_UNIT, changes: [sprint(S0.replace("  epic-2-retrospective: optional\n", "").replace(/action_items:\n[\s\S]*$/, ""), S0.replace(/action_items:\n[\s\S]*$/, `action_items:\n  - id: "epic-2-retro-item-1-y"\n    epic: 2\n`))], refused: [] },
  { name: "status-key: a retro removes its retrospective key", unit: RETRO_UNIT, changes: [sprint(S0, S0.replace("  epic-2-retrospective: optional\n", ""))], refused: [[key("development_status.epic-2-retrospective"), "status-key"]] },
  { name: "status-key: a retro sets another Epic's retrospective", unit: RETRO_UNIT, changes: [sprint(S0, withKeys("epic-1-retrospective: done"))], refused: [[key("development_status.epic-1-retrospective"), "status-key"]] },
  { name: "status-key: a retro changes its Epic's status", unit: RETRO_UNIT, changes: [sprint(S0, S0.replace("epic-2: in-progress", "epic-2: done"))], refused: [[key("development_status.epic-2"), "status-key"]] },
  { name: "status-key: a retro adds a key", unit: RETRO_UNIT, changes: [sprint(S0, withKeys("epic-3: backlog"))], refused: [[key("development_status.epic-3"), "status-key"]] },
  { name: "status-key: a retro changes another top-level value", unit: RETRO_UNIT, changes: [sprint(S0, S0.replace("project: xarabot", "project: other"))], refused: [[key("project"), "status-key"]] },
  { name: "status-key: a retro appends another Epic's action item", unit: RETRO_UNIT, changes: [sprint(S0, withItems(["epic-2-retro-item-1-y", "2"], ["epic-1-retro-item-2-z", "1"]))], refused: [[key("action_items[2]"), "status-key"]] },
  { name: "status-key: a retro appends an action item with no Epic", unit: RETRO_UNIT, changes: [sprint(S0, withItems(["epic-2-retro-item-1-y", ""]))], refused: [[key("action_items[1]"), "status-key"]] },
  { name: "status-key: a retro appends an action item whose Epic is a string", unit: RETRO_UNIT, changes: [sprint(S0, withItems(["epic-2-retro-item-1-y", '"2"']))], refused: [[key("action_items[1]"), "status-key"]] },
  { name: "status-key: a retro changes an existing action item", unit: RETRO_UNIT, changes: [sprint(S0, S0.replace("    status: open", "    status: done"))], refused: [[key("action_items[0]"), "status-key"]] },
  { name: "status-key: a retro removes an action item", unit: RETRO_UNIT, changes: [sprint(S0, S0.replace(/action_items:\n[\s\S]*$/, "action_items: []\n"))], refused: [[key("action_items[0]"), "status-key"]] },
  { name: "status-key: a retro inserts an action item before the others", unit: RETRO_UNIT, changes: [sprint(S0, S0.replace("action_items:\n", 'action_items:\n  - id: "epic-2-retro-item-1-y"\n    epic: 2\n'))], refused: [[key("action_items[0]"), "status-key"], [key("action_items[1]"), "status-key"]] },
  { name: "status-key: a retro makes action_items a mapping", unit: RETRO_UNIT, changes: [sprint(S0, S0.replace(/action_items:\n[\s\S]*$/, "action_items:\n  a: 1\n"))], refused: [[key("action_items"), "status-key"]] },
  { name: "status-key: a retro of another Epic appends Epic 2's items", unit: { kind: "retro", epic: 3 }, changes: [sprint(S0, withItems(["epic-2-retro-item-1-y", "2"]).replace("epic-2-retrospective: optional", "epic-2-retrospective: done"))], refused: [[key("action_items[1]"), "status-key"], [key("development_status.epic-2-retrospective"), "status-key"]] },
  // Any other session changes no key.
  { name: "status-key: any other session changes no key, last_updated included", unit: ANY_UNIT, changes: [sprint(S0, withKeys("epic-3: backlog").replace("last_updated: 10-22-2026 00:43", "last_updated: 10-25-2026 10:00"))], refused: [[key("development_status.epic-3"), "status-key"], [key("last_updated"), "status-key"]] },
  { name: "any other session: comments and layout change no key", unit: ANY_UNIT, changes: [sprint(S0, `# note\n${S0}`)], refused: [] },
  // story-done: no coordinator session sets a Story done; only reconcile's runner code does.
  { name: "story-done: status planning sets an existing Story done", unit: STATUS_UNIT, changes: [sprint(S0, S0.replace("2-2-takeover: review", "2-2-takeover: done"))], refused: [[key("development_status.2-2-takeover"), "story-done"]] },
  { name: "story-done: status planning adds a Story as done", unit: STATUS_UNIT, changes: [sprint(S0, withKeys("3-1-x: done"))], refused: [[key("development_status.3-1-x"), "story-done"]] },
  { name: "story-done: status planning writes a new file holding a done Story", unit: STATUS_UNIT, changes: [sprint(null, S0)], refused: [[key("development_status.2-1-heartbeat"), "story-done"]] },
  { name: "story-done: a Story done before stays done", unit: STATUS_UNIT, changes: [sprint(S0, `${S0}# a comment\n`)], refused: [] },
  { name: "story-done: a retro sets a Story done", unit: RETRO_UNIT, changes: [sprint(S0, S0.replace("2-2-takeover: review", "2-2-takeover: done"))], refused: [[key("development_status.2-2-takeover"), "story-done"]] },
  { name: "story-done: any other session sets a Story done", unit: ANY_UNIT, changes: [sprint(S0, S0.replace("2-2-takeover: review", "2-2-takeover: done"))], refused: [[key("development_status.2-2-takeover"), "story-done"]] },
  { name: "story-done: an Epic or a retrospective set done is not a Story", unit: RETRO_UNIT, changes: [sprint(S0, S0.replace("epic-2-retrospective: optional", "epic-2-retrospective: done"))], refused: [] },
  { name: "story-done: with another key refused, one refusal each", unit: STATUS_UNIT, changes: [sprint(S0, S0.replace("2-2-takeover: review", "2-2-takeover: done").replace("epic-2: in-progress", "epic-2: done"))], refused: [[key("development_status.2-2-takeover"), "story-done"], [key("development_status.epic-2"), "status-key"]] },
  // status-invalid.
  { name: "status-invalid: a change with no texts", unit: STATUS_UNIT, changes: [{ path: SPRINT, mode: "100644" }], refused: [[SPRINT, "status-invalid"]] },
  { name: "status-invalid: the after side does not parse", unit: STATUS_UNIT, changes: [sprint(S0, "development_status: [\n")], refused: [[SPRINT, "status-invalid"]] },
  { name: "status-invalid: the before side is not a mapping", unit: RETRO_UNIT, changes: [sprint("- a\n", S0)], refused: [[SPRINT, "status-invalid"]] },
  { name: "sprint-status: an earlier class wins", unit: STATUS_UNIT, changes: [{ ...sprint(S0, "x: ["), mode: "100755" }], refused: [[SPRINT, "mode"]] },
  // Full case folding: a variant of sprint-status.yaml is still the file, in a unit whose globs hold it.
  { name: "full fold: story-done", unit: ANY_UNIT, changes: [sprint(S0, S0.replace("2-2-takeover: review", "2-2-takeover: done"), SPRINT_FOLDED)], refused: [[key("development_status.2-2-takeover", SPRINT_FOLDED), "story-done"]] },
  { name: "full fold: status-key", unit: ANY_UNIT, changes: [sprint(S0, withKeys("epic-3: backlog"), SPRINT_FOLDED)], refused: [[key("development_status.epic-3", SPRINT_FOLDED), "status-key"]] },
  { name: "full fold: status-invalid", unit: ANY_UNIT, changes: [{ path: SPRINT_FOLDED, mode: "100644" }], refused: [[SPRINT_FOLDED, "status-invalid"]] },
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

  test("a full fold case refuses with every class", () => {
    for (const cls of COORDINATOR_WRITE_CLASSES) {
      const hit = COORD_CASES.some((c) => c.name.startsWith("full fold:") && c.refused.some(([, x]) => x === cls));
      expect([cls, hit]).toEqual([cls, true]);
    }
  });

  test("graph-and-status needs both: a graph unit holding a status file glob", () => {
    const rules = coordinatorWriteRules({ config: COORD_CONFIG, globs: [EPICS, SPRINT], graphUnit: true });
    const r = (path: string): WriteChange => ({ path, mode: "100644" });
    expect(checkWrite(rules, [r(EPICS)])).toEqual([]);
    expect(checkWrite(rules, [sprint(S0, S0)])).toEqual([]);
    expect(checkWrite(rules, [r(EPICS), sprint(S0, S0)])).toEqual([
      { path: SPRINT, class: "graph-and-status" },
      { path: EPICS, class: "graph-and-status" },
    ]);
  });

  test("coordinatorWriteRules sets no unit: no key of sprint-status.yaml may change", () => {
    const rules = coordinatorWriteRules({ config: COORD_CONFIG, globs: coordinatorGlobs(STATUS_UNIT, COORD_CONFIG), graphUnit: false });
    expect(rules.unit).toBeNull();
    expect(checkWrite(rules, [sprint(S0, withKeys("epic-3: backlog"))])).toEqual([{ path: key("development_status.epic-3"), class: "status-key" }]);
    expect(checkWrite({ ...rules, unit: "planning:status.1" }, [sprint(S0, withKeys("epic-3: backlog"))])).toEqual([]);
  });

  test.each([
    ["planning:status.1", false, { kind: "status-planning" }],
    ["planning:roadmap.2", false, { kind: "status-planning" }],
    ["planning:graph.1", true, { kind: "other" }],
    ["retro:2", false, { kind: "retro", epic: 2 }],
    ["retro:12", false, { kind: "retro", epic: 12 }],
    ["retro:0", false, { kind: "other" }],
    ["retro-item:epic-2-retro-item-1-fix", false, { kind: "other" }],
    ["reconcile:3", false, { kind: "other" }],
    ["story:2.3", false, { kind: "other" }],
    [null, false, { kind: "other" }],
  ] as const)("statusSession(%p, graph %p)", (unit, graph, want) => {
    expect(statusSession(unit, graph)).toEqual(want as StatusSession);
  });

  test("sprintStatusRefusals names each key it refuses, or none for the whole file", () => {
    expect(sprintStatusRefusals({ kind: "status-planning" }, SPRINT, { before: S0, after: S0.replace("2-2-takeover: review", "2-2-takeover: done") })).toEqual([
      { key: "development_status.2-2-takeover", class: "story-done" },
    ]);
    expect(sprintStatusRefusals({ kind: "retro", epic: 2 }, SPRINT, undefined)).toEqual([{ key: null, class: "status-invalid" }]);
  });

  test("coordinatorWriteRules takes the graph inputs and status files from the config", () => {
    expect(coordinatorWriteRules({ config: COORD_CONFIG, globs: coordinatorGlobs(STATUS_UNIT, COORD_CONFIG), graphUnit: false })).toEqual({
      role: "coordinator",
      globs: [SPRINT, RETRO, "_bmad-output/implementation-artifacts/epic-*-context.md"],
      graphUnit: false,
      graphInputs: [EPICS, ".xarabot/epics.yaml", "stories/*.md"],
      statusFiles: [SPRINT, RETRO],
      retroGatesPath: RETRO,
      sprintStatusPath: SPRINT,
      unit: null,
      refused: null,
    });
  });
});

describe("checkWrite (coordinator): the unit's globs are matched exactly, never case-folded", () => {
  /** A path a glob matches: each `**` as `a`, each other `*` as `2`. */
  const sample = (glob: string) => glob.replaceAll("**", "a").replaceAll("*", "2");
  /** Case variants of `path`: all upper case, its first lower-case letter upper-cased, and its first `s` as `ſ`. */
  const variants = (path: string): string[] => {
    const i = path.search(/[a-z]/);
    const out = [path.toUpperCase(), `${path.slice(0, i)}${(path[i] as string).toUpperCase()}${path.slice(i + 1)}`];
    if (path.includes("s")) out.push(path.replace("s", "ſ"));
    return out;
  };
  const SPECS: readonly CoordinatorUnitSpec[] = [STATUS_UNIT, GRAPH_UNIT, RETRO_UNIT, { kind: "retro-item", globs: ["src/x/**", "docs/notes.md"] }];
  const unitCases = SPECS.flatMap((spec) =>
    coordinatorGlobs(spec, COORD_CONFIG)
      .filter((g) => g !== GRAPH_PSEUDO_GLOB)
      .flatMap((g) => variants(sample(g)).map((v) => [unitOf(spec), g, v, spec] as const)),
  );

  test.each(unitCases)("%s: a case variant of %s (%s) is refused", (_unit, glob, variant, spec) => {
    const rules = coordRules(spec);
    const own = sample(glob);
    const change = (path: string): WriteChange => (path === SPRINT ? sprint(S0, S0) : path === RETRO ? gates(EMPTY_GATES, EMPTY_GATES) : { path, mode: "100644" });
    expect(checkWrite(rules, [change(own)])).toEqual([]);
    const cls = variant.toLowerCase().startsWith(".xarabot/") ? "xarabot" : "outside-unit";
    expect(checkWrite(rules, [{ path: variant, mode: "100644" }])).toEqual([{ path: variant, class: cls }]);
  });

  test("every coordinator unit kind with globs has a case variant row", () => {
    expect(new Set(unitCases.map(([, , , spec]) => spec.kind))).toEqual(new Set(["planning", "retro", "retro-item"]));
  });
});

describe("checkWrite (a retro item: coordinator rules plus every builder refusal, Story 2.10)", () => {
  const BUILDER_REFUSALS = {
    config: { ...COORD_CONFIG, standing_authority_path: AUTHORITY },
    policy: { protected_paths: ["secrets/**", "**/*.pem"] },
  };
  const itemRules = (globs: readonly string[]): CoordinatorWriteRules => ({
    ...coordinatorWriteRules({ config: COORD_CONFIG, globs: coordinatorGlobs({ kind: "retro-item", globs }, COORD_CONFIG), graphUnit: false, builderRefusals: BUILDER_REFUSALS }),
    unit: "retro-item:epic-2-retro-item-1-fix",
  });
  const ALL = ["**"];

  test.each([
    ["its own globs pass", ["src/x/**"], ["src/x/a.ts"], []],
    ["a path outside the globs: outside-unit", ["src/x/**"], ["src/y.ts"], [["src/y.ts", "outside-unit"]]],
    ["agent config inside a broad glob: agent-config", ["src/**"], ["src/CLAUDE.md"], [["src/CLAUDE.md", "agent-config"]]],
    ["agent config, case-folded", ["src/**"], ["src/claude.MD"], [["src/claude.MD", "agent-config"]]],
    ["an agent config folder: agent-config", ["src/**"], ["src/.claude/settings.json"], [["src/.claude/settings.json", "agent-config"]]],
    ["a status file: coordinator-file", ALL, [sprint(S0, `# a comment\n${S0}`)], [[SPRINT, "coordinator-file"]]],
    ["coordinator classes win: a sprint-status key change is status-key, not coordinator-file", ALL, [sprint(S0, withKeys("epic-3: backlog"))], [[key("development_status.epic-3"), "status-key"]]],
    ["coordinator classes win: a sprint-status change with no texts is status-invalid", ALL, [{ path: SPRINT, mode: "100644" }], [[SPRINT, "status-invalid"]]],
    ["a live evidence file: live-evidence", ALL, ["docs/maintainer/evidence/epic-2.md"], [["docs/maintainer/evidence/epic-2.md", "live-evidence"]]],
    ["a live evidence file, full fold: live-evidence", ALL, ["Docſ/Maintainer/Evidence/EPIC-2.MD"], [["Docſ/Maintainer/Evidence/EPIC-2.MD", "live-evidence"]]],
    ["the Standing Authority: standing-authority", ALL, [AUTHORITY], [[AUTHORITY, "standing-authority"]]],
    ["the Standing Authority, case-folded", ALL, [AUTHORITY.toUpperCase()], [[AUTHORITY.toUpperCase(), "standing-authority"]]],
    ["under .github: github", ALL, [".github/workflows/ci.yml"], [[".github/workflows/ci.yml", "github"]]],
    ["a policy Protected Path: protected-path", ALL, ["secrets/key.txt", "src/a.pem"], [["secrets/key.txt", "protected-path"], ["src/a.pem", "protected-path"]]],
    ["coordinator classes win: xarabot before the builder's xarabot", ALL, [".xarabot/policy.yaml"], [[".xarabot/policy.yaml", "xarabot"]]],
    ["coordinator classes win: a manifest is graph-input", ALL, ["stories/2.1.md"], [["stories/2.1.md", "graph-input"]]],
    ["coordinator classes win: outside-unit before agent-config", ["src/**"], ["AGENTS.md"], [["AGENTS.md", "outside-unit"]]],
    ["coordinator classes win: a retro record change, not coordinator-file", ALL, [gates(GATES_2, GATES_2.replace("status: open", "status: done"))], [[RETRO, "retro-item"]]],
    ["a retro-gates change touching no record: coordinator-file", ALL, [gates(GATES_2, `${GATES_2}# a comment\n`)], [[RETRO, "coordinator-file"]]],
  ] as const)("%s", (_name, globs, changes, refused) => {
    const got = checkWrite(itemRules(globs), changes.map((x) => (typeof x === "string" ? { path: x, mode: "100644" } : x)));
    const want = refused.map(([path, cls]) => ({ path, class: cls }));
    expect(got).toEqual([...want].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
  });

  test("every builder class the coordinator classes do not catch first is refused, with no exception", () => {
    const paths = ["docs/maintainer/evidence/epic-1.md", AUTHORITY, ".github/x", "a/AGENTS.md", "secrets/x"];
    const hit = new Set(checkWrite(itemRules(ALL), [sprint(S0, S0), ...paths.map((path) => ({ path, mode: "100644" }))]).map((r) => r.class));
    expect([...hit].sort()).toEqual(["agent-config", "coordinator-file", "github", "live-evidence", "protected-path", "standing-authority"]);
  });

  test("builderRefusals sets refused; without it, refused is null", () => {
    expect(itemRules(["src/**"]).refused).toEqual({
      coordinatorFiles: [SPRINT, RETRO, EPICS],
      manifestsDir: "stories",
      standingAuthorityPath: AUTHORITY,
      protectedPaths: ["secrets/**", "**/*.pem"],
      liveEvidenceGlob: "docs/maintainer/evidence/epic-*.md",
    });
    expect(coordRules({ kind: "retro-item", globs: ["src/**"] }).refused).toBeNull();
    expect(checkWrite(coordRules({ kind: "retro-item", globs: ["src/**"] }), [{ path: "src/CLAUDE.md", mode: "100644" }])).toEqual([]);
  });
});

describe("symlinks (Epic 2 retro item 18): a target that leaves the clone or resolves into a refused class", () => {
  /** A symlink at `path` to `target`; `undefined` gives no target. */
  const link = (path: string, target: string | undefined): WriteChange => (target === undefined ? { path, mode: "120000" } : { path, mode: "120000", linkTarget: target });
  const sym = (path: string): WriteRefusal => ({ path, class: "symlink" });

  test("the content classes", () => {
    expect([...CONTENT_WRITE_CLASSES]).toEqual(["symlink", "credential"]);
  });

  test.each([
    ["a sibling", "src/l", "a.ts", "src/a.ts"],
    ["a parent's file", "src/x/l", "../a.ts", "src/a.ts"],
    ["up to the root, then down", "src/x/l", "../../docs/a.md", "docs/a.md"],
    ["./ and empty components", "src/l", ".//x/./a.ts", "src/x/a.ts"],
    ["a trailing slash", "src/l", "x/", "src/x"],
    ["absolute", "src/l", "/etc/passwd", null],
    ["home, as a shell expands it", "src/l", "~/.claude", null],
    ["home of another user", "l", "~root", null],
    ["out of the clone", "src/l", "../../runner.git/hooks", null],
    ["out of the clone from the root", "l", "../x", null],
    ["out and back in", "src/l", "../../clone/src/a.ts", null],
    ["the repo root", "src/l", "..", null],
    ["the repo root as .", "l", ".", null],
    ["a .. after a name", "src/l", "x/../a.ts", null],
    ["a .. after a name that stays inside textually", "src/x/l", "y/../../a.ts", null],
    ["the clone's .git", "src/l", "../.git/hooks", null],
    ["a nested .git, case-folded", "src/l", "sub/.GIT", null],
    ["an empty target", "src/l", "", null],
  ] as const)("symlinkTarget: %s", (_name, path, target, want) => {
    expect(symlinkTarget(path, target)).toBe(want);
  });

  test.each([
    ["an inside target in no refused class passes", [link("src/l", "a.ts"), link("docs/l", "../src")], []],
    ["an absolute target", [link("src/l", "/etc/passwd")], [sym("src/l")]],
    ["~/.claude", [link("src/l", "~/.claude")], [sym("src/l")]],
    ["../runner.git/hooks", [link("hooks", "../runner.git/hooks")], [sym("hooks")]],
    ["the repo root", [link("src/all", "..")], [sym("src/all")]],
    ["into .git", [link("src/h", "../.git/hooks")], [sym("src/h")]],
    ["a .. after a name", [link("src/x/l", "y/../../a.ts")], [sym("src/x/l")]],
    ["no target given", [link("src/l", undefined)], [sym("src/l")]],
    ["an empty target", [link("src/l", "")], [sym("src/l")]],
    ["into .github", [link("docs/wf", "../.github/workflows")], [sym("docs/wf")]],
    ["into agent config, case-folded", [link("docs/s", "../.Claude/settings.json"), link("docs/a", "../AGENTS.md")], [sym("docs/a"), sym("docs/s")]],
    ["to an agent config folder", [link("docs/c", "../pkg/.codex")], [sym("docs/c")]],
    ["to a coordinator file", [link("docs/s", `../${SPRINT}`)], [sym("docs/s")]],
    ["to a manifest", [link("docs/m", "../stories/1.1.md")], [sym("docs/m")]],
    ["to .xarabot", [link("docs/x", "../.xarabot")], [sym("docs/x")]],
    ["to the Standing Authority", [link("src/sa", `../${AUTHORITY}`)], [sym("src/sa")]],
    ["to a live evidence file", [link("src/e", "../docs/maintainer/evidence/epic-2.md")], [sym("src/e")]],
    ["to a protected folder (<dir>/** matched with /x)", [link("src/k", "../secrets")], [sym("src/k")]],
    ["to a protected file", [link("src/k", "../secrets/key")], [sym("src/k")]],
    ["to the own manifest", [link("src/m", `../${STORY}`)], [sym("src/m")]],
    ["the path's own class wins: a .claude symlink is agent-config", [link(".claude", "src")], [no(".claude", "agent-config")]],
    ["a deleted symlink is not checked", [{ path: "src/l", mode: "000000" }], []],
    ["a regular file is not checked", [{ path: "src/l", mode: "100644" }], []],
  ] as const)("builder: %s", (_name, changes, refused) => {
    expect(checkWrite(RULES, changes)).toEqual([...refused]);
  });

  test("builder: an excepted path is still checked as a symlink, and no exception covers a target", () => {
    expect(checkWrite(RULES, [link(SPEC, "/etc/passwd")])).toEqual([sym(SPEC)]);
    expect(checkWrite(RULES, [link(SPEC, "x.md")])).toEqual([]);
    const infra = { ...RULES, infrastructureApproved: true };
    expect(checkWrite(infra, [link(".github/l", "/etc")])).toEqual([sym(".github/l")]);
    expect(checkWrite(infra, [link(".github/l", "../src/a.ts")])).toEqual([]);
    expect(checkWrite(infra, [link(".github/l", "workflows")])).toEqual([sym(".github/l")]);
    expect(checkWrite(infra, [link("src/l", "../.github/workflows"), link("src/k", "../secrets")])).toEqual([sym("src/k"), sym("src/l")]);
  });

  const BUILDER_REFUSALS = { config: { ...COORD_CONFIG, standing_authority_path: AUTHORITY }, policy: { protected_paths: ["secrets/**"] } };
  const item = (globs: readonly string[], refusals = true): CoordinatorWriteRules => ({
    ...coordinatorWriteRules({
      config: COORD_CONFIG,
      globs: coordinatorGlobs({ kind: "retro-item", globs }, COORD_CONFIG),
      graphUnit: false,
      ...(refusals ? { builderRefusals: BUILDER_REFUSALS } : {}),
    }),
    unit: "retro-item:epic-2-retro-item-1-fix",
  });

  test.each([
    ["a target inside the unit's globs passes", item(["src/**"]), [link("src/l", "a.ts")], []],
    ["an absolute target", item(["src/**"]), [link("src/l", "/Users/x/.claude")], [sym("src/l")]],
    ["out of the clone", item(["src/**"]), [link("src/l", "../../runner.git/hooks")], [sym("src/l")]],
    ["a target outside the unit's globs", item(["src/**"]), [link("src/l", "../docs/a.md")], [sym("src/l")]],
    ["a target in another case than the unit's globs", item(["src/**"]), [link("src/l", "../SRC/a.ts")], [sym("src/l")]],
    ["a target under .xarabot", item(["**"]), [link("src/l", "../.xarabot/policy.yaml")], [sym("src/l")]],
    ["a target that is a graph input", item(["**"]), [link("src/l", "../stories/2.1.md")], [sym("src/l")]],
    ["a target a builder is refused (a retro item)", item(["**"]), [link("src/l", "CLAUDE.md"), link("src/k", "../secrets")], [sym("src/k"), sym("src/l")]],
    ["without builder refusals, only the coordinator classes", item(["**"], false), [link("src/l", "CLAUDE.md")], []],
    ["no target given", item(["src/**"]), [link("src/l", undefined)], [sym("src/l")]],
    ["the path's own class wins", item(["src/**"]), [link("docs/l", "/etc")], [{ path: "docs/l", class: "outside-unit" }]],
  ] as const)("coordinator: %s", (_name, rules, changes, refused) => {
    expect(checkWrite(rules, changes)).toEqual([...refused]);
  });

  test("coordinator: a status unit's Epic context as a symlink", () => {
    const rules = coordRules(STATUS_UNIT);
    expect(checkWrite(rules, [link(CONTEXT_2, "sprint-status.yaml")])).toEqual([]);
    expect(checkWrite(rules, [link(CONTEXT_2, "../../.xarabot/config.yaml")])).toEqual([sym(CONTEXT_2)]);
    expect(checkWrite(rules, [link(CONTEXT_2, "/etc/passwd")])).toEqual([sym(CONTEXT_2)]);
  });
});

describe("credentials (Epic 2 retro item 20): an added or changed blob holding a credential", () => {
  /** A regular file whose new blob holds a credential, as the committer marks it. */
  const held = (path: string, extra: Partial<WriteChange> = {}): WriteChange => ({ path, mode: "100644", credential: true, ...extra });
  const cred = (path: string): WriteRefusal => ({ path, class: "credential" });

  test.each([
    ["a source file", [held("src/a.ts")], [cred("src/a.ts")]],
    ["an executable", [held("bin/x", { mode: "100755" })], [cred("bin/x")]],
    ["a symlink whose target text holds one", [held("src/l", { mode: "120000", linkTarget: "a.ts" })], [cred("src/l")]],
    ["several, in path order", [held("src/b.ts"), { path: "src/c.ts", mode: "100644" }, held("docs/a.md")], [cred("docs/a.md"), cred("src/b.ts")]],
    ["no credential marked", [{ path: "src/a.ts", mode: "100644" }], []],
    ["marked false", [held("src/a.ts", { credential: false })], []],
    ["the own spec file is still checked", [held(SPEC)], [cred(SPEC)]],
    ["the own manifest's status-only change is still checked", [held(STORY, { storyFile: { before: M0, after: withStatus("done") } })], [cred(STORY)]],
    ["the path's own class wins", [held(".claude/settings.json"), held(SPRINT)], [no(".claude/settings.json", "agent-config"), no(SPRINT, "coordinator-file")]],
    ["a refused symlink is symlink", [held("src/l", { mode: "120000", linkTarget: "/etc/passwd" })], [{ path: "src/l", class: "symlink" }]],
  ] as const)("builder: %s", (_name, changes, refused) => {
    expect(checkWrite(RULES, changes)).toEqual([...refused]);
  });

  test("builder: an approved Infrastructure Story's Protected Paths are still checked", () => {
    const infra = { ...RULES, infrastructureApproved: true };
    expect(checkWrite(infra, [held(".github/workflows/ci.yml"), held("secrets/key"), { path: "CLAUDE.md", mode: "100644" }])).toEqual([
      cred(".github/workflows/ci.yml"),
      cred("secrets/key"),
    ]);
  });

  test("a refusal names the path and the class only, never what matched", () => {
    const [refusal] = checkWrite(RULES, [held("src/a.ts")]);
    expect(Object.keys(refusal ?? {}).sort()).toEqual(["class", "path"]);
  });

  test.each([
    ["a path inside the unit's globs", coordRules(ANY_UNIT), [held("src/a.ts")], [cred("src/a.ts")]],
    ["the path's own class wins", coordRules({ kind: "retro-item", globs: ["src/**"] }), [held("docs/a.md")], [{ path: "docs/a.md", class: "outside-unit" }]],
    ["a status unit's Epic context", coordRules(STATUS_UNIT), [held(CONTEXT_2)], [cred(CONTEXT_2)]],
    ["a status unit's allowed sprint status change", coordRules(STATUS_UNIT), [{ ...sprint(S0, withKeys("2-3-write-check: backlog")), credential: true }], [cred(SPRINT)]],
    [
      "a sprint status change already refused by key is reported by key",
      coordRules(STATUS_UNIT),
      [{ ...sprint(S0, S0.replace("2-2-takeover: review", "2-2-takeover: in-progress")), credential: true }],
      [{ path: key("development_status.2-2-takeover"), class: "status-key" }],
    ],
    ["no credential marked", coordRules(ANY_UNIT), [{ path: "src/a.ts", mode: "100644" }], []],
  ] as const)("coordinator: %s", (_name, rules, changes, refused) => {
    expect(checkWrite(rules, changes)).toEqual([...refused]);
  });

  test("coordinator: a retro item's builder refusal wins over a credential", () => {
    const rules = {
      ...coordinatorWriteRules({
        config: COORD_CONFIG,
        globs: coordinatorGlobs({ kind: "retro-item", globs: ["**"] }, COORD_CONFIG),
        graphUnit: false,
        builderRefusals: { config: { ...COORD_CONFIG, standing_authority_path: AUTHORITY }, policy: { protected_paths: [] } },
      }),
      unit: "retro-item:epic-2-retro-item-1-fix",
    };
    expect(checkWrite(rules, [held("src/CLAUDE.md"), held("src/a.ts")])).toEqual([no("src/CLAUDE.md", "agent-config"), cred("src/a.ts")]);
  });
});

describe("NFD before folding (coordinator)", () => {
  test("a decomposed path to a composed sprint status is still the file: its keys are checked", () => {
    const composed = "état/sprint-status.yaml";
    const decomposed = "état/sprint-status.yaml";
    const config = { ...COORD_CONFIG, sprint_status_path: composed };
    const rules = { ...coordinatorWriteRules({ config, globs: ["**"], graphUnit: false }), unit: "planning:status.1" };
    expect(checkWrite(rules, [sprint(S0, S0.replace("2-2-takeover: review", "2-2-takeover: done"), decomposed)])).toEqual([
      { path: key("development_status.2-2-takeover", decomposed), class: "story-done" },
    ]);
    expect(checkWrite(rules, [{ path: decomposed, mode: "100644" }])).toEqual([{ path: decomposed, class: "status-invalid" }]);
  });
});
