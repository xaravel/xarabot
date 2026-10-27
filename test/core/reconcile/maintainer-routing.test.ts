import { describe, expect, test } from "bun:test";
import { renderDigest } from "../../../src/core/inbox/render-digest.ts";
import { epicHolds } from "../../../src/core/next/epic-gates.ts";
import { next } from "../../../src/core/next/next.ts";
import { editRetroGates, type RetroItemStatusChange } from "../../../src/core/reconcile/retro-gates-edit.ts";
import type { CoordinatorRecord, UnitRecord } from "../../../src/core/schemas/ledger.ts";
import type { RetroRecordResult } from "../../../src/core/schemas/retro-gates.ts";
import { COORD } from "../ledger/fixtures.ts";
import { NOW, RETRO, rec, snapshotOf, type World } from "../next/fixtures.ts";

/**
 * Story 4.3 end to end, with no mocks: a merged retro with lane and
 * Maintainer items is written by `editRetroGates`; over that file the
 * Maintainer's digest lists each routed item once, `next` (coordinator)
 * returns only the lane item, and a ruled `done` or `defer` takes the item
 * out of the digest and out of the Epic holds.
 */

// NOW is 2026-10-22T10:10:00Z; the fixtures' Maintainer is edanisko.
const REPO = "https://github.com/xaravel/xarabot";
const GATES_URL = `${REPO}/blob/main/${RETRO}`;
const DAYS_AGO_3 = new Date(Date.parse(NOW) - 3 * 86_400_000).toISOString();

const A = "epic-2-retro-item-1-lane-work";
const B = "epic-2-retro-item-2-ask-blocking";
const C = "epic-2-retro-item-3-ask-later";
const RESULT: RetroRecordResult = {
  verdict: "accepted-with-open-items",
  items: [
    { id: A, text: "Lane work.", route: "lane", blocking: true, globs: ["src/a/**"] },
    { id: B, text: "Decide the gate.", route: "maintainer", blocking: true, globs: [] },
    { id: C, text: "Decide it later.", route: "maintainer", blocking: false, globs: [] },
  ],
};
const ADDITION = { epic: 2, unit: "retro:2", result: RESULT, recorded_at: DAYS_AGO_3 };

/** A live coordinator claim whose digest is posted today, so the digest slot is no work. */
const CLAIM: CoordinatorRecord = {
  schema_version: 2,
  owner: COORD.owner,
  host: COORD.host,
  lane: "coordinator",
  generation: 1,
  heartbeat_at: NOW,
  digest_posted_at: "2026-10-22T08:00:00Z",
  rulings_cursor: null,
};
/** A reconcile run merged a minute ago: reconcile is not due. */
const RECENT: UnitRecord = rec({
  unit: "reconcile:4",
  state: "merged",
  owner: COORD.owner,
  host: COORD.host,
  lane: COORD.lane,
  globs: [],
  heartbeat_at: new Date(Date.parse(NOW) - 60_000).toISOString(),
});

/** Epic 1 bootstrapped; 2 → 3 → 4 by dependency, Epic 2's Story done, the others in backlog; `gates` as `retro-gates.yaml`. */
function world(gates: string): World {
  return {
    epics: { 1: [], 2: ["1"], 3: ["1"], 4: ["1"] },
    bootstrapped: [1],
    epicsYaml: "version: 1\nepics:\n  2:\n    depends_on: [1]\n  3:\n    depends_on: [2]\n  4:\n    depends_on: [3]\n",
    role: "coordinator",
    coordinator: CLAIM,
    records: [RECENT],
    status: { "epic-2": "done", "2.1": "done", "epic-3": "backlog", "3.1": "backlog", "epic-4": "backlog", "4.1": "backlog" },
    files: { [RETRO]: gates },
  };
}

/** The retro gates file as `reconcile` writes it for the merged retro:2. */
function recorded(): string {
  const r = editRetroGates(RETRO, null, [ADDITION]);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.text;
}

