import { z } from "zod";
import { normalizeGlob } from "../manifests/globs.ts";
import { STORY_ID_PATTERN } from "../story-id.ts";
import { GitHubLogin, IsoDateTime, NonEmpty } from "./common.ts";
import { RETRO_ITEM_ID_PATTERN, RetroRecordResultSchema } from "./retro-gates.ts";

/**
 * The `xarabot/claims` ledger records (AR5, AR6, AR35): unit ids and their
 * file names, unit records and `coordinator.json`.
 */

/**
 * The ledger's own `schema_version` (Story 2.7; 3 since Story 2.8 added
 * `approved_graph`, 4 since Story 2.9 added `retro_result`, 5 since Story 3.5
 * added `enqueued_sha`, which retro item 24's `park.graph_posted` shares, 6
 * since Story 4.2 added `park.text`): every record written carries it; the
 * reader accepts each of `LEDGER_SCHEMA_VERSIONS`. The other versioned files
 * keep `SCHEMA_VERSION` (1).
 */
export const LEDGER_SCHEMA_VERSION = 6;

/** The ledger `schema_version`s this runner reads. */
export const LEDGER_SCHEMA_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, LEDGER_SCHEMA_VERSION];

export const LedgerSchemaVersion = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(LEDGER_SCHEMA_VERSION),
]);

/** The longest `park.text` (Story 4.2), in UTF-16 code units. */
export const PARK_TEXT_MAX = 4_000;

/** A `resolveGraph` hash: `sha256:` and 64 lowercase hex digits. */
export const GraphHash = z.string().regex(/^sha256:[0-9a-f]{64}$/, "must be sha256: and 64 lowercase hex digits");

const POSITIVE = /^[1-9][0-9]*$/;
const PLANNING_BODY = /^[a-z0-9]+(?:-[a-z0-9]+)*\.([1-9][0-9]*)$/;

export const UNIT_KINDS = ["story", "retro", "retro-item", "checkpoint", "planning", "reconcile"] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

const UNIT_BODY: Readonly<Record<UnitKind, RegExp>> = {
  story: STORY_ID_PATTERN,
  retro: POSITIVE,
  "retro-item": RETRO_ITEM_ID_PATTERN,
  checkpoint: POSITIVE,
  planning: PLANNING_BODY,
  reconcile: POSITIVE,
};

/** The kind of a unit id, or `undefined` when the id is not one. */
export function unitKind(id: string): UnitKind | undefined {
  const i = id.indexOf(":");
  if (i === -1) return undefined;
  const kind = UNIT_KINDS.find((k) => k === id.slice(0, i));
  if (kind === undefined) return undefined;
  return UNIT_BODY[kind].test(id.slice(i + 1)) ? kind : undefined;
}

export function isUnitId(id: string): boolean {
  return unitKind(id) !== undefined;
}

/** The pseudo-glob a graph planning unit holds, so graph changes go one at a time (AD-11). */
export const GRAPH_PSEUDO_GLOB = "xarabot:graph";

/** The two planning kinds (Story 2.7): `planning:status.<n>` and `planning:graph.<n>`. */
export type PlanningKind = "status" | "graph";

/** The slug of a `planning:<slug>.<n>` id, or `null` when the id is not a planning unit. */
export function planningSlug(unit: string): string | null {
  if (unitKind(unit) !== "planning") return null;
  const body = unit.slice(unit.indexOf(":") + 1);
  return body.slice(0, body.lastIndexOf("."));
}

/**
 * A planning record's kind, from its slug: `status` and `graph` name
 * themselves; any other slug counts as graph when the record holds
 * `xarabot:graph`, else as status. `null` for a record that is not planning.
 */
export function planningKindOf(record: { readonly unit: string; readonly globs: readonly string[] }): PlanningKind | null {
  const slug = planningSlug(record.unit);
  if (slug === null) return null;
  if (slug === "status" || slug === "graph") return slug;
  return record.globs.includes(GRAPH_PSEUDO_GLOB) ? "graph" : "status";
}

export const UnitId = z
  .string()
  .refine(
    isUnitId,
    "must be a unit id: story:<id>, retro:<N>, retro-item:<id>, checkpoint:<N>, planning:<slug>.<n> or reconcile:<n>",
  );

const UNITS_DIR = "units/";

/** A unit's ledger file name: the id with `:` replaced by `__`, plus `.json`. */
export function unitFileName(id: string): string {
  return `${id.replaceAll(":", "__")}.json`;
}

