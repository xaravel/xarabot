import { describe, expect, test } from "bun:test";
import { claim } from "../../../src/core/ledger/edits.ts";
import {
  coordinatorGlobs,
  digestDue,
  doneOnMain,
  GRAPH_PSEUDO_GLOB,
  isCoordinatorKind,
  maintainerApproved,
  missingStatusEntries,
  newestMergedReconcile,
  nextCoordinator,
  nextPlanningNumber,
  planningDue,
  planningNumber,
  planningSlug,
  reconcileDue,
  retroCandidates,
  retroDue,
  retroItemCandidates,
  retroItemUnit,
  unitBranch,
  WAITING_ON_MAINTAINER,
  type CoordinatorUnitSpec,
} from "../../../src/core/next/coordinator.ts";
import { next, type NextOutcome } from "../../../src/core/next/next.ts";
import { CONFIG_DEFAULTS } from "../../../src/core/schemas/config.ts";
import { planningKindOf, UNIT_KINDS, unitKind, type CoordinatorRecord, type UnitRecord } from "../../../src/core/schemas/ledger.ts";
import type { PrState } from "../../../src/core/schemas/snapshot.ts";
import { ALICE, COORD, tip } from "../ledger/fixtures.ts";
import { AUTHORITY, CONFIG_PATH, contextPath, EPICS_MD, input, NOW, RETRO, STATUS, rec, snapshotOf, storyRec, type World } from "./fixtures.ts";

// NOW is 2026-10-22T10:10:00Z: past the default 08:00 digest slot.
const TODAY_DIGEST = "2026-10-22T08:00:00Z";
const minutesBefore = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();
const HEAD = "e".repeat(40);

/** A live coordinator claim whose digest is posted for today, so the digest slot is no work. */
function coordinator(over: Partial<CoordinatorRecord> = {}): CoordinatorRecord {
  return {
    schema_version: 2,
    owner: COORD.owner,
    host: COORD.host,
    lane: "coordinator",
    generation: 1,
    heartbeat_at: NOW,
    digest_posted_at: TODAY_DIGEST,
    rulings_cursor: null,
    ...over,
  };
}

/** A coordinator-held record for `unit`. */
function coord(unit: string, over: Partial<UnitRecord> = {}): UnitRecord {
  return rec({ unit, owner: COORD.owner, host: COORD.host, lane: COORD.lane, globs: [], heartbeat_at: NOW, ...over });
}

/** A `reconcile:<n>` record merged `minutes` ago. */
const reconciled = (n: number, minutes: number) => coord(`reconcile:${n}`, { state: "merged", heartbeat_at: minutesBefore(minutes) });
/** The latest reconcile ran 1 min ago: not due on time alone. */
const RECENT = reconciled(4, 1);
/** A digest slot 5 min before NOW (10:05), and the latest reconcile run 9 min ago, before it. */
const SLOT_TIME = "10:05";
const BEFORE_SLOT = reconciled(4, 9);

const open = (n: number): PrState => ({ number: n, state: "open", head_sha: HEAD });
const merged = (n: number): PrState => ({ number: n, state: "merged", head_sha: HEAD });

const STATUS_GLOBS = [STATUS, RETRO, "_bmad-output/implementation-artifacts/epic-*-context.md"];

/** Every status entry of the default world: no status planning due. */
const PLANNED = { "epic-2": "backlog", "2.1": "backlog" } as const;

/** Epic 1 bootstrapped, Epic 2 with Story 2.1 eligible and in sprint status; the coordinator's view. */
function world(extra: Partial<World> = {}): World {
  return { epics: { 1: [], 2: ["1"] }, bootstrapped: [1], role: "coordinator", coordinator: coordinator(), status: PLANNED, ...extra };
}

const pickC = (w: Partial<World>) => next(snapshotOf(world(w)), "coordinator");

/** `unit <id>`, or the outcome kind. */
function picked(o: NextOutcome): string {
  if (o.kind === "coordinator") return `unit ${o.unit.unit}`;
  if (o.kind === "unit" || o.kind === "park") return `story ${o.story.story_id}`;
  return o.kind;
}

const reasonOf = (o: NextOutcome) => (o.kind === "idle" ? o.reason : `not idle: ${o.kind}`);

describe("next(coordinator): reconcile", () => {
  test.each([
    ["no reconcile run on the ledger", {}, "unit reconcile:1"],
    ["work shown: a parked Story whose PR merged", { records: [RECENT, storyRec("2.1", { state: "parked", pr: 7 })], prs: { "story:2.1": merged(7) } }, "unit reconcile:5"],
    [
      "work shown: a merged record whose unit is done on main",
      { records: [RECENT, storyRec("2.1", { state: "merged", pr: 7 })], status: { "2.1": "done" } },
      "unit reconcile:5",
    ],
    // Story 4.2: the 10:05 slot passed at 10:10; the last run, 9 min ago (10:01), was before it.
    ["a passed digest slot, unposted, is work (Story 4.2)", { records: [BEFORE_SLOT], digestTime: SLOT_TIME, coordinator: coordinator({ digest_posted_at: null }) }, "unit reconcile:5"],
    ["a digest last posted yesterday is work (Story 4.2)", { records: [BEFORE_SLOT], digestTime: SLOT_TIME, coordinator: coordinator({ digest_posted_at: "2026-10-21T08:00:00Z" }) }, "unit reconcile:5"],
    ["a digest posted today after the slot is no work", { records: [BEFORE_SLOT], digestTime: SLOT_TIME, coordinator: coordinator({ digest_posted_at: "2026-10-22T10:06:00Z" }) }, "idle"],
    ["a digest posted today just before the slot is work", { records: [BEFORE_SLOT], digestTime: SLOT_TIME, coordinator: coordinator({ digest_posted_at: "2026-10-22T10:04:59Z" }) }, "unit reconcile:5"],
    ["no coordinator.json: the slot passed with no digest posted is work", { records: [BEFORE_SLOT], digestTime: SLOT_TIME, coordinator: null }, "unit reconcile:5"],
    [
      "slot passed, unposted, last run after the slot and under 10 min ago: not due (a run failed to stamp)",
      { records: [RECENT], coordinator: coordinator({ digest_posted_at: "2026-10-21T08:00:00Z" }), digestTime: SLOT_TIME },
      "idle",
    ],
    [
      "slot passed, unposted, last run before the slot: due",
      { records: [BEFORE_SLOT], coordinator: coordinator({ digest_posted_at: "2026-10-21T08:00:00Z" }), digestTime: SLOT_TIME },
      "unit reconcile:5",
    ],
    ["under 10 min, no work: not due", { records: [reconciled(4, 9)] }, "idle"],
    ["the last run is the newest merged one: a newer merging run does not count", { records: [reconciled(4, 12), coord("reconcile:5", { state: "merging", passed_sha: HEAD })] }, "unit reconcile:6"],
    ["a newer merging run does not make an older recent run stale", { records: [RECENT, coord("reconcile:5", { state: "merging", passed_sha: HEAD, heartbeat_at: minutesBefore(40) })] }, "idle"],
    ["no merged run, only a released one: due, numbered past it", { records: [coord("reconcile:7", { state: "released", heartbeat_at: minutesBefore(1) })] }, "unit reconcile:8"],
    ["n is the highest number of any state, plus 1", { records: [reconciled(4, 12), coord("reconcile:9", { state: "parked", park: { kind: "blocked", reason: "verification", inbox_owner: "carol", globs_held: [] } })] }, "unit reconcile:10"],
    ["exactly 10 min since the newest run: due", { records: [reconciled(4, 10)] }, "unit reconcile:5"],
    ["an older merged reconcile record is work (done on main)", { records: [reconciled(3, 20), RECENT] }, "unit reconcile:5"],
    ["the newest by number, not by name: reconcile:10 after reconcile:9", { records: [reconciled(10, 12)] }, "unit reconcile:11"],
    ["a merged Story not done on main is no work", { records: [RECENT, storyRec("2.1", { state: "merged", pr: 7 })] }, "idle"],
    ["a merged record whose PR merged is no work", { records: [RECENT, storyRec("2.1", { state: "merged", pr: 7 })], prs: { "story:2.1": merged(7) } }, "idle"],
  ] as const)("%s → %s", (_name, w, want) => {
    expect(picked(pickC(w as Partial<World>))).toBe(want);
  });

  test("the reconcile unit holds no globs, has no generation, takeover or PR, and says why", () => {
    const o = pickC({ records: [reconciled(4, 10)] });
    expect(o).toEqual({
      kind: "coordinator",
      unit: {
        unit: "reconcile:5",
        kind: "reconcile",
        globs: [],
        expect_generation: null,
        take_over: null,
        pr: null,
        why: `reconcile:4 ran at ${reconciled(4, 10).heartbeat_at}, 10 min or more ago`,
      },
      reasons: [],
    });
  });

  test("not due: a reason is added and a later position is returned", () => {
    const o = pickC({ records: [RECENT, coord("planning:status.1", { state: "released", pr: 9, globs: STATUS_GLOBS })], prs: { "planning:status.1": open(9) } });
    expect(picked(o)).toBe("unit planning:status.1");
    expect(o.kind === "coordinator" ? o.reasons.map((r) => r.code) : []).toEqual(["reconcile-not-due"]);
  });

  test("a configured digest_time not yet reached (11:30 at 10:10), never posted: not due", () => {
    const w = world({ records: [RECENT], digestTime: "11:30", coordinator: coordinator({ digest_posted_at: null }) });
    expect(picked(next(snapshotOf(w), "coordinator"))).toBe("idle");
    expect(reconcileDue(snapshotOf(w)).due).toBe(false);
  });

  test("a configured digest_time already passed (10:05), last posted at 08:00, last run before it: due, saying why (Story 4.2)", () => {
    const w = world({ records: [BEFORE_SLOT], digestTime: SLOT_TIME });
    expect(picked(next(snapshotOf(w), "coordinator"))).toBe("unit reconcile:5");
    expect(reconcileDue(snapshotOf(w))).toMatchObject({ due: true, why: "the digest slot 2026-10-22T10:05:00.000Z passed with no digest posted (last 2026-10-22T08:00:00Z)" });
  });

  test("a run after the slot that failed to stamp: the 10-min rule applies again", () => {
    const w = world({ records: [RECENT], digestTime: "09:00" });
    expect(reconcileDue(snapshotOf(w)).due).toBe(false);
    expect(reconcileDue(snapshotOf(world({ records: [reconciled(4, 10)], digestTime: "09:00" }))).due).toBe(true);
  });

  test("reconcileDue reports the last run: the newest merged reconcile record", () => {
    const r = reconcileDue(snapshotOf(world({ records: [reconciled(4, 9)] })));
    expect(r.due).toBe(false);
    expect(r.last?.unit).toBe("reconcile:4");
    expect(reconcileDue(snapshotOf(world())).last).toBeNull();
    const later = reconcileDue(snapshotOf(world({ records: [reconciled(4, 9), coord("reconcile:5", { state: "merging", passed_sha: HEAD })] })));
    expect(later.last?.unit).toBe("reconcile:4");
    expect(newestMergedReconcile(snapshotOf(world({ records: [coord("reconcile:5", { state: "released" })] })))).toBeNull();
  });

  test("no merged run: due, saying so", () => {
    const o = pickC({ records: [coord("reconcile:2", { state: "merging", passed_sha: HEAD })] });
    expect(o.kind === "coordinator" ? [o.unit.unit, o.unit.why] : null).toEqual(["reconcile:3", "no merged reconcile run on the ledger"]);
  });
});

