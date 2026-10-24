import { isStale } from "../ledger/edits.ts";
import { doneOnMain, epicStatusKey, isGraphPlanning, missingStatusEntries } from "../next/coordinator.ts";
import { unitKind, type UnitRecord } from "../schemas/ledger.ts";
import type { PrState, Snapshot } from "../schemas/snapshot.ts";
import { storyKey } from "../story-id.ts";
import { editDevelopmentStatus, type StatusAddition, type StatusChange, type StatusChanges } from "./status-edit.ts";

/**
 * The `reconcile` planner (FR2, NFR20, AR4, AR10, AR14): what one run does,
 * read from one snapshot. Pure. The step does the ledger work it lists, one
 * fenced swap per item, then either finishes the run with no PR or opens one
 * PR with the new `sprint-status.yaml` text. The run's own unit is never a
 * target.
 */

/** A record the run acts on, with its PR as the snapshot shows it. */
export type PlanTarget = {
  readonly unit: string;
  readonly generation: number;
  readonly pr: number | null;
  /** The PR's state in the snapshot; `null` when the record has no PR or the forge reported none. */
  readonly pr_state: PrState["state"] | null;
  readonly head_sha: string | null;
};

export type StatusPlan =
  /** Nothing to change on `main`. */
  | { readonly kind: "none" }
  /** Changes are due but there is no `sprint-status.yaml` to edit. */
  | { readonly kind: "absent"; readonly changes: StatusChanges }
  /** The file cannot be edited in place; `message` says why. */
  | { readonly kind: "invalid"; readonly changes: StatusChanges; readonly message: string }
  /** The new text, and one line per change. */
  | { readonly kind: "edit"; readonly changes: StatusChanges; readonly text: string; readonly summary: readonly string[] };

export type ReconcilePlan = {
  /** 1. Records not `merged` whose PR merged. */
  readonly markMerged: readonly string[];
  /** 2. Coordinator-held `merging` `reconcile` records whose PR has not merged: their queue is checked. */
  readonly checkQueue: readonly PlanTarget[];
  /** 3. Stale `claimed` `reconcile` records: the open PRs on their branch closed, then released with an attempt. */
  readonly releaseDead: readonly PlanTarget[];
  /** 4. `released` `reconcile` records: the open PRs on their branch closed, then deleted. */
  readonly deleteReleased: readonly PlanTarget[];
  /** 5. `merged` records (as of this run) whose unit is done on `main`. */
  readonly deleteMerged: readonly string[];
  /** `sprint_status_path`. */
  readonly path: string;
  readonly status: StatusPlan;
  /**
   * Every other `reconcile` record whose PR the snapshot shows open. Those
   * the ledger work leaves open stop a new PR this run.
   */
  readonly openPrs: readonly { readonly unit: string; readonly pr: number }[];
  /** The other `merged` `reconcile` records left after step 5, deleted once this run finishes `merged`. */
  readonly supersededMerged: readonly string[];
};

function target(r: UnitRecord, snapshot: Snapshot): PlanTarget {
  const pr = snapshot.prs[r.unit];
  return { unit: r.unit, generation: r.generation, pr: r.pr ?? pr?.number ?? null, pr_state: pr?.state ?? null, head_sha: r.head_sha };
}

/** `snapshot` with `merged` applied to the named records, as this run leaves them. */
function asMerged(snapshot: Snapshot, merged: ReadonlySet<string>): Snapshot {
  const units = snapshot.ledger.units.map((r) => (merged.has(r.unit) ? { ...r, state: "merged" as const, park: null } : r));
  return { ...snapshot, ledger: { ...snapshot.ledger, units } };
}

/** The keys of Epic `epic` a new key of it may follow: its Epic key, its manifests' keys, and `<epic>-<n>-…` keys. */
function epicKeys(snapshot: Snapshot, epic: number): string[] {
  const own = new RegExp(`^${epic}-[0-9]+-`);
  const keys = [epicStatusKey(epic), ...snapshot.manifests.filter((m) => m.epic === epic).map((m) => m.sprint_key)];
  for (const k of Object.keys(snapshot.sprint_status.development_status)) if (own.test(k)) keys.push(k);
  return [...new Set(keys)];
}

