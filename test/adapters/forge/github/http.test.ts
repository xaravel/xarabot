import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APP_PERMISSIONS,
  formatDate,
  GITHUB_OPERATIONS,
  mapGraphqlErrors,
  mapHttpError,
  request,
  SWAP_CONFLICT_STATUS,
  type FetchLike,
  type HttpReply,
  type Operation,
} from "../../../../src/adapters/forge/github/http.ts";

const DATE = "Thu, 22 Oct 2026 10:00:00 GMT";
const DATE_S = Date.parse(DATE) / 1000;
const GET_REF = GITHUB_OPERATIONS.getRef;

function reply(status: number, headers: Record<string, string> = {}, body: unknown = {}, date: string | null = DATE): Pick<HttpReply, "status" | "body" | "date" | "headers"> {
  return { status, body, date, headers: new Headers(headers) };
}

describe("mapHttpError", () => {
  test.each([
    [401, {}, {}, "auth"],
    [403, {}, { message: "Resource not accessible by integration" }, "forbidden"],
    [404, {}, {}, "not-found"],
    [500, {}, {}, "transient"],
    [502, {}, {}, "transient"],
    [503, {}, {}, "transient"],
    [409, {}, { message: "Git Repository is empty." }, "forbidden"],
    [422, {}, { message: "Validation Failed" }, "forbidden"],
    [400, {}, {}, "forbidden"],
    [429, {}, {}, "forbidden"],
  ] as const)("%d %p %p is %s", (status, headers, body, kind) => {
    expect(mapHttpError(GET_REF, reply(status, headers, body)).error.kind).toBe(kind);
  });

  test("rate limit: 403, remaining 0, reset at Date+30 is rate-limited with retry_after 30", () => {
    const e = mapHttpError(GET_REF, reply(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(DATE_S + 30) })).error;
    expect(e).toEqual({ kind: "rate-limited", message: expect.any(String), retry_after: 30 });
  });

  test("429 with remaining 0 is rate-limited from the reset", () => {
    const e = mapHttpError(GET_REF, reply(429, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(DATE_S + 5) })).error;
    expect(e.kind === "rate-limited" ? e.retry_after : -1).toBe(5);
  });

  test("a reset already passed waits 0", () => {
    const e = mapHttpError(GET_REF, reply(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(DATE_S - 10) })).error;
    expect(e.kind === "rate-limited" ? e.retry_after : -1).toBe(0);
  });

  test("remaining 0 without x-ratelimit-reset waits 60", () => {
    const e = mapHttpError(GET_REF, reply(403, { "x-ratelimit-remaining": "0" })).error;
    expect(e.kind === "rate-limited" ? e.retry_after : -1).toBe(60);
  });

  test("a blank retry-after waits 60", () => {
    const e = mapHttpError(GET_REF, reply(429, { "retry-after": "  " })).error;
    expect(e.kind === "rate-limited" ? e.retry_after : -1).toBe(60);
  });

  test.each([403, 429])("%d with retry-after waits that long", (status) => {
    const e = mapHttpError(GET_REF, reply(status, { "retry-after": "17" })).error;
    expect(e.kind === "rate-limited" ? e.retry_after : -1).toBe(17);
  });

  test.each([403, 429])("%d whose body says secondary rate limit waits 60", (status) => {
    const e = mapHttpError(GET_REF, reply(status, {}, { message: "You have exceeded a secondary rate limit." })).error;
    expect(e.kind === "rate-limited" ? e.retry_after : -1).toBe(60);
  });

  test("another status carries the status and GitHub's message", () => {
    expect(mapHttpError(GET_REF, reply(418, {}, { message: "I'm a teapot" })).error).toEqual({ kind: "forbidden", message: "getRef: 418 I'm a teapot" });
  });

  test("non-fast-forward: PATCH git/refs 422 is conflict; 409 is not", () => {
    expect(SWAP_CONFLICT_STATUS).toBe(422);
    expect(mapHttpError(GITHUB_OPERATIONS.updateRef, reply(422, {}, { message: "Update is not a fast forward" })).error.kind).toBe("conflict");
    expect(mapHttpError(GITHUB_OPERATIONS.updateRef, reply(409)).error.kind).toBe("forbidden");
  });

  test("POST git/refs 422 is conflict", () => {
    expect(mapHttpError(GITHUB_OPERATIONS.createRef, reply(422, {}, { message: "Reference already exists" })).error.kind).toBe("conflict");
  });

  test("the overrides apply to their operation only", () => {
    expect(mapHttpError(GITHUB_OPERATIONS.createCommit, reply(422)).error.kind).toBe("forbidden");
  });

  test("notFoundOn maps its status to not-found; other statuses keep their kind", () => {
    const checks = GITHUB_OPERATIONS.listCheckRuns;
    expect(mapHttpError(checks, reply(422, {}, { message: "No commit found for SHA: x" })).error).toEqual({
      kind: "not-found",
      message: "listCheckRuns: 422 No commit found for SHA: x",
    });
    expect(mapHttpError(GITHUB_OPERATIONS.getCombinedStatus, reply(422)).error.kind).toBe("not-found");
    expect(mapHttpError(checks, reply(409)).error.kind).toBe("forbidden");
    expect(mapHttpError(GITHUB_OPERATIONS.getCommit, reply(422)).error.kind).toBe("forbidden");
  });

  test("a 403 that is not a rate limit names the operation's permission", () => {
    expect(mapHttpError(GITHUB_OPERATIONS.listCheckRuns, reply(403, {}, { message: "Resource not accessible by integration" })).error).toEqual({
      kind: "forbidden",
      message: "listCheckRuns: 403 Resource not accessible by integration (needs checks: read)",
    });
    expect(mapHttpError(GET_REF, reply(403)).error).toEqual({ kind: "forbidden", message: "getRef: 403 (needs contents: write)" });
    // Other forbidden statuses keep their message as it was.
    expect(mapHttpError(GET_REF, reply(400)).error).toEqual({ kind: "forbidden", message: "getRef: 400" });
  });
});

