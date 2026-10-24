import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createGitHubForge, MAX_PAGES } from "../../../../src/adapters/forge/github/github-forge.ts";
import type { FetchLike } from "../../../../src/adapters/forge/github/http.ts";
import type { Forge, ForgeResult } from "../../../../src/ports/forge.ts";
import { createFakeGitHub, LOGS_HOST, testKeys, type FakeGitHub } from "./fake-github.ts";

const live = () => ({ signal: new AbortController().signal });
const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const SHA = "d".repeat(40);

function setup(wrap?: (fetch: FetchLike) => FetchLike): { gh: FakeGitHub; forge: Forge } {
  const { privateKey, publicKey } = testKeys();
  const gh = createFakeGitHub({ publicKey });
  const forge = createGitHubForge({
    repo: { owner: "acme", name: "widgets" },
    credentials: { app: { id: 4242, slug: "alice-xarabot" }, key: privateKey },
    fetch: wrap === undefined ? gh.fetch : wrap(gh.fetch),
    apiUrl: gh.control.apiUrl,
    now: gh.control.clock,
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

/** Token-authenticated API calls as `METHOD path` (below the repo). */
function calls(gh: FakeGitHub): string[] {
  return gh.control
    .log()
    .filter((l) => l.host === "api" && l.auth === "token")
    .map((l) => `${l.method} ${l.path.replace("/repos/acme/widgets", "")}`);
}

function bodies(gh: FakeGitHub, method: string): unknown[] {
  return gh.control
    .log()
    .filter((l) => l.host === "api" && l.method === method)
    .map((l) => l.body);
}

describe("openPr", () => {
  test("POSTs title, body, head and base and returns the PR", async () => {
    const { gh, forge } = setup();
    gh.control.setBranch("story/1.9", H1);
    const pr = value(await forge.openPr({ branch: "story/1.9", base: "main", title: "T", body: "B" }, live()));
    expect(pr).toEqual({ number: pr.number, branch: "story/1.9", base: "main", state: "open", head_sha: H1, title: "T", body: "B" });
    expect(calls(gh)).toEqual(["POST /pulls"]);
    expect(bodies(gh, "POST")).toContainEqual({ title: "T", body: "B", head: "story/1.9", base: "main" });
  });

  test("a second open PR on the branch is conflict", async () => {
    const { gh, forge } = setup();
    gh.control.setBranch("story/1.9", H1);
    value(await forge.openPr({ branch: "story/1.9", base: "main", title: "T", body: "B" }, live()));
    const r = await forge.openPr({ branch: "story/1.9", base: "main", title: "T", body: "B" }, live());
    expect(r.ok ? "ok" : r.error).toEqual({ kind: "conflict", message: "createPull: 422 A pull request already exists for acme:story/1.9." });
  });

  test("a missing head or base is not-found", async () => {
    const { gh, forge } = setup();
    expect(kind(await forge.openPr({ branch: "story/404", base: "main", title: "T", body: "B" }, live()))).toBe("not-found");
    gh.control.setBranch("story/1.9", H1);
    expect(kind(await forge.openPr({ branch: "story/1.9", base: "nope", title: "T", body: "B" }, live()))).toBe("not-found");
  });

  test("another 422 goes through mapHttpError", async () => {
    const { gh, forge } = setup();
    gh.control.inject("POST", /\/pulls$/, {
      status: 422,
      body: { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "No commits between main and story/1.9" }] },
    });
    expect(kind(await forge.openPr({ branch: "story/1.9", base: "main", title: "T", body: "B" }, live()))).toBe("rejected");
  });

  test("a null body comes back as an empty string; merged_at makes it merged", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(4, { state: "open", merged: false, head_sha: H1, branch: "story/1.9", body: null });
    gh.control.setPull(5, { state: "closed", merged: true, head_sha: H2, branch: "story/1.9" });
    const listed = value(await forge.listPrsByBranch("story/1.9", live()));
    expect(listed.map((p) => [p.number, p.state, p.body])).toEqual([
      [4, "open", ""],
      [5, "merged", ""],
    ]);
  });
});

