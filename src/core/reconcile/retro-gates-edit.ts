import { emptyRetroGates, parseRetroGates } from "../graph/retro-gates.ts";
import { normalizeGlob } from "../manifests/globs.ts";
import type { ClosedItemStatus } from "../next/epic-gates.ts";
import { err, ok, type Result } from "../result.ts";
import { bodyOf } from "../rulings/rulings.ts";
import { unitKind, type PendingRuling } from "../schemas/ledger.ts";
import { RETRO_ITEM_ID_PATTERN, type Go, type RetroGates, type RetroGatesEntry, type RetroItem, type RetroRecordResult } from "../schemas/retro-gates.ts";

/**
 * `reconcile`'s write of retro verdicts and items to `retro-gates.yaml`
 * (Story 2.9, AR4, AR13): the only writer of those records. Applying a
 * merged retro's result sets the Epic's `retro` and appends each item not
 * already listed, with `status: open` when `route: lane` and `status:
 * waiting` when `route: maintainer` (Story 4.3: a routed item waits on the
 * Maintainer's ruling); a merged retro item's unit sets its item `status:
 * done` (Story 2.10), and a ruled `done` or `defer` sets its item `done` or
 * `deferred` (Story 4.3), and each pending ruling (Story 4.6: `go`,
 * `block`, `unblock`, `done`, `defer`) is applied last; the file is then
 * rewritten whole, in a fixed, deterministic form. Comments in a hand-edited
 * file are not kept; its data, a hand-recorded `go` included, is. Pure.
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

/** A status a ruling sets on a retro item: `/xarabot done` or `/xarabot defer`, the closed statuses. */
export type RuledItemStatus = ClosedItemStatus;

/** One retro item whose status a ruling sets (Story 4.3; Story 4.6 parses the ruling). */
export type RetroItemStatusChange = {
  readonly epic: number;
  /** The item's id. */
  readonly id: string;
  readonly status: RuledItemStatus;
};

/**
 * `gates` with each listed item of `changes` that is not `done` yet set to
 * its `status`, so `deferred` -> `done` is allowed and a `done` item stays
 * `done`; an item already at its status, an unknown id and an unknown Epic
 * are left out. One line per change is returned as the summary:
 * `epics.<N>.items: <id> <old> -> <new>`.
 */
export function applyItemStatuses(gates: RetroGates, changes: readonly RetroItemStatusChange[]): { readonly gates: RetroGates; readonly summary: string[] } {
  const epics: Record<string, RetroGatesEntry> = { ...gates.epics };
  const summary: string[] = [];
  const sorted = [...changes].sort((a, b) => a.epic - b.epic);
  for (const c of sorted) {
    const key = String(c.epic);
    const entry = epics[key];
    const items = entry?.items;
    if (entry === undefined || items === undefined) continue;
    const i = items.findIndex((x) => x.id === c.id);
    const item = items[i];
    if (item === undefined || item.status === "done" || item.status === c.status) continue;
    epics[key] = { ...entry, items: items.map((x, j) => (j === i ? { ...x, status: c.status } : x)) };
    summary.push(`epics.${key}.items: ${c.id} ${item.status} -> ${c.status}`);
  }
  return { gates: { schema_version: gates.schema_version, epics }, summary };
}

/** `applyItemStatuses` with `done` for each item of `done` (Story 2.10). */
export function applyItemsDone(gates: RetroGates, done: readonly RetroItemDone[]): { readonly gates: RetroGates; readonly summary: string[] } {
  return applyItemStatuses(
    gates,
    done.map((d) => ({ epic: d.epic, id: d.id, status: "done" as const })),
  );
}

/**
 * `gates` with each addition applied: `epics.<N>.retro` = {`verdict`,
 * `unit`, `recorded_at`}, then each result item whose id the Epic does not
 * list yet appended with its globs normalized, with `status: open` when
 * `route: lane` and `status: waiting` when `route: maintainer`; an item
 * already listed keeps its status. An Epic whose `retro` is already
 * recorded is left as it is. One line per change is returned as the
 * summary: the retro, then `epics.<N>.items: <id> added as <status>` per
 * item.
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
    const added: RetroItem[] = [];
    for (const i of a.result.items) {
      if (listed.has(i.id)) continue;
      listed.add(i.id);
      const globs = i.globs.map((g) => {
        const n = normalizeGlob(g);
        return n.ok ? n.value : g;
      });
      const item: RetroItem = { id: i.id, text: i.text, route: i.route, blocking: i.blocking, globs, status: i.route === "maintainer" ? "waiting" : "open" };
      items.push(item);
      added.push(item);
    }
    epics[key] = { ...entry, retro: { verdict: a.result.verdict, unit: a.unit, recorded_at: a.recorded_at }, ...(items.length > 0 || entry.items !== undefined ? { items } : {}) };
    summary.push(`epics.${key}.retro: ${a.result.verdict} (${a.unit})`);
    for (const i of added) summary.push(`epics.${key}.items: ${i.id} added as ${i.status}`);
  }
  return { gates: { schema_version: gates.schema_version, epics }, summary };
}

/**
 * `gates` with each pending ruling of `pending` applied in order (Story
 * 4.6): `go checkpoint:<N>` sets `epics.<N>.checkpoint.go` = {by, at,
 * ruling} unless one is there; `go retro:<N>` sets `epics.<N>.retro.go`
 * only on a rejected retro with no go; `block` and `unblock` set a listed
 * item's `blocking`; `done` and `defer` set its status through
 * `applyItemStatuses`. A ruling that changes nothing (already there, or
 * nothing to apply it to, such as an item no longer listed) is left out.
 * One line per change is returned as the summary, so an entry is shown on
 * a file when applying it alone gives none.
 */
