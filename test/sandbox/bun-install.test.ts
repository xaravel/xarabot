import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../../src/core/schemas/config.ts";
import type { LaunchSpec, SandboxProfile } from "../../src/ports/sandbox.ts";
import { createMacSandbox } from "../../src/sandbox/macos.ts";
import { liveSandboxTest } from "../support/sandbox.ts";

/**
 * `bun install --frozen-lockfile` in a real sandboxed session (Story 2.12):
 * a clone of this checkout, laid out like a lane
 * (`<home>/.xarabot/repos/o__r/lanes/l/{clone,runner.git,vendor,tmp}`),
 * with the proxy allowing the clone's own `proxy_hosts`. The command is a
 * repo command (AR19), so it gets no vendor credential. Live: it reaches the
 * npm registry, so it runs only under `XARABOT_LIVE=1`, on macOS, outside a
 * sandboxed session.
 */

const ROOT = join(import.meta.dir, "..", "..");

liveSandboxTest(
  "bun install --frozen-lockfile in a clone of this repo exits 0 through the proxy",
  async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "xarabot-bun-install-")));
    try {
      const lane = join(home, ".xarabot", "repos", "o__r", "lanes", "l");
      for (const d of ["runner.git", "vendor", "tmp"]) mkdirSync(join(lane, d), { recursive: true });
      const clone = join(lane, "clone");
      const cloned = Bun.spawnSync(["git", "clone", "--quiet", "--no-hardlinks", ROOT, clone], { stdout: "pipe", stderr: "pipe" });
      if (cloned.exitCode !== 0) throw new Error(`git clone exited ${cloned.exitCode}: ${cloned.stderr.toString()}`);

      const config = ConfigSchema.parse(Bun.YAML.parse(readFileSync(join(clone, ".xarabot", "config.yaml"), "utf8")));
      const profile: SandboxProfile = {
        clone,
        vendorHome: join(lane, "vendor"),
        tempDir: join(lane, "tmp"),
        runnerGit: join(lane, "runner.git"),
        resultPath: join(lane, "tmp", "result.json"),
        repoHosts: config.proxy_hosts,
      };
      // A repo command: no credential, no API hosts; only the package hosts and the repo's proxy_hosts.
      const spec: LaunchSpec = { argv: ["bun", "install", "--frozen-lockfile"], vendor: "claude", vendorHomeEnv: "CLAUDE_CONFIG_DIR", apiHosts: [] };
      const launching = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: "en_US.UTF-8" };
      const r = await createMacSandbox({ launchingEnv: launching }).run(spec, profile, AbortSignal.timeout(240_000));
      if (!r.ok) throw new Error(`refused: ${r.error.message}`);
      if (r.value.exitCode !== 0) {
        throw new Error(`bun install exited ${r.value.exitCode ?? `on ${r.value.signal ?? "a signal"}`}:\n--- stdout ---\n${r.value.stdout}\n--- stderr ---\n${r.value.stderr}`);
      }
      expect(r.value.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  300_000,
);
