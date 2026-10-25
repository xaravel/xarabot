import { splitFrontmatter } from "../config/load-repo-config.ts";
import { AGENT_CONFIG_PATHS } from "../config/protected-paths.ts";
import { globsOverlap, literalPrefix, normalizeGlob } from "../manifests/globs.ts";
import { graphInputGlobs, statusFiles } from "../next/coordinator.ts";
import { parseYaml } from "../schemas/common.ts";
import type { Config } from "../schemas/config.ts";
import { RETRO_ITEM_ID_PATTERN } from "../schemas/retro-gates.ts";
import type { RetroResult } from "../schemas/session-result.ts";

/**
 * The retro result's validation (Story 2.9, FR10, AR15, AR30): the checks a
 * `retro` session result must pass before its commit (`checkRetroResult`)
 * and, after the commit and before any push, against the committed diff
 * (`checkRetroDiff`). Each returns the failures, `[]` when it passes; any
 * failure is a failed attempt. Pure.
 */

export type RefusedConfig = Pick<
  Config,
  "epics_path" | "manifests" | "sprint_status_path" | "retro_gates_path" | "standing_authority_path" | "live_evidence_glob"
>;

export type RefusedPolicy = { readonly effective_protected_paths: readonly string[] };

/** One refused item glob and the refused glob it hits. */
export type RefusedGlob = { readonly glob: string; readonly refused: string };

/** Full case folding, as the write check folds. */
const fold = (s: string): string => s.toUpperCase().toLowerCase();

/**
 * The globs no retro item may hold: the graph inputs, the status files,
 * `.xarabot/**`, the Standing Authority path, `.github/**`, the agent config
 * paths, the live evidence files (`live_evidence_glob` with `<N>` as `*`)
 * and the policy's effective Protected Paths; each once, in that order.
 */
export function refusedGlobs(config: RefusedConfig, policy: RefusedPolicy): string[] {
  return [
    ...new Set([
      ...graphInputGlobs(config),
      ...statusFiles(config),
      ".xarabot/**",
      config.standing_authority_path,
      ".github/**",
      ...AGENT_CONFIG_PATHS,
      config.live_evidence_glob.replaceAll("<N>", "*"),
      ...policy.effective_protected_paths,
    ]),
  ];
}

/**
 * The item globs (normalized) that are refused (Story 2.9): a glob overlaps
 * (`globsOverlap`) a refused glob that has a literal prefix, or, for a
 * refused glob that starts with a wildcard, `Bun.Glob(refused)` matches the
 * glob's text, both case-folded. Each glob is reported once, with the first
 * refused glob it hits.
 */
export function refusedItemGlobs(globs: readonly string[], config: RefusedConfig, policy: RefusedPolicy): RefusedGlob[] {
  const refused = refusedGlobs(config, policy);
  const out: RefusedGlob[] = [];
  for (const glob of globs) {
    const hit = refused.find((r) => (literalPrefix(r) === "" ? new Bun.Glob(fold(r)).match(fold(glob)) : globsOverlap(glob, r)));
    if (hit !== undefined) out.push({ glob, refused: hit });
  }
  return out;
}

/**
 * The pre-commit checks of a `retro` result for Epic `epic`: every item id
 * is `epic-<epic>-…` and appears once, and every glob normalizes and is not
 * refused (`refusedItemGlobs`).
 */
export function checkRetroResult(epic: number, result: Pick<RetroResult, "items">, config: RefusedConfig, policy: RefusedPolicy): string[] {
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const item of result.items) {
    const m = RETRO_ITEM_ID_PATTERN.exec(item.id);
    if (m === null || Number(m[1]) !== epic) failures.push(`item ${item.id}: its id must start with "epic-${epic}-"`);
    if (seen.has(item.id)) failures.push(`item ${item.id}: its id repeats`);
    seen.add(item.id);
    const normalized: string[] = [];
    for (const g of item.globs) {
      const n = normalizeGlob(g);
      if (!n.ok) failures.push(`item ${item.id}: ${n.error.message}`);
      else normalized.push(n.value);
    }
    for (const r of refusedItemGlobs(normalized, config, policy)) {
      failures.push(`item ${item.id}: glob "${r.glob}" is refused (it overlaps "${r.refused}")`);
    }
  }
  return failures;
}

/** One side of the commit: a tree's listing and the texts of the files the check reads. */
export type RetroTree = {
  readonly tree: readonly string[];
  readonly files: Readonly<Record<string, string>>;
};

