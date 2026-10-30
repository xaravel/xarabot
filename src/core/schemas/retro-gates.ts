import { z } from "zod";
import { normalizeGlob } from "../manifests/globs.ts";
import { GitHubLogin, IsoDateTime, NonEmpty, SchemaVersion } from "./common.ts";
import { EpicKey } from "./epics-yaml.ts";

/**
 * A recorded go: who, when, and the ruling: the ruling comment's id (AD-28),
 * `xarabot-rule` for the Maintainer's host ruling (`HOST_RULING_ID`), or
 * `maintainer-pr` for one written by hand.
 */
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
 * stock `bmad-retrospective` `_slugify` emits: runs of Unicode letters,
 * numbers and `_` (Python's `\w`, which matches no mark), joined by single
 * `-` (or its 8-hex hash fallback). It is also lowercase
 * (`retroItemSlugIssue`) and at most `RETRO_ITEM_SLUG_MAX` code points, which
 * the pattern does not state.
 */
export const RETRO_ITEM_ID_PATTERN = /^epic-([1-9][0-9]*)-retro-item-([1-9][0-9]*)-([\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*)$/u;

/**
 * The longest slug, in code points: the stock `_slugify`'s `maxlen`, so refs
 * and log file names stay short. `checkRetroResult` holds a new retro
 * result's ids to it; `RetroGatesSchema` does not, because `retro-gates.yaml`
 * keeps ids written by hand before the cap with longer slugs.
 */
export const RETRO_ITEM_SLUG_MAX = 40;

/**
 * Why the slug of `id`, an id `RETRO_ITEM_ID_PATTERN` matches, is refused,
 * or `null`: it is not its own lowercase form. The stock slug lowercases, and
 * on the lane host's case-insensitive APFS, case twins (the Kelvin sign among
 * them) would share one ref or file.
 */
export function retroItemSlugIssue(id: string): string | null {
  const slug = RETRO_ITEM_ID_PATTERN.exec(id)?.[3];
  return slug !== undefined && slug !== slug.toLowerCase() ? "its slug must be lowercase" : null;
}

/**
 * An id as the lane host's case-insensitive, normalization-insensitive APFS
 * compares names: NFC, full case folding, NFC again. Two ids with one folded
 * form would share one ref or file.
 */
export const foldRetroItemId = (id: string): string => id.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");

/**
 * The repeats among `ids`, one per id that repeats an earlier one, in order:
 * the same id, the same folded form (`foldRetroItemId`), or the same
 * (epic, seq) pair; only the first that holds is reported.
 */
export function retroItemIdRepeats(ids: readonly string[]): { readonly index: number; readonly message: string }[] {
  const exact = new Set<string>();
  const folded = new Map<string, string>();
  const pairs = new Map<string, string>();
  const out: { index: number; message: string }[] = [];
  ids.forEach((id, index) => {
    const fold = foldRetroItemId(id);
    const m = RETRO_ITEM_ID_PATTERN.exec(id);
    const pair = m === null ? undefined : `${m[1]}-${m[2]}`;
    const sameFold = folded.get(fold);
    const samePair = pair === undefined ? undefined : pairs.get(pair);
    if (exact.has(id)) out.push({ index, message: `repeats item id "${id}"` });
    else if (sameFold !== undefined) out.push({ index, message: `folds (NFC, case) to the same name as item id "${sameFold}"` });
    else if (samePair !== undefined) out.push({ index, message: `repeats the epic and seq of item id "${samePair}"` });
    exact.add(id);
    if (sameFold === undefined) folded.set(fold, id);
    if (pair !== undefined && samePair === undefined) pairs.set(pair, id);
  });
  return out;
}

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

/**
 * `retro-gates.yaml` (AR13). Every `<N>` in an entry must equal the entry's
 * key; an entry's item ids pass `retroItemSlugIssue` and do not repeat
 * (`retroItemIdRepeats`).
 */
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
      const items = entry.items ?? [];
      for (const r of retroItemIdRepeats(items.map((item) => item.id))) {
        ctx.addIssue({ code: "custom", message: r.message, path: ["epics", key, "items", r.index, "id"] });
      }
      items.forEach((item, i) => {
        const id = RETRO_ITEM_ID_PATTERN.exec(item.id);
        if (id !== null && id[1] !== key) {
          ctx.addIssue({ code: "custom", message: `must start with "epic-${key}-"`, path: ["epics", key, "items", i, "id"] });
        }
        const slug = retroItemSlugIssue(item.id);
        if (slug !== null) ctx.addIssue({ code: "custom", message: slug, path: ["epics", key, "items", i, "id"] });
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
