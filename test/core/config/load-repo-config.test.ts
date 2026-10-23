import { describe, expect, test } from "bun:test";
import {
  CONFIG_PATH,
  type ConfigStopKind,
  EPICS_YAML_PATH,
  HUMAN_LIVE_STEPS_PATH,
  loadRepoConfig,
  POLICY_PATH,
  type RepoSnapshot,
} from "../../../src/core/config/load-repo-config.ts";
import { MANDATORY_PROTECTED_PATHS } from "../../../src/core/config/protected-paths.ts";
import { CONFIG_DEFAULTS } from "../../../src/core/schemas/config.ts";

const AUTHORITY_PATH = "docs/standing-authority.md";

const CONFIG = `schema_version: 1
runner_version: "0.1.0"
maintainer: edanisko
standing_authority_path: ${AUTHORITY_PATH}
`;
const POLICY = "schema_version: 1\n";
const STEPS = "schema_version: 1\nsteps: []\n";

function authority(fields: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    schema_version: "1",
    granted_by: "edanisko",
    granted_at: "2026-10-01",
    repo: "xaravel/xarabot",
    ...fields,
  };
  const lines = Object.entries(base)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\nThe Maintainer grants lanes standing authority.\n`;
}

/** A valid snapshot; `files` overrides contents, a `null` value removes the file from tree and files. */
function snapshot(files: Record<string, string | null> = {}, extra: Partial<RepoSnapshot> = {}): RepoSnapshot {
  const all: Record<string, string | null> = {
    [CONFIG_PATH]: CONFIG,
    [POLICY_PATH]: POLICY,
    [HUMAN_LIVE_STEPS_PATH]: STEPS,
    [AUTHORITY_PATH]: authority(),
    ...files,
  };
  const present = Object.entries(all).filter((e): e is [string, string] => e[1] !== null);
  return {
    repo: "xaravel/xarabot",
    now: "2026-10-22T12:00:00Z",
    tree: ["README.md", ...present.map(([p]) => p)],
    files: Object.fromEntries(present),
    ...extra,
  };
}

describe("loadRepoConfig: valid snapshots", () => {
  test("minimal files load, with defaults filled and no epics.yaml", () => {
    const r = loadRepoConfig(snapshot());
    if (!r.ok) throw new Error(r.error.message);
    const { config, policy, humanLiveSteps, standingAuthority, epicsYaml } = r.value.repo;
    expect(config).toEqual({
      schema_version: 1,
      runner_version: "0.1.0",
      maintainer: "edanisko",
      standing_authority_path: AUTHORITY_PATH,
      epics_path: "_bmad-output/planning-artifacts/epics.md",
      sprint_status_path: "_bmad-output/implementation-artifacts/sprint-status.yaml",
      retro_gates_path: "_bmad-output/implementation-artifacts/retro-gates.yaml",
      retro_doc_glob: "_bmad-output/implementation-artifacts/epic-<N>-retro-*.md",
      epic_context_path: "_bmad-output/implementation-artifacts/epic-<N>-context.md",
      bootstrapped_epics: [],
      digest_time: "08:00",
      story_spec_path: "_bmad-output/implementation-artifacts/spec-<epic>-<story>-*.md",
      branches: { story: "story/", xarabot: "xarabot/" },
      unit_budget_hours: 6,
      ci_max_wait_minutes: 60,
      proxy_hosts: [],
    });
    expect(policy).toEqual({
      schema_version: 1,
      unattended_adapters: [],
      expected_checks: [],
      protected_paths: [],
      owner_approval_paths: [],
      effective_protected_paths: [".xarabot/**", AUTHORITY_PATH, ...MANDATORY_PROTECTED_PATHS.slice(1)],
    });
    expect(humanLiveSteps).toEqual({ schema_version: 1, steps: [] });
    expect(standingAuthority.frontmatter).toEqual({
      schema_version: 1,
      granted_by: "edanisko",
      granted_at: "2026-10-01",
      repo: "xaravel/xarabot",
    });
    expect(standingAuthority.body).toContain("standing authority");
    expect(epicsYaml).toBeNull();
    expect(r.value.package).toEqual({ defaults: CONFIG_DEFAULTS, mandatoryProtectedPaths: MANDATORY_PROTECTED_PATHS });
  });

  test("a full config and policy parse", () => {
    const config = `${CONFIG}bootstrapped_epics: [1, 2]
digest_time: "17:30"
manifests:
  dir: .xarabot/stories
  path_key: area
  path_map:
    web: ["apps/web/**"]
