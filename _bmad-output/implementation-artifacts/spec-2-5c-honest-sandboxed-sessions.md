---
title: 'Story 2.5c: Honest sandboxed sessions'
type: 'bugfix'
created: '2026-10-24'
baseline_revision: 'bdf976cf0a31ecd04a8363719db035fa549be567'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
warnings: ['oversized', 'multiple-goals']
deferred:
  - summary: >-
      The real-sandbox paths this Story changes (a credential-less launch through createMacSandbox, and a zsh heredoc under the profile) are covered only by nested cases that run on a macOS host outside a session.
    evidence: |-
      CI runs bun test on ubuntu-latest and sessions set XARABOT_SANDBOXED=1, so the macos.test.ts cases "no credential: …" and "a zsh heredoc succeeds …" skip in both. The fake sandbox in ci-step.test.ts only records the spec. A regression would show only when the Maintainer runs bun test test/sandbox/ on the host. Closing it needs the macOS CI job (sprint-change-proposal-2026-10-24 decision 29), a ci-workflow Human Live Step.
    location: >-
      test/sandbox/macos.test.ts
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Sandboxed agent sessions report false failures. A zsh heredoc fails because zsh writes its temp file under `/tmp/zsh` (F7). A sandboxed `bun test` gives 74 failures, all caused by the sandbox (F8). The real-CLI agent contract case runs without `XARABOT_LIVE=1`. The lockfile command gets the vendor credential (retro A14). And `createGitMerger > fetches only the SHA runner.git lacks` fails now and then under load.

**Approach:**
- Add `TMPPREFIX`, set inside the session temp folder, to the session env.
- Skip sandbox-denied test cases under `XARABOT_SANDBOXED=1` with a shared helper.
- Gate the real-CLI case on `XARABOT_LIVE=1`.
- Make `LaunchSpec.credential` optional, and have the lockfile launch omit it.
- Fix the merger test's timing dependence at its cause.
- Update the runbook's evidence row.

## Boundaries & Constraints

**Always:**
- `TMPPREFIX` is a reserved name: a spec can't set it, and the launching env's value never passes through.
- Agent adapters always return a credential: `Agent.launchSpec` keeps a required `credential`.
- With no credential, the sandbox still empties the vendor home (or keeps it on `resume`). It writes no home file, sets no credential variable and reads no credential file.
- A case skipped in a session must still run on the host, outside a sandbox. Off a session, the suite runs exactly the same cases as before.
- The flaky test keeps every assertion: exactly one fetch of `[main]`, and a successful merge.

**Never:**
- Don't weaken or delete an assertion, add retries, or raise timeouts to hide the flake.
- Don't skip a case that passes in a session, and don't skip on anything but `XARABOT_SANDBOXED=1` (plus the existing platform and tool checks).
- No change to `.github/`, `AGENTS.md`, `_bmad/` or the spec folder.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Session env | any vendor | `TMPPREFIX` = `<tempDir>/zsh` | none |
| Launching `TMPPREFIX` | `TMPPREFIX=/tmp/zsh` in the launching env | session value is still `<tempDir>/zsh` | none |
| Reserved name | spec credential env or vendor home env named `TMPPREFIX` | refused | `invalid` / `refused` naming it |
| zsh heredoc, nested | `zsh -c 'cat <<EOF …'` in a real session | exit 0, heredoc text on stdout | skipped under `XARABOT_SANDBOXED=1` |
| Lockfile launch | lockfile conflict with `lockfile_command` | the spec given to the sandbox has `credential` undefined | none |
| No-credential spec | sandbox run with no `credential` | the session runs with no credential variable and an empty vendor home | a missing credential file is not an error |
| Sandboxed suite | `bun test` with `XARABOT_SANDBOXED=1` | `0 fail` | the denied cases report skipped |
| Real CLI | `XARABOT_LIVE` unset | skipped, whatever `canSandbox` is | none |

</intent-contract>

## Code Map

