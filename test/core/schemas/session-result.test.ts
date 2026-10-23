import { describe, expect, test } from "bun:test";
import {
  parseSessionResult,
  RESULT_KINDS,
  RESULT_SCHEMAS,
  SessionResultSchema,
  type ResultKind,
} from "../../../src/core/schemas/session-result.ts";

const SHA = "a".repeat(40);

const VALID: Readonly<Record<ResultKind, Record<string, unknown>>> = {
  build: { kind: "build", outcome: "done", summary: "Built it", body: "", verification: ["bun test: pass"], denied_actions: [] },
  review: {
    kind: "review",
    reviewed_sha: SHA,
    verdict: "changes-requested",
    findings: [{ severity: "high", blocking: true, file: "src/a.ts", text: "wrong" }],
    denied_actions: ["git push"],
  },
  retro: {
    kind: "retro",
    verdict: "accepted-with-open-items",
    items: [{ id: "epic-1-retro-item-2-fix-ci", text: "do it", route: "lane", blocking: false, globs: ["src/**"] }],
    denied_actions: [],
  },
  planning: { kind: "planning", outcome: "nothing-due", summary: "nothing", denied_actions: [] },
};

const with_ = (kind: ResultKind, patch: Record<string, unknown>): Record<string, unknown> => ({ ...VALID[kind], ...patch });
const without = (kind: ResultKind, key: string): Record<string, unknown> => {
  const copy = { ...VALID[kind] };
  delete copy[key];
  return copy;
};
const accepts = (v: unknown) => SessionResultSchema.safeParse(v).success;

describe("each kind's valid shape", () => {
  for (const kind of RESULT_KINDS) {
    test(kind, () => {
      expect(SessionResultSchema.parse(VALID[kind])).toEqual(VALID[kind] as never);
      expect(RESULT_SCHEMAS[kind].safeParse(VALID[kind]).success).toBe(true);
    });
  }
});

describe("enumerated fields", () => {
  const blocked = (kind: string) => ({ kind, text: "why", ...(kind === "human-live-step" ? { step_id: "s1" } : {}) });
  const cases: { field: string; accepted: readonly string[]; refused: readonly string[]; make: (v: string) => unknown }[] = [
    {
      field: "build.outcome",
      accepted: ["done", "no-op"],
      refused: ["blocked", "failed", "DONE", ""],
      make: (v) => with_("build", { outcome: v }),
    },
    {
      field: "build.blocked.kind",
      accepted: ["escalation", "human-live-step", "intent-gap", "verification", "other"],
      refused: ["intent gap", "unknown", ""],
      make: (v) => with_("build", { outcome: "blocked", blocked: blocked(v) }),
    },
    {
      field: "review.verdict",
      accepted: ["pass", "changes-requested"],
      refused: ["fail", "approved", ""],
      make: (v) => with_("review", { verdict: v }),
    },
    {
      field: "review.findings[].severity",
      accepted: ["high", "medium", "low"],
      refused: ["critical", "HIGH", ""],
      make: (v) => with_("review", { findings: [{ severity: v, blocking: false, file: "a.ts", text: "t" }] }),
    },
    {
      field: "retro.verdict",
      accepted: ["accepted", "accepted-with-open-items", "rejected"],
      refused: ["pass", ""],
      make: (v) => with_("retro", { verdict: v }),
    },
    {
      field: "retro.items[].route",
      accepted: ["lane", "maintainer"],
      refused: ["coordinator", ""],
      make: (v) => with_("retro", { items: [{ id: "epic-1-retro-item-1-a", text: "t", route: v, blocking: true, globs: [] }] }),
    },
    {
      field: "planning.outcome",
      accepted: ["done", "nothing-due", "blocked"],
      refused: ["no-op", ""],
      make: (v) => with_("planning", { outcome: v }),
    },
  ];
  for (const c of cases) {
    test(c.field, () => {
      expect(c.accepted.filter((v) => !accepts(c.make(v)))).toEqual([]);
      expect(c.refused.filter((v) => accepts(c.make(v)))).toEqual([]);
    });
  }
});

