import { z } from "zod";
import { globsOverlap, normalizeGlob } from "../manifests/globs.ts";
import { err, ok, type Result } from "../result.ts";
import { describeIssues, GitHubLogin, IsoDateTime, NonEmpty } from "../schemas/common.ts";
import {
  CoordinatorRecordSchema,
  DismissalSchema,
  GitSha,
  GRAPH_PSEUDO_GLOB,
  GraphHash,
  LaneIdentity,
  LEDGER_SCHEMA_VERSION,
  PARK_TEXT_MAX,
  ParkReason,
  ParkSchema,
  pendingKey,
  PendingRulingSchema,
  planningKindOf,
  unitKind,
  unitPath,
  UnitRecordSchema,
  type CoordinatorRecord,
  type Dismissal,
  type Park,
  type PendingRuling,
  type UnitRecord,
  type UnitState,
} from "../schemas/ledger.ts";
import { RetroRecordResultSchema } from "../schemas/retro-gates.ts";
import { capText, sanitizeAgentText } from "../sanitize.ts";
import { COORDINATOR_PATH, parseLedger, serializeCoordinator, serializeUnitRecord, type Ledger } from "./codec.ts";
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
export function isStale(rec: Pick<UnitRecord, "heartbeat_at">, now: string): boolean {
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
  return { ...rec, ...changes, schema_version: LEDGER_SCHEMA_VERSION, owner: ctx.by.owner, host: ctx.by.host, lane: ctx.by.lane, heartbeat_at: ctx.now };
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

/**
 * A retro's result as `rec` keeps it at `pr` and `head` (Story 2.9): it is
 * bound to the PR and the head it was validated at, so a move of either
 * drops it, and the retro step re-checks the moved head against the result
 * before recording it again.
 */
function boundRetroResult(rec: UnitRecord, pr: number | null, head: string | null): UnitRecord["retro_result"] {
  return rec.pr === pr && rec.head_sha === head ? rec.retro_result : null;
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
    schema_version: LEDGER_SCHEMA_VERSION,
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
    enqueued_sha: null,
    approved_sha: null,
    approved_graph: null,
    retro_result: null,
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
        enqueued_sha: null,
        approved_sha: null,
        approved_graph: null,
        // A retro's result belongs to its PR: kept only when the claim adopts the PR at the head it was validated at (Story 2.9).
        retro_result: adopted === null ? null : boundRetroResult(rec, adopted.value.pr, adopted.value.head_sha),
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
  /** The head the PR is enqueued at (Story 3.5): the enqueue fence sets it. */
  enqueued_sha: GitSha.nullable().optional(),
  builder_providers: z.array(NonEmpty).optional(),
  /** A retro unit's validated result, recorded with its PR (Story 2.9). */
  retro_result: RetroRecordResultSchema.nullable().optional(),
});
export type HeartbeatSet = z.infer<typeof HeartbeatSetSchema>;

export type HeartbeatParams = HeldParams & { readonly set?: HeartbeatSet };

/**
 * `claimed → claimed` and `merging → merging`, optionally recording PR and
 * SHA progress. A set that moves `pr` or `head_sha` with no `retro_result`
 * drops the record's (Story 2.9).
 */
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
    // A retro's result is bound to its PR and head: a set that moves either without recording a result drops it.
    if (set.value.retro_result === undefined) {
      changes.retro_result = boundRetroResult(rec.value, changes.pr === undefined ? rec.value.pr : changes.pr, changes.head_sha === undefined ? rec.value.head_sha : changes.head_sha);
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
 * Either keeps a retro's result only at the PR and head it was validated at.
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
      return to("merging", stamp(ctx, r, { generation, head_sha: adopted.value.head_sha, retro_result: boundRetroResult(r, r.pr, adopted.value.head_sha) }));
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
      enqueued_sha: null,
      approved_sha: null,
      approved_graph: null,
      retro_result: adopted === null ? null : boundRetroResult(r, adopted.value.pr, adopted.value.head_sha),
    };
    const attempts = r.attempts + 1;
    if (attempts >= ATTEMPTS_CAP) {
      return to("parked", stamp(ctx, r, { ...claimed, state: "parked", attempts, park: blocked(ctx, "attempts-cap") }));
    }
    return to("claimed", stamp(ctx, r, { ...claimed, attempts }));
  });
}

// ---------------------------------------------------------------- startMerging

/**
 * `claimed → merging`: fenced and enqueued. The record needs a `passed_sha`
 * (a review round passed it), except a `reconcile:<n>` unit, whose PR gets
 * no review (Story 3.5).
 */
