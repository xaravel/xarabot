import { loadRepoConfig } from "../core/config/load-repo-config.ts";
import { writeRules } from "../core/lane/write-check.ts";
import { failAttempt, heartbeat, park, type HeartbeatSet, type LedgerEdit } from "../core/ledger/edits.ts";
import type { NextStory } from "../core/next/next.ts";
import { sanitizeAgentText } from "../core/sanitize.ts";
import { unitPath, UnitRecordSchema, type LaneIdentity, type UnitRecord } from "../core/schemas/ledger.ts";
import type { BuildResult } from "../core/schemas/session-result.ts";
import { isLaneStopKind, type CallOpts, type Forge, type ForgeResult, type ForgeSnapshot } from "../ports/forge.ts";
import type { Committer } from "./committer.ts";
import { DEFAULT_CALL_TIMEOUT_MS, readsPath, writtenRecord, type PrStep, type PrStepInput, type PrStepOutput } from "./lane-process.ts";
import { swapLedger, type Sleep } from "./ledger-cas.ts";

/**
 * The PR step after a `done` result (FR6, FR13, FR18, FR22, NFR10, AR7, AR16,
 * AR21, AR31, AR44): one fresh snapshot, the Standing Authority re-check on
 * its `main`, the bot commit onto that `main` behind the write check (a
 * refusal parks the unit `blocked` `write-check` and pushes nothing), a
 * fencing heartbeat, a leased push, a second fence and the PR opened (or the
 * adopted one updated), the record's `pr` and SHAs, and one 🤖 status
 * comment. It never throws.
 */

export type PrStepDeps = {
  readonly forge: Forge;
  readonly committer: Committer;
  /** Who writes the ledger records. */
  readonly identity: LaneIdentity;
  /** The repo slug, for the Standing Authority check. */
  readonly repo: string;
  /** Each forge call's (and the commit's) deadline; default 60 000 ms. */
  readonly callTimeoutMs?: number;
  /** The host clock in epoch ms; default `Date.now`. */
  readonly now?: () => number;
  readonly sleep?: Sleep;
  readonly random?: () => number;
};

const ZERO_SHA = "0".repeat(40);

/** The PR title and body: both sanitized. */
export function prText(story: Pick<NextStory, "story_id" | "title">, result: Pick<BuildResult, "summary" | "body">): { readonly title: string; readonly body: string } {
  const body = result.body.trim() === "" ? result.summary : `${result.summary}\n\n${result.body}`;
  return { title: sanitizeAgentText(`Story ${story.story_id}: ${story.title}`), body: sanitizeAgentText(body) };
}

export type StatusCommentParams = {
  readonly storyId: string;
  readonly headSha: string;
  readonly lane: string;
  readonly deniedActions: readonly string[];
};

