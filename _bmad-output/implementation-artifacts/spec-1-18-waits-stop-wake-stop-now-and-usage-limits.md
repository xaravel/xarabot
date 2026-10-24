---
title: 'Story 1.18: Waits, STOP, `wake`, `stop --now` and usage limits'
type: 'feature'
created: '2026-10-23'
baseline_revision: 'a91f47548c26633905a072d77197ba4375fff958'
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

**Problem:** A lane process ends as soon as its unit does, with no wait and nothing in `wait.pid`. Nothing kills a hung agent session or one that lingers after its result, and a usage-limit hit counts as a failed attempt. There is no `wake`, `stop` or `stop --now` command, so FR15, AR3, AR23 and AR44 are not in code.

**Approach:**
- A `Waiter` runs every wait as a child `sleep` whose PID is in `wait.pid`. It ends early on a STOP marker, a kill, or the unit budget.
- `runLaneProcess` adds three things: the trailing wait after the outcome, the session limits, and usage-limit sleeps.
- New `src/lane/stop.ts` functions back three CLI commands, `xarabot wake`, `xarabot stop` and `xarabot stop --now`. Every kill first checks the PID's start time and command.

## Boundaries & Constraints

**Always:**
- **Pure core (`src/core/lane/waits.ts`):**
  - `trailingWaitMs(outcome)` is 60 000 for `progress`, 1 800 000 for `idle`, 900 000 for `failed`, and `null` for `stop`.
  - `usageLimitSleepMs(resetAt, nowMs)` is `resetAt + 120 000 − now`, clamped to [0, 8 h]. When `resetAt` is `null` it is 900 000.
  - `checkPid({command, writtenMs, info, first})` returns `ok`, or `gone` (`info` is `null`), `started-later` (`info.startMs > writtenMs + 1000`) or `command`.
    - The command check passes when some whitespace-separated word of `info.args` has `command` as its basename.
    - With `first: true`, only the first word counts.
- **PID files.** `LaneStore.writePid(name, pid, command)` writes `<pid>\n<command>\n`. `command` is a plain basename.
  - The lane passes `basename(process.execPath)`, or `LaneDeps.command` when that is set.
  - The agent passes the basename of the launch spec's `argv[0]`.
  - The wait passes `sleep`.
