---
title: 'Story 2.12: Claims race verification'
type: 'feature'
created: '2026-10-25'
baseline_revision: '4ca289a6074795e227b4b0b184dcf3d9bfcbddcb'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Nothing yet proves, on the real GitHub ledger, that claims hold under a race (FR3). The fake-forge tests (Stories 2.1, 2.2, 2.11) cover the logic, but the builder limit must not be lifted after Epic 3 without live evidence. The Maintainer also has no runbook entry for the Epic 2 live run that Epic 2's retro waits for (`docs/maintainer/evidence/epic-2.md`, Story 2.9).

**Approach:**
- Add a live suite, `test/e2e/claims-race.test.ts`, that runs real `laneRun` lanes against the scratch repo's GitHub ledger. The lanes use stub sessions, so no agent runs, and the suite asserts the ledger history.
- Each live case also runs as a rehearsal on the fake forge in every `bun test`. The harness is therefore exercised without credentials.
- Add a live sandbox case: `bun install --frozen-lockfile` in a clone of this repo, run through the proxy.
- Add the evidence rows and the evidence-file instructions to `docs/maintainer/self-host.md`.

## Boundaries & Constraints

**Always:**
- **The lane under test is the real `laneRun`** (`src/cli/lane-run.ts`): the real STOP check, the lane lock, the version check, the start checks, and `runLaneProcess` with its claim loop, heartbeat keeper and fencing.
  - Only these seams are swapped:
    - `connect`: a GitHub forge, or the fake forge;
    - `cliVersion`: `STUB_VERSION`;
    - `start`: `runLaneProcess` with a holding stub sandbox and workspace, and a waiter that returns at once.
  - The holding session writes `<control>/<tag>.session` (the unit) when it starts. It then waits until `<control>/<tag>.release` exists or its signal aborts, and ends with exit 1 and no result, which is a failed attempt.
- **Live areas.** Each live case uses:
  - a fresh ledger branch `xarabot/test-<uuid>`;
  - unit branches prefixed `xarabot-test/<uuid>/` (`prefixed`);
  - the owner's App credentials (`liveCredentials`).
  - Cleanup runs in `finally` (`cleanupScratch`), with every race Story branch added to `touched`.
- **Main view.** Each lane reads the scratch repo's real `main`, with its Story set overlaid: `stories/**`, `epics.md` and `sprint-status.yaml` are replaced, and blob SHAs come from `gitBlobSha`. A lane's view may hold a different Story set from the other lane's. Rehearsals start the fake forge's `main` from `scratchSeed`.
  - Alerts go to a recorder, not to GitHub. The coordinator-gone alert is best effort, and it is not under test.
- **A forced race.** A swap barrier holds each racing lane's first `ledgerSwap` until both lanes have reached theirs, or 60 s pass. It records each lane's old tip and the result.
- **Hosts.** Each host is its own `HOME`/`XDG_CONFIG_HOME`, with a `host.yaml` (a fresh `host_id` UUID, one lane `builder-1`), a dummy Claude credential and the `runner` file matching `main`'s `runner_version`.
- **Gating:**
  - A live case (names start `live race:`) runs only with `XARABOT_LIVE=1`, `XARABOT_LIVE_GITHUB_REPO` and `XARABOT_LIVE_GITHUB_LOGIN` set, and `XARABOT_SANDBOXED` not `1`. Otherwise it reports skipped.
  - The 30-minute case (name starts `live long:`) also needs `XARABOT_LIVE_LONG=1` (`isLiveLong`, in `test/support/live.ts`).
  - Rehearsals that spawn lanes as OS processes use `ps`, so they are `hostTest`s.
- **Process control.** Kill by exact PID (`process.kill(pid, "SIGKILL")`). No `pkill`, no `timeout` binary.
- **The `bun install` case** is a `liveSandboxTest`:
  - `git clone` this checkout into a lane-layout clone;
  - `repoHosts` from the clone's `.xarabot/config.yaml` `proxy_hosts` (parsed with the config schema);
  - no credential (a repo command, AR19);
  - `bun install --frozen-lockfile` in the real macOS sandbox. It expects exit 0.

