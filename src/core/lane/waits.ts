import type { LaneOutcome } from "../schemas/journal.ts";

/**
 * The lane's waits and the PID check behind every kill (FR15, AR3, AR23,
 * AR44). Pure.
 */

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;

/** The trailing wait after each outcome; `stop` has none. */
export const TRAILING_WAIT_MS: Readonly<Record<LaneOutcome, number | null>> = {
  progress: MINUTE_MS,
  idle: 30 * MINUTE_MS,
  failed: 15 * MINUTE_MS,
  stop: null,
};

/** How long after a usage limit's reset the lane sleeps on. */
export const USAGE_LIMIT_MARGIN_MS = 2 * MINUTE_MS;
/** The sleep when the reset can't be read. */
export const USAGE_LIMIT_UNKNOWN_MS = 15 * MINUTE_MS;
/** The longest usage-limit sleep. */
export const USAGE_LIMIT_CAP_MS = 8 * HOUR_MS;
/** How often a usage-limit sleep heartbeats the claim. */
export const USAGE_LIMIT_TICK_MS = 5 * MINUTE_MS;

/** An agent session's own limit and how long it may linger after its result. */
export const SESSION_MS = 3 * HOUR_MS;
export const RESULT_LINGER_MS = 5 * MINUTE_MS;
export const RESULT_POLL_MS = 5 * 1000;

/** A process may start this long after its PID file was written (`lstart` has whole seconds). */
export const START_SLACK_MS = 1000;

export function trailingWaitMs(outcome: LaneOutcome): number | null {
  return TRAILING_WAIT_MS[outcome];
}

/** Until `resetAt` plus 2 min, clamped to [0, 8 h]; 15 min when `resetAt` is `null`. */
export function usageLimitSleepMs(resetAt: number | null, nowMs: number): number {
  if (resetAt === null) return USAGE_LIMIT_UNKNOWN_MS;
  return Math.min(USAGE_LIMIT_CAP_MS, Math.max(0, resetAt + USAGE_LIMIT_MARGIN_MS - nowMs));
}

function basename(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/**
 * Whether a whitespace-separated word of `args` has `command` as its
 * basename; with `first`, only the first word counts.
 */
export function commandMatches(command: string, args: string, first: boolean): boolean {
  if (command === "") return false;
  const words = args.trim().split(/\s+/).filter((w) => w !== "");
  return (first ? words.slice(0, 1) : words).some((w) => basename(w) === command);
}

/** A live process as the process table reports it. */
export type ProcessInfo = { readonly startMs: number; readonly args: string };

export type PidCheck = "ok" | "gone" | "started-later" | "command";

export type CheckPidParams = {
  /** The command the PID file recorded, a basename. */
  readonly command: string;
  /** When the PID file was written (its mtime). */
  readonly writtenMs: number;
  /** The process now holding the PID, or `null` when there is none. */
  readonly info: ProcessInfo | null;
  readonly first: boolean;
};

/** Whether the process holding a recorded PID is still the one recorded. */
export function checkPid(p: CheckPidParams): PidCheck {
  if (p.info === null) return "gone";
  if (p.info.startMs > p.writtenMs + START_SLACK_MS) return "started-later";
  if (!commandMatches(p.command, p.info.args, p.first)) return "command";
  return "ok";
}
