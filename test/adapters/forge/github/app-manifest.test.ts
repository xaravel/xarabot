import { describe, expect, test } from "bun:test";
import { convertManifest, readAppPermissions } from "../../../../src/adapters/forge/github/app-manifest.ts";
import { GITHUB_OPERATIONS } from "../../../../src/adapters/forge/github/http.ts";
import { createFakeGitHub, DEFAULT_APP_PERMISSIONS, testKeys } from "./fake-github.ts";

const live = () => AbortSignal.timeout(10_000);
const PEM = (): string => testKeys().privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function setup(options: { appOwner?: string } = {}) {
  const gh = createFakeGitHub({ publicKey: testKeys().publicKey, ...options });
  return { gh, params: { fetch: gh.fetch, apiUrl: gh.control.apiUrl } };
}

const credentials = () => ({ app: { id: 4242, slug: "alice-xarabot" }, key: testKeys().privateKey });

describe("the join operations", () => {
  test("convertManifest needs no credential and getApp the App JWT", () => {
    expect(GITHUB_OPERATIONS.convertManifest).toEqual({ name: "convertManifest", method: "POST", permission: "none" });
    expect(GITHUB_OPERATIONS.getApp).toEqual({ name: "getApp", method: "GET", permission: "app-jwt" });
  });
});

describe("convertManifest", () => {
  test("converts a code with no Authorization and returns the App and key", async () => {
    const { gh, params } = setup();
    const code = gh.control.registerManifest({ name: "alice-xarabot" }, PEM());
    const r = await convertManifest({ ...params, code, signal: live() });
    expect(r).toEqual({
      ok: true,
      value: { id: 4242, slug: "alice-xarabot", owner: "alice", htmlUrl: "https://github.com/apps/alice-xarabot", pem: PEM() },
    });
    const log = gh.control.log();
    expect(log.map((l) => [l.method, l.path, l.auth])).toEqual([["POST", `/app-manifests/${code}/conversions`, "none"]]);
    expect(log[0]?.headers["authorization"]).toBeUndefined();
  });

  test("a code is single-use: the second conversion is not-found and names the op and status", async () => {
    const { gh, params } = setup();
    const code = gh.control.registerManifest({ name: "alice-xarabot" }, PEM());
    expect((await convertManifest({ ...params, code, signal: live() })).ok).toBe(true);
    const again = await convertManifest({ ...params, code, signal: live() });
    expect(again.ok ? "ok" : again.error.kind).toBe("not-found");
    expect(again.ok ? "" : again.error.message).toStartWith("convertManifest: 404");
  });

  test.each([
    ["id", { slug: "alice-xarabot", owner: { login: "alice" }, pem: "x" }],
    ["slug", { id: 1, owner: { login: "alice" }, pem: "x" }],
    ["owner.login", { id: 1, slug: "alice-xarabot", pem: "x" }],
    ["pem", { id: 1, slug: "alice-xarabot", owner: { login: "alice" } }],
  ])("a reply lacking %s is refused", async (field, body) => {
    const { gh, params } = setup();
    gh.control.inject("POST", /^\/app-manifests\//, { status: 201, body });
    const r = await convertManifest({ ...params, code: "abc", signal: live() });
    expect(r.ok ? "ok" : r.error.message).toBe(`convertManifest: 201 reply lacks ${field}`);
  });

  test("a reply's pem never appears in an error", async () => {
    const { gh, params } = setup();
    const pem = PEM();
    gh.control.inject("POST", /^\/app-manifests\//, { status: 201, body: { id: "x", pem } });
    const r = await convertManifest({ ...params, code: "abc", signal: live() });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(pem.split("\n")[1] as string);
  });

  test("an empty code is refused before any request", async () => {
    const { gh, params } = setup();
    const r = await convertManifest({ ...params, code: "", signal: live() });
    expect(r.ok).toBe(false);
    expect(gh.control.log()).toEqual([]);
  });
});

describe("readAppPermissions", () => {
  test("reads GET /app with an App JWT", async () => {
    const { gh, params } = setup();
    const r = await readAppPermissions({ ...params, credentials: credentials(), now: gh.control.clock(), signal: live() });
    expect(r).toEqual({ ok: true, value: { ...DEFAULT_APP_PERMISSIONS } });
    expect(gh.control.log().map((l) => [l.method, l.path, l.auth])).toEqual([["GET", "/app", "jwt"]]);
  });

  test("returns what the App has", async () => {
    const { gh, params } = setup();
    gh.control.setAppPermissions({ contents: "write", administration: "read" });
    const r = await readAppPermissions({ ...params, credentials: credentials(), now: gh.control.clock(), signal: live() });
    expect(r).toEqual({ ok: true, value: { contents: "write", administration: "read" } });
  });

  test("a JWT the fake cannot verify is auth", async () => {
    const { gh, params } = setup();
    const r = await readAppPermissions({ ...params, credentials: { ...credentials(), app: { id: 1, slug: "x" } }, now: gh.control.clock(), signal: live() });
    expect(r.ok ? "ok" : r.error.kind).toBe("auth");
  });

  test("a reply with no permissions is transient", async () => {
    const { gh, params } = setup();
    gh.control.inject("GET", /^\/app$/, { status: 200, body: { id: 4242 } });
    const r = await readAppPermissions({ ...params, credentials: credentials(), now: gh.control.clock(), signal: live() });
    expect(r.ok ? "ok" : r.error.message).toBe("getApp: reply has no permissions");
  });
});