**Never:**
- No change under `src/`, `.github/`, `.xarabot/`, `AGENTS.md`, `_bmad/` or the spec folder.
- No change to `scratch-seed.ts`'s output or the canary, so the scratch repo needs no reseed.
- No real agent session in the race suite. No push, PR or merge, except the replayed late push, which the fence must refuse.
- No mocks in core tests (none are added).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| One unit | hosts A, B (different `host_id`s), both views hold Story 1.1 only; both run at once | both first swaps carry the same old tip: one `ok`, one `conflict`. The ledger has exactly one `ledger: claim story:1.1 [skip ci]`; the record is held by the winner at generation 1. Only the winner's session starts. The loser's `laneRun` exits 0 with `lane builder-1: idle` | barrier timeout: the assertion on the old tips fails |
| Overlapping globs | view X holds 1.1 (`race/shared/**`) and 1.3 (`race/other/**`); view Y holds 1.2 (`race/shared/b/**`) and 1.3 | same tip, one `ok` and one `conflict`. Exactly one of 1.1 or 1.2 is claimed, the other has no record, and 1.3 is claimed by the losing lane. Both sessions start, the loser's on 1.3 | — |
| Same lane, two processes | two OS processes of `builder-1`, one `HOME`, started at once | one session starts; the other process exits 0 printing `is already running` and `exiting without a claim`. `lane.lock`'s PID is the holder's. Live: exactly one claim commit. After the release, the holder exits 0 and `lane.lock` is gone | — |
| Killed mid-unit (long) | host A's lane in an OS process, holding story 1.1 at generation g; killed by PID | the process ends by SIGKILL. A host B run before the stale age exits 0 `idle`, and the record is unchanged | — |
| …after 30 min | forge `now` ≥ the last `heartbeat_at` + 30 min (`isStale`) | host B's run takes over: the record is held by B at g + 1, `attempts` + 1, and B's session starts | — |
| Late push replayed | the real `createPrStep` as host A, from A's generation-g record, with a real commit | output `failed`, state `null`, reason contains `fence: unit lost`. No branch head on `story/1.1`; the record is still B's at g + 1 | — |
| Rehearsal of the kill | the same steps on the fake forge; holder A in process with a 24 h heartbeat interval; `setNow` past the stale age | the same assertions, apart from the PID kill | — |
| Skipped | `XARABOT_LIVE` unset; or live but no scratch variables; or `XARABOT_SANDBOXED=1` | `-t "^live"`: 4 skip, 0 pass, 0 fail | — |
| Long not asked | live with the scratch variables, `XARABOT_LIVE_LONG` unset | `-t "^live long:"`: 1 skip, 0 pass, 0 fail | — |
| bun install | live, on the host | exit 0 | the output is shown on failure |

</intent-contract>

## Code Map

- `src/cli/lane-run.ts`: `laneRun` and `LaneRunDeps`: `connect`, `cliVersion`, `start` (gets the composed `LaneDeps`), `out`/`errOut`. Its lock message is `lane <name> is already running (pid …, lane.lock); exiting without a claim`, and its exit line is `lane <name>: <outcome>`.
- `src/lane/lane-process.ts`: `runLaneProcess` and `LaneDeps` (`sandbox`, `workspace`, `waiter`, `heartbeat.everyMs`). A claim swap that loses is `claim lost` → `continue` → the next round's `next`.
- `src/core/ledger/edits.ts`:
  - `claim` checks every precondition against the tip, overlap included;
  - `isStale`, `STALE_AFTER_MS`;
  - messages are `ledger: <edit> <unit> [skip ci]`.
