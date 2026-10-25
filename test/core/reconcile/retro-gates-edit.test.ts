import { describe, expect, test } from "bun:test";
import { parseRetroGates } from "../../../src/core/graph/retro-gates.ts";
import { applyRetroResults, editRetroGates, serializeRetroGates } from "../../../src/core/reconcile/retro-gates-edit.ts";
import type { RetroGates } from "../../../src/core/schemas/retro-gates.ts";

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
