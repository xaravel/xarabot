import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { strip } from "../../support/boundaries.ts";

/**
 * Only `reconcile` deletes ledger records (Story 2.5): the two delete edits,
 * `deleteMerged` (`merged → none`) and `deleteReleasedRecurring`
 * (`released → none`), are the only edits whose result is a deletion, and
 * only the coordinator's `reconcile` step writes them. The one other caller
 * is the planning step, which deletes only its own record once it has
 * nothing to commit (AR8's recurring units, Story 2.7).
 */

const SRC = join(import.meta.dir, "..", "..", "..", "src");
const EDITS = "src/core/ledger/edits.ts";
const DELETE_EDITS = ["deleteMerged", "deleteReleasedRecurring"] as const;

/** Every `.ts` file under `src/`, repo-relative, with its comments blanked. */
function sources(): { readonly path: string; readonly code: string }[] {
  return (readdirSync(SRC, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => ({ path: `src/${f}`, code: strip(readFileSync(join(SRC, f), "utf8")).code }));
}

/** `code`'s top-level `export function` bodies by name. */
function exportedFunctions(code: string): Map<string, string> {
  const out = new Map<string, string>();
  const starts = [...code.matchAll(/^export function (\w+)/gm)];
  starts.forEach((m, i) => out.set(m[1] as string, code.slice(m.index, starts[i + 1]?.index ?? code.length)));
  return out;
}

describe("only reconcile deletes ledger records (Story 2.5)", () => {
  test("in edits.ts, only the two delete edits end in no record", () => {
    const code = sources().find((s) => s.path === EDITS)?.code ?? "";
    const deleting = [...exportedFunctions(code)].filter(([, body]) => /\bto: "none"/.test(body)).map(([name]) => name);
    expect(deleting).toEqual([...DELETE_EDITS]);
  });

  test("no other src/ file builds a ledger commit with deletes", () => {
    const building = sources()
      .filter((s) => /\bdeletes:/.test(s.code))
      .map((s) => s.path);
    expect(building).toEqual([EDITS]);
  });

  test("only the reconcile step, and the planning step for its own record, call a delete edit", () => {
    const callers = sources()
      .filter((s) => s.path !== EDITS && DELETE_EDITS.some((name) => new RegExp(`\\b${name}\\(`).test(s.code)))
      .map((s) => s.path);
    expect(callers).toEqual(["src/lane/planning-step.ts", "src/lane/reconcile-step.ts"]);
  });

  test("the planning step deletes only its own record, and never a released one", () => {
    const code = sources().find((s) => s.path === "src/lane/planning-step.ts")?.code ?? "";
    // `unit` is the step's own unit id (`input.unit.unit`).
    expect(/\bconst unit = input\.unit\.unit;/.test(code)).toBe(true);
    const calls = code.match(/\b(?:deleteMerged|deleteReleasedRecurring)\(/g) ?? [];
    const own = code.match(/\bdeleteMerged\(\{ unit, /g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(own.length).toBe(calls.length);
  });
});
