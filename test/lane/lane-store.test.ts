import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JournalRecord } from "../../src/core/schemas/journal.ts";
import { createFsLaneStore, laneLayout, logFileName } from "../../src/lane/lane-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "xarabot-lane-store-"));
  dirs.push(root);
  const laneDir = join(root, "lanes", "builder-1");
  const hostStop = join(root, "home", ".xarabot", "STOP");
  return { root, laneDir, hostStop, store: createFsLaneStore({ laneDir, hostStop }) };
}

const SPAN: JournalRecord = {
  schema_version: 1,
  type: "span",
  span: "idle",
  reason: "no Story left to build",
  started_at: "2026-10-23T10:00:00.000Z",
  ended_at: "2026-10-23T10:00:01.000Z",
};

describe("laneLayout", () => {
  test("names the AR37 folders and the result file inside tmp/", () => {
    const l = laneLayout("/x/lane");
    expect(l).toEqual({
      laneDir: "/x/lane",
      clone: "/x/lane/clone",
      runnerGit: "/x/lane/runner.git",
      vendorHome: "/x/lane/vendor",
      tmp: "/x/lane/tmp",
      resultPath: "/x/lane/tmp/result.json",
      logs: "/x/lane/logs",
      journal: "/x/lane/journal.jsonl",
      outcome: "/x/lane/outcome",
      stop: "/x/lane/STOP",
    });
  });

  test("log file names use the unit file id and the start with : as - and no milliseconds", () => {
    expect(logFileName("story:1.16a", Date.parse("2026-10-23T09:08:07.654Z"))).toBe("story__1.16a-2026-10-23T09-08-07Z.log");
  });
});

describe("createFsLaneStore", () => {
  test("writes PID files, creating the lane folder, and clears them", () => {
    const { laneDir, store } = setup();
    for (const name of ["lane", "agent", "wait"] as const) {
      expect(store.writePid(name, 4242, "sleep").ok).toBe(true);
      expect(readFileSync(join(laneDir, `${name}.pid`), "utf8")).toBe("4242\nsleep\n");
      expect(store.clearPid(name).ok).toBe(true);
      expect(existsSync(join(laneDir, `${name}.pid`))).toBe(false);
    }
    expect(store.clearPid("agent").ok).toBe(true);
  });

  test("refuses an unknown PID file or a non-PID", () => {
    const { store } = setup();
    expect(store.writePid("other" as "lane", 1, "bun")).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(store.writePid("lane", 0, "bun")).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(store.writePid("lane", 1.5, "bun")).toMatchObject({ ok: false, error: { kind: "invalid" } });
    for (const command of ["", "/usr/bin/sleep", "two words", "a\nb"]) {
      expect(store.writePid("lane", 1, command)).toMatchObject({ ok: false, error: { kind: "invalid" } });
    }
  });

  test("reads the host and lane STOP markers", () => {
    const { laneDir, hostStop, store } = setup();
    expect(store.stopMarkers()).toEqual({ ok: true, value: { host: false, lane: false } });
    mkdirSync(laneDir, { recursive: true });
    writeFileSync(join(laneDir, "STOP"), "");
    expect(store.stopMarkers()).toEqual({ ok: true, value: { host: false, lane: true } });
    mkdirSync(join(hostStop, ".."), { recursive: true });
    writeFileSync(hostStop, "");
    expect(store.stopMarkers()).toEqual({ ok: true, value: { host: true, lane: true } });
  });

  test("appends one JSON line per journal record", () => {
    const { laneDir, store } = setup();
    expect(store.appendJournal(SPAN).ok).toBe(true);
    expect(store.appendJournal({ ...SPAN, reason: "again" }).ok).toBe(true);
    const lines = readFileSync(join(laneDir, "journal.jsonl"), "utf8").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    expect(JSON.parse(lines[0] as string)).toEqual(SPAN);
    expect(JSON.parse(lines[1] as string).reason).toBe("again");
  });

  test("refuses an invalid journal record and writes nothing", () => {
    const { laneDir, store } = setup();
    const r = store.appendJournal({ ...SPAN, reason: "" });
    expect(r).toMatchObject({ ok: false, error: { kind: "invalid" } });
    if (!r.ok) expect(r.error.message).toContain("reason");
    expect(store.appendJournal({ ...SPAN, extra: 1 } as unknown as JournalRecord).ok).toBe(false);
    expect(existsSync(join(laneDir, "journal.jsonl"))).toBe(false);
  });

  test("writes the outcome word and a newline, replacing the last", () => {
    const { laneDir, store } = setup();
    expect(store.writeOutcome("idle").ok).toBe(true);
    expect(store.writeOutcome("progress").ok).toBe(true);
    expect(readFileSync(join(laneDir, "outcome"), "utf8")).toBe("progress\n");
    expect(store.writeOutcome("done" as "idle").ok).toBe(false);
  });

  test("appends logs under logs/ and returns the absolute path", () => {
    const { laneDir, store } = setup();
    const a = store.appendLog("story__1.1-x.log", "one\n");
    const b = store.appendLog("story__1.1-x.log", "two\n");
    expect(a).toEqual({ ok: true, value: join(laneDir, "logs", "story__1.1-x.log") });
    expect(b).toEqual(a);
    expect(readFileSync(join(laneDir, "logs", "story__1.1-x.log"), "utf8")).toBe("one\ntwo\n");
  });

  test("refuses a log name that is not a plain file name", () => {
    const { store } = setup();
    for (const name of ["../x.log", "a/b.log", "/abs.log", ".hidden", ""]) {
      expect(store.appendLog(name, "x").ok).toBe(false);
    }
  });

  test("an unwritable lane folder is an io error, not a throw", () => {
    const { root } = setup();
    const file = join(root, "file");
    writeFileSync(file, "");
    const store = createFsLaneStore({ laneDir: join(file, "lane"), hostStop: join(root, "STOP") });
    expect(store.writePid("lane", 1, "bun")).toMatchObject({ ok: false, error: { kind: "io" } });
    expect(store.writeOutcome("stop")).toMatchObject({ ok: false, error: { kind: "io" } });
    expect(store.appendJournal(SPAN)).toMatchObject({ ok: false, error: { kind: "io" } });
  });
});