describe("updatePr and closePr", () => {
  test("update GETs then PATCHes only the given fields", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(7, { state: "open", merged: false, head_sha: H1, branch: "story/1.9", title: "old", body: "b" });
    const pr = value(await forge.updatePr(7, { title: "new" }, live()));
    expect(pr).toMatchObject({ number: 7, title: "new", body: "b", state: "open" });
    expect(calls(gh)).toEqual(["GET /pulls/7", "PATCH /pulls/7"]);
    expect(bodies(gh, "PATCH")).toEqual([{ title: "new" }]);
  });

  test("an empty update returns the PR unchanged and PATCHes nothing", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(7, { state: "open", merged: false, head_sha: H1, branch: "story/1.9", title: "t", body: "b" });
    expect(value(await forge.updatePr(7, {}, live()))).toMatchObject({ number: 7, title: "t", body: "b" });
    expect(calls(gh)).toEqual(["GET /pulls/7"]);
  });

  test("close PATCHes state closed", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(7, { state: "open", merged: false, head_sha: H1, branch: "story/1.9" });
    expect(value(await forge.closePr(7, live())).state).toBe("closed");
    expect(bodies(gh, "PATCH")).toEqual([{ state: "closed" }]);
  });

  test("a merged PR is conflict without a PATCH; a missing PR is not-found", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(7, { state: "closed", merged: true, head_sha: H1, branch: "story/1.9" });
    expect(kind(await forge.updatePr(7, { title: "x" }, live()))).toBe("conflict");
    expect(kind(await forge.closePr(7, live()))).toBe("conflict");
    expect(calls(gh).filter((c) => c.startsWith("PATCH"))).toEqual([]);
    expect(kind(await forge.updatePr(99, { title: "x" }, live()))).toBe("not-found");
    expect(kind(await forge.closePr(99, live()))).toBe("not-found");
  });

  test("a PATCH 422 that mentions merged is conflict; another 422 is not", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(7, { state: "open", merged: false, head_sha: H1, branch: "story/1.9" });
    gh.control.inject("PATCH", /\/pulls\/7$/, { status: 422, body: { message: "Validation Failed", errors: [{ message: "Cannot update a merged pull request" }] } });
    expect(kind(await forge.closePr(7, live()))).toBe("conflict");
    gh.control.inject("PATCH", /\/pulls\/7$/, { status: 422, body: { message: "Validation Failed" } });
    expect(kind(await forge.closePr(7, live()))).toBe("rejected");
  });
});

describe("listPrsByBranch", () => {
  test("pages 100 at a time until a short page, keeps head.ref === branch, sorts ascending", async () => {
    const { gh, forge } = setup();
    for (let n = 1; n <= 150; n += 1) gh.control.setPull(n, { state: n % 2 === 0 ? "open" : "closed", merged: false, head_sha: H1, branch: "story/1.9" });
    gh.control.setPull(151, { state: "open", merged: false, head_sha: H1, branch: "story/other" });
    const listed = value(await forge.listPrsByBranch("story/1.9", live()));
    expect(listed.map((p) => p.number)).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
    const head = encodeURIComponent("acme:story/1.9");
    expect(calls(gh)).toEqual([
      `GET /pulls?head=${head}&state=all&per_page=100&page=1`,
      `GET /pulls?head=${head}&state=all&per_page=100&page=2`,
    ]);
  });

  test("a PR whose head.ref differs from the branch is dropped", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", /\/pulls\?/, {
      status: 200,
      body: [
        { number: 3, state: "open", title: "t", body: "b", head: { ref: "story/1.9", sha: H1 }, base: { ref: "main" } },
        { number: 2, state: "open", title: "t", body: "b", head: { ref: "story/1.9x", sha: H1 }, base: { ref: "main" } },
      ],
    });
    expect(value(await forge.listPrsByBranch("story/1.9", live())).map((p) => p.number)).toEqual([3]);
  });

  test("a list entry with merged_at and no merged field is merged, as GitHub's list sends it", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", /\/pulls\?/, {
      status: 200,
      body: [
        { number: 3, state: "closed", merged_at: "2026-10-22T00:00:00Z", title: "t", body: "b", head: { ref: "story/1.9", sha: H1 }, base: { ref: "main" } },
        { number: 4, state: "closed", merged_at: null, title: "t", body: "b", head: { ref: "story/1.9", sha: H1 }, base: { ref: "main" } },
      ],
    });
    expect(value(await forge.listPrsByBranch("story/1.9", live())).map((p) => [p.number, p.state])).toEqual([
      [3, "merged"],
      [4, "closed"],
    ]);
  });

  test(`more than ${MAX_PAGES} full pages is transient`, async () => {
    const { gh, forge } = setup();
    for (let n = 1; n <= MAX_PAGES * 100; n += 1) gh.control.setPull(n, { state: "closed", merged: false, head_sha: H1, branch: "story/1.9" });
    expect(kind(await forge.listPrsByBranch("story/1.9", live()))).toBe("transient");
    expect(calls(gh)).toHaveLength(MAX_PAGES);
  });
});

