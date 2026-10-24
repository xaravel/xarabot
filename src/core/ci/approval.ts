/**
 * The owner-approval gate (FR13, AR7). Pure: a PR whose changed paths match
 * any gate glob parks `awaiting-approval` for its owner instead of entering
 * the merge queue. The gate globs are `policy.owner_approval_paths` followed
 * by `policy.effective_protected_paths`.
 */

/**
 * The paths that match any of `globs` under `Bun.Glob` rules, both sides
 * case-folded, sorted and each once.
 */
export function approvalPaths(paths: readonly string[], globs: readonly string[]): string[] {
  const matchers = globs.map((g) => new Bun.Glob(g.toLowerCase()));
  const hits = new Set<string>();
  for (const path of paths) {
    const folded = path.toLowerCase();
    if (matchers.some((m) => m.match(folded))) hits.add(path);
  }
  return [...hits].sort();
}
