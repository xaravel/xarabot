import { z } from "zod";
import { IsoDateTime, NonEmpty, SchemaVersion } from "./common.ts";
import { Effort } from "./host.ts";
import { LaneName, UnitId, UnitState } from "./ledger.ts";
import { AdapterName } from "./policy.ts";

/**
 * The lane journal, `journal.jsonl` (AR25, AR28): one JSON line per unit a
 * lane process handled, plus idle and usage-limit spans. Timings come from the host clock;
 * model and effort are the lane's configured values, never what the agent
 * reported.
 */

/** How one lane process ended. */
export const LaneOutcome = z.enum(["progress", "idle", "failed", "stop"]);
export type LaneOutcome = z.infer<typeof LaneOutcome>;

const Count = z.int().min(0);

export const JournalTokensSchema = z.strictObject({
  input: Count,
  output: Count,
  cacheRead: Count,
  cacheCreation: Count,
});

/** A session's cost; `estimate` is `true` unless every run was billed through an API key. */
export const JournalCostSchema = z.strictObject({
  usd: z.number().min(0),
  estimate: z.boolean(),
});

export const UnitJournalRecordSchema = z.strictObject({
  schema_version: SchemaVersion,
  type: z.literal("unit"),
  unit: UnitId,
  lane: LaneName,
  /** The claimed record's generation, or `null` when nothing was claimed. */
  generation: z.int().min(1).nullable(),
  started_at: IsoDateTime,
  ended_at: IsoDateTime,
  duration_ms: Count,
  agent: AdapterName,
  model: NonEmpty,
  effort: Effort,
  /** Summed over the session's runs; `null` when no run reported usage. */
  tokens: JournalTokensSchema.nullable(),
  cost: JournalCostSchema.nullable(),
  /** Agent runs: 0 with no session, 2 with a resume. */
  sessions: Count,
  outcome: LaneOutcome,
  result: z.enum(["done", "blocked", "no-op"]).nullable(),
  /** The ledger state after the unit, or `null` when unknown. */
  state: UnitState.nullable(),
  attempts: Count,
  loopbacks: Count,
  ci_fixes: Count,
  denied_actions: z.array(z.string()),
  reason: z.string().nullable(),
  /** The unit's log file, an absolute path under the lane's `logs/`. */
  log: NonEmpty,
});

export const SpanJournalRecordSchema = z.strictObject({
  schema_version: SchemaVersion,
  type: z.literal("span"),
  span: z.enum(["idle", "usage-limit"]),
  /** `next`'s idle reason, or the usage limit and its reset. */
  reason: NonEmpty,
  started_at: IsoDateTime,
  ended_at: IsoDateTime,
});

export const JournalRecordSchema = z.discriminatedUnion("type", [UnitJournalRecordSchema, SpanJournalRecordSchema]);

export type JournalTokens = z.infer<typeof JournalTokensSchema>;
export type JournalCost = z.infer<typeof JournalCostSchema>;
export type UnitJournalRecord = z.infer<typeof UnitJournalRecordSchema>;
export type SpanJournalRecord = z.infer<typeof SpanJournalRecordSchema>;
export type JournalRecord = z.infer<typeof JournalRecordSchema>;
