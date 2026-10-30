import { err } from "../result.ts";
import { inboxInstance } from "../inbox/render-digest.ts";
import { allOf, applyRuling, changeRulingLists, recordRulings, rulingListsOf, type LedgerEdit, type RulingLists } from "../ledger/edits.ts";
import { applyPendingRulings } from "../reconcile/retro-gates-edit.ts";
import { COORDINATOR_PATH } from "../ledger/codec.ts";
import { PENDING_RULING_VERBS, pendingKey, unitKind, type Approval, type Dismissal, type LaneIdentity, type PendingRuling, type PendingRulingVerb, type UnitRecord } from "../schemas/ledger.ts";
import type { Snapshot } from "../schemas/snapshot.ts";
import { judgeRuling, manifestOf, type RulingComment, type RulingJudgement } from "./rulings.ts";

/**
 * What each valid ruling does (Story 4.6, FR5, FR9, FR10, FR13, AR29,
 * AD-28), built from the run's snapshot. Pure.
 *
 * - `approve`, `release` and `rebuild` are ledger edits (`applyRuling`);
 *   `rebuild` also closes the PR the snapshot shows open, which the caller
 *   does before the swap.
 * - `go`, `block`, `unblock`, `done` and `defer` are pending entries in
 *   `coordinator.json` (Maintainer decision 1), which `reconcile` writes into
 *   `retro-gates.yaml` on every run until `main` shows them.
 * - `dismiss` is a dismissal in `coordinator.json` (Maintainer decision 2):
 *   the digest leaves the item out until it comes back as a new instance.
 *
 * A batch is judged in order, each comment against a view: the snapshot
 * with every pending entry applied to `retro_gates` and each earlier valid
 * ruling of the batch applied. All of a batch's effects go into one ledger
 * swap (`rulingsEdit`), so a batch lands whole or not at all.
 */

export { pendingKey };

/** A ruling to judge: its comment, id and creation time. */
export type RulingInput = RulingComment & { readonly id: string; readonly created_at: string };

/** Where a batch comes from: inbox comments, or the Maintainer's `xarabot rule` on the host. */
export type RulingSource = "comment" | "host";

/** The `ruling` a host ruling's pending entry records, as `maintainer-pr` names a hand-written go. */
export const HOST_RULING_ID = "xarabot-rule";

export type LedgerRulingVerb = "approve" | "release" | "rebuild";

export type RulingEffect =
  /** An `applyRuling` edit at the record's `generation`; `approval` for `approve`, and the open PR `rebuild` closes first. */
  | {
      readonly kind: "ledger";
      readonly verb: LedgerRulingVerb;
      readonly unit: string;
      readonly generation: number;
      readonly approval: Approval | null;
      readonly closePr: number | null;
    }
  | { readonly kind: "pending"; readonly entry: PendingRuling }
  | { readonly kind: "dismissal"; readonly dismissal: Dismissal };

/** One ruling judged: its effect is set exactly when the judgement is valid. */
export type JudgedRuling<C extends RulingInput = RulingInput> = {
  readonly comment: C;
  readonly judgement: RulingJudgement;
  readonly effect: RulingEffect | null;
};

const PENDING_VERBS: readonly string[] = PENDING_RULING_VERBS;

/** `snapshot` with `pending` (default its `coordinator.json`'s list) applied to `retro_gates`, in order. */
export function withPending(snapshot: Snapshot, pending: readonly PendingRuling[] = snapshot.ledger.coordinator?.pending_rulings ?? []): Snapshot {
  if (pending.length === 0) return snapshot;
  return { ...snapshot, retro_gates: applyPendingRulings(snapshot.retro_gates, pending).gates };
}

/** `view` with its `coordinator.json` lists set to `lists`; unchanged with no `coordinator.json`. */
function withLists(view: Snapshot, lists: RulingLists): Snapshot {
  const c = view.ledger.coordinator;
  if (c === null) return view;
  const { pending_rulings: _p, dismissals: _d, ...rest } = c;
  const coordinator = {
    ...rest,
    ...(lists.pending.length === 0 ? {} : { pending_rulings: [...lists.pending] }),
    ...(lists.dismissals.length === 0 ? {} : { dismissals: [...lists.dismissals] }),
  };
  return { ...view, ledger: { ...view.ledger, coordinator } };
}

