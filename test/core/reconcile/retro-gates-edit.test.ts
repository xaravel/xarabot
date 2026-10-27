import { describe, expect, test } from "bun:test";
import { parseRetroGates } from "../../../src/core/graph/retro-gates.ts";
import { applyItemStatuses, applyItemsDone, applyRetroResults, editRetroGates, serializeRetroGates } from "../../../src/core/reconcile/retro-gates-edit.ts";
import type { RetroGates, RetroItem } from "../../../src/core/schemas/retro-gates.ts";

const PATH = "_bmad-output/implementation-artifacts/retro-gates.yaml";
const AT = "2026-10-25T10:00:00Z";
const GO = { by: "edanisko", at: "2026-10-21T00:00:00Z", ruling: "maintainer-pr" };

const add = (epic: number, verdict: "accepted" | "accepted-with-open-items" | "rejected", ids: readonly string[] = []) => ({
  epic,
  unit: `retro:${epic}`,
  recorded_at: AT,
  result: { verdict, items: ids.map((id) => ({ id, text: `Do ${id}: "quoted", #hash, : colon`, route: "lane" as const, blocking: false, globs: ["src/**", "./docs/*.md"] })) },
});

describe("serializeRetroGates", () => {
  test("an empty file", () => {
    expect(serializeRetroGates({ schema_version: 1, epics: {} })).toBe("schema_version: 1\nepics: {}\n");
  });

  test("Epics by number, every field, and it parses back to the same value", () => {
    const gates: RetroGates = {
      schema_version: 1,
      epics: {
        "10": { checkpoint: { go: GO } },
        "2": {
          retro: { verdict: "rejected", unit: "retro:2", recorded_at: AT, go: GO },
          items: [{ id: "epic-2-retro-item-1-a", text: "A é 'b' \"c\"\nline two", route: "maintainer", blocking: true, globs: [], status: "waiting" }],
        },
        "3": { items: [] },
        "4": {},
      },
    };
    const text = serializeRetroGates(gates);
    expect(text.indexOf('"2":')).toBeLessThan(text.indexOf('"3":'));
    expect(text.indexOf('"4":')).toBeLessThan(text.indexOf('"10":'));
    const back = parseRetroGates(PATH, text);
    if (!back.ok) throw new Error(back.error.message);
    expect(back.value).toEqual(gates);
    expect(serializeRetroGates(back.value)).toBe(text);
  });
});

describe("serializeRetroGates: escaping", () => {
  test("U+2028, U+2029, non-ASCII, astral, control and quote characters round-trip, and the text is printable ASCII", () => {
    const text = 'a\u2028b\u2029c é 日本 😀 tab\there\nnew "q" back\\slash \u0007 \u0085 \u00a0 #x: y';
    const gates: RetroGates = {
      schema_version: 1,
      epics: {
        "2": {
          retro: { verdict: "accepted", unit: "retro:2", recorded_at: AT },
          items: [{ id: "epic-2-retro-item-1-réviser_l-écran", text, route: "lane", blocking: false, globs: ["src/é/**"], status: "open" }],
        },
      },
    };
    const out = serializeRetroGates(gates);
    expect(/^[\x20-\x7e\n]*$/.test(out)).toBe(true);
    expect(out).toContain("\\u2028");
    const back = parseRetroGates(PATH, out);
    if (!back.ok) throw new Error(back.error.message);
    expect(back.value).toEqual(gates);
    const r = editRetroGates(PATH, null, [{ epic: 2, unit: "retro:2", recorded_at: AT, result: { verdict: "accepted", items: [{ id: "epic-2-retro-item-1-a", text, route: "lane", blocking: false, globs: [] }] } }]);
    expect(r.ok).toBe(true);
  });
});

