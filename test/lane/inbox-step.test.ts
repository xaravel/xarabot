import { describe, expect, test } from "bun:test";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { EMPTY_INBOX_BODY, type OwnerDigest } from "../../src/core/inbox/render-digest.ts";
import type { Forge } from "../../src/ports/forge.ts";
import { digestMention, syncInboxes, type SyncInboxesParams } from "../../src/lane/inbox-step.ts";

const live = () => ({ signal: new AbortController().signal });

/** The fake forge with each inbox call recorded in order. */
function spied(fake: FakeForge, events: string[]): Forge {
  const f = fake.forge;
  return {
    ...f,
    inboxes: (o) => (events.push("inboxes"), f.inboxes(o)),
    openInbox: (who, o) => (events.push(`openInbox ${who}`), f.openInbox(who, o)),
    setInboxBody: (n, b, o) => (events.push(`setInboxBody #${n}`), f.setInboxBody(n, b, o)),
    inboxComment: (n, b, o) => (events.push(`inboxComment #${n}`), f.inboxComment(n, b, o)),
  };
}

type World = { fake: FakeForge; events: string[]; logs: string[]; stamps: number };

function world(): World {
  return { fake: createFakeForge(), events: [], logs: [], stamps: 0 };
}

const digestOf = (body: string, count: number): OwnerDigest => ({ body, count });

async function sync(w: World, digests: Record<string, OwnerDigest>, over: Partial<SyncInboxesParams> & { stamped?: boolean } = {}) {
  const { stamped = true, ...rest } = over;
  return syncInboxes({
    forge: spied(w.fake, w.events),
    digests: new Map(Object.entries(digests)),
    digestDue: false,
    stamp: async () => {
      w.stamps += 1;
      w.events.push("stamp");
      return stamped;
    },
    log: (l) => w.logs.push(l),
    signal: new AbortController().signal,
    ...rest,
  });
}

describe("syncInboxes: bodies", () => {
  test("first need: the inbox is created for the owner and its body written; an unchanged second run writes nothing", async () => {
    const w = world();
    const first = await sync(w, { alice: digestOf("alice's items", 1) });
    expect(first).toEqual({ opened: ["alice"], written: [1001], stamped: false, mentioned: [] });
    expect(w.fake.control.inboxes()).toEqual([{ number: 1001, title: "🤖 Xarabot inbox", owner: "alice", body: "alice's items", open: true }]);
    w.events.length = 0;
    const second = await sync(w, { alice: digestOf("alice's items", 1) });
    expect(second).toEqual({ opened: [], written: [], stamped: false, mentioned: [] });
    expect(w.events).toEqual(["inboxes"]);
  });

  test("a changed body is rewritten in place", async () => {
    const w = world();
    await sync(w, { alice: digestOf("one", 1) });
    expect((await sync(w, { alice: digestOf("two", 2) })).written).toEqual([1001]);
    expect(w.fake.control.inboxes().map((i) => i.body)).toEqual(["two"]);
  });

  test("a stale inbox is cleared to the empty text, an owner matched case-insensitively is not", async () => {
    const w = world();
    await sync(w, { bob: digestOf("bob's items", 1), Carol: digestOf("carol's", 1) });
    const r = await sync(w, { carol: digestOf("carol's", 1) }, { digestDue: true });
    // Owners in login order: Carol's inbox was opened first (#1001), bob's second (#1002).
    expect(r.written).toEqual([1002]);
    expect(w.fake.control.inboxes().map((i) => [i.owner, i.body])).toEqual([
      ["Carol", "carol's"],
      ["bob", EMPTY_INBOX_BODY],
    ]);
    // bob holds nothing: no mention for him.
    expect(w.fake.control.inboxComments(1002)).toEqual([]);
    expect(w.fake.control.inboxComments(1001)).toEqual([digestMention("carol", 1, "https://github.com/fake/repo/issues/1001")]);
  });

  test("an inbox already at the empty text is left alone; one with no owner is never touched", async () => {
    const w = world();
    const bob = await w.fake.forge.openInbox("bob", live());
    if (!bob.ok) throw new Error(bob.error.message);
    await w.fake.forge.setInboxBody(bob.value.number, EMPTY_INBOX_BODY, live());
    expect((await sync(w, {})).written).toEqual([]);
  });

  test("a failed list writes nothing and posts nothing, and never stamps", async () => {
    const w = world();
    w.fake.control.injectError("inboxes", { kind: "transient", message: "502" });
    const r = await sync(w, { alice: digestOf("x", 1) }, { digestDue: true });
    expect(r).toEqual({ opened: [], written: [], stamped: false, mentioned: [] });
    expect(w.stamps).toBe(0);
    expect(w.logs.some((l) => l.includes("inboxes failed: transient: 502"))).toBe(true);
  });

  test("a failed create is logged and skipped; the other owners go on, and the next run creates it", async () => {
    const w = world();
    w.fake.control.injectError("openInbox", { kind: "forbidden", message: "no issues: write" });
    const r = await sync(w, { alice: digestOf("a", 1), bob: digestOf("b", 1) }, { digestDue: true });
    expect(r).toEqual({ opened: ["bob"], written: [1001], stamped: true, mentioned: [1001] });
    expect(w.logs.some((l) => l.includes("openInbox alice failed: forbidden"))).toBe(true);
    const next = await sync(w, { alice: digestOf("a", 1), bob: digestOf("b", 1) });
    expect(next.opened).toEqual(["alice"]);
  });

  test("a failed body write is logged and skipped", async () => {
    const w = world();
    w.fake.control.injectError("setInboxBody", { kind: "rate-limited", message: "slow", retry_after: 5 });
    const r = await sync(w, { alice: digestOf("a", 1) });
    expect(r.written).toEqual([]);
    expect(w.fake.control.inboxes().map((i) => i.body)).toEqual([""]);
    expect(w.logs.some((l) => l.includes("setInboxBody #1001 failed: rate-limited"))).toBe(true);
  });

  test("an aborted signal does nothing", async () => {
    const w = world();
    const r = await sync(w, { alice: digestOf("a", 1) }, { digestDue: true, signal: AbortSignal.abort() });
    expect(r).toEqual({ opened: [], written: [], stamped: false, mentioned: [] });
    expect(w.events).toEqual([]);
  });
});

