import { z } from "zod";
import { globsOverlap, normalizeGlob } from "../manifests/globs.ts";
import { err, ok, type Result } from "../result.ts";
import { describeIssues, GitHubLogin, IsoDateTime, NonEmpty, SCHEMA_VERSION } from "../schemas/common.ts";
import {
  GitSha,
  LaneIdentity,
  ParkReason,
  ParkSchema,
  unitKind,
  unitPath,
  UnitRecordSchema,
  type Park,
  type UnitRecord,
  type UnitState,
} from "../schemas/ledger.ts";
import { parseLedger, serializeUnitRecord, type Ledger } from "./codec.ts";
import { checkTransition } from "./transitions.ts";

/**
 * Pure ledger edits, one per edge of the state diagram (AR5, AR8). An edit is
 * a value over a tip: applied to the tip's files it parses the whole tip,
 * re-checks its preconditions there and returns the files to write and delete
 * with a `[skip ci]` message, `null` when the tip already holds the target,
 * or an error.
 */

/** The ledger files of one tip: `path → JSON text`. */
export type LedgerFiles = Readonly<Record<string, string>>;

/** What one edit writes to the ledger branch. */
export type LedgerCommit = {
  readonly message: string;
  readonly writes: Readonly<Record<string, string>>;
  readonly deletes: readonly string[];
};

export type LedgerEditErrorKind = "stop" | "invalid" | "precondition" | "illegal-transition";

export type LedgerEditResult = Result<LedgerCommit | null, LedgerEditErrorKind>;

/** An edit, re-applicable to any re-fetched tip. */
export type LedgerEdit = (files: LedgerFiles) => LedgerEditResult;

/** Failed attempts at which a unit parks, tested after the increment. */
export const ATTEMPTS_CAP = 3;

/** A record is stale once its heartbeat is this old. */
export const STALE_AFTER_MS = 30 * 60 * 1000;

/** Every edit's writer and time. `now` is the forge's server time. */
export type EditBase = {
  readonly unit: string;
  readonly by: LaneIdentity;
  readonly now: string;
};

/** An edit by the record's holder at its current generation. */
export type HeldParams = EditBase & { readonly generation: number };

type Change = { readonly to: UnitState; readonly record: UnitRecord } | { readonly to: "none" } | null;

type Ctx = {
  readonly ledger: Ledger;
  readonly current: UnitRecord | undefined;
  readonly unit: string;
  readonly by: LaneIdentity;
  readonly now: string;
};

type Step<T> = Result<T, LedgerEditErrorKind>;

const pre = (message: string) => err("precondition", message);
const bad = (message: string) => err("invalid", message);

function check<S extends z.ZodType>(label: string, schema: S, value: unknown): Step<z.infer<S>> {
  const r = schema.safeParse(value);
  return r.success ? ok(r.data) : bad(`${label}: ${describeIssues(r.error)}`);
}

const BaseSchema = z.strictObject({ by: LaneIdentity, now: IsoDateTime });
const Generation = z.int().min(1);
const Cap = z.int().min(1);

function makeEdit(name: string, base: EditBase, body: (ctx: Ctx) => Step<Change>): LedgerEdit {
  return (files) => {
    const ledger = parseLedger(files);
    if (!ledger.ok) return ledger;
    if (unitKind(base.unit) === undefined) return bad(`${name}: "${base.unit}" is not a unit id`);
    const params = check(name, BaseSchema, { by: base.by, now: base.now });
    if (!params.ok) return params;
    const ctx: Ctx = {
      ledger: ledger.value,
      current: ledger.value.units.get(base.unit),
      unit: base.unit,
      by: params.value.by,
      now: params.value.now,
    };
    const change = body(ctx);
    if (!change.ok) return change;
    if (change.value === null) return ok(null);
    const t = checkTransition(ctx.current?.state ?? "none", change.value.to);
    if (!t.ok) return t;
    const message = `ledger: ${name} ${base.unit} [skip ci]`;
    const path = unitPath(base.unit);
    if (change.value.to === "none") return ok({ message, writes: {}, deletes: [path] });
    const record = check(`${name} result`, UnitRecordSchema, change.value.record);
    if (!record.ok) return record;
    return ok({ message, writes: { [path]: serializeUnitRecord(record.value) }, deletes: [] });
  };
}

