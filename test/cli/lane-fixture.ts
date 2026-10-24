import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { ok } from "../../src/core/result.ts";
import { forgeErr, forgeOk } from "../../src/ports/forge.ts";
import type { Connect, ForgeOpts } from "../../src/cli/lane-connection.ts";
import type { InstallRunner, InstallRunnerParams } from "../../src/lane/runner-install.ts";

/** A temp `HOME` and `XDG_CONFIG_HOME`, a fake connection and a stub runner installer for the lane CLI tests. */

export const HOST_ID = "11111111-1111-4111-8111-111111111111";
export const AUTHORITY = "docs/standing-authority.md";
export const FAKE_TOKEN = "ghs_fake_installation_token";
export const BOT_USER_ID = 4242;

export type MainOpts = {
  readonly runnerVersion?: string;
  readonly unattended?: readonly string[];
  /** Story ids already done; default every Story. */
  readonly done?: boolean;
};

/** A working repo on `main` with one Epic and one Story. */
export function mainFiles(o: MainOpts = {}): Record<string, string> {
  const version = o.runnerVersion ?? "v1";
  const unattended = o.unattended ?? ["claude"];
  return {
    ".xarabot/config.yaml": [
      "schema_version: 1",
      `runner_version: ${JSON.stringify(version)}`,
      "maintainer: edanisko",
      `standing_authority_path: ${AUTHORITY}`,
      "manifests:",
      "  dir: stories",
      "",
    ].join("\n"),
    ".xarabot/policy.yaml": `schema_version: 1\nunattended_adapters: [${unattended.join(", ")}]\n`,
    ".xarabot/human-live-steps.yaml": "schema_version: 1\nsteps: []\n",
    "_bmad-output/planning-artifacts/epics.md": "# Epics\n\n## Epic 1: One\n\n### Story 1.1: Story 1.1\n\nBody.\n",
    "_bmad-output/implementation-artifacts/epic-1-context.md": "# Epic 1 Context: One\n\nGoal.\n",
    "_bmad-output/implementation-artifacts/sprint-status.yaml": `development_status:\n  epic-1: in-progress\n  1-1-first: ${o.done === false ? "backlog" : "done"}\n`,
    [AUTHORITY]: "---\nschema_version: 1\ngranted_by: edanisko\ngranted_at: 2026-10-01\nrepo: xaravel/xarabot\n---\n\nGranted.\n",
    "stories/1.1.md": '---\nstory_id: "1.1"\nepic: 1\nsprint_key: 1-1-first\ntitle: Story 1.1\nglobs: ["src/**"]\n---\n',
  };
}

export type World = {
  readonly root: string;
  readonly home: string;
  readonly xdg: string;
  readonly env: Record<string, string>;
  readonly hostYaml: string;
  readonly xarabot: string;
  readonly runnerRoot: string;
  readonly laneDir: string;
};

export function world(dirs: string[], extraEnv: Record<string, string> = {}): World {
  const root = mkdtempSync(join(tmpdir(), "xarabot-lane-cli-"));
  dirs.push(root);
  const home = join(root, "home");
  const xdg = join(root, "config");
  mkdirSync(home, { recursive: true });
  const xarabot = join(home, ".xarabot");
  return {
    root,
    home,
    xdg,
    env: { HOME: home, XDG_CONFIG_HOME: xdg, PATH: "/usr/bin:/bin", ...extraEnv },
    hostYaml: join(xdg, "xarabot", "host.yaml"),
    xarabot,
    runnerRoot: join(xarabot, "runner"),
    laneDir: join(xarabot, "repos", "xaravel__xarabot", "lanes", "builder-1"),
  };
}

export function cleanup(dirs: string[]): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Writes the claude credential file, mode 600. */
export function writeCredential(w: World): void {
  const dir = join(w.xdg, "xarabot", "vendors", "claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "oauth-token"), "sk-ant-oat-fake\n");
  chmodSync(join(dir, "oauth-token"), 0o600);
}

export type FakeConnectRecord = {
  connects: number;
  tokens: number;
  forgeOpts: ForgeOpts[];
  fetchDirs: string[];
};

/** A connection over the fake forge; `fail` makes connecting fail. */
export function fakeConnect(fake: FakeForge, o: { readonly fail?: string; readonly tokenFails?: boolean; readonly botUserFails?: boolean } = {}): { readonly connect: Connect; readonly record: FakeConnectRecord } {
  const record: FakeConnectRecord = { connects: 0, tokens: 0, forgeOpts: [], fetchDirs: [] };
  const connect: Connect = async () => {
    record.connects += 1;
    if (o.fail !== undefined) return { ok: false, message: o.fail };
    return {
      ok: true,
      connection: {
        forge: (opts) => {
          record.forgeOpts.push(opts);
          return fake.forge;
        },
        token: async () => {
          record.tokens += 1;
          return o.tokenFails === true ? forgeErr("auth", "no token") : forgeOk(FAKE_TOKEN);
        },
        fetchShas: (gitDir) => {
          record.fetchDirs.push(gitDir);
          return async () => ok(undefined);
        },
        botUserId: async () => (o.botUserFails === true ? forgeErr("transient", "no bot user") : forgeOk(BOT_USER_ID)),
      },
    };
  };
  return { connect, record };
}

/** A runner installer that makes `<runnerRoot>/<version>/src/cli/main.ts`, or fails with `fail`. */
export function stubInstaller(o: { readonly fail?: string } = {}): { readonly install: InstallRunner; readonly calls: InstallRunnerParams[] } {
  const calls: InstallRunnerParams[] = [];
  const install: InstallRunner = async (p) => {
    calls.push(p);
    if (o.fail !== undefined) return { ok: false, error: { kind: "fetch", message: o.fail } };
    const dir = join(p.runnerRoot, p.version);
    mkdirSync(join(dir, "src", "cli"), { recursive: true });
    writeFileSync(join(dir, "src", "cli", "main.ts"), "// stub runner\n");
    return { ok: true, value: { installed: true, dir } };
  };
  return { install, calls };
}
