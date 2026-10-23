import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { alertBody, alertMarker, createGitHubForge, sanitizeCondition } from "../../../../src/adapters/forge/github/github-forge.ts";
import type { Forge, ForgeResult } from "../../../../src/ports/forge.ts";
import { createFakeGitHub, testKeys, type FakeGitHub } from "./fake-github.ts";

const live = () => ({ signal: new AbortController().signal });
const MAIN = "a".repeat(40);
const OTHER = "b".repeat(40);

function setup(...args: [maintainer?: string | undefined]): { gh: FakeGitHub; forge: Forge } {
  const maintainer = args.length === 0 ? "alice" : args[0];
  const { privateKey, publicKey } = testKeys();
  const gh = createFakeGitHub({ publicKey });
  const forge = createGitHubForge({
    repo: { owner: "acme", name: "widgets" },
    credentials: { app: { id: 4242, slug: "alice-xarabot" }, key: privateKey },
    fetch: gh.fetch,
    apiUrl: gh.control.apiUrl,
    now: gh.control.clock,
    maintainer,
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

const LIST_INBOX = "GET /issues?labels=xarabot-inbox&assignee=alice&state=open&per_page=100&page=1";

describe("alert", () => {
  test("first alert: the inbox issue is created, labelled and assigned; one comment with @login and the marker", async () => {
    const { gh, forge } = setup();
    expect(value(await forge.alert("forge-auth", MAIN, live()))).toEqual({ posted: true });
    const [issue] = gh.control.issues();
    expect(gh.control.issues()).toEqual([{ number: issue?.number as number, title: "Xarabot inbox: alice", labels: ["xarabot-inbox"], assignees: ["alice"] }]);
    const n = issue?.number as number;
    expect(gh.control.issueComments(n)).toEqual([alertBody("alice", "forge-auth", MAIN)]);
    const [body] = gh.control.issueComments(n);
    expect(body).toStartWith(`🤖 @alice every lane has stopped: forge-auth (main ${MAIN}).`);
    expect(body).toContain(alertMarker("forge-auth", MAIN));
    expect(calls(gh)).toEqual([LIST_INBOX, "POST /issues", `GET /issues/${n}/comments?per_page=100&page=1`, `POST /issues/${n}/comments`]);
    const created = gh.control.log().find((l) => l.method === "POST" && l.path.endsWith("/issues"))?.body as Record<string, unknown>;
    expect(created).toMatchObject({ title: "Xarabot inbox: alice", labels: ["xarabot-inbox"], assignees: ["alice"] });
    expect(typeof created["body"]).toBe("string");
  });

  test("repeat alert: the same condition and SHA posts nothing", async () => {
    const { gh, forge } = setup();
    value(await forge.alert("forge-auth", MAIN, live()));
    const n = gh.control.issues()[0]?.number as number;
    gh.control.clearLog();
    expect(value(await forge.alert("forge-auth", MAIN, live()))).toEqual({ posted: false });
    expect(calls(gh)).toEqual([LIST_INBOX, `GET /issues/${n}/comments?per_page=100&page=1`]);
    expect(gh.control.issueComments(n)).toHaveLength(1);
    expect(gh.control.issues()).toHaveLength(1);
  });

  test("a User comment containing the marker does not suppress the alert", async () => {
    const { gh, forge } = setup();
    value(await forge.alert("seed", MAIN, live()));
    const n = gh.control.issues()[0]?.number as number;
    gh.control.addUserComment(n, "mallory", `quoting ${alertMarker("forge-auth", MAIN)}`);
    expect(value(await forge.alert("forge-auth", MAIN, live()))).toEqual({ posted: true });
    expect(gh.control.issueComments(n)).toHaveLength(3);
    expect(value(await forge.alert("forge-auth", MAIN, live()))).toEqual({ posted: false });
  });

  test("a new SHA or a new condition posts again on the same inbox", async () => {
    const { gh, forge } = setup();
    value(await forge.alert("forge-auth", MAIN, live()));
    expect(value(await forge.alert("forge-auth", OTHER, live()))).toEqual({ posted: true });
    expect(value(await forge.alert("other", MAIN, live()))).toEqual({ posted: true });
    expect(gh.control.issues()).toHaveLength(1);
    expect(gh.control.issueComments(gh.control.issues()[0]?.number as number)).toHaveLength(3);
  });

  test("fail-closed: alert reads nothing from main, so it posts while main reads fail", async () => {
    const { gh, forge } = setup();
    for (let i = 0; i < 5; i += 1) gh.control.inject("GET", /\/git\//, { status: 500, body: { message: "boom" } });
    expect(kind(await forge.snapshot(live()))).toBe("transient");
    gh.control.clearLog();
    expect(value(await forge.alert("config-invalid", MAIN, live()))).toEqual({ posted: true });
    expect(calls(gh).some((c) => c.includes("/git/") || c.includes("/contents/"))).toBe(false);
  });

  test.each([[undefined], [""], ["  "]])("no maintainer (%p) is forbidden with no request", async (maintainer) => {
    const { gh, forge } = setup(maintainer);
    expect(kind(await forge.alert("forge-auth", MAIN, live()))).toBe("forbidden");
    expect(gh.control.log()).toEqual([]);
  });

  test("a main SHA that is not hex is not-found with no request", async () => {
    const { gh, forge } = setup();
    expect(kind(await forge.alert("forge-auth", "main", live()))).toBe("not-found");
    expect(gh.control.log()).toEqual([]);
  });

  test("the inbox is the lowest-numbered open issue; pull requests in the list are ignored", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", /^\/repos\/acme\/widgets\/issues\?/, {
      status: 200,
      body: [
        { number: 3, pull_request: { url: "x" } },
        { number: 9, title: "Xarabot inbox: alice" },
        { number: 7, title: "Xarabot inbox: alice" },
      ],
    });
    // Issues 7 and 9 exist only in the injected reply.
    gh.control.inject("GET", /^\/repos\/acme\/widgets\/issues\/7\/comments/, { status: 200, body: [] });
    gh.control.inject("POST", /^\/repos\/acme\/widgets\/issues\/7\/comments$/, { status: 201, body: { id: 1 } });
    expect(value(await forge.alert("x", MAIN, live()))).toEqual({ posted: true });
    expect(calls(gh)).toEqual([LIST_INBOX, "GET /issues/7/comments?per_page=100&page=1", "POST /issues/7/comments"]);
  });

  test("the comment list is paged when looking for the marker", async () => {
    const { gh, forge } = setup();
    value(await forge.alert("seed", MAIN, live()));
    const n = gh.control.issues()[0]?.number as number;
    const filler = Array.from({ length: 100 }, (_, i) => ({ id: i, body: `filler ${i}` }));
    gh.control.inject("GET", new RegExp(`/issues/${n}/comments\\?per_page=100&page=1$`), { status: 200, body: filler });
    gh.control.inject("GET", new RegExp(`/issues/${n}/comments\\?per_page=100&page=2$`), { status: 200, body: [{ id: 999, body: `x ${alertMarker("dup", MAIN)}`, user: { login: "alice-xarabot[bot]", type: "Bot" } }] });
    gh.control.clearLog();
    expect(value(await forge.alert("dup", MAIN, live()))).toEqual({ posted: false });
    expect(calls(gh)).toEqual([LIST_INBOX, `GET /issues/${n}/comments?per_page=100&page=1`, `GET /issues/${n}/comments?per_page=100&page=2`]);
  });

  test("the login is URL-encoded in the inbox query", async () => {
    const { gh, forge } = setup("al ice&x=1");
    value(await forge.alert("c", MAIN, live()));
    expect(calls(gh)[0]).toBe("GET /issues?labels=xarabot-inbox&assignee=al%20ice%26x%3D1&state=open&per_page=100&page=1");
  });

  test("an issues API error maps through mapHttpError and posts nothing", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", /\/issues\?/, { status: 403, body: { message: "Resource not accessible by integration" } });
    expect(kind(await forge.alert("c", MAIN, live()))).toBe("forbidden");
    expect(gh.control.issues()).toEqual([]);
  });

  test("an already-aborted signal is transient before any request", async () => {
    const { gh, forge } = setup();
    expect(kind(await forge.alert("c", MAIN, { signal: AbortSignal.abort() }))).toBe("transient");
    expect(gh.control.log()).toEqual([]);
  });
});

describe("alert text", () => {
  test("the marker is sha256(condition + newline + mainSha)", () => {
    const key = createHash("sha256").update(`forge-auth\n${MAIN}`).digest("hex");
    expect(alertMarker("forge-auth", MAIN)).toBe(`<!-- xarabot-alert:${key} -->`);
    expect(alertMarker("forge-auth", OTHER)).not.toBe(alertMarker("forge-auth", MAIN));
  });

  test.each([
    ["plain", "plain"],
    ["two\nlines", "two lines"],
    ["crlf\r\nand\rcr", "crlf and cr"],
    ["`code` and @someone", "code and someone"],
    ["@@``", ""],
    ["x --> <!-- xarabot-alert:abc -->", "x -- !-- xarabot-alert:abc --"],
  ])("sanitizes %p to %p", (input, expected) => {
    expect(sanitizeCondition(input)).toBe(expected);
  });

  test("the body is the sanitized line, then the marker of the raw condition", () => {
    const condition = "auth failed\nping @bob `now`";
    expect(alertBody("alice", condition, MAIN)).toBe(
      `🤖 @alice every lane has stopped: auth failed ping bob now (main ${MAIN}).\n\n${alertMarker(condition, MAIN)}`,
    );
  });
});
