import { isDisposable, isStale } from "../ledger/edits.ts";
import { RETRO_ITEM_ID_PATTERN, RETRO_UNIT_PATTERN } from "../schemas/retro-gates.ts";
import { doneOnMain, epicStatusKey, isGraphPlanning, missingStatusEntries } from "../next/coordinator.ts";
import { unitKind, type UnitRecord } from "../schemas/ledger.ts";
import type { PrState, Snapshot } from "../schemas/snapshot.ts";
import { storyKey } from "../story-id.ts";
import { editRetroGates, type RetroGatesAddition, type RetroItemDone } from "./retro-gates-edit.ts";
import { editDevelopmentStatus, type StatusAddition, type StatusChange, type StatusChanges } from "./status-edit.ts";

/**
 * The `reconcile` planner (FR2, NFR20, AR4, AR10, AR14): what one run does,
 * read from one snapshot. Pure. The step does the ledger work it lists, one
 * fenced swap per item, then either finishes the run with no PR or opens one
 * PR with the new `sprint-status.yaml` text, the new `retro-gates.yaml` text
 * (Story 2.9: retro verdicts and items; Story 2.10: merged items `done`), or
 * both. The run's own unit is never a target.
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

/** A parked PR the run may take on its owner's standing approval. */
export type ApprovalTarget = {
  readonly unit: string;
  readonly generation: number;
  readonly pr: number;
  readonly pr_owner: string;
  /** The record's head, which the snapshot shows the PR still at. */
  readonly head_sha: string;
  /**
   * For a re-park (the record's `lane` is `coordinator` and it has a
   * `passed_sha`: the coordinator took it on approval, fenced it at its head
   * and parked it again), its `heartbeat_at`: an approval must be submitted
   * after it. `null` for a first park, a builder's or the coordinator's own
   * (a planning or `reconcile` gate park has no `passed_sha`): any standing
   * owner approval of the head counts.
   */
  readonly parked_at: string | null;
  /** The paths the PR's diff changes (the park's `globs_held`). */
  readonly globs: readonly string[];
};

