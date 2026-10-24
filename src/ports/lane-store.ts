import type { Result } from "../core/result.ts";
import type { JournalRecord, LaneOutcome } from "../core/schemas/journal.ts";

/**
 * The `LaneStore` port (AR1, AR37): a lane's own files on the host — its PID
 * files, journal, outcome, log files and the STOP markers. Every method is
 * synchronous, never throws, and returns a `Result`. The lane only reads the
 * STOP markers; it never writes one.
 */

/** The PID files a lane process records: its own, its agent's and its wait's. */
export const PID_NAMES = ["lane", "agent", "wait"] as const;
export type PidName = (typeof PID_NAMES)[number];

export type LaneStoreErrorKind = "invalid" | "io";
export type LaneStoreResult<T> = Result<T, LaneStoreErrorKind>;

export type LaneStore = {
  /** Whether the host STOP (`~/.xarabot/STOP`) and the lane's own `STOP` exist. */
  stopMarkers(): LaneStoreResult<{ readonly host: boolean; readonly lane: boolean }>;
  /** Writes `<name>.pid` as `<pid>\n<command>\n`; `command` is a plain basename. */
  writePid(name: PidName, pid: number, command: string): LaneStoreResult<void>;
  /** Removes `<name>.pid`; a missing file is fine. */
  clearPid(name: PidName): LaneStoreResult<void>;
  /** Validates `record` and appends it to `journal.jsonl` as one JSON line; an invalid record is refused. */
  appendJournal(record: JournalRecord): LaneStoreResult<void>;
  /** Writes `outcome` as the word and a newline. */
  writeOutcome(outcome: LaneOutcome): LaneStoreResult<void>;
  /** Appends `text` to `logs/<file>` (a plain file name); returns the log's absolute path. */
  appendLog(file: string, text: string): LaneStoreResult<string>;
};
