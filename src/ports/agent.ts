import type { Result } from "../core/result.ts";
import type { Lane } from "../core/schemas/host.ts";
import type { LaunchSpec, Vendor } from "./sandbox.ts";

/**
 * The `Agent` port (AR1, FR7, AR15, AR22, AR30): turns one unit and a lane's
 * settings into a `LaunchSpec` for the `Sandbox`, checks the CLI before a
 * session starts and reads the session's usage from its stdout. An adapter
 * never spawns anything itself; `src/sandbox/` runs what it describes. Every
 * method is pure and never throws.
 */

/** A lane's `effort` (`host.yaml`). */
export type Effort = Lane["effort"];

/** What a session is asked to do. */
export type AgentUnit =
  /** A new session; `prompt` goes on stdin, never in argv. */
  | { readonly kind: "fresh"; readonly prompt: string }
  /** The one resume of a session that left no result: it asks only for the result. */
  | { readonly kind: "resume"; readonly sessionId: string };

/** A lane's agent settings (`host.yaml`); an unset `model` means the adapter's `defaultModel`. */
export type AgentSettings = {
  readonly model?: string;
  readonly effort: Effort;
};

export type TokenTotals = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
};

/** What a session's output says about itself. Only informative: the runner never trusts it for the journal's own facts. */
export type AgentUsage = {
  readonly sessionId: string | null;
  /** The model the CLI reported it ran, or `null` when it reported none. */
  readonly model: string | null;
  /** `null` when the output has no final usage. */
  readonly tokens: TokenTotals | null;
  /** `estimate` is `true` unless the session was billed through an API key. */
  readonly cost: { readonly usd: number; readonly estimate: boolean } | null;
  /** Set when the session hit a usage limit; `resetAt` is epoch ms, or `null` when the reset can't be read. */
  readonly usageLimit: { readonly resetAt: number | null } | null;
};

export type AgentErrorKind = "invalid" | "refused" | "model-mismatch";

export type Agent = {
  readonly vendor: Vendor;
  /** The model id used when the lane sets none. */
  readonly defaultModel: string;
  /** The lowest CLI version the adapter accepts, e.g. `2.1.304`. */
  readonly minVersion: string;
  /** The session to run; `resultPath` is the absolute path the sandbox exposes as `XARABOT_RESULT`. */
  launchSpec(unit: AgentUnit, settings: AgentSettings, resultPath: string): Result<LaunchSpec, "invalid">;
  /** Reads usage from the session's stdout; lines it can't read are skipped. */
  parseUsage(stdout: string): AgentUsage;
  /** The efforts the CLI offers for an exact model id; none for a model it doesn't know (fails closed). */
  effortValues(model: string): readonly Effort[];
  /** Before a session: refuses an effort the model doesn't offer and a CLI version that is unreadable or too old. */
  startCheck(settings: AgentSettings, versionOutput: string): Result<{ readonly model: string; readonly version: string }, "refused">;
};
