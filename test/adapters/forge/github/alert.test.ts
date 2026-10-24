import { describe, expect, test } from "bun:test";
import { alertMarker, createGitHubForge, DEFAULT_INBOX_LABEL, INBOX_TITLE } from "../../../../src/adapters/forge/github/github-forge.ts";
import type { Forge, ForgeResult } from "../../../../src/ports/forge.ts";
import { createFakeGitHub, testKeys, type FakeGitHub } from "./fake-github.ts";

const live = () => ({ signal: new AbortController().signal });
const BOT = "alice-xarabot[bot]";

function setup(extra: { maintainer?: string; inboxLabel?: string } = { maintainer: "alice" }): { gh: FakeGitHub; forge: Forge } {
  const { privateKey, publicKey } = testKeys();
  const gh = createFakeGitHub({ publicKey });
  const forge = createGitHubForge({
    repo: { owner: "acme", name: "widgets" },
    credentials: { app: { id: 4242, slug: "alice-xarabot" }, key: privateKey },
    fetch: gh.fetch,
    apiUrl: gh.control.apiUrl,
    now: gh.control.clock,
    ...extra,
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

function calls(gh: FakeGitHub): string[] {
  return gh.control
    .log()
    .filter((l) => l.host === "api" && l.auth === "token")
    .map((l) => `${l.method} ${l.path.replace("/repos/acme/widgets", "")}`);
}

const inbox = (gh: FakeGitHub, labels: readonly string[] = [DEFAULT_INBOX_LABEL], assignees: readonly string[] = ["alice"]) =>
  gh.control.setIssue({ title: INBOX_TITLE, body: "", state: "open", labels, assignees });

describe("alert", () => {
  test("a missing inbox is created with the label and assigned; one comment is posted", async () => {
    const { gh, forge } = setup();
    const main = gh.control.ref("main") as string;
    expect(value(await forge.alert("forge-auth", main, live()))).toEqual({ posted: true });
    const [issue, ...more] = gh.control.issues();
    expect(more).toEqual([]);
    expect(issue).toMatchObject({ title: "🤖 Xarabot inbox", state: "open", labels: ["xarabot-inbox"], assignees: ["alice"] });
    expect(gh.control.comments(issue?.number as number)).toEqual([
      `🤖 @alice Xarabot alert: \`forge-auth\` stops every lane (main \`${main}\`).\n\n<!-- xarabot-alert forge-auth ${main} -->`,
    ]);
  });

  test.each([
    ["coordinator-missing", "missing"],
    ["coordinator-expired", "expired"],
  ] as const)("%s says the claim is %s and builders keep going, with the same marker and mention", async (condition, state) => {
    const { gh, forge } = setup();
    const main = gh.control.ref("main") as string;
    expect(value(await forge.alert(condition, main, live()))).toEqual({ posted: true });
    expect(gh.control.comments(1)).toEqual([
      `🤖 @alice Xarabot alert: \`${condition}\`: the coordinator claim is ${state}; builders keep going (main \`${main}\`).\n\n<!-- xarabot-alert ${condition} ${main} -->`,
    ]);
  });

  test("the list query and request order", async () => {
    const { gh, forge } = setup();
    const main = gh.control.ref("main") as string;
    value(await forge.alert("c", main, live()));
    const [list, create, commit, comments, post] = calls(gh);
    expect(list).toBe("GET /issues?labels=xarabot-inbox&assignee=alice&state=open&sort=created&direction=asc&per_page=100&page=1");
    expect(create).toBe("POST /issues");
    expect(commit).toBe(`GET /git/commits/${main}`);
    expect(comments).toStartWith(`GET /issues/1/comments?since=`);
    expect(post).toBe("POST /issues/1/comments");
  });

  test("a repeat alert posts nothing", async () => {
    const { gh, forge } = setup();
    const main = gh.control.ref("main") as string;
    value(await forge.alert("forge-auth", main, live()));
    gh.control.clearLog();
    expect(value(await forge.alert("forge-auth", main, live()))).toEqual({ posted: false });
    expect(calls(gh).filter((c) => c.startsWith("POST"))).toEqual([]);
    expect(gh.control.comments(1)).toHaveLength(1);
  });

  test("another condition or SHA posts again on the same inbox", async () => {
    const { gh, forge } = setup();
    const a = gh.control.ref("main") as string;
    value(await forge.alert("x", a, live()));
    expect(value(await forge.alert("y", a, live()))).toEqual({ posted: true });
    expect(value(await forge.alert("x", "b".repeat(40), live()))).toEqual({ posted: true });
    expect(gh.control.issues()).toHaveLength(1);
    expect(gh.control.comments(1)).toHaveLength(3);
  });

  test("a marker in a comment by another user does not dedupe", async () => {
    const { gh, forge } = setup();
    const main = gh.control.ref("main") as string;
    const n = inbox(gh);
    gh.control.addComment(n, `pasted ${alertMarker("forge-auth", main)}`, "mallory");
    expect(value(await forge.alert("forge-auth", main, live()))).toEqual({ posted: true });
    expect(gh.control.commentRecords(n).map((c) => c.login)).toEqual(["mallory", BOT]);
  });

  test("the lowest-numbered matching open issue is used; PRs, closed and unassigned issues are not", async () => {
    const { gh, forge } = setup();
    gh.control.setIssue({ number: 3, title: "other", body: "", state: "open", labels: ["xarabot-inbox"], assignees: ["bob"] });
    gh.control.setIssue({ number: 4, title: "old", body: "", state: "closed", labels: ["xarabot-inbox"], assignees: ["alice"] });
    gh.control.setIssue({ number: 9, title: "late", body: "", state: "open", labels: ["xarabot-inbox"], assignees: ["alice"] });
    gh.control.setIssue({ number: 6, title: "early", body: "", state: "open", labels: ["xarabot-inbox", "x"], assignees: ["alice"] });
    value(await forge.alert("c", "a".repeat(40), live()));
    expect(gh.control.comments(6)).toHaveLength(1);
    expect(gh.control.comments(9)).toHaveLength(0);
  });

  test("entries with pull_request are dropped", async () => {
    const { gh, forge } = setup();
    const n = gh.control.setIssue({ number: 5, title: INBOX_TITLE, body: "", state: "open", labels: [DEFAULT_INBOX_LABEL], assignees: ["alice"] });
    gh.control.setPull(1, { state: "open", merged: false, head_sha: "1".repeat(40) });
    gh.control.inject("GET", /^\/repos\/acme\/widgets\/issues\?/, {
      status: 200,
      body: [
        { number: 1, pull_request: { url: "x" } },
        { number: n },
      ],
    });
    value(await forge.alert("c", "a".repeat(40), live()));
    expect(gh.control.comments(1)).toEqual([]);
    expect(gh.control.comments(n)).toHaveLength(1);
  });

  test("inboxLabel overrides the label", async () => {
    const { gh, forge } = setup({ maintainer: "alice", inboxLabel: "ops inbox" });
    value(await forge.alert("c", "a".repeat(40), live()));
    expect(calls(gh)[0]).toStartWith("GET /issues?labels=ops%20inbox&");
    expect(gh.control.issues()[0]?.labels).toEqual(["ops inbox"]);
  });

  test("the comment list asks for since = mainSha's committer date less 24 h", async () => {
    const { gh, forge } = setup();
    gh.control.setNow("2026-10-20T12:00:00Z");
    const n = inbox(gh);
    gh.control.addComment(n, "very old", BOT);
    gh.control.setNow("2026-10-23T08:00:00Z");
    const main = gh.control.setMain({ "a.md": "x" });
    gh.control.setNow("2026-10-23T09:00:00Z");
    value(await forge.alert("c", main, live()));
    const list = calls(gh).find((c) => c.startsWith(`GET /issues/${n}/comments`));
    expect(list).toBe(`GET /issues/${n}/comments?since=${encodeURIComponent("2026-10-22T08:00:00Z")}&per_page=100&page=1`);
  });

  test("a bot marker comment inside the lower bound dedupes", async () => {
    const { gh, forge } = setup();
    const n = inbox(gh);
    gh.control.setNow("2026-10-21T00:00:00Z");
    const main = gh.control.setMain({ "a.md": "x" });
    gh.control.setNow("2026-10-20T01:00:00Z");
    gh.control.addComment(n, alertMarker("c", main), BOT);
    expect(value(await forge.alert("c", main, live()))).toEqual({ posted: false });
  });

  test("a bot marker comment older than committer date less 24 h does not dedupe", async () => {
    const { gh, forge } = setup();
    const n = inbox(gh);
    gh.control.setNow("2026-10-21T00:00:00Z");
    const main = gh.control.setMain({ "a.md": "x" });
    gh.control.setNow("2026-10-19T23:59:59Z");
    gh.control.addComment(n, alertMarker("c", main), BOT);
    expect(value(await forge.alert("c", main, live()))).toEqual({ posted: true });
    expect(gh.control.commentRecords(n)).toHaveLength(2);
  });

  test("since is omitted when GitHub has no such commit (404 or 422)", async () => {
    for (const status of [404, 422]) {
      const { gh, forge } = setup();
      gh.control.inject("GET", /\/git\/commits\//, { status, body: { message: "No commit found" } });
      value(await forge.alert("c", "a".repeat(40), live()));
      expect(calls(gh).find((c) => c.includes("/comments?"))).toBe("GET /issues/1/comments?per_page=100&page=1");
    }
  });

  test("another commit-read error stops the alert", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", /\/git\/commits\//, { status: 500, body: {} });
    expect(kind(await forge.alert("c", "a".repeat(40), live()))).toBe("transient");
  });

  test("backticks and newlines in the shown condition are neutralised; the marker encodes the raw condition", async () => {
    const { gh, forge } = setup();
    const sha = "a".repeat(40);
    const condition = "bad `config`\nline two\r\n--> x";
    value(await forge.alert(condition, sha, live()));
    const [body] = gh.control.comments(1);
    expect(body).toBe(
      `🤖 @alice Xarabot alert: \`bad 'config' line two --> x\` stops every lane (main \`${sha}\`).\n\n<!-- xarabot-alert ${encodeURIComponent(condition)} ${sha} -->`,
    );
    expect(value(await forge.alert(condition, sha, live()))).toEqual({ posted: false });
  });

  test("a missing or invalid maintainer is forbidden and makes no request", async () => {
    for (const maintainer of [undefined, "", "-alice", "al ice", "a".repeat(40), "alice--x", "alice-"]) {
      const { gh, forge } = setup(maintainer === undefined ? {} : { maintainer });
      expect([maintainer, kind(await forge.alert("c", "a".repeat(40), live()))]).toEqual([maintainer, "forbidden"]);
      expect(calls(gh)).toEqual([]);
    }
  });

  test("a non-hex mainSha is not-found and makes no request", async () => {
    const { gh, forge } = setup();
    expect(kind(await forge.alert("c", "main", live()))).toBe("not-found");
    expect(calls(gh)).toEqual([]);
  });

  test("a missing issues permission names issues: write", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", /\/issues\?/, { status: 403, body: { message: "Resource not accessible by integration" } });
    const r = await forge.alert("c", "a".repeat(40), live());
    expect(r.ok ? "" : `${r.error.kind} ${r.error.message}`).toMatch(/^forbidden .*\(needs issues: write\)$/);
  });

  test("failing closed: an invalid config on main and no runnerGit still posts", async () => {
    const { gh, forge } = setup();
    const main = gh.control.setMain({ ".xarabot/config.yaml": "{ not: [valid yaml", ".xarabot/policy.yaml": "\u0000" });
    gh.control.clearLog();
    expect(value(await forge.alert("config-invalid", main, live()))).toEqual({ posted: true });
    expect(calls(gh).some((c) => /\/git\/(trees|blobs|ref)/.test(c))).toBe(false);
  });
});