/** A unit's ledger path, `units/<file name>`. */
export function unitPath(id: string): string {
  return `${UNITS_DIR}${unitFileName(id)}`;
}

/** The unit id a ledger path names, or `undefined` when the path is not a unit file. */
export function unitFromPath(path: string): string | undefined {
  if (!path.startsWith(UNITS_DIR) || !path.endsWith(".json")) return undefined;
  const name = path.slice(UNITS_DIR.length, -".json".length);
  const id = name.replace("__", ":");
  return isUnitId(id) && unitPath(id) === path ? id : undefined;
}

/** A lane name: `coordinator` or `builder-<n>`. */
export const LaneName = z
  .string()
  .regex(/^(?:coordinator|builder-[1-9][0-9]*)$/, 'must be "coordinator" or "builder-<n>"');

/** Who writes a record: the lane's owner, host and lane name. */
export const LaneIdentity = z.strictObject({
  owner: GitHubLogin,
  host: z.uuid(),
  lane: LaneName,
});

/** A full git SHA: 40 (SHA-1) or 64 (SHA-256) lowercase hex digits. */
export const GitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "must be a 40- or 64-digit lowercase hex git SHA");

/** A glob already in normalized form. */
export const NormalizedGlob = z.string().refine((g) => {
  const n = normalizeGlob(g);
  return n.ok && n.value === g;
}, "must be a normalized repo-relative glob");

export const UNIT_STATES = ["claimed", "merging", "parked", "released", "merged"] as const;
export const PARK_KINDS = ["awaiting-approval", "needs-approval", "blocked"] as const;
export const BLOCKED_KINDS = ["escalation", "human-live-step", "intent-gap", "verification", "other"] as const;
export const RUNNER_CAUSES = [
  "review-cap",
  "ci-fix-cap",
  "ci-timeout",
  "write-check",
  "no-op",
  "attempts-cap",
  "unclaimable",
  "graph-invalid",
  "readiness",
  "review-findings",
] as const;

export const UnitState = z.enum(UNIT_STATES);
export const ParkKind = z.enum(PARK_KINDS);
export const ParkReason = z.enum([...BLOCKED_KINDS, ...RUNNER_CAUSES]);

export const ParkSchema = z
  .strictObject({
    kind: ParkKind,
    reason: ParkReason.nullable(),
    inbox_owner: GitHubLogin,
    globs_held: z.array(NormalizedGlob),
    /**
     * The graph hash of the delta the runner last posted on the PR (retro
     * item 24, AD-11): a graph change is taken only at this hash, on an
     * approval submitted after it was posted. Absent when none was posted.
     */
    graph_posted: GraphHash.optional(),
    /**
     * The blocked session's own words (Story 4.2): a build result's
     * `blocked.text` or a planning unit's readiness summary, sanitized and
     * capped at `PARK_TEXT_MAX`, which the owner's inbox shows under the
     * item. Absent when the park has none.
     */
    text: z.string().max(PARK_TEXT_MAX).optional(),
  })
  .refine((p) => (p.kind === "blocked") === (p.reason !== null), {
    message: "reason is required when kind is blocked and must be null otherwise",
    path: ["reason"],
  })
  .refine((p) => p.kind === "awaiting-approval" || p.graph_posted === undefined, {
    message: "graph_posted is only for an awaiting-approval park",
    path: ["graph_posted"],
  });

export const ApprovalSchema = z.strictObject({
  by: GitHubLogin,
  manifest_sha: GitSha,
});

const Count = z.int().min(0);

/** One unit's record, `units/<file>.json` (AR6). Keys are in serialization order. */
export const UnitRecordSchema = z
  .strictObject({
    schema_version: LedgerSchemaVersion,
    unit: UnitId,
    state: UnitState,
    owner: GitHubLogin,
    host: z.uuid(),
    lane: LaneName,
    generation: z.int().min(1),
    globs: z.array(NormalizedGlob),
    heartbeat_at: IsoDateTime,
    pr: z.int().min(1).nullable(),
    pr_owner: GitHubLogin.nullable(),
    base_sha: GitSha.nullable(),
    head_sha: GitSha.nullable(),
    reviewed_sha: GitSha.nullable(),
    /** The head a review round with no blocking pass passed (Story 3.5: only a review round sets it). */
    passed_sha: GitSha.nullable(),
    /**
     * The head the runner enqueued the PR at, or fenced before re-parking a
     * taken record (Story 3.5), or at a re-park with a new graph delta (retro
     * item 24); a v1 to v4 record reads with the mapping in `codec.ts`.
     */
    enqueued_sha: GitSha.nullable().default(null),
    approved_sha: GitSha.nullable(),
    /** The merge result's graph hash the Maintainer approved (Story 2.8); a v1 or v2 record without it reads as `null`. */
    approved_graph: GraphHash.nullable().default(null),
    /** A retro unit's validated session result, carried to the merge for `reconcile` (Story 2.9); a v1 to v3 record without it reads as `null`. */
    retro_result: RetroRecordResultSchema.nullable().default(null),
    builder_providers: z.array(NonEmpty),
    park: ParkSchema.nullable(),
    attempts: Count,
    loopbacks: Count,
    ci_fixes: Count,
    approval: ApprovalSchema.nullable(),
  })
  .refine((r) => (r.state === "parked") === (r.park !== null), {
    message: "park must be set exactly when state is parked",
    path: ["park"],
  });

