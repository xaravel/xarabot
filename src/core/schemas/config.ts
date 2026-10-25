import { z } from "zod";
import { refuseHost } from "../network/hosts.ts";
import { GitHubLogin, NonEmpty, RepoPath, SchemaVersion } from "./common.ts";

/** Package-layer defaults for every optional `.xarabot/config.yaml` field that has one. */
export const CONFIG_DEFAULTS = {
  epics_path: "_bmad-output/planning-artifacts/epics.md",
  sprint_status_path: "_bmad-output/implementation-artifacts/sprint-status.yaml",
  retro_gates_path: "_bmad-output/implementation-artifacts/retro-gates.yaml",
  retro_doc_glob: "_bmad-output/implementation-artifacts/epic-<N>-retro-*.md",
  epic_context_path: "_bmad-output/implementation-artifacts/epic-<N>-context.md",
  live_evidence_glob: "docs/maintainer/evidence/epic-<N>.md",
  bootstrapped_epics: [] as readonly number[],
  digest_time: "08:00",
  story_spec_path: "_bmad-output/implementation-artifacts/spec-<epic>-<story>-*.md",
  branches: { story: "story/", xarabot: "xarabot/" },
  unit_budget_hours: 6,
  ci_max_wait_minutes: 60,
  proxy_hosts: [] as readonly string[],
} as const;

/** A repo-relative path pattern that must contain each placeholder. */
function patternWith(...placeholders: string[]) {
  return RepoPath.refine(
    (p) => placeholders.every((ph) => p.includes(ph)),
    `must contain ${placeholders.join(" and ")}`,
  );
}

/** `manifests`: the manifest directory, plus an optional path-key mapping (both keys or neither). */
export const ManifestsConfigSchema = z
  .strictObject({
    dir: RepoPath,
    path_key: NonEmpty.optional(),
    path_map: z.record(NonEmpty, z.array(NonEmpty).min(1)).optional(),
  })
  .refine((m) => (m.path_key === undefined) === (m.path_map === undefined), {
    message: "path_key and path_map must be set together or not at all",
  });

export const BranchesSchema = z.strictObject({
  story: NonEmpty.default(CONFIG_DEFAULTS.branches.story),
  xarabot: NonEmpty.default(CONFIG_DEFAULTS.branches.xarabot),
});

/**
 * A hostname for the sandbox proxy allowlist: never a GitHub host, an IP
 * literal or `localhost` (`buildAllowlist` refuses the same).
 */
const Hostname = z.string().superRefine((host, ctx) => {
  const why = refuseHost(host);
  if (why !== null) ctx.addIssue({ code: "custom", message: why });
});

/** One command line: non-empty, with no line break and no leading or trailing whitespace. */
const Command = NonEmpty.regex(/^\S(?:[^\r\n]*\S)?$/, "must be one line with no leading or trailing whitespace");

/** `.xarabot/config.yaml` (AR21). */
export const ConfigSchema = z.strictObject({
  schema_version: SchemaVersion,
  runner_version: NonEmpty,
  maintainer: GitHubLogin,
  standing_authority_path: RepoPath,
  epics_path: RepoPath.default(CONFIG_DEFAULTS.epics_path),
  sprint_status_path: RepoPath.default(CONFIG_DEFAULTS.sprint_status_path),
  retro_gates_path: RepoPath.default(CONFIG_DEFAULTS.retro_gates_path),
  retro_doc_glob: patternWith("<N>").default(CONFIG_DEFAULTS.retro_doc_glob),
  epic_context_path: patternWith("<N>").default(CONFIG_DEFAULTS.epic_context_path),
  /** The Maintainer's live evidence file per Epic (Story 2.9): a retro waits for it on `main`; builders never write one. */
  live_evidence_glob: patternWith("<N>").default(CONFIG_DEFAULTS.live_evidence_glob),
  bootstrapped_epics: z.array(z.int().positive()).default([]),
  digest_time: z
    .string()
    .regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/, "must be HH:MM (UTC)")
    .default(CONFIG_DEFAULTS.digest_time),
  manifests: ManifestsConfigSchema.optional(),
  story_spec_path: patternWith("<epic>", "<story>").default(CONFIG_DEFAULTS.story_spec_path),
  branches: BranchesSchema.default({ ...CONFIG_DEFAULTS.branches }),
  unit_budget_hours: z.number().positive().default(CONFIG_DEFAULTS.unit_budget_hours),
  ci_max_wait_minutes: z.int().positive().default(CONFIG_DEFAULTS.ci_max_wait_minutes),
  proxy_hosts: z.array(Hostname).default([]),
  lockfile_command: z.array(NonEmpty).min(1).optional(),
  epic_packages: z.record(z.string().regex(/^[1-9][0-9]*$/, "must be an Epic number"), z.array(NonEmpty).min(1)).optional(),
  /**
   * Epic number → the exact commands its verification Story's runbook
   * requires (retro item 14): the Epic's retro waits until its live evidence
   * file holds each one followed by a `bun test` summary with `0 fail`. An
   * Epic with no entry needs only the file.
   */
  live_evidence_checks: z
    .record(z.string().regex(/^[1-9][0-9]*$/, "must be an Epic number"), z.array(Command).min(1))
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ManifestsConfig = z.infer<typeof ManifestsConfigSchema>;
