import { COVERAGE_PLACEHOLDER, type GlobCoverage } from "../schemas/config.ts";
import { literalPrefix } from "./globs.ts";

/**
 * The glob coverage rule (Epic 3 retro item 14): the globs a list of globs
 * (a Story manifest's, or a lane retro item's) misses beside each of its own,
 * from the repo's `glob_coverage` table. Nothing of any repo's layout is
 * built in: with no table there is no rule. Pure.
 */

/** One missing glob, with the first glob of the list that needs it. */
export type MissingGlob = { readonly glob: string; readonly needed_by: string };

/** One coverage row, tests and wiring alike. */
type Row = {
  readonly path: string;
  readonly needs: readonly string[];
  readonly needs_if_present: readonly string[];
  readonly only_new: boolean;
};

/** How many steps a missing glob's own needs are followed. */
const NEED_DEPTH = 4;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** `pattern` as a whole-string regex: each `<name>` captures one or more characters, everything else matches itself. */
function patternRegExp(pattern: string): RegExp {
  let source = "";
  let last = 0;
  for (const m of pattern.matchAll(COVERAGE_PLACEHOLDER)) {
    source += `${escapeRegExp(pattern.slice(last, m.index))}(?<${m[1] as string}>.+)`;
    last = m.index + m[0].length;
  }
  return new RegExp(`^${source}${escapeRegExp(pattern.slice(last))}$`, "s");
}

/** `pattern` with each `<name>` set from `values`. */
function fillPattern(pattern: string, values: Readonly<Record<string, string>>): string {
  return pattern.replace(COVERAGE_PLACEHOLDER, (whole, name: string) => values[name] ?? whole);
}

/** The table's rows, tests first, each as a wiring row. */
function rows(coverage: GlobCoverage): Row[] {
  return [
    ...(coverage.tests ?? []).map((t) => ({ path: t.path, needs: [t.test], needs_if_present: [], only_new: false })),
    ...(coverage.wiring ?? []),
  ];
}

/** A glob in `have` is `need`, or matches its text (`test/**` covers `test/a.test.ts` and `test/a/**`). */
function covered(need: string, have: readonly string[]): boolean {
  return have.some((h) => h === need || new Bun.Glob(h).match(need));
}

/** A tree file is `glob`, or matches it. */
function present(glob: string, tree: readonly string[]): boolean {
  const g = new Bun.Glob(glob);
  return tree.some((p) => p === glob || g.match(p));
}

/** A literal path (no wildcard) the tree does not hold. */
function isNew(glob: string, tree: readonly string[]): boolean {
  return literalPrefix(glob) === glob && !tree.includes(glob);
}

/**
 * The globs `globs` (normalized) misses: for each glob a row's `path`
 * matches, as text, with each `<name>` standing for one or more characters,
 * the row's needed globs with those values, each unless a glob of `globs` is
 * it or matches it. A `needs_if_present` glob is needed only when a `tree`
 * file matches it, and an `only_new` row applies only to a literal path not
 * in `tree`. A missing glob's own needs are missing too, up to
 * `NEED_DEPTH` steps on. Each missing glob
 * once, in the order first needed.
 */
export function missingGlobs(globs: readonly string[], coverage: GlobCoverage, tree: readonly string[]): MissingGlob[] {
  const table = rows(coverage).map((r) => ({ ...r, re: patternRegExp(r.path) }));
  const out = new Map<string, MissingGlob>();
  // A missing glob is checked in turn, so the list it would join is complete in one pass; a table whose
  // needs feed each other without end (`<p>` needs `t/<p>`) stops after `NEED_DEPTH` steps.
  const queue = globs.map((glob) => ({ glob, depth: 0 }));
  for (let i = 0; i < queue.length; i += 1) {
    const { glob, depth } = queue[i] as { glob: string; depth: number };
    if (depth > NEED_DEPTH) continue;
    for (const row of table) {
      const m = row.re.exec(glob);
      if (m === null) continue;
      if (row.only_new && !isNew(glob, tree)) continue;
      const values = m.groups ?? {};
      const needed = [
        ...row.needs.map((n) => fillPattern(n, values)),
        ...row.needs_if_present.map((n) => fillPattern(n, values)).filter((n) => present(n, tree)),
      ];
      for (const need of needed) {
        if (out.has(need) || covered(need, globs)) continue;
        out.set(need, { glob: need, needed_by: glob });
        queue.push({ glob: need, depth: depth + 1 });
      }
    }
  }
  return [...out.values()];
}

/** `missing` as one clause: each glob in backticks, with the glob that needs it. */
export function describeMissing(missing: readonly MissingGlob[]): string {
  return missing.map((m) => `\`${m.glob}\` (for \`${m.needed_by}\`)`).join(", ");
}

/**
 * The table as prompt lines (Epic 3 retro item 14), one per row in table
 * order: tests first, then wiring.
 */
export function coverageRuleLines(coverage: GlobCoverage): string[] {
  const list = (globs: readonly string[]): string => globs.map((g) => `\`${g}\``).join(", ");
  const tests = (coverage.tests ?? []).map((t) => `- \`${t.path}\` needs its tests, \`${t.test}\`.`);
  const wiring = (coverage.wiring ?? []).map((w) => {
    const when = w.only_new ? `\`${w.path}\`, when it names a file this repository does not have yet,` : `\`${w.path}\``;
    const parts: string[] = [];
    if (w.needs.length > 0) parts.push(list(w.needs));
    if (w.needs_if_present.length > 0) parts.push(`each of ${list(w.needs_if_present)} that matches a file this repository has`);
    return `- ${when} needs ${parts.join(", and ")}.`;
  });
  return [...tests, ...wiring];
}
