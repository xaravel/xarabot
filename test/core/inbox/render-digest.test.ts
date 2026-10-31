import { describe, expect, test } from "bun:test";
import { ageText, EMPTY_INBOX_BODY, inboxInstance, inboxOwner, renderDigest } from "../../../src/core/inbox/render-digest.ts";
import { FORGE_TEXT_LIMITS } from "../../../src/core/sanitize.ts";
import type { CoordinatorRecord, Dismissal, Park, UnitRecord } from "../../../src/core/schemas/ledger.ts";
import type { Snapshot } from "../../../src/core/schemas/snapshot.ts";
import { RETRO, snapshotOf, storyRec, type World } from "../next/fixtures.ts";

// NOW is 2026-10-22T10:10:00Z; the fixtures' Maintainer is edanisko.
const REPO = "https://github.com/xaravel/xarabot";
const DAY = (d: number) => new Date(Date.parse("2026-10-22T10:10:00Z") - d * 86_400_000).toISOString();
const SPEC41 = "_bmad-output/implementation-artifacts/spec-4-1-gates.md";
const SPEC43 = "_bmad-output/implementation-artifacts/spec-4-3-waiting.md";

function parked(id: string, park: Omit<Park, "globs_held"> & { globs_held?: string[] }, over: Partial<UnitRecord> = {}): UnitRecord {
  return storyRec(id, { state: "parked", heartbeat_at: DAY(2), park: { globs_held: [], ...park }, ...over });
}

/** Epic 1 bootstrapped, Epic 2 with Stories 2.1-2.4; the records and files given. */
function world(over: Partial<World> = {}): World {
  return { epics: { 1: [], 2: ["1", "2", "3", "4"] }, bootstrapped: [1], ...over };
}

function digest(w: World, files: Record<string, string> = {}): Map<string, { body: string; count: number }> {
  const snapshot: Snapshot = snapshotOf({ ...w, files: { ...w.files, ...files } });
  return renderDigest({ snapshot, files, repoUrl: REPO });
}

/** Each owner's item lines (the `- ` lines), by owner. */
function itemLines(d: Map<string, { body: string; count: number }>): Record<string, string[]> {
  return Object.fromEntries([...d].map(([owner, { body }]) => [owner, body.split("\n").filter((l) => l.startsWith("- "))]));
}

const RETRO_GATES = [
  "schema_version: 1",
  "epics:",
  '  "1":',
  "    retro:",
  "      verdict: rejected",
  '      unit: "retro:1"',
  `      recorded_at: ${DAY(3)}`,
  "    items:",
  "      - id: epic-1-retro-item-1-fix-the-gate",
  '        text: "Fix the gate for @bob, fixes #12."',
  "        route: maintainer",
  "        blocking: true",
  "        globs: []",
  "        status: open",
  "      - id: epic-1-retro-item-2-lane-work",
  "        text: Lane work.",
  "        route: lane",
  "        blocking: false",
  "        globs: []",
  "        status: open",
  "      - id: epic-1-retro-item-3-done",
  "        text: Done already.",
  "        route: maintainer",
  "        blocking: false",
  "        globs: []",
  "        status: done",
  '  "2":',
  "    retro:",
  "      verdict: accepted",
  '      unit: "retro:2"',
  `      recorded_at: ${DAY(1)}`,
  '  "3":',
  "    retro:",
  "      verdict: accepted",
  '      unit: "retro:3"',
  `      recorded_at: ${DAY(1)}`,
  "    checkpoint:",
  "      go:",
  "        by: edanisko",
  `        at: ${DAY(0)}`,
  "        ruling: maintainer-pr",
  "",
].join("\n");

const CHECKPOINTS = "version: 1\nepics:\n  2:\n    depends_on: [1]\n    checkpoint: true\n  3:\n    depends_on: [2]\n    checkpoint: true\n";