export type RetroDiffInput = {
  readonly epic: number;
  readonly result: Pick<RetroResult, "verdict" | "items">;
  readonly config: Pick<Config, "sprint_status_path" | "retro_doc_glob">;
  /** Fresh `main`, which the commit went onto. */
  readonly onto: RetroTree;
  /** The committed head. */
  readonly head: RetroTree;
};

/** The retro document glob of Epic `epic`: `retro_doc_glob` with `<N>` set. */
export function retroDocGlob(pattern: string, epic: number): string {
  return pattern.replaceAll("<N>", String(epic));
}

/** The `id`s of `sprint-status.yaml`'s `action_items`, or why they cannot be read; an absent file has none. */
function actionItemIds(path: string, side: RetroTree): { readonly ok: true; readonly ids: string[] } | { readonly ok: false; readonly why: string } {
  if (!side.tree.includes(path)) return { ok: true, ids: [] };
  const text = side.files[path];
  if (text === undefined) return { ok: false, why: `${path} was not read` };
  const yaml = parseYaml(path, text);
  if (!yaml.ok) return { ok: false, why: yaml.error.message };
  const raw = yaml.value;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, why: `${path}: top level must be a YAML mapping` };
  const items = (raw as Record<string, unknown>)["action_items"];
  if (items === undefined || items === null) return { ok: true, ids: [] };
  if (!Array.isArray(items)) return { ok: false, why: `${path}: action_items must be a list` };
  const ids: string[] = [];
  for (const [i, item] of items.entries()) {
    const id = item !== null && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>)["id"] : undefined;
    if (typeof id !== "string") return { ok: false, why: `${path}: action_items[${i}] has no string id` };
    ids.push(id);
  }
  return { ok: true, ids };
}

/** A document's frontmatter `verdict`, or `null` when it has none or it cannot be read. */
function docVerdict(path: string, text: string): string | null {
  const split = splitFrontmatter(path, text);
  if (!split.ok) return null;
  const yaml = parseYaml(path, split.value.yaml);
  if (!yaml.ok) return null;
  const fm = yaml.value;
  if (fm === null || typeof fm !== "object" || Array.isArray(fm)) return null;
  const verdict = (fm as Record<string, unknown>)["verdict"];
  return typeof verdict === "string" ? verdict : null;
}

const listed = (ids: readonly string[]): string => (ids.length === 0 ? "none" : ids.join(", "));

/**
 * The post-commit checks of a `retro` result against the commit (`onto` to
 * `head`): its item ids equal, as a set, the ids of the `action_items`
 * entries in `head`'s `sprint_status_path` that `onto` lacks; exactly one
 * file matching the Epic's retro document glob is added or changed; and that
 * file's frontmatter `verdict` is the result's.
 */
export function checkRetroDiff(input: RetroDiffInput): string[] {
  const { epic, result, config, onto, head } = input;
  const failures: string[] = [];

  const path = config.sprint_status_path;
  const before = actionItemIds(path, onto);
  const after = actionItemIds(path, head);
  if (!before.ok) failures.push(`main's ${before.why}`);
  else if (!after.ok) failures.push(`the commit's ${after.why}`);
  else {
    const old = new Set(before.ids);
    const appended = [...new Set(after.ids.filter((id) => !old.has(id)))].sort();
    const ids = [...new Set(result.items.map((i) => i.id))].sort();
    if (appended.join("\n") !== ids.join("\n")) {
      failures.push(`the result's items (${listed(ids)}) are not the action items the commit appends to ${path} (${listed(appended)})`);
    }
  }

  const glob = new Bun.Glob(retroDocGlob(config.retro_doc_glob, epic));
  const docs = head.tree.filter((p) => glob.match(p) && (!onto.tree.includes(p) || onto.files[p] !== head.files[p])).sort();
  if (docs.length !== 1) {
    failures.push(`the commit adds or changes ${docs.length} retro documents matching ${retroDocGlob(config.retro_doc_glob, epic)}${docs.length === 0 ? "" : ` (${docs.join(", ")})`}, not exactly one`);
    return failures;
  }
  const doc = docs[0] as string;
  const text = head.files[doc];
  const verdict = text === undefined ? null : docVerdict(doc, text);
  if (verdict !== result.verdict) {
    failures.push(`${doc}'s frontmatter verdict is ${verdict === null ? "missing" : `"${verdict}"`}, not the result's "${result.verdict}"`);
  }
  return failures;
}
