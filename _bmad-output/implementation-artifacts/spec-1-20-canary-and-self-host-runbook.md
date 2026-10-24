---
title: 'Story 1.20: Canary and self-host runbook'
type: 'feature'
created: '2026-10-23'
baseline_revision: 'ffbe59095565468fd4be795d03ceb1c072a16567'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Nothing yet shows that a real lane works end to end, and nothing tells the Maintainer how to switch from the bootstrap loop to Xarabot's own pinned runner (NFR13, NFR14).

**Approach:**
- A live canary suite in `test/e2e/` runs the real `laneRun` against a scratch GitHub repo. It uses a stub `claude` CLI inside the real macOS sandbox. In one unit it covers a usage-limit sleep, the claim, the bot commit, the PR, CI, the enqueue, `merged`, and a STOP during the trailing wait.
- Non-live cases check the stub, the scratch seed and the commit check, so the suite gives evidence even without credentials.
- `docs/maintainer/self-host.md` lists every switch step, every step while Epic 2 is built, and the live commands with their expected results.

## Boundaries & Constraints

**Always:**
- **Live switch.** The live case runs only when `XARABOT_LIVE=1`, `XARABOT_LIVE_GITHUB_REPO` (`owner/name`) and `XARABOT_LIVE_GITHUB_LOGIN` are all set, and only where `sandboxTest` runs. Otherwise it reports skipped. These are the same variables the live forge contract uses.
- **The stub CLI (`test/e2e/stub-claude.ts`).** `stubClaudeScript(p)` returns a POSIX `sh` script:
  - `--version` prints `2.1.309 (Claude Code)`.
  - Otherwise it reads stdin and compares `date +%s` with `p.limitUntil` (epoch seconds).
  - **Before `limitUntil`:** it prints a `system`/`init` line, a `rate_limit_event` line (`status: "rejected"`, `resetsAt: p.reset`) and an error `result` line (`Claude AI usage limit reached|<reset>`). It writes no result and exits 1.
  - **From `limitUntil` on:** it writes `canary/<runId>.md` and the Story's spec file in the clone. The spec file has `status: done` and `## Auto Run Result` with `Status: done`. The script prints `init` and a success `result` line, and writes the build result JSON to `$XARABOT_RESULT` last.
  - The caller sets `limitUntil = reset + 119`. The lane's sleep ends at `reset + 120 s`, so the second session always builds, and the stub keeps no state.
- **The scratch seed (`test/e2e/scratch-seed.ts`).** `scratchSeed({repo, login})` returns the scratch repo's files:
  - `.xarabot/config.yaml`, `policy.yaml` (with `unattended_adapters: [claude]` and `expected_checks: [check]`) and `human-live-steps.yaml`;
  - the Standing Authority, `epics.md` with Story 1.1, `epic-1-context.md` and `sprint-status.yaml` (`1-1-canary: backlog`);
  - the manifest `stories/1.1.md`, with globs `canary/**`;
  - `.github/workflows/ci.yml`, a job `check` that runs on `pull_request` and `merge_group`.

  Run as a script (`bun test/e2e/scratch-seed.ts <dir> <owner/name> <login>`), it writes them into `<dir>`.
- **The commit check (`test/e2e/bot-commit.ts`).** `checkBotCommit(raw, login)` is pure. Given `git cat-file commit` text, it requires that author and committer are both `<login>-xarabot[bot]`, with an email ending `+<login>-xarabot[bot]@users.noreply.github.com`. It also requires that the message has no trailer lines (`Key: value` in the last paragraph) and no `Co-Authored-By` or "Generated with".
- **The live case (`test/e2e/canary.test.ts`):**
  1. It reads the scratch `main` through a forge snapshot and requires `loadRepoConfig` to pass.
  2. It builds a temp `HOME` and `XDG_CONFIG_HOME` holding `host.yaml` (lane `canary`, builder, `claude`), a dummy mode-600 `oauth-token` and the `runner` file set to `main`'s `runner_version`, so no install runs.
  3. It puts the stub as `claude` first on `PATH`.
  4. It passes a `Connect` built from the real App credentials, read from the caller's own config. That `Connect` uses a fresh ledger branch `xarabot/test-<uuid>` and a forge that prefixes unit branches and alert conditions with `xarabot-test/<uuid>/`. Each run is then independent and can be repeated.
  5. It sets `reset = now + 30 s`.
  6. When `wait.pid` appears after `outcome` is written, it writes the lane's `STOP`.
