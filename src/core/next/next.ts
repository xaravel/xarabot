import { heldGlobs, isStale } from "../ledger/edits.ts";
import { globsOverlap } from "../manifests/globs.ts";
import { resolveManifestGlobs } from "../manifests/parse-manifest.ts";
import { describeIssues } from "../schemas/common.ts";
import type { UnitRecord } from "../schemas/ledger.ts";
import { LaneRole, SnapshotSchema, type Snapshot, type SnapshotManifest } from "../schemas/snapshot.ts";
import { compareStoryIds, storyKey } from "../story-id.ts";
import { nextCoordinator, type CoordinatorUnit } from "./coordinator.ts";
import { epicHolds } from "./epic-gates.ts";
import { epicContextPath } from "./snapshot.ts";

export type ReasonCode =
  | "reconcile-not-due"
  | "unmanifested"
  | "unclaimable"
  | "dependency-epic"
  | "retro-rejected"
  | "epic-context"
  | "record-state"
  | "depends-on"
  | "escalation"
  | "overlap"
  | "planning-held"
  | "live-evidence";

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
  /** The released or taken-over record's generation, or `null` when the Story has no record. */
  readonly expect_generation: number | null;
  /**
   * The stale record the lane takes over (FR3, AR7): a `claimed` record, or a
   * builder-held `merging` one; `null` for a claim of no record or a released one.
   */
  readonly take_over: "claimed" | "merging" | null;
};

export type NextOutcome =
  | { readonly kind: "unit"; readonly story: NextStory; readonly reasons: readonly Reason[] }
  | { readonly kind: "park"; readonly park: "needs-approval"; readonly story: NextStory; readonly reasons: readonly Reason[] }
  /** A coordinator unit; only the coordinator role gets one. */
  | { readonly kind: "coordinator"; readonly unit: CoordinatorUnit; readonly reasons: readonly Reason[] }
  | { readonly kind: "idle"; readonly reason: string; readonly reasons: readonly Reason[] }
  | { readonly kind: "stop"; readonly reason: string };

/** What a builder lane gets: never a coordinator unit. */
export type BuilderOutcome = Exclude<NextOutcome, { readonly kind: "coordinator" }>;
/** What the coordinator gets: never a Story. */
export type CoordinatorOutcome = Exclude<NextOutcome, { readonly kind: "unit" | "park" }>;

const NOTHING_LEFT = "no Story left to build";

const storyUnit = (id: string) => `story:${id}`;
const epicOf = (id: string) => Number(id.slice(0, id.indexOf(".")));

/**
 * The stale record a lane may take over: a `claimed` one, or a `merging` one
 * a builder holds, once the snapshot's `now` is 30 min or more past its
 * heartbeat. `parked` records never expire.
 */
function takeOverOf(rec: UnitRecord | undefined, now: string): NextStory["take_over"] {
  if (rec === undefined || !isStale(rec, now)) return null;
  if (rec.state === "claimed") return "claimed";
  if (rec.state === "merging" && rec.lane !== "coordinator") return "merging";
  return null;
}

function stop(reason: string): { readonly kind: "stop"; readonly reason: string } {
  return { kind: "stop", reason };
}

/**
 * Picks a lane's next unit from one snapshot (FR2, FR4, AR14, AR28).
 *
 * A builder gets the lowest eligible Epic, then its lowest eligible Story:
 * the Story as a `unit` (a stale `claimed` or builder-held `merging` record
 * as a `take_over`), an Infrastructure Story without a current approval as
 * `park`, `idle` with the reasons nothing is eligible, or `stop`.
 *
 * The coordinator gets a `coordinator` unit in AD-13's order
 * (`nextCoordinator`), `idle`, or `stop`; never a Story.
 *
 * Pure; never throws.
 */
export function next(snapshot: Snapshot, laneRole: "builder"): BuilderOutcome;
export function next(snapshot: Snapshot, laneRole: "coordinator"): CoordinatorOutcome;
export function next(snapshot: Snapshot, laneRole: LaneRole): NextOutcome;
export function next(snapshot: Snapshot, laneRole: LaneRole): NextOutcome {
  const checked = SnapshotSchema.safeParse(snapshot);
  if (!checked.success) return stop(`invalid snapshot: ${describeIssues(checked.error)}`);
  const snap = checked.data;
  const role = LaneRole.safeParse(laneRole);
  if (!role.success) return stop(`unknown lane role "${String(laneRole)}"`);
  if (role.data !== snap.role) return stop(`lane role "${role.data}" differs from the snapshot's role "${snap.role}"`);
  if (!snap.graph.ok) return stop(snap.graph.error.message);
  if (role.data === "coordinator") return nextCoordinator(snap);
  return nextBuilder(snap);
}

function nextBuilder(snap: Snapshot): BuilderOutcome {
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
  const holdsOf = epicHolds(snap);

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

    const holds = holdsOf(n);
    reasons.push(...holds);
    let held = holds.length > 0;

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
      const takeOver = takeOverOf(rec, snap.now);
      if (rec !== undefined && rec.state !== "released" && takeOver === null) {
        reasons.push({ subject: unit, code: "record-state", message: `${unit} is ${rec.state}` });
      } else if (takeOver !== null && m.infrastructure && rec?.approval?.manifest_sha !== m.sha) {
        reasons.push({
          subject: unit,
          code: "record-state",
          message: `${unit} is ${takeOver} and stale, but has no approval for manifest ${m.sha}`,
        });
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
  const takeOver = takeOverOf(rec, snap.now);
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
    expect_generation: rec !== undefined && (rec.state === "released" || takeOver !== null) ? rec.generation : null,
    take_over: takeOver,
  };
  // A takeover's approval was checked in the loop: it never parks.
  if (takeOver === null && chosen.infrastructure && rec?.approval?.manifest_sha !== chosen.sha) {
    return { kind: "park", park: "needs-approval", story, reasons };
  }
  return { kind: "unit", story, reasons };
}
