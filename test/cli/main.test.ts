import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };

const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");

function run(args: readonly string[], env?: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([process.execPath, MAIN, ...args], { stdout: "pipe", stderr: "pipe", timeout: 10_000, ...(env !== undefined ? { env } : {}) });
  return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("xarabot bin", () => {
  test("package.json points bin.xarabot at main.ts", () => {
    expect(pkg.bin.xarabot).toBe("src/cli/main.ts");
  });

  test.each([[["--version"]], [[]]])("%j prints the package version", (args) => {
    const r = run(args);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${pkg.version}\n`);
    expect(r.stderr).toBe("");
  });

  test.each([[["--nope"]], [["run"]], [["--version", "extra"]], [["graph"]], [["graph", "check", "extra"]], [["join"]]])("%j prints usage and exits 1", (args) => {
    const r = run(args);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("usage: xarabot");
  });

  test.each([
    [["lane", "run", "x/y", "b"], "xarabot lane run: HOME is not set\n"],
    [["lane", "install", "builder-1", "--repo", "x/y", "--role", "builder", "--owner", "alice", "--agent", "claude"], "xarabot lane install: HOME is not set\n"],
    [["rule", "release", "story:2.6"], "xarabot rule: HOME is not set\n"],
    [["rule", "approve", "story:2.6"], "xarabot rule: HOME is not set\n"],
    [["join", "--repo", "x/y", "--login", "alice"], "xarabot join: neither XDG_CONFIG_HOME nor HOME is set\n"],
    // No `gh` on this PATH (nor a GitHub login in the scrubbed environment): the real login lookup fails.
    [["join", "--repo", "x/y"], "xarabot join: cannot read your GitHub login from `gh api user --jq .login`; pass --login <login>\n"],
  ])("%j reaches its subcommand", (args, stderr) => {
    // A scrubbed environment with no HOME, so the subcommand stops before touching anything.
    const r = run(args, { PATH: "/usr/bin:/bin" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(stderr);
  });
});