describe("request", () => {
  type Seen = { url: string; init: RequestInit };

  function recording(response: () => Response): { fetch: FetchLike; seen: Seen[] } {
    const seen: Seen[] = [];
    return {
      seen,
      fetch: async (url, init) => {
        seen.push({ url, init });
        return response();
      },
    };
  }

  test("adds the headers and signal and returns status, JSON body and Date", async () => {
    const { fetch, seen } = recording(() => new Response(JSON.stringify({ a: 1 }), { status: 201, headers: { date: DATE } }));
    const signal = new AbortController().signal;
    const r = await request({ op: GITHUB_OPERATIONS.createBlob, path: "/repos/o/r/git/blobs", token: "tok", signal, fetch, apiUrl: "https://x.test", body: { b: 2 } });
    if (!r.ok) throw new Error(r.error.message);
    expect([r.value.status, r.value.body, r.value.date]).toEqual([201, { a: 1 }, DATE]);
    const call = seen[0] as Seen;
    expect(call.url).toBe("https://x.test/repos/o/r/git/blobs");
    expect(call.init.method).toBe("POST");
    expect(call.init.signal).toBe(signal);
    expect(call.init.body).toBe(JSON.stringify({ b: 2 }));
    const h = new Headers(call.init.headers);
    expect(h.get("authorization")).toBe("Bearer tok");
    expect(h.get("accept")).toBe("application/vnd.github+json");
    expect(h.get("x-github-api-version")).toBe("2022-11-28");
  });

  test("a null token sends no Authorization; an absolute url and redirect pass through; text is kept", async () => {
    const { fetch, seen } = recording(() => new Response("plain log\n", { status: 302, headers: { location: "https://logs.test/x" } }));
    const r = await request({ op: GITHUB_OPERATIONS.downloadLog, url: "https://logs.test/a?sig=1", token: null, signal: new AbortController().signal, fetch, redirect: "manual" });
    if (!r.ok) throw new Error(r.error.message);
    expect([r.value.status, r.value.body, r.value.text, r.value.headers.get("location")]).toEqual([302, null, "plain log\n", "https://logs.test/x"]);
    const call = seen[0] as Seen;
    expect(call.url).toBe("https://logs.test/a?sig=1");
    expect(call.init.redirect).toBe("manual");
    expect(new Headers(call.init.headers).has("authorization")).toBe(false);
  });

  test("a non-2xx reply is still ok, carrying its status", async () => {
    const { fetch } = recording(() => new Response(JSON.stringify({ message: "nope" }), { status: 404 }));
    const r = await request({ op: GET_REF, path: "/x", token: "t", signal: new AbortController().signal, fetch });
    expect(r.ok ? [r.value.status, r.value.date] : r.error.kind).toEqual([404, null]);
  });

  test("an empty or non-JSON body is null", async () => {
    const { fetch } = recording(() => new Response("<html>", { status: 502 }));
    const r = await request({ op: GET_REF, path: "/x", token: "t", signal: new AbortController().signal, fetch });
    expect(r.ok ? r.value.body : "err").toBeNull();
  });

  test("a network error is transient", async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError("connection reset");
    };
    const r = await request({ op: GET_REF, path: "/x", token: "t", signal: new AbortController().signal, fetch });
    expect(r.ok ? "ok" : r.error).toEqual({ kind: "transient", message: "getRef: network error: connection reset" });
  });

  test("an abort is transient and says the deadline passed", async () => {
    const ac = new AbortController();
    const fetch: FetchLike = async () => {
      ac.abort();
      throw new DOMException("aborted", "AbortError");
    };
    const r = await request({ op: GET_REF, path: "/x", token: "t", signal: ac.signal, fetch });
    expect(r.ok ? "ok" : r.error).toEqual({ kind: "transient", message: "getRef: deadline passed" });
  });

  test("an already-aborted signal makes no call", async () => {
    const { fetch, seen } = recording(() => new Response("{}"));
    const r = await request({ op: GET_REF, path: "/x", token: "t", signal: AbortSignal.abort(), fetch });
    expect(r.ok ? "ok" : r.error.kind).toBe("transient");
    expect(seen).toEqual([]);
  });
});

