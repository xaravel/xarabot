import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createGitHubForge, MAX_PAGES } from "../../../../src/adapters/forge/github/github-forge.ts";
import type { FetchLike } from "../../../../src/adapters/forge/github/http.ts";
import type { Forge, ForgeResult } from "../../../../src/ports/forge.ts";
import { createFakeGitHub, LOGS_HOST, testKeys, type FakeGitHub } from "./fake-github.ts";

const live = () => ({ signal: new AbortController().signal });
const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const SHA = "d".repeat(40);

function setup(wrap?: (fetch: FetchLike) => FetchLike, unitBranchPrefix?: string): { gh: FakeGitHub; forge: Forge } {
  const { privateKey, publicKey } = testKeys();
  const gh = createFakeGitHub({ publicKey });
  const forge = createGitHubForge({
    repo: { owner: "acme", name: "widgets" },
    credentials: { app: { id: 4242, slug: "alice-xarabot" }, key: privateKey },
    fetch: wrap === undefined ? gh.fetch : wrap(gh.fetch),
    apiUrl: gh.control.apiUrl,
    now: gh.control.clock,
    ...(unitBranchPrefix !== undefined ? { unitBranchPrefix } : {}),
  });
  return { gh, forge };
}

function value<T>(r: ForgeResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.value;
}

function kind<T>(r: ForgeResult<T>): string {
  return r.ok ? "ok" : r.error.kind;
}

/** Token-authenticated API calls as `METHOD path` (below the repo). */
function calls(gh: FakeGitHub): string[] {
  return gh.control
    .log()
    .filter((l) => l.host === "api" && l.auth === "token")
    .map((l) => `${l.method} ${l.path.replace("/repos/acme/widgets", "")}`);
}

function bodies(gh: FakeGitHub, method: string): unknown[] {
  return gh.control
    .log()
    .filter((l) => l.host === "api" && l.method === method)
    .map((l) => l.body);
}

describe("openPr", () => {
  test("POSTs title, body, head and base and returns the PR", async () => {
    const { gh, forge } = setup();
    gh.control.setBranch("story/1.9", H1);
    const pr = value(await forge.openPr({ branch: "story/1.9", base: "main", title: "T", body: "B" }, live()));
    expect(pr).toEqual({ number: pr.number, branch: "story/1.9", base: "main", state: "open", head_sha: H1, title: "T", body: "B", merge_sha: null });
    expect(calls(gh)).toEqual(["POST /pulls"]);
    expect(bodies(gh, "POST")).toContainEqual({ title: "T", body: "B", head: "story/1.9", base: "main" });
  });

  test("a second open PR on the branch is conflict", async () => {
    const { gh, forge } = setup();
    gh.control.setBranch("story/1.9", H1);
    value(await forge.openPr({ branch: "story/1.9", base: "main", title: "T", body: "B" }, live()));
    const r = await forge.openPr({ branch: "story/1.9", base: "main", title: "T", body: "B" }, live());
    expect(r.ok ? "ok" : r.error).toEqual({ kind: "conflict", message: "createPull: 422 A pull request already exists for acme:story/1.9." });
  });

  test("a missing head or base is not-found", async () => {
    const { gh, forge } = setup();
    expect(kind(await forge.openPr({ branch: "story/404", base: "main", title: "T", body: "B" }, live()))).toBe("not-found");
    gh.control.setBranch("story/1.9", H1);
    expect(kind(await forge.openPr({ branch: "story/1.9", base: "nope", title: "T", body: "B" }, live()))).toBe("not-found");
  });

  test("another 422 goes through mapHttpError", async () => {
    const { gh, forge } = setup();
    gh.control.inject("POST", /\/pulls$/, {
      status: 422,
      body: { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "No commits between main and story/1.9" }] },
    });
    expect(kind(await forge.openPr({ branch: "story/1.9", base: "main", title: "T", body: "B" }, live()))).toBe("rejected");
  });

  test("a null body comes back as an empty string; merged_at makes it merged", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(4, { state: "open", merged: false, head_sha: H1, branch: "story/1.9", body: null });
    gh.control.setPull(5, { state: "closed", merged: true, head_sha: H2, branch: "story/1.9" });
    const listed = value(await forge.listPrsByBranch("story/1.9", live()));
    expect(listed.map((p) => [p.number, p.state, p.body])).toEqual([
      [4, "open", ""],
      [5, "merged", ""],
    ]);
  });
});

