import type { Result } from "../core/result.ts";
import type { Lane } from "../core/schemas/host.ts";
import type { LaunchSpec } from "./sandbox.ts";

/**
 * The `Agent` port (FR7, AR15, AR22, AR30, AR42): turns a unit and the lane's
 * model settings into a `LaunchSpec` for the `Sandbox` port, and reads the
 * session's own report back from its output. An adapter never spawns
 * anything (only `src/sandbox/` does) and never touches GitHub. Every
 * function returns a `Result` and never throws.
 */

export type Effort = Lane["effort"];

/** A fresh session on a prompt, or a resume of a session that wrote no result. */
export type AgentUnit =
  | { readonly kind: "session"; readonly prompt: string }
  | { readonly kind: "resume"; readonly session: string };

/** The lane's model settings; the adapter applies its own defaults. */
export type AgentSettings = { readonly model?: string; readonly effort?: Effort };

export type AgentTokens = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
};

/** A usage limit the session hit; `resetAt` is epoch ms, or `null` when the output gives no reset time. */
export type AgentUsageLimit = { readonly resetAt: number | null; readonly text: string | null };

/**
 * What a session's output says about itself. Missing parts are `null`. Only
 * the runner's journal decides what is recorded; these are the CLI's figures.
 */
export type AgentUsage = {
  readonly sessionId: string | null;
  readonly model: string | null;
  readonly tokens: AgentTokens | null;
  /** `estimate` is true when the figure is not a bill (a subscription session). */
  readonly cost: { readonly usd: number; readonly estimate: boolean } | null;
  readonly isError: boolean | null;
  readonly usageLimit: AgentUsageLimit | null;
};

/** What a passed start check settled: the CLI version and the effective settings. */
export type AgentStart = { readonly version: string; readonly model: string; readonly effort: Effort };

export type AgentErrorKind = "refused" | "invalid-input" | "model-mismatch";
export type AgentResult<T> = Result<T, AgentErrorKind>;

export type Agent = {
  /** The CLI's command name, `argv[0]` of every spec; the runner probes `<command> --version`. */
  readonly command: string;
  /** Refuses a CLI older than the adapter supports, unparseable version output, or an unsupported effort. */
  startCheck(settings: AgentSettings, versionOutput: string): AgentResult<AgentStart>;
  /** The spec for one session; `resultPath` is the profile's result path, which the sandbox exports as `XARABOT_RESULT`. */
  launchSpec(unit: AgentUnit, settings: AgentSettings, resultPath: string): AgentResult<LaunchSpec>;
  /** Reads the session's stdout; never fails on malformed output, it just finds less. */
  parseUsage(output: string): AgentResult<AgentUsage>;
  /** The efforts `model` accepts; `[]` for a model the adapter does not know. */
  effortValues(model: string): AgentResult<readonly Effort[]>;
  /** Fails `model-mismatch` when the session reported no model or another one than configured. */
  verifyModel(usage: AgentUsage, settings: AgentSettings): AgentResult<string>;
};
