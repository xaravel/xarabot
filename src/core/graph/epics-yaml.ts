import { err, ok, type Result } from "../result.ts";
import { describeIssues } from "../schemas/common.ts";
import { EpicsYamlSchema, type EpicEntry } from "../schemas/epics-yaml.ts";
import { checkEpicKeys, parseYamlMapping } from "./yaml-keys.ts";

/** A parsed `.xarabot/epics.yaml`, its keys read as Epic numbers. */
export type ParsedEpicsYaml = { readonly version: 1; readonly epics: ReadonlyMap<number, EpicEntry> };

/** The value of an absent `.xarabot/epics.yaml`: every Epic runs serially. */
export const EMPTY_EPICS_YAML: ParsedEpicsYaml = { version: 1, epics: new Map() };

/**
 * Parses `.xarabot/epics.yaml` strictly (AD-11): one document, a mapping of
 * `version: 1` and an `epics` map, no duplicate keys in the raw text. Pure.
 */
export function parseEpicsYaml(path: string, text: string): Result<ParsedEpicsYaml, "invalid" | "unsupported-version"> {
  const mapping = parseYamlMapping(path, text);
  if (!mapping.ok) return mapping;
  const version = mapping.value["version"];
  if (typeof version === "number" && Number.isInteger(version) && version !== 1) {
    return err("unsupported-version", `${path}: unsupported version ${version} (this runner reads 1)`);
  }
  const keys = checkEpicKeys(path, text, "epics");
  if (!keys.ok) return keys;
  const parsed = EpicsYamlSchema.safeParse(mapping.value);
  if (!parsed.success) return err("invalid", `${path}: ${describeIssues(parsed.error)}`);
  const epics = new Map<number, EpicEntry>();
  for (const [key, entry] of Object.entries(parsed.data.epics)) epics.set(Number(key), entry);
  return ok({ version: 1, epics });
}
