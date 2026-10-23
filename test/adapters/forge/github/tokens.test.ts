import { describe, expect, test } from "bun:test";
import { createVerify } from "node:crypto";
import { createAppJwt, createTokenSource, REDACTED } from "../../../../src/adapters/forge/github/tokens.ts";
import { createFakeGitHub, testKeys } from "./fake-github.ts";

const MIN = 60_000;
const live = (): AbortSignal => new AbortController().signal;

function setup() {
  const { privateKey, publicKey } = testKeys();
  const gh = createFakeGitHub({ publicKey });
  const tokens = createTokenSource({
    credentials: { app: { id: 4242, slug: "alice-xarabot" }, key: privateKey },
    repo: { owner: "acme", name: "widgets" },
    fetch: gh.fetch,
    apiUrl: gh.control.apiUrl,
    now: gh.control.clock,
  });
  return { gh, tokens };
}

describe("createAppJwt", () => {
  test("is RS256 with iat = now−60 s, exp = now+540 s and iss = the App id", () => {
    const { privateKey, publicKey } = testKeys();
    const now = Date.parse("2026-10-22T10:00:00Z");
    const jwt = createAppJwt(4242, privateKey, now + 999);
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: 4242 });
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });
});

describe("createTokenSource", () => {
  test("mints with the JWT: installation lookup, then a token scoped to the repo", async () => {
    const { gh, tokens } = setup();
    const r = await tokens.get(live());
    expect(r.ok ? r.value : r.error.message).toBe(gh.control.tokens()[0] as string);
    const log = gh.control.log();
    expect(log.map((l) => [l.method, l.path, l.auth])).toEqual([
      ["GET", "/repos/acme/widgets/installation", "jwt"],
      ["POST", `/app/installations/${gh.control.installationId}/access_tokens`, "jwt"],
    ]);
    expect(log[1]?.body).toEqual({ repositories: ["widgets"] });
  });

  test("token reuse: two calls 30 min apart share a mint; a call at 51 min mints again", async () => {
    const { gh, tokens } = setup();
    const first = await tokens.get(live());
    gh.control.advance(30 * MIN);
    const second = await tokens.get(live());
    expect(gh.control.mints()).toBe(1);
    expect(second).toEqual(first);
    gh.control.advance(21 * MIN);
    const third = await tokens.get(live());
    expect(gh.control.mints()).toBe(2);
    expect(third.ok && first.ok && third.value !== first.value).toBe(true);
  });

  test("a token is reused until exactly 10 min before expiry", async () => {
    const { gh, tokens } = setup();
    await tokens.get(live());
    gh.control.advance(50 * MIN - 1);
    await tokens.get(live());
    expect(gh.control.mints()).toBe(1);
    gh.control.advance(1);
    await tokens.get(live());
    expect(gh.control.mints()).toBe(2);
  });

  test("concurrent callers share one in-flight mint", async () => {
    const { gh, tokens } = setup();
    const results = await Promise.all([tokens.get(live()), tokens.get(live()), tokens.get(live())]);
    expect(gh.control.mints()).toBe(1);
    expect(new Set(results.map((r) => (r.ok ? r.value : "err"))).size).toBe(1);
  });

  test("invalidate drops the cached token so the next call mints", async () => {
    const { gh, tokens } = setup();
    const first = await tokens.get(live());
    if (!first.ok) throw new Error(first.error.message);
    tokens.invalidate("some-other-token");
    await tokens.get(live());
    expect(gh.control.mints()).toBe(1);
    tokens.invalidate(first.value);
    await tokens.get(live());
    expect(gh.control.mints()).toBe(2);
  });

  test.each([404, 422])("uninstalled: installation lookup %d", async (status) => {
    const { gh, tokens } = setup();
    gh.control.inject("GET", /\/installation$/, { status, body: { message: "Not Found" } });
    const r = await tokens.get(live());
    expect(r.ok ? "ok" : r.error.kind).toBe("uninstalled");
    expect(gh.control.log()).toHaveLength(1);
  });

  test.each([404, 422])("uninstalled: access token %d", async (status) => {
    const { gh, tokens } = setup();
    gh.control.inject("POST", /access_tokens$/, { status, body: { message: "nope" } });
    const r = await tokens.get(live());
    expect(r.ok ? "ok" : r.error.kind).toBe("uninstalled");
  });

  test("an uninstalled App (real 404) is uninstalled", async () => {
    const { gh, tokens } = setup();
    gh.control.setInstalled(false);
    const r = await tokens.get(live());
    expect(r.ok ? "ok" : r.error.kind).toBe("uninstalled");
  });

  test("a rejected JWT is auth", async () => {
    const { gh, tokens } = setup();
    gh.control.inject("GET", /\/installation$/, { status: 401, body: { message: "A JSON web token could not be decoded" } });
    const r = await tokens.get(live());
    expect(r.ok ? "ok" : r.error.kind).toBe("auth");
  });

  test("a failed mint is not cached", async () => {
    const { gh, tokens } = setup();
    gh.control.inject("POST", /access_tokens$/, { status: 500 });
    expect((await tokens.get(live())).ok).toBe(false);
    expect((await tokens.get(live())).ok).toBe(true);
  });

  test("an aborted signal is transient", async () => {
    const { gh, tokens } = setup();
    const r = await tokens.get(AbortSignal.abort());
    expect(r.ok ? "ok" : r.error.kind).toBe("transient");
    expect(gh.control.log()).toEqual([]);
  });

  test("redact replaces every minted token with [redacted]", async () => {
    const { tokens } = setup();
    const r = await tokens.get(live());
    if (!r.ok) throw new Error(r.error.message);
    expect(tokens.redact(`a ${r.value} b ${r.value}`)).toBe(`a ${REDACTED} b ${REDACTED}`);
  });
});
