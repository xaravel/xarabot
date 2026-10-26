import { serializeUnitRecord } from "../../../src/core/ledger/codec.ts";
import type { LaneIdentity, UnitRecord } from "../../../src/core/schemas/ledger.ts";

export const ALICE: LaneIdentity = { owner: "alice", host: "11111111-1111-4111-8111-111111111111", lane: "builder-1" };
export const BOB: LaneIdentity = { owner: "bob", host: "22222222-2222-4222-8222-222222222222", lane: "builder-2" };
export const COORD: LaneIdentity = { owner: "carol", host: "33333333-3333-4333-8333-333333333333", lane: "coordinator" };

export const T0 = "2026-10-22T10:00:00Z";
/** 10 min after T0: not stale. */
export const NOW = "2026-10-22T10:10:00Z";
/** Exactly 30 min after T0: stale. */
export const LATE = "2026-10-22T10:30:00Z";

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(64);
export const SHA_D = "d".repeat(40);

/** A claimed `story:1.5` held by ALICE at generation 1, with overrides. */
export function rec(over: Partial<UnitRecord> = {}): UnitRecord {
  return {
    schema_version: 5,
    unit: "story:1.5",
    state: "claimed",
    owner: ALICE.owner,
    host: ALICE.host,
    lane: ALICE.lane,
    generation: 1,
    globs: ["src/core/ledger/**"],
    heartbeat_at: T0,
    pr: null,
    pr_owner: null,
    base_sha: null,
    head_sha: null,
    reviewed_sha: null,
    passed_sha: null,
    enqueued_sha: null,
    approved_sha: null,
    approved_graph: null,
    retro_result: null,
    builder_providers: [],
    park: null,
    attempts: 0,
    loopbacks: 0,
    ci_fixes: 0,
    approval: null,
    ...over,
  };
}

/** Ledger files holding these records (plus any extra raw files). */
export function tip(records: readonly UnitRecord[], extra: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = { ...extra };
  for (const r of records) files[`units/${r.unit.replace(":", "__")}.json`] = serializeUnitRecord(r);
  return files;
}
