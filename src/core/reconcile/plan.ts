import { isDisposable, isStale, isUngatedRetro } from "../ledger/edits.ts";
import { RETRO_ITEM_ID_PATTERN, RETRO_UNIT_PATTERN } from "../schemas/retro-gates.ts";
import { approvalParkedAt, doneOnMain, epicStatusKey, isGraphPlanning, missingStatusEntries } from "../next/coordinator.ts";
import { unitKind, type PendingRuling, type UnitRecord } from "../schemas/ledger.ts";
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
   * For a re-park (the record's `lane` is `coordinator` and it has an
   * `enqueued_sha`: the coordinator took it on approval, fenced it at its head
   * and parked it again, or parked it again with a new graph delta), or for
   * a park with a posted graph delta (`graph_posted`, written only once the
   * delta comment succeeded, retro item 33), its `heartbeat_at`: an approval
   * must be submitted after it. `null` for any other first park, a builder's
   * or the coordinator's own (a planning or `reconcile` gate park has no
   * `enqueued_sha`), and for a taken record the runner never enqueued,
   * returned to its park without a graph delta (`takeApproved` clears
   * `enqueued_sha`): any standing owner approval of the head counts.
   */
  readonly parked_at: string | null;
  /** The head a review round passed (Story 3.5): a take needs the passed gate at `head_sha`. */
  readonly passed_sha: string | null;
  /** The providers that built the PR, whom its reviewer must differ from (AD-16). */
  readonly builder_providers: readonly string[];
  /** The paths the PR's diff changes (the park's `globs_held`). */
  readonly globs: readonly string[];
  /**
   * The graph hash of the delta the runner posted on the PR (the park's
   * `graph_posted`, retro item 24); `null` when none was posted. A graph
   * change is taken only at this hash: any other merge result, or none
   * posted, parks it again with the new delta. For a taken record the
   * runner never enqueued, returned to its park (`untake`), the taken
   * record's `approved_graph`, the hash its approval was taken on.
   */
  readonly graph_posted: string | null;
};

