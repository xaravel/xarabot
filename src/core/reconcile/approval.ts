/**
 * The standing-approval rule (FR13, AR8, AR17, AD-14): whether a parked PR's
 * owner has an approval standing on its current head. Pure.
 *
 * Only the owner's reviews count (logins compared case-insensitively). With
 * a `parkedAt` time (a coordinator-written re-park), only reviews submitted
 * strictly after it count; with `null` (a builder's first park), any review
 * does, including one given while CI still ran. Of those, the decisive ones
 * are `approved`, `changes_requested` and `dismissed`; the latest decisive
 * one (by `submitted_at`, ties by list order) must be `approved`, on `head`.
 * `commented` and `pending` reviews, and reviews with no `submitted_at`,
 * never count.
 */

const DECISIVE: readonly string[] = ["approved", "changes_requested", "dismissed"];

/** A review as the rule reads it: the shape of the `Forge` port's `ForgeReview`, which `core` may not import. */
export type ApprovalReview = {
  readonly author: string | null;
  readonly state: string;
  readonly commit_sha: string | null;
  readonly submitted_at: string | null;
};

export type ApprovalQuery = {
  /** The PR owner's login (`pr_owner`). */
  readonly owner: string;
  /** The PR's current head, which the approval must be on. */
  readonly head: string;
  /**
   * The re-park's time (the parked record's `heartbeat_at`): only reviews
   * submitted after it count. `null`: no time filter. A value that does not
   * parse matches nothing.
   */
  readonly parkedAt: string | null;
};

/** The owner's standing approval of `head` (submitted after `parkedAt` when set), or `null`. */
export function standingApproval<R extends ApprovalReview>(reviews: readonly R[], q: ApprovalQuery): R | null {
  const owner = q.owner.toLowerCase();
  const parkedAt = q.parkedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(q.parkedAt);
  if (Number.isNaN(parkedAt)) return null;
  let latest: { readonly review: R; readonly at: number } | null = null;
  for (const review of reviews) {
    if (review.author === null || review.author.toLowerCase() !== owner) continue;
    if (!DECISIVE.includes(review.state) || review.submitted_at === null) continue;
    const at = Date.parse(review.submitted_at);
    if (!Number.isFinite(at) || at <= parkedAt) continue;
    // A tie goes to the later review in the list.
    if (latest === null || at >= latest.at) latest = { review, at };
  }
  if (latest === null) return null;
  return latest.review.state === "approved" && latest.review.commit_sha === q.head ? latest.review : null;
}