/** That file with `statuses` ruled on it. */
function ruled(statuses: readonly RetroItemStatusChange[]): { readonly text: string; readonly summary: readonly string[] } {
  const r = editRetroGates(RETRO, recorded(), [], [], statuses);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** The Maintainer's retro-item lines and digest count over `gates`. */
function digestOf(gates: string): { readonly lines: readonly string[]; readonly count: number } {
  const w = world(gates);
  const d = renderDigest({ snapshot: snapshotOf(w), files: {}, repoUrl: REPO }).get("edanisko");
  const lines = (d?.body ?? "").split("\n").filter((l) => l.startsWith("- [retro-item:"));
  return { lines, count: d?.count ?? 0 };
}

const line = (id: string, what: string) => `- [retro-item:${id}](${GATES_URL}) · Epic 2 · ${what} · 3d · \`/xarabot done|defer retro-item:${id}\``;
const B_LINE = line(B, "waiting, blocking: Decide the gate.");
const C_LINE = line(C, "waiting: Decide it later.");

/** Whether a retro item's hold is a Maintainer cause: routed items' are, the lane item's is not. */
const MAINTAINER_CAUSE: Readonly<Record<string, boolean>> = { [A]: false, [B]: true, [C]: true };

/** The retro item ids each of Epics 3 and 4 is held by; each hold's `maintainer` flag is checked against `MAINTAINER_CAUSE`. */
function heldBy(gates: string): Record<number, string[]> {
  const holds = epicHolds(snapshotOf(world(gates)));
  const ids = (n: number) =>
    holds(n)
      .filter((r) => r.code === "retro-item")
      .map((r) => {
        const id = /retro-item:(\S+)/.exec(r.message)?.[1] ?? "";
        expect([id, r.maintainer === true]).toEqual([id, MAINTAINER_CAUSE[id] ?? false]);
        return id;
      })
      .sort();
  return { 3: ids(3), 4: ids(4) };
}

/** The `retro-item:` unit `next` returns for the coordinator, or `none`. */
function coordinatorRetroItemUnit(gates: string): string {
  const o = next(snapshotOf(world(gates)), "coordinator");
  return o.kind === "coordinator" && o.unit.kind === "retro-item" ? o.unit.unit : "none";
}

describe("Maintainer-routed retro items, end to end (Story 4.3)", () => {
  test("AC 1: the merged retro writes the Maintainer items waiting and the lane item open", () => {
    const r = editRetroGates(RETRO, null, [ADDITION]);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.summary).toEqual([
      "epics.2.retro: accepted-with-open-items (retro:2)",
      `epics.2.items: ${A} added as open`,
      `epics.2.items: ${B} added as waiting`,
      `epics.2.items: ${C} added as waiting`,
    ]);
    const snap = snapshotOf(world(r.value.text));
    expect(snap.retro_gates.epics["2"]?.items?.map((i) => [i.id, i.route, i.status])).toEqual([
      [A, "lane", "open"],
      [B, "maintainer", "waiting"],
      [C, "maintainer", "waiting"],
    ]);
  });

  test("AC 2: the Maintainer's digest lists each routed item once, with its id, text, Epic and age", () => {
    const { lines, count } = digestOf(recorded());
    expect(lines).toEqual([B_LINE, C_LINE]);
    expect(count).toBe(2);
  });

  test("AC 3: next (coordinator) returns the lane item only; with it done, no retro-item unit", () => {
    expect(coordinatorRetroItemUnit(recorded())).toBe(`retro-item:${A}`);
    expect(coordinatorRetroItemUnit(ruled([{ epic: 2, id: A, status: "done" }]).text)).toBe("none");
  });

  test("before any ruling, every open item holds: blocking ones at distance 1, the untagged one at 2", () => {
    expect(heldBy(recorded())).toEqual({ 3: [A, B].sort(), 4: [A, B, C].sort() });
    // The routed items' holds are Maintainer causes; the lane item's is not.
    const flags = epicHolds(snapshotOf(world(recorded())))(4)
      .filter((r) => r.code === "retro-item")
      .map((r) => [/retro-item:(\S+)/.exec(r.message)?.[1], r.maintainer === true])
      .sort();
    expect(flags).toEqual([[A, false], [B, true], [C, true]].sort());
  });

  // AC 4: a ruled done or defer, applied by editRetroGates through applyItemStatuses.
  const cases: readonly {
    readonly name: string;
    readonly statuses: readonly RetroItemStatusChange[];
    readonly summary: readonly string[];
    readonly digest: readonly string[];
    readonly held: Record<number, string[]>;
  }[] = [
    {
      name: "B ruled done",
      statuses: [{ epic: 2, id: B, status: "done" }],
      summary: [`epics.2.items: ${B} waiting -> done`],
      digest: [C_LINE],
      held: { 3: [A], 4: [A, C].sort() },
    },
    {
      name: "B ruled deferred",
      statuses: [{ epic: 2, id: B, status: "deferred" }],
      summary: [`epics.2.items: ${B} waiting -> deferred`],
      digest: [C_LINE],
      held: { 3: [A], 4: [A, C].sort() },
    },
    {
      name: "C ruled deferred",
      statuses: [{ epic: 2, id: C, status: "deferred" }],
      summary: [`epics.2.items: ${C} waiting -> deferred`],
      digest: [B_LINE],
      held: { 3: [A, B].sort(), 4: [A, B].sort() },
    },
    {
      name: "B done and C deferred",
      statuses: [
        { epic: 2, id: B, status: "done" },
        { epic: 2, id: C, status: "deferred" },
      ],
      summary: [`epics.2.items: ${B} waiting -> done`, `epics.2.items: ${C} waiting -> deferred`],
      digest: [],
      held: { 3: [A], 4: [A] },
    },
    {
      name: "an unknown id and an unknown Epic change nothing",
      statuses: [
        { epic: 2, id: "epic-2-retro-item-9-x", status: "done" },
        { epic: 7, id: B, status: "deferred" },
      ],
      summary: [],
      digest: [B_LINE, C_LINE],
      held: { 3: [A, B].sort(), 4: [A, B, C].sort() },
    },
  ];

  for (const c of cases) {
    test(`AC 4: ${c.name}: the digest and the Epic holds after it`, () => {
      const r = ruled(c.statuses);
      expect(r.summary).toEqual([...c.summary]);
      const { lines, count } = digestOf(r.text);
      expect(lines).toEqual([...c.digest]);
      expect(count).toBe(c.digest.length);
      expect(heldBy(r.text)).toEqual(c.held);
      // The lane item stays the coordinator's only retro-item unit.
      expect(coordinatorRetroItemUnit(r.text)).toBe(`retro-item:${A}`);
    });
  }
});
