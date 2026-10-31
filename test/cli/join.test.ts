import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadAppCredentials } from "../../src/adapters/forge/github/credentials.ts";
import type { FetchLike } from "../../src/adapters/forge/github/http.ts";
import { buildManifest } from "../../src/core/join/manifest.ts";
import { JOIN_DEADLINE_MS, JOIN_USAGE, joinCommand, manifestForm, type JoinDeps } from "../../src/cli/join.ts";
import { createFakeGitHub, DEFAULT_APP_PERMISSIONS, testKeys, type FakeGitHub } from "../adapters/forge/github/fake-github.ts";
import { hostTest } from "../support/sandbox.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BASE = "http://127.0.0.1:54321";
const PEM = (): string => testKeys().privateKey.export({ type: "pkcs8", format: "pem" }).toString();
/** Every base64 line of the key: none may show up in any output. */
const PEM_LINES = (): string[] =>
  PEM()
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith("-----"));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "xarabot-join-"));
  dirs.push(d);
  return d;
}

function unescape(text: string): string {
  return text.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

type Handler = (request: Request) => Promise<Response>;

/** What the fake browser saw. */
type Visit = {
  readonly page: string;
  readonly action: string;
  readonly manifest: Record<string, unknown>;
  readonly callback: { readonly status: number; readonly text: string } | null;
};

/** Reads the local page as a browser would: the form's action (with `state`) and its manifest. */
async function readPage(handler: Handler, base: string): Promise<Omit<Visit, "callback">> {
  const res = await handler(new Request(`${base}/`));
  const page = await res.text();
  const action = unescape((/<form method="post" action="([^"]*)"/.exec(page) ?? [])[1] ?? "");
  const manifest = JSON.parse(unescape((/name="manifest" value="([^"]*)"/.exec(page) ?? [])[1] ?? "null")) as Record<string, unknown>;
  return { page, action, manifest };
}

/** How the fake browser and GitHub's manifest page answer: the callback's query, from the real state and code. */
type Browser = "confirm" | "none" | ((state: string, code: string) => string);

function setup(options: { appOwner?: string; config?: string } = {}) {
  const gh = createFakeGitHub({ publicKey: testKeys().publicKey, ...(options.appOwner !== undefined ? { appOwner: options.appOwner } : {}) });
  const config = options.config ?? tempDir();
  return { gh, config, dir: join(config, "xarabot", "apps", "alice-xarabot") };
}

async function run(
  gh: FakeGitHub,
  config: string,
  args: readonly string[],
  options: { browser?: Browser; deadlineMs?: number; signal?: AbortSignal; whoami?: () => Promise<string | null>; fetch?: FetchLike } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const ports: number[] = [];
  let stops = 0;
  let handler: Handler | null = null;
  let visit: Promise<Visit> | null = null;
  const browser = options.browser ?? "confirm";
  const deps: JoinDeps = {
    env: { XDG_CONFIG_HOME: config, HOME: "/nonexistent" },
    out: (l) => out.push(l),
    errOut: (l) => err.push(l),
    fetch: options.fetch ?? gh.fetch,
    apiUrl: gh.control.apiUrl,
    now: () => gh.control.clock(),
    whoami: options.whoami ?? (async () => "alice"),
    serve: (h, port) => {
      handler = h;
      ports.push(port);
      return { url: BASE, stop: () => (stops += 1) };
    },
    openBrowser: (url) => {
      opened.push(url);
      if (browser === "none" || handler === null) return;
      const h: Handler = handler;
      visit = (async () => {
        const seen = await readPage(h, BASE);
        const state = new URL(seen.action).searchParams.get("state") ?? "";
        const code = gh.control.registerManifest(seen.manifest, PEM());
        const query = browser === "confirm" ? `code=${code}&state=${state}` : browser(state, code);
        const res = await h(new Request(`${BASE}/callback?${query}`));
        return { ...seen, callback: { status: res.status, text: await res.text() } };
      })();
    },
    ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
  const code = await joinCommand(args, deps);
  const seen = visit === null ? null : await (visit as Promise<Visit>);
  return { code, out, err, opened, ports, stops: () => stops, visit: seen };
}

const mode = (path: string): number => statSync(path).mode & 0o777;

/** Writes an existing App folder for alice. */
function writeRecord(dir: string, opts: { keyMode?: number; key?: boolean; app?: string } = {}): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (opts.key !== false) {
    writeFileSync(join(dir, "private-key.pem"), PEM());
    chmodSync(join(dir, "private-key.pem"), opts.keyMode ?? 0o600);
  }
  writeFileSync(join(dir, "app.json"), opts.app ?? JSON.stringify({ id: 4242, slug: "alice-xarabot", owner: "alice" }));
}

function expectNoKeyText(...texts: string[]): void {
  for (const text of texts) for (const line of PEM_LINES()) expect(text.includes(line)).toBe(false);
}

const ARGS = ["--repo", "acme/widgets", "--login", "alice"];

describe("join creates the App", () => {
  test("converts with no token and stores the key (600) and app.json in a 700 folder", async () => {
    const { gh, config, dir } = setup();
    const r = await run(gh, config, ARGS);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.ports).toEqual([0]);
    expect(r.opened).toEqual([`${BASE}/`]);
    expect(r.stops()).toBe(1);

    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, "private-key.pem"))).toBe(0o600);
    expect(readFileSync(join(dir, "private-key.pem"), "utf8")).toBe(PEM());
    const record = JSON.parse(readFileSync(join(dir, "app.json"), "utf8")) as Record<string, unknown>;
    expect(record).toEqual({ id: 4242, slug: "alice-xarabot", owner: "alice" });
    expect(readdirSync(dir).sort()).toEqual(["app.json", "private-key.pem"]);

    const conversions = gh.control.log().filter((l) => l.path.startsWith("/app-manifests/"));
    expect(conversions.map((l) => [l.method, l.auth])).toEqual([["POST", "none"]]);
    expect(conversions[0]?.headers["authorization"]).toBeUndefined();

    expect(r.out.join("\n")).toContain("alice-xarabot");
    expect(r.out.join("\n")).toContain("App ID 4242");
    expect(r.out.join("\n")).toContain(join(dir, "private-key.pem"));
    expect(r.out.join("\n")).toContain("https://github.com/apps/alice-xarabot/installations/new");
    expect(r.visit?.callback?.status).toBe(200);
    expectNoKeyText(r.out.join("\n"), r.err.join("\n"), readFileSync(join(dir, "app.json"), "utf8"), r.visit?.callback?.text ?? "", r.visit?.page ?? "");

    // The stored record loads with Story 1.8's loader.
    const creds = await loadAppCredentials({ login: "alice", env: { XDG_CONFIG_HOME: config } });
    expect(creds.ok ? creds.value.app : creds.error).toEqual({ id: 4242, slug: "alice-xarabot" });
  });

  test("the page posts the manifest to GitHub's manifest page with a state, and the redirect uses the server's port", async () => {
    const { gh, config } = setup();
    const r = await run(gh, config, ARGS);
    const action = new URL(r.visit?.action ?? "");
    expect(`${action.origin}${action.pathname}`).toBe("https://github.com/settings/apps/new");
    expect(action.searchParams.get("state")).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.visit?.manifest).toEqual({ ...buildManifest({ login: "alice", redirectUrl: `${BASE}/callback` }) });
    expect(gh.control.manifests()).toEqual([r.visit?.manifest]);
    const m = r.visit?.manifest as Record<string, unknown>;
    expect(m["default_permissions"]).toEqual({ ...DEFAULT_APP_PERMISSIONS });
    expect(m["hook_attributes"]).toEqual({ url: "https://github.com/xaravel/xarabot", active: false });
  });

  test("chmods an existing App folder to 700", async () => {
    const { gh, config, dir } = setup();
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    const r = await run(gh, config, ARGS);
    expect(r.code).toBe(0);
    expect(mode(dir)).toBe(0o700);
  });

  test("replaces a key left without app.json, at mode 600", async () => {
    const { gh, config, dir } = setup();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "private-key.pem"), "old");
    chmodSync(join(dir, "private-key.pem"), 0o644);
    const r = await run(gh, config, ARGS);
    expect(r.code).toBe(0);
    expect(mode(join(dir, "private-key.pem"))).toBe(0o600);
    expect(readFileSync(join(dir, "private-key.pem"), "utf8")).toBe(PEM());
  });

  test("the client and webhook secrets are never written or printed", async () => {
    const { gh, config, dir } = setup();
    const r = await run(gh, config, ARGS);
    expect(r.code).toBe(0);
    const record = readFileSync(join(dir, "app.json"), "utf8");
    for (const word of ["client_secret", "webhook_secret", "client_id", '"pem"']) {
      expect(record).not.toContain(word);
      expect(r.out.join("\n")).not.toContain(word);
    }
  });

  test("takes the login from whoami when --login is absent", async () => {
    const { gh, config, dir } = setup();
    let asked = 0;
    const r = await run(gh, config, ["--repo", "acme/widgets"], {
      whoami: async () => {
        asked += 1;
        return "alice";
      },
    });
    expect(r.code).toBe(0);
    expect(asked).toBe(1);
    expect(existsSync(join(dir, "app.json"))).toBe(true);
  });

  test("--login skips whoami", async () => {
    const { gh, config } = setup();
    const r = await run(gh, config, ARGS, { whoami: async () => Promise.reject(new Error("not called")) });
    expect(r.code).toBe(0);
  });

  test("the owner check is case-insensitive", async () => {
    const { gh, config } = setup({ appOwner: "Alice" });
    const r = await run(gh, config, ARGS);
    expect(r.code).toBe(0);
  });
});

