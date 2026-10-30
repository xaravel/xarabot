import { describe, expect, test } from "bun:test";
import { COORDINATOR_PATH, parseLedger, serializeCoordinator } from "../../../src/core/ledger/codec.ts";
import { renderDigest } from "../../../src/core/inbox/render-digest.ts";
import { next } from "../../../src/core/next/next.ts";
import { editRetroGates } from "../../../src/core/reconcile/retro-gates-edit.ts";
import {
  HOST_RULING_ID,
  judgeRulings,
  pendingKey,
  rulingAdds,
  rulingsDrops,
  rulingsEdit,
  rulingsView,
  withPending,
  type JudgedRuling,
  type RulingEffect,
  type RulingInput,
} from "../../../src/core/rulings/effects.ts";
import type { CoordinatorRecord, Dismissal, Park, PendingRuling, UnitRecord } from "../../../src/core/schemas/ledger.ts";
import type { Snapshot } from "../../../src/core/schemas/snapshot.ts";
import { COORD, tip } from "../ledger/fixtures.ts";
import { input, NOW, RETRO, shaOf, snapshotOf, storyRec } from "../next/fixtures.ts";

// The fixtures' Maintainer is edanisko; NOW is 2026-10-22T10:10:00Z.
const M = "edanisko";
const AT = "2026-10-22T09:00:00Z";
const RECORDED = "2026-10-20T00:00:00Z";
const HEAD = "e".repeat(40);
const ITEM_A = "retro-item:epic-2-retro-item-1-a";
const ITEM_E = "retro-item:epic-2-retro-item-5-e";

const item = (seq: number, slug: string, blocking: boolean, status: string) => [
  `      - id: epic-2-retro-item-${seq}-${slug}`,
  "        text: Do the thing.",
  "        route: maintainer",
  `        blocking: ${blocking}`,
  "        globs: []",
  `        status: ${status}`,
];

/** Epic 2: retro rejected with no go, item 1-a blocking and open, item 5-e not blocking and in progress. Epic 4: a checkpoint whose go waits. */
const RETRO_GATES = [
  "schema_version: 1",
  "epics:",
  '  "2":',
  "    retro:",
  "      verdict: rejected",
  '      unit: "retro:2"',
  `      recorded_at: ${RECORDED}`,
  "    items:",
  ...item(1, "a", true, "open"),
  ...item(5, "e", false, "in-progress"),
  '  "4":',
  "    retro:",
  "      verdict: accepted",
  '      unit: "retro:4"',
  `      recorded_at: ${RECORDED}`,
  "",
].join("\n");

const parked = (id: string, park: Omit<Park, "globs_held">, over: Partial<UnitRecord> = {}): UnitRecord =>
  storyRec(id, { state: "parked", park: { ...park, globs_held: [] } as Park, ...over });

/** alice's 2.1 blocked on an open PR, a needs-approval 2.2 (manifest on main), a needs-approval 7.1 (no manifest), bob's 2.4 awaiting approval. */
const RECORDS: readonly UnitRecord[] = [
  parked("2.1", { kind: "blocked", reason: "intent-gap", inbox_owner: "alice" }, { pr: 9, head_sha: HEAD, builder_providers: ["anthropic"], attempts: 2 }),
  parked("2.2", { kind: "needs-approval", reason: null, inbox_owner: "alice" }),
  parked("2.4", { kind: "awaiting-approval", reason: null, inbox_owner: "bob" }, { pr: 10, head_sha: HEAD }),
  parked("7.1", { kind: "needs-approval", reason: null, inbox_owner: "alice" }),
];

const claim = (over: Partial<CoordinatorRecord> = {}): CoordinatorRecord => ({
  schema_version: 6,
  ...COORD,
  lane: "coordinator",
  generation: 3,
  heartbeat_at: NOW,
  digest_posted_at: null,
  rulings_cursor: "40",
  ...over,
});

