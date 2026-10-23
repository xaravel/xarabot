import { err, ok, type Result } from "../core/result.ts";
import { needCommit, rebuildClone, type CloneErrorKind } from "./clone.ts";

/**
 * The agent's clone before each session (AR10, AR16), behind a narrow port so
 * the lane process can run against the fake forge, whose SHAs are not real
 * git objects. The git workspace fetches only the SHAs `runner.git` lacks,
 * through an injected `fetch` (the launcher wires the forge credential), then
 * rebuilds the clone at the start SHA, resuming a saved wip.
 */

export type PrepareParams = {
  readonly unit: string;
  readonly branch: string;
  /** The SHA the session starts at. */
  readonly start: string;
  readonly generation: number;
  /** SHAs the clone needs in `runner.git`. */
  readonly fetch: readonly string[];
  readonly signal: AbortSignal;
};

export type Prepared = { readonly sha: string; readonly resumed: boolean };

export type WorkspaceErrorKind = CloneErrorKind | "fetch";

export type Workspace = {
  prepare(params: PrepareParams): Promise<Result<Prepared, WorkspaceErrorKind>>;
};

/** Fetches `shas` into `runner.git`. Never throws. */
export type FetchShas = (shas: readonly string[], signal: AbortSignal) => Promise<Result<void>>;

export type GitWorkspaceParams = {
  readonly gitDir: string;
  readonly clone: string;
  readonly fetch: FetchShas;
};

export function createGitWorkspace(params: GitWorkspaceParams): Workspace {
  const { gitDir, clone, fetch } = params;
  return {
    async prepare(p) {
      const missing: string[] = [];
      for (const sha of new Set(p.fetch)) {
        const has = await needCommit(gitDir, sha, "prepare", p.signal);
        if (has.ok) continue;
        if (has.error.kind !== "missing-object") return has;
        missing.push(sha);
      }
      if (missing.length > 0) {
        let fetched: Result<void>;
        try {
          fetched = await fetch(missing, p.signal);
        } catch (e) {
          fetched = err("fetch", e instanceof Error ? e.message : String(e));
        }
        if (!fetched.ok) return err("fetch", `prepare: fetching ${missing.join(", ")}: ${fetched.error.message}`);
      }
      const rebuilt = await rebuildClone({
        gitDir,
        clone,
        unit: p.unit,
        branch: p.branch,
        sha: p.start,
        generation: p.generation,
        resumeWip: true,
        signal: p.signal,
      });
      if (!rebuilt.ok) return rebuilt;
      return ok({ sha: rebuilt.value.sha, resumed: rebuilt.value.resumed });
    },
  };
}
