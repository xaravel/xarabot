import { describe, expect, test } from "bun:test";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { judgeRulings, type JudgedRuling } from "../../src/core/rulings/effects.ts";
import type { Forge, InboxComment } from "../../src/ports/forge.ts";
import { answerRulings, type AnswerRulingsParams } from "../../src/lane/rulings-step.ts";
import { snapshotOf, storyRec } from "../core/next/fixtures.ts";

const live = () => ({ signal: new AbortController().signal });

/** Epic 2's retro is rejected with no go; the Maintainer is edanisko. */
const SNAPSHOT = snapshotOf({ epics: { 1: [], 2: ["1"] }, bootstrapped: [1], retro: { 2: "rejected" } });

/** The fake forge with each rulings call recorded in order. */
function spied(fake: FakeForge, events: string[]): Forge {
  const f = fake.forge;
  return {
    ...f,
    readRulings: (c, o) => (events.push(`readRulings ${c ?? "null"}`), f.readRulings(c, o)),
    inboxComment: (n, b, o) => (events.push(`inboxComment #${n}`), f.inboxComment(n, b, o)),
    closePr: (n, o) => (events.push(`closePr #${n}`), f.closePr(n, o)),
  };
}

type World = { fake: FakeForge; events: string[]; logs: string[]; inbox: number; swapped: (readonly JudgedRuling<InboxComment>[])[] };

async function world(): Promise<World> {
  const fake = createFakeForge();
  const opened = await fake.forge.openInbox("edanisko", live());
  if (!opened.ok) throw new Error(opened.error.message);
  return { fake, events: [], logs: [], inbox: opened.value.number, swapped: [] };
}

async function answer(w: World, cursor: string | null, over: Partial<AnswerRulingsParams> & { landed?: boolean; snapshot?: typeof SNAPSHOT } = {}) {
  const { landed = true, snapshot = SNAPSHOT, ...rest } = over;
  return answerRulings({
    forge: spied(w.fake, w.events),
    cursor,
    judge: (cs) => judgeRulings(snapshot, cs).judged,
    commit: async (from, to, judged) => {
      w.events.push(`advance ${from ?? "null"} → ${to}`);
      w.swapped.push(judged);
      return landed;
    },
    log: (l) => w.logs.push(l),
    signal: new AbortController().signal,
    ...rest,
  });
}

const reply = (w: World, id: string, rest: string) => `🤖 Ruling ${rest.replace("<url>", `https://github.com/fake/repo/issues/${w.inbox}#issuecomment-${id}`)}`;

