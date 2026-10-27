import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EMPTY_INBOX_BODY } from "../../src/core/inbox/render-digest.ts";
import { STALE_AFTER_MS } from "../../src/core/ledger/edits.ts";
import { missingStatusEntries } from "../../src/core/next/coordinator.ts";
import type { LaneIdentity, UnitRecord } from "../../src/core/schemas/ledger.ts";
import { rec } from "../core/ledger/fixtures.ts";
import { liveGithubEnabled } from "../support/live-github.ts";
import { isSandboxed } from "../support/sandbox.ts";
import { step } from "./cross-vendor-harness.ts";
import {
  assembleAs,
  BOOTSTRAPPED,
  builderRound,
  checkpointProblems,
  claimedUnits,
  daysBefore,
  digestCase,
  digestProblems,
  expectedDigest,
  fakeGatesArea,
  FAKE_NOW,
  GATES_EPICS,
  GATES_PATH,
  gatesWorld,
  GO_CHECKPOINT_10,
  globOf,
  INTENT_GAP_TEXT,
  itemId,
  ledgerOf,
  liveGatesArea,
  ruledOnto,
  runCheckpointCase,
  runDigestCase,
  seedLedger,
  storyUnit,
  wholeDays,
  type BuilderOutcome,
  type CheckpointObserved,
  type ExpectedItem,
  type FakeGatesArea,
  type GatesArea,
  type GatesWorldOptions,
} from "./parallel-epics-harness.ts";

/**
 * Story 4.7 (FR5, FR10): on a graph shaped like Xaravel Phase 1, builders
 * take Stories from several Epics at once exactly as the graph allows, and
 * every hold (dependency, checkpoint, rejected retro, retro item) holds
 * exactly the right Epics through `next`. The checkpoint go and the digest
 * run on the scratch repo too (`live gates:`), each rehearsed here on the
 * fake forge.
 */

const ROOT = join(import.meta.dir, "..", "..");

const areas: GatesArea[] = [];
afterEach(async () => {
  for (const a of areas.splice(0)) await a.cleanup();
});

function fresh(): FakeGatesArea {
  const a = fakeGatesArea();
  areas.push(a);
  return a;
}

/** Epic 9 done with an `accepted` retro. */
const P1: GatesWorldOptions = { done: [9], retros: { 9: "accepted" } };
/** P1 plus Epic 10 done with an `accepted` retro. */
const P2: GatesWorldOptions = { done: [9, 10], retros: { 9: "accepted", 10: "accepted" } };

type Round = {
  readonly area: FakeGatesArea;
  readonly outcomes: BuilderOutcome[];
  readonly claimed: string[];
  /** Every idle builder's reason. */
  readonly idle: string[];
};

/** One builder round on a fresh fake area with `world` laid over `main`, after `records` are seeded. */
async function round(world: GatesWorldOptions, o: { readonly records?: (area: FakeGatesArea) => UnitRecord[]; readonly builders?: number } = {}): Promise<Round> {
  const area = fresh();
  area.forge.setWorld(gatesWorld({ ...world, repo: area.repo, login: area.login }));
  if (o.records !== undefined) await seedLedger(area, o.records(area));
  const outcomes = await builderRound(area.forge, area.repo, area.builders(o.builders ?? 4));
  return { area, outcomes, claimed: claimedUnits(outcomes), idle: outcomes.filter((x) => x.kind === "idle").map((x) => x.reason ?? "") };
}

const all = (...epics: number[]): string[] => epics.map((e) => storyUnit(e, 1)).sort();
const ID9U = itemId(9, 1, "untagged-runtime");
const ID10 = itemId(10, 1, "contracts-follow-up");

// ------------------------------------------------------------ the world

