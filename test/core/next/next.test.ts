import { describe, expect, test } from "bun:test";
import { next, type NextOutcome } from "../../../src/core/next/next.ts";
import type { Snapshot } from "../../../src/core/schemas/snapshot.ts";
import { contextPath, itemId, type ItemSpec, manifestPath, shaOf, snapshotOf, storyRec, type Verdict, type World } from "./fixtures.ts";

const pick = (w: World) => next(snapshotOf(w), "builder");

/** The chosen Story id, or the outcome kind when none was chosen. */
function chosen(o: NextOutcome): string {
  return o.kind === "unit" || o.kind === "park" ? `${o.kind} ${o.story.story_id}` : o.kind;
}

const codes = (o: NextOutcome) => (o.kind === "stop" ? [] : o.reasons.map((r) => `${r.subject} ${r.code}`));
const idleReason = (o: NextOutcome) => (o.kind === "idle" ? o.reason : `not idle: ${o.kind}`);

/** Epic 1 bootstrapped; Epic 2 with the given Stories. */
const BOOT = (stories: readonly string[] = ["1", "2"], extra: Partial<World> = {}): World => ({
  epics: { 1: [], 2: stories },
  bootstrapped: [1],
  ...extra,
});

describe("next: happy path", () => {
  test("Epic 1 bootstrapped, Epic 2 valid: Story 2.1 with no record", () => {
    const o = pick(BOOT());
    expect(o).toEqual({
      kind: "unit",
      story: {
        unit: "story:2.1",
        story_id: "2.1",
        epic: 2,
        sprint_key: "k-2.1",
        title: "Story 2.1",
        manifest_path: manifestPath("2.1"),
        manifest_sha: shaOf("2.1"),
        globs: ["src/2.1/**"],
        infrastructure: false,
        expect_generation: null,
        take_over: null,
      },
      reasons: [],
    });
  });

  test("nothing left: every Story done", () => {
    const o = pick(BOOT(["1", "2"], { status: { "2.1": "done", "2.2": "done" } }));
    expect(o).toEqual({ kind: "idle", reason: "no Story left to build", reasons: [] });
  });
});

describe("next: dependency Epic gate", () => {
  const retro = { 1: "accepted" as const };
  const cases: { name: string; world: World; expect: string; cause?: RegExp }[] = [
    {
      name: "a Story of Epic 1 is in review",
      world: {
        epics: { 1: ["1", "2"], 2: ["1"] },
        status: { "1.1": "done", "1.2": "review" },
        records: [storyRec("1.2", { state: "merging" })],
        retro,
      },
      expect: "idle",
      cause: /Epic 2 waits on Epic 1: Story 1\.2 is not done \(review\)/,
    },
    {
      name: "Epic 1 has no Story headings",
      world: { epics: { 1: [], 2: ["1"] }, retro },
      expect: "idle",
      cause: /Epic 2 waits on Epic 1: it has no Stories/,
    },
    {
      name: "Epic 1 has no retro entry",
      world: { epics: { 1: ["1"], 2: ["1"] }, status: { "1.1": "done" } },
      expect: "idle",
      cause: /Epic 2 waits on Epic 1: its retro is not recorded/,
    },
    {
      name: "Epic 1 has an unmanifested heading",
      world: { epics: { 1: ["1", "2"], 2: ["1"] }, manifests: [{ id: "1.1" }, { id: "2.1" }], status: { "1.1": "done" }, retro },
      expect: "idle",
      cause: /Epic 2 waits on Epic 1: Story 1\.2 has no manifest/,
    },
    {
      name: "Epic 1 all done with a retro",
      world: { epics: { 1: ["1"], 2: ["1"] }, status: { "1.1": "done" }, retro },
      expect: "unit 2.1",
    },
    {
      name: "Epic 1 bootstrapped with no Stories and no retro",
      world: { epics: { 1: [], 2: ["1"] }, bootstrapped: [1] },
      expect: "unit 2.1",
    },
    {
      name: "Epic 1 bootstrapped with unmanifested headings: no reason for them",
      world: { epics: { 1: ["1", "2"], 2: ["1"] }, manifests: [{ id: "2.1" }], bootstrapped: [1] },
      expect: "unit 2.1",
    },
    {
      name: "an explicit depends_on on a later Epic holds the lower one",
      world: {
        epics: { 1: [], 2: ["1"], 3: ["1"] },
        bootstrapped: [1],
        epicsYaml: "version: 1\nepics:\n  2:\n    depends_on: [3]\n  3:\n    depends_on: [1]\n",
      },
      expect: "unit 3.1",
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const o = pick(c.world);
      expect(chosen(o)).toBe(c.expect);
      if (c.cause !== undefined) {
        expect(idleReason(o)).toMatch(c.cause);
        expect(codes(o)).toContain("epic:2 dependency-epic");
      }
      if (c.expect === "unit 2.1") expect(codes(o).filter((x) => x.includes("dependency-epic"))).toEqual([]);
      expect(codes(o).filter((x) => x.startsWith("story:1.") && x.endsWith("unmanifested"))).toEqual(
        c.name.includes("unmanifested heading") && !c.name.includes("bootstrapped") ? ["story:1.2 unmanifested"] : [],
      );
    });
  }
});

