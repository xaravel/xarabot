import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { classifyChecks, pollDelayMs } from "../core/ci/checks.ts";
import { loadRepoConfig } from "../core/config/load-repo-config.ts";
import { ciFix, park } from "../core/ledger/edits.ts";
import type { Result } from "../core/result.ts";
import type { Config } from "../core/schemas/config.ts";
import { capText, FORGE_TEXT_LIMITS, sanitizeAgentText } from "../core/sanitize.ts";
import type { LaneIdentity, ParkReason, UnitRecord } from "../core/schemas/ledger.ts";
import type { BuildResult } from "../core/schemas/session-result.ts";
import type { Forge, ForgeSnapshot } from "../ports/forge.ts";
import { DEFAULT_CALL_TIMEOUT_MS, defaultSleep, type Sleep } from "./ledger-cas.ts";
import type { MergeOutcome, Merger } from "./merger.ts";
import { message, readsPath, stepKit, type PrStepOutput, type StepUnit } from "./session.ts";

/**
 * The CI step after the PR is open (FR6, AR8, AR20, AR21, AR44, AD-19). Each
 * round takes one fresh snapshot, re-checks the config and Standing Authority
 * on it, merges `main` into a conflicting PR, then polls the head's checks by
 * hand with back-off. An unexpected failure, or a conflict no rule resolves,
 * runs a session in `ci-fix` mode, and `pushFix` pushes its fix; the next
 * round runs on the new head. It parks at the CI-fix cap and at the max wait,
 * and never throws. The unit is named, not a Story (Story 2.10): a Story's
 * PR step pushes a Story's fix, a retro item's step its own.
 */

/** CI-fix and conflict sessions a unit gets before it parks `ci-fix-cap`. */
export const CI_FIX_CAP = 2;

export type CiSessionRequest = {
  /** The SHA the clone starts at: the head, or a merge candidate. */
  readonly start: string;
  /** What the session is told: written to `tmp/ci-fix-log.md`. */
  readonly logText: string;
};

export type CiSessionDone = {
  readonly result: BuildResult;
  /** The spec file's repo-relative path in the clone; `null` for a `blocked` or `no-op` result, or a unit that needs none. */
  readonly specPath: string | null;
  /** The `blocked` spec files the `done` spec supersedes: dropped from the squash. */
  readonly superseded: readonly string[];
};

/** One builder session in `ci-fix` mode; a failure is a failed attempt. Never throws. */
export type CiSession = (request: CiSessionRequest) => Promise<Result<CiSessionDone>>;

export type RegenerateRequest = {
  readonly start: string;
  /** The lockfile paths to read back from the clone. */
  readonly paths: readonly string[];
  /** The repo's `lockfile_command`. */
  readonly command: readonly string[];
};

/** Runs the lockfile command in the sandbox at `start`; the lockfile texts by path. Never throws. */
export type Regenerate = (request: RegenerateRequest) => Promise<Result<Readonly<Record<string, string>>>>;

/** The unit whose PR the CI step takes through CI. */
export type CiUnit = StepUnit & {
  /** The PR's branch, from fresh `main`'s config. */
  readonly branch: (config: Pick<Config, "branches">) => string;
  /** Whether a `done` fix needs a spec file: a Story's does, a retro item's does not. */
  readonly needsSpec: boolean;
};

/** A `done` CI-fix or conflict session's fix, to push to the open PR. */
export type CiFix = {
  /** The claimed record as the CI step last saw it, with its `pr` and `head_sha`. */
  readonly record: UnitRecord;
  readonly result: BuildResult;
  /** The spec file's path; `null` for a unit that needs none. */
  readonly specPath: string | null;
  readonly superseded: readonly string[];
};

/** Commits and pushes a fix to the open PR, keeping its title and body. Never throws. */
export type PushFix = (fix: CiFix) => Promise<PrStepOutput>;

