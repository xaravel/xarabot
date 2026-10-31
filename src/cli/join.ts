import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertManifest, readAppPermissions, type ConvertedApp } from "../adapters/forge/github/app-manifest.ts";
import { APP_FILE, appDir, KEY_FILE, loadAppCredentials, type CredentialEnv } from "../adapters/forge/github/credentials.ts";
import type { FetchLike } from "../adapters/forge/github/http.ts";
import {
  appInstallUrl,
  appName,
  appPermissionsUrl,
  appSettingsUrl,
  buildManifest,
  comparePermissions,
  manifestPageUrl,
  type AppManifest,
} from "../core/join/manifest.ts";
import { GitHubLogin, RepoSlug } from "../core/schemas/common.ts";

/**
 * `xarabot join --repo <owner>/<name> [--login <login>] [--port <n>]`
 * (FR13, NFR9, AR27): creates the owner's `<login>-xarabot` GitHub App from a
 * manifest, or checks an existing one.
 *
 * With no `app.json` in the App folder it serves the manifest form on
 * `127.0.0.1`, opens it in the browser (it posts to GitHub's manifest page),
 * waits for the callback with a matching `state`, converts the code and
 * stores `private-key.pem` (mode 600) and then `app.json` (`{ id, slug,
 * owner }`) in the mode-700 folder. The key text is never printed.
 *
 * With an `app.json` it creates nothing: it reads the App with an App JWT
 * and stops, naming each permission to add, remove or change, unless they
 * equal the manifest's. Installing the App is Story 5.2's.
 */

export const JOIN_USAGE = "xarabot join --repo <owner>/<name> [--login <login>] [--port <n>]";

/** The longest the manifest conversion may take once GitHub's callback arrived. */
const CONVERSION_TIMEOUT_MS = 60_000;

/** How long `join` waits for GitHub's callback by default. */
export const JOIN_DEADLINE_MS = 15 * 60 * 1000;

/** A running local server: its base URL (`http://127.0.0.1:<port>`) and how to stop it. */
export type JoinServer = { readonly url: string; readonly stop: () => void };

/** Serves `handler` on `127.0.0.1:<port>` (`0` takes a free port). */
export type JoinServe = (handler: (request: Request) => Promise<Response>, port: number) => JoinServer;

export type JoinDeps = {
  readonly env: CredentialEnv;
  readonly out?: (line: string) => void;
  readonly errOut?: (line: string) => void;
  /** The GitHub adapter's `fetch`; default the global one. */
  readonly fetch?: FetchLike;
  readonly apiUrl?: string;
  /** Epoch milliseconds; default `Date.now`. */
  readonly now?: () => number;
  /** The caller's GitHub login when `--login` is absent, or `null`; default `gh api user --jq .login`. */
  readonly whoami?: () => Promise<string | null>;
  /** Default `open` (macOS) or `xdg-open`. */
  readonly openBrowser?: (url: string) => void;
  /** Default `Bun.serve` on `127.0.0.1`. */
  readonly serve?: JoinServe;
  /** The callback wait's deadline; default `JOIN_DEADLINE_MS`. */
  readonly deadlineMs?: number;
  /** Ends the callback wait early; default SIGINT. */
  readonly signal?: AbortSignal;
};

type JoinArgs = { readonly repo: string; readonly login: string | undefined; readonly port: number };

const FLAGS = ["--repo", "--login", "--port"] as const;
type Flag = (typeof FLAGS)[number];

/** The flags of `join`; `null` on any usage error. */
export function parseJoinArgs(args: readonly string[]): JoinArgs | null {
  const flags: Partial<Record<Flag, string>> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = FLAGS.find((f) => f === args[i]);
    const value = args[i + 1];
    if (flag === undefined || value === undefined || value.startsWith("--") || flags[flag] !== undefined) return null;
    flags[flag] = value;
  }
  const repo = flags["--repo"];
  if (repo === undefined || !RepoSlug.safeParse(repo).success) return null;
  const login = flags["--login"];
  if (login !== undefined && !GitHubLogin.safeParse(login).success) return null;
  const portText = flags["--port"] ?? "0";
  if (!/^\d{1,5}$/.test(portText) || Number(portText) > 65535) return null;
  return { repo, login, port: Number(portText) };
}