function requireRecord(ctx: Ctx): Step<UnitRecord> {
  return ctx.current === undefined ? pre(`${ctx.unit} has no ledger record`) : ok(ctx.current);
}

function requireState(rec: UnitRecord, states: readonly UnitState[]): Step<null> {
  return states.includes(rec.state)
    ? ok(null)
    : pre(`${rec.unit} is ${rec.state}, expected ${states.join(" or ")}`);
}

function requireGeneration(rec: UnitRecord, generation: number): Step<null> {
  const g = check("generation", Generation, generation);
  if (!g.ok) return g;
  return rec.generation === generation
    ? ok(null)
    : pre(`${rec.unit} is at generation ${rec.generation}, expected ${generation}`);
}

/** The record is in one of `states`, held by `by` at `generation`. */
function requireHeld(ctx: Ctx, generation: number, states: readonly UnitState[]): Step<UnitRecord> {
  const rec = requireRecord(ctx);
  if (!rec.ok) return rec;
  const g = requireGeneration(rec.value, generation);
  if (!g.ok) return g;
  const { owner, host, lane } = rec.value;
  if (owner !== ctx.by.owner || host !== ctx.by.host || lane !== ctx.by.lane) {
    return pre(`${ctx.unit} is held by ${owner}/${host}/${lane}, not the writer`);
  }
  const s = requireState(rec.value, states);
  return s.ok ? rec : s;
}

function requireCoordinator(ctx: Ctx): Step<null> {
  return ctx.by.lane === "coordinator" ? ok(null) : pre(`only the coordinator lane may write this edit`);
}

/** A record is stale once `now` (the forge's time) is `STALE_AFTER_MS` or more past its `heartbeat_at`. */
export function isStale(rec: UnitRecord, now: string): boolean {
  return Date.parse(now) - Date.parse(rec.heartbeat_at) >= STALE_AFTER_MS;
}

/** A stale record at `generation` in one of `states`, whatever its holder. */
function requireStale(ctx: Ctx, generation: number, states: readonly UnitState[]): Step<UnitRecord> {
  const rec = requireRecord(ctx);
  if (!rec.ok) return rec;
  const s = requireState(rec.value, states);
  if (!s.ok) return s;
  const g = requireGeneration(rec.value, generation);
  if (!g.ok) return g;
  if (!isStale(rec.value, ctx.now)) return pre(`${ctx.unit}'s heartbeat ${rec.value.heartbeat_at} is not stale at ${ctx.now}`);
  return rec;
}

/** `rec` with `changes`, written by `by` at `now`. */
function stamp(ctx: Ctx, rec: UnitRecord, changes: Partial<UnitRecord>): UnitRecord {
  return { ...rec, ...changes, owner: ctx.by.owner, host: ctx.by.host, lane: ctx.by.lane, heartbeat_at: ctx.now };
}

function to(state: UnitState, record: UnitRecord): Step<Change> {
  return ok({ to: state, record });
}

function normalizeAll(label: string, globs: readonly string[]): Step<string[]> {
  const out: string[] = [];
  for (const g of globs) {
    const n = normalizeGlob(g);
    if (!n.ok) return bad(`${label}: ${n.error.message}`);
    out.push(n.value);
  }
  return ok(out);
}

function blocked(ctx: Ctx, reason: Park["reason"]): Park {
  return { kind: "blocked", reason, inbox_owner: ctx.by.owner, globs_held: [] };
}