export function applyPendingRulings(gates: RetroGates, pending: readonly PendingRuling[]): { readonly gates: RetroGates; readonly summary: string[] } {
  let current = gates;
  const summary: string[] = [];
  for (const e of pending) {
    const epics: Record<string, RetroGatesEntry> = { ...current.epics };
    const go: Go = { by: e.by, at: e.at, ruling: e.ruling };
    const body = bodyOf(e.unit);
    const kind = unitKind(e.unit);
    if (e.verb === "go" && kind === "checkpoint") {
      const entry = epics[body] ?? {};
      if (entry.checkpoint !== undefined) continue;
      epics[body] = { ...entry, checkpoint: { go } };
      summary.push(`epics.${body}.checkpoint: go by ${e.by} (${e.ruling})`);
    } else if (e.verb === "go" && kind === "retro") {
      const entry = epics[body];
      const retro = entry?.retro;
      if (entry === undefined || retro === undefined || retro.verdict !== "rejected" || retro.go !== undefined) continue;
      epics[body] = { ...entry, retro: { ...retro, go } };
      summary.push(`epics.${body}.retro: go by ${e.by} (${e.ruling})`);
    } else if (e.verb === "block" || e.verb === "unblock") {
      const epic = RETRO_ITEM_ID_PATTERN.exec(body)?.[1];
      const entry = epic === undefined ? undefined : epics[epic];
      const items = entry?.items;
      const blocking = e.verb === "block";
      const i = items?.findIndex((x) => x.id === body) ?? -1;
      const item = items?.[i];
      if (entry === undefined || items === undefined || item === undefined || item.blocking === blocking) continue;
      epics[epic as string] = { ...entry, items: items.map((x, j) => (j === i ? { ...x, blocking } : x)) };
      summary.push(`epics.${epic as string}.items: ${body} blocking ${String(item.blocking)} -> ${String(blocking)}`);
    } else if (e.verb === "done" || e.verb === "defer") {
      const epic = RETRO_ITEM_ID_PATTERN.exec(body)?.[1];
      if (epic === undefined) continue;
      const ruled = applyItemStatuses(current, [{ epic: Number(epic), id: body, status: e.verb === "done" ? "done" : "deferred" }]);
      current = ruled.gates;
      summary.push(...ruled.summary);
      continue;
    } else continue;
    current = { schema_version: current.schema_version, epics };
  }
  return { gates: current, summary };
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
 * (Story 2.10), then the ruled item `statuses` (Story 4.3), then the
 * pending `rulings` (Story 4.6, `applyPendingRulings`, applied last),
 * over `text` (`null` when the file is absent, read as `{schema_version:
 * 1, epics: {}}`), or why it cannot be written: the current text does not
 * parse, or the new text does not parse back (`parseRetroGates`) to the
 * value it was made from.
 */
export function editRetroGates(
  path: string,
  text: string | null,
  additions: readonly RetroGatesAddition[],
  done: readonly RetroItemDone[] = [],
  statuses: readonly RetroItemStatusChange[] = [],
  rulings: readonly PendingRuling[] = [],
): Result<RetroGatesEdit, "invalid"> {
  let current = emptyRetroGates();
  if (text !== null) {
    const parsed = parseRetroGates(path, text);
    if (!parsed.ok) return err("invalid", parsed.error.message);
    current = parsed.value;
  }
  const added = applyRetroResults(current, additions);
  const finished = applyItemsDone(added.gates, done);
  const ruled = applyItemStatuses(finished.gates, statuses);
  const pending = applyPendingRulings(ruled.gates, rulings);
  const gates = pending.gates;
  const summary = [...added.summary, ...finished.summary, ...ruled.summary, ...pending.summary];
  const out = serializeRetroGates(gates);
  const back = parseRetroGates(path, out);
  if (!back.ok) return err("invalid", `the new text does not parse: ${back.error.message}`);
  if (!Bun.deepEquals(back.value, gates, true)) return err("invalid", `${path}: the new text does not parse back to the value written`);
  return ok({ text: out, summary });
}