function world(coordinator: CoordinatorRecord = claim(), gates = RETRO_GATES): Snapshot {
  return snapshotOf({
    epics: { 1: ["1"], 2: ["1", "2", "3", "4"], 3: ["1"], 4: ["1"], 7: ["1"] },
    bootstrapped: [1],
    manifests: ["1.1", "2.1", "2.2", "2.3", "2.4", "3.1", "4.1"].map((id) => ({ id })),
    epicsYaml: "version: 1\nepics:\n  4:\n    depends_on: [3]\n    checkpoint: true\n",
    files: { [RETRO]: gates },
    records: RECORDS,
    prs: { "story:2.1": { number: 9, state: "open", head_sha: HEAD }, "story:2.4": { number: 10, state: "closed", head_sha: HEAD } },
    coordinator,
  });
}

const SNAPSHOT = world();

let nextId = 100;
/** A comment by `author` (default the Maintainer), with a fresh id. */
const c = (body: string, author: string | null = M): RulingInput => ({ author, body, id: String(nextId++), created_at: AT });
const judged = (snapshot: Snapshot, ...comments: RulingInput[]) => judgeRulings(snapshot, comments).judged;
const one = (body: string, snapshot: Snapshot = SNAPSHOT, author: string | null = M) => {
  const comment = c(body, author);
  return { comment, j: judged(snapshot, comment)[0] as JudgedRuling };
};
const pending = (verb: PendingRuling["verb"], unit: string, ruling: string, by = M, at = AT): PendingRuling => ({ verb, unit, by, at, ruling });
const reasons = (js: readonly JudgedRuling[]) => js.map((j) => (j.judgement.kind === "refused" ? j.judgement.reason : j.judgement.kind));

describe("each verb's effect", () => {
  test.each([
    ["go checkpoint:4", "go", "checkpoint:4"],
    ["go retro:2", "go", "retro:2"],
    [`block ${ITEM_E}`, "block", ITEM_E],
    [`unblock ${ITEM_A}`, "unblock", ITEM_A],
    [`done ${ITEM_A}`, "done", ITEM_A],
    [`defer ${ITEM_E}`, "defer", ITEM_E],
  ] as const)("%s: a pending entry by the author, at the comment's time, with the comment id", (body, verb, unit) => {
    const { comment, j } = one(`/xarabot ${body}`);
    expect(j.judgement.kind).toBe("valid");
    expect(j.effect).toEqual({ kind: "pending", entry: pending(verb, unit, comment.id) });
  });

  test("from the host: the Maintainer's entry at the snapshot's now, ruling xarabot-rule", () => {
    const [j] = judgeRulings(SNAPSHOT, [{ author: M, body: "/xarabot go checkpoint:4", id: HOST_RULING_ID, created_at: NOW }], "host").judged;
    expect(j?.effect).toEqual({ kind: "pending", entry: pending("go", "checkpoint:4", HOST_RULING_ID, M, NOW) });
  });

  test("approve: applyRuling at the record's generation, approval {the author, the manifest's sha}", () => {
    const { j } = one("/xarabot approve story:2.2", SNAPSHOT, "EdAnisko");
    expect(j.effect).toEqual({ kind: "ledger", verb: "approve", unit: "story:2.2", generation: 1, approval: { by: "EdAnisko", manifest_sha: shaOf("2.2") }, closePr: null });
  });

  test("approve with no manifest on main is refused with the reason", () => {
    const { j } = one("/xarabot approve story:7.1");
    expect(j).toMatchObject({ judgement: { kind: "refused", reason: "story:7.1 has no manifest on main" }, effect: null });
  });

  test.each([
    ["rebuild story:2.1", "rebuild", "story:2.1", 9],
    ["release story:2.1", "release", "story:2.1", null],
    ["rebuild story:2.4 (its PR closed)", "rebuild", "story:2.4", null],
  ] as const)("%s: applyRuling, closing only an open PR on rebuild", (body, verb, unit, closePr) => {
    const { j } = one(`/xarabot ${body.split(" (")[0]}`);
    expect(j.effect).toEqual({ kind: "ledger", verb, unit, generation: 1, approval: null, closePr });
  });

  test("dismiss: the item's instance as the digest shows it", () => {
    expect(one("/xarabot dismiss story:2.1").j.effect).toEqual({ kind: "dismissal", dismissal: { unit: "story:2.1", subject: "blocked `intent-gap`", since: "2026-10-22T10:00:00Z" } });
    expect(one("/xarabot dismiss checkpoint:4").j.effect).toEqual({ kind: "dismissal", dismissal: { unit: "checkpoint:4", subject: "Epic 4's retro is recorded (accepted)", since: RECORDED } });
    expect(one(`/xarabot dismiss ${ITEM_A}`).j.effect).toEqual({ kind: "dismissal", dismissal: { unit: ITEM_A, subject: "Epic 2 · open, blocking: Do the thing.", since: RECORDED } });
  });

  test("a refused or ignored ruling has no effect", () => {
    expect(one("/xarabot go checkpoint:4", SNAPSHOT, "bob").j.effect).toBeNull();
    expect(one("thanks").j).toMatchObject({ judgement: { kind: "ignored" }, effect: null });
  });
});

