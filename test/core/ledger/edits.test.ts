import { describe, expect, test } from "bun:test";
import { serializeUnitRecord } from "../../../src/core/ledger/codec.ts";
import {
  applyRuling,
  ATTEMPTS_CAP,
  ciFix,
  claim,
  deleteMerged,
  ejected,
  failAttempt,
  finishRecurring,
  heartbeat,
  heldGlobs,
  keepAlive,
  loopback,
  markMerged,
  park,
  parkNew,
  release,
  releaseStale,
  startMerging,
  STALE_AFTER_MS,
  takeApproved,
  takeOverStale,
  type LedgerEdit,
} from "../../../src/core/ledger/edits.ts";
import type { LaneIdentity, Park, UnitRecord } from "../../../src/core/schemas/ledger.ts";
import { ALICE, BOB, COORD, LATE, NOW, rec, SHA_A, SHA_B, SHA_C, SHA_D, T0, tip } from "./fixtures.ts";

const U = "story:1.5";
const PATH = "units/story__1.5.json";

/** A record as written by `by` at `at`. */
function by(who: LaneIdentity, at: string, over: Partial<UnitRecord>): UnitRecord {
  return rec({ owner: who.owner, host: who.host, lane: who.lane, heartbeat_at: at, ...over });
}

const blocked = (reason: Park["reason"], inbox = "alice"): Park => ({ kind: "blocked", reason, inbox_owner: inbox, globs_held: [] });
const awaiting = (globs_held: string[]): Park => ({ kind: "awaiting-approval", reason: null, inbox_owner: "alice", globs_held });
const needs: Park = { kind: "needs-approval", reason: null, inbox_owner: "alice", globs_held: [] };

type Expect = UnitRecord | "null" | "deleted" | "stop" | "invalid" | "precondition" | "illegal-transition";
type Case = readonly [name: string, edit: LedgerEdit, records: readonly UnitRecord[], expected: Expect, editName?: string];

const base = { unit: U, by: ALICE, now: NOW };
const held = { ...base, generation: 1 };

