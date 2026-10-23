import { z } from "zod";
import { GitHubLogin, NonEmpty, RepoSlug, SchemaVersion } from "./common.ts";
import { ConfigSchema } from "./config.ts";
import { HumanLiveStepsSchema } from "./human-live-steps.ts";
import { AdapterName, PolicySchema } from "./policy.ts";

export const LaneRole = z.enum(["builder", "coordinator"]);
export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);

export const LaneSchema = z.strictObject({
  repo: RepoSlug,
  role: LaneRole,
  owner: GitHubLogin,
  agent: AdapterName,
  model: NonEmpty.optional(),
  effort: Effort.default("high"),
});

/** `host.yaml`, the host layer (AR21). */
export const HostConfigSchema = z.strictObject({
  schema_version: SchemaVersion,
  host_id: z.uuid().optional(),
  lanes: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "must be a lane name ([A-Za-z0-9_-])"), LaneSchema),
});

export type Lane = z.infer<typeof LaneSchema>;
export type HostConfig = z.infer<typeof HostConfigSchema>;

/** Every repo-layer key (config, policy, Human Live Steps); the host layer may set none of them. */
export const REPO_LAYER_KEYS: ReadonlySet<string> = new Set(
  [ConfigSchema, PolicySchema, HumanLiveStepsSchema]
    .flatMap((schema) => Object.keys(schema.shape))
    .filter((key) => key !== "schema_version"),
);
