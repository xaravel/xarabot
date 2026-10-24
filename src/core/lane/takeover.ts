import type { PrState } from "../schemas/snapshot.ts";

/**
 * A stale builder-held `merging` record's takeover (FR3, AR7, AR10). Pure.
 */

/** What becomes of a stale `merging` record. */
export type StaleMergingAction = "merged" | "take-over" | "release";

/** A PR as the merge queue sees it: its state and whether it is queued. */
export type QueueView = { readonly state: PrState["state"]; readonly queued: boolean };

/**
 * Decides a stale `merging` record by its PR's queue state: a merged PR is
 * marked `merged`; an open PR still in the queue is taken over and watched;
 * any other (open and not queued, closed, or `not-found`) is released.
 */
export function staleMergingAction(q: QueueView | "not-found"): StaleMergingAction {
  if (q === "not-found") return "release";
  if (q.state === "merged") return "merged";
  if (q.state === "open" && q.queued) return "take-over";
  return "release";
}