export type CiStepInput = {
  readonly unit: CiUnit;
  /** The claimed record, with its `pr` and `head_sha` set. */
  readonly record: UnitRecord;
  readonly clone: string;
  /** The unit budget's signal. */
  readonly signal: AbortSignal;
  /** Writes a note to the unit log. */
  readonly log: (text: string) => void;
  /** A runner-only folder for prefetched logs. */
  readonly scratchDir: string;
  readonly pushFix: PushFix;
  readonly session: CiSession;
  readonly regenerate: Regenerate;
};

/** Takes a unit's PR through CI. Never throws. */
export type CiStep = (input: CiStepInput) => Promise<PrStepOutput>;

export type CiStepDeps = {
  readonly forge: Forge;
  readonly merger: Merger;
  /** Who writes the ledger records. */
  readonly identity: LaneIdentity;
  /** The repo slug, for the Standing Authority check. */
  readonly repo: string;
  /** Each forge call's (and each merge's) deadline; default 60 000 ms. */
  readonly callTimeoutMs?: number;
  /** The host clock in epoch ms; default `Date.now`. */
  readonly now?: () => number;
  /** The poll and ledger back-off sleep. */
  readonly sleep?: Sleep;
  readonly random?: () => number;
};

const MINUTE_MS = 60_000;

export type CiLogFile = { readonly path: string; readonly text: string };

