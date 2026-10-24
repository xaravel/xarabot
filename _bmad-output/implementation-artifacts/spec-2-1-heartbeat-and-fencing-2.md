---
title: 'Story 2.1: Heartbeat and fencing'
type: 'feature'
created: '2026-10-23'
baseline_revision: '01381c31ac17a4b0b9969d0360b00d38bd117401'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      The dequeue in `stop --now` runs with no fencing heartbeat, so it could dequeue a PR that another lane took over.
    evidence: |-
      src/lane/stop.ts calls forge.dequeue with no generation-checked swap first. It predates Story 2.1 and is the Maintainer's command path, not a lane step; Story 2.2's takeover makes the race reachable.
    location: >-
      src/lane/stop.ts:97
    severity: low
---

<intent-contract>

## Intent

**Problem:** A lane heartbeats its claim only in usage-limit sleeps and inside the merge-queue watch. During a session of up to 3 h, a CI poll of up to 60 min, or the trailing wait, `heartbeat_at` goes stale (retro C1). Fences run before pushes, but not before every PR change: `openPr`/`updatePr` after the push and `dequeue`. So once Story 2.2's takeover lands, a quiet lane could act over the new holder (FR3, AR7, AR33).

**Approach:** Run one heartbeat keeper per claimed unit. It swaps `heartbeat_at` every 5 minutes, from the claim until the process ends, so it covers the session, CI, the queue watch and the trailing wait. A lost record kills the agent session by PID, and the lane abandons the unit. When back-off would let the heartbeat lapse past 30 minutes, the keeper releases the unit. Each step also runs a fencing heartbeat right before every push, PR change and enqueue, and right before a dequeue.

## Boundaries & Constraints

