import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { loadHostConfig } from "../../src/core/config/load-host-config.ts";
import { renderLauncher, renderPlist } from "../../src/core/lane/launchd.ts";
import { laneInstall, parseInstallArgs, type LaneInstallDeps } from "../../src/cli/lane-install.ts";
import { RUNNER_REPO_URL } from "../../src/cli/lane-connection.ts";
import { cleanup, FAKE_TOKEN, HOST_ID, mainFiles, stubInstaller, world, fakeConnect, type World } from "./lane-fixture.ts";

const dirs: string[] = [];
afterEach(() => cleanup(dirs));

const BUN = "/opt/homebrew/bin/bun";
const ARGS = ["builder-1", "--repo", "xaravel/xarabot", "--role", "builder", "--owner", "alice", "--agent", "claude"];
const LABEL = "com.xarabot.lane.xaravel__xarabot.builder-1";

async function install(w: World, args: readonly string[], o: { main?: Record<string, string>; fail?: string; connectFail?: string } = {}) {
  const fake = createFakeForge({ now: "2026-10-23T10:00:00Z", main: o.main ?? mainFiles({ runnerVersion: "v0.2.0" }) });
  const conn = fakeConnect(fake, o.connectFail !== undefined ? { fail: o.connectFail } : {});
  const installer = stubInstaller(o.fail !== undefined ? { fail: o.fail } : {});
  const out: string[] = [];
  const err: string[] = [];
  const deps: LaneInstallDeps = {
    env: w.env,
    connect: conn.connect,
    installRunner: installer.install,
    bun: BUN,
    user: "lane-user",
    newHostId: () => HOST_ID,
    out: (l) => out.push(l),
    errOut: (l) => err.push(l),
  };
  const code = await laneInstall(args, deps);
  return { code, out, err, calls: installer.calls, record: conn.record };
}

const mode = (path: string) => statSync(path).mode & 0o777;

/** Nothing the install writes after its checks exists. */
function nothingWritten(w: World): void {
  expect(existsSync(w.hostYaml)).toBe(false);
  expect(existsSync(w.laneDir)).toBe(false);
  expect(existsSync(join(w.xarabot, "bin"))).toBe(false);
}

