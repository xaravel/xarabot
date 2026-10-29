import { literalPrefix } from "./globs.ts";

/**
 * The globs-cover-tests-and-wiring rule (Epic 3 retro item 14, finding A10):
 * a Story manifest or a lane-routed retro item names, beside each `src/`
 * path, that path's tests and the wiring files a known kind of change needs.
 */

/** One glob a unit's globs miss, and the `src/` path or glob that needs it. */
export type MissingGlob = {
  readonly glob: string;
  readonly for: string;
};

/** One known kind of change: the `src/` paths that make it, and the globs it needs. */
export type WiringPair = {
  /** The rule as the planning prompt states it. */
  readonly text: string;
  /** The `src/` paths that make the change. */
  readonly source: RegExp;
  /** Only a source path not in the tree: a new file. */
  readonly newOnly: boolean;
  /** The globs the change needs, from the source path's match; `tree` holds `main`'s paths. */
  readonly needs: (m: RegExpExecArray, tree: ReadonlySet<string>) => readonly string[];
};

/** The known wiring pairs. */
export const WIRING_PAIRS: readonly WiringPair[] = [
  {
    text: "`src/ports/forge.ts` needs `test/ports/forge.test.ts`, `test/contracts/forge.contract.ts` and `src/adapters/forge/**`",
    source: /^src\/ports\/forge\.ts$/,
    newOnly: false,
    needs: () => ["test/ports/forge.test.ts", "test/contracts/forge.contract.ts", "src/adapters/forge/**"],
  },
  {
    text: "`src/ports/<x>.ts` needs `test/ports/<x>.test.ts`, and `test/contracts/<x>.contract.ts` when that file exists",
    source: /^src\/ports\/([^/]+)\.ts$/,
    newOnly: false,
    needs: (m, tree) => {
      const contract = `test/contracts/${m[1]}.contract.ts`;
      return [`test/ports/${m[1]}.test.ts`, ...(tree.has(contract) ? [contract] : [])];
    },
  },
  {
    text: "a new `src/lane/<x>-step.ts`, which `lane run` must wire in, needs `src/cli/lane-run.ts` and `test/cli/lane-run.test.ts`",
    source: /^src\/lane\/[^/]+-step\.ts$/,
    newOnly: true,
    needs: () => ["src/cli/lane-run.ts", "test/cli/lane-run.test.ts"],
  },
];

const GLOB_CHARS = /[*?[{]/;
const isLiteral = (glob: string): boolean => !GLOB_CHARS.test(glob);

/**
 * A `src/` glob's test counterpart: `src/<p>.ts` → `test/<p>.test.ts`,
 * `src/<dir>/**` → `test/<dir>/**` (and `src/**` → `test/**`). Any other
 * shape has none.
 */
export function testCounterpart(glob: string): string | null {
  if (!glob.startsWith("src/")) return null;
  const rest = glob.slice("src/".length);
  if (isLiteral(rest) && rest.endsWith(".ts") && !rest.endsWith(".d.ts")) return `test/${rest.slice(0, -".ts".length)}.test.ts`;
  if (rest === "**") return "test/**";
  if (rest.endsWith("/**") && isLiteral(rest.slice(0, -"/**".length))) return `test/${rest}`;
  return null;
}

/**
 * Whether `glob` covers `wanted`: the same glob; a literal `wanted` the glob
 * matches; or a `wanted` of `<prefix>**` under a `glob` of `<literal>**`
 * whose literal starts the prefix.
 */
export function globCovers(glob: string, wanted: string): boolean {
  if (glob === wanted) return true;
  if (isLiteral(wanted)) return new Bun.Glob(glob).match(wanted);
  if (!wanted.endsWith("**") || !glob.endsWith("**")) return false;
  const outer = glob.slice(0, -2);
  const inner = wanted.slice(0, -2);
  return isLiteral(outer) && literalPrefix(wanted) === inner && (outer === "" || outer.endsWith("/")) && inner.startsWith(outer);
}

/**
 * The globs `globs` (normalized) miss under the rule, in order, each once
 * and none covered by an earlier one:
 * each `src/` glob's test counterpart, then the wiring each named `src/`
 * path needs, with a needed `src/` glob's own test counterpart. A path is
 * named by a literal glob, or is a `tree` path a glob matches. Pure.
 */
export function missingGlobs(globs: readonly string[], tree: readonly string[]): MissingGlob[] {
  const treeSet = new Set(tree);
  const wanted: MissingGlob[] = [];
  for (const g of globs) {
    const t = testCounterpart(g);
    if (t !== null) wanted.push({ glob: t, for: g });
  }
  const named = new Set<string>();
  for (const g of globs) {
    if (isLiteral(g)) {
      if (g.startsWith("src/")) named.add(g);
    } else {
      const matcher = new Bun.Glob(g);
      for (const p of tree) if (p.startsWith("src/") && matcher.match(p)) named.add(p);
    }
  }
  for (const path of [...named].sort()) {
    for (const pair of WIRING_PAIRS) {
      const m = pair.source.exec(path);
      if (m === null || (pair.newOnly && treeSet.has(path))) continue;
      const needs = pair.needs(m, treeSet);
      for (const need of needs) wanted.push({ glob: need, for: path });
      for (const need of needs) {
        const t = testCounterpart(need);
        if (t !== null) wanted.push({ glob: t, for: need });
      }
    }
  }
  // A glob the globs, or an earlier missing glob, already cover is left out.
  const missing: MissingGlob[] = [];
  for (const w of wanted) {
    if (![...globs, ...missing.map((m) => m.glob)].some((g) => globCovers(g, w.glob))) missing.push(w);
  }
  return missing;
}

/** The missing globs on one line: `"test/a.test.ts" (for src/a.ts), ...`. */
export function describeMissing(missing: readonly MissingGlob[]): string {
  return missing.map((m) => `"${m.glob}" (for ${m.for})`).join(", ");
}
