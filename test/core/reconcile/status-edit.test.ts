import { describe, expect, test } from "bun:test";
import { parseSprintStatus } from "../../../src/core/next/sprint-status.ts";
import { editDevelopmentStatus, type StatusChanges } from "../../../src/core/reconcile/status-edit.ts";

const PATH = "_bmad-output/implementation-artifacts/sprint-status.yaml";

const FILE = [
  "# generated: 2026-10-01",
  "project: xarabot",
  "",
  "development_status:",
  "  # Epic 1",
  "  epic-1: done",
  "  1-1-first: done",
  "",
  "  # Epic 2",
  "  epic-2: in-progress",
  "  2-1-heartbeat: backlog   # waiting on 1.17",
  "  2-12-race: review",
  "  epic-2-retrospective: optional",
  "",
  "action_items: []",
  "",
].join("\n");

const none: StatusChanges = { set: [], add: [] };
const edit = (changes: Partial<StatusChanges>, text = FILE) => editDevelopmentStatus(PATH, text, { ...none, ...changes });

/** `FILE` with `from` lines replaced by `to`. */
function fileWith(from: string, to: string): string {
  if (!FILE.includes(from)) throw new Error(`no ${from}`);
  return FILE.replace(from, to);
}

describe("editDevelopmentStatus", () => {
  test("no changes: the text as it is", () => {
    expect(edit({})).toEqual({ ok: true, value: FILE });
  });

  test("set: the value changes, the key text and a trailing comment stay", () => {
    expect(edit({ set: [{ key: "2-1-heartbeat", status: "done" }] })).toEqual({
      ok: true,
      value: fileWith("  2-1-heartbeat: backlog   # waiting on 1.17", "  2-1-heartbeat: done   # waiting on 1.17"),
    });
  });

  test("add into an Epic: after its last key, before a key of no Story", () => {
    const r = edit({ add: [{ after: ["epic-2", "2-1-heartbeat", "2-12-race"], entries: [{ key: "2-13-claims", status: "backlog" }] }] });
    expect(r).toEqual({ ok: true, value: fileWith("  2-12-race: review\n", "  2-12-race: review\n  2-13-claims: backlog\n") });
  });

  test("add a new Epic: a block at the end of development_status, Epic key first", () => {
    const r = edit({ add: [{ after: ["epic-3"], entries: [{ key: "epic-3", status: "backlog" }, { key: "3-1-adapters", status: "backlog" }] }] });
    expect(r).toEqual({
      ok: true,
      value: fileWith("  epic-2-retrospective: optional\n", "  epic-2-retrospective: optional\n  epic-3: backlog\n  3-1-adapters: backlog\n"),
    });
  });

  test("comments, blank lines and other keys are kept; sets and adds together", () => {
    const r = edit({
      set: [{ key: "1-1-first", status: "done" }, { key: "2-12-race", status: "done" }],
      add: [
        { after: ["epic-2", "2-12-race"], entries: [{ key: "2-13-claims", status: "done" }] },
        { after: ["epic-4"], entries: [{ key: "epic-4", status: "backlog" }] },
      ],
    });
    if (!r.ok) throw new Error(r.error.message);
    const lines = r.value.split("\n");
    for (const kept of ["# generated: 2026-10-01", "project: xarabot", "  # Epic 1", "  # Epic 2", "action_items: []", "  2-1-heartbeat: backlog   # waiting on 1.17"]) {
      expect(lines).toContain(kept);
    }
    expect(lines.filter((l) => l === "")).toHaveLength(FILE.split("\n").filter((l) => l === "").length);
    const parsed = parseSprintStatus(PATH, r.value);
    expect(parsed.ok && parsed.value.development_status).toEqual({
      "epic-1": "done",
      "1-1-first": "done",
      "epic-2": "in-progress",
      "2-1-heartbeat": "backlog",
      "2-12-race": "done",
      "epic-2-retrospective": "optional",
      "2-13-claims": "done",
      "epic-4": "backlog",
    });
  });

  test("CRLF line ends are kept, on new lines too", () => {
    const crlf = FILE.replaceAll("\n", "\r\n");
    const r = edit({ set: [{ key: "2-1-heartbeat", status: "done" }], add: [{ after: ["epic-3"], entries: [{ key: "epic-3", status: "backlog" }] }] }, crlf);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.split("\r\n").join("\n")).toBe(
      fileWith("  2-1-heartbeat: backlog   # waiting on 1.17", "  2-1-heartbeat: done   # waiting on 1.17").replace(
        "  epic-2-retrospective: optional\n",
        "  epic-2-retrospective: optional\n  epic-3: backlog\n",
      ),
    );
    expect(r.value.replaceAll("\r\n", "")).not.toContain("\n");
  });

  test("a key that needs quoting is quoted", () => {
    const r = edit({ add: [{ after: [], entries: [{ key: "yes", status: "backlog" }] }] });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value).toContain('  "yes": backlog\n');
  });

  test("a four-space indent is followed", () => {
    const text = "development_status:\n    epic-1: backlog\n";
    expect(edit({ add: [{ after: ["epic-1"], entries: [{ key: "1-1-a", status: "backlog" }] }] }, text)).toEqual({
      ok: true,
      value: "development_status:\n    epic-1: backlog\n    1-1-a: backlog\n",
    });
  });

  test.each([
    ["a flow-style development_status", { set: [{ key: "a", status: "done" }] }, "development_status: {a: backlog, b: done}\n", "not a block mapping"],
    ["no development_status block", { add: [{ after: [], entries: [{ key: "a", status: "done" }] }] }, "project: x\n", "no top-level development_status"],
    ["a set key that is not there", { set: [{ key: "9-9-x", status: "done" }] }, FILE, "is not in development_status"],
    ["an added key that is already there", { add: [{ after: [], entries: [{ key: "epic-1", status: "backlog" }] }] }, FILE, "already in development_status"],
    ["the same key added twice", { add: [{ after: [], entries: [{ key: "x-1", status: "backlog" }, { key: "x-1", status: "done" }] }] }, FILE, "already in development_status"],
    ["a tab-indented line", { set: [{ key: "epic-1", status: "done" }] }, "development_status:\n\tepic-1: backlog\n", "invalid"],
    ["text that is not YAML", { set: [] }, "development_status: [\n", "invalid"],
    ["a multi-line value", { set: [{ key: "epic-1", status: "done" }] }, "development_status:\n  epic-1: >\n    in progress\n", "spans several lines"],
  ] as const)("refused: %s", (_name, changes, text, why) => {
    const r = edit(changes as Partial<StatusChanges>, text);
    expect(r.ok ? "ok" : r.error.kind).toBe("invalid");
    if (why !== "invalid") expect(r.ok ? "" : r.error.message).toContain(why);
  });
});