describe("updatePr and closePr", () => {
  test("update GETs then PATCHes only the given fields", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(7, { state: "open", merged: false, head_sha: H1, branch: "story/1.9", title: "old", body: "b" });
    const pr = value(await forge.updatePr(7, { title: "new" }, live()));
    expect(pr).toMatchObject({ number: 7, title: "new", body: "b", state: "open" });
    expect(calls(gh)).toEqual(["GET /pulls/7", "PATCH /pulls/7"]);
    expect(bodies(gh, "PATCH")).toEqual([{ title: "new" }]);
  });

  test("an empty update returns the PR unchanged and PATCHes nothing", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(7, { state: "open", merged: false, head_sha: H1, branch: "story/1.9", title: "t", body: "b" });
    expect(value(await forge.updatePr(7, {}, live()))).toMatchObject({ number: 7, title: "t", body: "b" });
    expect(calls(gh)).toEqual(["GET /pulls/7"]);
  });

  test("close PATCHes state closed", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(7, { state: "open", merged: false, head_sha: H1, branch: "story/1.9" });
    expect(value(await forge.closePr(7, live())).state).toBe("closed");
    expect(bodies(gh, "PATCH")).toEqual([{ state: "closed" }]);
  });

  test("a merged PR is conflict without a PATCH; a missing PR is not-found", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(7, { state: "closed", merged: true, head_sha: H1, branch: "story/1.9" });
    expect(kind(await forge.updatePr(7, { title: "x" }, live()))).toBe("conflict");
    expect(kind(await forge.closePr(7, live()))).toBe("conflict");
    expect(calls(gh).filter((c) => c.startsWith("PATCH"))).toEqual([]);
    expect(kind(await forge.updatePr(99, { title: "x" }, live()))).toBe("not-found");
    expect(kind(await forge.closePr(99, live()))).toBe("not-found");
  });

  test("a PATCH 422 that mentions merged is conflict; another 422 is not", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(7, { state: "open", merged: false, head_sha: H1, branch: "story/1.9" });
    gh.control.inject("PATCH", /\/pulls\/7$/, { status: 422, body: { message: "Validation Failed", errors: [{ message: "Cannot update a merged pull request" }] } });
    expect(kind(await forge.closePr(7, live()))).toBe("conflict");
    gh.control.inject("PATCH", /\/pulls\/7$/, { status: 422, body: { message: "Validation Failed" } });
    expect(kind(await forge.closePr(7, live()))).toBe("rejected");
  });
});

