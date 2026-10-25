import { fetchBotUserId } from "../adapters/forge/github/bot-user.ts";
import { loadAppCredentials, type CredentialEnv } from "../adapters/forge/github/credentials.ts";
import { createGitHubFetch } from "../adapters/forge/github/fetch-shas.ts";
import { createGitHubForge } from "../adapters/forge/github/github-forge.ts";
import type { FetchLike } from "../adapters/forge/github/http.ts";
import { createTokenSource } from "../adapters/forge/github/tokens.ts";
import type { Lane } from "../core/schemas/host.ts";
import type { Forge, ForgeResult } from "../ports/forge.ts";
import type { FetchShas } from "../lane/workspace.ts";

/**
 * What `lane install` and `lane run` reach the forge through, built from the
 * lane owner's App credentials. Injectable, so the commands run against the
 * fake forge in tests. The installation token goes only to the runner's own
 * git credential helper (the runner install); never to an agent session.
 */

/** The runner's git repo: `lane install` and `lane run` install pinned versions from it. */
export const RUNNER_REPO_URL = "https://github.com/xaravel/xarabot.git";

export type ForgeOpts = {
  /** The lane's `runner.git`, for pushes. */
  readonly runnerGit?: string;
  /** The Maintainer's login, for alerts. */
  readonly maintainer?: string;
};

export type LaneConnection = {
  forge(opts: ForgeOpts): Forge;
  /** An installation token, for the runner install's git credential. */
  token(signal: AbortSignal): Promise<ForgeResult<string>>;
  /** Fetches SHAs from the lane's repo into `gitDir`. */
  fetchShas(gitDir: string): FetchShas;
  /** The App bot account's numeric user id. */
  botUserId(signal: AbortSignal): Promise<ForgeResult<number>>;
};

export type Connect = (lane: Lane) => Promise<{ readonly ok: true; readonly connection: LaneConnection } | { readonly ok: false; readonly message: string }>;

/** Where the GitHub connection's requests go; production leaves every field unset (tests point them at fakes). */
export type GitHubNet = {
  readonly fetch?: FetchLike;
  /** The REST API's base URL; default GitHub's. */
  readonly apiUrl?: string;
  /** The git host; default `https://github.com`. */
  readonly gitUrl?: string;
};

/** The GitHub connection for `lane`, from `<config>/xarabot/apps/<owner>-xarabot/`. */
export function githubConnect(env: CredentialEnv, net: GitHubNet = {}): Connect {
  const http = {
    ...(net.fetch !== undefined ? { fetch: net.fetch } : {}),
    ...(net.apiUrl !== undefined ? { apiUrl: net.apiUrl } : {}),
  };
  const git = net.gitUrl !== undefined ? { gitUrl: net.gitUrl } : {};
  return async (lane) => {
    const creds = await loadAppCredentials({ login: lane.owner, env });
    if (!creds.ok) return { ok: false, message: `credentials ${creds.error.kind}: ${creds.error.message}` };
    const credentials = creds.value;
    const [owner, name] = lane.repo.split("/") as [string, string];
    const repo = { owner, name };
    const tokens = createTokenSource({ credentials, repo, ...http });
    return {
      ok: true,
      connection: {
        forge: (o) =>
          createGitHubForge({
            repo,
            credentials,
            ...http,
            ...git,
            ...(o.runnerGit !== undefined ? { runnerGit: o.runnerGit } : {}),
            ...(o.maintainer !== undefined ? { maintainer: o.maintainer } : {}),
          }),
        token: (signal) => tokens.get(signal),
        fetchShas: (gitDir) => createGitHubFetch({ repo, credentials, gitDir, ...http, ...git }),
        botUserId: (signal) => fetchBotUserId({ slug: credentials.app.slug, signal, ...http }),
      },
    };
  };
}
