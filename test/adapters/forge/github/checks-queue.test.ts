import { describe, expect, test } from "bun:test";
import { createGitHubForge, mapGraphqlErrors } from "../../../../src/adapters/forge/github/github-forge.ts";
import { ENQUEUE_PERMISSION, GITHUB_OPERATIONS } from "../../../../src/adapters/forge/github/http.ts";
import type { Forge, ForgeResult } from "../../../../src/ports/forge.ts";
import { createFakeGitHub, testKeys, type FakeGitHub } from "./fake-github.ts";

const live = () => ({ signal: new AbortController().signal });
const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const SHA = "c".repeat(40);

function setup(): { gh: FakeGitHub; forge: Forge } {
  const { privateKey, publicKey } = testKeys();
  const gh = createFakeGitHub({ publicKey });
  const forge = createGitHubForge({
    repo: { owner: "acme", name: "widgets" },
    credentials: { app: { id: 4242, slug: "alice-xarabot" }, key: privateKey },
    fetch: gh.fetch,
    apiUrl: gh.control.apiUrl,
    now: gh.control.clock,
    maintainer: "alice",
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

/** The GraphQL operation names sent, in order. */
function graphqlOps(gh: FakeGitHub): string[] {
  return gh.control
    .log()
    .filter((l) => l.path === "/graphql")
    .map((l) => /^\s*(?:query|mutation)\s+(\w+)/.exec(String((l.body as { query?: unknown }).query))?.[1] ?? "?");
}

function graphqlBodies(gh: FakeGitHub): { query: string; variables: Record<string, unknown> }[] {
  return gh.control
    .log()
    .filter((l) => l.path === "/graphql")
    .map((l) => l.body as { query: string; variables: Record<string, unknown> });
}

/** An open PR #1 on `story/1.10` at head `H1`. */
function openPull(gh: FakeGitHub, head = H1): number {
  gh.control.setBranch("story/1.10", head);
  gh.control.setPull(1, { state: "open", merged: false, head_sha: head, branch: "story/1.10" });
  return 1;
}

describe("checks", () => {
  test("pending: no check runs and no statuses is an empty list", async () => {
    const { gh, forge } = setup();
    expect(value(await forge.checks(SHA, live()))).toEqual({ checks: [] });
    expect(calls(gh)).toEqual([
      `GET /commits/${SHA}/check-runs?filter=latest&per_page=100&page=1`,
      `GET /commits/${SHA}/status?per_page=100&page=1`,
    ]);
  });

  test("mixed: runs in API order then statuses; waiting is queued and a pending status in_progress", async () => {
    const { gh, forge } = setup();
    gh.control.setChecks(SHA, [
      { name: "test", status: "completed", conclusion: "success" },
      { name: "deploy", status: "waiting" as never, conclusion: null },
    ]);
    gh.control.setStatuses(SHA, [{ context: "ci/legacy", state: "pending" }]);
    expect(value(await forge.checks(SHA, live()))).toEqual({
      checks: [
        { name: "test", status: "completed", conclusion: "success" },
        { name: "deploy", status: "queued", conclusion: null },
        { name: "ci/legacy", status: "in_progress", conclusion: null },
      ],
    });
  });

  test.each(["waiting", "requested", "pending", "queued"])("check-run status %s is queued", async (status) => {
    const { gh, forge } = setup();
    gh.control.setChecks(SHA, [{ name: "a", status: status as never, conclusion: null }]);
    expect(value(await forge.checks(SHA, live())).checks).toEqual([{ name: "a", status: "queued", conclusion: null }]);
  });

  test.each(["success", "failure", "error"] as const)("status %s is completed with that conclusion", async (state) => {
    const { gh, forge } = setup();
    gh.control.setStatuses(SHA, [{ context: "ctx", state }]);
    expect(value(await forge.checks(SHA, live())).checks).toEqual([{ name: "ctx", status: "completed", conclusion: state }]);
  });

  test("an unknown check-run status is a malformed reply (transient)", async () => {
    const { gh, forge } = setup();
    gh.control.setChecks(SHA, [{ name: "a", status: "exploded" as never, conclusion: null }]);
    expect(kind(await forge.checks(SHA, live()))).toBe("transient");
  });

  test("an unknown status state is a malformed reply (transient)", async () => {
    const { gh, forge } = setup();
    gh.control.setStatuses(SHA, [{ context: "ctx", state: "weird" as never }]);
    expect(kind(await forge.checks(SHA, live()))).toBe("transient");
  });

  test("unknown SHA: check-runs answering 422 is not-found", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", /\/check-runs/, { status: 422, body: { message: `No commit found for SHA: ${SHA}` } });
    expect(kind(await forge.checks(SHA, live()))).toBe("not-found");
  });

  test("unknown SHA: status answering 422 is not-found", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", /\/status\?/, { status: 422, body: { message: `No commit found for SHA: ${SHA}` } });
    expect(kind(await forge.checks(SHA, live()))).toBe("not-found");
  });

  test("a SHA that is not hex is not-found with no request", async () => {
    const { gh, forge } = setup();
    expect(kind(await forge.checks("main", live()))).toBe("not-found");
    expect(calls(gh)).toEqual([]);
  });

  test("both lists are paged", async () => {
    const { gh, forge } = setup();
    gh.control.setChecks(
      SHA,
      Array.from({ length: 150 }, (_, i) => ({ name: `run${i}`, status: "completed" as const, conclusion: "success" })),
    );
    gh.control.setStatuses(
      SHA,
      Array.from({ length: 100 }, (_, i) => ({ context: `st${i}`, state: "success" as const })),
    );
    const got = value(await forge.checks(SHA, live())).checks;
    expect(got).toHaveLength(250);
    expect(got[149]?.name).toBe("run149");
    expect(got[249]?.name).toBe("st99");
    expect(calls(gh)).toEqual([
      `GET /commits/${SHA}/check-runs?filter=latest&per_page=100&page=1`,
      `GET /commits/${SHA}/check-runs?filter=latest&per_page=100&page=2`,
      `GET /commits/${SHA}/status?per_page=100&page=1`,
      `GET /commits/${SHA}/status?per_page=100&page=2`,
    ]);
  });
});

describe("enqueue", () => {
  test("an open PR at the expected head, not queued: the mutation carries expectedHeadOid", async () => {
    const { gh, forge } = setup();
    const pr = openPull(gh);
    expect(value(await forge.enqueue(pr, H1, live()))).toEqual({ queued: true });
    expect(gh.control.queue()).toEqual([pr]);
    expect(graphqlOps(gh)).toEqual(["XarabotPull", "XarabotEnqueue"]);
    const [read, mutation] = graphqlBodies(gh);
    expect(read?.variables).toEqual({ owner: "acme", name: "widgets", number: pr });
    expect(read?.query).toContain("pullRequest(number: $number) { id state headRefOid isInMergeQueue }");
    expect(mutation?.variables).toEqual({ pullRequestId: `PR_${pr}`, expectedHeadOid: H1 });
    expect(mutation?.query).toContain("enqueuePullRequest(input: {pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid})");
    // GraphQL goes to /graphql, outside the repo path, with an installation token.
    expect(gh.control.log().filter((l) => l.path === "/graphql").every((l) => l.method === "POST" && l.auth === "token")).toBe(true);
  });

  test("re-enqueue: already queued at the head is ok with no mutation", async () => {
    const { gh, forge } = setup();
    const pr = openPull(gh);
    value(await forge.enqueue(pr, H1, live()));
    gh.control.clearLog();
    expect(value(await forge.enqueue(pr, H1, live()))).toEqual({ queued: true });
    expect(graphqlOps(gh)).toEqual(["XarabotPull"]);
    expect(gh.control.queue()).toEqual([pr]);
  });

  test("wrong head: conflict with no mutation", async () => {
    const { gh, forge } = setup();
    const pr = openPull(gh);
    expect(kind(await forge.enqueue(pr, H2, live()))).toBe("conflict");
    expect(graphqlOps(gh)).toEqual(["XarabotPull"]);
    expect(gh.control.queue()).toEqual([]);
  });

  test.each([
    ["closed", { state: "closed", merged: false }],
    ["merged", { state: "closed", merged: true }],
  ] as const)("a %s PR is conflict with no mutation", async (_, pull) => {
    const { gh, forge } = setup();
    gh.control.setPull(1, { ...pull, head_sha: H1 });
    expect(kind(await forge.enqueue(1, H1, live()))).toBe("conflict");
    expect(graphqlOps(gh)).toEqual(["XarabotPull"]);
  });

  test("a missing PR is not-found", async () => {
    const { forge } = setup();
    expect(kind(await forge.enqueue(42, H1, live()))).toBe("not-found");
  });

  test("no permission: FORBIDDEN is forbidden, naming merge_queues: write and AR38", async () => {
    const { gh, forge } = setup();
    const pr = openPull(gh);
    gh.control.denyMergeQueue(true);
    const r = await forge.enqueue(pr, H1, live());
    expect(kind(r)).toBe("forbidden");
    const message = r.ok ? "" : r.error.message;
    expect(message).toContain("merge_queues: write");
    expect(message).toContain("AR38");
    expect(gh.control.queue()).toEqual([]);
  });

  test("a push that moves a queued PR's head takes it out of the queue", async () => {
    const { gh, forge } = setup();
    const pr = openPull(gh);
    value(await forge.enqueue(pr, H1, live()));
    gh.control.setBranch("story/1.10", H2);
    expect(gh.control.queue()).toEqual([]);
    expect(kind(await forge.enqueue(pr, H1, live()))).toBe("conflict");
    expect(value(await forge.enqueue(pr, H2, live()))).toEqual({ queued: true });
  });

  test("a non-200 GraphQL reply goes through mapHttpError", async () => {
    const { gh, forge } = setup();
    openPull(gh);
    gh.control.inject("POST", /^\/graphql$/, { status: 502, body: { message: "Bad Gateway" } });
    expect(kind(await forge.enqueue(1, H1, live()))).toBe("transient");
    gh.control.inject("POST", /^\/graphql$/, { status: 401, body: { message: "Bad credentials" } });
    expect(kind(await forge.enqueue(1, H1, live()))).toBe("auth");
  });

  test("a GraphQL error message quoting the token comes back redacted", async () => {
    const { gh, forge } = setup();
    const pr = openPull(gh);
    value(await forge.dequeue(pr, live()));
    const [token] = gh.control.tokens();
    if (token === undefined) throw new Error("no token minted");
    gh.control.inject("POST", /^\/graphql$/, { status: 200, body: { data: null, errors: [{ type: "FORBIDDEN", message: `token ${token} lacks access` }] } });
    const r = await forge.enqueue(pr, H1, live());
    const message = r.ok ? "" : r.error.message;
    expect(message).toContain("[redacted]");
    expect(message).not.toContain(token);
  });

  test("a GraphQL reply with no data is a malformed reply (transient)", async () => {
    const { gh, forge } = setup();
    gh.control.inject("POST", /^\/graphql$/, { status: 200, body: {} });
    expect(kind(await forge.enqueue(1, H1, live()))).toBe("transient");
  });
});

describe("dequeue", () => {
  test("a PR that is not queued is ok with no mutation", async () => {
    const { gh, forge } = setup();
    const pr = openPull(gh);
    expect(value(await forge.dequeue(pr, live()))).toEqual({ queued: false });
    expect(graphqlOps(gh)).toEqual(["XarabotPull"]);
  });

  test("a queued PR is dequeued with XarabotDequeue on its node id", async () => {
    const { gh, forge } = setup();
    const pr = openPull(gh);
    value(await forge.enqueue(pr, H1, live()));
    gh.control.clearLog();
    expect(value(await forge.dequeue(pr, live()))).toEqual({ queued: false });
    expect(graphqlOps(gh)).toEqual(["XarabotPull", "XarabotDequeue"]);
    expect(graphqlBodies(gh)[1]?.variables).toEqual({ id: `PR_${pr}` });
    expect(graphqlBodies(gh)[1]?.query).toContain("dequeuePullRequest(input: {id: $id})");
    expect(gh.control.queue()).toEqual([]);
  });

  test("a missing PR is not-found", async () => {
    const { forge } = setup();
    expect(kind(await forge.dequeue(42, live()))).toBe("not-found");
  });

  test("no permission on dequeue names merge_queues: write and AR38", async () => {
    const { gh, forge } = setup();
    const pr = openPull(gh);
    value(await forge.enqueue(pr, H1, live()));
    gh.control.denyMergeQueue(true);
    const r = await forge.dequeue(pr, live());
    expect(r.ok ? "" : `${r.error.kind} ${r.error.message}`).toMatch(/^forbidden .*merge_queues: write.*AR38/);
  });
});

describe("mergeQueueHead (emulator)", () => {
  test("merges the front PR: merged, closed and out of the queue", async () => {
    const { gh, forge } = setup();
    const pr = openPull(gh);
    value(await forge.enqueue(pr, H1, live()));
    expect(gh.control.mergeQueueHead()?.number).toBe(pr);
    expect(gh.control.queue()).toEqual([]);
    expect(gh.control.pull(pr)?.["merged"]).toBe(true);
    expect(gh.control.mergeQueueHead()).toBeNull();
  });
});

describe("mapGraphqlErrors", () => {
  const enq = GITHUB_OPERATIONS.enqueuePullRequest;
  const deq = GITHUB_OPERATIONS.dequeuePullRequest;
  const read = GITHUB_OPERATIONS.readPullGraph;

  test.each([
    [read, [{ type: "FORBIDDEN", message: "nope" }], "forbidden"],
    [read, [{ message: "Resource not accessible by integration" }], "forbidden"],
    [enq, [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }], "forbidden"],
    [read, [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest" }], "not-found"],
    [enq, [{ type: "UNPROCESSABLE", message: "Pull request is not mergeable" }], "conflict"],
    [read, [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }], "rate-limited"],
    [read, [{ type: "INTERNAL", message: "Something went wrong" }], "transient"],
    [read, [{ message: "no type" }], "transient"],
    [read, ["not an object"], "transient"],
    [read, [], "transient"],
  ] as const)("case %#: errors on an operation map to the expected kind", (op, errors, expected) => {
    expect([op.name, mapGraphqlErrors(op, errors).error.kind]).toEqual([op.name, expected]);
  });

  test("RATE_LIMITED waits 60 s", () => {
    const e = mapGraphqlErrors(read, [{ type: "RATE_LIMITED", message: "slow" }]).error;
    expect(e.kind === "rate-limited" ? e.retry_after : -1).toBe(60);
  });

  test("FORBIDDEN wins over other errors", () => {
    expect(mapGraphqlErrors(read, [{ type: "NOT_FOUND", message: "x" }, { type: "FORBIDDEN", message: "y" }]).error.kind).toBe("forbidden");
  });

  test("forbidden on a queue mutation names ENQUEUE_PERMISSION and AR38; on a read it does not", () => {
    for (const op of [enq, deq]) {
      const m = mapGraphqlErrors(op, [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }]).error.message;
      expect(m).toContain(ENQUEUE_PERMISSION);
      expect(m).toContain("AR38");
      expect(m.startsWith(`${op.name}: `)).toBe(true);
    }
    expect(mapGraphqlErrors(read, [{ type: "FORBIDDEN", message: "x" }]).error.message).not.toContain("AR38");
  });

  test("the message carries each error's type and message", () => {
    expect(mapGraphqlErrors(read, [{ type: "NOT_FOUND", message: "Could not resolve" }]).error).toEqual({
      kind: "not-found",
      message: "readPullGraph: NOT_FOUND Could not resolve",
    });
  });
});
