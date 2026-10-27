import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { strip } from "./support/boundaries.ts";

/**
 * Kills are by exact PID only (AR3, brownfield lessons): no `pkill`, no
 * `killall`, and no `timeout` binary, which stock macOS lacks. The one
 * exception is the macOS sandbox's kill of the process group it created for
 * a session with `setsid`, by that group's id, the session's exact PID
 * (Epic 3 retro item 1): each of `GROUP_KILLS` once in `src/sandbox/macos.ts`,
 * the runner's own and its reaper's, and nowhere else.
 */

const BANNED: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /\bpkill\b/, what: "pkill" },
  { pattern: /\bkillall\b/, what: "killall" },
  { pattern: /(["'`])(?:[^"'`\s]*\/)?g?timeout(?:\1|\s)/, what: "a timeout binary" },
  { pattern: /\bprocess\s*\.\s*kill\s*\(\s*-/, what: "a process-group kill" },
  { pattern: /\bkill\s+(?:-s\s+\w+|-\w+)\s+(?:--\s+)?["']?-[\w$]/, what: "a shell process-group kill" },
];

/** Every banned name in `source`, comments stripped. */
export function bannedIn(source: string): string[] {
  const { code } = strip(source);
  return BANNED.filter((b) => b.pattern.test(code)).map((b) => b.what);
}

/** The exempt file and its group kills, each by the session's own group id: the runner's, then its reaper's. */
const GROUP_KILL_FILE = "sandbox/macos.ts";
const GROUP_KILLS = ["process.kill(-pid, sig)", 'kill -s KILL -- "-$1"'] as const;

/** The banned names in a `src/` file: the exempt file once, each of its group kills taken out once. */
export function bannedInSrc(file: string, source: string): string[] {
  if (file !== GROUP_KILL_FILE) return bannedIn(source);
  let { code } = strip(source);
  for (const kill of GROUP_KILLS) {
    const parts = code.split(kill);
    if (parts.length !== 2) return [`the group kill ${kill} ${parts.length - 1} times, not once`];
    code = parts.join("void 0");
  }
  return bannedIn(code);
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
    ["const s = 'kill -s KILL -- \"-$1\"';", ["a shell process-group kill"]],
    ["const s = 'kill -9 -123';", ["a shell process-group kill"]],
    ["const s = `kill -KILL -${pid}`;", ["a shell process-group kill"]],
    ["const s = 'kill -s TERM 123';", []],
  ] as const)("fixture %j", (source, expected) => {
    expect(bannedIn(source)).toEqual([...expected]);
  });

  const OK = `const k = () => process.kill(-pid, sig);\nconst r = 'kill -s KILL -- "-$1"';`;
  test.each([
    ["sandbox/macos.ts", OK, []],
    ["sandbox/macos.ts", `${OK}\nprocess.kill(-other, 'SIGKILL');`, ["a process-group kill"]],
    ["sandbox/macos.ts", `${OK}\nconst t = 'kill -9 -1';`, ["a shell process-group kill"]],
    ["sandbox/macos.ts", `${OK}\nprocess.kill(-pid, sig);`, ["the group kill process.kill(-pid, sig) 2 times, not once"]],
    ["sandbox/macos.ts", "const r = 'kill -s KILL -- \"-$1\"';\nprocess.kill(pid, sig);", ["the group kill process.kill(-pid, sig) 0 times, not once"]],
    ["sandbox/macos.ts", "// process.kill(-pid, sig)\nprocess.kill(pid, sig);", ["the group kill process.kill(-pid, sig) 0 times, not once"]],
    ["sandbox/macos.ts", "const k = () => process.kill(-pid, sig);", ['the group kill kill -s KILL -- "-$1" 0 times, not once']],
    ["sandbox/macos.ts", `${OK}\nBun.spawn(['pkill', 'x']);`, ["pkill"]],
    ["lane/stop.ts", "process.kill(-pid, sig);", ["a process-group kill"]],
    ["lane/stop.ts", "const r = 'kill -s KILL -- \"-$1\"';", ["a shell process-group kill"]],
  ] as const)("exemption %s: %j", (file, source, expected) => {
    expect(bannedInSrc(file, source)).toEqual([...expected]);
  });

  test("the source tree", () => {
    const dir = join(import.meta.dir, "..", "src");
    const hits: string[] = [];
    for (const file of readdirSync(dir, { recursive: true }) as string[]) {
      if (!file.endsWith(".ts")) continue;
      for (const what of bannedInSrc(file, readFileSync(join(dir, file), "utf8"))) hits.push(`src/${file}: ${what}`);
    }
    expect(hits).toEqual([]);
  });
});
