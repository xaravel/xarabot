import { join } from "node:path";
import { err, ok } from "../core/result.ts";
import type { Agent, AgentSettings } from "../ports/agent.ts";
import type { LaunchSpec } from "../ports/sandbox.ts";
import type { Regenerate } from "./ci-step.ts";
import type { LaneLayout } from "./lane-store.ts";
import { message, readRegular, type SessionContext, type SessionRunner } from "./session.ts";

/**
 * The CI step's lockfile regeneration (AR19, A14), shared by the lane
 * process and the retro-item step (Story 2.10): the clone prepared at the
 * merge candidate, then the repo's `lockfile_command` under the agent's own
 * launch spec with `argv` replaced, no stdin and no credential (a repo
 * command the runner starts gets no vendor credential), bounded by the unit
 * budget and the session limit. The lockfiles are read back from the clone.
 */

const HOUR_MS = 60 * 60 * 1000;

export type RegenerateDeps = {
  readonly runner: SessionRunner;
  /** The unit's session context: its budget, keeper and sandbox profile. */
  readonly ctx: SessionContext;
  readonly agent: Agent;
  readonly settings: AgentSettings;
  readonly layout: LaneLayout;
  /** Writes a note to the unit log. */
  readonly note: (text: string) => void;
};

export function createRegenerate(deps: RegenerateDeps): Regenerate {
  const { runner, ctx, agent, settings, layout, note } = deps;
  return async ({ start: at, paths, command }) => {
    const setUpFailed = await runner.prepare(ctx, at);
    if (setUpFailed !== null) return err("prepare", setUpFailed);
    const spec = agent.launchSpec({ kind: "fresh", prompt: "Regenerate the lockfiles." }, settings, layout.resultPath);
    if (!spec.ok) return err("launch-spec", spec.error.message);
    const s = spec.value;
    const launch: LaunchSpec = { argv: [...command], vendor: s.vendor, vendorHomeEnv: s.vendorHomeEnv, apiHosts: s.apiHosts };
    note(`lockfile command starts: ${command.join(" ")}`);
    const { run, timedOut } = await runner.sandboxed(ctx, launch);
    if (!run.ok) return err("sandbox", `sandbox refused: ${run.error.message}`);
    runner.logRun("lockfile command", run.value);
    if (ctx.budget.aborted) return err("budget", ctx.overBudget());
    if (timedOut) return err("session-limit", `the lockfile command ran past ${runner.limits.sessionMs / HOUR_MS} h`);
    if (run.value.exitCode !== 0) return err("exit", `the lockfile command exited ${run.value.exitCode ?? `on ${run.value.signal ?? "a signal"}`}`);
    const texts: Record<string, string> = {};
    for (const path of paths) {
      if (path === "" || path.startsWith("/") || path.split("/").some((p) => p === ".." || p === "." || p === "" || p === ".git")) {
        return err("invalid", `lockfile path ${JSON.stringify(path)} is not a plain repo path`);
      }
      let text: string | null;
      try {
        text = readRegular(join(layout.clone, path));
      } catch (e) {
        return err("read", `cannot read ${path}: ${message(e)}`);
      }
      if (text === null) return err("read", `${path} is not a regular file after the lockfile command`);
      texts[path] = text;
    }
    return ok(texts);
  };
}
