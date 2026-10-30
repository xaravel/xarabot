import { describe, expect, test } from "bun:test";
import {
  ECHO_MAX,
  echoText,
  inboxOwner,
  judgeRuling,
  MAINTAINER_VERBS,
  OWNER_VERBS,
  parseRuling,
  RULING_VERBS,
  rulingReply,
  type RulingJudgement,
  type RulingVerb,
} from "../../../src/core/rulings/rulings.ts";
import { inboxInstance, inboxOwner as digestInboxOwner, parkedOwner, renderDigest } from "../../../src/core/inbox/render-digest.ts";
import { FORGE_TEXT_LIMITS } from "../../../src/core/sanitize.ts";
import { isUnitId, type Park, type UnitRecord } from "../../../src/core/schemas/ledger.ts";
import type { Snapshot } from "../../../src/core/schemas/snapshot.ts";
import { RETRO, snapshotOf, storyRec } from "../next/fixtures.ts";

// The fixtures' Maintainer is edanisko.
const M = "edanisko";
const URL = "https://github.com/o/r/issues/7#issuecomment-9";

const item = (seq: number, slug: string, route: "lane" | "maintainer", blocking: boolean, status: string) => [
  `      - id: epic-2-retro-item-${seq}-${slug}`,
  "        text: Do the thing.",
  `        route: ${route}`,
  `        blocking: ${blocking}`,
  "        globs: []",
  `        status: ${status}`,
];

const retro = (n: number, verdict: string) => ["    retro:", `      verdict: ${verdict}`, `      unit: "retro:${n}"`, "      recorded_at: 2026-10-20T00:00:00Z"];
const go = (indent: string) => [`${indent}go:`, `${indent}  by: edanisko`, `${indent}  at: 2026-10-21T00:00:00Z`, `${indent}  ruling: maintainer-pr`];

/**
 * Epic 2: retro rejected with no go, and five items. Epic 3: a checkpoint
 * with its go. Epic 4: a checkpoint whose go waits. Epic 5: rejected, gone.
 * Epic 6: a checkpoint with no retro yet.
 */
const RETRO_GATES = [
  "schema_version: 1",
  "epics:",
  '  "2":',
  ...retro(2, "rejected"),
  "    items:",
  ...item(1, "a", "maintainer", true, "open"),
  ...item(2, "b", "maintainer", false, "done"),
  ...item(3, "c", "maintainer", false, "deferred"),
  ...item(4, "d", "lane", false, "waiting"),
  ...item(5, "e", "maintainer", false, "in-progress"),
  '  "3":',
  ...retro(3, "accepted"),
  "    checkpoint:",
  ...go("      "),
  '  "4":',
  ...retro(4, "accepted"),
  '  "5":',
  ...retro(5, "rejected"),
  ...go("      "),
  "",
].join("\n");

const CHECKPOINTS = "version: 1\nepics:\n  3:\n    depends_on: [2]\n    checkpoint: true\n  4:\n    depends_on: [3]\n    checkpoint: true\n  6:\n    depends_on: [5]\n    checkpoint: true\n";

const parked = (id: string, park: Omit<Park, "globs_held">): UnitRecord => storyRec(id, { state: "parked", park: { ...park, globs_held: [] } as Park });

/** alice's blocked 2.1, a needs-approval 2.2 and a human-live-step 2.3 (both the Maintainer's), bob's 2.4 awaiting approval, a claimed 3.1. */
const RECORDS: readonly UnitRecord[] = [
  parked("2.1", { kind: "blocked", reason: "intent-gap", inbox_owner: "alice" }),
  parked("2.2", { kind: "needs-approval", reason: null, inbox_owner: "alice" }),
  parked("2.3", { kind: "blocked", reason: "human-live-step", inbox_owner: "alice" }),
  parked("2.4", { kind: "awaiting-approval", reason: null, inbox_owner: "bob" }),
  storyRec("3.1", { state: "claimed" }),
];