- `src/core/ledger/codec.ts`: `parseLedger(files).value.units`.
- `src/lane/pr-step.ts`: `createPrStep` (step 5: `beat("fence")` before `pushBranch`). `src/lane/session.ts`: `PrStepInput` and `stepKit.lost` (`failed`, state `null`, reason `<what>: unit lost: …`).
- `src/lane/session.ts:~730–945`: `prepare` → `workspace.prepare`, `sandbox.run` with the keeper's signal; no result means a failed session.
- `src/adapters/forge/github/github-forge.ts`: `createGitHubForge` (`ledgerBranch`, `runnerGit`, `maintainer`). A missing ledger branch is created at an empty root on the first snapshot.
- `src/adapters/forge/github/http.ts`: `GITHUB_OPERATIONS.getCommit` and `request`, to walk the ledger history. `src/adapters/forge/github/runner-git.ts`: `openRunnerGit`, `runGit`. `src/adapters/forge/github/tokens.ts`: `createTokenSource`. `bot-user.ts`: `fetchBotUserId`. `fetch-shas.ts`: `createGitHubFetch`.
- `src/adapters/forge/fake/fake-forge.ts`: `createFakeForge`, `gitBlobSha`, `control.setNow`, `ledgerLog`, `makeCommit`.
- `src/core/next/snapshot.ts` `assembleSnapshot` and `src/core/next/next.ts` `next`: the `NextStory` for the replay, as in the canary's seed test.
- `test/e2e/canary.test.ts`: the model for the live `connect`, the host setup, `writeDummyCredential`, the nested `bun test` skip checks and the `step(...)` diagnostics.
- `test/support/live-github.ts`: `liveGithubEnabled`, `liveRepo`, `liveCredentials`, `prefixed`, `cleanupScratch`, `RawCall`. `test/support/live.ts`: `isLive`. `test/support/sandbox.ts`: `isSandboxed`, `hostTest`, `liveSandboxTest`.
- `test/e2e/scratch-seed.ts`: `scratchSeed`, `SEED_AUTHORITY_PATH`. `test/e2e/stub-claude.ts`: `STUB_VERSION`.
- `test/cli/lane-fixture.ts`: `fakeConnect`, the shape of a fake `LaneConnection`.
- `test/lane/several-lanes.test.ts`: the stub `Workspace`/`Sandbox` pattern.
- `test/sandbox/macos.test.ts:~50–130, 410`: the lane layout, the `createMacSandbox` run, and the live uv case to mirror. `src/core/schemas/config.ts`: the config schema with `proxy_hosts`.
- `docs/maintainer/self-host.md`: "Before you start: the evidence" (the sandbox table, the canary) and "While Epic 2 is built" ("Several builder lanes", line ~529).
- **What a lane session can verify.** It runs with `XARABOT_SANDBOXED=1`; `ps` is denied, but killing its own child by PID works. For the lock rows, then:
  - an in-process rehearsal runs two `laneRun`s on one host, with `LaneRunDeps.lock` giving each its own PID and a stub `ProcessTable` that reports the holder live. It runs everywhere.
  - a child-process rehearsal runs a fake-mode child: it claims, is killed by PID, ends by SIGKILL, and leaves `lane.lock` naming it. It needs no `ps`, so it runs everywhere.
  - the two-OS-process rehearsal is a `hostTest`.