- **What the live case asserts:**
  - `laneRun` exits 0 within 5 s of the STOP plus one poll, and the outcome is `progress`.
  - The ledger record `story:1.1` is `merged`, and it is the only record.
  - The journal has one `usage-limit` span whose `ended_at` is at or after `reset + 120 s` (1 s slack). After it comes one unit record with `sessions` 2, `result: done` and `state: merged`.
  - The PR head commit, fetched into a scratch git dir, passes `checkBotCommit`.
  - A second `laneRun` with STOP present exits 0 and leaves the ledger unchanged.
  - Cleanup closes the open PRs and deletes the prefixed branches and the ledger branch.
- **Shared helpers.** The `prefixed` forge wrapper and the scratch cleanup move from `test/contracts/forge.github.contract.test.ts` into `test/support/live-github.ts`, and both suites import them.
- **The runbook (`docs/maintainer/self-host.md`):** every item the Story's third and fourth AC lists, in order, each with the command or file content to apply. Values come from the code:
  - the `check` job of `docs/maintainer/ci-workflow.yml` as a required check;
  - the claims ruleset (no force-push or deletion of `xarabot/claims`, and no other ruleset matching it);
  - the merge queue (squash);
  - `squash_merge_commit_title=PR_TITLE` and `squash_merge_commit_message=PR_BODY`;
  - the App permissions, pointing to `app-permissions.md`, and the credential, pointing to `claude-credential.md`;
  - `.xarabot/config.yaml` (with `runner_version`, `maintainer: edanisko`, `standing_authority_path: docs/maintainer/standing-authority.md`, `bootstrapped_epics: [1]`, `manifests: {dir: stories}`);
  - `policy.yaml` (`unattended_adapters: [claude]`, `expected_checks: [check]`, `owner_approval_paths: ["**"]`) and `human-live-steps.yaml`;
  - the Standing Authority, the bootstrap writes, the retro, `XARABOT_MAX_BUILDERS=1`, `lane install`, and stopping the bootstrap loop;
  - the steps while Epic 2 is built, the `retro-gates.yaml` go shape (`ruling: maintainer-pr`), the canary command and its expected result, and the sandbox suites' commands with their measured pass and skip counts.

**Never:**
- No change to `src/`. This Story adds tests and docs only, apart from fixing the test race below.
- No write of `.xarabot/**`, `.github/**` or `AGENTS.md` in this repo. The runbook gives their content for the Maintainer.
- No GitHub token in the stub's environment, the session, an argv or a file. No `pkill` and no `timeout`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Stub limit phase | `date` before `limitUntil`, run in the real sandbox | no result file; `parseClaudeUsage` gives `usageLimit.resetAt = reset·1000` | exit 1 |
| Stub build phase | `date` from `limitUntil` on | result passes `parseSessionResult(build)`; the spec passes `checkBuildSpec(done)`; `canary/<runId>.md` exists | none |
| Stub version | `--version` | `cliVersion` + `claudeStartCheck` pass | none |
| Seed | `scratchSeed` as a `main` snapshot, empty ledger | `loadRepoConfig` ok; `next` picks `story:1.1`; `approvalPaths` of the stub's paths is empty | none |
| Commit check | bot author, clean message / human author / `Co-Authored-By` / `Signed-off-by:` trailer | ok / error naming the author / error / error | none |
| Live off | no `XARABOT_LIVE`, or `XARABOT_SANDBOXED=1` | the live case reports skipped; the rest pass | none |

</intent-contract>

## Code Map

