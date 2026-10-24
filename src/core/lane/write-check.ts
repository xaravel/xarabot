import { AGENT_CONFIG_PATHS } from "../config/protected-paths.ts";
import { parseYaml } from "../schemas/common.ts";
import type { Config } from "../schemas/config.ts";
import type { Policy } from "../schemas/policy.ts";

/**
 * The 0.x write check (FR18, NFR20, AR31, AD-30): which paths a builder
 * session's own change may not touch. Every refused-class comparison is
 * case-folded, because the clone lives on a case-insensitive filesystem;
 * the exceptions compare exact paths, so folding only ever widens a
 * refusal. Pure.
 */

/** The refused path classes, in reporting order: a path in several is reported as the first. */
export const WRITE_CLASSES = ["coordinator-file", "xarabot", "manifest", "standing-authority", "github", "agent-config", "protected-path"] as const;
export type WriteClass = (typeof WRITE_CLASSES)[number];

/** The classes an approved Infrastructure Story may write. */
const INFRASTRUCTURE_CLASSES: ReadonlySet<WriteClass> = new Set(["standing-authority", "github", "agent-config", "protected-path"]);

export type WriteRules = {
  /** `sprint_status_path`, `retro_gates_path` and `epics_path`. */
  readonly coordinatorFiles: readonly string[];
  /** `manifests.dir`, or `null` when `manifests` is unset (no manifests). */
  readonly manifestsDir: string | null;
  readonly standingAuthorityPath: string;
  /** The policy's own `protected_paths`. */
  readonly protectedPaths: readonly string[];
  /** `epic_context_path`, with `<N>`. */
  readonly epicContextPath: string;
  /** The unit's spec file: excepted, exact path. */
  readonly specPath: string;
  /** The unit's own manifest: its frontmatter `status:` line is excepted, exact path. */
  readonly storyFile: string;
  /** An approved Infrastructure Story: its Protected Paths are excepted. */
  readonly infrastructureApproved: boolean;
};

export type WriteRulesInput = {
  readonly config: Pick<Config, "sprint_status_path" | "retro_gates_path" | "epics_path" | "manifests" | "standing_authority_path" | "epic_context_path">;
  readonly policy: Pick<Policy, "protected_paths">;
  readonly specPath: string;
  readonly storyFile: string;
  readonly infrastructureApproved: boolean;
};

export function writeRules(input: WriteRulesInput): WriteRules {
  const { config, policy } = input;
  return {
    coordinatorFiles: [config.sprint_status_path, config.retro_gates_path, config.epics_path],
    manifestsDir: config.manifests?.dir ?? null,
    standingAuthorityPath: config.standing_authority_path,
    protectedPaths: [...policy.protected_paths],
    epicContextPath: config.epic_context_path,
    specPath: input.specPath,
    storyFile: input.storyFile,
    infrastructureApproved: input.infrastructureApproved,
  };
}

/** One path the session changed. `storyFile` holds the own manifest's two texts, given only when it is a regular file on both sides. */
export type WriteChange = {
  readonly path: string;
  readonly storyFile?: { readonly before: string; readonly after: string };
};

export type WriteRefusal = { readonly path: string; readonly class: WriteClass };

const fold = (s: string): string => s.toLowerCase();

