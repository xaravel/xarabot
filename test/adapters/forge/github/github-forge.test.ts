import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAppCredentials } from "../../../../src/adapters/forge/github/credentials.ts";
import { BLOBS_PER_QUERY, createGitHubForge, EMPTY_TREE, LEDGER_ROOT_MESSAGE, type SnapshotPart } from "../../../../src/adapters/forge/github/github-forge.ts";
import { serializeUnitRecord } from "../../../../src/core/ledger/codec.ts";
import { unitPath } from "../../../../src/core/schemas/ledger.ts";
import { FORGE_OPERATIONS, type Forge, type ForgeOperation, type ForgeResult } from "../../../../src/ports/forge.ts";
import { rec } from "../../../core/ledger/fixtures.ts";
import { createFakeGitHub, testKeys, type FakeGitHub } from "./fake-github.ts";

const live = () => ({ signal: new AbortController().signal });
const LEDGER_REF = /\/git\/ref\/heads\/xarabot\/claims$/;

function setup(extra: { onRead?: (p: SnapshotPart) => void } = {}): { gh: FakeGitHub; forge: Forge } {
  const { privateKey, publicKey } = testKeys();
  const gh = createFakeGitHub({ publicKey });
  const forge = createGitHubForge({
    repo: { owner: "acme", name: "widgets" },
    credentials: { app: { id: 4242, slug: "alice-xarabot" }, key: privateKey },
    fetch: gh.fetch,
    apiUrl: gh.control.apiUrl,
    now: gh.control.clock,
    onRead: extra.onRead,
  });
  return { gh, forge };
}

function value<T>(r: ForgeResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.value;
}

function kind<T>(r: ForgeResult<T>): string {
  return r.ok ? "ok" : r.error.kind;
}

/** Repo API calls only (no JWT calls), as `METHOD path`. */
function apiCalls(gh: FakeGitHub): string[] {
  return gh.control
    .log()
    .filter((l) => l.auth === "token")
    .map((l) => `${l.method} ${l.path.replace("/repos/acme/widgets", "")}`);
}