/** `view` with one effect applied: a released record, a pending entry on `retro_gates` and the list, or a dismissal. */
function applyEffect(view: Snapshot, effect: RulingEffect): Snapshot {
  switch (effect.kind) {
    case "ledger": {
      const units = view.ledger.units.map((r): UnitRecord => {
        if (r.unit !== effect.unit) return r;
        const released: UnitRecord = { ...r, state: "released", park: null, attempts: 0, loopbacks: 0, ci_fixes: 0 };
        if (effect.verb === "approve") return { ...r, state: "released", park: null, approval: effect.approval };
        if (effect.verb === "rebuild") {
          return { ...released, builder_providers: [], reviewed_sha: null, passed_sha: null, enqueued_sha: null, approved_sha: null, approved_graph: null, retro_result: null };
        }
        return released;
      });
      return { ...view, ledger: { ...view.ledger, units } };
    }
    case "pending": {
      const gated = { ...view, retro_gates: applyPendingRulings(view.retro_gates, [effect.entry]).gates };
      return withLists(gated, changeRulingLists(rulingListsOf(view.ledger.coordinator), {}, { pending: [effect.entry] }));
    }
    case "dismissal":
      return withLists(view, changeRulingLists(rulingListsOf(view.ledger.coordinator), {}, { dismissals: [effect.dismissal] }));
  }
}

/** The effect of a valid ruling in `view`, or why it has none (a refusal reason). */
function effectOf(view: Snapshot, j: Extract<RulingJudgement, { kind: "valid" }>, comment: RulingInput, source: RulingSource): RulingEffect | string {
  const { verb, unit } = j;
  const r = view.ledger.units.find((x) => x.unit === unit);
  if (verb === "approve" || verb === "release" || verb === "rebuild") {
    if (r === undefined) return `${unit} has no ledger record`;
    let approval: Approval | null = null;
    if (verb === "approve") {
      const m = manifestOf(view, unit);
      if (m === undefined) return `${unit} has no manifest on main`;
      approval = { by: j.author, manifest_sha: m.sha };
    }
    const closePr = verb === "rebuild" && r.pr !== null && view.prs[unit]?.state === "open" ? r.pr : null;
    return { kind: "ledger", verb, unit, generation: r.generation, approval, closePr };
  }
  if (PENDING_VERBS.includes(verb)) {
    const host = source === "host";
    const entry: PendingRuling = {
      verb: verb as PendingRulingVerb,
      unit,
      by: host ? view.config.maintainer : j.author,
      at: host ? view.now : comment.created_at,
      ruling: host ? HOST_RULING_ID : comment.id,
    };
    return { kind: "pending", entry };
  }
  const instance = inboxInstance(view, unit);
  if (instance === null) return `no inbox lists ${unit}`;
  return { kind: "dismissal", dismissal: { unit, subject: instance.subject, since: instance.since } };
}

/**
 * A batch judged in order (`judgeRuling`), each comment against the view
 * the earlier ones left: the snapshot with its pending entries applied
 * (`withPending`), then each earlier valid ruling's effect. So a second
 * `release` of a unit is refused (it is released), a second `go` is refused
 * (there is a go), and `unblock` while a `block` is pending is valid and
 * replaces it. From the host, a pending entry is the Maintainer's, at the
 * snapshot's `now`, with `ruling` `xarabot-rule`. Returns the judged batch
 * and the view it leaves.
 */
export function judgeRulings<C extends RulingInput>(
  snapshot: Snapshot,
  comments: readonly C[],
  source: RulingSource = "comment",
): { readonly judged: readonly JudgedRuling<C>[]; readonly view: Snapshot } {
  let view = withPending(snapshot);
  const judged: JudgedRuling<C>[] = [];
  for (const comment of comments) {
    const judgement = judgeRuling(view, comment);
    if (judgement.kind !== "valid") {
      judged.push({ comment, judgement, effect: null });
      continue;
    }
    const effect = effectOf(view, judgement, comment, source);
    if (typeof effect === "string") {
      judged.push({ comment, judgement: { kind: "refused", verb: judgement.verb, unit: judgement.unit, reason: effect }, effect: null });
      continue;
    }
    judged.push({ comment, judgement, effect });
    view = applyEffect(view, effect);
  }
  return { judged, view };
}

/** The pending entries and dismissals a judged batch adds. */
export function rulingAdds(judged: readonly JudgedRuling[]): { readonly pending: readonly PendingRuling[]; readonly dismissals: readonly Dismissal[] } {
  const pending: PendingRuling[] = [];
  const dismissals: Dismissal[] = [];
  for (const j of judged) {
    if (j.effect?.kind === "pending") pending.push(j.effect.entry);
    else if (j.effect?.kind === "dismissal") dismissals.push(j.effect.dismissal);
  }
  return { pending, dismissals };
}

export type RulingsDrops = { readonly pending: readonly PendingRuling[]; readonly dismissals: readonly Dismissal[] };