describe("next(coordinator): reconcile on the Maintainer's approval (retro item 13)", () => {
  const MAINTAINER = "edanisko";
  const OTHER_HEAD = "f".repeat(40);
  const PARKED_AT = minutesBefore(30);
  /** Story 2.1 parked awaiting approval at `HEAD` with PR #7, by its builder. */
  const awaiting = (over: Partial<UnitRecord> = {}): UnitRecord =>
    storyRec("2.1", {
      state: "parked",
      pr: 7,
      pr_owner: "alice",
      head_sha: HEAD,
      passed_sha: HEAD,
      heartbeat_at: PARKED_AT,
      park: { kind: "awaiting-approval", reason: null, inbox_owner: "alice", globs_held: ["docs/x.md"] },
      ...over,
    });
  const review = (author: string | null, commit: string | null, minutesAgo: number, state: "approved" | "changes_requested" | "dismissed" = "approved") => ({
    author,
    state,
    commit_sha: commit,
    submitted_at: minutesBefore(minutesAgo),
  });
  const openWith = (reviews: PrState["reviews"], head = HEAD): PrState => ({ number: 7, state: "open", head_sha: head, ...(reviews === undefined ? {} : { reviews }) });
  const dueFor = (record: UnitRecord, pr: PrState) => reconcileDue(snapshotOf(world({ records: [RECENT, record], prs: { "story:2.1": pr } })));

  test("the Maintainer's approval at the parked head: due in this round, saying why", () => {
    const w = world({ records: [RECENT, awaiting()], prs: { "story:2.1": openWith([review(MAINTAINER, HEAD, 5)]) } });
    const o = next(snapshotOf(w), "coordinator");
    expect(o.kind === "coordinator" ? [o.unit.unit, o.unit.why] : null).toEqual([
      "reconcile:5",
      `story:2.1 is parked awaiting approval and the Maintainer approved PR #7 at ${HEAD}`,
    ]);
  });

  test.each([
    ["the Maintainer's approval at another head", openWith([review(MAINTAINER, OTHER_HEAD, 5)])],
    ["an approval at the parked head by another login (the PR owner)", openWith([review("alice", HEAD, 5)])],
    ["no review", openWith([])],
    ["no reviews read", openWith(undefined)],
    ["the Maintainer requested changes at the parked head", openWith([review(MAINTAINER, HEAD, 5, "changes_requested")])],
    ["the Maintainer's approval was dismissed", openWith([review(MAINTAINER, HEAD, 5, "dismissed")])],
    ["the PR moved past the parked head, approved at its new head", openWith([review(MAINTAINER, OTHER_HEAD, 5)], OTHER_HEAD)],
    ["the PR is closed", { ...openWith([review(MAINTAINER, HEAD, 5)]), state: "closed" as const }],
  ] as const)("%s: not due", (_name, pr) => {
    const r = dueFor(awaiting(), pr);
    expect([r.due, r.why]).toEqual([false, `reconcile:4 ran at ${RECENT.heartbeat_at}, under 10 min ago, and the snapshot shows no reconcile work`]);
  });

  test("the Maintainer's login is compared case-insensitively", () => {
    expect(dueFor(awaiting(), openWith([review("Edanisko", HEAD, 5)])).due).toBe(true);
  });

  test("only a record parked awaiting approval, with an owner, counts", () => {
    const approved = openWith([review(MAINTAINER, HEAD, 5)]);
    expect(dueFor(awaiting({ park: { kind: "needs-approval", reason: null, inbox_owner: "alice", globs_held: [] } }), approved).due).toBe(false);
    expect(dueFor(awaiting({ state: "claimed", park: null }), approved).due).toBe(false);
    expect(dueFor(awaiting({ pr_owner: null }), approved).due).toBe(false);
  });

  test("a coordinator re-park (an enqueued_sha) counts only an approval submitted after it", () => {
    const reparked = awaiting({ owner: COORD.owner, host: COORD.host, lane: COORD.lane, generation: 2, passed_sha: HEAD, enqueued_sha: HEAD });
    expect(dueFor(reparked, openWith([review(MAINTAINER, HEAD, 40)])).due).toBe(false);
    expect(dueFor(reparked, openWith([review(MAINTAINER, HEAD, 30)])).due).toBe(false);
    expect(dueFor(reparked, openWith([review(MAINTAINER, HEAD, 20)])).due).toBe(true);
    // A taken record returned to its park (no `enqueued_sha`) counts any standing approval, as reconcile does.
    expect(dueFor(awaiting({ lane: COORD.lane, enqueued_sha: null }), openWith([review(MAINTAINER, HEAD, 40)])).due).toBe(true);
  });

  test("an approved but unreviewed record (passed_sha null, as every mapped pre-v5 park) is no work: not due on its approval (Story 3.5)", () => {
    const r = dueFor(awaiting({ passed_sha: null }), openWith([review(MAINTAINER, HEAD, 5)]));
    expect([r.due, r.why]).toEqual([false, `reconcile:4 ran at ${RECENT.heartbeat_at}, under 10 min ago, and the snapshot shows no reconcile work`]);
  });

  test("a reconcile PR needs no passed_sha: its approval is still work", () => {
    const r3 = coord("reconcile:3", { state: "parked", pr: 7, pr_owner: "alice", head_sha: HEAD, heartbeat_at: PARKED_AT, park: { kind: "awaiting-approval", reason: null, inbox_owner: "alice", globs_held: ["docs/x.md"] } });
    const s = snapshotOf(world({ records: [RECENT, r3], prs: { "reconcile:3": openWith([review(MAINTAINER, HEAD, 5)]) } }));
    expect(maintainerApproved(s.ledger.units.find((u) => u.unit === "reconcile:3") as UnitRecord, s)).toBe(true);
  });

  test("a coordinator park with passed_sha alone is not a re-park (Story 3.5): any standing approval counts", () => {
    const reviewedOnly = awaiting({ owner: COORD.owner, host: COORD.host, lane: COORD.lane, generation: 2, passed_sha: HEAD, enqueued_sha: null });
    expect(dueFor(reviewedOnly, openWith([review(MAINTAINER, HEAD, 40)])).due).toBe(true);
  });

  test("a first park with a posted graph delta counts only an approval submitted after it (retro item 33)", () => {
    const graphPark: UnitRecord["park"] = { kind: "awaiting-approval", reason: null, inbox_owner: MAINTAINER, globs_held: ["docs/x.md"], graph_posted: `sha256:${"e".repeat(64)}` };
    // A builder's first park: an approval given before the delta comment (while CI ran) is not counted.
    const builder = awaiting({ park: graphPark });
    expect(dueFor(builder, openWith([review(MAINTAINER, HEAD, 40)])).due).toBe(false);
    expect(dueFor(builder, openWith([review(MAINTAINER, HEAD, 30)])).due).toBe(false);
    expect(dueFor(builder, openWith([review(MAINTAINER, HEAD, 20)])).due).toBe(true);
    // The graph planning step's first park: coordinator lane, no enqueued_sha.
    const planning = coord("planning:graph.1", { state: "parked", pr: 7, pr_owner: COORD.owner, head_sha: HEAD, passed_sha: HEAD, heartbeat_at: PARKED_AT, park: graphPark });
    const approvedOf = (minutesAgo: number) => {
      const s = snapshotOf(world({ records: [RECENT, planning], prs: { "planning:graph.1": openWith([review(MAINTAINER, HEAD, minutesAgo)]) } }));
      return maintainerApproved(s.ledger.units.find((u) => u.unit === "planning:graph.1") as UnitRecord, s);
    };
    expect(approvedOf(40)).toBe(false);
    expect(approvedOf(20)).toBe(true);
    // No graph_posted: today's rule, any standing approval of the head counts.
    expect(dueFor(awaiting(), openWith([review(MAINTAINER, HEAD, 40)])).due).toBe(true);
  });

  test("maintainerApproved reads the record and its PR", () => {
    const s = snapshotOf(world({ records: [RECENT, awaiting()], prs: { "story:2.1": openWith([review(MAINTAINER, HEAD, 5)]) } }));
    const parked = s.ledger.units.find((u) => u.unit === "story:2.1") as UnitRecord;
    expect(maintainerApproved(parked, s)).toBe(true);
    expect(maintainerApproved(RECENT, s)).toBe(false);
  });
});