- **`src/lane/processes.ts`:**
  - `ProcessTable` has `inspect(pid)`, which returns `{startMs, args}` or `null`, and `kill(pid)`, which sends SIGTERM and returns `boolean`.
  - `createPsProcessTable()` reads `LC_ALL=C ps -ww -o lstart= -o args= -p <pid>` and parses `lstart` as local time. A non-zero exit or output it can't parse is `null`.
  - `readPidFile(path)` returns `{pid, command, writtenMs}` (the file's mtime) or `null`.
  - `killRecorded(table, path, {first})`:
    1. Reads the PID file.
    2. Runs `checkPid` on it.
    3. Kills only on `ok`. It returns `killed`, or `skipped` with the reason.
- **`Waiter` (`src/lane/wait.ts`).** `createSleepWaiter({store, pollMs = 5000, spawn?})` returns `wait({ms, signal?, tickMs?, onTick?})`, which resolves to `{end: "elapsed" | "woken" | "stopped" | "aborted" | "failed", message?}`. It never throws.
  1. It checks the STOP markers first. A marker that is present or unreadable returns `stopped` with no spawn.
  2. It spawns `sleep <ms/1000>`, then writes `wait.pid`.
  3. Every `pollMs` it checks the markers. A STOP kills the child and returns `stopped`.
  4. When `signal` aborts, it kills the child and returns `aborted`.
  5. It calls `onTick` every `tickMs`.
  6. A child that exits 0 returns `elapsed`. One that ends on a signal it did not send returns `woken`. A spawn failure returns `failed`.
  7. It always clears `wait.pid`.
- **`runLaneProcess`:**
  - `LaneDeps.waiter: Waiter` is **required**.
  - Optional `LaneDeps.limits?: {sessionMs = 3 h, resultLingerMs = 5 min, resultPollMs = 5 s}` and `LaneDeps.command`.
  - **Trailing wait.** After `writeOutcome`, an outcome whose `trailingWaitMs` is not `null` waits that long. Then `lane.pid` is cleared and the run returns. The wait's end is written to stderr only when it is `failed`.
  - **Session limits.** Each sandboxed run, the lockfile command included, gets one signal that combines the budget, a `sessionMs` timeout, and an abort `resultLingerMs` after the result file is first seen. The lane looks for that file every `resultPollMs`.
    - A run ended by the `sessionMs` limit with no result is a failed attempt, reason `agent session ran past <h> h`, with no resume.
  - **Usage limit.** A run whose `parseUsage` reports `usageLimit` and that leaves no result is a usage-limit hit. The fresh run and the resume are treated alike. The lane then sleeps `usageLimitSleepMs(resetAt, now)` through the waiter, with `signal` = budget and `tickMs` = 5 min.
    - Each tick writes a `heartbeat` swap at the record's generation. A failed heartbeat is logged and the sleep goes on.
    - After the sleep, one span is appended to the journal: `{type: "span", span: "usage-limit", reason: "usage limit; reset <iso>|unknown", started_at, ended_at}`.
    - `elapsed` and `woken` start the same session again at the same start SHA (`setUp` resumes the wip). `aborted` is the budget's failed attempt, and `failed` is a failed attempt naming the waiter's message.
    - `stopped` writes `release` (no attempt) and ends the run with outcome `stop`, reason `STOP during a usage-limit sleep`.
    - Inside a CI-fix or conflict session, the session returns an error. Once the CI step returns, the run ends `stop` with the released record, so the CI step's own failure edit (lost on a released record) is overridden.
  - **Journal.** `SpanJournalRecordSchema.span` is `z.enum(["idle", "usage-limit"])`.
- **`src/lane/stop.ts`:**
  - `writeStop(path)` creates the marker, and its parent folder, with the text `stop\n`.
  - `wakeLane(table, laneDir)` calls `killRecorded` on `wait.pid` with `first: true`. It also refuses a recorded command that is not `sleep`.
  - `stopNow({laneDir, table, release})` runs in this order:
    1. It writes the lane's `STOP`.
    2. It calls `killRecorded` on `lane.pid`, then `agent.pid`, then `wait.pid` (`first: true` only for `wait`).
    3. It calls `release()`.
    4. It returns every step's report.
  - `releaseHeld({forge, identity, callTimeoutMs?})` reads `snapshot()` and parses the ledger.
    - It takes every record held by `identity` in state `claimed` or `merging`.
    - A `merging` record with a PR is dequeued first. A dequeue failure leaves that record and is reported.
    - Each one is then written `release` at its generation through `swapLedger`.
    - It returns the units released and those that failed.
- **CLI (`src/cli/main.ts`, `src/cli/lane-commands.ts`).** `main` becomes async. The paths are:
  - `~/.xarabot` from `HOME`.
  - `host.yaml` at `<config>/xarabot/host.yaml`, where `<config>` is `XDG_CONFIG_HOME`, else `HOME/.config`.
  - The lane folder at `~/.xarabot/repos/<owner>__<name>/lanes/<lane>/`.

  The commands:
  - `xarabot wake <lane>` exits 0 when it woke the lane, else 1 with the reason.
  - `xarabot stop <lane>` writes the lane's `STOP`.
  - `xarabot stop --all` writes `~/.xarabot/STOP`.
  - `xarabot stop --now <lane>` runs `stopNow` with `releaseHeld` over a GitHub forge built from `loadAppCredentials({login: lane.owner})`. With no `host_id` there is nothing to release.
  - An unknown lane, or a `host.yaml` that can't be read, exits 1.
- **Source test.** A test scans `src/` with comments stripped and fails on `pkill`, `killall`, or a string literal naming a `timeout` or `gtimeout` binary.

**Never:**
- No `pkill`, `killall`, `timeout` binary or process-group kill. Kills are by exact PID only, after the check.
- No heartbeat during the trailing wait, no claim heartbeat timer (Epic 2), no launchd wiring or `lane install` (Story 1.19), and no change to `Agent`, `Sandbox`, the ledger edits or the CI and merge steps' logic.
- No GitHub token in an agent session.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Trailing waits | outcome progress / idle / failed / stop | waiter called with 60 s / 30 min / 15 min / not called | none |
| Wait STOP | lane `STOP` written mid-sleep | sleep killed, `stopped`, `wait.pid` gone | none |
| Wait woken | external SIGTERM to the recorded PID | `woken` | none |
| Wait budget | signal aborts | `aborted`, child killed | none |
| Wake | live `sleep`, PID file older than it started | `skipped started-later` | exit 1 |
| Wake ok | live `sleep` recorded | killed | exit 0 |
| Wake wrong cmd | `wait.pid` names a live `cat` | not killed | exit 1 |
| stop --now | lane/agent/wait live | STOP written, kills in order lane, agent, wait, then release | each step reported |
| Release merging | own `merging` record with PR | `dequeue`, then `released`, `attempts` unchanged | dequeue fails: record stays |
| Session limit | run never ends, `sessionMs` small | killed; `released` attempts + 1; reason names the limit | outcome failed |
| Result linger | result written, run stays alive | killed after `resultLingerMs`; result used | none |
| Usage limit | run 1 limited, reset now + 1 min; run 2 done | sleep 3 min, one `usage-limit` span, then the PR step | none |
| Limit unparsed | `resetAt` null | sleep 15 min | none |
| Limit cap | reset in 20 h | sleep 8 h | none |
| Limit STOP | waiter `stopped` | `release`, attempts unchanged | outcome stop |
| Limit budget | waiter `aborted` | `released` attempts + 1 | outcome failed |
| CI-fix limit STOP | CI session limited, then `stopped` | record `released` attempts unchanged | outcome stop |

</intent-contract>

## Code Map

- `src/lane/lane-process.ts` -- `runOnce` (433), `sessionAt` (488), `ciSession` (561), `regenerate` (568), the outer `Halt` catch (823), `writeOutcome` (867). `held`, `swap` and `forgeNow` are the edit helpers. `heartbeat` and `release` come from `core/ledger/edits.ts`.
- `src/ports/lane-store.ts`, `src/lane/lane-store.ts` -- `writePid` gains `command`. `laneLayout` gives the paths, `stop` among them.
- `src/core/schemas/journal.ts` -- `SpanJournalRecordSchema.span`.
- `src/ports/agent.ts` -- `AgentUsage.usageLimit.resetAt` (epoch ms or `null`). The claude adapter already sets it (`usage.ts`).
- `src/ports/sandbox.ts` -- `run(..., signal)`: an abort sends SIGTERM by exact PID, then SIGKILL 10 s later.
- `src/lane/ledger-cas.ts` -- `swapLedger`. `src/core/ledger/codec.ts` -- `parseLedger(files)` gives `units`.
- `src/core/schemas/host.ts`, `src/core/config/load-host-config.ts` -- the `host.yaml` lanes and `host_id`.
- `src/adapters/forge/github/credentials.ts` (`loadAppCredentials`) and `github-forge.ts` (`createGitHubForge`) -- the CLI's forge for `stop --now`.
- `test/support/boundaries.ts` -- `strip(source).code`, with comments blanked, for the source scan. `src/` may spawn outside agent adapters.
- `test/lane/lane-process.test.ts` (harness at about line 220), `test/lane/merge-step.test.ts` -- the `runLaneProcess` call sites that need `waiter`. `test/lane/lane-store.test.ts` -- the `writePid` cases. `test/cli/main.test.ts` -- spawns `main.ts`.

## Tasks & Acceptance

**Execution:**
- `src/core/lane/waits.ts` -- `trailingWaitMs`, `usageLimitSleepMs`, `checkPid`, `commandMatches`, and the constants.
- `src/core/schemas/journal.ts` -- the span enum.
- `src/ports/lane-store.ts`, `src/lane/lane-store.ts` -- `writePid(name, pid, command)`.
- `src/lane/processes.ts` -- `ProcessTable`, `createPsProcessTable`, `parseLstart`, `readPidFile`, `killRecorded`.
- `src/lane/wait.ts` -- `Waiter`, `createSleepWaiter`.
- `src/lane/lane-process.ts` -- `waiter`, `limits`, `command`, the trailing wait, the session limits and the usage-limit loop.
- `src/lane/stop.ts` -- `writeStop`, `wakeLane`, `stopNow`, `releaseHeld`.
- `src/cli/lane-commands.ts`, `src/cli/main.ts` -- `wake` and `stop`, with an async `main`.
- Tests:
  - `test/core/lane/waits.test.ts` -- case tables.
  - `test/lane/processes.test.ts` -- a real `sleep` and `ps`.
  - `test/lane/wait.test.ts` -- a real `sleep`, with short `ms` and `pollMs`.
  - `test/lane/stop.test.ts` -- a real process table, plus the fake forge for `releaseHeld`.
  - `test/lane/lane-process.test.ts` -- a stub waiter: the trailing waits and every session-limit and usage-limit row.
  - `test/cli/lane-commands.test.ts` -- a temporary `HOME` and `XDG_CONFIG_HOME`.
  - `test/no-pkill.test.ts` -- the source scan.
  - Update the `lane-store` and journal schema tests.

**Acceptance Criteria:**
- Given a finished unit with outcome `progress`, when `runLaneProcess` runs with `createSleepWaiter` and a 1-minute wait stubbed to milliseconds, then `wait.pid` named a live `sleep` during the wait and is gone after.
- Given the source tree, when the suite runs, then the scan finds no `pkill`, `killall` or `timeout` binary in `src/`.
- Given `bun test`, `bun --bun oxlint` and `bun --bun tsc`, when they run, then each exits 0.

## Spec Change Log

## Review Triage Log

### 2026-10-23 — Review pass
- verdicts: 31 findings — high 0, medium 1, low 23, false 7, maybe-false 0 (plus 3 descriptive intent-alignment divergences, recorded last)
- findings:
  - `[low]` `[reject]` (blind) the usage-limit loop sleeps 0 ms when `resetAt + 2 min` is past, so a limit that keeps being reported loops sessions until the budget — the claude adapter reads a real reset epoch, which is in the future while a limit is active. A past reset means the limit has lifted, so retrying at once is correct. A minimum sleep would add a rule the intent does not state.
  - `[low]` `[reject]` (blind) a lost heartbeat during a usage-limit sleep is only logged — in Epic 1 nothing takes over a claim (`takeOverStale` and `releaseStale` have no callers until Epic 2), and any later held edit fails its fence anyway. Ending the sleep on a loss adds a branch.
  - `[medium]` `[patch]` (blind) the waiter does not check STOP again when the `sleep` exits, so a STOP written just before the sleep ends, or `stop` followed by `wake`, returns `elapsed`/`woken` and starts a new session — the waiter now checks the markers once more after the child exits; a test was added.
  - `[low]` `[reject]` (blind) `stop --now` sends only SIGTERM, lane first, so the sandbox's SIGKILL escalation dies with the lane — the AC fixes the order, and the CLI then signals the agent by its own PID. A CLI that ignores SIGTERM has not been seen; escalation is extra machinery.
  - `[low]` `[reject]` (blind) `stop --now` writes no outcome or journal record in the lane folder — no AC asks for one. The CLI reports each step on stdout, and the ledger records the release.
  - `[low]` `[patch]` (blind) `stop --now` exits 0 when a verified process could not be signalled (`kill-failed`) — that report now sets exit 1; a test was added.
  - `[low]` `[reject]` (blind) `lstart` is parsed as local time, which is ambiguous in the DST fall-back hour — a wrong guess there makes the process look started later, so it is skipped and never mis-killed. This fails safe, and moving to `etime` would be a rewrite.
  - `[low]` `[patch]` (blind) the source scan misses `"timeout 5 …"` strings and process-group kills — the pattern now also matches a quoted literal starting with `timeout `/`gtimeout `, plus `process.kill(-`, with fixtures.
  - `[low]` `[reject]` (blind) the runner-git guard skips `processes.ts` and `wait.ts` entirely — those two files hold only the `ps` and `sleep` spawns. An argv-level allowlist adds parsing to a test for a risk with no named caller.
  - `[low]` `[patch]` (blind) the lockfile command's session limit is untested — same root as the first verification-gap row; a test was added there.
  - `[false]` `[reject]` (blind) a usage-limit STOP inside `regenerate` is untested — `regenerate` runs the lockfile command, not an agent session, so it never parses usage and has no usage-limit path.
  - `[low]` `[reject]` (blind) the path where the release fails during a usage-limit STOP is untested — same root as the first edge row (rejected).
  - `[low]` `[reject]` (blind) `stop --now` is not run through the bin — `laneCommand` is tested directly with every branch, and the bin test covers `wake` and `stop` routing.
  - `[low]` `[reject]` (blind) no test runs a real `sandbox-exec … claude` agent PID against the check — the pure table in `waits.test.ts` covers both command lines as text. A real sandboxed agent belongs to the canary (Story 1.20).
  - `[false]` `[reject]` (blind) `releaseHeld` releases a `merging` record whose PR has just merged — the next claim's `decidePr` sees the merged PR and writes `merged` (`lane-process.ts` claim path), so the unit is never rebuilt.
  - `[false]` `[reject]` (blind) the CI step keeps acting after a usage-limit STOP — after the session's error, the CI step's `failAttempt` is lost on the released record. `held` → `lost` ends the step with no further edit (`ci-step.ts:249-258`).
  - `[low]` `[reject]` (blind) duplication: the `limitStop` cast three times, a second `DEFAULT_CALL_TIMEOUT_MS`, hand-built PID paths, and `laneDirFor` in the CLI — cosmetic, with no caller that diverges today. Story 1.19 will share the lane-folder helper when the launcher needs it.
  - `[low]` `[reject]` (edge) if the release swap fails after a STOP in a usage-limit sleep, the unit stays claimed — that needs the CAS loop to fail 10 times or a forge error, and any fallback would be another swap that fails the same way.
  - `[false]` `[reject]` (edge) unreadable STOP markers end the wait as `stopped` — this is the lane's existing fail-closed rule (`checkStop` treats unreadable markers as a stop) and the spec's.
  - `[low]` `[reject]` (edge) a past reset gives a 0 ms sleep — same root as the first blind row.
  - `[low]` `[reject]` (edge) there is no cap on usage-limit restarts — the intent bounds them by the unit budget ("the unit budget still applies").
  - `[low]` `[reject]` (edge) an `argv[0]` whose basename is not a plain name leaves `agent.pid` unwritten — every adapter's `argv[0]` is a plain command (`claude`), and the failure is already reported to the log and stderr.
  - `[false]` `[reject]` (edge) a hanging `onTick` keeps the wait from returning — the heartbeat's snapshot and ledger swap each run under a `callTimeoutMs` `AbortSignal` deadline, so a tick is bounded.
  - `[low]` `[reject]` (edge) a throw inside `releaseHeld`'s loop hides the units already released — forge methods and `swapLedger` return results and never throw. `stopNow` also catches a throw.
  - `[false]` `[reject]` (edge) the CI step tries forge actions on a released unit — same refutation as the blind CI-step row.
  - `[low]` `[reject]` (edge) a one-line PID file from an older version is skipped — no lane has run in production before this Story (the launcher is Story 1.19), so no such files exist.
  - `[false]` `[reject]` (edge) `stop --now` with no `host_id` exits 0 while units stay claimed — a lane identity needs the host UUID, so a host with no `host_id` has never claimed anything.
  - `[low]` `[reject]` (edge) the `lstart` time zone or DST can skip a live process — same root as the blind `lstart` row; it fails safe.
  - `[low]` `[patch]` (verification-gap) the lockfile command's session limit has no test — an `endToEnd` CI-step case was added with a small `sessionMs` and a hanging lockfile command.
  - `[low]` `[patch]` (verification-gap) the usage-limit span's `ended_at` is only checked under a frozen clock — a test with an advancing clock was added.
  - `[low]` `[patch]` (verification-gap) the `catch` branch for "the CI step threw after a usage-limit STOP" is untested — a stub CI-step test was added.
  - intent alignment (descriptive):
    - The diff implements the library reading. `runLaneProcess` and `createSleepWaiter` have no production caller yet, as in Stories 1.16 to 1.17a; the launcher is Story 1.19. The CLI commands are real and tested through the bin.
    - AR3's "heartbeats continue through the trailing wait" is not implemented. In Epic 1, no record is `claimed` or `merging` when the trailing wait starts, so there is nothing to heartbeat. The coordinator's claim (Epic 2) is where it matters.
    - The start-time check compares with the PID file's mtime, not with a stored start time (Design Notes). `stop --now` releases every claimed or merging record the lane identity holds, which in Epic 1 is at most its one unit.

## Design Notes

**Start-time check without a stored start time.** The PID file's mtime is when it was written, and the process it names was alive then. A process that reused the PID started after the original died, so after the write. `checkPid` therefore rejects a process whose `lstart`, which has whole-second resolution, is more than 1 s after the mtime. The file stays two lines, and nobody needs to call `ps` at write time. The command check matches basenames. The agent's PID is first `sandbox-exec`, which then execs the CLI, so either command line contains the CLI's basename.

**Why release in the CLI.** `stop --now` writes `STOP`, so no lane process starts again to release the unit. AD-22 says the CLI applies AD-7 itself, so it builds a forge from the owner's App credentials, as a lane does.

## Verification

**Commands:**
- `bun test` -- expected: exit 0
- `bun --bun oxlint` -- expected: exit 0
- `bun --bun tsc` -- expected: exit 0

## Auto Run Result

Status: done

**Summary:** Every wait is now a child `sleep` whose PID is in `wait.pid`, and every kill goes by exact PID after a start-time and command check.
1. **Trailing wait.** After its outcome, `runLaneProcess` waits 1 min after `progress`, 30 min after `idle` or 15 min after `failed`, through the required `LaneDeps.waiter`. After `stop` it does not wait. It then clears `lane.pid`.
2. **Session limits.** Every sandboxed run gets one signal that combines the unit budget, a 3-hour limit, and a kill 5 minutes after the result file appears. A run that hits the 3-hour limit with no result is a failed attempt, with no resume.
3. **Usage limits.**
   - A usage-limit hit sleeps until the reset plus 2 minutes, or 15 minutes if the reset is unknown, capped at 8 hours. The sleep heartbeats the claim every 5 minutes and journals one `usage-limit` span. The session then starts again.
   - A STOP during the sleep releases the unit with no attempt and ends `stop`; this works inside CI sessions too. The budget ending the sleep is a failed attempt.
4. **CLI commands.**
   - `xarabot wake <lane>` kills only a verified `sleep`.
   - `xarabot stop <lane>` and `xarabot stop --all` write the lane or host `STOP`.
   - `xarabot stop --now <lane>` writes `STOP`, then kills lane, agent and wait in that order, each checked first. It then releases the lane's held records through the owner's GitHub App with no attempt counted, dequeuing a `merging` PR first.

**Files changed:**
- New modules:
  - `src/core/lane/waits.ts`: wait durations, the usage-limit sleep, and the pure PID check.
  - `src/lane/processes.ts`: the `ps` process table, PID files, and `killRecorded`.
  - `src/lane/wait.ts`: `createSleepWaiter`, a sleep that STOP, a kill or the budget can end.
  - `src/lane/stop.ts`: `writeStop`, `wakeLane`, `stopNow`, `releaseHeld`.
  - `src/cli/lane-commands.ts`: `wake`, `stop`, `stop --all`, `stop --now`.
- Changed:
  - `src/cli/main.ts`: async, and routes `wake` and `stop`.
  - `src/lane/lane-process.ts`: the trailing wait, the session limits and the usage-limit loop.
  - `src/ports/lane-store.ts` and `src/lane/lane-store.ts`: `writePid(name, pid, command)`.
  - `src/core/schemas/journal.ts`: the `usage-limit` span.
- Tests:
  - New: `test/core/lane/waits.test.ts`, `test/lane/processes.test.ts`, `test/lane/wait.test.ts`, `test/lane/stop.test.ts`, `test/cli/lane-commands.test.ts`, `test/no-pkill.test.ts`.
  - Extended: the lane-process and ci-step tests.
  - Updated for the new `waiter` and `writePid`: the lane-store, journal, pr-step and merge-step tests, plus the runner-git spawn guard, which now exempts `processes.ts` and `wait.ts`.

**Review findings:** 31 findings: 1 medium, 23 low, 7 false, plus 3 descriptive intent rows.
- **Patched (1 medium, 6 low):**
  - The waiter now checks STOP again when the `sleep` exits.
  - `stop --now` exits 1 on `kill-failed`.
  - The source scan catches `timeout` with arguments and process-group kills.
  - New tests: the lockfile command's session limit, the span's `ended_at` with a moving clock, and the CI-step-threw branch after a usage-limit STOP.
- **Deferred:** none.
- **Rejected:** the rest, each with its reason in the Review Triage Log.

**Follow-up review recommended:** false. Patched: 0 high, 1 medium, 6 low.

**Verification:**
- `bun install`: no changes.
- `bun test`: 2365 pass, 63 skip, 0 fail.
- `bun --bun oxlint` and `bun --bun tsc`: both exit 0.
- Every matrix row has a test that ran and passed.

**Residual risks:**
- Nothing in production calls `runLaneProcess` with `createSleepWaiter` yet; the launcher is Story 1.19.
- `stop --now`'s GitHub release is tested only against the fake forge and the missing-credentials path.
- The start-time check reads `ps lstart` as local time. That is ambiguous in the DST fall-back hour, where a live process may be skipped (never mis-killed). A PID reused within 1 s of the PID file being written would pass the check.
- AR3's heartbeat through the trailing wait is not done, because Epic 1 holds no claim then.
