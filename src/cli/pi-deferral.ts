import { POLICY_PATH } from "../core/config/load-repo-config.ts";
import { err, ok, type Result } from "../core/result.ts";
import type { AdapterName, Policy } from "../core/schemas/policy.ts";

/**
 * The `pi` adapter's deferral (Story 3.2, FR7, AR34): 0.x has no `pi`
 * adapter, so `lane install` and `lane run` refuse a `pi` lane and a policy
 * whose only reviewer would be `pi`, each naming this text.
 */
export const PI_DEFERRAL = "the `pi` adapter is deferred to v1: stock pi 1.4.0 gives `bmad-build-auto` no subagents";

/** The agents 0.x can compose a session for: every adapter name but `pi`. */
export type SessionAdapter = Exclude<AdapterName, "pi">;

/** Refuses a lane whose agent is `pi`; otherwise the agent, narrowed to a `SessionAdapter`. */
export function piAgentRefusal(agent: AdapterName): Result<SessionAdapter, "refused"> {
  if (agent === "pi") return err("refused", `agent pi: ${PI_DEFERRAL}`);
  return ok(agent);
}

/**
 * Refuses a policy whose `unattended_adapters` allows neither `claude` nor
 * `codex`: its lanes would have no reviewer but `pi` (SPEC § Assumptions,
 * "Same-vendor reviewer").
 */
export function piReviewerRefusal(policy: Pick<Policy, "unattended_adapters">): Result<void, "refused"> {
  const adapters = policy.unattended_adapters;
  if (adapters.includes("claude") || adapters.includes("codex")) return ok(undefined);
  const allowed = adapters.length === 0 ? "none" : adapters.join(", ");
  return err(
    "refused",
    `${POLICY_PATH} unattended_adapters allows neither claude nor codex (allowed: ${allowed}), so the only reviewer would be pi: ${PI_DEFERRAL}`,
  );
}