describe("build: blocked and step_id", () => {
  const cases: { name: string; patch: Record<string, unknown>; ok: boolean }[] = [
    { name: "blocked outcome with blocked", patch: { outcome: "blocked", blocked: { kind: "other", text: "x" } }, ok: true },
    { name: "blocked outcome without blocked", patch: { outcome: "blocked" }, ok: false },
    { name: "done with blocked", patch: { outcome: "done", blocked: { kind: "other", text: "x" } }, ok: false },
    { name: "no-op with blocked", patch: { outcome: "no-op", blocked: { kind: "other", text: "x" } }, ok: false },
    {
      name: "human-live-step with step_id",
      patch: { outcome: "blocked", blocked: { kind: "human-live-step", text: "x", step_id: "dns" } },
      ok: true,
    },
    { name: "human-live-step without step_id", patch: { outcome: "blocked", blocked: { kind: "human-live-step", text: "x" } }, ok: false },
    {
      name: "human-live-step with empty step_id",
      patch: { outcome: "blocked", blocked: { kind: "human-live-step", text: "x", step_id: "" } },
      ok: false,
    },
    ...(["escalation", "intent-gap", "verification", "other"] as const).map((kind) => ({
      name: `${kind} with step_id`,
      patch: { outcome: "blocked", blocked: { kind, text: "x", step_id: "dns" } },
      ok: false,
    })),
    { name: "blocked with empty text", patch: { outcome: "blocked", blocked: { kind: "other", text: "" } }, ok: false },
    { name: "empty summary", patch: { summary: "" }, ok: false },
    { name: "blank summary", patch: { summary: " \n\t" }, ok: false },
    { name: "blank blocked text", patch: { outcome: "blocked", blocked: { kind: "other", text: "  " } }, ok: false },
    {
      name: "blank step_id",
      patch: { outcome: "blocked", blocked: { kind: "human-live-step", text: "x", step_id: " " } },
      ok: false,
    },
    { name: "empty verification item", patch: { verification: [""] }, ok: false },
    { name: "blank verification item", patch: { verification: ["ok", "  "] }, ok: false },
    { name: "blank denied action", patch: { denied_actions: [" "] }, ok: false },
    { name: "empty body", patch: { body: "" }, ok: true },
    { name: "non-string verification", patch: { verification: [1] }, ok: false },
  ];
  for (const c of cases) {
    test(c.name, () => {
      expect(accepts(with_("build", c.patch))).toBe(c.ok);
    });
  }
});

describe("other field rules", () => {
  const cases: { name: string; value: unknown; ok: boolean }[] = [
    { name: "review: 64-hex sha", value: with_("review", { reviewed_sha: "b".repeat(64) }), ok: true },
    { name: "review: short sha", value: with_("review", { reviewed_sha: "abc123" }), ok: false },
    { name: "review: uppercase sha", value: with_("review", { reviewed_sha: "A".repeat(40) }), ok: false },
    {
      name: "review: absolute file",
      value: with_("review", { findings: [{ severity: "low", blocking: false, file: "/etc/passwd", text: "t" }] }),
      ok: false,
    },
    {
      name: "review: blocking not boolean",
      value: with_("review", { findings: [{ severity: "low", blocking: "yes", file: "a.ts", text: "t" }] }),
      ok: false,
    },
    {
      name: "review: blank finding text",
      value: with_("review", { findings: [{ severity: "low", blocking: false, file: "a.ts", text: " \n" }] }),
      ok: false,
    },
    {
      name: "retro: blank item text",
      value: with_("retro", { items: [{ id: "epic-1-retro-item-1-a", text: "  ", route: "lane", blocking: true, globs: [] }] }),
      ok: false,
    },
    { name: "review: no findings", value: with_("review", { verdict: "pass", findings: [] }), ok: true },
    {
      name: "retro: bad item id",
      value: with_("retro", { items: [{ id: "item-1", text: "t", route: "lane", blocking: true, globs: [] }] }),
      ok: false,
    },
    {
      name: "retro: globs missing",
      value: with_("retro", { items: [{ id: "epic-2-retro-item-3-x", text: "t", route: "lane", blocking: true }] }),
      ok: false,
    },
    { name: "planning: empty summary", value: with_("planning", { summary: "" }), ok: false },
    { name: "unknown kind", value: with_("planning", { kind: "checkpoint" }), ok: false },
    { name: "kind missing", value: without("planning", "kind"), ok: false },
  ];
  for (const c of cases) {
    test(c.name, () => {
      expect(accepts(c.value)).toBe(c.ok);
    });
  }
});

