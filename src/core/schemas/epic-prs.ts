import { z } from "zod";
import { StoryId } from "../story-id.ts";
import { IsoDateTime, SchemaVersion } from "./common.ts";
import { GitSha } from "./ledger.ts";

/**
 * The prefetched PR history of one Epic (Story 2.9, AR15): what a retro
 * session reads from `<tmp>/epic-<N>-prs.json` instead of GitHub. The PRs
 * are those on the Epic's Story branches, each with its reviews; the runner
 * writes the file and checks it against this schema first.
 */

export const EpicPrReviewSchema = z.strictObject({
  /** `null` for a deleted account. */
  author: z.string().nullable(),
  state: z.enum(["approved", "changes_requested", "commented", "dismissed", "pending"]),
  /** `null` while pending. */
  submitted_at: IsoDateTime.nullable(),
  commit_sha: GitSha.nullable(),
});

export const EpicPrSchema = z.strictObject({
  story: StoryId,
  number: z.int().min(1),
  title: z.string(),
  body: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  head_sha: GitSha,
  /** The commit the merge made on `main`; `null` unless the PR merged. */
  merge_sha: GitSha.nullable(),
  reviews: z.array(EpicPrReviewSchema),
});

export const EpicPrsSchema = z.strictObject({
  schema_version: SchemaVersion,
  epic: z.int().positive(),
  prs: z.array(EpicPrSchema),
});

export type EpicPrReview = z.infer<typeof EpicPrReviewSchema>;
export type EpicPr = z.infer<typeof EpicPrSchema>;
export type EpicPrs = z.infer<typeof EpicPrsSchema>;