describe("snapshot", () => {
  test("uninstalled: installation lookup 404 is uninstalled and no API call is made", async () => {
    const { gh, forge } = setup();
    gh.control.setInstalled(false);
    expect(kind(await forge.snapshot(live()))).toBe("uninstalled");
    expect(gh.control.log().map((l) => l.path)).toEqual(["/repos/acme/widgets/installation"]);
  });

  test("missing ledger: the branch is created at an empty root commit", async () => {
    const { gh, forge } = setup();
    const s = value(await forge.snapshot(live()));
    expect(s.ledger.files).toEqual({});
    expect(gh.control.ref("xarabot/claims")).toBe(s.ledger.tip);
    expect(gh.control.commit(s.ledger.tip)).toEqual({ tree: EMPTY_TREE, parents: [], message: LEDGER_ROOT_MESSAGE });
    const log = gh.control.log().filter((l) => l.method === "POST" && l.auth === "token");
    expect(log.map((l) => [l.path, l.body])).toEqual([
      ["/repos/acme/widgets/git/commits", { message: "xarabot ledger root [skip ci]", tree: EMPTY_TREE, parents: [] }],
      ["/repos/acme/widgets/git/refs", { ref: "refs/heads/xarabot/claims", sha: s.ledger.tip }],
    ]);
    // A second snapshot reads the branch and creates nothing.
    expect(value(await forge.snapshot(live())).ledger.tip).toBe(s.ledger.tip);
  });

  test("missing ledger: a racing creator yields conflict", async () => {
    const { gh, forge } = setup();
    gh.control.before("POST", /\/git\/refs$/, () => {
      gh.control.writeForeignLedger({ message: "other lane [skip ci]", writes: {}, deletes: [] });
    });
    const foreign = () => gh.control.ref("xarabot/claims");
    expect(kind(await forge.snapshot(live()))).toBe("conflict");
    expect(foreign()).toBeDefined();
    expect(gh.control.commit(foreign() as string)?.message).toBe("other lane [skip ci]");
  });

  test("snapshot order: ledger reads, then main reads, then pulls/{n}", async () => {
    const parts: SnapshotPart[] = [];
    const { gh, forge } = setup({ onRead: (p) => parts.push(p) });
    const record = serializeUnitRecord(rec({ pr: 7, pr_owner: "alice", head_sha: "a".repeat(40) }));
    gh.control.writeForeignLedger({ message: "claim [skip ci]", writes: { [unitPath("story:1.5")]: record }, deletes: [] });
    gh.control.setMain({ "README.md": "hi\n" });
    gh.control.setPull(7, { state: "open", merged: false, head_sha: "b".repeat(40) });
    const s = value(await forge.snapshot({ ...live(), read: () => true }));
    expect(s.prs).toEqual({ "story:1.5": { number: 7, state: "open", head_sha: "b".repeat(40) } });
    expect(parts).toEqual(["ledger", "main", "prs"]);

    const calls = apiCalls(gh);
    const ledgerTree = gh.control.commit(gh.control.ref("xarabot/claims") as string)?.tree as string;
    const mainTree = gh.control.commit(gh.control.ref("main") as string)?.tree as string;
    const at = (call: string) => calls.findIndex((c) => c.startsWith(call));
    const order = [
      at("GET /git/ref/heads/xarabot/claims"),
      at(`GET /git/trees/${ledgerTree}`),
      calls.indexOf("POST /graphql"),
      at("GET /git/ref/heads/main"),
      at(`GET /git/trees/${mainTree}`),
      calls.lastIndexOf("POST /graphql"),
      at("GET /pulls/7"),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(at("GET /pulls/7")).toBe(calls.length - 1);
  });

  test("ledger files are every blob of the tip, decoded as UTF-8", async () => {
    const { gh, forge } = setup();
    gh.control.writeForeignLedger({ message: "m", writes: { "units/a.json": "{\"ü\":1}\n", "coordinator.json": "{}" }, deletes: [] });
    expect(value(await forge.snapshot(live())).ledger.files).toEqual({ "units/a.json": "{\"ü\":1}\n", "coordinator.json": "{}" });
  });

  test("main: tree, blob SHAs, and only accepted paths are fetched as blobs", async () => {
    const { gh, forge } = setup();
    gh.control.setMain({ "a.md": "hello\n", "dir/b.txt": "x", "dir/deep/c.md": "" });
    value(await forge.snapshot(live()));
    gh.control.clearLog();
    const s = value(await forge.snapshot({ ...live(), read: (p) => p === "a.md" }));
    expect(s.main.tree).toEqual(["a.md", "dir/b.txt", "dir/deep/c.md"]);
    expect(s.main.files).toEqual({ "a.md": "hello\n" });
    expect(s.main.blob_shas["a.md"]).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    const calls = apiCalls(gh);
    expect(calls.filter((c) => c === "POST /graphql")).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("GET /git/blobs/"))).toEqual([]);
  });

  test("blobs are read BLOBS_PER_QUERY per GraphQL request, each distinct blob once, never one request per file", async () => {
    const { gh, forge } = setup();
    const files: Record<string, string> = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`docs/${i}.md`, `file ${i}\n`]));
    files["docs/copy.md"] = "file 0\n";
    gh.control.setMain(files);
    value(await forge.snapshot(live()));
    gh.control.clearLog();
    const s = value(await forge.snapshot({ ...live(), read: () => true }));
    expect(s.main.files).toEqual(files);
    const calls = apiCalls(gh);
    expect(calls.filter((c) => c === "POST /graphql")).toHaveLength(Math.ceil(250 / BLOBS_PER_QUERY));
    expect(calls.filter((c) => c.startsWith("GET /git/blobs/"))).toEqual([]);
  });

  test("a blob GraphQL reports truncated or binary is read over REST instead", async () => {
    const { privateKey, publicKey } = testKeys();
    const gh = createFakeGitHub({ publicKey });
    const forge = createGitHubForge({
      repo: { owner: "acme", name: "widgets" },
      credentials: { app: { id: 4242, slug: "alice-xarabot" }, key: privateKey },
      fetch: async (url, init) => {
        const r = await gh.fetch(url, init);
        if (!String(url).endsWith("/graphql")) return r;
        const body = (await r.json()) as { data: { repository: Record<string, Record<string, unknown> | null> } };
        const b0 = body.data.repository["b0"];
        if (b0 !== null && b0 !== undefined) body.data.repository["b0"] = { ...b0, text: "cut", isTruncated: true };
        return new Response(JSON.stringify(body), { status: r.status, headers: r.headers });
      },
      apiUrl: gh.control.apiUrl,
      now: gh.control.clock,
    });
    gh.control.setMain({ "a.md": "whole text\n", "b.md": "other\n" });
    const s = value(await forge.snapshot({ ...live(), read: () => true }));
    expect(s.main.files).toEqual({ "a.md": "whole text\n", "b.md": "other\n" });
    expect(apiCalls(gh).filter((c) => c.startsWith("GET /git/blobs/"))).toHaveLength(1);
  });

  test("GraphQL errors on the blob read fail the snapshot as transient", async () => {
    const { gh, forge } = setup();
    gh.control.setMain({ "a.md": "x", "b.md": "y" });
    value(await forge.snapshot(live()));
    gh.control.inject("POST", /\/graphql$/, { status: 200, body: { errors: [{ type: "INTERNAL", message: "Something went wrong" }] } });
    expect(kind(await forge.snapshot({ ...live(), read: () => true }))).toBe("transient");
  });

  test("a truncated tree is transient", async () => {
    const { gh, forge } = setup();
    gh.control.setMain({ "a.md": "x" });
    gh.control.truncateTrees(true);
    expect(kind(await forge.snapshot(live()))).toBe("transient");
  });

  test("merged, closed and missing PRs; an unparsable ledger gives prs {}", async () => {
    const { gh, forge } = setup();
    const a = rec({ unit: "story:1.8", globs: ["src/a/**"], pr: 1, pr_owner: "alice", head_sha: "a".repeat(40) });
    const b = rec({ unit: "story:1.9", globs: ["src/b/**"], pr: 2, pr_owner: "alice", head_sha: "b".repeat(40) });
    const c = rec({ unit: "story:1.10", globs: ["src/c/**"], pr: 3, pr_owner: "alice", head_sha: "c".repeat(40) });
    gh.control.writeForeignLedger({
      message: "m",
      writes: { [unitPath("story:1.8")]: serializeUnitRecord(a), [unitPath("story:1.9")]: serializeUnitRecord(b), [unitPath("story:1.10")]: serializeUnitRecord(c) },
      deletes: [],
    });
    gh.control.setPull(1, { state: "closed", merged: true, head_sha: "1".repeat(40) });
    gh.control.setPull(2, { state: "closed", merged: false, head_sha: "2".repeat(40) });
    expect(value(await forge.snapshot(live())).prs).toEqual({
      "story:1.8": { number: 1, state: "merged", head_sha: "1".repeat(40) },
      "story:1.9": { number: 2, state: "closed", head_sha: "2".repeat(40) },
    });
    gh.control.writeForeignLedger({ message: "m", writes: { "units/story__9.9.json": "{not json" }, deletes: [] });
    gh.control.clearLog();
    expect(value(await forge.snapshot(live())).prs).toEqual({});
    expect(apiCalls(gh).some((c) => c.includes("/pulls/"))).toBe(false);
  });

  test("now is the latest Date header seen during the snapshot", async () => {
    const { gh, forge } = setup();
    gh.control.setNow("2026-10-22T10:00:00Z");
    gh.control.before("GET", /\/git\/ref\/heads\/main$/, () => gh.control.setNow("2026-10-22T10:00:07Z"));
    gh.control.before("GET", /\/git\/trees\//, () => gh.control.setNow("2026-10-22T10:00:03Z"));
    expect(value(await forge.snapshot(live())).now).toBe("2026-10-22T10:00:07Z");
  });

  test("no Date header is transient", async () => {
    const { gh, forge } = setup();
    gh.control.omitDate(true);
    expect(kind(await forge.snapshot(live()))).toBe("transient");
  });

  test("rate limit: 403, remaining 0, reset at Date+30 is rate-limited with retry_after 30", async () => {
    const { gh, forge } = setup();
    const reset = Math.floor(gh.control.clock() / 1000) + 30;
    gh.control.inject("GET", LEDGER_REF, {
      status: 403,
      body: { message: "API rate limit exceeded" },
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
    });
    const r = await forge.snapshot(live());
    expect(r.ok ? "ok" : r.error).toEqual({ kind: "rate-limited", message: expect.any(String), retry_after: 30 });
  });

  test("a 401 on an API call is auth and drops the cached token", async () => {
    const { gh, forge } = setup();
    value(await forge.snapshot(live()));
    gh.control.revokeTokens();
    expect(kind(await forge.snapshot(live()))).toBe("auth");
    expect(gh.control.mints()).toBe(1);
    value(await forge.snapshot(live()));
    expect(gh.control.mints()).toBe(2);
  });

  test("a network error is transient", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", LEDGER_REF, "network-error");
    expect(kind(await forge.snapshot(live()))).toBe("transient");
  });
});

