import { describe, expect, test } from "bun:test";
import { COORDINATOR_PATH, serializeCoordinator, serializeUnitRecord } from "../../../src/core/ledger/codec.ts";
import {
  applyRuling,
  ATTEMPTS_CAP,
  ciFix,
  claim,
  claimCoordinator,
  coordinatorClaimState,
  deleteMerged,
  deleteReleasedRecurring,
  ejected,
  failAttempt,
  failClaimed,
  fenced,
  finishRecurring,
  heartbeat,
  heldGlobs,
  isDisposable,
  isStale,
  isUngatedRetro,
  keepAlive,
  keepCoordinator,
  loopback,
  markMerged,
  park,
  parkNew,
  parkText,
  release,
  releaseDeadReconcile,
  releaseDisposable,
  releaseEjected,
  releaseStale,
  reparkGraph,
  stampDigest,
  startMerging,
  STALE_AFTER_MS,
  takeApproved,
  takeOverStale,
  type LedgerEdit,
} from "../../../src/core/ledger/edits.ts";
import { PARK_TEXT_MAX, type CoordinatorRecord, type LaneIdentity, type Park, type UnitRecord } from "../../../src/core/schemas/ledger.ts";
import { REDACTED, TRUNCATION_MARKER } from "../../../src/core/sanitize.ts";
import { ALICE, BOB, COORD, LATE, NOW, rec, SHA_A, SHA_B, SHA_C, SHA_D, T0, tip } from "./fixtures.ts";

const U = "story:1.5";
/** A graph hash. */
const GH = `sha256:${"9".repeat(64)}`;
const PATH = "units/story__1.5.json";

/** A record as written by `by` at `at`. */
function by(who: LaneIdentity, at: string, over: Partial<UnitRecord>): UnitRecord {
  return rec({ owner: who.owner, host: who.host, lane: who.lane, heartbeat_at: at, ...over });
}

const blocked = (reason: Park["reason"], inbox = "alice"): Park => ({ kind: "blocked", reason, inbox_owner: inbox, globs_held: [] });
const awaiting = (globs_held: string[]): Park => ({ kind: "awaiting-approval", reason: null, inbox_owner: "alice", globs_held });
const needs: Park = { kind: "needs-approval", reason: null, inbox_owner: "alice", globs_held: [] };
/** An awaiting-approval park whose graph delta at `hash` was posted (retro item 24). */
const posted = (globs_held: string[], hash: string = GH, inbox = "alice"): Park => ({ ...awaiting(globs_held), inbox_owner: inbox, graph_posted: hash });
/** Another graph hash. */
const GH_2 = `sha256:${"8".repeat(64)}`;

type Expect = UnitRecord | "null" | "deleted" | "stop" | "invalid" | "precondition" | "illegal-transition";
type Case = readonly [name: string, edit: LedgerEdit, records: readonly UnitRecord[], expected: Expect, editName?: string];