describe("next(coordinator): an open coordinator PR", () => {
  const base = (records: readonly UnitRecord[], prs: Record<string, PrState>): Partial<World> => ({ records: [RECENT, ...records], prs });

  test("released with its PR open: that unit, its generation and PR", () => {
    const o = pickC(base([coord("planning:status.1", { state: "released", generation: 2, pr: 9, globs: STATUS_GLOBS })], { "planning:status.1": open(9) }));
    expect(o.kind === "coordinator" ? o.unit : null).toEqual({
      unit: "planning:status.1",
      kind: "planning",
      // The record's globs, as the ledger sorts them.
      globs: [...STATUS_GLOBS].sort(),
      expect_generation: 2,
      take_over: null,
      pr: 9,
      why: "planning:status.1 is released with PR #9 open",
    });
  });

  test("stale claimed: returned as a takeover", () => {
    const stale = coord("planning:status.1", { state: "claimed", pr: 9, heartbeat_at: minutesBefore(30) });
    const o = pickC(base([stale], { "planning:status.1": open(9) }));
    expect(o.kind === "coordinator" ? [o.unit.unit, o.unit.take_over, o.unit.expect_generation, o.unit.pr] : null).toEqual(["planning:status.1", "claimed", 1, 9]);
  });

  test.each([
    ["live claimed", { state: "claimed" }],
    ["merging", { state: "merging", passed_sha: HEAD }],
    ["merging and stale (reconcile checks it, never a takeover)", { state: "merging", passed_sha: HEAD, heartbeat_at: minutesBefore(60) }],
  ] as const)("%s: idle naming it; later positions wait", (_name, over) => {
    const o = pickC(base([coord("planning:status.1", { pr: 9, ...over })], { "planning:status.1": open(9) }));
    expect(o.kind).toBe("idle");
    expect(reasonOf(o)).toContain("waiting on an open coordinator PR");
    expect(reasonOf(o)).toContain(`planning:status.1 is ${over.state} with coordinator PR #9 open`);
    expect(o.kind === "idle" ? o.reasons.map((r) => `${r.subject} ${r.code}`) : []).toEqual(["reconcile:4 reconcile-not-due", "planning:status.1 record-state"]);
  });

  test("a live one before a released one: the released one is returned, the live one a reason", () => {
    const o = pickC(
      base(
        [coord("planning:a.1", { state: "claimed", pr: 8 }), coord("planning:b.1", { state: "released", pr: 9 })],
        { "planning:a.1": open(8), "planning:b.1": open(9) },
      ),
    );
    expect(picked(o)).toBe("unit planning:b.1");
    expect(o.kind === "coordinator" ? o.reasons.map((r) => r.subject) : []).toEqual(["reconcile:4", "planning:a.1"]);
  });

  test("a Story record the coordinator holds (takeApproved) is reconcile's, not this position's", () => {
    const held = storyRec("2.1", { state: "merging", owner: COORD.owner, host: COORD.host, lane: "coordinator", pr: 7, passed_sha: HEAD });
    const o = pickC(base([held], { "story:2.1": open(7) }));
    expect(o.kind).toBe("idle");
    expect(reasonOf(o).startsWith("no coordinator unit due")).toBe(true);
  });

  test("a parked coordinator record does not block", () => {
    const parked = coord("planning:graph.1", { state: "parked", pr: 8, park: { kind: "awaiting-approval", reason: null, inbox_owner: "edanisko", globs_held: [EPICS_MD] } });
    const o = pickC(base([parked], { "planning:graph.1": open(8) }));
    expect(reasonOf(o).startsWith("no coordinator unit due")).toBe(true);
  });

  test.each([
    ["closed", { number: 9, state: "closed", head_sha: HEAD } as PrState],
    ["no PR", null],
  ] as const)("a released record whose PR is %s is not this position's", (_name, pr) => {
    const o = pickC(base([coord("planning:status.1", { state: "released", pr: 9 })], pr === null ? {} : { "planning:status.1": pr }));
    expect(o.kind).toBe("idle");
  });

  test("a checkpoint record with its PR open is never a coordinator unit: no checkpoint unit runs (AR14)", () => {
    const o = pickC(base([coord("checkpoint:2", { state: "released", generation: 2, pr: 9 })], { "checkpoint:2": open(9) }));
    expect(o.kind).toBe("idle");
    expect(reasonOf(o).startsWith("no coordinator unit due")).toBe(true);
  });

  test("a builder's released record with an open PR is not a coordinator PR", () => {
    const o = pickC(base([storyRec("2.1", { state: "released", pr: 7 })], { "story:2.1": open(7) }));
    expect(o.kind).toBe("idle");
  });

  test.each([
    ["released", { state: "released" }],
    ["claimed and stale (a dead run)", { state: "claimed", heartbeat_at: minutesBefore(30) }],
  ] as const)("a %s reconcile record with its PR open is never returned, and does not block", (_name, over) => {
    const o = pickC(base([coord("reconcile:5", { pr: 9, ...over })], { "reconcile:5": open(9) }));
    expect(o.kind).toBe("idle");
    expect(reasonOf(o).startsWith("no coordinator unit due")).toBe(true);
  });

  test.each([
    ["merging (queued)", { state: "merging", passed_sha: HEAD, heartbeat_at: minutesBefore(60) }],
    ["claimed and live (a run in progress)", { state: "claimed" }],
  ] as const)("a %s reconcile record with its PR open is never returned, but later positions wait", (_name, over) => {
    const o = pickC(base([coord("reconcile:5", { pr: 9, ...over })], { "reconcile:5": open(9) }));
    expect(o.kind).toBe("idle");
    expect(reasonOf(o)).toContain("waiting on an open coordinator PR");
    expect(reasonOf(o)).toContain(`reconcile:5 is ${over.state} with reconcile PR #9 open`);
  });

  test("a live reconcile PR does not hide a released planning PR at the same position", () => {
    const o = pickC(
      base(
        [coord("reconcile:5", { state: "merging", passed_sha: HEAD, pr: 9 }), coord("retro:2", { state: "released", pr: 8 })],
        { "reconcile:5": open(9), "retro:2": open(8) },
      ),
    );
    expect(picked(o)).toBe("unit retro:2");
    expect(o.kind === "coordinator" ? o.reasons.map((r) => r.subject) : []).toEqual(["reconcile:4", "reconcile:5"]);
  });
});

describe("next(coordinator): idle, and roles never cross", () => {
  test("nothing due: idle with its reason and each reason's message", () => {
    const o = pickC({ records: [reconciled(4, 9)] });
    expect(o.kind).toBe("idle");
    expect(reasonOf(o)).toBe(
      `no coordinator unit due; reconcile is not due: reconcile:4 ran at ${reconciled(4, 9).heartbeat_at}, under 10 min ago, and the snapshot shows no reconcile work`,
    );
  });

  test("an eligible Story is never the coordinator's", () => {
    const worlds: Partial<World>[] = [{}, { records: [RECENT] }, { records: [RECENT, storyRec("2.1", { state: "released" })] }];
    for (const w of worlds) {
      // Typed as any outcome: the overload already rules a Story out at compile time.
      const kind: string = pickC(w).kind;
      expect(["unit", "park"]).not.toContain(kind);
    }
    // The same world as a builder: Story 2.1.
    expect(picked(next(snapshotOf(world({ records: [RECENT], role: "builder" })), "builder"))).toBe("story 2.1");
  });

  test("a builder never gets a coordinator unit, whatever the coordinator's records", () => {
    const records = [coord("planning:status.1", { state: "released", pr: 9 })];
    const builder = (w: Partial<World>) => picked(next(snapshotOf(world({ ...w, role: "builder" })), "builder"));
    expect(builder({ records, prs: { "planning:status.1": open(9) } })).toBe("story 2.1");
    expect(builder({ epics: { 1: [] }, records, prs: { "planning:status.1": open(9) } })).toBe("idle");
    expect(builder({ epics: { 1: [] }, coordinator: null })).toBe("idle");
  });
});

describe("coordinator kinds", () => {
  test("every unit kind but story and checkpoint; checkpoint:<epic> still parses as a unit id", () => {
    expect(UNIT_KINDS.filter(isCoordinatorKind)).toEqual(["retro", "retro-item", "planning", "reconcile"]);
    expect(unitKind("checkpoint:2")).toBe("checkpoint");
  });
});

describe("coordinatorGlobs", () => {
  const config = { ...CONFIG_DEFAULTS, manifests: { dir: "stories" } };
  test.each([
    ["graph planning", { kind: "planning", planning: "graph" }, [CONFIG_DEFAULTS.epics_path, ".xarabot/epics.yaml", "stories/*.md", "xarabot:graph"]],
    ["status planning", { kind: "planning", planning: "status" }, [STATUS, RETRO, "_bmad-output/implementation-artifacts/epic-*-context.md"]],
    [
      "retro:3",
      { kind: "retro", epic: 3 },
      [STATUS, RETRO, "_bmad-output/implementation-artifacts/epic-3-context.md", "_bmad-output/implementation-artifacts/epic-3-retro-*.md"],
    ],
    ["a retro item", { kind: "retro-item", globs: ["src/x/**", "docs/x.md"] }, ["src/x/**", "docs/x.md"]],
    ["reconcile", { kind: "reconcile" }, []],
  ] as const)("%s", (_name, spec, want) => {
    expect(coordinatorGlobs(spec as CoordinatorUnitSpec, config)).toEqual([...want]);
  });

  test("graph planning with no manifests config holds no manifest glob", () => {
    expect(coordinatorGlobs({ kind: "planning", planning: "graph" }, CONFIG_DEFAULTS)).toEqual([CONFIG_DEFAULTS.epics_path, ".xarabot/epics.yaml", "xarabot:graph"]);
  });

  test("overlap: a builder claim is refused against a coordinator unit's globs", () => {
    const held = coord("planning:status.1", { state: "claimed", globs: coordinatorGlobs({ kind: "planning", planning: "status" }, config) });
    const r = claim({ unit: "story:2.1", by: ALICE, now: NOW, globs: ["_bmad-output/implementation-artifacts/**"], expectGeneration: null })(tip([held]));
    expect(r.ok ? "ok" : r.error.kind).toBe("precondition");
    expect(r.ok ? "" : r.error.message).toContain("held by planning:status.1");
    // And `next` passes the Story over with an overlap reason.
    const o = next(
      snapshotOf(world({ role: "builder", records: [held], manifests: [{ id: "2.1", globs: ["_bmad-output/implementation-artifacts/**"] }] })),
      "builder",
    );
    expect(o.kind === "idle" ? o.reasons.map((x) => x.code) : o.kind).toContain("overlap");
  });
});

