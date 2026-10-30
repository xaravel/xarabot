import { describe, expect, test } from "bun:test";
import { createGitHubForge, DEFAULT_INBOX_LABEL, INBOX_TITLE, RULINGS_SETTLE_MS } from "../../../../src/adapters/forge/github/github-forge.ts";
import { formatDate, GITHUB_OPERATIONS } from "../../../../src/adapters/forge/github/http.ts";
import type { Forge, ForgeResult } from "../../../../src/ports/forge.ts";
import { createFakeGitHub, testKeys, type FakeGitHub } from "./fake-github.ts";

const live = () => ({ signal: new AbortController().signal });

function setup(extra: { inboxLabel?: string } = {}): { gh: FakeGitHub; forge: Forge } {
  const { privateKey, publicKey } = testKeys();
  const gh = createFakeGitHub({ publicKey });
  const forge = createGitHubForge({
    repo: { owner: "acme", name: "widgets" },
    credentials: { app: { id: 4242, slug: "alice-xarabot" }, key: privateKey },
    fetch: gh.fetch,
    apiUrl: gh.control.apiUrl,
    now: gh.control.clock,
    maintainer: "alice",
    ...extra,
  });
  return { gh, forge };
}

function value<T>(r: ForgeResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.value;
}

const kind = <T>(r: ForgeResult<T>): string => (r.ok ? "ok" : r.error.kind);

function calls(gh: FakeGitHub): string[] {
  return gh.control
    .log()
    .filter((l) => l.host === "api" && l.auth === "token")
    .map((l) => `${l.method} ${l.path.replace("/repos/acme/widgets", "")}`);
}

const issue = (gh: FakeGitHub, assignees: readonly string[], over: { body?: string; state?: "open" | "closed"; labels?: readonly string[] } = {}) =>
  gh.control.setIssue({ title: INBOX_TITLE, body: over.body ?? "", state: over.state ?? "open", labels: over.labels ?? [DEFAULT_INBOX_LABEL], assignees });

