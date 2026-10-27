import type { RetroItem } from "../schemas/retro-gates.ts";
import type { Snapshot, SnapshotManifest } from "../schemas/snapshot.ts";
import { storyKey } from "../story-id.ts";
import type { Reason } from "./reasons.ts";

/** The item statuses that hold nothing; an item with any other status is open and holds. */
const CLOSED_ITEM: ReadonlySet<RetroItem["status"]> = new Set<RetroItem["status"]>(["deferred", "done"]);

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
 * Epic's items do. A rejected retro's hold, and an item's routed to the
 * Maintainer, are Maintainer causes (`maintainer`, Story 4.2). Its own module, so `next` and the coordinator side share
 * it with no import cycle. Pure.
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
  const sources = epics.map((e) => {
    const entry = snap.retro_gates.epics[String(e.number)];
    return {
      epic: e.number,
      rejected: entry?.retro?.verdict === "rejected" && entry.retro.go === undefined,
      items: (entry?.items ?? []).filter((item) => !CLOSED_ITEM.has(item.status)),
    };
  });

  return (n) => {
    const subject = `epic:${n}`;
    const reasons: Reason[] = [];
    for (const x of depsOf(n)) {
      if (bootstrapped.has(x)) continue;
      const dep = epicByNumber.get(x);
      const causes: string[] = [];
      const unmanifested = graph.unmanifested.filter((u) => u.epic === x);
      if ((dep?.stories.length ?? 0) === 0 && unmanifested.length === 0) causes.push("it has no Stories");
      for (const u of unmanifested) causes.push(`Story ${u.id} has no manifest`);
      for (const id of dep?.stories ?? []) {
        const m = manifestOf(id);
        if (m === undefined || !isDone(m)) {
          causes.push(`Story ${id} is not done (${m === undefined ? "no manifest" : (statusOf(m) ?? "no status")})`);
        }
      }
      if (snap.retro_gates.epics[String(x)]?.retro === undefined) causes.push("its retro is not recorded");
      if (causes.length > 0) reasons.push({ subject, code: "dependency-epic", message: `Epic ${n} waits on Epic ${x}: ${causes.join(", ")}` });
    }
    for (const src of sources) {
      const e = src.epic;
      if (!src.rejected && src.items.length === 0) continue;
      const d = distance(n, e);
      if (d === undefined) continue;
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
}