describe("next: Epic context gate", () => {
  const cases: { name: string; text: string | null; state: string }[] = [
    { name: "missing", text: null, state: "missing" },
    { name: "empty", text: " \n\t\n", state: "empty" },
    { name: "wrong heading", text: "# Epic 3 Context: wrong Epic\n", state: "wrong-heading" },
    { name: "no heading", text: "Some prose\n# Epic 2 Context: late\n", state: "wrong-heading" },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const o = pick(BOOT(["1"], { contexts: { 2: c.text } }));
      expect(chosen(o)).toBe("idle");
      expect(codes(o)).toEqual(["epic:2 epic-context"]);
      expect(idleReason(o)).toBe(`Epic 2 context ${contextPath(2)} is ${c.state}`);
    });
  }

  test("a bootstrapped Epic needs no context", () => {
    expect(chosen(pick(BOOT(["1"], { contexts: { 1: null } })))).toBe("unit 2.1");
  });

  test("a held Epic falls through to the next eligible Epic", () => {
    const w: World = {
      epics: { 1: [], 2: ["1"], 3: ["1"] },
      bootstrapped: [1],
      epicsYaml: "version: 1\nepics:\n  3:\n    depends_on: [1]\n",
      contexts: { 2: null },
    };
    const o = pick(w);
    expect(chosen(o)).toBe("unit 3.1");
    expect(codes(o)).toEqual(["epic:2 epic-context"]);
  });
});

describe("next: rejected retro", () => {
  // Epic 1 done; 2 depends on 1; 3 depends on 2; 2 is done with an accepted retro.
  const world = (verdict: "accepted" | "accepted-with-open-items" | "rejected" | "rejected-go"): World => ({
    epics: { 1: ["1"], 2: ["1"], 3: ["1"] },
    status: { "1.1": "done", "2.1": "done" },
    retro: { 1: verdict, 2: "accepted" },
  });

  test("rejected without go holds Epics 2 and 3", () => {
    const o = pick(world("rejected"));
    expect(chosen(o)).toBe("idle");
    expect(codes(o)).toEqual(["epic:2 retro-rejected", "epic:3 retro-rejected"]);
    expect(idleReason(o)).toContain("Epic 2 is held by Epic 1's rejected retro (retro:1)");
    expect(idleReason(o)).toContain("Epic 3 is held by Epic 1's rejected retro (retro:1)");
  });

  test("the rejected Epic itself is not held by its own retro", () => {
    const o = pick({ ...world("rejected"), status: {} });
    expect(chosen(o)).toBe("unit 1.1");
  });

  for (const v of ["rejected-go", "accepted", "accepted-with-open-items"] as const) {
    test(`${v} holds nothing`, () => {
      const o = pick(world(v));
      expect(chosen(o)).toBe("unit 3.1");
      expect(codes(o)).toEqual([]);
    });
  }
});

