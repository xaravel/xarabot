import { z } from "zod";
import { NonEmpty, SchemaVersion } from "./common.ts";

export const HumanLiveStepSchema = z.strictObject({
  id: NonEmpty,
  text: NonEmpty,
});

/** `.xarabot/human-live-steps.yaml` (AR21). An empty `steps` list is the opt-out. */
export const HumanLiveStepsSchema = z.strictObject({
  schema_version: SchemaVersion,
  steps: z
    .array(HumanLiveStepSchema)
    .default([])
    .superRefine((steps, ctx) => {
      const seen = new Set<string>();
      steps.forEach((step, i) => {
        if (seen.has(step.id)) {
          ctx.addIssue({ code: "custom", path: [i, "id"], message: `duplicate step id "${step.id}"` });
        }
        seen.add(step.id);
      });
    }),
});

export type HumanLiveStep = z.infer<typeof HumanLiveStepSchema>;
export type HumanLiveSteps = z.infer<typeof HumanLiveStepsSchema>;
