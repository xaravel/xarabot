import { err, ok, type Result } from "../result.ts";
import { isRepoRelative } from "../schemas/common.ts";

/**
 * Normalizes one manifest or `path_map` glob: strips every leading `./`, then
 * rejects an empty glob, a negation (`!`), an absolute or home path (`/`,
 * `~`), a backslash, and any empty, `.` or `..` segment. The error message is
 * the reason only; callers prefix it with the file's path.
 */
export function normalizeGlob(glob: string): Result<string, "invalid"> {
  let g = glob;
  while (g.startsWith("./")) g = g.slice(2);
  const bad = (reason: string) => err("invalid", `glob "${glob}" ${reason}`);
  if (g === "") return bad("is empty");
  if (g.startsWith("!")) return bad("must not be a negation (leading !)");
  if (g.startsWith("~")) return bad("must be repo-relative (no leading ~)");
  if (!isRepoRelative(g)) {
    return bad("must be repo-relative (no leading /, no backslash, no empty, . or .. path segment)");
  }
  return ok(g);
}

/** A normalized glob up to its first `*`, `?`, `[` or `{`. */
export function literalPrefix(glob: string): string {
  const i = glob.search(/[*?[{]/);
  return i === -1 ? glob : glob.slice(0, i);
}

/** Two normalized globs overlap when one case-folded literal prefix starts with the other. */
export function globsOverlap(a: string, b: string): boolean {
  const pa = literalPrefix(a).toLowerCase();
  const pb = literalPrefix(b).toLowerCase();
  return pa.startsWith(pb) || pb.startsWith(pa);
}