describe("answerRulings", () => {
  test("advances the cursor first, then answers each ruling once on its own inbox; comments that are not rulings get no reply", async () => {
    const w = await world();
    const go = w.fake.control.addInboxComment(w.inbox, "edanisko", "/xarabot go retro:2");
    w.fake.control.addInboxComment(w.inbox, "alice", "thanks");
    const bob = w.fake.control.addInboxComment(w.inbox, "bob", "/xarabot go retro:2");
    const bad = w.fake.control.addInboxComment(w.inbox, "edanisko", "/xarabot frob story:1.1");
    w.fake.control.addInboxComment(w.inbox, "alice", "> /xarabot go retro:2");
    const out = await answer(w, null);
    expect(out).toMatchObject({ read: 5, advanced: true, answered: [go, bob, bad] });
    expect(w.events).toEqual(["readRulings null", `advance null → ${Number(bad) + 1}`, `inboxComment #${w.inbox}`, `inboxComment #${w.inbox}`, `inboxComment #${w.inbox}`]);
    const posted = w.fake.control.inboxComments(w.inbox).slice(5);
    expect(posted).toEqual([
      reply(w, go, "acknowledged: `/xarabot go retro:2` from edanisko ([comment](<url>))."),
      reply(w, bob, "not applied ([comment](<url>)): only the Maintainer (edanisko) may rule `go`. Nothing changed."),
      reply(w, bad, "not applied ([comment](<url>)): `frob` is not a verb (go, approve, block, unblock, done, defer, rebuild, release, dismiss). Nothing changed."),
    ]);
    for (const text of posted) expect(text).not.toContain("@");
  });

  test("comments that are not rulings: the cursor still advances, with no reply", async () => {
    const w = await world();
    w.fake.control.addInboxComment(w.inbox, "alice", "thanks");
    const ack = w.fake.control.addInboxComment(w.inbox, "edanisko", "🤖 Ruling acknowledged: `/xarabot go retro:2` from edanisko.");
    const out = await answer(w, null);
    expect(out).toMatchObject({ read: 2, advanced: true, answered: [] });
    expect(w.events).toEqual(["readRulings null", `advance null → ${ack}`]);
    expect(w.fake.control.inboxComments(w.inbox)).toHaveLength(2);
  });

  test("no new comments: the cursor at the last comment is not swapped and nothing is posted", async () => {
    const w = await world();
    const last = w.fake.control.addInboxComment(w.inbox, "edanisko", "/xarabot go retro:2");
    const out = await answer(w, last);
    expect(out).toMatchObject({ read: 0, advanced: false, answered: [] });
    expect(w.events).toEqual([`readRulings ${last}`]);
    // No inbox has a comment yet, from no cursor: nothing either.
    const empty = await world();
    expect(await answer(empty, null)).toMatchObject({ read: 0, advanced: false, answered: [] });
    expect(empty.events).toEqual(["readRulings null"]);
  });

  test("a refused swap (another run moved the cursor): no reply, logged", async () => {
    const w = await world();
    w.fake.control.addInboxComment(w.inbox, "edanisko", "/xarabot go retro:2");
    const out = await answer(w, null, { landed: false });
    expect(out).toMatchObject({ read: 1, advanced: false, answered: [] });
    expect(w.events.filter((e) => e.startsWith("inboxComment"))).toEqual([]);
    expect(w.logs.some((l) => l.includes("rulings step: rulings_cursor not advanced: no ruling applied and no reply"))).toBe(true);
    // A swap that throws is the same.
    const t = await world();
    t.fake.control.addInboxComment(t.inbox, "edanisko", "/xarabot go retro:2");
    const thrown = await answer(t, null, {
      commit: async () => {
        throw new Error("boom");
      },
    });
    expect(thrown.advanced).toBe(false);
    expect(t.fake.control.inboxComments(t.inbox)).toHaveLength(1);
  });

  test("a reply that fails is logged and not retried; the cursor stays advanced and the next ruling is still answered", async () => {
    const w = await world();
    const first = w.fake.control.addInboxComment(w.inbox, "edanisko", "/xarabot go retro:2");
    const second = w.fake.control.addInboxComment(w.inbox, "bob", "/xarabot go retro:2");
    w.fake.control.injectError("inboxComment", { kind: "transient", message: "502" });
    const out = await answer(w, null);
    expect(out).toMatchObject({ read: 2, advanced: true, answered: [second] });
    expect(w.events.filter((e) => e.startsWith("inboxComment"))).toHaveLength(2);
    expect(w.logs.some((l) => l.includes(`inboxComment #${w.inbox} (reply to comment ${first}) failed: transient: 502; skipped`))).toBe(true);
    expect(w.fake.control.inboxComments(w.inbox)).toHaveLength(3);
  });

  test("a read that fails writes nothing, logged", async () => {
    const w = await world();
    w.fake.control.addInboxComment(w.inbox, "edanisko", "/xarabot go retro:2");
    w.fake.control.injectError("readRulings", { kind: "rate-limited", message: "slow", retry_after: 30 });
    const out = await answer(w, null);
    expect(out).toMatchObject({ read: 0, advanced: false, answered: [] });
    expect(w.events).toEqual(["readRulings null"]);
    expect(w.logs.some((l) => l.includes("rulings step: readRulings failed: rate-limited"))).toBe(true);
  });

  test("an aborted signal reads nothing; a throwing log is ignored", async () => {
    const w = await world();
    w.fake.control.addInboxComment(w.inbox, "edanisko", "/xarabot go retro:2");
    expect(await answer(w, null, { signal: AbortSignal.abort() })).toMatchObject({ read: 0, advanced: false, answered: [] });
    expect(w.events).toEqual([]);
    const out = await answer(w, null, {
      log: () => {
        throw new Error("disk full");
      },
    });
    expect(out.answered).toHaveLength(1);
  });
});

