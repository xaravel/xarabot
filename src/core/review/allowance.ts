import { unattendedRefusal } from "../lane/runner.ts";
import type { Policy } from "../schemas/policy.ts";
import { chooseReviewer } from "./reviewer.ts";

/**
 * The allowance re-check before each session and enqueue (Story 3.5, AD-16,
 * AD-21), pure: a lane whose agent the policy no longer allows unattended,
 * or a unit no allowed adapter can review, gets no further session and no
 * enqueue.
 */

/**
 * Why `agent` may not go on with a unit built by `builderProviders` under
 * `policy`: the `unattendedRefusal` text when the policy does not allow the
 * agent unattended; else a reason when `chooseReviewer` finds no reviewer
 * among the allowed adapters; else `null`.
 */
export function allowanceRefusal(
  policy: Pick<Policy, "unattended_adapters">,
  agent: string,
  builderProviders: readonly string[],
): string | null {
  const refused = unattendedRefusal(policy, agent);
  if (!refused.ok) return refused.error.message;
  if (chooseReviewer(builderProviders, policy.unattended_adapters) === null) {
    return "no reviewer: .xarabot/policy.yaml unattended_adapters allows neither claude nor codex";
  }
  return null;
}
