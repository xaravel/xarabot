import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { LANE_LOCK_FILE } from "../core/lane/lane-lock.ts";
import { err, ok } from "../core/result.ts";
import { describeIssues } from "../core/schemas/common.ts";
import { JournalRecordSchema, LaneOutcome } from "../core/schemas/journal.ts";
import { PID_NAMES, type LaneStore, type LaneStoreResult } from "../ports/lane-store.ts";
import { unitFileId } from "./clone.ts";

/**
 * The filesystem `LaneStore` and the lane folder's layout (AR37). The lane
 * folder holds `lane.lock` (the lane process's exclusive lock, AR3),
 * `lane.pid`, `agent.pid`, `wait.pid`, `journal.jsonl`, `outcome`, `STOP` and
 * `logs/`, plus the session folders `laneLayout` names. Each write creates
 * its parent folder.
 */

export type LaneLayout = {
  readonly laneDir: string;
  readonly clone: string;
  readonly runnerGit: string;
  readonly vendorHome: string;
  /** The session temp folder, emptied before each session. */
  readonly tmp: string;
  /** Where the session writes its result; inside `tmp`. */
  readonly resultPath: string;
  readonly logs: string;
  readonly journal: string;
  readonly outcome: string;
  readonly stop: string;
  /** The lane process's exclusive lock (`src/lane/lane-lock.ts`). */
  readonly lock: string;
};

/** The absolute paths inside a lane folder. */
export function laneLayout(laneDirIn: string): LaneLayout {
  const laneDir = resolve(laneDirIn);
  const tmp = join(laneDir, "tmp");
  return {
    laneDir,
    clone: join(laneDir, "clone"),
    runnerGit: join(laneDir, "runner.git"),
    vendorHome: join(laneDir, "vendor"),
    tmp,
    resultPath: join(tmp, "result.json"),
    logs: join(laneDir, "logs"),
    journal: join(laneDir, "journal.jsonl"),
    outcome: join(laneDir, "outcome"),
    stop: join(laneDir, "STOP"),
    lock: join(laneDir, LANE_LOCK_FILE),
  };
}

/** A unit's log file name: `<unit-file-id>-<start>.log`, the start in ISO form with `:` as `-` and no milliseconds. */
export function logFileName(unit: string, startMs: number): string {
  const iso = new Date(startMs).toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-");
  return `${unitFileId(unit)}-${iso}.log`;
}

const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function io(what: string, e: unknown): { readonly ok: false; readonly error: { readonly kind: "io"; readonly message: string } } {
  return err("io", `${what}: ${e instanceof Error ? e.message : String(e)}`);
}

function write(path: string, text: string, append: boolean): LaneStoreResult<void> {
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (append) appendFileSync(path, text);
    else writeFileSync(path, text);
    return ok(undefined);
  } catch (e) {
    return io(path, e);
  }
}

export type FsLaneStoreParams = {
  readonly laneDir: string;
  /** The host STOP marker, `~/.xarabot/STOP`. */
  readonly hostStop: string;
};

export function createFsLaneStore(params: FsLaneStoreParams): LaneStore {
  const layout = laneLayout(params.laneDir);
  const hostStop = resolve(params.hostStop);
  const pidPath = (name: string) => join(layout.laneDir, `${name}.pid`);
  const known = (name: string): boolean => (PID_NAMES as readonly string[]).includes(name);

  return {
    stopMarkers() {
      try {
        return ok({ host: existsSync(hostStop), lane: existsSync(layout.stop) });
      } catch (e) {
        return io("STOP markers", e);
      }
    },

    writePid(name, pid, command) {
      if (!known(name)) return err("invalid", `writePid: unknown PID file ${JSON.stringify(name)}`);
      if (!Number.isSafeInteger(pid) || pid < 1) return err("invalid", `writePid: ${pid} is not a PID`);
      if (!PLAIN_NAME.test(command)) return err("invalid", `writePid: ${JSON.stringify(command)} is not a plain command name`);
      return write(pidPath(name), `${pid}\n${command}\n`, false);
    },

    clearPid(name) {
      if (!known(name)) return err("invalid", `clearPid: unknown PID file ${JSON.stringify(name)}`);
      try {
        rmSync(pidPath(name), { force: true });
        return ok(undefined);
      } catch (e) {
        return io(pidPath(name), e);
      }
    },

    appendJournal(record) {
      const parsed = JournalRecordSchema.safeParse(record);
      if (!parsed.success) return err("invalid", `journal record: ${describeIssues(parsed.error)}`);
      return write(layout.journal, `${JSON.stringify(parsed.data)}\n`, true);
    },

    writeOutcome(outcome) {
      const parsed = LaneOutcome.safeParse(outcome);
      if (!parsed.success) return err("invalid", `outcome: ${JSON.stringify(outcome)} is not a lane outcome`);
      return write(layout.outcome, `${parsed.data}\n`, false);
    },

    appendLog(file, text) {
      if (!PLAIN_NAME.test(file) || isAbsolute(file)) return err("invalid", `appendLog: ${JSON.stringify(file)} is not a plain file name`);
      const path = join(layout.logs, file);
      const w = write(path, text, true);
      return w.ok ? ok(path) : w;
    },
  };
}
