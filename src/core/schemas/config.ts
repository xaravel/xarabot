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

/** A `<name>` placeholder in a `glob_coverage` pattern. */
export const COVERAGE_PLACEHOLDER = /<([A-Za-z][A-Za-z0-9_]*)>/g;

/** The placeholder names in `pattern`, in order, each as often as it appears. */
export function coveragePlaceholders(pattern: string): string[] {
  return [...pattern.matchAll(COVERAGE_PLACEHOLDER)].map((m) => m[1] as string);
}

/**
 * One `glob_coverage` pattern: a repo-relative glob, never a negation or a
 * home path, with no backtick or control character, whose only `<` and `>`
 * are `<name>` placeholders, no two of them side by side.
 */
const CoveragePattern = RepoPath.superRefine((p, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (p.startsWith("!") || p.startsWith("~")) issue("must not start with ! or ~");
  if ([...p].some((c) => c === "`" || (c.codePointAt(0) ?? 0) < 0x20 || c === "\u007f")) issue("must have no backtick or control character");
  if (/[<>]/.test(p.replace(COVERAGE_PLACEHOLDER, ""))) issue("may hold < and > only as <name> placeholders");
  if (p.includes("><")) issue("must not put two placeholders side by side");
});

/** The placeholders a needed pattern uses, all of which its row's `path` must hold. */
function placeholdersFrom(path: string, needs: readonly string[], ctx: z.RefinementCtx, field: string): void {
  const have = coveragePlaceholders(path);
  const seen = new Set<string>();
  for (const name of have) {
    if (seen.has(name)) ctx.addIssue({ code: "custom", path: ["path"], message: `repeats the placeholder <${name}>` });
    seen.add(name);
  }
  for (const [i, need] of needs.entries()) {
    for (const name of coveragePlaceholders(need)) {
      if (!seen.has(name)) ctx.addIssue({ code: "custom", path: [field, i], message: `uses <${name}>, which its path does not hold` });
    }
  }
}

/** A `glob_coverage.tests` row: a glob matching `path` needs `test`, its tests. */
export const CoverageTestRowSchema = z
  .strictObject({ path: CoveragePattern, test: CoveragePattern })
  .superRefine((r, ctx) => placeholdersFrom(r.path, [r.test], ctx, "test"));

/**
 * A `glob_coverage.wiring` row: a glob matching `path` (with `only_new`,
 * only a literal path not yet in the tree) needs each of `needs`, and each
 * of `needs_if_present` that some tree file matches.
 */
export const CoverageWiringRowSchema = z
  .strictObject({
    path: CoveragePattern,
    needs: z.array(CoveragePattern).default([]),
    needs_if_present: z.array(CoveragePattern).default([]),
    only_new: z.boolean().default(false),
  })
  .superRefine((r, ctx) => {
    if (r.needs.length + r.needs_if_present.length === 0) {
      ctx.addIssue({ code: "custom", message: "needs or needs_if_present must list at least one glob" });
    }
    placeholdersFrom(r.path, r.needs, ctx, "needs");
    placeholdersFrom(r.path, r.needs_if_present, ctx, "needs_if_present");
  });

/**
 * `glob_coverage` (Epic 3 retro item 14): the globs a manifest's or a lane
 * retro item's glob needs beside it, its tests (`tests`) and the wiring a
 * known kind of change needs (`wiring`). A `<name>` placeholder stands for
 * any text, the same in a row's `path` and its needed globs; every other
 * character matches itself, so `*` in a pattern matches only a `*`.
 */
export const GlobCoverageSchema = z
  .strictObject({
    tests: z.array(CoverageTestRowSchema).min(1).optional(),
    wiring: z.array(CoverageWiringRowSchema).min(1).optional(),
  })
  .refine((c) => c.tests !== undefined || c.wiring !== undefined, { message: "set tests, wiring or both" });

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
  /**
   * The globs that must sit beside a glob (Epic 3 retro item 14): with it,
   * `graph check` warns per manifest, the retro step refuses a lane item, and
   * the graph planning and retro prompts state the table. Without it the rule
   * is off.
   */
  glob_coverage: GlobCoverageSchema.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ManifestsConfig = z.infer<typeof ManifestsConfigSchema>;
export type GlobCoverage = z.infer<typeof GlobCoverageSchema>;