const GATES = [
  "schema_version: 1",
  "epics:",
  '  "2":',
  "    retro:",
  "      verdict: accepted-with-open-items",
  '      unit: "retro:2"',
  "      recorded_at: 2026-10-20T00:00:00Z",
  "    items:",
  "      - id: epic-2-retro-item-1-fix-x",
  "        text: Fix x",
  "        route: lane",
  "        blocking: false",
  '        globs: ["src/x/**"]',
  "        status: done",
  "      - id: epic-2-retro-item-2-fix-y",
  "        text: Fix y",
  "        route: lane",
  "        blocking: true",
  "        globs: []",
  "        status: open",
  "    checkpoint:",
  "      go:",
  "        by: edanisko",
  "        at: 2026-10-21T00:00:00Z",
  "        ruling: maintainer-pr",
  "",
].join("\n");

describe("doneOnMain", () => {
  const snap = snapshotOf(world({ epics: { 1: [], 2: ["1", "2"], 3: [] }, status: { "2.1": "done", "2.2": "review" }, files: { [RETRO]: GATES }, records: [reconciled(3, 30), RECENT] }));
  const m = (unit: string) => coord(unit, { state: "merged" });
  test.each([
    ["story done", "story:2.1", true],
    ["story not done", "story:2.2", false],
    ["story with no manifest", "story:2.9", false],
    ["retro with a verdict", "retro:2", true],
    ["retro with none", "retro:3", false],
    ["retro item done", "retro-item:epic-2-retro-item-1-fix-x", true],
    ["retro item open", "retro-item:epic-2-retro-item-2-fix-y", false],
    ["retro item unknown", "retro-item:epic-3-retro-item-1-z", false],
    ["checkpoint with its go", "checkpoint:2", true],
    ["checkpoint with none", "checkpoint:3", false],
    ["status planning (a merged recurring record)", "planning:status.1", true],
    ["an older reconcile", "reconcile:3", true],
    ["the newest reconcile", "reconcile:4", false],
  ] as const)("%s: %s → %p", (_name, unit, want) => {
    expect(doneOnMain(m(unit), snap)).toBe(want);
  });

  const graphUnit = coord("planning:graph.1", { state: "merged", globs: [EPICS_MD, GRAPH_PSEUDO_GLOB] });
  const statusOf = (keys: readonly string[]) => ["development_status:", ...keys.map((k) => `  ${k}: backlog`), ""].join("\n");
  test.each([
    ["every Epic and manifest key present", ["epic-1", "epic-2", "k-2.1"], true],
    ["an Epic key missing", ["epic-1", "k-2.1"], false],
    ["a manifest key missing", ["epic-1", "epic-2"], false],
  ] as const)("graph planning, %s → %p", (_name, keys, want) => {
    const s = snapshotOf(world({ files: { [STATUS]: statusOf(keys) } }));
    expect(doneOnMain(graphUnit, s)).toBe(want);
  });

  test("missingStatusEntries: graph order, each Epic key before its Stories", () => {
    const s = snapshotOf(world({ epics: { 1: [], 2: ["2", "1"], 3: ["1"] }, files: { [STATUS]: statusOf(["epic-1", "k-2.2"]) } }));
    expect(missingStatusEntries(s)).toEqual([
      { key: "epic-2", epic: 2 },
      { key: "k-2.1", epic: 2 },
      { key: "epic-3", epic: 3 },
      { key: "k-3.1", epic: 3 },
    ]);
  });

  test.each([
    ["merged but not the newest merged", coord("reconcile:3", { state: "merged" }), true],
    ["released", coord("reconcile:3", { state: "released" }), false],
    ["merging", coord("reconcile:5", { state: "merging", passed_sha: HEAD }), false],
  ] as const)("a reconcile record %s → %p", (_name, record, want) => {
    expect(doneOnMain(record, snap)).toBe(want);
  });
});

describe("digestDue", () => {
  test.each([
    ["before the slot", "2026-10-22T07:59:59Z", "08:00", null, false],
    ["at the slot, never posted", "2026-10-22T08:00:00Z", "08:00", null, true],
    ["after the slot, posted yesterday", "2026-10-22T10:00:00Z", "08:00", "2026-10-21T08:00:00Z", true],
    ["after the slot, posted just before it", "2026-10-22T10:00:00Z", "08:00", "2026-10-22T07:59:00Z", true],
    ["after the slot, posted at it", "2026-10-22T10:00:00Z", "08:00", "2026-10-22T08:00:00Z", false],
    ["after the slot, posted after it", "2026-10-22T10:00:00Z", "08:00", "2026-10-22T09:00:00Z", false],
    ["an offset now is read in UTC", "2026-10-22T09:30:00+02:00", "08:00", null, false],
    ["another digest_time", "2026-10-22T10:00:00Z", "11:30", null, false],
    ["just after midnight UTC, posted yesterday", "2026-10-23T00:01:00Z", "00:00", "2026-10-22T00:00:00Z", true],
  ] as const)("%s → %p", (_name, now, time, posted, want) => {
    expect(digestDue(now, time, posted)).toBe(want);
  });
});

describe("nextCoordinator", () => {
  test("is what next returns for the coordinator", () => {
    const s = snapshotOf(world({ records: [reconciled(4, 9)] }));
    expect(next(s, "coordinator")).toEqual(nextCoordinator(s));
  });
});

