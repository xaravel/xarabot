import { describe, expect, test } from "bun:test";
import { GRAPH_PSEUDO_GLOB } from "../../../src/core/next/coordinator.ts";
import { planReconcile, type ReconcilePlan } from "../../../src/core/reconcile/plan.ts";
import { parseSprintStatus } from "../../../src/core/next/sprint-status.ts";
import type { UnitRecord } from "../../../src/core/schemas/ledger.ts";
import type { PrState } from "../../../src/core/schemas/snapshot.ts";
import { COORD } from "../ledger/fixtures.ts";
import { EPICS_MD, input, NOW, STATUS, rec, snapshotOf, storyRec, type World } from "../next/fixtures.ts";

const HEAD = "e".repeat(40);
const minutesBefore = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();

/** A coordinator-held record. */
const coord = (unit: string, over: Partial<UnitRecord> = {}): UnitRecord =>
  rec({ unit, owner: COORD.owner, host: COORD.host, lane: COORD.lane, globs: [], heartbeat_at: NOW, ...over });

/** This run's own record. */
const U = "reconcile:5";
const OWN = coord(U, { state: "claimed" });
/** The last finished run. */
const LAST = coord("reconcile:4", { state: "merged", heartbeat_at: minutesBefore(12) });

const open = (n: number): PrState => ({ number: n, state: "open", head_sha: HEAD });
const merged = (n: number): PrState => ({ number: n, state: "merged", head_sha: HEAD });
const closed = (n: number): PrState => ({ number: n, state: "closed", head_sha: HEAD });

/** Epic 1 bootstrapped, Epic 2 with Stories 2.1 and 2.2; the coordinator's view with this run claimed. */
function world(extra: Partial<World> = {}): World {
  return { epics: { 1: [], 2: ["1", "2"] }, bootstrapped: [1], role: "coordinator", ...extra, records: [OWN, LAST, ...(extra.records ?? [])] };
}

function plan(w: Partial<World>): ReconcilePlan {
  const full = world(w);
  const files = input(full).files;
  return planReconcile(snapshotOf(full), U, Object.hasOwn(files, STATUS) ? (files[STATUS] as string) : null);
}

const statusMap = (p: ReconcilePlan): Record<string, string> | string => {
  if (p.status.kind !== "edit") return p.status.kind;
  const parsed = parseSprintStatus(STATUS, p.status.text);
  return parsed.ok ? parsed.value.development_status : `unparsed: ${parsed.error.message}`;
};

/** The parts of a plan that name units, compactly. */
function shape(p: ReconcilePlan) {
  return {
    markMerged: p.markMerged,
    checkQueue: p.checkQueue.map((t) => t.unit),
    releaseDead: p.releaseDead.map((t) => t.unit),
    deleteReleased: p.deleteReleased.map((t) => t.unit),
    deleteMerged: p.deleteMerged,
    status: p.status.kind,
    openPr: p.openPr?.unit ?? null,
    supersededMerged: p.supersededMerged,
  };
}

const EMPTY: ReturnType<typeof shape> = { markMerged: [], checkQueue: [], releaseDead: [], deleteReleased: [], deleteMerged: [], status: "none", openPr: null, supersededMerged: ["reconcile:4"] };