describe("next: retro-item distance gates (FR10, AR13)", () => {
  // Chain 1 → 2 → 3 → 4 (each depends on the previous); Epics 1-3 done with retros recorded, so only 4.1 is left.
  const chain = (items: readonly ItemSpec[], verdict: Verdict = "accepted-with-open-items", over: Partial<World> = {}): World => ({
    epics: { 1: ["1"], 2: ["1"], 3: ["1"], 4: ["1"] },
    status: { "1.1": "done", "2.1": "done", "3.1": "done" },
    retro: { 1: verdict, 2: "accepted", 3: "accepted" },
    items: { 1: items },
    ...over,
  });
  const ID = `retro-item:${itemId(1, 1)}`;
  const untagged = (status: ItemSpec["status"] = "open"): ItemSpec[] => [{ seq: 1, blocking: false, status }];
  const blocking = (status: ItemSpec["status"] = "open"): ItemSpec[] => [{ seq: 1, blocking: true, status }];

  const cases: { name: string; world: World; expect: string; codes: string[] }[] = [
    { name: "an untagged open item holds Epics 3 and 4 (d ≥ 2), not Epic 2 (d = 1)", world: chain(untagged()), expect: "idle", codes: ["epic:3 retro-item", "epic:4 retro-item"] },
    { name: "a blocking open item holds Epics 2, 3 and 4", world: chain(blocking()), expect: "idle", codes: ["epic:2 retro-item", "epic:3 retro-item", "epic:4 retro-item"] },
    ...(["done", "deferred"] as const).flatMap((st) => [
      { name: `an untagged ${st} item holds nothing`, world: chain(untagged(st)), expect: "unit 4.1", codes: [] },
      { name: `a blocking ${st} item holds nothing`, world: chain(blocking(st)), expect: "unit 4.1", codes: [] },
    ]),
    ...(["waiting", "in-progress"] as const).flatMap((st) => [
      { name: `an untagged ${st} item holds d ≥ 2 as open does`, world: chain(untagged(st)), expect: "idle", codes: ["epic:3 retro-item", "epic:4 retro-item"] },
      { name: `a blocking ${st} item holds d ≥ 1 as open does`, world: chain(blocking(st)), expect: "idle", codes: ["epic:2 retro-item", "epic:3 retro-item", "epic:4 retro-item"] },
    ]),
    {
      name: "a maintainer-routed item gates as a lane-routed one does",
      world: chain([{ seq: 1, blocking: false, status: "open", route: "maintainer" }]),
      expect: "idle",
      codes: ["epic:3 retro-item", "epic:4 retro-item"],
    },
    { name: "rejected with no go holds every Epic at d ≥ 1", world: chain([], "rejected"), expect: "idle", codes: ["epic:2 retro-rejected", "epic:3 retro-rejected", "epic:4 retro-rejected"] },
    { name: "rejected with go holds nothing by its verdict", world: chain([], "rejected-go"), expect: "unit 4.1", codes: [] },
    { name: "rejected with go: an untagged open item still holds d ≥ 2", world: chain(untagged(), "rejected-go"), expect: "idle", codes: ["epic:3 retro-item", "epic:4 retro-item"] },
    {
      name: "rejected with go: a blocking open item still holds d ≥ 1",
      world: chain(blocking(), "rejected-go"),
      expect: "idle",
      codes: ["epic:2 retro-item", "epic:3 retro-item", "epic:4 retro-item"],
    },
    {
      name: "rejected with no go and an untagged item: both hold, each by its own rule",
      world: chain(untagged(), "rejected"),
      expect: "idle",
      codes: ["epic:2 retro-rejected", "epic:3 retro-rejected", "epic:3 retro-item", "epic:4 retro-rejected", "epic:4 retro-item"],
    },
    { name: "an accepted verdict holds nothing by itself; its items still gate", world: chain(untagged(), "accepted"), expect: "idle", codes: ["epic:3 retro-item", "epic:4 retro-item"] },
    {
      name: "one reason per holding item",
      world: chain([{ seq: 1, blocking: true, status: "open" }, { seq: 2, blocking: false, status: "waiting" }, { seq: 3, blocking: false, status: "done" }]),
      expect: "idle",
      codes: ["epic:2 retro-item", "epic:3 retro-item", "epic:3 retro-item", "epic:4 retro-item", "epic:4 retro-item"],
    },
    {
      name: "the item's own Epic (d = 0) is never held by it",
      world: chain(blocking(), "accepted-with-open-items", { status: {} }),
      expect: "unit 1.1",
      codes: ["epic:2 dependency-epic", "epic:2 retro-item", "epic:3 dependency-epic", "epic:3 retro-item", "epic:4 dependency-epic", "epic:4 retro-item"],
    },
    {
      name: "a bootstrapped Epic's items gate its dependents",
      world: chain(blocking(), "accepted-with-open-items", { bootstrapped: [1] }),
      expect: "idle",
      codes: ["epic:2 retro-item", "epic:3 retro-item", "epic:4 retro-item"],
    },
    {
      name: "diamond: D (3) depends on E (1) and on F (2), F on E; an untagged item on E does not hold D, only its dependent 4",
      world: chain(untagged(), "accepted-with-open-items", { epicsYaml: "version: 1\nepics:\n  3:\n    depends_on: [1, 2]\n" }),
      expect: "idle",
      codes: ["epic:4 retro-item"],
    },
    {
      name: "diamond: with Epic 4 left out, D (3) is picked",
      world: chain(untagged(), "accepted-with-open-items", {
        epicsYaml: "version: 1\nepics:\n  3:\n    depends_on: [1, 2]\n  4:\n    depends_on: []\n",
        status: { "1.1": "done", "2.1": "done", "4.1": "done" },
        retro: { 1: "accepted-with-open-items", 2: "accepted" },
      }),
      expect: "unit 3.1",
      codes: [],
    },
    {
      name: "an unrelated Epic (4 depends on nothing) is never held",
      world: chain(blocking(), "rejected", { epicsYaml: "version: 1\nepics:\n  4:\n    depends_on: []\n" }),
      expect: "unit 4.1",
      codes: ["epic:2 retro-rejected", "epic:2 retro-item", "epic:3 retro-rejected", "epic:3 retro-item"],
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const o = pick(c.world);
      expect(chosen(o)).toBe(c.expect);
      expect(codes(o)).toEqual(c.codes);
    });
  }

  test("the idle reason names an untagged item, its Epic and its distance", () => {
    const o = pick(chain(untagged()));
    expect(idleReason(o)).toBe(
      `Epic 3 is held by Epic 1's retro item ${ID} (open, untagged, distance 2); Epic 4 is held by Epic 1's retro item ${ID} (open, untagged, distance 3)`,
    );
  });

  test("the idle reason names a blocking item", () => {
    const o = pick(chain(blocking("waiting")));
    expect(idleReason(o)).toContain(`Epic 2 is held by Epic 1's retro item ${ID} (waiting, blocking, distance 1)`);
    expect(o.kind === "idle" ? o.reasons.filter((r) => r.code === "retro-item").map((r) => r.subject) : []).toEqual(["epic:2", "epic:3", "epic:4"]);
  });

  test("items on two source Epics: each source adds its own reasons for the Epics it holds", () => {
    const o = pick(chain(untagged(), "accepted-with-open-items", { items: { 1: untagged(), 2: untagged() } }));
    expect(chosen(o)).toBe("idle");
    expect(codes(o)).toEqual(["epic:3 retro-item", "epic:4 retro-item", "epic:4 retro-item"]);
    expect(o.kind === "idle" ? o.reasons.map((r) => r.message) : []).toEqual([
      `Epic 3 is held by Epic 1's retro item ${ID} (open, untagged, distance 2)`,
      `Epic 4 is held by Epic 1's retro item ${ID} (open, untagged, distance 3)`,
      `Epic 4 is held by Epic 2's retro item retro-item:${itemId(2, 1)} (open, untagged, distance 2)`,
    ]);
  });

  test("the idle reason names a rejected retro", () => {
    const o = pick(chain([], "rejected"));
    expect(idleReason(o)).toContain("Epic 4 is held by Epic 1's rejected retro (retro:1), which has no go");
  });

  test("a claimed Story in a newly held Epic keeps its record and no other Story of that Epic is picked", () => {
    const records = [storyRec("2.1", { state: "claimed", generation: 3 })];
    const w: World = { epics: { 1: ["1"], 2: ["1", "2"] }, status: { "1.1": "done" }, retro: { 1: "accepted-with-open-items" }, items: { 1: blocking() }, records };
    const snap = snapshotOf(w);
    const o = next(snap, "builder");
    expect(chosen(o)).toBe("idle");
    expect(codes(o)).toEqual(["epic:2 retro-item"]);
    expect(snap.ledger.units.find((r) => r.unit === "story:2.1")).toEqual(records[0]);
  });

  test("a held Epic falls through to an unrelated Epic", () => {
    const w: World = {
      epics: { 1: ["1"], 2: ["1"], 3: ["1"] },
      status: { "1.1": "done" },
      retro: { 1: "accepted-with-open-items" },
      items: { 1: blocking() },
      epicsYaml: "version: 1\nepics:\n  3:\n    depends_on: []\n",
    };
    const o = pick(w);
    expect(chosen(o)).toBe("unit 3.1");
    expect(codes(o)).toEqual(["epic:2 retro-item"]);
  });
});