describe("the world", () => {
  test("it loads: the snapshot assembles, every Epic outside bootstrapped_epics has a valid context, and no status entry is missing", async () => {
    for (const world of [{}, P2, digestCase(fresh(), FAKE_NOW).world] as GatesWorldOptions[]) {
      const area = fresh();
      area.forge.setWorld(gatesWorld({ ...world, repo: area.repo, login: area.login }));
      await seedLedger(area);
      const snap = await area.forge.snapshot({ signal: AbortSignal.timeout(5000), read: () => true });
      if (!snap.ok) throw new Error(snap.error.message);
      const s = assembleAs(area.repo, snap.value, area.builders(1)[0] as LaneIdentity, "builder");
      expect(s.graph.ok).toBe(true);
      if (!s.graph.ok) continue;
      expect(s.graph.value.epics.map((e) => e.number)).toEqual([...BOOTSTRAPPED, 9, 10, 11, 12, 13, 14]);
      expect(s.config.bootstrapped_epics).toEqual([...BOOTSTRAPPED]);
      for (const e of GATES_EPICS) expect([e.epic, s.epic_context[String(e.epic)]]).toEqual([e.epic, "valid"]);
      expect(missingStatusEntries(s)).toEqual([]);
      expect(s.graph.value.unmanifested).toEqual([]);
    }
  });

  test("every epics.yaml entry is explicit: 9 after 8, 10 after 9, 11 to 13 after 10, 14 after 9; 8 a checkpoint after 7", async () => {
    const area = fresh();
    area.forge.setWorld(gatesWorld({ repo: area.repo, login: area.login, checkpoint: [10] }));
    const snap = await area.forge.snapshot({ signal: AbortSignal.timeout(5000), read: () => true });
    if (!snap.ok) throw new Error(snap.error.message);
    const s = assembleAs(area.repo, snap.value, area.builders(1)[0] as LaneIdentity, "builder");
    if (!s.graph.ok) throw new Error(s.graph.error.message);
    const deps = Object.fromEntries(s.graph.value.epics.map((e) => [e.number, e.depends_on]));
    expect(deps).toMatchObject({ 8: [7], 9: [8], 10: [9], 11: [10], 12: [10], 13: [10], 14: [9] });
    expect(s.graph.value.checkpoints).toEqual([8, 10]);
    expect(s.manifests.find((m) => m.story_id === "13.2")).toMatchObject({ sprint_key: "13-2-json-schema", paths: { kind: "globs", globs: [globOf(13)] }, depends_on: ["13.1"] });
  });

  test("the overlay hides the scratch seed's own Story and context, and keeps the rest of main", async () => {
    const area = fresh();
    area.forge.setWorld(gatesWorld({ repo: area.repo, login: area.login }));
    const snap = await area.forge.snapshot({ signal: AbortSignal.timeout(5000) });
    if (!snap.ok) throw new Error(snap.error.message);
    expect(snap.value.main.tree).not.toContain("stories/1.1.md");
    expect(snap.value.main.tree).toContain("docs/maintainer/standing-authority.md");
    expect(snap.value.main.tree).toContain("stories/14.2.md");
  });
});

// ------------------------------------------------------------ the fixture rows

