import { EPICS_YAML_PATH } from "../config/load-repo-config.ts";
import { isStale } from "../ledger/edits.ts";
import type { Config } from "../schemas/config.ts";
import { unitKind, type UnitKind, type UnitRecord } from "../schemas/ledger.ts";
import { RETRO_ITEM_ID_PATTERN } from "../schemas/retro-gates.ts";
import type { Snapshot } from "../schemas/snapshot.ts";
import { storyKey } from "../story-id.ts";
import type { CoordinatorOutcome, Reason } from "./next.ts";
import { epicContextPath } from "./snapshot.ts";

/**
 * The coordinator's side of `next` (FR4, AR14, AD-8, AD-9, AD-13): the globs
 * each coordinator unit kind holds, when `reconcile` is due, and the
 * coordinator's order. Only `reconcile` and an open coordinator PR exist so
 * far; planning, retro, retro items and checkpoint join the order in Stories
 * 2.7, 2.9, 2.10 and 4.4. Pure.
 */

/** The pseudo-glob a graph planning unit holds, so graph changes go one at a time (AD-11). */
export const GRAPH_PSEUDO_GLOB = "xarabot:graph";

/** `reconcile` is due this long after its last run, by the forge's `now`. */
export const RECONCILE_EVERY_MS = 10 * 60 * 1000;

/** Every unit kind but `story`. */
export type CoordinatorKind = Exclude<UnitKind, "story">;

/** What `coordinatorGlobs` needs to know about a coordinator unit. */
export type CoordinatorUnitSpec =
  | { readonly kind: "planning"; readonly planning: "graph" | "status" }
  | { readonly kind: "retro"; readonly epic: number }
  | { readonly kind: "checkpoint"; readonly epic: number }
  | { readonly kind: "retro-item"; readonly globs: readonly string[] }
  | { readonly kind: "reconcile" };

export type CoordinatorGlobsConfig = Pick<
  Config,
  "epics_path" | "sprint_status_path" | "retro_gates_path" | "epic_context_path" | "retro_doc_glob" | "manifests"
>;

/** The graph inputs: `epics_path`, `.xarabot/epics.yaml` and the manifests (when `manifests` is set). */
export function graphInputGlobs(config: Pick<Config, "epics_path" | "manifests">): string[] {
  const out = [config.epics_path, EPICS_YAML_PATH];
  if (config.manifests !== undefined) out.push(`${config.manifests.dir}/*.md`);
  return out;
}

/** The status files: `sprint_status_path` and `retro_gates_path`. */
export function statusFiles(config: Pick<Config, "sprint_status_path" | "retro_gates_path">): string[] {
  return [config.sprint_status_path, config.retro_gates_path];
}

/**
 * The globs a coordinator unit holds (AD-13). Graph planning: the graph
 * inputs and `xarabot:graph`. Status planning: the status files and every
 * Epic's context path. A retro: the status files, its Epic's context path
 * and retro document glob. A checkpoint: the status files and its Epic's
 * context path. A retro item: its own globs. `reconcile`: none.
 */
export function coordinatorGlobs(spec: CoordinatorUnitSpec, config: CoordinatorGlobsConfig): string[] {
  switch (spec.kind) {
    case "planning":
      if (spec.planning === "graph") return [...graphInputGlobs(config), GRAPH_PSEUDO_GLOB];
      return [...statusFiles(config), config.epic_context_path.replaceAll("<N>", "*")];
    case "retro":
      return [
        ...statusFiles(config),
        epicContextPath(config.epic_context_path, spec.epic),
        config.retro_doc_glob.replaceAll("<N>", String(spec.epic)),
      ];
    case "checkpoint":
      return [...statusFiles(config), epicContextPath(config.epic_context_path, spec.epic)];
    case "retro-item":
      return [...spec.globs];
    case "reconcile":
      return [];
  }
}

const RECONCILE_UNIT = /^reconcile:([1-9][0-9]*)$/;

/** The run number of a `reconcile:<n>` id, or `null`. */
export function reconcileNumber(unit: string): number | null {
  const m = RECONCILE_UNIT.exec(unit);
  return m === null ? null : Number(m[1]);
}

/** The highest-numbered `reconcile:<n>` record in any state for which `keep` holds, or `null`. */
function highestReconcile(snapshot: Snapshot, keep: (r: UnitRecord) => boolean): UnitRecord | null {
  let best: UnitRecord | null = null;
  let bestN = 0;
  for (const r of snapshot.ledger.units) {
    const n = reconcileNumber(r.unit);
    if (n !== null && n > bestN && keep(r)) {
      best = r;
      bestN = n;
    }
  }
  return best;
}

/** The highest-numbered `merged` `reconcile:<n>` record: the last finished run. */
export function newestMergedReconcile(snapshot: Snapshot): UnitRecord | null {
  return highestReconcile(snapshot, (r) => r.state === "merged");
}