describe("syncInboxes: the daily digest", () => {
  test("due: bodies first, then the stamp, then one mention per non-empty inbox", async () => {
    const w = world();
    const stale = await w.fake.forge.openInbox("dave", live());
    if (!stale.ok) throw new Error(stale.error.message);
    w.events.length = 0;
    const r = await sync(w, { alice: digestOf("a", 2), bob: digestOf("b", 1) }, { digestDue: true });
    expect(r).toEqual({ opened: ["alice", "bob"], written: [1002, 1003, 1001], stamped: true, mentioned: [1002, 1003] });
    expect(w.events).toEqual([
      "inboxes",
      "openInbox alice",
      "setInboxBody #1002",
      "openInbox bob",
      "setInboxBody #1003",
      "setInboxBody #1001",
      "stamp",
      "inboxComment #1002",
      "inboxComment #1003",
    ]);
    expect(w.fake.control.inboxComments(1002)).toEqual(["🤖 @alice Xarabot daily digest: 2 items wait on you in https://github.com/fake/repo/issues/1002."]);
    expect(w.fake.control.inboxComments(1003)).toEqual(["🤖 @bob Xarabot daily digest: 1 item waits on you in https://github.com/fake/repo/issues/1003."]);
    expect(w.fake.control.inboxComments(1001)).toEqual([]);
  });

  test("not due: no stamp and no mention, even when a body changed", async () => {
    const w = world();
    await sync(w, { alice: digestOf("a", 1) });
    const r = await sync(w, { alice: digestOf("b", 1) }, { digestDue: false });
    expect(r.written).toEqual([1001]);
    expect(w.stamps).toBe(0);
    expect(w.fake.control.inboxComments(1001)).toEqual([]);
  });

  test("a refused or lost stamp posts nothing", async () => {
    const w = world();
    const r = await sync(w, { alice: digestOf("a", 1) }, { digestDue: true, stamped: false });
    expect(r).toMatchObject({ stamped: false, mentioned: [] });
    expect(w.stamps).toBe(1);
    expect(w.fake.control.inboxComments(1001)).toEqual([]);
    expect(w.logs.some((l) => l.includes("not stamped"))).toBe(true);
  });

  test("a stamp that throws posts nothing and does not throw", async () => {
    const w = world();
    const r = await sync(w, { alice: digestOf("a", 1) }, {
      digestDue: true,
      stamp: async () => {
        throw new Error("boom");
      },
    });
    expect(r).toMatchObject({ stamped: false, mentioned: [] });
    expect(w.logs.some((l) => l.includes("digest stamp threw: boom"))).toBe(true);
  });

  test("a post that fails after the stamp is logged, never retried; the next owner still gets theirs", async () => {
    const w = world();
    w.fake.control.injectError("inboxComment", { kind: "transient", message: "502" });
    const r = await sync(w, { alice: digestOf("a", 1), bob: digestOf("b", 1) }, { digestDue: true });
    expect(r).toMatchObject({ stamped: true, mentioned: [1002] });
    expect(w.fake.control.inboxComments(1001)).toEqual([]);
    expect(w.events.filter((e) => e.startsWith("inboxComment"))).toEqual(["inboxComment #1001", "inboxComment #1002"]);
    expect(w.logs.some((l) => l.includes("inboxComment #1001 failed: transient: 502"))).toBe(true);
  });

  test("a failed body write posts no mention for that owner; the others still get theirs", async () => {
    const w = world();
    w.fake.control.injectError("setInboxBody", { kind: "transient", message: "502" });
    const r = await sync(w, { alice: digestOf("a", 1), bob: digestOf("b", 1) }, { digestDue: true });
    expect(r).toMatchObject({ opened: ["alice", "bob"], written: [1002], stamped: true, mentioned: [1002] });
    expect(w.fake.control.inboxComments(1001)).toEqual([]);
  });

  test("an owner with zero items gets no mention", async () => {
    const w = world();
    const r = await sync(w, { alice: digestOf("a", 0) }, { digestDue: true });
    expect(r.mentioned).toEqual([]);
  });
});
