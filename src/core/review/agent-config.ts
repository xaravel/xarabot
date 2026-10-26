import { AGENT_CONFIG_PATHS } from "../config/protected-paths.ts";

/**
 * Agent config (AR22): the one rule for the write check's `agent-config`
 * class (`src/core/lane/write-check.ts`) and the paths a review checkout
 * takes from `main` instead of the reviewed head (Story 3.4), so the change
 * under review can never configure its own reviewer. `AGENT_CONFIG_PATHS`,
 * plus any path whose last segment is an agent config folder name (a file
 * or symlink there), all case-folded as APFS folds names, because the clone
 * and the checkout live on a case-insensitive filesystem. Pure.
 */

/**
 * Full case folding, as APFS folds names: `ſ` and `K` (Kelvin) fold with
 * `s` and `k`, and a composed `é` with `e` and a combining accent (NFD,
 * as APFS compares names).
 */
export const fold = (s: string): string => s.normalize("NFD").toUpperCase().toLowerCase();

/** The agent config folder names, folded: a path ending in one is agent config whatever it is. */
export const AGENT_CONFIG_DIRS: ReadonlySet<string> = new Set([".agents", ".claude", ".codex", ".pi"]);

const GLOBS: readonly Bun.Glob[] = AGENT_CONFIG_PATHS.map((g) => new Bun.Glob(fold(g)));

/** True when repo-relative `path` is agent config, case-folded. */
export function isAgentConfigPath(path: string): boolean {
  const p = fold(path);
  return GLOBS.some((g) => g.match(p)) || AGENT_CONFIG_DIRS.has(p.slice(p.lastIndexOf("/") + 1));
}