describe("the gates through next (fixture rows)", () => {
  test("serial start: nothing done, so only story:9.1 is claimed; 9.2 waits on it and Epics 10 to 14 wait on their dependency", async () => {
    const r = await round({});
    expect(r.claimed).toEqual(["story:9.1"]);
    expect(r.idle).toHaveLength(3);
    for (const why of r.idle) {
      expect(why).toContain("Story 9.2 waits on Story 9.1");
      for (const n of [10, 14]) expect(why).toContain(`Epic ${n} waits on Epic 9`);
      for (const n of [11, 12, 13]) expect(why).toContain(`Epic ${n} waits on Epic 10`);
    }
  });

  test("Epic 8's go pending: no claim, and every idle reason waits on the Maintainer naming checkpoint:8", async () => {
    const r = await round({ epic8Go: false });
    expect(r.claimed).toEqual([]);
    expect(r.idle).toHaveLength(4);
    for (const why of r.idle) {
      expect(why.startsWith("waiting-on-maintainer: ")).toBe(true);
      expect(why).toContain("checkpoint:8");
    }
  });

  test("dependency retro missing: Epic 9 done with no retro, so neither 10 nor 14 takes a Story", async () => {
    const r = await round({ done: [9] });
    expect(r.claimed).toEqual([]);
    expect(r.idle).toHaveLength(4);
    for (const why of r.idle) {
      expect(why).toContain("Epic 10 waits on Epic 9: its retro is not recorded");
      expect(why).toContain("Epic 14 waits on Epic 9: its retro is not recorded");
    }
  });

  test("after runtime (P1): 10.1 and 14.1 are claimed", async () => {
    expect((await round(P1)).claimed).toEqual(all(10, 14));
  });

  test("AC1 parallel (P2): 11.1, 12.1, 13.1 and 14.1 are claimed and held on the ledger at once; a fifth builder idles", async () => {
    const r = await round(P2, { builders: 5 });
    expect(r.claimed).toEqual(all(11, 12, 13, 14));
    expect(r.outcomes.map((o) => o.kind)).toEqual(["claimed", "claimed", "claimed", "claimed", "idle"]);
    const { units } = await ledgerOf(r.area.forge);
    expect([...units.values()].filter((u) => u.state === "claimed").map((u) => u.unit).sort()).toEqual(all(11, 12, 13, 14));
    expect(new Set([...units.values()].map((u) => u.lane)).size).toBe(4);
  });

  test("AC2 checkpoint pending (P2, checkpoint 10, no go): only 14.1 is claimed; Epics 11 to 13 are held naming checkpoint:10", async () => {
    const r = await round({ ...P2, checkpoint: [10] });
    expect(r.claimed).toEqual(all(14));
    expect(r.idle).toHaveLength(3);
    for (const why of r.idle) {
      for (const n of [11, 12, 13]) expect(why).toContain(`Epic ${n} is held by checkpoint Epic 10 (checkpoint:10), which has no go`);
    }
  });

  test("checkpoint, only Maintainer causes: with Epic 14 done too, every builder idles waiting on the Maintainer", async () => {
    const r = await round({ done: [9, 10, 14], retros: { 9: "accepted", 10: "accepted", 14: "accepted" }, checkpoint: [10] });
    expect(r.claimed).toEqual([]);
    expect(r.idle).toHaveLength(4);
    for (const why of r.idle) {
      expect(why.startsWith("waiting-on-maintainer: ")).toBe(true);
      expect(why).toContain("checkpoint:10");
    }
  });

  test("checkpoint, retro not done: Epic 10 done with no retro holds 11 to 13 (whose retro is not done), not as a Maintainer cause", async () => {
    const r = await round({ done: [9, 10], retros: { 9: "accepted" }, checkpoint: [10] });
    expect(r.claimed).toEqual(all(14));
    expect(r.idle).toHaveLength(3);
    for (const why of r.idle) {
      expect(why).toContain("Epic 11 is held by checkpoint Epic 10 (checkpoint:10), whose retro is not done");
      expect(why.startsWith("waiting-on-maintainer:")).toBe(false);
    }
  });

  test("late checkpoint, in flight: a stale 11.1 is taken over, a fresh 12.1 stays its holder's, and 11 to 13 take no new Story", async () => {
    const holder = { owner: "alice", host: "77777777-7777-4777-8777-777777777777", lane: "builder-7" };
    const records = (): UnitRecord[] => [
      rec({ unit: "story:11.1", ...holder, globs: [globOf(11)], heartbeat_at: new Date(Date.parse(FAKE_NOW) - STALE_AFTER_MS - 60_000).toISOString() }),
      rec({ unit: "story:12.1", ...holder, globs: [globOf(12)], heartbeat_at: new Date(Date.parse(FAKE_NOW) - 5 * 60_000).toISOString() }),
    ];
    const r = await round({ ...P2, checkpoint: [10] }, { records });
    expect(r.outcomes.filter((o) => o.kind === "took-over").map((o) => o.unit)).toEqual(["story:11.1"]);
    expect(r.outcomes.filter((o) => o.kind === "claimed").map((o) => o.unit)).toEqual(["story:14.1"]);
    const { units } = await ledgerOf(r.area.forge);
    expect(units.get("story:11.1")).toMatchObject({ state: "claimed", lane: "builder-1", generation: 2, attempts: 1 });
    expect(units.get("story:12.1")).toMatchObject({ state: "claimed", lane: "builder-7", generation: 1 });
    expect([...units.keys()].filter((u) => /^story:1[123]\./.test(u)).sort()).toEqual(["story:11.1", "story:12.1"]);
  });

  test("checkpoint go: with checkpoint 10's go recorded, 11.1, 12.1 and 13.1 are claimed", async () => {
    expect((await round({ ...P2, checkpoint: [10], checkpointGo: [10] })).claimed).toEqual(all(11, 12, 13, 14));
  });

  describe("AC3 rejected retro", () => {
    const REJECTED: GatesWorldOptions = { done: [9, 10], retros: { 9: "accepted", 10: "rejected" } };

    test("contracts' retro rejected: only 14.1 is claimed; 11 to 13 are held naming retro:10", async () => {
      const r = await round(REJECTED);
      expect(r.claimed).toEqual(all(14));
      expect(r.idle).toHaveLength(3);
      for (const why of r.idle) {
        for (const n of [11, 12, 13]) expect(why).toContain(`Epic ${n} is held by Epic 10's rejected retro (retro:10), which has no go`);
      }
    });

    test("go retro ruled: /xarabot go retro:10 from the Maintainer, carried onto main, lets 11.1, 12.1 and 13.1 be claimed", async () => {
      const r = await round(REJECTED);
      const ruled = ruledOnto(r.area.forge.world, { author: r.area.login, body: "/xarabot go retro:10", id: "9001", created_at: FAKE_NOW }, r.area);
      expect(ruled.judged.map((j) => j.judgement.kind)).toEqual(["valid"]);
      expect(ruled.main[GATES_PATH]).toContain('ruling: "9001"');
      r.area.forge.setWorld(ruled.main);
      const after = await builderRound(r.area.forge, r.area.repo, r.area.builders(4));
      expect(claimedUnits(after)).toEqual(all(11, 12, 13));
    });

    test("the same comment from another login is refused, and 11 to 13 stay held", async () => {
      const r = await round(REJECTED);
      const ruled = ruledOnto(r.area.forge.world, { author: "mallory", body: "/xarabot go retro:10", id: "9002", created_at: FAKE_NOW }, r.area);
      expect(ruled.judged[0]?.judgement).toMatchObject({ kind: "refused", reason: "only the Maintainer (alice) may rule `go`" });
      expect(ruled.main).toBe(r.area.forge.world);
      r.area.forge.setWorld(ruled.main);
      const after = await builderRound(r.area.forge, r.area.repo, r.area.builders(4));
      expect(claimedUnits(after)).toEqual([]);
      for (const o of after) expect(o.reason).toContain("Epic 11 is held by Epic 10's rejected retro (retro:10)");
    });
  });

  describe("FR10: retro items go by distance", () => {
    const untagged9 = { epic: 9, seq: 1, slug: "untagged-runtime", blocking: false } as const;

    test("AC5 an untagged open item on Epic 9: P1 claims 10.1 and 14.1 (distance 1); P2 holds 11 to 13 (distance 2) and claims 14.1", async () => {
      expect((await round({ ...P1, items: [untagged9] })).claimed).toEqual(all(10, 14));
      const p2 = await round({ ...P2, items: [untagged9] });
      expect(p2.claimed).toEqual(all(14));
      expect(p2.idle).toHaveLength(3);
      for (const why of p2.idle) {
        for (const n of [11, 12, 13]) expect(why).toContain(`Epic ${n} is held by Epic 9's retro item retro-item:${ID9U} (open, untagged, distance 2)`);
      }
    });

    test("a blocking item on Epic 9: P1 claims nothing from 10 or 14; P2 nothing from 11 to 14", async () => {
      const blocking = { ...untagged9, blocking: true };
      expect((await round({ ...P1, items: [blocking] })).claimed).toEqual([]);
      const p2 = await round({ ...P2, items: [blocking] });
      expect(p2.claimed).toEqual([]);
      expect(p2.idle).toHaveLength(4);
      for (const why of p2.idle) expect(why).toContain("Epic 14 is held by Epic 9's retro item");
    });

    test("an item on contracts: untagged lets 11 to 13 run (distance 1); blocking holds them, and 14.1 still runs (14 does not reach 10)", async () => {
      const item = { epic: 10, seq: 1, slug: "contracts-follow-up" };
      expect((await round({ ...P2, items: [{ ...item, blocking: false }] })).claimed).toEqual(all(11, 12, 13, 14));
      const held = await round({ ...P2, items: [{ ...item, blocking: true }] });
      expect(held.claimed).toEqual(all(14));
      expect(held.idle).toHaveLength(3);
      for (const why of held.idle) expect(why).toContain(`Epic 11 is held by Epic 10's retro item retro-item:${ID10} (open, blocking, distance 1)`);
    });

    test.each([
      ["in-progress", true],
      ["waiting", true],
      ["deferred", false],
      ["done", false],
    ] as const)("a blocking item on Epic 10 with status %s holds 11 to 13: %p", async (status, holds) => {
      const r = await round({ ...P2, items: [{ epic: 10, seq: 1, slug: "contracts-follow-up", blocking: true, status }] });
      expect(r.claimed).toEqual(holds ? all(14) : all(11, 12, 13, 14));
    });

    test.each([
      ["accepted-with-open-items with no items", { done: [9, 10], retros: { 9: "accepted", 10: "accepted-with-open-items" } }],
      ["rejected with a go", { done: [9, 10], retros: { 9: "accepted", 10: "rejected" }, retroGo: [10] }],
    ] as const)("Epic 10's verdict %s holds nothing", async (_name, world) => {
      expect((await round(world as GatesWorldOptions)).claimed).toEqual(all(11, 12, 13, 14));
    });

    test("a blocking Maintainer item on Epic 10, with Epic 14 done: every builder idles waiting on the Maintainer, naming the item", async () => {
      const r = await round({
        done: [9, 10, 14],
        retros: { 9: "accepted", 10: "accepted", 14: "accepted" },
        items: [{ epic: 10, seq: 1, slug: "contracts-follow-up", route: "maintainer", blocking: true, status: "waiting" }],
      });
      expect(r.claimed).toEqual([]);
      expect(r.idle).toHaveLength(4);
      for (const why of r.idle) {
        expect(why.startsWith("waiting-on-maintainer: ")).toBe(true);
        expect(why).toContain(`retro-item:${ID10}`);
      }
    });

    test("block ruling: /xarabot block on an untagged contracts item, carried onto main, holds 11 to 13 on a fresh ledger", async () => {
      const world: GatesWorldOptions = { ...P2, items: [{ epic: 10, seq: 1, slug: "contracts-follow-up", blocking: false }] };
      const before = await round(world);
      expect(before.claimed).toEqual(all(11, 12, 13, 14));
      const ruled = ruledOnto(before.area.forge.world, { author: before.area.login, body: `/xarabot block retro-item:${ID10}`, id: "9003", created_at: FAKE_NOW }, before.area);
      expect(ruled.judged.map((j) => j.judgement.kind)).toEqual(["valid"]);
      const area = fresh();
      area.forge.setWorld(ruled.main);
      const after = await builderRound(area.forge, area.repo, area.builders(4));
      expect(claimedUnits(after)).toEqual(all(14));
      expect(after.map((o) => o.kind)).toEqual(["claimed", "idle", "idle", "idle"]);
      for (const o of after.filter((x) => x.kind === "idle")) expect(o.reason).toContain(`retro-item:${ID10} (open, blocking, distance 1)`);
    });
  });
});

