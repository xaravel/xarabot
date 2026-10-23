import { heldGlobs } from "../ledger/edits.ts";
import { globsOverlap } from "../manifests/globs.ts";
import { resolveManifestGlobs } from "../manifests/parse-manifest.ts";
import { describeIssues } from "../schemas/common.ts";
import type { UnitRecord } from "../schemas/ledger.ts";
import { LaneRole, SnapshotSchema, type Snapshot, type SnapshotManifest } from "../schemas/snapshot.ts";
import { compareStoryIds } from "../story-id.ts";
import { epicContextPath } from "./snapshot.ts";

export type ReasonCode =
  | "unmanifested"
  | "unclaimable"
  | "dependency-epic"
  | "retro-rejected"
  | "epic-context"
  | "record-state"
  | "depends-on"
  | "escalation"
  | "overlap";

/** Why a Story or Epic was passed over. `subject` is `epic:<N>` or a unit id. */
export type Reason = { readonly subject: string; readonly code: ReasonCode; readonly message: string };

/** The Story `next` picked. */
export type NextStory = {
  readonly unit: string;
  readonly story_id: string;
  readonly epic: number;
  readonly sprint_key: string;
  readonly title: string;
  readonly manifest_path: string;
  readonly manifest_sha: string;
  readonly globs: readonly string[];
  readonly infrastructure: boolean;
  /** The released record's generation, or `null` when the Story has no record. */
  readonly expect_generation: number | null;
};

export type NextOutcome =
  | { readonly kind: "unit"; readonly story: NextStory; readonly reasons: readonly Reason[] }
  | { readonly kind: "park"; readonly park: "needs-approval"; readonly story: NextStory; readonly reasons: readonly Reason[] }
  | { readonly kind: "idle"; readonly reason: string; readonly reasons: readonly Reason[] }
  | { readonly kind: "stop"; readonly reason: string };

const NOTHING_LEFT = "no Story left to build";

const storyUnit = (id: string) => `story:${id}`;
const epicOf = (id: string) => Number(id.slice(0, id.indexOf(".")));

/** A Story id's join key, the rule `resolveGraph` uses: numeric Epic and Story parts, then the suffix (`2.01` → `2.1`). */
function storyKey(id: string): string {
  const m = /^(\d+)\.(\d+)([a-z]?)$/.exec(id);
  return m === null ? id : `${Number(m[1])}.${Number(m[2])}${m[3] ?? ""}`;
}

function stop(reason: string): NextOutcome {
  return { kind: "stop", reason };
}

/**
 * Picks a builder lane's next unit from one snapshot (FR2, AR14, AR28): the
 * lowest eligible Epic, then its lowest eligible Story. Returns the Story as
 * a `unit`, an Infrastructure Story without a current approval as `park`,
 * `idle` with the reasons nothing is eligible, or `stop`. Pure; never throws.
 */
