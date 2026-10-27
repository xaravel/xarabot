import { describe, expect, test } from "bun:test";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { judgeRuling } from "../../src/core/rulings/rulings.ts";
import type { Forge } from "../../src/ports/forge.ts";
import { answerRulings, type AnswerRulingsParams } from "../../src/lane/rulings-step.ts";
import { snapshotOf } from "../core/next/fixtures.ts";

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
  };
}

type World = { fake: FakeForge; events: string[]; logs: string[]; inbox: number };

async function world(): Promise<World> {
  const fake = createFakeForge();
  const opened = await fake.forge.openInbox("edanisko", live());
  if (!opened.ok) throw new Error(opened.error.message);
  return { fake, events: [], logs: [], inbox: opened.value.number };
}

async function answer(w: World, cursor: string | null, over: Partial<AnswerRulingsParams> & { landed?: boolean } = {}) {
  const { landed = true, ...rest } = over;
  return answerRulings({
    forge: spied(w.fake, w.events),
    cursor,
    judge: (c) => judgeRuling(SNAPSHOT, c),
    advance: async (from, to) => {
      w.events.push(`advance ${from ?? "null"} → ${to}`);
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
    expect(out).toEqual({ read: 5, advanced: true, answered: [go, bob, bad] });
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
    expect(out).toEqual({ read: 2, advanced: true, answered: [] });
    expect(w.events).toEqual(["readRulings null", `advance null → ${ack}`]);
    expect(w.fake.control.inboxComments(w.inbox)).toHaveLength(2);
  });

  test("no new comments: the cursor at the last comment is not swapped and nothing is posted", async () => {
    const w = await world();
    const last = w.fake.control.addInboxComment(w.inbox, "edanisko", "/xarabot go retro:2");
    const out = await answer(w, last);
    expect(out).toEqual({ read: 0, advanced: false, answered: [] });
    expect(w.events).toEqual([`readRulings ${last}`]);
    // No inbox has a comment yet, from no cursor: nothing either.
    const empty = await world();
    expect(await answer(empty, null)).toEqual({ read: 0, advanced: false, answered: [] });
    expect(empty.events).toEqual(["readRulings null"]);
  });

  test("a refused swap (another run moved the cursor): no reply, logged", async () => {
    const w = await world();
    w.fake.control.addInboxComment(w.inbox, "edanisko", "/xarabot go retro:2");
    const out = await answer(w, null, { landed: false });
    expect(out).toEqual({ read: 1, advanced: false, answered: [] });
    expect(w.events.filter((e) => e.startsWith("inboxComment"))).toEqual([]);
    expect(w.logs.some((l) => l.includes("rulings step: rulings_cursor not advanced: no reply"))).toBe(true);
    // A swap that throws is the same.
    const t = await world();
    t.fake.control.addInboxComment(t.inbox, "edanisko", "/xarabot go retro:2");
    const thrown = await answer(t, null, {
      advance: async () => {
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
    expect(out).toEqual({ read: 2, advanced: true, answered: [second] });
    expect(w.events.filter((e) => e.startsWith("inboxComment"))).toHaveLength(2);
    expect(w.logs.some((l) => l.includes(`inboxComment #${w.inbox} (reply to comment ${first}) failed: transient: 502; skipped`))).toBe(true);
    expect(w.fake.control.inboxComments(w.inbox)).toHaveLength(3);
  });

  test("a read that fails writes nothing, logged", async () => {
    const w = await world();
    w.fake.control.addInboxComment(w.inbox, "edanisko", "/xarabot go retro:2");
    w.fake.control.injectError("readRulings", { kind: "rate-limited", message: "slow", retry_after: 30 });
    const out = await answer(w, null);
    expect(out).toEqual({ read: 0, advanced: false, answered: [] });
    expect(w.events).toEqual(["readRulings null"]);
    expect(w.logs.some((l) => l.includes("rulings step: readRulings failed: rate-limited"))).toBe(true);
  });

  test("an aborted signal reads nothing; a throwing log is ignored", async () => {
    const w = await world();
    w.fake.control.addInboxComment(w.inbox, "edanisko", "/xarabot go retro:2");
    expect(await answer(w, null, { signal: AbortSignal.abort() })).toEqual({ read: 0, advanced: false, answered: [] });
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
      advance: async () => {
        stop.abort();
        return true;
      },
    });
    expect(out).toEqual({ read: 2, advanced: true, answered: [] });
    expect(w.fake.control.inboxComments(w.inbox)).toHaveLength(2);
    expect(w.logs).toContain(`rulings step: aborted after rulings_cursor advanced: 2 comment(s) left unanswered: ${a}, ${b}`);
  });
});