const CASES: readonly Case[] = [
  // claim: none -> claimed
  ["claim none -> claimed", claim({ ...base, globs: ["./src/core/ledger/**"], expectGeneration: null }), [], by(ALICE, NOW, {})],
  [
    "claim none -> claimed adopting a PR",
    claim({ ...base, globs: ["src/core/ledger/**"], expectGeneration: null, adoptPr: { pr: 9, pr_owner: "alice", head_sha: SHA_A, base_sha: SHA_B } }),
    [],
    by(ALICE, NOW, { pr: 9, pr_owner: "alice", head_sha: SHA_A, base_sha: SHA_B }),
  ],
  [
    "claim none -> claimed with a base SHA",
    claim({ ...base, globs: ["src/core/ledger/**"], expectGeneration: null, baseSha: SHA_B }),
    [],
    by(ALICE, NOW, { base_sha: SHA_B }),
  ],
  ["claim with a bad base SHA", claim({ ...base, globs: ["src/x/**"], expectGeneration: null, baseSha: "main" }), [], "invalid"],
  [
    "claim with both a base SHA and an adopted PR",
    claim({ ...base, globs: ["src/x/**"], expectGeneration: null, baseSha: SHA_B, adoptPr: { pr: 9, pr_owner: "alice", head_sha: SHA_A, base_sha: SHA_B } }),
    [],
    "invalid",
  ],
  ["claim none with a manifest_sha", claim({ ...base, globs: ["src/x/**"], expectGeneration: null, manifestSha: SHA_A }), [], "precondition"],
  ["claim none expecting a generation", claim({ ...base, globs: ["src/x/**"], expectGeneration: 1 }), [], "precondition"],
  ["claim expecting generation 0", claim({ ...base, globs: ["src/x/**"], expectGeneration: 0 }), [], "invalid"],
  ["claim expecting generation -1", claim({ ...base, globs: ["src/x/**"], expectGeneration: -1 }), [], "invalid"],
  ["claim expecting generation 1.5", claim({ ...base, globs: ["src/x/**"], expectGeneration: 1.5 }), [], "invalid"],
  ["claim with a bad glob", claim({ ...base, globs: ["../x"], expectGeneration: null }), [], "invalid"],
  // claim: released -> claimed
  [
    "claim released -> claimed",
    claim({ ...base, globs: ["src/core/ledger/**"], expectGeneration: 2, manifestSha: SHA_A }),
    [
      by(BOB, T0, {
        state: "released", generation: 2, attempts: 1, loopbacks: 1, ci_fixes: 2, pr: 7, pr_owner: "bob", head_sha: SHA_A, base_sha: SHA_B,
        reviewed_sha: SHA_A, passed_sha: SHA_A, approved_sha: SHA_A, builder_providers: ["claude"], approval: { by: "carol", manifest_sha: SHA_A },
      }),
    ],
    by(ALICE, NOW, {
      generation: 3, attempts: 1, loopbacks: 1, ci_fixes: 2, builder_providers: ["claude"], approval: { by: "carol", manifest_sha: SHA_A },
    }),
  ],
  ["claim released, manifest_sha not approved", claim({ ...base, globs: ["src/x/**"], expectGeneration: 1, manifestSha: SHA_B }), [rec({ state: "released", approval: { by: "carol", manifest_sha: SHA_A } })], "precondition"],
  ["claim released, no approval", claim({ ...base, globs: ["src/x/**"], expectGeneration: 1, manifestSha: SHA_B }), [rec({ state: "released" })], "precondition"],
  ["claim released, wrong generation", claim({ ...base, globs: ["src/x/**"], expectGeneration: 2 }), [rec({ state: "released" })], "precondition"],
  ["claim released, expecting none", claim({ ...base, globs: ["src/x/**"], expectGeneration: null }), [rec({ state: "released" })], "precondition"],
  ["claim a claimed unit", claim({ ...base, globs: ["src/x/**"], expectGeneration: 1 }), [rec()], "precondition"],
  // claim: overlap
  ["claim overlapping a claimed unit", claim({ ...base, globs: ["src/core/**"], expectGeneration: null }), [rec({ unit: "story:1.6", globs: ["src/core/ledger/x.ts"] })], "precondition"],
  ["claim overlapping a merging unit", claim({ ...base, globs: ["SRC/Core/**"], expectGeneration: null }), [rec({ unit: "story:1.6", state: "merging", globs: ["src/core/a.ts"] })], "precondition"],
  ["claim overlapping a parked unit's held paths", claim({ ...base, globs: ["src/a/**"], expectGeneration: null }), [rec({ unit: "story:1.6", state: "parked", globs: [], park: awaiting(["src/a/x.ts"]) })], "precondition"],
  ["claim beside a parked unit holding nothing", claim({ ...base, globs: ["src/a/**"], expectGeneration: null }), [rec({ unit: "story:1.6", state: "parked", globs: ["src/a/**"], park: blocked("other") })], by(ALICE, NOW, { globs: ["src/a/**"] })],
  ["claim beside a released unit", claim({ ...base, globs: ["src/a/**"], expectGeneration: null }), [rec({ unit: "story:1.6", state: "released", globs: ["src/a/**"] })], by(ALICE, NOW, { globs: ["src/a/**"] })],
  // parkNew
  ["parkNew needs-approval", parkNew({ ...base, kind: "needs-approval" }), [], by(ALICE, NOW, { state: "parked", globs: [], park: needs })],
  ["parkNew blocked", parkNew({ ...base, kind: "blocked", inboxOwner: "carol" }), [], by(ALICE, NOW, { state: "parked", globs: [], park: blocked("escalation", "carol") })],
  ["parkNew a non-Story unit", parkNew({ ...base, unit: "retro:1", kind: "blocked" }), [], "invalid"],
  ["parkNew with a record", parkNew({ ...base, kind: "blocked" }), [rec({ state: "released" })], "precondition"],
  // heartbeat
  [
    "heartbeat claimed",
    heartbeat({ ...held, set: { pr: 7, pr_owner: "alice", head_sha: SHA_A, base_sha: SHA_B, reviewed_sha: SHA_A, passed_sha: SHA_C, builder_providers: ["codex", "claude"] } }),
    [rec()],
    by(ALICE, NOW, { pr: 7, pr_owner: "alice", head_sha: SHA_A, base_sha: SHA_B, reviewed_sha: SHA_A, passed_sha: SHA_C, builder_providers: ["claude", "codex"] }),
  ],
  ["heartbeat merging", heartbeat(held), [rec({ state: "merging", pr: 7, passed_sha: SHA_A })], by(ALICE, NOW, { state: "merging", pr: 7, passed_sha: SHA_A })],
  ["heartbeat by another holder", heartbeat({ ...held, by: BOB }), [rec()], "precondition"],
  ["heartbeat from another host", heartbeat({ ...held, by: { ...ALICE, host: BOB.host } }), [rec()], "precondition"],
  ["heartbeat at the wrong generation", heartbeat({ ...held, generation: 2 }), [rec()], "precondition"],
  ["heartbeat a parked unit", heartbeat(held), [rec({ state: "parked", park: needs })], "precondition"],
  ["heartbeat a missing unit", heartbeat(held), [], "precondition"],
  ["heartbeat with a bad sha", heartbeat({ ...held, set: { head_sha: "xyz" } }), [rec()], "invalid"],
  // keepAlive: the keeper's beat
  ["keepAlive claimed", keepAlive(held), [rec({ pr: 7, head_sha: SHA_A })], by(ALICE, NOW, { pr: 7, head_sha: SHA_A })],
  ["keepAlive merging", keepAlive(held), [rec({ state: "merging", pr: 7, passed_sha: SHA_A })], by(ALICE, NOW, { state: "merging", pr: 7, passed_sha: SHA_A })],
  ["keepAlive a unit its holder parked", keepAlive(held), [rec({ state: "parked", park: blocked("no-op") })], "null"],
  ["keepAlive a unit its holder released", keepAlive(held), [rec({ state: "released", attempts: 1 })], "null"],
  ["keepAlive a unit its holder merged", keepAlive(held), [rec({ state: "merged", pr: 7 })], "null"],
  ["keepAlive by another holder", keepAlive({ ...held, by: BOB }), [rec()], "precondition"],
  ["keepAlive from another host", keepAlive({ ...held, by: { ...ALICE, host: BOB.host } }), [rec()], "precondition"],
  ["keepAlive at the wrong generation", keepAlive(held), [rec({ generation: 2 })], "precondition"],
  ["keepAlive a record another lane holds at generation + 1", keepAlive(held), [by(BOB, NOW, { generation: 2 })], "precondition"],
  ["keepAlive a parked unit at another generation", keepAlive(held), [rec({ state: "parked", generation: 2, park: blocked("no-op") })], "precondition"],
  ["keepAlive a released unit another lane wrote", keepAlive(held), [by(BOB, NOW, { state: "released" })], "precondition"],
  ["keepAlive a missing unit", keepAlive(held), [], "precondition"],
  ["keepAlive generation 0", keepAlive({ ...held, generation: 0 }), [rec()], "invalid"],
  // loopback / ciFix
  ["loopback under the cap", loopback({ ...held, cap: 2 }), [rec({ loopbacks: 1 })], by(ALICE, NOW, { loopbacks: 2 })],
  ["loopback at the cap", loopback({ ...held, cap: 2 }), [rec({ loopbacks: 2 })], by(ALICE, NOW, { loopbacks: 2, state: "parked", park: blocked("review-cap") })],
  ["loopback cap 0", loopback({ ...held, cap: 0 }), [rec()], "invalid"],
  ["loopback while merging", loopback({ ...held, cap: 2 }), [rec({ state: "merging" })], "precondition"],
  ["ciFix under the cap", ciFix({ ...held, cap: 1 }), [rec()], by(ALICE, NOW, { ci_fixes: 1 })],
  ["ciFix at the cap", ciFix({ ...held, cap: 1 }), [rec({ ci_fixes: 1 })], by(ALICE, NOW, { ci_fixes: 1, state: "parked", park: blocked("ci-fix-cap") })],
  ["ciFix cap 1.5", ciFix({ ...held, cap: 1.5 }), [rec()], "invalid"],
  // takeOverStale
  ["takeOverStale claimed", takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1 }), [rec()], by(BOB, LATE, { generation: 2, attempts: 1 })],
  ["takeOverStale claimed, 3rd attempt", takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1 }), [rec({ attempts: 2 })], by(BOB, LATE, { generation: 2, attempts: 3, state: "parked", park: blocked("attempts-cap", "bob") })],
  ["takeOverStale not stale", takeOverStale({ unit: U, by: BOB, now: NOW, generation: 1 }), [rec()], "precondition"],
  ["takeOverStale 1 ms before stale", takeOverStale({ unit: U, by: BOB, now: "2026-10-22T10:29:59.999Z", generation: 1 }), [rec()], "precondition"],
  ["takeOverStale exactly at the boundary", takeOverStale({ unit: U, by: BOB, now: "2026-10-22T10:30:00.000Z", generation: 1 }), [rec()], by(BOB, "2026-10-22T10:30:00.000Z", { generation: 2, attempts: 1 })],
  ["takeOverStale wrong generation", takeOverStale({ unit: U, by: BOB, now: LATE, generation: 2 }), [rec()], "precondition"],
  ["takeOverStale merging, still queued", takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1, stillQueued: true }), [rec({ state: "merging", attempts: 1 })], by(BOB, LATE, { state: "merging", generation: 2, attempts: 1 })],
  ["takeOverStale merging, not asserted queued", takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1 }), [rec({ state: "merging" })], "precondition"],
  ["takeOverStale merging under the coordinator", takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1, stillQueued: true }), [by(COORD, T0, { state: "merging" })], "precondition"],
  ["takeOverStale released", takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1 }), [rec({ state: "released" })], "precondition"],
  // startMerging
  ["startMerging", startMerging(held), [rec({ pr: 7, passed_sha: SHA_A })], by(ALICE, NOW, { state: "merging", pr: 7, passed_sha: SHA_A })],
  ["startMerging without passed_sha", startMerging(held), [rec({ pr: 7 })], "precondition"],
  ["startMerging without a PR", startMerging(held), [rec({ passed_sha: SHA_A })], "precondition"],
  // park
  ["park claimed awaiting-approval", park({ ...held, kind: "awaiting-approval", diffPaths: ["./src/b.ts", "src/a.ts"] }), [rec({ approved_sha: SHA_A })], by(ALICE, NOW, { state: "parked", approved_sha: SHA_A, park: awaiting(["src/a.ts", "src/b.ts"]) })],
  ["park claimed blocked", park({ ...held, kind: "blocked", reason: "verification" }), [rec()], by(ALICE, NOW, { state: "parked", park: blocked("verification") })],
  ["park claimed needs-approval", park({ ...held, kind: "needs-approval" }), [rec()], by(ALICE, NOW, { state: "parked", park: needs })],
  ["park with reason unclaimable", park({ ...held, kind: "blocked", reason: "unclaimable" }), [rec()], "invalid"],
  ["park blocked without a reason", park({ ...held, kind: "blocked" }), [rec()], "invalid"],
  ["park awaiting-approval with a reason", park({ ...held, kind: "awaiting-approval", reason: "other", diffPaths: [] }), [rec()], "invalid"],
  ["park awaiting-approval without diff paths", park({ ...held, kind: "awaiting-approval" }), [rec()], "invalid"],
  ["park with an unknown reason", park({ ...held, kind: "blocked", reason: "tired" as never }), [rec()], "invalid"],
  ["park merging awaiting-approval", park({ ...held, kind: "awaiting-approval", diffPaths: ["src/a.ts"] }), [rec({ state: "merging", approved_sha: SHA_A })], by(ALICE, NOW, { state: "parked", park: awaiting(["src/a.ts"]) })],
  ["park merging blocked", park({ ...held, kind: "blocked", reason: "other" }), [rec({ state: "merging" })], "precondition"],
  ["park by another holder", park({ ...held, by: BOB, kind: "needs-approval" }), [rec()], "precondition"],
  // failAttempt
  ["failAttempt claimed, attempts 1", failAttempt(held), [rec({ attempts: 1 })], by(ALICE, NOW, { state: "released", attempts: 2 })],
  ["failAttempt claimed, attempts 2", failAttempt(held), [rec({ attempts: 2 })], by(ALICE, NOW, { state: "parked", attempts: 3, park: blocked("attempts-cap") })],
  ["failAttempt merging, attempts 2", failAttempt(held), [rec({ state: "merging", attempts: 2, pr: 7 })], by(ALICE, NOW, { state: "released", attempts: 3, pr: 7 })],
  ["failAttempt released", failAttempt(held), [rec({ state: "released" })], "precondition"],
  // release
  ["release claimed", release(held), [rec({ attempts: 1 })], by(ALICE, NOW, { state: "released", attempts: 1 })],
  ["release merging", release(held), [rec({ state: "merging" })], by(ALICE, NOW, { state: "released" })],
  ["release parked", release(held), [rec({ state: "parked", park: needs })], "precondition"],
  // releaseStale
  ["releaseStale merging", releaseStale({ unit: U, by: BOB, now: LATE, generation: 1 }), [rec({ state: "merging", pr: 7 })], by(BOB, LATE, { state: "released", attempts: 1, pr: 7 })],
  ["releaseStale not stale", releaseStale({ unit: U, by: BOB, now: NOW, generation: 1 }), [rec({ state: "merging" })], "precondition"],
  ["releaseStale under the coordinator", releaseStale({ unit: U, by: BOB, now: LATE, generation: 1 }), [by(COORD, T0, { state: "merging" })], "precondition"],
  ["releaseStale wrong generation", releaseStale({ unit: U, by: BOB, now: LATE, generation: 2 }), [rec({ state: "merging" })], "precondition"],
  ["releaseStale claimed", releaseStale({ unit: U, by: BOB, now: LATE, generation: 1 }), [rec()], "precondition"],
  // ejected
  ["ejected", ejected(held), [rec({ state: "merging", pr: 7 })], by(ALICE, NOW, { state: "claimed", attempts: 1, pr: 7 })],
  ["ejected under the coordinator", ejected({ ...held, by: COORD }), [by(COORD, T0, { state: "merging" })], "precondition"],
  ["ejected while claimed", ejected(held), [rec()], "precondition"],
  // markMerged
  ["markMerged released", markMerged({ ...base, by: BOB }), [rec({ state: "released" })], by(BOB, NOW, { state: "merged" })],
  ["markMerged claimed", markMerged(base), [rec()], by(ALICE, NOW, { state: "merged" })],
  ["markMerged merging", markMerged(base), [rec({ state: "merging" })], by(ALICE, NOW, { state: "merged" })],
  ["markMerged parked", markMerged(base), [rec({ state: "parked", park: awaiting(["a.ts"]) })], by(ALICE, NOW, { state: "merged" })],
  ["markMerged merged", markMerged(base), [rec({ state: "merged" })], "null"],
  ["markMerged with no record", markMerged(base), [], "precondition"],
  // finishRecurring
  ["finishRecurring planning", finishRecurring({ ...held, unit: "planning:sprint.2" }), [rec({ unit: "planning:sprint.2", pr: 4 })], by(ALICE, NOW, { unit: "planning:sprint.2", state: "merged" }), "finishRecurring planning:sprint.2"],
  ["finishRecurring reconcile", finishRecurring({ ...held, unit: "reconcile:3" }), [rec({ unit: "reconcile:3" })], by(ALICE, NOW, { unit: "reconcile:3", state: "merged" }), "finishRecurring reconcile:3"],
  ["finishRecurring a Story", finishRecurring(held), [rec()], "invalid"],
  // takeApproved
  [
    "takeApproved",
    takeApproved({ unit: U, by: COORD, now: NOW, generation: 1, approvedSha: SHA_D }),
    [rec({ state: "parked", globs: ["src/**"], park: awaiting(["src/a.ts"]), pr: 7 })],
    by(COORD, NOW, { state: "merging", generation: 2, globs: ["src/a.ts"], approved_sha: SHA_D, pr: 7 }),
  ],
  ["takeApproved by a builder", takeApproved({ ...base, generation: 1, approvedSha: SHA_D }), [rec({ state: "parked", park: awaiting([]) })], "precondition"],
  ["takeApproved needs-approval", takeApproved({ unit: U, by: COORD, now: NOW, generation: 1, approvedSha: SHA_D }), [rec({ state: "parked", park: needs })], "precondition"],
  ["takeApproved wrong generation", takeApproved({ unit: U, by: COORD, now: NOW, generation: 3, approvedSha: SHA_D }), [rec({ state: "parked", park: awaiting([]) })], "precondition"],
  ["takeApproved a claimed unit", takeApproved({ unit: U, by: COORD, now: NOW, generation: 1, approvedSha: SHA_D }), [rec()], "precondition"],
  ["takeApproved bad sha", takeApproved({ unit: U, by: COORD, now: NOW, generation: 1, approvedSha: "nope" }), [rec({ state: "parked", park: awaiting([]) })], "invalid"],
  // applyRuling
  [
    "applyRuling release",
    applyRuling({ unit: U, by: COORD, now: NOW, generation: 1, ruling: "release" }),
    [rec({ state: "parked", park: blocked("attempts-cap"), attempts: 3, loopbacks: 2, ci_fixes: 1, passed_sha: SHA_A, builder_providers: ["claude"] })],
    by(COORD, NOW, { state: "released", passed_sha: SHA_A, builder_providers: ["claude"] }),
  ],
  [
    "applyRuling rebuild",
    applyRuling({ unit: U, by: COORD, now: NOW, generation: 1, ruling: "rebuild" }),
    [rec({ state: "parked", park: blocked("review-cap"), attempts: 1, loopbacks: 2, reviewed_sha: SHA_A, passed_sha: SHA_A, approved_sha: SHA_A, builder_providers: ["claude"], pr: 7 })],
    by(COORD, NOW, { state: "released", pr: 7 }),
  ],
  [
    "applyRuling approve",
    applyRuling({ unit: U, by: COORD, now: NOW, generation: 1, ruling: "approve", manifestSha: SHA_A }),
    [rec({ state: "parked", globs: [], park: needs })],
    by(COORD, NOW, { state: "released", globs: [], approval: { by: "carol", manifest_sha: SHA_A } }),
  ],
  ["applyRuling approve on a blocked park", applyRuling({ unit: U, by: COORD, now: NOW, generation: 1, ruling: "approve", manifestSha: SHA_A }), [rec({ state: "parked", park: blocked("other") })], "precondition"],
  ["applyRuling approve without a manifest_sha", applyRuling({ unit: U, by: COORD, now: NOW, generation: 1, ruling: "approve" }), [rec({ state: "parked", park: needs })], "invalid"],
  ["applyRuling by a builder", applyRuling({ ...base, generation: 1, ruling: "release" }), [rec({ state: "parked", park: needs })], "precondition"],
  ["applyRuling wrong generation", applyRuling({ unit: U, by: COORD, now: NOW, generation: 2, ruling: "release" }), [rec({ state: "parked", park: needs })], "precondition"],
  ["applyRuling on a claimed unit", applyRuling({ unit: U, by: COORD, now: NOW, generation: 1, ruling: "release" }), [rec()], "precondition"],
  // deleteMerged
  ["deleteMerged", deleteMerged({ unit: U, by: COORD, now: NOW }), [rec({ state: "merged" })], "deleted"],
  ["deleteMerged already gone", deleteMerged({ unit: U, by: COORD, now: NOW }), [], "null"],
  ["deleteMerged a released unit", deleteMerged({ unit: U, by: COORD, now: NOW }), [rec({ state: "released" })], "precondition"],
  ["deleteMerged by a builder", deleteMerged(base), [rec({ state: "merged" })], "precondition"],
  // parameters
  ["a bad unit id", markMerged({ ...base, unit: "story:x" }), [], "invalid"],
  ["a bad now", markMerged({ ...base, now: "soon" }), [rec()], "invalid"],
  ["a bad writer", markMerged({ ...base, by: { ...ALICE, lane: "builder-0" } }), [rec()], "invalid"],
];

