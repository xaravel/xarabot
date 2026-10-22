// Bootstrap loop: mints an installation token for the lane bot `<login>-xarabot` from its App key
// (SPEC "Bootstrap", spine AD-31: "the loop mints bot installation tokens from the key").
// Only the driver (run.sh) calls this; the Claude session never gets a token.
//
//   bun token.ts            prints a token valid for at least 10 more minutes
//   bun token.ts identity   prints the bot's commit identity: "<name>\t<email>"
//
// The key is read from $XDG_CONFIG_HOME/xarabot/apps/<app>/ (falling back to ~/.config), where
// bootstrap/join.ts wrote it. Tokens are cached in $XARABOT_BOOTSTRAP_STATE/token.json, mode 600.

import { createSign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = "https://api.github.com";
const REPO = process.env.XARABOT_BOOTSTRAP_REPO ?? "xaravel/xarabot";
const APP_NAME = process.env.XARABOT_BOOTSTRAP_APP ?? "edanisko-xarabot";
const STATE = process.env.XARABOT_BOOTSTRAP_STATE ?? join(homedir(), ".xarabot-bootstrap", "state");
const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
const appDir = join(configHome, "xarabot", "apps", APP_NAME);
const cacheFile = join(STATE, "token.json");

type AppRecord = { id: number; slug: string };
type Cached = { token: string; expires_at: string };

function appJwt(app: AppRecord, pem: string): string {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: app.id })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(pem).toString("base64url")}`;
}

async function api<T>(path: string, token: string, method = "GET"): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

function readApp(): { app: AppRecord; pem: string } {
  const app = JSON.parse(readFileSync(join(appDir, "app.json"), "utf8")) as AppRecord;
  return { app, pem: readFileSync(join(appDir, "private-key.pem"), "utf8") };
}

async function token(): Promise<string> {
  if (existsSync(cacheFile)) {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as Cached;
    if (Date.parse(cached.expires_at) - Date.now() > 10 * 60_000) return cached.token;
  }
  const { app, pem } = readApp();
  const jwt = appJwt(app, pem);
  const inst = await api<{ id: number }>(`/repos/${REPO}/installation`, jwt);
  const fresh = await api<Cached>(`/app/installations/${inst.id}/access_tokens`, jwt, "POST");
  writeFileSync(cacheFile, JSON.stringify({ token: fresh.token, expires_at: fresh.expires_at }), { mode: 0o600 });
  return fresh.token;
}

async function identity(): Promise<string> {
  const { app } = readApp();
  const login = `${app.slug}[bot]`;
  const res = await fetch(`${API}/users/${encodeURIComponent(login)}`, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GET /users/${login}: ${res.status} ${await res.text()}`);
  const bot = (await res.json()) as { id: number };
  return `${login}\t${bot.id}+${login}@users.noreply.github.com`;
}

const out = process.argv[2] === "identity" ? await identity() : await token();
process.stdout.write(`${out}\n`);
