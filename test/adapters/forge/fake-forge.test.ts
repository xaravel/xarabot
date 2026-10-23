import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeForge, gitBlobSha } from "../../../src/adapters/forge/fake/fake-forge.ts";
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

  test("protected branches refuse pushes", async () => {
    const { forge, control } = createFakeForge();
    for (const branch of ["main", "xarabot/claims"]) {
      const r = await forge.pushBranch({ branch, expected_sha: null, sha: control.makeCommit() }, live());
      expect(r.ok ? "ok" : r.error.kind).toBe("forbidden");
    }
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
    expect(control.mergeQueueHead()).toEqual({ ...b, state: "merged" });
    const main1 = value(await forge.snapshot(live())).main.sha;
    expect(main1).not.toBe(main0);
    expect(control.queue()).toEqual([a.number]);
    expect(control.mergeQueueHead()?.number).toBe(a.number);
    expect(control.mergeQueueHead()).toBeNull();
    // The merged PR's branch still exists: a lease on its head succeeds.
    value(await forge.pushBranch({ branch: "story/1.2", expected_sha: b.head_sha, sha: control.makeCommit() }, live()));
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
