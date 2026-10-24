import { forgeErr, forgeOk, type ForgeResult } from "../../../ports/forge.ts";
import { GITHUB_OPERATIONS, isSuccess, mapHttpError, request, type FetchLike } from "./http.ts";

/**
 * The bot account's numeric user id (FR13), for the commit email
 * `<id>+<slug>[bot]@users.noreply.github.com`. The account is public, so the
 * read carries no token.
 */

export type FetchBotUserIdParams = {
  /** The App's slug; its bot account is `<slug>[bot]`. */
  readonly slug: string;
  readonly apiUrl?: string;
  readonly fetch?: FetchLike;
  readonly signal: AbortSignal;
};

const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export async function fetchBotUserId(params: FetchBotUserIdParams): Promise<ForgeResult<number>> {
  const op = GITHUB_OPERATIONS.getUser;
  if (!SLUG.test(params.slug)) return forgeErr("not-found", `${op.name}: ${JSON.stringify(params.slug)} is not an App slug`);
  const login = `${params.slug}[bot]`;
  const r = await request({
    op,
    path: `/users/${encodeURIComponent(login)}`,
    token: null,
    signal: params.signal,
    ...(params.fetch !== undefined ? { fetch: params.fetch } : {}),
    ...(params.apiUrl !== undefined ? { apiUrl: params.apiUrl } : {}),
  });
  if (!r.ok) return r;
  if (!isSuccess(r.value.status)) return mapHttpError(op, r.value);
  const body = r.value.body;
  const id = body !== null && typeof body === "object" ? (body as Record<string, unknown>)["id"] : undefined;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return forgeErr("transient", `${op.name}: ${login}: reply has no user id`);
  return forgeOk(id);
}
