import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ENQUEUE_PERMISSION,
  formatDate,
  GITHUB_OPERATIONS,
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

describe("the operation table", () => {
  test("every entry names itself and a known permission", () => {
    const permissions = [
      "app-jwt",
      "contents: write",
      "pull_requests: write",
      "metadata: read",
      "checks: read",
      "actions: read",
      "statuses: read",
      "issues: write",
      "merge_queues: write",
      "none",
    ];
    for (const [key, op] of Object.entries(GITHUB_OPERATIONS) as [string, Operation][]) {
      expect(op.name).toBe(key);
      expect(permissions).toContain(op.permission);
    }
  });
});

describe("docs/maintainer/app-permissions.md", () => {
  const doc = readFileSync(join(import.meta.dir, "../../../../docs/maintainer/app-permissions.md"), "utf8");
  /** The table rows: first cell the permission in backticks, second the operations. */
  const rows = new Map(
    doc
      .split("\n")
      .map((line) => /^\|\s*`([^`]+)`\s*\|([^|]*)\|/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1] as string, m[2] as string]),
  );
  const ops = Object.values(GITHUB_OPERATIONS) as Operation[];

  test("has a row for every permission an operation uses, naming its operations", () => {
    for (const op of ops) {
      expect([op.permission, rows.has(op.permission)]).toEqual([op.permission, true]);
      expect([op.name, (rows.get(op.permission) as string).includes(`\`${op.name}\``)]).toEqual([op.name, true]);
    }
  });

  test("lists no permission that no operation uses", () => {
    const used = new Set(ops.map((op) => op.permission));
    for (const permission of rows.keys()) expect([permission, used.has(permission as Operation["permission"])]).toEqual([permission, true]);
  });

  test("names ENQUEUE_PERMISSION as unverified in an AR38 section", () => {
    expect(doc).toContain("## AR38");
    expect(doc).toContain(ENQUEUE_PERMISSION);
    expect(doc).toMatch(/unverified/i);
    expect(doc).toContain("XARABOT_LIVE=1 bun test test/contracts/forge.github.contract.test.ts -t AR38");
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