describe("ledgerSwap", () => {
  test("swap: blobs, tree, commit, then PATCH with force: false", async () => {
    const { gh, forge } = setup();
    gh.control.writeForeignLedger({ message: "seed", writes: { "units/a.json": "A", "units/b.json": "B" }, deletes: [] });
    const t0 = value(await forge.snapshot(live())).ledger.tip;
    const oldTree = gh.control.commit(t0)?.tree as string;
    gh.control.clearLog();
    const message = "claim story:1.5 [skip ci]\n\nbody line";
    const t1 = value(await forge.ledgerSwap(t0, { message, writes: { "units/c.json": "C", "units/a.json": "A2" }, deletes: ["units/b.json", "units/never.json"] }, live())).tip;

    const log = gh.control.log().filter((l) => l.auth === "token");
    expect(log.map((l) => `${l.method} ${l.path.replace("/repos/acme/widgets", "")}`)).toEqual([
      "GET /git/ref/heads/xarabot/claims",
      `GET /git/commits/${t0}`,
      `GET /git/trees/${oldTree}?recursive=1`,
      "POST /git/blobs",
      "POST /git/blobs",
      "POST /git/trees",
      "POST /git/commits",
      "PATCH /git/refs/heads/xarabot/claims",
    ]);
    expect(log.slice(3, 5).map((l) => l.body)).toEqual([
      { content: "C", encoding: "utf-8" },
      { content: "A2", encoding: "utf-8" },
    ]);
    const tree = log[5]?.body as { base_tree: string; tree: { path: string; sha: string | null }[] };
    expect(tree.base_tree).toBe(oldTree);
    expect(tree.tree.map((e) => [e.path, e.sha === null ? null : "sha"])).toEqual([
      ["units/c.json", "sha"],
      ["units/a.json", "sha"],
      ["units/b.json", null],
    ]);
    const commit = log[6]?.body as { message: string; parents: string[] };
    expect(commit.message).toBe(message);
    expect(commit.parents).toEqual([t0]);
    expect(log[7]?.body).toEqual({ sha: t1, force: false });
    expect(gh.control.files("xarabot/claims")).toEqual({ "units/a.json": "A2", "units/c.json": "C" });
  });

  test("a swap from the empty root posts a tree without base_tree", async () => {
    const { gh, forge } = setup();
    const t0 = value(await forge.snapshot(live())).ledger.tip;
    gh.control.clearLog();
    value(await forge.ledgerSwap(t0, { message: "m", writes: { "units/a.json": "1" }, deletes: [] }, live()));
    const tree = gh.control.log().find((l) => l.path.endsWith("/git/trees"))?.body as Record<string, unknown>;
    expect("base_tree" in tree).toBe(false);
    expect(gh.control.files("xarabot/claims")).toEqual({ "units/a.json": "1" });
  });

  test("a tip other than oldSha is conflict before any write", async () => {
    const { gh, forge } = setup();
    const t0 = value(await forge.snapshot(live())).ledger.tip;
    gh.control.writeForeignLedger({ message: "bob", writes: { "units/bob.json": "{}" }, deletes: [] });
    gh.control.clearLog();
    expect(kind(await forge.ledgerSwap(t0, { message: "m", writes: { "units/x.json": "1" }, deletes: [] }, live()))).toBe("conflict");
    expect(apiCalls(gh)).toEqual(["GET /git/ref/heads/xarabot/claims"]);
  });

  test("non-fast-forward: PATCH answering 422 is conflict; a 409 is not conflict", async () => {
    const { gh, forge } = setup();
    const t0 = value(await forge.snapshot(live())).ledger.tip;
    gh.control.inject("PATCH", /\/git\/refs\/heads\/xarabot\/claims$/, {
      status: 422,
      body: { message: "Update is not a fast forward" },
    });
    expect(kind(await forge.ledgerSwap(t0, { message: "m", writes: { "units/x.json": "1" }, deletes: [] }, live()))).toBe("conflict");
    gh.control.inject("PATCH", /\/git\/refs\/heads\/xarabot\/claims$/, { status: 409, body: { message: "Conflict" } });
    const r = await forge.ledgerSwap(t0, { message: "m", writes: { "units/x.json": "1" }, deletes: [] }, live());
    expect(kind(r)).toBe("rejected");
    expect(gh.control.ref("xarabot/claims")).toBe(t0);
  });

  test("a real non-fast-forward PATCH from the emulator is conflict", async () => {
    const { gh, forge } = setup();
    const t0 = value(await forge.snapshot(live())).ledger.tip;
    gh.control.before("PATCH", /\/git\/refs\/heads\/xarabot\/claims$/, () => {
      gh.control.writeForeignLedger({ message: "bob", writes: { "units/bob.json": "{}" }, deletes: [] });
    });
    expect(kind(await forge.ledgerSwap(t0, { message: "m", writes: { "units/x.json": "1" }, deletes: [] }, live()))).toBe("conflict");
    expect(gh.control.files("xarabot/claims")).toEqual({ "units/bob.json": "{}" });
  });
});

