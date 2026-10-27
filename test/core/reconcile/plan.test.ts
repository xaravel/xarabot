import { describe, expect, test } from "bun:test";
import { GRAPH_PSEUDO_GLOB } from "../../../src/core/next/coordinator.ts";
import { standingApproval } from "../../../src/core/reconcile/approval.ts";
import { planReconcile, type ReconcilePlan } from "../../../src/core/reconcile/plan.ts";
import { parseSprintStatus } from "../../../src/core/next/sprint-status.ts";
import type { UnitRecord } from "../../../src/core/schemas/ledger.ts";
import type { PrState } from "../../../src/core/schemas/snapshot.ts";
import { COORD } from "../ledger/fixtures.ts";
import { parseRetroGates } from "../../../src/core/graph/retro-gates.ts";
import { EPICS_MD, input, NOW, RETRO, STATUS, rec, snapshotOf, storyRec, type World } from "../next/fixtures.ts";

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
    checkGated: p.checkGated.map((t) => t.unit),
    checkUngated: p.checkUngated.map((t) => t.unit),
    takeApproved: p.takeApproved.map((t) => t.unit),
    releaseDead: p.releaseDead.map((t) => t.unit),
    deleteReleased: p.deleteReleased.map((t) => t.unit),
    deleteMerged: p.deleteMerged,
    status: p.status.kind,
    openPrs: p.openPrs.map((o) => o.unit),
    supersededMerged: p.supersededMerged,
  };
}

const EMPTY: ReturnType<typeof shape> = { markMerged: [], checkQueue: [], checkGated: [], checkUngated: [], takeApproved: [], releaseDead: [], deleteReleased: [], deleteMerged: [], status: "none", openPrs: [], supersededMerged: ["reconcile:4"] };

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
    expect(shape(p)).toEqual({ ...EMPTY, markMerged: ["story:2.1"], status: "edit", openPrs: ["reconcile:3"] });
    expect(p.openPrs).toEqual([{ unit: "reconcile:3", pr: 3 }]);
  });

  test("Earlier PR queued: its queue is checked; it is the open reconcile PR", () => {
    const p = plan({ records: [coord("reconcile:3", { state: "merging", pr: 3, head_sha: HEAD, passed_sha: HEAD })], prs: { "reconcile:3": open(3) } });
    expect(shape(p)).toEqual({ ...EMPTY, checkQueue: ["reconcile:3"], openPrs: ["reconcile:3"] });
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
    expect(p.openPrs.map((o) => o.unit)).toEqual(["reconcile:3"]);
  });

  test.each([
    ["with its PR open", { "reconcile:3": open(3) }, "open", ["reconcile:3"]],
    ["with its PR closed", { "reconcile:3": closed(3) }, "closed", []],
    ["with no PR", {}, null, []],
  ] as const)("Released record %s: deleted (its PR closed first when open)", (_name, prs, state, openUnits) => {
    const p = plan({ records: [coord("reconcile:3", { state: "released", pr: state === null ? null : 3 })], prs });
    expect(shape(p)).toEqual({ ...EMPTY, deleteReleased: ["reconcile:3"], openPrs: [...openUnits] });
    expect(p.deleteReleased[0]?.pr_state).toBe(state);
  });

  test("every other reconcile record with an open PR is listed, in ledger order", () => {
    const parked = coord("reconcile:2", { state: "parked", pr: 2, park: { kind: "blocked", reason: "verification", inbox_owner: "carol", globs_held: [] } });
    const merging = coord("reconcile:3", { state: "merging", pr: 3, head_sha: HEAD, passed_sha: HEAD });
    const p = plan({ records: [parked, merging, storyRec("2.1", { state: "claimed", pr: 9 })], prs: { "reconcile:2": open(2), "reconcile:3": open(3), "story:2.1": open(9) } });
    expect(p.openPrs).toEqual([
      { unit: "reconcile:2", pr: 2 },
      { unit: "reconcile:3", pr: 3 },
    ]);
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

  test("a merged Story not yet done: the key set to done; a missing key added as done after its Epic's keys, with the Epic's absent key", () => {
    const p = plan({ records: [storyRec("2.1", { state: "merged", pr: 7 }), storyRec("2.2", { state: "merged", pr: 8 })], status: { "2.1": "review" } });
    expect(p.status.kind === "edit" ? p.status.summary : p.status.kind).toEqual(["k-2.1: review -> done", "epic-2: added as done", "k-2.2: added as done"]);
    expect(p.status.kind === "edit" ? p.status.text : "").toContain("  k-2.1: done\n  epic-2: done\n  k-2.2: done\naction_items: []\n");
  });

  test("this run's own record is never a target, even when stale", () => {
    const w: World = { epics: { 1: [] }, bootstrapped: [1], role: "coordinator", records: [coord(U, { state: "claimed", heartbeat_at: minutesBefore(45) })] };
    const p = planReconcile(snapshotOf(w), U, input(w).files[STATUS] as string);
    expect(shape(p)).toEqual({ ...EMPTY, supersededMerged: [] });
  });
});

