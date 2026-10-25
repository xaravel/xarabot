import type { Snapshot, SnapshotManifest } from "../schemas/snapshot.ts";
import { storyKey } from "../story-id.ts";
import type { Reason } from "./next.ts";

/**
 * The Epic-level holds the builder and the planning position share (FR2,
 * AR14, Story 2.7): an Epic waits on each Epic it depends on (`dependency-epic`)
 * until that Epic's every Story is `done` and its retro is recorded, and on
 * any Epic it reaches whose retro is `rejected` with no go (`retro-rejected`).
 * A bootstrapped dependency never holds. Its own module, so `next` and the
 * coordinator side share it with no import cycle. Pure.
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
  const reaches = (from: number, target: number): boolean => {
    const seen = new Set<number>();
    const stack = [...depsOf(from)];
    while (stack.length > 0) {
      const n = stack.pop() as number;
      if (n === target) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...depsOf(n));
    }
    return false;
  };
  const rejected = epics
    .map((e) => ({ epic: e.number, retro: snap.retro_gates.epics[String(e.number)]?.retro }))
    .filter((r) => r.retro?.verdict === "rejected" && r.retro.go === undefined)
    .map((r) => r.epic);

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
    for (const e of rejected) {
      if (!reaches(n, e)) continue;
      reasons.push({ subject, code: "retro-rejected", message: `Epic ${n} is held by Epic ${e}'s rejected retro (retro:${e}), which has no go` });
    }
    return reasons;
  };
}
