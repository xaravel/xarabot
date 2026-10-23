import { createPrivateKey, type KeyObject } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describeIssues } from "../../../core/schemas/common.ts";
import { AppRecordSchema, type AppRecord } from "../../../core/schemas/github-app.ts";
import { forgeErr, forgeOk, type ForgeResult } from "../../../ports/forge.ts";

/**
 * Loads a lane bot's GitHub App credentials (FR13, AR27) from
 * `<config>/xarabot/apps/<login>-xarabot/`: `private-key.pem` (mode 600) and
 * `app.json`. Every failure is `auth` and names the path, never the key.
 */

export type AppCredentials = {
  readonly app: AppRecord;
  /** The parsed private key; its PEM text is not kept. */
  readonly key: KeyObject;
};

export type CredentialEnv = Readonly<Record<string, string | undefined>>;

export type LoadAppCredentialsParams = {
  /** The owner's GitHub login; the App is `<login>-xarabot`. */
  readonly login: string;
  readonly env: CredentialEnv;
};

export const KEY_FILE = "private-key.pem";
export const APP_FILE = "app.json";
const KEY_MODE = 0o600;

/**
 * The App folder: `<config>/xarabot/apps/<login>-xarabot`, where `<config>` is
 * a non-empty `XDG_CONFIG_HOME`, else `<HOME>/.config`. `null` when neither
 * `XDG_CONFIG_HOME` nor `HOME` is set.
 */
export function appDir(params: LoadAppCredentialsParams): string | null {
  const xdg = params.env["XDG_CONFIG_HOME"];
  const home = params.env["HOME"];
  let config: string;
  if (xdg !== undefined && xdg !== "") config = xdg;
  else if (home !== undefined && home !== "") config = join(home, ".config");
  else return null;
  return join(config, "xarabot", "apps", `${params.login}-xarabot`);
}

function isMissing(e: unknown): boolean {
  return e !== null && typeof e === "object" && (e as { code?: unknown }).code === "ENOENT";
}

function code(e: unknown): string {
  if (e !== null && typeof e === "object" && typeof (e as { code?: unknown }).code === "string") return (e as { code: string }).code;
  return "unreadable";
}

export async function loadAppCredentials(params: LoadAppCredentialsParams): Promise<ForgeResult<AppCredentials>> {
  const dir = appDir(params);
  if (dir === null) return forgeErr("auth", "GitHub App credentials: neither XDG_CONFIG_HOME nor HOME is set");
  const keyPath = join(dir, KEY_FILE);
  const appPath = join(dir, APP_FILE);

  let mode: number;
  try {
    mode = (await stat(keyPath)).mode & 0o777;
  } catch (e) {
    return forgeErr("auth", isMissing(e) ? `${keyPath}: missing` : `${keyPath}: cannot read (${code(e)})`);
  }
  if (mode !== KEY_MODE) {
    return forgeErr("auth", `${keyPath}: mode ${mode.toString(8).padStart(3, "0")}, must be 600`);
  }
  let pem: Buffer;
  try {
    pem = await readFile(keyPath);
  } catch (e) {
    return forgeErr("auth", isMissing(e) ? `${keyPath}: missing` : `${keyPath}: cannot read (${code(e)})`);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    // The parser's message is dropped: it may quote the file.
    return forgeErr("auth", `${keyPath}: not a private key node:crypto can parse`);
  }

  let text: string;
  try {
    text = await readFile(appPath, "utf8");
  } catch (e) {
    return forgeErr("auth", isMissing(e) ? `${appPath}: missing` : `${appPath}: cannot read (${code(e)})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return forgeErr("auth", `${appPath}: invalid JSON`);
  }
  const parsed = AppRecordSchema.safeParse(raw);
  if (!parsed.success) return forgeErr("auth", `${appPath}: ${describeIssues(parsed.error)}`);
  return forgeOk({ app: parsed.data, key });
}
