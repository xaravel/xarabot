import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { strip } from "./support/boundaries.ts";

/**
 * Kills are by exact PID only (AR3, brownfield lessons): no `pkill`, no
 * `killall`, and no `timeout` binary, which stock macOS lacks.
 */

const BANNED: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /\bpkill\b/, what: "pkill" },
  { pattern: /\bkillall\b/, what: "killall" },
  { pattern: /(["'`])(?:[^"'`\s]*\/)?g?timeout(?:\1|\s)/, what: "a timeout binary" },
  { pattern: /\bprocess\s*\.\s*kill\s*\(\s*-/, what: "a process-group kill" },
];

/** Every banned name in `source`, comments stripped. */
export function bannedIn(source: string): string[] {
  const { code } = strip(source);
  return BANNED.filter((b) => b.pattern.test(code)).map((b) => b.what);
}

describe("no pkill, killall or timeout binary in src/", () => {
  test.each([
    ['Bun.spawn(["pkill", "-f", "claude"]);', ["pkill"]],
    ['Bun.spawnSync(["killall", "sleep"]);', ["killall"]],
    ['Bun.spawn(["timeout", "5", "claude"]);', ["a timeout binary"]],
    ["const t = 'gtimeout';", ["a timeout binary"]],
    ['const t = "/opt/homebrew/bin/gtimeout";', ["a timeout binary"]],
    ['Bun.spawn(["sh", "-c", "timeout 5 claude"]);', ["a timeout binary"]],
    ["const c = `gtimeout ${n} x`;", ["a timeout binary"]],
    ["const c = '/usr/local/bin/timeout 5 claude';", ["a timeout binary"]],
    ["process.kill(-pid, 'SIGTERM');", ["a process-group kill"]],
    ["process . kill( -child.pid);", ["a process-group kill"]],
    ["process.kill(pid, 'SIGTERM');", []],
    ['const m = "session timeout reached";', []],
    ["const s = AbortSignal.timeout(5000);", []],
    ['const r = "ci-timeout";', []],
    ["// never pkill, killall or `timeout`\nconst x = 1;", []],
    ["/* pkill */ const y = 2;", []],
  ] as const)("fixture %j", (source, expected) => {
    expect(bannedIn(source)).toEqual([...expected]);
  });

  test("the source tree", () => {
    const dir = join(import.meta.dir, "..", "src");
    const hits: string[] = [];
    for (const file of readdirSync(dir, { recursive: true }) as string[]) {
      if (!file.endsWith(".ts")) continue;
      for (const what of bannedIn(readFileSync(join(dir, file), "utf8"))) hits.push(`src/${file}: ${what}`);
    }
    expect(hits).toEqual([]);
  });
});