**Always:**
- Heartbeats and fences go through `swapLedger`, using the `heartbeat` edit, or the new `keepAlive` edit for the keeper. Both require the lane's own `owner/host/lane` and `generation` (AD-6).
- `heartbeat_at` is forge time. The keeper stamps the last forge `now` the lane saw, advanced by the host time since (the steps' existing `forgeNow` rule). The keeper makes no extra snapshot for the time.
- A lost unit means no further ledger edit and no further forge write by this lane for that unit. The agent is killed only through the sandbox's abort, which sends SIGTERM to the exact PID. Never `pkill`, never a `timeout` binary.
- When the keeper finds the record still held by this lane at its generation but no longer `claimed`/`merging` (parked, released, merged by the lane's own steps), it stops quietly, with no abort and no write.
- Keep the merge-step's in-loop queue heartbeat. It also fences the watch.
- Core code stays pure: no clock, no I/O. The lapse decision is a pure function in `src/core/lane/`, tested by case table.

**Never:**
- No per-run nonce or PID lock for two processes of the same lane (retro C10, item 10). That is still an open Maintainer decision, and this Story's ACs don't include it.
- No stale takeover by this lane (Story 2.2), no coordinator heartbeat (Story 2.4), and no ledger schema change.
- Don't do the runLaneProcess helper split (retro item 11). Add the keeper as its own module, and change the existing steps only where fencing needs it.
- No change to `.github/`, `AGENTS.md`, `_bmad/`, the specs folder or the skills.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Beat | record `claimed` or `merging`, held at gen G | every `everyMs` (default 5 min) a `keepAlive` commit stamps `heartbeat_at` | none |
| Moved on | the lane's own step parked, released or merged the record | `keepAlive` returns no commit; the keeper stops, no abort | none |
| Lost | another lane wrote the record at gen G+1, or another holder, or no record | keeper aborts its signal with `lost`; the running agent is killed; lane ends `failed`, `state` null, reason names the unit lost; no further edits | logged |
| Transient | swap fails `exhausted`/`deadline` on `transient`/`rate-limited` | retry after `HEARTBEAT_RETRY_MS` (60 s), or `retry_after` when it is longer | logged |
| Would lapse | now + retry delay + call deadline ≥ last good beat + 30 min | `release` edit (no attempt counted), keeper aborts with `released`; lane ends `failed`, state `released` | if the release fails, abort with `lapsed`, state null |
| Fence lost before push/PR change/enqueue/dequeue | gen bumped before the fence | step ends `failed`, state null; the push/openPr/updatePr/enqueue/dequeue never reaches the forge | none |

</intent-contract>

## Code Map

This run resumes `spec-2-1-heartbeat-and-fencing.md` (status `blocked`: its session could not install dependencies). Its whole implementation is committed at `edeef2ebd55cf62006837df2f292171a40346221` on top of the baseline. The intent contract above is that spec's, verbatim. Read the story's diff with `git diff 01381c31ac17a4b0b9969d0360b00d38bd117401 HEAD`.

- `src/core/ledger/edits.ts` -- `keepAlive(p: HeldParams)` (after `heartbeat`): held + other state → `ok(null)`, any other mismatch → precondition. Done.
- `src/core/lane/heartbeat.ts` -- `HEARTBEAT_MS`, `HEARTBEAT_RETRY_MS`, `wouldLapse`, `heartbeatRetryMs`. Done. `USAGE_LIMIT_TICK_MS` was removed from `src/core/lane/waits.ts`.
- `src/lane/heartbeat.ts` -- the `startHeartbeat` keeper: `KeeperEnd` kinds `lost`/`released`/`lapsed`/`moved-on`; a `sleep` loop on its own `stopping` signal; `releaseUnit` on lapse. It imports `DEFAULT_CALL_TIMEOUT_MS` and `writtenRecord` from `./lane-process.ts`, which makes a cycle. Both are used only at call time, the same pattern `pr-step.ts`, `ci-step.ts` and `merge-step.ts` already use.
- `src/lane/lane-process.ts` -- `estimatedNow`, `keeper`, `keeperSignals()`, and `checkHeld()`, which throws `Abandon` (a `Halt`). The keeper starts after the claim (~line 1026), is joined into `sandboxed()` and `usageLimitSleep`, and stops in the `finally` after the trailing wait.
- `src/lane/pr-step.ts` -- `beat("fence")` before `openPr`/`updatePr` (~line 248).
- `src/lane/merge-step.ts` -- a fence on enqueue retries (`n > 0`); a direct-`swap` fence in `leaveMerging()`.
- `test/lane/heartbeat.test.ts` -- the `world()` harness. The keeper starts inside `world()`; its first loop sleep yields one `setTimeout(0)` tick, then runs `onLoopSleep`. The `lost to %s` table (~line 191) reads `before = await w.record()` after `world()` returns. The fake's snapshot takes longer than that tick, so `before` sometimes sees the foreign write (generation 2, or no record). That race in the test, not in the keeper, explains the 3 known failures.
- `test/lane/lane-process.test.ts`, `test/lane/pr-step.test.ts`, `test/lane/merge-step.test.ts`, `test/lane/ci-step.test.ts`, `test/core/ledger/edits.test.ts`, `test/core/lane/heartbeat.test.ts` -- the AC cases. Done, and they pass.
- Sandbox: this session cannot listen on loopback or inspect processes. 73 tests also fail at the baseline (`Failed to start server`, and the `ps`/`kill` suites: the GitHub emulator contract, `pushBranch`, `installRunner`, `killRecorded`, `wakeLane`, `stopNow` and others).

## Tasks & Acceptance

**Execution:**
- `test/lane/heartbeat.test.ts` -- in the `lost to %s` table, capture the before-record inside `onLoopSleep` (i 0), before the foreign write, and assert it equals `rec()`. Do the same anywhere else a read races the keeper's first sleep. -- Removes the race; the keeper's behaviour is unchanged.
- Any source file that the review or the full run shows is wrong -- fix it within the intent contract. -- The blocked session's code has not been reviewed yet.

**Acceptance Criteria:**
- Given a lane holding a `claimed` record whose stub session runs until aborted, when the keeper's interval passes several times, then the fake's ledger log shows `keepAlive` heartbeat commits during the session, and also during the trailing wait while the step left the record `claimed` or `merging`.
- Given a session running, when another lane writes the record at `generation` + 1, then the next heartbeat fails, and the sandbox's signal is aborted (the agent is killed by PID). The PR step is never called, nothing is pushed, BOB's record is left as it was, and the journal records `failed`, `state` null and a "lost" reason.
- Given heartbeat swaps failing `transient` or `rate-limited` with the host clock advancing, when the next retry would land past 30 minutes since the last good beat, then the unit is `released` with `attempts` unchanged and the lane ends `failed`.
- Given the PR step, CI step or merge step against the fake forge, when another lane takes the record at `generation` + 1 before a fence, then that fence fails, and no push (branch unchanged), no `openPr`/`updatePr`, no enqueue (`queue()` empty) and no dequeue (a queued PR stays queued) from it reaches the fake.
- Given `test/lane/heartbeat.test.ts`, when it runs 20 times in a row, then every run passes.

## Spec Change Log

## Review Triage Log

### 2026-10-24 — Review pass
- verdicts: 42 findings — high 0, medium 5, low 27, false 9, maybe-false 1
- findings:
  - `[medium]` `[patch]` (verification-gap) The lane's handling of a `lapsed` keeper end has no `runLaneProcess` test. — Pre-verified gap. Added a lane-level test that fails both keepAlive and release swaps until the lapse: failed, state null, one run, no PR step, record unchanged.
  - `[medium]` `[patch]` (verification-gap) Abandoning the unit at a step boundary (`checkHeld` in `settle` and before the PR step) has no test. — Pre-verified gap. Added a lane-level test: a stub `ciStep` loses the unit to generation + 1 and returns `progress`/`claimed`; `mergeStep` is never called; journal failed, state null, reason "lost".
  - `[low]` `[patch]` (verification-gap) No test tells forge-time stamps from host time. — Pre-verified gap. In the keeper tests, `forgeNow` is now offset from the host clock and the stamps are asserted; there is one lane-level `heartbeat_at` assertion against the forge `now`.
  - `[low]` `[reject]` (verification-gap, other) A `lapsed` end inside a CI-fix session: `ci-step` catches `Abandon` and its `failAttempt` lands. — Real: the record is still held at G after a failed release. It needs a lapse inside a CI session plus a forge that recovers within one call. Fixing it means teaching `ci-step` about `Abandon`, a new branch in a module the spec keeps unchanged.
  - `[false]` `[reject]` (intent-alignment a) "Kills by PID … and exits" is checked only at the stub sandbox, and the lane still runs its trailing wait. — The keeper's signal is joined into the existing sandbox abort, which sends SIGTERM to the exact PID (already tested in the sandbox suite). The trailing wait after `failed` is the lane's specified exit path (Story 1.18).
  - `[low]` `[reject]` (intent-alignment b) The keeper's signal is not passed to the PR, CI and merge steps, so a loss during a CI poll is noticed only at the next fence or step boundary. — For `lost` and `released`, every step write is fenced, so nothing lands; the cost is read-only polling until the boundary. Joining the signal would turn a loss into "budget passed" handling in each step, which is not a direct fix.
  - `[false]` `[reject]` (intent-alignment c) Only a lost fence abandons the unit; other fence failures take the step's `failed()` path. — On any fence failure the step pushes nothing and ends `failed`, which is abandoning the unit as AC2 asks. The `failed()` path releases the unit with an attempt, as before this Story.
  - `[low]` `[defer]` (intent-alignment d) The dequeue in `src/lane/stop.ts` (`stop --now`) is not fenced. — It predates this Story and runs from the Maintainer's command, not from a lane step. Deferred.
  - `[false]` `[reject]` (intent-alignment e1) Only the keeper applies the lapse rule, and it ignores the stamps the steps make. — Ignoring the steps' stamps can only make the keeper release earlier, never later. Step fences back off inside their own deadlines and then end the step.
  - `[false]` `[reject]` (intent-alignment e2) The keeper releases at about 28 min, not "past 30". — AC3 asks for a release instead of a lapse, so releasing before the 30-min lapse is the requirement itself.
  - `[false]` `[reject]` (intent-alignment e3) The lapse release counts no attempt. — The AC leaves this open, and the Design Notes settle it from AD-2 and AD-7; it is not a defect.
  - `[low]` `[reject]` (intent-alignment e4) A lapse release of a `merging` record does not dequeue (AR8). — Real, and listed as an accepted limit. It needs about 28 min of failing beats while `merging`, with the merge-step's own queue heartbeats failing over the same span; the sweep marks the unit merged if the queue merges it. A dequeue inside the keeper would be new forge surface.
  - `[low]` `[reject]` (intent-alignment e5) The keeper retries `auth`, `forbidden`, `uninstalled` and edit-stop failures instead of stopping. — The spec says so; the next forge call by a step or the next lane process raises the alert. The cost is a delayed alert and a "lapsed" reason during a broken-token outage. A new keeper end kind and alert path is not a direct fix.
  - `[low]` `[reject]` (intent-alignment e6) A `lapsed` end lets `ci-step` still write. — Same root as the verification-gap "other" row above; rejected for the same reason.
  - `[false]` `[reject]` (intent-alignment f) The 5-min cadence is checked only in the keeper unit tests, with 5 ms beats at lane level. — The keeper unit tests pin the interval with a controlled sleep, and the lane tests check the wiring. No bad outcome is claimed.
  - `[low]` `[reject]` (intent-alignment g) No single test runs the keeper and a real step's fence together. — The fence is the step's own generation-checked swap and does not depend on the keeper; each half is tested against the fake. Combining them adds no coverage of a different path.
  - `[false]` `[reject]` (intent-alignment h) Only builder lanes heartbeat. — The coordinator heartbeat is Story 2.4, as the epics and AR9 say.
  - `[false]` `[reject]` (intent-alignment i) The diff shows no verification run and no status change. — Verification ran in step 3 and is recorded under Auto Run Result; this workflow sets the statuses.
  - `[low]` `[reject]` (blind) The keeper ignores `retry_after` in production, because the 60 s swap deadline turns a long rate-limit wait into `deadline`. — Real for `retry_after` over the remaining deadline: the keeper calls back early and gets another rate-limited reply. The lapse check still runs on the host clock, so the release timing holds. A fix would change the `swapLedger` error type.
  - `[medium]` `[patch]` (blind) The lapse baseline `lastGood` is taken after the swap returns, but the stamp is taken before it, so the release can come after the record is stale. — The host time is now read just before the stamp and becomes `lastGood` on success.
  - `[low]` `[patch]` (blind) `claimedMs` is never passed, so the first baseline is late by the claim round-trip. — `runLaneProcess` now passes the host time at which the claim snapshot's `now` was seen.
  - `[low]` `[reject]` (blind) The keeper's signal never reaches the PR, CI and merge steps. — Same root as intent-alignment b; rejected for the same reason.
  - `[low]` `[reject]` (blind) The CI step swallows `Abandon` and writes `failAttempt`. — Same root as the verification-gap "other" row: it lands only on `lapsed`; for `lost` and `released`, the precondition refuses it.
  - `[low]` `[reject]` (blind) The keeper retries lane-stop conditions instead of raising them. — Same as intent-alignment e5.
  - `[low]` `[reject]` (blind) A keeper end during the trailing wait is never journaled. — Real but narrow: the unit is lost or lapses inside a 1–15 min wait after the outcome was written. Re-journaling would add a second journal write path.
  - `[low]` `[reject]` (blind) The estimated forge time is never corrected during long phases. — Host drift over 3 h on an NTP host is seconds against a 30-min stale age. The spec forbids an extra snapshot, and feeding the swap's snapshot time back would change `swapLedger`'s result type.
  - `[low]` `[reject]` (blind) A thrown swap is logged as `deadline`. — `swapLedger` does not throw on these inputs; only the label in a log line for an unreachable path would change.
  - `[low]` `[patch]` (blind) No test checks that the lapse is measured from the last good beat rather than from the claim. — Added a keeper test: good beats, then failures; the release comes when the next try would land 30 min after the last good beat.
  - `[medium]` `[patch]` (blind) The `runLaneProcess` tests skip `lapsed`, loss during a step, and `Abandon` through the steps. — Same group as the two verification-gap test rows; covered by the lapsed and step-boundary tests added there.
  - `[maybe-false]` `[reject]` (blind) The lane-level keeper tests depend on real 5 ms timing and may flake. — The keeper and usage-limit lane tests passed 15 of 15 runs, and `test/lane/heartbeat.test.ts` passed 20 of 20. A load-induced flake would only be `low`.
  - `[low]` `[reject]` (edge) `retry_after` is not honoured because the swap ends in `deadline`. — Same as the blind `retry_after` row.
  - `[medium]` `[patch]` (edge) `heartbeat_at` is stamped before the swap but `lastGood` is taken after it, and the claim's stamp time is not passed. — Same group as the blind baseline rows; fixed there.
  - `[low]` `[reject]` (edge) A lapse release while `merging` leaves the PR queued. — Same as intent-alignment e4.
  - `[false]` `[reject]` (edge) `params.forgeNow()` could throw (`iso(NaN)`) outside the swap's try, and the keeper would stop silently. — The forge `now` always comes from `formatDate` in the GitHub adapter and as ISO from the fake, so `estimatedNow` cannot produce NaN.
  - `[low]` `[reject]` (edge) `ci-step` catches `Abandon` and runs `failAttempt`. — Same as the verification-gap "other" row.
  - `[low]` `[reject]` (edge) On `lapsed`, the steps keep pushing or enqueueing because their fences pass. — On `lapsed` the record is still this lane's at G, so a passing fence is a legitimate holder check that stamps `heartbeat_at` again; the lane abandons at the next boundary.
  - `[low]` `[reject]` (edge) `checkHeld` overwrites a `merged` record the step wrote after the keeper's release. — It needs a lapse release while `merging` and then the queue merging inside the same step. Only the journal's state is wrong, and the sweep reconciles it.
  - `[low]` `[reject]` (edge) A transient failure of the post-push PR fence counts a failed attempt with the branch pushed and no PR. — This is the same consequence as the existing `openPr` failure path at the same point, handled the same way.
  - `[low]` `[reject]` (edge) A beat that fails with an edit stop or `auth`/`forbidden`/`uninstalled` raises no alert and retries until the lapse. — Same as intent-alignment e5.
  - `[low]` `[reject]` (edge) `WaitParams.tickMs`/`onTick` and the sleep waiter's tick are now dead code. — True, but it is the Waiter port's own capability from Story 1.18, with tests, and causes no harm. Removing it would widen this Story into the port.
  - `[low]` `[reject]` (edge, claim) Inside CI sessions, `Abandon` is caught and `ci-step`'s own edits still run. — Same as the verification-gap "other" row.
  - `[low]` `[reject]` (edge, claim) The lapse release skips the dequeue-before-leaving-merging rule. — Same as intent-alignment e4.

### 2026-10-24 — Review pass
- verdicts: 35 findings — high 0, medium 0, low 28, false 7, maybe-false 0
- findings:
  - `[low]` `[patch]` (verification-gap) No test fails if the keeper's `claimedMs: claimNowAt` wiring is reverted. — Pre-verified gap. Added the lane-level test "the lapse counts from the claim's snapshot time": the claim swap takes 20 min of host time, keepAlive fails, and the release must come at exactly T0 + 28 min. Without the wiring it comes at T0 + 48 min, so the test fails; this was checked by reverting the line.
  - `[low]` `[reject]` (verification-gap) No test covers the unexpected-error path keeping the `Abandon` state (`lane-process.ts` `if (!(inner instanceof Abandon))`). — Real, but reaching it needs a non-`Halt` throw after the keeper ended, and the harness has no seam for one. A new injection point is more than a direct fix for a path users rarely meet.
  - `[low]` `[reject]` (intent-alignment 1) `retry_after` is never honoured in production, because the 60 s deadline turns it into `deadline`. — carried: same as the earlier blind `retry_after` row; `src/lane/heartbeat.ts:142` still reads as that row describes.
  - `[low]` `[reject]` (intent-alignment 2) The steps notice a loss only at their next fence or boundary, and `ci-step` catches `Abandon`. — carried: same as the earlier intent-alignment b and verification-gap "other" rows.
  - `[false]` `[reject]` (intent-alignment 3) The kill by PID is checked only at the stub sandbox. — carried: same as the earlier intent-alignment a row.
  - `[low]` `[reject]` (intent-alignment 4) A lapse release while `merging` leaves the PR queued. — carried: same as the earlier intent-alignment e4 row.
  - `[low]` `[reject]` (intent-alignment 5) The keeper retries lane-stop kinds such as `auth` until the lapse. — carried: same as the earlier intent-alignment e5 row.
  - `[false]` `[reject]` (intent-alignment 6) The lapse ignores the steps' fences and queue beats as good beats. — carried: same as the earlier intent-alignment e1 row.
  - `[low]` `[reject]` (intent-alignment 7) The fence rows are tested at step level, not together with the keeper in lane-process. — carried: same as the earlier intent-alignment g row.
  - `[false]` `[reject]` (intent-alignment 8) The fix path and the status and approval comments get no fence of their own. — A fix that changes no PR is not a PR change, and the test "a fix leaves the PR text alone" checks that. Each comment directly follows a generation-checked ledger edit (`beat("record")` in `pr-step.ts`), so a lost unit stops before it.
  - `[low]` `[reject]` (edge) A lapse release of a `merging` record does no dequeue (`src/lane/heartbeat.ts:108`). — carried: same as the earlier intent-alignment e4 row.
  - `[low]` `[reject]` (edge) The lapse release fails its precondition because the lane's own step just parked or merged the unit, so the end is `lapsed`. — Real. It needs about 28 min of failing beats and then a step's park or merge landing just before the release. It is the same narrow family as the earlier "`checkHeld` overwrites a `merged` record" row, and a fix adds a re-check branch.
  - `[low]` `[reject]` (edge) `retry_after` at or past `callTimeoutMs` ends as `deadline`. — carried: same as the earlier blind `retry_after` row.
  - `[false]` `[reject]` (edge) `forgeNow()` could throw outside the swap's try. — carried: same as the earlier edge `iso(NaN)` row.
  - `[low]` `[reject]` (edge) The keeper's stamps drift when the host clock steps back or no forge read refreshes `lastNow`. — carried: same as the earlier blind "estimated forge time is never corrected" row.
  - `[false]` `[reject]` (edge) A claim whose `writtenRecord` is null starts no keeper (`lane-process.ts:1028`). — `makeEdit` always writes the unit's path with `serializeUnitRecord` of a record built by the claim edit (`src/core/ledger/edits.ts:109`), so a successful claim commit always parses. The null branch is unreachable.
  - `[low]` `[reject]` (edge) Beats failing `auth`/`forbidden`/`uninstalled` retry instead of raising a lane stop. — carried: same as the earlier intent-alignment e5 row.
  - `[low]` `[reject]` (edge) The PR, CI and merge steps get only `budget`, not the keeper's signal. — carried: same as the earlier intent-alignment b row.
  - `[low]` `[reject]` (edge) `stop()` with a beat and a release in flight delays exit by up to two call deadlines. — Partly disproved: after a failed beat, `if (stopping.signal.aborted) return;` (`src/lane/heartbeat.ts:141`) skips the release, so the delay is at most one 60 s call deadline. That happens only on a hanging forge after the trailing wait has ended, and it is harmless there. Joining the stop signal into the swap would add a cancellation path to the keeper's writes.
  - `[low]` `[reject]` (edge) A non-lost failure of the post-push PR fence leaves the record's `head_sha` older than the branch. — carried: same as the earlier edge "transient failure of the post-push PR fence" row; the `openPr` failure at the same point has the same result.
  - `[low]` `[reject]` (edge) The Waiter's `tickMs`/`onTick` path has lost its only production caller. — carried: same as the earlier edge dead-code row.
  - `[low]` `[reject]` (edge, claim) The doc's "retry_after when longer" is never true with the default deadline. — carried: same as the earlier blind `retry_after` row.
  - `[low]` `[reject]` (edge, claim) The keeper's lapse release breaks the merge step's "dequeue before leaving merging" rule. — carried: same as the earlier intent-alignment e4 row.
  - `[low]` `[reject]` (blind) Another lane's sweep `markMerged` rewrites `owner/host/lane` through `stamp()`, so this lane's keeper ends `lost` and `checkHeld` journals a merged unit as `failed`, state null. — Real (`src/core/ledger/edits.ts:166`, `548`). It needs a second lane's process start to sweep in the short window between the queue merging the PR and this lane's next queue poll. Only the journal is wrong: the ledger says `merged`. The matrix's Lost row names "another holder" literally, so the fix is a new branch in `keepAlive` or `checkHeld` that the intent does not settle.
  - `[low]` `[reject]` (blind) `wouldLapse` leaves out the release's own call deadline, so a release can land up to about 60 s past the stale age. — Real: a beat that fails just before `L + 30 min` releases with up to one more deadline. Only a takeover inside that minute is at risk, and takeover is Story 2.2. The formula is the intent matrix's own, so changing it would change the intent.
  - `[low]` `[reject]` (blind) `checkHeld` in `settle` and in `usageLimitSleep` turns a step's `stop`, or a STOP, into `failed` once the keeper has ended. — Real but narrow: the keeper ends at least about 28 min after beats start failing, and a step that meets the same `auth` failure returns `stop` long before that. In the sleep, the keeper's end aborts the wait, so it ends `aborted`, not `stopped`. A fix adds a branch to the abandon rule.
  - `[low]` `[reject]` (blind) A precondition failure on the lapse release is reported as `lapsed`, not `lost`. — Real, but only the reason text differs: the state is null either way and nothing more is written. A takeover in that window needs Story 2.2, and a fix adds a branch.
  - `[false]` `[reject]` (blind) `regenerate()` hides the abandon reason behind a lockfile failure. — The CI step turns the failed lockfile run into its `failed` path, whose fenced edit is refused. `settle` then runs `checkHeld`, which throws `Abandon` with the keeper's `heartbeat: … lost` reason, so the journal still records the loss.
  - `[low]` `[reject]` (blind) A keepAlive stamp can move `heartbeat_at` back behind a step's fresher stamp. — Real, by at most host drift plus one 60 s swap deadline, against a 30-min stale age. No user meets it, and a `max` stamp would change the shared `stamp()` rule.
  - `[low]` `[reject]` (blind) The `world()` harness tests a rate-limited back-off that production cannot reach. — Same root as the earlier blind `retry_after` row; the tests pin the keeper's `exhausted` handling, which stays correct if `swapLedger` ever carries `retry_after`.
  - `[low]` `[patch]` (blind) No test fails if the `claimedMs` wiring is reverted, and the lane-level lapse test bounds the timing only loosely. — Same root as the verification-gap `claimedMs` row; the new test pins the exact release time with a host gap during the claim swap.
  - `[low]` `[reject]` (blind) Three keeper edge cases lack tests: stop overwrite, foreign `markMerged`, and keepAlive contending with step swaps. — The first two are the rejected rows above. Contention is the CAS loop's existing retry, which the ledger-cas suite covers; it costs a step one retry.
  - `[false]` `[reject]` (blind) There is no keeper and no log when the claim's record does not parse. — Same refutation as the edge `writtenRecord` row: a successful claim commit always carries a schema-valid record.
  - `[low]` `[reject]` (blind) There is an import cycle (`heartbeat.ts` ↔ `lane-process.ts`) and some duplicated holder checks and test helpers. — The cycle is used only at call time, the pattern the Code Map records for the existing steps. Moving helpers is a refactor across modules and fixes no failure.
  - `[low]` `[patch]` (blind) There are naming and doc gaps: the `lane-process.ts` header omits `lapsed`, the `KeeperEnd` kinds are undocumented, and two types are named `HeartbeatParams`. — Patched the header to cover a release that fails before the lapse. The `KeeperEnd` kinds are documented in the module header above the type. Renaming the exported type would change public surface that the compiler already keeps apart.

## Design Notes

- **Release without an attempt.** AR33 says "a heartbeat that would lapse releases the unit". AD-7 says "with attempts + 1" every time it means an attempt counts, and AD-2 says "as a failed attempt" for the budget. Forge flakiness is not the unit's failure, so use the `release` edit.
- **Why `keepAlive` exists.** The keeper runs alongside the steps' own edits. A precondition failure from `heartbeat` can't tell "my step parked it" from "BOB took it", and the null from `keepAlive` can.
- **The lapse margin.** The keeper counts only its own beats and the claim as good beats. That is conservative: it releases a little early rather than late.
- **Known limits, accepted.** A lapse release of a `merging` record leaves its PR queued, with no dequeue; the sweep marks it merged if the queue merges it later. Retro C10 (per-run nonce or PID lock) stays out of scope.

## Verification

**Commands:**
- `bun test` -- expected: no failure outside the baseline's sandbox-only set. Compare with the same run at `01381c31ac17a4b0b9969d0360b00d38bd117401`. Outside the sandbox, it should exit 0.
- `for i in $(seq 20); do bun test test/lane/heartbeat.test.ts || break; done` -- expected: 20 passes.
- `bun --bun oxlint` -- expected: exit 0
- `bun --bun tsc` -- expected: exit 0

## Auto Run Result

Status: done

**Summary.** Story 2.1 is complete. One heartbeat keeper per claimed unit stamps `heartbeat_at` with a `keepAlive` swap every 5 min, from the claim until the lane process ends. When it loses the unit, it kills the session through the sandbox signal and the lane abandons the unit. When back-off would let the heartbeat lapse, it releases the unit without counting an attempt. New fences guard `openPr`/`updatePr`, every enqueue retry, and the dequeue in `leaveMerging`. This run picked up the blocked session's work, committed at `edeef2ebd55cf62006837df2f292171a40346221`, fixed the race in its tests, reviewed the whole Story diff from `01381c31ac17a4b0b9969d0360b00d38bd117401`, and applied the review patches.

**Files changed (whole Story, baseline → working tree):**
- `src/core/ledger/edits.ts` -- `keepAlive`: a held claimed/merging record is stamped; a held record in another state gives null; anything else is a precondition failure.
- `src/core/lane/heartbeat.ts` -- `HEARTBEAT_MS`, `HEARTBEAT_RETRY_MS`, the pure `wouldLapse` and `heartbeatRetryMs`.
- `src/core/lane/waits.ts` -- removes `USAGE_LIMIT_TICK_MS`.
- `src/lane/heartbeat.ts` -- the `startHeartbeat` keeper. In this run, the lapse baseline became the host time of each beat's stamp.
- `src/lane/lane-process.ts` -- starts the keeper and joins its signal into the session and the usage-limit wait. `checkHeld`/`Abandon` abandon the unit, and the keeper stops after the trailing wait. In this run, it also passes `claimedMs`, the time the claim's `now` was seen.
- `src/lane/pr-step.ts` -- a fence before `openPr`/`updatePr`.
- `src/lane/merge-step.ts` -- fences before enqueue retries and before the dequeue in `leaveMerging`.
- `test/core/ledger/edits.test.ts`, `test/core/lane/heartbeat.test.ts` -- case tables for `keepAlive`, `wouldLapse` and `heartbeatRetryMs`.
- `test/lane/heartbeat.test.ts` -- the keeper against the fake forge. In this run: the race in the lost table fixed, forge time offset from host time, and a lapse measured from the last good beat.
- `test/lane/lane-process.test.ts` -- the keeper at lane level. In this run: lapsed, a loss at a step boundary, and forge-time stamps.
- `test/lane/pr-step.test.ts`, `test/lane/merge-step.test.ts`, `test/lane/ci-step.test.ts` -- a generation + 1 takeover before each fence: no push, PR change, enqueue or dequeue reaches the fake.

**Review findings.** 42 findings: high 0, medium 5, low 27, false 9, maybe-false 1.
- Patches applied, as three entries:
  - The lapse baseline and claim time (medium).
  - The lane-level lapsed and step-boundary tests (medium).
  - The forge-time test (low).
- Deferred: 1 item, the unfenced dequeue in `stop --now`.
- Rejected: 31 findings. Each one's reason is recorded in the Review Triage Log above.

**Follow-up review recommended: true.** Two medium entries were patched (high 0, medium 2, low 1). The unverified risks:
- No test fails if the `claimedMs` wiring is reverted.
- The keeper's interplay with the steps after a `lapsed` end was not re-reviewed after the patch. `ci-step` can still land `failAttempt` there (rejected as low).

**Verification:**
- `bun test`: 2422 pass, 73 fail. The 73 failures match the baseline run at `01381c31ac17a4b0b9969d0360b00d38bd117401` name for name. They are all sandbox-only (no loopback listen, no `ps`/`kill`). The Story added no failure.
- `bun test test/lane/heartbeat.test.ts`: 20 of 20 runs pass.
- The lane-level keeper and usage-limit tests: 10 of 10 runs pass after the patch, and 15 of 15 before it.
- `bun --bun oxlint`: exit 0.
- `bun --bun tsc`: exit 0.

**Residual risks:**
- A lapse release of a `merging` record leaves its PR queued.
- The keeper retries lane-stop errors (`auth`, edit stop) until the lapse instead of alerting.
- A long `retry_after` ends the swap as `deadline`, so the keeper calls back early.
- The PR, CI and merge steps notice a loss only at their next fence or at the step boundary.
- Retro C10 (a per-run nonce or PID lock) is still an open Maintainer decision.
- The earlier `spec-2-1-heartbeat-and-fencing.md` keeps its `blocked` status. This spec supersedes it.
- The changes are left uncommitted in the working tree, as the lane runner's rules require, and the runner makes the commit. This is a deliberate departure from this workflow's commit step.

### Follow-up review pass (2026-10-24)

Status: done

**Summary.** A fresh four-layer review of the whole Story diff from `01381c31ac17a4b0b9969d0360b00d38bd117401`. This run started from the `done` spec. The invocation named Story 2.1 but no spec file, and a new spec under the bare slug would have put two `spec-2-1-*.md` files on disk again. (The earlier blocked spec was removed in `30dea1df91ff9c4843582ab5f01ec9742e7578ad`, so the residual-risk note above about it no longer applies.) Two low patches were applied; the code behaves as before.

**Files changed in this pass:**
- `test/lane/lane-process.test.ts` -- a lapse test with a 20-min claim swap pins the release at T0 + 28 min, measured from the claim's snapshot time. It fails if `claimedMs: claimNowAt` is reverted (48 min).
- `src/lane/lane-process.ts` -- the header comment now covers a release that fails before the lapse (`lapsed`).

**Review findings.** 35 findings: high 0, medium 0, low 28, false 7, maybe-false 0.
- Patches applied: 2 entries, both low (the `claimedMs` test; the header doc).
- Deferred: none new.
- Rejected: 33 findings, of which 17 were carried from the earlier pass. Each reason is in the Review Triage Log. The most notable new ones:
  - A foreign sweep's `markMerged` makes the keeper report `lost`, so the journal says failed for a merged unit (ledger correct).
  - `wouldLapse` leaves out the release's own deadline, which is up to about 60 s; the formula is the intent's.
  - `checkHeld` can turn a late `stop` into `failed`.

**Follow-up review recommended: false.** This is a follow-up pass, and no high entry was patched (patched: high 0, medium 0, low 2).

**Verification:**
- `bun install --frozen-lockfile`: installed the lockfile's 10 packages. `node_modules` was missing in this clone, and the lockfile is unchanged.
- `bun test`: 2423 pass, 73 fail, 162 skip. The same run on a `git archive` of `01381c31ac17a4b0b9969d0360b00d38bd117401` in the temp folder gave 2339 pass and 74 fail. The 73 failures here are all among those 74. The one extra baseline failure is the repo graph check, which needs `.git`. All of them are sandbox-only (loopback listen, `ps`/`kill`).
- The new test passes; with `claimedMs: claimNowAt` commented out, it fails (received 48 min, expected 28).
- `bun test test/lane/heartbeat.test.ts`: 20 of 20 runs pass.
- `bun test test/lane/lane-process.test.ts -t "keeper|lapse|heartbeat|lost"`: 10 of 10 runs pass (14 tests each).
- `bun --bun oxlint`: exit 0.
- `bun --bun tsc`: exit 0.

**Residual risks:** the earlier list stands. Add the newly rejected low rows:
- A foreign `markMerged` journals a merged unit as failed.
- A release can land up to about one call deadline past the stale age.
- A late lane stop can become `failed`.

The changes are left uncommitted in the working tree for the lane runner, as in the earlier pass.