describe("listPrsByBranch", () => {
  test("pages 100 at a time until a short page, keeps head.ref === branch, sorts ascending", async () => {
    const { gh, forge } = setup();
    for (let n = 1; n <= 150; n += 1) gh.control.setPull(n, { state: n % 2 === 0 ? "open" : "closed", merged: false, head_sha: H1, branch: "story/1.9" });
    gh.control.setPull(151, { state: "open", merged: false, head_sha: H1, branch: "story/other" });
    const listed = value(await forge.listPrsByBranch("story/1.9", live()));
    expect(listed.map((p) => p.number)).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
    const head = encodeURIComponent("acme:story/1.9");
    expect(calls(gh)).toEqual([
      `GET /pulls?head=${head}&state=all&per_page=100&page=1`,
      `GET /pulls?head=${head}&state=all&per_page=100&page=2`,
    ]);
  });

  test("a PR whose head.ref differs from the branch is dropped", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", /\/pulls\?/, {
      status: 200,
      body: [
        { number: 3, state: "open", title: "t", body: "b", head: { ref: "story/1.9", sha: H1 }, base: { ref: "main" } },
        { number: 2, state: "open", title: "t", body: "b", head: { ref: "story/1.9x", sha: H1 }, base: { ref: "main" } },
      ],
    });
    expect(value(await forge.listPrsByBranch("story/1.9", live())).map((p) => p.number)).toEqual([3]);
  });

  test("a list entry with merged_at and no merged field is merged, as GitHub's list sends it", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", /\/pulls\?/, {
      status: 200,
      body: [
        { number: 3, state: "closed", merged_at: "2026-10-22T00:00:00Z", title: "t", body: "b", head: { ref: "story/1.9", sha: H1 }, base: { ref: "main" } },
        { number: 4, state: "closed", merged_at: null, title: "t", body: "b", head: { ref: "story/1.9", sha: H1 }, base: { ref: "main" } },
      ],
    });
    expect(value(await forge.listPrsByBranch("story/1.9", live())).map((p) => [p.number, p.state])).toEqual([
      [3, "merged"],
      [4, "closed"],
    ]);
  });

  test("merge_sha is merge_commit_sha for a merged PR, and null for an open or closed one (GitHub sends a test merge for open PRs)", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", /\/pulls\?/, {
      status: 200,
      body: [
        { number: 3, state: "closed", merged_at: "2026-10-22T00:00:00Z", merge_commit_sha: SHA, title: "t", body: "b", head: { ref: "story/1.9", sha: H1 }, base: { ref: "main" } },
        { number: 4, state: "open", merged_at: null, merge_commit_sha: H2, title: "t", body: "b", head: { ref: "story/1.9", sha: H1 }, base: { ref: "main" } },
        { number: 5, state: "closed", merged_at: null, merge_commit_sha: H2, title: "t", body: "b", head: { ref: "story/1.9", sha: H1 }, base: { ref: "main" } },
        { number: 6, state: "closed", merged_at: "2026-10-22T00:00:00Z", merge_commit_sha: "not-a-sha", title: "t", body: "b", head: { ref: "story/1.9", sha: H1 }, base: { ref: "main" } },
      ],
    });
    expect(value(await forge.listPrsByBranch("story/1.9", live())).map((p) => [p.number, p.state, p.merge_sha])).toEqual([
      [3, "merged", SHA],
      [4, "open", null],
      [5, "closed", null],
      [6, "merged", null],
    ]);
  });

  test("the emulator's merged PR carries the merge commit it made on main", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(7, { state: "closed", merged: true, head_sha: H1, branch: "story/1.9", merge_commit_sha: SHA });
    expect(value(await forge.listPrsByBranch("story/1.9", live())).map((p) => p.merge_sha)).toEqual([SHA]);
  });

  test(`more than ${MAX_PAGES} full pages is transient`, async () => {
    const { gh, forge } = setup();
    for (let n = 1; n <= MAX_PAGES * 100; n += 1) gh.control.setPull(n, { state: "closed", merged: false, head_sha: H1, branch: "story/1.9" });
    expect(kind(await forge.listPrsByBranch("story/1.9", live()))).toBe("transient");
    expect(calls(gh)).toHaveLength(MAX_PAGES);
  });
});