describe("branchHead", () => {
  const STORY_REF = /\/git\/ref\/heads\/story\/1\.1$/;

  test("a missing branch is null; a present one is its SHA, from one ref read", async () => {
    const { gh, forge } = setup();
    expect(value(await forge.branchHead("story/1.1", live()))).toBeNull();
    const sha = "b".repeat(40);
    gh.control.setBranch("story/1.1", sha);
    gh.control.clearLog();
    expect(value(await forge.branchHead("story/1.1", live()))).toBe(sha);
    expect(apiCalls(gh)).toEqual(["GET /git/ref/heads/story/1.1"]);
  });

  test("a server error is transient, a network error transient, and a reply with no object.sha malformed", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", STORY_REF, { status: 502, body: { message: "Bad Gateway" } });
    expect(kind(await forge.branchHead("story/1.1", live()))).toBe("transient");
    gh.control.inject("GET", STORY_REF, "network-error");
    expect(kind(await forge.branchHead("story/1.1", live()))).toBe("transient");
    gh.control.inject("GET", STORY_REF, { status: 200, body: { ref: "refs/heads/story/1.1" } });
    const r = await forge.branchHead("story/1.1", live());
    expect(r.ok ? "ok" : r.error.message).toContain("malformed reply");
  });

  test("an uninstalled App is uninstalled, not null", async () => {
    const { gh, forge } = setup();
    gh.control.setInstalled(false);
    expect(kind(await forge.branchHead("story/1.1", live()))).toBe("uninstalled");
  });
});