describe("answerRulings: more cases", () => {
  test("rulings on two inboxes: each reply lands on its own issue and not the other", async () => {
    const w = await world();
    const bobs = await w.fake.forge.openInbox("bob", live());
    if (!bobs.ok) throw new Error(bobs.error.message);
    const bobInbox = bobs.value.number;
    const fromBob = w.fake.control.addInboxComment(bobInbox, "bob", "/xarabot go retro:2");
    const fromM = w.fake.control.addInboxComment(w.inbox, "edanisko", "/xarabot go retro:2");
    const out = await answer(w, null);
    expect(out.answered).toEqual([fromBob, fromM]);
    expect(w.fake.control.inboxComments(bobInbox)).toEqual([
      "/xarabot go retro:2",
      `🤖 Ruling not applied ([comment](https://github.com/fake/repo/issues/${bobInbox}#issuecomment-${fromBob})): only the Maintainer (edanisko) may rule \`go\`. Nothing changed.`,
    ]);
    expect(w.fake.control.inboxComments(w.inbox)).toEqual([
      "/xarabot go retro:2",
      `🤖 Ruling acknowledged: \`/xarabot go retro:2\` from edanisko ([comment](https://github.com/fake/repo/issues/${w.inbox}#issuecomment-${fromM})).`,
    ]);
  });

  test("an abort after the swap landed: no reply is posted, and the unanswered comments are logged", async () => {
    const w = await world();
    const a = w.fake.control.addInboxComment(w.inbox, "edanisko", "/xarabot go retro:2");
    const b = w.fake.control.addInboxComment(w.inbox, "bob", "/xarabot go retro:2");
    const stop = new AbortController();
    const out = await answer(w, null, {
      signal: stop.signal,
      commit: async () => {
        stop.abort();
        return true;
      },
    });
    expect(out).toMatchObject({ read: 2, advanced: true, answered: [] });
    expect(w.fake.control.inboxComments(w.inbox)).toHaveLength(2);
    expect(w.logs).toContain(`rulings step: aborted after rulings_cursor advanced: 2 comment(s) left unanswered: ${a}, ${b}`);
  });
});