describe("next(coordinator): planning (Story 2.7)", () => {
  const GRAPH_GLOBS = coordinatorGlobs({ kind: "planning", planning: "graph" }, { ...CONFIG_DEFAULTS, manifests: { dir: "stories" } });
  const planningRec = (unit: string, over: Partial<UnitRecord> = {}) =>
    coord(unit, { globs: unit.startsWith("planning:graph") ? GRAPH_GLOBS : STATUS_GLOBS, ...over });
  const parkedAs = (reason: "readiness" | "write-check" | "verification" | "ci-timeout" | "attempts-cap"): Partial<UnitRecord> => ({
    state: "parked",
    park: { kind: "blocked", reason, inbox_owner: "carol", globs_held: [] },
  });
  /** Epic 3 has a heading (3.1) with no manifest, and no status key. */
  const GRAPH_DUE: Partial<World> = { epics: { 1: [], 2: ["1"], 3: ["1"] }, manifests: [{ id: "2.1" }] };
  /** Every key present, Epic 2's context missing and Story 2.1 in backlog. */
  const CONTEXT_DUE: Partial<World> = { contexts: { 2: null } };
  /** Graph due, every key present: status not due. */
  const GRAPH_ONLY: Partial<World> = { ...GRAPH_DUE, status: { ...PLANNED, "epic-3": "backlog" } };
  const pick = (w: Partial<World>) => pickC({ records: [RECENT, ...(w.records ?? [])], ...w, ...(w.records === undefined ? {} : { records: [RECENT, ...w.records] }) });
  const reasonsOf = (o: NextOutcome) => (o.kind === "coordinator" || o.kind === "idle" ? o.reasons : []);

  test.each([
    ["the matrix: graph first (unmanifested 3.1, Epic 3 missing from status)", GRAPH_DUE, "unit planning:graph.1"],
    ["the matrix: context only (Epic 2 context missing, Story 2.1 backlog, every key present)", CONTEXT_DUE, "unit planning:status.1"],
    ["the matrix: bootstrapped (heading and missing context only in Epic 1)", { epics: { 1: ["1"], 2: ["1"] }, manifests: [{ id: "2.1" }], contexts: { 1: null } }, "idle"],
    ["the matrix: readiness park holds status", { ...CONTEXT_DUE, records: [planningRec("planning:status.2", parkedAs("readiness"))] }, "idle"],
    ["the matrix: readiness park, graph still due", { ...GRAPH_DUE, contexts: { 2: null }, records: [planningRec("planning:status.2", parkedAs("readiness"))] }, "unit planning:graph.1"],
    ["the matrix: release (status.2 released, status due)", { ...CONTEXT_DUE, records: [planningRec("planning:status.2", { state: "released" })] }, "unit planning:status.3"],
    ["nothing due: every key present, every context valid", {}, "idle"],
    ["status due: an Epic key missing", { status: { "2.1": "backlog" } }, "unit planning:status.1"],
    ["status due: a Story key missing", { status: { "epic-2": "backlog" } }, "unit planning:status.1"],
    ["a missing key of a bootstrapped Epic only is not due", { epics: { 1: ["1"], 2: ["1"] }, status: PLANNED }, "idle"],
    [
      "missing keys a merged graph planning record will add are reconcile's, not due",
      { status: { "epic-2": "backlog" }, records: [planningRec("planning:graph.1", { state: "merged" })] },
      "idle",
    ],
    ["a context not valid, with every Story done: not due", { contexts: { 2: null }, status: { "epic-2": "in-progress", "2.1": "done" } }, "idle"],
    ["a context with the wrong heading is due", { contexts: { 2: "# Wrong\n" } }, "unit planning:status.1"],
    ["an empty context is due", { contexts: { 2: "" } }, "unit planning:status.1"],
    [
      "a context of an Epic a dependency holds: not due",
      { epics: { 1: [], 2: ["1"], 3: ["1"] }, epicsYaml: "version: 1\nepics:\n  3:\n    depends_on: [2]\n", contexts: { 3: null }, status: { ...PLANNED, "epic-3": "backlog", "3.1": "backlog" } },
      "idle",
    ],
    [
      "a context of an Epic a rejected retro holds: not due",
      { epics: { 1: [], 2: ["1"], 3: ["1"] }, contexts: { 3: null }, retro: { 2: "rejected" }, status: { "epic-2": "done", "2.1": "done", "epic-3": "backlog", "3.1": "backlog" } },
      "idle",
    ],
    [
      "a context of an Epic an open blocking retro item holds: not due",
      { epics: { 1: [], 2: ["1"], 3: ["1"] }, contexts: { 3: null }, retro: { 2: "accepted-with-open-items" }, items: { 2: [{ seq: 1, blocking: true, status: "open" }] }, status: { "epic-2": "done", "2.1": "done", "epic-3": "backlog", "3.1": "backlog" } },
      "idle",
    ],
    [
      "a context of an Epic one step from an open untagged retro item: due",
      { epics: { 1: [], 2: ["1"], 3: ["1"] }, contexts: { 3: null }, retro: { 2: "accepted-with-open-items" }, items: { 2: [{ seq: 1, blocking: false, status: "open" }] }, status: { "epic-2": "done", "2.1": "done", "epic-3": "backlog", "3.1": "backlog" } },
      "unit planning:status.1",
    ],
    ["graph before status when both are due", { ...GRAPH_DUE, contexts: { 2: null } }, "unit planning:graph.1"],
    ["a graph park holds graph only: status is still due", { ...GRAPH_DUE, contexts: { 2: null }, records: [planningRec("planning:graph.1", { state: "parked", park: { kind: "awaiting-approval", reason: null, inbox_owner: "carol", globs_held: [EPICS_MD] } })] }, "unit planning:status.1"],
    ["a merging status record holds status", { ...CONTEXT_DUE, records: [planningRec("planning:status.1", { state: "merging", passed_sha: HEAD })] }, "idle"],
    ["a live claimed status record holds status", { ...CONTEXT_DUE, records: [planningRec("planning:status.1")] }, "idle"],
    ["a merged status record is reconcile's to delete first", { ...CONTEXT_DUE, records: [planningRec("planning:status.4", { state: "merged" })] }, "unit reconcile:5"],
    ["a merged graph record not done on main does not hold; n counts it", { ...GRAPH_DUE, records: [planningRec("planning:graph.4", { state: "merged" })] }, "unit planning:graph.5"],
    ["a released graph record does not hold; n counts it", { ...GRAPH_DUE, records: [planningRec("planning:graph.7", { state: "released" })] }, "unit planning:graph.8"],
    ["n counts only its own slug", { ...GRAPH_DUE, records: [planningRec("planning:status.9", { state: "released" })] }, "unit planning:graph.1"],
    ["n is by number, not by name: status.10 after status.9", { ...CONTEXT_DUE, records: [planningRec("planning:status.9", { state: "released" }), planningRec("planning:status.10", { state: "released" })] }, "unit planning:status.11"],
    ["another slug holding xarabot:graph counts as graph and holds it", { ...GRAPH_ONLY, records: [coord("planning:sprint.1", { globs: GRAPH_GLOBS, ...parkedAs("verification") })] }, "idle"],
    ["a held graph kind leaves a due status kind due", { ...GRAPH_DUE, records: [planningRec("planning:graph.1", parkedAs("verification"))] }, "unit planning:status.1"],
    ["graph only", GRAPH_ONLY, "unit planning:graph.1"],
    ["another slug without xarabot:graph counts as status and holds it", { ...CONTEXT_DUE, records: [coord("planning:sprint.1", { globs: STATUS_GLOBS, ...parkedAs("write-check") })] }, "idle"],
  ] as const)("%s → %s", (_name, w, want) => {
    expect(picked(pick(w as Partial<World>))).toBe(want);
  });

  const whyOf = (o: NextOutcome) => (o.kind === "coordinator" ? o.unit.why : o.kind);

  test("C4: a new record names the count it takes from the newest released record of its kind", () => {
    const o = pick({ ...CONTEXT_DUE, records: [planningRec("planning:status.2", { state: "released", attempts: 2 })] });
    expect(picked(o)).toBe("unit planning:status.3");
    expect(whyOf(o)).toMatch(/^status planning is due: .*; it starts at 2 of 3 attempts, from planning:status\.2$/);
  });

  test.each([
    ["a released record with no failed attempt", { ...CONTEXT_DUE, records: [planningRec("planning:status.2", { state: "released" })] }, "unit planning:status.3"],
    [
      "the newest record merged (a done run)",
      { ...GRAPH_DUE, records: [planningRec("planning:graph.3", { state: "released", attempts: 2, heartbeat_at: minutesBefore(5) }), planningRec("planning:graph.4", { state: "merged" })] },
      "unit planning:graph.5",
    ],
    ["a released record of the other kind", { ...CONTEXT_DUE, records: [planningRec("planning:graph.2", { state: "released", attempts: 2 })] }, "unit planning:status.1"],
  ] as const)("C4: no count named for %s", (_name, w, want) => {
    const o = pick(w as Partial<World>);
    expect(picked(o)).toBe(want);
    expect(whyOf(o)).not.toContain("it starts at");
  });

  test.each(["readiness", "write-check", "verification", "ci-timeout", "attempts-cap"] as const)("a blocked %s park holds its kind, naming it with planning-held", (reason) => {
    const o = pick({ ...CONTEXT_DUE, records: [planningRec("planning:status.2", parkedAs(reason))] });
    expect(o.kind).toBe("idle");
    const held = reasonsOf(o).find((r) => r.code === "planning-held");
    expect(held?.subject).toBe("planning:status.2");
    expect(held?.message).toContain(`planning:status.2 is parked blocked ${reason}`);
    expect(reasonOf(o)).toContain("status planning is due");
  });

  test("the matrix: a stale claim with no PR is taken over, same id", () => {
    const stale = planningRec("planning:graph.1", { generation: 2, heartbeat_at: minutesBefore(30) });
    const o = pick({ ...GRAPH_DUE, records: [stale] });
    expect(o.kind === "coordinator" ? o.unit : null).toEqual({
      unit: "planning:graph.1",
      kind: "planning",
      globs: GRAPH_GLOBS,
      expect_generation: 2,
      take_over: "claimed",
      pr: null,
      why: `planning:graph.1 is claimed and stale (heartbeat ${minutesBefore(30)}) with no open PR`,
    });
  });

  test("a stale claim is taken over even when its kind is no longer due (the step finds nothing due)", () => {
    const o = pick({ records: [planningRec("planning:status.3", { heartbeat_at: minutesBefore(45) })] });
    expect(o.kind === "coordinator" ? [o.unit.unit, o.unit.take_over] : null).toEqual(["planning:status.3", "claimed"]);
  });

  test("a status unit holds the status files and every Epic context, says why, and has no generation or PR", () => {
    const o = pick(CONTEXT_DUE);
    expect(o.kind === "coordinator" ? o.unit : null).toEqual({
      unit: "planning:status.1",
      kind: "planning",
      globs: STATUS_GLOBS,
      expect_generation: null,
      take_over: null,
      pr: null,
      why: "status planning is due: Epic 2 context _bmad-output/implementation-artifacts/epic-2-context.md is missing",
    });
  });

  test("a graph unit holds the graph inputs and xarabot:graph and names the headings", () => {
    const o = pick(GRAPH_DUE);
    expect(o.kind === "coordinator" ? o.unit.globs : null).toEqual(GRAPH_GLOBS);
    expect(o.kind === "coordinator" ? o.unit.why : "").toMatch(new RegExp(`^graph planning is due: Story 3\\.1 has a heading \\(${EPICS_MD.replaceAll(".", "\\.")}:[0-9]+\\) but no manifest$`));
  });

  test("overlap: a builder record holding a manifest glob passes graph over with an overlap reason; status is still due", () => {
    const builder = storyRec("2.1", { globs: ["stories/**"] });
    const o = pick({ ...GRAPH_DUE, contexts: { 2: null }, records: [builder] });
    expect(picked(o)).toBe("unit planning:status.1");
    const overlap = reasonsOf(o).find((r) => r.code === "overlap");
    expect(overlap?.subject).toBe("planning:graph.1");
    expect(overlap?.message).toContain('overlaps "stories/**" held by story:2.1');
  });

  test("overlap: no planning unit at all, idle naming the overlap", () => {
    const o = pick({ ...CONTEXT_DUE, records: [storyRec("2.1", { globs: ["_bmad-output/**"] })] });
    expect(o.kind).toBe("idle");
    expect(reasonsOf(o).map((r) => r.code)).toContain("overlap");
  });

  test("reconcile comes first, and an open coordinator PR before planning", () => {
    expect(picked(pickC({ ...GRAPH_DUE }))).toBe("unit reconcile:1");
    const released = planningRec("planning:status.1", { state: "released", pr: 9 });
    expect(picked(pick({ ...GRAPH_DUE, records: [released], prs: { "planning:status.1": open(9) } }))).toBe("unit planning:status.1");
    const live = planningRec("planning:status.1", { state: "merging", pr: 9, passed_sha: HEAD });
    expect(reasonOf(pick({ ...GRAPH_DUE, records: [live], prs: { "planning:status.1": open(9) } }))).toContain("waiting on an open coordinator PR");
  });

  test("planningDue reports both kinds for the prompt", () => {
    const d = planningDue(snapshotOf(world({ ...GRAPH_DUE, contexts: { 2: null } })));
    expect(d.graph.due).toBe(true);
    expect(d.graph.headings.map((h) => [h.id, h.epic])).toEqual([["3.1", 3]]);
    expect(d.status.due).toBe(true);
    expect(d.status.entries.map((e) => e.key)).toEqual(["epic-3"]);
    expect(d.status.contexts).toEqual([2]);
    const none = planningDue(snapshotOf(world()));
    expect([none.graph.due, none.status.due]).toEqual([false, false]);
  });

  test("with no manifests config, graph planning is never due (there is no manifest directory to write to)", () => {
    const noManifests = ["schema_version: 1", 'runner_version: "0.1.0"', "maintainer: edanisko", `standing_authority_path: ${AUTHORITY}`, "bootstrapped_epics: [1]", ""].join("\n");
    const d = planningDue(snapshotOf(world({ ...GRAPH_DUE, files: { [CONFIG_PATH]: noManifests } })));
    expect(d.graph).toEqual({ due: false, why: "no manifests directory is configured", headings: [] });
  });

  test("planning ids, slugs and branches", () => {
    expect(planningSlug("planning:status.12")).toBe("status");
    expect(planningSlug("planning:sprint-x.1")).toBe("sprint-x");
    expect(planningSlug("reconcile:1")).toBeNull();
    expect(planningNumber("planning:graph.10")).toBe(10);
    expect(planningKindOf({ unit: "planning:graph.1", globs: [] })).toBe("graph");
    expect(planningKindOf({ unit: "planning:status.1", globs: [GRAPH_PSEUDO_GLOB] })).toBe("status");
    expect(planningKindOf({ unit: "planning:x.1", globs: [GRAPH_PSEUDO_GLOB] })).toBe("graph");
    expect(planningKindOf({ unit: "planning:x.1", globs: [] })).toBe("status");
    expect(planningKindOf({ unit: "story:1.1", globs: [] })).toBeNull();
    expect(unitBranch("xarabot/", "planning:status.2")).toBe("xarabot/planning-status.2");
    expect(unitBranch("bot-", "reconcile:7")).toBe("bot-reconcile-7");
    const s = snapshotOf(world({ records: [RECENT, planningRec("planning:graph.3", { state: "merged" }), planningRec("planning:status.1", { state: "released" })] }));
    expect([nextPlanningNumber(s, "graph"), nextPlanningNumber(s, "status")]).toEqual([4, 2]);
  });
});