export function next(snapshot: Snapshot, laneRole: LaneRole): NextOutcome {
  const checked = SnapshotSchema.safeParse(snapshot);
  if (!checked.success) return stop(`invalid snapshot: ${describeIssues(checked.error)}`);
  const snap = checked.data;
  const role = LaneRole.safeParse(laneRole);
  if (!role.success) return stop(`unknown lane role "${String(laneRole)}"`);
  if (role.data !== snap.role) return stop(`lane role "${role.data}" differs from the snapshot's role "${snap.role}"`);
  if (role.data === "coordinator") return stop("coordinator selection is not available yet (Epic 2)");
  if (!snap.graph.ok) return stop(snap.graph.error.message);
  const graph = snap.graph.value;
  const { config } = snap;

  const bootstrapped = new Set(config.bootstrapped_epics);
  const status = snap.sprint_status.development_status;
  const statusOf = (m: SnapshotManifest) => (Object.hasOwn(status, m.sprint_key) ? status[m.sprint_key] : undefined);
  const isDone = (m: SnapshotManifest) => statusOf(m) === "done";
  const manifestByKey = new Map(snap.manifests.map((m) => [storyKey(m.story_id), m]));
  const manifestOf = (id: string) => manifestByKey.get(storyKey(id));
  const records = new Map<string, UnitRecord>(snap.ledger.units.map((r) => [r.unit, r]));
  const escalated = new Set((snap.escalations?.open ?? []).map(storyKey));

  const globsOf = new Map<string, readonly string[]>();
  const unclaimable = new Map<string, string>();
  for (const m of snap.manifests) {
    const g = resolveManifestGlobs(m, config.manifests);
    if (g.ok) globsOf.set(m.story_id, g.value);
    else if (g.error.kind === "unclaimable") unclaimable.set(m.story_id, g.error.message);
    else return stop(g.error.message);
  }

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

  const reasons: Reason[] = [];
  const candidates: SnapshotManifest[] = [];

  for (const epic of epics) {
    const n = epic.number;
    if (bootstrapped.has(n)) continue;
    const subject = `epic:${n}`;

    for (const u of graph.unmanifested.filter((x) => x.epic === n)) {
      reasons.push({
        subject: storyUnit(u.id),
        code: "unmanifested",
        message: `Story ${u.id} has a heading (${config.epics_path}:${u.line}) but no manifest`,
      });
    }
    for (const id of epic.stories) {
      const why = unclaimable.get(id);
      if (why !== undefined) reasons.push({ subject: storyUnit(id), code: "unclaimable", message: why });
    }

    let held = false;
    for (const x of epic.depends_on) {
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
      if (causes.length > 0) {
        held = true;
        reasons.push({ subject, code: "dependency-epic", message: `Epic ${n} waits on Epic ${x}: ${causes.join(", ")}` });
      }
    }

    for (const e of rejected) {
      if (!reaches(n, e)) continue;
      held = true;
      reasons.push({
        subject,
        code: "retro-rejected",
        message: `Epic ${n} is held by Epic ${e}'s rejected retro (retro:${e}), which has no go`,
      });
    }

    const context = snap.epic_context[String(n)] ?? "missing";
    if (context !== "valid") {
      held = true;
      reasons.push({
        subject,
        code: "epic-context",
        message: `Epic ${n} context ${epicContextPath(config.epic_context_path, n)} is ${context}`,
      });
    }
    if (held) continue;

    for (const id of [...epic.stories].sort(compareStoryIds)) {
      const m = manifestOf(id);
      if (m === undefined || isDone(m)) continue;
      const unit = storyUnit(id);
      const before = reasons.length;

      const rec = records.get(unit);
      if (rec !== undefined && rec.state !== "released") {
        reasons.push({ subject: unit, code: "record-state", message: `${unit} is ${rec.state}` });
      }

      const globs = globsOf.get(id);
      if (globs === undefined) continue;

      for (const d of m.depends_on) {
        const dm = manifestOf(d);
        const satisfied =
          bootstrapped.has(epicOf(d)) ||
          (dm !== undefined && isDone(dm)) ||
          records.get(storyUnit(dm?.story_id ?? d))?.state === "merged";
        if (!satisfied) {
          reasons.push({ subject: unit, code: "depends-on", message: `Story ${id} waits on Story ${d}` });
        }
      }

      if (escalated.has(storyKey(id))) {
        reasons.push({ subject: unit, code: "escalation", message: `Story ${id} has an open escalation` });
      }

      for (const other of snap.ledger.units) {
        if (other.unit === unit) continue;
        for (const held of heldGlobs(other)) {
          const hit = globs.find((g) => globsOverlap(g, held));
          if (hit !== undefined) {
            reasons.push({
              subject: unit,
              code: "overlap",
              message: `Story ${id} glob "${hit}" overlaps "${held}" held by ${other.unit}`,
            });
          }
        }
      }

      if (reasons.length === before) candidates.push(m);
    }
  }

  const chosen = candidates[0];
  if (chosen === undefined) {
    return { kind: "idle", reason: reasons.length === 0 ? NOTHING_LEFT : reasons.map((r) => r.message).join("; "), reasons };
  }
  const rec = records.get(storyUnit(chosen.story_id));
  const story: NextStory = {
    unit: storyUnit(chosen.story_id),
    story_id: chosen.story_id,
    epic: chosen.epic,
    sprint_key: chosen.sprint_key,
    title: chosen.title,
    manifest_path: chosen.path,
    manifest_sha: chosen.sha,
    globs: globsOf.get(chosen.story_id) ?? [],
    infrastructure: chosen.infrastructure,
    expect_generation: rec?.state === "released" ? rec.generation : null,
  };
  if (chosen.infrastructure && rec?.approval?.manifest_sha !== chosen.sha) {
    return { kind: "park", park: "needs-approval", story, reasons };
  }
  return { kind: "unit", story, reasons };
}