describe("planReconcile: the matrix", () => {
  test("Story merged: marked merged; the status set to done", () => {
    const p = plan({ records: [storyRec("2.1", { state: "parked", pr: 7 })], prs: { "story:2.1": merged(7) }, status: { "2.1": "backlog" } });
    expect(shape(p)).toEqual({ ...EMPTY, markMerged: ["story:2.1"], status: "edit" });
    expect(statusMap(p)).toEqual({ "epic-1": "backlog", "k-2.1": "done" });
    expect(p.status.kind === "edit" ? p.status.summary : []).toEqual(["k-2.1: backlog -> done"]);
    expect(p.status.kind === "edit" ? p.status.text : "").toContain("# comment\nproject: x\n");
    expect(p.path).toBe(STATUS);
  });

  test("Nothing to do: no status change; the older merged reconcile record is superseded", () => {
    expect(shape(plan({}))).toEqual(EMPTY);
  });

  test("Done on main: the merged Story is deleted, no status change", () => {
    const p = plan({ records: [storyRec("2.1", { state: "merged", pr: 7 })], prs: { "story:2.1": merged(7) }, status: { "2.1": "done" } });
    expect(shape(p)).toEqual({ ...EMPTY, deleteMerged: ["story:2.1"] });
  });

  test("A Story whose PR merged and that is already done on main: marked merged and deleted in one run", () => {
    const p = plan({ records: [storyRec("2.1", { state: "parked", pr: 7 })], prs: { "story:2.1": merged(7) }, status: { "2.1": "done" } });
    expect(shape(p)).toEqual({ ...EMPTY, markMerged: ["story:2.1"], deleteMerged: ["story:2.1"] });
  });

  test("Earlier PR open: the ledger work only; the open reconcile PR is named", () => {
    const parked = coord("reconcile:3", { state: "parked", pr: 3, park: { kind: "blocked", reason: "verification", inbox_owner: "carol", globs_held: [] } });
    const p = plan({ records: [parked, storyRec("2.1", { state: "parked", pr: 7 })], prs: { "reconcile:3": open(3), "story:2.1": merged(7) }, status: { "2.1": "backlog" } });
    expect(shape(p)).toEqual({ ...EMPTY, markMerged: ["story:2.1"], status: "edit", openPr: "reconcile:3" });
    expect(p.openPr).toEqual({ unit: "reconcile:3", pr: 3 });
  });

  test("Earlier PR queued: its queue is checked; it is the open reconcile PR", () => {
    const p = plan({ records: [coord("reconcile:3", { state: "merging", pr: 3, head_sha: HEAD, passed_sha: HEAD })], prs: { "reconcile:3": open(3) } });
    expect(shape(p)).toEqual({ ...EMPTY, checkQueue: ["reconcile:3"], openPr: "reconcile:3" });
    expect(p.checkQueue[0]).toEqual({ unit: "reconcile:3", generation: 1, pr: 3, pr_state: "open", head_sha: HEAD });
  });

  test("Earlier PR merged: marked merged; as the newest merged run it supersedes reconcile:4, which is deleted", () => {
    const p = plan({ records: [coord("reconcile:3", { state: "merging", pr: 3, head_sha: HEAD, passed_sha: HEAD, heartbeat_at: minutesBefore(40) })], prs: { "reconcile:3": merged(3) } });
    // reconcile:4 is newer by number, so reconcile:3 (merged as of this run) is the older one.
    expect(shape(p)).toEqual({ ...EMPTY, markMerged: ["reconcile:3"], deleteMerged: ["reconcile:3"], supersededMerged: ["reconcile:4"] });
  });

  test("Earlier PR merged, with no merged run after it: marked merged and kept as the newest; the older one deleted", () => {
    const old = coord("reconcile:2", { state: "merged", heartbeat_at: minutesBefore(60) });
    const w: World = { epics: { 1: [], 2: ["1"] }, bootstrapped: [1], role: "coordinator", records: [OWN, old, coord("reconcile:3", { state: "merging", pr: 3, passed_sha: HEAD })], prs: { "reconcile:3": merged(3) } };
    const files = input(w).files;
    const p = planReconcile(snapshotOf(w), U, files[STATUS] as string);
    expect(shape(p)).toEqual({ ...EMPTY, markMerged: ["reconcile:3"], deleteMerged: ["reconcile:2"], supersededMerged: ["reconcile:3"] });
  });

  test("Earlier PR ejected (open, not queued): checked like a queued one; no new PR this run", () => {
    const p = plan({ records: [coord("reconcile:3", { state: "merging", pr: 3, passed_sha: HEAD })], prs: { "reconcile:3": open(3) } });
    expect(shape(p).checkQueue).toEqual(["reconcile:3"]);
    expect(p.openPr?.unit).toBe("reconcile:3");
  });

  test.each([
    ["with its PR open", { "reconcile:3": open(3) }, "open", "reconcile:3"],
    ["with its PR closed", { "reconcile:3": closed(3) }, "closed", null],
    ["with no PR", {}, null, null],
  ] as const)("Released record %s: deleted (its PR closed first when open)", (_name, prs, state, openUnit) => {
    const p = plan({ records: [coord("reconcile:3", { state: "released", pr: state === null ? null : 3 })], prs });
    expect(shape(p)).toEqual({ ...EMPTY, deleteReleased: ["reconcile:3"], openPr: openUnit });
    expect(p.deleteReleased[0]?.pr_state).toBe(state);
  });

  test("Dead run: a stale claimed reconcile record is released", () => {
    const p = plan({ records: [coord("reconcile:3", { state: "claimed", heartbeat_at: minutesBefore(30) })] });
    expect(shape(p)).toEqual({ ...EMPTY, releaseDead: ["reconcile:3"] });
  });

  test("a live claimed reconcile record is left alone", () => {
    expect(shape(plan({ records: [coord("reconcile:3", { state: "claimed", heartbeat_at: minutesBefore(29) })] }))).toEqual(EMPTY);
  });

  test("Graph unit merged: its missing Story key is added as backlog after the Epic's last key", () => {
    const graph = coord("planning:graph.1", { state: "merged", globs: [EPICS_MD, GRAPH_PSEUDO_GLOB] });
    const status = ["development_status:", "  epic-1: done", "  epic-2: in-progress", "  k-2.1: done", "  k-2.12: backlog", "  epic-2-retrospective: optional", ""].join("\n");
    const p = plan({ epics: { 1: [], 2: ["1", "12", "13"] }, records: [graph], files: { [STATUS]: status } });
    expect(shape(p)).toEqual({ ...EMPTY, status: "edit" });
    expect(p.status.kind === "edit" ? p.status.text : "").toBe(status.replace("  k-2.12: backlog\n", "  k-2.12: backlog\n  k-2.13: backlog\n"));
  });

  test("Graph unit merged with a new Epic: a block at the end, Epic key first; a merged Story's key added as done", () => {
    const graph = coord("planning:graph.1", { state: "merged", globs: [EPICS_MD, GRAPH_PSEUDO_GLOB] });
    const p = plan({ epics: { 1: [], 2: ["1"], 3: ["1", "2"] }, records: [graph, storyRec("3.1", { state: "merged", pr: 8 })], status: { "2.1": "done" } });
    expect(p.status.kind === "edit" ? p.status.summary : p.status.kind).toEqual(["epic-2: added as backlog", "epic-3: added as backlog", "k-3.1: added as done", "k-3.2: added as backlog"]);
    expect(p.status.kind === "edit" ? p.status.text : "").toContain("  k-2.1: done\n  epic-2: backlog\n  epic-3: backlog\n  k-3.1: done\n  k-3.2: backlog\naction_items: []\n");
  });

  test("Graph unit whose entries are all on main: done, deleted", () => {
    const graph = coord("planning:graph.1", { state: "merged", globs: [EPICS_MD, GRAPH_PSEUDO_GLOB] });
    const status = ["development_status:", "  epic-1: done", "  epic-2: backlog", "  k-2.1: backlog", "  k-2.2: backlog", ""].join("\n");
    expect(shape(plan({ records: [graph], files: { [STATUS]: status } }))).toEqual({ ...EMPTY, deleteMerged: ["planning:graph.1"] });
  });

  test("Unparseable status: a flow-style development_status is invalid, naming why", () => {
    const p = plan({ records: [storyRec("2.1", { state: "merged", pr: 7 })], files: { [STATUS]: "development_status: {epic-1: backlog, k-2.1: backlog}\n" } });
    expect(p.status.kind).toBe("invalid");
    expect(p.status.kind === "invalid" ? p.status.message : "").toContain("not a block mapping");
  });

  test("an absent sprint-status.yaml: absent", () => {
    expect(plan({ records: [storyRec("2.1", { state: "merged", pr: 7 })], files: { [STATUS]: null } }).status.kind).toBe("absent");
  });

  test("a merged Story not yet done: the key set to done; a missing key added as done after its Epic's keys", () => {
    const p = plan({ records: [storyRec("2.1", { state: "merged", pr: 7 }), storyRec("2.2", { state: "merged", pr: 8 })], status: { "2.1": "review" } });
    expect(p.status.kind === "edit" ? p.status.summary : p.status.kind).toEqual(["k-2.1: review -> done", "k-2.2: added as done"]);
    expect(p.status.kind === "edit" ? p.status.text : "").toContain("  k-2.1: done\n  k-2.2: done\naction_items: []\n");
  });

  test("this run's own record is never a target, even when stale", () => {
    const w: World = { epics: { 1: [] }, bootstrapped: [1], role: "coordinator", records: [coord(U, { state: "claimed", heartbeat_at: minutesBefore(45) })] };
    const p = planReconcile(snapshotOf(w), U, input(w).files[STATUS] as string);
    expect(shape(p)).toEqual({ ...EMPTY, supersededMerged: [] });
  });
});