/** Story 1.2 (of bootstrapped Epic 1) and Story 7.1 have headings and no manifest. */
const SNAPSHOT: Snapshot = snapshotOf({
  epics: { 1: ["1", "2"], 2: ["1", "2", "3", "4"], 3: ["1"], 4: ["1"], 5: ["1"], 6: ["1"], 7: ["1"] },
  bootstrapped: [1],
  manifests: ["1.1", "2.1", "2.2", "2.3", "2.4", "3.1", "4.1", "5.1", "6.1"].map((id) => ({ id })),
  epicsYaml: CHECKPOINTS,
  files: { [RETRO]: RETRO_GATES },
  records: RECORDS,
});

const judge = (author: string | null, body: string, snapshot: Snapshot = SNAPSHOT): RulingJudgement => judgeRuling(snapshot, { author, body });
const reasonOf = (j: RulingJudgement): string => (j.kind === "refused" ? j.reason : `not refused: ${j.kind}`);

describe("the world", () => {
  test("resolves, with the checkpoints and unmanifested headings the cases rely on", () => {
    expect(SNAPSHOT.graph.ok).toBe(true);
    if (!SNAPSHOT.graph.ok) return;
    expect(SNAPSHOT.graph.value.checkpoints).toEqual([3, 4, 6]);
    // A bootstrapped Epic's heading with no manifest is not reported at all.
    expect(SNAPSHOT.graph.value.unmanifested.map((u) => u.id)).toEqual(["7.1"]);
  });
});

describe("parseRuling: the grammar", () => {
  test.each([
    ["thanks"],
    [""],
    ["   "],
    ["🤖 Ruling acknowledged: `/xarabot go checkpoint:4` from edanisko ([comment](https://x)). "],
    ["> /xarabot go retro:2"],
    ["please /xarabot go retro:2"],
    ["/xarabotgo retro:2"],
    ["`/xarabot go retro:2`"],
  ])("%p is not a ruling", (body) => {
    expect(parseRuling(body)).toEqual({ kind: "none" });
  });

  test.each([
    ["/xarabot go retro:2", "go", "retro:2"],
    ["  /xarabot   go\tretro:2  \n", "go", "retro:2"],
    ["/xarabot release story:1.1", "release", "story:1.1"],
    ["/xarabot done retro-item:epic-2-retro-item-1-a", "done", "retro-item:epic-2-retro-item-1-a"],
  ] as const)("%p is %s %s", (body, verb, unit) => {
    expect(parseRuling(body)).toEqual({ kind: "ruling", verb, unit });
  });

  test.each([
    ["/xarabot", "the ruling names no verb"],
    ["/xarabot\ngo retro:2", "the ruling names no verb"],
    ["/xarabot frob story:1.1", "`frob` is not a verb (go, approve, block, unblock, done, defer, rebuild, release, dismiss)"],
    ["/xarabot GO retro:2", "`GO` is not a verb (go, approve, block, unblock, done, defer, rebuild, release, dismiss)"],
    ["/xarabot go", "`go` names no unit id"],
    ["/xarabot go nope", "`nope` is not a unit id"],
    ["/xarabot go retro:0", "`retro:0` is not a unit id"],
    ["/xarabot go retro:2 now", "there is text after the unit id `retro:2`"],
    ["/xarabot go retro:2\nthanks!", "there is text after the unit id `retro:2`"],
    ["/xarabot @frob story:1.1", "`frob` is not a verb (go, approve, block, unblock, done, defer, rebuild, release, dismiss)"],
    ["/xarabot go `x`", "`x` is not a unit id"],
    ["/xarabot go ``", "(blank) is not a unit id"],
  ])("%p is malformed: %s", (body, reason) => {
    expect(parseRuling(body)).toEqual({ kind: "malformed", reason });
  });

  test("the verbs split into the Maintainer's and the owner's", () => {
    expect([...MAINTAINER_VERBS, ...OWNER_VERBS].sort()).toEqual([...RULING_VERBS].sort());
  });
});

