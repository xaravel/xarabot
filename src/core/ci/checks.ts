/**
 * CI check classification and poll back-off (FR6, AR20). Pure: the CI step
 * polls a head's checks by hand, never with `--watch`, and stops at the first
 * unexpected failure.
 */

/** The conclusions that count as a pass. */
export const PASSING_CONCLUSIONS = ["success", "neutral", "skipped"] as const;

/** One check run as the forge reports it. */
export type CheckRun = {
  readonly name: string;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion: string | null;
};

export type CheckClass =
  | { readonly kind: "pending" }
  | { readonly kind: "passed" }
  /** `failing`: the unexpected failing check names, in report order, each once. */
  | { readonly kind: "failed"; readonly failing: readonly string[] };

/** The first poll's delay. */
export const FIRST_POLL_DELAY_MS = 30_000;
/** The longest delay between polls. */
export const MAX_POLL_DELAY_MS = 300_000;

function passes(conclusion: string | null): boolean {
  return conclusion !== null && (PASSING_CONCLUSIONS as readonly string[]).includes(conclusion);
}

/**
 * `pending` for an empty list or while any check runs, `failed` as soon as a
 * completed check outside `expected` has a non-passing conclusion (even while
 * others run), `passed` once every check completed with no unexpected failure.
 */
export function classifyChecks(checks: readonly CheckRun[], expected: readonly string[]): CheckClass {
  if (checks.length === 0) return { kind: "pending" };
  const failing: string[] = [];
  let running = false;
  for (const c of checks) {
    if (c.status !== "completed") {
      running = true;
      continue;
    }
    if (passes(c.conclusion) || expected.includes(c.name)) continue;
    if (!failing.includes(c.name)) failing.push(c.name);
  }
  if (failing.length > 0) return { kind: "failed", failing };
  return running ? { kind: "pending" } : { kind: "passed" };
}

/** The sleep before poll `n + 1`: 30 s after poll 0, doubling each poll, capped at 5 min. */
export function pollDelayMs(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return FIRST_POLL_DELAY_MS;
  // Past 4 doublings the cap holds; avoid huge powers.
  if (n >= 4) return MAX_POLL_DELAY_MS;
  return Math.min(MAX_POLL_DELAY_MS, FIRST_POLL_DELAY_MS * 2 ** Math.floor(n));
}
