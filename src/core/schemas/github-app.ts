import { z } from "zod";
import { NonEmpty } from "./common.ts";

/**
 * `app.json` beside a lane bot's App key (FR13, AR27): the App's numeric `id`
 * and its `slug`. Other keys GitHub's manifest flow writes are allowed and
 * dropped.
 */
export const AppRecordSchema = z.object({
  id: z.number().int().positive(),
  slug: NonEmpty,
});

export type AppRecord = z.infer<typeof AppRecordSchema>;
