import { deadlinePassed, forgeErr, forgeOk, rateLimited, type ForgeErrorKind, type ForgeFailure, type ForgeResult } from "../../../ports/forge.ts";

/**
 * The GitHub adapter's single HTTP path (AR27, AR39). Every call names an
 * entry of `GITHUB_OPERATIONS` and goes through `request`, the only place the
 * adapter calls `fetch`. `mapHttpError` turns a non-2xx reply into a forge
 * error kind and is pure.
 */

export const DEFAULT_API_URL = "https://api.github.com";
export const API_VERSION = "2022-11-28";

/**
 * The status GitHub answers a non-fast-forward `PATCH git/refs` with
 * ("Update is not a fast forward"). The live contract test checks it (AR39).
 */
export const SWAP_CONFLICT_STATUS = 422;

/** The credential an operation needs: the App JWT, or one installation-token permission. */
export type Permission =
  | "app-jwt"
  | "contents: write"
  | "pull_requests: write"
  | "issues: write"
  | "metadata: read"
  | "checks: read"
  | "statuses: read"
  | "actions: read"
  /** No credential at all: a signed download URL. */
  | "none";

export type Redirect = "follow" | "manual" | "error";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type Operation = {
  readonly name: string;
  readonly method: HttpMethod;
  readonly permission: Permission;
  /** A status this operation maps to `conflict` instead of the default kind. */
  readonly conflictOn?: number;
  /** A status this operation maps to `not-found` instead of the default kind. */
  readonly notFoundOn?: number;
};

export const GITHUB_OPERATIONS = {
  getInstallation: { name: "getInstallation", method: "GET", permission: "app-jwt" },
  createAccessToken: { name: "createAccessToken", method: "POST", permission: "app-jwt" },
  getRef: { name: "getRef", method: "GET", permission: "contents: write" },
  getCommit: { name: "getCommit", method: "GET", permission: "contents: write" },
  getTree: { name: "getTree", method: "GET", permission: "contents: write" },
  getBlob: { name: "getBlob", method: "GET", permission: "contents: write" },
  createBlob: { name: "createBlob", method: "POST", permission: "contents: write" },
  createTree: { name: "createTree", method: "POST", permission: "contents: write" },
  createCommit: { name: "createCommit", method: "POST", permission: "contents: write" },
  createRef: { name: "createRef", method: "POST", permission: "contents: write", conflictOn: 422 },
  updateRef: { name: "updateRef", method: "PATCH", permission: "contents: write", conflictOn: SWAP_CONFLICT_STATUS },
  /** The branch of a closed `reconcile` or disposable planning PR (Epic 2 retro item 21); never `main` or the ledger. */
  deleteRef: { name: "deleteRef", method: "DELETE", permission: "contents: write" },
  getPull: { name: "getPull", method: "GET", permission: "pull_requests: write" },
  listPulls: { name: "listPulls", method: "GET", permission: "pull_requests: write" },
  listReviews: { name: "listReviews", method: "GET", permission: "pull_requests: write" },
  createPull: { name: "createPull", method: "POST", permission: "pull_requests: write" },
  updatePull: { name: "updatePull", method: "PATCH", permission: "pull_requests: write" },
  createComment: { name: "createComment", method: "POST", permission: "pull_requests: write" },
  /** A comment-only review (`event: "COMMENT"`): never an approval or a change request. */
  createReview: { name: "createReview", method: "POST", permission: "pull_requests: write" },
  listCheckRuns: { name: "listCheckRuns", method: "GET", permission: "checks: read", notFoundOn: 422 },
  getCombinedStatus: { name: "getCombinedStatus", method: "GET", permission: "statuses: read", notFoundOn: 422 },
  pullQueueState: { name: "pullQueueState", method: "POST", permission: "pull_requests: write" },
  /** Blob texts by object id, many per request, over GraphQL. */
  readBlobs: { name: "readBlobs", method: "POST", permission: "contents: write" },
  enqueuePullRequest: { name: "enqueuePullRequest", method: "POST", permission: "contents: write" },
  dequeuePullRequest: { name: "dequeuePullRequest", method: "POST", permission: "contents: write" },
  listIssues: { name: "listIssues", method: "GET", permission: "issues: write" },
  createIssue: { name: "createIssue", method: "POST", permission: "issues: write" },
  /** An inbox issue's body (Story 4.2). */
  updateIssue: { name: "updateIssue", method: "PATCH", permission: "issues: write" },
  listIssueComments: { name: "listIssueComments", method: "GET", permission: "issues: write" },
  createIssueComment: { name: "createIssueComment", method: "POST", permission: "issues: write" },
  getJobLogs: { name: "getJobLogs", method: "GET", permission: "actions: read" },
  downloadLog: { name: "downloadLog", method: "GET", permission: "none" },
  /** A public user, such as the bot account `<slug>[bot]`; sent with no token. */
  getUser: { name: "getUser", method: "GET", permission: "none" },
  /** `xarabot join`: turns the manifest flow's one-time code into the App; sent with no token. */
  convertManifest: { name: "convertManifest", method: "POST", permission: "none" },
  /** `xarabot join`'s re-run: the App and the permissions it has. */
  getApp: { name: "getApp", method: "GET", permission: "app-jwt" },
} as const satisfies Readonly<Record<string, Operation>>;

