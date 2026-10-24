import { loadAppCredentials, type AppCredentials } from "../../src/adapters/forge/github/credentials.ts";
import { isSuccess, type Operation } from "../../src/adapters/forge/github/http.ts";
import type { Forge, ForgePr, ForgeResult } from "../../src/ports/forge.ts";
import { isLive } from "./live.ts";

/**
 * Shared helpers for the live GitHub suites (the forge contract and the
 * canary): the scratch repo and login from the environment, the owner's App
 * credentials from the caller's own config, a forge wrapper that prefixes
 * unit branches and alert conditions, and the scratch cleanup.
 */

/** The scratch repo, `owner/name`. */
export const LIVE_REPO: string = process.env.XARABOT_LIVE_GITHUB_REPO ?? "";
/** The login whose `<login>-xarabot` App is installed on the scratch repo. */
export const LIVE_LOGIN: string = process.env.XARABOT_LIVE_GITHUB_LOGIN ?? "";
/** `XARABOT_LIVE=1` with both the scratch repo and the login set. */
export const liveGithubEnabled: boolean = isLive && LIVE_REPO !== "" && LIVE_LOGIN !== "";

/** Test-only: deletes a scratch branch. Not part of the adapter. */
export const DELETE_REF: Operation = { name: "deleteRef (live test cleanup)", method: "DELETE", permission: "contents: write" };

export function liveRepo(): { owner: string; name: string } {
  const [owner, name, ...rest] = LIVE_REPO.split("/");
  if (owner === undefined || name === undefined || owner === "" || name === "" || rest.length > 0) {
    throw new Error("XARABOT_LIVE_GITHUB_REPO must be owner/name");
  }
  return { owner, name };
}

/** `LIVE_LOGIN`'s App credentials, from `<config>/xarabot/apps/<login>-xarabot/` of the caller's own environment. */
export async function liveCredentials(): Promise<AppCredentials> {
  const r = await loadAppCredentials({ login: LIVE_LOGIN, env: process.env });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

export const encodePath = (branch: string): string => branch.split("/").map(encodeURIComponent).join("/");

/**
 * Wraps a forge so every branch a case names gets `prefix`, and maps the
 * branches in its results back. `touched` collects the real branch names.
 * Every `alert` condition gets the prefix too, so dedupe never crosses runs.
 */
export function prefixed(forge: Forge, prefix: string, touched: Set<string>): Forge {
  const to = (branch: string): string => {
    touched.add(`${prefix}${branch}`);
    return `${prefix}${branch}`;
  };
  const back = (pr: ForgePr): ForgePr => ({ ...pr, branch: pr.branch.startsWith(prefix) ? pr.branch.slice(prefix.length) : pr.branch });
  const mapPr = (r: ForgeResult<ForgePr>): ForgeResult<ForgePr> => (r.ok ? { ok: true, value: back(r.value) } : r);
  return {
    ...forge,
    pushBranch: (lease, opts) => forge.pushBranch({ ...lease, branch: to(lease.branch) }, opts),
    openPr: async (req, opts) => mapPr(await forge.openPr({ ...req, branch: to(req.branch) }, opts)),
    updatePr: async (pr, req, opts) => mapPr(await forge.updatePr(pr, req, opts)),
    closePr: async (pr, opts) => mapPr(await forge.closePr(pr, opts)),
    listPrsByBranch: async (branch, opts) => {
      const r = await forge.listPrsByBranch(to(branch), opts);
      return r.ok ? { ok: true, value: r.value.map(back) } : r;
    },
    alert: (condition, mainSha, opts) => forge.alert(`${prefix}${condition}`, mainSha, opts),
  };
}

/** A raw API call on the scratch repo, for test setup and cleanup: `path` is under `/repos/<owner>/<name>`. */
export type RawCall = (op: Operation, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;

export type CleanupScratchParams = {
  /** The unprefixed forge, which sees the real branch names. */
  readonly forge: Forge;
  readonly raw: RawCall;
  /** The real branch names the prefixed forge touched. */
  readonly touched: ReadonlySet<string>;
  /** The scratch ledger branch. */
  readonly ledgerBranch: string;
  readonly signal: () => AbortSignal;
};

/**
 * Closes every open PR on the touched branches, then deletes those branches
 * and the ledger branch. It tries every step, then throws naming each one
 * that failed.
 */
export async function cleanupScratch(p: CleanupScratchParams): Promise<void> {
  const problems: string[] = [];
  const del = async (branch: string): Promise<void> => {
    try {
      const r = await p.raw(DELETE_REF, `/git/refs/heads/${encodePath(branch)}`);
      if (!isSuccess(r.status) && r.status !== 404 && r.status !== 422) problems.push(`delete ${branch}: ${r.status}`);
    } catch (e) {
      problems.push(`delete ${branch}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  for (const b of p.touched) {
    try {
      const listed = await p.forge.listPrsByBranch(b, { signal: p.signal() });
      if (listed.ok) {
        for (const pr of listed.value.filter((x) => x.state === "open")) {
          const closed = await p.forge.closePr(pr.number, { signal: p.signal() });
          if (!closed.ok) problems.push(`close #${pr.number}: ${closed.error.kind}`);
        }
      } else problems.push(`list ${b}: ${listed.error.kind}`);
    } catch (e) {
      problems.push(`list ${b}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await del(b);
  }
  await del(p.ledgerBranch);
  if (problems.length > 0) throw new Error(`live cleanup: ${problems.join("; ")}`);
}
