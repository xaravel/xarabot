import { z } from "zod";
import { err, ok, type Result } from "../result.ts";
import { describeIssues, RepoPath } from "./common.ts";
import { GitSha } from "./ledger.ts";
import { RETRO_ITEM_ID_PATTERN } from "./retro-gates.ts";

/**
 * Session results (AR15, AD-14): the JSON a session writes to
 * `$XARABOT_RESULT` as the prompt's last step. One strict shape per unit
 * kind, keyed by `kind`; every kind carries `denied_actions`. The build rules
 * are nested discriminated unions, not refinements, so `z.toJSONSchema`
 * states them and the prompt can embed that JSON Schema.
 */

export const RESULT_KINDS = ["build", "review", "retro", "planning"] as const;
export type ResultKind = (typeof RESULT_KINDS)[number];

/** A string with at least one non-whitespace character; a pattern, so `z.toJSONSchema` states it. */
const Text = z.string().regex(/\S/, "must not be blank");

/** Actions the agent's permission mode refused; reported, never worked around. */
const DeniedActions = z.array(Text);

/** `blocked`: `step_id` exactly for `human-live-step`. */
export const BuildBlockedSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("human-live-step"),
    text: Text,
    step_id: Text,
  }),
  z.strictObject({
    kind: z.enum(["escalation", "intent-gap", "verification", "other"]),
    text: Text,
  }),
]);

const buildFields = {
  kind: z.literal("build"),
  summary: Text,
  body: z.string(),
  verification: z.array(Text),
  denied_actions: DeniedActions,
};

/** `build`: `blocked` present exactly when `outcome` is `blocked`. */
export const BuildResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ ...buildFields, outcome: z.literal("blocked"), blocked: BuildBlockedSchema }),
  z.strictObject({ ...buildFields, outcome: z.enum(["done", "no-op"]) }),
]);

export const ReviewFindingSchema = z.strictObject({
  severity: z.enum(["high", "medium", "low"]),
  blocking: z.boolean(),
  file: RepoPath,
  text: Text,
});

export const ReviewResultSchema = z.strictObject({
  kind: z.literal("review"),
  reviewed_sha: GitSha,
  verdict: z.enum(["pass", "changes-requested"]),
  findings: z.array(ReviewFindingSchema),
  denied_actions: DeniedActions,
});

export const RetroResultItemSchema = z.strictObject({
  id: z.string().regex(RETRO_ITEM_ID_PATTERN, "must be epic-<N>-retro-item-<seq>-<slug>"),
  text: Text,
  route: z.enum(["lane", "maintainer"]),
  blocking: z.boolean(),
  globs: z.array(z.string()),
});

export const RetroResultSchema = z.strictObject({
  kind: z.literal("retro"),
  verdict: z.enum(["accepted", "accepted-with-open-items", "rejected"]),
  items: z.array(RetroResultItemSchema),
  denied_actions: DeniedActions,
});

export const PlanningResultSchema = z.strictObject({
  kind: z.literal("planning"),
  outcome: z.enum(["done", "nothing-due", "blocked"]),
  summary: Text,
  denied_actions: DeniedActions,
});

export const SessionResultSchema = z.discriminatedUnion("kind", [
  BuildResultSchema,
  ReviewResultSchema,
  RetroResultSchema,
  PlanningResultSchema,
]);

/** Each kind's schema, by `kind`. */
export const RESULT_SCHEMAS = {
  build: BuildResultSchema,
  review: ReviewResultSchema,
  retro: RetroResultSchema,
  planning: PlanningResultSchema,
} as const;

export type BuildBlocked = z.infer<typeof BuildBlockedSchema>;
export type BuildResult = z.infer<typeof BuildResultSchema>;
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
export type RetroResultItem = z.infer<typeof RetroResultItemSchema>;
export type RetroResult = z.infer<typeof RetroResultSchema>;
export type PlanningResult = z.infer<typeof PlanningResultSchema>;
export type SessionResult = z.infer<typeof SessionResultSchema>;
export type SessionResultOf<K extends ResultKind> = z.infer<(typeof RESULT_SCHEMAS)[K]>;

export type ParseResultError = "invalid-json" | "invalid" | "wrong-kind";

function isResultKind(v: unknown): v is ResultKind {
  return typeof v === "string" && (RESULT_KINDS as readonly string[]).includes(v);
}

/**
 * Parses the text of a result file against the schema of the `expected`
 * kind. Non-JSON is `invalid-json`; a known `kind` other than `expected` is
 * `wrong-kind`; anything else that misses the schema is `invalid`, naming
 * each offending field.
 */
export function parseSessionResult<K extends ResultKind>(
  path: string,
  text: string,
  expected: K,
): Result<SessionResultOf<K>, ParseResultError> {
  let json: unknown;
  try {
    json = JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err("invalid-json", `${path}: invalid JSON: ${reason}`);
  }
  if (json !== null && typeof json === "object" && !Array.isArray(json)) {
    const kind = (json as Record<string, unknown>)["kind"];
    if (isResultKind(kind) && kind !== expected) {
      return err("wrong-kind", `${path}: expected a "${expected}" result, got "${kind}"`);
    }
  }
  const parsed = RESULT_SCHEMAS[expected].safeParse(json);
  if (!parsed.success) return err("invalid", `${path}: ${describeIssues(parsed.error)}`);
  return ok(parsed.data as SessionResultOf<K>);
}