describe("comment", () => {
  test("GETs the PR, POSTs the body verbatim to the issue and returns the id as a string", async () => {
    const { gh, forge } = setup();
    gh.control.setPull(7, { state: "open", merged: false, head_sha: H1, branch: "story/1.9" });
    const posted = value(await forge.comment(7, "🤖 hi\n@nobody", live()));
    expect(typeof posted.id).toBe("string");
    expect(calls(gh)).toEqual(["GET /pulls/7", "POST /issues/7/comments"]);
    expect(bodies(gh, "POST")).toContainEqual({ body: "🤖 hi\n@nobody" });
    expect(gh.control.comments(7)).toEqual(["🤖 hi\n@nobody"]);
  });

  test("a missing PR is not-found and posts nothing", async () => {
    const { gh, forge } = setup();
    expect(kind(await forge.comment(99, "x", live()))).toBe("not-found");
    expect(calls(gh)).toEqual(["GET /pulls/99"]);
  });
});

describe("prefetch", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tempDir = () => {
    const d = mkdtempSync(join(tmpdir(), "xarabot-prefetch-"));
    dirs.push(d);
    return d;
  };

  test("an Actions log is downloaded through the redirect without Authorization", async () => {
    const { gh, forge } = setup();
    gh.control.setChecks(SHA, [{ name: "test", status: "completed", conclusion: "failure" }]);
    gh.control.setCiLog(SHA, "test", "1 failing\n");
    const dir = join(tempDir(), "logs");
    const { files } = value(await forge.prefetch({ kind: "ci-log", sha: SHA, dir }, live()));
    expect(files).toEqual([join(dir, "test.log")]);
    expect(readFileSync(files[0] as string, "utf8")).toBe("1 failing\n");
    const log = gh.control.log();
    const jobs = log.filter((l) => l.host === "api" && l.path.includes("/actions/jobs/"));
    expect(jobs.map((l) => l.auth)).toEqual(["token"]);
    const downloads = log.filter((l) => l.host === "logs");
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.auth).toBe("none");
    expect(downloads[0]?.headers["authorization"]).toBeUndefined();
    expect(LOGS_HOST).toStartWith("https://");
    expect(calls(gh)[0]).toBe(`GET /commits/${SHA}/check-runs?filter=latest&per_page=100&page=1`);
  });

  test("a 404 or 410 job log writes logs unavailable", async () => {
    const { gh, forge } = setup();
    gh.control.setChecks(SHA, [
      { name: "gone", status: "completed", conclusion: "failure" },
      { name: "expired", status: "completed", conclusion: "cancelled" },
    ]);
    // The first job-log request (for "gone") answers 410; "expired" has no log, so 404.
    gh.control.inject("GET", /\/actions\/jobs\/\d+\/logs$/, { status: 410, body: { message: "Gone" } });
    const dir = tempDir();
    const { files } = value(await forge.prefetch({ kind: "ci-log", sha: SHA, dir }, live()));
    expect(files.map((f) => [basename(f), readFileSync(f, "utf8")]).sort()).toEqual([
      ["expired.log", "logs unavailable (404)\n"],
      ["gone.log", "logs unavailable (410)\n"],
    ]);
  });

  /** Answers every download from the log host with `status`. */
  const logHostAnswers = (status: number) => (fetch: FetchLike): FetchLike => (url, init) =>
    url.startsWith(`${LOGS_HOST}/`) ? Promise.resolve(new Response("nope", { status })) : fetch(url, init);

  test("a 404 or 410 from the log download writes logs unavailable", async () => {
    for (const status of [404, 410]) {
      const { gh, forge } = setup(logHostAnswers(status));
      gh.control.setChecks(SHA, [{ name: "test", status: "completed", conclusion: "failure" }]);
      gh.control.setCiLog(SHA, "test", "1 failing\n");
      const { files } = value(await forge.prefetch({ kind: "ci-log", sha: SHA, dir: tempDir() }, live()));
      expect(files.map((f) => readFileSync(f, "utf8"))).toEqual([`logs unavailable (${status})\n`]);
    }
  });

  test("an unknown commit (check-runs 422) is not-found", async () => {
    const { gh, forge } = setup();
    gh.control.inject("GET", /\/check-runs\?/, { status: 422, body: { message: "No commit found for SHA" } });
    expect(kind(await forge.prefetch({ kind: "ci-log", sha: SHA, dir: tempDir() }, live()))).toBe("not-found");
  });

  test("another failed log download goes through mapHttpError", async () => {
    const { gh, forge } = setup(logHostAnswers(403));
    gh.control.setChecks(SHA, [{ name: "test", status: "completed", conclusion: "failure" }]);
    gh.control.setCiLog(SHA, "test", "1 failing\n");
    expect(kind(await forge.prefetch({ kind: "ci-log", sha: SHA, dir: tempDir() }, live()))).toBe("forbidden");
  });

  test("a non-Actions run writes its output and details_url; names dedupe case-insensitively", async () => {
    const { gh, forge } = setup();
    gh.control.setChecks(SHA, [
      { name: "Lint", status: "completed", conclusion: "action_required", app: "some-ci", output: { title: "T", summary: "S", text: "X" }, details_url: "https://ci.test/1" },
      { name: "lint", status: "completed", conclusion: "failure", app: "other-ci", output: { title: "only title" } },
      { name: "ok", status: "completed", conclusion: "neutral", app: "some-ci" },
      { name: "pending", status: "in_progress", conclusion: null, app: "some-ci" },
    ]);
    const dir = tempDir();
    const { files } = value(await forge.prefetch({ kind: "ci-log", sha: SHA, dir }, live()));
    expect(files.map((f) => basename(f))).toEqual(["Lint.log", "lint-2.log"]);
    expect(readFileSync(files[0] as string, "utf8")).toBe("T\n\nS\n\nX\n\nhttps://ci.test/1\n");
    expect(readFileSync(files[1] as string, "utf8")).toStartWith("only title\n\n");
    expect(gh.control.log().some((l) => l.path.includes("/actions/jobs/"))).toBe(false);
  });

  test("check runs are paged like pulls", async () => {
    const { gh, forge } = setup();
    gh.control.setChecks(
      SHA,
      Array.from({ length: 120 }, (_, i) => ({ name: `c${i}`, status: "completed" as const, conclusion: "success", app: "some-ci" })),
    );
    expect(value(await forge.prefetch({ kind: "ci-log", sha: SHA, dir: tempDir() }, live()))).toEqual({ files: [] });
    expect(calls(gh)).toEqual([
      `GET /commits/${SHA}/check-runs?filter=latest&per_page=100&page=1`,
      `GET /commits/${SHA}/check-runs?filter=latest&per_page=100&page=2`,
    ]);
  });
});