describe("judging in sequence", () => {
  test("the same release twice: the first valid, the second refused", () => {
    expect(reasons(judged(SNAPSHOT, c("/xarabot release story:2.1"), c("/xarabot release story:2.1")))).toEqual(["valid", "story:2.1 is released, not parked"]);
  });

  test("a second go is refused: there is already a go", () => {
    expect(reasons(judged(SNAPSHOT, c("/xarabot go checkpoint:4"), c("/xarabot go checkpoint:4"), c("/xarabot go retro:2"), c("/xarabot go retro:2")))).toEqual([
      "valid",
      "checkpoint:4 already has a go",
      "valid",
      "retro:2 already has a go",
    ]);
  });

  test("block then unblock in one batch: both valid; the later supersedes in the adds", () => {
    const js = judged(SNAPSHOT, c(`/xarabot block ${ITEM_E}`), c(`/xarabot unblock ${ITEM_E}`));
    expect(reasons(js)).toEqual(["valid", "valid"]);
    expect(rulingAdds(js).pending.map((e) => e.verb)).toEqual(["block", "unblock"]);
  });

  test("done then defer of one item: defer is refused, the item is done", () => {
    expect(reasons(judged(SNAPSHOT, c(`/xarabot done ${ITEM_E}`), c(`/xarabot defer ${ITEM_E}`)))).toEqual(["valid", `${ITEM_E} is done, not open, in-progress or waiting`]);
  });

  test("an approve after a release of the same record is refused", () => {
    expect(reasons(judged(SNAPSHOT, c("/xarabot release story:2.2"), c("/xarabot approve story:2.2")))).toEqual(["valid", "story:2.2 is not parked needs-approval"]);
  });

  test("a refused ruling changes nothing for the next: bob's release then the Maintainer's", () => {
    expect(reasons(judged(SNAPSHOT, c("/xarabot release story:2.1", "carol"), c("/xarabot release story:2.1")))).toEqual([
      `only alice or the Maintainer (${M}) may rule \`release\` on story:2.1`,
      "valid",
    ]);
  });
});

describe("the pending view", () => {
  const withBlock = world(claim({ pending_rulings: [pending("block", ITEM_E, "7")] }));

  test("withPending applies the snapshot's pending entries to retro_gates, and nothing else", () => {
    const view = withPending(withBlock);
    expect(view.retro_gates.epics["2"]?.items?.find((i) => `retro-item:${i.id}` === ITEM_E)?.blocking).toBe(true);
    expect(withBlock.retro_gates.epics["2"]?.items?.find((i) => `retro-item:${i.id}` === ITEM_E)?.blocking).toBe(false);
    expect(view.ledger).toBe(withBlock.ledger);
    expect(withPending(SNAPSHOT)).toBe(SNAPSHOT);
  });

  test("a pending block counts: another block is refused, and an unblock is valid and replaces it", () => {
    expect(reasons(judged(withBlock, c(`/xarabot block ${ITEM_E}`)))).toEqual([`${ITEM_E} is already blocking`]);
    const js = judged(withBlock, c(`/xarabot unblock ${ITEM_E}`));
    expect(reasons(js)).toEqual(["valid"]);
    const view = rulingsView(withBlock, js);
    expect(view.ledger.coordinator?.pending_rulings?.map((e) => e.verb)).toEqual(["unblock"]);
    expect(view.retro_gates.epics["2"]?.items?.find((i) => `retro-item:${i.id}` === ITEM_E)?.blocking).toBe(false);
  });

  test("a pending go counts: a go again is refused", () => {
    const gone = world(claim({ pending_rulings: [pending("go", "checkpoint:4", "8")] }));
    expect(reasons(judged(gone, c("/xarabot go checkpoint:4")))).toEqual(["checkpoint:4 already has a go"]);
  });

  test("pendingKey: one family per unit", () => {
    expect(pendingKey(pending("block", ITEM_E, "1"))).toBe(pendingKey(pending("unblock", ITEM_E, "2")));
    expect(pendingKey(pending("done", ITEM_E, "1"))).toBe(pendingKey(pending("defer", ITEM_E, "2")));
    expect(pendingKey(pending("done", ITEM_E, "1"))).not.toBe(pendingKey(pending("block", ITEM_E, "1")));
  });
});