story_spec_path: specs/<epic>/<story>.md
branches: { story: "s/" }
unit_budget_hours: 2.5
ci_max_wait_minutes: 30
proxy_hosts: [pypi.org]
lockfile_command: [bun, install]
epic_packages:
  "3": ["@xaravel/web"]
`;
    const policy = `schema_version: 1
unattended_adapters: [claude, pi]
expected_checks: [ci]
protected_paths: ["src/**", ".github/**"]
owner_approval_paths: ["**"]
`;
    const steps = "schema_version: 1\nsteps:\n  - {id: login, text: Log in to the console}\n";
    const r = loadRepoConfig(snapshot({ [CONFIG_PATH]: config, [POLICY_PATH]: policy, [HUMAN_LIVE_STEPS_PATH]: steps }));
    if (!r.ok) throw new Error(r.error.message);
    const { config: c, policy: p, humanLiveSteps } = r.value.repo;
    expect(c.bootstrapped_epics).toEqual([1, 2]);
    expect(c.digest_time).toBe("17:30");
    expect(c.manifests).toEqual({ dir: ".xarabot/stories", path_key: "area", path_map: { web: ["apps/web/**"] } });
    expect(c.branches).toEqual({ story: "s/", xarabot: "xarabot/" });
    expect(c.unit_budget_hours).toBe(2.5);
    expect(c.proxy_hosts).toEqual(["pypi.org"]);
    expect(c.lockfile_command).toEqual(["bun", "install"]);
    expect(c.epic_packages).toEqual({ "3": ["@xaravel/web"] });
    expect(p.unattended_adapters).toEqual(["claude", "pi"]);
    expect(p.effective_protected_paths).toEqual([
      ".xarabot/**",
      AUTHORITY_PATH,
      ...MANDATORY_PROTECTED_PATHS.slice(1),
      "src/**",
    ]);
    expect(humanLiveSteps.steps).toEqual([{ id: "login", text: "Log in to the console" }]);
  });

  test("epics.yaml present is passed through raw", () => {
    const raw = "schema_version: 1\nepics: whatever-story-1.4-parses\n";
    const r = loadRepoConfig(snapshot({ [EPICS_YAML_PATH]: raw }));
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.repo.epicsYaml).toBe(raw);
  });

  const okCases: readonly { name: string; files: Record<string, string>; extra?: Partial<RepoSnapshot> }[] = [
    { name: "expires today (date-only) is valid all day", files: { [AUTHORITY_PATH]: authority({ expires: "2026-10-22" }) } },
    { name: "expires in the future (date-time)", files: { [AUTHORITY_PATH]: authority({ expires: "2026-10-22T12:00:01Z" }) } },
    { name: "granted_by differs only in case", files: { [AUTHORITY_PATH]: authority({ granted_by: "EDanisko" }) } },
    { name: "repo differs only in case", files: { [AUTHORITY_PATH]: authority({ repo: "Xaravel/Xarabot" }) } },
    { name: "granted_at as a date-time", files: { [AUTHORITY_PATH]: authority({ granted_at: "2026-10-01T09:00:00+02:00" }) } },
    { name: "UTF-8 BOM before the authority frontmatter", files: { [AUTHORITY_PATH]: `\uFEFF${authority()}` } },
    { name: "CRLF line endings in the authority", files: { [AUTHORITY_PATH]: authority().replaceAll("\n", "\r\n") } },
  ];
  for (const c of okCases) {
    test(c.name, () => {
      const r = loadRepoConfig(snapshot(c.files, c.extra));
      expect(r.ok ? "ok" : r.error.message).toBe("ok");
    });
  }
});

type StopCase = {
  readonly name: string;
  readonly files?: Record<string, string | null>;
  readonly extra?: Partial<RepoSnapshot>;
  readonly kind: ConfigStopKind;
  readonly path: string;
  readonly reason?: string;
};

const STOP_CASES: readonly StopCase[] = [
  { name: "config missing", files: { [CONFIG_PATH]: null }, kind: "missing", path: CONFIG_PATH, reason: "missing on main" },
  { name: "config invalid YAML", files: { [CONFIG_PATH]: "a: [1" }, kind: "invalid-yaml", path: CONFIG_PATH },
  { name: "config newer version", files: { [CONFIG_PATH]: CONFIG.replace("schema_version: 1", "schema_version: 2") }, kind: "unsupported-version", path: CONFIG_PATH },
  { name: "config version 2 with junk is still unsupported-version", files: { [CONFIG_PATH]: "schema_version: 2\nnew_field: x\n" }, kind: "unsupported-version", path: CONFIG_PATH },
  { name: "config version missing", files: { [CONFIG_PATH]: CONFIG.replace("schema_version: 1\n", "") }, kind: "invalid", path: CONFIG_PATH, reason: "schema_version" },
  { name: "config version a string", files: { [CONFIG_PATH]: CONFIG.replace("schema_version: 1", 'schema_version: "1"') }, kind: "invalid", path: CONFIG_PATH, reason: "schema_version" },
  { name: "config unknown key", files: { [CONFIG_PATH]: `${CONFIG}surprise: true\n` }, kind: "invalid", path: CONFIG_PATH, reason: "surprise" },
  { name: "config runner_version as a number", files: { [CONFIG_PATH]: CONFIG.replace('"0.1.0"', "1.10") }, kind: "invalid", path: CONFIG_PATH, reason: "runner_version" },
  { name: "config missing maintainer", files: { [CONFIG_PATH]: CONFIG.replace("maintainer: edanisko\n", "") }, kind: "invalid", path: CONFIG_PATH, reason: "maintainer" },
  { name: "config empty file", files: { [CONFIG_PATH]: "" }, kind: "invalid", path: CONFIG_PATH, reason: "mapping" },
  { name: "config is a list", files: { [CONFIG_PATH]: "- a\n- b\n" }, kind: "invalid", path: CONFIG_PATH, reason: "mapping" },
  { name: "config bad digest_time", files: { [CONFIG_PATH]: `${CONFIG}digest_time: "24:00"\n` }, kind: "invalid", path: CONFIG_PATH, reason: "digest_time" },
  { name: "config bootstrapped_epics zero", files: { [CONFIG_PATH]: `${CONFIG}bootstrapped_epics: [0]\n` }, kind: "invalid", path: CONFIG_PATH, reason: "bootstrapped_epics" },
  { name: "config story_spec_path without <story>", files: { [CONFIG_PATH]: `${CONFIG}story_spec_path: spec-<epic>.md\n` }, kind: "invalid", path: CONFIG_PATH, reason: "story_spec_path" },
  { name: "config path_key without path_map", files: { [CONFIG_PATH]: `${CONFIG}manifests: {dir: m, path_key: area}\n` }, kind: "invalid", path: CONFIG_PATH, reason: "path_key and path_map" },
  { name: "config empty path_map glob list", files: { [CONFIG_PATH]: `${CONFIG}manifests: {dir: m, path_key: a, path_map: {web: []}}\n` }, kind: "invalid", path: CONFIG_PATH, reason: "path_map" },
  { name: "config unknown branches key", files: { [CONFIG_PATH]: `${CONFIG}branches: {story: s/, other: o/}\n` }, kind: "invalid", path: CONFIG_PATH, reason: "other" },
  { name: "config empty lockfile_command", files: { [CONFIG_PATH]: `${CONFIG}lockfile_command: []\n` }, kind: "invalid", path: CONFIG_PATH, reason: "lockfile_command" },
  { name: "config epic_packages bad key", files: { [CONFIG_PATH]: `${CONFIG}epic_packages: {"01": [a]}\n` }, kind: "invalid", path: CONFIG_PATH, reason: "epic_packages" },
  { name: "config absolute authority path", files: { [CONFIG_PATH]: CONFIG.replace(AUTHORITY_PATH, "/etc/authority.md") }, kind: "invalid", path: CONFIG_PATH, reason: "standing_authority_path" },
  ...["../outside.md", "docs/./a.md", "docs\\\\a.md", "docs//a.md"].map((p) => ({
    name: `config standing_authority_path ${p}`,
    files: { [CONFIG_PATH]: CONFIG.replace(AUTHORITY_PATH, `"${p}"`) },
    kind: "invalid" as const,
    path: CONFIG_PATH,
    reason: "standing_authority_path",
  })),
  ...[
    ["story_spec_path", "/abs/spec-<epic>-<story>.md"],
    ["story_spec_path", "../spec-<epic>-<story>.md"],
    ["retro_doc_glob", "/abs/epic-<N>-retro.md"],
    ["retro_doc_glob", "docs/../epic-<N>-retro.md"],
    ["retro_doc_glob", "docs/epic-retro.md"],
    ["epic_context_path", "/abs/epic-<N>-context.md"],
    ["epic_context_path", "docs/epic-context.md"],
  ].map(([field, value]) => ({
    name: `config ${field} ${value}`,
    files: { [CONFIG_PATH]: `${CONFIG}${field}: "${value}"\n` },
    kind: "invalid" as const,
    path: CONFIG_PATH,
    reason: field,
  })),
  { name: "config proxy_hosts wildcard", files: { [CONFIG_PATH]: `${CONFIG}proxy_hosts: ["*"]\n` }, kind: "invalid", path: CONFIG_PATH, reason: "proxy_hosts" },
  { name: "config proxy_hosts URL", files: { [CONFIG_PATH]: `${CONFIG}proxy_hosts: ["https://pypi.org"]\n` }, kind: "invalid", path: CONFIG_PATH, reason: "proxy_hosts" },
  ...["github.com", "api.github.com", "objects.githubusercontent.com", "ghcr.io", "GitHub.com.", "mygithubmirror.example"].map((host) => ({
    name: `config proxy_hosts GitHub host ${host}`,
    files: { [CONFIG_PATH]: `${CONFIG}proxy_hosts: [pypi.org, "${host}"]\n` },
    kind: "invalid" as const,
    path: CONFIG_PATH,
    reason: "a GitHub host is never allowed",
  })),
  ...["1.2.3.4", "140.82.112.3", "::1", "localhost", "app.localhost"].map((host) => ({
    name: `config proxy_hosts ${host}`,
    files: { [CONFIG_PATH]: `${CONFIG}proxy_hosts: ["${host}"]\n` },
    kind: "invalid" as const,
    path: CONFIG_PATH,
    reason: "proxy_hosts",
  })),
  { name: "config unit_budget_hours zero", files: { [CONFIG_PATH]: `${CONFIG}unit_budget_hours: 0\n` }, kind: "invalid", path: CONFIG_PATH, reason: "unit_budget_hours" },
  { name: "config ci_max_wait_minutes fractional", files: { [CONFIG_PATH]: `${CONFIG}ci_max_wait_minutes: 1.5\n` }, kind: "invalid", path: CONFIG_PATH, reason: "ci_max_wait_minutes" },
  { name: "config empty story branch prefix", files: { [CONFIG_PATH]: `${CONFIG}branches: {story: ""}\n` }, kind: "invalid", path: CONFIG_PATH, reason: "branches.story" },
  { name: "config listed but unread", extra: { files: {} }, kind: "unreadable", path: CONFIG_PATH },
  { name: "policy missing", files: { [POLICY_PATH]: null }, kind: "missing", path: POLICY_PATH, reason: "missing on main" },
  { name: "policy unknown adapter", files: { [POLICY_PATH]: "schema_version: 1\nunattended_adapters: [gpt]\n" }, kind: "invalid", path: POLICY_PATH, reason: "unattended_adapters" },
  { name: "policy negated protected path", files: { [POLICY_PATH]: 'schema_version: 1\nprotected_paths: ["!.github/**"]\n' }, kind: "invalid", path: POLICY_PATH, reason: "protected_paths" },
  { name: "policy negated owner approval path", files: { [POLICY_PATH]: 'schema_version: 1\nowner_approval_paths: ["!src/**"]\n' }, kind: "invalid", path: POLICY_PATH, reason: "owner_approval_paths" },
  { name: "policy empty expected check", files: { [POLICY_PATH]: 'schema_version: 1\nexpected_checks: [""]\n' }, kind: "invalid", path: POLICY_PATH, reason: "expected_checks" },
  { name: "policy newer version", files: { [POLICY_PATH]: "schema_version: 3\n" }, kind: "unsupported-version", path: POLICY_PATH },
  { name: "human-live-steps missing", files: { [HUMAN_LIVE_STEPS_PATH]: null }, kind: "missing", path: HUMAN_LIVE_STEPS_PATH },
  { name: "human-live-steps duplicate ids", files: { [HUMAN_LIVE_STEPS_PATH]: "schema_version: 1\nsteps:\n  - {id: a, text: x}\n  - {id: a, text: y}\n" }, kind: "invalid", path: HUMAN_LIVE_STEPS_PATH, reason: "duplicate" },
  { name: "authority absent", files: { [AUTHORITY_PATH]: null }, kind: "missing", path: AUTHORITY_PATH, reason: "missing on main" },
  {
    name: "authority listed but unread",
    extra: { tree: [CONFIG_PATH, POLICY_PATH, HUMAN_LIVE_STEPS_PATH, AUTHORITY_PATH], files: { [CONFIG_PATH]: CONFIG, [POLICY_PATH]: POLICY, [HUMAN_LIVE_STEPS_PATH]: STEPS } },
    kind: "unreadable",
    path: AUTHORITY_PATH,
  },
  {
    name: "authority path names a prototype member, listed but unread",
    files: { [CONFIG_PATH]: CONFIG.replace(AUTHORITY_PATH, "constructor"), [AUTHORITY_PATH]: null },
    extra: { tree: [CONFIG_PATH, POLICY_PATH, HUMAN_LIVE_STEPS_PATH, "constructor"] },
    kind: "unreadable",
    path: "constructor",
  },
  { name: "authority without frontmatter", files: { [AUTHORITY_PATH]: "# Standing Authority\n\nprose\n" }, kind: "invalid", path: AUTHORITY_PATH, reason: "frontmatter" },
  { name: "authority frontmatter not closed", files: { [AUTHORITY_PATH]: "---\nschema_version: 1\n" }, kind: "invalid", path: AUTHORITY_PATH, reason: "closing" },
  { name: "authority frontmatter invalid YAML", files: { [AUTHORITY_PATH]: "---\na: [1\n---\n" }, kind: "invalid", path: AUTHORITY_PATH },
  { name: "authority bad granted_at", files: { [AUTHORITY_PATH]: authority({ granted_at: "yesterday" }) }, kind: "invalid", path: AUTHORITY_PATH, reason: "granted_at" },
  { name: "authority missing repo", files: { [AUTHORITY_PATH]: authority({ repo: "" }) }, kind: "invalid", path: AUTHORITY_PATH, reason: "repo" },
  { name: "authority unknown key", files: { [AUTHORITY_PATH]: authority({ scope: "all" }) }, kind: "invalid", path: AUTHORITY_PATH, reason: "scope" },
  { name: "authority newer version", files: { [AUTHORITY_PATH]: authority({ schema_version: "2" }) }, kind: "unsupported-version", path: AUTHORITY_PATH },
  { name: "authority granted_by not the maintainer", files: { [AUTHORITY_PATH]: authority({ granted_by: "someone-else" }) }, kind: "authority-granted-by", path: AUTHORITY_PATH, reason: "someone-else" },
  { name: "authority repo not this repo", files: { [AUTHORITY_PATH]: authority({ repo: "xaravel/xaravel" }) }, kind: "authority-repo", path: AUTHORITY_PATH, reason: "xaravel/xaravel" },
  { name: "authority expired yesterday", files: { [AUTHORITY_PATH]: authority({ expires: "2026-10-21" }) }, kind: "authority-expired", path: AUTHORITY_PATH, reason: "2026-10-21" },
  { name: "authority expired at now", files: { [AUTHORITY_PATH]: authority({ expires: "2026-10-22T12:00:00Z" }) }, kind: "authority-expired", path: AUTHORITY_PATH },
  { name: "epics.yaml in tree but unread", extra: { tree: [CONFIG_PATH, POLICY_PATH, HUMAN_LIVE_STEPS_PATH, AUTHORITY_PATH, EPICS_YAML_PATH] }, kind: "unreadable", path: EPICS_YAML_PATH },
  { name: "snapshot now not a date-time", extra: { now: "2026-10-22" }, kind: "invalid-snapshot", path: "snapshot", reason: "now" },
  { name: "snapshot repo not owner/name", extra: { repo: "xarabot" }, kind: "invalid-snapshot", path: "snapshot", reason: "repo" },
];

describe("loadRepoConfig: stop cases", () => {
  for (const c of STOP_CASES) {
    test(c.name, () => {
      const r = loadRepoConfig(snapshot(c.files, c.extra));
      if (r.ok) throw new Error("expected a stop error");
      expect(r.error.kind).toBe(c.kind);
      expect(r.error.message.startsWith(`${c.path}: `)).toBe(true);
      if (c.reason !== undefined) expect(r.error.message).toContain(c.reason);
    });
  }

  test("a GitHub host in proxy_hosts names the field and says it is never allowed", () => {
    const r = loadRepoConfig(snapshot({ [CONFIG_PATH]: `${CONFIG}proxy_hosts: [raw.githubusercontent.com]\n` }));
    if (r.ok) throw new Error("expected a stop error");
    expect(r.error.kind).toBe("invalid");
    expect(r.error.message).toContain("proxy_hosts");
    expect(r.error.message).toContain("raw.githubusercontent.com");
    expect(r.error.message).toContain("a GitHub host is never allowed");
  });

  test("a non-object snapshot is invalid-snapshot, not a throw", () => {
    const r = loadRepoConfig(null as unknown as RepoSnapshot);
    expect(r.ok ? "ok" : r.error.kind).toBe("invalid-snapshot");
  });
});
