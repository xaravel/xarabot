import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const FIXTURE = "./test/fixtures/live-sample.fixture.ts";

function runFixture(live: boolean): { code: number; output: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "XARABOT_LIVE") env[k] = v;
  }
  if (live) env.XARABOT_LIVE = "1";
  const proc = Bun.spawnSync([process.execPath, "test", FIXTURE], {
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  return { code: proc.exitCode ?? -1, output: proc.stdout.toString() + proc.stderr.toString() };
}

describe("live switch", () => {
  test("XARABOT_LIVE unset: the live case is skipped", () => {
    const r = runFixture(false);
    expect(r.code).toBe(0);
    expect(r.output).toMatch(/\b1 skip\b/);
    expect(r.output).toMatch(/\b0 pass\b/);
  });

  test("XARABOT_LIVE=1: the live case passes", () => {
    const r = runFixture(true);
    expect(r.code).toBe(0);
    expect(r.output).toMatch(/\b1 pass\b/);
    expect(r.output).not.toMatch(/\b[1-9]\d* skip\b/);
  });
});
