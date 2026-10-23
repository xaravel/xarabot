import { z } from "zod";
import { err, ok, type Result } from "../result.ts";
import { describeIssues, IsoDateTime, NonEmpty, parseVersioned, parseVersionedYaml, parseYaml, RepoSlug } from "../schemas/common.ts";
import { CONFIG_DEFAULTS, ConfigSchema, type Config } from "../schemas/config.ts";
import { HumanLiveStepsSchema, type HumanLiveSteps } from "../schemas/human-live-steps.ts";
import { PolicySchema, type Policy } from "../schemas/policy.ts";
import { StandingAuthorityFrontmatterSchema, type StandingAuthority } from "../schemas/standing-authority.ts";
import { effectiveProtectedPaths, MANDATORY_PROTECTED_PATHS } from "./protected-paths.ts";

export const CONFIG_PATH = ".xarabot/config.yaml";
export const POLICY_PATH = ".xarabot/policy.yaml";
export const HUMAN_LIVE_STEPS_PATH = ".xarabot/human-live-steps.yaml";
export const EPICS_YAML_PATH = ".xarabot/epics.yaml";

/** Why a lane stops on its repo config. */
export type ConfigStopKind =
  | "invalid-snapshot"
  | "missing"
  | "unreadable"
  | "invalid-yaml"
  | "unsupported-version"
  | "invalid"
  | "authority-granted-by"
  | "authority-repo"
  | "authority-expired";

/** One `main` snapshot: its tree listing, the contents of the files read, the repo slug and the server's `now`. */
export const RepoSnapshotSchema = z.strictObject({
  repo: RepoSlug,
  now: IsoDateTime,
  tree: z.array(NonEmpty),
  files: z.record(z.string(), z.string()),
});

export type RepoSnapshot = z.infer<typeof RepoSnapshotSchema>;

export type PackageLayer = {
  readonly defaults: typeof CONFIG_DEFAULTS;
  readonly mandatoryProtectedPaths: readonly string[];
};

export type RepoLayer = {
  readonly config: Config;
  readonly policy: Policy & { readonly effective_protected_paths: readonly string[] };
  readonly humanLiveSteps: HumanLiveSteps;
  readonly standingAuthority: StandingAuthority;
  /** Raw `.xarabot/epics.yaml` text, or `null` when `main` has none (Epics then run serially). */
  readonly epicsYaml: string | null;
};

export type RepoConfig = { readonly package: PackageLayer; readonly repo: RepoLayer };

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A file's text from the snapshot: `missing` when the tree lacks it, `unreadable` when its content was not supplied. */
function readFile(snap: RepoSnapshot, path: string): Result<string, "missing" | "unreadable"> {
  if (!snap.tree.includes(path)) return err("missing", `${path}: missing on main`);
  const text = Object.hasOwn(snap.files, path) ? snap.files[path] : undefined;
  if (typeof text !== "string") return err("unreadable", `${path}: listed in the tree but its content was not read`);
  return ok(text);
}

/**
 * Splits a Markdown file into YAML frontmatter and body. The frontmatter sits
 * between a leading `---` line and the next `---` line.
 */
export function splitFrontmatter(path: string, text: string): Result<{ yaml: string; body: string }, "invalid"> {
  const lines = (text.startsWith("\uFEFF") ? text.slice(1) : text).split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") {
    return err("invalid", `${path}: no YAML frontmatter (the file must start with a --- line)`);
  }
  const close = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---");
  if (close === -1) return err("invalid", `${path}: frontmatter has no closing --- line`);
  return ok({ yaml: lines.slice(1, close).join("\n"), body: lines.slice(close + 1).join("\n") });
}

/** The instant after which `expires` no longer holds; a date-only value lasts to the end of that UTC day. */
function expiryInstant(expires: string): number {
  if (DATE_ONLY.test(expires)) return Date.parse(`${expires}T00:00:00Z`) + DAY_MS;
  return Date.parse(expires);
}

function readStandingAuthority(
  snap: RepoSnapshot,
  config: Config,
): Result<StandingAuthority, ConfigStopKind> {
  const path = config.standing_authority_path;
  const text = readFile(snap, path);
  if (!text.ok) return text;
  const split = splitFrontmatter(path, text.value);
  if (!split.ok) return split;
  const yaml = parseYaml(path, split.value.yaml);
  if (!yaml.ok) return err("invalid", yaml.error.message);
  const frontmatter = parseVersioned(path, yaml.value, StandingAuthorityFrontmatterSchema);
  if (!frontmatter.ok) return frontmatter;
  const fm = frontmatter.value;

  if (fm.granted_by.toLowerCase() !== config.maintainer.toLowerCase()) {
    return err(
      "authority-granted-by",
      `${path}: granted_by "${fm.granted_by}" is not the configured maintainer "${config.maintainer}"`,
    );
  }
  if (fm.repo.toLowerCase() !== snap.repo.toLowerCase()) {
    return err("authority-repo", `${path}: repo "${fm.repo}" is not this repo "${snap.repo}"`);
  }
  if (fm.expires !== undefined) {
    const until = expiryInstant(fm.expires);
    if (!Number.isFinite(until) || Date.parse(snap.now) >= until) {
      return err("authority-expired", `${path}: expired ${fm.expires} (now ${snap.now})`);
    }
  }
  return ok({ frontmatter: fm, body: split.value.body });
}

/**
 * Loads the package and repo config layers from one `main` snapshot, or
 * returns the stop error that should halt the lane (FR22, AR21, AR22). Pure:
 * reads nothing but `snap`.
 */
export function loadRepoConfig(snap: RepoSnapshot): Result<RepoConfig, ConfigStopKind> {
  const checked = RepoSnapshotSchema.safeParse(snap);
  if (!checked.success) return err("invalid-snapshot", `snapshot: ${describeIssues(checked.error)}`);
  const snapshot = checked.data;

  const configText = readFile(snapshot, CONFIG_PATH);
  if (!configText.ok) return configText;
  const config = parseVersionedYaml(CONFIG_PATH, configText.value, ConfigSchema);
  if (!config.ok) return config;

  const policyText = readFile(snapshot, POLICY_PATH);
  if (!policyText.ok) return policyText;
  const policy = parseVersionedYaml(POLICY_PATH, policyText.value, PolicySchema);
  if (!policy.ok) return policy;

  const stepsText = readFile(snapshot, HUMAN_LIVE_STEPS_PATH);
  if (!stepsText.ok) return stepsText;
  const humanLiveSteps = parseVersionedYaml(HUMAN_LIVE_STEPS_PATH, stepsText.value, HumanLiveStepsSchema);
  if (!humanLiveSteps.ok) return humanLiveSteps;

  const standingAuthority = readStandingAuthority(snapshot, config.value);
  if (!standingAuthority.ok) return standingAuthority;

  let epicsYaml: string | null = null;
  if (snapshot.tree.includes(EPICS_YAML_PATH)) {
    const text = readFile(snapshot, EPICS_YAML_PATH);
    if (!text.ok) return text;
    epicsYaml = text.value;
  }

  return ok({
    package: { defaults: CONFIG_DEFAULTS, mandatoryProtectedPaths: MANDATORY_PROTECTED_PATHS },
    repo: {
      config: config.value,
      policy: {
        ...policy.value,
        effective_protected_paths: effectiveProtectedPaths(policy.value.protected_paths, config.value.standing_authority_path),
      },
      humanLiveSteps: humanLiveSteps.value,
      standingAuthority: standingAuthority.value,
      epicsYaml,
    },
  });
}