/** A second coordinator identity on another host. */
const COORD_2: LaneIdentity = { owner: "dave", host: "44444444-4444-4444-8444-444444444444", lane: "coordinator" };

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
        reviewed_sha: SHA_A, passed_sha: SHA_A, enqueued_sha: SHA_A, approved_sha: SHA_A, builder_providers: ["anthropic"], approval: { by: "carol", manifest_sha: SHA_A },
      }),
    ],
    by(ALICE, NOW, {
      generation: 3, attempts: 1, loopbacks: 1, ci_fixes: 2, builder_providers: ["anthropic"], approval: { by: "carol", manifest_sha: SHA_A },
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
    heartbeat({ ...held, set: { pr: 7, pr_owner: "alice", head_sha: SHA_A, base_sha: SHA_B, reviewed_sha: SHA_A, passed_sha: SHA_C, builder_providers: ["openai", "anthropic"] } }),
    [rec()],
    by(ALICE, NOW, { pr: 7, pr_owner: "alice", head_sha: SHA_A, base_sha: SHA_B, reviewed_sha: SHA_A, passed_sha: SHA_C, builder_providers: ["anthropic", "openai"] }),
  ],
  ["heartbeat merging", heartbeat(held), [rec({ state: "merging", pr: 7, passed_sha: SHA_A })], by(ALICE, NOW, { state: "merging", pr: 7, passed_sha: SHA_A })],
  ["heartbeat sets enqueued_sha", heartbeat({ ...held, set: { enqueued_sha: SHA_A } }), [rec({ pr: 7, passed_sha: SHA_A })], by(ALICE, NOW, { pr: 7, passed_sha: SHA_A, enqueued_sha: SHA_A })],
  ["heartbeat with a bad enqueued_sha", heartbeat({ ...held, set: { enqueued_sha: "nope" } }), [rec({ pr: 7 })], "invalid"],
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
  ["takeOverStale parked, heartbeat long gone", takeOverStale({ unit: U, by: BOB, now: "2031-01-01T00:00:00Z", generation: 1 }), [rec({ state: "parked", park: blocked("other") })], "precondition"],
  ["takeOverStale merged", takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1 }), [rec({ state: "merged" })], "precondition"],
  ["takeOverStale with no record", takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1 }), [], "precondition"],
  // takeOverStale claimed: the claim's globs, PR fields and cleared review SHAs
  [
    "takeOverStale claimed with re-resolved globs",
    takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1, globs: ["./src/x/**", "src/y.ts"] }),
    [rec()],
    by(BOB, LATE, { generation: 2, attempts: 1, globs: ["src/x/**", "src/y.ts"] }),
  ],
  [
    "takeOverStale claimed adopting the open PR",
    takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1, adoptPr: { pr: 9, pr_owner: "bob", head_sha: SHA_D, base_sha: SHA_B } }),
    [rec({ pr: 7, pr_owner: "alice", head_sha: SHA_A, base_sha: SHA_A, reviewed_sha: SHA_A, passed_sha: SHA_A, enqueued_sha: SHA_A, approved_sha: SHA_A, builder_providers: ["anthropic"], loopbacks: 1 })],
    by(BOB, LATE, { generation: 2, attempts: 1, pr: 9, pr_owner: "bob", head_sha: SHA_D, base_sha: SHA_B, builder_providers: ["anthropic"], loopbacks: 1 }),
  ],
  [
    "takeOverStale claimed with no open PR starts from main",
    takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1, baseSha: SHA_B }),
    [rec({ pr: 7, pr_owner: "alice", head_sha: SHA_A, base_sha: SHA_A, reviewed_sha: SHA_A, passed_sha: SHA_A })],
    by(BOB, LATE, { generation: 2, attempts: 1, base_sha: SHA_B }),
  ],
  [
    "takeOverStale claimed, 3rd attempt adopting a PR",
    takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1, adoptPr: { pr: 9, pr_owner: "bob", head_sha: SHA_D, base_sha: SHA_B } }),
    [rec({ attempts: 2 })],
    by(BOB, LATE, { generation: 2, attempts: 3, pr: 9, pr_owner: "bob", head_sha: SHA_D, base_sha: SHA_B, state: "parked", park: blocked("attempts-cap", "bob") }),
  ],
  ["takeOverStale claimed, globs overlap a claimed unit", takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1, globs: ["src/a/**"] }), [rec(), rec({ unit: "story:1.6", globs: ["src/a/x.ts"] })], "precondition"],
  ["takeOverStale claimed, its own globs overlap a merging unit", takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1 }), [rec(), rec({ unit: "story:1.6", state: "merging", globs: ["SRC/Core/**"] })], "precondition"],
  ["takeOverStale claimed, globs overlap a parked unit's held paths", takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1, globs: ["src/a/**"] }), [rec(), rec({ unit: "story:1.6", state: "parked", globs: [], park: awaiting(["src/a/x.ts"]) })], "precondition"],
  [
    "takeOverStale claimed beside a released unit",
    takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1, globs: ["src/a/**"] }),
    [rec(), rec({ unit: "story:1.6", state: "released", globs: ["src/a/**"] })],
    by(BOB, LATE, { generation: 2, attempts: 1, globs: ["src/a/**"] }),
  ],
  ["takeOverStale with a bad glob", takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1, globs: ["../x"] }), [rec()], "invalid"],
  ["takeOverStale with a bad base SHA", takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1, baseSha: "main" }), [rec()], "invalid"],
  ["takeOverStale with a bad adopted PR", takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1, adoptPr: { pr: 0, pr_owner: "bob", head_sha: SHA_D, base_sha: SHA_B } }), [rec()], "invalid"],
  [
    "takeOverStale with both a base SHA and an adopted PR",
    takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1, baseSha: SHA_B, adoptPr: { pr: 9, pr_owner: "bob", head_sha: SHA_D, base_sha: SHA_B } }),
    [rec()],
    "invalid",
  ],
  // takeOverStale merging: PR, SHAs and globs kept, head_sha from the queue
  [
    "takeOverStale merging, still queued at a new head",
    takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1, stillQueued: true, adoptPr: { pr: 7, pr_owner: "bob", head_sha: SHA_D, base_sha: SHA_B } }),
    [rec({ state: "merging", pr: 7, pr_owner: "alice", head_sha: SHA_A, base_sha: SHA_A, passed_sha: SHA_A, attempts: 1 })],
    by(BOB, LATE, { state: "merging", generation: 2, attempts: 1, pr: 7, pr_owner: "alice", head_sha: SHA_D, base_sha: SHA_A, passed_sha: SHA_A }),
  ],
  ["takeOverStale merging, another PR", takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1, stillQueued: true, adoptPr: { pr: 8, pr_owner: "bob", head_sha: SHA_D, base_sha: SHA_B } }), [rec({ state: "merging", pr: 7 })], "precondition"],
  ["takeOverStale merging with globs", takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1, stillQueued: true, globs: ["src/x/**"] }), [rec({ state: "merging", pr: 7 })], "precondition"],
  ["takeOverStale merging with a base SHA", takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1, stillQueued: true, baseSha: SHA_B }), [rec({ state: "merging", pr: 7 })], "precondition"],
  // startMerging
  ["startMerging", startMerging(held), [rec({ pr: 7, passed_sha: SHA_A })], by(ALICE, NOW, { state: "merging", pr: 7, passed_sha: SHA_A })],
  ["startMerging without passed_sha", startMerging(held), [rec({ pr: 7 })], "precondition"],
  ["startMerging without passed_sha but enqueued_sha", startMerging(held), [rec({ pr: 7, enqueued_sha: SHA_A })], "precondition"],
  [
    "startMerging a reconcile unit with no passed_sha: a reconcile PR gets no review",
    startMerging({ ...held, unit: "reconcile:3", by: COORD }),
    [by(COORD, T0, { unit: "reconcile:3", pr: 7, globs: [] })],
    by(COORD, NOW, { unit: "reconcile:3", state: "merging", pr: 7, globs: [] }),
    "startMerging reconcile:3",
  ],
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
  [
    "park merging awaiting-approval with enqueuedSha: enqueued_sha set, passed_sha kept, so only a later approval re-takes it",
    park({ ...held, by: COORD, generation: 2, kind: "awaiting-approval", diffPaths: ["src/a.ts"], enqueuedSha: SHA_A }),
    [by(COORD, T0, { state: "merging", generation: 2, pr: 7, approved_sha: SHA_A, passed_sha: SHA_B })],
    by(COORD, NOW, { state: "parked", generation: 2, pr: 7, passed_sha: SHA_B, enqueued_sha: SHA_A, park: { ...awaiting(["src/a.ts"]), inbox_owner: "carol" } }),
  ],
  [
    "park merging awaiting-approval with no enqueuedSha keeps enqueued_sha",
    park({ ...held, by: COORD, generation: 2, kind: "awaiting-approval", diffPaths: ["src/a.ts"] }),
    [by(COORD, T0, { state: "merging", generation: 2, pr: 7, approved_sha: SHA_A, enqueued_sha: SHA_B })],
    by(COORD, NOW, { state: "parked", generation: 2, pr: 7, enqueued_sha: SHA_B, park: { ...awaiting(["src/a.ts"]), inbox_owner: "carol" } }),
  ],
  ["park claimed with enqueuedSha", park({ ...held, kind: "awaiting-approval", diffPaths: ["src/a.ts"], enqueuedSha: SHA_A }), [rec()], "invalid"],
  ["park merging with a bad enqueuedSha", park({ ...held, by: COORD, generation: 2, kind: "awaiting-approval", diffPaths: ["src/a.ts"], enqueuedSha: "nope" }), [by(COORD, T0, { state: "merging", generation: 2, pr: 7 })], "invalid"],
  ["park by another holder", park({ ...held, by: BOB, kind: "needs-approval" }), [rec()], "precondition"],
  // park: any coordinator lane moves a coordinator-held merging record on at its generation (AD-6)
  [
    "park coordinator-held merging by another coordinator",
    park({ ...held, by: COORD_2, generation: 2, kind: "awaiting-approval", diffPaths: ["src/a.ts"], inboxOwner: "alice" }),
    [by(COORD, T0, { state: "merging", generation: 2, globs: ["src/a.ts"], pr: 7, approved_sha: SHA_A })],
    by(COORD_2, NOW, { state: "parked", generation: 2, globs: ["src/a.ts"], pr: 7, park: awaiting(["src/a.ts"]) }),
  ],
  [
    "park coordinator-held merging by another coordinator at the wrong generation",
    park({ ...held, by: COORD_2, generation: 1, kind: "awaiting-approval", diffPaths: ["src/a.ts"] }),
    [by(COORD, T0, { state: "merging", generation: 2, pr: 7 })],
    "precondition",
  ],
  ["park coordinator-held merging blocked by another coordinator", park({ ...held, by: COORD_2, generation: 2, kind: "blocked", reason: "other" }), [by(COORD, T0, { state: "merging", generation: 2, pr: 7 })], "precondition"],
  ["park coordinator-held merging by a builder", park({ ...held, by: BOB, generation: 2, kind: "awaiting-approval", diffPaths: ["src/a.ts"] }), [by(COORD, T0, { state: "merging", generation: 2, pr: 7 })], "precondition"],
  ["park builder-held merging by another identity", park({ ...held, by: BOB, kind: "awaiting-approval", diffPaths: ["src/a.ts"] }), [rec({ state: "merging", pr: 7 })], "precondition"],
  ["park builder-held merging by a coordinator", park({ ...held, by: COORD, kind: "awaiting-approval", diffPaths: ["src/a.ts"] }), [rec({ state: "merging", pr: 7 })], "precondition"],
  ["park coordinator-held claimed by another coordinator", park({ ...held, by: COORD_2, kind: "awaiting-approval", diffPaths: ["src/a.ts"] }), [by(COORD, T0, { state: "claimed" })], "precondition"],
  // failAttempt
  ["failAttempt claimed, attempts 1", failAttempt(held), [rec({ attempts: 1 })], by(ALICE, NOW, { state: "released", attempts: 2 })],
  ["failAttempt claimed, attempts 2", failAttempt(held), [rec({ attempts: 2 })], by(ALICE, NOW, { state: "parked", attempts: 3, park: blocked("attempts-cap") })],
  ["failAttempt merging, attempts 2", failAttempt(held), [rec({ state: "merging", attempts: 2, pr: 7 })], by(ALICE, NOW, { state: "released", attempts: 3, pr: 7 })],
  ["failAttempt released", failAttempt(held), [rec({ state: "released" })], "precondition"],
  // failClaimed: failAttempt from claimed only
  ["failClaimed claimed, attempts 1", failClaimed(held), [rec({ attempts: 1 })], by(ALICE, NOW, { state: "released", attempts: 2 }), `failAttempt ${U}`],
  ["failClaimed claimed, attempts 2", failClaimed(held), [rec({ attempts: 2 })], by(ALICE, NOW, { state: "parked", attempts: 3, park: blocked("attempts-cap") }), `failAttempt ${U}`],
  ["failClaimed merging", failClaimed(held), [rec({ state: "merging", attempts: 2, pr: 7 })], "precondition"],
  ["failClaimed another holder", failClaimed(held), [rec({ owner: BOB.owner, host: BOB.host, lane: BOB.lane })], "precondition"],
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
  [
    "takeApproved clears enqueued_sha (only the taker's recorded enqueue sets it again) and keeps passed_sha",
    takeApproved({ unit: U, by: COORD, now: NOW, generation: 1, approvedSha: SHA_D }),
    [rec({ state: "parked", globs: ["src/**"], park: awaiting(["src/a.ts"]), pr: 7, head_sha: SHA_D, passed_sha: SHA_D, enqueued_sha: SHA_D })],
    by(COORD, NOW, { state: "merging", generation: 2, globs: ["src/a.ts"], approved_sha: SHA_D, pr: 7, head_sha: SHA_D, passed_sha: SHA_D }),
  ],
  ["takeApproved by a builder", takeApproved({ ...base, generation: 1, approvedSha: SHA_D }), [rec({ state: "parked", park: awaiting([]) })], "precondition"],
  ["takeApproved needs-approval", takeApproved({ unit: U, by: COORD, now: NOW, generation: 1, approvedSha: SHA_D }), [rec({ state: "parked", park: needs })], "precondition"],
  ["takeApproved wrong generation", takeApproved({ unit: U, by: COORD, now: NOW, generation: 3, approvedSha: SHA_D }), [rec({ state: "parked", park: awaiting([]) })], "precondition"],
  ["takeApproved a claimed unit", takeApproved({ unit: U, by: COORD, now: NOW, generation: 1, approvedSha: SHA_D }), [rec()], "precondition"],
  ["takeApproved bad sha", takeApproved({ unit: U, by: COORD, now: NOW, generation: 1, approvedSha: "nope" }), [rec({ state: "parked", park: awaiting([]) })], "invalid"],
  // takeApproved with a graph (Story 2.8): xarabot:graph held, approved_graph set, one graph change at a time
  [
    "takeApproved with a graph",
    takeApproved({ unit: U, by: COORD, now: NOW, generation: 1, approvedSha: SHA_D, approvedGraph: GH }),
    [rec({ state: "parked", globs: ["src/**"], park: posted(["src/a.ts"]), pr: 7 }), rec({ unit: "story:1.6", state: "parked", globs: ["xarabot:graph"], park: awaiting(["src/b.ts"]) })],
    by(COORD, NOW, { state: "merging", generation: 2, globs: ["src/a.ts", "xarabot:graph"], approved_sha: SHA_D, approved_graph: GH, pr: 7 }),
  ],
  // retro item 24: the approved graph must be the posted delta's
  ["takeApproved with a graph and no delta posted", takeApproved({ unit: U, by: COORD, now: NOW, generation: 1, approvedSha: SHA_D, approvedGraph: GH }), [rec({ state: "parked", park: awaiting(["src/a.ts"]), pr: 7 })], "precondition"],
  ["takeApproved with a graph other than the posted delta's", takeApproved({ unit: U, by: COORD, now: NOW, generation: 1, approvedSha: SHA_D, approvedGraph: GH }), [rec({ state: "parked", park: posted(["src/a.ts"], GH_2), pr: 7 })], "precondition"],
  [
    "takeApproved with no graph from a park with a posted delta",
    takeApproved({ unit: U, by: COORD, now: NOW, generation: 1, approvedSha: SHA_D }),
    [rec({ state: "parked", park: posted(["src/a.ts"]), pr: 7 })],
    by(COORD, NOW, { state: "merging", generation: 2, globs: ["src/a.ts"], approved_sha: SHA_D, pr: 7 }),
  ],
  ["takeApproved with a graph beside a merging graph change", takeApproved({ unit: U, by: COORD, now: NOW, generation: 1, approvedSha: SHA_D, approvedGraph: GH }), [rec({ state: "parked", park: posted(["src/a.ts"]) }), by(COORD, T0, { unit: "story:1.6", state: "merging", globs: ["src/b.ts", "xarabot:graph"], approved_graph: GH })], "precondition"],
  ["takeApproved with a graph beside a claimed graph planning unit", takeApproved({ unit: U, by: COORD, now: NOW, generation: 1, approvedSha: SHA_D, approvedGraph: GH }), [rec({ state: "parked", park: posted(["src/a.ts"]) }), by(COORD, T0, { unit: "planning:graph.2", globs: ["stories/*.md", "xarabot:graph"] })], "precondition"],
  // reparkGraph (retro item 24): parked -> parked with a new posted delta, in the Maintainer's inbox, enqueued_sha at the head
  [
    "reparkGraph a builder's park",
    reparkGraph({ unit: U, by: COORD, now: NOW, generation: 1, graphPosted: GH, inboxOwner: "edanisko" }),
    [rec({ state: "parked", globs: ["src/**"], park: awaiting(["src/a.ts"]), pr: 7, pr_owner: "alice", head_sha: SHA_A, passed_sha: SHA_A })],
    by(COORD, NOW, { state: "parked", globs: ["src/**"], park: posted(["src/a.ts"], GH, "edanisko"), pr: 7, pr_owner: "alice", head_sha: SHA_A, passed_sha: SHA_A, enqueued_sha: SHA_A }),
  ],
  [
    "reparkGraph a park with another posted delta",
    reparkGraph({ unit: U, by: COORD_2, now: NOW, generation: 3, graphPosted: GH_2, inboxOwner: "edanisko" }),
    [by(COORD, T0, { state: "parked", generation: 3, park: posted(["src/a.ts"], GH, "edanisko"), pr: 7, head_sha: SHA_A, enqueued_sha: SHA_B })],
    by(COORD_2, NOW, { state: "parked", generation: 3, park: posted(["src/a.ts"], GH_2, "edanisko"), pr: 7, head_sha: SHA_A, enqueued_sha: SHA_A }),
  ],
  ["reparkGraph by a builder", reparkGraph({ unit: U, by: ALICE, now: NOW, generation: 1, graphPosted: GH, inboxOwner: "edanisko" }), [rec({ state: "parked", park: awaiting(["src/a.ts"]), pr: 7, head_sha: SHA_A })], "precondition"],
  ["reparkGraph wrong generation", reparkGraph({ unit: U, by: COORD, now: NOW, generation: 2, graphPosted: GH, inboxOwner: "edanisko" }), [rec({ state: "parked", park: awaiting(["src/a.ts"]), pr: 7, head_sha: SHA_A })], "precondition"],
  ["reparkGraph a blocked park", reparkGraph({ unit: U, by: COORD, now: NOW, generation: 1, graphPosted: GH, inboxOwner: "edanisko" }), [rec({ state: "parked", park: blocked("other"), pr: 7, head_sha: SHA_A })], "precondition"],
  ["reparkGraph a merging record", reparkGraph({ unit: U, by: COORD, now: NOW, generation: 1, graphPosted: GH, inboxOwner: "edanisko" }), [rec({ state: "merging", pr: 7, head_sha: SHA_A })], "precondition"],
  ["reparkGraph with no head", reparkGraph({ unit: U, by: COORD, now: NOW, generation: 1, graphPosted: GH, inboxOwner: "edanisko" }), [rec({ state: "parked", park: awaiting(["src/a.ts"]), pr: 7 })], "precondition"],
  ["reparkGraph with no record", reparkGraph({ unit: U, by: COORD, now: NOW, generation: 1, graphPosted: GH, inboxOwner: "edanisko" }), [], "precondition"],
  ["reparkGraph with a bad hash", reparkGraph({ unit: U, by: COORD, now: NOW, generation: 1, graphPosted: "sha256:xyz", inboxOwner: "edanisko" }), [rec({ state: "parked", park: awaiting(["src/a.ts"]), pr: 7, head_sha: SHA_A })], "invalid"],
  // park with a posted graph delta (retro item 24)
  [
    "park coordinator-held merging awaiting-approval with a posted graph delta",
    park({ ...held, by: COORD, generation: 2, kind: "awaiting-approval", diffPaths: ["src/a.ts"], inboxOwner: "edanisko", enqueuedSha: SHA_A, graphPosted: GH }),
    [by(COORD, T0, { state: "merging", generation: 2, globs: ["src/a.ts", "xarabot:graph"], pr: 7, approved_sha: SHA_A, approved_graph: GH })],
    by(COORD, NOW, { state: "parked", generation: 2, globs: ["src/a.ts", "xarabot:graph"], pr: 7, enqueued_sha: SHA_A, park: posted(["src/a.ts"], GH, "edanisko") }),
  ],
  ["park blocked with a posted graph delta", park({ ...held, kind: "blocked", reason: "other", graphPosted: GH }), [rec()], "invalid"],
  ["park with a bad graph hash", park({ ...held, kind: "awaiting-approval", diffPaths: ["src/a.ts"], graphPosted: "sha256:xyz" }), [rec()], "invalid"],
  [
    "takeApproved with no graph beside a merging graph change",
    takeApproved({ unit: U, by: COORD, now: NOW, generation: 1, approvedSha: SHA_D }),
    [rec({ state: "parked", park: awaiting(["src/a.ts"]), pr: 7 }), by(COORD, T0, { unit: "story:1.6", state: "merging", globs: ["xarabot:graph"] })],
    by(COORD, NOW, { state: "merging", generation: 2, globs: ["src/a.ts"], approved_sha: SHA_D, pr: 7 }),
  ],
  ["takeApproved with a bad graph hash", takeApproved({ unit: U, by: COORD, now: NOW, generation: 1, approvedSha: SHA_D, approvedGraph: "sha256:xyz" }), [rec({ state: "parked", park: awaiting([]) })], "invalid"],
  // every move that clears approved_sha clears approved_graph (Story 2.8)
  [
    "claim released clears approved_graph",
    claim({ ...base, globs: ["src/core/ledger/**"], expectGeneration: 2 }),
    [by(COORD, T0, { state: "released", generation: 2, approved_sha: SHA_A, approved_graph: GH, passed_sha: SHA_A })],
    by(ALICE, NOW, { generation: 3 }),
  ],
  [
    "takeOverStale claimed clears approved_graph",
    takeOverStale({ unit: U, by: BOB, now: LATE, generation: 1 }),
    [rec({ approved_sha: SHA_A, approved_graph: GH })],
    by(BOB, LATE, { generation: 2, attempts: 1 }),
  ],
  [
    "park coordinator-held merging awaiting-approval clears approved_graph",
    park({ ...held, by: COORD, generation: 2, kind: "awaiting-approval", diffPaths: ["src/a.ts"], inboxOwner: "edanisko" }),
    [by(COORD, T0, { state: "merging", generation: 2, globs: ["src/a.ts", "xarabot:graph"], pr: 7, approved_sha: SHA_A, approved_graph: GH })],
    by(COORD, NOW, { state: "parked", generation: 2, globs: ["src/a.ts", "xarabot:graph"], pr: 7, park: { ...awaiting(["src/a.ts"]), inbox_owner: "edanisko" } }),
  ],
  [
    "park coordinator-held merging blocked graph-invalid",
    park({ ...held, by: COORD_2, generation: 2, kind: "blocked", reason: "graph-invalid", inboxOwner: "alice" }),
    [by(COORD, T0, { state: "merging", generation: 2, globs: ["src/a.ts", "xarabot:graph"], pr: 7, approved_sha: SHA_A, approved_graph: GH })],
    by(COORD_2, NOW, { state: "parked", generation: 2, globs: ["src/a.ts", "xarabot:graph"], pr: 7, park: blocked("graph-invalid") }),
  ],
  ["park builder-held merging blocked graph-invalid", park({ ...held, kind: "blocked", reason: "graph-invalid" }), [rec({ state: "merging", pr: 7 })], "precondition"],
  [
    "applyRuling rebuild clears approved_graph",
    applyRuling({ unit: U, by: COORD, now: NOW, generation: 1, ruling: "rebuild" }),
    [rec({ state: "parked", park: blocked("graph-invalid"), approved_sha: SHA_A, approved_graph: GH })],
    by(COORD, NOW, { state: "released" }),
  ],
  [
    "applyRuling release keeps approved_graph",
    applyRuling({ unit: U, by: COORD, now: NOW, generation: 1, ruling: "release" }),
    [rec({ state: "parked", park: blocked("graph-invalid"), approved_sha: SHA_A, approved_graph: GH })],
    by(COORD, NOW, { state: "released", approved_sha: SHA_A, approved_graph: GH }),
  ],
  // applyRuling
  [
    "applyRuling release",
    applyRuling({ unit: U, by: COORD, now: NOW, generation: 1, ruling: "release" }),
    [rec({ state: "parked", park: blocked("attempts-cap"), attempts: 3, loopbacks: 2, ci_fixes: 1, passed_sha: SHA_A, builder_providers: ["anthropic"] })],
    by(COORD, NOW, { state: "released", passed_sha: SHA_A, builder_providers: ["anthropic"] }),
  ],
  [
    "applyRuling rebuild",
    applyRuling({ unit: U, by: COORD, now: NOW, generation: 1, ruling: "rebuild" }),
    [rec({ state: "parked", park: blocked("review-cap"), attempts: 1, loopbacks: 2, reviewed_sha: SHA_A, passed_sha: SHA_A, enqueued_sha: SHA_A, approved_sha: SHA_A, builder_providers: ["anthropic"], pr: 7 })],
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
  [
    "applyRuling by a builder",
    applyRuling({ unit: U, by: BOB, now: NOW, generation: 1, ruling: "release" }),
    [rec({ state: "parked", park: blocked("other"), attempts: 2, loopbacks: 1, ci_fixes: 1, builder_providers: ["anthropic"] })],
    by(BOB, NOW, { state: "released", builder_providers: ["anthropic"] }),
  ],
  ...(
    [
      ["blocked", blocked("write-check")],
      ["awaiting-approval", awaiting(["src/a.ts"])],
      ["needs-approval", needs],
    ] as const
  ).map(
    ([name, park]): Case => [
      `applyRuling rebuild from ${name}`,
      applyRuling({ unit: U, by: BOB, now: NOW, generation: 2, ruling: "rebuild" }),
      [
        rec({
          state: "parked",
          generation: 2,
          park,
          attempts: 2,
          loopbacks: 1,
          ci_fixes: 1,
          reviewed_sha: SHA_A,
          passed_sha: SHA_B,
          approved_sha: SHA_D,
          builder_providers: ["anthropic"],
          pr: 7,
        }),
      ],
      by(BOB, NOW, { state: "released", generation: 2, pr: 7 }),
    ],
  ),
  ["applyRuling wrong generation", applyRuling({ unit: U, by: COORD, now: NOW, generation: 2, ruling: "release" }), [rec({ state: "parked", park: needs })], "precondition"],
  ...(["claimed", "merging", "released", "merged"] as const).flatMap((state) =>
    (["release", "rebuild"] as const).map(
      (ruling): Case => [
        `applyRuling ${ruling} on a ${state} unit`,
        applyRuling({ unit: U, by: BOB, now: NOW, generation: 1, ruling }),
        [rec({ state })],
        "precondition",
      ],
    ),
  ),
  ["applyRuling release with no record", applyRuling({ unit: U, by: BOB, now: NOW, generation: 1, ruling: "release" }), [], "precondition"],
  ["applyRuling rebuild with no record", applyRuling({ unit: U, by: BOB, now: NOW, generation: 1, ruling: "rebuild" }), [], "precondition"],
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

  test.each([
    ["10 min old", NOW, false],
    ["1 ms short of 30 min", "2026-10-22T10:29:59.999Z", false],
    ["exactly 30 min", LATE, true],
    ["a year old", "2027-10-22T10:00:00Z", true],
    ["stamped after now (skew)", "2026-10-22T09:00:00Z", false],
  ] as const)("isStale: a heartbeat at T0, now %s → %p", (_name, now, stale) => {
    expect(isStale(rec(), now)).toBe(stale);
  });

  test("caps", () => {
    expect(ATTEMPTS_CAP).toBe(3);
    expect(STALE_AFTER_MS).toBe(30 * 60 * 1000);
  });

  const v2 = { "units/story__9.9.json": serializeUnitRecord(rec({ unit: "story:9.9" })).replace('"schema_version": 6', '"schema_version": 7') };
  const v0 = { "units/story__9.9.json": serializeUnitRecord(rec({ unit: "story:9.9" })).replace('"schema_version": 6', '"schema_version": 0') };
  const everyEdit: readonly [string, LedgerEdit][] = CASES.map(([name, edit]) => [name, edit]);
  for (const [name, edit] of everyEdit) {
    test(`${name}: a schema_version 7 or 0 record on the tip stops`, () => {
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

// ---------------------------------------------------------------- coordinator.json

function coordRec(who: LaneIdentity, at: string, over: Partial<CoordinatorRecord> = {}): CoordinatorRecord {
  return {
    schema_version: 6,
    owner: who.owner,
    host: who.host,
    lane: "coordinator",
    generation: 1,
    heartbeat_at: at,
    digest_posted_at: null,
    rulings_cursor: null,
    ...over,
  };
}

const coordTip = (c: CoordinatorRecord | null, records: readonly UnitRecord[] = []) =>
  tip(records, c === null ? {} : { [COORDINATOR_PATH]: serializeCoordinator(c) });

type CoordExpect = CoordinatorRecord | "precondition" | "invalid" | "stop";

function expectCoordinator(edit: LedgerEdit, files: Record<string, string>, want: CoordExpect, name: string): void {
  const r = edit(files);
  if (typeof want === "string") {
    expect(r.ok ? "ok" : r.error.kind).toBe(want);
    return;
  }
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  expect(r.value).toEqual({ message: `ledger: ${name} coordinator [skip ci]`, writes: { [COORDINATOR_PATH]: serializeCoordinator(want) }, deletes: [] });
}

describe("claimCoordinator", () => {
  const cursor = { digest_posted_at: "2026-10-22T08:00:00Z", rulings_cursor: "ruling-17" };
  test.each([
    ["no record: generation 1, no digest time, no cursor", COORD, null, coordRec(COORD, NOW)],
    ["same identity, live: re-stamped at the same generation", COORD, coordRec(COORD, T0, { generation: 3, ...cursor }), coordRec(COORD, NOW, { generation: 3, ...cursor })],
    ["same identity, stale: re-stamped at the same generation, not a takeover", COORD, coordRec(COORD, "2026-10-22T08:00:00Z", { generation: 3, ...cursor }), coordRec(COORD, NOW, { generation: 3, ...cursor })],
    ["another identity, stale (30 min): taken over at generation + 1, cursor kept", COORD_2, coordRec(COORD, "2026-10-22T09:40:00Z", { generation: 3, ...cursor }), coordRec(COORD_2, NOW, { generation: 4, ...cursor })],
    ["another identity, live: refused", COORD_2, coordRec(COORD, "2026-10-22T09:40:01Z"), "precondition"],
    ["the same owner and host on another lane name is another identity", { ...COORD, lane: "builder-1" }, null, "precondition"],
    ["a builder lane: refused", ALICE, null, "precondition"],
  ] as const)("%s", (_name, who, current, want) => {
    expectCoordinator(claimCoordinator({ by: who, now: NOW }), coordTip(current), want, "claimCoordinator");
  });

  test("the refusal names the holder and its heartbeat, and the unit records are untouched", () => {
    const r = claimCoordinator({ by: COORD_2, now: NOW })(coordTip(coordRec(COORD, T0), [rec()]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toContain(`${COORD.owner}/${COORD.host}/coordinator`);
      expect(r.error.message).toContain(T0);
    }
  });

  test("an invalid now or writer is invalid", () => {
    expect(claimCoordinator({ by: COORD, now: "yesterday" })({}).ok).toBe(false);
    const r = claimCoordinator({ by: { ...COORD, host: "nope" }, now: NOW })({});
    expect(r.ok ? "ok" : r.error.kind).toBe("invalid");
  });

  test("a schema_version 7 coordinator.json stops", () => {
    const v2 = serializeCoordinator(coordRec(COORD, T0)).replace('"schema_version": 6', '"schema_version": 7');
    const r = claimCoordinator({ by: COORD, now: NOW })({ [COORDINATOR_PATH]: v2 });
    expect(r.ok ? "ok" : r.error.kind).toBe("stop");
  });
});

describe("keepCoordinator", () => {
  test.each([
    ["held at the generation: heartbeat_at only", COORD, 2, coordRec(COORD, T0, { generation: 2, rulings_cursor: "r" }), coordRec(COORD, NOW, { generation: 2, rulings_cursor: "r" })],
    ["held but stale: still beats", COORD, 1, coordRec(COORD, "2026-10-22T08:00:00Z"), coordRec(COORD, NOW)],
    ["the wrong generation: lost", COORD, 1, coordRec(COORD, T0, { generation: 2 }), "precondition"],
    ["another identity: lost", COORD, 1, coordRec(COORD_2, T0), "precondition"],
    ["no record: lost", COORD, 1, null, "precondition"],
    ["a builder lane: refused", ALICE, 1, coordRec(COORD, T0), "precondition"],
    ["generation 0: invalid", COORD, 0, coordRec(COORD, T0), "invalid"],
  ] as const)("%s", (_name, who, generation, current, want) => {
    expectCoordinator(keepCoordinator({ by: who, now: NOW, generation }), coordTip(current), want, "keepCoordinator");
  });
});

describe("stampDigest (Story 4.2)", () => {
  const SLOT = "2026-10-22T08:00:00.000Z";
  test.each([
    ["never posted: stamped now, nothing else changes", COORD, 2, coordRec(COORD, T0, { generation: 2, rulings_cursor: "r" }), coordRec(COORD, T0, { generation: 2, rulings_cursor: "r", digest_posted_at: NOW })],
    ["posted yesterday: stamped", COORD, 1, coordRec(COORD, T0, { digest_posted_at: "2026-10-21T08:00:00Z" }), coordRec(COORD, T0, { digest_posted_at: NOW })],
    ["posted just before the slot: stamped", COORD, 1, coordRec(COORD, T0, { digest_posted_at: "2026-10-22T07:59:59Z" }), coordRec(COORD, T0, { digest_posted_at: NOW })],
    ["posted at the slot: refused", COORD, 1, coordRec(COORD, T0, { digest_posted_at: "2026-10-22T08:00:00Z" }), "precondition"],
    ["posted after the slot: refused", COORD, 1, coordRec(COORD, T0, { digest_posted_at: "2026-10-22T09:00:00Z" }), "precondition"],
    ["the wrong generation: refused", COORD, 1, coordRec(COORD, T0, { generation: 2 }), "precondition"],
    ["another identity holds it: refused", COORD, 1, coordRec(COORD_2, T0), "precondition"],
    ["no record: refused", COORD, 1, null, "precondition"],
    ["a builder lane: refused", ALICE, 1, coordRec(COORD, T0), "precondition"],
    ["generation 0: invalid", COORD, 0, coordRec(COORD, T0), "invalid"],
  ] as const)("%s", (_name, who, generation, current, want) => {
    expectCoordinator(stampDigest({ by: who, now: NOW, generation, slot: SLOT }), coordTip(current), want, "stampDigest");
  });

  test("an older record is written at the current schema_version", () => {
    expectCoordinator(stampDigest({ by: COORD, now: NOW, generation: 1, slot: SLOT }), coordTip(coordRec(COORD, T0, { schema_version: 2 })), coordRec(COORD, T0, { digest_posted_at: NOW }), "stampDigest");
  });

  test("a bad slot is invalid", () => {
    const r = stampDigest({ by: COORD, now: NOW, generation: 1, slot: "today" })(coordTip(coordRec(COORD, T0)));
    expect(r.ok ? "ok" : r.error.kind).toBe("invalid");
  });

  test("fenced on the run's own record: a lost unit refuses the stamp", () => {
    const own = by(COORD, T0, { unit: "reconcile:5", globs: [] });
    const files = coordTip(coordRec(COORD, T0), [own]);
    const stamp = stampDigest({ by: COORD, now: NOW, generation: 1, slot: SLOT });
    const ok = fenced(heartbeat({ unit: "reconcile:5", by: COORD, now: NOW, generation: 1 }), stamp)(files);
    expect(ok.ok && ok.value !== null ? Object.keys(ok.value.writes).sort() : []).toEqual([COORDINATOR_PATH, "units/reconcile__5.json"]);
    const lost = fenced(heartbeat({ unit: "reconcile:5", by: COORD, now: NOW, generation: 2 }), stamp)(files);
    expect(lost.ok ? "ok" : lost.error.kind).toBe("precondition");
  });
});

describe("park text (Story 4.2)", () => {
  const parkedWith = (text: string | undefined) =>
    park({ ...held, kind: "blocked", reason: "intent-gap", ...(text !== undefined ? { text } : {}) })(tip([rec()]));
  const written = (r: ReturnType<ReturnType<typeof park>>) => (r.ok && r.value !== null ? (JSON.parse(r.value.writes[PATH] as string) as UnitRecord) : null);

  test("a blocked park keeps its text, and the record is v6", () => {
    const r = written(parkedWith("Which inbox owns graph PRs?"));
    expect(r?.schema_version).toBe(6);
    expect(r?.park).toEqual({ ...blocked("intent-gap"), text: "Which inbox owns graph PRs?" });
  });

  test("no text, or an empty one: no text key", () => {
    expect(Object.keys(written(parkedWith(undefined))?.park ?? {})).toEqual(["kind", "reason", "inbox_owner", "globs_held"]);
    expect(Object.keys(written(parkedWith(""))?.park ?? {})).toEqual(["kind", "reason", "inbox_owner", "globs_held"]);
  });

  test("a text over PARK_TEXT_MAX is invalid", () => {
    const r = parkedWith("x".repeat(PARK_TEXT_MAX + 1));
    expect(r.ok ? "ok" : r.error.kind).toBe("invalid");
    expect(written(parkedWith("x".repeat(PARK_TEXT_MAX)))?.park?.text).toHaveLength(PARK_TEXT_MAX);
  });

  test.each([
    ["plain text is kept, trimmed", "  Ask first.\n", "Ask first."],
    ["an @mention loses its @", "Ask @bob first.", "Ask bob first."],
    ["a closing keyword is dropped", "Blocked, see fixes #12 here.", "Blocked, see here."],
    ["blank: nothing", " \n ", undefined],
  ] as const)("parkText: %s", (_name, text, want) => {
    expect(parkText(text)).toBe(want);
  });

  test("parkText redacts the lane's secrets and token-shaped strings, then caps at PARK_TEXT_MAX", () => {
    const secret = "lane-secret-value-123";
    const token = "gh" + "p_" + "a".repeat(36);
    expect(parkText(`uses ${secret} and ${token}`, [secret])).toBe(`uses ${REDACTED} and ${REDACTED}`);
    const long = parkText("y".repeat(PARK_TEXT_MAX * 2)) ?? "";
    expect(long.length).toBe(PARK_TEXT_MAX);
    expect(long.endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});

describe("reconcile record edits", () => {
  const R = "reconcile:3";
  const R_PATH = "units/reconcile__3.json";
  /** A `reconcile:3` record held by `who`. */
  const rr = (over: Partial<UnitRecord> = {}, who: LaneIdentity = COORD): UnitRecord =>
    by(who, T0, { unit: R, globs: [], pr: 9, pr_owner: "carol", head_sha: SHA_A, base_sha: SHA_B, ...over });
  const at = (now: string, generation = 1) => ({ unit: R, by: COORD, now, generation });

  type Want = UnitRecord | "deleted" | "null" | "invalid" | "precondition";
  const cases: readonly (readonly [string, LedgerEdit, readonly UnitRecord[], Want, string])[] = [
    // releaseDisposable: merging -> released, no attempt
    ["releaseDisposable: merging, held by this coordinator", releaseDisposable(at(NOW, 2)), [rr({ state: "merging", generation: 2, passed_sha: SHA_A, attempts: 1 })], by(COORD, NOW, { unit: R, globs: [], state: "released", generation: 2, pr: 9, pr_owner: "carol", head_sha: SHA_A, base_sha: SHA_B, passed_sha: SHA_A, attempts: 1 }), "releaseDisposable"],
    ["releaseDisposable: merging, held by another coordinator identity", releaseDisposable(at(NOW)), [rr({ state: "merging", passed_sha: SHA_A }, COORD_2)], by(COORD, NOW, { unit: R, globs: [], state: "released", pr: 9, pr_owner: "carol", head_sha: SHA_A, base_sha: SHA_B, passed_sha: SHA_A }), "releaseDisposable"],
    ["releaseDisposable: a builder writer", releaseDisposable({ ...at(NOW), by: ALICE }), [rr({ state: "merging" })], "precondition", "releaseDisposable"],
    ["releaseDisposable: a Story unit", releaseDisposable({ ...at(NOW), unit: U }), [rec({ state: "merging" })], "invalid", "releaseDisposable"],
    ["releaseDisposable: the wrong generation", releaseDisposable(at(NOW, 2)), [rr({ state: "merging" })], "precondition", "releaseDisposable"],
    ["releaseDisposable: claimed, not merging", releaseDisposable(at(NOW)), [rr()], "precondition", "releaseDisposable"],
    ["releaseDisposable: a holder that is not a coordinator lane", releaseDisposable(at(NOW)), [rr({ state: "merging" }, ALICE)], "precondition", "releaseDisposable"],
    ["releaseDisposable: no record", releaseDisposable(at(NOW)), [], "precondition", "releaseDisposable"],
    // releaseDeadReconcile: stale claimed -> released, attempts + 1
    ["releaseDeadReconcile: stale claimed", releaseDeadReconcile(at(LATE)), [rr({ attempts: 1 }, COORD_2)], by(COORD, LATE, { unit: R, globs: [], state: "released", pr: 9, pr_owner: "carol", head_sha: SHA_A, base_sha: SHA_B, attempts: 2 }), "releaseDeadReconcile"],
    ["releaseDeadReconcile: claimed but live", releaseDeadReconcile(at(NOW)), [rr()], "precondition", "releaseDeadReconcile"],
    ["releaseDeadReconcile: stale merging", releaseDeadReconcile(at(LATE)), [rr({ state: "merging" })], "precondition", "releaseDeadReconcile"],
    ["releaseDeadReconcile: the wrong generation", releaseDeadReconcile(at(LATE, 2)), [rr()], "precondition", "releaseDeadReconcile"],
    ["releaseDeadReconcile: a builder writer", releaseDeadReconcile({ ...at(LATE), by: ALICE }), [rr()], "precondition", "releaseDeadReconcile"],
    ["releaseDeadReconcile: a Story unit", releaseDeadReconcile({ ...at(LATE), unit: U }), [rec()], "invalid", "releaseDeadReconcile"],
    // deleteReleasedRecurring: released -> none
    ["deleteReleasedRecurring: released", deleteReleasedRecurring(at(NOW)), [rr({ state: "released" })], "deleted", "deleteReleasedRecurring"],
    ["deleteReleasedRecurring: already gone", deleteReleasedRecurring(at(NOW)), [], "null", "deleteReleasedRecurring"],
    ["deleteReleasedRecurring: merged", deleteReleasedRecurring(at(NOW)), [rr({ state: "merged" })], "precondition", "deleteReleasedRecurring"],
    ["deleteReleasedRecurring: parked", deleteReleasedRecurring(at(NOW)), [rr({ state: "parked", park: blocked("verification", "carol") })], "precondition", "deleteReleasedRecurring"],
    ["deleteReleasedRecurring: the wrong generation", deleteReleasedRecurring(at(NOW, 2)), [rr({ state: "released" })], "precondition", "deleteReleasedRecurring"],
    ["deleteReleasedRecurring: a builder writer", deleteReleasedRecurring({ ...at(NOW), by: ALICE }), [rr({ state: "released" })], "precondition", "deleteReleasedRecurring"],
    ["deleteReleasedRecurring: a Story unit", deleteReleasedRecurring({ ...at(NOW), unit: U }), [rec({ state: "released" })], "invalid", "deleteReleasedRecurring"],
  ];
  test.each(cases)("%s", (_name, edit, records, want, name) => {
    const r = edit(tip(records));
    if (want === "invalid" || want === "precondition") {
      expect(r.ok ? "ok" : r.error.kind).toBe(want);
      return;
    }
    if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
    if (want === "null") {
      expect(r.value).toBeNull();
      return;
    }
    if (want === "deleted") {
      expect(r.value).toEqual({ message: `ledger: ${name} ${R} [skip ci]`, writes: {}, deletes: [R_PATH] });
      return;
    }
    expect(r.value).toEqual({ message: `ledger: ${name} ${R} [skip ci]`, writes: { [R_PATH]: serializeUnitRecord(want) }, deletes: [] });
  });
});

describe("ungated retro records: an ejection is an attempt (Stories 2.9, 2.10)", () => {
  const RI = "retro-item:epic-2-retro-item-1-fix";
  const RI_PATH = "units/retro-item__epic-2-retro-item-1-fix.json";
  /** `retro-item:<id>` merging under `who`, queued by its own step with no approval. */
  const ri = (over: Partial<UnitRecord> = {}, who: LaneIdentity = COORD): UnitRecord =>
    by(who, T0, { unit: RI, globs: ["src/x/**"], state: "merging", pr: 9, pr_owner: "carol", head_sha: SHA_A, base_sha: SHA_B, passed_sha: SHA_A, ...over });
  const at = (over: Partial<{ unit: string; by: LaneIdentity; generation: number }> = {}) => ({ unit: RI, by: COORD, now: NOW, generation: 1, ...over });

  test.each([
    ["an ungated retro item", ri(), true],
    ["an ungated retro", by(COORD, T0, { unit: "retro:2", globs: [] }), true],
    ["a retro item taken on an approval", ri({ approved_sha: SHA_A }), false],
    ["a Story", rec(), false],
    ["a planning record", by(COORD, T0, { unit: "planning:graph.1", globs: [] }), false],
  ] as const)("isUngatedRetro: %s → %p", (_name, record, want) => {
    expect(isUngatedRetro(record)).toBe(want);
  });

  type Want = UnitRecord | "invalid" | "precondition";
  test.each([
    ["merging: released, attempts + 1, the PR kept", releaseEjected(at()), [ri({ attempts: 1 })], by(COORD, NOW, { unit: RI, globs: ["src/x/**"], state: "released", pr: 9, pr_owner: "carol", head_sha: SHA_A, base_sha: SHA_B, passed_sha: SHA_A, attempts: 2 })],
    ["merging at the cap: parked blocked attempts-cap", releaseEjected(at()), [ri({ attempts: 2 })], by(COORD, NOW, { unit: RI, globs: ["src/x/**"], state: "parked", pr: 9, pr_owner: "carol", head_sha: SHA_A, base_sha: SHA_B, passed_sha: SHA_A, attempts: 3, park: blocked("attempts-cap", "carol") })],
    ["held by another coordinator identity", releaseEjected(at()), [ri({}, COORD_2)], by(COORD, NOW, { unit: RI, globs: ["src/x/**"], state: "released", pr: 9, pr_owner: "carol", head_sha: SHA_A, base_sha: SHA_B, passed_sha: SHA_A, attempts: 1 })],
    ["taken on an approval", releaseEjected(at()), [ri({ approved_sha: SHA_A })], "precondition"],
    ["claimed, not merging", releaseEjected(at()), [ri({ state: "claimed" })], "precondition"],
    ["the wrong generation", releaseEjected(at({ generation: 2 })), [ri()], "precondition"],
    ["a builder writer", releaseEjected(at({ by: ALICE })), [ri()], "precondition"],
    ["a holder that is not a coordinator lane", releaseEjected(at()), [ri({}, ALICE)], "precondition"],
    ["no record", releaseEjected(at()), [], "precondition"],
    ["a Story unit", releaseEjected(at({ unit: U })), [rec({ state: "merging" })], "invalid"],
  ] as readonly (readonly [string, LedgerEdit, readonly UnitRecord[], Want])[])("releaseEjected: %s", (_name, edit, records, want) => {
    const r = edit(tip(records));
    if (want === "invalid" || want === "precondition") {
      expect(r.ok ? "ok" : r.error.kind).toBe(want);
      return;
    }
    expect(r.ok && r.value).toEqual({ message: `ledger: releaseEjected ${RI} [skip ci]`, writes: { [RI_PATH]: serializeUnitRecord(want) }, deletes: [] });
  });

  test("releaseEjected releases an ungated retro too", () => {
    const r = releaseEjected({ unit: "retro:2", by: COORD, now: NOW, generation: 1 })(tip([by(COORD, T0, { unit: "retro:2", globs: [], state: "merging", pr: 9, passed_sha: SHA_A })]));
    expect(r.ok ? r.value?.message : r.error.message).toBe("ledger: releaseEjected retro:2 [skip ci]");
  });
});

describe("planning records: disposable and recurring (Story 2.7)", () => {
  const STATUS_GLOBS = ["_bmad-output/implementation-artifacts/sprint-status.yaml"];
  const GRAPH_GLOBS = ["_bmad-output/planning-artifacts/epics.md", "xarabot:graph"];
  const pl = (unit: string, over: Partial<UnitRecord> = {}): UnitRecord =>
    by(COORD, T0, { unit, globs: unit.includes("graph") ? GRAPH_GLOBS : STATUS_GLOBS, pr: 9, pr_owner: "carol", head_sha: SHA_A, base_sha: SHA_B, ...over });
  const path = (unit: string) => `units/${unit.replace(":", "__")}.json`;

  test.each([
    ["a reconcile record", by(COORD, T0, { unit: "reconcile:3", globs: [] }), true],
    ["a reconcile record taken on approval", by(COORD, T0, { unit: "reconcile:3", globs: [], approved_sha: SHA_A }), true],
    ["an ungated status planning record", pl("planning:status.2"), true],
    ["a status planning record taken on approval", pl("planning:status.2", { approved_sha: SHA_A }), false],
    ["a graph planning record", pl("planning:graph.1"), false],
    ["another slug holding xarabot:graph", pl("planning:sprint.1", { globs: GRAPH_GLOBS }), false],
    ["another slug without it", pl("planning:sprint.1"), true],
    ["a Story", rec(), false],
  ] as const)("isDisposable: %s → %p", (_name, record, want) => {
    expect(isDisposable(record)).toBe(want);
  });

  test("releaseDisposable: an ungated merging status planning record is released, no attempt, its PR kept", () => {
    const u = "planning:status.2";
    const r = releaseDisposable({ unit: u, by: COORD, now: NOW, generation: 1 })(tip([pl(u, { state: "merging", passed_sha: SHA_A })]));
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value).toEqual({
      message: `ledger: releaseDisposable ${u} [skip ci]`,
      writes: { [path(u)]: serializeUnitRecord(pl(u, { state: "released", passed_sha: SHA_A, heartbeat_at: NOW })) },
      deletes: [],
    });
  });

  test.each([
    ["a graph planning record", "planning:graph.1", {}],
    ["a status planning record taken on approval", "planning:status.2", { approved_sha: SHA_A }],
  ] as const)("releaseDisposable refuses %s", (_name, u, over) => {
    const r = releaseDisposable({ unit: u, by: COORD, now: NOW, generation: 1 })(tip([pl(u, { state: "merging", passed_sha: SHA_A, ...over })]));
    expect(r.ok ? "ok" : r.error.kind).toBe("precondition");
  });

  test.each(["planning:status.2", "planning:graph.1"])("deleteReleasedRecurring deletes a released %s", (u) => {
    const r = deleteReleasedRecurring({ unit: u, by: COORD, now: NOW, generation: 1 })(tip([pl(u, { state: "released" })]));
    expect(r.ok && r.value).toEqual({ message: `ledger: deleteReleasedRecurring ${u} [skip ci]`, writes: {}, deletes: [path(u)] });
  });

  test("every record an edit writes carries schema_version 6, whatever the tip held", () => {
    const v1 = rec({ schema_version: 1, state: "claimed" });
    const r = heartbeat({ unit: U, by: ALICE, now: NOW, generation: 1 })(tip([v1]));
    if (!r.ok || r.value === null) throw new Error("expected a write");
    expect(JSON.parse(r.value.writes[PATH] as string).schema_version).toBe(6);
    const c = claim({ unit: "story:7.1", by: ALICE, now: NOW, globs: ["src/7/**"], expectGeneration: null })(tip([v1]));
    if (!c.ok || c.value === null) throw new Error("expected a write");
    expect(JSON.parse(c.value.writes["units/story__7.1.json"] as string).schema_version).toBe(6);
  });

  test("an edit over a raw v4 record (no enqueued_sha key, passed_sha set) writes v6 with enqueued_sha the old passed_sha and passed_sha null", () => {
    const raw = JSON.parse(serializeUnitRecord(rec({ pr: 7, head_sha: SHA_A, passed_sha: SHA_A }))) as Record<string, unknown>;
    raw["schema_version"] = 4;
    delete raw["enqueued_sha"];
    const r = heartbeat(held)({ [PATH]: JSON.stringify(raw) });
    if (!r.ok || r.value === null) throw new Error("expected a write");
    expect(JSON.parse(r.value.writes[PATH] as string)).toMatchObject({ schema_version: 6, passed_sha: null, enqueued_sha: SHA_A, head_sha: SHA_A });
  });

  test("coordinator.json writes carry schema_version 6: a claim over a v1 record, and the keeper's beat", () => {
    const v1 = serializeCoordinator(coordRec(COORD, T0, { schema_version: 1 }));
    const claimed = claimCoordinator({ by: COORD, now: NOW })({ [COORDINATOR_PATH]: v1 });
    if (!claimed.ok || claimed.value === null) throw new Error("expected a write");
    expect(JSON.parse(claimed.value.writes[COORDINATOR_PATH] as string).schema_version).toBe(6);
    const kept = keepCoordinator({ by: COORD, now: NOW, generation: 1 })({ [COORDINATOR_PATH]: v1 });
    if (!kept.ok || kept.value === null) throw new Error("expected a write");
    expect(JSON.parse(kept.value.writes[COORDINATOR_PATH] as string).schema_version).toBe(6);
  });
});

describe("fenced", () => {
  const own = by(COORD, T0, { unit: "reconcile:5", globs: [] });
  const fence = (generation = 1) => heartbeat({ unit: "reconcile:5", by: COORD, now: NOW, generation });
  const ownPath = "units/reconcile__5.json";
  const beaten = serializeUnitRecord({ ...own, heartbeat_at: NOW });

  test("the fence and the item in one commit, under the item's message", () => {
    const r = fenced(fence(), markMerged({ unit: U, by: COORD, now: NOW }))(tip([own, rec({ state: "parked", park: blocked("other") })]));
    expect(r.ok && r.value).toEqual({
      message: `ledger: markMerged ${U} [skip ci]`,
      writes: { [ownPath]: beaten, [PATH]: serializeUnitRecord(by(COORD, NOW, { state: "merged" })) },
      deletes: [],
    });
  });

  test("a deleting item: the fence written, the item's record deleted", () => {
    const r = fenced(fence(), deleteMerged({ unit: U, by: COORD, now: NOW }))(tip([own, rec({ state: "merged" })]));
    expect(r.ok && r.value).toEqual({ message: `ledger: deleteMerged ${U} [skip ci]`, writes: { [ownPath]: beaten }, deletes: [PATH] });
  });

  test("a lost fence refuses the item", () => {
    const r = fenced(fence(2), markMerged({ unit: U, by: COORD, now: NOW }))(tip([own, rec({ state: "parked", park: blocked("other") })]));
    expect(r.ok ? "ok" : r.error.kind).toBe("precondition");
  });

  test("a refused item writes nothing", () => {
    const r = fenced(fence(), deleteMerged({ unit: U, by: COORD, now: NOW }))(tip([own, rec({ state: "released" })]));
    expect(r.ok ? "ok" : r.error.kind).toBe("precondition");
  });

  test("an item already done writes nothing, not even the fence", () => {
    const r = fenced(fence(), deleteMerged({ unit: U, by: COORD, now: NOW }))(tip([own]));
    expect(r.ok && r.value).toBeNull();
  });
});

describe("coordinatorClaimState", () => {
  test.each([
    ["no record", null, "missing"],
    ["10 min old", coordRec(COORD, T0), "live"],
    ["exactly 30 min old", coordRec(COORD, "2026-10-22T09:40:00Z"), "expired"],
  ] as const)("%s → %s", (_name, record, want) => {
    expect(coordinatorClaimState(record, NOW)).toBe(want);
  });
});

describe("retro_result (Story 2.9)", () => {
  const R = "retro:2";
  const RP = "units/retro__2.json";
  const RESULT = { verdict: "accepted-with-open-items" as const, items: [{ id: "epic-2-retro-item-1-fix", text: "Fix it", route: "lane" as const, blocking: true, globs: ["src/x/**"] }] };
  const adopt = { pr: 9, pr_owner: "carol", head_sha: SHA_A, base_sha: SHA_B };
  /** The PR adopted at a head that moved past the one its result was validated at. */
  const moved = { ...adopt, head_sha: SHA_D };
  const retro = (over: Partial<UnitRecord> = {}) => by(COORD, T0, { unit: R, globs: ["src/r/**"], retro_result: RESULT, pr: 9, pr_owner: "carol", head_sha: SHA_A, ...over });
  const written = (r: ReturnType<LedgerEdit>): UnitRecord => {
    if (!r.ok || r.value === null) throw new Error(r.ok ? "no write" : r.error.message);
    return JSON.parse(r.value.writes[RP] as string) as UnitRecord;
  };

  test("a heartbeat records retro_result with the PR fields", () => {
    const r = heartbeat({ unit: R, by: COORD, now: NOW, generation: 1, set: { pr: 9, retro_result: RESULT } })(tip([retro({ retro_result: null, pr: null })]));
    expect(written(r)).toMatchObject({ pr: 9, retro_result: RESULT, schema_version: 6 });
  });

  test("a heartbeat with an invalid retro_result is invalid", () => {
    const bad = { ...RESULT, items: [{ ...RESULT.items[0], id: "nope" }] };
    const r = heartbeat({ unit: R, by: COORD, now: NOW, generation: 1, set: { retro_result: bad as never } })(tip([retro()]));
    expect(r.ok ? "ok" : r.error.kind).toBe("invalid");
  });

  test.each([
    ["claim from released adopting the PR keeps it", () => claim({ unit: R, by: COORD, now: NOW, globs: ["src/r/**"], expectGeneration: 1, adoptPr: adopt }), retro({ state: "released" }), RESULT],
    ["claim from released with no PR clears it", () => claim({ unit: R, by: COORD, now: NOW, globs: ["src/r/**"], expectGeneration: 1, baseSha: SHA_B }), retro({ state: "released" }), null],
    ["a claimed takeover adopting the PR keeps it", () => takeOverStale({ unit: R, by: COORD_2, now: LATE, generation: 1, adoptPr: adopt }), retro(), RESULT],
    ["a claimed takeover with no PR clears it", () => takeOverStale({ unit: R, by: COORD_2, now: LATE, generation: 1, baseSha: SHA_B }), retro(), null],
    ["claim from released adopting the PR at a moved head clears it (C1)", () => claim({ unit: R, by: COORD, now: NOW, globs: ["src/r/**"], expectGeneration: 1, adoptPr: moved }), retro({ state: "released" }), null],
    [
      "claim from released adopting another PR at the same head clears it",
      () => claim({ unit: R, by: COORD, now: NOW, globs: ["src/r/**"], expectGeneration: 1, adoptPr: { ...adopt, pr: 10 } }),
      retro({ state: "released" }),
      null,
    ],
    ["a claimed takeover adopting the PR at a moved head clears it (C1)", () => takeOverStale({ unit: R, by: COORD_2, now: LATE, generation: 1, adoptPr: moved }), retro(), null],
    [
      "a merging takeover at a moved queue head clears it",
      () => takeOverStale({ unit: R, by: BOB, now: LATE, generation: 1, stillQueued: true, adoptPr: moved }),
      retro({ ...BOB, state: "merging", passed_sha: SHA_A }),
      null,
    ],
    [
      "a merging takeover at the same queue head keeps it",
      () => takeOverStale({ unit: R, by: BOB, now: LATE, generation: 1, stillQueued: true, adoptPr: adopt }),
      retro({ ...BOB, state: "merging", passed_sha: SHA_A }),
      RESULT,
    ],
    ["a heartbeat that keeps the PR and head keeps it", () => heartbeat({ unit: R, by: COORD, now: NOW, generation: 1, set: { passed_sha: SHA_A } }), retro(), RESULT],
    ["a heartbeat re-recording the same head keeps it", () => heartbeat({ unit: R, by: COORD, now: NOW, generation: 1, set: { head_sha: SHA_A } }), retro(), RESULT],
    ["a heartbeat moving the head with no result clears it", () => heartbeat({ unit: R, by: COORD, now: NOW, generation: 1, set: { head_sha: SHA_D } }), retro(), null],
    ["a heartbeat moving the PR with no result clears it", () => heartbeat({ unit: R, by: COORD, now: NOW, generation: 1, set: { pr: 10 } }), retro(), null],
    [
      "a heartbeat moving the head with its re-checked result records it",
      () => heartbeat({ unit: R, by: COORD, now: NOW, generation: 1, set: { head_sha: SHA_D, retro_result: RESULT } }),
      retro(),
      RESULT,
    ],
    [
      "applyRuling release keeps it (the next claim adopts the PR)",
      () => applyRuling({ unit: R, by: COORD, now: NOW, generation: 1, ruling: "release" }),
      retro({ state: "parked", park: blocked("verification", "carol") }),
      RESULT,
    ],
    [
      "applyRuling rebuild clears it",
      () => applyRuling({ unit: R, by: COORD, now: NOW, generation: 1, ruling: "rebuild" }),
      retro({ state: "parked", park: blocked("verification", "carol") }),
      null,
    ],
    ["markMerged keeps it for reconcile", () => markMerged({ unit: R, by: COORD, now: NOW }), retro({ state: "merging", passed_sha: SHA_A }), RESULT],
    ["park keeps it", () => park({ unit: R, by: COORD, now: NOW, generation: 1, kind: "awaiting-approval", diffPaths: ["a.md"] }), retro({ state: "merging", passed_sha: SHA_A }), RESULT],
  ] as const)("%s", (_name, edit, record, want) => {
    expect(written(edit()(tip([record]))).retro_result).toEqual(want);
  });

  test("a new claim starts with none", () => {
    expect(written(claim({ unit: R, by: COORD, now: NOW, globs: ["src/r/**"], expectGeneration: null })({})).retro_result).toBeNull();
  });

  test("a retro record is never disposable", () => {
    expect(isDisposable(retro())).toBe(false);
    const r = releaseDisposable({ unit: R, by: COORD, now: NOW, generation: 1 })(tip([retro({ state: "merging", passed_sha: SHA_A })]));
    expect(r.ok ? "ok" : r.error.kind).toBe("invalid");
  });
});