describe("join stops before writing", () => {
  test.each([
    ["a state that differs", (_state: string, code: string) => `code=${code}&state=wrong`],
    ["no code", (state: string) => `state=${state}`],
    ["an empty code", (state: string) => `code=&state=${state}`],
  ])("%s: 400 to the browser, exit 1, start again", async (_name, browser) => {
    const { gh, config, dir } = setup();
    const r = await run(gh, config, ARGS, { browser });
    expect(r.code).toBe(1);
    expect(r.visit?.callback?.status).toBe(400);
    expect(r.err.join("\n")).toContain("start again");
    expect(existsSync(dir)).toBe(false);
    expect(gh.control.log().filter((l) => l.path.startsWith("/app-manifests/"))).toEqual([]);
    expect(r.stops()).toBe(1);
  });

  test("a non-2xx conversion names the op and status", async () => {
    const { gh, config, dir } = setup();
    gh.control.inject("POST", /^\/app-manifests\//, { status: 422, body: { message: "Validation Failed" } });
    const r = await run(gh, config, ARGS);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("convertManifest: 422");
    expect(r.visit?.callback?.status).toBe(500);
    expect(existsSync(dir)).toBe(false);
  });

  test.each(["id", "slug", "owner", "pem"])("a conversion reply lacking %s writes nothing", async (field) => {
    const { gh, config, dir } = setup();
    const body: Record<string, unknown> = { id: 4242, slug: "alice-xarabot", owner: { login: "alice" }, pem: PEM() };
    delete body[field];
    gh.control.inject("POST", /^\/app-manifests\//, { status: 201, body });
    const r = await run(gh, config, ARGS);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("convertManifest: 201 reply lacks");
    expect(existsSync(dir)).toBe(false);
    expectNoKeyText(r.err.join("\n"), r.out.join("\n"));
  });

  test("an App created under another account: nothing written, the settings URL to delete it", async () => {
    const { gh, config, dir } = setup({ appOwner: "mallory" });
    const r = await run(gh, config, ARGS);
    expect(r.code).toBe(1);
    const err = r.err.join("\n");
    expect(err).toContain("mallory");
    expect(err).toContain("https://github.com/settings/apps/alice-xarabot");
    expect(existsSync(dir)).toBe(false);
    expectNoKeyText(err, r.out.join("\n"));
  });

  test("an App named other than <login>-xarabot: nothing written, the settings URL to delete it", async () => {
    const { gh, config, dir } = setup();
    gh.control.inject("POST", /^\/app-manifests\//, { status: 201, body: { id: 4243, slug: "alice-xarabot-2", owner: { login: "alice" }, pem: PEM() } });
    const r = await run(gh, config, ARGS);
    expect(r.code).toBe(1);
    const err = r.err.join("\n");
    expect(err).toContain("alice-xarabot-2");
    expect(err).toContain("https://github.com/settings/apps/alice-xarabot-2/advanced");
    expect(r.visit?.callback?.status).toBe(500);
    expect(existsSync(dir)).toBe(false);
    expectNoKeyText(err, r.out.join("\n"), r.visit?.callback?.text ?? "");
  });

  test("the folder cannot be written: exit 1, the created App's delete URL, no key text", async () => {
    const { gh } = setup();
    // XDG_CONFIG_HOME is a regular file, so the App folder cannot be made below it.
    const config = join(tempDir(), "not-a-dir");
    writeFileSync(config, "");
    const r = await run(gh, config, ARGS);
    expect(r.code).toBe(1);
    const err = r.err.join("\n");
    expect(err).toContain("cannot write");
    expect(err).toContain("https://github.com/settings/apps/alice-xarabot/advanced");
    expect(r.visit?.callback?.status).toBe(500);
    expectNoKeyText(err, r.out.join("\n"), r.visit?.callback?.text ?? "");
  });

  test("no callback before the deadline: server stopped, nothing written, the wait named", async () => {
    const { gh, config, dir } = setup();
    const r = await run(gh, config, ARGS, { browser: "none", deadlineMs: 20 });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("callback wait");
    expect(r.stops()).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  test("the default deadline is 15 min", () => {
    expect(JOIN_DEADLINE_MS).toBe(15 * 60 * 1000);
  });

  test("an interrupt ends the wait early", async () => {
    const { gh, config, dir } = setup();
    const c = new AbortController();
    setTimeout(() => c.abort(), 10);
    const r = await run(gh, config, ARGS, { browser: "none", signal: c.signal });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("interrupted");
    expect(r.stops()).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  test("SIGINT ends the wait when no signal is injected, and its listener is removed", async () => {
    const { gh, config, dir } = setup();
    const before = process.listenerCount("SIGINT");
    // process.emit only calls the JS listeners; it sends no signal to the process.
    setTimeout(() => process.emit("SIGINT"), 10);
    const r = await run(gh, config, ARGS, { browser: "none" });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("interrupted");
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(existsSync(dir)).toBe(false);
  });

  test("the deadline passing during a conversion waits for it, and the App is saved", async () => {
    const { gh, config, dir } = setup();
    let deadlinePassed = false;
    const slow: FetchLike = async (url, init) => {
      if (url.includes("/app-manifests/")) {
        await Bun.sleep(100);
        deadlinePassed = true;
      }
      return gh.fetch(url, init);
    };
    const r = await run(gh, config, ARGS, { deadlineMs: 20, fetch: slow });
    expect(deadlinePassed).toBe(true);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.visit?.callback?.status).toBe(200);
    expect(mode(join(dir, "private-key.pem"))).toBe(0o600);
  });

  test("a second callback after the first is refused", async () => {
    const { gh, config } = setup();
    let handler: Handler | null = null;
    const code = await joinCommand(ARGS, {
      env: { XDG_CONFIG_HOME: config },
      out: () => {},
      errOut: () => {},
      fetch: gh.fetch,
      apiUrl: gh.control.apiUrl,
      serve: (h) => {
        handler = h;
        return { url: BASE, stop: () => {} };
      },
      openBrowser: () => {
        void (async () => {
          const h = handler as unknown as Handler;
          await h(new Request(`${BASE}/callback?code=x&state=wrong`));
        })();
      },
    });
    expect(code).toBe(1);
    const again = await (handler as unknown as Handler)(new Request(`${BASE}/callback?code=x&state=y`));
    expect(again.status).toBe(409);
  });

  test("whoami failing tells the user to pass --login", async () => {
    const { gh, config } = setup();
    const r = await run(gh, config, ["--repo", "acme/widgets"], { whoami: async () => null });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("--login");
    expect(r.opened).toEqual([]);
  });

  test("with neither XDG_CONFIG_HOME nor HOME", async () => {
    const errs: string[] = [];
    const code = await joinCommand(ARGS, { env: {}, errOut: (l) => errs.push(l) });
    expect(code).toBe(1);
    expect(errs).toEqual(["xarabot join: neither XDG_CONFIG_HOME nor HOME is set"]);
  });
});

describe("join re-run", () => {
  test("exact permissions: no creation, no browser, exit 0", async () => {
    const { gh, config, dir } = setup();
    writeRecord(dir);
    const r = await run(gh, config, ARGS);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toContain("has the manifest's permissions");
    expect(r.ports).toEqual([]);
    expect(r.opened).toEqual([]);
    expect(gh.control.log().map((l) => [l.method, l.path, l.auth])).toEqual([["GET", "/app", "jwt"]]);
    expectNoKeyText(r.out.join("\n"));
  });

  test("a missing permission: add it, at the settings URL, as a Human Live Step", async () => {
    const { gh, config, dir } = setup();
    writeRecord(dir);
    const { issues: _issues, ...rest } = DEFAULT_APP_PERMISSIONS;
    gh.control.setAppPermissions(rest);
    const r = await run(gh, config, ARGS);
    expect(r.code).toBe(1);
    const err = r.err.join("\n");
    expect(err).toContain("add issues: write");
    expect(err).toContain("https://github.com/settings/apps/alice-xarabot/permissions");
    expect(err).toContain("Human Live Step");
    expect(r.opened).toEqual([]);
  });

  test.each([
    [{ administration: "read" }, "remove administration: read"],
    [{ workflows: "write" }, "remove workflows: write"],
  ])("an extra permission %p: %s", async (extra, line) => {
    const { gh, config, dir } = setup();
    writeRecord(dir);
    gh.control.setAppPermissions({ ...DEFAULT_APP_PERMISSIONS, ...extra });
    const r = await run(gh, config, ARGS);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain(line);
  });

  test("a different level: change it", async () => {
    const { gh, config, dir } = setup();
    writeRecord(dir);
    gh.control.setAppPermissions({ ...DEFAULT_APP_PERMISSIONS, checks: "write" });
    const r = await run(gh, config, ARGS);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("change checks: write to checks: read");
  });

  test.each([
    ["a missing key", { key: false }, "private-key.pem: missing"],
    ["a key at mode 644", { keyMode: 0o644 }, "private-key.pem: mode 644, must be 600"],
    ["an invalid app.json", { app: "{" }, "app.json: invalid JSON"],
  ] as const)("%s: no creation, loadAppCredentials' message", async (_name, opts, message) => {
    const { gh, config, dir } = setup();
    writeRecord(dir, opts);
    const r = await run(gh, config, ARGS);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain(message);
    expect(r.ports).toEqual([]);
    expect(r.opened).toEqual([]);
    expect(gh.control.log()).toEqual([]);
  });
});

describe("join arguments", () => {
  test.each([
    [[]],
    [["--repo"]],
    [["--login", "alice"]],
    [["--repo", "acme"]],
    [["--repo", "acme/"]],
    [["--repo", "a/b/c"]],
    [["--repo", "acme/widgets", "--nope", "x"]],
    [["--repo", "acme/widgets", "extra"]],
    [["--repo", "acme/widgets", "--port", "x"]],
    [["--repo", "acme/widgets", "--port", "70000"]],
    [["--repo", "acme/widgets", "--login", "-bad-"]],
    [["--repo", "acme/widgets", "--repo", "acme/widgets"]],
  ])("%j prints usage and exits 1", async (args) => {
    const { gh, config } = setup();
    const r = await run(gh, config, args);
    expect(r.code).toBe(1);
    expect(r.err).toEqual([`xarabot join: usage: ${JOIN_USAGE}`]);
    expect(r.ports).toEqual([]);
  });

  test("--port is passed to the server", async () => {
    const { gh, config } = setup();
    const r = await run(gh, config, [...ARGS, "--port", "8765"]);
    expect(r.code).toBe(0);
    expect(r.ports).toEqual([8765]);
  });
});

describe("manifestForm", () => {
  test("escapes the manifest JSON into the hidden field", () => {
    const manifest = { ...buildManifest({ login: "alice", redirectUrl: `${BASE}/callback` }), description: `a "b" <c> & 'd'` };
    const html = manifestForm(manifest, "s-1");
    expect(html).not.toContain("<c>");
    expect(html).toContain("&lt;c&gt; &amp; &#39;d&#39;");
    const value = (/name="manifest" value="([^"]*)"/.exec(html) ?? [])[1] ?? "";
    expect(JSON.parse(unescape(value))).toEqual(manifest);
    expect(html).toContain('action="https://github.com/settings/apps/new?state=s-1"');
  });
});

describe("the source", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join(dir, f));
  }

  test("bootstrap/join.ts is gone", () => {
    expect(existsSync(join(ROOT, "bootstrap", "join.ts"))).toBe(false);
  });

  test("the only JWT signer is tokens.ts, and join calls no fetch of its own", () => {
    const signers = sources(join(ROOT, "src"))
      .filter((f) => readFileSync(f, "utf8").includes("createSign"))
      .map((f) => relative(ROOT, f));
    expect(signers).toEqual(["src/adapters/forge/github/tokens.ts"]);
    for (const f of [join(ROOT, "src", "cli", "join.ts"), ...sources(join(ROOT, "src", "core", "join"))]) {
      expect([relative(ROOT, f), readFileSync(f, "utf8").includes("fetch(")]).toEqual([relative(ROOT, f), false]);
    }
  });
});

describe("join with a real server", () => {
  hostTest("Bun.serve on 127.0.0.1 serves the page and takes the callback", async () => {
    const { gh, config, dir } = setup();
    const out: string[] = [];
    let browsed: Promise<number> | null = null;
    const code = await joinCommand([...ARGS, "--port", "0"], {
      env: { XDG_CONFIG_HOME: config },
      out: (l) => out.push(l),
      errOut: (l) => out.push(l),
      fetch: gh.fetch,
      apiUrl: gh.control.apiUrl,
      openBrowser: (url) => {
        browsed = (async () => {
          const res = await globalThis.fetch(url);
          const page = await res.text();
          const action = unescape((/action="([^"]*)"/.exec(page) ?? [])[1] ?? "");
          const manifest = JSON.parse(unescape((/name="manifest" value="([^"]*)"/.exec(page) ?? [])[1] ?? "null")) as Record<string, unknown>;
          expect(String(manifest["redirect_url"])).toStartWith(url.replace(/\/$/, ""));
          const state = new URL(action).searchParams.get("state") ?? "";
          const c = gh.control.registerManifest(manifest, PEM());
          const cb = await globalThis.fetch(`${String(manifest["redirect_url"])}?code=${c}&state=${state}`);
          return cb.status;
        })();
      },
      deadlineMs: 10_000,
    });
    expect(out.join("\n")).toContain("Created alice-xarabot");
    expect(code).toBe(0);
    expect(await (browsed as unknown as Promise<number>)).toBe(200);
    expect(mode(join(dir, "private-key.pem"))).toBe(0o600);
  });
});