describe("mapGraphqlErrors", () => {
  const ENQUEUE = GITHUB_OPERATIONS.enqueuePullRequest;
  test.each([
    [[{ type: "FORBIDDEN", message: "nope" }], "conflict", "forbidden"],
    [[{ message: "Resource not accessible by integration" }], "conflict", "forbidden"],
    [[{ type: "NOT_FOUND", message: "Could not resolve to a node" }], "conflict", "not-found"],
    [[{ type: "RATE_LIMITED", message: "slow" }], "conflict", "rate-limited"],
    [[{ type: "UNPROCESSABLE", message: "API rate limit exceeded" }], "conflict", "rate-limited"],
    [[{ type: "INTERNAL", message: "x" }], "conflict", "transient"],
    [[{ type: "SERVICE_UNAVAILABLE", message: "x" }], "conflict", "transient"],
    [[{ type: "TIMEOUT", message: "x" }], "conflict", "transient"],
    [[{ message: "Parse error on \"}\"" }], "transient", "forbidden"],
    [[{ type: "UNPROCESSABLE", message: "Pull request is not mergeable" }], "conflict", "conflict"],
    [[{ type: "UNPROCESSABLE", message: "x" }], "transient", "transient"],
    [[], "conflict", "conflict"],
  ] as const)("%p with fallback %s is %s", (errors, fallback, kind) => {
    expect(mapGraphqlErrors(ENQUEUE, errors, fallback).error.kind).toBe(kind);
  });

  test("forbidden names the permission; rate-limited waits 60 s", () => {
    expect(mapGraphqlErrors(ENQUEUE, [{ type: "FORBIDDEN", message: "denied" }], "conflict").error).toEqual({
      kind: "forbidden",
      message: "enqueuePullRequest: FORBIDDEN: denied (needs contents: write)",
    });
    const e = mapGraphqlErrors(ENQUEUE, [{ type: "RATE_LIMITED", message: "slow" }], "conflict").error;
    expect(e.kind === "rate-limited" ? e.retry_after : -1).toBe(60);
  });
});

