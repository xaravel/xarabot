import { err, ok, type Result } from "../result.ts";
import { checkVersioned, describeIssues } from "../schemas/common.ts";
import { RetroGatesSchema, type RetroGates } from "../schemas/retro-gates.ts";
import { checkEpicKeys, parseYamlMapping } from "./yaml-keys.ts";

/** The value of an absent `retro-gates.yaml`. */
export function emptyRetroGates(): RetroGates {
  return { schema_version: 1, epics: {} };
}

/** Parses `retro-gates.yaml` strictly (AR13), with the raw-text duplicate-key scan. Pure. */
export function parseRetroGates(path: string, text: string): Result<RetroGates, "invalid" | "unsupported-version"> {
  const mapping = parseYamlMapping(path, text);
  if (!mapping.ok) return mapping;
  const versioned = checkVersioned(path, mapping.value);
  if (!versioned.ok) return versioned;
  const keys = checkEpicKeys(path, text, "epics");
  if (!keys.ok) return keys;
  const parsed = RetroGatesSchema.safeParse(versioned.value);
  if (!parsed.success) return err("invalid", `${path}: ${describeIssues(parsed.error)}`);
  return ok(parsed.data);
}