describe("applyRetroResults", () => {
  test("sets retro and appends new items open, globs normalized; an Epic already recorded is left", () => {
    const start: RetroGates = { schema_version: 1, epics: { "1": { retro: { verdict: "accepted", unit: "retro:1", recorded_at: AT } } } };
    const { gates, summary } = applyRetroResults(start, [add(2, "accepted-with-open-items", ["epic-2-retro-item-1-a"]), add(1, "rejected")]);
    expect(gates.epics["1"]).toEqual(start.epics["1"]);
    expect(gates.epics["2"]).toEqual({
      retro: { verdict: "accepted-with-open-items", unit: "retro:2", recorded_at: AT },
      items: [{ id: "epic-2-retro-item-1-a", text: 'Do epic-2-retro-item-1-a: "quoted", #hash, : colon', route: "lane", blocking: false, globs: ["src/**", "docs/*.md"], status: "open" }],
    });
    expect(summary).toEqual(["epics.2.retro: accepted-with-open-items (retro:2)", "epics.2.items: epic-2-retro-item-1-a added as open"]);
  });

  test("no items: no items key", () => {
    expect(applyRetroResults({ schema_version: 1, epics: {} }, [add(2, "accepted")]).gates.epics["2"]).toEqual({ retro: { verdict: "accepted", unit: "retro:2", recorded_at: AT } });
  });
});

describe("editRetroGates", () => {
  test("an absent file starts from schema_version 1 and no Epics", () => {
    const r = editRetroGates(PATH, null, [add(2, "accepted", ["epic-2-retro-item-1-a"])]);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.text.startsWith("schema_version: 1\nepics:\n")).toBe(true);
    const back = parseRetroGates(PATH, r.value.text);
    expect(back.ok && back.value.epics["2"]?.items?.[0]?.status).toBe("open");
  });

  test("a hand-edited file loses its comments, keeps its data", () => {
    const hand = 'schema_version: 1\n# my note\nepics:\n  "1":\n    retro:\n      verdict: rejected\n      unit: "retro:1"\n      recorded_at: 2026-10-20T00:00:00Z\n      go:\n        by: edanisko\n        at: 2026-10-21T00:00:00Z\n        ruling: maintainer-pr\n';
    const r = editRetroGates(PATH, hand, [add(2, "accepted")]);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.text).not.toContain("# my note");
    const back = parseRetroGates(PATH, r.value.text);
    expect(back.ok && back.value.epics["1"]?.retro?.go).toEqual(GO);
  });

  test("a current text that does not parse is invalid", () => {
    const r = editRetroGates(PATH, "schema_version: 1\nepics: [\n", [add(2, "accepted")]);
    expect(r.ok ? "ok" : r.error.kind).toBe("invalid");
  });

  test("a new text that does not re-parse to the value is invalid", () => {
    // A blank item text breaks the schema's non-empty text on the way back.
    const bad = { ...add(2, "accepted"), result: { verdict: "accepted" as const, items: [{ id: "epic-2-retro-item-1-a", text: "", route: "lane" as const, blocking: false, globs: [] }] } };
    const r = editRetroGates(PATH, null, [bad]);
    expect(r.ok ? "ok" : r.error.message).toContain("does not parse");
  });
});

describe("applyItemsDone and editRetroGates: retro items done (Story 2.10)", () => {
  const item = (id: string, status: "open" | "in-progress" | "waiting" | "deferred" | "done") => ({ id, text: `Do ${id}`, route: "lane" as const, blocking: false, globs: ["src/x/**"], status });
  const START: RetroGates = {
    schema_version: 1,
    epics: {
      "2": { retro: { verdict: "accepted-with-open-items", unit: "retro:2", recorded_at: AT }, items: [item("epic-2-retro-item-1-a", "open"), item("epic-2-retro-item-2-b", "deferred"), item("epic-2-retro-item-3-c", "done")] },
      "3": { items: [item("epic-3-retro-item-1-z", "open")] },
    },
  };

  test("sets each listed item not done to done, one summary line each with its old status, in Epic order", () => {
    const { gates, summary } = applyItemsDone(START, [
      { epic: 3, id: "epic-3-retro-item-1-z" },
      { epic: 2, id: "epic-2-retro-item-2-b" },
      { epic: 2, id: "epic-2-retro-item-1-a" },
    ]);
    expect(gates.epics["2"]?.items?.map((i) => i.status)).toEqual(["done", "done", "done"]);
    expect(gates.epics["3"]?.items?.map((i) => i.status)).toEqual(["done"]);
    expect(gates.epics["2"]?.retro).toEqual(START.epics["2"]?.retro);
    expect(summary).toEqual([
      "epics.2.items: epic-2-retro-item-2-b deferred -> done",
      "epics.2.items: epic-2-retro-item-1-a open -> done",
      "epics.3.items: epic-3-retro-item-1-z open -> done",
    ]);
  });

  test("an item already done, an unknown item and an unknown Epic change nothing", () => {
    const { gates, summary } = applyItemsDone(START, [
      { epic: 2, id: "epic-2-retro-item-3-c" },
      { epic: 2, id: "epic-2-retro-item-9-x" },
      { epic: 4, id: "epic-4-retro-item-1-x" },
    ]);
    expect(gates).toEqual(START);
    expect(summary).toEqual([]);
  });

  test("editRetroGates: the additions, then the items done, in one deterministic rewrite", () => {
    const text = serializeRetroGates(START);
    const r = editRetroGates(PATH, text, [add(4, "accepted", ["epic-4-retro-item-1-n"])], [{ epic: 2, id: "epic-2-retro-item-1-a" }]);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.summary).toEqual(["epics.4.retro: accepted (retro:4)", "epics.4.items: epic-4-retro-item-1-n added as open", "epics.2.items: epic-2-retro-item-1-a open -> done"]);
    const back = parseRetroGates(PATH, r.value.text);
    if (!back.ok) throw new Error(back.error.message);
    expect(back.value.epics["2"]?.items?.[0]?.status).toBe("done");
    expect(back.value.epics["4"]?.items?.[0]?.status).toBe("open");
    expect(serializeRetroGates(back.value)).toBe(r.value.text);
    // Deterministic: the same input writes the same text.
    const again = editRetroGates(PATH, text, [add(4, "accepted", ["epic-4-retro-item-1-n"])], [{ epic: 2, id: "epic-2-retro-item-1-a" }]);
    expect(again.ok && again.value.text).toBe(r.value.text);
  });
});