describe("planReconcile: an Epic's key done with its last Story (retro item 16)", () => {
  const summary = (p: ReconcilePlan) => (p.status.kind === "edit" ? p.status.summary : p.status.kind);

  test("the last Story done: the Epic's key set done in the same edit", () => {
    const p = plan({ records: [storyRec("2.2", { state: "merged", pr: 8 })], status: { "epic-2": "in-progress", "2.1": "done", "2.2": "review" } });
    expect(summary(p)).toEqual(["k-2.2: review -> done", "epic-2: in-progress -> done"]);
    expect(statusMap(p)).toEqual({ "epic-1": "backlog", "epic-2": "done", "k-2.1": "done", "k-2.2": "done" });
  });

  test("both Stories merged in one run, the Epic's key absent: added done", () => {
    const p = plan({ records: [storyRec("2.1", { state: "merged", pr: 7 }), storyRec("2.2", { state: "merged", pr: 8 })], status: { "2.1": "review", "2.2": "review" } });
    expect(summary(p)).toEqual(["k-2.1: review -> done", "k-2.2: review -> done", "epic-2: added as done"]);
  });

  test("a Story not yet done: the Epic's key is left as it is", () => {
    const p = plan({ records: [storyRec("2.1", { state: "merged", pr: 7 })], status: { "epic-2": "in-progress", "2.1": "review", "2.2": "backlog" } });
    expect(summary(p)).toEqual(["k-2.1: review -> done"]);
    expect(statusMap(p)).toMatchObject({ "epic-2": "in-progress", "k-2.2": "backlog" });
  });

  test("a Story with no status yet counts as not done", () => {
    const p = plan({ records: [storyRec("2.1", { state: "merged", pr: 7 })], status: { "epic-2": "in-progress", "2.1": "review" } });
    expect(summary(p)).toEqual(["k-2.1: review -> done"]);
  });

  test("an Epic already done: not set again", () => {
    const p = plan({ records: [storyRec("2.2", { state: "merged", pr: 8 })], status: { "epic-2": "done", "2.1": "done", "2.2": "review" } });
    expect(summary(p)).toEqual(["k-2.2: review -> done"]);
  });

  test("an Epic done with a Story not yet done: never set back from done", () => {
    const p = plan({ records: [storyRec("2.1", { state: "merged", pr: 7 })], status: { "epic-2": "done", "2.1": "review", "2.2": "backlog" } });
    expect(summary(p)).toEqual(["k-2.1: review -> done"]);
    expect(statusMap(p)).toMatchObject({ "epic-2": "done" });
  });

  test("every Story already done on main: no edit for the Epic's key alone", () => {
    const p = plan({ records: [storyRec("2.2", { state: "merged", pr: 8 })], status: { "epic-2": "in-progress", "2.1": "done", "2.2": "done" } });
    expect(p.status.kind).toBe("none");
  });

  test("a bootstrapped Epic whose key is absent: its key is not added", () => {
    const p = plan({ epics: { 1: [], 2: ["1", "2"], 3: ["1"] }, bootstrapped: [1, 3], records: [storyRec("3.1", { state: "merged", pr: 9 })], status: { "3.1": "review" } });
    expect(summary(p)).toEqual(["k-3.1: review -> done"]);
    expect(statusMap(p)).not.toHaveProperty("epic-3");
  });

  test("a bootstrapped Epic whose key is present: set done like any other", () => {
    const p = plan({ epics: { 1: [], 2: ["1", "2"], 3: ["1"] }, bootstrapped: [1, 3], records: [storyRec("3.1", { state: "merged", pr: 9 })], status: { "epic-3": "in-progress", "3.1": "review" } });
    expect(summary(p)).toEqual(["k-3.1: review -> done", "epic-3: in-progress -> done"]);
  });

  test("a graph unit adding the Epic's key as backlog in the same run: added done instead", () => {
    const graph = coord("planning:graph.1", { state: "merged", globs: [EPICS_MD, GRAPH_PSEUDO_GLOB] });
    const p = plan({ records: [graph, storyRec("2.2", { state: "merged", pr: 8 })], status: { "2.1": "done", "2.2": "review" } });
    expect(summary(p)).toEqual(["k-2.2: review -> done", "epic-2: added as done"]);
  });
});

