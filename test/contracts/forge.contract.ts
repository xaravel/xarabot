import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { LedgerCommit } from "../../src/core/ledger/edits.ts";
import { serializeUnitRecord } from "../../src/core/ledger/codec.ts";
import { unitPath } from "../../src/core/schemas/ledger.ts";
import {
  FORGE_ERROR_KINDS,
  FORGE_OPERATIONS,
  type CallOpts,
  type Forge,
  type ForgeCheck,
  type ForgeError,
  type ForgeErrorKind,
  type ForgeOperation,
  type ForgePr,
  type ForgeResult,
  type ForgeReview,
  type GitSha,
} from "../../src/ports/forge.ts";
import { rec } from "../core/ledger/fixtures.ts";
import { runContract } from "./run-contract.ts";

/**
 * The `Forge` contract (AR33): every forge adapter passes it. A harness
 * supplies a fresh `Forge` per case plus whichever test controls it can
 * offer; a case needing a control the harness lacks is skipped, never passed.
 */

type MaybePromise<T> = T | Promise<T>;

/** Test controls a case may need. Names match the fake forge's `control`. */
export type ForgeContractControls = {
  /** A commit SHA the forge accepts in `pushBranch`. */
  makeCommit(): MaybePromise<GitSha>;
  setMain(files: Readonly<Record<string, string>>): MaybePromise<GitSha>;
  setNow(now: string): MaybePromise<void>;
  writeForeignLedger(commit: LedgerCommit): MaybePromise<GitSha>;
  setChecks(sha: GitSha, checks: readonly ForgeCheck[]): MaybePromise<void>;
  setCiLog(sha: GitSha, check: string, log: string): MaybePromise<void>;
  injectError(operation: ForgeOperation, error: ForgeError): MaybePromise<void>;
  /** Later pushes to `branch` are refused, as a repository rule refuses them. */
  refusePushes(branch: string): MaybePromise<void>;
  mergeQueueHead(): MaybePromise<ForgePr | null>;
  /** Appends a review to an existing PR, as its author submitting it would. */
  addReview(pr: number, review: ForgeReview): MaybePromise<void>;
  comments(pr: number): MaybePromise<string[]>;
  /** The bodies of the reviews `postReview` posted on PR `pr`, oldest first. */
  reviewBodies(pr: number): MaybePromise<string[]>;
  queue(): MaybePromise<number[]>;
  trace(): MaybePromise<string[]>;
};

export type ForgeControlName = keyof ForgeContractControls;

export type ForgeFixture = {
  readonly forge: Forge;
  readonly control: Partial<ForgeContractControls>;
  readonly cleanup?: () => MaybePromise<void>;
};

export type ForgeHarness = {
  readonly name: string;
  /** The controls every fixture from `make` carries; cases needing others skip. */
  readonly controls: readonly ForgeControlName[];
  readonly make: () => MaybePromise<ForgeFixture>;
  /** `false` skips every case (a live harness without its environment); default `true`. */
  readonly enabled?: boolean;
  /** The operations the forge implements; cases calling others skip. Default all. */
  readonly operations?: readonly ForgeOperation[];
};

const live = (): CallOpts => ({ signal: new AbortController().signal });
const aborted = (): CallOpts => ({ signal: AbortSignal.abort() });

