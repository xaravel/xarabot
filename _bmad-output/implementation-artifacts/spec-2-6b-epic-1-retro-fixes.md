---
title: 'Story 2.6b: Epic 1 retro fixes'
type: 'bugfix'
created: '2026-10-24'
baseline_revision: 'e74438dbf8a86e914beaaf3f3881a653f34b4009'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
warnings: ['multiple-goals', 'oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Epic 1's retro left open code items. Any one of them can stop a unit or lose a deferral:
- **Model check:** a session that ran the wrong model still counts (A1, `checkModel` is never called).
- **`step_id`:** a `human-live-step` block naming a step nobody configured parks like a real one (A2).
- **Ledger swap:** a swap that landed but lost its ack at the deadline is reported as failed, and a `Halt("failed")` after a claim leaves the record `claimed` for 30 minutes (A3, C2).
- **Push lease:** a re-claim with no open PR leases as if the branch did not exist, so it conflicts on every attempt (A4).
- **Checkpoint:** `next` still carries a checkpoint unit that never runs (AR14).
- **Untested and unbounded paths:** the production `githubConnect` is never run by a test (C14), and `graph check`'s git calls have no deadline (decision 33).
- **Already fixed:** the `stop --now` dequeue fence is Story 2.1's deferral. Story 2.2 already fenced it; it is only untested at the CLI.

**Approach:** One small, separately tested fix per AC. Each fix sits in the module that owns that behaviour. The only port addition is `Forge.branchHead`, which AR1 names. The only schema addition is an optional journal field.

## Boundaries & Constraints

**Always:**
- **Model check:** wire `checkModel` from `src/adapters/agent/claude/usage.ts` into the shared session runner (`runOnce` in `src/lane/session.ts`) for every agent run, fresh and resume.
  - The configured model is `settings.model ?? agent.defaultModel`.
  - A refusal, a different model or none reported, fails the session with reason `` `model-mismatch: ${message}` ``. The attempt fails through the existing `failUnit` path (`released`, `attempts` + 1, parked at the cap).
- **`reported_model`:** the unit journal record gains an optional `reported_model` (`NonEmpty`): the last model a run reported, written whenever any run reported one. `model` stays the configured value.
- **`step_id` check:** a `build` result `blocked` with `kind: "human-live-step"` is invalid unless its `step_id` equals the `id` of a step in `.xarabot/human-live-steps.yaml`, taken from the same config the session's prompt was built from.
  - This applies to build sessions and to CI-fix sessions; both go through `sessionAt`.
  - The reason starts `result invalid: `, and the attempt fails.
- **Swap reconcile:** `swapLedger` returns `deadline` or `exhausted` only after reconciling once.
  - When the last swap attempt reported `transient` (the `unacked` state), it takes one more `forge.snapshot` under its own fresh deadline (default 10 000 ms, injectable), because the caller's signal may already be aborted.
  - If that tip shows the swap landed (the same rule as the in-loop lost-ack check), it returns `ok` with that commit.
  - Otherwise, or when the read fails, it returns the original error. There is at most one extra snapshot per call.
- **Release after `Halt("failed")`:** a run that ends in a `Halt` with outcome `failed`, other than `Abandon`, while the unit's own written record (`t.record`) is `claimed`, fails the attempt at once through `failUnit`: AD-7's crash row, `released` or parked at the cap.
  - This holds in both `runLaneProcess` and `runCoordinatorProcess`.
  - The `Halt`'s reason stays the journal reason.
- **`branchHead`:** `Forge.branchHead(branch, opts)` returns `ForgeResult<GitSha | null>`, with `null` when the branch does not exist.
  - The PR step leases from it whenever the claimed record has no PR (`record.pr === null`). With an adopted PR it keeps the record's `head_sha`.
  - The session still starts from `main` (AD-9).
- **No checkpoint unit:**
  - `CoordinatorKind` excludes `checkpoint`.
  - `CoordinatorUnitSpec`, `coordinatorGlobs` and `STEP_STORY` lose their checkpoint entries.
  - The "checkpoint arrives in 4.4" order comment and header text are removed.
  - Their test rows are dropped.
- **`graph check`'s git:** each git call passes `GIT_TERMINAL_PROMPT=0` and a deadline (`Bun.spawnSync` `timeout`, default 60 000 ms, `SIGKILL`). A call that runs past it fails `graph check` with exit 1 and a message naming the call.

**Never:**
- No ledger `schema_version` bump and no journal `schema_version` bump: the new field is optional.
- Do not remove `checkpoint` from `UNIT_KINDS`, the id grammar, `doneOnMain` (AD-9 keeps "checkpoint: the go recorded"), `retro-gates.yaml`, the graph or `go` ruling targets.
- No `timeout` binary and no `pkill`. No change to `.github/`, `AGENTS.md`, `_bmad/`, the spec folder or `stories/`.
- No change to `src/lane/stop.ts` behaviour (the fence exists): AC 6 gets a CLI-level test only.
- No `checkModel` port method, and no change to `startCheck`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Model matches | run reports the configured model | session proceeds; journal `model` = configured, `reported_model` = reported | none |
| Model differs | lane configured `claude-opus-5-5`, run reports `claude-sonnet-5-5` | run `failed`; record `released`, `attempts` + 1; journal `reported_model: "claude-sonnet-5-5"`, reason starts `model-mismatch:` and names both | none |
| No model reported | `usage.model === null` | session fails `model-mismatch`; no `reported_model` | none |
| Unknown step | blocked `human-live-step`, `step_id: "nope"`, configured `rotate-key` | run `failed`, record `released`; reason starts `result invalid:` and names `nope` | none |
| Known step | blocked `human-live-step`, `step_id: "rotate-key"` | parks `blocked` `human-live-step` as today | none |
| Lost ack at deadline | fake lands the swap and reports `transient`, signal aborted | `swapLedger` → `ok`, commit = ours | none |
| Lost ack, last try | same, `maxTries: 1` | `ok` | none |
| Transient, not landed | `injectError("ledgerSwap", transient)`, `maxTries: 1` | `exhausted`, exactly one extra snapshot | none |
| `Halt("failed")` after claim | claim lands, then `markMerged` swap fails `not-found` | record `released`, `attempts` + 1, outcome `failed`, reason `markMerged: …` | failAttempt fails → state as `failUnit` leaves it |
| Re-claim, stale branch | `story/1.6` at `S` with a closed PR; record `released` | push lease `expected_sha: S`; PR opened; no conflict | `branchHead` error → attempt fails `branchHead <kind>: …` |
| `branchHead` absent / present | contract: unknown branch / after `pushBranch` | `null` / the pushed SHA; aborted call → `transient` | none |
| `graph check` slow git | a `git` that sleeps past a 200 ms test deadline | exit 1, stderr names `git rev-parse` and the deadline | none |
| `graph check` prompt env | a `git` wrapper that exits 3 unless `GIT_TERMINAL_PROMPT=0` | exit 0 on this repo's fixture | none |

</intent-contract>

## Code Map

The baseline is `e74438d`.

- `src/adapters/agent/claude/usage.ts:137` -- `checkModel(usage, configured): Result<string, "model-mismatch">`, used as it is. The lane may import adapters (AR1 table, `test/support/boundaries.ts:23`).
- `src/lane/session.ts`:
  - `UnitTrack` (l.452) and `newTrack` (l.467) gain `reportedModel: string | null`.
  - `runOnce` (l.764–800) reads `usage.model` after `parseUsage` (l.779). Add the check after the cost totals and `checkHeld` (l.798), returning `{ fail }` as l.767 does.
  - `JournalEntry` (l.563) gains `reportedModel?`; `journalUnit` (l.581) writes `reported_model` when it is non-null.
  - The outer catches use `trackOps().failUnit` (l.540).
- `src/core/schemas/journal.ts:33` -- `reported_model: NonEmpty.optional()`; update the header doc (l.7–12).
- `src/lane/lane-process.ts`:
  - `builderPrompt` (l.354): keep the prompted step ids, `repo.value.repo.humanLiveSteps.steps`, in a closure variable.
  - `sessionAt` (l.402): after `ran.ok`, call the new pure check before the spec pick.
  - Final `journal(...)` (l.884) passes `reportedModel`.
  - Outer catch (l.846–874): the `Halt("failed")` release.
  - The only after-claim `Halt("failed")` is `markedMerged` (l.730).
- `src/lane/coordinator-process.ts`:
  - Outer catch (l.366–396): the same release. `checkClaim` (l.229) is the after-claim `Halt`.
  - `STEP_STORY` (l.83): drop `checkpoint`.
- `src/core/lane/build-check.ts` -- add a pure `checkHumanLiveStep(result: BuildResult, stepIds: readonly string[]): Result<void, "invalid">`, next to `pickSpec` and `checkBuildSpec`.
- `src/lane/ledger-cas.ts:112–176`:
  - Factor out the lost-ack test (l.138).
  - Every `deadline` and `exhausted` return (l.129, 160, 161, 174) goes through one `reconcileOnce` that runs when `unacked !== null`.
  - Add `reconcileMs?` to `SwapLedgerParams` (l.43).
- `src/adapters/forge/fake/fake-forge.ts`:
  - `branchHead`: abort-checked through `call`, read from `branches` (l.149).
  - A new `FakeForgeControl.loseSwapAck()`: the next `ledgerSwap` that lands returns `transient` "ack lost" (l.247–254).
- `src/ports/forge.ts:165–220` -- `branchHead` in `Forge`, `FORGE_OPERATIONS` (sorted), and the doc.
- `src/adapters/forge/github/github-forge.ts` -- `branchHead` through `guarded` and the private `readRef` (l.285). A `not-found` result becomes `ok(null)`.
- `src/lane/pr-step.ts:214–216` -- `record.pr === null`: `call("branchHead", …)`. Failure goes to `failed(\`branchHead ${kind}: ${message}\`)`; otherwise the lease's `expected_sha` is that head.
- Operation lists that must gain `branchHead`:
  - `test/ports/forge.test.ts:47,66`
  - `test/contracts/forge.contract.ts:287–303`
  - `test/adapters/forge/github/github-forge.test.ts:~335`
  - `test/adapters/forge/fake-forge.test.ts:20`
  - `test/support/live-github.ts:54–59` (`prefixed` rewrites the branch)
  - the canary's `prefixed`, if it lists ops
- `test/contracts/forge.contract.ts` -- `scenario("branchHead …", ["branchHead","pushBranch"], …)` cases: absent → `null`; after a push → the SHA.
- `src/core/next/coordinator.ts`:
  - l.11–17 (doc) and l.26 (`Exclude<UnitKind, "story" | "checkpoint">`).
  - l.32, l.53–57 (doc) and l.71–72.
  - l.284–308: skip `checkpoint` records like `story`, so `CoordinatorUnit.kind` stays typed.
  - l.310 (comment).
  - Keep `doneOnMain` l.187.
- `src/cli/lane-run.ts:293` -- comment drops checkpoint.
- Tests dropping checkpoint rows:
  - `test/core/next/coordinator.test.ts:290` (globs row). The `doneOnMain` rows l.356–357 stay.
  - `test/core/lane/write-check.test.ts:502` (checkpoint coordinator row).
- `src/cli/lane-connection.ts:40` -- `githubConnect(env, net?: { fetch?, apiUrl?, gitUrl? })`, passed to `createGitHubForge`, `createTokenSource`, `createGitHubFetch` and `fetchBotUserId`. Production callers stay unchanged.
- `test/cli/lane-connection.test.ts` (new):
  - Credentials go in `$XDG_CONFIG_HOME/xarabot/apps/alice-xarabot/` (`credentials.ts:37,56`), with `testKeys()`, `createFakeGitHub` and `startGitServer`, as `push.test.ts:31–58` does.
  - `hostTest`, since it binds a socket.
  - It asserts that `forge({maintainer}).alert` posts and that `forge({runnerGit}).pushBranch` lands.
- `test/cli/lane-commands.test.ts:147` -- add a `stop --now` case on a `merging` record with a queued PR. It asserts a `heartbeat` ledger commit before the `release`, and the PR dequeued.
- `src/cli/graph-check.ts:10–17` -- `git()` gets `env: { ...env, GIT_TERMINAL_PROMPT: "0" }`, `timeout` and `killSignal`. `graphCheck(cwd, opts?: { gitTimeoutMs?, env? })`. `exitedDueToTimeout` gives "ran past N ms".
- `test/cli/graph-check.test.ts` -- in-process `graphCheck` with a stub `git` dir first on `PATH`, for the two rows.
- `test/lane/lane-process.test.ts`:
  - The `parseUsage` fake (l.204) reports `o.reportedModel ?? "claude-opus-5-5"`.
  - Retarget l.892–896 to "journal `model` is the lane's; `reported_model` is the session's".
  - Add the mismatch, unknown-step, `Halt` release and stale-branch re-claim cases.
- Other inline agent fakes whose runs go through `runOnce` report the configured model:
  - `test/lane/session.test.ts:361`
  - `pr-step.test.ts:826`, `ci-step.test.ts:687` and `merge-step.test.ts:657`, where they run sessions
- `docs/maintainer/self-host.md:529` -- the delete-the-branch note applies only until the runner includes Story 2.6b.

## Tasks & Acceptance

**Execution:**
- `src/core/schemas/journal.ts`, `src/lane/session.ts`, `src/lane/lane-process.ts` -- model check, `reported_model`, `step_id` check, `Halt` release -- AC 1, 3 and 4b.
- `src/core/lane/build-check.ts` -- `checkHumanLiveStep` -- AC 3.
- `src/lane/coordinator-process.ts`, `src/core/next/coordinator.ts`, `src/cli/lane-run.ts` -- checkpoint removal and the coordinator `Halt` release -- AC 2 and 4b.
- `src/lane/ledger-cas.ts`, `src/adapters/forge/fake/fake-forge.ts` -- reconcile-once and `loseSwapAck` -- AC 4.
- `src/ports/forge.ts`, `src/adapters/forge/github/github-forge.ts`, the fake forge, `src/lane/pr-step.ts` -- `branchHead` and the lease -- AC 5.
- `src/cli/lane-connection.ts` -- network injection -- AC 7.
- `src/cli/graph-check.ts` -- deadline and env -- AC 8.
- Tests: every matrix row, plus `test/core/lane/build-check.test.ts`, `test/lane/ledger-cas.test.ts`, the contract cases, the new connection test and the CLI `stop --now` case -- AC 1–8.
- `docs/maintainer/self-host.md` -- the branch note.

**Acceptance Criteria:**
- Given a lane-process run whose session reports a model other than the lane's, when the run ends, then the attempt failed and the journal line has the reported model.
- Given the coordinator `next` and globs, when the Story is done, then no checkpoint position, globs or rows remain, and `checkpoint:<epic>` still parses as a unit id and a `go` target.
- Given `xarabot stop --now` on a `merging` unit, when it dequeues, then a fencing heartbeat commit precedes the dequeue.
- Given the production `githubConnect` against the fake GitHub and git server, when a test alerts and pushes, then both go through.
- Given `bun --bun oxlint` and `bun --bun tsc`, when they run, then both exit 0, and `bun test` gives 0 fail.

## Spec Change Log

## Review Triage Log

### 2026-10-24 — Review pass
- verdicts: 36 findings — high 0, medium 4, low 24, false 8, maybe-false 0
- findings:
  - `[low]` `[patch]` (verification-gap 1) No coordinator test covers a failed-`Halt` release whose `failAttempt` then fails (pre-verified). — A new coordinator test mirrors lane-process's "failAttempt fails too": the record stays `claimed`, the journal `state` is `null`, and the reason names both.
  - `[medium]` `[patch]` (verification-gap other) `runOnce` checks the model before `after()` weighs the budget, the result, the session limit and the usage limit, so a run with no init line gets `model-mismatch` instead of its real reason. — Confirmed at `session.ts` `runOnce`/`after`. A reported model that differs still fails at once. A missing model now fails in `after()`, only after the budget, session-limit and usage-limit outcomes, and new session-runner rows cover it.
  - `[medium]` `[patch]` (intent 1) The model check is broader than the AC (shared runner, a `null` model fails), and it runs before the run's end decisions. — The ordering is the same root cause as verification-gap other, and was patched there. A `null` model failing is `checkModel`'s own Story 1.14 contract. The shared runner is where every session's usage is read.
  - `[false]` `[reject]` (intent 2) The `step_id` check lives in the lane, not in the result schema. — The schema cannot see `.xarabot/human-live-steps.yaml`. The lane check makes the result invalid, a failed attempt as AD-7's invalid-result row says, which is the AC's outcome.
  - `[low]` `[reject]` (intent 3) No lane-process test drives `loseSwapAck`. — The AC's surface is `swapLedger` with a fake-forge mode, and seven `swapLedger` cases cover it. At lane level a lost ack mid-loop already resolved before this Story. A lane test would add little.
  - `[false]` `[reject]` (intent 4) The `Halt` release is `failAttempt`, not a bare `release`. — The record does become `released` (or parks at the cap), as AD-7's crash row requires. Design Notes record why.
  - `[false]` `[reject]` (intent 5) `branchHead` is read at push time, not claim time. — The lease is taken at the push. The record's `head_sha` doubles as the session start, which AD-9 says is `main` with no open PR (Design Notes).
  - `[false]` `[reject]` (intent 6) AC 6 has no code change. — `releaseHeld` already fences before the dequeue (Story 2.2). The new CLI test shows a heartbeat commit before the dequeue and the release after it.
  - `[low]` `[reject]` (intent 7) `githubConnect` gained a parameter, and its push case skips in the sandbox. — Production callers pass nothing. The push case is a `hostTest` because it binds a socket, and the sandbox refuses that. It needs a host run, listed under residual risks.
  - `[low]` `[reject]` (intent 8) The `graph check` git tests call `graphCheck` in process, not the CLI. — The CLI's dispatch to `graphCheck` is covered by the existing spawned-CLI tests. In-process is how the stub `PATH` and the deadline get injected.
  - `[false]` `[reject]` (intent 9) `epic-2-context.md` changed outside the diff and the globs. — It is the workflow's epic-context recompile (planning artifacts newer than the cache), not Story code. The runner reverts a builder's change to it.
  - `[medium]` `[patch]` (blind 1) The model check runs before the run's real end reason is decided. — Same root cause as verification-gap other. Patched there.
  - `[low]` `[reject]` (blind 2) The shared runner reports every adapter's mismatch with Claude's `claude:` prefix. — Only the Claude adapter exists until Epic 3, and the AC names `checkModel` in `claude/usage.ts`. Moving it is more than a direct fix for a case no lane meets today.
  - `[low]` `[patch]` (blind 3) The `branchHead` read sits between the fence and the push. — The read now runs before `beat("fence")`.
  - `[low]` `[reject]` (blind 4) Leasing from the real head overwrites commits on a Story branch with no PR. — AC 5 requires it ("takes the lease from the branch's real head"), and AD-9 starts such a claim from `main`. The runbook now warns about it (blind 5).
  - `[low]` `[patch]` (blind 5) The runbook doesn't warn about that overwrite. — `self-host.md` now says the next claim replaces any commits on a Story branch with no open PR.
  - `[low]` `[patch]` (blind 6) No operator docs for the new failure modes. — `self-host.md` §8 now says that with `steps: []`, or with an unlisted `step_id`, a `human-live-step` block is an invalid result. The runbook documents neither the lane `model` field nor the journal fields, so it gets no model note.
  - `[low]` `[patch]` (blind 7) The release code is copied, and its guards differ (`t.record?.state` against `t.state`). — The named harm is the diverging guard (edge 3, edge 4). Both new branches now require `t.state === "claimed"` as well.
  - `[low]` `[reject]` (blind 8) The inner catch drops non-`Halt` throws silently. — The same pattern was copied from the existing unexpected-error branch, and the forge port never throws by contract. A fix adds a branch for a case no one meets.
  - `[low]` `[patch]` (blind 9) `failUnit(t, e.reason)` erases reasons gathered before the `Halt`. — The new branches now pass the accumulated `t.reason`.
  - `[low]` `[reject]` (blind 10) The lost-ack recovery misses a landed swap that a foreign write then covered. — This is the existing in-loop lost-ack rule (whole-file equality), reused. It needs a lost ack and a foreign write in the same window. A fix needs per-edit knowledge `swapLedger` does not have.
  - `[low]` `[reject]` (blind 11) The fake and GitHub `branchHead` differ for `main` and `xarabot/claims`. — No caller reads those branches. Only Story branches are leased.
  - `[low]` `[patch]` (blind 12) The `GIT_TERMINAL_PROMPT=0` test depends on the live repo's graph. — It now runs on a fixture.
  - `[low]` `[patch]` (blind 13) The connection test never exercises the `net` injection into `fetchBotUserId`. — The alert test now also reads `botUserId` through the fake GitHub. `fetchShas` needs the git server (socket), as the push case does.
  - `[low]` `[patch]` (blind 14) Only the coordinator release's success case is tested. — Same root cause as verification-gap 1. Patched there.
  - `[false]` `[reject]` (blind 15) Two changed files are missing from the review diff. — The spec is the claims file, handed to the edge-case layer on purpose. `epic-2-context.md` is the workflow recompile (intent 9).
  - `[medium]` `[patch]` (edge 1) A run with no init line fails `model-mismatch`, masking budget, session-limit and usage-limit reasons. — Same root cause as verification-gap other. Patched there.
  - `[low]` `[reject]` (edge 2) A Claude-only rule and message apply to every adapter. — Same as blind 2.
  - `[low]` `[patch]` (edge 3) The lane-process release gates on a possibly stale `t.record` rather than `t.state`. — Both conditions are now required.
  - `[low]` `[patch]` (edge 4) The coordinator release could `failAttempt` a record whose `merging` write landed unseen. — Same root cause as edge 3. Patched there.
  - `[low]` `[reject]` (edge 5) A `markMerged` that comes back `lost` now also tries `failAttempt`, which adds noise. — `markMerged` is idempotent, so `lost` needs the record to have moved to a state it refuses, which is rare. The added reason is accurate, and handling `lost` separately is new branching.
  - `[low]` `[patch]` (edge 6) `failUnit` drops earlier reasons. — Same root cause as blind 9. Patched there.
  - `[low]` `[reject]` (edge 7) The journal's `result` shows `blocked` for an attempt that failed `result invalid`. — This matches the other invalid-result paths (the spec pick and the status cross-check), where `result` is what the agent returned and `reason` says why it failed.
  - `[low]` `[reject]` (edge 8) A landed swap covered by a foreign write is reported failed. — Same as blind 10.
  - `[false]` `[reject]` (edge 9) A NaN or negative `reconcileMs` silently skips the reconcile. — No production caller passes `reconcileMs`; it exists for tests, and the default is 10 000.
  - `[false]` `[reject]` (edge 10) `doneOnMain` still has a `checkpoint` case. — AD-9 keeps "checkpoint: the go recorded" as done-on-`main`. The spec keeps it on purpose, and it is not the `next` position or a glob.

## Design Notes

- **Lease at push, not at claim.** The record's `head_sha` is also the session start and means "the PR's head" (AD-9). Storing a stale branch head there would start the session from the stale branch. Instead, the PR step reads `branchHead` right before the first push of a claim that has no PR, which is the moment the lease is taken.
- **Release = failAttempt.** AD-7 makes every failed attempt `released` with `attempts` + 1, which is also what Story 2.2's takeover would have done. A plain `release` would let a recurring `Halt` loop with no cap.
- **Reconcile under a fresh deadline**, since at `deadline` the caller's signal is already aborted:
  ```ts
  const fail = async (e: SwapLedgerError) => unacked === null ? err(e) : (await landedNow(unacked)) ?? err(e);
  ```

## Verification

**Commands:**
- `bun test` -- expected: 0 fail (sandboxed: socket cases skip)
- `bun test test/lane test/cli test/core test/contracts test/adapters` -- expected: 0 fail
- `grep -rn 'checkModel(' src` -- expected: a call in `src/lane/session.ts`
- `grep -n 'checkpoint' src/core/next/coordinator.ts` -- expected: only the header doc, the `CoordinatorKind` exclusion and the `doneOnMain` case and its doc
- `bun --bun oxlint` -- expected: exit 0
- `bun --bun tsc` -- expected: exit 0

## Auto Run Result

Status: done

**Summary.** The open code items from Epic 1's retro are fixed:
- **Model check (AC 1):** the shared session runner calls `checkModel` on every run. A run whose reported model differs from the configured one fails the attempt at once (`model-mismatch: …`). A run that reported no model fails the same way, but only after the budget, session-limit and usage-limit outcomes have had their say. The journal records the reported model as the new optional `reported_model`.
- **Checkpoint (AC 2):** the coordinator's checkpoint kind, globs, `STEP_STORY` entry and order comment are gone, along with their case rows. `checkpoint:<epic>` still parses as a unit id and stays done-on-`main` per AD-9.
- **`step_id` (AC 3):** a `human-live-step` block whose `step_id` is not configured is an invalid result, a failed attempt, in build and CI-fix sessions alike.
- **Ledger swap (AC 4):** `swapLedger` reconciles an unacked swap once, under its own deadline, before it returns `deadline` or `exhausted`. The fake forge's new `loseSwapAck()` tests this.
- **Release (AC 4):** a failed `Halt` after a claim fails the attempt at once, in the lane and the coordinator, keeping the run's reasons.
- **`branchHead` (AC 5):** `Forge.branchHead` is on the port, the GitHub adapter and the fake, with contract cases. The PR step reads it before the fence when the record has no PR, and leases from the branch's real head.
- **`stop --now` (AC 6):** the dequeue fence already existed (Story 2.2). A CLI test now shows the heartbeat commit comes before the dequeue.
- **`githubConnect` (AC 7):** it takes optional network endpoints. A test drives it against the fake GitHub: the alert, the token and the bot user id go through, and a host-only test pushes through a git server.
- **`graph check` (AC 8):** each git call runs with `GIT_TERMINAL_PROMPT=0` and a 60 s deadline (killed with `SIGKILL`).

**Files changed:**
- `src/lane/session.ts`: the model check, `noModel` ordering in `after()`, and the track's and journal's `reportedModel`.
- `src/core/schemas/journal.ts`: the optional `reported_model`.
- `src/lane/lane-process.ts`: the step-id check against the prompted steps, and the failed-`Halt` release.
- `src/lane/coordinator-process.ts`: the failed-`Halt` release, and no checkpoint `STEP_STORY`.
- `src/core/lane/build-check.ts`: the pure `checkHumanLiveStep`.
- `src/core/next/coordinator.ts`: no checkpoint kind or globs, and `isCoordinatorKind`.
- `src/cli/lane-run.ts`: a comment.
- `src/lane/ledger-cas.ts`: the reconcile-once `giveUp`, and `reconcileMs`.
- `src/ports/forge.ts`, `src/adapters/forge/github/github-forge.ts`, `src/adapters/forge/fake/fake-forge.ts`: `branchHead`, and the fake's `loseSwapAck`.
- `src/lane/pr-step.ts`: the branch-head lease, read before the fence.
- `src/cli/lane-connection.ts`: `githubConnect(env, net?)`.
- `src/cli/graph-check.ts`: the git deadline and env.
- `docs/maintainer/self-host.md`: the branch note, its overwrite warning, and the `steps: []` consequence.
- Tests:
  - New cases in `lane-process`, `session`, `ledger-cas`, `pr-step`, `coordinator-process`, `build-check`, `coordinator`, `journal`, `fake-forge`, `github-forge`, the forge contract, `graph-check` and `lane-commands`.
  - A new `test/cli/lane-connection.test.ts`.
  - The agent fakes now report the configured model.
  - Two pr-step lease-conflict tests no longer assume the old bug.
- `_bmad-output/implementation-artifacts/epic-2-context.md`: recompiled for the 2026-10-25 Story 2.6 decisions (workflow step 1).

**Review findings:** 36 findings. By verdict: high 0, medium 4, low 24, false 8.
- **Patched, 9 entries:**
  - medium: model-check ordering (verification-gap other, intent 1, blind 1, edge 1).
  - low:
    - the coordinator release test (verification-gap 1, blind 14);
    - `branchHead` before the fence (blind 3);
    - the overwrite warning in the runbook (blind 5);
    - the `steps: []` doc (blind 6);
    - the release guard on `t.state` (blind 7, edge 3, edge 4);
    - kept reasons (blind 9, edge 6);
    - the fixture-based git env test (blind 12);
    - `botUserId` through the injected fetch (blind 13).
- **Deferred:** none.
- **Rejected, with the reasons recorded in the Review Triage Log:**
  - `step_id` in the lane, not the schema (intent 2, false);
  - no lane-level lost-ack test (intent 3);
  - release as failAttempt (intent 4, false);
  - lease at push (intent 5, false);
  - AC 6 has no code (intent 6, false);
  - the sandbox-skipped push case (intent 7);
  - `graph check` tested in process (intent 8);
  - the epic-context recompile (intent 9, blind 15, both false);
  - the `claude:` prefix for every adapter (blind 2, edge 2);
  - overwriting a stale branch, which AC 5 requires (blind 4);
  - non-`Halt` throws in the inner catch (blind 8);
  - a landed swap covered by a foreign write (blind 10, edge 8);
  - fake versus GitHub `branchHead` on `main` (blind 11);
  - `markMerged` coming back `lost` (edge 5);
  - the journal `result` on an invalid result (edge 7);
  - `reconcileMs` validation (edge 9, false);
  - `doneOnMain` still handling `checkpoint` (edge 10, false).

**Follow-up review recommended:** false. Patched entries by verdict: high 0, medium 1, low 8.

**Verification:**
- `bun test` (`XARABOT_SANDBOXED=1`): 3413 pass, 277 skip, 0 fail. The baseline before the change was 3360 pass, 269 skip, 0 fail.
- `bun --bun tsc`: exit 0.
- `bun --bun oxlint`: exit 0.
- `grep -rn 'checkModel(' src`: a call in `src/lane/session.ts`.
- `grep -n checkpoint src/core/next/coordinator.ts`: only the header doc, the `CoordinatorKind` exclusion and `doneOnMain`.
- Matrix audit: every I/O row has a covering test that ran and passed, checked in the JUnit report. The GitHub-emulator contract cases and the `githubConnect` push case skip in the sandbox, because they bind a socket. Each matrix row is also covered by a case that ran.

**Not committed:** the run's instructions say to leave the changes in the clone's working tree for the runner, so the finalize commit was skipped and the tree is intentionally dirty.

**Residual risks:**
- `githubConnect`'s push and the GitHub-emulator `branchHead` contract cases have not run here: the sandbox refuses to bind a socket. They need a host run of `bun test test/cli/lane-connection.test.ts test/contracts/forge.github.contract.test.ts`.
- The model check needs the Claude CLI to report the configured model id exactly, as the agent contract test expects. A lane that sets a model alias would fail every attempt with `model-mismatch`.
- A swap that landed and was then covered by a foreign write is still reported failed (the whole-file lost-ack rule).
- Leasing from a branch's real head replaces any commits left on a Story branch with no open PR; the runbook now says so.