describe("applyRetroResults: Maintainer-routed items are written waiting (Story 4.3)", () => {
  const LANE = "epic-2-retro-item-1-a";
  const MAINT = "epic-2-retro-item-2-b";
  const result = {
    verdict: "accepted-with-open-items" as const,
    items: [
      { id: LANE, text: "Lane work", route: "lane" as const, blocking: false, globs: ["src/**"] },
      { id: MAINT, text: "Ask the Maintainer", route: "maintainer" as const, blocking: true, globs: [] },
    ],
  };
  const addition = { epic: 2, unit: "retro:2", recorded_at: AT, result };

  const cases: readonly { readonly name: string; readonly start: RetroGates; readonly statuses: readonly [RetroItem["status"], RetroItem["status"]]; readonly summary: readonly string[] }[] = [
    {
      name: "a mixed retro: the lane item open, the Maintainer item waiting",
      start: { schema_version: 1, epics: {} },
      statuses: ["open", "waiting"],
      summary: ["epics.2.retro: accepted-with-open-items (retro:2)", `epics.2.items: ${LANE} added as open`, `epics.2.items: ${MAINT} added as waiting`],
    },
    {
      name: "a Maintainer item already listed open keeps open, and is not added again",
      start: { schema_version: 1, epics: { "2": { items: [{ id: MAINT, text: "Ask the Maintainer", route: "maintainer", blocking: true, globs: [], status: "open" }] } } },
      statuses: ["open", "open"],
      summary: ["epics.2.retro: accepted-with-open-items (retro:2)", `epics.2.items: ${LANE} added as open`],
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const { gates, summary } = applyRetroResults(c.start, [addition]);
      const items = gates.epics["2"]?.items ?? [];
      expect(Object.fromEntries(items.map((i) => [i.id, i.status]))).toEqual({ [LANE]: c.statuses[0], [MAINT]: c.statuses[1] });
      expect(gates.epics["2"]?.retro).toEqual({ verdict: "accepted-with-open-items", unit: "retro:2", recorded_at: AT });
      expect(summary).toEqual([...c.summary]);
    });
  }

  test("the item order of the file is kept: listed items first, then the result's new items in result order", () => {
    const start: RetroGates = { schema_version: 1, epics: { "2": { items: [{ id: MAINT, text: "Ask the Maintainer", route: "maintainer", blocking: true, globs: [], status: "open" }] } } };
    expect(applyRetroResults(start, [addition]).gates.epics["2"]?.items?.map((i) => i.id)).toEqual([MAINT, LANE]);
    expect(applyRetroResults({ schema_version: 1, epics: {} }, [addition]).gates.epics["2"]?.items?.map((i) => i.id)).toEqual([LANE, MAINT]);
  });
});