/** The globs a record holds against other claims. */
export function heldGlobs(rec: UnitRecord): readonly string[] {
  if (rec.state === "claimed" || rec.state === "merging") return rec.globs;
  if (rec.state === "parked") return rec.park?.globs_held ?? [];
  return [];
}

/** A record with no PR, SHAs, providers, park, counters or approval. */
function fresh(ctx: Ctx, state: UnitState, globs: string[], park: Park | null): UnitRecord {
  return {
    schema_version: SCHEMA_VERSION,
    unit: ctx.unit,
    state,
    owner: ctx.by.owner,
    host: ctx.by.host,
    lane: ctx.by.lane,
    generation: 1,
    globs,
    heartbeat_at: ctx.now,
    pr: null,
    pr_owner: null,
    base_sha: null,
    head_sha: null,
    reviewed_sha: null,
    passed_sha: null,
    approved_sha: null,
    builder_providers: [],
    park,
    attempts: 0,
    loopbacks: 0,
    ci_fixes: 0,
    approval: null,
  };
}

// ---------------------------------------------------------------- claim

/** An open PR a claim adopts. */
export const AdoptedPrSchema = z.strictObject({
  pr: z.int().min(1),
  pr_owner: GitHubLogin,
  head_sha: GitSha,
  base_sha: GitSha,
});
export type AdoptedPr = z.infer<typeof AdoptedPrSchema>;

export type ClaimParams = EditBase & {
  readonly globs: readonly string[];
  /** `null` for a unit with no record; else the released record's generation. */
  readonly expectGeneration: number | null;
  /** An Infrastructure Story's manifest SHA, which must carry an approval. */
  readonly manifestSha?: string | null;
  readonly adoptPr?: AdoptedPr | null;
  /** The SHA a claim with no adopted PR starts from (`main`); an adopted PR carries its own. */
  readonly baseSha?: string | null;
};

/** `none → claimed` and `released → claimed`. */
export function claim(p: ClaimParams): LedgerEdit {
  return makeEdit("claim", p, (ctx) => {
    if (p.expectGeneration !== null) {
      const g = check("claim expectGeneration", Generation, p.expectGeneration);
      if (!g.ok) return g;
    }
    const globs = normalizeAll("claim globs", p.globs);
    if (!globs.ok) return globs;
    const manifestSha = p.manifestSha ?? null;
    if (manifestSha !== null) {
      const m = check("claim manifestSha", GitSha, manifestSha);
      if (!m.ok) return m;
    }
    const adopted = p.adoptPr == null ? null : check("claim adoptPr", AdoptedPrSchema, p.adoptPr);
    if (adopted !== null && !adopted.ok) return adopted;
    const baseSha = p.baseSha ?? null;
    if (baseSha !== null) {
      if (adopted !== null) return bad("claim: baseSha and adoptPr are exclusive (an adopted PR carries its base_sha)");
      const b = check("claim baseSha", GitSha, baseSha);
      if (!b.ok) return b;
    }
    const prFields = {
      pr: adopted?.value.pr ?? null,
      pr_owner: adopted?.value.pr_owner ?? null,
      head_sha: adopted?.value.head_sha ?? null,
      base_sha: adopted?.value.base_sha ?? baseSha,
    };

    for (const [id, other] of ctx.ledger.units) {
      if (id === ctx.unit) continue;
      for (const held of heldGlobs(other)) {
        const hit = globs.value.find((g) => globsOverlap(g, held));
        if (hit !== undefined) return pre(`claim glob "${hit}" overlaps "${held}" held by ${id}`);
      }
    }

    const rec = ctx.current;
    if (rec === undefined) {
      if (p.expectGeneration !== null) return pre(`${ctx.unit} has no record; expected generation ${p.expectGeneration}`);
      if (manifestSha !== null) return pre(`${ctx.unit} has no record, so no approval for manifest ${manifestSha}`);
      return to("claimed", { ...fresh(ctx, "claimed", globs.value, null), ...prFields });
    }
    const s = requireState(rec, ["released"]);
    if (!s.ok) return s;
    if (p.expectGeneration === null) return pre(`${ctx.unit} has a record at generation ${rec.generation}`);
    const g = requireGeneration(rec, p.expectGeneration);
    if (!g.ok) return g;
    if (manifestSha !== null && rec.approval?.manifest_sha !== manifestSha) {
      return pre(`${ctx.unit} has no approval for manifest ${manifestSha}`);
    }
    return to(
      "claimed",
      stamp(ctx, rec, {
        state: "claimed",
        generation: rec.generation + 1,
        globs: globs.value,
        ...prFields,
        reviewed_sha: null,
        passed_sha: null,
        approved_sha: null,
      }),
    );
  });
}

