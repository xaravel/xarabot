import { splitFrontmatter } from "../config/load-repo-config.ts";
import { err, ok, type Result } from "../result.ts";
import { parseYaml } from "../schemas/common.ts";
import type { BuildResult } from "../schemas/session-result.ts";

/**
 * The build result's cross-check against the Story's spec file (AR11, AR15).
 * A session's `done`, `blocked` or `no-op` counts only when the spec it
 * worked from says the same. Pure.
 */

/** The spec status a build outcome must leave. */
export type SpecStatus = "done" | "blocked";

/** The paths that match `glob` (`Bun.Glob` rules), in their given order. */
export function specMatches(glob: string, paths: readonly string[]): string[] {
  const g = new Bun.Glob(glob);
  return paths.filter((p) => g.match(p));
}

/** `done` and `no-op` leave a spec `done` (build-auto never writes `no-op`); `blocked` leaves it `blocked`. */
export function expectedSpecStatus(outcome: BuildResult["outcome"]): SpecStatus {
  return outcome === "blocked" ? "blocked" : "done";
}

/** One file matching `story_spec_path` in the clone; `text` is `null` when it cannot be read. */
export type SpecMatch = { readonly path: string; readonly text: string | null };

/**
 * The pick: the spec file `checkBuildSpec` runs on (`null`: no cross-check),
 * and the `blocked` matches a `done` spec supersedes, dropped from the squash.
 */
export type SpecPick = {
  readonly spec: { readonly path: string; readonly text: string } | null;
  readonly superseded: readonly string[];
};

/** A spec's frontmatter `status`, or `null` when it has none or cannot be read or parsed. */
export function specStatus(text: string | null): string | null {
  if (text === null) return null;
  const split = splitFrontmatter("spec", text);
  if (!split.ok) return null;
  const yaml = parseYaml("spec", split.value.yaml);
  if (!yaml.ok) return null;
  const fm = yaml.value;
  if (fm === null || typeof fm !== "object" || Array.isArray(fm)) return null;
  const status = (fm as Record<string, unknown>)["status"];
  return typeof status === "string" ? status : null;
}

/**
 * Picks the spec file among `matches` by status. For `done` and `no-op`,
 * exactly one match must be `done` and every other `blocked`: that one is the
 * spec, the others superseded; anything else is `invalid`. For `blocked`,
 * one match is the spec (`invalid` when it cannot be read), and 0 or 2+
 * matches give no spec and no failure.
 */
export function pickSpec(outcome: BuildResult["outcome"], matches: readonly SpecMatch[]): Result<SpecPick, "invalid"> {
  if (outcome === "blocked") {
    if (matches.length !== 1) return ok({ spec: null, superseded: [] });
    const only = matches[0] as SpecMatch;
    if (only.text === null) return err("invalid", `spec: ${only.path} cannot be read`);
    return ok({ spec: { path: only.path, text: only.text }, superseded: [] });
  }
  const statuses = matches.map((m) => ({ match: m, status: specStatus(m.text) }));
  const done = statuses.filter((s) => s.status === "done");
  const others = statuses.filter((s) => s.status !== "done");
  const stray = others.filter((s) => s.status !== "blocked");
  if (done.length !== 1 || stray.length > 0) {
    const shown = statuses
      .map((s) => `${s.match.path} ${s.match.text === null ? "(unreadable)" : s.status === null ? "(no status)" : JSON.stringify(s.status)}`)
      .join(", ");
    return err(
      "invalid",
      `spec: a ${outcome} result needs exactly one "done" spec, every other match "blocked"; ${matches.length} files match${matches.length > 0 ? ` (${shown})` : ""}`,
    );
  }
  // A `done` status was read from the text, so it is there.
  const spec = (done[0] as (typeof done)[number]).match;
  return ok({ spec: { path: spec.path, text: spec.text as string }, superseded: others.map((s) => s.match.path) });
}

const RESULT_HEADING = "## Auto Run Result";
/** A heading that ends the `## Auto Run Result` section: level 1 or 2. */
const SECTION_END = /^#{1,2}(?:\s|$)/;
/** `Status: <s>`, with an optional `**` around the label (`**Status:**` or `**Status**:`). */
const STATUS_LINE = /^\s*(?:\*\*Status:\*\*|\*\*Status\*\*:|Status:)\s*(.*?)\s*$/;

/**
 * Checks that the spec's frontmatter `status` and the `Status:` line of its
 * `## Auto Run Result` section both equal the status `outcome` maps to. Any
 * miss is `invalid`, naming what differed.
 */
export function checkBuildSpec(outcome: BuildResult["outcome"], specText: string): Result<{ readonly status: SpecStatus }, "invalid"> {
  const want = expectedSpecStatus(outcome);
  const split = splitFrontmatter("spec", specText);
  if (!split.ok) return split;
  const yaml = parseYaml("spec", split.value.yaml);
  if (!yaml.ok) return err("invalid", yaml.error.message);
  const fm = yaml.value;
  const status = fm !== null && typeof fm === "object" && !Array.isArray(fm) ? (fm as Record<string, unknown>)["status"] : undefined;
  if (status !== want) {
    return err("invalid", `spec: frontmatter status is ${JSON.stringify(status ?? null)}, expected "${want}" for a ${outcome} result`);
  }

  const lines = split.value.body.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trimEnd() === RESULT_HEADING);
  if (start === -1) return err("invalid", `spec: no "${RESULT_HEADING}" heading`);
  let found: string | undefined;
  for (const line of lines.slice(start + 1)) {
    if (SECTION_END.test(line)) break;
    const m = STATUS_LINE.exec(line);
    if (m !== null) {
      found = m[1] ?? "";
      break;
    }
  }
  if (found === undefined) return err("invalid", `spec: "${RESULT_HEADING}" has no Status: line`);
  if (found !== want) {
    return err("invalid", `spec: "${RESULT_HEADING}" Status is ${JSON.stringify(found)}, expected "${want}" for a ${outcome} result`);
  }
  return ok({ status: want });
}

/**
 * A `blocked` `human-live-step` result must name a configured step: its
 * `step_id` must equal the `id` of a step in `.xarabot/human-live-steps.yaml`
 * (`stepIds`, from the config the session's prompt was built from). Any other
 * result passes.
 */
export function checkHumanLiveStep(result: BuildResult, stepIds: readonly string[]): Result<void, "invalid"> {
  if (result.outcome !== "blocked" || result.blocked.kind !== "human-live-step") return ok(undefined);
  const id = result.blocked.step_id;
  if (stepIds.includes(id)) return ok(undefined);
  const known = stepIds.length === 0 ? "none is configured" : `configured: ${stepIds.map((s) => JSON.stringify(s)).join(", ")}`;
  return err("invalid", `blocked human-live-step names step_id ${JSON.stringify(id)}, which is not a step in .xarabot/human-live-steps.yaml (${known})`);
}
