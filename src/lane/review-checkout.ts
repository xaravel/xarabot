import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../core/result.ts";
import { needCommit, writeReviewCheckout } from "./clone.ts";
import { laneLayout } from "./lane-store.ts";
import type { FetchShas, Workspace, WorkspaceErrorKind } from "./workspace.ts";

/**
 * The review checkout before each review pass (Story 3.4, AR16, AR17),
 * behind a narrow port so the review step can run against the fake forge,
 * whose SHAs are not real git objects. The git implementation fetches the
 * SHAs `runner.git` lacks, through an injected `fetch`, then writes the
 * checkout (`writeReviewCheckout`): `<lane>/review`, never the agent's
 * clone, at the reviewed head with `main`'s agent config and hooks off.
 */

export type ReviewCheckoutRequest = {
  /** The reviewed SHA. */
  readonly head: string;
  /** `main`'s SHA. */
  readonly main: string;
  readonly signal: AbortSignal;
};

export type ReviewCheckout = {
  /** Writes a fresh checkout of `head` and `main`; the SHA it is at. */
  prepare(request: ReviewCheckoutRequest): Promise<Result<{ readonly sha: string }, WorkspaceErrorKind>>;
};

export type GitReviewCheckoutParams = {
  readonly gitDir: string;
  /** The lane folder: the checkout is always its `laneLayout(laneDir).review`, never a folder the caller names. */
  readonly laneDir: string;
  readonly fetch: FetchShas;
};

export function createGitReviewCheckout(params: GitReviewCheckoutParams): ReviewCheckout {
  const { gitDir, fetch } = params;
  const dir = laneLayout(params.laneDir).review;
  return {
    async prepare(r) {
      const missing: string[] = [];
      for (const sha of new Set([r.head, r.main])) {
        const has = await needCommit(gitDir, sha, "review checkout", r.signal);
        if (has.ok) continue;
        if (has.error.kind !== "missing-object") return has;
        missing.push(sha);
      }
      if (missing.length > 0) {
        let fetched: Result<void>;
        try {
          fetched = await fetch(missing, r.signal);
        } catch (e) {
          fetched = err("fetch", e instanceof Error ? e.message : String(e));
        }
        if (!fetched.ok) return err("fetch", `review checkout: fetching ${missing.join(", ")}: ${fetched.error.message}`);
      }
      const written = await writeReviewCheckout({ gitDir, dir, head: r.head, main: r.main, signal: r.signal });
      return written.ok ? ok(written.value) : written;
    },
  };
}

/**
 * `checkout` as the session runner's `Workspace`: `prepare` writes a fresh
 * review checkout of its start SHA and `main`, ignoring the branch, the
 * generation and any wip, so every pass starts from a clean checkout.
 */
export function reviewWorkspace(checkout: ReviewCheckout, main: string): Workspace {
  return {
    async prepare(p) {
      const r = await checkout.prepare({ head: p.start, main, signal: p.signal });
      return r.ok ? ok({ sha: r.value.sha, resumed: false }) : r;
    },
  };
}

/** Every file in the checkout, repo-relative and sorted, its top-level `.git` skipped. */
export function checkoutFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string, rel: string): void => {
    for (const entry of readdirSync(at)) {
      if (rel === "" && entry === ".git") continue;
      const path = join(at, entry);
      const relPath = rel === "" ? entry : `${rel}/${entry}`;
      if (lstatSync(path).isDirectory()) walk(path, relPath);
      else out.push(relPath);
    }
  };
  walk(dir, "");
  return out.sort();
}