// ---------------------------------------------------------------- parkNew

export type ParkNewParams = EditBase & {
  readonly kind: "needs-approval" | "blocked";
  /** Whose inbox the park lands in; defaults to the writer's owner. */
  readonly inboxOwner?: string;
};

/** `none → parked`: an unapproved Infrastructure Story or an open Escalation. */
export function parkNew(p: ParkNewParams): LedgerEdit {
  return makeEdit("parkNew", p, (ctx) => {
    if (unitKind(ctx.unit) !== "story") return bad(`parkNew: ${ctx.unit} is not a Story unit`);
    const kind = check("parkNew kind", z.enum(["needs-approval", "blocked"]), p.kind);
    if (!kind.ok) return kind;
    const inbox = check("parkNew inboxOwner", GitHubLogin, p.inboxOwner ?? ctx.by.owner);
    if (!inbox.ok) return inbox;
    if (ctx.current !== undefined) return pre(`${ctx.unit} already has a record (${ctx.current.state})`);
    const park: Park = {
      kind: kind.value,
      reason: kind.value === "blocked" ? "escalation" : null,
      inbox_owner: inbox.value,
      globs_held: [],
    };
    return to("parked", fresh(ctx, "parked", [], park));
  });
}

// ---------------------------------------------------------------- heartbeat

export const HeartbeatSetSchema = z.strictObject({
  pr: z.int().min(1).nullable().optional(),
  pr_owner: GitHubLogin.nullable().optional(),
  base_sha: GitSha.nullable().optional(),
  head_sha: GitSha.nullable().optional(),
  reviewed_sha: GitSha.nullable().optional(),
  passed_sha: GitSha.nullable().optional(),
  builder_providers: z.array(NonEmpty).optional(),
});
export type HeartbeatSet = z.infer<typeof HeartbeatSetSchema>;

export type HeartbeatParams = HeldParams & { readonly set?: HeartbeatSet };

/** `claimed → claimed` and `merging → merging`, optionally recording PR and SHA progress. */
export function heartbeat(p: HeartbeatParams): LedgerEdit {
  return makeEdit("heartbeat", p, (ctx) => {
    const set = check("heartbeat set", HeartbeatSetSchema, p.set ?? {});
    if (!set.ok) return set;
    const rec = requireHeld(ctx, p.generation, ["claimed", "merging"]);
    if (!rec.ok) return rec;
    const changes: Partial<UnitRecord> = {};
    for (const [key, value] of Object.entries(set.value)) {
      if (value !== undefined) (changes as Record<string, unknown>)[key] = value;
    }
    return to(rec.value.state, stamp(ctx, rec.value, changes));
  });
}

/**
 * The heartbeat keeper's beat: `claimed → claimed` and `merging → merging`,
 * stamping `heartbeat_at` only. A record still held by `by` at `generation`
 * but in another state (the holder's own steps moved it on) gives `null`; any
 * other mismatch is a precondition error (the unit is lost).
 */