describe("next: record states", () => {
  const cases: { state?: "claimed" | "merging" | "parked" | "released" | "merged"; expect: string; gen?: number | null }[] = [
    { expect: "unit 2.1", gen: null },
    { state: "released", expect: "unit 2.1", gen: 4 },
    { state: "claimed", expect: "unit 2.2" },
    { state: "merging", expect: "unit 2.2" },
    { state: "parked", expect: "unit 2.2" },
    { state: "merged", expect: "unit 2.2" },
  ];
  for (const c of cases) {
    test(c.state ?? "absent", () => {
      const records = c.state === undefined ? [] : [storyRec("2.1", { state: c.state, generation: 4 })];
      const o = pick(BOOT(["1", "2"], { records }));
      expect(chosen(o)).toBe(c.expect);
      if (c.gen !== undefined) {
        expect(o.kind === "unit" ? o.story.expect_generation : "none").toBe(c.gen);
        expect(codes(o)).toEqual([]);
      } else {
        expect(codes(o)).toEqual(["story:2.1 record-state"]);
        expect(o.kind === "unit" ? o.reasons[0]?.message : "").toBe(`story:2.1 is ${c.state}`);
      }
    });
  }

  test("a fresh claim and a released record: take_over is null", () => {
    expect(pick(BOOT(["1"]))).toMatchObject({ kind: "unit", story: { take_over: null, expect_generation: null } });
    const released = pick(BOOT(["1"], { records: [storyRec("2.1", { state: "released", generation: 4, heartbeat_at: "2020-01-01T00:00:00Z" })] }));
    expect(released).toMatchObject({ kind: "unit", story: { take_over: null, expect_generation: 4 } });
  });

  test("done with its record deleted is never returned", () => {
    const o = pick(BOOT(["1"], { status: { "2.1": "done" } }));
    expect(o).toEqual({ kind: "idle", reason: "no Story left to build", reasons: [] });
  });
});

