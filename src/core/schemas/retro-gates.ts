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

export const RETRO_UNIT_PATTERN = /^retro:([1-9][0-9]*)$/;
export const RETRO_ITEM_ID_PATTERN = /^epic-([1-9][0-9]*)-retro-item-([1-9][0-9]*)-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export const RetroSchema = z
  .strictObject({
    verdict: z.enum(["accepted", "accepted-with-open-items", "rejected"]),
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

export type Go = z.infer<typeof GoSchema>;
export type Retro = z.infer<typeof RetroSchema>;
export type RetroItem = z.infer<typeof RetroItemSchema>;
export type RetroGatesEntry = z.infer<typeof RetroGatesEntrySchema>;
export type RetroGates = z.infer<typeof RetroGatesSchema>;