- A fake-mode child has its own fake forge, so cross-process ledger facts (one claim in total, the takeover of a killed process's unit) are asserted only live. The in-process rehearsals assert them on one shared fake forge.

## Tasks & Acceptance

**Execution:**
- `test/support/live.ts` -- add `isLiveLong` (`XARABOT_LIVE_LONG=1`) -- the long-running switch.
- `test/e2e/race-harness.ts` (new) -- the shared pieces:
  - `raceStories` and the overlay;
  - `withMain`, the alert recorder and `swapRace`;
  - `raceHost`, `holdingSession` and `runRaceLane`;
  - `fakeArea` and `liveArea`, each with `connect`, `records`, `history`, `now`, `waitStale`, `replay` and `cleanup`;
  - `storyFor`, which gives the `NextStory` of a view.
- `test/e2e/race-lane.ts` (new) -- the child entry: `bun test/e2e/race-lane.ts <config.json>` runs one `runRaceLane` (`fake` mode: its own fake forge; `live` mode: the area's ledger branch and prefix), prints the lane's lines and exits with its code.
- `test/e2e/claims-race.test.ts` (new):
  - the four live cases;
  - the fake-forge rehearsals of the two races, the two-process lock (a `hostTest`) and the takeover with the late push;
  - a seed check that `next` picks the intended Stories in each view;
  - the nested skip checks.
- `test/sandbox/bun-install.test.ts` (new) -- the live `bun install --frozen-lockfile` case.
- `docs/maintainer/self-host.md`:
  - add "Epic 2's live evidence (Story 2.12)", with:
    - the race suite's live command and expected result;
    - the `bun install` row;
    - the agent-contract live smoke row;
    - committing the results as `docs/maintainer/evidence/epic-2.md`, with what it holds;
    - the after-Epic-3 acceptance check (a coordinator and 2 builders for 24 h, no unit built twice, no builder write to the status files);
  - point "Several builder lanes" at it;
  - update the sandbox table's `test/sandbox/` counts for the new case.

**Acceptance Criteria:**
- Given `bun test` without live credentials, or inside a sandboxed session, when it runs, then every live case reports skipped and the rehearsals that can run pass, with 0 fail.
- Given `bun --bun tsc` and `bun --bun oxlint`, when run, then they report no error.
- Given the runbook, when the Maintainer reads the Epic 2 evidence section, then each command has an expected result, and the section says to commit the results as `docs/maintainer/evidence/epic-2.md` before Epic 2's retro.

## Spec Change Log

## Review Triage Log

### 2026-10-25 — Review pass
- verdicts: 35 findings — high 0, medium 2, low 22, false 11, maybe-false 0
- findings:
  - `[low]` `[patch]` (blind) `endWorld` removes the world folder without awaiting the SIGKILLed children. — `endWorld` now awaits every child's `exited` before `rmSync`. Failing a timed-out in-process lane loudly was rejected: it adds a branch for a hang the lanes' own deadlines bound.
  - `[low]` `[patch]` (blind) The live `history()` silently truncates at 500 commits. — Same root cause as the edge row on the 500-commit cap. It now throws when the cap is hit with a commit still unread.
  - `[low]` `[reject]` (blind) The history assertions count only `ledger: claim` messages. — Asserting the whole history would pin heartbeat and fail commits whose timing varies. The record assertions already show the final state.
  - `[low]` `[patch]` (blind) Recorded alerts are never in the diagnostics. — One `alerts` array per world, passed to every connect and printed by `diagnostics()`.
  - `[medium]` `[patch]` (blind) A barrier timeout leaves no trace. — Same root cause as the edge row on the barrier's 60 s wait. Each first swap now records `barrier` or `timeout`, and the steps expect `barrier`.
  - `[low]` `[reject]` (blind) The `bun install` case asserts only exit 0. — The AC's outcome is exit 0. The sandbox suite already covers credential absence for repo commands (Story 2.5c) and the proxy's refusals.
  - `[low]` `[patch]` (blind) The runbook says the case clones "this checkout", but `git clone` copies only the committed HEAD. — The wording now says the committed HEAD.
  - `[low]` `[patch]` (blind) The evidence intro's "three commands below" is followed by a setup block, and nothing records the commit. — The block is labelled setup and records `git rev-parse HEAD` for the evidence file.
  - `[low]` `[reject]` (blind) The contract smoke row gives no pass or skip counts. — They cannot be measured off the host, and writing guessed counts would be worse. The row names the cases that must pass and says the GitHub cases skip without the scratch variables.
  - `[low]` `[patch]` (blind) The after-Epic-3 journal query is not limited to the 24 h window. — It now filters rows to `started_at >= "<start>"`. Computing the overlap in `jq`, and a ledger-history check, were rejected as more machinery than a one-off manual check needs.
  - `[low]` `[patch]` (blind) "Deletes both when it ends, pass or fail" is not true when Bun's test timeout fires. — Same root cause as the edge rows on the long-case timeout and the cleanup claim. The runbook names timeouts and gives a `gh api` command that lists leftovers.
  - `[low]` `[patch]` (blind) Unused surface: `RaceArea.now()` and `RaceLaneConfig.heartbeatEveryMs`. — `heartbeatEveryMs` is removed from the child config. `now` stays, because the spec's task list names it as part of the area contract.
  - `[low]` `[patch]` (blind) The nested skip checks run under Bun's 5 s default timeout but spawn a nested `bun test` allowed 60 s. — Each now has a 90 s timeout.
  - `[false]` `[reject]` (blind) The diff leaves out `epic-2-context.md` and the spec. — By design: the spec is the claims file, shown only to the edge layer. The Epic context is step-01's recompile, which the runner reverts.
  - `[medium]` `[patch]` (edge) The barrier's fixed 60 s wait is shorter than the 3 min live start window, so the barrier can open early and the live race fails falsely. — The cases pass `startMs(area)` as `waitMs`.
  - `[low]` `[patch]` (edge) A child that fails before a step pushes its output leaves none in the diagnostics. — `startChild` pushes the child's stdout and stderr when it exits.
  - `[low]` `[reject]` (edge) Awaits on `.done` and `.exited` are unbounded, so Bun's timeout can skip cleanup. — Bounding every await adds a wrapper at each call site. The lanes end on their own deadlines, and the runbook now covers leftovers after a timeout.
  - `[low]` `[patch]` (edge) The long case's bounded waits sum to about 59 min against a 60 min timeout. — The timeout is raised to 75 min.
  - `[low]` `[patch]` (edge) History is silently cut at 500 commits. — Grouped with the blind row; the walk throws.
  - `[low]` `[patch]` (edge) The runbook's cleanup claim fails on a test timeout. — Grouped with the blind row; the runbook is corrected.
  - `[low]` `[patch]` (edge) The diagnostics never read the children's output. — Grouped with the `startChild` row.
  - `[low]` `[patch]` (edge) "Each live case also runs as a rehearsal" overclaims. — The module docstring now says the cross-process kill and the one-claim count are asserted only live.
  - `[false]` `[reject]` (intent) A throwaway ledger ref is used, not the scratch repo's `xarabot/claims`. — It is the same adapter and the same fast-forward-only ref CAS on GitHub, so the claims mechanism under test is real (Design Notes). The canary does the same.
  - `[false]` `[reject]` (intent) The scratch `main`'s Story set is overlaid in memory. — Only the inputs to `next` change. The ledger, the race and the fence are real, and no reseed or push to a protected `main` is needed (Design Notes).
  - `[false]` `[reject]` (intent) The race is forced by a barrier. — The claim under proof is that the CAS resolves same-tip contention to one winner. Without the barrier the test may never race at all.
  - `[low]` `[reject]` (intent) The overlap case exercises only "next eligible", not "or idle", and does not assert which mechanism refused the loser. — The one-unit case covers the idle branch. The AC's outcome is asserted: one `ok` swap, one `conflict`, and no record for the loser's pick.
  - `[false]` `[reject]` (intent) The "different hosts" run in one OS process. — The AC asks for different host UUIDs, which the lanes have. Separate OS processes are covered by the lock and kill cases.
  - `[false]` `[reject]` (intent) The late push is replayed through the PR step with a stubbed committer. — The fence refuses before `pushBranch`, so this is the push surface; the AC says "replayed by the test".
  - `[low]` `[patch]` (intent) The kill rehearsal does not kill. — Grouped with the docstring row.
  - `[false]` `[reject]` (intent) `bun install` runs as a runner-launched command, not inside an agent session. — It is the real sandbox and proxy with the repo's `proxy_hosts`. The same command also ran inside this real sandboxed agent session, from a clone with an empty cache, and exited 0.
  - `[false]` `[reject]` (intent) `XARABOT_LIVE_LONG` goes beyond the AC's literal `XARABOT_LIVE=1 bun test <suite>`. — The runbook's command includes the 30-minute case, as that AC asks, and the separate switch is how it "runs only when asked".
  - `[false]` `[reject]` (intent) With the scratch variables set but no App key, the live cases fail rather than skip. — The Maintainer asked for live, so failing loudly is correct. A skip would let a misconfigured evidence run look complete.
  - `[false]` `[reject]` (intent) The `bun install` case's skip is not checked. — Checked directly: `XARABOT_LIVE=1 bun test test/sandbox/bun-install.test.ts` inside this sandboxed session gives 0 pass, 1 skip, 0 fail.
  - `[low]` `[patch]` (intent) The status-file check counts only merged builder PRs. — The loop now uses `--state all` with `created:>=<start>`.
  - `[false]` `[reject]` (intent) The diff produces no live evidence itself. — The AC assigns the run to the Maintainer on the host, and builders are refused the evidence file.

## Design Notes

- **Why a fresh ledger branch per case, not the scratch repo's `xarabot/claims`?** It is the same adapter and the same fast-forward-only CAS on a real GitHub ref. A fresh branch keeps runs independent and lets cleanup delete it. The canary and the forge contract do the same.
- **Why overlay `main`?** The scratch `main` holds only the canary's Story 1.1. The overlay gives each case its Story set without a reseed and without pushing to a protected `main`. The ledger, the race and the fence are all real.
- **Why asymmetric views for the overlap race?** With one view, both lanes pick the same Story, which is the first case again. Lanes that read `main` at different moments can pick different overlapping Stories at one tip. The CAS must then refuse the second claim by its overlap check.
- **Why rehearsals?** The live suite runs only on the Maintainer's host. Running the same case functions on the fake forge in every `bun test` keeps the harness from rotting before that run.

## Verification

**Commands:**
- `bun test` -- expected: 0 fail (live cases skipped)
- `bun test test/e2e/claims-race.test.ts` -- expected: 0 fail; with `-t "^live"`, all skip
- `bun --bun tsc` -- expected: no error
- `bun --bun oxlint` -- expected: no warning or error

## Auto Run Result

Status: done

**Summary.** Story 2.12 adds the live proof that claims hold on the real GitHub ledger, plus the runbook entries for Epic 2's live evidence.
- **The claims race suite** (`test/e2e/claims-race.test.ts`) runs real `laneRun` lanes against the scratch repo. Each case uses a fresh `xarabot/test-<uuid>` ledger branch and prefixed unit branches. Sessions are holding stubs, and each lane's `main` has its Story set overlaid. Four live cases:
  - **One unit:** two hosts with different `host_id`s race for one unit at one ledger tip (forced by a swap barrier). Exactly one claim lands, and the loser idles.
  - **Overlapping globs:** two Stories with overlapping globs are raced from asymmetric views. One is claimed, and the loser takes the next eligible Story.
  - **Two processes of one lane:** one holds `lane.lock` and claims; the other exits 0 without a claim.
  - **Killed mid-unit (long-running):** a lane is killed by PID and taken over at `generation` + 1 once 30 minutes pass after its last heartbeat. Its replayed late push, through the real PR step, is refused by its fence.
- **Gating:**
  - The live cases run only with `XARABOT_LIVE=1` and the scratch variables, outside a sandboxed session.
  - The 30-minute case also needs `XARABOT_LIVE_LONG=1`.
  - Nested `bun test` checks show the live cases reported skipped, never passed.
- **Rehearsals.** Every case also runs on the fake forge in every `bun test`. The kill by PID across processes and the one-claim count across OS processes are asserted only live.
- **A live sandbox case** (`test/sandbox/bun-install.test.ts`) runs `bun install --frozen-lockfile` in a clone of this repo, in the real macOS sandbox, through the proxy, with no credential.
- **The runbook** (`docs/maintainer/self-host.md`) gains "Epic 2's live evidence (Story 2.12)":
  - the race suite's command and expected result, and the `bun install` and agent-contract smoke rows;
  - committing the results as `docs/maintainer/evidence/epic-2.md` before Epic 2's retro;
  - the after-Epic-3 acceptance check: a coordinator and 2 builders for 24 h, with no unit built twice and no builder write to the status files.

**Files changed.**
- `test/support/live.ts`: `isLiveLong` (`XARABOT_LIVE_LONG=1`).
- `test/e2e/race-harness.ts` (new):
  - the Story-set overlay, the alert recorder and the swap barrier;
  - the race hosts, the holding session and `runRaceLane`;
  - the fake and live areas, the late-push replay, and child spawn and kill by PID.
- `test/e2e/race-lane.ts` (new): the child lane process entry.
- `test/e2e/claims-race.test.ts` (new): the 4 live cases, 6 fake-forge rehearsals, 6 race-view checks and 4 nested skip checks.
- `test/sandbox/bun-install.test.ts` (new): the live `bun install` case.
- `docs/maintainer/self-host.md`:
  - the new evidence section and its cross-reference from "Several builder lanes";
  - updated `test/sandbox/` and `test/e2e/` counts.

**Review findings.** One pass, 35 findings: 0 high, 2 medium, 22 low, 11 false.
- **Patched** (13 entries):
  - the barrier's wait is now the live start window, and each first swap records `barrier` or `timeout` (medium);
  - `endWorld` awaits the killed children;
  - the live history walk throws at its cap;
  - alerts and children's output are in the diagnostics;
  - the long case timeout is 75 min, and the nested checks have a 90 s timeout;
  - the unused `heartbeatEveryMs` child field is removed;
  - the docstring no longer overclaims the rehearsals;
  - runbook fixes:
    - the setup block is labelled, with `git rev-parse HEAD`;
    - leftover branches after a timeout are named, with a list command;
    - the clone is of the committed `HEAD`;
    - the after-Epic-3 checks use the 24 h window and count PRs in every state.
- **Deferred:** none.
- **Rejected,** each with its reason in the Review Triage Log:
  - low:
    - asserting the whole ledger history;
    - extra `bun install` assertions;
    - contract-smoke counts that cannot be measured off the host;
    - computed overlap or ledger checks for the after-Epic-3 check;
    - bounding every await;
    - which mechanism refused the overlap loser;
    - keeping `RaceArea.now()`, which the spec names.
  - false:
    - the diff's scope;
    - the throwaway ledger ref;
    - the `main` overlay;
    - the forced race;
    - same-process hosts;
    - the PR-step replay;
    - `bun install` as a runner command;
    - the `XARABOT_LIVE_LONG` switch;
    - failing rather than skipping without an App key;
    - the `bun install` skip (checked directly);
    - no live evidence in the diff.

**Follow-up review recommended:** false. One medium entry was patched (2 medium findings, grouped as one root cause) and no high. Patched: 0 high, 1 medium, 12 low (entries).

**Verification.**
- `bun --bun tsc`: exit 0. `bun --bun oxlint`: exit 0.
- `bun test`: 4111 pass, 289 skip, 0 fail (in this sandboxed session).
- `bun test test/e2e/claims-race.test.ts`: 15 pass, 5 skip, 0 fail. The skips are the 4 live cases and the two-OS-process rehearsal, which needs `ps`.
- With `-t "^live"`: 0 pass, 4 skip, 0 fail.
- `XARABOT_LIVE=1 bun test test/sandbox/bun-install.test.ts` inside this sandboxed session: 0 pass, 1 skip, 0 fail.
- **Manual check:** in this sandboxed session, `bun install --frozen-lockfile` ran through the proxy in a fresh clone of this repo with an empty `BUN_INSTALL_CACHE_DIR`, and exited 0.
- **Matrix audit:** each matrix row is covered by a fake-forge rehearsal or a nested skip check that ran and passed here, with these exceptions, which run only on the host:
  - the two-OS-process lock rehearsal (it needs `ps`; the in-process lock rehearsal with a stub process table and the child kill-by-PID rehearsal ran);
  - the live cases;
  - the live `bun install` case (its behaviour was shown by the manual check above).

**Residual risks.**
- **No live case has run.** The four race cases and the `bun install` case need the Maintainer's run on the host, as the runbook says. The live-only paths are:
  - the GitHub `conflict` on a same-tip swap;
  - the history walk;
  - the live replay commit;
  - the stale wait against GitHub's clock;
  - the leftover-branch command.
- **Counts not measured on the host.** The runbook's host counts for the sandbox and e2e tables were adjusted by the cases added, not measured on the host. They should be re-measured there.
- **Not committed.** The task rules require the changes to stay in the working tree, so the stock finalize commit and the clean-tree check were not done. `epic-2-context.md` holds step-01's recompile of a stale context file, with the Maintainer-note line restored.
