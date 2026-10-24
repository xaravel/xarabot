import { readFileSync, statSync } from "node:fs";
import { checkPid, type PidCheck, type ProcessInfo } from "../core/lane/waits.ts";

/**
 * The host's process table and kills by recorded PID (AR3, AR23). A kill
 * always reads the PID file, checks the process now holding that PID against
 * the file's command and mtime, and sends SIGTERM to that exact PID only.
 */

export type ProcessTable = {
  /** The process holding `pid`, or `null` when there is none or it can't be read. */
  inspect(pid: number): ProcessInfo | null;
  /** Sends SIGTERM to exactly `pid`; whether it was sent. */
  kill(pid: number): boolean;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `ps -o lstart=` in the C locale, then the args: `Fri Oct 23 10:00:00 2026 sleep 60`. */
const PS_LINE = /^\s*[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s+(\S.*?)\s*$/;

/** One `lstart= args=` line, `lstart` as local time; `null` when it can't be read. */
export function parseLstart(line: string): ProcessInfo | null {
  const m = PS_LINE.exec(line);
  if (m === null) return null;
  const month = MONTHS.indexOf(m[1] as string);
  if (month < 0) return null;
  const startMs = new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  if (!Number.isFinite(startMs)) return null;
  return { startMs, args: m[7] as string };
}

/** The IANA zone `Date` reads local time in, when known. */
function localZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** The process table through `LC_ALL=C ps -ww -o lstart= -o args= -p <pid>`. */
export function createPsProcessTable(): ProcessTable {
  return {
    inspect(pid) {
      if (!Number.isSafeInteger(pid) || pid < 1) return null;
      let proc: ReturnType<typeof Bun.spawnSync>;
      try {
        proc = Bun.spawnSync(["ps", "-ww", "-o", "lstart=", "-o", "args=", "-p", String(pid)], {
          // `ps` prints in the zone this process reads local time in (`bun test` pins its own zone).
          env: { ...process.env, LC_ALL: "C", ...(localZone() === undefined ? {} : { TZ: localZone() }) },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch {
        return null;
      }
      if (proc.exitCode !== 0) return null;
      const line = (proc.stdout?.toString() ?? "").split("\n").find((l) => l.trim() !== "");
      return line === undefined ? null : parseLstart(line);
    },
    kill(pid) {
      if (!Number.isSafeInteger(pid) || pid < 1) return false;
      try {
        process.kill(pid, "SIGTERM");
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type PidFile = { readonly pid: number; readonly command: string; readonly writtenMs: number };

/** A `<pid>\n<command>\n` PID file and its mtime; `null` when missing or malformed. */
export function readPidFile(path: string): PidFile | null {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    const pidText = (lines[0] ?? "").trim();
    const command = (lines[1] ?? "").trim();
    if (!/^[1-9]\d*$/.test(pidText) || command === "") return null;
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid)) return null;
    return { pid, command, writtenMs: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

export type SkipReason = "no-pid-file" | Exclude<PidCheck, "ok"> | "kill-failed";

export type KillReport =
  | { readonly kind: "killed"; readonly pid: number; readonly command: string }
  | { readonly kind: "skipped"; readonly reason: SkipReason; readonly pid: number | null };

export type KillOpts = {
  /** Only the process's first word counts for the command check. */
  readonly first: boolean;
  /** Refuse a PID file that recorded any other command. */
  readonly expect?: string;
};

/** Reads the PID file at `path`, checks its process, and kills it only when the check passes. */
export function killRecorded(table: ProcessTable, path: string, opts: KillOpts): KillReport {
  const file = readPidFile(path);
  if (file === null) return { kind: "skipped", reason: "no-pid-file", pid: null };
  if (opts.expect !== undefined && file.command !== opts.expect) return { kind: "skipped", reason: "command", pid: file.pid };
  const check = checkPid({ command: file.command, writtenMs: file.writtenMs, info: table.inspect(file.pid), first: opts.first });
  if (check !== "ok") return { kind: "skipped", reason: check, pid: file.pid };
  if (!table.kill(file.pid)) return { kind: "skipped", reason: "kill-failed", pid: file.pid };
  return { kind: "killed", pid: file.pid, command: file.command };
}

/** A report as one line of text. */
export function describeKill(name: string, r: KillReport): string {
  if (r.kind === "killed") return `${name}: killed ${r.command} (pid ${r.pid})`;
  return `${name}: skipped: ${r.reason}${r.pid === null ? "" : ` (pid ${r.pid})`}`;
}
