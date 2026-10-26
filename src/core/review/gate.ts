/**
 * The review loop's decision after a round (Story 3.5, FR8, AR20), pure. A
 * blocking round loops the findings back to the builder, at most
 * `LOOPBACK_CAP` times; a blocking round after the last loopback parks the
 * unit `review-cap`. The cap stops a third loopback, never a pass: a round
 * with no blocking pass passes at any loopback count.
 */

/** Review loopbacks a unit gets before a blocking round parks it `review-cap`. */
export const LOOPBACK_CAP = 2;

export type ReviewNext = "pass" | "loopback" | "cap";

/**
 * After a round: `pass` when it is not blocking; else `cap` once
 * `loopbacks` reached `LOOPBACK_CAP`; else `loopback`.
 */
export function reviewNext(p: { readonly loopbacks: number; readonly blocking: boolean }): ReviewNext {
  if (!p.blocking) return "pass";
  return p.loopbacks >= LOOPBACK_CAP ? "cap" : "loopback";
}