describe("planningDue: a stale Epic context (retro item 12)", () => {
  /** Epics 2 and 3 each with one Story in backlog, both depending on Epic 1 only, every status key present. */
  const BASE: Partial<World> = {
    epics: { 1: [], 2: ["1"], 3: ["1"] },
    epicsYaml: "version: 1\nepics:\n  3:\n    depends_on: [1]\n",
    status: { ...PLANNED, "epic-3": "backlog", "3.1": "backlog" },
  };
  const epicsText = (w: Partial<World> = {}) => input(world({ ...BASE, ...w })).files[EPICS_MD] as string;
  /** `epics.md` with one line added at the end of Epic `n`'s section: the contexts keep the old hash. */
  const edited = (n: number) => {
    const text = epicsText();
    const at = text.indexOf(`### Story ${n}.1:`);
    return { [EPICS_MD]: `${text.slice(0, at)}A new line for Epic ${n}.\n\n${text.slice(at)}` };
  };
  const due = (w: Partial<World>) => planningDue(snapshotOf(world({ ...BASE, ...w }))).status;
  const states = (w: Partial<World>) => snapshotOf(world({ ...BASE, ...w })).epic_context;

  test("a matching hash: valid, nothing due", () => {
    expect(states({})).toEqual({ "1": "valid", "2": "valid", "3": "valid" });
    expect(due({})).toMatchObject({ due: false, contexts: [] });
  });

  test("a changed section: that Epic's context is stale and due", () => {
    const d = due({ files: edited(2) });
    expect(states({ files: edited(2) })["2"]).toBe("stale");
    expect(d).toMatchObject({ due: true, contexts: [2] });
    expect(d.why).toBe(`Epic 2 context ${contextPath(2)} is stale`);
    expect(picked(pickC({ ...BASE, files: edited(2), records: [RECENT] }))).toBe("unit planning:status.1");
  });

  test("a missing source line: stale and due, though the heading is valid", () => {
    const d = due({ contexts: { 2: "# Epic 2 Context: Epic 2\n\nGoal.\n" } });
    expect(d).toMatchObject({ due: true, contexts: [2] });
    expect(d.why).toBe(`Epic 2 context ${contextPath(2)} is stale`);
  });

  test("a source line not directly below the heading is missing: stale", () => {
    const line = /<!-- source: sha256:[0-9a-f]{64} -->/.exec(input(world(BASE)).files[contextPath(2)] as string)?.[0];
    expect(states({ contexts: { 2: `# Epic 2 Context: Epic 2\n\n${line}\n` } })["2"]).toBe("stale");
  });

  test("a change to another Epic's section only: only that Epic is stale", () => {
    expect(states({ files: edited(3) })).toEqual({ "1": "valid", "2": "valid", "3": "stale" });
    expect(due({ files: edited(3) }).contexts).toEqual([3]);
  });

  test("an Epic whose Stories are all done: stale, but not due", () => {
    const status = { ...PLANNED, "2.1": "done", "epic-3": "backlog", "3.1": "backlog" };
    expect(states({ status, files: edited(2) })["2"]).toBe("stale");
    expect(due({ status, files: edited(2) })).toMatchObject({ due: false, contexts: [] });
  });

  test("a stale context holds no Story: a builder still gets the Epic's Story", () => {
    const o = next(snapshotOf({ ...world({ ...BASE, files: edited(2) }), role: "builder" }), "builder");
    expect(picked(o)).toBe("story 2.1");
  });
});