/** `gh api user --jq .login`, or `null` when it fails. */
async function ghLogin(): Promise<string | null> {
  try {
    const p = Bun.spawn(["gh", "api", "user", "--jq", ".login"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const text = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? text.trim() : null;
  } catch {
    return null;
  }
}

function openWithSystem(url: string): void {
  try {
    Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch {
    // The URL is printed too; the user can open it by hand.
  }
}

const bunServe: JoinServe = (handler, port) => {
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: handler });
  // A graceful stop: the callback's reply still reaches the browser.
  return { url: `http://127.0.0.1:${server.port}`, stop: () => void server.stop() };
};

function escapeAttribute(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The local page: a form that posts the manifest to GitHub's manifest page with `state`. */
export function manifestForm(manifest: AppManifest, state: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>Create ${escapeAttribute(manifest.name)}</title>
<form method="post" action="${escapeAttribute(manifestPageUrl(state))}">
<input type="hidden" name="manifest" value="${escapeAttribute(JSON.stringify(manifest))}">
<button type="submit">Create ${escapeAttribute(manifest.name)} on GitHub</button>
</form>
<script>document.forms[0].submit()</script>
`;
}

function page(status: number, body: string, type = "text/plain; charset=utf-8"): Response {
  return new Response(body, { status, headers: { "content-type": type, "cache-control": "no-store" } });
}

function describeWait(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000} s`;
  return `${ms} ms`;
}

function errorCode(e: unknown): string {
  if (e !== null && typeof e === "object" && typeof (e as { code?: unknown }).code === "string") return (e as { code: string }).code;
  return "unknown error";
}

type Outcome = { readonly ok: true; readonly lines: readonly string[] } | { readonly ok: false; readonly message: string };

/** Writes the App folder: mode 700, the key (mode 600) first, then `app.json`. An error names a path, never the key. */
function writeApp(dir: string, app: ConvertedApp): string | null {
  const keyPath = join(dir, KEY_FILE);
  const appPath = join(dir, APP_FILE);
  let at = dir;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    at = keyPath;
    // A key left by an earlier run that stopped before `app.json` is replaced, never reopened with its old mode.
    rmSync(keyPath, { force: true });
    writeFileSync(keyPath, app.pem, { mode: 0o600, flag: "wx" });
    chmodSync(keyPath, 0o600);
    at = appPath;
    writeFileSync(appPath, `${JSON.stringify({ id: app.id, slug: app.slug, owner: app.owner }, null, 2)}\n`);
    return null;
  } catch (e) {
    return `${at}: cannot write (${errorCode(e)})`;
  }
}

type Context = {
  readonly deps: JoinDeps;
  readonly out: (line: string) => void;
  readonly login: string;
  readonly org: string;
  readonly port: number;
  readonly dir: string;
};

/** Checks an existing App's permissions against the manifest's. */
async function checkExisting(ctx: Context, fail: (message: string) => number): Promise<number> {
  const { deps, out } = ctx;
  const creds = await loadAppCredentials({ login: ctx.login, env: deps.env });
  if (!creds.ok) return fail(creds.error.message);
  const { slug, id } = creds.value.app;
  const read = await readAppPermissions({
    credentials: creds.value,
    now: (deps.now ?? Date.now)(),
    signal: AbortSignal.timeout(60_000),
    ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
    ...(deps.apiUrl !== undefined ? { apiUrl: deps.apiUrl } : {}),
  });
  if (!read.ok) return fail(read.error.message);
  const changes = comparePermissions(read.value);
  if (changes.length === 0) {
    out(`${slug} (App ID ${id}) has the manifest's permissions. Key: ${join(ctx.dir, KEY_FILE)}`);
    out(`Next: install it on ${ctx.org}: ${appInstallUrl(slug)}`);
    return 0;
  }
  return fail(
    [
      `${slug} (App ID ${id}) does not have the manifest's permissions:`,
      ...changes.map((c) => `  ${c}`),
      `Change them at ${appPermissionsUrl(slug)} (a Human Live Step), accept the new permissions on each installation, then run join again.`,
    ].join("\n"),
  );
}

/** Creates the App through GitHub's manifest flow. */
async function createApp(ctx: Context, fail: (message: string) => number): Promise<number> {
  const { deps, out, login } = ctx;
  const state = randomUUID();
  let settled = false;
  let busy = false;
  let resolve!: (o: Outcome) => void;
  const outcome = new Promise<Outcome>((r) => {
    resolve = r;
  });
  const settle = (o: Outcome): void => {
    if (settled) return;
    settled = true;
    resolve(o);
  };

  const finish = async (code: string): Promise<Outcome> => {
    // Once a callback is being handled the deadline and an interrupt wait for it; only this bounds it.
    const converted = await convertManifest({
      code,
      signal: AbortSignal.timeout(CONVERSION_TIMEOUT_MS),
      ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
      ...(deps.apiUrl !== undefined ? { apiUrl: deps.apiUrl } : {}),
    });
    if (!converted.ok) return { ok: false, message: `${converted.error.message}; nothing was written` };
    const app = converted.value;
    /** GitHub created the App but this machine keeps nothing of it: it must be deleted before a new join. */
    const unsaved = (why: string): Outcome => ({
      ok: false,
      message:
        `${why}. GitHub created ${app.slug} (App ID ${app.id}), owned by ${app.owner}, but its key was not saved. ` +
        `Delete it at ${appSettingsUrl(app.slug)}/advanced while signed in to GitHub as ${app.owner}, then run join again.`,
    });
    if (app.owner.toLowerCase() !== login.toLowerCase()) return unsaved(`the App is owned by ${app.owner}, not ${login}; nothing was written`);
    if (app.slug.toLowerCase() !== appName(login).toLowerCase()) return unsaved(`the App is named ${app.slug}, not ${appName(login)}; nothing was written`);
    const wrote = writeApp(ctx.dir, app);
    if (wrote !== null) return unsaved(wrote);
    return {
      ok: true,
      lines: [
        `Created ${app.slug} (App ID ${app.id}), owned by ${app.owner}.`,
        `Key: ${join(ctx.dir, KEY_FILE)}`,
        `Next: install it on ${ctx.org}: ${appInstallUrl(app.slug)}`,
      ],
    };
  };

  let form = "";
  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return page(200, form, "text/html; charset=utf-8");
    if (request.method !== "GET" || url.pathname !== "/callback") return page(404, "Not found.");
    if (settled || busy) return page(409, "This join has already ended. Return to the terminal.");
    const code = url.searchParams.get("code");
    if (code === null || code === "" || url.searchParams.get("state") !== state) {
      settle({ ok: false, message: "the callback's state does not match this join, or it has no code; nothing was written; start again" });
      return page(400, "State mismatch: nothing was saved. Return to the terminal and start again.");
    }
    busy = true;
    const result = await finish(code);
    settle(result);
    return result.ok ? page(200, "The App was created. Return to the terminal.") : page(500, "The App was not saved. Return to the terminal.");
  };

  let server: JoinServer;
  try {
    server = (deps.serve ?? bunServe)(handler, ctx.port);
  } catch (e) {
    return fail(`cannot serve on 127.0.0.1:${ctx.port} (${e instanceof Error ? e.message : String(e)})`);
  }
  const base = server.url.replace(/\/+$/, "");
  form = manifestForm(buildManifest({ login, redirectUrl: `${base}/callback` }), state);

  const deadlineMs = deps.deadlineMs ?? JOIN_DEADLINE_MS;
  // While a callback is being handled (`busy`), its outcome settles the wait instead.
  const timer = setTimeout(() => {
    if (busy) return;
    settle({ ok: false, message: `no callback from GitHub's manifest page within ${describeWait(deadlineMs)} (the callback wait); nothing was written; run join again` });
  }, deadlineMs);
  const interrupt = new AbortController();
  const onSigint = (): void => interrupt.abort();
  if (deps.signal === undefined) process.once("SIGINT", onSigint);
  const signal = deps.signal ?? interrupt.signal;
  const onAbort = (): void => {
    if (busy) return;
    settle({ ok: false, message: "interrupted during the callback wait; nothing was written" });
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  try {
    if (!settled) {
      out(`Opening ${base}/ to create ${appName(login)} on GitHub. Click "Create GitHub App for ${login}".`);
      out(`If no browser opens, open ${base}/ yourself. Waiting up to ${describeWait(deadlineMs)}.`);
      (deps.openBrowser ?? openWithSystem)(`${base}/`);
    }
    const o = await outcome;
    if (!o.ok) return fail(o.message);
    for (const line of o.lines) out(line);
    return 0;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    process.off("SIGINT", onSigint);
    server.stop();
  }
}

/** Runs `xarabot join`; `args` follow `join`. Returns the exit code. */
export async function joinCommand(args: readonly string[], deps: JoinDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const errOut = deps.errOut ?? ((l: string) => console.error(l));
  const fail = (message: string): number => {
    errOut(`xarabot join: ${message}`);
    return 1;
  };
  const parsed = parseJoinArgs(args);
  if (parsed === null) return fail(`usage: ${JOIN_USAGE}`);
  let login = parsed.login;
  if (login === undefined) {
    const found = await (deps.whoami ?? ghLogin)();
    if (found === null || !GitHubLogin.safeParse(found).success) {
      return fail("cannot read your GitHub login from `gh api user --jq .login`; pass --login <login>");
    }
    login = found;
  }
  const dir = appDir({ login, env: deps.env });
  if (dir === null) return fail("neither XDG_CONFIG_HOME nor HOME is set");
  const ctx: Context = { deps, out, login, org: parsed.repo.split("/")[0] as string, port: parsed.port, dir };
  return existsSync(join(dir, APP_FILE)) ? checkExisting(ctx, fail) : createApp(ctx, fail);
}
