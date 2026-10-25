import { emptyRetroGates, parseRetroGates } from "../graph/retro-gates.ts";
import { normalizeGlob } from "../manifests/globs.ts";
import { err, ok, type Result } from "../result.ts";
import type { Go, RetroGates, RetroGatesEntry, RetroItem, RetroRecordResult } from "../schemas/retro-gates.ts";

/**
 * `reconcile`'s write of retro verdicts and items to `retro-gates.yaml`
 * (Story 2.9, AR4, AR13): the only writer of those records. Applying a
 * merged retro's result sets the Epic's `retro` and appends each item not
 * already listed with `status: open`; a merged retro item's unit sets its
 * item `status: done` (Story 2.10); the file is then rewritten whole, in a
 * fixed, deterministic form. Comments in a hand-edited file are not kept; its
 * data, a hand-recorded `go` included, is. Pure.
 */

/** One merged retro record's result to record. */
export type RetroGatesAddition = {
  readonly epic: number;
  /** `retro:<N>`. */
  readonly unit: string;
  readonly result: RetroRecordResult;
  /** The run's snapshot `now`. */
  readonly recorded_at: string;
};

/** One merged `retro-item:<id>` record whose item to set `done` (Story 2.10). */
export type RetroItemDone = {
  readonly epic: number;
  /** The item's id. */
  readonly id: string;
};

/**
 * `gates` with each listed item of `done` that is not `done` yet set to
 * `status: done`; an item not listed is left out. One line per change is
 * returned as the summary: `epics.<N>.items: <id> <old> -> done`.
 */
export function applyItemsDone(gates: RetroGates, done: readonly RetroItemDone[]): { readonly gates: RetroGates; readonly summary: string[] } {
  const epics: Record<string, RetroGatesEntry> = { ...gates.epics };
  const summary: string[] = [];
  const sorted = [...done].sort((a, b) => a.epic - b.epic);
  for (const d of sorted) {
    const key = String(d.epic);
    const entry = epics[key];
    const items = entry?.items;
    if (entry === undefined || items === undefined) continue;
    const i = items.findIndex((x) => x.id === d.id);
    const item = items[i];
    if (item === undefined || item.status === "done") continue;
    epics[key] = { ...entry, items: items.map((x, j) => (j === i ? { ...x, status: "done" as const } : x)) };
    summary.push(`epics.${key}.items: ${d.id} ${item.status} -> done`);
  }
  return { gates: { schema_version: gates.schema_version, epics }, summary };
}

/**
 * `gates` with each addition applied: `epics.<N>.retro` = {`verdict`,
 * `unit`, `recorded_at`}, then each result item whose id the Epic does not
 * list yet appended with its globs normalized and `status: open`. An Epic
 * whose `retro` is already recorded is left as it is. One line per change
 * is returned as the summary.
 */
export function applyRetroResults(gates: RetroGates, additions: readonly RetroGatesAddition[]): { readonly gates: RetroGates; readonly summary: string[] } {
  const epics: Record<string, RetroGatesEntry> = { ...gates.epics };
  const summary: string[] = [];
  for (const a of [...additions].sort((x, y) => x.epic - y.epic)) {
    const key = String(a.epic);
    const entry = epics[key] ?? {};
    if (entry.retro !== undefined) continue;
    const items: RetroItem[] = [...(entry.items ?? [])];
    const listed = new Set(items.map((i) => i.id));
    const added: string[] = [];
    for (const i of a.result.items) {
      if (listed.has(i.id)) continue;
      listed.add(i.id);
      const globs = i.globs.map((g) => {
        const n = normalizeGlob(g);
        return n.ok ? n.value : g;
      });
      items.push({ id: i.id, text: i.text, route: i.route, blocking: i.blocking, globs, status: "open" });
      added.push(i.id);
    }
    epics[key] = { ...entry, retro: { verdict: a.result.verdict, unit: a.unit, recorded_at: a.recorded_at }, ...(items.length > 0 || entry.items !== undefined ? { items } : {}) };
    summary.push(`epics.${key}.retro: ${a.result.verdict} (${a.unit})`);
    for (const id of added) summary.push(`epics.${key}.items: ${id} added as open`);
  }
  return { gates: { schema_version: gates.schema_version, epics }, summary };
}