describe("inboxOwner: renderDigest's rules", () => {
  test.each([
    ["story:2.1", "alice"],
    ["story:2.2", M],
    ["story:2.3", M],
    ["story:2.4", "bob"],
    ["checkpoint:4", M],
    ["retro:2", M],
    ["retro-item:epic-2-retro-item-1-a", M],
    ["retro-item:epic-2-retro-item-5-e", M],
    ["story:7.1", M],
    ["story:3.1", null],
    ["checkpoint:3", null],
    ["checkpoint:6", null],
    ["retro:3", null],
    ["retro:5", null],
    ["retro-item:epic-2-retro-item-2-b", null],
    ["retro-item:epic-2-retro-item-3-c", null],
    ["retro-item:epic-2-retro-item-4-d", null],
    ["story:1.2", null],
    ["story:9.9", null],
  ] as const)("%s is %p's", (unit, owner) => {
    expect(inboxOwner(SNAPSHOT, unit)).toBe(owner);
  });
});

describe("inboxOwner agrees with renderDigest", () => {
  test("the units inboxOwner finds an owner for, with those owners, are exactly the unit-id items each owner's digest lists", () => {
    // Every unit id the world could name: its records, each Epic's checkpoint and retro, each retro item and each heading.
    const epics = [1, 2, 3, 4, 5, 6, 7];
    const items = Object.values(SNAPSHOT.retro_gates.epics).flatMap((e) => (e.items ?? []).map((i) => `retro-item:${i.id}`));
    const headings = ["1.1", "1.2", "2.1", "2.2", "2.3", "2.4", "3.1", "4.1", "5.1", "6.1", "7.1"].map((id) => `story:${id}`);
    const candidates = new Set([...RECORDS.map((r) => r.unit), ...epics.flatMap((n) => [`checkpoint:${n}`, `retro:${n}`]), ...items, ...headings, "story:9.9"]);
    const owned: Record<string, string> = {};
    for (const unit of candidates) {
      const owner = inboxOwner(SNAPSHOT, unit);
      if (owner !== null) owned[unit] = owner;
    }
    const listed: Record<string, string> = {};
    for (const [owner, d] of renderDigest({ snapshot: SNAPSHOT, files: {}, repoUrl: "https://github.com/o/r" })) {
      for (const line of d.body.split("\n")) {
        const label = /^- \[([^\]]+)\]/.exec(line)?.[1];
        // Only AR35 unit ids: deferred entries are not units.
        if (label !== undefined && isUnitId(label)) listed[label] = owner;
      }
    }
    expect(Object.keys(listed).length).toBeGreaterThan(5);
    expect(owned).toEqual(listed);
  });
});

describe("inboxOwner: one rule with renderDigest (Epic 4 retro item 5)", () => {
  test("the rulings' inboxOwner is the digest module's own", () => {
    expect(inboxOwner).toBe(digestInboxOwner);
  });

  test("a unit has an owner exactly when a dismissal could name its item", () => {
    const units = [...RECORDS.map((r) => r.unit), "checkpoint:3", "checkpoint:4", "retro:2", "retro:5", "retro-item:epic-2-retro-item-1-a", "retro-item:epic-2-retro-item-2-b", "story:7.1", "story:1.2"];
    for (const unit of units) expect(inboxOwner(SNAPSHOT, unit) !== null).toBe(inboxInstance(SNAPSHOT, unit) !== null);
  });

  test("parkedOwner: a parked record's owner, or null for a record not parked", () => {
    expect(RECORDS.map((r) => parkedOwner(SNAPSHOT, r))).toEqual(["alice", M, M, "bob", null]);
  });
});