/** The CI-fix session's log text: the unexpected failing checks, then each prefetched file under a header. */
export function ciLogText(p: { readonly sha: string; readonly failing: readonly string[]; readonly files: readonly CiLogFile[] }): string {
  const lines = [
    `# CI failed on ${p.sha}`,
    "",
    `These checks failed unexpectedly: ${p.failing.join(", ")}.`,
    "",
    p.files.length === 0 ? "No log was prefetched for them." : "Their prefetched logs follow, one per file.",
  ];
  for (const f of p.files) {
    lines.push("", `## ${basename(f.path)}`, "", "```text", f.text.endsWith("\n") ? f.text.slice(0, -1) : f.text, "```");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The conflict session's log text: the clone is `main` merged into the PR,
 * with markers in `paths`; each of `lockfiles` holds `main`'s version with no
 * markers, the PR's changes to it dropped. The PR is "this Story's" unless
 * `subject` names another unit (`Unit <unit>`: "this unit's").
 */
export function conflictLogText(p: {
  readonly mainSha: string;
  readonly headSha: string;
  readonly paths: readonly string[];
  readonly lockfiles?: readonly string[];
  /** The unit's subject (`Story <id>`, `Unit <unit>`); default a Story. */
  readonly subject?: string;
}): string {
  const lockfiles = p.lockfiles ?? [];
  const noun = p.subject === undefined || p.subject.startsWith("Story ") ? "Story" : "unit";
  const lines = [`# Conflicts merging main ${p.mainSha} into the PR`, "", `The clone is main (${p.mainSha}) merged into this ${noun}'s PR (${p.headSha}).`];
  if (p.paths.length > 0) {
    lines.push("", "No rule resolved these paths, so they hold conflict markers:", "", ...p.paths.map((path) => `- ${path}`));
  }
  if (lockfiles.length > 0) {
    lines.push(
      "",
      "These lockfiles conflicted. Each now holds main's version, with no conflict markers, so the PR's changes to it were dropped:",
      "",
      ...lockfiles.map((path) => `- ${path}`),
      "",
      "Regenerate each one so it matches the merged package manifests.",
    );
  }
  lines.push("", "Resolve each conflict, keeping what both sides meant, and remove every conflict marker. Then re-run the checks here.");
  return `${lines.join("\n")}\n`;
}

/** The 🤖 comment after `main` was merged into the PR, for `subject` (`Story <id>`, `Unit <unit>`), capped at the comment limit. */
export function mergeComment(p: { readonly subject: string; readonly mainSha: string; readonly headSha: string; readonly resolved: readonly string[] }): string {
  const resolved = p.resolved.length === 0 ? "" : ` Resolved: ${p.resolved.map((r) => sanitizeAgentText(r)).join(", ")}.`;
  return capText(
    `🤖 ${sanitizeAgentText(p.subject)}: merged main ${p.mainSha.slice(0, 7)} into the PR as ${p.headSha.slice(0, 7)}.${resolved}\n`,
    FORGE_TEXT_LIMITS.comment,
  );
}

type Next = { readonly kind: "poll"; readonly head: string } | { readonly kind: "conflict"; readonly start: string; readonly paths: readonly string[]; readonly lockfiles: readonly string[] };

export function createCiStep(deps: CiStepDeps): CiStep {
  const { forge, merger, identity } = deps;
  const clock = deps.now ?? Date.now;
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const sleep = deps.sleep ?? defaultSleep;

  return async (input: CiStepInput): Promise<PrStepOutput> => {
    const ciUnit = input.unit;
    const unit = ciUnit.unit;
    const kit = stepKit({
      name: "CI step",
      forge,
      identity,
      record: input.record,
      log: input.log,
      clock,
      callTimeoutMs,
      sleep,
      ...(deps.random !== undefined ? { random: deps.random } : {}),
    });
    const { generation, reasons, note, end, forgeNow, call, failed, held, beat } = kit;

    const parkBlocked = async (reason: ParkReason, why: string): Promise<never> => {
      reasons.push(why);
      note(`parking blocked ${reason}: ${why}`);
      await held("park", park({ unit, by: identity, now: forgeNow(), generation, kind: "blocked", reason }));
      throw end("progress", kit.record.state);
    };

    /** The unit budget passed: end `failed`, the record left as it is for the lane's budget rule. */
    const aborted = (): void => {
      if (!input.signal.aborted) return;
      reasons.push("unit budget passed during the CI step");
      note("unit budget passed");
      throw end("failed", kit.record.state);
    };

    const merge = async (head: string, main: string, statusPaths: readonly string[], lockfiles?: Readonly<Record<string, string>>): Promise<MergeOutcome> => {
      let r: Awaited<ReturnType<Merger["merge"]>>;
      try {
        r = await merger.merge({
          unit,
          headSha: head,
          mainSha: main,
          message: `Merge main ${main} into the PR for ${ciUnit.subject}`,
          statusPaths,
          ...(lockfiles !== undefined ? { lockfiles } : {}),
          signal: AbortSignal.any([input.signal, AbortSignal.timeout(callTimeoutMs)]),
        });
      } catch (e) {
        r = { ok: false, error: { kind: "transient", message: `merge threw: ${message(e)}` } };
      }
      aborted();
      if (!r.ok) return await failed(`merge ${r.error.kind}: ${r.error.message}`);
      return r.value;
    };

    /** Pushes a merge commit as the new head and records it; the head to poll. */
    const pushMerge = async (head: string, main: string, m: Extract<MergeOutcome, { kind: "merged" }>, branch: string, pr: number): Promise<string> => {
      await beat("fence");
      aborted();
      const pushed = await call("pushBranch", (o) => forge.pushBranch({ branch, expected_sha: head, sha: m.head_sha }, o));
      if (!pushed.ok) return await failed(`pushBranch ${pushed.error.kind}: ${pushed.error.message}`);
      note(`pushed merge ${m.head_sha} to ${branch}`);
      await beat("record", { head_sha: m.head_sha, base_sha: main });
      const body = mergeComment({ subject: ciUnit.subject, mainSha: main, headSha: m.head_sha, resolved: m.resolved });
      const commented = await call("comment", (o) => forge.comment(pr, body, o));
      if (!commented.ok) {
        reasons.push(`merge comment on PR #${pr} failed: ${commented.error.kind}: ${commented.error.message}`);
        note(`merge comment failed: ${commented.error.kind}: ${commented.error.message}`);
      }
      return m.head_sha;
    };

    /** Polls `sha` until it passes or fails; parks `ci-timeout` past the max wait. */
    const poll = async (sha: string, waitMs: number, expected: readonly string[]): Promise<readonly string[] | "passed"> => {
      const startedAt = clock();
      for (let n = 0; ; n += 1) {
        aborted();
        const r = await call("checks", (o) => forge.checks(sha, o));
        let delay = pollDelayMs(n);
        if (!r.ok) {
          if (r.error.kind !== "transient" && r.error.kind !== "rate-limited") return await failed(`checks ${r.error.kind}: ${r.error.message}`);
          if (r.error.kind === "rate-limited") delay = Math.max(delay, r.error.retry_after * 1000);
          note(`checks ${r.error.kind}: counted as pending: ${r.error.message}`);
        } else {
          const c = classifyChecks(r.value.checks, expected);
          if (c.kind === "passed") return "passed";
          if (c.kind === "failed") return c.failing;
        }
        if (clock() - startedAt >= waitMs) {
          return await parkBlocked("ci-timeout", `CI on ${sha} still pending after ${Math.round(waitMs / MINUTE_MS)} min`);
        }
        await sleep(delay, input.signal);
      }
    };

    /** A CI-fix or conflict session at `start`; returns when the next round should run. */
    const session = async (start: string, what: string, logText: () => Promise<string>): Promise<void> => {
      await held("ciFix", ciFix({ unit, by: identity, now: forgeNow(), generation, cap: CI_FIX_CAP }));
      if (kit.record.state === "parked") {
        reasons.push(`${what}: CI-fix cap of ${CI_FIX_CAP} reached`);
        note(`parked ci-fix-cap before ${what}`);
        throw end("progress", kit.record.state);
      }
      note(`${what} ${kit.record.ci_fixes} of ${CI_FIX_CAP} at ${start}`);
      aborted();
      const text = await logText();
      aborted();
      let ran: Awaited<ReturnType<CiSession>>;
      try {
        ran = await input.session({ start, logText: text });
      } catch (e) {
        ran = { ok: false, error: { kind: "threw", message: message(e) } };
      }
      aborted();
      if (!ran.ok) return await failed(`${what} session ${ran.error.kind}: ${ran.error.message}`);
      const { result, specPath, superseded } = ran.value;
      note(`${what} result: ${result.outcome}`);
      if (result.outcome === "blocked") return await parkBlocked(result.blocked.kind, `${what} blocked ${result.blocked.kind}: ${result.blocked.text}`);
      if (result.outcome === "no-op") return await parkBlocked("no-op", `${what}: no-op`);
      if (ciUnit.needsSpec && specPath === null) return await failed(`${what} session: a done result with no spec file`);
      let out: PrStepOutput;
      try {
        out = await input.pushFix({ record: kit.record, result, specPath, superseded });
      } catch (e) {
        return await failed(`PR step threw: ${message(e)}`);
      }
      if (out.record !== undefined) kit.record = out.record;
      if (out.reason !== undefined) reasons.push(out.reason);
      note(`PR step (fix): ${out.outcome} (${out.state ?? "unknown"})`);
      if (out.outcome !== "progress" || out.state !== "claimed") throw end(out.outcome, out.state);
    };

    const ciFixLog = async (sha: string, failing: readonly string[]): Promise<string> => {
      let dir: string;
      try {
        mkdirSync(input.scratchDir, { recursive: true });
        dir = mkdtempSync(join(input.scratchDir, "ci-log-"));
      } catch (e) {
        return await failed(`prefetch: cannot create a folder in ${input.scratchDir}: ${message(e)}`);
      }
      try {
        const r = await call("prefetch", (o) => forge.prefetch({ kind: "ci-log", sha, dir }, o));
        if (!r.ok) return await failed(`prefetch ${r.error.kind}: ${r.error.message}`);
        const files: CiLogFile[] = [];
        for (const path of r.value.files) {
          try {
            files.push({ path, text: readFileSync(path, "utf8") });
          } catch (e) {
            return await failed(`prefetch: cannot read ${path}: ${message(e)}`);
          }
        }
        return ciLogText({ sha, failing, files });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    const steps = async (): Promise<PrStepOutput> => {
      for (;;) {
        aborted();
        const head = kit.record.head_sha;
        const pr = kit.record.pr;
        if (head === null || pr === null) return await failed("the record has no PR or head_sha to take through CI");

        // 1. Snapshot and config: the Standing Authority re-check.
        const snapped = await call("snapshot", (o) => forge.snapshot({ ...o, read: readsPath }));
        if (!snapped.ok) return await failed(`snapshot ${snapped.error.kind}: ${snapped.error.message}`);
        const snap: ForgeSnapshot = snapped.value;
        kit.see(snap.now);
        const main = snap.main.sha;
        kit.mainSha = main;
        const loaded = loadRepoConfig({ repo: deps.repo, now: snap.now, tree: [...snap.main.tree], files: { ...snap.main.files } });
        if (!loaded.ok) {
          reasons.push(`config ${loaded.error.kind}: ${loaded.error.message}`);
          note(`stop: config ${loaded.error.kind}: ${loaded.error.message}`);
          throw end("stop", kit.record.state);
        }
        const config = loaded.value.repo.config;
        const expected = loaded.value.repo.policy.expected_checks;
        const branch = ciUnit.branch(config);
        const statusPaths = [config.sprint_status_path, config.retro_gates_path];
        note(`round on head ${head}, fresh main ${main}`);

        // 2. Merge main into the PR.
        const decide = async (m: MergeOutcome, regenerated: boolean): Promise<Next> => {
          switch (m.kind) {
            case "up-to-date":
            case "clean":
              note(`merge: ${m.kind}`);
              return { kind: "poll", head };
            case "merged":
              return { kind: "poll", head: await pushMerge(head, main, m, branch, pr) };
            case "lockfile": {
              const command = config.lockfile_command;
              if (command === undefined || regenerated) {
                note(`merge: lockfile conflict (${m.paths.join(", ")}), ${command === undefined ? "no lockfile_command" : "still conflicted"}`);
                return { kind: "conflict", start: m.candidate_sha, paths: [], lockfiles: m.paths };
              }
              let texts: Awaited<ReturnType<Regenerate>>;
              try {
                texts = await input.regenerate({ start: m.candidate_sha, paths: m.paths, command });
              } catch (e) {
                texts = { ok: false, error: { kind: "threw", message: message(e) } };
              }
              aborted();
              if (!texts.ok) {
                note(`regenerate ${texts.error.kind}: ${texts.error.message}; a conflict session instead`);
                return { kind: "conflict", start: m.candidate_sha, paths: [], lockfiles: m.paths };
              }
              note(`regenerated ${m.paths.join(", ")}`);
              return decide(await merge(head, main, statusPaths, texts.value), true);
            }
            case "needs-session":
              note(`merge: conflicts need a session (${m.paths.join(", ")})`);
              return { kind: "conflict", start: m.candidate_sha, paths: m.paths, lockfiles: m.lockfiles };
          }
        };
        const next = await decide(await merge(head, main, statusPaths), false);

        if (next.kind === "conflict") {
          // 4. A conflict session.
          await session(next.start, "conflict session", async () => conflictLogText({ mainSha: main, headSha: head, paths: next.paths, lockfiles: next.lockfiles, subject: ciUnit.subject }));
          continue;
        }

        // 3. Poll.
        const polled = await poll(next.head, config.ci_max_wait_minutes * MINUTE_MS, expected);
        if (polled === "passed") {
          note(`CI passed on ${next.head}`);
          throw end("progress", kit.record.state);
        }
        note(`CI failed on ${next.head}: ${polled.join(", ")}`);
        // 4. A CI-fix session.
        const failedHead = next.head;
        await session(failedHead, "CI fix", () => ciFixLog(failedHead, polled));
      }
    };

    return kit.run(steps);
  };
}