describe("strictness and denied_actions", () => {
  for (const kind of RESULT_KINDS) {
    test(`${kind}: extra key refused`, () => {
      expect(accepts(with_(kind, { tokens: 12 }))).toBe(false);
    });
    test(`${kind}: denied_actions required`, () => {
      expect(accepts(without(kind, "denied_actions"))).toBe(false);
    });
    test(`${kind}: denied_actions must be strings`, () => {
      expect(accepts(with_(kind, { denied_actions: [{ action: "x" }] }))).toBe(false);
    });
  }
  test("extra key inside blocked refused", () => {
    expect(accepts(with_("build", { outcome: "blocked", blocked: { kind: "other", text: "x", extra: 1 } }))).toBe(false);
  });
  test("extra key inside a finding refused", () => {
    const finding = { severity: "low", blocking: false, file: "a.ts", text: "t", line: 3 };
    expect(accepts(with_("review", { findings: [finding] }))).toBe(false);
  });
});

describe("parseSessionResult", () => {
  const P = "/tmp/x/result.json";
  test("valid build", () => {
    expect(parseSessionResult(P, JSON.stringify(VALID.build), "build")).toEqual({ ok: true, value: VALID.build as never });
  });
  test("valid review", () => {
    expect(parseSessionResult(P, JSON.stringify(VALID.review), "review")).toEqual({ ok: true, value: VALID.review as never });
  });
  test("a leading UTF-8 BOM is skipped", () => {
    expect(parseSessionResult(P, `\uFEFF${JSON.stringify(VALID.build)}`, "build")).toEqual({
      ok: true,
      value: VALID.build as never,
    });
  });

  const cases: { name: string; text: string; expected: ResultKind; kind: string; message: RegExp }[] = [
    { name: "not JSON", text: "{nope", expected: "build", kind: "invalid-json", message: /^\/tmp\/x\/result\.json: invalid JSON/ },
    { name: "empty file", text: "", expected: "build", kind: "invalid-json", message: /invalid JSON/ },
    { name: "array", text: "[]", expected: "build", kind: "invalid", message: /result\.json: / },
    { name: "null", text: "null", expected: "planning", kind: "invalid", message: /result\.json: / },
    {
      name: "schema miss names the fields",
      text: JSON.stringify(with_("build", { summary: "", verification: "x" })),
      expected: "build",
      kind: "invalid",
      message: /summary: .*verification: /,
    },
    {
      name: "unknown kind",
      text: JSON.stringify(with_("planning", { kind: "checkpoint" })),
      expected: "planning",
      kind: "invalid",
      message: /kind: /,
    },
    {
      name: "other kind than expected",
      text: JSON.stringify(VALID.review),
      expected: "build",
      kind: "wrong-kind",
      message: /expected a "build" result, got "review"/,
    },
    {
      name: "other kind, also invalid",
      text: JSON.stringify(with_("planning", { summary: "" })),
      expected: "retro",
      kind: "wrong-kind",
      message: /got "planning"/,
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const r = parseSessionResult(P, c.text, c.expected);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe(c.kind as never);
      expect(r.error.message).toMatch(c.message);
    });
  }
});
