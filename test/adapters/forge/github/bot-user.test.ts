import { describe, expect, test } from "bun:test";
import { fetchBotUserId } from "../../../../src/adapters/forge/github/bot-user.ts";
import { GITHUB_OPERATIONS } from "../../../../src/adapters/forge/github/http.ts";
import { createFakeGitHub, testKeys } from "./fake-github.ts";

const live = () => AbortSignal.timeout(10_000);

function setup() {
  const gh = createFakeGitHub({ publicKey: testKeys().publicKey, appSlug: "edanisko-xarabot", botUserId: 1234567 });
  return { gh, params: { fetch: gh.fetch, apiUrl: gh.control.apiUrl } };
}

describe("fetchBotUserId", () => {
  test("GET /users/<slug>[bot] with no token returns the id", async () => {
    const { gh, params } = setup();
    expect(await fetchBotUserId({ ...params, slug: "edanisko-xarabot", signal: live() })).toEqual({ ok: true, value: 1234567 });
    const log = gh.control.log();
    expect(log.map((r) => [r.method, r.path, r.auth])).toEqual([["GET", "/users/edanisko-xarabot%5Bbot%5D", "none"]]);
    expect(log[0]?.headers["authorization"]).toBeUndefined();
  });

  test("getUser needs no permission", () => {
    expect(GITHUB_OPERATIONS.getUser).toEqual({ name: "getUser", method: "GET", permission: "none" });
  });

  test("an unknown account is not-found", async () => {
    const { params } = setup();
    const r = await fetchBotUserId({ ...params, slug: "nobody-xarabot", signal: live() });
    expect(r.ok ? "ok" : r.error.kind).toBe("not-found");
  });

  test("a reply with no id is transient", async () => {
    const { gh, params } = setup();
    gh.control.inject("GET", /^\/users\//, { status: 200, body: { login: "x" } });
    const r = await fetchBotUserId({ ...params, slug: "edanisko-xarabot", signal: live() });
    expect(r.ok ? "ok" : r.error.kind).toBe("transient");
  });

  test("a bad slug is refused before any request", async () => {
    const { gh, params } = setup();
    const r = await fetchBotUserId({ ...params, slug: "../x", signal: live() });
    expect(r.ok ? "ok" : r.error.kind).toBe("not-found");
    expect(gh.control.log()).toEqual([]);
  });

  test("an aborted signal is transient", async () => {
    const { params } = setup();
    const c = new AbortController();
    c.abort();
    const r = await fetchBotUserId({ ...params, slug: "edanisko-xarabot", signal: c.signal });
    expect(r.ok ? "ok" : r.error.kind).toBe("transient");
  });
});
