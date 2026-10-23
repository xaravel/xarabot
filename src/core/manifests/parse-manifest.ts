import { CONFIG_PATH, splitFrontmatter } from "../config/load-repo-config.ts";
import { err, ok, type Result } from "../result.ts";
import { describeIssues, parseYaml } from "../schemas/common.ts";
import type { ManifestsConfig } from "../schemas/config.ts";
import { ManifestFrontmatterSchema, type Manifest, type ManifestPaths } from "../schemas/manifest.ts";
import { normalizeGlob } from "./globs.ts";

export type ManifestErrorKind = "invalid" | "invalid-yaml";
export type LoadManifestsErrorKind = ManifestErrorKind | "unreadable" | "duplicate-story";

/**
 * Parses one Story manifest: YAML frontmatter holding `story_id`, `epic`,
 * `sprint_key`, `title`, exactly one of `globs` or the configured path key,
 * and optional `depends_on` and `infrastructure` (AD-10). Pure.
 */
export function parseManifest(
  path: string,
  text: string,
  manifestsConfig?: ManifestsConfig,
): Result<Manifest, ManifestErrorKind> {
  const split = splitFrontmatter(path, text);
  if (!split.ok) return split;
  const yaml = parseYaml(path, split.value.yaml);
  if (!yaml.ok) return yaml;
  const raw = yaml.value;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return err("invalid", `${path}: frontmatter must be a YAML mapping`);
  }
  const parsed = ManifestFrontmatterSchema.safeParse(raw);
  if (!parsed.success) return err("invalid", `${path}: ${describeIssues(parsed.error)}`);
  const fm = parsed.data;

  const idEpic = Number(fm.story_id.slice(0, fm.story_id.indexOf(".")));
  if (fm.epic !== idEpic) {
    return err("invalid", `${path}: epic ${fm.epic} does not match story_id "${fm.story_id}" (Epic ${idEpic})`);
  }

  const key = manifestsConfig?.path_key;
  const hasKey = key !== undefined && Object.hasOwn(raw, key);
  if (fm.globs !== undefined && hasKey) {
    return err("invalid", `${path}: set exactly one of globs or ${key}, not both`);
  }

  let paths: ManifestPaths;
  if (fm.globs !== undefined) {
    const globs: string[] = [];
    for (const g of fm.globs) {
      const n = normalizeGlob(g);
      if (!n.ok) return err("invalid", `${path}: globs: ${n.error.message}`);
      globs.push(n.value);
    }
    paths = { kind: "globs", globs };
  } else if (hasKey) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value !== "string" || value === "") {
      return err("invalid", `${path}: ${key}: must be a non-empty string`);
    }
    paths = { kind: "key", key, value };
  } else {
    return err("invalid", `${path}: set exactly one of ${key === undefined ? "globs" : `globs or ${key}`}`);
  }

  return ok({
    path,
    story_id: fm.story_id,
    epic: fm.epic,
    sprint_key: fm.sprint_key,
    title: fm.title,
    paths,
    depends_on: fm.depends_on,
    infrastructure: fm.infrastructure,
  });
}

/**
 * A manifest's normalized globs. A key with no `path_map` entry, or an empty
 * `globs` list, makes the Story `unclaimable`; a `path_map` glob that fails
 * normalization makes the config `invalid`.
 */
export function resolveManifestGlobs(
  manifest: Manifest,
  manifestsConfig?: ManifestsConfig,
): Result<string[], "unclaimable" | "invalid"> {
  const { path, paths } = manifest;
  if (paths.kind === "globs") {
    if (paths.globs.length === 0) return err("unclaimable", `${path}: unclaimable: globs is empty`);
    return ok([...paths.globs]);
  }
  if (manifestsConfig?.path_key !== paths.key || manifestsConfig.path_map === undefined) {
    return err("unclaimable", `${path}: unclaimable: manifests.path_key is not "${paths.key}" in the config`);
  }
  const map = manifestsConfig.path_map;
  const mapped = Object.hasOwn(map, paths.value) ? map[paths.value] : undefined;
  if (mapped === undefined) {
    return err("unclaimable", `${path}: unclaimable: ${paths.key} "${paths.value}" is not in manifests.path_map`);
  }
  return normalizePathMapGlobs(paths.value, mapped);
}

/** Normalizes one `path_map` entry's globs; a bad glob makes the config `invalid`. */
function normalizePathMapGlobs(value: string, mapped: readonly string[]): Result<string[], "invalid"> {
  const globs: string[] = [];
  for (const g of mapped) {
    const n = normalizeGlob(g);
    if (!n.ok) return err("invalid", `${CONFIG_PATH}: manifests.path_map.${value}: ${n.error.message}`);
    globs.push(n.value);
  }
  return ok(globs);
}

/**
 * Loads every manifest directly inside `manifests.dir` (tree entries ending in
 * `.md`), in sorted path order. No `manifests` config means no manifests.
 */
export function loadManifests(
  snap: { readonly tree: readonly string[]; readonly files: Readonly<Record<string, string>> },
  manifestsConfig?: ManifestsConfig,
): Result<Manifest[], LoadManifestsErrorKind> {
  if (manifestsConfig === undefined) return ok([]);
  for (const [value, mapped] of Object.entries(manifestsConfig.path_map ?? {})) {
    const n = normalizePathMapGlobs(value, mapped);
    if (!n.ok) return n;
  }
  const prefix = `${manifestsConfig.dir}/`;
  const paths = snap.tree
    .filter((p) => p.startsWith(prefix) && p.endsWith(".md") && !p.slice(prefix.length).includes("/"))
    .sort();
  const manifests: Manifest[] = [];
  const seen = new Map<string, string>();
  for (const path of paths) {
    const text = Object.hasOwn(snap.files, path) ? snap.files[path] : undefined;
    if (typeof text !== "string") return err("unreadable", `${path}: listed in the tree but its content was not read`);
    const m = parseManifest(path, text, manifestsConfig);
    if (!m.ok) return m;
    const first = seen.get(m.value.story_id);
    if (first !== undefined) {
      return err("duplicate-story", `${path}: story_id "${m.value.story_id}" is already used by ${first}`);
    }
    seen.set(m.value.story_id, path);
    manifests.push(m.value);
  }
  return ok(manifests);
}