describe("deleteBranch", () => {
  test("lists the branch's open PRs, then DELETEs its ref; a missing branch is deleted: false", async () => {
    const { gh, forge } = setup();
    gh.control.setBranch("xarabot/reconcile-1", H1);
    expect(value(await forge.deleteBranch("xarabot/reconcile-1", live()))).toEqual({ deleted: true });
    expect(gh.control.ref("xarabot/reconcile-1")).toBeUndefined();
    expect(calls(gh)).toEqual([
      "GET /pulls?head=acme%3Axarabot%2Freconcile-1&state=open&per_page=100&page=1",
      "DELETE /git/refs/heads/xarabot/reconcile-1",
    ]);
    expect(value(await forge.deleteBranch("xarabot/reconcile-1", live()))).toEqual({ deleted: false });
    gh.control.inject("DELETE", /\/git\/refs\/heads\//, { status: 404, body: { message: "Not Found" } });
    expect(value(await forge.deleteBranch("xarabot/reconcile-2", live()))).toEqual({ deleted: false });
  });

  test("a branch with an open PR is conflict and is not deleted; a closed PR's branch is", async () => {
    const { gh, forge } = setup();
    gh.control.setBranch("xarabot/reconcile-3", H1);
    const pr = value(await forge.openPr({ branch: "xarabot/reconcile-3", base: "main", title: "T", body: "B" }, live()));
    gh.control.clearLog();
    expect(await forge.deleteBranch("xarabot/reconcile-3", live())).toEqual({
      ok: false,
      error: { kind: "conflict", message: `deleteBranch: xarabot/reconcile-3 has open PR #${pr.number}` },
    });
    expect(calls(gh).some((c) => c.startsWith("DELETE"))).toBe(false);
    expect(gh.control.ref("xarabot/reconcile-3")).toBe(H1);
    value(await forge.closePr(pr.number, live()));
    expect(value(await forge.deleteBranch("xarabot/reconcile-3", live()))).toEqual({ deleted: true });
    expect(value(await forge.listPrsByBranch("xarabot/reconcile-3", live())).map((p) => [p.state, p.head_sha])).toEqual([["closed", H1]]);
  });

  test("main and the ledger branch are forbidden with no request", async () => {
    const { gh, forge } = setup();
    expect(kind(await forge.deleteBranch("main", live()))).toBe("forbidden");
    expect(kind(await forge.deleteBranch("xarabot/claims", live()))).toBe("forbidden");
    expect(calls(gh)).toEqual([]);
  });

  test("a branch outside the unit-branch namespace is forbidden with no request and stays (Epic 2 retro item 37)", async () => {
    const { gh, forge } = setup();
    const outside = ["story/1.1", "alice/topic", "xarabot-reconcile-1", "xarabot/", "xarabot/../story/1.1", "xarabot/./reconcile-1", "xarabot//reconcile-1"];
    for (const branch of outside) gh.control.setBranch(branch, H1);
    gh.control.clearLog();
    for (const branch of outside) expect([branch, kind(await forge.deleteBranch(branch, live()))]).toEqual([branch, "forbidden"]);
    expect(gh.control.log()).toEqual([]);
    for (const branch of outside) expect(gh.control.ref(branch)).toBe(H1);
    const r = await forge.deleteBranch("story/1.1", live());
    expect(r.ok ? "ok" : r.error.message).toBe(`deleteBranch: "story/1.1" is outside the runner's branches "xarabot/"`);
  });

  test("the namespace is the configured unitBranchPrefix", async () => {
    const { gh, forge } = setup(undefined, "bot/");
    gh.control.setBranch("bot/reconcile-1", H1);
    gh.control.setBranch("xarabot/reconcile-1", H1);
    gh.control.clearLog();
    expect(kind(await forge.deleteBranch("xarabot/reconcile-1", live()))).toBe("forbidden");
    expect(calls(gh)).toEqual([]);
    expect(value(await forge.deleteBranch("bot/reconcile-1", live()))).toEqual({ deleted: true });
    expect(gh.control.ref("bot/reconcile-1")).toBeUndefined();
    expect(gh.control.ref("xarabot/reconcile-1")).toBe(H1);
  });

  test("another refusal goes through mapHttpError: a rule's 422 is rejected, a 403 forbidden", async () => {
    const { gh, forge } = setup();
    gh.control.setBranch("xarabot/reconcile-4", H1);
    gh.control.inject("DELETE", /\/git\/refs\/heads\//, { status: 422, body: { message: "Repository rule violations found" } });
    expect(kind(await forge.deleteBranch("xarabot/reconcile-4", live()))).toBe("rejected");
    gh.control.inject("DELETE", /\/git\/refs\/heads\//, { status: 403, body: { message: "Resource not accessible by integration" } });
    const r = await forge.deleteBranch("xarabot/reconcile-4", live());
    expect(r.ok ? "ok" : r.error.message).toBe("deleteRef: 403 Resource not accessible by integration (needs contents: write)");
    expect(gh.control.ref("xarabot/reconcile-4")).toBe(H1);
  });
});

describe("reviews", () => {
  test("maps author, lowercased state, commit SHA and submitted time, paging 100 at a time in order", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(7, { state: "open", merged: false, head_sha: H1, branch: "story/1.9" });
    const states = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"];
    for (let i = 0; i < 120; i += 1) {
      gh.control.addReview(7, { login: `u${i}`, state: states[i % 4] as string, commit_id: H1, submitted_at: `2026-10-24T10:${String(i % 60).padStart(2, "0")}:00Z` });
    }
    const listed = value(await forge.reviews(7, live()));
    expect(listed).toHaveLength(120);
    expect(listed.slice(0, 4)).toEqual([
      { author: "u0", state: "approved", commit_sha: H1, submitted_at: "2026-10-24T10:00:00Z" },
      { author: "u1", state: "changes_requested", commit_sha: H1, submitted_at: "2026-10-24T10:01:00Z" },
      { author: "u2", state: "commented", commit_sha: H1, submitted_at: "2026-10-24T10:02:00Z" },
      { author: "u3", state: "dismissed", commit_sha: H1, submitted_at: "2026-10-24T10:03:00Z" },
    ]);
    expect(listed.map((r) => r.author)).toEqual(Array.from({ length: 120 }, (_, i) => `u${i}`));
    expect(calls(gh)).toEqual(["GET /pulls/7/reviews?per_page=100&page=1", "GET /pulls/7/reviews?per_page=100&page=2"]);
  });

  test("a null user is a null author; a pending review has a null submitted time", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(7, { state: "open", merged: false, head_sha: H1, branch: "story/1.9" });
    gh.control.addReview(7, { login: null, state: "APPROVED", commit_id: H1, submitted_at: "2026-10-24T10:00:00Z" });
    gh.control.addReview(7, { login: "alice", state: "PENDING", commit_id: H2, submitted_at: null });
    expect(value(await forge.reviews(7, live()))).toEqual([
      { author: null, state: "approved", commit_sha: H1, submitted_at: "2026-10-24T10:00:00Z" },
      { author: "alice", state: "pending", commit_sha: H2, submitted_at: null },
    ]);
  });

  test("a missing PR is not-found", async () => {
    const { forge } = setup();
    expect(kind(await forge.reviews(99, live()))).toBe("not-found");
  });

  test("a review with no submitted_at key is valid, with a null submitted time", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(7, { state: "open", merged: false, head_sha: H1, branch: "story/1.9" });
    gh.control.inject("GET", /\/pulls\/7\/reviews\?/, { status: 200, body: [{ id: 1, user: { login: "alice" }, state: "PENDING", commit_id: H1 }] });
    expect(value(await forge.reviews(7, live()))).toEqual([{ author: "alice", state: "pending", commit_sha: H1, submitted_at: null }]);
  });

  test.each([
    ["an unknown state", [{ id: 1, user: { login: "alice" }, state: "SHRUGGED", commit_id: H1, submitted_at: "2026-10-24T10:00:00Z" }]],
    ["a non-object item", ["approved"]],
    ["a non-string commit", [{ id: 1, user: { login: "alice" }, state: "APPROVED", commit_id: 7, submitted_at: "2026-10-24T10:00:00Z" }]],
    ["a non-object user", [{ id: 1, user: "alice", state: "APPROVED", commit_id: H1, submitted_at: "2026-10-24T10:00:00Z" }]],
    ["a non-string submitted time", [{ id: 1, user: { login: "alice" }, state: "APPROVED", commit_id: H1, submitted_at: 1729764000 }]],
    ["a non-list page", { reviews: [] }],
  ])("%s is a malformed reply (transient)", async (_what, body) => {
    const { gh, forge } = setup();
    gh.control.setPull(7, { state: "open", merged: false, head_sha: H1, branch: "story/1.9" });
    gh.control.inject("GET", /\/pulls\/7\/reviews\?/, { status: 200, body });
    const r = await forge.reviews(7, live());
    expect(r.ok ? "ok" : r.error.kind).toBe("transient");
    expect(r.ok ? "" : r.error.message).toMatch(/^listReviews: malformed reply/);
  });
});

