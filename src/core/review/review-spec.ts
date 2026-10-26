import { splitFrontmatter } from "../config/load-repo-config.ts";
import { parseYaml } from "../schemas/common.ts";

/**
 * The spec's follow-up flag (Story 3.4, AD-16): a Story whose spec at the
 * reviewed head sets `followup_review_recommended: true` in its frontmatter
 * gets a follow-up review pass after the normal one. Pure.
 */

/** True only when the frontmatter parses and its `followup_review_recommended` is the boolean `true`. */
export function followupRecommended(specText: string): boolean {
  const split = splitFrontmatter("spec", specText);
  if (!split.ok) return false;
  const yaml = parseYaml("spec", split.value.yaml);
  if (!yaml.ok) return false;
  const fm = yaml.value;
  if (fm === null || typeof fm !== "object" || Array.isArray(fm)) return false;
  return (fm as Record<string, unknown>)["followup_review_recommended"] === true;
}
