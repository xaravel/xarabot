import { err, ok, type Result } from "./result.ts";
import { GitHubLogin } from "./schemas/common.ts";

/**
 * The owner's bot as git author and committer (FR13): name
 * `<login>-xarabot[bot]`, email
 * `<botUserId>+<login>-xarabot[bot]@users.noreply.github.com`.
 */

export type BotIdentity = { readonly name: string; readonly email: string };

const SUFFIX = "-xarabot[bot]";
const NOREPLY = "@users.noreply.github.com";

/** The bot identity for an owner's login and the bot account's numeric user id. */
export function botIdentity(login: string, botUserId: number): Result<BotIdentity, "invalid"> {
  if (!GitHubLogin.safeParse(login).success) return err("invalid", `bot identity: ${JSON.stringify(login)} is not a GitHub login`);
  if (!Number.isSafeInteger(botUserId) || botUserId < 1) {
    return err("invalid", `bot identity: ${JSON.stringify(botUserId)} is not a positive integer user id`);
  }
  const name = `${login}${SUFFIX}`;
  return ok({ name, email: `${botUserId}+${name}${NOREPLY}` });
}

/** True when `id` has exactly the shape `botIdentity` returns. */
export function isBotIdentity(id: { readonly name: string; readonly email: string }): boolean {
  if (!id.name.endsWith(SUFFIX)) return false;
  const login = id.name.slice(0, -SUFFIX.length);
  const m = /^([1-9][0-9]*)\+/.exec(id.email);
  if (m === null || m[1] === undefined) return false;
  const made = botIdentity(login, Number(m[1]));
  return made.ok && made.value.name === id.name && made.value.email === id.email;
}