describe("renderDigest: who gets what", () => {
  test.each([
    ["no records: no inbox has items", world(), {}],
    [
      "awaiting-approval goes to its inbox_owner, with no verb",
      world({ records: [parked("2.1", { kind: "awaiting-approval", reason: null, inbox_owner: "alice" }, { pr: 12 })] }),
      { alice: [`- [story:2.1](${REPO}/pull/12) · awaiting approval · 2d`] },
    ],
    [
      "a graph change awaiting approval says so, in its inbox_owner's (the Maintainer's) inbox",
      world({ records: [parked("2.1", { kind: "awaiting-approval", reason: null, inbox_owner: "edanisko", graph_posted: `sha256:${"9".repeat(64)}` }, { pr: 12 })] }),
      { edanisko: [`- [story:2.1](${REPO}/pull/12) · awaiting approval (graph change) · 2d`] },
    ],
    [
      "needs-approval goes to the Maintainer with the approve verb",
      world({ records: [parked("2.1", { kind: "needs-approval", reason: null, inbox_owner: "alice" })] }),
      { edanisko: [`- [story:2.1](${REPO}/blob/xarabot/claims/units/story__2.1.json) · needs approval · 2d · \`/xarabot approve story:2.1\``] },
    ],
    [
      "blocked goes to its inbox_owner; a human-live-step block to the Maintainer",
      world({
        records: [
          parked("2.1", { kind: "blocked", reason: "intent-gap", inbox_owner: "alice" }, { pr: 12 }),
          parked("2.2", { kind: "blocked", reason: "human-live-step", inbox_owner: "alice" }, { heartbeat_at: DAY(0.5) }),
        ],
      }),
      {
        alice: [`- [story:2.1](${REPO}/pull/12) · blocked \`intent-gap\` · 2d`],
        edanisko: [`- [story:2.2](${REPO}/blob/xarabot/claims/units/story__2.2.json) · blocked \`human-live-step\` · <1d`],
      },
    ],
    [
      "claimed, merging, released and merged records list nothing",
      world({ records: [storyRec("2.1", { state: "claimed" }), storyRec("2.2", { state: "merging", pr: 3 }), storyRec("2.3", { state: "released" }), storyRec("2.4", { state: "merged" })] }),
      {},
    ],
    [
      "owners differing only in case share one inbox",
      world({
        records: [
          parked("2.1", { kind: "awaiting-approval", reason: null, inbox_owner: "Alice" }, { pr: 1 }),
          parked("2.2", { kind: "awaiting-approval", reason: null, inbox_owner: "alice" }, { pr: 2 }),
        ],
      }),
      { Alice: [`- [story:2.1](${REPO}/pull/1) · awaiting approval · 2d`, `- [story:2.2](${REPO}/pull/2) · awaiting approval · 2d`] },
    ],
  ] as const)("%s", (_name, w, want) => {
    expect(itemLines(digest(w as World))).toEqual(want as unknown as Record<string, string[]>);
  });

  test("the Maintainer's own items: checkpoint gos, rejected retros, routed items, unmanifested headings and deferred entries", () => {
    const w = world({
      epics: { 1: ["1"], 2: ["1"], 3: ["1"], 4: ["1", "2"], 5: ["1"] },
      bootstrapped: [1],
      manifests: [{ id: "1.1" }, { id: "2.1" }, { id: "3.1" }, { id: "4.1" }],
      epicsYaml: CHECKPOINTS,
      files: { [RETRO]: RETRO_GATES },
    });
    const files = {
      [SPEC41]: "---\ncreated: '2026-10-19'\ndeferred:\n  - summary: First @carol item, closes #3.\n  - summary: Second item.\n---\n",
      [SPEC43]: "---\ncreated: '2026-10-21'\nresolves: [\"4.1-d1\"]\n---\n",
    };
    const d = digest(w, files);
    expect([...d.keys()]).toEqual(["edanisko"]);
    const gates = `${REPO}/blob/main/_bmad-output/implementation-artifacts/retro-gates.yaml`;
    expect(itemLines(d)["edanisko"]).toEqual([
      `- [checkpoint:2](${gates}) · Epic 2's retro is recorded (accepted) · 1d · \`/xarabot go checkpoint:2\``,
      `- [retro:1](${gates}) · rejected, no go · 3d · \`/xarabot go retro:1\``,
      `- [retro-item:epic-1-retro-item-1-fix-the-gate](${gates}) · Epic 1 · open, blocking: Fix the gate for bob,. · 3d · \`/xarabot done|defer retro-item:epic-1-retro-item-1-fix-the-gate\``,
      `- [story:4.2](${REPO}/blob/main/_bmad-output/planning-artifacts/epics.md#L31) · Epic 4's heading has no manifest`,
      `- [story:5.1](${REPO}/blob/main/_bmad-output/planning-artifacts/epics.md#L37) · Epic 5's heading has no manifest`,
      `- [4.1-d2](${REPO}/blob/main/${SPEC41}) · deferred: Second item. · 3d`,
    ]);
    const body = d.get("edanisko")?.body ?? "";
    expect(body).toContain("  - course correction: retro-item:epic-1-retro-item-1-fix-the-gate");
    expect(d.get("edanisko")?.count).toBe(6);
  });

  test.each(["waiting", "in-progress", "open"] as const)("a %s Maintainer-routed item: one line with its Epic, status, text, age and the done|defer verb (Story 4.3)", (status) => {
    const gates = ["schema_version: 1", "epics:", '  "2":', "    retro:", "      verdict: accepted-with-open-items", '      unit: "retro:2"', `      recorded_at: ${DAY(3)}`, "    items:", "      - id: epic-2-retro-item-2-b", "        text: Ask the Maintainer.", "        route: maintainer", "        blocking: false", "        globs: []", `        status: ${status}`, ""].join("\n");
    const d = digest(world({ files: { [RETRO]: gates } }));
    const url = `${REPO}/blob/main/_bmad-output/implementation-artifacts/retro-gates.yaml`;
    expect(itemLines(d)).toEqual({ edanisko: [`- [retro-item:epic-2-retro-item-2-b](${url}) · Epic 2 · ${status}: Ask the Maintainer. · 3d · \`/xarabot done|defer retro-item:epic-2-retro-item-2-b\``] });
    expect(d.get("edanisko")?.count).toBe(1);
  });

  test("a routed item of an Epic with no retro record has no age; done and deferred items are not listed (Story 4.3)", () => {
    const item = (id: string, status: string) => [`      - id: ${id}`, "        text: Ask.", "        route: maintainer", "        blocking: true", "        globs: []", `        status: ${status}`];
    const gates = ["schema_version: 1", "epics:", '  "3":', "    items:", ...item("epic-3-retro-item-1-a", "waiting"), ...item("epic-3-retro-item-2-b", "done"), ...item("epic-3-retro-item-3-c", "deferred"), ""].join("\n");
    const d = digest(world({ epics: { 1: [], 2: ["1"], 3: ["1"] }, manifests: [{ id: "2.1" }, { id: "3.1" }], files: { [RETRO]: gates } }));
    const url = `${REPO}/blob/main/_bmad-output/implementation-artifacts/retro-gates.yaml`;
    expect(itemLines(d)).toEqual({ edanisko: [`- [retro-item:epic-3-retro-item-1-a](${url}) · Epic 3 · waiting, blocking: Ask. · \`/xarabot done|defer retro-item:epic-3-retro-item-1-a\``] });
    expect(d.get("edanisko")?.count).toBe(1);
  });

  test("a rejected retro with no go and a waiting Maintainer item: the retro and the item once each, the item a course correction under the retro (Story 4.3)", () => {
    const gates = ["schema_version: 1", "epics:", '  "2":', "    retro:", "      verdict: rejected", '      unit: "retro:2"', `      recorded_at: ${DAY(3)}`, "    items:", "      - id: epic-2-retro-item-1-a", "        text: Ask.", "        route: maintainer", "        blocking: true", "        globs: []", "        status: waiting", ""].join("\n");
    const d = digest(world({ files: { [RETRO]: gates } }));
    const url = `${REPO}/blob/main/_bmad-output/implementation-artifacts/retro-gates.yaml`;
    expect(itemLines(d)).toEqual({
      edanisko: [
        `- [retro:2](${url}) · rejected, no go · 3d · \`/xarabot go retro:2\``,
        `- [retro-item:epic-2-retro-item-1-a](${url}) · Epic 2 · waiting, blocking: Ask. · 3d · \`/xarabot done|defer retro-item:epic-2-retro-item-1-a\``,
      ],
    });
    const body = d.get("edanisko")?.body ?? "";
    expect(body.split("\n").filter((l) => l.startsWith("- [retro-item:"))).toHaveLength(1);
    expect(body).toContain(`- [retro:2](${url}) · rejected, no go · 3d · \`/xarabot go retro:2\`\n  - course correction: retro-item:epic-2-retro-item-1-a\n`);
    expect(d.get("edanisko")?.count).toBe(2);
  });

  test.each([
    ["no retro record: listed as bootstrapped, with no age", "", [`- [checkpoint:1](${REPO}/blob/main/${RETRO}) · Epic 1 is bootstrapped · \`/xarabot go checkpoint:1\``]],
    ["a go recorded: nothing listed", '  "1":\n    checkpoint:\n      go:\n        by: edanisko\n        at: 2026-10-21T00:00:00Z\n        ruling: maintainer-pr\n', []],
  ] as const)("a bootstrapped checkpoint Epic, %s (Story 4.4)", (_name, entries, want) => {
    const gates = `schema_version: 1\nepics:${entries === "" ? " {}" : ""}\n${entries}`;
    const d = digest(world({ epicsYaml: "version: 1\nepics:\n  1:\n    checkpoint: true\n", files: { [RETRO]: gates } }));
    expect(itemLines(d)).toEqual(want.length === 0 ? {} : { edanisko: [...want] });
  });

  test("an unmanifested heading of a bootstrapped Epic is not listed", () => {
    const d = digest(world({ epics: { 1: ["1"], 2: ["1"] }, bootstrapped: [1], manifests: [{ id: "2.1" }] }));
    expect(d.size).toBe(0);
  });
});