- `src/sandbox/environment.ts` -- `buildSessionEnv` (~l.61): add `TMPPREFIX: join(parts.tempDir, "zsh")`. It is a prefix, not a folder: zsh writes `<prefix><pid>…`, and `SESSION_DIR_NAMES` stays unchanged. Add `"TMPPREFIX"` to `isReservedEnvName`'s list. Update the allowlist doc comment.
- `src/ports/sandbox.ts` -- `LaunchSpec.credential` becomes `credential?: LaunchCredential`. The doc: absent means a repo command the runner starts (AR19), so nothing is seeded and no credential variable is set.
- `src/ports/agent.ts` l.58 -- `export type AgentLaunchSpec = LaunchSpec & { readonly credential: LaunchCredential }`. `launchSpec` returns `Result<AgentLaunchSpec, "invalid">`. Update the claude adapter's return type under `src/adapters/agent/claude/`.
- `src/sandbox/macos.ts` -- `validateSpec` (l.82-104) checks the credential only when present. `session` (l.292) passes the optional credential to `seedVendorHome`.
- `src/sandbox/vendor-home.ts` -- `SeedParams.credential?`. In `seedVendorHome`, an absent credential empties the home (or keeps it), reads no file and returns `ok({})`. Update the doc comment.
- `src/lane/lane-process.ts` l.873-880 `regenerate` -- build `launch` without `credential`. Comment: no credential (AR19, A14).
- `src/cli/lane-run.ts` l.258 -- uses `spec.value.credential.file`. It still type-checks through `AgentLaunchSpec`.
- `test/support/sandbox.ts` -- add `export const isSandboxed = process.env.XARABOT_SANDBOXED === "1"` and define `canSandbox` from it. Add `hostTest = test.skipIf(isSandboxed)`, documented as "needs host access a session's profile denies: binding a socket, `ps`, signalling or inspecting another process, resolving `/tmp`; reports skipped inside a session". Add `hostDescribe = describe.skipIf(isSandboxed)` if a whole file needs it.
- Baseline sandbox failures, 74 at `bdf976c` (list in `$TMPDIR/baseline-fails.txt`). Convert each to `hostTest`, or skip its setup:
  - socket binding (`listen`): `test/contracts/forge.github.contract.test.ts` (emulator harness: `enabled: !isSandboxed`); `test/adapters/forge/github/{push,fetch-shas,runner-git}.test.ts` (the `git-server.ts` users: only the cases that start a server); `test/lane/runner-install.test.ts`; `test/sandbox/proxy.test.ts` (its top-level `beforeAll` `Bun.listen` must not run in a session; the pure `decideConnect` cases keep running).
  - `ps`/kill denied: `test/lane/processes.test.ts` (`createPsProcessTable` "inspects a live sleep", `killRecorded` live cases); `test/lane/wait.test.ts` "a short wait elapses…"; `test/lane/stop.test.ts` (`wakeLane` live cases, `stopNow` order); `test/cli/lane-commands.test.ts` (`stop --now` with no host_id, the 2 `wake` cases); `test/lane/lane-process.test.ts` "with the sleep waiter, wait.pid names a live sleep…".
  - `/tmp` realpath denied: `test/sandbox/tools.test.ts` `realpathLoose` (2).