describe("the final view", () => {
  test("pending entries applied, released records out, dismissed items left out of the inbox", () => {
    const js = judged(SNAPSHOT, c("/xarabot go checkpoint:4"), c("/xarabot release story:2.4"), c("/xarabot dismiss story:2.1"), c("/xarabot go retro:2"));
    expect(reasons(js)).toEqual(["valid", "valid", "valid", "valid"]);
    const view = rulingsView(SNAPSHOT, js);
    const digests = renderDigest({ snapshot: view, files: {}, repoUrl: "https://github.com/o/r" });
    const all = [...digests.values()].map((d) => d.body).join("\n");
    expect(all).not.toContain("[checkpoint:4]");
    expect(all).not.toContain("[retro:2]");
    expect(all).not.toContain("[story:2.4]");
    expect(all).not.toContain("[story:2.1]");
    expect(all).toContain("[story:2.2]");
    expect(digests.has("bob")).toBe(false);
    // The snapshot's own digest still lists them all.
    const before = [...renderDigest({ snapshot: SNAPSHOT, files: {}, repoUrl: "https://github.com/o/r" }).values()].map((d) => d.body).join("\n");
    for (const u of ["checkpoint:4", "retro:2", "story:2.4", "story:2.1"]) expect(before).toContain(`[${u}]`);
  });
});