/** The 🤖 status comment: the Story, the short head SHA, the lane, then the denied actions, each sanitized onto one line. */
export function statusComment(p: StatusCommentParams): string {
  const lines = [`🤖 Story ${sanitizeAgentText(p.storyId)}: pushed ${p.headSha.slice(0, 7)} from lane ${sanitizeAgentText(p.lane)}.`, ""];
  const actions = p.deniedActions.map((a) => sanitizeAgentText(a.replace(/\s+/g, " ").trim()).trim()).filter((a) => a !== "");
  if (actions.length === 0) {
    lines.push("Denied actions: none.");
  } else {
    lines.push("Denied actions:");
    for (const action of actions) lines.push(`- ${action}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Ends the step with `out`. */
class End {
  constructor(readonly out: PrStepOutput) {}
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Control, line-separator and bidi characters: a path holding one is quoted in the log. */
// oxlint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f\u0085\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** A path for a log line: as it is, or quoted with every unsafe character escaped. */
export function shown(path: string): string {
  if (!UNSAFE.test(path)) return path;
  return JSON.stringify(path).replace(new RegExp(UNSAFE.source, "g"), (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * An approved Infrastructure Story on the fresh snapshot: the Story is
 * Infrastructure, its ledger record's approval names `manifest_sha`, and the
 * manifest on `main` still has that blob SHA.
 */
export function infrastructureApproved(story: Pick<NextStory, "unit" | "infrastructure" | "manifest_path" | "manifest_sha">, snap: ForgeSnapshot): boolean {
  if (!story.infrastructure) return false;
  const text = snap.ledger.files[unitPath(story.unit)];
  if (text === undefined) return false;
  let approval: string | undefined;
  try {
    const parsed = UnitRecordSchema.safeParse(JSON.parse(text));
    approval = parsed.success ? parsed.data.approval?.manifest_sha : undefined;
  } catch {
    return false;
  }
  return approval === story.manifest_sha && snap.main.blob_shas[story.manifest_path] === story.manifest_sha;
}

export function createPrStep(deps: PrStepDeps): PrStep {
  const { forge, committer, identity } = deps;
  const clock = deps.now ?? Date.now;
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const deadline = (): CallOpts => ({ signal: AbortSignal.timeout(callTimeoutMs) });

  return async (input: PrStepInput): Promise<PrStepOutput> => {
    const { unit: story, result } = input;
    const unit = story.unit;
    const generation = input.record.generation;
    let record: UnitRecord = input.record;
    let ontoSha: string | null = null;
    /** The snapshot's `now` and the host time it was seen at. */
    let base: { readonly now: string; readonly at: number } | null = null;
    const reasons: string[] = [];

    const note = (text: string): void => {
      try {
        input.log(`PR step: ${text}`);
      } catch {
        // A log that cannot be written never ends the step.
      }
    };
    const reason = (): string | undefined => (reasons.length === 0 ? undefined : reasons.join("; "));
    const end = (outcome: PrStepOutput["outcome"], state: PrStepOutput["state"]): End => {
      const r = reason();
      return new End({ outcome, state, record, ...(r !== undefined ? { reason: r } : {}) });
    };
    const forgeNow = (): string => {
      if (base === null) return new Date(clock()).toISOString();
      return new Date(Date.parse(base.now) + Math.max(0, clock() - base.at)).toISOString();
    };

    /** Posts the alert (its failure ignored) and stops the lane; the record stays as it is. */
    const laneStop = async (condition: string, why: string): Promise<never> => {
      try {
        await forge.alert(condition, ontoSha ?? ZERO_SHA, deadline());
      } catch {
        // The alert is best effort; the lane stops either way.
      }
      reasons.push(`${condition}: ${why}`);
      note(`stop: ${condition}: ${why}`);
      throw end("stop", record.state);
    };

    /** One forge call under its own deadline; a lane-stop kind stops the lane. */
    const call = async <T>(operation: string, run: (opts: CallOpts) => Promise<ForgeResult<T>>): Promise<ForgeResult<T>> => {
      let r: ForgeResult<T>;
      try {
        r = await run(deadline());
      } catch (e) {
        return { ok: false, error: { kind: "transient", message: `${operation} threw: ${message(e)}` } };
      }
      if (!r.ok && isLaneStopKind(r.error.kind)) await laneStop(`forge-${r.error.kind}`, `${operation}: ${r.error.message}`);
      return r;
    };

    type Swapped = { readonly kind: "ok" } | { readonly kind: "lost" | "failed"; readonly message: string };

    /** One ledger edit through the CAS loop; a ledger or forge stop stops the lane. */
    const swap = async (edit: LedgerEdit): Promise<Swapped> => {
      const r = await swapLedger({
        forge,
        edit,
        signal: AbortSignal.timeout(callTimeoutMs),
        ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
        ...(deps.random !== undefined ? { random: deps.random } : {}),
      });
      if (r.ok) {
        const written = writtenRecord(r.value.commit, unit);
        if (written !== null) record = written;
        return { kind: "ok" };
      }
      const e = r.error;
      if (e.kind === "edit" && e.edit === "stop") await laneStop("ledger-schema-version", e.message);
      if (e.kind === "forge" && isLaneStopKind(e.forge.kind)) await laneStop(`forge-${e.forge.kind}`, e.message);
      if (e.kind === "edit" && e.edit === "precondition") return { kind: "lost", message: e.message };
      return { kind: "failed", message: `ledger ${e.kind}: ${e.message}` };
    };

    /** A failed attempt: released, or parked at the attempts cap. */
    const failed = async (why: string): Promise<never> => {
      reasons.push(why);
      note(`failed: ${why}`);
      const r = await swap(failAttempt({ unit, by: identity, now: forgeNow(), generation }));
      if (r.kind === "ok") {
        note(`failAttempt: ${record.state}`);
        throw end("failed", record.state);
      }
      reasons.push(`failAttempt: ${r.message}`);
      note(`failAttempt failed: ${r.message}`);
      throw end("failed", null);
    };

    /** The unit was lost to another writer: no further ledger edit. */
    const lost = (what: string, why: string): never => {
      reasons.push(`${what}: unit lost: ${why}`);
      note(`${what}: unit lost: ${why}`);
      throw end("failed", null);
    };

    /** A fenced heartbeat; a lost unit ends the step, any other failure is a failed attempt. */
    const beat = async (what: string, set?: HeartbeatSet): Promise<void> => {
      const r = await swap(heartbeat({ unit, by: identity, now: forgeNow(), generation, ...(set !== undefined ? { set } : {}) }));
      if (r.kind === "lost") lost(what, r.message);
      if (r.kind === "failed") await failed(`${what}: ${r.message}`);
    };

    const overBudget = async (): Promise<void> => {
      if (input.signal.aborted) await failed("unit budget passed before the push");
    };

    const steps = async (): Promise<PrStepOutput> => {
      await overBudget();
      // 1. Snapshot: the freshly fetched `main`.
      const snapped = await call("snapshot", (o) => forge.snapshot({ ...o, read: readsPath }));
      if (!snapped.ok) return await failed(`snapshot ${snapped.error.kind}: ${snapped.error.message}`);
      const snap: ForgeSnapshot = snapped.value;
      base = { now: snap.now, at: clock() };
      const onto = snap.main.sha;
      ontoSha = onto;
      note(`fresh main ${onto}`);

      // 2. Standing Authority re-check on this `main`; the write check's rules come from it too.
      const config = loadRepoConfig({ repo: deps.repo, now: snap.now, tree: [...snap.main.tree], files: { ...snap.main.files } });
      if (!config.ok) {
        reasons.push(`config ${config.error.kind}: ${config.error.message}`);
        note(`stop: config ${config.error.kind}: ${config.error.message}`);
        throw end("stop", record.state);
      }
      const rules = writeRules({
        config: config.value.repo.config,
        policy: config.value.repo.policy,
        specPath: input.specPath,
        storyFile: story.manifest_path,
        infrastructureApproved: infrastructureApproved(story, snap),
      });

      // 3. Commit, behind the write check.
      const commitTimeout = AbortSignal.timeout(callTimeoutMs);
      let committed: Awaited<ReturnType<Committer["commit"]>>;
      try {
        committed = await committer.commit({
          unit,
          ontoSha: onto,
          message: `${story.story_id}: ${result.summary}`,
          rules,
          signal: AbortSignal.any([input.signal, commitTimeout]),
        });
      } catch (e) {
        committed = { ok: false, error: { kind: "transient", message: `commit threw: ${message(e)}` } };
      }
      if (!committed.ok) return await failed(`commit ${committed.error.kind}: ${committed.error.message}`);
      const c = committed.value;
      if (c.kind === "conflict") return await failed(`commit conflict onto ${onto}: ${c.paths.join(", ")}`);
      for (const path of c.reverted ?? []) note(`write-check: reverted ${shown(path)} (Epic context)`);
      if (c.kind === "refused") {
        for (const r of c.refusals) note(`write-check: refused ${shown(r.path)} (${r.class})`);
        reasons.push(`write-check: refused ${c.refusals.map((r) => `${shown(r.path)} (${r.class})`).join(", ")}`);
        note("write check refused: parking write-check");
        const r = await swap(park({ unit, by: identity, now: forgeNow(), generation, kind: "blocked", reason: "write-check" }));
        if (r.kind === "lost") lost("park", r.message);
        if (r.kind === "failed") await failed(`park: ${r.message}`);
        throw end("progress", record.state);
      }
      if (c.kind === "empty") {
        reasons.push("no-op: the commit onto main is empty");
        note("commit empty: parking no-op");
        const r = await swap(park({ unit, by: identity, now: forgeNow(), generation, kind: "blocked", reason: "no-op" }));
        if (r.kind === "lost") lost("park", r.message);
        if (r.kind === "failed") await failed(`park: ${r.message}`);
        throw end("progress", record.state);
      }
      note(`committed ${c.head_sha} onto ${c.base_sha}`);
      await overBudget();

      // 4. Fence.
      await beat("fence");
      await overBudget();

      // 5. Push with a lease.
      const branch = `${config.value.repo.config.branches.story}${story.story_id}`;
      const pushed = await call("pushBranch", (o) => forge.pushBranch({ branch, expected_sha: input.record.head_sha, sha: c.head_sha }, o));
      if (!pushed.ok) return await failed(`pushBranch ${pushed.error.kind}: ${pushed.error.message}`);
      note(`pushed ${c.head_sha} to ${branch}`);

      // 6. Open the PR, or update the adopted one; a fix leaves the PR's text as it is.
      const text = prText(story, result);
      const adopted = input.record.pr;
      let pr: number;
      if (adopted !== null && input.kind === "fix") {
        pr = adopted;
        note(`fix pushed to PR #${pr}`);
      } else {
        // A PR change is fenced: a unit lost since the push opens or updates no PR.
        await beat("fence");
        const opened =
          adopted === null
            ? await call("openPr", (o) => forge.openPr({ branch, base: "main", title: text.title, body: text.body }, o))
            : await call("updatePr", (o) => forge.updatePr(adopted, { title: text.title, body: text.body }, o));
        if (!opened.ok) return await failed(`${adopted === null ? "openPr" : "updatePr"} ${opened.error.kind}: ${opened.error.message}`);
        pr = opened.value.number;
        note(`${adopted === null ? "opened" : "updated"} PR #${pr}`);
      }

      // 7. Record the PR and SHAs.
      await beat("record", { pr, pr_owner: identity.owner, head_sha: c.head_sha, base_sha: c.base_sha });

      // 8. The status comment.
      const body = statusComment({ storyId: story.story_id, headSha: c.head_sha, lane: identity.lane, deniedActions: result.denied_actions });
      const commented = await call("comment", (o) => forge.comment(pr, body, o));
      if (!commented.ok) {
        reasons.push(`status comment on PR #${pr} failed: ${commented.error.kind}: ${commented.error.message}`);
        note(`status comment failed: ${commented.error.kind}: ${commented.error.message}`);
      }

      // 9. Done.
      throw end("progress", record.state);
    };

    try {
      return await steps();
    } catch (e) {
      if (e instanceof End) return e.out;
      // An unexpected error: try one failed attempt, never throw.
      try {
        return await failed(`unexpected error: ${message(e)}`);
      } catch (inner) {
        if (inner instanceof End) return inner.out;
        reasons.push(`unexpected error: ${message(inner)}`);
        return { outcome: "failed", state: null, record, reason: reasons.join("; ") };
      }
    }
  };
}
