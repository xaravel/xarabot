import type { Result } from "../core/result.ts";
import type { Lane } from "../core/schemas/host.ts";
import type { LaunchCredential, LaunchSpec, Vendor } from "./sandbox.ts";

/**
 * The `Agent` port (AR1, FR7, AR15, AR22, AR30): turns one unit and a lane's
 * settings into a `LaunchSpec` for the `Sandbox`, checks the CLI before a
 * session starts, reads the session's usage from its stdout (and, for a CLI
 * that keeps it there, from the session files in the lane's vendor home) and
 * checks the model it reported. An adapter never spawns anything itself;
 * `src/sandbox/` runs what it describes. Every method but `parseUsage` is
 * pure; `parseUsage` only reads files under the vendor home it is given. No
 * method throws.
 */

/** A lane's `effort` (`host.yaml`). */
export type Effort = Lane["effort"];

/** What a session is asked to do. */
export type AgentUnit =
  /**
   * A new session. Where `prompt` goes is the adapter's: `claude` writes it on
   * stdin and never in argv; `codex` puts it last in argv, after `--` (its
   * stdin stays closed).
   */
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
  /**
   * Set, to the CLI's own error message, when the session's turn failed for a
   * reason other than a usage limit (codex's `turn.failed`). The runner fails
   * the attempt on it, with no resume. Absent when nothing failed.
   */
  readonly failure?: string;
};

/**
 * A `LaunchSpec` with its credential required: an agent session always
 * carries one. Only the runner's own repo commands omit it (AR19).
 */
export type AgentLaunchSpec = LaunchSpec & { readonly credential: LaunchCredential };

export type AgentErrorKind = "invalid" | "refused" | "model-mismatch";

export type Agent = {
  readonly vendor: Vendor;
  /** The model id used when the lane sets none. */
  readonly defaultModel: string;
  /** The lowest CLI version the adapter accepts, e.g. `2.1.304`. */
  readonly minVersion: string;
  /** The session to run; `resultPath` is the absolute path the sandbox exposes as `XARABOT_RESULT`. */
  launchSpec(unit: AgentUnit, settings: AgentSettings, resultPath: string): Result<AgentLaunchSpec, "invalid">;
  /**
   * Reads usage from the session's stdout; lines it can't read are skipped.
   * `vendorHome` is the lane's vendor home after the run, for a CLI that
   * keeps its model, rate limits or subagent sessions there; `since` is the
   * run's start (epoch ms), so files an earlier run left are not counted.
   * An adapter that needs neither ignores them. Never throws.
   */
  parseUsage(stdout: string, vendorHome?: string, since?: number): AgentUsage;
  /** After a run: the model `usage` reports, refused when it reported none or not the `configured` one (Story 2.6b). */
  checkModel(usage: AgentUsage, configured: string): Result<string, "model-mismatch">;
  /** The efforts the CLI offers for an exact model id; none for a model it doesn't know (fails closed). */
  effortValues(model: string): readonly Effort[];
  /** Before a session: refuses an effort the model doesn't offer and a CLI version that is unreadable or too old. */
  startCheck(settings: AgentSettings, versionOutput: string): Result<{ readonly model: string; readonly version: string }, "refused">;
};