export function keepAlive(p: HeldParams): LedgerEdit {
  return makeEdit("keepAlive", p, (ctx) => {
    const rec = requireRecord(ctx);
    if (!rec.ok) return rec;
    const g = requireGeneration(rec.value, p.generation);
    if (!g.ok) return g;
    const { owner, host, lane } = rec.value;
    if (owner !== ctx.by.owner || host !== ctx.by.host || lane !== ctx.by.lane) {
      return pre(`${ctx.unit} is held by ${owner}/${host}/${lane}, not the writer`);
    }
    if (rec.value.state !== "claimed" && rec.value.state !== "merging") return ok(null);
    return to(rec.value.state, stamp(ctx, rec.value, {}));
  });
}

// ---------------------------------------------------------------- loopback / ciFix

export type CappedParams = HeldParams & { readonly cap: number };

function capped(name: string, counter: "loopbacks" | "ci_fixes", reason: Park["reason"], p: CappedParams): LedgerEdit {
  return makeEdit(name, p, (ctx) => {
    const cap = check(`${name} cap`, Cap, p.cap);
    if (!cap.ok) return cap;
    const rec = requireHeld(ctx, p.generation, ["claimed"]);
    if (!rec.ok) return rec;
    if (rec.value[counter] < cap.value) {
      return to("claimed", stamp(ctx, rec.value, { [counter]: rec.value[counter] + 1 }));
    }
    return to("parked", stamp(ctx, rec.value, { state: "parked", park: blocked(ctx, reason) }));
  });
}

/** A review loopback: `claimed → claimed`, or `→ parked` (`review-cap`) once the cap is reached. */
export function loopback(p: CappedParams): LedgerEdit {
  return capped("loopback", "loopbacks", "review-cap", p);
}

/** A CI fix: `claimed → claimed`, or `→ parked` (`ci-fix-cap`) once the cap is reached. */
export function ciFix(p: CappedParams): LedgerEdit {
  return capped("ciFix", "ci_fixes", "ci-fix-cap", p);
}

// ---------------------------------------------------------------- takeOverStale

export type TakeOverStaleParams = EditBase & {
  readonly generation: number;
  /** For a `merging` record: the caller has seen its PR still in the merge queue. */
  readonly stillQueued?: boolean;
  /** For a `claimed` record: the manifest's globs, re-resolved; default the record's. */
  readonly globs?: readonly string[];
  /**
   * For a `claimed` record: the open PR on the branch, adopted as a claim
   * adopts it. For a `merging` record: its own PR (`pr` must match), whose
   * queue head becomes `head_sha`; nothing else is taken from it.
   */
  readonly adoptPr?: AdoptedPr | null;
  /** For a `claimed` record with no adopted PR: the SHA it starts from (`main`). */
  readonly baseSha?: string | null;
};

/**
 * A stale takeover: `claimed → claimed` (or `→ parked` at the attempts cap),
 * `merging → merging`. A `claimed` takeover is a claim of the record: its
 * globs re-checked for overlap, the claim's PR fields, the review SHAs
 * cleared. A `merging` takeover keeps the PR, SHAs and globs, `head_sha` aside.
 */