- `src/cli/lane-run.ts` -- `laneRun(args, {env, connect, out, errOut})`. The canary calls it as is. The steps: STOP, connect, snapshot, `runner` version, refusals (`cliVersion` on the launching `PATH`, the credential file) and compose.
- `src/cli/lane-connection.ts` -- `Connect`, `LaneConnection`, and `githubConnect` (the model for the canary's connect: `createTokenSource`, `createGitHubFetch`, `fetchBotUserId`).
- `src/cli/host-paths.ts` -- `hostPaths(env)`, `RUNNER_FILE`, and the lane folder `~/.xarabot/repos/<owner>__<name>/lanes/<lane>`.
- `src/lane/lane-store.ts` -- `laneLayout` (`journal`, `outcome`, `stop`, `clone`, `resultPath`), with `wait.pid` in the lane folder.
- `src/lane/lane-process.ts:1041` -- the trailing wait after `writeOutcome`. Usage-limit sleep 624. Spec match 705.
- `src/core/lane/waits.ts` -- `usageLimitSleepMs` (reset + 2 min, clamped), `TRAILING_WAIT_MS.progress` 1 min.
- `src/adapters/agent/claude/usage.ts` -- `parseClaudeUsage`: a `rate_limit_event` with `rejected`, and the `usage limit|<epoch>` suffix.
- `src/adapters/agent/claude/claude-agent.ts` -- `claudeLaunchSpec`, `claudeStartCheck`, `CLAUDE_MIN_VERSION`.
- `src/core/lane/build-check.ts` -- `checkBuildSpec`. `src/core/schemas/session-result.ts` -- `parseSessionResult`.
- `src/core/next/snapshot.ts` (`assembleSnapshot`), `src/core/next/next.ts` (`next`), `src/core/ci/approval.ts` (`approvalPaths`), `src/core/config/load-repo-config.ts` (`loadRepoConfig`, `effective_protected_paths`).
- `src/adapters/forge/github/github-forge.ts` -- `createGitHubForge({ledgerBranch, runnerGit, maintainer})`. `credentials.ts` -- `loadAppCredentials`.
- `test/contracts/forge.github.contract.test.ts:105-232` -- `LIVE_REPO`/`LIVE_LOGIN`, `prefixed`, and `liveScratch` cleanup, to move into `test/support/live-github.ts`.
- `test/contracts/agent.contract.ts:43` and `test/sandbox/macos.test.ts` -- patterns for running a stub CLI in the real sandbox. `test/support/sandbox.ts` -- `sandboxTest`, `liveSandboxTest`. `test/live.test.ts` -- the pattern for spawning a nested `bun test` to check skip reporting.
- `test/cli/lane-fixture.ts` -- `mainFiles`, `writeCredential`, and the `host.yaml` shape (`HOST_ID`).
- `test/cli/graph-check.test.ts:132` -- already asserts that `xarabot graph check` on this repo exits 0 (the fourth AC). It is kept, and the runbook names it.
- `test/sandbox/macos.test.ts:318` -- a race: the host probe's `open` callback can fire after `accepted = 0`. It fails here every time. The fix is to wait for the probe's accept before resetting.
- `docs/maintainer/{ci-workflow.yml,app-permissions.md,claude-credential.md}`, `bootstrap/loop/README.md` (read-only; stopping the loop is `touch ~/.xarabot-bootstrap/state/STOP` and `sudo launchctl bootout system/com.xarabot.bootstrap`).

## Tasks & Acceptance

**Execution:**
- `test/support/live-github.ts` -- `LIVE_REPO`, `LIVE_LOGIN`, `liveGithubEnabled`, `liveRepo()`, `liveCredentials()`, `prefixed()`, `cleanupScratch()`. `forge.github.contract.test.ts` imports them.
- `test/e2e/stub-claude.ts`, `test/e2e/scratch-seed.ts`, `test/e2e/bot-commit.ts` -- the helpers above.
- `test/e2e/canary.test.ts` -- the non-live rows (the stub phases under `sandboxTest`, the seed, the commit check), the skip-report row (a nested `bun test` with `XARABOT_LIVE=1 XARABOT_SANDBOXED=1`) and the live canary.
- `test/sandbox/macos.test.ts` -- fix the accept race.
- `docs/maintainer/self-host.md` -- the runbook.

**Acceptance Criteria:**
- Given no live credentials, when `bun test test/e2e/` runs, then every non-live case passes and the live canary reports skipped.
- Given the seeded scratch repo and live credentials on the Xarabot host, outside any sandbox, when the Maintainer runs `XARABOT_LIVE=1 XARABOT_LIVE_GITHUB_REPO=<o/n> XARABOT_LIVE_GITHUB_LOGIN=<login> bun test test/e2e/canary.test.ts`, then the live case passes with the assertions listed above, and a failed assertion names its step while cleanup still runs. This is the Maintainer's live run before Epic 1's retro; in this session it reports skipped.
- Given the runbook, when it is read against the Story's ACs, then every listed Maintainer step has a command or file content, and the canary and sandbox commands state their expected results.
- Given `bun test`, `bun --bun oxlint` and `bun --bun tsc`, when they run, then each exits 0.

## Spec Change Log

- Implementation note (no intent change): the live case's temp `host.yaml` names its lane `builder-1`, not `canary`. Ledger records and `assembleSnapshot` accept only `coordinator` or `builder-<n>` (`LaneName` in `src/core/schemas/ledger.ts`), so a lane named `canary` stops at its first snapshot (`invalid-snapshot: lane.lane`). `xarabot lane install` accepts any `[A-Za-z0-9_-]` name, so it does not catch this. The runbook warns about it, and `src/` is unchanged.

## Review Triage Log

### 2026-10-23 — Review pass
- verdicts: 20 findings — high 0, medium 0, low 19, false 1, maybe-false 0 (plus 8 intent-alignment divergences, recorded last)
- findings:
  - `[low]` `[patch]` (verification-gap) `cleanupScratch`'s keep-going-after-a-failure path runs only in live suites — a non-live test now drives it with a stub forge and a failing `RawCall`.
  - `[low]` `[patch]` (verification-gap) no `checkBotCommit` row exercises the `<id>+` email prefix — rows added for a missing id and for a wrong committer name with the bot email.
  - `[low]` `[patch]` (blind) the live `finally` cleans up while a lane past its deadline may still run — cleanup now waits up to 30 s for `laneRun` and notes when it is still pending.
  - `[low]` `[patch]` (blind) the scratch repo's squash messages are not set to PR title + body, unlike the switch — the runbook's scratch setup now sets them. The other half, checking the squash commit on `main`, is rejected: GitHub's squash commit has GitHub as committer, so `checkBotCommit` cannot apply; the lane's own commit is the PR head, which the canary checks.
  - `[low]` `[patch]` (blind) the runbook has the lane's macOS user push the scratch seed and the runner tag, but that user holds no Maintainer git credential — those steps now run on the Maintainer's own machine.
  - `[low]` `[reject]` (blind) cleanup leaves `xarabot-inbox` alert issues from a failed run — only a failed run raises one, its condition carries the run prefix, and closing issues adds an operation to the test helper; the Maintainer closes it by hand.
  - `[low]` `[patch]` (blind) `await probed` in the macOS race fix has no bound — it now races a 5 s timeout with a clear error.
  - `[low]` `[reject]` (blind) no nested test for `XARABOT_LIVE=1` with the repo or login missing — `liveGithubEnabled` is a one-line conjunction already used by the live forge contract; a third nested `bun test` adds runtime for no named harm.
  - `[low]` `[patch]` (blind) several live steps pass no `diagnostics`, and step 8 clears the first run's stdout — diagnostics are passed and step 8 reads only its own new lines.
  - `[low]` `[patch]` (blind) runbook step 14 says to close bootstrap PRs "first" after its commands — moved to the top with a `gh pr list` check.
  - `[low]` `[patch]` (blind) the Standing Authority text grants enqueueing approved PRs, but with `owner_approval_paths: ["**"]` the Maintainer approves and queues every PR by hand — the grant is reworded to match `merge-step.ts`.
  - `[low]` `[patch]` (blind) runbook step 9 reads as if `granted_by` is compared with the literal `maintainer` — reworded to the `maintainer` login in `config.yaml`.
  - `[low]` `[patch]` (blind) `checkBotCommit` table skips refusal paths — same root as the verification-gap row; the header-count, no-blank-line and `gpgsig` rows are rejected: `gpgsig` continuation lines start with a space and never match the `author `/`committer ` filter, and the other returns guard malformed `git cat-file` output git never prints.
  - `[low]` `[patch]` (edge) `laneRun` rejecting leaves the `.finally` chain's rejection unhandled — `.catch` added.
  - `[low]` `[patch]` (edge) steps 7 and 8 carry no diagnostics — same root as the blind row.
  - `[low]` `[patch]` (edge) the seed emits `maintainer`, `granted_by` and `repo` as bare YAML scalars, so a numeric login parses as a number — they are now quoted with `JSON.stringify`.
  - `[low]` `[reject]` (edge) a `specPath` with no slash makes `mkdir -p ''` fail — only the default spec path, which has folders, is ever passed; a branch for an unused input adds code.
  - `[false]` `[reject]` (edge) an unset `XARABOT_RESULT` gives an unclear redirect error — the sandbox always sets `XARABOT_RESULT` to the profile's result path, and the lane reports a missing result itself.
  - `[low]` `[patch]` (edge) unbounded `await probed` — same root as the blind row.
  - `[low]` `[patch]` (edge) cleanup while the lane still runs — same root as the blind row.
  - intent alignment (descriptive):
    - The diff implements the harness reading: the real `laneRun` and `runLaneProcess` in-process against live GitHub and the real sandbox, with a test `Connect`, a fresh ledger and prefixed branches. `lane install`, the launcher, launchd and the production `githubConnect` are not on the canary's path.
    - "Passes CI" is the scratch repo's trivial `check` job, which exercises the CI polling plumbing, not Xarabot's own workflow.
    - ACs 2 and 3 are proven only by the live case, skipped here. Their lane-side behavior is covered by Story 1.18's tests with fakes; the live rehearsal during implementation (fake forge, real sandbox and waiter) is not in the suite.
    - The runbook's live result counts (`19 pass`) are a prediction from the suite's test count; the sandbox counts were measured in this session on the Xarabot host, not under `XARABOT_SANDBOXED`.
    - The live command needs `XARABOT_LIVE_GITHUB_REPO`, `XARABOT_LIVE_GITHUB_LOGIN` and a one-time scratch setup, wider than the AC's `XARABOT_LIVE=1 bun test <suite>` but within its "Given the scratch repo and live credentials".
    - The runbook's YAML blocks are checked only by reading; only the seed's YAML is tested.
    - The macOS race fix and the helper move are beyond the ACs, justified by a failing suite and shared use.
    - AC 4 is met by the existing `graph-check.test.ts:132`.

## Design Notes

**One unit covers three ACs.** In one run, the usage limit hits before the build, the build merges, and the STOP lands in the trailing wait. That keeps the live run to about 5 minutes and one scratch PR. The ordering is forced by `runLaneProcess`: a session runs, sleeps through the limit, and runs again, and the trailing wait follows the outcome.

**Why a fresh ledger and prefixed branches.** `next` skips a Story that is `done` in `sprint-status.yaml` or that has a record. The stub never marks sprint status `done`, and each run gets an empty ledger branch, so `story:1.1` is eligible on every run. Prefixing keeps the old `story/1.1` branches and merged PRs from being adopted.

**Why `limitUntil = reset + 119`.** The first session must start before `limitUntil`. The second starts at `reset + 120 s` at the earliest, which is after `limitUntil`. Live uses `reset = now + 30 s`, so the first session has 149 s to start.

## Verification

**Commands:**
- `bun test test/e2e/` -- expected: non-live pass, live skipped
- `bun test` -- expected: exit 0
- `bun --bun oxlint` -- expected: exit 0
- `bun --bun tsc` -- expected: exit 0

## Auto Run Result

Status: done

**Summary:** Story 1.20 adds the end-to-end canary and the self-host runbook. Nothing under `src/` changed.
- **The live canary** (`test/e2e/canary.test.ts`) runs the real `laneRun` against a seeded scratch repo, with a stub `claude` CLI inside the real macOS sandbox. In one unit it covers:
  1. a usage-limit sleep to reset + 2 min;
  2. the claim, the bot commit, the PR, CI, the merge queue and `merged`;
  3. a STOP during the trailing wait;
  4. a second start with STOP present.

  It runs only with `XARABOT_LIVE=1` plus the scratch repo and login, outside a sandbox. Otherwise it reports skipped.
- **The non-live cases** check the stub's two phases in the real sandbox, the seed through `loadRepoConfig`, `next` and `approvalPaths`, the bot-commit check, skip reporting (two nested `bun test` runs) and `cleanupScratch`.
- **`docs/maintainer/self-host.md`** holds, each with its command or file content:
  - the evidence to gather first: the sandbox suite counts, the canary command and its expected result, and `graph check`;
  - the 15 switch steps;
  - the steps while Epic 2 is built.

**Files changed:**
- `test/e2e/canary.test.ts`: the canary suite, live and non-live.
- `test/e2e/stub-claude.ts`: the stateless stub `claude` script.
- `test/e2e/scratch-seed.ts`: the scratch repo's files, also runnable as a script.
- `test/e2e/bot-commit.ts`: the pure check of the bot author and committer and of trailers.
- `test/support/live-github.ts` (new) and `live-github.test.ts`: the shared live helpers (`prefixed`, `cleanupScratch`) and a non-live test of the cleanup.
- `test/contracts/forge.github.contract.test.ts`: now imports the shared helpers.
- `test/sandbox/macos.test.ts`: fixes an accept race. That test failed every time on this host.
- `docs/maintainer/self-host.md`: the runbook.

**Review findings:** 20 findings: 19 low, 1 false, plus 8 descriptive intent rows.
- **Patched:** 15 rows (0 high, 0 medium, 15 low):
  - live cleanup waits for the lane;
  - the unhandled rejection;
  - diagnostics on every step;
  - `checkBotCommit` rows;
  - a `cleanupScratch` test;
  - the bounded probe wait;
  - quoted seed scalars;
  - five runbook corrections: which machine pushes, the scratch squash settings, the step 14 order, the Standing Authority enqueue wording and the `granted_by` wording.
- **Deferred:** none.
- **Rejected:** 5, each with its reason in the Review Triage Log:
  - alert issues left behind by a failed run;
  - a third nested live-off test;
  - a spec path with no folder;
  - an unset `XARABOT_RESULT` (false);
  - checking the squash commit on `main`, whose committer is GitHub.

**Follow-up review recommended:** false. No high was patched and only low-severity rows were patched.

**Verification:**
- `bun install`: no changes.
- `bun test test/e2e/ test/support/`: 22 pass, 1 skip (the live canary), 0 fail.
- `bun test`: 2545 pass, 64 skip, 0 fail on five of six full runs. One run had 1 failure, which did not recur and was not captured.
- `bun --bun oxlint` and `bun --bun tsc`: both exit 0.
- Every matrix row has a passing test.
- During implementation, a rehearsal ran the real `laneRun`, sandbox, stub and waiter against the fake forge. It confirmed the usage-limit span, `merged`, the STOP exit (4.95 s) and the second start.

**Residual risks:**
- The live canary has not run against GitHub. Real git pushes, Actions on the bot's PR, the merge queue and the `refs/pull/<n>/head` fetch are proven only when the Maintainer runs it.
- The runbook's `gh api` ruleset and merge-queue JSON was written from the API docs and not tried live.
- The runbook content needs the Maintainer's confirmation: the Human Live Steps list, the Standing Authority wording, the Epic 2 manifest example globs and the `<tag>` placeholders.
- The canary's lane must be named `builder-1`, because `LaneName` accepts only `builder-<n>` or `coordinator`. `xarabot lane install` accepts other names, which then fail at the first snapshot. This is a latent `src/` gap, outside this Story.
- An intermittent failure in the full suite (1 in 6 runs) was not identified.
