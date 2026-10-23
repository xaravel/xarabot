import { err, ok, type Result } from "../result.ts";
import { describeIssues, parseYaml } from "../schemas/common.ts";
import { SprintStatusSchema } from "../schemas/sprint-status.ts";

/** The part of `sprint-status.yaml` `next` reads. */
export type DevelopmentStatus = { readonly development_status: Record<string, string> };

/** The value of an absent `sprint-status.yaml`. */
export function emptySprintStatus(): DevelopmentStatus {
  return { development_status: {} };
}

/**
 * Parses `sprint-status.yaml`: a YAML mapping whose `development_status` maps
 * each key to a status string. Other top-level keys are ignored. Pure.
 */
export function parseSprintStatus(path: string, text: string): Result<DevelopmentStatus, "invalid"> {
  const yaml = parseYaml(path, text);
  if (!yaml.ok) return err("invalid", yaml.error.message);
  const raw = yaml.value;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return err("invalid", `${path}: top level must be a YAML mapping`);
  }
  const parsed = SprintStatusSchema.safeParse(raw);
  if (!parsed.success) return err("invalid", `${path}: ${describeIssues(parsed.error)}`);
  return ok({ development_status: { ...parsed.data.development_status } });
}