describe("next(coordinator): retro (Story 2.9)", () => {
  const RETRO_GLOBS_2 = [STATUS, RETRO, "_bmad-output/implementation-artifacts/epic-2-context.md", "_bmad-output/implementation-artifacts/epic-2-retro-*.md"];
  /** Story 2.1 done, every status key present. */
  const DONE = { "epic-2": "backlog", "2.1": "done" } as const;
  /** Epic 2's retro due: its Story done, no verdict, its live evidence on main. */
  const DUE: Partial<World> = { status: DONE, evidence: [2] };
  const retroRec = (over: Partial<UnitRecord> = {}) => coord("retro:2", { globs: RETRO_GLOBS_2, ...over });
  const pick = (w: Partial<World>) => pickC({ ...w, records: [RECENT, ...(w.records ?? [])] });
  const codes = (o: NextOutcome) => (o.kind === "coordinator" || o.kind === "idle" ? o.reasons.map((r) => `${r.subject} ${r.code}`) : []);

  test.each([
    ["due: Epic 2 all done, no verdict, evidence on main", DUE, "unit retro:2"],
    ["a Story not done (2.1 backlog)", { ...DUE, status: PLANNED }, "idle"],
    ["no evidence file", { status: DONE }, "idle"],
    ["bootstrapped: Epic 1 all done with evidence, never retro:1", { epics: { 1: ["1"], 2: ["1"] }, status: { ...PLANNED, "1.1": "done" }, evidence: [1, 2] }, "idle"],
    ["recorded: retro-gates has 2.retro", { ...DUE, retro: { 2: "accepted" } }, "idle"],
    ["a rejected verdict is recorded too", { ...DUE, retro: { 2: "rejected" } }, "idle"],
    ["an Epic with no Story", { epics: { 1: [], 2: [] }, status: { "epic-2": "backlog" }, evidence: [2] }, "idle"],
    ["an unmanifested heading", { epics: { 1: [], 2: ["1", "2"] }, manifests: [{ id: "2.1" }], status: DONE, evidence: [2] }, "unit planning:graph.1"],
    ["planning goes first: a status key missing", { status: { "2.1": "done" }, evidence: [2] }, "unit planning:status.1"],
    ["Epics in ascending order", { epics: { 1: [], 2: ["1"], 3: ["1"] }, status: { ...DONE, "epic-3": "backlog", "3.1": "done" }, evidence: [2, 3] }, "unit retro:2"],
    ["an Epic waiting on evidence passes to the next one", { epics: { 1: [], 2: ["1"], 3: ["1"] }, status: { ...DONE, "epic-3": "backlog", "3.1": "done" }, evidence: [3] }, "unit retro:3"],
    ["released, no PR: re-claimed", { ...DUE, records: [retroRec({ state: "released", generation: 2 })] }, "unit retro:2"],
    ["stale claimed, no PR: taken over", { ...DUE, records: [retroRec({ heartbeat_at: minutesBefore(30) })] }, "unit retro:2"],
    ["live claimed: holds", { ...DUE, records: [retroRec()] }, "idle"],
    ["merged, waiting for reconcile: holds", { ...DUE, records: [retroRec({ state: "merged" })] }, "idle"],
    ["parked: holds", { ...DUE, records: [retroRec({ state: "parked", park: { kind: "blocked", reason: "verification", inbox_owner: "carol", globs_held: [] } })] }, "idle"],
    ["merging: holds", { ...DUE, records: [retroRec({ state: "merging", pr: 9, passed_sha: HEAD })] }, "idle"],
  ] as const)("%s → %s", (_name, w, want) => {
    expect(picked(pick(w as Partial<World>))).toBe(want);
  });

  test("the unit: its globs, a new claim, and why", () => {
    const o = pick(DUE);
    expect(o.kind === "coordinator" ? o.unit : null).toEqual({
      unit: "retro:2",
      kind: "retro",
      globs: RETRO_GLOBS_2,
      expect_generation: null,
      take_over: null,
      pr: null,
      why: "retro:2 is due: Epic 2's Stories are all done, its retro is not recorded and docs/maintainer/evidence/epic-2.md is on main",
    });
    expect(RETRO_GLOBS_2).toEqual(coordinatorGlobs({ kind: "retro", epic: 2 }, CONFIG_DEFAULTS));
  });

  test("released: re-claimed at its generation; stale claimed: taken over at its generation", () => {
    const released = pick({ ...DUE, records: [retroRec({ state: "released", generation: 2 })] });
    expect(released.kind === "coordinator" ? [released.unit.expect_generation, released.unit.take_over] : null).toEqual([2, null]);
    const stale = pick({ ...DUE, records: [retroRec({ heartbeat_at: minutesBefore(30), generation: 3 })] });
    expect(stale.kind === "coordinator" ? [stale.unit.expect_generation, stale.unit.take_over] : null).toEqual([3, "claimed"]);
  });

  test("a released record with its PR open is the open-PR position's", () => {
    const o = pick({ ...DUE, records: [retroRec({ state: "released", pr: 9 })], prs: { "retro:2": open(9) } });
    expect(o.kind === "coordinator" ? [o.unit.unit, o.unit.pr, o.unit.why] : null).toEqual(["retro:2", 9, "retro:2 is released with PR #9 open"]);
  });

  test("a stale claimed record with its PR open is the open-PR position's", () => {
    const o = pick({ ...DUE, records: [retroRec({ heartbeat_at: minutesBefore(30), pr: 9 })], prs: { "retro:2": open(9) } });
    expect(o.kind === "coordinator" ? [o.unit.unit, o.unit.take_over, o.unit.pr] : null).toEqual(["retro:2", "claimed", 9]);
  });

  test("no evidence: idle waiting-on-maintainer, naming the file", () => {
    const o = pick({ status: DONE });
    expect(reasonOf(o).startsWith(`${WAITING_ON_MAINTAINER}retro:2 waits for the live evidence file docs/maintainer/evidence/epic-2.md on main`)).toBe(true);
    expect(codes(o)).toEqual(["reconcile:4 reconcile-not-due", "retro:2 live-evidence"]);
  });

  test("a configured live_evidence_glob is named with <N> set", () => {
    const o = pick({ status: DONE, liveEvidenceGlob: "evidence/e<N>-*.md" });
    expect(reasonOf(o)).toContain("waits for the live evidence file evidence/e2-*.md on main");
    expect(picked(pick({ status: DONE, liveEvidenceGlob: "evidence/e<N>-*.md", files: { "evidence/e2-run.md": "x\n" } }))).toBe("unit retro:2");
  });

  test("an idle outcome without a live-evidence reason has no waiting-on-maintainer prefix", () => {
    expect(reasonOf(pick({ ...DUE, records: [retroRec()] })).startsWith("no coordinator unit due")).toBe(true);
  });

  describe("the every-reason rule (Story 4.2; Epic 4 retro item 3)", () => {
    const TWO = { epics: { 1: [], 2: ["1"], 3: ["1"] }, status: { ...DONE, "epic-3": "backlog", "3.1": "done" } } as const;
    const retro3 = coord("retro:3", { globs: coordinatorGlobs({ kind: "retro", epic: 3 }, CONFIG_DEFAULTS) });

    test("every reason besides reconcile-not-due a live-evidence one: the prefix names each, then the rest", () => {
      const o = pick(TWO);
      expect(codes(o)).toEqual(["reconcile:4 reconcile-not-due", "retro:2 live-evidence", "retro:3 live-evidence"]);
      expect(o.kind === "idle" ? o.reasons.filter((r) => r.code === "live-evidence").every((r) => r.maintainer === true) : false).toBe(true);
      expect(reasonOf(o)).toStartWith(
        `${WAITING_ON_MAINTAINER}retro:2 waits for the live evidence file docs/maintainer/evidence/epic-2.md on main; retro:3 waits for the live evidence file docs/maintainer/evidence/epic-3.md on main; no coordinator unit due; reconcile is not due`,
      );
    });

    test("a live-evidence reason beside a lane reason (a held record): no prefix, every reason after nothing-due", () => {
      const o = pick({ ...TWO, evidence: [3], records: [retro3] });
      expect(picked(o)).toBe("idle");
      expect(codes(o)).toEqual(["reconcile:4 reconcile-not-due", "retro:2 live-evidence", "retro:3 record-state"]);
      expect(reasonOf(o)).toStartWith("no coordinator unit due; reconcile is not due");
      expect(reasonOf(o)).toContain("retro:2 waits for the live evidence file docs/maintainer/evidence/epic-2.md on main; retro:3 is due but its record is");
      expect(reasonOf(o)).not.toContain(WAITING_ON_MAINTAINER);
    });

    test("a live-evidence reason beside an overlap: no prefix", () => {
      const held = coord("planning:status.1", { globs: STATUS_GLOBS });
      const o = pick({ ...TWO, evidence: [3], records: [held] });
      expect(codes(o)).toEqual(["reconcile:4 reconcile-not-due", "retro:2 live-evidence", "retro:3 overlap"]);
      expect(reasonOf(o)).toStartWith("no coordinator unit due; ");
      expect(reasonOf(o)).not.toContain(WAITING_ON_MAINTAINER);
    });
  });

  test("a held record is a record-state reason", () => {
    const o = pick({ ...DUE, records: [retroRec({ state: "merged" })] });
    expect(codes(o)).toContain("retro:2 record-state");
    expect(reasonOf(o)).toContain("retro:2 is due but its record is merged");
  });

  test("an overlap with any held glob passes the Epic over", () => {
    const held = coord("planning:status.1", { globs: STATUS_GLOBS });
    const o = pick({ ...DUE, records: [held] });
    expect(picked(o)).toBe("idle");
    expect(codes(o)).toContain("retro:2 overlap");
    expect(reasonOf(o)).toContain(`glob "${STATUS}" overlaps "${STATUS}" held by planning:status.1`);
  });

  test("retroCandidates and retroDue", () => {
    const s = snapshotOf(world({ epics: { 1: [], 2: ["1"], 3: ["1"] }, status: { ...DONE, "epic-3": "backlog", "3.1": "done" }, evidence: [3] }));
    expect(retroCandidates(s)).toEqual([
      { epic: 2, evidence: "docs/maintainer/evidence/epic-2.md", evidenceOnMain: false, missingChecks: [], failingChecks: [] },
      { epic: 3, evidence: "docs/maintainer/evidence/epic-3.md", evidenceOnMain: true, missingChecks: [], failingChecks: [] },
    ]);
    expect([retroDue(s, 2), retroDue(s, 3), retroDue(s, 1)]).toEqual([false, true, false]);
  });

  describe("live_evidence_checks (retro item 14)", () => {
    const A = "XARABOT_LIVE=1 bun test test/e2e/claims-race.test.ts";
    const B = "XARABOT_LIVE=1 bun test test/contracts/";
    const EVIDENCE = "docs/maintainer/evidence/epic-2.md";
    const row = (cmd: string, result: string) => `| \`${cmd}\` | ${result} | 12 s |`;
    const evidence = (...rows: string[]) => ({ [EVIDENCE]: ["# Epic 2 live evidence", "", "| Command | Result | Time |", "|---|---|---|", ...rows, ""].join("\n") });
    const BOTH_PASS = evidence(row(A, "20 pass, 0 skip, 0 fail"), row(B, "107 pass, 72 skip, 0 fail"));
    const CHECKED: Partial<World> = { ...DUE, liveEvidenceChecks: { 2: [A, B] } };

    test("all present with 0 fail: due, and why says so", () => {
      const o = pick({ ...CHECKED, files: BOTH_PASS });
      expect(o.kind === "coordinator" ? [o.unit.unit, o.unit.why] : null).toEqual([
        "retro:2",
        `retro:2 is due: Epic 2's Stories are all done, its retro is not recorded and ${EVIDENCE} is on main with each required live result`,
      ]);
    });

    test("one missing: idle waiting-on-maintainer, naming the command", () => {
      const o = pick({ ...CHECKED, files: evidence(row(A, "20 pass, 0 skip, 0 fail")) });
      expect(picked(o)).toBe("idle");
      expect(reasonOf(o).startsWith(`${WAITING_ON_MAINTAINER}retro:2 waits for the live evidence file ${EVIDENCE} on main to hold each required live result: missing \`${B}\`;`)).toBe(true);
      expect(codes(o)).toEqual(["reconcile:4 reconcile-not-due", "retro:2 live-evidence"]);
    });

    test("one with failures: idle waiting-on-maintainer, naming the command", () => {
      const o = pick({ ...CHECKED, files: evidence(row(A, "20 pass, 0 skip, 0 fail"), row(B, "116 pass, 43 skip, 20 fail")) });
      expect(picked(o)).toBe("idle");
      expect(reasonOf(o)).toStartWith(`${WAITING_ON_MAINTAINER}retro:2 waits for the live evidence file ${EVIDENCE} on main to hold each required live result: no '0 fail' summary after \`${B}\`;`);
    });

    test("one missing and one failing: both named", () => {
      const o = pick({ ...CHECKED, files: evidence(row(B, "1 fail")) });
      expect(reasonOf(o)).toContain(`required live result: missing \`${A}\`; no '0 fail' summary after \`${B}\``);
    });

    test("none listed for the Epic: existence alone is enough, as before", () => {
      const o = pick({ ...DUE, liveEvidenceChecks: { 3: [A] } });
      expect(o.kind === "coordinator" ? [o.unit.unit, o.unit.why] : null).toEqual([
        "retro:2",
        `retro:2 is due: Epic 2's Stories are all done, its retro is not recorded and ${EVIDENCE} is on main`,
      ]);
    });

    test("listed but the file absent: waits for the file, as before", () => {
      const o = pick({ status: DONE, liveEvidenceChecks: { 2: [A] } });
      expect(reasonOf(o)).toStartWith(`${WAITING_ON_MAINTAINER}retro:2 waits for the live evidence file ${EVIDENCE} on main;`);
    });

    test("a wildcard glob names the matched file", () => {
      const o = pick({ status: DONE, liveEvidenceGlob: "ev/e<N>-*.md", liveEvidenceChecks: { 2: [A] }, files: { "ev/e2-run.md": "nothing yet\n" } });
      expect(reasonOf(o)).toContain(`the live evidence file ev/e2-run.md on main to hold each required live result: missing \`${A}\``);
    });

    test("an Epic lacking a result passes to the next one", () => {
      const w = { epics: { 1: [], 2: ["1"], 3: ["1"] }, status: { ...DONE, "epic-3": "backlog", "3.1": "done" }, evidence: [2, 3], liveEvidenceChecks: { 2: [A] } };
      expect(picked(pick(w))).toBe("unit retro:3");
    });

    test("retroCandidates carries the gaps; retroDue needs none", () => {
      const s = snapshotOf(world({ ...CHECKED, files: evidence(row(B, "3 fail")) }));
      expect(retroCandidates(s)).toEqual([{ epic: 2, evidence: EVIDENCE, evidenceOnMain: true, missingChecks: [A], failingChecks: [B] }]);
      expect(retroDue(s, 2)).toBe(false);
      expect(retroDue(snapshotOf(world({ ...CHECKED, files: BOTH_PASS })), 2)).toBe(true);
    });
  });

  test("retro:<N> is done on main once retro-gates records its verdict", () => {
    const rec = retroRec({ state: "merged" });
    expect(doneOnMain(rec, snapshotOf(world({ ...DUE, records: [rec] })))).toBe(false);
    expect(doneOnMain(rec, snapshotOf(world({ ...DUE, records: [rec], retro: { 2: "rejected" } })))).toBe(true);
  });
});

