import type { RetroItem } from "../schemas/retro-gates.ts";
import type { Snapshot, SnapshotManifest } from "../schemas/snapshot.ts";
import { storyKey } from "../story-id.ts";
import type { Reason } from "./reasons.ts";

/** The retro item statuses that hold nothing: the two a ruling sets (`/xarabot defer`, `/xarabot done`) through the gates edit. */
export type ClosedItemStatus = "deferred" | "done";
/** The retro item statuses that are open: `open`, `in-progress` and `waiting`. */
export type OpenItemStatus = Exclude<RetroItem["status"], ClosedItemStatus>;

const CLOSED_ITEM: ReadonlySet<RetroItem["status"]> = new Set<ClosedItemStatus>(["deferred", "done"]);

/**
 * Whether a retro item's status is open (`open`, `in-progress` or
 * `waiting`): the one rule the gates, the digest and the rulings share. An
 * open item holds, and lists in the Maintainer's inbox when routed to them;
 * a closed one (`ClosedItemStatus`) holds nothing.
 */
export function isOpenItem(status: RetroItem["status"]): status is OpenItemStatus {
  return !CLOSED_ITEM.has(status);
}

/**
 * The Epic-level holds the builder and the planning position share (FR2,
 * AR14, Story 2.7): an Epic waits on each Epic it depends on (`dependency-epic`)
 * until that Epic's every Story is `done` and its retro is recorded. The
 * retro gates (FR10, AR13, Story 4.1) go by distance: the length of the
 * shortest path of dependency edges from the held Epic down to Epic E (an
 * Epic that does not reach E is never held by E, and E is never held by its
 * own retro). E's retro `rejected` with no go holds every Epic at distance
 * ≥ 1 (`retro-rejected`); each open item of E (`open`, `in-progress` or
 * `waiting`) holds every Epic at distance ≥ 1 when it is `blocking` and ≥ 2
 * otherwise (`retro-item`), whatever its route or verdict, and a go never
 * releases it. A bootstrapped dependency never holds, but a bootstrapped
 * Epic's items do.
 *
 * A checkpoint Epic C is an Epic in `graph.checkpoints` (FR5, AR12, Story
 * 4.4). While no go is recorded for C (`retro_gates.epics[C].checkpoint`), C
 * holds every Epic at distance ≥ 1 (`checkpoint`), whether or not C's retro
 * is done, except an Epic whose every Story is `done`, which has nothing left
 * to hold. A recorded go releases the hold, and a checkpoint no longer in the
 * graph holds nothing.
 *
 * Four holds are Maintainer causes (`maintainer`, Story 4.2): the hold of a
 * rejected retro, the hold of an item routed to the Maintainer, the
 * checkpoint hold once C's retro is done (recorded, or C bootstrapped), when
 * its go is due, and the dependency hold on an Epic X that still has a Story
 * not `done` and is itself held by one of those three. X's Stories wait on
 * the Maintainer, so the Epics waiting on X do too: in chain C → 3 → 4, a
 * lane idle only for C's go waits on the Maintainer (Story 4.4, AC 1).
 *
 * Its own module, so `next` and the coordinator side share it with no import
 * cycle. Pure.
 */

/** The holds on one Epic: one reason per held cause, `[]` when nothing holds it. */
export type EpicHolds = (epic: number) => Reason[];