export function takeOverStale(p: TakeOverStaleParams): LedgerEdit {
  return makeEdit("takeOverStale", p, (ctx) => {
    const globs = p.globs === undefined ? null : normalizeAll("takeOverStale globs", p.globs);
    if (globs !== null && !globs.ok) return globs;
    const adopted = p.adoptPr == null ? null : check("takeOverStale adoptPr", AdoptedPrSchema, p.adoptPr);
    if (adopted !== null && !adopted.ok) return adopted;
    const baseSha = p.baseSha ?? null;
    if (baseSha !== null) {
      if (adopted !== null) return bad("takeOverStale: baseSha and adoptPr are exclusive (an adopted PR carries its base_sha)");
      const b = check("takeOverStale baseSha", GitSha, baseSha);
      if (!b.ok) return b;
    }
    const rec = requireStale(ctx, p.generation, ["claimed", "merging"]);
    if (!rec.ok) return rec;
    const r = rec.value;
    const generation = r.generation + 1;
    if (r.state === "merging") {
      if (r.lane === "coordinator") return pre(`${ctx.unit} is merging under the coordinator`);
      if (p.stillQueued !== true) return pre(`${ctx.unit}'s PR is not asserted to be still queued`);
      if (globs !== null || baseSha !== null) return pre(`${ctx.unit} is merging: a merging takeover keeps its globs and base_sha`);
      if (adopted === null) return to("merging", stamp(ctx, r, { generation }));
      if (adopted.value.pr !== r.pr) return pre(`${ctx.unit} is merging PR #${r.pr ?? "none"}, not #${adopted.value.pr}`);
      return to("merging", stamp(ctx, r, { generation, head_sha: adopted.value.head_sha }));
    }
    const held = globs?.value ?? [...r.globs];
    for (const [id, other] of ctx.ledger.units) {
      if (id === ctx.unit) continue;
      for (const theirs of heldGlobs(other)) {
        const hit = held.find((g) => globsOverlap(g, theirs));
        if (hit !== undefined) return pre(`takeOverStale glob "${hit}" overlaps "${theirs}" held by ${id}`);
      }
    }
    const claimed: Partial<UnitRecord> = {
      generation,
      globs: held,
      pr: adopted?.value.pr ?? null,
      pr_owner: adopted?.value.pr_owner ?? null,
      head_sha: adopted?.value.head_sha ?? null,
      base_sha: adopted?.value.base_sha ?? baseSha,
      reviewed_sha: null,
      passed_sha: null,
      approved_sha: null,
    };
    const attempts = r.attempts + 1;
    if (attempts >= ATTEMPTS_CAP) {
      return to("parked", stamp(ctx, r, { ...claimed, state: "parked", attempts, park: blocked(ctx, "attempts-cap") }));
    }
    return to("claimed", stamp(ctx, r, { ...claimed, attempts }));
  });
}

// ---------------------------------------------------------------- startMerging

/** `claimed → merging`: fenced and enqueued at `passed_sha`. */
export function startMerging(p: HeldParams): LedgerEdit {
  return makeEdit("startMerging", p, (ctx) => {
    const rec = requireHeld(ctx, p.generation, ["claimed"]);
    if (!rec.ok) return rec;
    if (rec.value.pr === null) return pre(`${ctx.unit} has no PR`);
    if (rec.value.passed_sha === null) return pre(`${ctx.unit} has no passed_sha`);
    return to("merging", stamp(ctx, rec.value, { state: "merging" }));
  });
}

// ---------------------------------------------------------------- park

export type ParkParams = HeldParams & {
  readonly kind: Park["kind"];
  /** Required for `blocked`, absent otherwise. */
  readonly reason?: Park["reason"];
  /** The paths the PR's diff changes; required for `awaiting-approval`. */
  readonly diffPaths?: readonly string[];
  /** Whose inbox the park lands in; defaults to the writer's owner. */
  readonly inboxOwner?: string;
};

/** `claimed → parked` and, for an approval-gated ejection, `merging → parked`. */
export function park(p: ParkParams): LedgerEdit {
  return makeEdit("park", p, (ctx) => {
    const reason = check("park reason", ParkReason.nullable(), p.reason ?? null);
    if (!reason.ok) return reason;
    const inbox = check("park inboxOwner", GitHubLogin, p.inboxOwner ?? ctx.by.owner);
    if (!inbox.ok) return inbox;
    let held: string[] = [];
    if (p.kind === "awaiting-approval") {
      if (p.diffPaths === undefined) return bad("park: awaiting-approval needs diffPaths");
      const d = normalizeAll("park diffPaths", p.diffPaths);
      if (!d.ok) return d;
      held = d.value;
    }
    const parkValue = check("park", ParkSchema, {
      kind: p.kind,
      reason: reason.value,
      inbox_owner: inbox.value,
      globs_held: held,
    });
    if (!parkValue.ok) return parkValue;
    if (reason.value === "unclaimable") return bad("park: unclaimable is not a reason for parking a claimed unit");
    const rec = requireHeld(ctx, p.generation, ["claimed", "merging"]);
    if (!rec.ok) return rec;
    if (rec.value.state === "merging") {
      if (p.kind !== "awaiting-approval") return pre(`${ctx.unit} is merging; only awaiting-approval parks it`);
      return to("parked", stamp(ctx, rec.value, { state: "parked", park: parkValue.value, approved_sha: null }));
    }
    return to("parked", stamp(ctx, rec.value, { state: "parked", park: parkValue.value }));
  });
}