describe("every operation", () => {
  const sha = "a".repeat(40);
  const calls = (f: Forge, signal: AbortSignal): Readonly<Record<ForgeOperation, () => Promise<ForgeResult<unknown>>>> => {
    const o = { signal };
    return {
      snapshot: () => f.snapshot(o),
      ledgerSwap: () => f.ledgerSwap(sha, { message: "m", writes: {}, deletes: [] }, o),
      pushBranch: () => f.pushBranch({ branch: "story/9.9", expected_sha: null, sha }, o),
      branchHead: () => f.branchHead("story/9.9", o),
      openPr: () => f.openPr({ branch: "story/9.9", base: "main", title: "t", body: "b" }, o),
      updatePr: () => f.updatePr(1, { title: "t" }, o),
      closePr: () => f.closePr(1, o),
      listPrsByBranch: () => f.listPrsByBranch("story/9.9", o),
      reviews: () => f.reviews(1, o),
      comment: () => f.comment(1, "b", o),
      checks: () => f.checks(sha, o),
      enqueue: () => f.enqueue(1, sha, o),
      dequeue: () => f.dequeue(1, o),
      queueState: () => f.queueState(1, o),
      alert: () => f.alert("c", sha, o),
      prefetch: () => f.prefetch({ kind: "ci-log", sha, dir: join(tmpdir(), "xarabot-never") }, o),
    };
  };

  test("an already-aborted signal is transient before any request", async () => {
    const { gh, forge } = setup();
    const c = calls(forge, AbortSignal.abort());
    for (const op of FORGE_OPERATIONS) expect([op, kind(await c[op]())]).toEqual([op, "transient"]);
    expect(gh.control.log()).toEqual([]);
  });
});

