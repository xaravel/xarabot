import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LANE_LOCK_FILE, laneLockText, lockVerdict, parseLaneLock, type StaleReason } from "../core/lane/lane-lock.ts";
import { err, ok, type Result } from "../core/result.ts";
import type { ProcessTable } from "./processes.ts";
import { message } from "./session.ts";

/**
 * The lane's exclusive process lock on the filesystem (AR3). The lock is
 * created whole: its text goes to a temp file in the lane folder, which is
 * then `link`ed to `lane.lock`, so a reader never sees a half-written lock;
 * `EEXIST` means another process holds it. A held lock whose process is gone,
 * whose PID was reused or runs another command, or whose text does not parse
 * is stale: it is renamed aside, checked to be the very text judged stale
 * (else it is put back and the lock reported held), removed, and the create
 * retried once. Release removes the lock only while it is still this
 * process's own. Never throws.
 */

export type AcquireLaneLockParams = {
  readonly laneDir: string;
  readonly pid: number;
  /** The runtime's basename, as the process table shows it. */
  readonly command: string;
  /** The process's start, epoch ms. */
  readonly startedMs: number;
  readonly table: ProcessTable;
};

export type StaleLock = {
  /** The stale lock's PID; `null` when its text did not parse. */
  readonly pid: number | null;
  readonly reason: StaleReason;
};

export type LaneLockAcquired = {
  readonly kind: "acquired";
  /** The stale lock this process took over, or `null` when there was none. */
  readonly tookOver: StaleLock | null;
  /** Removes `lane.lock` while its text is still this process's own. */
  release(): Result<void, "io">;
};

export type LaneLockHeld = {
  readonly kind: "held";
  /** The holder's PID; `null` when its lock could not be read. */
  readonly pid: number | null;
};

export type LaneLockOutcome = LaneLockAcquired | LaneLockHeld;

function code(e: unknown): unknown {
  return e !== null && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
}

class LockIo extends Error {}

/** `fn`, with any filesystem error turned into a `LockIo` naming `what`. */
function io<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new LockIo(`${what}: ${message(e)}`);
  }
}

function rmQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best effort.
  }
}

/** The text at `path`, or `null` when it does not exist. */
function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if (code(e) === "ENOENT") return null;
    throw new LockIo(`${path}: ${message(e)}`);
  }
}

/** The PID a lock text records, or `null`. */
function pidOf(text: string | null): number | null {
  if (text === null) return null;
  const parsed = parseLaneLock(text);
  return parsed.ok ? parsed.value.pid : null;
}

export function acquireLaneLock(p: AcquireLaneLockParams): Result<LaneLockOutcome, "io" | "invalid"> {
  const own = laneLockText({ pid: p.pid, command: p.command, startedMs: p.startedMs });
  if (!own.ok) return own;
  const text = own.value;
  const laneDir = resolve(p.laneDir);
  const lockPath = join(laneDir, LANE_LOCK_FILE);

  /** Publishes `text` as the lock, whole: whether it was created. */
  const create = (): boolean => {
    const tmp = join(laneDir, `${LANE_LOCK_FILE}.tmp-${p.pid}-${randomUUID()}`);
    try {
      io(tmp, () => writeFileSync(tmp, text, { mode: 0o600, flag: "wx" }));
      try {
        linkSync(tmp, lockPath);
        return true;
      } catch (e) {
        if (code(e) === "EEXIST") return false;
        throw new LockIo(`${lockPath}: ${message(e)}`);
      }
    } finally {
      rmQuietly(tmp);
    }
  };

  const release = (): Result<void, "io"> => {
    try {
      if (readOrNull(lockPath) !== text) return ok(undefined);
      rmSync(lockPath, { force: true });
      return ok(undefined);
    } catch (e) {
      return err("io", e instanceof LockIo ? e.message : `${lockPath}: ${message(e)}`);
    }
  };

  const acquired = (tookOver: StaleLock | null): LaneLockAcquired => ({ kind: "acquired", tookOver, release });
  const heldBy = (pid: number | null): LaneLockHeld => ({ kind: "held", pid });

  try {
    io(laneDir, () => mkdirSync(laneDir, { recursive: true, mode: 0o700 }));
    if (create()) return ok(acquired(null));

    // Taken: live, or stale and taken over.
    const seen = readOrNull(lockPath);
    let stale: StaleLock | null = null;
    if (seen !== null) {
      const parsed = parseLaneLock(seen);
      if (!parsed.ok) {
        stale = { pid: null, reason: "malformed" };
      } else {
        const verdict = lockVerdict(parsed.value, p.table.inspect(parsed.value.pid));
        if (verdict.kind === "live") return ok(heldBy(parsed.value.pid));
        stale = { pid: parsed.value.pid, reason: verdict.reason };
      }
      const aside = join(laneDir, `${LANE_LOCK_FILE}.stale-${p.pid}-${randomUUID()}`);
      let moved = true;
      try {
        renameSync(lockPath, aside);
      } catch (e) {
        // Gone already: another process removed or took it; the retry decides.
        if (code(e) !== "ENOENT") throw new LockIo(`${lockPath}: ${message(e)}`);
        moved = false;
      }
      if (moved) {
        const asideText = readOrNull(aside);
        if (asideText !== seen) {
          // Another process took the lock between the read and the rename: put it back.
          try {
            linkSync(aside, lockPath);
          } catch (e) {
            if (code(e) !== "EEXIST") throw new LockIo(`${lockPath}: ${message(e)}`);
          }
          rmQuietly(aside);
          return ok(heldBy(pidOf(asideText)));
        }
        io(aside, () => rmSync(aside, { force: true }));
      }
    }

    // One retry; taken again means another process holds it now.
    if (create()) return ok(acquired(stale));
    return ok(heldBy(pidOf(readOrNull(lockPath))));
  } catch (e) {
    return err("io", e instanceof LockIo ? e.message : `${lockPath}: ${message(e)}`);
  }
}