// ------------------------------------------------------------ the checks

describe("checkpointProblems", () => {
  const GOOD: CheckpointObserved = {
    login: "alice",
    claimedBefore: ["story:14.1"],
    inboxBefore: "🤖 Xarabot inbox: 1 item waits on you.\n\n### Checkpoint gos (1)\n\n- [checkpoint:10](https://github.com/acme/scratch/blob/main/x) · Epic 10's retro is recorded (accepted) · 5d · `/xarabot go checkpoint:10`\n",
    comment: { id: "42", created_at: "2026-10-25T10:05:00Z" },
    pending: [{ verb: "go", unit: "checkpoint:10", by: "alice", at: "2026-10-25T10:05:00Z", ruling: "42" }],
    replies: ["🤖 Ruling acknowledged: `/xarabot go checkpoint:10` from alice ([comment](https://github.com/acme/scratch/issues/1001#issuecomment-42))."],
    pr: 7,
    committedGates: [
      "schema_version: 1",
      "epics:",
      '  "10":',
      "    checkpoint:",
      "      go:",
      '        by: "alice"',
      '        at: "2026-10-25T10:05:00Z"',
      '        ruling: "42"',
      "",
    ].join("\n"),
    inboxAfter: EMPTY_INBOX_BODY,
    claimedAfter: ["story:11.1", "story:12.1", "story:13.1"],
  };

  test("a run that shows AC 4 has no problem", () => {
    expect(checkpointProblems(GOOD)).toEqual([]);
    // The login is compared case-insensitively, as GitHub logins are.
    expect(checkpointProblems({ ...GOOD, login: "Alice" })).toEqual([]);
  });

  test.each([
    ["another claim before the go", { claimedBefore: ["story:11.1", "story:14.1"] }, "not only story:14.1"],
    ["round 1's inbox without checkpoint:10", { inboxBefore: EMPTY_INBOX_BODY }, "does not list checkpoint:10"],
    ["no pending go", { pending: [] }, "not exactly the go of checkpoint:10"],
    ["a pending go by another login", { pending: [{ ...GOOD.pending[0], by: "bob" }] }, "is by bob"],
    ["a pending go at another time", { pending: [{ ...GOOD.pending[0], at: "2026-10-25T10:06:00Z" }] }, "not the comment's created_at"],
    ["a pending go with another ruling", { pending: [{ ...GOOD.pending[0], ruling: "43" }] }, "not the comment's id"],
    ["a pending ruling whose verb is not go", { pending: [{ ...GOOD.pending[0], verb: "block" }] }, "verb is block, not go"],
    ["a second pending ruling", { pending: [...GOOD.pending, { verb: "go", unit: "retro:9", by: "alice", at: "2026-10-25T10:05:00Z", ruling: "44" }] }, "2 pending ruling(s)"],
    ["no ack", { replies: [] }, "0 replies start"],
    ["two acks", { replies: [...GOOD.replies, ...GOOD.replies] }, "2 replies start"],
    ["a refusal instead of an ack", { replies: ["🤖 Ruling not applied ([comment](u)): only the Maintainer (alice) may rule `go`. Nothing changed."] }, "0 replies start"],
    ["an ack from another login", { replies: ["🤖 Ruling acknowledged: `/xarabot go checkpoint:10` from bob ([comment](u))."] }, "0 replies start"],
    ["no PR", { pr: null }, "opened and enqueued no PR"],
    ["no committed retro-gates.yaml", { committedGates: null }, "committed no retro-gates.yaml"],
    ["a committed file without the go", { committedGates: "schema_version: 1\nepics: {}\n" }, "sets no epics.10.checkpoint.go"],
    ["a committed go with another ruling", { committedGates: (GOOD.committedGates as string).replace('ruling: "42"', 'ruling: "41"') }, "not by alice"],
    ["a committed go by another login", { committedGates: (GOOD.committedGates as string).replace('by: "alice"', 'by: "bob"') }, "not by alice"],
    ["a committed file that does not parse", { committedGates: "epics: [" }, "does not parse"],
    ["an inbox still listing the item", { inboxAfter: GOOD.inboxBefore }, "is not empty"],
    ["13.1 not claimed after the merge", { claimedAfter: ["story:11.1", "story:12.1"] }, "story:13.1 was not claimed"],
  ] as const)("%s is named", (_name, change, fragment) => {
    const problems = checkpointProblems({ ...GOOD, ...(change as Partial<CheckpointObserved>) });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain(fragment);
  });
});

