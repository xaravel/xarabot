import { z } from "zod";

/** An Epic number as a map key: `^[1-9][0-9]*$`. */
export const EPIC_KEY_PATTERN = /^[1-9][0-9]*$/;

export const EpicKey = z.string().regex(EPIC_KEY_PATTERN, "must be an Epic number (^[1-9][0-9]*$)");

/** One `.xarabot/epics.yaml` entry; `depends_on` duplicates are dropped. */
export const EpicEntrySchema = z.strictObject({
  depends_on: z
    .array(z.int().positive())
    .transform((deps) => [...new Set(deps)])
    .optional(),
  checkpoint: z.literal(true).optional(),
});

/** `.xarabot/epics.yaml` (AD-11, AR12). */
export const EpicsYamlSchema = z.strictObject({
  version: z.literal(1),
  epics: z.record(EpicKey, EpicEntrySchema),
});

export type EpicEntry = z.infer<typeof EpicEntrySchema>;
export type EpicsYaml = z.infer<typeof EpicsYamlSchema>;
