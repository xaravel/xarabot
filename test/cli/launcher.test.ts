import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderLauncher } from "../../src/core/lane/launchd.ts";

/**
 * Runs the real rendered launcher under `/bin/sh` against a stub
 * `runner/<v>/src/cli/main.ts` that prints its argv and environment.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const STUB = `console.log(JSON.stringify({ argv: Bun.argv.slice(2), sandboxed: process.env.XARABOT_SANDBOXED ?? null, home: process.env.HOME }));\n`;

function world(o: { runner?: string | null; installed?: readonly string[] } = {}) {
  const home = mkdtempSync(join(tmpdir(), "xarabot-launcher-"));
  dirs.push(home);
  const launcher = join(home, ".xarabot", "bin", "xarabot-lane");
  mkdirSync(join(home, ".xarabot", "bin"), { recursive: true });
  writeFileSync(launcher, renderLauncher({ bun: process.execPath }));
  chmodSync(launcher, 0o755);
  const laneDir = join(home, ".xarabot", "repos", "xaravel__xarabot", "lanes", "builder-1");
  mkdirSync(laneDir, { recursive: true });
  const runner = o.runner === undefined ? "v1\n" : o.runner;
  if (runner !== null) writeFileSync(join(laneDir, "runner"), runner);
  for (const v of o.installed ?? ["v1"]) {
    mkdirSync(join(home, ".xarabot", "runner", v, "src", "cli"), { recursive: true });
    writeFileSync(join(home, ".xarabot", "runner", v, "src", "cli", "main.ts"), STUB);
  }
  return { home, launcher };
}

function run(launcher: string, args: readonly string[], env: Record<string, string>) {
  const p = Bun.spawnSync([launcher, ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

describe("the rendered launcher", () => {
  test("runs the runner its lane names with lane run <repo> <lane> and no XARABOT_SANDBOXED", () => {
    const w = world();
    const r = run(w.launcher, ["xaravel/xarabot", "builder-1"], { HOME: w.home, PATH: "/usr/bin:/bin", XARABOT_SANDBOXED: "1" });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ argv: ["lane", "run", "xaravel/xarabot", "builder-1"], sandboxed: null, home: w.home });
  });

  test("a runner file without a trailing newline still works", () => {
    const w = world({ runner: "v1" });
    expect(run(w.launcher, ["xaravel/xarabot", "builder-1"], { HOME: w.home, PATH: "/usr/bin:/bin" }).code).toBe(0);
  });

  test.each([
    ["the runner version is not installed", { runner: "v2\n" }, "not installed"],
    ["no runner file", { runner: null }, "missing"],
    ["an unsafe version", { runner: "../v1\n", installed: ["v1"] }, "is not a runner version"],
    ["an empty runner file", { runner: "" }, "cannot read a version"],
  ] as const)("%s: exits non-zero with the reason on stderr", (_name, o, why) => {
    const w = world(o);
    const r = run(w.launcher, ["xaravel/xarabot", "builder-1"], { HOME: w.home, PATH: "/usr/bin:/bin" });
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(why);
  });

  test.each([
    [[]],
    [["xaravel/xarabot"]],
    [["xaravel/xarabot", "builder-1", "extra"]],
    [["xarabot", "builder-1"]],
    [["xaravel/xarabot/x", "builder-1"]],
    [["-x/xarabot", "builder-1"]],
    [["xaravel/..", "builder-1"]],
    [["xaravel/xarabot", "../builder-1"]],
    [["xaravel/xarabot", "-builder"]],
    [["xa ravel/xarabot", "builder-1"]],
  ])("%j is refused", (args) => {
    const w = world();
    const r = run(w.launcher, args, { HOME: w.home, PATH: "/usr/bin:/bin" });
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toStartWith("xarabot-lane: ");
  });

  test("no HOME is refused", () => {
    const w = world();
    const r = run(w.launcher, ["xaravel/xarabot", "builder-1"], { PATH: "/usr/bin:/bin" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("HOME is not set");
  });
});
