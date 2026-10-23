import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createGitHubForge } from "../../../../src/adapters/forge/github/github-forge.ts";
import type { Forge, ForgeResult } from "../../../../src/ports/forge.ts";
import { createFakeGitHub, testKeys, type FakeGitHub, type InjectedResponse, type LoggedRequest } from "./fake-github.ts";

const live = () => ({ signal: new AbortController().signal });
const H1 = "1".repeat(40);
const H2 = "2".repeat(40);

function setup(): { gh: FakeGitHub; forge: Forge } {
  const { privateKey, publicKey } = testKeys();
  const gh = createFakeGitHub({ publicKey });
  const forge = createGitHubForge({
    repo: { owner: "acme", name: "widgets" },
    credentials: { app: { id: 4242, slug: "alice-xarabot" }, key: privateKey },
    fetch: gh.fetch,
    apiUrl: gh.control.apiUrl,
    now: gh.control.clock,
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

type GqlBody = { query: string; variables: Record<string, unknown> };

function graphqlCalls(gh: FakeGitHub): GqlBody[] {
  return gh.control
    .log()
    .filter((l: LoggedRequest) => l.host === "api" && l.path === "/graphql")
    .map((l) => {
      expect([l.method, l.auth]).toEqual(["POST", "token"]);
      return l.body as GqlBody;
    });
}

/** The GraphQL request after the next one (the mutation after the state query) gets `response`. */
function onMutation(gh: FakeGitHub, response: InjectedResponse): void {
  const graphql = /^\/graphql$/;
  // A hook runs before the injection check of its own request, so the inner hook arms the injection for the next one.
  gh.control.before("POST", graphql, () => gh.control.before("POST", graphql, () => gh.control.inject("POST", graphql, response)));
}

const isMutation = (b: GqlBody): boolean => /^\s*mutation\b/.test(b.query);

/** An open PR #7 on `story/1.10` at H1. */
function openPr(gh: FakeGitHub): void {
  gh.control.setBranch("story/1.10", H1);
  gh.control.setPull(7, { state: "open", merged: false, head_sha: H1, branch: "story/1.10" });
}

describe("enqueue", () => {
  test("an open PR at the expected head, not queued: one query, then the mutation with expectedHeadOid", async () => {
    const { gh, forge } = setup();
    openPr(gh);
    expect(value(await forge.enqueue(7, H1, live()))).toEqual({ queued: true });
    expect(gh.control.queue()).toEqual([7]);
    const [query, mutation, ...rest] = graphqlCalls(gh);
    expect(rest).toEqual([]);
    expect(query?.query).toMatch(/^query\b.*repository\(owner: \$owner, name: \$name\).*pullRequest\(number: \$number\).*id state headRefOid mergeQueueEntry \{ id \}/);
    expect(query?.variables).toEqual({ owner: "acme", name: "widgets", number: 7 });
    expect(mutation?.query).toMatch(/^mutation\b.*enqueuePullRequest\(input: \{ pullRequestId: \$pullRequestId, expectedHeadOid: \$expectedHeadOid \}\)/);
    expect(mutation?.variables).toEqual({ pullRequestId: "PR_7", expectedHeadOid: H1 });
  });

  test("a wrong head is conflict and sends no mutation", async () => {
    const { gh, forge } = setup();
    openPr(gh);
    expect(kind(await forge.enqueue(7, H2, live()))).toBe("conflict");
    expect(graphqlCalls(gh).filter(isMutation)).toEqual([]);
    expect(gh.control.queue()).toEqual([]);
  });

  test("an already-queued PR is ok and sends no mutation", async () => {
    const { gh, forge } = setup();
    openPr(gh);
    value(await forge.enqueue(7, H1, live()));
    gh.control.clearLog();
    expect(value(await forge.enqueue(7, H1, live()))).toEqual({ queued: true });
    expect(graphqlCalls(gh).filter(isMutation)).toEqual([]);
    expect(gh.control.queue()).toEqual([7]);
  });

  test("a closed or merged PR is conflict; a missing PR is not-found", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(8, { state: "closed", merged: false, head_sha: H1 });
    gh.control.setPull(9, { state: "closed", merged: true, head_sha: H1 });
    expect(kind(await forge.enqueue(8, H1, live()))).toBe("conflict");
    expect(kind(await forge.enqueue(9, H1, live()))).toBe("conflict");
    expect(kind(await forge.enqueue(404, H1, live()))).toBe("not-found");
    expect(graphqlCalls(gh).filter(isMutation)).toEqual([]);
  });

  test("a mutation answering 200 with FORBIDDEN errors is forbidden and names contents: write", async () => {
    const { gh, forge } = setup();
    openPr(gh);
    onMutation(gh, { status: 200, body: { data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] } });
    const r = await forge.enqueue(7, H1, live());
    expect(r.ok ? "ok" : r.error.kind).toBe("forbidden");
    expect(r.ok ? "" : r.error.message).toContain("contents: write");
  });

  test("a mutation refused for PR state is conflict; one saying already queued is ok", async () => {
    for (const [message, expected] of [
      ["Pull request is not mergeable", "conflict"],
      ["Pull request is already queued", "ok"],
      ["This pull request is already enqueued", "ok"],
      ["Pull request is already in the queue", "ok"],
    ] as const) {
      const { gh, forge } = setup();
      openPr(gh);
      onMutation(gh, { status: 200, body: { data: null, errors: [{ type: "UNPROCESSABLE", message }] } });
      expect([message, kind(await forge.enqueue(7, H1, live()))]).toEqual([message, expected]);
    }
  });

  test("an already-queued error beside a FORBIDDEN error is forbidden", async () => {
    const { gh, forge } = setup();
    openPr(gh);
    onMutation(gh, {
      status: 200,
      body: { data: null, errors: [{ type: "UNPROCESSABLE", message: "Pull request is already queued" }, { type: "FORBIDDEN", message: "Resource not accessible by integration" }] },
    });
    expect(kind(await forge.enqueue(7, H1, live()))).toBe("forbidden");
  });

  test("query errors map with fallback transient; an HTTP error goes through mapHttpError", async () => {
    const { gh, forge } = setup();
    openPr(gh);
    gh.control.inject("POST", /^\/graphql$/, { status: 200, body: { errors: [{ type: "SOMETHING_NEW", message: "?" }] } });
    expect(kind(await forge.enqueue(7, H1, live()))).toBe("transient");
    gh.control.inject("POST", /^\/graphql$/, { status: 200, body: { errors: [{ message: "Field 'mergeQueueEntry' doesn't exist" }] } });
    expect(kind(await forge.enqueue(7, H1, live()))).toBe("forbidden");
    gh.control.inject("POST", /^\/graphql$/, { status: 502, body: {} });
    expect(kind(await forge.enqueue(7, H1, live()))).toBe("transient");
    gh.control.inject("POST", /^\/graphql$/, { status: 403, body: { message: "Resource not accessible by integration" } });
    const r = await forge.enqueue(7, H1, live());
    expect(r.ok ? "" : `${r.error.kind} ${r.error.message}`).toMatch(/^forbidden pullQueueState: 403 .*\(needs pull_requests: write\)$/);
  });

  test("a head move or a close drops the queue entry", async () => {
    const { gh, forge } = setup();
    openPr(gh);
    value(await forge.enqueue(7, H1, live()));
    gh.control.setBranch("story/1.10", H2);
    expect(gh.control.queue()).toEqual([]);
    value(await forge.enqueue(7, H2, live()));
    value(await forge.closePr(7, live()));
    expect(gh.control.queue()).toEqual([]);
  });
});

describe("dequeue", () => {
  test("a queued PR: the query, then dequeuePullRequest with the node id", async () => {
    const { gh, forge } = setup();
    openPr(gh);
    value(await forge.enqueue(7, H1, live()));
    gh.control.clearLog();
    expect(value(await forge.dequeue(7, live()))).toEqual({ queued: false });
    expect(gh.control.queue()).toEqual([]);
    const [query, mutation, ...rest] = graphqlCalls(gh);
    expect(rest).toEqual([]);
    expect(query?.variables).toEqual({ owner: "acme", name: "widgets", number: 7 });
    expect(mutation?.query).toMatch(/^mutation\b.*dequeuePullRequest\(input: \{ id: \$id \}\)/);
    expect(mutation?.variables).toEqual({ id: "PR_7" });
  });

  test("a PR that is not queued is ok and sends no mutation", async () => {
    const { gh, forge } = setup();
    openPr(gh);
    expect(value(await forge.dequeue(7, live()))).toEqual({ queued: false });
    expect(graphqlCalls(gh).filter(isMutation)).toEqual([]);
  });

  test("a missing PR is not-found", async () => {
    const { forge } = setup();
    expect(kind(await forge.dequeue(404, live()))).toBe("not-found");
  });

  test("a mutation saying not in the queue is ok; another refusal is conflict", async () => {
    for (const [message, expected] of [
      ["Pull request is not in the queue", "ok"],
      ["Pull request is not in queue", "ok"],
      ["Pull request is not queued", "ok"],
      ["Something else", "conflict"],
    ] as const) {
      const { gh, forge } = setup();
      openPr(gh);
      value(await forge.enqueue(7, H1, live()));
      onMutation(gh, { status: 200, body: { data: null, errors: [{ type: "UNPROCESSABLE", message }] } });
      expect([message, kind(await forge.dequeue(7, live()))]).toEqual([message, expected]);
    }
  });
});

describe("the adapter source", () => {
  test("has no merge, auto-merge, admin, branch-delete or DELETE path", () => {
    const dir = join(import.meta.dir, "../../../../src/adapters/forge/github");
    const hits: string[] = [];
    for (const file of readdirSync(dir)) {
      const lines = readFileSync(join(dir, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/mergePullRequest|enablePullRequestAutoMerge|auto[-_]?merge|--admin|delete-branch|method: "DELETE"|\/merge\b/i.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