// ---------------------------------------------------------------- failAttempt / release

/** A failed attempt: `claimed → released` (or `→ parked` at the attempts cap), `merging → released`. */
export function failAttempt(p: HeldParams): LedgerEdit {
  return makeEdit("failAttempt", p, (ctx) => {
    const rec = requireHeld(ctx, p.generation, ["claimed", "merging"]);
    if (!rec.ok) return rec;
    const attempts = rec.value.attempts + 1;
    if (rec.value.state === "claimed" && attempts >= ATTEMPTS_CAP) {
      return to("parked", stamp(ctx, rec.value, { state: "parked", attempts, park: blocked(ctx, "attempts-cap") }));
    }
    return to("released", stamp(ctx, rec.value, { state: "released", attempts }));
  });
}

/** `claimed / merging → released` with no attempt counted (`stop --now`). */
export function release(p: HeldParams): LedgerEdit {
  return makeEdit("release", p, (ctx) => {
    const rec = requireHeld(ctx, p.generation, ["claimed", "merging"]);
    if (!rec.ok) return rec;
    return to("released", stamp(ctx, rec.value, { state: "released" }));
  });
}

/** `merging → released`: stale and no longer queued (attempts + 1, PR kept). */
export function releaseStale(p: EditBase & { readonly generation: number }): LedgerEdit {
  return makeEdit("releaseStale", p, (ctx) => {
    const rec = requireStale(ctx, p.generation, ["merging"]);
    if (!rec.ok) return rec;
    if (rec.value.lane === "coordinator") return pre(`${ctx.unit} is merging under the coordinator`);
    return to("released", stamp(ctx, rec.value, { state: "released", attempts: rec.value.attempts + 1 }));
  });
}

/** `merging → claimed`: a builder's PR was ejected from the queue (attempts + 1). */
export function ejected(p: HeldParams): LedgerEdit {
  return makeEdit("ejected", p, (ctx) => {
    if (ctx.by.lane === "coordinator") return pre("ejected: the coordinator's merges park instead");
    const rec = requireHeld(ctx, p.generation, ["merging"]);
    if (!rec.ok) return rec;
    return to("claimed", stamp(ctx, rec.value, { state: "claimed", attempts: rec.value.attempts + 1 }));
  });
}

// ---------------------------------------------------------------- merged

/** `released / claimed / merging / parked → merged`: the PR was found merged. */
export function markMerged(p: EditBase): LedgerEdit {
  return makeEdit("markMerged", p, (ctx) => {
    const rec = requireRecord(ctx);
    if (!rec.ok) return rec;
    if (rec.value.state === "merged") return ok(null);
    return to("merged", stamp(ctx, rec.value, { state: "merged", park: null }));
  });
}

/** `claimed → merged`: a recurring unit (planning, reconcile) with nothing to commit. */
export function finishRecurring(p: HeldParams): LedgerEdit {
  return makeEdit("finishRecurring", p, (ctx) => {
    const kind = unitKind(ctx.unit);
    if (kind !== "planning" && kind !== "reconcile") return bad(`finishRecurring: ${ctx.unit} is not a recurring unit`);
    const rec = requireHeld(ctx, p.generation, ["claimed"]);
    if (!rec.ok) return rec;
    return to("merged", stamp(ctx, rec.value, { state: "merged", pr: null }));
  });
}

