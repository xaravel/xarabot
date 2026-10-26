import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LANE_LOCK_FILE, laneLockText, lockVerdict, parseLaneLock, type StaleReason } from "../core/lane/lane-lock.ts";
import { START_SLACK_MS } from "../core/lane/waits.ts";
import { err, ok, type Result } from "../core/result.ts";
import { inspectPid, type ProcessTable } from "./processes.ts";

/**
 * The lane's exclusive process lock on the filesystem (AR3). The lock is
 * created whole: its text goes to a temp file in the lane folder, which is
 * then `link`ed to `lane.lock`, so a reader never sees a half-written lock;
 * `EEXIST` means another process holds it. A held lock whose process is gone,
 * whose PID was reused or runs another command, or whose text does not parse
 * is stale: it is renamed aside, checked to be the very text judged stale
 * (else it is put back and the lock reported held), removed, and the create
 * retried once. A holder the process table can't read is held, never gone.
 * Once acquired, the temp and set-aside files a killed process left are
 * removed. Release removes the lock only while it is still this process's
 * own. Never throws.
 *
 * A lock taken for this process's own PID is recorded until its release, and
 * each heartbeat re-reads it with `checkHeldLaneLocks`: a lock another process
 * took over, or one that is gone, ends the unit, so two live holders of a lane
 * never both run on.
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

/**
 * The re-read of the locks this process holds: `held` when each still has
 * this process's text (or there is none); `lost` when one was taken over or
 * is gone; `unreadable` when one could not be read, which shows no other
 * holder (a starting process can't read it either).
 */
export type LaneLockCheck =
  | { readonly kind: "held" }
  | { readonly kind: "lost"; readonly message: string }
  | { readonly kind: "unreadable"; readonly message: string };

/** The locks this process holds for its own PID: path → own text. */
const heldLocks = new Map<string, string>();

function code(e: unknown): unknown {
  return e !== null && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
}

/** A filesystem error on `what`. */
class LockIo extends Error {
  constructor(what: string, cause: unknown) {
    super(`${what}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** `e`'s text, as a `LockIo` on `what` unless it is one already. */
function ioText(what: string, e: unknown): string {
  return e instanceof LockIo ? e.message : new LockIo(what, e).message;
}

/** `fn`, with any filesystem error turned into a `LockIo` naming `what`. */
function io<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new LockIo(what, e);
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
    throw new LockIo(path, e);
  }
}

/** The PID a lock text records, or `null`. */
function pidOf(text: string | null): number | null {
  if (text === null) return null;
  const parsed = parseLaneLock(text);
  return parsed.ok ? parsed.value.pid : null;
}

/** A temp or set-aside file `acquireLaneLock` makes: `lane.lock.<tmp|stale>-<pid>-<uuid>`. */
const LEFTOVER = /^lane\.lock\.(?:tmp|stale)-([1-9][0-9]*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Removes the temp and set-aside files in `laneDir` whose maker is gone: one
 * named for `ownPid` (an acquire runs synchronously, so none of this
 * process's own is in flight), one whose PID has no process, or one whose
 * PID's process started after the file last changed (a reused PID). A file
 * whose PID the table can't read is kept. Best effort.
 */
function sweepLeftovers(laneDir: string, ownPid: number, table: ProcessTable): void {
  let names: string[];
  try {
    names = readdirSync(laneDir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = LEFTOVER.exec(name);
    if (m === null) continue;
    const path = join(laneDir, name);
    try {
      const st = lstatSync(path);
      if (!st.isFile()) continue;
      const pid = Number(m[1]);
      if (pid !== ownPid) {
        const info = inspectPid(table, pid);
        if (info === "unknown") continue;
        // A rename or link moves `ctime`, so it is never before the maker's last step.
        if (info !== null && info.startMs <= st.ctimeMs + START_SLACK_MS) continue;
      }
      rmSync(path, { force: true });
    } catch {
      // Best effort: the next acquire tries again.
    }
  }
}

/** Re-reads each lock this process holds; see `LaneLockCheck`. Never throws. */
export function checkHeldLaneLocks(): LaneLockCheck {
  for (const [lockPath, own] of heldLocks) {
    let text: string | null;
    try {
      text = readOrNull(lockPath);
    } catch (e) {
      return { kind: "unreadable", message: ioText(lockPath, e) };
    }
    if (text === own) continue;
    if (text === null) return { kind: "lost", message: `${lockPath} is gone: this process no longer holds its lane` };
    const parsed = parseLaneLock(text);
    if (!parsed.ok) return { kind: "lost", message: `${lockPath} no longer has this process's text: ${parsed.error.message}` };
    const holder = parsed.value;
    return {
      kind: "lost",
      message: `${lockPath} is now pid ${holder.pid}'s (started ${new Date(holder.startedMs).toISOString()}): another process runs this lane`,
    };
  }
  return { kind: "held" };
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
        throw new LockIo(lockPath, e);
      }
    } finally {
      rmQuietly(tmp);
    }
  };

  const release = (): Result<void, "io"> => {
    if (heldLocks.get(lockPath) === text) heldLocks.delete(lockPath);
    try {
      if (readOrNull(lockPath) !== text) return ok(undefined);
      rmSync(lockPath, { force: true });
      return ok(undefined);
    } catch (e) {
      return err("io", ioText(lockPath, e));
    }
  };

  const acquired = (tookOver: StaleLock | null): LaneLockAcquired => {
    if (p.pid === process.pid) heldLocks.set(lockPath, text);
    sweepLeftovers(laneDir, p.pid, p.table);
    return { kind: "acquired", tookOver, release };
  };
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
        const info = inspectPid(p.table, parsed.value.pid);
        // A holder the table can't read may be live: held, never gone.
        if (info === "unknown") return ok(heldBy(parsed.value.pid));
        const verdict = lockVerdict(parsed.value, info);
        if (verdict.kind === "live") return ok(heldBy(parsed.value.pid));
        stale = { pid: parsed.value.pid, reason: verdict.reason };
      }
      const aside = join(laneDir, `${LANE_LOCK_FILE}.stale-${p.pid}-${randomUUID()}`);
      let moved = true;
      try {
        renameSync(lockPath, aside);
      } catch (e) {
        // Gone already: another process removed or took it; the retry decides.
        if (code(e) !== "ENOENT") throw new LockIo(lockPath, e);
        moved = false;
      }
      if (moved) {
        const asideText = readOrNull(aside);
        if (asideText !== seen) {
          // Another process took the lock between the read and the rename: put it back.
          try {
            linkSync(aside, lockPath);
          } catch (e) {
            if (code(e) !== "EEXIST") throw new LockIo(lockPath, e);
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
    return err("io", ioText(lockPath, e));
  }
}