describe("ledger edits", () => {
  for (const [name, edit, records, expected, msg] of CASES) {
    test(name, () => {
      const r = edit(tip(records));
      if (typeof expected === "string" && expected !== "null" && expected !== "deleted") {
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.kind).toBe(expected);
        return;
      }
      if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
      if (expected === "null") {
        expect(r.value).toBeNull();
        return;
      }
      if (r.value === null) throw new Error("expected a commit");
      expect(r.value.message).toEndWith(" [skip ci]");
      if (expected === "deleted") {
        expect(r.value).toEqual({ message: `ledger: deleteMerged ${U} [skip ci]`, writes: {}, deletes: [PATH] });
        return;
      }
      const path = `units/${expected.unit.replace(":", "__")}.json`;
      expect(r.value.writes).toEqual({ [path]: serializeUnitRecord(expected) });
      expect(r.value.deletes).toEqual([]);
      const editName = msg ?? name.split(" ")[0];
      expect(r.value.message).toBe(`ledger: ${editName}${msg === undefined ? ` ${U}` : ""} [skip ci]`);
      // Byte-stable: the same edit on the same tip gives identical bytes.
      expect(edit(tip(records))).toEqual(r);
    });
  }

  const heldCases: readonly [string, UnitRecord, readonly string[]][] = [
    ["claimed", rec({ globs: ["src/a/**"] }), ["src/a/**"]],
    ["merging", rec({ state: "merging", globs: ["src/a/**"] }), ["src/a/**"]],
    ["parked awaiting-approval", rec({ state: "parked", globs: ["src/a/**"], park: awaiting(["src/a/x.ts"]) }), ["src/a/x.ts"]],
    ["parked blocked", rec({ state: "parked", globs: ["src/a/**"], park: blocked("other") }), []],
    ["released", rec({ state: "released", globs: ["src/a/**"] }), []],
    ["merged", rec({ state: "merged", globs: ["src/a/**"] }), []],
  ];
  for (const [state, record, expected] of heldCases) {
    test(`heldGlobs of a ${state} record`, () => {
      expect(heldGlobs(record)).toEqual(expected);
    });
  }

  test("caps", () => {
    expect(ATTEMPTS_CAP).toBe(3);
    expect(STALE_AFTER_MS).toBe(30 * 60 * 1000);
  });

  const v2 = { "units/story__9.9.json": serializeUnitRecord(rec({ unit: "story:9.9" })).replace('"schema_version": 1', '"schema_version": 2') };
  const v0 = { "units/story__9.9.json": serializeUnitRecord(rec({ unit: "story:9.9" })).replace('"schema_version": 1', '"schema_version": 0') };
  const everyEdit: readonly [string, LedgerEdit][] = CASES.map(([name, edit]) => [name, edit]);
  for (const [name, edit] of everyEdit) {
    test(`${name}: a schema_version 2 or 0 record on the tip stops`, () => {
      for (const files of [v2, v0]) {
        const r = edit({ ...tip([rec()]), ...files });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.kind).toBe("stop");
      }
    });
  }

  test("a malformed tip is invalid for an edit", () => {
    const r = markMerged(base)({ [PATH]: "{" });
    expect(r.ok === false && r.error.kind).toBe("invalid");
  });

  test("attempts 1 -> fail -> released at 2, then claim and fail -> parked", () => {
    const first = failAttempt(held)(tip([rec({ attempts: 1 })]));
    if (!first.ok || first.value === null) throw new Error("expected a commit");
    const released = first.value.writes[PATH] as string;
    expect(JSON.parse(released)).toMatchObject({ state: "released", attempts: 2 });
    const reclaimed = claim({ ...base, globs: ["src/core/ledger/**"], expectGeneration: 1 })({ [PATH]: released });
    if (!reclaimed.ok || reclaimed.value === null) throw new Error("expected a commit");
    const again = failAttempt({ ...held, generation: 2 })(reclaimed.value.writes);
    if (!again.ok || again.value === null) throw new Error("expected a commit");
    expect(JSON.parse(again.value.writes[PATH] as string)).toMatchObject({ state: "parked", attempts: 3, park: blocked("attempts-cap") });
  });
});