/** The agent config folder names, folded: a path ending in one is agent config whatever it is. */
const AGENT_CONFIG_DIRS: ReadonlySet<string> = new Set([".agents", ".claude", ".codex", ".pi"]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** True when `path` is `pattern` with every `<N>` replaced by one positive integer; case-folded. */
export function epicContextMatch(pattern: string, path: string): boolean {
  const parts = fold(pattern).split("<n>");
  if (parts.length < 2) return false;
  const source = parts.map(escapeRegExp).reduce((acc, part, i) => (i === 0 ? part : `${acc}${i === 1 ? "([1-9][0-9]*)" : "\\1"}${part}`), "");
  return new RegExp(`^${source}$`).test(fold(path));
}

type StatusSplit = {
  /** The text's lines with the frontmatter `status:` line removed. */
  readonly rest: readonly string[];
  /** The frontmatter parsed as a mapping, or `null` when there is none or it is not one. */
  readonly frontmatter: Record<string, unknown> | null;
};

/**
 * `text` split around its top-level frontmatter `status:` line, or `null`
 * when it has more than one, or one holding a `\r` other than a trailing one.
 */
function splitStatus(text: string): StatusSplit | null {
  const lines = text.split("\n");
  const opener = (lines[0] ?? "").replace(/^\ufeff/, "").trimEnd();
  if (opener !== "---") return { rest: lines, frontmatter: null };
  const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (close === -1) return { rest: lines, frontmatter: null };
  const status = lines.flatMap((l, i) => (i > 0 && i < close && /^status:(?:\s|$)/.test(l) ? [i] : []));
  if (status.length > 1) return null;
  if (status.some((i) => (lines[i] as string).replace(/\r$/, "").includes("\r"))) return null;
  const yaml = parseYaml("manifest", lines.slice(1, close).join("\n"));
  const fm = yaml.ok && yaml.value !== null && typeof yaml.value === "object" && !Array.isArray(yaml.value) ? (yaml.value as Record<string, unknown>) : null;
  return { rest: lines.filter((_, i) => !status.includes(i)), frontmatter: fm };
}

function withoutStatusKey(fm: Record<string, unknown>): Record<string, unknown> {
  const { status: _status, ...rest } = fm;
  return rest;
}

/**
 * True when `after` differs from `before` at most in one top-level `status:`
 * line inside the leading `---` frontmatter: each side has at most one (with
 * no `\r` but a trailing one), and with those lines removed both texts are
 * identical. Both frontmatters must also parse as YAML mappings that are
 * equal without their `status` key, and `after`'s `status`, if any, must be
 * a string.
 */
export function statusLineOnly(before: string, after: string): boolean {
  const b = splitStatus(before);
  const a = splitStatus(after);
  if (b === null || a === null) return false;
  if (b.rest.join("\n") !== a.rest.join("\n")) return false;
  if (b.frontmatter === null || a.frontmatter === null) return false;
  if (Object.hasOwn(a.frontmatter, "status") && typeof a.frontmatter["status"] !== "string") return false;
  return Bun.deepEquals(withoutStatusKey(b.frontmatter), withoutStatusKey(a.frontmatter), true);
}

function matchesAny(globs: readonly string[], folded: string): boolean {
  return globs.some((g) => new Bun.Glob(fold(g)).match(folded));
}

/** The first refused class `path` is in, or `null`; case-folded. */
function classify(rules: WriteRules, path: string): WriteClass | null {
  const p = fold(path);
  if (rules.coordinatorFiles.some((f) => fold(f) === p)) return "coordinator-file";
  if (p === ".xarabot" || p.startsWith(".xarabot/")) return "xarabot";
  if (rules.manifestsDir !== null) {
    const prefix = `${fold(rules.manifestsDir)}/`;
    if (p.startsWith(prefix) && p.endsWith(".md") && !p.slice(prefix.length).includes("/")) return "manifest";
  }
  if (fold(rules.standingAuthorityPath) === p) return "standing-authority";
  if (p === ".github" || p.startsWith(".github/")) return "github";
  // A bare agent config folder name (a file or symlink there) counts too.
  if (matchesAny(AGENT_CONFIG_PATHS, p) || AGENT_CONFIG_DIRS.has(p.slice(p.lastIndexOf("/") + 1))) return "agent-config";
  if (matchesAny(rules.protectedPaths, p)) return "protected-path";
  return null;
}

/** The changes the rules refuse, in path order. */
export function checkWrite(rules: WriteRules, changes: readonly WriteChange[]): WriteRefusal[] {
  const out: WriteRefusal[] = [];
  for (const change of changes) {
    const { path } = change;
    const cls = classify(rules, path);
    if (cls === null) continue;
    if (path === rules.specPath) continue;
    if (path === rules.storyFile && change.storyFile !== undefined && statusLineOnly(change.storyFile.before, change.storyFile.after)) continue;
    if (rules.infrastructureApproved && INFRASTRUCTURE_CLASSES.has(cls)) continue;
    out.push({ path, class: cls });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