describe("applyItemStatuses and editRetroGates: ruled done and defer (Story 4.3)", () => {
  type Status = "open" | "in-progress" | "waiting" | "deferred" | "done";
  const item = (id: string, status: Status) => ({ id, text: `Do ${id}`, route: "maintainer" as const, blocking: false, globs: [], status });
  const B = "epic-2-retro-item-2-b";
  const C = "epic-2-retro-item-3-c";
  const D = "epic-2-retro-item-4-d";
  const START: RetroGates = {
    schema_version: 1,
    epics: { "2": { retro: { verdict: "accepted-with-open-items", unit: "retro:2", recorded_at: AT }, items: [item(B, "waiting"), item(C, "done"), item(D, "deferred")] } },
  };

  const cases: readonly { readonly name: string; readonly change: { readonly epic: number; readonly id: string; readonly status: "done" | "deferred" }; readonly after: Readonly<Record<string, Status>>; readonly summary: readonly string[] }[] = [
    { name: "ruled done on a waiting item", change: { epic: 2, id: B, status: "done" }, after: { [B]: "done", [C]: "done", [D]: "deferred" }, summary: [`epics.2.items: ${B} waiting -> done`] },
    { name: "ruled defer on a waiting item", change: { epic: 2, id: B, status: "deferred" }, after: { [B]: "deferred", [C]: "done", [D]: "deferred" }, summary: [`epics.2.items: ${B} waiting -> deferred`] },
    { name: "deferred -> done is allowed", change: { epic: 2, id: D, status: "done" }, after: { [B]: "waiting", [C]: "done", [D]: "done" }, summary: [`epics.2.items: ${D} deferred -> done`] },
    { name: "a done item stays done", change: { epic: 2, id: C, status: "deferred" }, after: { [B]: "waiting", [C]: "done", [D]: "deferred" }, summary: [] },
    { name: "an item already at its status is unchanged", change: { epic: 2, id: D, status: "deferred" }, after: { [B]: "waiting", [C]: "done", [D]: "deferred" }, summary: [] },
    { name: "an unknown id is unchanged", change: { epic: 2, id: "epic-2-retro-item-9-x", status: "done" }, after: { [B]: "waiting", [C]: "done", [D]: "deferred" }, summary: [] },
    { name: "an unknown Epic is unchanged", change: { epic: 7, id: B, status: "done" }, after: { [B]: "waiting", [C]: "done", [D]: "deferred" }, summary: [] },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const { gates, summary } = applyItemStatuses(START, [c.change]);
      expect(Object.fromEntries((gates.epics["2"]?.items ?? []).map((i) => [i.id, i.status]))).toEqual({ ...c.after });
      expect(gates.epics["2"]?.retro).toEqual(START.epics["2"]?.retro);
      expect(Object.keys(gates.epics)).toEqual(["2"]);
      expect(summary).toEqual([...c.summary]);
      if (summary.length === 0) expect(gates).toEqual(START);
    });
  }

  test("applyItemsDone is applyItemStatuses with done", () => {
    const done = [{ epic: 2, id: B }, { epic: 2, id: D }];
    expect(applyItemsDone(START, done)).toEqual(applyItemStatuses(START, done.map((d) => ({ ...d, status: "done" as const }))));
  });

  test("editRetroGates applies the ruled statuses last, after the additions and the items done", () => {
    const text = serializeRetroGates(START);
    const r = editRetroGates(PATH, text, [add(4, "accepted", ["epic-4-retro-item-1-n"])], [{ epic: 2, id: D }], [{ epic: 2, id: B, status: "deferred" }, { epic: 2, id: D, status: "deferred" }]);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.summary).toEqual([
      "epics.4.retro: accepted (retro:4)",
      "epics.4.items: epic-4-retro-item-1-n added as open",
      `epics.2.items: ${D} deferred -> done`,
      `epics.2.items: ${B} waiting -> deferred`,
    ]);
    const back = parseRetroGates(PATH, r.value.text);
    if (!back.ok) throw new Error(back.error.message);
    expect(back.value.epics["2"]?.items?.map((i) => i.status)).toEqual(["deferred", "done", "done"]);
    expect(serializeRetroGates(back.value)).toBe(r.value.text);
  });

  test("editRetroGates with only ruled statuses, no additions", () => {
    const r = editRetroGates(PATH, serializeRetroGates(START), [], [], [{ epic: 2, id: B, status: "done" }]);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.summary).toEqual([`epics.2.items: ${B} waiting -> done`]);
  });
});