/** The next `reconcile` run's number: the highest number of any state, plus 1. */
export function nextReconcileNumber(snapshot: Snapshot): number {
  const top = highestReconcile(snapshot, () => true);
  return top === null ? 1 : (reconcileNumber(top.unit) as number) + 1;
}

/** A graph planning unit holds `xarabot:graph`. */
export function isGraphPlanning(record: Pick<UnitRecord, "unit" | "globs">): boolean {
  return unitKind(record.unit) === "planning" && record.globs.includes(GRAPH_PSEUDO_GLOB);
}

/** A `development_status` key the effective graph needs, and its Epic. */
export type StatusEntry = { readonly key: string; readonly epic: number };

/** An Epic's `development_status` key. */
export function epicStatusKey(epic: number): string {
  return `epic-${epic}`;
}

/**
 * The graph's `development_status` keys absent on `main`, in graph order:
 * each graph Epic's `epic-<N>`, then its manifests' `sprint_key`s in the
 * Epic's Story order (a manifest of no graph Epic last, by Epic). `[]` when
 * the graph did not resolve.
 */
export function missingStatusEntries(snapshot: Snapshot): StatusEntry[] {
  if (!snapshot.graph.ok) return [];
  const status = snapshot.sprint_status.development_status;
  const has = (key: string) => Object.hasOwn(status, key);
  const out: StatusEntry[] = [];
  const seen = new Set<string>();
  const add = (key: string, epic: number) => {
    if (has(key) || seen.has(key)) return;
    seen.add(key);
    out.push({ key, epic });
  };
  const epics = [...snapshot.graph.value.epics].sort((a, b) => a.number - b.number);
  const order = (epic: number, id: string): number => {
    const stories = epics.find((e) => e.number === epic)?.stories ?? [];
    const i = stories.findIndex((s) => storyKey(s) === storyKey(id));
    return i === -1 ? stories.length : i;
  };
  const byEpic = (epic: number) =>
    snapshot.manifests.filter((m) => m.epic === epic).sort((a, b) => order(epic, a.story_id) - order(epic, b.story_id));
  for (const e of epics) {
    add(epicStatusKey(e.number), e.number);
    for (const m of byEpic(e.number)) add(m.sprint_key, e.number);
  }
  const rest = [...new Set(snapshot.manifests.map((m) => m.epic))].filter((n) => !epics.some((e) => e.number === n)).sort((a, b) => a - b);
  for (const n of rest) for (const m of byEpic(n)) add(m.sprint_key, n);
  return out;
}

/**
 * Whether `record`'s unit is done on `main` (AD-9): a Story `done` in
 * `sprint-status.yaml` (through its manifest's `sprint_key`), a retro with a
 * recorded verdict, a retro item with status `done`, a checkpoint with its
 * go recorded, a status planning unit always, a graph planning unit once
 * every graph Epic's and manifest's key has a `development_status` entry
 * (the entries land through a later, disposable `reconcile` PR), and every
 * `merged` `reconcile` record but the newest `merged` one.
 */
export function doneOnMain(record: UnitRecord, snapshot: Snapshot): boolean {
  const kind = unitKind(record.unit);
  const body = record.unit.slice(record.unit.indexOf(":") + 1);
  const gates = snapshot.retro_gates.epics;
  switch (kind) {
    case "story": {
      const m = snapshot.manifests.find((x) => storyKey(x.story_id) === storyKey(body));
      if (m === undefined) return false;
      const status = snapshot.sprint_status.development_status;
      return Object.hasOwn(status, m.sprint_key) && status[m.sprint_key] === "done";
    }
    case "retro":
      return gates[body]?.retro !== undefined;
    case "retro-item": {
      const epic = RETRO_ITEM_ID_PATTERN.exec(body)?.[1];
      if (epic === undefined) return false;
      return (gates[epic]?.items ?? []).some((i) => i.id === body && i.status === "done");
    }
    case "checkpoint":
      return gates[body]?.checkpoint !== undefined;
    case "planning":
      if (!isGraphPlanning(record)) return true;
      return snapshot.graph.ok && missingStatusEntries(snapshot).length === 0;
    case "reconcile":
      return record.state === "merged" && newestMergedReconcile(snapshot)?.unit !== record.unit;
    case undefined:
      return false;
  }
}

/**
 * Whether the daily digest slot has passed unposted: today's `digest_time`
 * (UTC, by `now`) is due when `now` is at or past it and `postedAt` is
 * `null` or before it.
 */
export function digestDue(now: string, digestTime: string, postedAt: string | null): boolean {
  const nowMs = Date.parse(now);
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const slot = Date.parse(`${day}T${digestTime}:00Z`);
  if (nowMs < slot) return false;
  return postedAt === null || Date.parse(postedAt) < slot;
}

export type ReconcileDue = {
  readonly due: boolean;
  /** Why it is due, or why not. */
  readonly why: string;
  /** The newest `merged` `reconcile:<n>` record, the last finished run. */
  readonly last: UnitRecord | null;
};