describe("next: stale takeover", () => {
  // NOW is 2026-10-22T10:10:00Z.
  const STALE = "2026-10-22T09:40:00Z";
  const FRESH = "2026-10-22T09:40:01Z";
  const coordinator = { owner: "carol", host: "33333333-3333-4333-8333-333333333333", lane: "coordinator" };
  const cases: {
    name: string;
    over: Parameters<typeof storyRec>[1];
    expect: string;
    takeOver?: "claimed" | "merging";
    reason?: string;
  }[] = [
    { name: "claimed, 29:59 old", over: { state: "claimed", heartbeat_at: FRESH }, expect: "unit 2.2", reason: "story:2.1 is claimed" },
    { name: "claimed, 30:00 old", over: { state: "claimed", heartbeat_at: STALE }, expect: "unit 2.1", takeOver: "claimed" },
    { name: "claimed, a year old", over: { state: "claimed", heartbeat_at: "2025-10-22T10:10:00Z" }, expect: "unit 2.1", takeOver: "claimed" },
    { name: "merging, 29:59 old", over: { state: "merging", pr: 7, heartbeat_at: FRESH }, expect: "unit 2.2", reason: "story:2.1 is merging" },
    { name: "merging, 30:00 old", over: { state: "merging", pr: 7, heartbeat_at: STALE }, expect: "unit 2.1", takeOver: "merging" },
    {
      name: "merging under the coordinator, a year old",
      over: { state: "merging", pr: 7, ...coordinator, heartbeat_at: "2025-10-22T10:10:00Z" },
      expect: "unit 2.2",
      reason: "story:2.1 is merging",
    },
    { name: "parked, years old", over: { state: "parked", heartbeat_at: "2020-01-01T00:00:00Z" }, expect: "unit 2.2", reason: "story:2.1 is parked" },
    { name: "merged, years old", over: { state: "merged", heartbeat_at: "2020-01-01T00:00:00Z" }, expect: "unit 2.2", reason: "story:2.1 is merged" },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const o = pick(BOOT(["1", "2"], { records: [storyRec("2.1", { generation: 4, ...c.over })] }));
      expect(chosen(o)).toBe(c.expect);
      if (c.takeOver !== undefined) {
        expect(o).toMatchObject({ kind: "unit", story: { take_over: c.takeOver, expect_generation: 4, globs: ["src/2.1/**"] } });
        expect(codes(o)).toEqual([]);
      } else {
        expect(o).toMatchObject({ kind: "unit", story: { take_over: null } });
        expect(codes(o)).toEqual(["story:2.1 record-state"]);
        expect(o.kind === "unit" ? o.reasons[0]?.message : "").toBe(c.reason as string);
      }
    });
  }

  test("a stale record still waits on depends_on, escalations and other records' globs", () => {
    const stale = storyRec("2.2", { state: "claimed", heartbeat_at: STALE, globs: ["src/b/**"] });
    const manifests = [{ id: "2.1", globs: ["src/a/**"] }, { id: "2.2", globs: ["src/b/**"], deps: ["2.1"] }];
    expect(codes(pick(BOOT(["1", "2"], { manifests, records: [stale, storyRec("2.1", { globs: ["src/a/**"] })] })))).toEqual([
      "story:2.1 record-state",
      "story:2.2 depends-on",
    ]);
    const escalated = pick(BOOT(["1", "2"], { records: [storyRec("2.1", { heartbeat_at: STALE })], escalations: ["2.1"] }));
    expect(chosen(escalated)).toBe("unit 2.2");
    expect(codes(escalated)).toEqual(["story:2.1 escalation"]);
    const overlap = BOOT(["1", "2"], {
      manifests: [{ id: "2.1", globs: ["src/a/**"] }, { id: "2.2", globs: ["src/a/b/**"] }],
      records: [storyRec("2.1", { globs: ["src/a/**"] }), storyRec("2.2", { heartbeat_at: STALE, globs: ["src/a/b/**"] })],
    });
    // The stale 2.2 still holds its globs against 2.1, and 2.1's block 2.2.
    expect(codes(pick(overlap))).toEqual(["story:2.1 record-state", "story:2.1 overlap", "story:2.2 overlap"]);
  });

  test("another stale record's globs still block: stale or not, it holds them", () => {
    const o = pick(
      BOOT(["1", "2"], {
        manifests: [{ id: "2.1", globs: ["src/a/**"] }, { id: "2.2", globs: ["src/a/b/**"] }],
        records: [storyRec("2.1", { state: "parked", heartbeat_at: "2020-01-01T00:00:00Z", globs: ["src/a/**"] })],
      }),
    );
    expect(chosen(o)).toBe("idle");
    expect(codes(o)).toEqual(["story:2.1 record-state", "story:2.2 overlap"]);
  });

  test("Infrastructure: a stale record whose approval does not match is passed over with a record-state reason, never parked", () => {
    const manifests = [{ id: "2.1", infra: true }, { id: "2.2" }];
    const records = [storyRec("2.1", { heartbeat_at: STALE, approval: { by: "edanisko", manifest_sha: "e".repeat(40) } })];
    const o = pick(BOOT(["1", "2"], { manifests, records }));
    expect(chosen(o)).toBe("unit 2.2");
    expect(codes(o)).toEqual(["story:2.1 record-state"]);
    expect(o.kind === "unit" ? o.reasons[0]?.message : "").toBe(`story:2.1 is claimed and stale, but has no approval for manifest ${shaOf("2.1")}`);
    const none = pick(BOOT(["1"], { manifests: [{ id: "2.1", infra: true }], records: [storyRec("2.1", { state: "merging", pr: 7, heartbeat_at: STALE })] }));
    expect(none.kind).toBe("idle");
    expect(codes(none)).toEqual(["story:2.1 record-state"]);
  });

  test("Infrastructure: a stale record with a matching approval is taken over", () => {
    const records = [storyRec("2.1", { generation: 3, heartbeat_at: STALE, approval: { by: "edanisko", manifest_sha: shaOf("2.1") } })];
    const o = pick(BOOT(["1"], { manifests: [{ id: "2.1", infra: true }], records }));
    expect(o).toMatchObject({ kind: "unit", story: { infrastructure: true, take_over: "claimed", expect_generation: 3 } });
  });
});