describe("drops", () => {
  const shownGates = RETRO_GATES.replace("        blocking: false", "        blocking: true");

  test("a pending entry main shows is dropped; one it does not show is kept", () => {
    const shown = pending("block", ITEM_E, "1");
    const unlisted = pending("done", "retro-item:epic-2-retro-item-9-z", "3");
    const entries = [shown, pending("go", "checkpoint:4", "2"), unlisted];
    const snapshot = world(claim({ pending_rulings: entries }), shownGates);
    const drops = rulingsDrops(withPending(snapshot), snapshot);
    // The block is on main; the item 9-z is no longer listed, so its done cannot apply: both shown.
    expect(drops.pending).toEqual([shown, unlisted]);
  });

  test("a dismissal whose item comes back as a new instance is dropped; the same instance and an unlisted item keep theirs", () => {
    const same: Dismissal = { unit: "story:2.1", subject: "blocked `intent-gap`", since: "2026-10-22T10:00:00Z" };
    const changed: Dismissal = { unit: "checkpoint:4", subject: "Epic 4's retro is recorded (accepted)", since: "2026-10-19T00:00:00Z" };
    const unlisted: Dismissal = { unit: "story:9.9", subject: "blocked `other`", since: null };
    const otherText: Dismissal = { unit: ITEM_A, subject: "Epic 2 · open: Do the thing.", since: RECORDED };
    const snapshot = world(claim({ dismissals: [same, changed, unlisted, otherText] }));
    expect(rulingsDrops(withPending(snapshot), snapshot).dismissals).toEqual([changed, otherText]);
  });

  test("main's graph does not resolve (retro_gates read as empty): no pending entry is dropped; dismissals still are", () => {
    const entries = [pending("block", ITEM_E, "1"), pending("go", "retro:2", "2"), pending("done", ITEM_A, "3")];
    const stale: Dismissal = { unit: "story:2.1", subject: "blocked `other`", since: "2026-10-22T10:00:00Z" };
    const broken = snapshotOf({
      epics: { 1: [], 2: ["1"] },
      epicsYaml: "version: 1\nepics:\n  1:\n    depends_on: [2]\n  2:\n    depends_on: [1]\n",
      files: { [RETRO]: RETRO_GATES },
      records: [RECORDS[0] as UnitRecord],
      coordinator: claim({ pending_rulings: entries, dismissals: [stale] }),
    });
    expect(broken.graph.ok).toBe(false);
    expect(broken.retro_gates.epics).toEqual({});
    const drops = rulingsDrops(withPending(broken), broken);
    expect(drops.pending).toEqual([]);
    expect(drops.dismissals).toEqual([stale]);
  });

  describe("a reconcile PR open keeps every pending entry (Epic 4 retro item 1)", () => {
    const R = 11;
    const reconcile = storyRec("9.9", { unit: "reconcile:7", state: "merging", lane: "coordinator", globs: [], pr: R, head_sha: HEAD });
    /** `world` with `reconcile:7`'s PR in `state`, carrying what the first ruling wrote. */
    const withReconcile = (coordinator: CoordinatorRecord, gates: string, state: "open" | "merged" | "closed"): Snapshot => {
      const base = world(coordinator, gates);
      return {
        ...base,
        ledger: { ...base.ledger, units: [...base.ledger.units, reconcile] },
        prs: { ...base.prs, "reconcile:7": { number: R, state, head_sha: HEAD } },
      };
    };
    const blockingE = RETRO_GATES.replace("        blocking: false", "        blocking: true");
    const unblockedA = RETRO_GATES.replace("        blocking: true", "        blocking: false");

    test.each([
      // main shows item 5-e not blocking; the first PR blocks it; then the Maintainer unblocks it.
      ["block then unblock", "block", "unblock", ITEM_E, RETRO_GATES, blockingE],
      // The mirror: main shows item 1-a blocking; the first PR unblocks it; then the Maintainer blocks it again.
      ["unblock then block", "unblock", "block", ITEM_A, RETRO_GATES, unblockedA],
    ] as const)("%s with the first PR open: the last ruling is kept until main shows it with no reconcile PR open", (_name, first, last, unit, mainBefore, mainAfter) => {
      const firstEntry = pending(first, unit, "1");
      const run1 = withReconcile(claim({ pending_rulings: [firstEntry] }), mainBefore, "open");
      // The first ruling is pending and on the open PR, not yet on main: the last one is valid against the view and supersedes it.
      const { judged: js } = judgeRulings(run1, [c(`/xarabot ${last} ${unit}`)]);
      const j = js[0] as JudgedRuling;
      expect(j.judgement.kind).toBe("valid");
      const lastEntry = (j.effect as Extract<RulingEffect, { kind: "pending" }>).entry;
      expect(rulingsDrops(rulingsView(run1, js), run1).pending).toEqual([]);
      expect(rulingsView(run1, js).ledger.coordinator?.pending_rulings).toEqual([lastEntry]);

      // The next run: main still shows what the last ruling says, but the open PR carries the first: kept.
      const run2 = withReconcile(claim({ pending_rulings: [lastEntry] }), mainBefore, "open");
      expect(rulingsDrops(withPending(run2), run2).pending).toEqual([]);

      // The first PR merges: main shows the first ruling, so the last one is kept and still applies.
      const run3 = withReconcile(claim({ pending_rulings: [lastEntry] }), mainAfter, "merged");
      expect(rulingsDrops(withPending(run3), run3).pending).toEqual([]);
      const item = (s: Snapshot) => s.retro_gates.epics["2"]?.items?.find((x) => `retro-item:${x.id}` === unit)?.blocking;
      expect(item(run3)).toBe(first === "block");
      expect(item(withPending(run3))).toBe(last === "block");

      // Main shows the last ruling and no reconcile PR is open: dropped.
      const run4 = withReconcile(claim({ pending_rulings: [lastEntry] }), mainBefore, "merged");
      expect(rulingsDrops(withPending(run4), run4).pending).toEqual([lastEntry]);
    });

    test("a closed reconcile PR does not keep an entry main shows", () => {
      const shown = pending("block", ITEM_E, "1");
      const snapshot = withReconcile(claim({ pending_rulings: [shown] }), blockingE, "closed");
      expect(rulingsDrops(withPending(snapshot), snapshot).pending).toEqual([shown]);
      const open = withReconcile(claim({ pending_rulings: [shown] }), blockingE, "open");
      expect(rulingsDrops(withPending(open), open).pending).toEqual([]);
    });

    test("dismissals still expire while a reconcile PR is open", () => {
      const changed: Dismissal = { unit: "checkpoint:4", subject: "Epic 4's retro is recorded (accepted)", since: "2026-10-19T00:00:00Z" };
      const snapshot = withReconcile(claim({ dismissals: [changed] }), RETRO_GATES, "open");
      expect(rulingsDrops(withPending(snapshot), snapshot).dismissals).toEqual([changed]);
    });
  });

  test("an item a pending ruling changes is a new instance in the view", () => {
    const dismissal: Dismissal = { unit: ITEM_E, subject: "Epic 2 · in-progress: Do the thing.", since: RECORDED };
    const snapshot = world(claim({ dismissals: [dismissal], pending_rulings: [pending("block", ITEM_E, "1")] }));
    expect(rulingsDrops(withPending(snapshot), snapshot).dismissals).toEqual([dismissal]);
    const plain = world(claim({ dismissals: [dismissal] }));
    expect(rulingsDrops(withPending(plain), plain).dismissals).toEqual([]);
  });
});

