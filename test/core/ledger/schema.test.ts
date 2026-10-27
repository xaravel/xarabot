import { describe, expect, test } from "bun:test";
import {
  CoordinatorRecordSchema,
  isUnitId,
  unitFileName,
  unitFromPath,
  unitKind,
  unitPath,
  UnitRecordSchema,
} from "../../../src/core/schemas/ledger.ts";
import { ALICE, COORD, rec, SHA_A, SHA_C, T0 } from "./fixtures.ts";

describe("unit ids", () => {
  const good: readonly [string, string, string][] = [
    ["story:1.5", "story", "units/story__1.5.json"],
    ["story:1.17a", "story", "units/story__1.17a.json"],
    ["retro:2", "retro", "units/retro__2.json"],
    ["retro-item:epic-2-retro-item-1-fix-polling", "retro-item", "units/retro-item__epic-2-retro-item-1-fix-polling.json"],
    // The stock retro's `_slugify` keeps `_` (even doubled) and Unicode letters, marks and digits (Story 2.9).
    ["retro-item:epic-2-retro-item-3-add-a-retro_result-test", "retro-item", "units/retro-item__epic-2-retro-item-3-add-a-retro_result-test.json"],
    ["retro-item:epic-2-retro-item-5-a__b", "retro-item", "units/retro-item__epic-2-retro-item-5-a__b.json"],
    ["retro-item:epic-2-retro-item-4-réviser-l-écran-日本", "retro-item", "units/retro-item__epic-2-retro-item-4-réviser-l-écran-日本.json"],
    ["checkpoint:3", "checkpoint", "units/checkpoint__3.json"],
    ["planning:sprint-review.4", "planning", "units/planning__sprint-review.4.json"],
    ["reconcile:12", "reconcile", "units/reconcile__12.json"],
  ];
  for (const [id, kind, path] of good) {
    test(`${id} is a ${kind} at ${path}`, () => {
      expect(unitKind(id)).toBe(kind as never);
      expect(unitFileName(id)).toBe(path.slice("units/".length));
      expect(unitPath(id)).toBe(path);
      expect(unitFromPath(path)).toBe(id);
    });
  }
  const bad = [
    "story:1",
    "story:1.5A",
    "retro:0",
    "retro:01",
    "retro:x",
    "retro-item:item-1",
    "retro-item:epic-2-retro-item-1-",
    "retro-item:epic-2-retro-item-1-a--b",
    "retro-item:epic-2-retro-item-1-a b",
    "retro-item:epic-2-retro-item-1-a.b",
    "checkpoint:-1",
    "planning:Sprint.1",
    "planning:sprint",
    "planning:sprint.0",
    "reconcile:",
    "task:1",
    "story1.5",
    "",
  ];
  for (const id of bad) {
    test(`rejects ${JSON.stringify(id)}`, () => {
      expect(unitKind(id)).toBeUndefined();
      expect(isUnitId(id)).toBe(false);
      expect(UnitRecordSchema.safeParse(rec({ unit: id })).success).toBe(false);
    });
  }
  for (const path of ["units/story:1.5.json", "units/story__1.5", "units/x/story__1.5.json", "story__1.5.json", "units/task__1.json"]) {
    test(`${path} is not a unit file`, () => {
      expect(unitFromPath(path)).toBeUndefined();
    });
  }
});

