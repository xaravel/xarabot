import { describe, expect, test } from "bun:test";
import { createGitHubForge } from "../../../../src/adapters/forge/github/github-forge.ts";
import type { Forge, ForgeResult } from "../../../../src/ports/forge.ts";
import { createFakeGitHub, testKeys, type FakeGitHub } from "./fake-github.ts";

const live = () => ({ signal: new AbortController().signal });
const SHA = "d".repeat(40);

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

function calls(gh: FakeGitHub): string[] {
  return gh.control
    .log()
    .filter((l) => l.host === "api" && l.auth === "token")
    .map((l) => `${l.method} ${l.path.replace("/repos/acme/widgets", "")}`);
}

describe("checks", () => {
  test("no runs and no statuses is pending: an empty list", async () => {
    const { gh, forge } = setup();
    expect(value(await forge.checks(SHA, live()))).toEqual({ checks: [] });
    expect(calls(gh)).toEqual([
      `GET /commits/${SHA}/check-runs?filter=latest&per_page=100&page=1`,
      `GET /commits/${SHA}/status?per_page=100&page=1`,
    ]);
  });

  test("mixed: check runs first, then statuses", async () => {
    const { gh, forge } = setup();
    gh.control.setChecks(SHA, [{ name: "test", status: "completed", conclusion: "success" }]);
    gh.control.setStatuses(SHA, [{ context: "ci/legacy", state: "pending" }]);
    expect(value(await forge.checks(SHA, live()))).toEqual({
      checks: [
        { name: "test", status: "completed", conclusion: "success" },
        { name: "ci/legacy", status: "in_progress", conclusion: null },
      ],
    });
  });

  test("check-run status and conclusion map as given, other statuses become queued", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", /\/check-runs\?/, {
      status: 200,
      body: {
        total_count: 5,
        check_runs: [
          { name: "a", status: "completed", conclusion: "failure" },
          { name: "b", status: "in_progress", conclusion: "success" },
          { name: "c", status: "queued", conclusion: null },
          { name: "d", status: "waiting", conclusion: null },
          { name: "e", status: "pending", conclusion: null },
        ],
      },
    });
    expect(value(await forge.checks(SHA, live())).checks).toEqual([
      { name: "a", status: "completed", conclusion: "failure" },
      { name: "b", status: "in_progress", conclusion: null },
      { name: "c", status: "queued", conclusion: null },
      { name: "d", status: "queued", conclusion: null },
      { name: "e", status: "queued", conclusion: null },
    ]);
  });

  test("commit statuses map success, failure and error to completed and pending to in_progress", async () => {
    const { gh, forge } = setup();
    gh.control.setStatuses(SHA, [
      { context: "s", state: "success" },
      { context: "f", state: "failure" },
      { context: "e", state: "error" },
      { context: "p", state: "pending" },
    ]);
    expect(value(await forge.checks(SHA, live())).checks).toEqual([
      { name: "s", status: "completed", conclusion: "success" },
      { name: "f", status: "completed", conclusion: "failure" },
      { name: "e", status: "completed", conclusion: "error" },
      { name: "p", status: "in_progress", conclusion: null },
    ]);
  });

  test("both lists are paged 100 a page", async () => {
    const { gh, forge } = setup();
    gh.control.setChecks(SHA, Array.from({ length: 120 }, (_, i) => ({ name: `c${i}`, status: "completed" as const, conclusion: "success" })));
    gh.control.setStatuses(SHA, Array.from({ length: 100 }, (_, i) => ({ context: `s${i}`, state: "success" as const })));
    const got = value(await forge.checks(SHA, live())).checks;
    expect(got).toHaveLength(220);
    expect(got[0]?.name).toBe("c0");
    expect(got[120]?.name).toBe("s0");
    expect(calls(gh)).toEqual([
      `GET /commits/${SHA}/check-runs?filter=latest&per_page=100&page=1`,
      `GET /commits/${SHA}/check-runs?filter=latest&per_page=100&page=2`,
      `GET /commits/${SHA}/status?per_page=100&page=1`,
      `GET /commits/${SHA}/status?per_page=100&page=2`,
    ]);
  });

  test("an unknown commit (check-runs 422) is not-found", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", /\/check-runs\?/, { status: 422, body: { message: `No commit found for SHA: ${SHA}` } });
    expect(kind(await forge.checks(SHA, live()))).toBe("not-found");
  });

  test("an unknown commit on the status endpoint (422) is not-found", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", /\/status\?/, { status: 422, body: { message: "No commit found" } });
    expect(kind(await forge.checks(SHA, live()))).toBe("not-found");
  });

  test("a missing checks permission (403) is forbidden and names checks: read", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", /\/check-runs\?/, { status: 403, body: { message: "Resource not accessible by integration" } });
    const r = await forge.checks(SHA, live());
    expect(r.ok ? "ok" : r.error.kind).toBe("forbidden");
    expect(r.ok ? "" : r.error.message).toContain("checks: read");
  });

  test("a missing statuses permission (403) names statuses: read", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", /\/status\?/, { status: 403, body: { message: "Resource not accessible by integration" } });
    const r = await forge.checks(SHA, live());
    expect(r.ok ? "" : `${r.error.kind} ${r.error.message}`).toMatch(/^forbidden .*statuses: read/);
  });

  test("a non-hex SHA is not-found and makes no request", async () => {
    const { gh, forge } = setup();
    for (const bad of ["main", "D".repeat(40), "d".repeat(39), `${SHA}/../x`]) expect(kind(await forge.checks(bad, live()))).toBe("not-found");
    expect(calls(gh)).toEqual([]);
  });

  test("a malformed check run is transient", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", /\/check-runs\?/, { status: 200, body: { check_runs: [{ status: "completed" }] } });
    expect(kind(await forge.checks(SHA, live()))).toBe("transient");
  });
});