describe("digestProblems", () => {
  const URL = "https://github.com/acme/scratch/blob/main/_bmad-output/implementation-artifacts/retro-gates.yaml";
  const EXPECTED: ExpectedItem[] = [
    { label: "checkpoint:10", url: URL, age: "3d" },
    { label: "story:11.1", url: "https://github.com/acme/scratch/blob/xarabot/claims/units/story__11.1.json", age: "<1d" },
  ];
  const BODY = [
    "🤖 Xarabot inbox: 2 items wait on you.",
    "",
    "### Needs approval (1)",
    "",
    "- [story:11.1](https://github.com/acme/scratch/blob/xarabot/claims/units/story__11.1.json) · needs approval · <1d · `/xarabot approve story:11.1`",
    "",
    "### Checkpoint gos (1)",
    "",
    `- [checkpoint:10](${URL}) · Epic 10's retro is recorded (accepted) · 3d · \`/xarabot go checkpoint:10\``,
    "",
    "Each reconcile run rewrites this list; ages are in whole days.",
    "",
  ].join("\n");

  test("a body listing each expected item once, with its link and age, has no problem", () => {
    expect(digestProblems(BODY, EXPECTED)).toEqual([]);
  });

  test.each([
    ["a header counting another number", BODY.replace("2 items wait", "3 items wait"), "counts 3 items, not 2"],
    ["no header", BODY.replace("🤖 Xarabot inbox: 2 items wait on you.", "Inbox"), "not the digest header"],
    ["the empty inbox", EMPTY_INBOX_BODY, "not the digest header"],
    ["an item missing", BODY.replace(/^- \[checkpoint:10\].*$/m, ""), "checkpoint:10: 0 lines start"],
    ["an item listed twice", BODY.replace(/^(- \[checkpoint:10\].*)$/m, "$1\n$1"), "checkpoint:10: 2 lines start"],
    ["an item with another link", BODY.replace(`[checkpoint:10](${URL})`, "[checkpoint:10](https://example.com/x)"), "checkpoint:10: 0 lines start"],
    ["an item with another age", BODY.replace("· 3d ·", "· 2d ·"), "does not hold the age 3d"],
    ["an item with no age", BODY.replace(" · <1d", ""), "does not hold the age <1d"],
    ["an unexpected item", BODY.replace("### Checkpoint gos (1)", "- [retro:9](u) · rejected, no go · 1d\n\n### Checkpoint gos (1)"), "an unexpected item line"],
  ] as const)("%s is named", (_name, body, fragment) => {
    expect(digestProblems(body, EXPECTED).join("\n")).toContain(fragment);
  });

  test("an item with no age (a bootstrapped checkpoint) need hold none", () => {
    const undated: ExpectedItem[] = [{ label: "checkpoint:8", url: URL, age: null }];
    const body = ["🤖 Xarabot inbox: 1 item waits on you.", "", `- [checkpoint:8](${URL}) · Epic 8 is bootstrapped · \`/xarabot go checkpoint:8\``, ""].join("\n");
    expect(digestProblems(body, undated)).toEqual([]);
  });

  test("ages are whole days, <1d under one", () => {
    expect(wholeDays(FAKE_NOW, daysBefore(FAKE_NOW, 0))).toBe("<1d");
    expect(wholeDays(FAKE_NOW, daysBefore(FAKE_NOW, 1))).toBe("1d");
    expect(wholeDays(FAKE_NOW, daysBefore(FAKE_NOW, 5))).toBe("5d");
    expect(wholeDays(FAKE_NOW, FAKE_NOW)).toBe("<1d");
  });

  test("the digest case expects exactly 8 items, each with its link and age", () => {
    const area = fresh();
    const { world, records } = digestCase(area, FAKE_NOW);
    const expected = expectedDigest(world, records, FAKE_NOW, area.repoUrl);
    const gates = `https://github.com/acme/scratch/blob/main/${GATES_PATH}`;
    expect(expected).toEqual([
      { label: "checkpoint:10", url: gates, age: "3d" },
      { label: "retro:9", url: gates, age: "5d" },
      { label: `retro-item:${itemId(9, 1, "pin-the-runtime-api")}`, url: gates, age: "5d" },
      { label: `retro-item:${itemId(10, 1, "freeze-the-contracts")}`, url: gates, age: "3d" },
      { label: "story:14.1", url: "https://github.com/acme/scratch/blob/xarabot/claims/units/story__14.1.json", age: "2d" },
      { label: "story:11.1", url: "https://github.com/acme/scratch/blob/xarabot/claims/units/story__11.1.json", age: "<1d" },
      { label: "story:12.1", url: "https://github.com/acme/scratch/blob/xarabot/claims/units/story__12.1.json", age: "4d" },
      { label: "9.1-d1", url: "https://github.com/acme/scratch/blob/main/_bmad-output/implementation-artifacts/spec-9-1-runtime.md", age: "6d" },
    ]);
  });
});