describe("next(coordinator): retro items (Story 2.10)", () => {
  type ItemSpec = { readonly id: string; readonly route?: string; readonly status?: string; readonly globs?: readonly string[] };
  /** `retro-gates.yaml` with Epic → items, each Epic's retro recorded. */
  const gatesOf = (epics: Record<number, readonly ItemSpec[]>): string => {
    const lines = ["schema_version: 1", "epics:"];
    for (const [n, items] of Object.entries(epics)) {
      lines.push(`  "${n}":`, "    retro:", "      verdict: accepted-with-open-items", `      unit: "retro:${n}"`, "      recorded_at: 2026-10-20T00:00:00Z", "    items:");
      for (const i of items) {
        lines.push(
          `      - id: ${i.id}`,
          `        text: Do ${i.id}`,
          `        route: ${i.route ?? "lane"}`,
          "        blocking: false",
          `        globs: [${(i.globs ?? ["src/x/**"]).map((g) => JSON.stringify(g)).join(", ")}]`,
          `        status: ${i.status ?? "open"}`,
        );
      }
    }
    return `${lines.join("\n")}\n`;
  };
  const X = "epic-2-retro-item-1-fix-x";
  const Y = "epic-2-retro-item-2-fix-y";
  const UNIT_X = `retro-item:${X}`;
  const items = (epics: Record<number, readonly ItemSpec[]>): Partial<World> => ({ files: { [RETRO]: gatesOf(epics) } });
  const DUE = items({ 2: [{ id: X }] });
  const itemRec = (over: Partial<UnitRecord> = {}) => coord(UNIT_X, { globs: ["src/x/**"], ...over });
  const pick = (w: Partial<World>) => pickC({ ...w, records: [RECENT, ...(w.records ?? [])] });
  const codes = (o: NextOutcome) => (o.kind === "coordinator" || o.kind === "idle" ? o.reasons.map((r) => `${r.subject} ${r.code}`) : []);
  const BLOCKED: NonNullable<UnitRecord["park"]> = { kind: "blocked", reason: "verification", inbox_owner: "carol", globs_held: [] };

  test.each([
    ["due: an open lane item with globs", DUE, `unit ${UNIT_X}`],
    ["no globs: never returned", items({ 2: [{ id: X, globs: [] }] }), "idle"],
    ["a maintainer item: skipped", items({ 2: [{ id: X, route: "maintainer" }] }), "idle"],
    ["a waiting maintainer item: skipped (Story 4.3)", items({ 2: [{ id: X, route: "maintainer", status: "waiting" }] }), "idle"],
    ["a maintainer item passes to the lane item after it (Story 4.3)", items({ 2: [{ id: X, route: "maintainer", status: "waiting" }, { id: Y }] }), `unit retro-item:${Y}`],
    ["a done item: skipped", items({ 2: [{ id: X, status: "done" }] }), "idle"],
    ["an in-progress item: skipped", items({ 2: [{ id: X, status: "in-progress" }] }), "idle"],
    ["a deferred item: skipped", items({ 2: [{ id: X, status: "deferred" }] }), "idle"],
    ["a waiting item: skipped", items({ 2: [{ id: X, status: "waiting" }] }), "idle"],
    ["items in file order", items({ 2: [{ id: Y }, { id: X }] }), `unit retro-item:${Y}`],
    ["a skipped item passes to the next one", items({ 2: [{ id: X, status: "done" }, { id: Y }] }), `unit retro-item:${Y}`],
    ["a no-glob item passes to the next one", items({ 2: [{ id: X, globs: [] }, { id: Y }] }), `unit retro-item:${Y}`],
    ["Epics in ascending order", items({ 3: [{ id: "epic-3-retro-item-1-z" }], 2: [{ id: X }] }), `unit ${UNIT_X}`],
    ["Epics in numeric order: 2 before 10", items({ 10: [{ id: "epic-10-retro-item-1-z" }], 2: [{ id: X }] }), `unit ${UNIT_X}`],
    ["released, no PR: re-claimed", { ...DUE, records: [itemRec({ state: "released", generation: 2 })] }, `unit ${UNIT_X}`],
    ["stale claimed, no PR: taken over", { ...DUE, records: [itemRec({ heartbeat_at: minutesBefore(30) })] }, `unit ${UNIT_X}`],
    ["live claimed: holds", { ...DUE, records: [itemRec()] }, "idle"],
    ["parked: holds", { ...DUE, records: [itemRec({ state: "parked", park: BLOCKED })] }, "idle"],
    ["merged, waiting for reconcile: holds", { ...DUE, records: [itemRec({ state: "merged" })] }, "idle"],
    ["merging: holds", { ...DUE, records: [itemRec({ state: "merging", pr: 9, passed_sha: HEAD })] }, "idle"],
    ["a held item passes to the next one", { ...items({ 2: [{ id: X }, { id: Y, globs: ["src/y/**"] }] }), records: [itemRec()] }, `unit retro-item:${Y}`],
  ] as const)("%s → %s", (_name, w, want) => {
    expect(picked(pick(w as Partial<World>))).toBe(want);
  });

  test("the unit: its globs, its branch, a new claim, and why", () => {
    const o = pick(DUE);
    expect(o.kind === "coordinator" ? o.unit : null).toEqual({
      unit: UNIT_X,
      kind: "retro-item",
      globs: ["src/x/**"],
      expect_generation: null,
      take_over: null,
      pr: null,
      why: `${UNIT_X} is due: Epic 2's retro item is open and routed to a lane`,
    });
    expect(coordinatorGlobs({ kind: "retro-item", globs: ["src/x/**"] }, CONFIG_DEFAULTS)).toEqual(["src/x/**"]);
    expect(unitBranch(CONFIG_DEFAULTS.branches.xarabot, UNIT_X)).toBe(`xarabot/retro-item-${X}`);
  });

  test("released: re-claimed at its generation; stale claimed: taken over at its generation", () => {
    const released = pick({ ...DUE, records: [itemRec({ state: "released", generation: 2 })] });
    expect(released.kind === "coordinator" ? [released.unit.expect_generation, released.unit.take_over] : null).toEqual([2, null]);
    const stale = pick({ ...DUE, records: [itemRec({ heartbeat_at: minutesBefore(30), generation: 3 })] });
    expect(stale.kind === "coordinator" ? [stale.unit.expect_generation, stale.unit.take_over] : null).toEqual([3, "claimed"]);
  });

  test("a released record with its PR open is the open-PR position's (adopted)", () => {
    const o = pick({ ...DUE, records: [itemRec({ state: "released", pr: 9 })], prs: { [UNIT_X]: open(9) } });
    expect(o.kind === "coordinator" ? [o.unit.unit, o.unit.kind, o.unit.pr, o.unit.why] : null).toEqual([UNIT_X, "retro-item", 9, `${UNIT_X} is released with PR #9 open`]);
  });

  test("a released record with its PR open whose globs overlap a held glob: not adopted, an overlap reason, later positions wait", () => {
    const held = storyRec("2.1", { globs: ["src/**"] });
    const o = pick({ ...DUE, records: [held, itemRec({ state: "released", pr: 9 })], prs: { [UNIT_X]: open(9) } });
    expect(picked(o)).toBe("idle");
    expect(codes(o)).toContain(`${UNIT_X} overlap`);
    expect(reasonOf(o)).toContain("waiting on an open coordinator PR");
    expect(reasonOf(o)).toContain(`${UNIT_X} with PR #9 open glob "src/x/**" overlaps "src/**" held by story:2.1`);
  });

  test("a stale claimed record with its PR open whose globs overlap a held glob: not taken over", () => {
    const held = storyRec("2.1", { globs: ["src/**"] });
    const o = pick({ ...DUE, records: [held, itemRec({ heartbeat_at: minutesBefore(30), pr: 9 })], prs: { [UNIT_X]: open(9) } });
    expect(picked(o)).toBe("idle");
    expect(codes(o)).toContain(`${UNIT_X} overlap`);
  });

  test("no globs: an unclaimable reason naming the item", () => {
    const o = pick(items({ 2: [{ id: X, globs: [] }] }));
    expect(codes(o)).toEqual(["reconcile:4 reconcile-not-due", `${UNIT_X} unclaimable`]);
    expect(reasonOf(o)).toContain(`${UNIT_X} is unclaimable: the item has no globs`);
  });

  test("a maintainer or done item gets no reason", () => {
    expect(codes(pick(items({ 2: [{ id: X, route: "maintainer" }, { id: Y, status: "done" }] })))).toEqual(["reconcile:4 reconcile-not-due"]);
  });

  test("a held record is a record-state reason", () => {
    const o = pick({ ...DUE, records: [itemRec({ state: "parked", park: BLOCKED })] });
    expect(codes(o)).toContain(`${UNIT_X} record-state`);
    expect(reasonOf(o)).toContain(`${UNIT_X} is due but its record is parked blocked verification`);
  });

  test("an overlap with any held glob passes the item over", () => {
    const held = storyRec("2.1", { globs: ["src/**"] });
    const o = pick({ ...DUE, records: [held] });
    expect(picked(o)).toBe("idle");
    expect(codes(o)).toContain(`${UNIT_X} overlap`);
    expect(reasonOf(o)).toContain(`glob "src/x/**" overlaps "src/**" held by story:2.1`);
  });

  test("retro goes first: a due retro before a due item", () => {
    const w = { ...items({ 2: [{ id: X }] }), epics: { 1: [], 2: ["1"], 3: ["1"] }, status: { "epic-2": "backlog", "2.1": "done", "epic-3": "backlog", "3.1": "done" }, evidence: [3] };
    expect(picked(pick(w))).toBe("unit retro:3");
  });

  test("planning goes first: a missing status key before a due item", () => {
    expect(picked(pick({ ...DUE, status: { "2.1": "backlog" } }))).toBe("unit planning:status.1");
  });

  test("retroItemCandidates: open lane items, Epics ascending, file order, globs or not", () => {
    const s = snapshotOf(world(items({ 3: [{ id: "epic-3-retro-item-1-z", globs: [] }], 2: [{ id: Y }, { id: X, route: "maintainer" }, { id: "epic-2-retro-item-3-w", status: "done" }] })));
    expect(retroItemCandidates(s).map((c) => [c.epic, c.item.id])).toEqual([
      [2, Y],
      [3, "epic-3-retro-item-1-z"],
    ]);
    expect(retroItemUnit(X)).toBe(UNIT_X);
  });

  test("retro-item:<id> is done on main once its item is done", () => {
    const rec = itemRec({ state: "merged" });
    expect(doneOnMain(rec, snapshotOf(world({ ...DUE, records: [rec] })))).toBe(false);
    expect(doneOnMain(rec, snapshotOf(world({ ...items({ 2: [{ id: X, status: "done" }] }), records: [rec] })))).toBe(true);
  });
});
