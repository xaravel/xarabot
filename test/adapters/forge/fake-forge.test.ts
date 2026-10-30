import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeForge, FAKE_BOT_LOGIN, gitBlobSha } from "../../../src/adapters/forge/fake/fake-forge.ts";
import { serializeUnitRecord } from "../../../src/core/ledger/codec.ts";
import { unitPath } from "../../../src/core/schemas/ledger.ts";
import { rec } from "../../core/ledger/fixtures.ts";
import { FORGE_OPERATIONS, type CallOpts, type ForgeResult } from "../../../src/ports/forge.ts";

const live = (): CallOpts => ({ signal: new AbortController().signal });
const SHA40 = /^[0-9a-f]{40}$/;

function value<T>(r: ForgeResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.kind}: ${r.error.message}`);
  return r.value;
}

describe("fake forge", () => {
  test("has exactly the port's operations", () => {
    expect(Object.keys(createFakeForge().forge).sort()).toEqual([...FORGE_OPERATIONS].sort());
  });

  test("blob SHAs are git's", () => {
    expect(gitBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  test("the ledger starts at an empty root commit", async () => {
    const { forge, control } = createFakeForge();
    const s = value(await forge.snapshot(live()));
    expect(s.ledger.files).toEqual({});
    expect(control.ledgerLog()).toEqual([{ sha: s.ledger.tip, parent: null, message: "root" }]);
  });

  test("commit SHAs are 40-hex, distinct and deterministic per instance", async () => {
    const run = async (): Promise<string[]> => {
      const { forge, control } = createFakeForge();
      const t0 = value(await forge.snapshot(live())).ledger.tip;
      const t1 = value(await forge.ledgerSwap(t0, { message: "m", writes: { a: "1" }, deletes: [] }, live())).tip;
      return [t0, t1, control.makeCommit(), control.setMain({ x: "y" }), control.writeForeignLedger({ message: "f", writes: {}, deletes: [] })];
    };
    const a = await run();
    for (const sha of a) expect(sha).toMatch(SHA40);
    expect(new Set(a).size).toBe(a.length);
    expect(await run()).toEqual(a);
  });

  test("racing swaps add exactly one commit to the log", async () => {
    const { forge, control } = createFakeForge();
    const t0 = value(await forge.snapshot(live())).ledger.tip;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => forge.ledgerSwap(t0, { message: `r${i}`, writes: { [`f${i}`]: "x" }, deletes: [] }, live())),
    );
    const log = control.ledgerLog();
    expect(log).toHaveLength(2);
    expect(log[1]?.parent).toBe(t0);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  test("options set now, main and the first PR number", async () => {
    const { forge, control } = createFakeForge({ now: "2026-10-22T10:00:00Z", main: { "a.md": "x" }, firstPrNumber: 7 });
    const s = value(await forge.snapshot({ ...live(), read: () => true }));
    expect(s.now).toBe("2026-10-22T10:00:00Z");
    expect(s.main.files).toEqual({ "a.md": "x" });
    value(await forge.pushBranch({ branch: "story/1.7", expected_sha: null, sha: control.makeCommit() }, live()));
    const pr = value(await forge.openPr({ branch: "story/1.7", base: "main", title: "t", body: "b" }, live()));
    expect(pr.number).toBe(7);
    value(await forge.comment(7, "🤖 hi", live()));
    expect(control.comments(7)).toEqual(["🤖 hi"]);
    expect(control.comments(8)).toEqual([]);
  });

  test("postReview records a commented review at commit_sha by the bot, and keeps the body", async () => {
    const { forge, control } = createFakeForge({ now: "2026-10-25T10:00:00Z", firstPrNumber: 7 });
    const head = control.makeCommit();
    value(await forge.pushBranch({ branch: "story/3.4", expected_sha: null, sha: head }, live()));
    value(await forge.openPr({ branch: "story/3.4", base: "main", title: "t", body: "b" }, live()));
    value(await forge.postReview(7, { commit_sha: head, body: "🤖 review" }, live()));
    expect(value(await forge.reviews(7, live()))).toEqual([{ author: FAKE_BOT_LOGIN, state: "commented", commit_sha: head, submitted_at: "2026-10-25T10:00:00Z" }]);
    expect(control.reviewBodies(7)).toEqual(["🤖 review"]);
    expect(control.comments(7)).toEqual([]);
    const missing = await forge.postReview(8, { commit_sha: head, body: "x" }, live());
    expect(missing.ok ? "ok" : missing.error.kind).toBe("not-found");
  });

  test("botLogin names the account postReview's reviews are by", async () => {
    const { forge, control } = createFakeForge({ botLogin: "alice-xarabot[bot]" });
    const head = control.makeCommit();
    value(await forge.pushBranch({ branch: "story/3.4", expected_sha: null, sha: head }, live()));
    const pr = value(await forge.openPr({ branch: "story/3.4", base: "main", title: "t", body: "b" }, live()));
    value(await forge.postReview(pr.number, { commit_sha: head, body: "x" }, live()));
    expect(value(await forge.reviews(pr.number, live())).map((r) => r.author)).toEqual(["alice-xarabot[bot]"]);
  });

  test("snapshot traces ledger, main, prs in order, once each", async () => {
    const { forge, control } = createFakeForge();
    value(await forge.snapshot(live()));
    expect(control.trace()).toEqual(["ledger", "main", "prs"]);
  });

  test("snapshot omits units whose PR the forge does not know", async () => {
    const { forge, control } = createFakeForge();
    control.writeForeignLedger({ message: "m", writes: { [unitPath("story:1.5")]: serializeUnitRecord(rec({ pr: 12345 })) }, deletes: [] });
    const s = await forge.snapshot(live());
    expect(s.ok).toBe(true);
    expect(value(s).prs).toEqual({});
  });

  test("snapshot skips PR states for an unparsable ledger", async () => {
    const { forge, control } = createFakeForge();
    control.writeForeignLedger({ message: "m", writes: { "units/story__1.5.json": "not json" }, deletes: [] });
    const s = value(await forge.snapshot(live()));
    expect(s.prs).toEqual({});
    expect(s.ledger.files["units/story__1.5.json"]).toBe("not json");
  });

  test("an injected error hits only the named operation's next call", async () => {
    const { forge, control } = createFakeForge();
    control.injectError("alert", { kind: "forbidden", message: "no" });
    expect((await forge.checks("a".repeat(40), live())).ok).toBe(true);
    expect(await forge.alert("c", "a".repeat(40), live())).toEqual({ ok: false, error: { kind: "forbidden", message: "no" } });
    expect(await forge.alert("c", "a".repeat(40), live())).toEqual({ ok: true, value: { posted: true } });
    expect(control.alerts()).toEqual([{ condition: "c", main_sha: "a".repeat(40) }]);
  });

  test("the before-swap hook runs before the compare-and-set and can move the tip", async () => {
    const { forge, control } = createFakeForge();
    const t0 = value(await forge.snapshot(live())).ledger.tip;
    const calls: number[] = [];
    const olds: string[] = [];
    control.beforeSwap(({ n, oldSha }) => {
      calls.push(n);
      olds.push(oldSha);
      if (n === 1) control.writeForeignLedger({ message: "foreign", writes: { b: "1" }, deletes: [] });
    });
    expect((await forge.ledgerSwap(t0, { message: "m", writes: {}, deletes: [] }, live())).ok).toBe(false);
    control.beforeSwap(null);
    const t1 = value(await forge.snapshot(live())).ledger.tip;
    expect((await forge.ledgerSwap(t1, { message: "m", writes: {}, deletes: [] }, live())).ok).toBe(true);
    expect(calls).toEqual([1]);
    expect(olds).toEqual([t0]);
  });

  test("loseSwapAck: the next swap that lands reports transient, once; a swap that conflicts keeps it armed", async () => {
    const { forge, control } = createFakeForge();
    control.loseSwapAck();
    const t0 = value(await forge.snapshot(live())).ledger.tip;
    control.writeForeignLedger({ message: "foreign", writes: { b: "1" }, deletes: [] });
    // A conflicting swap lands nothing, so the lost ack waits for one that lands.
    expect(await forge.ledgerSwap(t0, { message: "stale", writes: {}, deletes: [] }, live())).toMatchObject({ ok: false, error: { kind: "conflict" } });
    const t1 = value(await forge.snapshot(live())).ledger.tip;
    expect(await forge.ledgerSwap(t1, { message: "m1", writes: { a: "1" }, deletes: [] }, live())).toEqual({
      ok: false,
      error: { kind: "transient", message: "ledgerSwap: ack lost" },
    });
    const after = value(await forge.snapshot(live())).ledger;
    expect(after.tip).not.toBe(t1);
    expect(after.files).toEqual({ a: "1", b: "1" });
    expect(control.ledgerLog().at(-1)?.message).toBe("m1");
    expect((await forge.ledgerSwap(after.tip, { message: "m2", writes: {}, deletes: [] }, live())).ok).toBe(true);
  });

  test("branchHead reads the pushed head; an unknown branch is null", async () => {
    const { forge, control } = createFakeForge();
    expect(value(await forge.branchHead("story/1.1", live()))).toBeNull();
    const sha = control.makeCommit();
    value(await forge.pushBranch({ branch: "story/1.1", expected_sha: null, sha }, live()));
    expect(value(await forge.branchHead("story/1.1", live()))).toBe(sha);
    control.injectError("branchHead", { kind: "transient", message: "down" });
    expect(await forge.branchHead("story/1.1", live())).toEqual({ ok: false, error: { kind: "transient", message: "down" } });
  });

  test("deleteBranch refuses the protected branches and a branch with an open PR, and frees a deleted one for a null lease", async () => {
    const { forge, control } = createFakeForge();
    expect(await forge.deleteBranch("main", live())).toEqual({ ok: false, error: { kind: "forbidden", message: "deleteBranch: main is protected" } });
    expect((await forge.deleteBranch("xarabot/claims", live())).ok ? "ok" : "refused").toBe("refused");
    const sha = control.makeCommit();
    value(await forge.pushBranch({ branch: "xarabot/reconcile-1", expected_sha: null, sha }, live()));
    const pr = value(await forge.openPr({ branch: "xarabot/reconcile-1", base: "main", title: "t", body: "b" }, live()));
    expect(await forge.deleteBranch("xarabot/reconcile-1", live())).toEqual({
      ok: false,
      error: { kind: "conflict", message: `deleteBranch: xarabot/reconcile-1 has open PR #${pr.number}` },
    });
    value(await forge.closePr(pr.number, live()));
    control.injectError("deleteBranch", { kind: "transient", message: "down" });
    expect(await forge.deleteBranch("xarabot/reconcile-1", live())).toEqual({ ok: false, error: { kind: "transient", message: "down" } });
    expect(value(await forge.branchHead("xarabot/reconcile-1", live()))).toBe(sha);
    expect(value(await forge.deleteBranch("xarabot/reconcile-1", live()))).toEqual({ deleted: true });
    expect(value(await forge.branchHead("xarabot/reconcile-1", live()))).toBeNull();
    const next = control.makeCommit();
    expect(value(await forge.pushBranch({ branch: "xarabot/reconcile-1", expected_sha: null, sha: next }, live()))).toEqual({ sha: next });
  });

  test("deleteBranch deletes only in its unit-branch namespace, xarabot/ by default (Epic 2 retro item 37)", async () => {
    const { forge, control } = createFakeForge({ unitBranchPrefix: "bot/" });
    const sha = control.makeCommit();
    for (const branch of ["bot/reconcile-1", "xarabot/reconcile-1"]) value(await forge.pushBranch({ branch, expected_sha: null, sha }, live()));
    expect(await forge.deleteBranch("xarabot/reconcile-1", live())).toEqual({
      ok: false,
      error: { kind: "forbidden", message: `deleteBranch: "xarabot/reconcile-1" is outside the runner's branches "bot/"` },
    });
    expect(value(await forge.branchHead("xarabot/reconcile-1", live()))).toBe(sha);
    expect(value(await forge.deleteBranch("bot/reconcile-1", live()))).toEqual({ deleted: true });
    const plain = createFakeForge().forge;
    expect((await plain.deleteBranch("bot/reconcile-1", live())).ok ? "ok" : "refused").toBe("refused");
    expect(value(await plain.deleteBranch("xarabot/reconcile-1", live()))).toEqual({ deleted: false });
  });

  test("protected branches refuse pushes", async () => {
    const { forge, control } = createFakeForge();
    for (const branch of ["main", "xarabot/claims"]) {
      const r = await forge.pushBranch({ branch, expected_sha: null, sha: control.makeCommit() }, live());
      expect(r.ok ? "ok" : r.error.kind).toBe("forbidden");
    }
  });

  test("refusePushes: later pushes to that branch are rejected and move nothing; others still push", async () => {
    const { forge, control } = createFakeForge();
    const a = control.makeCommit();
    value(await forge.pushBranch({ branch: "story/2.9", expected_sha: null, sha: a }, live()));
    value(await forge.openPr({ branch: "story/2.9", base: "main", title: "T", body: "B" }, live()));
    control.refusePushes("story/2.9");
    const b = control.makeCommit();
    const r = await forge.pushBranch({ branch: "story/2.9", expected_sha: a, sha: b }, live());
    expect(r.ok ? "ok" : r.error.kind).toBe("rejected");
    const prs = value(await forge.listPrsByBranch("story/2.9", live()));
    expect(prs.map((p) => p.head_sha)).toEqual([a]);
    expect(value(await forge.pushBranch({ branch: "story/2.8", expected_sha: null, sha: b }, live()))).toEqual({ sha: b });
  });

  test("the queue merges head first, moves main and keeps the branch", async () => {
    const { forge, control } = createFakeForge();
    const open = async (branch: string) => {
      value(await forge.pushBranch({ branch, expected_sha: null, sha: control.makeCommit() }, live()));
      return value(await forge.openPr({ branch, base: "main", title: "t", body: "b" }, live()));
    };
    const a = await open("story/1.1");
    const b = await open("story/1.2");
    value(await forge.enqueue(b.number, b.head_sha, live()));
    value(await forge.enqueue(a.number, a.head_sha, live()));
    expect(control.queue()).toEqual([b.number, a.number]);
    const main0 = value(await forge.snapshot(live())).main.sha;
    const merged = control.mergeQueueHead();
    const main1 = value(await forge.snapshot(live())).main.sha;
    expect(merged).toEqual({ ...b, state: "merged", merge_sha: main1 });
    expect(main1).not.toBe(main0);
    expect(control.queue()).toEqual([a.number]);
    expect(control.mergeQueueHead()?.number).toBe(a.number);
    expect(control.mergeQueueHead()).toBeNull();
    // The merged PR's branch still exists: a lease on its head succeeds.
    value(await forge.pushBranch({ branch: "story/1.2", expected_sha: b.head_sha, sha: control.makeCommit() }, live()));
  });

  test("eject takes a queued PR out of the queue without merging it", async () => {
    const { forge, control } = createFakeForge();
    const sha = control.makeCommit();
    value(await forge.pushBranch({ branch: "story/1.4", expected_sha: null, sha }, live()));
    const pr = value(await forge.openPr({ branch: "story/1.4", base: "main", title: "t", body: "b" }, live()));
    expect(control.eject(pr.number)).toBe(false);
    value(await forge.enqueue(pr.number, sha, live()));
    const main0 = value(await forge.snapshot(live())).main.sha;
    expect(control.eject(pr.number)).toBe(true);
    expect(control.queue()).toEqual([]);
    expect(value(await forge.queueState(pr.number, live()))).toEqual({ state: "open", head_sha: sha, queued: false });
    expect(value(await forge.snapshot(live())).main.sha).toBe(main0);
    expect(control.eject(pr.number)).toBe(false);
  });

  test("a push to a queued PR's branch or closing it leaves the queue", async () => {
    const { forge, control } = createFakeForge();
    const sha = control.makeCommit();
    value(await forge.pushBranch({ branch: "story/1.3", expected_sha: null, sha }, live()));
    const pr = value(await forge.openPr({ branch: "story/1.3", base: "main", title: "t", body: "b" }, live()));
    value(await forge.enqueue(pr.number, sha, live()));
    value(await forge.pushBranch({ branch: "story/1.3", expected_sha: sha, sha: control.makeCommit() }, live()));
    expect(control.queue()).toEqual([]);
    const [now] = value(await forge.listPrsByBranch("story/1.3", live()));
    value(await forge.enqueue(pr.number, now?.head_sha as string, live()));
    value(await forge.closePr(pr.number, live()));
    expect(control.queue()).toEqual([]);
  });

  test("opening on a missing base is not-found", async () => {
    const { forge, control } = createFakeForge();
    value(await forge.pushBranch({ branch: "story/1.4", expected_sha: null, sha: control.makeCommit() }, live()));
    const r = await forge.openPr({ branch: "story/1.4", base: "nope", title: "t", body: "b" }, live());
    expect(r.ok ? "ok" : r.error.kind).toBe("not-found");
  });

  test("prefetch names files after checks and de-duplicates them", async () => {
    const { forge, control } = createFakeForge();
    const sha = "a".repeat(40);
    control.setChecks(sha, [
      { name: "ci / test (ubuntu)", status: "completed", conclusion: "failure" },
      { name: "ci / test [ubuntu]", status: "completed", conclusion: "cancelled" },
      { name: "skipped", status: "completed", conclusion: "skipped" },
      { name: "neutral", status: "completed", conclusion: "neutral" },
    ]);
    control.setCiLog(sha, "ci / test (ubuntu)", "boom\n");
    const dir = mkdtempSync(join(tmpdir(), "xarabot-fake-prefetch-"));
    try {
      const target = join(dir, "logs");
      const { files } = value(await forge.prefetch({ kind: "ci-log", sha, dir: target }, live()));
      expect(files).toEqual([join(target, "ci-test-ubuntu.log"), join(target, "ci-test-ubuntu-2.log")]);
      expect(readdirSync(target).sort()).toEqual(["ci-test-ubuntu-2.log", "ci-test-ubuntu.log"]);
      expect(await Bun.file(files[0] as string).text()).toBe("boom\n");
      expect(await Bun.file(files[1] as string).text()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prefetch de-duplicates names case-insensitively", async () => {
    const { forge, control } = createFakeForge();
    const sha = "c".repeat(40);
    control.setChecks(sha, [
      { name: "Test", status: "completed", conclusion: "failure" },
      { name: "test", status: "completed", conclusion: "failure" },
    ]);
    control.setCiLog(sha, "Test", "upper\n");
    control.setCiLog(sha, "test", "lower\n");
    const dir = mkdtempSync(join(tmpdir(), "xarabot-fake-prefetch-"));
    try {
      const { files } = value(await forge.prefetch({ kind: "ci-log", sha, dir }, live()));
      expect(files).toEqual([join(dir, "Test.log"), join(dir, "test-2.log")]);
      expect(await Bun.file(files[0] as string).text()).toBe("upper\n");
      expect(await Bun.file(files[1] as string).text()).toBe("lower\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("checks returns copies, so callers cannot change the forge's state", async () => {
    const { forge, control } = createFakeForge();
    const sha = "b".repeat(40);
    control.setChecks(sha, [{ name: "t", status: "queued", conclusion: null }]);
    const first = value(await forge.checks(sha, live()));
    (first.checks[0] as { status: string }).status = "completed";
    expect(value(await forge.checks(sha, live())).checks[0]?.status).toBe("queued");
  });
});

describe("fake forge inboxes (Story 4.2)", () => {
  test("issue numbers start apart from PR numbers; links use the repo URL", async () => {
    const { forge } = createFakeForge({ repoUrl: "https://github.com/o/r", firstIssueNumber: 50 });
    expect(value(await forge.openInbox("alice", live()))).toEqual({ number: 50, owner: "alice", body: "", url: "https://github.com/o/r/issues/50" });
  });

  test("an owner's inbox is the lowest-numbered open one, matched case-insensitively; a closed one is left out", async () => {
    const { forge, control } = createFakeForge();
    const first = value(await forge.openInbox("alice", live()));
    expect(value(await forge.openInbox("ALICE", live())).number).toBe(first.number);
    expect(control.closeInbox(first.number)).toBe(true);
    expect(control.closeInbox(4242)).toBe(false);
    const second = value(await forge.openInbox("alice", live()));
    expect(second.number).toBe(first.number + 1);
    expect(value(await forge.inboxes(live())).map((i) => i.number)).toEqual([second.number]);
    expect(control.inboxes().map((i) => [i.number, i.open])).toEqual([
      [first.number, false],
      [second.number, true],
    ]);
  });

  test("bodies and comments; an injected error changes nothing", async () => {
    const { forge, control } = createFakeForge();
    const inbox = value(await forge.openInbox("bob", live()));
    control.injectError("setInboxBody", { kind: "transient", message: "502" });
    expect((await forge.setInboxBody(inbox.number, "x", live())).ok).toBe(false);
    expect(value(await forge.setInboxBody(inbox.number, "y", live())).body).toBe("y");
    control.injectError("inboxComment", { kind: "transient", message: "502" });
    expect((await forge.inboxComment(inbox.number, "c1", live())).ok).toBe(false);
    value(await forge.inboxComment(inbox.number, "c2", live()));
    expect(control.inboxComments(inbox.number)).toEqual(["c2"]);
    expect(control.inboxComments(999)).toEqual([]);
  });
});

describe("fake forge readRulings (Story 4.5)", () => {
  test("open inboxes' comments, oldest first, with their author, time and link; the cursor is the last id; a closed inbox is skipped", async () => {
    const { forge, control } = createFakeForge({ now: "2026-10-26T09:00:00Z", repoUrl: "https://github.com/o/r" });
    const a = value(await forge.openInbox("alice", live())).number;
    const b = value(await forge.openInbox("bob", live())).number;
    const shut = value(await forge.openInbox("carol", live())).number;
    const c1 = control.addInboxComment(b, "edanisko", "/xarabot go retro:2");
    const posted = value(await forge.inboxComment(a, "🤖 digest", live())).id;
    control.setNow("2026-10-26T09:05:00Z");
    const c3 = control.addInboxComment(a, "alice", "thanks");
    control.addInboxComment(shut, "carol", "/xarabot dismiss story:1.1");
    control.closeInbox(shut);
    const r = value(await forge.readRulings(null, live()));
    expect(r.comments).toEqual([
      { id: c1, issue: b, author: "edanisko", body: "/xarabot go retro:2", created_at: "2026-10-26T09:00:00Z", url: `https://github.com/o/r/issues/${b}#issuecomment-${c1}` },
      { id: posted, issue: a, author: FAKE_BOT_LOGIN, body: "🤖 digest", created_at: "2026-10-26T09:00:00Z", url: `https://github.com/o/r/issues/${a}#issuecomment-${posted}` },
      { id: c3, issue: a, author: "alice", body: "thanks", created_at: "2026-10-26T09:05:00Z", url: `https://github.com/o/r/issues/${a}#issuecomment-${c3}` },
    ]);
    expect(r.cursor).toBe(c3);
    expect(control.inboxComments(a)).toEqual(["🤖 digest", "thanks"]);
    // From the cursor: only later comments, and with none the cursor stays.
    expect(value(await forge.readRulings(r.cursor, live()))).toEqual({ comments: [], cursor: c3 });
    const c4 = control.addInboxComment(b, "bob", "later");
    expect(value(await forge.readRulings(c1, live())).comments.map((c) => c.id)).toEqual([posted, c3, c4]);
  });

  test("a comment posted while readRulings reads the inboxes is left for the next read, on an inbox already read or one still to read", async () => {
    const { forge, control } = createFakeForge();
    const a = value(await forge.openInbox("alice", live())).number;
    const b = value(await forge.openInbox("bob", live())).number;
    control.addInboxComment(a, "carol", "A1");
    control.addInboxComment(b, "dave", "B1");
    control.addInboxCommentBeforeRead(b, a, "carol", "A2");
    control.addInboxCommentBeforeRead(b, b, "dave", "B2");
    const r1 = value(await forge.readRulings(null, live()));
    expect(r1.comments.map((c) => c.body)).toEqual(["A1", "B1"]);
    expect(control.inboxComments(a)).toEqual(["A1", "A2"]);
    const r2 = value(await forge.readRulings(r1.cursor, live()));
    expect(r2.comments.map((c) => c.body)).toEqual(["A2", "B2"]);
    // Each runs once.
    expect(value(await forge.readRulings(r2.cursor, live()))).toEqual({ comments: [], cursor: r2.cursor });
    expect(control.inboxComments(b)).toEqual(["B1", "B2"]);
    expect(() => control.addInboxCommentBeforeRead(b, 4242, "carol", "x")).toThrow("no issue #4242");
  });

  test("a non-numeric cursor, or one above every id issued, is rejected; addInboxComment needs an existing issue; an injected error changes nothing", async () => {
    const { forge, control } = createFakeForge();
    expect((await forge.readRulings("2026-01-01T00:00:00Z|5", live())).ok).toBe(false);
    const r = await forge.readRulings("abc", live());
    expect(r.ok ? "ok" : r.error.kind).toBe("rejected");
    // A numeric cursor at or above the next comment id was never issued.
    const above = await forge.readRulings("999999", live());
    expect(above.ok ? "ok" : above.error.kind).toBe("rejected");
    const inbox = value(await forge.openInbox("alice", live())).number;
    const id = control.addInboxComment(inbox, "alice", "hi");
    const next = await forge.readRulings(String(Number(id) + 1), live());
    expect(next.ok ? "ok" : next.error.kind).toBe("rejected");
    expect(value(await forge.readRulings(id, live()))).toEqual({ comments: [], cursor: id });
    expect(() => control.addInboxComment(4242, "alice", "x")).toThrow("no issue #4242");
    control.injectError("readRulings", { kind: "transient", message: "502" });
    expect((await forge.readRulings(null, live())).ok).toBe(false);
    expect(value(await forge.readRulings(null, live())).cursor).toBe(id);
  });
});