/**
 * When `reconcile` is due (the Maintainer's 2026-10-24 decision): the
 * snapshot shows work (a record not `merged` whose PR merged, or a `merged`
 * record whose unit is done on `main`), there is no `merged`
 * `reconcile:<n>` record, or `now` is 10 min or more past the newest
 * `merged` one's `heartbeat_at`. A passed digest slot is not work until
 * Story 4.2 adds it back.
 */
export function reconcileDue(snapshot: Snapshot): ReconcileDue {
  const last = newestMergedReconcile(snapshot);
  for (const r of snapshot.ledger.units) {
    const pr = snapshot.prs[r.unit];
    if (r.state !== "merged" && pr?.state === "merged") {
      return { due: true, why: `${r.unit} is ${r.state} but its PR #${pr.number} merged`, last };
    }
  }
  for (const r of snapshot.ledger.units) {
    if (r.state === "merged" && doneOnMain(r, snapshot)) return { due: true, why: `${r.unit} is merged and done on main`, last };
  }
  if (last === null) return { due: true, why: "no merged reconcile run on the ledger", last };
  const since = Date.parse(snapshot.now) - Date.parse(last.heartbeat_at);
  if (since >= RECONCILE_EVERY_MS) return { due: true, why: `${last.unit} ran at ${last.heartbeat_at}, 10 min or more ago`, last };
  return { due: false, why: `${last.unit} ran at ${last.heartbeat_at}, under 10 min ago, and the snapshot shows no reconcile work`, last };
}

/** The coordinator unit `next` picked. */
export type CoordinatorUnit = {
  readonly unit: string;
  readonly kind: CoordinatorKind;
  readonly globs: readonly string[];
  /** The released or taken-over record's generation, or `null` for a unit with no record. */
  readonly expect_generation: number | null;
  /** `claimed` for a stale `claimed` record the coordinator takes over. */
  readonly take_over: "claimed" | null;
  /** The unit's open PR, or `null`. */
  readonly pr: number | null;
  /** Why it was picked. */
  readonly why: string;
};

const NOTHING_DUE = "no coordinator unit due";

/** The coordinator states an open coordinator PR's record may be in. */
const OPEN_PR_STATES: readonly UnitRecord["state"][] = ["claimed", "merging", "released"];

/**
 * The coordinator's next unit from a validated snapshot whose graph resolved
 * (AD-13): `reconcile` when due, then an open coordinator PR, else `idle`.
 * Never a Story. The open-PR position never returns a `reconcile` record (a
 * released or dead run's PR is the next `reconcile` run's to close), but a
 * live one still makes later positions wait.
 */
export function nextCoordinator(snapshot: Snapshot): CoordinatorOutcome {
  const reasons: Reason[] = [];

  // 1. reconcile.
  const r = reconcileDue(snapshot);
  if (r.due) {
    const n = nextReconcileNumber(snapshot);
    const unit = { unit: `reconcile:${n}`, kind: "reconcile", globs: [], expect_generation: null, take_over: null, pr: null, why: r.why } as const;
    return { kind: "coordinator", unit, reasons };
  }
  reasons.push({ subject: r.last?.unit ?? "reconcile:1", code: "reconcile-not-due", message: `reconcile is not due: ${r.why}` });

  // 2. An open coordinator PR, in unit order.
  let open = false;
  for (const rec of snapshot.ledger.units) {
    const kind = unitKind(rec.unit);
    if (kind === undefined || kind === "story" || rec.lane !== "coordinator" || !OPEN_PR_STATES.includes(rec.state)) continue;
    const pr = snapshot.prs[rec.unit];
    if (pr?.state !== "open") continue;
    if (kind === "reconcile" && (rec.state === "released" || (rec.state === "claimed" && isStale(rec, snapshot.now)))) continue;
    open = true;
    if (kind === "reconcile") {
      reasons.push({ subject: rec.unit, code: "record-state", message: `${rec.unit} is ${rec.state} with reconcile PR #${pr.number} open` });
      continue;
    }
    const base = { unit: rec.unit, kind, globs: [...rec.globs], expect_generation: rec.generation, pr: pr.number } as const;
    if (rec.state === "released") {
      return { kind: "coordinator", unit: { ...base, take_over: null, why: `${rec.unit} is released with PR #${pr.number} open` }, reasons };
    }
    if (rec.state === "claimed" && isStale(rec, snapshot.now)) {
      const why = `${rec.unit} is claimed and stale (heartbeat ${rec.heartbeat_at}) with PR #${pr.number} open`;
      return { kind: "coordinator", unit: { ...base, take_over: "claimed", why }, reasons };
    }
    reasons.push({ subject: rec.unit, code: "record-state", message: `${rec.unit} is ${rec.state} with coordinator PR #${pr.number} open` });
  }
  const messages = reasons.map((x) => x.message);
  if (open) return { kind: "idle", reason: ["waiting on an open coordinator PR", ...messages].join("; "), reasons };

  // 3. Planning, retro, retro items and checkpoint arrive in Stories 2.7, 2.9, 2.10 and 4.4.
  return { kind: "idle", reason: [NOTHING_DUE, ...messages].join("; "), reasons };
}