describe("UnitRecordSchema", () => {
  test("a record with every AR6 field set parses", () => {
    const full = rec({
      state: "parked",
      pr: 7,
      pr_owner: "alice",
      base_sha: SHA_A,
      head_sha: SHA_C,
      reviewed_sha: SHA_A,
      passed_sha: SHA_A,
      approved_sha: SHA_A,
      builder_providers: ["anthropic"],
      park: { kind: "blocked", reason: "verification", inbox_owner: "alice", globs_held: [] },
      attempts: 2,
      loopbacks: 1,
      ci_fixes: 1,
      approval: { by: "carol", manifest_sha: SHA_A },
    });
    expect(UnitRecordSchema.safeParse(full).success).toBe(true);
  });

  const reasons = [
    "escalation", "human-live-step", "intent-gap", "verification", "other",
    "review-cap", "ci-fix-cap", "ci-timeout", "write-check", "no-op", "attempts-cap", "unclaimable", "graph-invalid", "readiness", "review-findings",
  ];
  for (const reason of reasons) {
    test(`park.reason ${reason} is valid for blocked`, () => {
      const r = rec({ state: "parked", park: { kind: "blocked", reason: reason as never, inbox_owner: "alice", globs_held: [] } });
      expect(UnitRecordSchema.safeParse(r).success).toBe(true);
    });
  }

  const invalid: readonly [string, unknown][] = [
    ["unknown park.reason", rec({ state: "parked", park: { kind: "blocked", reason: "tired" as never, inbox_owner: "alice", globs_held: [] } })],
    ["blocked without reason", rec({ state: "parked", park: { kind: "blocked", reason: null, inbox_owner: "alice", globs_held: [] } })],
    ["reason on awaiting-approval", rec({ state: "parked", park: { kind: "awaiting-approval", reason: "other", inbox_owner: "alice", globs_held: [] } })],
    ["park on a claimed record", rec({ park: { kind: "needs-approval", reason: null, inbox_owner: "alice", globs_held: [] } })],
    ["parked without park", rec({ state: "parked" })],
    ["unknown state", rec({ state: "done" as never })],
    ["unknown key", { ...rec(), extra: 1 }],
    ["missing key", (({ approval: _a, ...r }) => r)(rec())],
    ["short sha", rec({ head_sha: "abc123" })],
    ["uppercase sha", rec({ head_sha: "A".repeat(40) })],
    ["generation 0", rec({ generation: 0 })],
    ["negative attempts", rec({ attempts: -1 })],
    ["pr 0", rec({ pr: 0 })],
    ["bad lane", rec({ lane: "builder" })],
    ["bad host", rec({ host: "not-a-uuid" })],
    ["bad owner", rec({ owner: "-x" })],
    ["unnormalized glob", rec({ globs: ["./src/**"] })],
    ["empty provider", rec({ builder_providers: [""] })],
    ["bad heartbeat", rec({ heartbeat_at: "yesterday" })],
    ["schema_version 7", rec({ schema_version: 7 as never })],
    ["bad enqueued_sha", rec({ enqueued_sha: "abc123" })],
    ["schema_version 0", rec({ schema_version: 0 as never })],
  ];
  for (const [name, value] of invalid) {
    test(`rejects ${name}`, () => {
      expect(UnitRecordSchema.safeParse(value).success).toBe(false);
    });
  }
});

describe("CoordinatorRecordSchema", () => {
  const good = {
    schema_version: 1,
    owner: COORD.owner,
    host: COORD.host,
    lane: "coordinator",
    generation: 1,
    heartbeat_at: T0,
    digest_posted_at: null,
    rulings_cursor: null,
  };
  test("parses", () => {
    expect(CoordinatorRecordSchema.safeParse(good).success).toBe(true);
    expect(CoordinatorRecordSchema.safeParse({ ...good, schema_version: 2 }).success).toBe(true);
    expect(CoordinatorRecordSchema.safeParse({ ...good, schema_version: 3 }).success).toBe(true);
    expect(CoordinatorRecordSchema.safeParse({ ...good, schema_version: 4 }).success).toBe(true);
    expect(CoordinatorRecordSchema.safeParse({ ...good, schema_version: 6 }).success).toBe(true);
    expect(CoordinatorRecordSchema.safeParse({ ...good, schema_version: 7 }).success).toBe(false);
    expect(CoordinatorRecordSchema.safeParse({ ...good, digest_posted_at: T0, rulings_cursor: "123" }).success).toBe(true);
  });
  for (const [name, value] of [
    ["builder lane", { ...good, lane: ALICE.lane }],
    ["empty cursor", { ...good, rulings_cursor: "" }],
    ["extra key", { ...good, x: 1 }],
  ] as const) {
    test(`rejects ${name}`, () => {
      expect(CoordinatorRecordSchema.safeParse(value).success).toBe(false);
    });
  }
});