describe("judgeRuling: authority", () => {
  /** A target each verb applies to, and its inbox item's owner. */
  const TARGETS: readonly (readonly [RulingVerb, string, string])[] = [
    ["go", "checkpoint:4", M],
    ["go", "retro:2", M],
    ["approve", "story:2.2", M],
    ["block", "retro-item:epic-2-retro-item-5-e", M],
    ["unblock", "retro-item:epic-2-retro-item-1-a", M],
    ["done", "retro-item:epic-2-retro-item-1-a", M],
    ["defer", "retro-item:epic-2-retro-item-5-e", M],
    ["rebuild", "story:2.1", "alice"],
    ["release", "story:2.4", "bob"],
    ["dismiss", "story:2.1", "alice"],
    ["dismiss", "retro:2", M],
  ];
  const owned = (verb: RulingVerb) => (OWNER_VERBS as readonly string[]).includes(verb);

  test.each(TARGETS)("%s %s: the Maintainer's counts, in any case", (verb, unit, owner) => {
    expect(judge(M, `/xarabot ${verb} ${unit}`)).toEqual({ kind: "valid", verb, unit, author: M, owner });
    expect(judge("EdAnisko", `/xarabot ${verb} ${unit}`)).toEqual({ kind: "valid", verb, unit, author: "EdAnisko", owner });
  });

  test.each(TARGETS)("%s %s: the item's owner counts only for rebuild, release and dismiss", (verb, unit, owner) => {
    const who = owner === M ? "alice" : owner.toUpperCase();
    const j = judge(who, `/xarabot ${verb} ${unit}`);
    if (owned(verb) && owner !== M) expect(j).toEqual({ kind: "valid", verb, unit, author: who, owner });
    else expect(j.kind).toBe("refused");
  });

  test.each(TARGETS)("%s %s: anyone else is refused", (verb, unit, owner) => {
    const j = judge("carol", `/xarabot ${verb} ${unit}`);
    const want = !owned(verb)
      ? `only the Maintainer (${M}) may rule \`${verb}\``
      : owner === M
        ? `only the Maintainer (${M}) may rule \`${verb}\` on ${unit}`
        : `only ${owner} or the Maintainer (${M}) may rule \`${verb}\` on ${unit}`;
    expect(j).toEqual({ kind: "refused", verb, unit, reason: want });
    expect(judge(null, `/xarabot ${verb} ${unit}`).kind).toBe("refused");
  });

  test("the Maintainer-only check runs before the target: bob's go on a retro that is not rejected names the Maintainer", () => {
    expect(reasonOf(judge("bob", "/xarabot go retro:3"))).toBe(`only the Maintainer (${M}) may rule \`go\``);
    expect(reasonOf(judge("bob", "/xarabot go retro:2"))).toBe(`only the Maintainer (${M}) may rule \`go\``);
  });

  test("the owner's verbs check the target first: carol's release of an unparked unit says it is not parked", () => {
    expect(reasonOf(judge("carol", "/xarabot release story:3.1"))).toBe("story:3.1 is claimed, not parked");
  });

  test("owner release: alice's release of her parked Story counts, carol's does not", () => {
    expect(judge("alice", "/xarabot release story:2.1").kind).toBe("valid");
    expect(reasonOf(judge("carol", "/xarabot release story:2.1"))).toBe(`only alice or the Maintainer (${M}) may rule \`release\` on story:2.1`);
  });
});