describe("comment", () => {
  test("GETs the PR, POSTs the body verbatim to the issue and returns the id as a string", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(7, { state: "open", merged: false, head_sha: H1, branch: "story/1.9" });
    const posted = value(await forge.comment(7, "🤖 hi\n@nobody", live()));
    expect(typeof posted.id).toBe("string");
    expect(calls(gh)).toEqual(["GET /pulls/7", "POST /issues/7/comments"]);
    expect(bodies(gh, "POST")).toContainEqual({ body: "🤖 hi\n@nobody" });
    expect(gh.control.comments(7)).toEqual(["🤖 hi\n@nobody"]);
  });

  test("a missing PR is not-found and posts nothing", async () => {
    const { gh, forge } = setup();
    expect(kind(await forge.comment(99, "x", live()))).toBe("not-found");
    expect(calls(gh)).toEqual(["GET /pulls/99"]);
  });
});

describe("postReview", () => {
  test("GETs the PR, then POSTs one COMMENT review at commit_id with the body verbatim, and returns the id as a string", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(7, { state: "open", merged: false, head_sha: H1, branch: "story/1.9" });
    const posted = value(await forge.postReview(7, { commit_sha: H1, body: "🤖 review\n@nobody" }, live()));
    expect(typeof posted.id).toBe("string");
    expect(calls(gh)).toEqual(["GET /pulls/7", "POST /pulls/7/reviews"]);
    expect(bodies(gh, "POST")).toContainEqual({ commit_id: H1, body: "🤖 review\n@nobody", event: "COMMENT" });
    expect(gh.control.reviewBodies(7)).toEqual(["🤖 review\n@nobody"]);
    expect(gh.control.reviews(7)).toMatchObject([{ login: "alice-xarabot[bot]", state: "COMMENTED", commit_id: H1 }]);
    const listed = value(await forge.reviews(7, live()));
    expect(listed.map((r) => [r.author, r.state, r.commit_sha])).toEqual([["alice-xarabot[bot]", "commented", H1]]);
  });

  test("never sends an approval or a change request", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(7, { state: "open", merged: false, head_sha: H1, branch: "story/1.9" });
    value(await forge.postReview(7, { commit_sha: H1, body: "x" }, live()));
    const reviewPosts = gh.control.log().filter((l) => l.method === "POST" && l.path.endsWith("/reviews"));
    expect(reviewPosts.map((l) => (l.body as { event?: unknown } | null)?.event)).toEqual(["COMMENT"]);
  });

  test("a missing PR is not-found and posts nothing", async () => {
    const { gh, forge } = setup();
    expect(kind(await forge.postReview(99, { commit_sha: H1, body: "x" }, live()))).toBe("not-found");
    expect(calls(gh)).toEqual(["GET /pulls/99"]);
  });

  test("a reply with no id is a malformed reply (transient)", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(7, { state: "open", merged: false, head_sha: H1, branch: "story/1.9" });
    gh.control.inject("POST", /\/pulls\/7\/reviews$/, { status: 200, body: { state: "COMMENTED" } });
    const r = await forge.postReview(7, { commit_sha: H1, body: "x" }, live());
    expect(r.ok ? "ok" : r.error.message).toMatch(/^createReview: malformed reply/);
  });

  test("a refused review is the mapped error kind", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(7, { state: "open", merged: false, head_sha: H1, branch: "story/1.9" });
    gh.control.inject("POST", /\/pulls\/7\/reviews$/, { status: 403, body: { message: "Resource not accessible by integration" } });
    expect(kind(await forge.postReview(7, { commit_sha: H1, body: "x" }, live()))).toBe("forbidden");
    expect(gh.control.reviewBodies(7)).toEqual([]);
  });
});