describe("planReconcile: each kind's doneOnMain decides deleteMerged", () => {
  const graph = { globs: [EPICS_MD, GRAPH_PSEUDO_GLOB] };
  test.each([
    ["a Story done", storyRec("2.1", { state: "merged" }), { status: { "2.1": "done" } }, true],
    ["a Story in review", storyRec("2.1", { state: "merged" }), { status: { "2.1": "review" } }, false],
    ["a status planning unit", coord("planning:status.1", { state: "merged" }), {}, true],
    ["a graph planning unit with entries missing", coord("planning:graph.1", { state: "merged", ...graph }), {}, false],
    ["a retro with its verdict", coord("retro:2", { state: "merged" }), { retro: { 2: "accepted" } }, true],
    ["a retro with none", coord("retro:2", { state: "merged" }), {}, false],
    ["a checkpoint with no go", coord("checkpoint:2", { state: "merged" }), {}, false],
    ["an older merged reconcile", coord("reconcile:3", { state: "merged", heartbeat_at: minutesBefore(30) }), {}, true],
  ] as const)("%s → %p", (_name, record, extra, want) => {
    const p = plan({ ...(extra as Partial<World>), records: [record] });
    expect(p.deleteMerged.includes(record.unit)).toBe(want);
  });

  test("the newest merged reconcile is kept by step 5 and superseded only when the run finishes", () => {
    const p = plan({});
    expect(p.deleteMerged).toEqual([]);
    expect(p.supersededMerged).toEqual(["reconcile:4"]);
  });
});