// ---------------------------------------------------------------- coordinator

export type TakeApprovedParams = EditBase & { readonly generation: number; readonly approvedSha: string };

/** `parked → merging`: the coordinator takes an approved PR at `approved_sha`. */
export function takeApproved(p: TakeApprovedParams): LedgerEdit {
  return makeEdit("takeApproved", p, (ctx) => {
    const sha = check("takeApproved approvedSha", GitSha, p.approvedSha);
    if (!sha.ok) return sha;
    const c = requireCoordinator(ctx);
    if (!c.ok) return c;
    const rec = requireRecord(ctx);
    if (!rec.ok) return rec;
    const s = requireState(rec.value, ["parked"]);
    if (!s.ok) return s;
    const g = requireGeneration(rec.value, p.generation);
    if (!g.ok) return g;
    const parked = rec.value.park;
    if (parked?.kind !== "awaiting-approval") return pre(`${ctx.unit} is not parked awaiting-approval`);
    return to(
      "merging",
      stamp(ctx, rec.value, {
        state: "merging",
        generation: rec.value.generation + 1,
        approved_sha: sha.value,
        globs: parked.globs_held,
        park: null,
      }),
    );
  });
}

export type Ruling = "release" | "rebuild" | "approve";

export type ApplyRulingParams = EditBase & {
  readonly generation: number;
  readonly ruling: Ruling;
  /** The approved manifest's SHA; required for `approve`. */
  readonly manifestSha?: string;
};

/** `parked → released` under a ruling. */
export function applyRuling(p: ApplyRulingParams): LedgerEdit {
  return makeEdit("applyRuling", p, (ctx) => {
    const ruling = check("applyRuling ruling", z.enum(["release", "rebuild", "approve"]), p.ruling);
    if (!ruling.ok) return ruling;
    let manifestSha: string | null = null;
    if (ruling.value === "approve") {
      const m = check("applyRuling manifestSha", GitSha, p.manifestSha);
      if (!m.ok) return m;
      manifestSha = m.value;
    }
    const c = requireCoordinator(ctx);
    if (!c.ok) return c;
    const rec = requireRecord(ctx);
    if (!rec.ok) return rec;
    const s = requireState(rec.value, ["parked"]);
    if (!s.ok) return s;
    const g = requireGeneration(rec.value, p.generation);
    if (!g.ok) return g;
    const base: Partial<UnitRecord> = { state: "released", park: null };
    if (ruling.value === "release") {
      return to("released", stamp(ctx, rec.value, { ...base, attempts: 0, loopbacks: 0, ci_fixes: 0 }));
    }
    if (ruling.value === "rebuild") {
      return to(
        "released",
        stamp(ctx, rec.value, {
          ...base,
          attempts: 0,
          loopbacks: 0,
          ci_fixes: 0,
          builder_providers: [],
          reviewed_sha: null,
          passed_sha: null,
          approved_sha: null,
        }),
      );
    }
    if (rec.value.park?.kind !== "needs-approval") return pre(`${ctx.unit} is not parked needs-approval`);
    return to(
      "released",
      stamp(ctx, rec.value, { ...base, approval: { by: ctx.by.owner, manifest_sha: manifestSha as string } }),
    );
  });
}

/** `merged → none`: the coordinator deletes a record once the unit is done on `main`. */
export function deleteMerged(p: EditBase): LedgerEdit {
  return makeEdit("deleteMerged", p, (ctx) => {
    const c = requireCoordinator(ctx);
    if (!c.ok) return c;
    if (ctx.current === undefined) return ok(null);
    const s = requireState(ctx.current, ["merged"]);
    if (!s.ok) return s;
    return ok({ to: "none" });
  });
}