/** A coordinator-held `merging` record taken on approval, whose queue is checked. */
export type GatedTarget = {
  readonly unit: string;
  readonly generation: number;
  readonly pr: number;
  readonly pr_owner: string | null;
  readonly head_sha: string | null;
  readonly approved_sha: string | null;
  /** The paths the PR's diff changes, kept since the first park. */
  readonly globs: readonly string[];
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

/** The `retro-gates.yaml` write for merged retro (Story 2.9) and retro-item (Story 2.10) records. */
export type RetroGatesPlan =
  /** No merged retro result to record and no merged item to set `done`. */
  | { readonly kind: "none" }
  /** The new text, and one line per change. */
  | { readonly kind: "edit"; readonly text: string; readonly summary: readonly string[] }
  /** The file cannot be written; `message` says why. The run fails. */
  | { readonly kind: "invalid"; readonly message: string };

export type ReconcilePlan = {
  /** 1. Records not `merged` whose PR merged. */
  readonly markMerged: readonly string[];
  /**
   * 2. Coordinator-held `merging` disposable records (`isDisposable`: a
   * `reconcile` record, or a status planning record with `approved_sha`
   * `null`) whose PR has not merged: their queue is checked, and a PR out of
   * it is closed and its record released with no attempt.
   */
  readonly checkQueue: readonly PlanTarget[];
  /** 3. Coordinator-held `merging` records that are not disposable, whose PR has not merged: their queue is checked, and a PR out of it parks again. */
  readonly checkGated: readonly GatedTarget[];
  /** 4. `parked` `awaiting-approval` records whose PR is open at the record's head: taken on a standing owner approval (after the park only for a re-park of a record the coordinator took). */
  readonly takeApproved: readonly ApprovalTarget[];
  /** 5. Stale `claimed` `reconcile` records: the open PRs on their branch closed, then released with an attempt. */
  readonly releaseDead: readonly PlanTarget[];
  /**
   * 6. `released` `reconcile` records, and `released` planning records whose
   * PR the snapshot does not show open (an open one is the open-PR
   * position's to resume): the open PRs on their branch closed, then deleted.
   */
  readonly deleteReleased: readonly PlanTarget[];
  /** 7. `merged` records (as of this run) whose unit is done on `main`. */
  readonly deleteMerged: readonly string[];
  /** `sprint_status_path`. */
  readonly path: string;
  readonly status: StatusPlan;
  /**
   * Every other `reconcile` record whose PR the snapshot shows open. Those
   * the ledger work leaves open stop a new PR this run.
   */
  readonly openPrs: readonly { readonly unit: string; readonly pr: number }[];
  /** The other `merged` `reconcile` records left after step 7, deleted once this run finishes `merged`. */
  readonly supersededMerged: readonly string[];
  /** `retro_gates_path`. */
  readonly retroGatesPath: string;
  /**
   * The verdicts and items of `retro:<N>` records `merged` as of this run,
   * with a `retro_result`, whose Epic has no `retro` entry on `main`; then
   * `status: done` for the item of each `retro-item:<id>` record `merged` as
   * of this run whose item is listed on `main` and not `done`.
   */
  readonly retroGates: RetroGatesPlan;
  /** `merged` `retro:<N>` records with no `retro_result`: logged and skipped. */
  readonly retroWithoutResult: readonly string[];
  /** `merged` `retro-item:<id>` records whose item `retro-gates.yaml` does not list: logged and skipped. */
  readonly retroItemsMissing: readonly string[];
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

/** The retro results to record: each `merged` `retro:<N>` record of `effective` with a result and no `retro` entry on `main`. */
function retroAdditions(effective: Snapshot, unit: string): { readonly additions: RetroGatesAddition[]; readonly without: string[] } {
  const additions: RetroGatesAddition[] = [];
  const without: string[] = [];
  for (const r of effective.ledger.units) {
    if (r.unit === unit || r.state !== "merged") continue;
    const m = RETRO_UNIT_PATTERN.exec(r.unit);
    if (m === null) continue;
    const epic = m[1] as string;
    if (effective.retro_gates.epics[epic]?.retro !== undefined) continue;
    if (r.retro_result === null) {
      without.push(r.unit);
      continue;
    }
    additions.push({ epic: Number(epic), unit: r.unit, result: r.retro_result, recorded_at: effective.now });
  }
  return { additions, without };
}

/** The retro items to set `done`: each `merged` `retro-item:<id>` record of `effective` whose item is listed on `main` and not `done`. */
function itemsDone(effective: Snapshot, unit: string): { readonly done: RetroItemDone[]; readonly missing: string[] } {
  const done: RetroItemDone[] = [];
  const missing: string[] = [];
  for (const r of effective.ledger.units) {
    if (r.unit === unit || r.state !== "merged" || unitKind(r.unit) !== "retro-item") continue;
    const id = r.unit.slice(r.unit.indexOf(":") + 1);
    const epic = RETRO_ITEM_ID_PATTERN.exec(id)?.[1];
    const item = epic === undefined ? undefined : effective.retro_gates.epics[epic]?.items?.find((i) => i.id === id);
    if (epic === undefined || item === undefined) {
      missing.push(r.unit);
      continue;
    }
    if (item.status !== "done") done.push({ epic: Number(epic), id });
  }
  return { done, missing };
}

/**
 * The plan for `reconcile` unit `unit` from `snapshot`. `statusText` is
 * `sprint_status_path`'s text on the snapshot's `main`, and `retroGatesText`
 * `retro_gates_path`'s; each `null` when the file is absent.
 */
export function planReconcile(snapshot: Snapshot, unit: string, statusText: string | null, retroGatesText: string | null = null): ReconcilePlan {
  const others = snapshot.ledger.units.filter((r) => r.unit !== unit);
  const prOf = (r: UnitRecord) => snapshot.prs[r.unit];
  const isReconcile = (r: UnitRecord) => unitKind(r.unit) === "reconcile";

  // 1. Records whose PR merged.
  const markMerged = others.filter((r) => r.state !== "merged" && prOf(r)?.state === "merged").map((r) => r.unit);
  const marked = new Set(markMerged);
  const unmerged = others.filter((r) => !marked.has(r.unit) && prOf(r)?.state !== "merged");
  const pending = unmerged.filter(isReconcile);
  const isPlanning = (r: UnitRecord) => unitKind(r.unit) === "planning";

  // 2, 5, 6. Earlier reconcile runs, disposable planning PRs and released planning records.
  const checkQueue = unmerged.filter((r) => isDisposable(r) && r.state === "merging" && r.lane === "coordinator").map((r) => target(r, snapshot));
  const releaseDead = pending.filter((r) => r.state === "claimed" && isStale(r, snapshot.now)).map((r) => target(r, snapshot));
  const deleteReleased = unmerged
    .filter((r) => r.state === "released" && (isReconcile(r) || (isPlanning(r) && prOf(r)?.state !== "open")))
    .map((r) => target(r, snapshot));

  // 3. Approval-gated PRs the coordinator queued.
  const checkGated: GatedTarget[] = [];
  for (const r of others) {
    if (marked.has(r.unit) || isDisposable(r) || r.state !== "merging" || r.lane !== "coordinator") continue;
    if (r.pr === null || prOf(r)?.state === "merged") continue;
    checkGated.push({ unit: r.unit, generation: r.generation, pr: r.pr, pr_owner: r.pr_owner, head_sha: r.head_sha, approved_sha: r.approved_sha, globs: r.globs });
  }

  // 4. Parked PRs awaiting approval, still open at the head the lane parked.
  const takeApproved: ApprovalTarget[] = [];
  for (const r of others) {
    if (marked.has(r.unit) || r.state !== "parked" || r.park?.kind !== "awaiting-approval") continue;
    if (r.pr === null || r.pr_owner === null || r.head_sha === null) continue;
    const p = prOf(r);
    if (p?.state !== "open" || p.head_sha !== r.head_sha) continue;
    takeApproved.push({
      unit: r.unit,
      generation: r.generation,
      pr: r.pr,
      pr_owner: r.pr_owner,
      head_sha: r.head_sha,
      parked_at: r.lane === "coordinator" && r.passed_sha !== null ? r.heartbeat_at : null,
      globs: r.park.globs_held,
    });
  }

  // 7. Records merged as of this run whose unit is done on main.
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

  const retroGatesPath = snapshot.config.retro_gates_path;
  const { additions, without } = retroAdditions(effective, unit);
  const { done, missing: itemsMissing } = itemsDone(effective, unit);
  let retroGates: RetroGatesPlan = { kind: "none" };
  if (additions.length > 0 || done.length > 0) {
    const edited = editRetroGates(retroGatesPath, retroGatesText, additions, done);
    retroGates = edited.ok ? { kind: "edit", text: edited.value.text, summary: edited.value.summary } : { kind: "invalid", message: edited.error.message };
  }

  return {
    markMerged,
    checkQueue,
    checkGated,
    takeApproved,
    releaseDead,
    deleteReleased,
    deleteMerged,
    path,
    status,
    openPrs,
    supersededMerged,
    retroGatesPath,
    retroGates,
    retroWithoutResult: without,
    retroItemsMissing: itemsMissing,
  };
}
