import { createSign, type KeyObject } from "node:crypto";
import { forgeErr, forgeOk, type ForgeResult } from "../../../ports/forge.ts";
import type { AppCredentials } from "./credentials.ts";
import { GITHUB_OPERATIONS, isSuccess, mapHttpError, request, type FetchLike } from "./http.ts";

/**
 * App JWTs and installation tokens (FR13, AR27). The installation token lives
 * only in the closure of `createTokenSource`: never in the environment, a
 * file, a log or an error message.
 */

/** The JWT is back-dated this much against clock drift. */
export const JWT_BACKDATE_S = 60;
/** The JWT's lifetime after `now` (GitHub caps it at 10 min). */
export const JWT_LIFETIME_S = 540;
/** A cached token is re-minted once it has less than this left. */
export const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;

export const REDACTED = "[redacted]";

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** An RS256 App JWT: `iat = now − 60 s`, `exp = now + 540 s`, `iss = appId`. */
export function createAppJwt(appId: number, key: KeyObject, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ iat: now - JWT_BACKDATE_S, exp: now + JWT_LIFETIME_S, iss: appId })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url");
  return `${unsigned}.${signature}`;
}

export type TokenSourceOptions = {
  readonly credentials: AppCredentials;
  readonly repo: { readonly owner: string; readonly name: string };
  readonly fetch?: FetchLike;
  readonly apiUrl?: string;
  /** Epoch milliseconds; default `Date.now`. */
  readonly now?: () => number;
};

export type TokenSource = {
  /**
   * An installation token for the repo with at least 10 min left, minted when
   * needed. Concurrent callers share one in-flight mint (and its signal).
   */
  get(signal: AbortSignal): Promise<ForgeResult<string>>;
  /** Drops the cached token if it is still `token` (after a 401). */
  invalidate(token: string): void;
  /** Replaces every installation token this source minted with `[redacted]`. */
  redact(text: string): string;
};

type Cached = { readonly token: string; readonly expiresAt: number };

function field(body: unknown, key: string): unknown {
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
}

export function createTokenSource(options: TokenSourceOptions): TokenSource {
  const now = options.now ?? Date.now;
  const { owner, name } = options.repo;
  const secrets = new Set<string>();
  let cached: Cached | null = null;
  let inflight: Promise<ForgeResult<string>> | null = null;

  const redact = (text: string): string => {
    let out = text;
    for (const s of secrets) out = out.split(s).join(REDACTED);
    return out;
  };

  async function mint(signal: AbortSignal): Promise<ForgeResult<string>> {
    const jwt = createAppJwt(options.credentials.app.id, options.credentials.key, now());
    const common = { token: jwt, signal, fetch: options.fetch, apiUrl: options.apiUrl } as const;
    const lookup = GITHUB_OPERATIONS.getInstallation;
    const inst = await request({ ...common, op: lookup, path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation` });
    if (!inst.ok) return inst;
    if (inst.value.status === 404 || inst.value.status === 422) {
      return forgeErr("uninstalled", `${lookup.name}: the GitHub App is not installed on ${owner}/${name} (${inst.value.status})`);
    }
    if (!isSuccess(inst.value.status)) return mapHttpError(lookup, inst.value);
    const id = field(inst.value.body, "id");
    if (typeof id !== "number" || !Number.isInteger(id)) return forgeErr("transient", `${lookup.name}: reply has no installation id`);

    const create = GITHUB_OPERATIONS.createAccessToken;
    const minted = await request({ ...common, op: create, path: `/app/installations/${id}/access_tokens`, body: { repositories: [name] } });
    if (!minted.ok) return minted;
    if (minted.value.status === 404 || minted.value.status === 422) {
      return forgeErr("uninstalled", `${create.name}: installation ${id} does not cover ${owner}/${name} (${minted.value.status})`);
    }
    if (!isSuccess(minted.value.status)) return mapHttpError(create, minted.value);
    const token = field(minted.value.body, "token");
    const expires = field(minted.value.body, "expires_at");
    const expiresAt = typeof expires === "string" ? Date.parse(expires) : Number.NaN;
    if (typeof token !== "string" || token === "" || !Number.isFinite(expiresAt)) {
      return forgeErr("transient", `${create.name}: reply has no token or expires_at`);
    }
    secrets.add(token);
    cached = { token, expiresAt };
    return forgeOk(token);
  }

  return {
    get(signal) {
      if (cached !== null && cached.expiresAt - now() > TOKEN_REFRESH_MARGIN_MS) return Promise.resolve(forgeOk(cached.token));
      if (inflight === null) {
        inflight = mint(signal)
          .catch((e: unknown) => forgeErr("transient", `mint: ${e instanceof Error ? e.message : String(e)}`))
          .then((r) => (r.ok ? r : { ok: false as const, error: { ...r.error, message: redact(r.error.message) } }))
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
    invalidate(token) {
      if (cached !== null && cached.token === token) cached = null;
    },
    redact,
  };
}