/**
 * A YAML double-quoted scalar holding only printable ASCII: `"` and `\`
 * escaped, every other character outside U+0020–U+007E written as `\uXXXX`
 * (or `\UXXXXXXXX` past U+FFFF), so no line separator, control or other
 * character changes the value on the way back.
 */
function q(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '"' || ch === "\\") out += `\\${ch}`;
    else if (cp >= 0x20 && cp <= 0x7e) out += ch;
    else if (cp <= 0xffff) out += `\\u${cp.toString(16).toUpperCase().padStart(4, "0")}`;
    else out += `\\U${cp.toString(16).toUpperCase().padStart(8, "0")}`;
  }
  return `${out}"`;
}

function goLines(go: Go, indent: string): string[] {
  return [`${indent}go:`, `${indent}  by: ${q(go.by)}`, `${indent}  at: ${q(go.at)}`, `${indent}  ruling: ${q(go.ruling)}`];
}

/**
 * `gates` as `retro-gates.yaml` text: `schema_version`, then `epics` by
 * ascending Epic number, each entry's `retro`, `items` and `checkpoint` in
 * that order, every string double-quoted and every glob list in flow form.
 */
export function serializeRetroGates(gates: RetroGates): string {
  const lines = [`schema_version: ${gates.schema_version}`];
  const keys = Object.keys(gates.epics).sort((a, b) => Number(a) - Number(b));
  if (keys.length === 0) lines.push("epics: {}");
  else lines.push("epics:");
  for (const key of keys) {
    const e = gates.epics[key] as RetroGatesEntry;
    const body: string[] = [];
    if (e.retro !== undefined) {
      body.push("    retro:", `      verdict: ${e.retro.verdict}`, `      unit: ${q(e.retro.unit)}`, `      recorded_at: ${q(e.retro.recorded_at)}`);
      if (e.retro.go !== undefined) body.push(...goLines(e.retro.go, "      "));
    }
    if (e.items !== undefined) {
      if (e.items.length === 0) body.push("    items: []");
      else body.push("    items:");
      for (const i of e.items) {
        body.push(
          `      - id: ${q(i.id)}`,
          `        text: ${q(i.text)}`,
          `        route: ${i.route}`,
          `        blocking: ${String(i.blocking)}`,
          `        globs: [${i.globs.map(q).join(", ")}]`,
          `        status: ${i.status}`,
        );
      }
    }
    if (e.checkpoint !== undefined) body.push("    checkpoint:", ...goLines(e.checkpoint.go, "      "));
    lines.push(body.length === 0 ? `  ${q(key)}: {}` : `  ${q(key)}:`, ...body);
  }
  return `${lines.join("\n")}\n`;
}

export type RetroGatesEdit = { readonly text: string; readonly summary: readonly string[] };

/**
 * The new `retro-gates.yaml` text for `additions`, then the items `done`
 * (Story 2.10), over `text` (`null` when the file is absent, read as
 * `{schema_version: 1, epics: {}}`), or why it cannot be written: the
 * current text does not parse, or the new text does not parse back
 * (`parseRetroGates`) to the value it was made from.
 */
export function editRetroGates(
  path: string,
  text: string | null,
  additions: readonly RetroGatesAddition[],
  done: readonly RetroItemDone[] = [],
): Result<RetroGatesEdit, "invalid"> {
  let current = emptyRetroGates();
  if (text !== null) {
    const parsed = parseRetroGates(path, text);
    if (!parsed.ok) return err("invalid", parsed.error.message);
    current = parsed.value;
  }
  const added = applyRetroResults(current, additions);
  const finished = applyItemsDone(added.gates, done);
  const gates = finished.gates;
  const summary = [...added.summary, ...finished.summary];
  const out = serializeRetroGates(gates);
  const back = parseRetroGates(path, out);
  if (!back.ok) return err("invalid", `the new text does not parse: ${back.error.message}`);
  if (!Bun.deepEquals(back.value, gates, true)) return err("invalid", `${path}: the new text does not parse back to the value written`);
  return ok({ text: out, summary });
}