describe("token leak", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function filesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...filesUnder(p));
      else out.push(p);
    }
    return out;
  }

  test("after a full snapshot and swap the token is absent from env, argv, files, console, results and messages", async () => {
    const { privateKey, publicKey } = testKeys();
    const home = mkdtempSync(join(tmpdir(), "xarabot-home-"));
    dirs.push(home);
    const appDir = join(home, ".config", "xarabot", "apps", "alice-xarabot");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "private-key.pem"), privateKey.export({ type: "pkcs8", format: "pem" }));
    chmodSync(join(appDir, "private-key.pem"), 0o600);
    writeFileSync(join(appDir, "app.json"), JSON.stringify({ id: 4242, slug: "alice-xarabot" }));

    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((m) => spyOn(console, m));
    try {
      const credentials = value(await loadAppCredentials({ login: "alice", env: { HOME: home } }));
      const gh = createFakeGitHub({ publicKey });
      const forge = createGitHubForge({
        repo: { owner: "acme", name: "widgets" },
        credentials,
        fetch: gh.fetch,
        apiUrl: gh.control.apiUrl,
        now: gh.control.clock,
      });
      const results: unknown[] = [];
      const s1 = await forge.snapshot({ ...live(), read: () => true });
      results.push(s1);
      const tip = value(s1).ledger.tip;
      results.push(await forge.ledgerSwap(tip, { message: "m [skip ci]", writes: { "units/a.json": "{}" }, deletes: [] }, live()));
      results.push(await forge.snapshot(live()));

      const [token] = gh.control.tokens();
      if (token === undefined) throw new Error("no token minted");
      // An error whose GitHub message quotes the token comes back redacted.
      gh.control.inject("GET", LEDGER_REF, { status: 403, body: { message: `token ${token} lacks contents: write` } });
      const failed = await forge.snapshot(live());
      results.push(failed);
      expect(failed.ok ? "ok" : failed.error.message).toContain("[redacted]");

      const haystacks = [
        JSON.stringify(process.env),
        process.argv.join(" "),
        ...filesUnder(home).map((f) => readFileSync(f, "utf8")),
        JSON.stringify(spies.map((s) => s.mock.calls)),
        JSON.stringify(results),
      ];
      for (const h of haystacks) expect(h.includes(token)).toBe(false);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
