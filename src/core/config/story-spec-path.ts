import { err, ok, type Result } from "../result.ts";

const STORY_ID = /^([1-9]\d*)\.([1-9]\d*[a-z]?)$/;

/**
 * Expands a `story_spec_path` pattern for one Story: `<epic>` becomes the
 * Epic number and `<story>` the Story part, so `1.17a` gives `spec-1-17a-*.md`
 * under the default pattern.
 */
export function storySpecGlob(pattern: string, storyId: string): Result<string, "invalid"> {
  if (!pattern.includes("<epic>") || !pattern.includes("<story>")) {
    return err("invalid", `story_spec_path: pattern "${pattern}" must contain <epic> and <story>`);
  }
  const match = STORY_ID.exec(storyId);
  if (match === null) {
    return err("invalid", `story id "${storyId}": must look like 1.7 or 1.17a`);
  }
  const [, epic, story] = match as unknown as [string, string, string];
  return ok(pattern.replaceAll("<epic>", epic).replaceAll("<story>", story));
}