/**
 * The installation permissions the App asks for (AR38), exactly. The merge
 * queue needs no permission of its own (verified live 2026-10-23):
 * `enqueuePullRequest` and `dequeuePullRequest` run under `contents: write`.
 * `docs/maintainer/app-permissions.md` lists the same set.
 */
export const APP_PERMISSIONS = [
  "contents: write",
  "pull_requests: write",
  "issues: write",
  "checks: read",
  "statuses: read",
  "actions: read",
  "metadata: read",
] as const satisfies readonly Permission[];

/** The injectable `fetch`: the subset of the global one the adapter uses. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type HttpReply = {
  readonly status: number;
  /** The parsed JSON body; `null` when the body is empty or not JSON. */
  readonly body: unknown;
  /** The raw body text. */
  readonly text: string;
  /** The `Date` header, or `null`. */
  readonly date: string | null;
  readonly headers: Headers;
};

export type RequestParams = {
  readonly op: Operation;
  /** The bearer credential: the App JWT or an installation token; `null` sends no `Authorization`. */
  readonly token: string | null;
  readonly signal: AbortSignal;
  readonly fetch?: FetchLike;
  readonly apiUrl?: string;
  /** A JSON body. */
  readonly body?: unknown;
  /** `manual` returns a redirect as is instead of following it. */
  readonly redirect?: Redirect;
} & (
  | {
      /** The path below the API URL, starting with `/`. */
      readonly path: string;
      readonly url?: undefined;
    }
  | {
      /** An absolute URL, used instead of the API URL and a path. */
      readonly url: string;
      readonly path?: undefined;
    }
);

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * One HTTP call. Any HTTP reply, 2xx or not, comes back as `ok` with its
 * status; a network failure is `transient` and an abort is `transient` with a
 * "deadline passed" message.
 */
export async function request(params: RequestParams): Promise<ForgeResult<HttpReply>> {
  const { op, signal } = params;
  const fetch = params.fetch ?? globalThis.fetch;
  if (signal.aborted) return deadlinePassed(op.name);
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "xarabot",
  };
  if (params.token !== null) headers["Authorization"] = `Bearer ${params.token}`;
  const init: RequestInit = { method: op.method, headers, signal };
  if (params.redirect !== undefined) init.redirect = params.redirect;
  if (params.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(params.body);
  }
  try {
    const url = params.url ?? `${params.apiUrl ?? DEFAULT_API_URL}${params.path}`;
    const response = await fetch(url, init);
    const text = await response.text();
    let body: unknown = null;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return forgeOk({ status: response.status, body, text, date: response.headers.get("date"), headers: response.headers });
  } catch (e) {
    if (signal.aborted) return deadlinePassed(op.name);
    return forgeErr("transient", `${op.name}: network error: ${describe(e)}`);
  }
}

