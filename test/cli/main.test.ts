import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };

const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");

function run(args: readonly string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([process.execPath, MAIN, ...args], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
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

  test.each([[["--nope"]], [["run"]], [["--version", "extra"]]])("%j prints usage and exits 1", (args) => {
    const r = run(args);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("usage: xarabot");
  });
});
