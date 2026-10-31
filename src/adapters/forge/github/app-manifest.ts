import { forgeErr, forgeOk, type ForgeResult } from "../../../ports/forge.ts";
import type { AppCredentials } from "./credentials.ts";
import { GITHUB_OPERATIONS, isSuccess, mapHttpError, request, type FetchLike } from "./http.ts";
import { createAppJwt } from "./tokens.ts";

/**
 * The two GitHub calls `xarabot join` makes (FR13, AR27): converting the
 * manifest flow's code into the App, and reading an existing App's
 * permissions with an App JWT. The private key's text is returned to the
 * caller only, and never put in a message.
 */

/** The App a manifest conversion created. The reply's client and webhook secrets are dropped. */
export type ConvertedApp = {
  readonly id: number;
  readonly slug: string;
  /** The owning account's login. */
  readonly owner: string;
  readonly htmlUrl: string;
  /** The App's private key, PEM text. */
  readonly pem: string;
};

type Transport = {
  readonly signal: AbortSignal;
  readonly fetch?: FetchLike;
  readonly apiUrl?: string;
};

export type ConvertManifestParams = Transport & {
  /** The one-time code GitHub's manifest page sent to the callback. */
  readonly code: string;
};

export type ReadAppPermissionsParams = Transport & {
  readonly credentials: AppCredentials;
  /** Epoch milliseconds, for the JWT. */
  readonly now: number;
};

const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

function record(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function transport(params: Transport): { signal: AbortSignal; fetch?: FetchLike; apiUrl?: string } {
  return {
    signal: params.signal,
    ...(params.fetch !== undefined ? { fetch: params.fetch } : {}),
    ...(params.apiUrl !== undefined ? { apiUrl: params.apiUrl } : {}),
  };
}

/** `POST /app-manifests/<code>/conversions`, with no `Authorization`. */
export async function convertManifest(params: ConvertManifestParams): Promise<ForgeResult<ConvertedApp>> {
  const op = GITHUB_OPERATIONS.convertManifest;
  if (params.code === "") return forgeErr("rejected", `${op.name}: the callback has no code`);
  const r = await request({ op, path: `/app-manifests/${encodeURIComponent(params.code)}/conversions`, token: null, ...transport(params) });
  if (!r.ok) return r;
  if (!isSuccess(r.value.status)) return mapHttpError(op, r.value);
  const body = record(r.value.body) ?? {};
  const id = body["id"];
  const slug = body["slug"];
  const owner = record(body["owner"])?.["login"];
  const pem = body["pem"];
  const htmlUrl = body["html_url"];
  const missing: string[] = [];
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) missing.push("id");
  if (typeof slug !== "string" || !SLUG.test(slug)) missing.push("slug");
  if (typeof owner !== "string" || owner === "") missing.push("owner.login");
  if (typeof pem !== "string" || pem.trim() === "") missing.push("pem");
  if (missing.length > 0) return forgeErr("transient", `${op.name}: ${r.value.status} reply lacks ${missing.join(", ")}`);
  return forgeOk({
    id: id as number,
    slug: slug as string,
    owner: owner as string,
    htmlUrl: typeof htmlUrl === "string" && htmlUrl !== "" ? htmlUrl : `https://github.com/apps/${slug as string}`,
    pem: pem as string,
  });
}

/** `GET /app` with an App JWT: the App's granted permissions, name → level. */
export async function readAppPermissions(params: ReadAppPermissionsParams): Promise<ForgeResult<Record<string, string>>> {
  const op = GITHUB_OPERATIONS.getApp;
  const { app, key } = params.credentials;
  const jwt = createAppJwt(app.id, key, params.now);
  const r = await request({ op, path: "/app", token: jwt, ...transport(params) });
  if (!r.ok) return r;
  if (!isSuccess(r.value.status)) return mapHttpError(op, r.value);
  const permissions = record(record(r.value.body)?.["permissions"]);
  if (permissions === undefined) return forgeErr("transient", `${op.name}: reply has no permissions`);
  const out: Record<string, string> = {};
  for (const [name, level] of Object.entries(permissions)) {
    if (typeof level !== "string") return forgeErr("transient", `${op.name}: permission ${name} has no level`);
    out[name] = level;
  }
  return forgeOk(out);
}
