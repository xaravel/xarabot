import { z } from "zod";
import type { ResolvedGraph } from "../graph/resolve-graph.ts";
import { StoryId } from "../story-id.ts";
import { IsoDateTime, NonEmpty } from "./common.ts";
import { ConfigSchema } from "./config.ts";
import { EpicKey } from "./epics-yaml.ts";
import { LaneRole as HostLaneRole } from "./host.ts";
import type { Manifest } from "./manifest.ts";
import { CoordinatorRecordSchema, GitSha, LaneIdentity, UnitId, UnitRecordSchema } from "./ledger.ts";
import { PolicySchema } from "./policy.ts";
import { RetroGatesSchema } from "./retro-gates.ts";
import { StandingAuthorityFrontmatterSchema } from "./standing-authority.ts";

/** A lane's role: `builder` or `coordinator` (the host layer's enum). */
export const LaneRole = HostLaneRole;
export type LaneRole = z.infer<typeof LaneRole>;

const ManifestPathsSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("globs"), globs: z.array(z.string()) }),
  z.strictObject({ kind: z.literal("key"), key: NonEmpty, value: NonEmpty }),
]);

/** A parsed Story manifest plus `sha`, its git blob SHA on `main`. */
export const SnapshotManifestSchema = z.strictObject({
  path: NonEmpty,
  story_id: StoryId,
  epic: z.int().positive(),
  sprint_key: NonEmpty,
  title: NonEmpty,
  paths: ManifestPathsSchema,
  depends_on: z.array(StoryId),
  infrastructure: z.boolean(),
  sha: GitSha,
});

/** The `resolveGraph` value. */
export const ResolvedGraphSchema = z.strictObject({
  epics: z.array(
    z.strictObject({
      number: z.int().positive(),
      title: z.string(),
      depends_on: z.array(z.int().positive()),
      checkpoint: z.boolean(),
      stories: z.array(StoryId),
    }),
  ),
  edges: z.array(z.strictObject({ from: z.int().positive(), to: z.int().positive() })),
  checkpoints: z.array(z.int().positive()),
  unmanifested: z.array(z.strictObject({ id: StoryId, epic: z.int().positive(), line: z.int().min(1) })),
  retroGates: RetroGatesSchema,
  hash: NonEmpty,
});

/** The `resolveGraph` result as data: a graph failure stops `next`, not the assembler. */
export const GraphResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: ResolvedGraphSchema }),
  z.strictObject({ ok: z.literal(false), error: z.strictObject({ kind: NonEmpty, message: z.string() }) }),
]);

export const EPIC_CONTEXT_STATES = ["valid", "missing", "empty", "wrong-heading"] as const;
export const EpicContextState = z.enum(EPIC_CONTEXT_STATES);

/** The review states that decide a PR: GitHub's `latestOpinionatedReviews` ones. */
export const PR_REVIEW_DECISIONS = ["approved", "changes_requested", "dismissed"] as const;

/**
 * One reviewer's latest decisive review of a PR, from the snapshot's own PR
 * read (Story 2.4, retro item 13). `author` is `null` for a deleted account.
 */
export const PrReviewSchema = z.strictObject({
  author: NonEmpty.nullable(),
  state: z.enum(PR_REVIEW_DECISIONS),
  commit_sha: GitSha.nullable(),
  submitted_at: IsoDateTime,
});

/**
 * A unit's PR as the forge reports it. `reviews`: each reviewer's latest
 * decisive review, in the forge's order; absent when the forge did not read
 * them.
 */
export const PrStateSchema = z.strictObject({
  number: z.int().min(1),
  state: z.enum(["open", "closed", "merged"]),
  head_sha: GitSha,
  reviews: z.array(PrReviewSchema).optional(),
});

/** Everything `next` reads, from one `main` SHA and one ledger tip (AR28). */
export const SnapshotSchema = z.strictObject({
  now: IsoDateTime,
  main_sha: GitSha,
  ledger: z.strictObject({
    tip: GitSha,
    units: z
      .array(UnitRecordSchema)
      .refine((units) => units.every((u, i) => i === 0 || (units[i - 1] as { unit: string }).unit < u.unit), {
        message: "must be sorted by unit, each unit once",
      }),
    coordinator: CoordinatorRecordSchema.nullable(),
  }),
  config: ConfigSchema,
  policy: PolicySchema.extend({ effective_protected_paths: z.array(NonEmpty) }),
  standing_authority: z.strictObject({ frontmatter: StandingAuthorityFrontmatterSchema, body: z.string() }),
  manifests: z.array(SnapshotManifestSchema),
  graph: GraphResultSchema,
  sprint_status: z.strictObject({ development_status: z.record(z.string(), z.string()) }),
  retro_gates: RetroGatesSchema,
  escalations: z.strictObject({ open: z.array(StoryId) }).nullable(),
  epic_context: z.record(EpicKey, EpicContextState),
  /** Each graph Epic: whether a `main` path matches `live_evidence_glob` with `<N>` set to it (Story 2.9). */
  live_evidence: z.record(EpicKey, z.boolean()),
  /**
   * Each graph Epic whose live evidence file is on `main` and was read: the
   * first matching path in path order, and its text (retro item 14).
   */
  live_evidence_file: z.record(EpicKey, z.strictObject({ path: NonEmpty, text: z.string() })),
  prs: z.record(UnitId, PrStateSchema),
  lane: LaneIdentity,
  role: LaneRole,
});

export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;
export type ResolvedGraphData = z.infer<typeof ResolvedGraphSchema>;
export type GraphResult = z.infer<typeof GraphResultSchema>;
export type EpicContextState = z.infer<typeof EpicContextState>;
export type PrReview = z.infer<typeof PrReviewSchema>;
export type PrState = z.infer<typeof PrStateSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type SnapshotInput = z.input<typeof SnapshotSchema>;

/*
 * Compile-time drift checks: the hand-written schemas above must stay
 * mutually assignable with the core types they mirror (`ResolvedGraph`,
 * `Manifest` plus `sha`), so a field added to either side fails `tsc`.
 */
type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
type Assignable<A extends B, B> = [A, B];
type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false;
type True<T extends true> = T;
type _SnapshotDriftChecks = [
  Assignable<ResolvedGraphData, ResolvedGraph>,
  Assignable<ResolvedGraph, DeepReadonly<ResolvedGraphData>>,
  True<SameKeys<ResolvedGraphData, ResolvedGraph>>,
  True<SameKeys<ResolvedGraphData["epics"][number], ResolvedGraph["epics"][number]>>,
  True<SameKeys<ResolvedGraphData["unmanifested"][number], ResolvedGraph["unmanifested"][number]>>,
  Assignable<SnapshotManifest, Manifest & { readonly sha: string }>,
  Assignable<Manifest & { readonly sha: string }, DeepReadonly<SnapshotManifest>>,
  True<SameKeys<SnapshotManifest, Manifest & { readonly sha: string }>>,
];