- `test/contracts/agent.contract.ts` l.256 `realCli` -- add `!isLive` (import from `../support/live.ts`). Update the header comment.
- `test/sandbox/macos.test.ts` -- a `sandboxTest` (with `toolTest("zsh")` if zsh may be missing) that runs `ran(["zsh", "-c", "cat <<EOF\nheredoc ok\nEOF"])`. Expect exit 0 and stdout `heredoc ok\n`. Also a `sandboxTest` for a spec with no `credential`: no `CLAUDE_CODE_OAUTH_TOKEN` in `env`, and an empty vendor home.
- `test/sandbox/environment.test.ts` -- add `TMPPREFIX: "/l/tmp/zsh"` to the "exactly the allowlist" and key-list rows. Add a launching-`TMPPREFIX` row, `TMPPREFIX` to the reserved list, and a refusal row for a `TMPPREFIX` credential name.
- `test/sandbox/vendor-home.test.ts` -- no-credential rows: the home is emptied, nothing is written, `{}` comes back, and a missing credential file is fine. `keep` keeps the contents.
- `test/lane/ci-step.test.ts` l.802 -- `expect(regen?.credential).toBeUndefined()`. This is the AC's test.
- `test/lane/merger.test.ts` l.122-137 -- the cause: `base` (in `repo`) and `otherBase` (in `other`) share a SHA only when both commits land in the same second. When load pushes them across a second boundary, the histories are unrelated, `git merge-tree` exits 128 ("refusing to merge unrelated histories"), and `r.ok` is false. Fix: put `base` itself into `other` (`update-ref refs/x/base` in `repo`, then `plainFetch(other.gitDir, repo.gitDir, "refs/x/base")`) and build `main` on `base`. Drop `otherBase`. Keep the assertions.
- `docs/maintainer/self-host.md` l.39 -- replace the `XARABOT_SANDBOXED=1 bun test test/sandbox/` row with an in-session check: `bun test`, run from the clone inside a real sandboxed lane session (e.g. a Story session's own verification), expecting `0 fail`.

## Tasks & Acceptance

**Execution:**
- `src/sandbox/environment.ts` -- `TMPPREFIX` set and reserved -- F7, AR18.
- `src/ports/sandbox.ts`, `src/ports/agent.ts`, `src/adapters/agent/claude/*`, `src/sandbox/macos.ts`, `src/sandbox/vendor-home.ts` -- optional credential -- AR19.
- `src/lane/lane-process.ts` -- the lockfile launch without a credential -- A14.
- `test/support/sandbox.ts` and the test files listed above -- `hostTest`/`isSandboxed` skips -- F8.
- `test/contracts/agent.contract.ts` -- the live gate.
- `test/sandbox/{macos,environment,vendor-home}.test.ts`, `test/lane/ci-step.test.ts` -- the new and changed rows.
- `test/lane/merger.test.ts` -- the shared-base fix.
- `docs/maintainer/self-host.md` -- the evidence row.

**Acceptance Criteria:**
- Given an agent session, when its environment is built, then `TMPPREFIX` is `<tempDir>/zsh`, and a nested sandbox test runs a zsh heredoc that succeeds (skipped inside a session).
- Given `XARABOT_SANDBOXED=1`, when `bun test` runs, then it reports `0 fail`.
- Given `XARABOT_LIVE` unset, when the agent contract runs, then the real-CLI case reports skipped.
- Given a lockfile conflict with `lockfile_command`, when the runner regenerates the lockfile, then the launch spec has no credential, and `test/lane/ci-step.test.ts` asserts it.
- Given the fixed merger test, when the full suite runs 10 times in a row, then every run gives `0 fail`.
- Given `bun --bun oxlint` and `bun --bun tsc`, when they run, then both exit 0.

## Spec Change Log

## Review Triage Log

### 2026-10-24 — Review pass
- verdicts: 29 findings — high 0, medium 4, low 15, false 10, maybe-false 0
- findings:
  - `[false]` `[reject]` (blind 1) The `epic-2-context.md` rewrite is out of scope and drops rules. -- Step 1 of this workflow recompiled the file because a planning artifact (the 2026-10-24 Maintainer note) is newer than it. The runner also reverts a builder's change to the Epic context file before the squash (`src/lane/commit.ts:155`, `epicContextMatch`), so the change never reaches `main`.
  - `[medium]` `[patch]` (blind 2) The other host rows in the `self-host.md` sandbox table still give the 2026-10-23 counts, so the Maintainer would see a mismatch and stop. -- Confirmed by counting test cases per file before and after (JUnit output): macos +3 (+1 from the blind 8 patch), environment +5, vendor-home +6, proxy unchanged. The rows now add these cases, and the intro says they are still to be re-measured on the host.
  - `[low]` `[reject]` (blind 3) The new in-session row gives only `0 fail`, so a blanket skip would go unnoticed. -- The AC fixes the expected result as `0 fail`. Pass/skip counts change with every Story. Over-skipping is caught by the host rows (a nested case skipped on the host stops the switch). This run's measured totals are in the Auto Run Result.
  - `[low]` `[patch]` (blind 4) The proxy's `live` case binds a socket but is gated only on `XARABOT_LIVE`, so `XARABOT_LIVE=1 bun test` fails inside a session. -- Confirmed (`test/sandbox/proxy.test.ts` `describe("live")` calls `startProxy`). That block is now `hostDescribe`.
  - `[low]` `[reject]` (blind 5) No credential plus `resume: true` keeps an earlier session's credential home file. -- No caller combines the two: `regenerate` never sets `resume`, and without `resume` the vendor home is emptied. A refusal adds a branch for an unreachable path.
  - `[low]` `[reject]` (blind 6) An optional `credential` makes "no credential" the silent default for hand-built specs. -- Only the runner builds a `LaunchSpec` by hand. Adapters must return `AgentLaunchSpec`, which requires the credential. A forgotten credential fails closed: the agent can't authenticate. A discriminant adds public surface the spec did not ask for.
  - `[low]` `[reject]` (blind 7) The lockfile launch keeps the vendor `apiHosts` and calls `agent.launchSpec` only to read `vendor`/`vendorHomeEnv`. -- The AC and AR19 ask for no credential. The vendor hosts are useless without one, and the `launchSpec` call is unchanged from before this Story. Changing the network allowlist is a separate decision.
  - `[low]` `[patch]` (blind 8) The no-credential branch of `validateSpec` has no case that runs in a session, and the new case passes `credential: undefined` instead of omitting the key. -- Added a plain test under "refusals before any check (any host)": a spec with the key omitted and `vendorHomeEnv: "TMPPREFIX"` is refused.
  - `[low]` `[reject]` (blind 9) Pure refusal cases in `push`/`fetch-shas` skip in sessions only because their shared `setup()` starts a git server. -- They do start a server (the baseline failures were `listen` errors), so the AC's "cases that bind sockets" covers them. They run on the host and in CI. Splitting the fixtures adds complexity for no change in coverage.
  - `[low]` `[reject]` (blind 10) The baseline failure list lives at a temp path. -- The fix would edit this spec. The per-file baseline (74 failures in 12 files) and the before/after comparison are recorded in the Auto Run Result.
  - `[false]` `[reject]` (blind 11) The spec records no acceptance evidence. -- Finalize writes the verification results to the Auto Run Result. The review runs before that.
  - `[false]` `[reject]` (blind 12) Nothing checks that runs outside a session keep the same cases. -- Every new gate is `skipIf(isSandboxed)`, `enabled: !isSandboxed` or `if (isSandboxed) return`, and none is inverted. A per-test JUnit comparison against the baseline worktree found no case that passed before and is skipped now. The only case that changes outside a session is the real-CLI case, and the AC asks for that.
  - `[low]` `[reject]` (blind 13) The zsh case tests only a heredoc, not here-strings or that the file lands under `TMPPREFIX`. -- The AC asks for a heredoc. zsh deletes the temp file at once, so asserting its location needs tracing. Checked by hand in this session: the same heredoc fails with the default prefix and passes with `TMPPREFIX=$TMPDIR/zsh`.
  - `[low]` `[reject]` (blind 14a) The `text === null` check in `seedVendorHome` is redundant. -- It narrows `text` for the type checker. Restructuring is cosmetic.
  - `[low]` `[patch]` (blind 14b) `merger.test.ts` re-implements the fixture's `value()` idiom. -- Now `value(plainFetch(...))`.
  - `[low]` `[reject]` (edge 1) A no-credential resume keeps a stale credential file in the vendor home. -- Same as blind 5.
  - `[low]` `[reject]` (edge 2) `validateSpec` accepts `resume` without a credential. -- Same as blind 5.
  - `[low]` `[reject]` (edge 3) The lockfile launch keeps the vendor `apiHosts`. -- Same as blind 7.
  - `[medium]` `[patch]` (edge 4) The `self-host.md` count rows are stale. -- Same root cause as blind 2. Patched there.
  - `[false]` `[reject]` (edge 5) The real-CLI case now skips on the host without `XARABOT_LIVE=1`. -- The AC requires it: "when `XARABOT_LIVE=1` is not set, then it reports skipped, whatever `canSandbox` returns".
  - `[false]` `[reject]` (edge 6) The merger fix removed `expect(otherBase).not.toBe("")`. -- That line checked only a variable the fix removes. The assertions the AC protects (exactly one fetch of `[main]`, `r.ok`) are unchanged.
  - `[medium]` `[defer]` (verification-gap 1) The credential-less real-sandbox launch and the zsh heredoc are checked only by nested cases that run on a macOS host outside a session. -- Pre-verified. Deferred as filed, since closing it needs the macOS CI job (decision 29, a `ci-workflow` Human Live Step). Recorded in `deferred`.
  - `[medium]` `[patch]` (verification-gap other 1) The `self-host.md` host counts are stale. -- Same root cause as blind 2. Patched there.
  - `[false]` `[reject]` (intent 1) Nothing shows that the `claude` Bash tool picks up `TMPPREFIX`. -- zsh imports `TMPPREFIX` from its environment. In this session, `TMPPREFIX=$TMPDIR/zsh zsh -c 'cat <<EOF …'` exits 0, and without it the heredoc fails. The Bash tool's shell inherits the session env that `buildSessionEnv` builds.
  - `[false]` `[reject]` (intent 2) The skips key on the env var, not on actual denial. -- The AC names the condition `XARABOT_SANDBOXED=1`. A real-session run gave `0 fail`.
  - `[false]` `[reject]` (intent 3) "No credential" is asserted at the spec-object level. -- The AC asks that the launch spec carry no credential and that a test assert it. `ci-step.test.ts` does both. The `apiHosts` part is the same as blind 7.
  - `[false]` `[reject]` (intent 4) The 10 runs happened only in a session, with lighter load. -- The cause was two commits crossing a second boundary. The fix builds `main` on the same `base` object, so the result no longer depends on time or load. Host runs are not possible in this session.
  - `[low]` `[patch]` (intent 5) The new in-session row sits under an intro that says every count was measured on the host, outside a sandbox. -- The intro is reworded, together with the blind 2 patch.
  - `[false]` `[reject]` (intent 6) The `epic-2-context.md` changes are outside the Story's intent. -- Same as blind 1.

## Design Notes

- **Prefix, not folder.** zsh appends to `TMPPREFIX` (default `/tmp/zsh`). `<tempDir>/zsh` puts its files in the writable temp folder without a new rebuilt folder.
- **Why optional on `LaunchSpec` but required on `AgentLaunchSpec`.** The sandbox port serves both agent sessions and repo commands. Only the runner's repo commands may omit the credential, so no adapter can drop it by accident.
- **Skip helper, not per-file env checks.** One `isSandboxed` source keeps "reports skipped inside a session" consistent with `sandboxTest`'s existing rule.

## Verification

**Commands:**
- `bun test` (inside this sandboxed session, `XARABOT_SANDBOXED=1`) -- expected: `0 fail`, 10 runs in a row.
- `bun --bun oxlint` -- expected: exit 0.
- `bun --bun tsc` -- expected: exit 0.
- `bun test test/lane/merger.test.ts` -- expected: pass.

## Auto Run Result

Status: done

**Summary.** Story 2.5c is complete.
- **zsh heredocs (F7).** Every session env sets `TMPPREFIX` to `<tempDir>/zsh`. `TMPPREFIX` is a reserved name: a spec can't use it, and the launching env's value never passes through.
- **0 fail inside a session (F8).** A shared helper in `test/support/sandbox.ts` (`isSandboxed`, `hostTest`, `hostDescribe`) skips, under `XARABOT_SANDBOXED=1`, exactly the 74 baseline failures the profile causes:
  - socket binding: the GitHub emulator contract, the `git-server.ts` users, `runner-install`, `proxy`;
  - `ps` and signals: `processes`, `wait`, `stop`, `lane-commands`, one `lane-process` case;
  - resolving `/tmp`: `realpathLoose`.
- **Real-CLI case.** The agent contract's real-CLI case now also needs `XARABOT_LIVE=1`.
- **No credential for the lockfile command (A14, AR19).**
  - `LaunchSpec.credential` is optional. An absent credential means a runner repo command: the vendor home is emptied, and no credential file is read or seeded.
  - `Agent.launchSpec` returns `AgentLaunchSpec`, which still requires the credential.
  - `regenerate` builds its launch without one.
- **The flaky merger test.**
  - Cause: the test rebuilt `base` in a second repo and relied on both commits landing in the same second to get the same SHA. Under load they crossed a second boundary, the histories were unrelated, and `git merge-tree` exited 128 ("refusing to merge unrelated histories").
  - Fix: the test fetches `base` itself into the other repo. Its assertions are unchanged.
- **Runbook.** The `XARABOT_SANDBOXED=1 bun test test/sandbox/` evidence row is replaced by an in-session `bun test` expecting `0 fail`. The host counts now include the added cases.

**Files changed (baseline `bdf976cf0a31ecd04a8363719db035fa549be567` → working tree):**
- `src/sandbox/environment.ts` -- `TMPPREFIX` set and reserved.
- `src/ports/sandbox.ts` -- optional `credential`.
- `src/ports/agent.ts`, `src/adapters/agent/claude/claude-agent.ts` -- `AgentLaunchSpec`.
- `src/sandbox/macos.ts`, `src/sandbox/vendor-home.ts` -- the no-credential path.
- `src/lane/lane-process.ts` -- the lockfile launch without a credential.
- `test/support/sandbox.ts` -- `isSandboxed`, `hostTest`, `hostDescribe`.
- Session skips: `test/adapters/forge/github/{fetch-shas,push,runner-git}.test.ts`, `test/contracts/forge.github.contract.test.ts`, `test/lane/{processes,wait,stop,runner-install,lane-process}.test.ts`, `test/cli/lane-commands.test.ts`, `test/sandbox/{proxy,tools}.test.ts`.
- `test/contracts/agent.contract.ts` -- the live gate.
- New rows: `test/sandbox/{environment,vendor-home,macos}.test.ts`.
- `test/lane/ci-step.test.ts` -- asserts the lockfile spec has no credential.
- `test/lane/{merge-step,pr-step}.test.ts` -- type-only casts to `AgentLaunchSpec`.
- `test/lane/merger.test.ts` -- the shared-base fix.
- `docs/maintainer/self-host.md` -- the evidence table.
- `_bmad-output/implementation-artifacts/epic-2-context.md` -- recompiled by step 1, because a planning artifact (the 2026-10-24 Maintainer note) is newer. The runner reverts builder changes to this file.

**Review findings.** 29 findings: high 0, medium 4, low 15, false 10, maybe-false 0.
- **Patched (5 entries; by entry verdict: medium 1, low 4):**
  - medium: the stale host counts in `self-host.md` (blind 2, edge 4, verification-gap other 1);
  - low: the proxy `live` block made `hostDescribe` (blind 4);
  - low: a no-credential refusal case that runs in a session (blind 8);
  - low: the `value()` idiom in `merger.test.ts` (blind 14b);
  - low: the table intro reworded (intent 5).
- **Deferred (1):** medium, the real-sandbox no-credential and zsh paths are checked only on the macOS host (verification-gap 1). It needs the macOS CI job.
- **Rejected:**
  - low: blind 3 (the AC fixes `0 fail`; counts drift every Story);
  - low: blind 5, edge 1 and edge 2 (no caller combines `resume` with no credential);
  - low: blind 6 (only the runner builds a `LaunchSpec` by hand; a missing credential fails closed);
  - low: blind 7 and edge 3 (vendor hosts are useless without a credential, and the network allowlist is a separate decision);
  - low: blind 9 (those cases do start a git server);
  - low: blind 10 (the fix would edit this spec; the baseline is recorded below);
  - low: blind 13 (the AC asks for a heredoc; checked by hand in this session);
  - low: blind 14a (cosmetic);
  - false: blind 1 and intent 6 (step 1 recompiled the context, and the runner reverts it);
  - false: blind 11 (written here);
  - false: blind 12 (JUnit comparison: no case that passed before is skipped now);
  - false: edge 5 (the AC requires it);
  - false: edge 6 (the removed line checked a removed variable);
  - false: intents 1-4 (the evidence is in the triage log).
- **Follow-up review:** not recommended. One medium entry was patched, it was a docs count, and no high was patched.

**Verification.**
- Baseline at `bdf976c`, inside this sandboxed session: 3142 pass, 164 skip, 74 fail. Every failure was caused by the sandbox, in 12 files:
  - emulator contract: 32;
  - `push`: 12;
  - `runner-install`: 7;
  - `fetch-shas`: 5;
  - `processes`, `stop`: 4 each;
  - `lane-commands`: 3;
  - `runner-git`, `tools`: 2 each;
  - `wait`, `lane-process`, `proxy`: 1 each.
- After the patches, `bun test` inside this session (`XARABOT_SANDBOXED=1`) ran 10 times in a row. Every run gave 3184 pass, 263 skip, 0 fail.
- `bun --bun oxlint`: exit 0. `bun --bun tsc`: exit 0.
- A per-test JUnit comparison against a baseline worktree found no case that passed before and is skipped now.
- By hand in this session: a zsh heredoc fails with the default `TMPPREFIX` ("can't create temp file for here document: operation not permitted"). The same heredoc succeeds with `TMPPREFIX=$TMPDIR/zsh`.

**Residual risks.**
- The nested macOS cases (the zsh heredoc, the no-credential session, `TMPPREFIX` in the allowlist row, the `TMPPREFIX` refusals) have not run anywhere. They need the Maintainer's host run.
- The updated host counts in `self-host.md` are computed, not measured. Re-measure them on the host.
- Sessions get the `TMPPREFIX` fix only after the Maintainer advances `runner_version` past this Story.
- Not committed. The lane's task rules say to leave the changes in the working tree for the runner, which overrides the workflow's commit step.