/** The verbs whose ruling waits in `coordinator.json` until `main`'s `retro-gates.yaml` shows it (Story 4.6). */
export const PENDING_RULING_VERBS = ["go", "block", "unblock", "done", "defer"] as const;
export type PendingRulingVerb = (typeof PENDING_RULING_VERBS)[number];

/**
 * A `retro-gates.yaml` ruling acknowledged and not yet shown on `main`
 * (Story 4.6, Maintainer decision 1): `go` on a `checkpoint:<N>` or
 * `retro:<N>`, the other verbs on a `retro-item:<id>`. `by` ruled it at
 * `at` (the comment's `created_at`, or the host's snapshot time), and
 * `ruling` is the comment id (`xarabot-rule` from the host).
 */
export const PendingRulingSchema = z
  .strictObject({
    verb: z.enum(PENDING_RULING_VERBS),
    unit: UnitId,
    by: GitHubLogin,
    at: IsoDateTime,
    ruling: NonEmpty,
  })
  .refine((e) => {
    const kind = unitKind(e.unit);
    return e.verb === "go" ? kind === "checkpoint" || kind === "retro" : kind === "retro-item";
  }, { message: "go takes a checkpoint:<N> or retro:<N> unit; block, unblock, done and defer take a retro-item:<id> unit", path: ["unit"] });

/**
 * A dismissed inbox item (Story 4.6, Maintainer decision 2): the unit and
 * the instance dismissed, its inbox text (`subject`) and start time
 * (`since`, `null` when nothing dates it).
 */
export const DismissalSchema = z.strictObject({
  unit: UnitId,
  subject: NonEmpty,
  since: IsoDateTime.nullable(),
});

/** A pending ruling's family: a later ruling of one family replaces an earlier one on the same unit. */
export function pendingFamily(verb: PendingRulingVerb): "go" | "block" | "done" {
  if (verb === "go") return "go";
  return verb === "block" || verb === "unblock" ? "block" : "done";
}

/** The supersede key of a pending ruling: its family and unit. */
export function pendingKey(entry: { readonly verb: PendingRulingVerb; readonly unit: string }): string {
  return `${pendingFamily(entry.verb)} ${entry.unit}`;
}

/**
 * `coordinator.json`. `pending_rulings` and `dismissals` (Story 4.6, ledger
 * version 6) are optional, and written only when non-empty, so an older
 * record and its text are unchanged.
 */
export const CoordinatorRecordSchema = z.strictObject({
  schema_version: LedgerSchemaVersion,
  owner: GitHubLogin,
  host: z.uuid(),
  lane: z.literal("coordinator"),
  generation: z.int().min(1),
  heartbeat_at: IsoDateTime,
  digest_posted_at: IsoDateTime.nullable(),
  rulings_cursor: NonEmpty.nullable(),
  pending_rulings: z.array(PendingRulingSchema).optional(),
  dismissals: z.array(DismissalSchema).optional(),
});

export type LaneIdentity = z.infer<typeof LaneIdentity>;
export type UnitState = z.infer<typeof UnitState>;
export type ParkKind = z.infer<typeof ParkKind>;
export type ParkReason = z.infer<typeof ParkReason>;
export type Park = z.infer<typeof ParkSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type UnitRecord = z.infer<typeof UnitRecordSchema>;
export type CoordinatorRecord = z.infer<typeof CoordinatorRecordSchema>;
export type PendingRuling = z.infer<typeof PendingRulingSchema>;
export type Dismissal = z.infer<typeof DismissalSchema>;