/** The status changes, computed from `main`, for the records `merged` as of this run. */
function statusChanges(effective: Snapshot, unit: string): { readonly changes: StatusChanges; readonly summary: string[] } {
  const status = effective.sprint_status.development_status;
  const has = (key: string) => Object.hasOwn(status, key);
  const set = new Map<string, string>();
  const add = new Map<string, { readonly status: string; readonly epic: number }>();
  const missing = missingStatusEntries(effective);

  for (const r of effective.ledger.units) {
    if (r.unit === unit || r.state !== "merged") continue;
    const kind = unitKind(r.unit);
    if (kind === "story") {
      const body = r.unit.slice(r.unit.indexOf(":") + 1);
      const m = effective.manifests.find((x) => storyKey(x.story_id) === storyKey(body));
      if (m === undefined) continue;
      if (!has(m.sprint_key)) add.set(m.sprint_key, { status: "done", epic: m.epic });
      else if (status[m.sprint_key] !== "done") set.set(m.sprint_key, "done");
    } else if (kind === "planning" && isGraphPlanning(r) && !doneOnMain(r, effective)) {
      for (const e of missing) if (!add.has(e.key)) add.set(e.key, { status: "backlog", epic: e.epic });
    }
  }

  const order = (key: string): number => {
    const i = missing.findIndex((e) => e.key === key);
    return i === -1 ? missing.length : i;
  };
  const epics = [...new Set([...add.values()].map((a) => a.epic))].sort((a, b) => a - b);
  const additions: StatusAddition[] = epics.map((epic) => {
    const entries: StatusChange[] = [...add.entries()]
      .filter(([, a]) => a.epic === epic)
      .sort(([a], [b]) => (a === epicStatusKey(epic) ? -1 : b === epicStatusKey(epic) ? 1 : order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0)))
      .map(([key, a]) => ({ key, status: a.status }));
    return { after: epicKeys(effective, epic), entries };
  });
  const sets: StatusChange[] = [...set.entries()].map(([key, s]) => ({ key, status: s }));
  const summary = [
    ...sets.map((c) => `${c.key}: ${status[c.key] ?? ""} -> ${c.status}`),
    ...additions.flatMap((a) => a.entries.map((e) => `${e.key}: added as ${e.status}`)),
  ];
  return { changes: { set: sets, add: additions }, summary };
}

/**
 * The plan for `reconcile` unit `unit` from `snapshot`. `statusText` is
 * `sprint_status_path`'s text on the snapshot's `main`, or `null` when the
 * file is absent.
 */
export function planReconcile(snapshot: Snapshot, unit: string, statusText: string | null): ReconcilePlan {
  const others = snapshot.ledger.units.filter((r) => r.unit !== unit);
  const prOf = (r: UnitRecord) => snapshot.prs[r.unit];
  const isReconcile = (r: UnitRecord) => unitKind(r.unit) === "reconcile";

  // 1. Records whose PR merged.
  const markMerged = others.filter((r) => r.state !== "merged" && prOf(r)?.state === "merged").map((r) => r.unit);
  const marked = new Set(markMerged);
  const pending = others.filter((r) => isReconcile(r) && !marked.has(r.unit) && prOf(r)?.state !== "merged");

  // 2-4. Earlier reconcile runs.
  const checkQueue = pending.filter((r) => r.state === "merging" && r.lane === "coordinator").map((r) => target(r, snapshot));
  const releaseDead = pending.filter((r) => r.state === "claimed" && isStale(r, snapshot.now)).map((r) => target(r, snapshot));
  const deleteReleased = pending.filter((r) => r.state === "released").map((r) => target(r, snapshot));

  // 5. Records merged as of this run whose unit is done on main.
  const effective = asMerged(snapshot, marked);
  const mergedNow = effective.ledger.units.filter((r) => r.unit !== unit && r.state === "merged");
  const deleteMerged = mergedNow.filter((r) => doneOnMain(r, effective)).map((r) => r.unit);
  const deleted = new Set(deleteMerged);
  const supersededMerged = mergedNow.filter((r) => isReconcile(r) && !deleted.has(r.unit)).map((r) => r.unit);

  const openPrs = others.filter((r) => isReconcile(r) && prOf(r)?.state === "open").map((r) => ({ unit: r.unit, pr: (prOf(r) as PrState).number }));

  const path = snapshot.config.sprint_status_path;
  const { changes, summary } = statusChanges(effective, unit);
  let status: StatusPlan;
  if (changes.set.length === 0 && changes.add.length === 0) status = { kind: "none" };
  else if (statusText === null) status = { kind: "absent", changes };
  else {
    const edited = editDevelopmentStatus(path, statusText, changes);
    status = edited.ok ? { kind: "edit", changes, text: edited.value, summary } : { kind: "invalid", changes, message: edited.error.message };
  }

  return { markMerged, checkQueue, releaseDead, deleteReleased, deleteMerged, path, status, openPrs, supersededMerged };
}