describe("answerRulings: the batch and its effects (Story 4.6)", () => {
  /** A world whose snapshot holds story:2.1 parked with its PR open on the fake forge. */
  async function rebuildWorld(): Promise<{ w: World; pr: number; snapshot: typeof SNAPSHOT }> {
    const w = await world();
    const head = w.fake.control.makeCommit();
    const pushed = await w.fake.forge.pushBranch({ branch: "story/2.1", expected_sha: null, sha: head }, live());
    if (!pushed.ok) throw new Error(pushed.error.message);
    const opened = await w.fake.forge.openPr({ branch: "story/2.1", base: "main", title: "t", body: "b" }, live());
    if (!opened.ok) throw new Error(opened.error.message);
    const pr = opened.value.number;
    const snapshot = snapshotOf({
      epics: { 1: [], 2: ["1"] },
      bootstrapped: [1],
      retro: { 2: "rejected" },
      records: [storyRec("2.1", { state: "parked", pr, head_sha: head })],
      prs: { "story:2.1": { number: pr, state: "open", head_sha: head } },
    });
    return { w, pr, snapshot };
  }

  test("the batch is judged in order and swapped whole: a second go is refused, and the swap carries both judgements", async () => {
    const w = await world();
    const first = w.fake.control.addInboxComment(w.inbox, "edanisko", "/xarabot go retro:2");
    const second = w.fake.control.addInboxComment(w.inbox, "edanisko", "/xarabot go retro:2");
    const out = await answer(w, null);
    expect(out).toMatchObject({ read: 2, advanced: true, tried: true, answered: [first, second] });
    expect(w.swapped).toHaveLength(1);
    const judged = w.swapped[0] ?? [];
    expect(judged.map((j) => j.judgement.kind)).toEqual(["valid", "refused"]);
    expect(judged[0]?.effect).toEqual({ kind: "pending", entry: { verb: "go", unit: "retro:2", by: "edanisko", at: expect.any(String), ruling: first } });
    expect(judged[1]?.judgement).toMatchObject({ reason: "retro:2 already has a go" });
    expect(out.judged).toBe(judged);
    expect(w.fake.control.inboxComments(w.inbox).at(-1)).toContain("retro:2 already has a go. Nothing changed.");
  });

  test("a valid rebuild closes its open PR before the swap, and the reply comes after the swap", async () => {
    const { w, pr, snapshot } = await rebuildWorld();
    const ruling = w.fake.control.addInboxComment(w.inbox, "edanisko", "/xarabot rebuild story:2.1");
    const out = await answer(w, null, { snapshot });
    expect(out).toMatchObject({ advanced: true, answered: [ruling] });
    expect(w.events).toEqual(["readRulings null", `closePr #${pr}`, `advance null → ${ruling}`, `inboxComment #${w.inbox}`]);
    expect(w.swapped[0]?.[0]?.effect).toMatchObject({ kind: "ledger", verb: "rebuild", unit: "story:2.1", closePr: pr });
    const prs = await w.fake.forge.listPrsByBranch("story/2.1", live());
    expect(prs.ok && prs.value.map((p) => p.state)).toEqual(["closed"]);
  });

  test("a rebuild whose close fails is refused with the reason, and its effect is dropped from the swap", async () => {
    const { w, pr, snapshot } = await rebuildWorld();
    w.fake.control.injectError("closePr", { kind: "transient", message: "502" });
    const ruling = w.fake.control.addInboxComment(w.inbox, "edanisko", "/xarabot rebuild story:2.1");
    const out = await answer(w, null, { snapshot });
    expect(out.advanced).toBe(true);
    const j = w.swapped[0]?.[0];
    expect(j?.effect).toBeNull();
    expect(j?.judgement).toEqual({ kind: "refused", verb: "rebuild", unit: "story:2.1", reason: `closing PR #${pr} failed: transient: 502` });
    expect(w.fake.control.inboxComments(w.inbox).at(-1)).toBe(
      `🤖 Ruling not applied ([comment](https://github.com/fake/repo/issues/${w.inbox}#issuecomment-${ruling})): closing PR #${pr} failed: transient: 502. Nothing changed.`,
    );
  });

  test("a refused swap posts no reply and applies nothing; the step says a swap was tried", async () => {
    const w = await world();
    w.fake.control.addInboxComment(w.inbox, "edanisko", "/xarabot go retro:2");
    const out = await answer(w, null, { landed: false });
    expect(out).toMatchObject({ read: 1, advanced: false, tried: true, answered: [] });
    expect(w.fake.control.inboxComments(w.inbox)).toHaveLength(1);
    expect(w.logs.some((l) => l.includes("no ruling applied and no reply"))).toBe(true);
  });

  test("a judge that throws: nothing applied or answered, the swap not tried, logged", async () => {
    const w = await world();
    w.fake.control.addInboxComment(w.inbox, "edanisko", "/xarabot go retro:2");
    const out = await answer(w, null, {
      judge: () => {
        throw new Error("boom");
      },
    });
    expect(out).toMatchObject({ tried: false, advanced: false, answered: [] });
    expect(w.swapped).toEqual([]);
    expect(w.events.some((e) => e.startsWith("advance"))).toBe(false);
    expect(w.logs).toContain("rulings step: judging the 1 comment(s) threw: boom; nothing applied or answered");
  });

  test("nothing new to read: no swap is tried and the batch is empty", async () => {
    const w = await world();
    const out = await answer(w, null);
    expect(out).toEqual({ read: 0, advanced: false, tried: false, answered: [], judged: [] });
  });
});