/** True for a 2xx status. */
export function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/** GitHub's `message` from an error body, or `""`. */
export function githubMessage(body: unknown): string {
  if (body !== null && typeof body === "object" && typeof (body as Record<string, unknown>)["message"] === "string") {
    return (body as Record<string, string>)["message"] as string;
  }
  return "";
}

/** The fallback wait for a secondary rate limit without `retry-after`. */
export const SECONDARY_RATE_LIMIT_WAIT = 60;

/** A numeric header value; `NaN` when absent or blank. */
function headerNumber(value: string | null): number {
  return value === null || value.trim() === "" ? Number.NaN : Number(value);
}

/** Maps a non-2xx reply of `op` to a forge error (the AR39 table). Pure. */
export function mapHttpError(op: Operation, reply: Pick<HttpReply, "status" | "body" | "date" | "headers">): ForgeFailure {
  const { status, headers } = reply;
  const message = githubMessage(reply.body);
  const what = `${op.name}: ${status}${message === "" ? "" : ` ${message}`}`;
  if (op.conflictOn !== undefined && status === op.conflictOn) return forgeErr("conflict", what);
  if (op.notFoundOn !== undefined && status === op.notFoundOn) return forgeErr("not-found", what);
  if (status === 401) return forgeErr("auth", what);
  if (status === 403 || status === 429) {
    if (headers.get("x-ratelimit-remaining") === "0") {
      const reset = headerNumber(headers.get("x-ratelimit-reset"));
      const date = reply.date === null ? Number.NaN : Date.parse(reply.date) / 1000;
      const wait = Number.isFinite(reset) && Number.isFinite(date) ? reset - date : SECONDARY_RATE_LIMIT_WAIT;
      return rateLimited(wait, what);
    }
    const retryAfter = headers.get("retry-after");
    if (retryAfter !== null || /secondary rate limit/i.test(message)) {
      const seconds = headerNumber(retryAfter);
      return rateLimited(Number.isFinite(seconds) ? seconds : SECONDARY_RATE_LIMIT_WAIT, what);
    }
    if (status === 403) return forgeErr("forbidden", `${what} (needs ${op.permission})`);
  }
  if (status === 404) return forgeErr("not-found", what);
  if (status >= 500 && status < 600) return forgeErr("transient", what);
  // Any other 4xx: GitHub refused the request itself (a validation failure, a conflict no
  // override maps, a 429 without rate-limit headers). The step fails, not the lane.
  if (status >= 400 && status < 500) return forgeErr("rejected", what);
  return forgeErr("forbidden", what);
}

/** One entry of a GraphQL reply's `errors[]`. */
export type GraphqlError = { readonly type?: string; readonly message?: string };

/**
 * Maps the `errors[]` of a GraphQL reply of `op` to a forge error. Pure. The
 * first error that maps to a known kind decides; otherwise `fallback`.
 */
export function mapGraphqlErrors(
  op: Operation,
  errors: readonly GraphqlError[],
  fallback: Exclude<ForgeErrorKind, "rate-limited">,
): ForgeFailure {
  const messages = errors.map((e) => `${e.type === undefined ? "" : `${e.type}: `}${e.message ?? ""}`.trim()).filter((m) => m !== "");
  const what = `${op.name}: ${messages.length === 0 ? "GraphQL error" : messages.join("; ")}`;
  for (const e of errors) {
    const message = e.message ?? "";
    if (e.type === "FORBIDDEN" || /not accessible by integration/i.test(message)) return forgeErr("forbidden", `${what} (needs ${op.permission})`);
    if (e.type === "NOT_FOUND") return forgeErr("not-found", what);
    if (e.type === "RATE_LIMITED" || /rate limit/i.test(message)) return rateLimited(SECONDARY_RATE_LIMIT_WAIT, what);
    if (e.type === "INTERNAL" || e.type === "SERVICE_UNAVAILABLE" || e.type === "TIMEOUT") return forgeErr("transient", what);
    // A schema or parse error carries no `type`: the request itself is wrong.
    if (e.type === undefined) return forgeErr("forbidden", what);
  }
  return forgeErr(fallback, what);
}

/** Formats epoch milliseconds as `YYYY-MM-DDTHH:MM:SSZ`. */
export function formatDate(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