/** A coordinator-held `merging` record taken on approval, whose queue is checked. */
export type GatedTarget = {
  readonly unit: string;
  readonly generation: number;
  readonly pr: number;
  readonly pr_owner: string | null;
  readonly head_sha: string | null;
  readonly approved_sha: string | null;
  /** The merge result's graph hash the Maintainer's approval was taken on; `null` when the take held no graph change. */
  readonly approved_graph: string | null;
  /**
   * The head the coordinator enqueued it at, or fenced before parking it
   * again; `null` while the runner has not enqueued it since the take.
   */
  readonly enqueued_sha: string | null;
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

/** The `retro-gates.yaml` write for merged retro (Story 2.9) and retro-item (Story 2.10) records, and pending rulings (Story 4.6). */
export type RetroGatesPlan =
  /** No merged retro result to record, no merged item to set `done` and no pending ruling `main` does not show: nothing changes. */
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
  /**
   * 3. Coordinator-held `merging` records that are not disposable or
   * ungated retros, whose PR has not merged: their queue is checked, and a
   * PR out of it parks again; one the runner never enqueued (no
   * `enqueued_sha`) is taken again on its standing approval.
   */
  readonly checkGated: readonly GatedTarget[];
  /**
   * 3a. Coordinator-held `merging` ungated retro and retro-item records
   * (`isUngatedRetro`), whose PR has not merged: their queue is checked, and
   * a PR out of it is released with an attempt, never parked awaiting
   * approval.
   */
  readonly checkUngated: readonly PlanTarget[];
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
   * with a `retro_result` and their PR merged at the record's `head_sha`
   * (the head the result was validated at), whose Epic has no `retro` entry
   * on `main`; then
   * `status: done` for the item of each `retro-item:<id>` record `merged` as
   * of this run whose item is listed on `main` and not `done`; then each
   * pending ruling (Story 4.6) `main` does not show yet.
   */
  readonly retroGates: RetroGatesPlan;
  /** `merged` `retro:<N>` records with no `retro_result`, or whose PR the snapshot does not show merged at the record's `head_sha`: logged and skipped. */
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

/**
 * Whether every Story of graph Epic `epic` is `done` in `status`: the Epic
 * has at least one Story, no unmanifested heading, and each Story's manifest
 * key is `done`.
 */
function epicStoriesDone(snapshot: Snapshot, epic: number, status: Readonly<Record<string, string>>): boolean {
  if (!snapshot.graph.ok) return false;
  const graph = snapshot.graph.value;
  if (graph.unmanifested.some((u) => u.epic === epic)) return false;
  const stories = graph.epics.find((e) => e.number === epic)?.stories ?? [];
  if (stories.length === 0) return false;
  return stories.every((id) => {
    const m = snapshot.manifests.find((x) => storyKey(x.story_id) === storyKey(id));
    return m !== undefined && Object.hasOwn(status, m.sprint_key) && status[m.sprint_key] === "done";
  });
}

/**
 * The status changes, computed from `main`, for the records `merged` as of
 * this run. An Epic's `epic-<N>` key is set `done` in the edit that sets its
 * last Story `done` (E6, retro item 16): added `done` when absent, except for
 * a bootstrapped Epic; never set back from `done`.
 */
function statusChanges(effective: Snapshot, unit: string): { readonly changes: StatusChanges; readonly summary: string[] } {
  const status = effective.sprint_status.development_status;
  const has = (key: string) => Object.hasOwn(status, key);
  const set = new Map<string, string>();
  const add = new Map<string, { readonly status: string; readonly epic: number }>();
  const missing = missingStatusEntries(effective);
  const storyEpics = new Set<number>();

  for (const r of effective.ledger.units) {
    if (r.unit === unit || r.state !== "merged") continue;
    const kind = unitKind(r.unit);
    if (kind === "story") {
      const body = r.unit.slice(r.unit.indexOf(":") + 1);
      const m = effective.manifests.find((x) => storyKey(x.story_id) === storyKey(body));
      if (m === undefined) continue;
      if (!has(m.sprint_key)) add.set(m.sprint_key, { status: "done", epic: m.epic });
      else if (status[m.sprint_key] !== "done") set.set(m.sprint_key, "done");
      else continue;
      storyEpics.add(m.epic);
    } else if (kind === "planning" && isGraphPlanning(r) && !doneOnMain(r, effective)) {
      for (const e of missing) if (!add.has(e.key)) add.set(e.key, { status: "backlog", epic: e.epic });
    }
  }

  // Each Epic whose last Story this edit sets done.
  const edited: Record<string, string> = { ...status };
  for (const [key, s] of set) edited[key] = s;
  for (const [key, a] of add) edited[key] = a.status;
  const bootstrapped = new Set(effective.config.bootstrapped_epics);
  for (const epic of storyEpics) {
    if (!epicStoriesDone(effective, epic, edited)) continue;
    const key = epicStatusKey(epic);
    if (has(key)) {
      if (status[key] !== "done") set.set(key, "done");
    } else if (!bootstrapped.has(epic)) add.set(key, { status: "done", epic });
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
 * The retro results to record: each `merged` `retro:<N>` record of
 * `effective` with no `retro` entry on `main` whose result is bound to the
 * merged head: the snapshot shows its PR merged at the record's `head_sha`,
 * the head the result was validated at. Any other is `without`.
 */
function retroAdditions(effective: Snapshot, unit: string): { readonly additions: RetroGatesAddition[]; readonly without: string[] } {
  const additions: RetroGatesAddition[] = [];
  const without: string[] = [];
  for (const r of effective.ledger.units) {
    if (r.unit === unit || r.state !== "merged") continue;
    const m = RETRO_UNIT_PATTERN.exec(r.unit);
    if (m === null) continue;
    const epic = m[1] as string;
    if (effective.retro_gates.epics[epic]?.retro !== undefined) continue;
    const pr = effective.prs[r.unit];
    const bound = pr?.state === "merged" && pr.number === r.pr && pr.head_sha === r.head_sha;
    if (r.retro_result === null || !bound) {
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
 * The `retro-gates.yaml` write over `retroGatesText` (`main`'s, `null` when
 * absent) for `additions`, the items `done` and the `pending` rulings (Story
 * 4.6): `none` when there is nothing to apply or the edit changes nothing
 * (an empty summary).
 */
export function planRetroGates(
  path: string,
  retroGatesText: string | null,
  additions: readonly RetroGatesAddition[],
  done: readonly RetroItemDone[],
  pending: readonly PendingRuling[],
): RetroGatesPlan {
  if (additions.length === 0 && done.length === 0 && pending.length === 0) return { kind: "none" };
  const edited = editRetroGates(path, retroGatesText, additions, done, [], pending);
  if (!edited.ok) return { kind: "invalid", message: edited.error.message };
  if (edited.value.summary.length === 0) return { kind: "none" };
  return { kind: "edit", text: edited.value.text, summary: edited.value.summary };
}

/**
 * The plan for `reconcile` unit `unit` from `snapshot`. `statusText` is
 * `sprint_status_path`'s text on the snapshot's `main`, and `retroGatesText`
 * `retro_gates_path`'s; each `null` when the file is absent.
 * `pendingRulings` is the pending rulings list (Story 4.6), by default the snapshot
 * `coordinator.json`'s.
 */
export function planReconcile(
  snapshot: Snapshot,
  unit: string,
  statusText: string | null,
  retroGatesText: string | null = null,
  pendingRulings: readonly PendingRuling[] = snapshot.ledger.coordinator?.pending_rulings ?? [],
): ReconcilePlan {
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

  // 3. Approval-gated PRs the coordinator queued; 3a. ungated retro and retro-item PRs their step queued.
  const checkGated: GatedTarget[] = [];
  const checkUngated: PlanTarget[] = [];
  for (const r of others) {
    if (marked.has(r.unit) || isDisposable(r) || r.state !== "merging" || r.lane !== "coordinator") continue;
    if (prOf(r)?.state === "merged") continue;
    if (isUngatedRetro(r)) {
      checkUngated.push(target(r, snapshot));
      continue;
    }
    if (r.pr === null) continue;
    checkGated.push({
      unit: r.unit,
      generation: r.generation,
      pr: r.pr,
      pr_owner: r.pr_owner,
      head_sha: r.head_sha,
      approved_sha: r.approved_sha,
      approved_graph: r.approved_graph,
      enqueued_sha: r.enqueued_sha,
      globs: r.globs,
    });
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
      parked_at: approvalParkedAt(r),
      passed_sha: r.passed_sha,
      builder_providers: r.builder_providers,
      globs: r.park.globs_held,
      graph_posted: r.park.graph_posted ?? null,
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
  const retroGates = planRetroGates(retroGatesPath, retroGatesText, additions, done, pendingRulings);

  return {
    markMerged,
    checkQueue,
    checkGated,
    checkUngated,
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
