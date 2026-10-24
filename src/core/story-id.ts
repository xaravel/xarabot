import { z } from "zod";

/** A Story id as AD-10 writes it: Epic number, dot, Story number, optional lowercase letter (`2.6a`). */
export const STORY_ID_PATTERN = /^\d+\.\d+[a-z]?$/;

/** A Story id. A YAML number (`1.10` reads as `1.1`) is rejected: ids must be strings. */
export const StoryId = z
  .string({
    error: (issue) =>
      typeof issue.input === "number"
        ? 'must be a quoted string (YAML reads an unquoted id such as 1.10 as the number 1.1); write it as "1.10"'
        : undefined,
  })
  .regex(STORY_ID_PATTERN, "must be a Story id like 1.7 or 1.17a");

const PARTS = /^(\d+)\.(\d+)([a-z]?)$/;

/**
 * Orders Story ids: numeric Epic part, then numeric Story part, then suffix
 * (none before `a` before `b`). Ids that do not match the pattern sort after
 * those that do, by plain string order.
 */
export function compareStoryIds(a: string, b: string): number {
  const ma = PARTS.exec(a);
  const mb = PARTS.exec(b);
  if (ma === null || mb === null) {
    if (ma !== null) return -1;
    if (mb !== null) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const epic = Number(ma[1]) - Number(mb[1]);
  if (epic !== 0) return Math.sign(epic);
  const story = Number(ma[2]) - Number(mb[2]);
  if (story !== 0) return Math.sign(story);
  const sa = ma[3] ?? "";
  const sb = mb[3] ?? "";
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** A Story id's join key, the rule `resolveGraph` uses: numeric Epic and Story parts, then the suffix (`2.01` → `2.1`). */
export function storyKey(id: string): string {
  const m = PARTS.exec(id);
  return m === null ? id : `${Number(m[1])}.${Number(m[2])}${m[3] ?? ""}`;
}