describe("prefetch", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tempDir = () => {
    const d = mkdtempSync(join(tmpdir(), "xarabot-prefetch-"));
    dirs.push(d);
    return d;
  };

  test("an Actions log is downloaded through the redirect without Authorization", async () => {
    const { gh, forge } = setup();
    gh.control.setChecks(SHA, [{ name: "test", status: "completed", conclusion: "failure" }]);
    gh.control.setCiLog(SHA, "test", "1 failing\n");
    const dir = join(tempDir(), "logs");
    const { files } = value(await forge.prefetch({ kind: "ci-log", sha: SHA, dir }, live()));
    expect(files).toEqual([join(dir, "test.log")]);
    expect(readFileSync(files[0] as string, "utf8")).toBe("1 failing\n");
    const log = gh.control.log();
    const jobs = log.filter((l) => l.host === "api" && l.path.includes("/actions/jobs/"));
    expect(jobs.map((l) => l.auth)).toEqual(["token"]);
    const downloads = log.filter((l) => l.host === "logs");
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.auth).toBe("none");
    expect(downloads[0]?.headers["authorization"]).toBeUndefined();
    expect(LOGS_HOST).toStartWith("https://");
    expect(calls(gh)[0]).toBe(`GET /commits/${SHA}/check-runs?filter=latest&per_page=100&page=1`);
  });

  test("a 404 or 410 job log writes logs unavailable", async () => {
    const { gh, forge } = setup();
    gh.control.setChecks(SHA, [
      { name: "gone", status: "completed", conclusion: "failure" },
      { name: "expired", status: "completed", conclusion: "cancelled" },
    ]);
    // The first job-log request (for "gone") answers 410; "expired" has no log, so 404.
    gh.control.inject("GET", /\/actions\/jobs\/\d+\/logs$/, { status: 410, body: { message: "Gone" } });
    const dir = tempDir();
    const { files } = value(await forge.prefetch({ kind: "ci-log", sha: SHA, dir }, live()));
    expect(files.map((f) => [basename(f), readFileSync(f, "utf8")]).sort()).toEqual([
      ["expired.log", "logs unavailable (404)\n"],
      ["gone.log", "logs unavailable (410)\n"],
    ]);
  });

  /** Answers every download from the log host with `status`. */
  const logHostAnswers = (status: number) => (fetch: FetchLike): FetchLike => (url, init) =>
    url.startsWith(`${LOGS_HOST}/`) ? Promise.resolve(new Response("nope", { status })) : fetch(url, init);

  test("a 404 or 410 from the log download writes logs unavailable", async () => {
    for (const status of [404, 410]) {
      const { gh, forge } = setup(logHostAnswers(status));
      gh.control.setChecks(SHA, [{ name: "test", status: "completed", conclusion: "failure" }]);
      gh.control.setCiLog(SHA, "test", "1 failing\n");
      const { files } = value(await forge.prefetch({ kind: "ci-log", sha: SHA, dir: tempDir() }, live()));
      expect(files.map((f) => readFileSync(f, "utf8"))).toEqual([`logs unavailable (${status})\n`]);
    }
  });

  test("an unknown commit (check-runs 422) is not-found", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", /\/check-runs\?/, { status: 422, body: { message: "No commit found for SHA" } });
    expect(kind(await forge.prefetch({ kind: "ci-log", sha: SHA, dir: tempDir() }, live()))).toBe("not-found");
  });

  test("another failed log download goes through mapHttpError", async () => {
    const { gh, forge } = setup(logHostAnswers(403));
    gh.control.setChecks(SHA, [{ name: "test", status: "completed", conclusion: "failure" }]);
    gh.control.setCiLog(SHA, "test", "1 failing\n");
    expect(kind(await forge.prefetch({ kind: "ci-log", sha: SHA, dir: tempDir() }, live()))).toBe("forbidden");
  });

  test("a non-Actions run writes its output and details_url; names dedupe case-insensitively", async () => {
    const { gh, forge } = setup();
    gh.control.setChecks(SHA, [
      { name: "Lint", status: "completed", conclusion: "action_required", app: "some-ci", output: { title: "T", summary: "S", text: "X" }, details_url: "https://ci.test/1" },
      { name: "lint", status: "completed", conclusion: "failure", app: "other-ci", output: { title: "only title" } },
      { name: "ok", status: "completed", conclusion: "neutral", app: "some-ci" },
      { name: "pending", status: "in_progress", conclusion: null, app: "some-ci" },
    ]);
    const dir = tempDir();
    const { files } = value(await forge.prefetch({ kind: "ci-log", sha: SHA, dir }, live()));
    expect(files.map((f) => basename(f))).toEqual(["Lint.log", "lint-2.log"]);
    expect(readFileSync(files[0] as string, "utf8")).toBe("T\n\nS\n\nX\n\nhttps://ci.test/1\n");
    expect(readFileSync(files[1] as string, "utf8")).toStartWith("only title\n\n");
    expect(gh.control.log().some((l) => l.path.includes("/actions/jobs/"))).toBe(false);
  });

  test("check runs are paged like pulls", async () => {
    const { gh, forge } = setup();
    gh.control.setChecks(
      SHA,
      Array.from({ length: 120 }, (_, i) => ({ name: `c${i}`, status: "completed" as const, conclusion: "success", app: "some-ci" })),
    );
    expect(value(await forge.prefetch({ kind: "ci-log", sha: SHA, dir: tempDir() }, live()))).toEqual({ files: [] });
    expect(calls(gh)).toEqual([
      `GET /commits/${SHA}/check-runs?filter=latest&per_page=100&page=1`,
      `GET /commits/${SHA}/check-runs?filter=latest&per_page=100&page=2`,
    ]);
  });
});
