import { loadRepoConfig } from "../core/config/load-repo-config.ts";
import { writeRules } from "../core/lane/write-check.ts";
import { park } from "../core/ledger/edits.ts";
import type { NextStory } from "../core/next/next.ts";
import { capText, FORGE_TEXT_LIMITS, redactSecrets, sanitizeAgentText } from "../core/sanitize.ts";
import { unitPath, UnitRecordSchema, type LaneIdentity } from "../core/schemas/ledger.ts";
import type { BuildResult } from "../core/schemas/session-result.ts";
import type { Forge, ForgeSnapshot } from "../ports/forge.ts";
import type { Committer } from "./committer.ts";
import { DEFAULT_CALL_TIMEOUT_MS, type Sleep } from "./ledger-cas.ts";
import { message, readsPath, stepKit, type PrStep, type PrStepInput, type PrStepOutput } from "./session.ts";

/**
 * The PR step after a `done` result (FR6, FR13, FR18, FR22, NFR10, AR7, AR16,
 * AR21, AR31, AR44): one fresh snapshot, the Standing Authority re-check on
 * its `main`, the bot commit onto that `main` behind the write check (a
 * refusal parks the unit `blocked` `write-check` and pushes nothing), a
 * fencing heartbeat, a leased push, a second fence and the PR opened (or the
 * adopted one updated), the record's `pr` and SHAs, and one 🤖 status
 * comment. The lane's credential and token-shaped strings are redacted from
 * the commit message, the PR text and the comment, each capped at the
 * forge's limits; superseded spec files are dropped from the squash. It
 * never throws.
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
  /**
   * The lane's credentials (the vendor credential `lane run` reads at start),
   * redacted from the commit message, the PR title and body and the status
   * comment; default none.
   */
  readonly secrets?: readonly string[];
};

/** The PR title and body: both sanitized, with `secrets` redacted, and capped at the forge's limits. */
export function prText(
  story: Pick<NextStory, "story_id" | "title">,
  result: Pick<BuildResult, "summary" | "body">,
  secrets: readonly string[] = [],
): { readonly title: string; readonly body: string } {
  const body = result.body.trim() === "" ? result.summary : `${result.summary}\n\n${result.body}`;
  return {
    title: sanitizeAgentText(`Story ${story.story_id}: ${story.title}`, { secrets, max: FORGE_TEXT_LIMITS.title }),
    body: sanitizeAgentText(body, { secrets, max: FORGE_TEXT_LIMITS.body }),
  };
}

export type StatusCommentParams = {
  readonly storyId: string;
  readonly headSha: string;
  readonly lane: string;
  readonly deniedActions: readonly string[];
  /** Redacted from every part; default none. */
  readonly secrets?: readonly string[];
};

/**
 * The 🤖 status comment: the Story, the short head SHA, the lane, then the
 * denied actions, each sanitized onto one line; capped at the comment limit.
 */