describe("renderDigest: the body", () => {
  const records = [
    parked("2.2", { kind: "blocked", reason: "intent-gap", inbox_owner: "alice", text: "Which inbox owns graph PRs?\n\nAsk @bob first." }, { pr: 12 }),
    parked("2.1", { kind: "awaiting-approval", reason: null, inbox_owner: "alice" }, { pr: 7, heartbeat_at: DAY(0) }),
  ];

  test("sections in a fixed order, items sorted, the park text quoted under its item", () => {
    expect(digest(world({ records })).get("alice")).toEqual({
      count: 2,
      body: [
        "🤖 Xarabot inbox: 2 items wait on you.",
        "",
        "### Awaiting approval (1)",
        "",
        `- [story:2.1](${REPO}/pull/7) · awaiting approval · <1d`,
        "",
        "### Blocked (1)",
        "",
        `- [story:2.2](${REPO}/pull/12) · blocked \`intent-gap\` · 2d`,
        "  > Which inbox owns graph PRs?",
        "  >",
        "  > Ask bob first.",
        "",
        "Each reconcile run rewrites this list; ages are in whole days.",
        "",
      ].join("\n"),
    });
  });

  test("deterministic: the same snapshot renders the same bodies", () => {
    const w = world({ records });
    expect(digest(w)).toEqual(digest(w));
  });

  test("never an @mention, and capped at the forge's body limit", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      parked(`2.${i + 1}`, { kind: "blocked", reason: "other", inbox_owner: "alice", text: `@carol ${"x".repeat(3_990)}` }, { pr: i + 1 }),
    );
    const d = digest(world({ epics: { 1: [], 2: many.map((_, i) => String(i + 1)) }, records: many }));
    const body = d.get("alice")?.body ?? "";
    expect(d.get("alice")?.count).toBe(30);
    expect(body.length).toBeLessThanOrEqual(FORGE_TEXT_LIMITS.body);
    expect(body).toEndWith("[truncated by xarabot]");
    expect(/(?<![\w`])@[A-Za-z0-9]/.test(body)).toBe(false);
  });

  test("the empty body mentions no one", () => {
    expect(EMPTY_INBOX_BODY).not.toContain("@");
  });
});

describe("ageText", () => {
  test.each([
    ["2026-10-22T10:10:00Z", "<1d"],
    ["2026-10-21T10:10:01Z", "<1d"],
    ["2026-10-21T10:10:00Z", "1d"],
    ["2026-10-19", "3d"],
    ["2026-10-23T00:00:00Z", "<1d"],
  ] as const)("since %s: %s", (since, want) => {
    expect(ageText("2026-10-22T10:10:00Z", since)).toBe(want);
  });
});

describe("dismissals (Story 4.6)", () => {
  const blocked = parked("2.1", { kind: "blocked", reason: "intent-gap", inbox_owner: "alice" });
  const claim = (dismissals: readonly Dismissal[]): CoordinatorRecord => ({
    schema_version: 6,
    owner: "carol",
    host: "33333333-3333-4333-8333-333333333333",
    lane: "coordinator",
    generation: 1,
    heartbeat_at: DAY(0),
    digest_posted_at: null,
    rulings_cursor: null,
    dismissals: [...dismissals],
  });
  const gates = { [RETRO]: RETRO_GATES };
  const ITEM = "retro-item:epic-1-retro-item-1-fix-the-gate";

  test("inboxInstance gives an item's text and start time as the digest shows them, or null when no inbox lists it", () => {
    const snapshot = snapshotOf(world({ records: [blocked], files: gates }));
    expect(inboxInstance(snapshot, "story:2.1")).toEqual({ subject: "blocked `intent-gap`", since: DAY(2) });
    expect(inboxInstance(snapshot, ITEM)).toEqual({ subject: "Epic 1 · open, blocking: Fix the gate for bob,.", since: DAY(3) });
    expect(inboxInstance(snapshot, "retro:1")).toEqual({ subject: "rejected, no go", since: DAY(3) });
    expect(inboxInstance(snapshot, "story:2.2")).toBeNull();
    expect(inboxInstance(snapshot, "retro-item:epic-1-retro-item-3-done")).toBeNull();
  });

  test("a dismissed item is left out of its owner's inbox, and an owner left with none gets no body", () => {
    const base = world({ records: [blocked], files: gates });
    const before = digest(base);
    expect(itemLines(before)["alice"]).toHaveLength(1);
    const snapshot = snapshotOf(base);
    const d = digest({ ...base, coordinator: claim([{ unit: "story:2.1", ...(inboxInstance(snapshot, "story:2.1") as { subject: string; since: string }) }, { unit: ITEM, ...(inboxInstance(snapshot, ITEM) as { subject: string; since: string }) }]) });
    expect(d.has("alice")).toBe(false);
    const maintainer = itemLines(d)["edanisko"] ?? [];
    expect(maintainer.some((l) => l.includes(ITEM))).toBe(false);
    expect(maintainer.some((l) => l.includes("[retro:1]"))).toBe(true);
    expect(d.get("edanisko")?.count).toBe((before.get("edanisko")?.count ?? 0) - 1);
  });

  test("the same unit as a new instance (another text or start time) lists again", () => {
    const base = world({ records: [blocked], files: gates });
    const otherText = digest({ ...base, coordinator: claim([{ unit: "story:2.1", subject: "blocked `other`", since: DAY(2) }]) });
    expect(itemLines(otherText)["alice"]).toHaveLength(1);
    const otherStart = digest({ ...base, coordinator: claim([{ unit: "story:2.1", subject: "blocked `intent-gap`", since: DAY(5) }]) });
    expect(itemLines(otherStart)["alice"]).toHaveLength(1);
  });

  test("inboxOwner: a parked record's owner rules a unit that is also a Maintainer item; the Maintainer's otherwise (Epic 4 retro item 7)", () => {
    const parkedItem = parked("9.9", { kind: "blocked", reason: "intent-gap", inbox_owner: "alice" }, { unit: ITEM });
    const parkedHeading = parked("3.1", { kind: "awaiting-approval", reason: null, inbox_owner: "bob" });
    const both = snapshotOf(world({ epics: { 1: [], 2: ["1"], 3: ["1"] }, manifests: [{ id: "2.1" }], records: [parkedItem, parkedHeading], files: gates }));
    expect(inboxOwner(both, ITEM)).toBe("alice");
    expect(inboxInstance(both, ITEM)).toEqual({ subject: "blocked `intent-gap`", since: DAY(2) });
    expect(inboxOwner(both, "story:3.1")).toBe("bob");
    expect(inboxInstance(both, "story:3.1")).toEqual({ subject: "awaiting approval", since: DAY(2) });
    // With no parked record, the same units are the Maintainer's.
    const plain = snapshotOf(world({ epics: { 1: [], 2: ["1"], 3: ["1"] }, manifests: [{ id: "2.1" }], files: gates }));
    expect(inboxOwner(plain, ITEM)).toBe("edanisko");
    expect(inboxOwner(plain, "story:3.1")).toBe("edanisko");
    // A record not parked leaves the Maintainer item the Maintainer's.
    const merging = snapshotOf(world({ epics: { 1: [], 2: ["1"], 3: ["1"] }, manifests: [{ id: "2.1" }], records: [storyRec("3.1", { state: "merging" })], files: gates }));
    expect(inboxOwner(merging, "story:3.1")).toBe("edanisko");
  });

  test("an undated item matches a dismissal with since null", () => {
    const w = world({ epics: { 1: [], 2: ["1"], 3: ["1"] }, manifests: [{ id: "2.1" }] });
    const snapshot = snapshotOf(w);
    expect(inboxInstance(snapshot, "story:3.1")).toEqual({ subject: "Epic 3's heading has no manifest", since: null });
    const d = digest({ ...w, coordinator: claim([{ unit: "story:3.1", subject: "Epic 3's heading has no manifest", since: null }]) });
    expect((itemLines(d)["edanisko"] ?? []).some((l) => l.includes("story:3.1"))).toBe(false);
  });
});
