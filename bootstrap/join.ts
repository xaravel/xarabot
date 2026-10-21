// Bootstrap `join`: creates the caller's lane bot, a GitHub App named `<login>-xarabot` owned
// by their own account, installs it, and verifies what it can reach (SPEC CAP-13, CAP-14).
// The package's `xarabot join` absorbs this once Xarabot's code exists.
//
//   bun bootstrap/join.ts [--repo xaravel/xarabot] [--login <github-login>] [--port 8765]
//
// Two clicks: "Create GitHub App" on GitHub's manifest page, then "Install" on the repo.
// The private key goes to ~/.config/xarabot/apps/<name>/private-key.pem (mode 600) and is
// never printed. Re-running skips creation and only installs and verifies.

import { createSign, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = "https://api.github.com";

type AppRecord = { id: number; slug: string; owner: string; html_url: string };
type Installation = { id: number; account: { login: string } };

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

async function run(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "inherit" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
  return out.trim();
}

function openBrowser(url: string): void {
  Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], { stdout: "ignore", stderr: "ignore" });
}

function appJwt(app: AppRecord, pem: string): string {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: app.id })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(pem).toString("base64url")}`;
}

async function gh<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, ...init.headers },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function createApp(name: string, login: string, port: number, dir: string): Promise<AppRecord> {
  const state = randomUUID();
  const manifest = {
    name,
    url: "https://github.com/xaravel/xarabot",
    description: `Xarabot lane bot operated by @${login}. Its lanes commit, push and open PRs as this App.`,
    public: true,
    redirect_url: `http://127.0.0.1:${port}/callback`,
    hook_attributes: { url: "https://github.com/xaravel/xarabot", active: false },
    request_oauth_on_install: false,
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      checks: "read",
      statuses: "read",
      actions: "read",
      metadata: "read",
    },
  };
  const escaped = JSON.stringify(manifest).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  const form = `<!doctype html><meta charset="utf-8"><title>Create ${name}</title>
<form method="post" action="https://github.com/settings/apps/new?state=${state}">
<input type="hidden" name="manifest" value="${escaped}"></form>
<script>document.forms[0].submit()</script>`;

  let done!: (app: AppRecord) => void;
  let failed!: (e: Error) => void;
  const created = new Promise<AppRecord>((resolve, reject) => ((done = resolve), (failed = reject)));

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/") return new Response(form, { headers: { "Content-Type": "text/html" } });
      if (url.pathname !== "/callback") return new Response("not found", { status: 404 });
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.get("state") !== state) {
        failed(new Error("callback without a matching state; start again"));
        return new Response("State mismatch. Return to the terminal.", { status: 400 });
      }
      try {
        const res = await fetch(`${API}/app-manifests/${code}/conversions`, {
          method: "POST",
          headers: { Accept: "application/vnd.github+json" },
        });
        if (!res.ok) throw new Error(`manifest conversion: ${res.status} ${await res.text()}`);
        const c = (await res.json()) as AppRecord & { pem: string; owner: { login: string } };
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(join(dir, "private-key.pem"), c.pem, { mode: 0o600 });
        chmodSync(join(dir, "private-key.pem"), 0o600);
        const app: AppRecord = { id: c.id, slug: c.slug, owner: c.owner.login, html_url: c.html_url };
        writeFileSync(join(dir, "app.json"), `${JSON.stringify(app, null, 2)}\n`);
        done(app);
        return new Response(`${c.slug} created. Return to the terminal.`);
      } catch (e) {
        failed(e as Error);
        return new Response("Creation failed. Return to the terminal.", { status: 500 });
      }
    },
  });

  console.log(`Opening GitHub to create ${name}. Click "Create GitHub App for ${login}".`);
  openBrowser(`http://127.0.0.1:${port}/`);
  try {
    return await created;
  } finally {
    server.stop();
  }
}

async function main(): Promise<void> {
  const repo = arg("repo", "xaravel/xarabot") as string;
  const [org, repoName] = repo.split("/");
  if (!org || !repoName) throw new Error(`--repo must be owner/name, got ${repo}`);
  const login = arg("login") ?? (await run(["gh", "api", "user", "--jq", ".login"]));
  const port = Number(arg("port", "8765"));
  const name = `${login}-xarabot`;
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const dir = join(configHome, "xarabot", "apps", name);

  const app = existsSync(join(dir, "app.json"))
    ? (JSON.parse(readFileSync(join(dir, "app.json"), "utf8")) as AppRecord)
    : await createApp(name, login, port, dir);
  const pem = readFileSync(join(dir, "private-key.pem"), "utf8");
  console.log(`App ${app.slug} (ID ${app.id}), owned by ${app.owner}. Key: ${join(dir, "private-key.pem")}`);

  const find = async () =>
    (await gh<Installation[]>("/app/installations", appJwt(app, pem))).find((i) => i.account.login === org);
  let inst = await find();
  if (!inst) {
    console.log(`Opening the install page. Pick "${org}", choose "Only select repositories", select ${repoName}, click Install.`);
    console.log(`If you are not an owner of ${org}, GitHub sends an install request for an owner to approve.`);
    openBrowser(`https://github.com/apps/${app.slug}/installations/new`);
    const deadline = Date.now() + 15 * 60_000;
    while (!inst && Date.now() < deadline) {
      await Bun.sleep(5000);
      inst = await find();
    }
    if (!inst) throw new Error(`no installation on ${org} after 15 minutes; re-run once it is installed or approved`);
  }

  const { token } = await gh<{ token: string }>(`/app/installations/${inst.id}/access_tokens`, appJwt(app, pem), {
    method: "POST",
  });
  const { repositories } = await gh<{ repositories: { full_name: string }[] }>("/installation/repositories", token);
  const reach = repositories.map((r) => r.full_name);
  const bot = (await (await fetch(`${API}/users/${encodeURIComponent(`${app.slug}[bot]`)}`)).json()) as { id: number };

  console.log(`\nInstalled on ${org} (installation ${inst.id}). Reaches: ${reach.join(", ") || "nothing"}`);
  if (!reach.includes(repo)) throw new Error(`the installation does not reach ${repo}; add it in the App's installation settings`);
  if (reach.length > 1) console.log(`Warning: it reaches ${reach.length} repos; Xarabot needs only ${repo}.`);
  console.log(`Bot login: ${app.slug}[bot]`);
  console.log(`Commit identity: ${app.slug}[bot] <${bot.id}+${app.slug}[bot]@users.noreply.github.com>`);
}

main().catch((e: Error) => {
  console.error(`join: ${e.message}`);
  process.exit(1);
});