describe("judgeRuling: targets (as the Maintainer)", () => {
  test.each([
    ["go story:2.1", "`go` applies only to a checkpoint or a retro"],
    ["go retro-item:epic-2-retro-item-1-a", "`go` applies only to a checkpoint or a retro"],
    ["go retro:3", "retro:3's verdict is accepted, not rejected"],
    ["go retro:5", "retro:5 already has a go"],
    ["go retro:7", "Epic 7 has no retro verdict recorded"],
    ["go checkpoint:3", "checkpoint:3 already has a go"],
    ["go checkpoint:2", "Epic 2 is not a checkpoint"],
    ["approve story:2.1", "story:2.1 is not parked needs-approval"],
    ["approve story:3.1", "story:3.1 is not parked needs-approval"],
    ["approve story:9.9", "story:9.9 has no ledger record"],
    ["block retro-item:epic-2-retro-item-1-a", "retro-item:epic-2-retro-item-1-a is already blocking"],
    ["block story:2.1", "`block` applies only to a retro item"],
    ["block retro-item:epic-2-retro-item-9-z", "_bmad-output/implementation-artifacts/retro-gates.yaml lists no retro-item:epic-2-retro-item-9-z under Epic 2"],
    ["block retro-item:epic-8-retro-item-1-a", "_bmad-output/implementation-artifacts/retro-gates.yaml lists no retro-item:epic-8-retro-item-1-a under Epic 8"],
    ["unblock retro-item:epic-2-retro-item-2-b", "retro-item:epic-2-retro-item-2-b is already not blocking"],
    ["unblock checkpoint:4", "`unblock` applies only to a retro item"],
    ["done retro-item:epic-2-retro-item-2-b", "retro-item:epic-2-retro-item-2-b is already done"],
    ["done retro:2", "`done` applies only to a retro item"],
    ["defer retro-item:epic-2-retro-item-2-b", "retro-item:epic-2-retro-item-2-b is done, not open, in-progress or waiting"],
    ["defer retro-item:epic-2-retro-item-3-c", "retro-item:epic-2-retro-item-3-c is deferred, not open, in-progress or waiting"],
    ["rebuild story:3.1", "story:3.1 is claimed, not parked"],
    ["release story:9.9", "story:9.9 has no ledger record"],
    ["dismiss story:3.1", "no inbox lists story:3.1"],
    ["dismiss checkpoint:3", "no inbox lists checkpoint:3"],
    ["dismiss checkpoint:6", "no inbox lists checkpoint:6"],
    ["dismiss retro:3", "no inbox lists retro:3"],
    ["dismiss retro-item:epic-2-retro-item-4-d", "no inbox lists retro-item:epic-2-retro-item-4-d"],
    ["dismiss story:1.2", "no inbox lists story:1.2"],
  ])("%s: %s", (ruling, reason) => {
    expect(reasonOf(judge(M, `/xarabot ${ruling}`))).toBe(reason);
  });

  test.each([
    ["go checkpoint:6", M],
    ["defer retro-item:epic-2-retro-item-1-a", M],
    ["done retro-item:epic-2-retro-item-3-c", M],
    ["done retro-item:epic-2-retro-item-4-d", M],
    ["defer retro-item:epic-2-retro-item-4-d", M],
    ["rebuild story:2.3", M],
    ["release story:2.2", M],
    ["dismiss story:7.1", M],
    ["dismiss checkpoint:4", M],
    ["dismiss retro-item:epic-2-retro-item-5-e", M],
    ["dismiss story:2.4", "bob"],
  ])("%s applies; the item is %s's", (ruling, owner) => {
    expect(judge(M, `/xarabot ${ruling}`)).toMatchObject({ kind: "valid", owner });
  });

  test("approve needs the Story's manifest on main (Story 4.6)", () => {
    const noManifest = snapshotOf({ epics: { 1: [], 2: ["2"] }, bootstrapped: [1], manifests: [], records: [parked("2.2", { kind: "needs-approval", reason: null, inbox_owner: "alice" })] });
    expect(reasonOf(judge(M, "/xarabot approve story:2.2", noManifest))).toBe("story:2.2 has no manifest on main");
    expect(judge(M, "/xarabot approve story:2.2").kind).toBe("valid");
  });

  test("a bootstrapped checkpoint Epic with no retro is listed, as renderDigest lists it: dismiss applies", () => {
    const boot = snapshotOf({ epics: { 1: ["1"], 2: ["1"] }, bootstrapped: [1], epicsYaml: "version: 1\nepics:\n  1:\n    checkpoint: true\n" });
    expect(inboxOwner(boot, "checkpoint:1")).toBe(M);
    expect(judge(M, "/xarabot dismiss checkpoint:1", boot)).toMatchObject({ kind: "valid", owner: M });
    expect(renderDigest({ snapshot: boot, files: {}, repoUrl: "https://github.com/o/r" }).get(M)?.body).toContain("[checkpoint:1]");
  });

  test("go on a checkpoint when the graph does not resolve", () => {
    const broken = snapshotOf({ epics: { 1: [], 2: [] }, epicsYaml: "version: 1\nepics:\n  1:\n    depends_on: [2]\n  2:\n    depends_on: [1]\n" });
    expect(broken.graph.ok).toBe(false);
    expect(reasonOf(judge(M, "/xarabot go checkpoint:2", broken))).toBe("the Epic graph does not resolve");
  });

  test("ignored and malformed bodies", () => {
    expect(judge(M, "thanks")).toEqual({ kind: "ignored" });
    expect(judge("bob", "> /xarabot go retro:2")).toEqual({ kind: "ignored" });
    expect(judge(M, "/xarabot go retro:2 now")).toEqual({ kind: "refused", verb: null, unit: null, reason: "there is text after the unit id `retro:2`" });
  });
});