export function startMerging(p: HeldParams): LedgerEdit {
  return makeEdit("startMerging", p, (ctx) => {
    const rec = requireHeld(ctx, p.generation, ["claimed"]);
    if (!rec.ok) return rec;
    if (rec.value.pr === null) return pre(`${ctx.unit} has no PR`);
    if (rec.value.passed_sha === null && unitKind(ctx.unit) !== "reconcile") return pre(`${ctx.unit} has no passed_sha`);
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
  /**
   * The head a park from `merging` sets `enqueued_sha` to: a re-park of a
   * record the coordinator took, so only an approval submitted after it
   * re-takes the PR. Absent: `enqueued_sha` is kept.
   */
  readonly enqueuedSha?: string;
  /**
   * The graph hash of the delta the runner posted on the PR (retro item 24),
   * kept as `park.graph_posted`; only for `awaiting-approval`. Absent: none
   * was posted.
   */
  readonly graphPosted?: string;
  /**
   * The blocked session's own words (Story 4.2), kept as `park.text`:
   * already sanitized (`parkText`) and at most `PARK_TEXT_MAX` long. Absent
   * or empty: the park has none.
   */
  readonly text?: string;
};

/**
 * Agent text as a park keeps it (Story 4.2): `sanitizeAgentText` with the
 * lane's known `secrets`, trimmed and capped at `PARK_TEXT_MAX`; `undefined`
 * when nothing is left.
 */
export function parkText(text: string, secrets: readonly string[] = []): string | undefined {
  const clean = sanitizeAgentText(text, { secrets }).trim();
  return clean === "" ? undefined : capText(clean, PARK_TEXT_MAX);
}

/**
 * `claimed → parked` and, for an approval-gated ejection, `merging → parked`
 * (`awaiting-approval`; a coordinator-held record may also park `blocked`
 * `graph-invalid`, Story 2.8). A park from `merging` clears `approved_sha`
 * and `approved_graph`, and sets `enqueued_sha` to `enqueuedSha` when given.
 * With `graphPosted`, the park records the posted graph delta's hash (retro
 * item 24). The record must be held by the writer at
 * `generation`, except a `merging` record held by a coordinator lane: any
 * coordinator-lane writer may park it at its `generation` (as
 * `releaseDisposable` releases one), so a coordinator that moved hosts
 * leaves nothing stuck (AD-6).
 */
export function park(p: ParkParams): LedgerEdit {
  return makeEdit("park", p, (ctx) => {
    const reason = check("park reason", ParkReason.nullable(), p.reason ?? null);
    if (!reason.ok) return reason;
    const inbox = check("park inboxOwner", GitHubLogin, p.inboxOwner ?? ctx.by.owner);
    if (!inbox.ok) return inbox;
    const enqueued = check("park enqueuedSha", GitSha.nullable(), p.enqueuedSha ?? null);
    if (!enqueued.ok) return enqueued;
    const posted = check("park graphPosted", GraphHash.nullable(), p.graphPosted ?? null);
    if (!posted.ok) return posted;
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
      ...(posted.value !== null ? { graph_posted: posted.value } : {}),
      ...(p.text !== undefined && p.text !== "" ? { text: p.text } : {}),
    });
    if (!parkValue.ok) return parkValue;
    if (reason.value === "unclaimable") return bad("park: unclaimable is not a reason for parking a claimed unit");
    const coordinator = coordinatorMerging(ctx);
    const rec = coordinator ? requireCoordinatorMerging(ctx, p.generation) : requireHeld(ctx, p.generation, ["claimed", "merging"]);
    if (!rec.ok) return rec;
    if (rec.value.state === "merging") {
      const graphInvalid = coordinator && p.kind === "blocked" && reason.value === "graph-invalid";
      if (p.kind !== "awaiting-approval" && !graphInvalid) {
        return pre(`${ctx.unit} is merging; only awaiting-approval${coordinator ? " or blocked graph-invalid" : ""} parks it`);
      }
      const fencedAt = enqueued.value !== null ? { enqueued_sha: enqueued.value } : {};
      return to("parked", stamp(ctx, rec.value, { state: "parked", park: parkValue.value, approved_sha: null, approved_graph: null, ...fencedAt }));
    }
    if (enqueued.value !== null) return bad("park: enqueuedSha is only for a park from merging");
    return to("parked", stamp(ctx, rec.value, { state: "parked", park: parkValue.value }));
  });
}

/** The record is `merging` under a coordinator lane, and the writer is a coordinator lane. */
function coordinatorMerging(ctx: Ctx): boolean {
  return ctx.by.lane === "coordinator" && ctx.current?.state === "merging" && ctx.current.lane === "coordinator";
}

/** A coordinator-held `merging` record at `generation`, whatever coordinator holds it. */
function requireCoordinatorMerging(ctx: Ctx, generation: number): Step<UnitRecord> {
  const rec = requireRecord(ctx);
  if (!rec.ok) return rec;
  const s = requireState(rec.value, ["merging"]);
  if (!s.ok) return s;
  const g = requireGeneration(rec.value, generation);
  if (!g.ok) return g;
  return rec;
}

// ---------------------------------------------------------------- failAttempt / release

/** A failed attempt: `claimed → released` (or `→ parked` at the attempts cap), `merging → released`. */
export function failAttempt(p: HeldParams): LedgerEdit {
  return failFrom(p, ["claimed", "merging"]);
}