describe("the operation table", () => {
  test("every entry names itself and a known permission", () => {
    const permissions = [
      "app-jwt",
      "contents: write",
      "pull_requests: write",
      "issues: write",
      "metadata: read",
      "checks: read",
      "statuses: read",
      "actions: read",
      "none",
    ];
    for (const [key, op] of Object.entries(GITHUB_OPERATIONS) as [string, Operation][]) {
      expect(op.name).toBe(key);
      expect(permissions).toContain(op.permission);
    }
  });

  test("no operation deletes, merges or approves", () => {
    for (const [key, op] of Object.entries(GITHUB_OPERATIONS) as [string, Operation][]) {
      expect([key, op.method]).not.toEqual([key, "DELETE"]);
      expect(key).not.toMatch(/merge(?!Queue)|approve|delete/i);
    }
  });
});

describe("the App permission manifest", () => {
  const ops = Object.values(GITHUB_OPERATIONS) as Operation[];

  test("is exactly the AR38 set", () => {
    expect([...APP_PERMISSIONS]).toEqual([
      "contents: write",
      "pull_requests: write",
      "issues: write",
      "checks: read",
      "statuses: read",
      "actions: read",
      "metadata: read",
    ]);
  });

  test("covers every operation's permission, and every entry but metadata: read is used", () => {
    const manifest: readonly string[] = APP_PERMISSIONS;
    for (const op of ops) {
      if (op.permission === "app-jwt" || op.permission === "none") continue;
      expect([op.name, manifest.includes(op.permission)]).toEqual([op.name, true]);
    }
    const used = new Set<string>(ops.map((op) => op.permission));
    for (const p of APP_PERMISSIONS) if (p !== "metadata: read") expect([p, used.has(p)]).toEqual([p, true]);
  });

  test("the merge queue needs no permission of its own", () => {
    expect(GITHUB_OPERATIONS.enqueuePullRequest.permission).toBe("contents: write");
    expect(GITHUB_OPERATIONS.dequeuePullRequest.permission).toBe("contents: write");
  });

  test("docs/maintainer/app-permissions.md has one table row per entry and no merge-queue row", () => {
    const doc = readFileSync(join(import.meta.dir, "../../../../docs/maintainer/app-permissions.md"), "utf8");
    const rows = doc
      .split("\n")
      .filter((l) => l.startsWith("|") && !/^\|\s*-/.test(l))
      .slice(1);
    const names = rows.map((r) => (/^\|\s*`([^`]+)`\s*\|/.exec(r) ?? [])[1] ?? r);
    expect(names).toEqual([...APP_PERMISSIONS]);
    for (const r of rows) expect(r).not.toMatch(/merge.?queue/i);
  });
});

describe("formatDate", () => {
  test("is YYYY-MM-DDTHH:MM:SSZ", () => {
    expect(formatDate(Date.parse(DATE))).toBe("2026-10-22T10:00:00Z");
    expect(formatDate(Date.parse("2026-10-22T10:00:00.789Z"))).toBe("2026-10-22T10:00:00Z");
  });
});

describe("the adapter source", () => {
  test("fetch( appears only in http.ts:request", () => {
    const dir = join(import.meta.dir, "../../../../src/adapters/forge/github");
    const hits: string[] = [];
    for (const file of readdirSync(dir)) {
      const lines = readFileSync(join(dir, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (line.includes("fetch(")) hits.push(`${file}:${i + 1}`);
      });
    }
    expect(hits).toHaveLength(1);
    const [file, line] = (hits[0] as string).split(":");
    expect(file).toBe("http.ts");
    const source = readFileSync(join(dir, "http.ts"), "utf8").split("\n");
    const start = source.findIndex((l) => l.startsWith("export async function request("));
    const end = source.findIndex((l, i) => i > start && l === "}");
    expect(Number(line) - 1).toBeGreaterThan(start);
    expect(Number(line) - 1).toBeLessThan(end);
  });
});