describe("rulingReply", () => {
  test("a valid ruling's acknowledgement, linking the comment", () => {
    expect(rulingReply(judge(M, "/xarabot go checkpoint:4"), URL)).toBe(
      "🤖 Ruling acknowledged: `/xarabot go checkpoint:4` from edanisko ([comment](https://github.com/o/r/issues/7#issuecomment-9)).",
    );
  });

  test("a refused ruling's reply, with its reason", () => {
    expect(rulingReply(judge("bob", "/xarabot go checkpoint:4"), URL)).toBe(
      "🤖 Ruling not applied ([comment](https://github.com/o/r/issues/7#issuecomment-9)): only the Maintainer (edanisko) may rule `go`. Nothing changed.",
    );
    expect(rulingReply(judge(M, "/xarabot go retro:3"), URL)).toBe(
      "🤖 Ruling not applied ([comment](https://github.com/o/r/issues/7#issuecomment-9)): retro:3's verdict is accepted, not rejected. Nothing changed.",
    );
  });

  test("a comment that is not a ruling gets no reply", () => {
    expect(rulingReply(judge(M, "thanks"), URL)).toBeNull();
  });

  test("echoed text is sanitized, has no backtick or @, and is capped; a reply mentions no one", () => {
    const mention = rulingReply(judge("bob", "/xarabot @edanisko story:1.1"), URL) as string;
    expect(mention).toBe(
      "🤖 Ruling not applied ([comment](https://github.com/o/r/issues/7#issuecomment-9)): `edanisko` is not a verb (go, approve, block, unblock, done, defer, rebuild, release, dismiss). Nothing changed.",
    );
    expect(mention).not.toContain("@");
    const ticks = rulingReply(judge("bob", "/xarabot go `@carol`x"), URL) as string;
    expect(ticks).toContain(": `carolx` is not a unit id.");
    const token = ["gh", "p_", "A".repeat(36)].join("");
    const leaked = rulingReply(judge("bob", `/xarabot ${token} story:1.1`), URL) as string;
    expect(leaked).not.toContain(token);
    expect(leaked).toContain("[REDACTED]");
    const long = rulingReply(judge("bob", `/xarabot ${"x".repeat(5000)} story:1.1`), URL) as string;
    expect(long.length).toBeLessThan(400);
    expect(long).toContain(`\`${"x".repeat(ECHO_MAX - 1)}…\``);
    expect(echoText("a\n\n@b  `c`")).toBe("a b c");
  });

  test("a reply is capped at FORGE_TEXT_LIMITS.comment, and the link cannot break out of its parentheses", () => {
    const huge = rulingReply(judge(M, "/xarabot go checkpoint:4"), `https://x/${"y".repeat(70_000)}`) as string;
    expect(huge.length).toBeLessThanOrEqual(FORGE_TEXT_LIMITS.comment);
    expect(rulingReply(judge(M, "/xarabot go checkpoint:4"), "https://x/a) (b")).toContain("([comment](https://x/ab)).");
  });
});