describe("xarabot lane install", () => {
  test("a new host: host.yaml with a UUID and the lane, the runner, runner, the launcher and the plist", async () => {
    const w = world(dirs);
    const r = await install(w, ARGS);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);

    const host = loadHostConfig(readFileSync(w.hostYaml, "utf8"));
    expect(host).toEqual({
      ok: true,
      value: { schema_version: 1, host_id: HOST_ID, lanes: { "builder-1": { repo: "xaravel/xarabot", role: "builder", owner: "alice", agent: "claude", effort: "high" } } },
    });
    expect(mode(w.hostYaml)).toBe(0o600);

    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ runnerRoot: w.runnerRoot, version: "v0.2.0", url: RUNNER_REPO_URL, credential: { url: RUNNER_REPO_URL, token: FAKE_TOKEN } });
    expect(existsSync(join(w.runnerRoot, "v0.2.0", "src", "cli", "main.ts"))).toBe(true);

    expect(mode(w.laneDir)).toBe(0o700);
    expect(existsSync(join(w.laneDir, "runner.git", "HEAD"))).toBe(true);
    expect(readFileSync(join(w.laneDir, "runner"), "utf8")).toBe("v0.2.0\n");

    const launcher = join(w.xarabot, "bin", "xarabot-lane");
    expect(readFileSync(launcher, "utf8")).toBe(renderLauncher({ bun: BUN }));
    expect(readFileSync(launcher, "utf8")).toBe(readFileSync(join(import.meta.dir, "..", "fixtures", "launchd", "xarabot-lane"), "utf8"));
    expect(mode(launcher)).toBe(0o755);

    const plistPath = join(w.laneDir, `${LABEL}.plist`);
    expect(readFileSync(plistPath, "utf8")).toBe(
      renderPlist({ label: LABEL, launcher, repo: "xaravel/xarabot", lane: "builder-1", user: "lane-user", home: w.home, env: w.env, log: join(w.laneDir, "launchd.log") }),
    );
    expect(readFileSync(plistPath, "utf8")).toContain(`<key>XDG_CONFIG_HOME</key>\n    <string>${w.xdg}</string>`);

    expect(r.out.slice(-2)).toEqual([`sudo cp '${plistPath}' /Library/LaunchDaemons/`, `sudo launchctl bootstrap system '/Library/LaunchDaemons/${LABEL}.plist'`]);
  });

  test("XARABOT_SANDBOXED in the install environment never reaches the plist", async () => {
    const w = world(dirs, { XARABOT_SANDBOXED: "1", XARABOT_MAX_BUILDERS: "1" });
    expect((await install(w, ARGS)).code).toBe(0);
    const plist = readFileSync(join(w.laneDir, `${LABEL}.plist`), "utf8");
    expect(plist).not.toContain("XARABOT_SANDBOXED");
    expect(plist).toContain("<key>XARABOT_MAX_BUILDERS</key>");
  });

  test("again: the host_id stays and the lane is replaced", async () => {
    const w = world(dirs);
    const other = "22222222-2222-4222-8222-222222222222";
    mkdirSync(join(w.xdg, "xarabot"), { recursive: true });
    writeFileSync(
      w.hostYaml,
      `schema_version: 1\nhost_id: ${other}\nlanes:\n  builder-1:\n    repo: xaravel/xarabot\n    role: builder\n    owner: alice\n    agent: claude\n  coord:\n    repo: xaravel/xarabot\n    role: coordinator\n    owner: alice\n    agent: claude\n`,
    );
    const r = await install(w, [...ARGS, "--effort", "max", "--model", "claude-opus-5-5"]);
    expect(r.code).toBe(0);
    const host = loadHostConfig(readFileSync(w.hostYaml, "utf8"));
    expect(host.ok && host.value.host_id).toBe(other);
    expect(host.ok && host.value.lanes["builder-1"]).toEqual({ repo: "xaravel/xarabot", role: "builder", owner: "alice", agent: "claude", model: "claude-opus-5-5", effort: "max" });
    expect(host.ok && Object.keys(host.value.lanes).sort()).toEqual(["builder-1", "coord"]);
  });

  const ONE_BUILDER = `schema_version: 1\nhost_id: ${HOST_ID}\nlanes:\n  builder-0:\n    repo: xaravel/xaravel\n    role: builder\n    owner: alice\n    agent: claude\n`;

  test.each([
    ["a second builder over XARABOT_MAX_BUILDERS=1", {}, ONE_BUILDER, "more than XARABOT_MAX_BUILDERS=1"],
    ["an invalid XARABOT_MAX_BUILDERS", { XARABOT_MAX_BUILDERS: "many" }, "schema_version: 1\nlanes: {}\n", "is not a positive integer"],
  ] as const)("%s: refused, nothing written, exit 1", async (_name, env, before, why) => {
    const w = world(dirs, env);
    mkdirSync(join(w.xdg, "xarabot"), { recursive: true });
    writeFileSync(w.hostYaml, before);
    const r = await install(w, ARGS);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain(why);
    expect(r.calls).toEqual([]);
    expect(r.record.connects).toBe(0);
    expect(readFileSync(w.hostYaml, "utf8")).toBe(before);
    expect(existsSync(w.laneDir)).toBe(false);
    expect(existsSync(join(w.xarabot, "bin"))).toBe(false);
  });

  test("a second builder under XARABOT_MAX_BUILDERS=2 installs", async () => {
    const w = world(dirs, { XARABOT_MAX_BUILDERS: "2" });
    mkdirSync(join(w.xdg, "xarabot"), { recursive: true });
    writeFileSync(w.hostYaml, ONE_BUILDER);
    expect((await install(w, ARGS)).code).toBe(0);
  });

  test("an already installed runner is not installed again", async () => {
    const w = world(dirs);
    mkdirSync(join(w.runnerRoot, "v0.2.0"), { recursive: true });
    const r = await install(w, ARGS);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.record.tokens).toBe(0);
  });

  test("a bad runner_version: nothing written, exit 1", async () => {
    const w = world(dirs);
    const r = await install(w, ARGS, { main: mainFiles({ runnerVersion: "../x" }) });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("runner_version");
    expect(r.calls).toEqual([]);
    nothingWritten(w);
  });

  test("a missing tag: no runner, nothing written, exit 1", async () => {
    const w = world(dirs);
    const r = await install(w, ARGS, { fail: "install runner v0.2.0: fetch: couldn't find remote ref refs/tags/v0.2.0" });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("couldn't find remote ref");
    expect(existsSync(join(w.runnerRoot, "v0.2.0"))).toBe(false);
    nothingWritten(w);
  });

  test("no App credentials: nothing written, exit 1", async () => {
    const w = world(dirs);
    const r = await install(w, ARGS, { connectFail: "credentials auth: missing private-key.pem" });
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["xarabot lane install: credentials auth: missing private-key.pem"]);
    nothingWritten(w);
  });

  test("an invalid host.yaml exits 1 and is left as it was", async () => {
    const w = world(dirs);
    mkdirSync(join(w.xdg, "xarabot"), { recursive: true });
    writeFileSync(w.hostYaml, "schema_version: 1\nlanes: [\n");
    const r = await install(w, ARGS);
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
    expect(readFileSync(w.hostYaml, "utf8")).toBe("schema_version: 1\nlanes: [\n");
  });

  test.each([
    [["builder-1"], "usage"],
    [[...ARGS, "--nope", "x"], "usage"],
    [[...ARGS, "--repo"], "usage"],
    [[...ARGS, "--repo", "a/b"], "usage"],
    [[...ARGS, "extra"], "usage"],
    [["-x", ...ARGS.slice(1)], "is not a lane name"],
    [["bad.name", ...ARGS.slice(1)], "is not a lane name"],
    [["builder-1", "--repo", "nope", "--role", "builder", "--owner", "alice", "--agent", "claude"], "repo"],
    [["builder-1", "--repo", "a/b", "--role", "boss", "--owner", "alice", "--agent", "claude"], "role"],
    [["builder-1", "--repo", "a/b", "--role", "builder", "--owner", "alice", "--agent", "gpt"], "agent"],
    [[...ARGS, "--effort", "huge"], "effort"],
    [["coord", "--repo", "xaravel/xarabot", "--role", "coordinator", "--owner", "alice", "--agent", "claude"], "a coordinator lane must be named coordinator"],
    [["builder-1", "--repo", "xaravel/xarabot", "--role", "coordinator", "--owner", "alice", "--agent", "claude"], "a coordinator lane must be named coordinator"],
    [["coordinator", ...ARGS.slice(1)], "the lane name coordinator is only for role coordinator"],
  ])("%j is refused before anything is read or written", async (args, why) => {
    const w = world(dirs);
    const r = await install(w, args);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain(why);
    expect(r.record.connects).toBe(0);
    nothingWritten(w);
  });

  test("a coordinator lane named coordinator installs in lanes/coordinator", async () => {
    const w = world(dirs);
    const r = await install(w, ["coordinator", "--repo", "xaravel/xarabot", "--role", "coordinator", "--owner", "alice", "--agent", "claude"]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    const host = loadHostConfig(readFileSync(w.hostYaml, "utf8"));
    expect(host.ok && host.value.lanes["coordinator"]).toEqual({ repo: "xaravel/xarabot", role: "coordinator", owner: "alice", agent: "claude", effort: "high" });
    expect(existsSync(join(w.xarabot, "repos", "xaravel__xarabot", "lanes", "coordinator", "runner"))).toBe(true);
  });

  test("parseInstallArgs", () => {
    expect(parseInstallArgs(["b", ...ARGS.slice(1), "--model", "m"])).toEqual({
      name: "b",
      flags: { "--repo": "xaravel/xarabot", "--role": "builder", "--owner": "alice", "--agent": "claude", "--model": "m" },
    });
    expect(parseInstallArgs([])).toBeNull();
    expect(parseInstallArgs(["b", "--repo", "a/b"])).toBeNull();
    expect(parseInstallArgs([...ARGS, "--repo", "a/b"])).toBeNull();
    expect(parseInstallArgs([...ARGS, "--model", "--effort", "high"])).toBeNull();
  });
});