describe("rulingsEdit", () => {
  const ledgerFiles = (coordinator: CoordinatorRecord) => tip(RECORDS, { [COORDINATOR_PATH]: serializeCoordinator(coordinator) });
  const apply = (edit: ReturnType<typeof rulingsEdit>, files: Record<string, string>) => {
    const r = edit(files);
    if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
    if (r.value === null) return null;
    const out: Record<string, string> = { ...files, ...r.value.writes };
    for (const d of r.value.deletes) delete out[d];
    const l = parseLedger(out);
    if (!l.ok) throw new Error(l.error.message);
    return { message: r.value.message, ledger: l.value };
  };

  test("one commit: the cursor, the drops, the batch's pending entries and dismissals, and each applyRuling", () => {
    const old = pending("go", "retro:2", "5");
    const coordinator = claim({ pending_rulings: [old] });
    const js = judged(world(coordinator), c(`/xarabot block ${ITEM_E}`), c("/xarabot approve story:2.2"), c("/xarabot dismiss story:2.4"), c("/xarabot rebuild story:2.1"));
    const out = apply(
      rulingsEdit({ by: COORD, now: NOW, coordinatorGeneration: 3, cursor: { from: "40", to: "44" }, judged: js, drops: { pending: [old], dismissals: [] } }),
      ledgerFiles(coordinator),
    );
    expect(out?.message).toBe("ledger: recordRulings coordinator [skip ci]");
    const c2 = out?.ledger.coordinator;
    expect(c2?.rulings_cursor).toBe("44");
    expect(c2?.pending_rulings?.map((e) => `${e.verb} ${e.unit}`)).toEqual([`block ${ITEM_E}`]);
    expect(c2?.dismissals?.map((d) => d.unit)).toEqual(["story:2.4"]);
    expect(out?.ledger.units.get("story:2.2")).toMatchObject({ state: "released", approval: { by: M, manifest_sha: shaOf("2.2") } });
    expect(out?.ledger.units.get("story:2.1")).toMatchObject({ state: "released", builder_providers: [], attempts: 0, reviewed_sha: null, passed_sha: null });
  });

  test("with only ledger effects and no cursor (the host's approve): no recordRulings, so no coordinator.json is needed", () => {
    const js = judged(SNAPSHOT, c("/xarabot approve story:2.2"));
    const files = tip(RECORDS);
    const out = apply(rulingsEdit({ by: { ...COORD, lane: "builder-1" }, now: NOW, coordinatorGeneration: null, cursor: null, judged: js, drops: { pending: [], dismissals: [] } }), files);
    expect(out?.message).toBe("ledger: applyRuling story:2.2 [skip ci]");
    expect(out?.ledger.coordinator).toBeNull();
  });

  test("a pending entry with no coordinator.json is refused", () => {
    const js = judged(SNAPSHOT, c("/xarabot go checkpoint:4"));
    const r = rulingsEdit({ by: COORD, now: NOW, coordinatorGeneration: null, cursor: null, judged: js, drops: { pending: [], dismissals: [] } })(tip(RECORDS));
    expect(r.ok ? "ok" : r.error.kind).toBe("precondition");
  });

  test("a record that moved refuses the whole batch: nothing is written", () => {
    const coordinator = claim();
    const js = judged(SNAPSHOT, c("/xarabot go checkpoint:4"), c("/xarabot release story:2.1"));
    const moved = { ...ledgerFiles(coordinator), ...tip([{ ...(RECORDS[0] as UnitRecord), generation: 2 }]) };
    const r = rulingsEdit({ by: COORD, now: NOW, coordinatorGeneration: 3, cursor: { from: "40", to: "42" }, judged: js, drops: { pending: [], dismissals: [] } })(moved);
    expect(r.ok ? "ok" : r.error.kind).toBe("precondition");
  });

  test("nothing judged and nothing to drop, with no cursor: writes nothing", () => {
    expect(apply(rulingsEdit({ by: COORD, now: NOW, coordinatorGeneration: 3, cursor: null, judged: [], drops: { pending: [], dismissals: [] } }), ledgerFiles(claim()))).toBeNull();
  });
});

