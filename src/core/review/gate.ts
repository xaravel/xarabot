/**
 * The review loop's decision after a round (Story 3.5, FR8, AR20), pure. A
 * blocking round loops the findings back to the builder, at most
 * `LOOPBACK_CAP` times; the round after the last loopback parks the unit
 * `review-cap`, whatever its verdict.
 */

/** Review loopbacks a unit gets before it parks `review-cap`. */
export const LOOPBACK_CAP = 2;

export type ReviewNext = "pass" | "loopback" | "cap";

/**
 * After a round: `cap` once `loopbacks` reached `LOOPBACK_CAP`, whatever the
 * verdict; else `loopback` for a blocking round; else `pass`.
 */
export function reviewNext(p: { readonly loopbacks: number; readonly blocking: boolean }): ReviewNext {
  if (p.loopbacks >= LOOPBACK_CAP) return "cap";
  return p.blocking ? "loopback" : "pass";
}