describe("next: depends_on", () => {
  const manifests = [{ id: "2.1", globs: ["src/a/**"] }, { id: "2.2", globs: ["src/b/**"], deps: ["2.1"] }];
  const records21 = [storyRec("2.1", { state: "claimed", globs: ["src/a/**"] })];

  test("2.1 not done and not merged", () => {
    const o = pick(BOOT(["1", "2"], { manifests, records: records21 }));
    expect(chosen(o)).toBe("idle");
    expect(codes(o)).toEqual(["story:2.1 record-state", "story:2.2 depends-on"]);
    expect(idleReason(o)).toBe("story:2.1 is claimed; Story 2.2 waits on Story 2.1");
  });

  test("2.1 done", () => {
    expect(chosen(pick(BOOT(["1", "2"], { manifests, status: { "2.1": "done" } })))).toBe("unit 2.2");
  });

  test("2.1 merged in the ledger", () => {
    const o = pick(BOOT(["1", "2"], { manifests, records: [storyRec("2.1", { state: "merged" })] }));
    expect(chosen(o)).toBe("unit 2.2");
    expect(codes(o)).toEqual(["story:2.1 record-state"]);
  });

  const canonical = [{ id: "2.1", globs: ["src/a/**"] }, { id: "2.2", globs: ["src/b/**"], deps: ["2.01"] }];

  test("a non-canonical depends_on id (2.01) is satisfied when 2.1 is done", () => {
    expect(chosen(pick(BOOT(["1", "2"], { manifests: canonical, status: { "2.1": "done" } })))).toBe("unit 2.2");
  });

  test("a non-canonical depends_on id (2.01) is satisfied when story:2.1 is merged", () => {
    const o = pick(BOOT(["1", "2"], { manifests: canonical, records: [storyRec("2.1", { state: "merged" })] }));
    expect(chosen(o)).toBe("unit 2.2");
  });

  test("a non-canonical depends_on id (2.01) still waits while 2.1 is open", () => {
    const o = pick(BOOT(["1", "2"], { manifests: canonical, records: [storyRec("2.1", { state: "claimed", globs: ["src/a/**"] })] }));
    expect(chosen(o)).toBe("idle");
    expect(codes(o)).toContain("story:2.2 depends-on");
  });

  test("a dependency in a bootstrapped Epic is satisfied", () => {
    const w: World = { epics: { 1: ["1"], 2: ["1"] }, bootstrapped: [1], manifests: [{ id: "1.1" }, { id: "2.1", deps: ["1.1"] }] };
    expect(chosen(pick(w))).toBe("unit 2.1");
  });
});

