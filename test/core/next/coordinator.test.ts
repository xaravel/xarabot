import { describe, expect, test } from "bun:test";
import { claim } from "../../../src/core/ledger/edits.ts";
import {
  coordinatorGlobs,
  digestDue,
  doneOnMain,
  nextCoordinator,
  reconcileDue,
  type CoordinatorUnitSpec,
} from "../../../src/core/next/coordinator.ts";
import { next, type NextOutcome } from "../../../src/core/next/next.ts";
import { CONFIG_DEFAULTS } from "../../../src/core/schemas/config.ts";
import type { CoordinatorRecord, UnitRecord } from "../../../src/core/schemas/ledger.ts";
import type { PrState } from "../../../src/core/schemas/snapshot.ts";
import { ALICE, COORD, tip } from "../ledger/fixtures.ts";
import { EPICS_MD, NOW, RETRO, STATUS, rec, snapshotOf, storyRec, type World } from "./fixtures.ts";

// NOW is 2026-10-22T10:10:00Z: past the default 08:00 digest slot.
const TODAY_DIGEST = "2026-10-22T08:00:00Z";
const minutesBefore = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();
const HEAD = "e".repeat(40);

/** A live coordinator claim whose digest is posted for today, so the digest slot is no work. */
function coordinator(over: Partial<CoordinatorRecord> = {}): CoordinatorRecord {
  return {
    schema_version: 1,
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

const open = (n: number): PrState => ({ number: n, state: "open", head_sha: HEAD });
const merged = (n: number): PrState => ({ number: n, state: "merged", head_sha: HEAD });

const STATUS_GLOBS = [STATUS, RETRO, "_bmad-output/implementation-artifacts/epic-*-context.md"];

/** Epic 1 bootstrapped, Epic 2 with Story 2.1 eligible; the coordinator's view. */
function world(extra: Partial<World> = {}): World {
  return { epics: { 1: [], 2: ["1"] }, bootstrapped: [1], role: "coordinator", coordinator: coordinator(), ...extra };
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
    ["work shown: the digest slot passed unposted", { records: [RECENT], coordinator: coordinator({ digest_posted_at: null }) }, "unit reconcile:5"],
    ["work shown: the digest was last posted yesterday", { records: [RECENT], coordinator: coordinator({ digest_posted_at: "2026-10-21T08:00:00Z" }) }, "unit reconcile:5"],
    ["under 10 min, no work: not due", { records: [reconciled(4, 9)] }, "idle"],
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

  test("a configured digest_time already passed (09:00), last posted at 08:00: due, naming the configured time", () => {
    const w = world({ records: [RECENT], digestTime: "09:00" });
    const o = next(snapshotOf(w), "coordinator");
    expect(picked(o)).toBe("unit reconcile:5");
    expect(o.kind === "coordinator" ? o.unit.why : "").toBe("the 09:00 UTC digest is due");
  });

  test("reconcileDue reports the last run", () => {
    const r = reconcileDue(snapshotOf(world({ records: [reconciled(4, 9)] })));
    expect(r.due).toBe(false);
    expect(r.last?.unit).toBe("reconcile:4");
    expect(reconcileDue(snapshotOf(world())).last).toBeNull();
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

  test("a builder's released record with an open PR is not a coordinator PR", () => {
    const o = pickC(base([storyRec("2.1", { state: "released", pr: 7 })], { "story:2.1": open(7) }));
    expect(o.kind).toBe("idle");
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
    ["checkpoint:3", { kind: "checkpoint", epic: 3 }, [STATUS, RETRO, "_bmad-output/implementation-artifacts/epic-3-context.md"]],
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
    ["planning (a merged recurring record)", "planning:status.1", true],
    ["an older reconcile", "reconcile:3", true],
    ["the newest reconcile", "reconcile:4", false],
  ] as const)("%s: %s → %p", (_name, unit, want) => {
    expect(doneOnMain(m(unit), snap)).toBe(want);
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
