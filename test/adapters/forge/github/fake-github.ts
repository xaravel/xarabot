import { createVerify, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import type { LedgerCommit } from "../../../../src/core/ledger/edits.ts";
import type { FetchLike } from "../../../../src/adapters/forge/github/http.ts";

/**
 * An in-process GitHub emulator: a `fetch` for the endpoints the GitHub forge
 * adapter calls. It holds git objects, refs, PRs, a clock that sets `Date`,
 * App JWT and installation-token checks, a request log and one-shot hooks and
 * response injections. Each request yields a macrotask and checks its signal
 * before any change, so an aborted request changes nothing.
 */

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const API = "https://api.github.test";
const TOKEN_TTL_MS = 60 * 60 * 1000;

export type FakeGitHubOptions = {
  readonly owner?: string;
  readonly name?: string;
  readonly appId?: number;
  /** The App's public key, for JWT checks. */
  readonly publicKey: KeyObject;
  readonly installationId?: number;
  /** The clock, epoch ms; default `2026-01-01T00:00:00Z`. */
  readonly now?: number;
  readonly ledgerBranch?: string;
  readonly mainBranch?: string;
};

export type LoggedRequest = {
  readonly method: string;
  /** Path and query below the API URL. */
  readonly path: string;
  /** `jwt`, `token` or `none`. */
  readonly auth: "jwt" | "token" | "none";
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
};

export type InjectedResponse = {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
};

export type FakePull = { readonly state: "open" | "closed"; readonly merged: boolean; readonly head_sha: string };

type Entry = { readonly mode: string; readonly sha: string };
type Commit = { readonly tree: string; readonly parents: readonly string[]; readonly message: string };
type Matcher = { readonly method: string; readonly path: RegExp };

export type FakeGitHubControl = {
  readonly apiUrl: string;
  readonly installationId: number;
  /** Epoch ms. */
  clock(): number;
  setClock(ms: number): void;
  setNow(iso: string): void;
  advance(ms: number): void;
  setInstalled(installed: boolean): void;
  /** Replaces `main`'s files as one new commit; returns its SHA. */
  setMain(files: Readonly<Record<string, string>>): string;
  /** Writes a ledger commit on the ledger tip (creating the branch if missing); returns the new tip. */
  writeForeignLedger(commit: LedgerCommit): string;
  /** The SHA a branch points at, or `undefined`. */
  ref(branch: string): string | undefined;
  /** A branch's files at its tip. */
  files(branch: string): Record<string, string>;
  commit(sha: string): Commit | undefined;
  setPull(number: number, pull: FakePull): void;
  /** Revokes every installation token minted so far. */
  revokeTokens(): void;
  /** Every installation token minted, oldest first. */
  tokens(): string[];
  mints(): number;
  /** Makes every recursive tree read report `truncated`. */
  truncateTrees(on: boolean): void;
  /** The next request matching `method` and `path` gets `response` and changes nothing. */
  inject(method: string, path: RegExp, response: InjectedResponse | "network-error"): void;
  /** Runs `fn` once, before handling the next request matching `method` and `path`. */
  before(method: string, path: RegExp, fn: () => void): void;
  /** Leaves the `Date` header off every response. */
  omitDate(on: boolean): void;
  log(): LoggedRequest[];
  clearLog(): void;
};

export type FakeGitHub = { readonly fetch: FetchLike; readonly control: FakeGitHubControl };

function sha1(text: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha1").update(text).digest("hex");
}

function gitBlobSha(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): { status: number; body: unknown; headers: Record<string, string> } {
  return { status, body, headers };
}

const notFound = () => json(404, { message: "Not Found", documentation_url: "https://docs.github.com/rest" });
const unprocessable = (message: string) => json(422, { message });

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function createFakeGitHub(options: FakeGitHubOptions): FakeGitHub {
  const owner = options.owner ?? "acme";
  const name = options.name ?? "widgets";
  const appId = options.appId ?? 4242;
  const installationId = options.installationId ?? 777;
  const ledgerBranch = options.ledgerBranch ?? "xarabot/claims";
  const mainBranch = options.mainBranch ?? "main";
  let clock = options.now ?? Date.parse("2026-01-01T00:00:00Z");
  let installed = true;
  let truncate = false;
  let withDate = true;
  let commitCounter = 0;

  const blobs = new Map<string, Uint8Array>();
  const trees = new Map<string, ReadonlyMap<string, Entry>>([[EMPTY_TREE, new Map()]]);
  const commits = new Map<string, Commit>();
  const refs = new Map<string, string>();
  const pulls = new Map<number, FakePull>();
  const tokens = new Map<string, { expiresAt: number; revoked: boolean }>();
  const minted: string[] = [];
  const log: LoggedRequest[] = [];
  const injections: { m: Matcher; r: InjectedResponse | "network-error" }[] = [];
  const hooks: { m: Matcher; fn: () => void }[] = [];

  const repoPrefix = `/repos/${owner}/${name}`;

  function putBlob(bytes: Uint8Array): string {
    const sha = gitBlobSha(bytes);
    blobs.set(sha, bytes);
    return sha;
  }

  function putTree(entries: ReadonlyMap<string, Entry>): string {
    if (entries.size === 0) return EMPTY_TREE;
    const lines = [...entries].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, e]) => `${e.mode} ${p} ${e.sha}\n`);
    const sha = sha1(`tree\n${lines.join("")}`);
    trees.set(sha, new Map(entries));
    return sha;
  }

  function putCommit(c: Commit): string {
    const sha = sha1(`commit ${c.tree} ${c.parents.join(",")} ${c.message} ${commitCounter++}`);
    commits.set(sha, c);
    return sha;
  }

  function filesAt(commitSha: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (commitSha === undefined) return out;
    const tree = trees.get(commits.get(commitSha)?.tree ?? "") ?? new Map<string, Entry>();
    for (const [path, e] of tree) out[path] = new TextDecoder().decode(blobs.get(e.sha));
    return out;
  }

  function treeOf(files: Readonly<Record<string, string>>): string {
    const entries = new Map<string, Entry>();
    for (const [path, text] of Object.entries(files)) entries.set(path, { mode: "100644", sha: putBlob(new TextEncoder().encode(text)) });
    return putTree(entries);
  }

  function isAncestor(ancestor: string, of: string): boolean {
    const seen = new Set<string>();
    const stack = [of];
    while (stack.length > 0) {
      const s = stack.pop() as string;
      if (s === ancestor) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...(commits.get(s)?.parents ?? []));
    }
    return false;
  }

  function verifyJwt(jwt: string): boolean {
    const parts = jwt.split(".");
    if (parts.length !== 3) return false;
    const [h, p, s] = parts as [string, string, string];
    const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(options.publicKey, Buffer.from(s, "base64url"));
    if (!ok) return false;
    try {
      const header = JSON.parse(Buffer.from(h, "base64url").toString()) as Record<string, unknown>;
      const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
      const now = Math.floor(clock / 1000);
      return (
        header["alg"] === "RS256" &&
        claims["iss"] === appId &&
        typeof claims["iat"] === "number" &&
        typeof claims["exp"] === "number" &&
        claims["iat"] <= now + 60 &&
        claims["exp"] > now &&
        claims["exp"] - claims["iat"] <= 600
      );
    } catch {
      return false;
    }
  }

  function tokenValid(token: string): boolean {
    const t = tokens.get(token);
    return t !== undefined && !t.revoked && t.expiresAt > clock;
  }

  function takeMatch<T extends { m: Matcher }>(list: T[], method: string, path: string): T | undefined {
    const i = list.findIndex((x) => x.m.method === method && x.m.path.test(path));
    if (i === -1) return undefined;
    return list.splice(i, 1)[0];
  }

  type Reply = { status: number; body: unknown; headers: Record<string, string> };

  function handleJwt(method: string, path: string, body: unknown): Reply {
    if (method === "GET" && path === `${repoPrefix}/installation`) {
      return installed ? json(200, { id: installationId, app_id: appId }) : notFound();
    }
    const m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (method === "POST" && m !== null) {
      if (!installed || Number(m[1]) !== installationId) return notFound();
      const repos = obj(body)?.["repositories"];
      if (repos !== undefined && (!Array.isArray(repos) || !repos.every((r) => r === name))) {
        return unprocessable("There is at least one repository that does not exist or is not accessible to the parent installation.");
      }
      const token = `ghs_${randomBytes(18).toString("hex")}`;
      const expiresAt = clock + TOKEN_TTL_MS;
      tokens.set(token, { expiresAt, revoked: false });
      minted.push(token);
      return json(201, { token, expires_at: new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, "Z"), permissions: { contents: "write" } });
    }
    return notFound();
  }

  function handleRepo(method: string, rest: string, body: unknown): Reply {
    const b = obj(body);
    let m: RegExpExecArray | null;
    if (method === "GET" && (m = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) !== null) {
      const branch = (m[1] as string).split("/").map(decodeURIComponent).join("/");
      const sha = refs.get(branch);
      return sha === undefined ? notFound() : json(200, { ref: `refs/heads/${branch}`, object: { sha, type: "commit" } });
    }
    if (method === "GET" && (m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest)) !== null) {
      const c = commits.get(m[1] as string);
      if (c === undefined) return notFound();
      return json(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), message: c.message });
    }
    if (method === "GET" && (m = /^\/git\/trees\/([0-9a-f]{40})(\?recursive=1)?$/.exec(rest)) !== null) {
      const t = trees.get(m[1] as string);
      if (t === undefined) return notFound();
      const dirs = new Set<string>();
      const tree: { path: string; mode: string; type: string; sha: string }[] = [];
      for (const [path, e] of t) {
        const segs = path.split("/");
        for (let i = 1; i < segs.length; i += 1) dirs.add(segs.slice(0, i).join("/"));
        tree.push({ path, mode: e.mode, type: "blob", sha: e.sha });
      }
      for (const d of dirs) tree.push({ path: d, mode: "040000", type: "tree", sha: sha1(`dir ${d}`) });
      tree.sort((a, b) => (a.path < b.path ? -1 : 1));
      const shown = m[2] === undefined ? tree.filter((e) => !e.path.includes("/")) : tree;
      return json(200, { sha: m[1], tree: shown, truncated: truncate });
    }
    if (method === "GET" && (m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest)) !== null) {
      const bytes = blobs.get(m[1] as string);
      if (bytes === undefined) return notFound();
      // GitHub wraps base64 content at 60 columns.
      const content = (Buffer.from(bytes).toString("base64").match(/.{1,60}/g) ?? []).join("\n");
      return json(200, { sha: m[1], size: bytes.byteLength, content: content === "" ? "" : `${content}\n`, encoding: "base64" });
    }
    if (method === "POST" && rest === "/git/blobs") {
      const content = b?.["content"];
      const encoding = b?.["encoding"] ?? "utf-8";
      if (typeof content !== "string" || (encoding !== "utf-8" && encoding !== "base64")) return unprocessable("Invalid request.");
      const bytes = encoding === "base64" ? new Uint8Array(Buffer.from(content, "base64")) : new TextEncoder().encode(content);
      return json(201, { sha: putBlob(bytes) });
    }
    if (method === "POST" && rest === "/git/trees") {
      const base = b?.["base_tree"];
      const items = b?.["tree"];
      if (!Array.isArray(items)) return unprocessable("Invalid tree info");
      let entries = new Map<string, Entry>();
      if (base !== undefined) {
        const t = typeof base === "string" ? trees.get(base) : undefined;
        if (t === undefined) return unprocessable("base_tree is not a valid tree oid");
        entries = new Map(t);
      }
      for (const raw of items) {
        const item = obj(raw);
        const path = item?.["path"];
        const mode = item?.["mode"];
        const sha = item?.["sha"];
        if (typeof path !== "string" || typeof mode !== "string" || item?.["type"] !== "blob") return unprocessable("Invalid tree info");
        if (sha === null) entries.delete(path);
        else if (typeof sha === "string" && blobs.has(sha)) entries.set(path, { mode, sha });
        else return unprocessable("tree.sha is not a valid blob");
      }
      return json(201, { sha: putTree(entries) });
    }
    if (method === "POST" && rest === "/git/commits") {
      const message = b?.["message"];
      const tree = b?.["tree"];
      const parents = b?.["parents"] ?? [];
      if (typeof message !== "string" || typeof tree !== "string" || !trees.has(tree)) return unprocessable("Tree SHA does not exist");
      if (!Array.isArray(parents) || !parents.every((p) => typeof p === "string" && commits.has(p))) {
        return unprocessable("Parent SHA does not exist or is not a commit object");
      }
      return json(201, { sha: putCommit({ tree, parents: parents as string[], message }) });
    }
    if (method === "POST" && rest === "/git/refs") {
      const ref = b?.["ref"];
      const sha = b?.["sha"];
      if (typeof ref !== "string" || !ref.startsWith("refs/heads/") || typeof sha !== "string" || !commits.has(sha)) {
        return unprocessable("Invalid request.");
      }
      const branch = ref.slice("refs/heads/".length);
      if (refs.has(branch)) return unprocessable("Reference already exists");
      refs.set(branch, sha);
      return json(201, { ref, object: { sha, type: "commit" } });
    }
    if (method === "PATCH" && (m = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) !== null) {
      const branch = (m[1] as string).split("/").map(decodeURIComponent).join("/");
      const current = refs.get(branch);
      const sha = b?.["sha"];
      if (current === undefined) return unprocessable("Reference does not exist");
      if (typeof sha !== "string" || !commits.has(sha)) return unprocessable("Object does not exist");
      if (b?.["force"] !== true && !isAncestor(current, sha)) return unprocessable("Update is not a fast forward");
      refs.set(branch, sha);
      return json(200, { ref: `refs/heads/${branch}`, object: { sha, type: "commit" } });
    }
    if (method === "GET" && (m = /^\/pulls\/(\d+)$/.exec(rest)) !== null) {
      const n = Number(m[1]);
      const p = pulls.get(n);
      if (p === undefined) return notFound();
      return json(200, { number: n, state: p.state, merged: p.merged, merged_at: p.merged ? "2026-01-01T00:00:00Z" : null, head: { sha: p.head_sha } });
    }
    return notFound();
  }

  const fetch: FetchLike = async (url, init) => {
    const signal = init.signal ?? undefined;
    const abortError = () => new DOMException("The operation was aborted.", "AbortError");
    if (signal?.aborted) throw abortError();
    await tick();
    if (signal?.aborted) throw abortError();

    const method = (init.method ?? "GET").toUpperCase();
    if (!url.startsWith(API)) throw new TypeError(`fake GitHub: unexpected host in ${url}`);
    const path = url.slice(API.length);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const authHeader = headers["authorization"] ?? "";
    const credential = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const isJwt = credential.split(".").length === 3;
    log.push({ method, path, auth: credential === "" ? "none" : isJwt ? "jwt" : "token", body, headers });

    const hook = takeMatch(hooks, method, path);
    hook?.fn();

    const date = new Date(clock).toUTCString();
    const respond = (r: Reply): Response => {
      const h: Record<string, string> = { "content-type": "application/json; charset=utf-8", ...r.headers };
      if (withDate) h["date"] = date;
      return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: h });
    };

    const injected = takeMatch(injections, method, path);
    if (injected !== undefined) {
      if (injected.r === "network-error") throw new TypeError("fetch failed: connection reset");
      return respond({ status: injected.r.status, body: injected.r.body ?? {}, headers: { ...injected.r.headers } });
    }

    if (headers["accept"] !== "application/vnd.github+json" || headers["x-github-api-version"] !== "2022-11-28") {
      return respond(json(400, { message: "missing Accept or X-GitHub-Api-Version" }));
    }
    const appRoute = path.startsWith("/app/") || path === `${repoPrefix}/installation`;
    if (appRoute) {
      if (!isJwt || !verifyJwt(credential)) return respond(json(401, { message: "A JSON web token could not be decoded" }));
      return respond(handleJwt(method, path, body));
    }
    if (!tokenValid(credential)) return respond(json(401, { message: "Bad credentials" }));
    if (!path.startsWith(`${repoPrefix}/`)) return respond(notFound());
    return respond(handleRepo(method, path.slice(repoPrefix.length), body));
  };

  const control: FakeGitHubControl = {
    apiUrl: API,
    installationId,
    clock: () => clock,
    setClock(ms) {
      clock = ms;
    },
    setNow(iso) {
      clock = Date.parse(iso);
    },
    advance(ms) {
      clock += ms;
    },
    setInstalled(on) {
      installed = on;
    },
    setMain(files) {
      const parent = refs.get(mainBranch);
      const sha = putCommit({ tree: treeOf(files), parents: parent === undefined ? [] : [parent], message: "main" });
      refs.set(mainBranch, sha);
      return sha;
    },
    writeForeignLedger(commit) {
      let tip = refs.get(ledgerBranch);
      if (tip === undefined) {
        tip = putCommit({ tree: EMPTY_TREE, parents: [], message: "foreign root" });
        refs.set(ledgerBranch, tip);
      }
      const files = filesAt(tip);
      for (const path of commit.deletes) delete files[path];
      Object.assign(files, commit.writes);
      const sha = putCommit({ tree: treeOf(files), parents: [tip], message: commit.message });
      refs.set(ledgerBranch, sha);
      return sha;
    },
    ref: (branch) => refs.get(branch),
    files: (branch) => filesAt(refs.get(branch)),
    commit: (sha) => commits.get(sha),
    setPull(number, pull) {
      pulls.set(number, pull);
    },
    revokeTokens() {
      for (const t of tokens.values()) t.revoked = true;
    },
    tokens: () => [...minted],
    mints: () => minted.length,
    truncateTrees(on) {
      truncate = on;
    },
    inject(method, path, response) {
      injections.push({ m: { method, path }, r: response });
    },
    before(method, path, fn) {
      hooks.push({ m: { method, path }, fn });
    },
    omitDate(on) {
      withDate = !on;
    },
    log: () => [...log],
    clearLog() {
      log.length = 0;
    },
  };

  // A repo starts with an empty `main`.
  control.setMain({});
  return { fetch, control };
}

let keys: { readonly privateKey: KeyObject; readonly publicKey: KeyObject } | undefined;

/** One RSA key pair per test process (generating one takes a while). */
export function testKeys(): { readonly privateKey: KeyObject; readonly publicKey: KeyObject } {
  keys ??= generateKeyPairSync("rsa", { modulusLength: 2048 });
  return keys;
}