describe("the inbox operations (Story 4.2)", () => {
  test("updateIssue is a PATCH under issues: write", () => {
    expect(GITHUB_OPERATIONS.updateIssue).toEqual({ name: "updateIssue", method: "PATCH", permission: "issues: write" });
  });

  test("inboxes lists every open labelled issue, ascending, with its first assignee as owner; closed, unlabelled and unassigned ones are told apart", async () => {
    const { gh, forge } = setup();
    const bob = issue(gh, ["bob", "carol"], { body: "b" });
    issue(gh, ["alice"], { state: "closed" });
    issue(gh, ["alice"], { labels: ["other"] });
    const nobody = issue(gh, []);
    expect(value(await forge.inboxes(live()))).toEqual([
      { number: bob, owner: "bob", body: "b", url: `https://github.com/acme/widgets/issues/${bob}` },
      { number: nobody, owner: null, body: "", url: `https://github.com/acme/widgets/issues/${nobody}` },
    ]);
    expect(calls(gh)).toEqual(["GET /issues?labels=xarabot-inbox&state=open&sort=created&direction=asc&per_page=100&page=1"]);
  });

  test("a PR in the issue list is left out, and a null body reads as empty", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", /^\/repos\/acme\/widgets\/issues\?/, {
      status: 200,
      body: [
        { number: 4, body: null, assignees: [{ login: "alice" }], html_url: "https://github.com/acme/widgets/issues/4" },
        { number: 3, body: "x", assignees: [{ login: "bob" }], pull_request: {} },
      ],
    });
    expect(value(await forge.inboxes(live()))).toEqual([{ number: 4, owner: "alice", body: "", url: "https://github.com/acme/widgets/issues/4" }]);
  });

  test("a malformed issue is transient", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", /^\/repos\/acme\/widgets\/issues\?/, { status: 200, body: [{ title: "no number" }] });
    expect(kind(await forge.inboxes(live()))).toBe("transient");
  });

  test("openInbox returns the owner's lowest-numbered open inbox, matched by assignee", async () => {
    const { gh, forge } = setup();
    issue(gh, ["bob"]);
    const low = issue(gh, ["alice"], { body: "mine" });
    issue(gh, ["alice"]);
    expect(value(await forge.openInbox("alice", live()))).toMatchObject({ number: low, owner: "alice", body: "mine" });
    expect(calls(gh)).toEqual(["GET /issues?labels=xarabot-inbox&assignee=alice&state=open&sort=created&direction=asc&per_page=100&page=1"]);
    expect(gh.control.issues()).toHaveLength(3);
  });

  test("openInbox skips an issue another owner holds, even when the login is among its assignees", async () => {
    const { gh, forge } = setup();
    const bobs = issue(gh, ["bob", "alice"], { body: "bob's" });
    const created = value(await forge.openInbox("alice", live()));
    expect(created.number).not.toBe(bobs);
    expect(created.owner).toBe("alice");
    expect(value(await forge.openInbox("alice", live())).number).toBe(created.number);
    expect(value(await forge.openInbox("bob", live())).number).toBe(bobs);
    expect(gh.control.issues().find((i) => i.number === bobs)?.body).toBe("bob's");
  });

  test("openInbox creates a missing inbox: titled, labelled with the configured label, assigned, with an empty body", async () => {
    const { gh, forge } = setup({ inboxLabel: "my-inbox" });
    const created = value(await forge.openInbox("bob", live()));
    expect(gh.control.issues()).toEqual([{ number: created.number, title: "🤖 Xarabot inbox", body: "", state: "open", labels: ["my-inbox"], assignees: ["bob"] }]);
    expect(created).toEqual({ number: created.number, owner: "bob", body: "", url: `https://github.com/acme/widgets/issues/${created.number}` });
    expect(calls(gh)).toEqual(["GET /issues?labels=my-inbox&assignee=bob&state=open&sort=created&direction=asc&per_page=100&page=1", "POST /issues"]);
  });

  test("openInbox refuses a non-login before any request", async () => {
    const { gh, forge } = setup();
    expect(kind(await forge.openInbox("bob smith", live()))).toBe("rejected");
    expect(calls(gh)).toEqual([]);
  });

  test("setInboxBody PATCHes the body and returns the issue; a missing one is not-found", async () => {
    const { gh, forge } = setup();
    const n = issue(gh, ["alice"], { body: "old" });
    expect(value(await forge.setInboxBody(n, "new body", live()))).toMatchObject({ number: n, owner: "alice", body: "new body" });
    expect(gh.control.issues()[0]?.body).toBe("new body");
    const patch = gh.control.log().find((l) => l.method === "PATCH");
    expect(patch).toMatchObject({ path: `/repos/acme/widgets/issues/${n}`, body: { body: "new body" } });
    expect(kind(await forge.setInboxBody(999, "x", live()))).toBe("not-found");
  });

  test("inboxComment posts the body verbatim, by the bot; a missing issue is not-found", async () => {
    const { gh, forge } = setup();
    const n = issue(gh, ["alice"]);
    const posted = value(await forge.inboxComment(n, "🤖 @alice digest", live()));
    expect(typeof posted.id).toBe("string");
    expect(gh.control.commentRecords(n)).toMatchObject([{ body: "🤖 @alice digest", login: "alice-xarabot[bot]" }]);
    expect(kind(await forge.inboxComment(999, "x", live()))).toBe("not-found");
  });

  test("alert still posts on the Maintainer's inbox, created with its alerts body", async () => {
    const { gh, forge } = setup();
    const main = gh.control.ref("main") as string;
    expect(value(await forge.alert("forge-auth", main, live()))).toEqual({ posted: true });
    const [inbox] = gh.control.issues();
    expect(inbox?.body).toContain("Xarabot posts alerts for @alice here");
    expect(value(await forge.openInbox("alice", live())).number).toBe(inbox?.number as number);
  });
});