/** The Epic hold check over a snapshot whose graph resolved; with no graph nothing is held. */
export function epicHolds(snap: Snapshot): EpicHolds {
  if (!snap.graph.ok) return () => [];
  const graph = snap.graph.value;
  const bootstrapped = new Set(snap.config.bootstrapped_epics);
  const status = snap.sprint_status.development_status;
  const statusOf = (m: SnapshotManifest) => (Object.hasOwn(status, m.sprint_key) ? status[m.sprint_key] : undefined);
  const isDone = (m: SnapshotManifest) => statusOf(m) === "done";
  const manifestByKey = new Map(snap.manifests.map((m) => [storyKey(m.story_id), m]));
  const manifestOf = (id: string) => manifestByKey.get(storyKey(id));

  const epics = [...graph.epics].sort((a, b) => a.number - b.number);
  const epicByNumber = new Map(epics.map((e) => [e.number, e]));
  const depsOf = (n: number) => epicByNumber.get(n)?.depends_on ?? [];
  /** The shortest dependency path from `from` down to `target`, in edges; `undefined` when it does not reach it. */
  const distance = (from: number, target: number): number | undefined => {
    const seen = new Set<number>([from]);
    let frontier = [from];
    for (let d = 1; frontier.length > 0; d++) {
      const next: number[] = [];
      for (const n of frontier) {
        for (const x of depsOf(n)) {
          if (x === target) return d;
          if (seen.has(x)) continue;
          seen.add(x);
          next.push(x);
        }
      }
      frontier = next;
    }
    return undefined;
  };
  const checkpoints = new Set(graph.checkpoints);
  const sources = epics.map((e) => {
    const entry = snap.retro_gates.epics[String(e.number)];
    return {
      epic: e.number,
      rejected: entry?.retro?.verdict === "rejected" && entry.retro.go === undefined,
      items: (entry?.items ?? []).filter((item) => isOpenItem(item.status)),
      // A checkpoint with no go: `due` once its retro is done (a bootstrapped Epic counts as retro done, AD-12).
      checkpoint: checkpoints.has(e.number) && entry?.checkpoint === undefined ? { due: entry?.retro !== undefined || bootstrapped.has(e.number) } : null,
    };
  });
  /** Why Epic `x`'s Stories are not all `done`; `[]` when every one is. */
  const storyCauses = (x: number): string[] => {
    const epic = epicByNumber.get(x);
    const causes: string[] = [];
    const unmanifested = graph.unmanifested.filter((u) => u.epic === x);
    if ((epic?.stories.length ?? 0) === 0 && unmanifested.length === 0) causes.push("it has no Stories");
    for (const u of unmanifested) causes.push(`Story ${u.id} has no manifest`);
    for (const id of epic?.stories ?? []) {
      const m = manifestOf(id);
      if (m === undefined || !isDone(m)) {
        causes.push(`Story ${id} is not done (${m === undefined ? "no manifest" : (statusOf(m) ?? "no status")})`);
      }
    }
    return causes;
  };

  /** The holds on Epic `n` from the Epics it reaches: checkpoint, rejected retro and retro items. */
  const sourceHolds = (n: number, done: boolean): Reason[] => {
    const subject = `epic:${n}`;
    const reasons: Reason[] = [];
    for (const src of sources) {
      const e = src.epic;
      // A finished Epic has nothing left for a checkpoint to hold, so it never waits on the go.
      const checkpoint = done ? null : src.checkpoint;
      if (!src.rejected && src.items.length === 0 && checkpoint === null) continue;
      const d = distance(n, e);
      if (d === undefined) continue;
      if (checkpoint !== null) {
        // The go is due only once the retro is done; before that the hold is not the Maintainer's to lift.
        reasons.push(
          checkpoint.due
            ? { subject, code: "checkpoint", message: `Epic ${n} is held by checkpoint Epic ${e} (checkpoint:${e}), which has no go`, maintainer: true }
            : { subject, code: "checkpoint", message: `Epic ${n} is held by checkpoint Epic ${e} (checkpoint:${e}), whose retro is not done` },
        );
      }
      if (src.rejected) {
        reasons.push({ subject, code: "retro-rejected", message: `Epic ${n} is held by Epic ${e}'s rejected retro (retro:${e}), which has no go`, maintainer: true });
      }
      for (const item of src.items) {
        if (d < (item.blocking ? 1 : 2)) continue;
        const tag = item.blocking ? "blocking" : "untagged";
        const message = `Epic ${n} is held by Epic ${e}'s retro item retro-item:${item.id} (${item.status}, ${tag}, distance ${d})`;
        // An item routed to the Maintainer waits on the Maintainer (Story 4.2).
        reasons.push(item.route === "maintainer" ? { subject, code: "retro-item", message, maintainer: true } : { subject, code: "retro-item", message });
      }
    }
    return reasons;
  };

  return (n) => {
    const subject = `epic:${n}`;
    const reasons: Reason[] = [];
    for (const x of depsOf(n)) {
      if (bootstrapped.has(x)) continue;
      const stories = storyCauses(x);
      const causes = [...stories];
      if (snap.retro_gates.epics[String(x)]?.retro === undefined) causes.push("its retro is not recorded");
      if (causes.length === 0) continue;
      const message = `Epic ${n} waits on Epic ${x}: ${causes.join(", ")}`;
      // X's Stories wait on the Maintainer when X is held by a Maintainer cause, so this wait does too (Story 4.4).
      const onMaintainer = stories.length > 0 && sourceHolds(x, false).some((r) => r.maintainer === true);
      reasons.push(onMaintainer ? { subject, code: "dependency-epic", message, maintainer: true } : { subject, code: "dependency-epic", message });
    }
    reasons.push(...sourceHolds(n, storyCauses(n).length === 0));
    return reasons;
  };
}
