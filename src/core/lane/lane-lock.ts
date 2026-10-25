import { err, ok, type Result } from "../result.ts";
import { checkPid, type PidCheck, type ProcessInfo } from "./waits.ts";

/**
 * The lane's process lock, `<laneDir>/lane.lock` (AR3): its text, its parse
 * and whether the process it names still holds it. The text is
 * `<pid>\n<command>\n<start>\n`: the PID, the basename of the runtime that
 * runs the lane, and the process's start as ISO 8601 UTC. A lock is live
 * when `checkPid` gives `ok` for it with the recorded start as `writtenMs`
 * and every word of the process's args counting, as `stop --now` checks; a
 * PID with no process, one whose process started later (a reused PID) or one
 * running another command is stale. Pure.
 */

/** The lock's file name in the lane folder. */
export const LANE_LOCK_FILE = "lane.lock";

export type LaneLock = {
  readonly pid: number;
  /** The runtime's basename, e.g. `bun`. */
  readonly command: string;
  /** The process's start, epoch ms. */
  readonly startedMs: number;
};

/** Why a lock is not live: a `checkPid` result other than `ok`, or text that does not parse. */
export type StaleReason = Exclude<PidCheck, "ok"> | "malformed";

export type LockVerdict = { readonly kind: "live" } | { readonly kind: "stale"; readonly reason: Exclude<PidCheck, "ok"> };

const PLAIN_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PID_TEXT = /^[1-9][0-9]*$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid >= 1;
}

/** The lock's text for `lock`; `invalid` for a PID, command or start the text can't carry. */
export function laneLockText(lock: LaneLock): Result<string, "invalid"> {
  if (!validPid(lock.pid)) return err("invalid", `lane.lock: ${lock.pid} is not a PID`);
  if (!PLAIN_COMMAND.test(lock.command)) return err("invalid", `lane.lock: ${JSON.stringify(lock.command)} is not a plain command name`);
  if (!Number.isFinite(lock.startedMs)) return err("invalid", `lane.lock: ${lock.startedMs} is not a start time`);
  const start = new Date(Math.floor(lock.startedMs));
  if (Number.isNaN(start.getTime())) return err("invalid", `lane.lock: ${lock.startedMs} is not a start time`);
  return ok(`${lock.pid}\n${lock.command}\n${start.toISOString()}\n`);
}

/** The lock a text records; `malformed` unless it is exactly three valid lines, each ending in a newline. */
export function parseLaneLock(text: string): Result<LaneLock, "malformed"> {
  const bad = (why: string) => err("malformed", `lane.lock: ${why}`);
  if (!text.endsWith("\n")) return bad("the text does not end in a newline");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length !== 3) return bad(`${lines.length} lines, not 3`);
  const [pidText, command, startText] = lines as [string, string, string];
  if (!PID_TEXT.test(pidText) || !validPid(Number(pidText))) return bad(`${JSON.stringify(pidText)} is not a PID`);
  if (!PLAIN_COMMAND.test(command)) return bad(`${JSON.stringify(command)} is not a plain command name`);
  if (!ISO_UTC.test(startText)) return bad(`${JSON.stringify(startText)} is not an ISO 8601 UTC time`);
  const startedMs = Date.parse(startText);
  if (!Number.isFinite(startedMs)) return bad(`${JSON.stringify(startText)} is not an ISO 8601 UTC time`);
  return ok({ pid: Number(pidText), command, startedMs });
}

/** Whether `lock` is still held, given the process now holding its PID (`null` for none). */
export function lockVerdict(lock: LaneLock, info: ProcessInfo | null): LockVerdict {
  const check = checkPid({ command: lock.command, writtenMs: lock.startedMs, info, first: false });
  return check === "ok" ? { kind: "live" } : { kind: "stale", reason: check };
}

/** A stale reason in words, for the lane's log. */
export function describeStale(reason: StaleReason): string {
  switch (reason) {
    case "gone":
      return "no process has its PID";
    case "started-later":
      return "its PID's process started after the lock was taken (a reused PID)";
    case "command":
      return "its PID runs another command";
    case "malformed":
      return "its text does not parse";
  }
}
