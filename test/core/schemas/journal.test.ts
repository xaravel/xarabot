import { describe, expect, test } from "bun:test";
import {
  JournalRecordSchema,
  LaneOutcome,
  SpanJournalRecordSchema,
  UnitJournalRecordSchema,
} from "../../../src/core/schemas/journal.ts";

const UNIT: Record<string, unknown> = {
  schema_version: 1,
  type: "unit",
  unit: "story:1.1",
  lane: "builder-1",
  generation: 1,
  started_at: "2026-10-23T10:00:00.000Z",
  ended_at: "2026-10-23T10:05:00.000Z",
  duration_ms: 300_000,
  agent: "claude",
  model: "claude-opus-5-5",
  effort: "high",
  tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 1 },
  cost: { usd: 0.25, estimate: true },
  sessions: 1,
  outcome: "progress",
  result: "done",
  state: "claimed",
  attempts: 0,
  loopbacks: 0,
  ci_fixes: 0,
  denied_actions: [],
  reason: null,
  log: "/lane/logs/story__1.1-2026-10-23T10-00-00Z.log",
};

const SPAN: Record<string, unknown> = {
  schema_version: 1,
  type: "span",
  span: "idle",
  reason: "no Story left to build",
  started_at: "2026-10-23T10:00:00Z",
  ended_at: "2026-10-23T10:00:01Z",
};

const u = (patch: Record<string, unknown>) => ({ ...UNIT, ...patch });
const s = (patch: Record<string, unknown>) => ({ ...SPAN, ...patch });

describe("journal records", () => {
  const cases: readonly [string, unknown, boolean][] = [
    ["a full unit record", UNIT, true],
    ["a unit record with nothing claimed or run", u({ generation: null, tokens: null, cost: null, sessions: 0, result: null, state: null, reason: "stop" }), true],
    ["every lane outcome", u({ outcome: "stop" }), true],
    ["a no-op result", u({ result: "no-op" }), true],
    ["a blocked park's wip ref", u({ result: "blocked", state: "parked", wip_ref: "refs/wip/story__2.5a" }), true],
    ["an empty wip ref", u({ wip_ref: "" }), false],
    ["a null wip ref", u({ wip_ref: null }), false],
    ["the model a run reported", u({ reported_model: "claude-sonnet-5-5" }), true],
    ["an empty reported model", u({ reported_model: "" }), false],
    ["a null reported model", u({ reported_model: null }), false],
    ["schema_version 2", u({ schema_version: 2 }), false],
    ["an unknown outcome", u({ outcome: "done" }), false],
    ["an unknown result", u({ result: "ready-for-dev" }), false],
    ["a non-unit id", u({ unit: "1.1" }), false],
    ["an unknown lane name", u({ lane: "main" }), false],
    ["generation 0", u({ generation: 0 }), false],
    ["a negative duration", u({ duration_ms: -1 }), false],
    ["an unknown agent", u({ agent: "gpt" }), false],
    ["an unknown effort", u({ effort: "huge" }), false],
    ["an unknown state", u({ state: "done" }), false],
    ["partial tokens", u({ tokens: { input: 1 } }), false],
    ["a negative cost", u({ cost: { usd: -1, estimate: false } }), false],
    ["a missing field", (({ log: _log, ...rest }) => rest)(UNIT), false],
    ["an extra field", u({ extra: 1 }), false],
    ["a non-ISO time", u({ started_at: "yesterday" }), false],
    ["an empty log path", u({ log: "" }), false],
    ["an idle span", SPAN, true],
    ["a usage-limit span", s({ span: "usage-limit", reason: "usage limit; reset unknown" }), true],
    ["a span of another kind", s({ span: "waiting" }), false],
    ["a span with an empty reason", s({ reason: "" }), false],
    ["a span with an extra field", s({ unit: "story:1.1" }), false],
    ["an unknown type", s({ type: "other" }), false],
  ];
  test.each(cases)("%s", (_name, record, valid) => {
    expect(JournalRecordSchema.safeParse(record).success).toBe(valid);
  });

  test("each kind parses only against its own schema", () => {
    expect(UnitJournalRecordSchema.safeParse(UNIT).success).toBe(true);
    expect(UnitJournalRecordSchema.safeParse(SPAN).success).toBe(false);
    expect(SpanJournalRecordSchema.safeParse(SPAN).success).toBe(true);
    expect(SpanJournalRecordSchema.safeParse(UNIT).success).toBe(false);
  });

  test("lane outcomes are progress, idle, failed and stop", () => {
    expect(LaneOutcome.options).toEqual(["progress", "idle", "failed", "stop"]);
  });
});