// ------------------------------------------------------------ the rehearsals

describe("rehearsals on the fake forge", () => {
  test("the digest: after one coordinator round, the Maintainer's inbox lists exactly the 8 waiting items, each once, with its link and age", async () => {
    const area = fresh();
    const run = await runDigestCase(area);
    expect(run.problems).toEqual([]);
    expect(run.round.result.outcome).toBe("progress");
    expect(run.round.commits).toEqual([]);
    expect(run.body.split("\n")).toContain("- [story:14.1](https://github.com/acme/scratch/blob/xarabot/claims/units/story__14.1.json) · blocked `intent-gap` · 2d");
    expect(run.body).toContain(`  > ${INTENT_GAP_TEXT}`);
    // The digest was stamped at seeding, so no mention was posted.
    expect(area.fake.control.inboxComments(run.issue as number)).toEqual([]);
    expect(area.alerts).toEqual([]);
  });

  test("the checkpoint go (AC 4): round 1 lists checkpoint:10; the Maintainer's comment is ruled, acknowledged and carried by the reconcile PR; after the simulated merge 11.1, 12.1 and 13.1 are claimed", async () => {
    const area = fresh();
    const run = await runCheckpointCase(area);
    expect(run.problems).toEqual([]);
    const { comment } = run.observed;
    expect(run.observed.pending).toEqual([{ verb: "go", unit: "checkpoint:10", by: "alice", at: comment.created_at, ruling: comment.id }]);
    expect(run.observed.replies).toEqual([
      `🤖 Ruling acknowledged: \`${GO_CHECKPOINT_10}\` from alice ([comment](https://github.com/acme/scratch/issues/${run.issue}#issuecomment-${comment.id})).`,
    ]);
    // Round 2's PR carries only retro-gates.yaml, and its enqueue was held: nothing merged.
    expect(Object.keys(run.rounds[1]?.commits[0]?.files ?? {})).toEqual([GATES_PATH]);
    expect(run.rounds[1]?.held).toHaveLength(1);
    expect(area.fake.control.queue()).toEqual([]);
    expect(run.after.filter((o) => o.kind === "claimed").map((o) => o.unit)).toEqual(["story:11.1", "story:12.1", "story:13.1"]);
    const { units } = await ledgerOf(area.forge);
    expect(units.get("reconcile:2")?.state).toBe("merging");
  });
});

