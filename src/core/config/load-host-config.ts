import { err, type Result } from "../result.ts";
import { checkVersioned, parseVersioned, parseYaml } from "../schemas/common.ts";
import { HostConfigSchema, REPO_LAYER_KEYS, type HostConfig } from "../schemas/host.ts";

export type HostConfigErrorKind = "invalid-yaml" | "unsupported-version" | "invalid" | "repo-key-in-host";

/**
 * Parses `host.yaml` text into the host layer (AR21). A repo-layer key at the
 * top level or inside a lane is refused as `repo-key-in-host`: those settings
 * come only from `main`. Pure; the caller reads the file.
 */
export function loadHostConfig(text: string, path = "host.yaml"): Result<HostConfig, HostConfigErrorKind> {
  const yaml = parseYaml(path, text);
  if (!yaml.ok) return yaml;
  const pre = checkVersioned(path, yaml.value);
  if (!pre.ok) return pre;

  for (const key of Object.keys(pre.value)) {
    if (REPO_LAYER_KEYS.has(key)) {
      return err("repo-key-in-host", `${path}: ${key} is a repo setting; set it in .xarabot/ on main, not in host.yaml`);
    }
  }
  const lanes = pre.value["lanes"];
  if (lanes !== null && typeof lanes === "object" && !Array.isArray(lanes)) {
    for (const [name, lane] of Object.entries(lanes)) {
      if (lane === null || typeof lane !== "object" || Array.isArray(lane)) continue;
      for (const key of Object.keys(lane)) {
        if (REPO_LAYER_KEYS.has(key)) {
          return err(
            "repo-key-in-host",
            `${path}: lanes.${name}.${key} is a repo setting; set it in .xarabot/ on main, not in host.yaml`,
          );
        }
      }
    }
  }
  return parseVersioned(path, pre.value, HostConfigSchema);
}