export function statusComment(p: StatusCommentParams): string {
  const secrets = p.secrets ?? [];
  const clean = (s: string): string => sanitizeAgentText(s, { secrets });
  const lines = [`🤖 Story ${clean(p.storyId)}: pushed ${p.headSha.slice(0, 7)} from lane ${clean(p.lane)}.`, ""];
  // Secrets are redacted before whitespace collapses, so a secret holding whitespace still matches exactly.
  const actions = p.deniedActions.map((a) => clean(redactSecrets(a, secrets).replace(/\s+/g, " ").trim()).trim()).filter((a) => a !== "");
  if (actions.length === 0) {
    lines.push("Denied actions: none.");
  } else {
    lines.push("Denied actions:");
    for (const action of actions) lines.push(`- ${action}`);
  }
  return capText(`${lines.join("\n")}\n`, FORGE_TEXT_LIMITS.comment);
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
  const secrets = deps.secrets ?? [];
  const clock = deps.now ?? Date.now;
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

  return async (input: PrStepInput): Promise<PrStepOutput> => {
    const { unit: story, result } = input;
    const unit = story.unit;
    const kit = stepKit({
      name: "PR step",
      forge,
      identity,
      record: input.record,
      log: input.log,
      clock,
      callTimeoutMs,
      ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
      ...(deps.random !== undefined ? { random: deps.random } : {}),
    });
    const { generation, reasons, note, end, forgeNow, call, swap, failed, lost, beat } = kit;

    const overBudget = async (): Promise<void> => {
      if (input.signal.aborted) await failed("unit budget passed before the push");
    };

    const steps = async (): Promise<PrStepOutput> => {
      await overBudget();
      // 1. Snapshot: the freshly fetched `main`.
      const snapped = await call("snapshot", (o) => forge.snapshot({ ...o, read: readsPath }));
      if (!snapped.ok) return await failed(`snapshot ${snapped.error.kind}: ${snapped.error.message}`);
      const snap: ForgeSnapshot = snapped.value;
      kit.see(snap.now);
      const onto = snap.main.sha;
      kit.mainSha = onto;
      note(`fresh main ${onto}`);

      // 2. Standing Authority re-check on this `main`; the write check's rules come from it too.
      const config = loadRepoConfig({ repo: deps.repo, now: snap.now, tree: [...snap.main.tree], files: { ...snap.main.files } });
      if (!config.ok) {
        reasons.push(`config ${config.error.kind}: ${config.error.message}`);
        note(`stop: config ${config.error.kind}: ${config.error.message}`);
        throw end("stop", kit.record.state);
      }
      const rules = writeRules({
        config: config.value.repo.config,
        policy: config.value.repo.policy,
        specPath: input.specPath,
        superseded: input.superseded,
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
          secrets,
          rules,
          signal: AbortSignal.any([input.signal, commitTimeout]),
        });
      } catch (e) {
        committed = { ok: false, error: { kind: "transient", message: `commit threw: ${message(e)}` } };
      }
      if (!committed.ok) return await failed(`commit ${committed.error.kind}: ${committed.error.message}`);
      const c = committed.value;
      if (c.kind === "conflict") return await failed(`commit conflict onto ${onto}: ${c.paths.join(", ")}`);
      for (const path of c.reverted ?? []) note(`write-check: reverted ${shown(path)} (${rules.superseded.includes(path) ? "superseded spec" : "Epic context"})`);
      if (c.kind === "refused") {
        for (const r of c.refusals) note(`write-check: refused ${shown(r.path)} (${r.class})`);
        reasons.push(`write-check: refused ${c.refusals.map((r) => `${shown(r.path)} (${r.class})`).join(", ")}`);
        note("write check refused: parking write-check");
        const r = await swap(park({ unit, by: identity, now: forgeNow(), generation, kind: "blocked", reason: "write-check" }));
        if (r.kind === "lost") lost("park", r.message);
        if (r.kind === "failed") await failed(`park: ${r.message}`);
        throw end("progress", kit.record.state);
      }
      if (c.kind === "empty") {
        reasons.push("no-op: the commit onto main is empty");
        note("commit empty: parking no-op");
        const r = await swap(park({ unit, by: identity, now: forgeNow(), generation, kind: "blocked", reason: "no-op" }));
        if (r.kind === "lost") lost("park", r.message);
        if (r.kind === "failed") await failed(`park: ${r.message}`);
        throw end("progress", kit.record.state);
      }
      note(`committed ${c.head_sha} onto ${c.base_sha}`);
      await overBudget();

      // 4. The lease: an adopted PR's head, else the branch's real head (a stale branch a closed PR left, Story 2.6b).
      const branch = `${config.value.repo.config.branches.story}${story.story_id}`;
      let expected = input.record.head_sha;
      if (input.record.pr === null) {
        const head = await call("branchHead", (o) => forge.branchHead(branch, o));
        if (!head.ok) return await failed(`branchHead ${head.error.kind}: ${head.error.message}`);
        expected = head.value;
        if (expected !== null) note(`${branch} is at ${expected}: the push leases from it`);
      }

      // 5. Fence, then push with the lease.
      await beat("fence");
      await overBudget();
      const pushed = await call("pushBranch", (o) => forge.pushBranch({ branch, expected_sha: expected, sha: c.head_sha }, o));
      if (!pushed.ok) return await failed(`pushBranch ${pushed.error.kind}: ${pushed.error.message}`);
      note(`pushed ${c.head_sha} to ${branch}`);

      // 6. Open the PR, or update the adopted one; a fix leaves the PR's text as it is.
      const text = prText(story, result, secrets);
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
      const body = statusComment({ storyId: story.story_id, headSha: c.head_sha, lane: identity.lane, deniedActions: result.denied_actions, secrets });
      const commented = await call("comment", (o) => forge.comment(pr, body, o));
      if (!commented.ok) {
        reasons.push(`status comment on PR #${pr} failed: ${commented.error.kind}: ${commented.error.message}`);
        note(`status comment failed: ${commented.error.kind}: ${commented.error.message}`);
      }

      // 9. Done.
      throw end("progress", kit.record.state);
    };

    return kit.run(steps);
  };
}
