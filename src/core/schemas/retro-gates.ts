import { z } from "zod";
import { normalizeGlob } from "../manifests/globs.ts";
import { GitHubLogin, IsoDateTime, NonEmpty, SchemaVersion } from "./common.ts";
import { EpicKey } from "./epics-yaml.ts";

/** A recorded go: who, when, and the ruling (`maintainer-pr` for one written by hand before Story 4.6). */
export const GoSchema = z.strictObject({
  by: GitHubLogin,
  at: IsoDateTime,
  ruling: NonEmpty,
});

/** A retro's verdicts, as the stock retro document's frontmatter spells them. */
export const RETRO_VERDICTS = ["accepted", "accepted-with-open-items", "rejected"] as const;
export const RetroVerdict = z.enum(RETRO_VERDICTS);

export const RETRO_UNIT_PATTERN = /^retro:([1-9][0-9]*)$/;
/**
 * A retro item id: `epic-<N>-retro-item-<seq>-<slug>`. The slug is what the
 * stock `bmad-retrospective` `_slugify` emits: runs of Unicode letters, marks,
 * digits and `_`, joined by single `-` (or its 8-hex hash fallback).
 */
export const RETRO_ITEM_ID_PATTERN = /^epic-([1-9][0-9]*)-retro-item-([1-9][0-9]*)-([\p{L}\p{M}\p{N}_]+(?:-[\p{L}\p{M}\p{N}_]+)*)$/u;

export const RetroSchema = z
  .strictObject({
    verdict: RetroVerdict,
    unit: z.string().regex(RETRO_UNIT_PATTERN, 'must be "retro:<N>"'),
    recorded_at: IsoDateTime,
    go: GoSchema.optional(),
  })
  .refine((r) => r.go === undefined || r.verdict === "rejected", {
    message: "go is allowed only for a rejected verdict",
    path: ["go"],
  });

/** A normalized glob; a glob that fails normalization is an issue. */
const Glob = z.string().transform((g, ctx) => {
  const n = normalizeGlob(g);
  if (!n.ok) {
    ctx.addIssue({ code: "custom", message: n.error.message });
    return z.NEVER;
  }
  return n.value;
});

export const RetroItemSchema = z.strictObject({
  id: z.string().regex(RETRO_ITEM_ID_PATTERN, "must be epic-<N>-retro-item-<seq>-<slug>"),
  text: NonEmpty,
  route: z.enum(["lane", "maintainer"]),
  blocking: z.boolean(),
  globs: z.array(Glob),
  status: z.enum(["open", "in-progress", "waiting", "deferred", "done"]),
});

/** A string with at least one non-whitespace character; a pattern, so `z.toJSONSchema` states it. */
const ResultText = z.string().regex(/\S/, "must not be blank");

/**
 * One action item of a `retro` session result (AR15). Its own module's, not
 * `session-result.ts`'s, so the ledger's `retro_result` (Story 2.9) shares it
 * with no import cycle.
 */
export const RetroResultItemSchema = z.strictObject({
  id: z.string().regex(RETRO_ITEM_ID_PATTERN, "must be epic-<N>-retro-item-<seq>-<slug>"),
  text: ResultText,
  route: z.enum(["lane", "maintainer"]),
  blocking: z.boolean(),
  globs: z.array(z.string()),
});

/** A retro result as a ledger record carries it to the merge (Story 2.9): its verdict and items. */
export const RetroRecordResultSchema = z.strictObject({
  verdict: RetroVerdict,
  items: z.array(RetroResultItemSchema),
});

export const CheckpointGoSchema = z.strictObject({ go: GoSchema });

export const RetroGatesEntrySchema = z.strictObject({
  retro: RetroSchema.optional(),
  items: z.array(RetroItemSchema).optional(),
  checkpoint: CheckpointGoSchema.optional(),
});

/** `retro-gates.yaml` (AR13). Every `<N>` in an entry must equal the entry's key. */
export const RetroGatesSchema = z
  .strictObject({
    schema_version: SchemaVersion,
    epics: z.record(EpicKey, RetroGatesEntrySchema),
  })
  .superRefine((file, ctx) => {
    for (const [key, entry] of Object.entries(file.epics)) {
      const unit = entry.retro === undefined ? undefined : RETRO_UNIT_PATTERN.exec(entry.retro.unit);
      if (unit != null && unit[1] !== key) {
        ctx.addIssue({ code: "custom", message: `must be "retro:${key}"`, path: ["epics", key, "retro", "unit"] });
      }
      const seen = new Set<string>();
      (entry.items ?? []).forEach((item, i) => {
        if (seen.has(item.id)) {
          ctx.addIssue({ code: "custom", message: `repeats item id "${item.id}"`, path: ["epics", key, "items", i, "id"] });
        }
        seen.add(item.id);
        const id = RETRO_ITEM_ID_PATTERN.exec(item.id);
        if (id !== null && id[1] !== key) {
          ctx.addIssue({ code: "custom", message: `must start with "epic-${key}-"`, path: ["epics", key, "items", i, "id"] });
        }
      });
    }
  });

export type RetroResultItem = z.infer<typeof RetroResultItemSchema>;
export type RetroRecordResult = z.infer<typeof RetroRecordResultSchema>;
export type RetroVerdict = z.infer<typeof RetroVerdict>;
export type Go = z.infer<typeof GoSchema>;
export type Retro = z.infer<typeof RetroSchema>;
export type RetroItem = z.infer<typeof RetroItemSchema>;
export type RetroGatesEntry = z.infer<typeof RetroGatesEntrySchema>;
export type RetroGates = z.infer<typeof RetroGatesSchema>;