describe("planReconcile: approval-gated PRs (Story 2.6)", () => {
  const OTHER = "f".repeat(40);
  const PARKED_AT = minutesBefore(20);
  /** A Story parked awaiting approval with PR 7 at HEAD, owned by alice. */
  const awaiting = (over: Partial<UnitRecord> = {}): UnitRecord =>
    storyRec("2.1", {
      state: "parked",
      pr: 7,
      pr_owner: "alice",
      head_sha: HEAD,
      passed_sha: HEAD,
      heartbeat_at: PARKED_AT,
      park: { kind: "awaiting-approval", reason: null, inbox_owner: "alice", globs_held: ["docs/x.md", "src/2.1/a.ts"] },
      ...over,
    });
  /** A Story the coordinator took on approval and queued. */
  const gated = (over: Partial<UnitRecord> = {}): UnitRecord =>
    coord("story:2.1", { state: "merging", generation: 2, globs: ["src/2.1/a.ts"], pr: 7, pr_owner: "alice", head_sha: HEAD, passed_sha: HEAD, enqueued_sha: HEAD, approved_sha: HEAD, ...over });

  test("a builder-parked awaiting-approval record whose PR is open at its head is a take candidate, with no park time and its diff paths", () => {
    const p = plan({ records: [awaiting()], prs: { "story:2.1": open(7) } });
    expect(shape(p)).toEqual({ ...EMPTY, takeApproved: ["story:2.1"] });
    expect(p.takeApproved).toEqual([
      { unit: "story:2.1", generation: 1, pr: 7, pr_owner: "alice", head_sha: HEAD, parked_at: null, passed_sha: HEAD, builder_providers: [], globs: ["docs/x.md", "src/2.1/a.ts"], graph_posted: null },
    ]);
  });

  test("a take candidate carries its passed_sha and builder_providers, for the passed gate and the allowance (Story 3.5)", () => {
    const p = plan({ records: [awaiting({ passed_sha: null, builder_providers: ["anthropic"] })], prs: { "story:2.1": open(7) } });
    expect(p.takeApproved.map((t) => [t.passed_sha, t.builder_providers])).toEqual([[null, ["anthropic"]]]);
  });

  test("a reconcile record's first protected-path park (coordinator lane, no enqueued_sha) is a first park: parked_at null", () => {
    const r3 = coord("reconcile:3", { state: "parked", pr: 3, pr_owner: COORD.owner, head_sha: HEAD, heartbeat_at: PARKED_AT, park: { kind: "awaiting-approval", reason: null, inbox_owner: COORD.owner, globs_held: [STATUS] } });
    const p = plan({ records: [r3], prs: { "reconcile:3": open(3) } });
    expect(p.takeApproved).toEqual([{ unit: "reconcile:3", generation: 1, pr: 3, pr_owner: COORD.owner, head_sha: HEAD, parked_at: null, passed_sha: null, builder_providers: [], globs: [STATUS], graph_posted: null }]);
  });

  test("a planning step's first park (planning:graph.1, coordinator lane, reviewed: passed_sha but no enqueued_sha): parked_at null", () => {
    const g = coord("planning:graph.1", { state: "parked", globs: [EPICS_MD, GRAPH_PSEUDO_GLOB], pr: 4, pr_owner: COORD.owner, head_sha: HEAD, passed_sha: HEAD, heartbeat_at: PARKED_AT, park: { kind: "awaiting-approval", reason: null, inbox_owner: COORD.owner, globs_held: [EPICS_MD] } });
    const p = plan({ records: [g], prs: { "planning:graph.1": open(4) } });
    expect(p.takeApproved).toEqual([{ unit: "planning:graph.1", generation: 1, pr: 4, pr_owner: COORD.owner, head_sha: HEAD, parked_at: null, passed_sha: HEAD, builder_providers: [], globs: [EPICS_MD], graph_posted: null }]);
  });

  test("a coordinator re-park with enqueued_sha set: parked_at is its heartbeat_at", () => {
    const g = coord("planning:graph.1", { state: "parked", generation: 2, globs: [EPICS_MD, GRAPH_PSEUDO_GLOB], pr: 4, pr_owner: COORD.owner, head_sha: HEAD, passed_sha: HEAD, enqueued_sha: HEAD, heartbeat_at: PARKED_AT, park: { kind: "awaiting-approval", reason: null, inbox_owner: COORD.owner, globs_held: [EPICS_MD] } });
    const p = plan({ records: [g], prs: { "planning:graph.1": open(4) } });
    expect(p.takeApproved.map((t) => t.parked_at)).toEqual([PARKED_AT]);
  });

  test("a coordinator-lane re-park is a take candidate whose park time is its heartbeat_at", () => {
    const reparked = awaiting({ owner: COORD.owner, host: COORD.host, lane: COORD.lane, generation: 2, enqueued_sha: HEAD });
    const p = plan({ records: [reparked], prs: { "story:2.1": open(7) } });
    expect(p.takeApproved).toEqual([
      { unit: "story:2.1", generation: 2, pr: 7, pr_owner: "alice", head_sha: HEAD, parked_at: PARKED_AT, passed_sha: HEAD, builder_providers: [], globs: ["docs/x.md", "src/2.1/a.ts"], graph_posted: null },
    ]);
  });

  test("a re-park with a posted graph delta (retro item 24) carries its graph_posted, and its heartbeat_at as the park time", () => {
    const hash = `sha256:${"e".repeat(64)}`;
    const reparked = awaiting({
      owner: COORD.owner,
      host: COORD.host,
      lane: COORD.lane,
      enqueued_sha: HEAD,
      park: { kind: "awaiting-approval", reason: null, inbox_owner: "edanisko", globs_held: ["src/2.1/a.ts"], graph_posted: hash },
    });
    const p = plan({ records: [reparked], prs: { "story:2.1": open(7) } });
    expect(p.takeApproved.map((t) => [t.parked_at, t.graph_posted])).toEqual([[PARKED_AT, hash]]);
  });

  test("a coordinator-lane park with passed_sha alone is a first park (Story 3.5): parked_at null", () => {
    const reviewedOnly = awaiting({ owner: COORD.owner, host: COORD.host, lane: COORD.lane, generation: 2, passed_sha: HEAD, enqueued_sha: null });
    const p = plan({ records: [reviewedOnly], prs: { "story:2.1": open(7) } });
    expect(p.takeApproved.map((t) => t.parked_at)).toEqual([null]);
  });

  describe("a first park with a posted graph delta counts only a later approval (retro item 33)", () => {
    const hash = `sha256:${"e".repeat(64)}`;
    const approvedAt = (minutesAgo: number) => [{ author: "edanisko", state: "approved", commit_sha: HEAD, submitted_at: minutesBefore(minutesAgo) }];
    /** The candidate's standing approval from the Maintainer, as the reconcile step queries it. */
    const approvalOf = (p: ReconcilePlan, minutesAgo: number) =>
      p.takeApproved.map((t) => standingApproval(approvedAt(minutesAgo), { owner: "edanisko", head: t.head_sha, parkedAt: t.parked_at }) !== null);

    test("a builder's first park with graph_posted: parked_at is its heartbeat_at; an approval before the delta comment stays parked, one after is taken", () => {
      const builder = awaiting({ park: { kind: "awaiting-approval", reason: null, inbox_owner: "edanisko", globs_held: ["src/2.1/a.ts"], graph_posted: hash } });
      const p = plan({ records: [builder], prs: { "story:2.1": open(7) } });
      expect(p.takeApproved.map((t) => [t.parked_at, t.graph_posted])).toEqual([[PARKED_AT, hash]]);
      expect(approvalOf(p, 30)).toEqual([false]);
      expect(approvalOf(p, 20)).toEqual([false]);
      expect(approvalOf(p, 10)).toEqual([true]);
    });

    test("the graph planning step's first park with graph_posted (coordinator lane, no enqueued_sha): parked_at is its heartbeat_at", () => {
      const g = coord("planning:graph.1", {
        state: "parked",
        globs: [EPICS_MD, GRAPH_PSEUDO_GLOB],
        pr: 4,
        pr_owner: COORD.owner,
        head_sha: HEAD,
        passed_sha: HEAD,
        heartbeat_at: PARKED_AT,
        park: { kind: "awaiting-approval", reason: null, inbox_owner: "edanisko", globs_held: [EPICS_MD], graph_posted: hash },
      });
      const p = plan({ records: [g], prs: { "planning:graph.1": open(4) } });
      expect(p.takeApproved.map((t) => [t.parked_at, t.graph_posted])).toEqual([[PARKED_AT, hash]]);
      expect(approvalOf(p, 30)).toEqual([false]);
      expect(approvalOf(p, 10)).toEqual([true]);
    });

    test("a first park with no graph_posted keeps today's rule: parked_at null, an approval given while CI ran counts", () => {
      const p = plan({ records: [awaiting()], prs: { "story:2.1": open(7) } });
      expect(p.takeApproved.map((t) => t.parked_at)).toEqual([null]);
      expect(approvalOf(p, 30)).toEqual([true]);
    });
  });

  test("a parked reconcile record awaiting approval is a candidate of any kind; its open PR still stops a new one", () => {
    const r3 = coord("reconcile:3", { state: "parked", pr: 3, pr_owner: COORD.owner, head_sha: HEAD, park: { kind: "awaiting-approval", reason: null, inbox_owner: COORD.owner, globs_held: [STATUS] } });
    const p = plan({ records: [r3], prs: { "reconcile:3": open(3) } });
    expect(shape(p)).toEqual({ ...EMPTY, takeApproved: ["reconcile:3"], openPrs: ["reconcile:3"] });
  });

  test.each([
    ["parked needs-approval", awaiting({ park: { kind: "needs-approval", reason: null, inbox_owner: "alice", globs_held: [] } }), open(7)],
    ["parked blocked", awaiting({ park: { kind: "blocked", reason: "verification", inbox_owner: "alice", globs_held: [] } }), open(7)],
    ["its PR closed", awaiting(), closed(7)],
    ["its head moved since the park", awaiting(), { number: 7, state: "open", head_sha: OTHER } as PrState],
    ["no pr_owner", awaiting({ pr_owner: null }), open(7)],
    ["no head_sha", awaiting({ head_sha: null }), open(7)],
    ["no PR state in the snapshot", awaiting(), undefined],
  ] as const)("not a candidate: %s", (_name, record, pr) => {
    const p = plan({ records: [record], prs: pr === undefined ? {} : { "story:2.1": pr } });
    expect(p.takeApproved).toEqual([]);
    expect(p.checkGated).toEqual([]);
  });

  test("a parked record whose PR merged is marked merged, not a candidate", () => {
    const p = plan({ records: [awaiting()], prs: { "story:2.1": merged(7) }, status: { "2.1": "backlog" } });
    expect(shape(p)).toEqual({ ...EMPTY, markMerged: ["story:2.1"], status: "edit" });
  });

  test("this run's own record is never a candidate", () => {
    const own = coord(U, { state: "parked", pr: 5, pr_owner: COORD.owner, head_sha: HEAD, park: { kind: "awaiting-approval", reason: null, inbox_owner: COORD.owner, globs_held: [STATUS] } });
    const w: World = { epics: { 1: [] }, bootstrapped: [1], role: "coordinator", records: [own], prs: { [U]: { number: 5, state: "open", head_sha: HEAD } } };
    expect(planReconcile(snapshotOf(w), U, input(w).files[STATUS] as string).takeApproved).toEqual([]);
  });

  test("a coordinator-held merging Story is checked as gated, with its approved head and diff paths", () => {
    const p = plan({ records: [gated()], prs: { "story:2.1": open(7) } });
    expect(shape(p)).toEqual({ ...EMPTY, checkGated: ["story:2.1"] });
    expect(p.checkGated).toEqual([{ unit: "story:2.1", generation: 2, pr: 7, pr_owner: "alice", head_sha: HEAD, approved_sha: HEAD, approved_graph: null, enqueued_sha: HEAD, globs: ["src/2.1/a.ts"] }]);
  });

  test("a taken record the runner never enqueued carries its null enqueued_sha to the gated check, whatever its passed_sha", () => {
    const p = plan({ records: [gated({ enqueued_sha: null, passed_sha: HEAD })], prs: { "story:2.1": open(7) } });
    expect(p.checkGated.map((t) => [t.unit, t.enqueued_sha])).toEqual([["story:2.1", null]]);
  });

  test("a taken graph change carries its approved_graph to the gated check, for a re-take to compare", () => {
    const hash = `sha256:${"c".repeat(64)}`;
    const p = plan({ records: [gated({ enqueued_sha: null, globs: ["src/2.1/a.ts", "xarabot:graph"], approved_graph: hash })], prs: { "story:2.1": open(7) } });
    expect(p.checkGated.map((t) => [t.unit, t.approved_graph])).toEqual([["story:2.1", hash]]);
  });

  test.each([
    ["an ungated retro", coord("retro:2", { state: "merging", pr: 9, pr_owner: COORD.owner, head_sha: HEAD, passed_sha: HEAD }), "retro:2"],
    ["an ungated retro item", coord("retro-item:epic-2-retro-item-1-fix", { state: "merging", globs: ["src/x/**"], pr: 9, pr_owner: COORD.owner, head_sha: HEAD, passed_sha: HEAD }), "retro-item:epic-2-retro-item-1-fix"],
  ] as const)("%s merging under the coordinator is checked as ungated, never as gated", (_name, record, unit) => {
    const p = plan({ records: [record], prs: { [unit]: open(9) } });
    expect(shape(p)).toEqual({ ...EMPTY, checkUngated: [unit] });
    expect(p.checkUngated).toEqual([{ unit, generation: 1, pr: 9, pr_state: "open", head_sha: HEAD }]);
  });

  test("a retro item taken on an approval (approved_sha set) is checked as gated", () => {
    const unit = "retro-item:epic-2-retro-item-1-fix";
    const p = plan({ records: [coord(unit, { state: "merging", generation: 2, globs: ["src/x/a.ts"], pr: 9, pr_owner: COORD.owner, head_sha: HEAD, passed_sha: HEAD, approved_sha: HEAD })], prs: { [unit]: open(9) } });
    expect(shape(p)).toEqual({ ...EMPTY, checkGated: [unit] });
  });

  test.each([
    ["a builder-held merging Story", storyRec("2.1", { state: "merging", pr: 7, pr_owner: "alice", head_sha: HEAD, passed_sha: HEAD }), { "story:2.1": open(7) }],
    ["a gated record whose PR merged (marked merged instead)", gated(), { "story:2.1": merged(7) }],
    ["a gated record with no PR", gated({ pr: null }), {}],
  ] as const)("not gated: %s", (_name, record, prs) => {
    expect(plan({ records: [record], prs, status: { "2.1": "backlog" } }).checkGated).toEqual([]);
  });

  test("a coordinator-held merging reconcile record is in checkQueue, not checkGated", () => {
    const p = plan({ records: [coord("reconcile:3", { state: "merging", pr: 3, head_sha: HEAD, passed_sha: HEAD, approved_sha: HEAD })], prs: { "reconcile:3": open(3) } });
    expect(shape(p)).toEqual({ ...EMPTY, checkQueue: ["reconcile:3"], openPrs: ["reconcile:3"] });
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

describe("planReconcile: planning records (Story 2.7)", () => {
  const STATUS_GLOBS = [STATUS, "_bmad-output/implementation-artifacts/retro-gates.yaml", "_bmad-output/implementation-artifacts/epic-*-context.md"];
  const graphGlobs = [EPICS_MD, GRAPH_PSEUDO_GLOB];
  const status = (over: Partial<UnitRecord> = {}) => coord("planning:status.2", { globs: STATUS_GLOBS, pr: 6, pr_owner: COORD.owner, head_sha: HEAD, ...over });
  const graph = (over: Partial<UnitRecord> = {}) => coord("planning:graph.1", { globs: graphGlobs, pr: 6, pr_owner: COORD.owner, head_sha: HEAD, ...over });

  test("the matrix: an ungated status PR (merging, approved_sha null) is disposable: its queue is checked", () => {
    const p = plan({ records: [status({ state: "merging", passed_sha: HEAD })], prs: { "planning:status.2": open(6) } });
    expect(shape(p)).toEqual({ ...EMPTY, checkQueue: ["planning:status.2"] });
    expect(p.checkQueue[0]).toEqual({ unit: "planning:status.2", generation: 1, pr: 6, pr_state: "open", head_sha: HEAD });
  });

  test("the matrix: a gated graph PR (merging, approved_sha set) is checked as gated, keeping 2.6's re-park", () => {
    const p = plan({ records: [graph({ state: "merging", generation: 2, passed_sha: HEAD, approved_sha: HEAD })], prs: { "planning:graph.1": open(6) } });
    expect(shape(p)).toEqual({ ...EMPTY, checkGated: ["planning:graph.1"] });
  });

  test("a status PR the coordinator took on approval (approved_sha set) is gated, not disposable", () => {
    const p = plan({ records: [status({ state: "merging", generation: 2, passed_sha: HEAD, approved_sha: HEAD })], prs: { "planning:status.2": open(6) } });
    expect(shape(p)).toEqual({ ...EMPTY, checkGated: ["planning:status.2"] });
  });

  test("a planning PR is never named among the open reconcile PRs", () => {
    const p = plan({ records: [status({ state: "merging", passed_sha: HEAD })], prs: { "planning:status.2": open(6) } });
    expect(p.openPrs).toEqual([]);
  });

  test.each([
    ["status, its PR closed", status({ state: "released" }), { "planning:status.2": closed(6) }, ["planning:status.2"]],
    ["status, no PR", status({ state: "released", pr: null, head_sha: null }), {}, ["planning:status.2"]],
    ["graph, its PR closed", graph({ state: "released" }), { "planning:graph.1": closed(6) }, ["planning:graph.1"]],
    ["status, its PR open (the open-PR position resumes it)", status({ state: "released" }), { "planning:status.2": open(6) }, []],
    ["graph, its PR open", graph({ state: "released" }), { "planning:graph.1": open(6) }, []],
  ] as const)("the matrix: a released planning record, %s", (_name, record, prs, want) => {
    expect(plan({ records: [record], prs }).deleteReleased.map((t) => t.unit)).toEqual([...want]);
  });

  test.each([
    ["parked blocked readiness", { state: "parked", park: { kind: "blocked", reason: "readiness", inbox_owner: "carol", globs_held: [] } }],
    ["live claimed", { state: "claimed" }],
    ["stale claimed (next takes it over)", { state: "claimed", heartbeat_at: minutesBefore(45) }],
  ] as const)("a planning record %s is left alone", (_name, over) => {
    const p = plan({ records: [status({ pr: null, head_sha: null, ...over } as Partial<UnitRecord>)] });
    expect(shape(p)).toEqual(EMPTY);
  });
});

describe("planReconcile: retro-gates.yaml (Story 2.9)", () => {
  const RESULT = {
    verdict: "accepted-with-open-items" as const,
    items: [
      { id: "epic-2-retro-item-1-fix", text: "Fix it", route: "lane" as const, blocking: true, globs: ["./src/x/**"] },
      { id: "epic-2-retro-item-2-ask", text: "Ask the Maintainer", route: "maintainer" as const, blocking: false, globs: [] },
    ],
  };
  const retroRec = (over: Partial<UnitRecord> = {}) => coord("retro:2", { state: "merging", pr: 9, head_sha: HEAD, passed_sha: HEAD, retro_result: RESULT, ...over });
  /** The forge reports every record's PR: retro:2's merged at the record's head unless `w.prs` says otherwise (`undefined`: none). */
  const planWith = (w: Partial<World>) => {
    const prs = Object.entries({ "retro:2": merged(9), ...w.prs }).filter(([, pr]) => pr !== undefined);
    const full = world({ ...w, prs: Object.fromEntries(prs) });
    const files = input(full).files;
    const text = (p: string) => (Object.hasOwn(files, p) ? (files[p] as string) : null);
    return planReconcile(snapshotOf(full), U, text(STATUS), text(RETRO));
  };

  test("retro:2 merged with a result, the file absent: a new file with schema_version 1, the verdict, the lane item open and the Maintainer item waiting (Story 4.3)", () => {
    const p = planWith({ records: [retroRec()], prs: { "retro:2": merged(9) } });
    expect(p.markMerged).toEqual(["retro:2"]);
    expect(p.deleteMerged).toEqual([]);
    expect(p.retroGatesPath).toBe(RETRO);
    if (p.retroGates.kind !== "edit") throw new Error(`expected an edit, got ${p.retroGates.kind}`);
    const parsed = parseRetroGates(RETRO, p.retroGates.text);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value).toEqual({
      schema_version: 1,
      epics: {
        "2": {
          retro: { verdict: "accepted-with-open-items", unit: "retro:2", recorded_at: NOW },
          items: [
            { id: "epic-2-retro-item-1-fix", text: "Fix it", route: "lane", blocking: true, globs: ["src/x/**"], status: "open" },
            { id: "epic-2-retro-item-2-ask", text: "Ask the Maintainer", route: "maintainer", blocking: false, globs: [], status: "waiting" },
          ],
        },
      },
    });
    expect(p.retroGates.summary).toEqual([
      "epics.2.retro: accepted-with-open-items (retro:2)",
      "epics.2.items: epic-2-retro-item-1-fix added as open",
      "epics.2.items: epic-2-retro-item-2-ask added as waiting",
    ]);
  });

  test("a rejected verdict is written like any other, with no go", () => {
    const p = planWith({ records: [retroRec({ state: "merged", retro_result: { verdict: "rejected", items: [] } })] });
    if (p.retroGates.kind !== "edit") throw new Error(p.retroGates.kind);
    const parsed = parseRetroGates(RETRO, p.retroGates.text);
    expect(parsed.ok && parsed.value.epics["2"]).toEqual({ retro: { verdict: "rejected", unit: "retro:2", recorded_at: NOW } });
  });

  test("an existing file keeps its other Epics and a hand-recorded go", () => {
    const p = planWith({ retro: { 1: "rejected-go" }, records: [retroRec({ state: "merged" })] });
    if (p.retroGates.kind !== "edit") throw new Error(p.retroGates.kind);
    const parsed = parseRetroGates(RETRO, p.retroGates.text);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.epics["1"]?.retro?.go).toEqual({ by: "edanisko", at: "2026-10-21T00:00:00Z", ruling: "maintainer-pr" });
    expect(Object.keys(parsed.value.epics)).toEqual(["1", "2"]);
  });

  test("recorded once: an Epic with a retro entry on main is not written again, and the record is done on main", () => {
    const p = planWith({ retro: { 2: "accepted" }, records: [retroRec({ state: "merged" })] });
    expect(p.retroGates).toEqual({ kind: "none" });
    expect(p.deleteMerged).toEqual(["retro:2"]);
  });

  test("a retro record not merged as of the run writes nothing", () => {
    expect(planWith({ records: [retroRec()], prs: { "retro:2": open(9) } }).retroGates).toEqual({ kind: "none" });
  });

  test("a merged retro record with no retro_result is listed and skipped", () => {
    const p = planWith({ records: [retroRec({ state: "merged", retro_result: null })] });
    expect(p.retroGates).toEqual({ kind: "none" });
    expect(p.retroWithoutResult).toEqual(["retro:2"]);
  });

  const MOVED = "f".repeat(40);
  test.each([
    ["its PR merged this run at a head that moved past the validated one", { state: "merging" }, { number: 9, state: "merged", head_sha: MOVED }],
    ["merged on the ledger, its PR merged at a head that moved past the validated one", { state: "merged" }, { number: 9, state: "merged", head_sha: MOVED }],
    ["merged on the ledger, the forge reporting no PR", { state: "merged" }, undefined],
    ["merged on the ledger, the snapshot's PR another one", { state: "merged" }, { number: 10, state: "merged", head_sha: HEAD }],
  ] as const)("the result is not bound to the merged head: %s; nothing written, listed and skipped (C1)", (_name, over, pr) => {
    const p = planWith({ records: [retroRec(over)], prs: { "retro:2": pr as PrState } });
    expect(p.retroGates).toEqual({ kind: "none" });
    expect(p.retroWithoutResult).toEqual(["retro:2"]);
    expect(p.deleteMerged).not.toContain("retro:2");
  });

  test("an invalid retro-gates.yaml text: the plan is invalid", () => {
    const full = world({ records: [retroRec({ state: "merged" })], prs: { "retro:2": merged(9) } });
    const files = input(full).files;
    const p = planReconcile(snapshotOf(full), U, files[STATUS] as string, "schema_version: 1\nepics: [\n");
    expect(p.retroGates.kind).toBe("invalid");
  });

  test("an item already listed is not appended again; the new Maintainer item is written waiting", () => {
    const listed = [
      "schema_version: 1",
      "epics:",
      '  "2":',
      "    items:",
      '      - id: "epic-2-retro-item-1-fix"',
      "        text: Fix it",
      "        route: lane",
      "        blocking: true",
      "        globs: []",
      "        status: done",
      "",
    ].join("\n");
    const p = planWith({ files: { [RETRO]: listed }, records: [retroRec({ state: "merged" })] });
    if (p.retroGates.kind !== "edit") throw new Error(p.retroGates.kind);
    const parsed = parseRetroGates(RETRO, p.retroGates.text);
    expect(parsed.ok && parsed.value.epics["2"]?.items?.map((i) => [i.id, i.status])).toEqual([
      ["epic-2-retro-item-1-fix", "done"],
      ["epic-2-retro-item-2-ask", "waiting"],
    ]);
  });

  test("a Maintainer item already listed open keeps open (Story 4.3)", () => {
    const listed = [
      "schema_version: 1",
      "epics:",
      '  "2":',
      "    items:",
      '      - id: "epic-2-retro-item-2-ask"',
      "        text: Ask the Maintainer",
      "        route: maintainer",
      "        blocking: false",
      "        globs: []",
      "        status: open",
      "",
    ].join("\n");
    const p = planWith({ files: { [RETRO]: listed }, records: [retroRec({ state: "merged" })] });
    if (p.retroGates.kind !== "edit") throw new Error(p.retroGates.kind);
    const parsed = parseRetroGates(RETRO, p.retroGates.text);
    expect(parsed.ok && parsed.value.epics["2"]?.items?.map((i) => [i.id, i.status])).toEqual([
      ["epic-2-retro-item-2-ask", "open"],
      ["epic-2-retro-item-1-fix", "open"],
    ]);
    expect(p.retroGates.summary).toEqual(["epics.2.retro: accepted-with-open-items (retro:2)", "epics.2.items: epic-2-retro-item-1-fix added as open"]);
  });

  test("both files change in one run", () => {
    const p = planWith({ records: [retroRec({ state: "merged" }), storyRec("2.1", { state: "parked", pr: 7 })], prs: { "story:2.1": merged(7) }, status: { "2.1": "backlog" } });
    expect([p.status.kind, p.retroGates.kind]).toEqual(["edit", "edit"]);
  });
});

describe("planReconcile: retro items done (Story 2.10)", () => {
  const X = "epic-2-retro-item-1-fix-x";
  const UNIT_X = `retro-item:${X}`;
  const gatesWith = (status: string) =>
    [
      "schema_version: 1",
      "epics:",
      '  "2":',
      "    retro:",
      "      verdict: accepted-with-open-items",
      '      unit: "retro:2"',
      "      recorded_at: 2026-10-20T00:00:00Z",
      "    items:",
      `      - id: ${X}`,
      "        text: Fix x",
      "        route: lane",
      "        blocking: false",
      '        globs: ["src/x/**"]',
      `        status: ${status}`,
      "",
    ].join("\n");
  const itemRec = (over: Partial<UnitRecord> = {}) => coord(UNIT_X, { state: "merging", globs: ["src/x/**"], pr: 9, head_sha: HEAD, passed_sha: HEAD, ...over });
  const planWith = (w: Partial<World>) => {
    const full = world(w);
    const files = input(full).files;
    const text = (p: string) => (Object.hasOwn(files, p) ? (files[p] as string) : null);
    return planReconcile(snapshotOf(full), U, text(STATUS), text(RETRO));
  };
  const statusOf = (p: ReconcilePlan) => {
    if (p.retroGates.kind !== "edit") return p.retroGates.kind;
    const parsed = parseRetroGates(RETRO, p.retroGates.text);
    return parsed.ok ? parsed.value.epics["2"]?.items?.[0]?.status : `unparsed: ${parsed.error.message}`;
  };

  test("its PR merged this run, the item open: marked merged and the item set done; the record is not deleted yet", () => {
    const p = planWith({ files: { [RETRO]: gatesWith("open") }, records: [itemRec()], prs: { [UNIT_X]: merged(9) } });
    expect(p.markMerged).toEqual([UNIT_X]);
    expect(statusOf(p)).toBe("done");
    expect(p.retroGates.kind === "edit" ? p.retroGates.summary : []).toEqual([`epics.2.items: ${X} open -> done`]);
    expect(p.deleteMerged).not.toContain(UNIT_X);
    expect(p.retroItemsMissing).toEqual([]);
  });

  test("merged on the ledger, the item deferred: set done", () => {
    const p = planWith({ files: { [RETRO]: gatesWith("deferred") }, records: [itemRec({ state: "merged" })] });
    expect(statusOf(p)).toBe("done");
    expect(p.retroGates.kind === "edit" ? p.retroGates.summary : []).toEqual([`epics.2.items: ${X} deferred -> done`]);
  });

  test("the next run, the item done on main: no write, and the record is deleted", () => {
    const p = planWith({ files: { [RETRO]: gatesWith("done") }, records: [itemRec({ state: "merged" })] });
    expect(p.retroGates).toEqual({ kind: "none" });
    expect(p.deleteMerged).toContain(UNIT_X);
  });

  test("not merged as of the run: nothing written", () => {
    const p = planWith({ files: { [RETRO]: gatesWith("open") }, records: [itemRec()], prs: { [UNIT_X]: open(9) } });
    expect(p.retroGates).toEqual({ kind: "none" });
  });

  test("the item absent from retro-gates.yaml: listed as missing and skipped", () => {
    const p = planWith({ records: [itemRec({ state: "merged" })] });
    expect(p.retroGates).toEqual({ kind: "none" });
    expect(p.retroItemsMissing).toEqual([UNIT_X]);
    expect(p.deleteMerged).not.toContain(UNIT_X);
  });

  test("in the same rewrite as a merged retro's additions", () => {
    const retro3 = coord("retro:3", { state: "merged", pr: 10, head_sha: HEAD, retro_result: { verdict: "accepted", items: [{ id: "epic-3-retro-item-1-z", text: "Z", route: "lane", blocking: false, globs: ["src/z/**"] }] } });
    const p = planWith({ epics: { 1: [], 2: ["1", "2"], 3: ["1"] }, files: { [RETRO]: gatesWith("open") }, records: [itemRec({ state: "merged" }), retro3], prs: { "retro:3": merged(10) } });
    if (p.retroGates.kind !== "edit") throw new Error(p.retroGates.kind);
    expect(p.retroGates.summary).toEqual(["epics.3.retro: accepted (retro:3)", "epics.3.items: epic-3-retro-item-1-z added as open", `epics.2.items: ${X} open -> done`]);
    expect(statusOf(p)).toBe("done");
  });
});

describe("planReconcile: pending rulings (Story 4.6)", () => {
  const X = "epic-2-retro-item-1-x";
  const GATES = ["schema_version: 1", "epics:", '  "2":', "    retro:", "      verdict: rejected", '      unit: "retro:2"', "      recorded_at: 2026-10-20T00:00:00Z", "    items:", `      - id: ${X}`, "        text: Fix x", "        route: maintainer", "        blocking: false", "        globs: []", "        status: waiting", ""].join("\n");
  const at = "2026-10-22T09:00:00Z";
  const BLOCK = { verb: "block" as const, unit: `retro-item:${X}`, by: "edanisko", at, ruling: "5" };
  const GO = { verb: "go" as const, unit: "retro:2", by: "edanisko", at, ruling: "6" };
  const claim = (pending: readonly (typeof BLOCK | typeof GO)[]) => ({
    schema_version: 6 as const,
    owner: COORD.owner,
    host: COORD.host,
    lane: "coordinator" as const,
    generation: 1,
    heartbeat_at: NOW,
    digest_posted_at: null,
    rulings_cursor: null,
    pending_rulings: [...pending],
  });
  const planWith = (w: Partial<World>, pending?: Parameters<typeof planReconcile>[4]) => {
    const full = world({ files: { [RETRO]: GATES }, ...w });
    const files = input(full).files;
    const text = (p: string) => (Object.hasOwn(files, p) ? (files[p] as string) : null);
    return planReconcile(snapshotOf(full), U, text(STATUS), text(RETRO), pending);
  };

  test("only pending rulings, from the snapshot's coordinator.json by default: an edit carrying each, in order", () => {
    const p = planWith({ coordinator: claim([BLOCK, GO]) });
    if (p.retroGates.kind !== "edit") throw new Error(p.retroGates.kind);
    expect(p.retroGates.summary).toEqual([`epics.2.items: ${X} blocking false -> true`, "epics.2.retro: go by edanisko (6)"]);
    const parsed = parseRetroGates(RETRO, p.retroGates.text);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.epics["2"]?.retro?.go).toEqual({ by: "edanisko", at, ruling: "6" });
    expect(parsed.value.epics["2"]?.items?.[0]?.blocking).toBe(true);
  });

  test("a pending list passed in replaces the snapshot's", () => {
    const p = planWith({ coordinator: claim([BLOCK]) }, [GO]);
    expect(p.retroGates.kind === "edit" ? p.retroGates.summary : p.retroGates.kind).toEqual(["epics.2.retro: go by edanisko (6)"]);
  });

  test("only rulings main already shows: none", () => {
    const shown = GATES.replace("blocking: false", "blocking: true");
    expect(planWith({ files: { [RETRO]: shown }, coordinator: claim([BLOCK]) }).retroGates).toEqual({ kind: "none" });
    expect(planWith({}, []).retroGates).toEqual({ kind: "none" });
  });

  test("a ruling with nothing to apply to (the file absent) changes nothing: none", () => {
    expect(planWith({ files: { [RETRO]: null }, coordinator: claim([BLOCK]) }).retroGates).toEqual({ kind: "none" });
  });
});
