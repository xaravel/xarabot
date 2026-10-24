import { err, ok, type Result } from "../../../core/result.ts";
import type { AppCredentials } from "./credentials.ts";
import { DEFAULT_GIT_URL } from "./github-forge.ts";
import type { FetchLike } from "./http.ts";
import { runGit } from "./runner-git.ts";
import { createTokenSource } from "./tokens.ts";

/**
 * Fetches commits by SHA from the repo into the lane's `runner.git` (AR16,
 * AR19): the `FetchShas` the workspace, committer, merger and diff-paths
 * use. The installation token goes only to `runGit`'s credential helper, and
 * every error message is redacted.
 */

export type GitHubFetchOptions = {
  readonly repo: { readonly owner: string; readonly name: string };
  readonly credentials: AppCredentials;
  /** The lane's `runner.git`. */
  readonly gitDir: string;
  /** The git host; default `https://github.com`. */
  readonly gitUrl?: string;
  readonly apiUrl?: string;
  readonly fetch?: FetchLike;
  /** Epoch ms, for the JWT and token expiry; default `Date.now`. */
  readonly now?: () => number;
};

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function createGitHubFetch(options: GitHubFetchOptions): (shas: readonly string[], signal: AbortSignal) => Promise<Result<void>> {
  const { owner, name } = options.repo;
  const repoUrl = `${(options.gitUrl ?? DEFAULT_GIT_URL).replace(/\/+$/, "")}/${owner}/${name}.git`;
  const tokens = createTokenSource({
    credentials: options.credentials,
    repo: options.repo,
    fetch: options.fetch,
    apiUrl: options.apiUrl,
    now: options.now,
  });

  const fetchShas = async (shas: readonly string[], signal: AbortSignal): Promise<Result<void>> => {
    const wanted = [...new Set(shas)];
    for (const sha of wanted) if (!SHA_PATTERN.test(sha)) return err("invalid", `fetch: ${JSON.stringify(sha)} is not a commit SHA`);
    if (wanted.length === 0) return ok(undefined);
    const token = await tokens.get(signal);
    if (!token.ok) return err(token.error.kind, `fetch: ${token.error.message}`);
    const run = await runGit(options.gitDir, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", repoUrl, ...wanted], {
      signal,
      credential: { url: repoUrl, token: token.value },
    });
    if (!run.ok) return err(run.error.kind, tokens.redact(`fetch: ${run.error.message}`));
    if (run.value.code !== 0) {
      const stderr = run.value.stderr.trim();
      if (/Authentication failed|error: 401/.test(stderr)) tokens.invalidate(token.value);
      return err("fetch", tokens.redact(`fetch: git exited ${run.value.code}${stderr === "" ? "" : `: ${stderr}`}`));
    }
    for (const sha of wanted) {
      const has = await runGit(options.gitDir, ["cat-file", "-e", `${sha}^{commit}`], { signal });
      if (!has.ok) return err(has.error.kind, tokens.redact(`fetch: ${has.error.message}`));
      if (has.value.code !== 0) return err("fetch", `fetch: ${sha} is not a commit after the fetch`);
    }
    return ok(undefined);
  };

  return async (shas, signal) => {
    try {
      return await fetchShas(shas, signal);
    } catch (e) {
      return err("transient", tokens.redact(`fetch threw: ${e instanceof Error ? e.message : String(e)}`));
    }
  };
}