// ------------------------------------------------------------ the live switch

describe("live switch", () => {
  const nested = (extra: Record<string, string>, unset: readonly string[]): { code: number; output: string } => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !unset.includes(k)) env[k] = v;
    Object.assign(env, extra);
    const r = Bun.spawnSync([process.execPath, "test", "test/e2e/parallel-epics.test.ts", "-t", "^live gates:"], {
      cwd: ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    return { code: r.exitCode ?? -1, output: r.stdout.toString() + r.stderr.toString() };
  };
  const SCRATCH = { XARABOT_LIVE_GITHUB_REPO: "acme/scratch", XARABOT_LIVE_GITHUB_LOGIN: "alice" };

  test("XARABOT_LIVE unset: both live cases report skipped", () => {
    const r = nested(SCRATCH, ["XARABOT_LIVE", "XARABOT_SANDBOXED"]);
    expect(r.code).toBe(0);
    expect(r.output).toMatch(/\b2 skip\b/);
    expect(r.output).toMatch(/\b0 pass\b/);
    expect(r.output).toMatch(/\b0 fail\b/);
  });

  test("XARABOT_LIVE=1 inside a sandbox (XARABOT_SANDBOXED=1): both live cases report skipped", () => {
    const r = nested({ ...SCRATCH, XARABOT_LIVE: "1", XARABOT_SANDBOXED: "1" }, []);
    expect(r.code).toBe(0);
    expect(r.output).toMatch(/\b2 skip\b/);
    expect(r.output).toMatch(/\b0 pass\b/);
    expect(r.output).toMatch(/\b0 fail\b/);
  });
});