describe("the gates and next follow (the acceptance criteria)", () => {
  test("go checkpoint: once the reconcile PR's text is on main, next no longer holds the checkpoint's dependents", () => {
    const chain = {
      epics: { 1: ["1"], 2: ["1"], 3: ["1"] },
      status: { "1.1": "done", "2.1": "done" },
      retro: { 1: "accepted" as const, 2: "accepted" as const },
      epicsYaml: "version: 1\nepics:\n  2:\n    checkpoint: true\n",
      coordinator: claim(),
    };
    const before = snapshotOf(chain);
    const held = next(before, "builder");
    expect(held.kind).toBe("idle");
    const [j] = judged(before, c("/xarabot go checkpoint:2"));
    if (j?.effect?.kind !== "pending") throw new Error("expected a pending go");
    const mainText = input(chain).files[RETRO] as string;
    const edited = editRetroGates(RETRO, mainText, [], [], [], [j.effect.entry]);
    if (!edited.ok) throw new Error(edited.error.message);
    const after = next(snapshotOf({ ...chain, files: { [RETRO]: edited.value.text } }), "builder");
    expect(after.kind === "unit" ? after.story.story_id : after.kind).toBe("3.1");
  });

  test("approve: next takes the approved Infrastructure Story while its manifest sha holds, and parks it needs-approval again once the sha changes", () => {
    const needsRec = parked("1.1", { kind: "needs-approval", reason: null, inbox_owner: "alice" });
    const w = { epics: { 1: ["1"] }, manifests: [{ id: "1.1", infra: true }], records: [needsRec], coordinator: claim() };
    const snapshot = snapshotOf(w);
    const js = judged(snapshot, c("/xarabot approve story:1.1"));
    const files = tip([needsRec], { [COORDINATOR_PATH]: serializeCoordinator(claim()) });
    const r = rulingsEdit({ by: COORD, now: NOW, coordinatorGeneration: 3, cursor: { from: "40", to: "41" }, judged: js, drops: { pending: [], dismissals: [] } })(files);
    if (!r.ok || r.value === null) throw new Error("expected a commit");
    const approved = snapshotOf({ ...w, ledgerFiles: { ...files, ...r.value.writes } });
    expect(approved.ledger.units[0]).toMatchObject({ state: "released", approval: { by: M, manifest_sha: shaOf("1.1") } });
    const taken = next(approved, "builder");
    expect(taken.kind === "unit" ? taken.story.story_id : taken.kind).toBe("1.1");
    const changed: Snapshot = { ...approved, manifests: approved.manifests.map((m) => ({ ...m, sha: "a".repeat(40) })) };
    const parkedAgain = next(changed, "builder");
    expect(parkedAgain.kind === "park" ? parkedAgain.park : parkedAgain.kind).toBe("needs-approval");
  });
});