describe("next: escalations and overlap", () => {
  test("an open escalation skips the Story", () => {
    const o = pick(BOOT(["1", "2"], { escalations: ["2.1"] }));
    expect(chosen(o)).toBe("unit 2.2");
    expect(codes(o)).toEqual(["story:2.1 escalation"]);
  });

  test("an escalation id is matched by its numeric key (2.01 is 2.1)", () => {
    const o = pick(BOOT(["1", "2"], { escalations: ["2.01"] }));
    expect(chosen(o)).toBe("unit 2.2");
    expect(codes(o)).toEqual(["story:2.1 escalation"]);
  });

  test("no escalation source", () => {
    expect(chosen(pick(BOOT(["1"], { escalations: null })))).toBe("unit 2.1");
  });

  test("2.2 overlaps a glob 2.1 holds", () => {
    const w = BOOT(["1", "2", "3"], {
      manifests: [{ id: "2.1", globs: ["src/a/**"] }, { id: "2.2", globs: ["src/a/b/**"] }, { id: "2.3", globs: ["src/c/**"] }],
      records: [storyRec("2.1", { state: "claimed", globs: ["src/a/**"] })],
    });
    const o = pick(w);
    expect(chosen(o)).toBe("unit 2.3");
    expect(codes(o)).toEqual(["story:2.1 record-state", "story:2.2 overlap"]);
  });

  test("a parked unit's globs_held count; a released unit's globs do not", () => {
    const manifests = [{ id: "2.1", globs: ["src/a/**"] }, { id: "2.2", globs: ["SRC/A/x.ts"] }];
    const parked = pick(BOOT(["1", "2"], { manifests, records: [storyRec("2.1", { state: "parked", globs: ["src/a/**"] })] }));
    expect(chosen(parked)).toBe("idle");
    const released = pick(BOOT(["1", "2"], { manifests, records: [storyRec("2.1", { state: "released", globs: ["src/a/**"] })] }));
    expect(chosen(released)).toBe("unit 2.1");
    expect(codes(released).filter((c) => c.endsWith("overlap"))).toEqual([]);
  });

  for (const state of ["released", "merged"] as const) {
    test(`2.1 done with a ${state} record holding src/a/**: no overlap for 2.2`, () => {
      const manifests = [{ id: "2.1", globs: ["src/a/**"] }, { id: "2.2", globs: ["src/a/b/**"] }];
      const records = [storyRec("2.1", { state, globs: ["src/a/**"] })];
      const o = pick(BOOT(["1", "2"], { manifests, records, status: { "2.1": "done" } }));
      expect(chosen(o)).toBe("unit 2.2");
      expect(codes(o)).toEqual([]);
    });
  }
});

describe("next: Infrastructure Stories", () => {
  const manifests = [{ id: "2.1", infra: true }];
  const approval = (sha: string) => ({ by: "edanisko", manifest_sha: sha });

  test("no record: park", () => {
    const o = pick(BOOT(["1"], { manifests }));
    expect(o.kind).toBe("park");
    expect(o).toMatchObject({ park: "needs-approval", story: { story_id: "2.1", infrastructure: true, expect_generation: null } });
  });

  test("released with a matching approval: unit", () => {
    const o = pick(BOOT(["1"], { manifests, records: [storyRec("2.1", { state: "released", generation: 2, approval: approval(shaOf("2.1")) })] }));
    expect(o).toMatchObject({ kind: "unit", story: { infrastructure: true, expect_generation: 2 } });
  });

  test("released with a stale approval: park", () => {
    const o = pick(BOOT(["1"], { manifests, records: [storyRec("2.1", { state: "released", generation: 2, approval: approval("e".repeat(40)) })] }));
    expect(o).toMatchObject({ kind: "park", park: "needs-approval", story: { expect_generation: 2 } });
  });
});

describe("next: unmanifested and unclaimable", () => {
  test("both listed, never returned", () => {
    const w = BOOT(["1", "3", "4"], {
      manifests: [{ id: "2.1", area: "core" }, { id: "2.4", area: "nowhere" }],
      pathMap: { core: ["src/core/**"] },
      status: { "2.1": "done" },
    });
    const o = pick(w);
    expect(chosen(o)).toBe("idle");
    expect(codes(o)).toEqual(["story:2.3 unmanifested", "story:2.4 unclaimable"]);
    expect(idleReason(o)).toMatch(/Story 2\.3 has a heading .* but no manifest; .*2\.4\.md: unclaimable/);
  });

  test("an unclaimable manifest in a bootstrapped Epic is not listed", () => {
    const o = pick({ epics: { 1: ["1"], 2: ["1"] }, bootstrapped: [1], manifests: [{ id: "1.1", globs: [] }, { id: "2.1" }] });
    expect(chosen(o)).toBe("unit 2.1");
    expect(codes(o)).toEqual([]);
  });

  test("a sprint_key that names a prototype member is not a status", () => {
    const w: World = {
      epics: { 1: ["1"], 2: ["1"] },
      retro: { 1: "accepted" },
      files: { "stories/1.1.md": '---\nstory_id: "1.1"\nepic: 1\nsprint_key: constructor\ntitle: T\nglobs: [src/x/**]\n---\n' },
      records: [storyRec("1.1", { state: "claimed", globs: ["src/x/**"] })],
    };
    const o = pick(w);
    expect(idleReason(o)).toContain("Story 1.1 is not done (no status)");
  });

  test("listed even when the Epic is held", () => {
    const o = pick(BOOT(["1", "3"], { manifests: [{ id: "2.1", globs: [] }], contexts: { 2: null } }));
    expect(codes(o)).toEqual(["story:2.3 unmanifested", "story:2.1 unclaimable", "epic:2 epic-context"]);
  });

  test("listed when another Story is chosen", () => {
    const o = pick(BOOT(["1", "2"], { manifests: [{ id: "2.2" }] }));
    expect(chosen(o)).toBe("unit 2.2");
    expect(codes(o)).toEqual(["story:2.1 unmanifested"]);
  });
});