// ------------------------------------------------------------ live

const liveGates = test.skipIf(!liveGithubEnabled || isSandboxed) as typeof test;

liveGates(
  "live gates: the digest lists every waiting item once, with its link and age, in the Maintainer's inbox on the scratch repo",
  async () => {
    const area = await step("the live area", () => liveGatesArea());
    try {
      const run = await runDigestCase(area);
      const pr = run.round.held[0]?.pr;
      console.log(`live gates: digest: inbox #${run.issue ?? "none"}, PR ${pr === undefined ? "none" : `#${pr}`}, comment none; ${run.expected.length} items`);
      expect(run.problems).toEqual([]);
    } finally {
      await area.cleanup();
    }
  },
  10 * 60_000,
);

liveGates(
  "live gates: the checkpoint go from the Maintainer's comment is ruled by reconcile, and then 11.1, 12.1 and 13.1 are claimed",
  async () => {
    const area = await step("the live area", () => liveGatesArea());
    try {
      const run = await runCheckpointCase(area);
      console.log(`live gates: checkpoint go: inbox #${run.issue ?? "none"}, PR ${run.observed.pr === null ? "none" : `#${run.observed.pr}`}, comment ${run.observed.comment.id}`);
      expect(run.problems).toEqual([]);
    } finally {
      await area.cleanup();
    }
  },
  45 * 60_000,
);