function value<T>(r: ForgeResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.kind}: ${r.error.message}`);
  return r.value;
}

function kind<T>(r: ForgeResult<T>): ForgeErrorKind | "ok" {
  return r.ok ? "ok" : r.error.kind;
}

function need<K extends ForgeControlName>(fx: ForgeFixture, name: K): ForgeContractControls[K] {
  const c = fx.control[name];
  if (c === undefined) throw new Error(`harness declared control ${name} but the fixture lacks it`);
  return c as ForgeContractControls[K];
}

/** The git blob SHA-1 of `text`, computed independently of any adapter. */
function blobSha(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return new Bun.CryptoHasher("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** The operations `openOn` calls. */
const OPEN_PR: readonly ForgeOperation[] = ["pushBranch", "openPr"];
/** The operations a ledger case calls. */
const LEDGER: readonly ForgeOperation[] = ["snapshot", "ledgerSwap"];
const MISSING_PR = 999_999;

export function forgeContract(harness: ForgeHarness): void {
  const has = new Set(harness.controls);
  const offers = new Set<ForgeOperation>(harness.operations ?? FORGE_OPERATIONS);
  const enabled = harness.enabled ?? true;

  /** Pushes a fresh commit to `branch` and opens a PR on it. */
  async function openOn(fx: ForgeFixture, branch: string): Promise<ForgePr> {
    const sha = await need(fx, "makeCommit")();
    value(await fx.forge.pushBranch({ branch, expected_sha: null, sha }, live()));
    return value(await fx.forge.openPr({ branch, base: "main", title: `t ${branch}`, body: `b ${branch}` }, live()));
  }

  runContract<ForgeFixture>("Forge", [{ name: harness.name, make: harness.make }], (make) => {
    /**
     * One case: skipped unless the harness is enabled and offers every
     * operation in `uses` and every control in `controls`.
     */
    function scenario(
      name: string,
      uses: readonly ForgeOperation[],
      controls: readonly ForgeControlName[],
      body: (fx: ForgeFixture) => Promise<void>,
    ): void {
      const missing = [...uses.filter((op) => !offers.has(op)), ...controls.filter((c) => !has.has(c))];
      const reason = !enabled ? "harness disabled" : missing.length > 0 ? `needs ${missing.join(", ")}` : "";
      const label = reason === "" ? name : `${name} (${reason})`;
      test.skipIf(reason !== "")(label, async () => {
        const fx = await make();
        try {
          await body(fx);
        } finally {
          await fx.cleanup?.();
        }
      });
    }

    scenario("offers exactly the port's operations and no approve or merge", [], [], async (fx) => {
      for (const op of FORGE_OPERATIONS) expect(typeof fx.forge[op]).toBe("function");
      const extra = fx.forge as unknown as Record<string, unknown>;
      for (const banned of ["approve", "approvePr", "merge", "mergePr", "adminMerge", "autoMerge", "deleteBranch"]) {
        expect(extra[banned]).toBeUndefined();
      }
    });

    // ------------------------------------------------------------ snapshot

    scenario("snapshot returns 40-hex SHAs and a ledger shaped for assembleSnapshot", ["snapshot"], [], async (fx) => {
      const s = value(await fx.forge.snapshot(live()));
      expect(s.ledger.tip).toMatch(SHA);
      expect(s.main.sha).toMatch(SHA);
      expect(typeof s.now).toBe("string");
      expect(Number.isNaN(Date.parse(s.now))).toBe(false);
      expect(s.main.files).toEqual({});
    });

    scenario("snapshot reads ledger, then main, then prs", ["snapshot"], ["trace"], async (fx) => {
      value(await fx.forge.snapshot(live()));
      const trace = await need(fx, "trace")();
      expect(trace.filter((t) => ["ledger", "main", "prs"].includes(t))).toEqual(["ledger", "main", "prs"]);
    });

    scenario("snapshot now is the forge's server time", ["snapshot"], ["setNow"], async (fx) => {
      await need(fx, "setNow")("2026-10-22T10:00:00Z");
      expect(value(await fx.forge.snapshot(live())).now).toBe("2026-10-22T10:00:00Z");
    });

    scenario("snapshot lists main, blob SHAs and reads only the accepted paths", ["snapshot"], ["setMain"], async (fx) => {
      const sha = await need(fx, "setMain")({ "a.md": "hello\n", "dir/b.txt": "ünïcode", "c.md": "" });
      const s = value(await fx.forge.snapshot({ ...live(), read: (p) => p.endsWith(".md") }));
      expect(s.main.sha).toBe(sha);
      expect([...s.main.tree].sort()).toEqual(["a.md", "c.md", "dir/b.txt"]);
      expect(s.main.files).toEqual({ "a.md": "hello\n", "c.md": "" });
      expect(s.main.blob_shas).toEqual({
        "a.md": "ce013625030ba8dba906f756967f9e9ca394464a",
        "c.md": "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
        "dir/b.txt": blobSha("ünïcode"),
      });
    });

    scenario("snapshot reports PR state for each unit record with a pr", [...OPEN_PR, "snapshot", "ledgerSwap"], ["makeCommit"], async (fx) => {
      const pr = await openOn(fx, "story/1.5");
      const tip = value(await fx.forge.snapshot(live())).ledger.tip;
      const withPr = rec({ pr: pr.number, pr_owner: "alice", head_sha: pr.head_sha });
      const without = rec({ unit: "story:1.6", globs: ["src/core/next/**"] });
      value(
        await fx.forge.ledgerSwap(
          tip,
          {
            message: "claims [skip ci]",
            writes: { [unitPath("story:1.5")]: serializeUnitRecord(withPr), [unitPath("story:1.6")]: serializeUnitRecord(without) },
            deletes: [],
          },
          live(),
        ),
      );
      const s = value(await fx.forge.snapshot(live()));
      expect(s.prs).toEqual({ "story:1.5": { number: pr.number, state: "open", head_sha: pr.head_sha, reviews: [] } });
    });

    scenario(
      "snapshot carries each reviewer's latest decisive review of a unit's PR",
      [...OPEN_PR, "snapshot", "ledgerSwap"],
      ["makeCommit", "addReview"],
      async (fx) => {
        const pr = await openOn(fx, "story/1.7");
        const old = await need(fx, "makeCommit")();
        const list: ForgeReview[] = [
          { author: "alice", state: "approved", commit_sha: old, submitted_at: "2026-10-24T10:00:00Z" },
          { author: "bob", state: "changes_requested", commit_sha: pr.head_sha, submitted_at: "2026-10-24T10:05:00Z" },
          { author: "alice", state: "commented", commit_sha: pr.head_sha, submitted_at: "2026-10-24T10:10:00Z" },
          { author: "carol", state: "approved", commit_sha: pr.head_sha, submitted_at: "2026-10-24T10:12:00Z" },
          { author: "Alice", state: "approved", commit_sha: pr.head_sha, submitted_at: "2026-10-24T10:15:00Z" },
          { author: "carol", state: "dismissed", commit_sha: pr.head_sha, submitted_at: "2026-10-24T10:20:00Z" },
          { author: "dave", state: "pending", commit_sha: pr.head_sha, submitted_at: null },
        ];
        for (const r of list) await need(fx, "addReview")(pr.number, r);
        const tip = value(await fx.forge.snapshot(live())).ledger.tip;
        const withPr = rec({ unit: "story:1.7", pr: pr.number, pr_owner: "alice", head_sha: pr.head_sha });
        value(await fx.forge.ledgerSwap(tip, { message: "claims [skip ci]", writes: { [unitPath("story:1.7")]: serializeUnitRecord(withPr) }, deletes: [] }, live()));
        expect(value(await fx.forge.snapshot(live())).prs).toEqual({
          "story:1.7": {
            number: pr.number,
            state: "open",
            head_sha: pr.head_sha,
            reviews: [
              { author: "bob", state: "changes_requested", commit_sha: pr.head_sha, submitted_at: "2026-10-24T10:05:00Z" },
              { author: "Alice", state: "approved", commit_sha: pr.head_sha, submitted_at: "2026-10-24T10:15:00Z" },
              { author: "carol", state: "dismissed", commit_sha: pr.head_sha, submitted_at: "2026-10-24T10:20:00Z" },
            ],
          },
        });
      },
    );

    scenario(
      "snapshot reports merged and closed PR states",
      [...OPEN_PR, "enqueue", "closePr", "snapshot", "ledgerSwap"],
      ["makeCommit", "mergeQueueHead"],
      async (fx) => {
      const merged = await openOn(fx, "story/1.8");
      value(await fx.forge.enqueue(merged.number, merged.head_sha, live()));
      expect((await need(fx, "mergeQueueHead")())?.number).toBe(merged.number);
      const closed = await openOn(fx, "story/1.9");
      value(await fx.forge.closePr(closed.number, live()));
      const tip = value(await fx.forge.snapshot(live())).ledger.tip;
      const a = rec({ unit: "story:1.8", globs: ["src/a/**"], pr: merged.number, pr_owner: "alice", head_sha: merged.head_sha });
      const b = rec({ unit: "story:1.9", globs: ["src/b/**"], pr: closed.number, pr_owner: "alice", head_sha: closed.head_sha });
      value(
        await fx.forge.ledgerSwap(
          tip,
          {
            message: "claims [skip ci]",
            writes: { [unitPath("story:1.8")]: serializeUnitRecord(a), [unitPath("story:1.9")]: serializeUnitRecord(b) },
            deletes: [],
          },
          live(),
        ),
      );
      expect(value(await fx.forge.snapshot(live())).prs).toEqual({
        "story:1.8": { number: merged.number, state: "merged", head_sha: merged.head_sha, reviews: [] },
        "story:1.9": { number: closed.number, state: "closed", head_sha: closed.head_sha, reviews: [] },
      });
      },
    );

    // ------------------------------------------------------------ ledgerSwap

    scenario("a swap applies writes and deletes in one new commit", LEDGER, [], async (fx) => {
      const t0 = value(await fx.forge.snapshot(live())).ledger;
      const t1 = value(await fx.forge.ledgerSwap(t0.tip, { message: "one [skip ci]", writes: { "units/a.json": "{}", "units/b.json": "{}" }, deletes: [] }, live()));
      expect(t1.tip).toMatch(SHA);
      expect(t1.tip).not.toBe(t0.tip);
      const t2 = value(
        await fx.forge.ledgerSwap(t1.tip, { message: "two [skip ci]", writes: { "units/c.json": "{\"c\":1}" }, deletes: ["units/a.json"] }, live()),
      );
      const s = value(await fx.forge.snapshot(live())).ledger;
      expect(s.tip).toBe(t2.tip);
      expect(s.files).toEqual({ ...t0.files, "units/b.json": "{}", "units/c.json": "{\"c\":1}" });
    });

    scenario("a stale swap conflicts and leaves the tip alone", LEDGER, [], async (fx) => {
      const t0 = value(await fx.forge.snapshot(live())).ledger.tip;
      const t1 = value(await fx.forge.ledgerSwap(t0, { message: "m", writes: { "units/x.json": "1" }, deletes: [] }, live())).tip;
      const stale = await fx.forge.ledgerSwap(t0, { message: "m", writes: { "units/y.json": "2" }, deletes: [] }, live());
      expect(kind(stale)).toBe("conflict");
      const s = value(await fx.forge.snapshot(live())).ledger;
      expect(s.tip).toBe(t1);
      expect(s.files["units/y.json"]).toBeUndefined();
    });

    scenario("of 8 racing swaps from one tip exactly one wins", LEDGER, [], async (fx) => {
      const t0 = value(await fx.forge.snapshot(live())).ledger;
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          fx.forge.ledgerSwap(t0.tip, { message: `race ${i}`, writes: { [`units/r${i}.json`]: String(i) }, deletes: [] }, live()),
        ),
      );
      const kinds = results.map(kind);
      expect(kinds.filter((k) => k === "ok")).toHaveLength(1);
      expect(kinds.filter((k) => k === "conflict")).toHaveLength(7);
      const winner = results.findIndex((r) => r.ok);
      const s = value(await fx.forge.snapshot(live())).ledger;
      expect(s.tip).toBe(value(results[winner] as ForgeResult<{ tip: string }>).tip);
      expect(s.files).toEqual({ ...t0.files, [`units/r${winner}.json`]: String(winner) });
    });

    scenario("a foreign ledger commit makes a swap from the old tip conflict", LEDGER, ["writeForeignLedger"], async (fx) => {
      const t0 = value(await fx.forge.snapshot(live())).ledger.tip;
      const t1 = await need(fx, "writeForeignLedger")({ message: "bob [skip ci]", writes: { "units/bob.json": "{}" }, deletes: [] });
      expect(kind(await fx.forge.ledgerSwap(t0, { message: "m", writes: {}, deletes: [] }, live()))).toBe("conflict");
      expect(value(await fx.forge.snapshot(live())).ledger.tip).toBe(t1);
    });

    // ------------------------------------------------------------ deadline

    // Calls only the operations the harness offers (the GitHub adapter's stubs are checked in its own tests).
    scenario("every operation with an aborted signal returns transient", [], [], async (fx) => {
      const f = fx.forge;
      const sha = "a".repeat(40);
      const calls: Readonly<Record<ForgeOperation, () => Promise<ForgeResult<unknown>>>> = {
        snapshot: () => f.snapshot(aborted()),
        ledgerSwap: () => f.ledgerSwap(sha, { message: "m", writes: {}, deletes: [] }, aborted()),
        pushBranch: () => f.pushBranch({ branch: "story/9.9", expected_sha: null, sha }, aborted()),
        branchHead: () => f.branchHead("story/9.9", aborted()),
        openPr: () => f.openPr({ branch: "story/9.9", base: "main", title: "t", body: "b" }, aborted()),
        updatePr: () => f.updatePr(1, { title: "t" }, aborted()),
        closePr: () => f.closePr(1, aborted()),
        listPrsByBranch: () => f.listPrsByBranch("story/9.9", aborted()),
        reviews: () => f.reviews(1, aborted()),
        comment: () => f.comment(1, "b", aborted()),
        postReview: () => f.postReview(1, { commit_sha: sha, body: "b" }, aborted()),
        checks: () => f.checks(sha, aborted()),
        enqueue: () => f.enqueue(1, sha, aborted()),
        dequeue: () => f.dequeue(1, aborted()),
        queueState: () => f.queueState(1, aborted()),
        alert: () => f.alert("c", sha, aborted()),
        prefetch: () => f.prefetch({ kind: "ci-log", sha, dir: join(tmpdir(), "xarabot-never") }, aborted()),
      };
      for (const op of FORGE_OPERATIONS.filter((o) => offers.has(o))) expect([op, kind(await calls[op]())]).toEqual([op, "transient"]);
    });

    scenario("an aborted swap changes nothing", LEDGER, [], async (fx) => {
      const f = fx.forge;
      const t0 = value(await f.snapshot(live())).ledger.tip;
      expect(kind(await f.ledgerSwap(t0, { message: "m", writes: { "units/z.json": "1" }, deletes: [] }, aborted()))).toBe("transient");
      expect(value(await f.snapshot(live())).ledger.tip).toBe(t0);
    });

    scenario(
      "aborted push, PR and alert calls change nothing",
      ["pushBranch", "openPr", "listPrsByBranch", "updatePr", "closePr", "alert"],
      ["makeCommit"],
      async (fx) => {
      const f = fx.forge;
      const sha = await need(fx, "makeCommit")();
      expect(kind(await f.pushBranch({ branch: "story/8.1", expected_sha: null, sha }, aborted()))).toBe("transient");
      value(await f.pushBranch({ branch: "story/8.1", expected_sha: null, sha }, live()));
      expect(kind(await f.openPr({ branch: "story/8.1", base: "main", title: "t", body: "b" }, aborted()))).toBe("transient");
      expect(value(await f.listPrsByBranch("story/8.1", live()))).toEqual([]);

      const pr = value(await f.openPr({ branch: "story/8.1", base: "main", title: "t", body: "b" }, live()));
      expect(kind(await f.updatePr(pr.number, { title: "new" }, aborted()))).toBe("transient");
      expect(kind(await f.closePr(pr.number, aborted()))).toBe("transient");
      expect(value(await f.listPrsByBranch("story/8.1", live()))).toEqual([pr]);

      expect(kind(await f.alert("cond", sha, aborted()))).toBe("transient");
      expect(value(await f.alert("cond", sha, live()))).toEqual({ posted: true });
      },
    );

    scenario("a signal aborting mid-call returns transient and changes nothing", LEDGER, [], async (fx) => {
      const t0 = value(await fx.forge.snapshot(live())).ledger.tip;
      const ac = new AbortController();
      const pending = fx.forge.ledgerSwap(t0, { message: "m", writes: { "units/z.json": "1" }, deletes: [] }, { signal: ac.signal });
      ac.abort();
      expect(kind(await pending)).toBe("transient");
      expect(value(await fx.forge.snapshot(live())).ledger.tip).toBe(t0);
    });

    scenario(
      "aborted comment and enqueue leave no comment and no queue entry",
      [...OPEN_PR, "comment", "enqueue"],
      ["makeCommit", "comments", "queue"],
      async (fx) => {
      const pr = await openOn(fx, "story/8.2");
      expect(kind(await fx.forge.comment(pr.number, "x", aborted()))).toBe("transient");
      expect(await need(fx, "comments")(pr.number)).toEqual([]);
      expect(kind(await fx.forge.enqueue(pr.number, pr.head_sha, aborted()))).toBe("transient");
      expect(await need(fx, "queue")()).toEqual([]);
      },
    );

    // ------------------------------------------------------------ errors

    scenario("an injected error of each kind comes back as that kind, once", ["checks"], ["injectError"], async (fx) => {
      const inject = need(fx, "injectError");
      for (const k of FORGE_ERROR_KINDS) {
        const error: ForgeError = k === "rate-limited" ? { kind: k, message: "slow down", retry_after: 7 } : { kind: k, message: `injected ${k}` };
        await inject("checks", error);
        const r = await fx.forge.checks("a".repeat(40), live());
        expect(r).toEqual({ ok: false, error });
        expect(kind(await fx.forge.checks("a".repeat(40), live()))).toBe("ok");
      }
    });

    scenario("an injected swap error changes nothing", LEDGER, ["injectError"], async (fx) => {
      const t0 = value(await fx.forge.snapshot(live())).ledger.tip;
      await need(fx, "injectError")("ledgerSwap", { kind: "auth", message: "bad token" });
      expect(kind(await fx.forge.ledgerSwap(t0, { message: "m", writes: { "units/a.json": "1" }, deletes: [] }, live()))).toBe("auth");
      expect(value(await fx.forge.snapshot(live())).ledger.tip).toBe(t0);
    });

    // ------------------------------------------------------------ pushBranch

    scenario("a push lease creates, conflicts on a wrong head, and moves on the right one", ["pushBranch"], ["makeCommit"], async (fx) => {
      const mk = need(fx, "makeCommit");
      const [a, b, c] = [await mk(), await mk(), await mk()];
      expect(value(await fx.forge.pushBranch({ branch: "story/2.1", expected_sha: null, sha: a }, live()))).toEqual({ sha: a });
      expect(kind(await fx.forge.pushBranch({ branch: "story/2.1", expected_sha: null, sha: b }, live()))).toBe("conflict");
      expect(kind(await fx.forge.pushBranch({ branch: "story/2.1", expected_sha: c, sha: b }, live()))).toBe("conflict");
      expect(kind(await fx.forge.pushBranch({ branch: "story/2.2", expected_sha: a, sha: b }, live()))).toBe("conflict");
      expect(value(await fx.forge.pushBranch({ branch: "story/2.1", expected_sha: a, sha: b }, live()))).toEqual({ sha: b });
    });

    // ------------------------------------------------------------ branchHead

    scenario("branchHead of an unknown branch is null", ["branchHead", "pushBranch"], [], async (fx) => {
      expect(value(await fx.forge.branchHead("story/7.7", live()))).toBeNull();
    });

    scenario("branchHead after a push is the pushed SHA, and follows the next push", ["branchHead", "pushBranch"], ["makeCommit"], async (fx) => {
      const mk = need(fx, "makeCommit");
      const [a, b] = [await mk(), await mk()];
      value(await fx.forge.pushBranch({ branch: "story/7.8", expected_sha: null, sha: a }, live()));
      expect(value(await fx.forge.branchHead("story/7.8", live()))).toBe(a);
      value(await fx.forge.pushBranch({ branch: "story/7.8", expected_sha: a, sha: b }, live()));
      expect(value(await fx.forge.branchHead("story/7.8", live()))).toBe(b);
      expect(value(await fx.forge.branchHead("story/7.9", live()))).toBeNull();
    });

    scenario("branchHead with an aborted signal is transient", ["branchHead"], [], async (fx) => {
      expect(kind(await fx.forge.branchHead("story/7.7", aborted()))).toBe("transient");
    });

    scenario("a push a rule refuses is rejected and moves nothing", OPEN_PR, ["makeCommit", "refusePushes"], async (fx) => {
      const mk = need(fx, "makeCommit");
      await need(fx, "refusePushes")("story/2.9");
      const [a, b] = [await mk(), await mk()];
      expect(kind(await fx.forge.pushBranch({ branch: "story/2.9", expected_sha: null, sha: a }, live()))).toBe("rejected");
      expect(kind(await fx.forge.openPr({ branch: "story/2.9", base: "main", title: "T", body: "B" }, live()))).toBe("not-found");
      expect(value(await fx.forge.pushBranch({ branch: "story/2.8", expected_sha: null, sha: b }, live()))).toEqual({ sha: b });
    });

    // ------------------------------------------------------------ PRs

    scenario("opening a PR on a missing branch is not-found", ["openPr"], [], async (fx) => {
      expect(kind(await fx.forge.openPr({ branch: "story/404", base: "main", title: "t", body: "b" }, live()))).toBe("not-found");
    });

    scenario("a PR opens on the branch head; a second open PR conflicts", OPEN_PR, ["makeCommit"], async (fx) => {
      const sha = await need(fx, "makeCommit")();
      value(await fx.forge.pushBranch({ branch: "story/3.1", expected_sha: null, sha }, live()));
      const pr = value(await fx.forge.openPr({ branch: "story/3.1", base: "main", title: "T", body: "B" }, live()));
      expect(pr).toEqual({ number: pr.number, branch: "story/3.1", base: "main", state: "open", head_sha: sha, title: "T", body: "B", merge_sha: null });
      expect(kind(await fx.forge.openPr({ branch: "story/3.1", base: "main", title: "T2", body: "B2" }, live()))).toBe("conflict");
    });

    scenario(
      "a merged PR carries the merge SHA main moved to; an open or closed one carries null",
      [...OPEN_PR, "enqueue", "listPrsByBranch", "closePr", "snapshot"],
      ["makeCommit", "mergeQueueHead"],
      async (fx) => {
        const f = fx.forge;
        const merged = await openOn(fx, "story/3.9");
        const closed = await openOn(fx, "story/3.10");
        value(await f.closePr(closed.number, live()));
        value(await f.enqueue(merged.number, merged.head_sha, live()));
        const done = await need(fx, "mergeQueueHead")();
        const main = value(await f.snapshot(live())).main.sha;
        expect(done?.merge_sha).toBe(main);
        const [listed] = value(await f.listPrsByBranch("story/3.9", live()));
        expect([listed?.state, listed?.merge_sha]).toEqual(["merged", main]);
        expect(value(await f.listPrsByBranch("story/3.10", live())).map((p) => [p.state, p.merge_sha])).toEqual([["closed", null]]);
        const open = await openOn(fx, "story/3.11");
        expect(open.merge_sha).toBeNull();
      },
    );

    scenario("a push moves an open PR's head", [...OPEN_PR, "listPrsByBranch"], ["makeCommit"], async (fx) => {
      const pr = await openOn(fx, "story/3.2");
      const next = await need(fx, "makeCommit")();
      value(await fx.forge.pushBranch({ branch: "story/3.2", expected_sha: pr.head_sha, sha: next }, live()));
      const [listed] = value(await fx.forge.listPrsByBranch("story/3.2", live()));
      expect(listed?.head_sha).toBe(next);
    });

    scenario("update and close change a PR; missing PRs are not-found", [...OPEN_PR, "updatePr", "closePr"], ["makeCommit"], async (fx) => {
      const pr = await openOn(fx, "story/3.3");
      expect(value(await fx.forge.updatePr(pr.number, { title: "new" }, live()))).toEqual({ ...pr, title: "new" });
      expect(value(await fx.forge.updatePr(pr.number, { body: "nb" }, live()))).toEqual({ ...pr, title: "new", body: "nb" });
      expect(value(await fx.forge.closePr(pr.number, live()))).toEqual({ ...pr, title: "new", body: "nb", state: "closed" });
      expect(kind(await fx.forge.updatePr(MISSING_PR, { title: "x" }, live()))).toBe("not-found");
      expect(kind(await fx.forge.closePr(MISSING_PR, live()))).toBe("not-found");
    });

    scenario(
      "listPrsByBranch returns every PR on the branch in any state, ascending",
      [...OPEN_PR, "closePr", "listPrsByBranch"],
      ["makeCommit"],
      async (fx) => {
      const first = await openOn(fx, "story/3.4");
      value(await fx.forge.closePr(first.number, live()));
      const second = value(await fx.forge.openPr({ branch: "story/3.4", base: "main", title: "again", body: "b" }, live()));
      await openOn(fx, "story/3.5");
      const listed = value(await fx.forge.listPrsByBranch("story/3.4", live()));
      expect(listed.map((p) => [p.number, p.state])).toEqual([
        [first.number, "closed"],
        [second.number, "open"],
      ]);
      expect(second.number).toBeGreaterThan(first.number);
      expect(value(await fx.forge.listPrsByBranch("story/none", live()))).toEqual([]);
      },
    );

    scenario(
      "updating or closing a merged PR conflicts",
      [...OPEN_PR, "enqueue", "updatePr", "closePr", "listPrsByBranch"],
      ["makeCommit", "mergeQueueHead"],
      async (fx) => {
      const pr = await openOn(fx, "story/3.6");
      value(await fx.forge.enqueue(pr.number, pr.head_sha, live()));
      expect((await need(fx, "mergeQueueHead")())?.number).toBe(pr.number);
      expect(kind(await fx.forge.updatePr(pr.number, { title: "x" }, live()))).toBe("conflict");
      expect(kind(await fx.forge.closePr(pr.number, live()))).toBe("conflict");
      const [listed] = value(await fx.forge.listPrsByBranch("story/3.6", live()));
      expect(listed?.state).toBe("merged");
      },
    );

    // ------------------------------------------------------------ reviews

    scenario("reviews of a PR with none is empty; a missing PR is not-found", [...OPEN_PR, "reviews"], ["makeCommit"], async (fx) => {
      const pr = await openOn(fx, "story/3.7");
      expect(value(await fx.forge.reviews(pr.number, live()))).toEqual([]);
      expect(kind(await fx.forge.reviews(MISSING_PR, live()))).toBe("not-found");
    });

    scenario(
      "reviews returns each review's author, state, commit SHA and submitted time, in order",
      [...OPEN_PR, "reviews"],
      ["makeCommit", "addReview"],
      async (fx) => {
        const pr = await openOn(fx, "story/3.8");
        const old = await need(fx, "makeCommit")();
        const list: ForgeReview[] = [
          { author: "alice", state: "changes_requested", commit_sha: old, submitted_at: "2026-10-24T10:00:00Z" },
          { author: "bob", state: "commented", commit_sha: pr.head_sha, submitted_at: "2026-10-24T10:05:00Z" },
          { author: "alice", state: "approved", commit_sha: pr.head_sha, submitted_at: "2026-10-24T10:10:00Z" },
          { author: "carol", state: "dismissed", commit_sha: pr.head_sha, submitted_at: "2026-10-24T10:15:00Z" },
          { author: "dave", state: "pending", commit_sha: pr.head_sha, submitted_at: null },
        ];
        for (const r of list) await need(fx, "addReview")(pr.number, r);
        expect(value(await fx.forge.reviews(pr.number, live()))).toEqual(list);
      },
    );

    // ------------------------------------------------------------ comment

    scenario("a comment posts its body verbatim; a missing PR is not-found", [...OPEN_PR, "comment"], ["makeCommit", "comments"], async (fx) => {
      const pr = await openOn(fx, "story/4.1");
      const posted = value(await fx.forge.comment(pr.number, "🤖 hi", live()));
      expect(typeof posted.id).toBe("string");
      expect(await need(fx, "comments")(pr.number)).toEqual(["🤖 hi"]);
      expect(kind(await fx.forge.comment(MISSING_PR, "🤖 hi", live()))).toBe("not-found");
    });

    // ------------------------------------------------------------ postReview

    scenario(
      "a review posts its body verbatim as one commented review at commit_sha; a missing PR is not-found",
      [...OPEN_PR, "postReview", "reviews"],
      ["makeCommit", "reviewBodies"],
      async (fx) => {
        const pr = await openOn(fx, "story/4.2");
        const body = "🤖 Story 4.2: cross-vendor review\n\nVerdict: pass.\n\nFindings: none.\n@nobody";
        const posted = value(await fx.forge.postReview(pr.number, { commit_sha: pr.head_sha, body }, live()));
        expect(typeof posted.id).toBe("string");
        expect(await need(fx, "reviewBodies")(pr.number)).toEqual([body]);
        const list = value(await fx.forge.reviews(pr.number, live()));
        expect(list).toHaveLength(1);
        const [review] = list;
        expect([review?.state, review?.commit_sha]).toEqual(["commented", pr.head_sha]);
        expect(typeof review?.author).toBe("string");
        expect(typeof review?.submitted_at).toBe("string");
        expect(kind(await fx.forge.postReview(MISSING_PR, { commit_sha: pr.head_sha, body }, live()))).toBe("not-found");
      },
    );

    scenario("an aborted review posts nothing", [...OPEN_PR, "postReview", "reviews"], ["makeCommit", "reviewBodies"], async (fx) => {
      const pr = await openOn(fx, "story/4.3");
      expect(kind(await fx.forge.postReview(pr.number, { commit_sha: pr.head_sha, body: "x" }, aborted()))).toBe("transient");
      expect(await need(fx, "reviewBodies")(pr.number)).toEqual([]);
      expect(value(await fx.forge.reviews(pr.number, live()))).toEqual([]);
    });

    // ------------------------------------------------------------ checks

    scenario("checks are empty while pending and report what CI set", ["checks"], ["setChecks"], async (fx) => {
      const sha = "c".repeat(40);
      expect(value(await fx.forge.checks(sha, live()))).toEqual({ checks: [] });
      const list: ForgeCheck[] = [
        { name: "test", status: "completed", conclusion: "success" },
        { name: "lint", status: "in_progress", conclusion: null },
      ];
      await need(fx, "setChecks")(sha, list);
      expect(value(await fx.forge.checks(sha, live()))).toEqual({ checks: list });
    });

    // ------------------------------------------------------------ queue

    scenario("enqueue with a wrong head conflicts", [...OPEN_PR, "enqueue"], ["makeCommit"], async (fx) => {
      const pr = await openOn(fx, "story/5.1");
      const wrong = await need(fx, "makeCommit")();
      expect(kind(await fx.forge.enqueue(pr.number, wrong, live()))).toBe("conflict");
      expect(kind(await fx.forge.enqueue(MISSING_PR, wrong, live()))).toBe("not-found");
    });

    scenario(
      "enqueue and dequeue are idempotent and only queue open PRs at the expected head",
      [...OPEN_PR, "enqueue", "dequeue", "closePr"],
      ["makeCommit", "queue"],
      async (fx) => {
      const pr = await openOn(fx, "story/5.2");
      const queue = need(fx, "queue");
      expect(kind(await fx.forge.enqueue(pr.number, "f".repeat(40), live()))).toBe("conflict");
      expect(await queue()).toEqual([]);
      expect(value(await fx.forge.enqueue(pr.number, pr.head_sha, live()))).toEqual({ queued: true });
      expect(value(await fx.forge.enqueue(pr.number, pr.head_sha, live()))).toEqual({ queued: true });
      expect(await queue()).toEqual([pr.number]);
      expect(value(await fx.forge.dequeue(pr.number, live()))).toEqual({ queued: false });
      expect(value(await fx.forge.dequeue(pr.number, live()))).toEqual({ queued: false });
      expect(await queue()).toEqual([]);
      value(await fx.forge.closePr(pr.number, live()));
      expect(kind(await fx.forge.enqueue(pr.number, pr.head_sha, live()))).toBe("conflict");
      expect(await queue()).toEqual([]);
      },
    );

    scenario(
      "queueState reports open, queued, dequeued, closed and merged; a missing PR is not-found",
      [...OPEN_PR, "enqueue", "dequeue", "closePr", "queueState"],
      ["makeCommit", "mergeQueueHead"],
      async (fx) => {
        const f = fx.forge;
        const a = await openOn(fx, "story/5.3");
        expect(value(await f.queueState(a.number, live()))).toEqual({ state: "open", head_sha: a.head_sha, queued: false });
        value(await f.enqueue(a.number, a.head_sha, live()));
        expect(value(await f.queueState(a.number, live()))).toEqual({ state: "open", head_sha: a.head_sha, queued: true });
        value(await f.dequeue(a.number, live()));
        expect(value(await f.queueState(a.number, live()))).toEqual({ state: "open", head_sha: a.head_sha, queued: false });
        value(await f.closePr(a.number, live()));
        expect(value(await f.queueState(a.number, live()))).toEqual({ state: "closed", head_sha: a.head_sha, queued: false });
        const b = await openOn(fx, "story/5.4");
        value(await f.enqueue(b.number, b.head_sha, live()));
        expect((await need(fx, "mergeQueueHead")())?.number).toBe(b.number);
        expect(value(await f.queueState(b.number, live()))).toEqual({ state: "merged", head_sha: b.head_sha, queued: false });
        expect(kind(await f.queueState(MISSING_PR, live()))).toBe("not-found");
      },
    );

    // ------------------------------------------------------------ alert

    scenario("an alert posts once per condition and main SHA", ["alert"], [], async (fx) => {
      const [a, b] = ["a".repeat(40), "b".repeat(40)];
      expect(value(await fx.forge.alert("forge-auth", a, live()))).toEqual({ posted: true });
      expect(value(await fx.forge.alert("forge-auth", a, live()))).toEqual({ posted: false });
      expect(value(await fx.forge.alert("forge-auth", b, live()))).toEqual({ posted: true });
      expect(value(await fx.forge.alert("other", a, live()))).toEqual({ posted: true });
    });

    // ------------------------------------------------------------ prefetch

    scenario("prefetch writes one log file per failing check, at absolute paths", ["prefetch"], ["setChecks", "setCiLog"], async (fx) => {
      const sha = "d".repeat(40);
      await need(fx, "setChecks")(sha, [
        { name: "test", status: "completed", conclusion: "failure" },
        { name: "lint", status: "completed", conclusion: "success" },
        { name: "types", status: "completed", conclusion: "timed_out" },
        { name: "slow", status: "in_progress", conclusion: null },
      ]);
      await need(fx, "setCiLog")(sha, "test", "1 failing\n");
      await need(fx, "setCiLog")(sha, "types", "tsc died\n");
      const dir = mkdtempSync(join(tmpdir(), "xarabot-prefetch-"));
      try {
        const { files } = value(await fx.forge.prefetch({ kind: "ci-log", sha, dir }, live()));
        expect(files).toHaveLength(2);
        for (const f of files) {
          expect(isAbsolute(f)).toBe(true);
          expect(f.startsWith(dir)).toBe(true);
        }
        expect(files.map((f) => readFileSync(f, "utf8")).sort()).toEqual(["1 failing\n", "tsc died\n"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    scenario("prefetch with no failing checks writes nothing", ["prefetch"], [], async (fx) => {
      const dir = mkdtempSync(join(tmpdir(), "xarabot-prefetch-"));
      try {
        expect(value(await fx.forge.prefetch({ kind: "ci-log", sha: "e".repeat(40), dir }, live()))).toEqual({ files: [] });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
