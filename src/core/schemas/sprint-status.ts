import { z } from "zod";

/**
 * `sprint-status.yaml` as BMAD writes it: a `development_status` map of key →
 * status. Loose: other top-level keys (`action_items`, metadata) pass the
 * parse and are ignored.
 */
export const SprintStatusSchema = z.looseObject({
  development_status: z.record(z.string(), z.string()).default({}),
});

export type SprintStatus = z.infer<typeof SprintStatusSchema>;