describe("readRulings (Story 4.5)", () => {
  const T = "2026-01-01T00:00:00Z";
  const commentsCalls = (gh: FakeGitHub) => calls(gh).filter((c) => c.includes("/comments"));

  /** The floor a read whose inbox listing is dated `iso` writes: that time less `RULINGS_SETTLE_MS`. */
  const floorOf = (iso: string) => formatDate(Date.parse(iso) - RULINGS_SETTLE_MS);

  test("reads each open inbox's comments, oldest first by (created_at, id), and writes its cursor as <floor>|0|<ids returned past it>", async () => {
    const { gh, forge } = setup();
    const a = issue(gh, ["alice"]);
    const b = issue(gh, ["bob"]);
    gh.control.addComment(b, "/xarabot go retro:2", "edanisko");
    gh.control.addComment(a, "thanks", "alice");
    gh.control.advance(1000);
    gh.control.addComment(a, "later", "carol");
    const r = value(await forge.readRulings(null, live()));
    const ids = [...gh.control.commentRecords(b), ...gh.control.commentRecords(a)].map((c) => String(c.id)) as [string, string, string];
    expect(r.comments).toEqual([
      { id: ids[0], issue: b, author: "edanisko", body: "/xarabot go retro:2", created_at: T, url: `https://github.com/acme/widgets/issues/${b}#issuecomment-${ids[0]}` },
      { id: ids[1], issue: a, author: "alice", body: "thanks", created_at: T, url: `https://github.com/acme/widgets/issues/${a}#issuecomment-${ids[1]}` },
      { id: ids[2], issue: a, author: "carol", body: "later", created_at: "2026-01-01T00:00:01Z", url: `https://github.com/acme/widgets/issues/${a}#issuecomment-${ids[2]}` },
    ]);
    // Every comment is younger than the read's start less the settle time, so each rides the cursor.
    expect(r.cursor).toBe(`${floorOf("2026-01-01T00:00:01Z")}|0|${ids.join(",")}`);
    // From no cursor, no `since`.
    expect(commentsCalls(gh)).toEqual([`GET /issues/${a}/comments?per_page=100&page=1`, `GET /issues/${b}/comments?per_page=100&page=1`]);
  });

  test("the since query is sent from the cursor's floor, and a comment the cursor names is not returned again", async () => {
    const { gh, forge } = setup();
    const a = issue(gh, ["alice"]);
    gh.control.addComment(a, "first", "carol");
    const r1 = value(await forge.readRulings(null, live()));
    gh.control.addComment(a, "/xarabot release story:1.1", "dave");
    gh.control.clearLog();
    const r2 = value(await forge.readRulings(r1.cursor, live()));
    expect(r2.comments.map((c) => [c.author, c.body])).toEqual([["dave", "/xarabot release story:1.1"]]);
    expect(commentsCalls(gh)).toEqual([`GET /issues/${a}/comments?since=${encodeURIComponent(floorOf(T))}&per_page=100&page=1`]);
    expect(r2.cursor).toBe(`${floorOf(T)}|0|${gh.control.commentRecords(a).map((c) => c.id).join(",")}`);
    expect(value(await forge.readRulings(r2.cursor, live()))).toEqual({ comments: [], cursor: r2.cursor });
  });

  test("C2: with two inboxes, a comment posted on the one read first while the other is read is returned by the next read", async () => {
    const { gh, forge } = setup();
    const a = issue(gh, ["alice"]);
    const b = issue(gh, ["bob"]);
    gh.control.addComment(a, "A1", "alice");
    gh.control.addComment(b, "B1", "bob");
    gh.control.advance(10_000);
    // Between the two lists: A2 on the inbox already read, then B2, newer still, on the one about to be.
    gh.control.before("GET", new RegExp(`^/repos/acme/widgets/issues/${b}/comments\\?`), () => {
      gh.control.advance(1000);
      gh.control.addComment(a, "A2", "carol");
      gh.control.advance(1000);
      gh.control.addComment(b, "B2", "dave");
    });
    const r1 = value(await forge.readRulings(null, live()));
    expect(r1.comments.map((c) => [c.body, c.created_at])).toEqual([
      ["A1", T],
      ["B1", T],
      ["B2", "2026-01-01T00:00:12Z"],
    ]);
    // The floor stays at the read's start less the settle time, behind A2.
    const [a1, a2] = gh.control.commentRecords(a).map((c) => c.id) as [number, number];
    const [b1, b2] = gh.control.commentRecords(b).map((c) => c.id) as [number, number];
    expect(r1.cursor).toBe(`${floorOf("2026-01-01T00:00:10Z")}|0|${[a1, b1, b2].join(",")}`);
    const r2 = value(await forge.readRulings(r1.cursor, live()));
    expect(r2.comments.map((c) => [c.issue, c.author, c.body])).toEqual([[a, "carol", "A2"]]);
    expect(r2.cursor).toBe(`${floorOf("2026-01-01T00:00:12Z")}|0|${[a1, b1, a2, b2].join(",")}`);
    expect(value(await forge.readRulings(r2.cursor, live()))).toEqual({ comments: [], cursor: r2.cursor });
  });

  test("the floor moves up to the read's start less RULINGS_SETTLE_MS, and the ids it passes leave the cursor", async () => {
    const { gh, forge } = setup();
    const a = issue(gh, ["alice"]);
    gh.control.addComment(a, "old", "alice");
    const r1 = value(await forge.readRulings(null, live()));
    const [old] = gh.control.commentRecords(a).map((c) => c.id) as [number];
    expect(r1.cursor).toBe(`${floorOf(T)}|0|${old}`);
    gh.control.advance(2 * RULINGS_SETTLE_MS);
    gh.control.addComment(a, "new", "bob");
    const r2 = value(await forge.readRulings(r1.cursor, live()));
    expect(r2.comments.map((c) => c.body)).toEqual(["new"]);
    const later = formatDate(Date.parse(T) + 2 * RULINGS_SETTLE_MS);
    // `old` is behind the new floor now, so the cursor no longer names it.
    expect(r2.cursor).toBe(`${floorOf(later)}|0|${gh.control.commentRecords(a)[1]?.id}`);
  });

  test("a two-part cursor's floor is kept while it is ahead of the read's start less the settle time", async () => {
    const { gh, forge } = setup();
    const a = issue(gh, ["alice"]);
    gh.control.addComment(a, "seen", "alice");
    const seen = gh.control.commentRecords(a)[0]?.id;
    gh.control.addComment(a, "unseen", "bob");
    const r = value(await forge.readRulings(`${T}|${seen}`, live()));
    expect(r.comments.map((c) => c.body)).toEqual(["unseen"]);
    expect(r.cursor).toBe(`${T}|${seen}|${gh.control.commentRecords(a)[1]?.id}`);
  });

  test("a comment listed twice is returned once; no Date header is transient", async () => {
    const { gh, forge } = setup();
    const a = issue(gh, ["alice"]);
    const twice = { id: 7, body: "/xarabot go retro:2", user: { login: "alice" }, created_at: T };
    gh.control.inject("GET", /\/comments\?/, { status: 200, body: [twice, twice] });
    const r = value(await forge.readRulings(null, live()));
    expect(r.comments.map((c) => [c.issue, c.id])).toEqual([[a, "7"]]);
    expect(r.cursor).toBe(`${floorOf(T)}|0|7`);
    gh.control.omitDate(true);
    expect(kind(await forge.readRulings(null, live()))).toBe("transient");
  });

  test("a closed inbox's comments are skipped: its comments are never listed", async () => {
    const { gh, forge } = setup();
    const open = issue(gh, ["alice"]);
    const closed = issue(gh, ["bob"], { state: "closed" });
    gh.control.addComment(closed, "/xarabot go retro:2", "edanisko");
    gh.control.addComment(open, "hello", "alice");
    expect(value(await forge.readRulings(null, live())).comments.map((c) => c.issue)).toEqual([open]);
    expect(commentsCalls(gh)).toEqual([`GET /issues/${open}/comments?per_page=100&page=1`]);
  });

  test("comments are paged", async () => {
    const { gh, forge } = setup();
    const a = issue(gh, ["alice"]);
    for (let i = 0; i < 150; i += 1) gh.control.addComment(a, `c${i}`, "alice");
    const r = value(await forge.readRulings(null, live()));
    expect(r.comments.map((c) => c.body)).toEqual(Array.from({ length: 150 }, (_, i) => `c${i}`));
    expect(commentsCalls(gh)).toEqual([`GET /issues/${a}/comments?per_page=100&page=1`, `GET /issues/${a}/comments?per_page=100&page=2`]);
  });

  test("a comment edited after the cursor but posted before it is not returned again; a missing html_url links under the issue", async () => {
    const { gh, forge } = setup();
    const a = issue(gh, ["alice"]);
    const cursor = `${T}|500`;
    gh.control.inject("GET", /\/comments\?/, {
      status: 200,
      body: [
        { id: 400, body: "old, edited", user: { login: "alice" }, created_at: "2025-12-31T23:59:59Z", updated_at: "2026-01-01T00:00:05Z" },
        { id: 499, body: "same second, lower id", user: { login: "alice" }, created_at: T },
        { id: 501, body: "new", user: { login: "bob" }, created_at: T },
        { id: 502, body: null, user: null, created_at: "2026-01-01T00:00:01Z" },
      ],
    });
    const r = value(await forge.readRulings(cursor, live()));
    expect(r.comments).toEqual([
      { id: "501", issue: a, author: "bob", body: "new", created_at: T, url: `https://github.com/acme/widgets/issues/${a}#issuecomment-501` },
      { id: "502", issue: a, author: null, body: "", created_at: "2026-01-01T00:00:01Z", url: `https://github.com/acme/widgets/issues/${a}#issuecomment-502` },
    ]);
    expect(r.cursor).toBe(`${T}|500|501,502`);
  });

  test.each([
    "nope",
    "",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z|",
    "2026-01-01T00:00:00Z|x",
    "yesterday|5",
    "2026-01-01T00:00:00Z|05",
    "2026-01-01T00:00:00Z|0|",
    "2026-01-01T00:00:00Z|0|x",
    "2026-01-01T00:00:00Z|0|1,,2",
    "2026-01-01T00:00:00Z|0|01",
    "2026-01-01T00:00:00Z|0|1|2",
    "2026-01-01T00:00:00Z|0|99999999999999999",
  ])(
    "the cursor %p is rejected before any request",
    async (cursor) => {
      const { gh, forge } = setup();
      expect(kind(await forge.readRulings(cursor, live()))).toBe("rejected");
      expect(calls(gh)).toEqual([]);
    },
  );

  test("a malformed comment is transient; a failed list is its error", async () => {
    const { gh, forge } = setup();
    issue(gh, ["alice"]);
    gh.control.inject("GET", /\/comments\?/, { status: 200, body: [{ id: "x", body: "b", created_at: T }] });
    expect(kind(await forge.readRulings(null, live()))).toBe("transient");
    gh.control.inject("GET", /\/comments\?/, { status: 200, body: [{ id: 7, body: "b", created_at: "soon" }] });
    expect(kind(await forge.readRulings(null, live()))).toBe("transient");
    // A time Date.parse takes but that is not ISO 8601 would end a cursor readRulings then rejects: malformed.
    gh.control.inject("GET", /\/comments\?/, { status: 200, body: [{ id: 8, body: "b", created_at: "Thu, 01 Jan 2026 00:00:00 GMT" }] });
    expect(kind(await forge.readRulings(null, live()))).toBe("transient");
    gh.control.inject("GET", /^\/repos\/acme\/widgets\/issues\?/, { status: 403, body: { message: "Resource not accessible by integration" } });
    expect(kind(await forge.readRulings(null, live()))).toBe("forbidden");
  });
});
