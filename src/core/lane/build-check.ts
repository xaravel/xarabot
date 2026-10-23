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