/**
 * `failAttempt` from `claimed` only: the lane's retry of a failed attempt the
 * ledger did not take, which must never move a `merging` record out of the
 * queue without its dequeue.
 */
export function failClaimed(p: HeldParams): LedgerEdit {
  return failFrom(p, ["claimed"]);
}

function failFrom(p: HeldParams, states: readonly UnitState[]): LedgerEdit {
  return makeEdit("failAttempt", p, (ctx) => {
    const rec = requireHeld(ctx, p.generation, states);
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

export type TakeApprovedParams = EditBase & {
  readonly generation: number;
  readonly approvedSha: string;
  /** A graph-changing PR's merge-result hash the Maintainer approved (Story 2.8): the record also holds `xarabot:graph`. */
  readonly approvedGraph?: string | null;
};

/**
 * `parked → merging`: the coordinator takes an approved PR at `approved_sha`.
 * With `approvedGraph`, the record's `globs` are the park's `globs_held` plus
 * `xarabot:graph` and `approved_graph` is set; another record holding a glob
 * that overlaps `xarabot:graph` refuses the take (precondition).
 * The posted delta binds the approval (retro item 24, AD-11): `approvedGraph`
 * must equal the park's `graph_posted`, else the take is refused
 * (precondition) and the record is parked again with the new delta
 * (`reparkGraph`).
 * `enqueued_sha` is cleared: the taker sets it at the head once the enqueue
 * succeeds (or before it parks the record again), so a taken record with no
 * `enqueued_sha` is one the runner never enqueued, and its approval stands.
 * `passed_sha` is kept: the review that passed the head still stands.
 */
export function takeApproved(p: TakeApprovedParams): LedgerEdit {
  return makeEdit("takeApproved", p, (ctx) => {
    const sha = check("takeApproved approvedSha", GitSha, p.approvedSha);
    if (!sha.ok) return sha;
    const graph = check("takeApproved approvedGraph", GraphHash.nullable(), p.approvedGraph ?? null);
    if (!graph.ok) return graph;
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
    let globs = [...parked.globs_held];
    if (graph.value !== null) {
      if (parked.graph_posted !== graph.value) {
        return pre(`takeApproved: the approved graph ${graph.value} is not the posted delta's ${parked.graph_posted ?? "(none posted)"}`);
      }
      for (const [id, other] of ctx.ledger.units) {
        if (id === ctx.unit) continue;
        const held = heldGlobs(other).find((g) => globsOverlap(g, GRAPH_PSEUDO_GLOB));
        if (held !== undefined) return pre(`takeApproved: ${id} holds "${held}", which overlaps "${GRAPH_PSEUDO_GLOB}"`);
      }
      globs = [...new Set([...globs, GRAPH_PSEUDO_GLOB])];
    }
    return to(
      "merging",
      stamp(ctx, rec.value, {
        state: "merging",
        generation: rec.value.generation + 1,
        approved_sha: sha.value,
        approved_graph: graph.value,
        enqueued_sha: null,
        globs,
        park: null,
      }),
    );
  });
}

export type ReparkGraphParams = EditBase & {
  readonly generation: number;
  /** The graph hash of the delta just posted on the PR. */
  readonly graphPosted: string;
  /** Whose inbox the park lands in: the Maintainer, whose approval alone takes a graph change. */
  readonly inboxOwner: string;
};

/**
 * `parked → parked` (retro item 24, AD-11): the coordinator re-parks a
 * `parked` `awaiting-approval` record at `generation` after posting a new
 * graph delta on its PR, because the merge result's hash is not the park's
 * `graph_posted` (or none was posted). The park keeps its `globs_held`, lands
 * in `inboxOwner`'s inbox and records `graph_posted`; `enqueued_sha` is set
 * to the record's head, so with the record coordinator-held only an approval
 * submitted after `heartbeat_at` (`now`: the forge time read before the
 * reviews were, never a later one) takes it. `generation` is kept.
 */
export function reparkGraph(p: ReparkGraphParams): LedgerEdit {
  return makeEdit("reparkGraph", p, (ctx) => {
    const posted = check("reparkGraph graphPosted", GraphHash, p.graphPosted);
    if (!posted.ok) return posted;
    const inbox = check("reparkGraph inboxOwner", GitHubLogin, p.inboxOwner);
    if (!inbox.ok) return inbox;
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
    if (rec.value.head_sha === null) return pre(`${ctx.unit} has no head`);
    const park: Park = { ...parked, inbox_owner: inbox.value, graph_posted: posted.value };
    return to("parked", stamp(ctx, rec.value, { park, enqueued_sha: rec.value.head_sha }));
  });
}

export type Ruling = "release" | "rebuild" | "approve";

export type ApplyRulingParams = EditBase & {
  readonly generation: number;
  readonly ruling: Ruling;
  /** The approved manifest's SHA; required for `approve`. */
  readonly manifestSha?: string;
  /** Who approved, for `approve`'s `approval.by` (Story 4.6: the ruling's author); default the writer's owner. */
  readonly approver?: string;
};

/**
 * `parked → released` under a ruling, by any lane identity: the coordinator's
 * comment rulings (4.6) or the Maintainer's `xarabot rule`. The record must be
 * `parked` at `generation`; `release` and `rebuild` zero the counters, and
 * `rebuild` also clears the providers, the reviewed, passed, enqueued and approved SHAs,
 * `approved_graph` and `retro_result`. `approve` needs a `needs-approval`
 * park and records `approval` = {`approver` (default the writer's owner),
 * `manifestSha`}.
 */
export function applyRuling(p: ApplyRulingParams): LedgerEdit {
  return makeEdit("applyRuling", p, (ctx) => {
    const ruling = check("applyRuling ruling", z.enum(["release", "rebuild", "approve"]), p.ruling);
    if (!ruling.ok) return ruling;
    let manifestSha: string | null = null;
    let approver = ctx.by.owner;
    if (ruling.value === "approve") {
      const m = check("applyRuling manifestSha", GitSha, p.manifestSha);
      if (!m.ok) return m;
      manifestSha = m.value;
      if (p.approver !== undefined) {
        const a = check("applyRuling approver", GitHubLogin, p.approver);
        if (!a.ok) return a;
        approver = a.value;
      }
    }
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
          enqueued_sha: null,
          approved_sha: null,
          approved_graph: null,
          retro_result: null,
        }),
      );
    }
    if (rec.value.park?.kind !== "needs-approval") return pre(`${ctx.unit} is not parked needs-approval`);
    return to(
      "released",
      stamp(ctx, rec.value, { ...base, approval: { by: approver, manifest_sha: manifestSha as string } }),
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

// ---------------------------------------------------------------- recurring records

/** The writer is the coordinator lane and the unit a `reconcile:<n>` (an `invalid` unit kind otherwise). */
function requireReconcileWriter(name: string, ctx: Ctx): Step<null> {
  if (unitKind(ctx.unit) !== "reconcile") return bad(`${name}: ${ctx.unit} is not a reconcile unit`);
  return requireCoordinator(ctx);
}

/**
 * Whether `rec` is a disposable record (Story 2.7): a `reconcile:<n>`, or a
 * status planning record the coordinator did not take on an approval
 * (`approved_sha` is `null`: only `takeApproved` sets it).
 */
export function isDisposable(rec: Pick<UnitRecord, "unit" | "globs" | "approved_sha">): boolean {
  const kind = unitKind(rec.unit);
  if (kind === "reconcile") return true;
  return kind === "planning" && planningKindOf(rec) === "status" && rec.approved_sha === null;
}

/**
 * `merging → released`, no attempt counted: a disposable PR (`isDisposable`:
 * a `reconcile` PR, or an ungated status planning PR) was ejected, dequeued,
 * closed or refused by the queue. The record must be held by a coordinator
 * lane at `generation`; its PR fields are kept.
 */
export function releaseDisposable(p: HeldParams): LedgerEdit {
  return makeEdit("releaseDisposable", p, (ctx) => {
    const kind = unitKind(ctx.unit);
    if (kind !== "reconcile" && kind !== "planning") return bad(`releaseDisposable: ${ctx.unit} is not a reconcile or planning unit`);
    const c = requireCoordinator(ctx);
    if (!c.ok) return c;
    const rec = requireRecord(ctx);
    if (!rec.ok) return rec;
    if (!isDisposable(rec.value)) return pre(`${ctx.unit} is not disposable: only a reconcile or an ungated status planning record is`);
    const s = requireState(rec.value, ["merging"]);
    if (!s.ok) return s;
    const g = requireGeneration(rec.value, p.generation);
    if (!g.ok) return g;
    if (rec.value.lane !== "coordinator") return pre(`${ctx.unit} is held by lane ${rec.value.lane}, not a coordinator`);
    return to("released", stamp(ctx, rec.value, { state: "released" }));
  });
}

/**
 * Whether `rec` is a retro or retro-item record its own step queued with no
 * approval (Stories 2.9, 2.10): `approved_sha` is `null`, as only
 * `takeApproved` sets it. Its PR follows a Story's path, so an ejection is a
 * failed attempt, never a park awaiting approval.
 */
export function isUngatedRetro(rec: Pick<UnitRecord, "unit" | "approved_sha">): boolean {
  const kind = unitKind(rec.unit);
  return (kind === "retro" || kind === "retro-item") && rec.approved_sha === null;
}

/**
 * `merging → released`, `attempts` + 1 (`→ parked` `blocked` `attempts-cap`
 * at the cap): an ungated retro or retro-item PR (`isUngatedRetro`) that
 * left the merge queue unmerged, as a Story's ejection counts an attempt. Its
 * PR fields are kept, so the next claim adopts an open PR and takes it
 * through CI again. The record must be held by a coordinator lane at
 * `generation`, whichever coordinator; the writer is a coordinator lane.
 */
export function releaseEjected(p: HeldParams): LedgerEdit {
  return makeEdit("releaseEjected", p, (ctx) => {
    const kind = unitKind(ctx.unit);
    if (kind !== "retro" && kind !== "retro-item") return bad(`releaseEjected: ${ctx.unit} is not a retro or retro-item unit`);
    const c = requireCoordinator(ctx);
    if (!c.ok) return c;
    const rec = requireRecord(ctx);
    if (!rec.ok) return rec;
    if (!isUngatedRetro(rec.value)) return pre(`${ctx.unit} was taken on an approval: an ejection parks it awaiting approval`);
    const s = requireState(rec.value, ["merging"]);
    if (!s.ok) return s;
    const g = requireGeneration(rec.value, p.generation);
    if (!g.ok) return g;
    if (rec.value.lane !== "coordinator") return pre(`${ctx.unit} is held by lane ${rec.value.lane}, not a coordinator`);
    const attempts = rec.value.attempts + 1;
    if (attempts >= ATTEMPTS_CAP) {
      return to("parked", stamp(ctx, rec.value, { state: "parked", attempts, park: blocked(ctx, "attempts-cap") }));
    }
    return to("released", stamp(ctx, rec.value, { state: "released", attempts }));
  });
}

/** `claimed → released`, `attempts` + 1: a `reconcile` run that died (its record stale at `generation`, AD-7's crash row). */
export function releaseDeadReconcile(p: HeldParams): LedgerEdit {
  return makeEdit("releaseDeadReconcile", p, (ctx) => {
    const w = requireReconcileWriter("releaseDeadReconcile", ctx);
    if (!w.ok) return w;
    const rec = requireStale(ctx, p.generation, ["claimed"]);
    if (!rec.ok) return rec;
    return to("released", stamp(ctx, rec.value, { state: "released", attempts: rec.value.attempts + 1 }));
  });
}

/**
 * `released → none`: a later `reconcile` run deletes a superseded `released`
 * recurring record (`reconcile:<n>` or `planning:<slug>.<n>`) at `generation`.
 */
export function deleteReleasedRecurring(p: HeldParams): LedgerEdit {
  return makeEdit("deleteReleasedRecurring", p, (ctx) => {
    const kind = unitKind(ctx.unit);
    if (kind !== "reconcile" && kind !== "planning") return bad(`deleteReleasedRecurring: ${ctx.unit} is not a recurring unit`);
    const c = requireCoordinator(ctx);
    if (!c.ok) return c;
    if (ctx.current === undefined) return ok(null);
    const s = requireState(ctx.current, ["released"]);
    if (!s.ok) return s;
    const g = requireGeneration(ctx.current, p.generation);
    if (!g.ok) return g;
    return ok({ to: "none" });
  });
}

/** The files of `files` with `commit` applied. */
function applied(files: LedgerFiles, commit: LedgerCommit): Record<string, string> {
  const out: Record<string, string> = { ...files };
  for (const path of commit.deletes) delete out[path];
  for (const [path, text] of Object.entries(commit.writes)) out[path] = text;
  return out;
}

/**
 * `edit` behind `fence`, as one commit: `fence` (a held edit of the writer's
 * own unit, such as `heartbeat`) must apply to the tip, and `edit` then
 * applies to the fenced files. The commit carries both changes under
 * `edit`'s message. Either one's error is the result; when `edit` finds the
 * tip already holding its target, nothing is written.
 */
export function fenced(fence: LedgerEdit, edit: LedgerEdit): LedgerEdit {
  return (files) => {
    const f = fence(files);
    if (!f.ok) return f;
    const e = edit(f.value === null ? files : applied(files, f.value));
    if (!e.ok || e.value === null || f.value === null) return e;
    const outer = f.value;
    const inner = e.value;
    const writes: Record<string, string> = { ...outer.writes };
    for (const path of inner.deletes) delete writes[path];
    Object.assign(writes, inner.writes);
    const deletes = [...new Set([...outer.deletes.filter((d) => !Object.hasOwn(inner.writes, d)), ...inner.deletes])];
    return ok({ message: inner.message, writes, deletes });
  };
}

/** `commit`'s changes on top of `acc`'s: a later write or delete of a path wins. */
function merged(acc: LedgerCommit, commit: LedgerCommit): LedgerCommit {
  const writes: Record<string, string> = { ...acc.writes };
  for (const path of commit.deletes) delete writes[path];
  Object.assign(writes, commit.writes);
  const deletes = [...new Set([...acc.deletes.filter((d) => !Object.hasOwn(commit.writes, d)), ...commit.deletes])];
  return { message: acc.message, writes, deletes };
}

/**
 * `edits` as one commit (Story 4.6): each applies, in order, to the files
 * the earlier ones left; their writes and deletes merge, an edit that finds
 * its target already held (`null`) adds nothing, and the first error is the
 * result. The commit carries the first change's message; with no change at
 * all, nothing is written.
 */
export function allOf(edits: readonly LedgerEdit[]): LedgerEdit {
  return (files) => {
    let current: LedgerFiles = files;
    let acc: LedgerCommit | null = null;
    for (const edit of edits) {
      const r = edit(current);
      if (!r.ok) return r;
      if (r.value === null) continue;
      current = applied(current, r.value);
      acc = acc === null ? r.value : merged(acc, r.value);
    }
    return ok(acc);
  };
}

/** Wraps a ledger edit before its swap, as `coordinatorFenced` does. */
export type LedgerFence = (edit: LedgerEdit) => LedgerEdit;

/** The `coordinator.json` holder and generation every edit of a coordinator lane is fenced on (Q5). */
export type CoordinatorFence = { readonly by: LaneIdentity; readonly generation: number };

/**
 * `edit` fenced on the coordinator claim (AD-8, Q5): it applies only while
 * `coordinator.json` at the tip is still held by `fence.by` at
 * `fence.generation`. The check is part of the same pure edit, so it costs
 * no forge call, and a coordinator that lost its claim writes nothing more,
 * even before its keeper's next beat sees the loss. A missing record,
 * another holder or another generation is a precondition error.
 */
export function coordinatorFenced(fence: CoordinatorFence, edit: LedgerEdit): LedgerEdit {
  return (files) => {
    const ledger = parseLedger(files);
    if (!ledger.ok) return ledger;
    const held = requireCoordinatorHeld(ledger.value.coordinator, fence.by, fence.generation);
    if (!held.ok) return held;
    return edit(files);
  };
}

// ---------------------------------------------------------------- coordinator.json

/** A `coordinator.json` edit's writer and time. `now` is the forge's server time. */
export type CoordinatorEditBase = {
  readonly by: LaneIdentity;
  readonly now: string;
};

type CoordinatorCtx = {
  readonly current: CoordinatorRecord | null;
  readonly by: LaneIdentity;
  readonly now: string;
};

/** The same `owner/host/lane`. */
function sameHolder(rec: CoordinatorRecord, by: LaneIdentity): boolean {
  return rec.owner === by.owner && rec.host === by.host && rec.lane === by.lane;
}

const holderOf = (rec: CoordinatorRecord) => `${rec.owner}/${rec.host}/${rec.lane}`;

/** `coordinator.json` as `by` holds it at `generation`; a missing record, another holder or another generation is a lost claim. */
function requireCoordinatorHeld(rec: CoordinatorRecord | null, by: LaneIdentity, generation: number): Step<CoordinatorRecord> {
  if (rec === null) return pre(`${COORDINATOR_PATH} is missing: the coordinator claim is lost`);
  if (!sameHolder(rec, by)) return pre(`${COORDINATOR_PATH} is held by ${holderOf(rec)}, not the writer: the coordinator claim is lost`);
  if (rec.generation !== generation) return pre(`${COORDINATOR_PATH} is at generation ${rec.generation}, expected ${generation}: the coordinator claim is lost`);
  return ok(rec);
}

/** An edit of `coordinator.json` by the coordinator lane: the record to write, `null` to write nothing, or an error. */
function makeCoordinatorEdit(name: string, base: CoordinatorEditBase, body: (ctx: CoordinatorCtx) => Step<CoordinatorRecord | null>): LedgerEdit {
  return (files) => {
    const ledger = parseLedger(files);
    if (!ledger.ok) return ledger;
    const params = check(name, BaseSchema, { by: base.by, now: base.now });
    if (!params.ok) return params;
    if (params.value.by.lane !== "coordinator") return pre(`${name}: only the coordinator lane may write ${COORDINATOR_PATH}`);
    const next = body({ current: ledger.value.coordinator, by: params.value.by, now: params.value.now });
    if (!next.ok) return next;
    if (next.value === null) return ok(null);
    const record = check(`${name} result`, CoordinatorRecordSchema, next.value);
    if (!record.ok) return record;
    return ok({ message: `ledger: ${name} coordinator [skip ci]`, writes: { [COORDINATOR_PATH]: serializeCoordinator(record.value) }, deletes: [] });
  };
}

/**
 * The writer's record at `generation`, stamped `now`, keeping the current
 * record's digest time, rulings cursor, pending rulings and dismissals.
 */
function coordinatorStamp(ctx: CoordinatorCtx, generation: number): CoordinatorRecord {
  const pending = ctx.current?.pending_rulings;
  const dismissals = ctx.current?.dismissals;
  return {
    schema_version: LEDGER_SCHEMA_VERSION,
    owner: ctx.by.owner,
    host: ctx.by.host,
    lane: "coordinator",
    generation,
    heartbeat_at: ctx.now,
    digest_posted_at: ctx.current?.digest_posted_at ?? null,
    rulings_cursor: ctx.current?.rulings_cursor ?? null,
    ...(pending === undefined ? {} : { pending_rulings: pending }),
    ...(dismissals === undefined ? {} : { dismissals }),
  };
}

/**
 * The coordinator claim (AD-8): with no record, generation 1; the writer's
 * own record, live or stale, is re-stamped at the same generation (not a
 * takeover); another identity's stale record is taken over at generation + 1,
 * keeping `digest_posted_at` and `rulings_cursor`; another identity's live
 * record is a precondition error naming its holder and heartbeat.
 */
export function claimCoordinator(p: CoordinatorEditBase): LedgerEdit {
  return makeCoordinatorEdit("claimCoordinator", p, (ctx) => {
    const rec = ctx.current;
    if (rec === null) return ok(coordinatorStamp(ctx, 1));
    if (sameHolder(rec, ctx.by)) return ok(coordinatorStamp(ctx, rec.generation));
    if (isStale(rec, ctx.now)) return ok(coordinatorStamp(ctx, rec.generation + 1));
    return pre(`${COORDINATOR_PATH} is held by ${holderOf(rec)} at generation ${rec.generation}, heartbeat ${rec.heartbeat_at}, still live at ${ctx.now}`);
  });
}

export type KeepCoordinatorParams = CoordinatorEditBase & { readonly generation: number };

/** The coordinator keeper's beat: stamps `heartbeat_at` only while the writer holds the record at `generation`. */
export function keepCoordinator(p: KeepCoordinatorParams): LedgerEdit {
  return makeCoordinatorEdit("keepCoordinator", p, (ctx) => {
    const g = check("keepCoordinator generation", Generation, p.generation);
    if (!g.ok) return g;
    const held = requireCoordinatorHeld(ctx.current, ctx.by, g.value);
    if (!held.ok) return held;
    return ok({ ...held.value, schema_version: LEDGER_SCHEMA_VERSION, heartbeat_at: ctx.now });
  });
}

export type StampDigestParams = CoordinatorEditBase & {
  readonly generation: number;
  /** Today's digest slot (`digestSlot`): a stamp at or after it means today's digest is already taken. */
  readonly slot: string;
};

/**
 * The daily digest's claim (Story 4.2): sets `digest_posted_at` to `now`,
 * the forge's time, only while the writer holds `coordinator.json` at
 * `generation` and its `digest_posted_at` is unset or before `slot`. A stamp
 * already at or after `slot` refuses, so at most one run a day posts the
 * digest's mentions.
 */
export function stampDigest(p: StampDigestParams): LedgerEdit {
  return makeCoordinatorEdit("stampDigest", p, (ctx) => {
    const g = check("stampDigest generation", Generation, p.generation);
    if (!g.ok) return g;
    const slot = check("stampDigest slot", IsoDateTime, p.slot);
    if (!slot.ok) return slot;
    const held = requireCoordinatorHeld(ctx.current, ctx.by, g.value);
    if (!held.ok) return held;
    const rec = held.value;
    if (rec.digest_posted_at !== null && Date.parse(rec.digest_posted_at) >= Date.parse(slot.value)) {
      return pre(`${COORDINATOR_PATH}: the digest was already posted at ${rec.digest_posted_at}, at or after today's slot ${slot.value}`);
    }
    return ok({ ...rec, schema_version: LEDGER_SCHEMA_VERSION, digest_posted_at: ctx.now });
  });
}

export type AdvanceRulingsCursorParams = CoordinatorEditBase & {
  readonly generation: number;
  /** The cursor the rulings were read from: `coordinator.json`'s `rulings_cursor` in the run's snapshot. */
  readonly from: string | null;
  /** The forge's cursor past the last comment read. */
  readonly to: string;
};

/**
 * The rulings cursor (Story 4.5, AD-28): sets `rulings_cursor` to `to` only
 * while the writer holds `coordinator.json` at `generation` and its cursor
 * is still `from`, keeping every other field. A cursor another run moved
 * (even to `to` itself) refuses, so two runs that read the same comments
 * never both answer them. Since Story 4.6 the rulings step writes
 * `recordRulings`, which moves the cursor the same way alongside the
 * batch's effects.
 */
export function advanceRulingsCursor(p: AdvanceRulingsCursorParams): LedgerEdit {
  return makeCoordinatorEdit("advanceRulingsCursor", p, (ctx) => {
    const g = check("advanceRulingsCursor generation", Generation, p.generation);
    if (!g.ok) return g;
    const from = check("advanceRulingsCursor from", NonEmpty.nullable(), p.from);
    if (!from.ok) return from;
    const to = check("advanceRulingsCursor to", NonEmpty, p.to);
    if (!to.ok) return to;
    const held = requireCoordinatorHeld(ctx.current, ctx.by, g.value);
    if (!held.ok) return held;
    const rec = held.value;
    if (rec.rulings_cursor !== from.value) {
      return pre(`${COORDINATOR_PATH}: rulings_cursor is ${JSON.stringify(rec.rulings_cursor)}, not ${JSON.stringify(from.value)}: another run read these rulings`);
    }
    return ok({ ...rec, schema_version: LEDGER_SCHEMA_VERSION, rulings_cursor: to.value });
  });
}

/** `coordinator.json`'s two Story 4.6 lists. */
export type RulingLists = { readonly pending: readonly PendingRuling[]; readonly dismissals: readonly Dismissal[] };

/** Entries to drop from, or add to, the two lists; a list left out is empty. */
export type RulingListsChange = { readonly pending?: readonly PendingRuling[]; readonly dismissals?: readonly Dismissal[] };

const samePending = (a: PendingRuling, b: PendingRuling): boolean => a.verb === b.verb && a.unit === b.unit && a.by === b.by && a.at === b.at && a.ruling === b.ruling;
const sameDismissal = (a: Dismissal, b: Dismissal): boolean => a.unit === b.unit && a.subject === b.subject && a.since === b.since;

/**
 * The lists with `drop`'s entries removed (each matched whole), then
 * `add`'s appended in order: a pending entry replaces any entry with the
 * same unit and family (`pendingKey`), a dismissal any dismissal of the
 * same unit. Pure.
 */
export function changeRulingLists(current: RulingLists, drop: RulingListsChange = {}, add: RulingListsChange = {}): RulingLists {
  let pending = current.pending.filter((e) => !(drop.pending ?? []).some((d) => samePending(d, e)));
  let dismissals = current.dismissals.filter((e) => !(drop.dismissals ?? []).some((d) => sameDismissal(d, e)));
  for (const e of add.pending ?? []) pending = [...pending.filter((x) => pendingKey(x) !== pendingKey(e)), e];
  for (const d of add.dismissals ?? []) dismissals = [...dismissals.filter((x) => x.unit !== d.unit), d];
  return { pending, dismissals };
}

/** A record's two lists, empty when absent. */
export function rulingListsOf(rec: CoordinatorRecord | null): RulingLists {
  return { pending: rec?.pending_rulings ?? [], dismissals: rec?.dismissals ?? [] };
}

export type RecordRulingsParams = CoordinatorEditBase & {
  readonly generation: number;
  /** Moves `rulings_cursor` from `from` (refused unless it is still there) to `to`; absent leaves it. */
  readonly cursor?: { readonly from: string | null; readonly to: string };
  /** Entries to drop, each matched whole. */
  readonly drop?: RulingListsChange;
  /** Entries to add, superseding as `changeRulingLists` does. */
  readonly add?: RulingListsChange;
};

const PendingList = z.array(PendingRulingSchema);
const DismissalList = z.array(DismissalSchema);

/**
 * The rulings' `coordinator.json` write (Story 4.6, AD-28): only while the
 * writer holds `coordinator.json` at `generation`, it moves `rulings_cursor`
 * when `cursor` is given (refused unless the cursor is still `from`), drops
 * the listed entries and adds the new ones (`changeRulingLists`), keeping
 * every other field. It writes nothing when nothing changes.
 */
export function recordRulings(p: RecordRulingsParams): LedgerEdit {
  return makeCoordinatorEdit("recordRulings", p, (ctx) => {
    const g = check("recordRulings generation", Generation, p.generation);
    if (!g.ok) return g;
    let to: string | null = null;
    let from: string | null = null;
    if (p.cursor !== undefined) {
      const f = check("recordRulings cursor.from", NonEmpty.nullable(), p.cursor.from);
      if (!f.ok) return f;
      const t = check("recordRulings cursor.to", NonEmpty, p.cursor.to);
      if (!t.ok) return t;
      from = f.value;
      to = t.value;
    }
    const lists: Record<string, readonly unknown[] | undefined> = {
      "drop.pending": p.drop?.pending,
      "drop.dismissals": p.drop?.dismissals,
      "add.pending": p.add?.pending,
      "add.dismissals": p.add?.dismissals,
    };
    for (const [label, list] of Object.entries(lists)) {
      if (list === undefined) continue;
      const c = check(`recordRulings ${label}`, label.endsWith("pending") ? PendingList : DismissalList, list);
      if (!c.ok) return c;
    }
    const held = requireCoordinatorHeld(ctx.current, ctx.by, g.value);
    if (!held.ok) return held;
    const rec = held.value;
    if (p.cursor !== undefined && rec.rulings_cursor !== from) {
      return pre(`${COORDINATOR_PATH}: rulings_cursor is ${JSON.stringify(rec.rulings_cursor)}, not ${JSON.stringify(from)}: another run read these rulings`);
    }
    const before = rulingListsOf(rec);
    const after = changeRulingLists(before, p.drop, p.add);
    const cursor = to ?? rec.rulings_cursor;
    if (cursor === rec.rulings_cursor && Bun.deepEquals(after, before, true)) return ok(null);
    const { pending_rulings: _p, dismissals: _d, ...rest } = rec;
    return ok({
      ...rest,
      schema_version: LEDGER_SCHEMA_VERSION,
      rulings_cursor: cursor,
      ...(after.pending.length === 0 ? {} : { pending_rulings: [...after.pending] }),
      ...(after.dismissals.length === 0 ? {} : { dismissals: [...after.dismissals] }),
    });
  });
}

export type CoordinatorClaimState = "live" | "missing" | "expired";

/** The coordinator claim at `now` (the forge's time): live, missing, or expired (stale). */
export function coordinatorClaimState(record: CoordinatorRecord | null, now: string): CoordinatorClaimState {
  if (record === null) return "missing";
  return isStale(record, now) ? "expired" : "live";
}