/** Whether the snapshot shows a `reconcile` record's PR open: its `retro-gates.yaml` can still change what `main` shows. */
function reconcilePrOpen(snapshot: Snapshot): boolean {
  return snapshot.ledger.units.some((r) => unitKind(r.unit) === "reconcile" && snapshot.prs[r.unit]?.state === "open");
}

/**
 * What a run drops from the snapshot's `coordinator.json` lists: each
 * pending entry `main` shows (applying it alone to `main`'s
 * `retro-gates.yaml` changes nothing, which covers one that can no longer
 * apply), and each dismissal whose unit `view` (the final view) lists as a
 * new instance, with another subject or start time. A dismissal whose item
 * is not listed stays: it is no new instance. When `main`'s graph does not
 * resolve, the snapshot's `retro_gates` is empty rather than `main`'s, so no
 * pending entry is dropped. While the snapshot shows a `reconcile` PR open,
 * no pending entry is dropped either (Epic 4 retro item 1): that PR may
 * carry an earlier ruling the entry superseded (a `block` an `unblock`
 * replaced), so `main` showing the entry now does not keep it once the PR
 * merges; the entry is written again by the next PR, and dropped once
 * `main` shows it with no reconcile PR open.
 */
export function rulingsDrops(view: Snapshot, snapshot: Snapshot): RulingsDrops {
  const lists = rulingListsOf(snapshot.ledger.coordinator);
  const settled = snapshot.graph.ok && !reconcilePrOpen(snapshot);
  const pending = settled ? lists.pending.filter((e) => applyPendingRulings(snapshot.retro_gates, [e]).summary.length === 0) : [];
  const dismissals = lists.dismissals.filter((d) => {
    const now = inboxInstance(view, d.unit);
    return now !== null && (now.subject !== d.subject || now.since !== d.since);
  });
  return { pending, dismissals };
}

const NO_DROPS: RulingsDrops = { pending: [], dismissals: [] };

/**
 * The view a batch leaves once its swap lands: the snapshot with its
 * pending entries and each valid effect of `judged` applied, and its
 * `coordinator.json` lists as the swap writes them (`drops` removed, the
 * batch's entries added). `renderDigest` over it leaves released records
 * and dismissed items out.
 */
export function rulingsView(snapshot: Snapshot, judged: readonly JudgedRuling[], drops: RulingsDrops = NO_DROPS): Snapshot {
  let view = withPending(snapshot);
  for (const j of judged) if (j.effect !== null) view = applyEffect(view, j.effect);
  return withLists(view, changeRulingLists(rulingListsOf(snapshot.ledger.coordinator), drops, rulingAdds(judged)));
}

export type RulingsEditParams = {
  /** The writer: the coordinator lane (the host's own lane for a host ruling with only a ledger effect). */
  readonly by: LaneIdentity;
  /** The forge's time. */
  readonly now: string;
  /** `coordinator.json`'s generation in the snapshot; `null` when it has none. */
  readonly coordinatorGeneration: number | null;
  /** The cursor move, or `null` to leave it (a host ruling, or a drop-only swap). */
  readonly cursor: { readonly from: string | null; readonly to: string } | null;
  readonly judged: readonly JudgedRuling[];
  readonly drops: RulingsDrops;
};

/**
 * The batch's ledger edit: `allOf` of `recordRulings` (the cursor move, the
 * drops and the batch's pending entries and dismissals; left out when it has
 * none of them) and one `applyRuling` per ledger effect, in order.
 */
export function rulingsEdit(p: RulingsEditParams): LedgerEdit {
  const adds = rulingAdds(p.judged);
  const edits: LedgerEdit[] = [];
  const needed = p.cursor !== null || adds.pending.length > 0 || adds.dismissals.length > 0 || p.drops.pending.length > 0 || p.drops.dismissals.length > 0;
  if (needed) {
    const generation = p.coordinatorGeneration;
    edits.push(
      generation === null
        ? () => err("precondition", `${COORDINATOR_PATH} is missing: the coordinator claim is lost`)
        : recordRulings({ by: p.by, now: p.now, generation, ...(p.cursor === null ? {} : { cursor: p.cursor }), drop: p.drops, add: adds }),
    );
  }
  for (const j of p.judged) {
    const e = j.effect;
    if (e?.kind !== "ledger") continue;
    edits.push(
      applyRuling({
        unit: e.unit,
        by: p.by,
        now: p.now,
        generation: e.generation,
        ruling: e.verb,
        ...(e.approval === null ? {} : { manifestSha: e.approval.manifest_sha, approver: e.approval.by }),
      }),
    );
  }
  return allOf(edits);
}
