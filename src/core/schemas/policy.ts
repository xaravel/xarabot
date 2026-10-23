import { z } from "zod";
import { NonEmpty, SchemaVersion } from "./common.ts";

/** The agent adapters a policy may allow unattended. */
export const AdapterName = z.enum(["claude", "codex", "pi"]);
export type AdapterName = z.infer<typeof AdapterName>;

/** A path glob; a `!` negation is refused so a policy can never remove a mandatory Protected Path. */
const PathGlob = NonEmpty.refine((g) => !g.startsWith("!"), "must not start with ! (negation)");

/** `.xarabot/policy.yaml` (AR21). */
export const PolicySchema = z.strictObject({
  schema_version: SchemaVersion,
  unattended_adapters: z.array(AdapterName).default([]),
  expected_checks: z.array(NonEmpty).default([]),
  protected_paths: z.array(PathGlob).default([]),
  owner_approval_paths: z.array(PathGlob).default([]),
});

export type Policy = z.infer<typeof PolicySchema>;