describe("next: order", () => {
  test("eligible 3.1, 2.10, 2.9, 2.9a picks 2.9", () => {
    const w: World = {
      epics: { 1: [], 2: ["9", "9a", "10"], 3: ["1"] },
      bootstrapped: [1],
      epicsYaml: "version: 1\nepics:\n  3:\n    depends_on: [1]\n",
      manifests: [{ id: "3.1" }, { id: "2.10" }, { id: "2.9" }, { id: "2.9a" }],
    };
    expect(chosen(pick(w))).toBe("unit 2.9");
  });
});

describe("next: stop", () => {
  test("graph cycle", () => {
    const w: World = { epics: { 1: [], 2: [] }, epicsYaml: "version: 1\nepics:\n  1:\n    depends_on: [2]\n  2:\n    depends_on: [1]\n" };
    expect(pick(w)).toEqual({ kind: "stop", reason: "graph: cycle among Epics 1 → 2 → 1" });
  });

  test("malformed snapshot", () => {
    const bad = { ...snapshotOf(BOOT()), main_sha: "nope" } as Snapshot;
    const o = next(bad, "builder");
    expect(o.kind).toBe("stop");
    expect(o.kind === "stop" ? o.reason : "").toContain("main_sha");
    expect(next(null as unknown as Snapshot, "builder").kind).toBe("stop");
  });

  test("role mismatch", () => {
    expect(next(snapshotOf(BOOT()), "coordinator")).toEqual({
      kind: "stop",
      reason: 'lane role "coordinator" differs from the snapshot\'s role "builder"',
    });
  });

  test("coordinator: no longer a stop; with no reconcile run on the ledger, reconcile:1", () => {
    const o = next(snapshotOf(BOOT(["1"], { role: "coordinator" })), "coordinator");
    expect(o.kind === "coordinator" ? o.unit.unit : o.kind).toBe("reconcile:1");
  });

  test("coordinator: a graph cycle stops it as it stops a builder", () => {
    const w: World = {
      epics: { 1: [], 2: [] },
      epicsYaml: "version: 1\nepics:\n  1:\n    depends_on: [2]\n  2:\n    depends_on: [1]\n",
      role: "coordinator",
    };
    expect(next(snapshotOf(w), "coordinator")).toEqual({ kind: "stop", reason: "graph: cycle among Epics 1 → 2 → 1" });
  });

  test("coordinator: a malformed snapshot stops it", () => {
    const bad = { ...snapshotOf(BOOT(["1"], { role: "coordinator" })), main_sha: "nope" } as Snapshot;
    expect(next(bad, "coordinator").kind).toBe("stop");
  });

  test("unknown lane role", () => {
    expect(next(snapshotOf(BOOT()), "reviewer" as "builder").kind).toBe("stop");
  });

  test("a path_map glob that fails normalization", () => {
    const s = snapshotOf(BOOT(["1"], { manifests: [{ id: "2.1", area: "core" }], pathMap: { core: ["src/**"] } }));
    const manifests = s.config.manifests;
    if (manifests === undefined) throw new Error("no manifests config");
    const bad: Snapshot = { ...s, config: { ...s.config, manifests: { ...manifests, path_map: { core: ["../x/**"] } } } };
    const o = next(bad, "builder");
    expect(o.kind).toBe("stop");
    expect(o.kind === "stop" ? o.reason : "").toContain("manifests.path_map.core");
  });
});

describe("next: purity", () => {
  test("the same snapshot gives the same outcome and is not mutated", () => {
    const s = snapshotOf(BOOT(["1", "2"], { records: [storyRec("2.1", { state: "claimed" })] }));
    const copy = structuredClone(s);
    expect(next(s, "builder")).toEqual(next(s, "builder"));
    expect(s).toEqual(copy);
  });
});
