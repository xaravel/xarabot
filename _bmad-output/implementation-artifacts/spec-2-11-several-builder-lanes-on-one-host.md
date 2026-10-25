---
title: 'Story 2.11: Several builder lanes on one host'
type: 'feature'
created: '2026-10-25'
baseline_revision: '0434649a98f965dac12c43d4ca7fffc348f63e38'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A host cannot yet safely run several builder lanes (FR4, NFR21, AR3, AR22, AR35).
- Nothing stops a second process of the same lane: `lane.lock` does not exist.
- `xarabot lane install` accepts any builder name, so a name the ledger refuses stops the lane at its first snapshot. It silently replaces a lane of another repo that has the same name, and it never checks that the tools the lane needs resolve on the `PATH` it writes into the plist.
- When the session's change conflicts with fresh `origin/main` at commit time, the attempt fails. With several builders this is common, and it should go to a conflict session counted in `ci_fixes` (AR20).
- No test runs two builders and a coordinator against one forge.

**Approach:**
- `lane run` holds an exclusive `lane.lock` for the whole run. A second process exits 0 without claiming, and a lock whose process is gone is taken over.
- `lane install` gains the name, uniqueness and `PATH` checks.
- The PR step's commit conflict falls back to a commit onto the session's start, so the CI step's existing merge of `main` starts the conflict session.
- A fake-forge test runs two builders and a coordinator concurrently.
- The builder limit and the host `STOP` already exist (Stories 1.19, 1.18). This Story only adds tests and runbook text for them.

## Boundaries & Constraints

**Always:**
- **`lane.lock`** at `<laneDir>/lane.lock`. Its text is `<pid>\n<command>\n<start ISO 8601 UTC>\n`: the PID, the basename of `process.execPath`, and the process start time (`performance.timeOrigin`).
  - **Created exclusively and whole.** Write a temp file in the lane folder, then `link` it to `lane.lock`. EEXIST means the lock is taken. Remove the temp file in every case.
  - **Live or stale.** An existing lock is live when `checkPid` (the `stop --now` check, `src/core/lane/waits.ts`) gives `ok` for it. The check uses `writtenMs` = the recorded start and `first: false`, against `ProcessTable.inspect(pid)`. It is stale when the check gives `gone`, `started-later` or `command`, and also when the text is malformed.
  - **Stale takeover.**
    1. Rename `lane.lock` to a unique name.
    2. If the renamed file's text differs from the text judged stale, another process just took the lock: `link` it back (ignore EEXIST), remove the renamed file and report the lock held.
    3. Otherwise remove it and retry the exclusive create once. EEXIST on the retry also means the lock is held.
  - **Release** removes `lane.lock` only while its text is still this process's own.
  - **In `lane run`**, the lock is taken after the STOP check and the static role/name check, and before any forge call, version switch or failed-start write. It is released on every exit, a throw included (`try`/`finally`).
    - A live lock: print `lane <name> is already running (pid <pid>, lane.lock); exiting without a claim` and exit 0. Do not touch `failed-starts`, do not connect, and claim nothing.
    - A takeover prints which PID was stale and why.
    - An I/O error on the lock is a failed start.
  - The pure parts (text, parse and the live/stale verdict) go in `src/core/lane/lane-lock.ts`, which returns `Result` and never throws. The filesystem part goes in `src/lane/lane-lock.ts`. `lane.pid` stays as it is.
- **`lane install` checks.** All run before `host.yaml` is read or written and before any connect:
  - Role `builder` with a name not matching `^builder-[1-9][0-9]*$` is refused: `a builder lane must be named builder-<n> (n >= 1), not "<name>"`.
  - A name `host.yaml` already holds for a different repo is refused, naming that repo. The same name and repo is still replaced, as now.
  - `claude`, `bun`, `git` and `uv` must each resolve (`Bun.which`) on the `PATH` that `plistEnv(env)` writes. Install refuses and names every missing tool and the `PATH`. An unset `PATH` refuses, naming all four.
- **Commit conflict (builder PR step).**
  - A `conflict` outcome now carries `start`, the clone session's start SHA (`commitSession` and the git committer both have it).
  - On a conflict, `createPrStep` notes the paths and commits again onto `start`. It then handles that second outcome exactly as the first (a refusal parks `write-check`, an empty commit parks `no-op`, and any further conflict is a failed attempt). It pushes and opens or updates the PR as usual.
  - This applies to `kind` `build` and `fix` alike. No attempt is counted for the conflict.
  - The CI step's next round merges `main`. A conflict no rule resolves runs its conflict session, which is counted in `ci_fixes` with the cap of 2 (the existing path).
- The builder limit stays as `builderRefusal` counts it: the `builder` lanes in `host.yaml`, across all repos.

**Never:**
- No ledger schema change, no new park reason, no `runner_version` change.
- No change to the commit-conflict handling of the planning, retro, retro-item or `reconcile` steps.
- No change to `host.yaml`'s schema.
- Do not touch `.github/`, `AGENTS.md`, `_bmad/` or the spec folder.
- No `pkill` and no `timeout` binary.
- No mocks in core tests.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Second process | `lane.lock` names a live process (start ≤ recorded + 1 s, command matches) | exit 0, message names the PID, no connect, `failed-starts` untouched, nothing claimed | — |
| Dead PID | lock's PID has no process | taken over; the run proceeds; the lock is removed at exit | — |
| PID reused | live PID whose process started after the recorded start + 1 s | stale: taken over | — |
| Other command | live PID, command mismatch | stale: taken over | — |
| Malformed lock | unparseable text | stale: taken over | — |
| Takeover race | renamed file's text is not the stale text | restored; reported held, exit 0 | EEXIST on restore ignored |
| Held during run | run in progress | `lane.lock` holds own PID and start; removed after the run, a throw included | an I/O error on the lock is a failed start |
| Bad builder name | `--role builder`, name `worker` or `builder-0` | exit 1, nothing written, no connect | — |
| Name taken | `host.yaml` has `builder-1` for `xaravel/xaravel`; install `builder-1` for `xaravel/xarabot` | exit 1, `host.yaml` unchanged | — |
| Missing tool | `uv` not on the `PATH` | exit 1 naming `uv` and the `PATH`, nothing written | unset `PATH`: names all four |
| Several builders | `builder-1`, `builder-2` under `XARABOT_MAX_BUILDERS=2` | distinct lane folders, `runner.git`s, plists and labels; distinct `laneLayout` clone and vendor paths | over the limit: refused (existing) |
| Limit across repos | `host.yaml` builders in two repos exceed the limit | `lane run` refuses: a failed start (existing test) | — |
| Host STOP | `~/.xarabot/STOP` present at a coordinator's or builder's start | exit 0, no claim, not counted | — |
| STOP mid-unit | host STOP written during a builder session | the unit finishes through its PR step; the next start claims nothing | — |
| Commit conflict | first commit `conflict`, second (onto `start`) `committed` | pushed, PR opened, `progress`, `attempts` unchanged; the log names the paths | second conflict: failed attempt |
| Race | 2 builders + coordinator, Promise.all, 3 Stories with disjoint globs, one session writing `sprint-status.yaml` and one `retro-gates.yaml` | each Story claimed and sessioned once in total; no committed change touches a status file; those two park `write-check`; the coordinator claims no Story | — |

</intent-contract>

## Code Map

- `src/cli/lane-run.ts`:
  - `laneRun`: step 1 (the lane), step 2 (STOP, line ~139), the static role check (~200), then step 3. Every `return` after that must release the lock, so wrap steps 3–6 in an inner function under `try`/`finally`.
  - `LaneRunDeps` gains `lock?: { pid?; command?; startedMs?; table? }`, for tests.
- `src/core/lane/waits.ts`: `checkPid`, `START_SLACK_MS`, `ProcessInfo`. Reuse them, do not copy them.
- `src/lane/processes.ts`: `ProcessTable`, `createPsProcessTable` (the default) and `readPidFile`, as a model.
- `src/lane/lane-store.ts`: `laneLayout`. Add `lock: join(laneDir, "lane.lock")`, and add `lane.lock` to the module doc's layout list.
- `src/cli/lane-install.ts`: `laneInstall` step 1 (name checks next to the coordinator-name checks), `LANE_NAME`, `COORDINATOR_LANE`, and `withLane` (where the replace happens).
- `src/core/lane/launchd.ts`: `plistEnv`, the source of the plist's `PATH`. `src/core/schemas/ledger.ts:108`: the ledger lane-name regex the builder check mirrors.
- `src/lane/commit.ts`: `CommitOutcome` (add `start` to `conflict`) and `commitSession` (it has `start` from the marker). `src/lane/committer.ts`: `createGitCommitter`, which computes the merge base from `start`. Committing onto `start` gives base = start.
- `src/lane/pr-step.ts`: step 3, `if (c.kind === "conflict") return await failed(...)`. Refactor the outcome handling so it can run twice.
- Other `c.kind === "conflict"` readers (planning, retro, retro-item, reconcile commit) only need the type to compile. Fake committers in tests that return `conflict` need a `start`.
- `src/lane/ci-step.ts`: `decide` → `needs-session` → `session(..., "conflict session")` and `ciFix` with `CI_FIX_CAP`. This path is unchanged; the fallback relies on it.
- Tests:
  - `test/cli/lane-fixture.ts`: `world()` sets `PATH: "/usr/bin:/bin"`. Give it a temp bin folder holding executable stubs for `claude`, `bun` and `uv`, plus a symlink `git` to the test's own `Bun.which("git")`, first on `PATH`, so every existing install test passes the tool check.
  - `test/cli/lane-install.test.ts`: `install()` and `ONE_BUILDER`, which uses the name `builder-0`. That is fine, because only the installed name is checked.
  - `test/cli/lane-run.test.ts`: `laneRunWith` and the STOP tests at line ~131, plus the coordinator tests at ~364.
  - `test/lane/pr-step.test.ts:103`: `stubCommitter`.
  - `test/lane/lane-process.test.ts`: the harness at lines ~120–300, with `mainFiles` (disjoint globs `src/s<i>/**`), `finishes` and stub sandbox `Behavior`s.
  - `test/lane/coordinator-process.test.ts:~90–130`: the coordinator harness.
  - `test/lane/planning-step.test.ts:~220,594`: a stub committer that runs the real `checkWrite` over the session's changed paths, the model for the race test.
  - `test/core/lane/` for case tables.

## Tasks & Acceptance

**Execution:**
- `src/core/lane/lane-lock.ts` (new) -- add `LANE_LOCK_FILE`, `laneLockText`, `parseLaneLock` and `lockVerdict(lock, info)` → `live` | stale with its `PidCheck` reason -- the pure lock rules.
- `src/lane/lane-lock.ts` (new) -- add `acquireLaneLock({ laneDir, pid, command, startedMs, table })`. It returns `acquired` (with `tookOver` and `release()`), `held` (with the holder's PID) or an `io` error, as above -- the exclusive lock.
- `src/lane/lane-store.ts` -- add `layout.lock`.
- `src/cli/lane-run.ts` -- take and release the lock as above, and update the module doc -- AR3.
- `src/cli/lane-install.ts` -- add the builder-name, other-repo and tool checks, and update the module doc -- AR35 and the `PATH`.
- `src/lane/commit.ts`, `src/lane/committer.ts`, `src/lane/pr-step.ts` -- carry `start` on a conflict and add the PR step fallback, then update the PR step doc -- AR16/AR20.
- `docs/maintainer/self-host.md`:
  - Step 13: install now refuses a bad builder name and missing tools. Drop "Until Story 2.11 …" and "Any other name passes …".
  - Add a "Several builder lanes" bullet under "While Epic 2 is built", covering:
    - the limit stays 1 until Epic 3 (Story 2.12's evidence first);
    - then `lane install builder-2 …` with `XARABOT_MAX_BUILDERS=2` on every lane's install;
    - each lane has its own folder, clone and job;
    - `lane.lock`, and what a second start prints;
    - `touch ~/.xarabot/STOP` stops every lane after its unit;
    - a commit conflict opens the PR and goes to a conflict session counted in `ci_fixes`.
- Tests:
  - `test/core/lane/lane-lock.test.ts`: a case table for text, parse and verdict;
  - `test/lane/lane-lock.test.ts`: real filesystem, with a stub `ProcessTable` and one real-`ps` case using `process.pid`;
  - lane-run rows for the lock, plus a coordinator host-STOP row;
  - lane-install rows;
  - pr-step conflict rows;
  - a lane-process "STOP mid-unit" row;
  - `test/lane/several-lanes.test.ts` (new): the race row, with two `runLaneProcess` (`builder-1`, `builder-2`, their own lane folders) and one `runCoordinatorProcess` on one fake forge, using the real `createPrStep` with the `checkWrite` stub committer.

**Acceptance Criteria:**
- Given a running lane, when a second `xarabot lane run` of the same lane starts, then it exits 0 without connecting or claiming and leaves `failed-starts` as it was.
- Given a commit conflict onto fresh `main`, when the builder's PR step commits, then the PR is pushed with no attempt counted. The CI step's merge of `main` then starts a conflict session that counts 1 in `ci_fixes`.
- Given `bun test`, `bun --bun tsc` and `bun --bun oxlint`, when run, then they report 0 fail and no error.

## Spec Change Log

## Review Triage Log

### 2026-10-25 — Review pass
- verdicts: 28 findings — high 0, medium 4, low 22, false 2, maybe-false 0
- findings:
  - `[medium]` `[patch]` (intent) The commit-conflict fallback opens the PR first and leaves the conflict session to the CI step's merge, and no test shows the real merger conflicting on the fallback head. — Same root cause as the blind row on the untested end-to-end claim; patched there with a real-git test.
  - `[low]` `[reject]` (intent) No test runs two separate OS processes contending for `lane.lock`. — The real-`ps` host tests check the cross-PID verdict with `process.pid`. A second OS process differs only in its PID, and spawning one is a heavier harness for no new branch.
  - `[low]` `[reject]` (intent) The race test runs in one Bun process with stub workspace, sandbox and committer, and a stub `reconcile`. — The AC sets its surface as "against the fake forge". The committer runs the real `checkWrite`, and the claims are the real CAS on the fake forge.
  - `[low]` `[reject]` (intent) There is no coordinator mid-unit STOP row, and "finishes its current unit" means through this process's PR step. — The coordinator checks STOP only at round start, as the builder does; the builder row covers that shape. Each lane process runs one unit per start (AR3).
  - `[false]` `[reject]` (intent) Names are unique per host, not per (host, repo) pair. — `host.yaml` keys lanes by bare name, and the spec forbids a schema change. Per-host uniqueness satisfies "unique per host and repo".
  - `[low]` `[reject]` (intent) `epic-2-context.md` is rewritten outside the task list. — This is step-01's recompile of a stale context file. The builder write check reverts any Epic context change before the squash.
  - `[low]` `[reject]` (blind) A `ps` failure makes `inspect` return `null`, so a live lock reads as `gone`. — `ps` is `/bin/ps`, always on a launchd `PATH`. A spawn failure is not an everyday event, and the fix adds a second process probe and a branch.
  - `[low]` `[reject]` (blind) A three-process race can drop the restored winner's lock (EEXIST on the link-back). — This needs three starts of one lane at once on a stale lock, while launchd runs one instance per job. The fix adds more branches to the takeover.
  - `[medium]` `[patch]` (blind) The runbook installs `builder-2` before raising `builder-1`'s plist limit. `builder-1` then fails each start, and the third writes its STOP. — Reordered: reinstall and reload the existing builders with `XARABOT_MAX_BUILDERS=2` first, then install `builder-2`.
  - `[medium]` `[patch]` (blind) The runbook's `launchctl bootout` SIGTERMs a running lane mid-unit. — Now drain first: `xarabot stop <lane>`, wait for its outcome, bootout, bootstrap, then remove the lane's STOP.
  - `[low]` `[patch]` (blind) The runbook reinstalls the coordinator for a limit it ignores. — Dropped the coordinator from the reinstall step.
  - `[low]` `[reject]` (blind) `LANE_TOOLS` always requires `claude`, whatever `--agent` says. — Only `claude` has an adapter until Epic 6, and `lane run` refuses any other agent. Deriving the tool from the adapter adds plumbing for a case no one meets yet.
  - `[low]` `[patch]` (blind) The race test never shows that both builders worked. — Added an assertion that each builder claimed and sessioned at least one Story, with a fixed interleaving.
  - `[medium]` `[patch]` (blind) The key claim that the fallback head conflicts with `main` as the commit did is never tested end to end. — Added a real-git test: a commit conflict onto `main`, then the commit onto `start`, then `createGitMerger` gives `needs-session` on the same paths.
  - `[low]` `[reject]` (blind) The fallback PR's text and status comment do not say it conflicts. — The CI step's conflict session follows in the same run. Naming the paths needs new comment parameters for a short-lived state.
  - `[low]` `[patch]` (blind) SIGTERM leaves `lane.lock` behind, and the next start reports a stale takeover. — The runbook now says this takeover is expected after a bootout or `stop --now`.
  - `[low]` `[reject]` (blind) The Epic context says "unique per host and repo" while the code is unique per host. — The code's rule is stricter, so it satisfies the context's rule; the context file is generated.
  - `[low]` `[reject]` (blind) The spec says every install check runs before `host.yaml` is read, but the other-repo check reads it. — The fix would edit this build's spec. The code runs the check after the read and before any write or connect.
  - `[low]` `[reject]` (blind) `Bun.which` resolves relative `PATH` entries against the install's working directory, not the job's `HOME`. — A relative entry in a lane's `PATH` is not everyday use, and refusing such entries adds a branch.
  - `[low]` `[patch]` (blind) A duplicate malformed row in `test/core/lane/lane-lock.test.ts`. — Deleted it.
  - `[low]` `[reject]` (verification-gap) The retry-create EEXIST branch after a stale takeover is never run by a test. — Reaching it deterministically needs an injected filesystem seam between the aside removal and the retry. The race needs two simultaneous takeovers of one lane's stale lock.
  - `[low]` `[reject]` (verification-gap) After the fallback, an empty park says "the commit onto main is empty", and the `[CONFLICT, empty|refused]` rows pin orders real git does not produce. — Real `commitSession` reports `empty` and `refused` before `merge-tree`, so this cannot happen with git. The rows pin the defensive handling.
  - `[low]` `[reject]` (edge) A `ps` failure reads a live lock as `gone`. — Same as the blind row.
  - `[low]` `[reject]` (edge) EEXIST on the restore drops the winner's lock. — Same as the blind row.
  - `[low]` `[reject]` (edge) A non-EEXIST `link` error on the restore leaves `lane.lock` missing while its owner runs. — This needs a filesystem failure in the lane folder inside a takeover race. That process ends as a failed start.
  - `[low]` `[reject]` (edge) Relative `PATH` entries. — Same as the blind row.
  - `[low]` `[reject]` (edge) The recompiled `epic-2-context.md` drops the "Blocked resume" and "Host rulings" decisions. — The compile rule scopes aggressively, and those decisions stay in their Story specs. The builder write check reverts the file before the squash.
  - `[false]` `[reject]` (edge) `acquireLaneLock` also returns `invalid`, which the spec does not list. — The only caller, `laneRun`, branches on `!locked.ok`, so every error kind is a failed start; no caller misses it.

## Design Notes

- **Why fall back onto `start`?** Committing onto the session's start can never conflict, and the PR head then conflicts with `main` exactly as the commit did: the same three-way merge, from the same base. The CI step already merges `main` into a conflicting PR, resolves status YAML and lockfiles, and otherwise runs a conflict session counted in `ci_fixes` (AR20). The fallback reuses that path instead of adding a second conflict session in the PR step. A conflict is then never a failed attempt.
- **Why `link` from a temp file?** An `O_EXCL` create leaves a moment where the lock exists but is still empty, and a racing reader would judge an empty lock malformed and so stale. A `link` publishes the whole text atomically.
- **The recorded start is the process start** (`performance.timeOrigin`), so `checkPid`'s `started-later` test (lstart > recorded + 1 s) catches a reused PID, exactly as `stop --now` does.

## Verification

**Commands:**
- `bun test` -- expected: 0 fail (live cases skipped)
- `bun --bun tsc` -- expected: no error
- `bun --bun oxlint` -- expected: no warning or error

## Auto Run Result

Status: done

**Summary.** One host can now run several builder lanes safely.
- **`lane.lock`.** `xarabot lane run` holds the lane's exclusive `lane.lock` for the whole run: its PID, runtime and process start, created whole through a temp file and `link`.
  - A second process of the same lane exits 0 with no connect, no claim and no failed start.
  - A lock whose process is gone, whose PID was reused or runs another command, or whose text does not parse is taken over, using the start-time check `stop --now` uses.
  - The lock is released on every exit.
- **`xarabot lane install`** refuses:
  - a builder name other than `builder-<n>` (n ≥ 1);
  - a name `host.yaml` already holds for another repo;
  - an install where `claude`, `bun`, `git` or `uv` does not resolve on the `PATH` it writes into the plist. It names each missing tool.
- **Commit conflicts.** When a builder's change conflicts with fresh `main` at commit time, the PR step commits onto the session's start instead and opens the PR. The CI step's merge of `main` then runs a conflict session counted in `ci_fixes`, never a failed attempt.
- The builder limit and the host `STOP` already existed. They gain tests: a host STOP at a coordinator's start, and a STOP written mid-unit.
- A fake-forge test runs two builders and a coordinator concurrently.

**Files changed.**
- `src/core/lane/lane-lock.ts` (new): the lock text, its parse, the live/stale verdict (`checkPid`) and the stale reasons in words.
- `src/lane/lane-lock.ts` (new): `acquireLaneLock`, which creates the lock whole, takes over a stale one with a rename-and-compare, and releases only the process's own lock.
- `src/lane/lane-store.ts`: `layout.lock`.
- `src/cli/lane-run.ts`: takes the lock after the STOP and role checks, runs steps 3–6 under `try`/`finally`, and gains the `LaneRunDeps.lock` seam.
- `src/cli/lane-install.ts`: `BUILDER_LANE`, `LANE_TOOLS`/`missingTools`, and the other-repo name refusal.
- `src/lane/commit.ts`, `src/lane/committer.ts`: a `conflict` outcome carries the session's `start`.
- `src/lane/pr-step.ts`: the conflict fallback onto `start`.
- `docs/maintainer/self-host.md`:
  - step 13 (the install checks);
  - a new "Several builder lanes" bullet: the limit stays 1 until Epic 3, the order to reinstall and drain, `lane.lock`, the host STOP, and conflicts as CI fixes.
- Tests:
  - new: `test/core/lane/lane-lock.test.ts`, `test/lane/lane-lock.test.ts` and `test/lane/several-lanes.test.ts`;
  - new rows in `lane-run`, `lane-install`, `pr-step`, `lane-process`, `committer` (a real-git conflict, then the commit onto the start, then the real merger's `needs-session` on the same paths) and `ci-step` (the conflict-session end to end);
  - `test/cli/lane-fixture.ts` puts stub tools on `PATH`;
  - adapted rows in `main`, `commit`, `planning-step` and `lane-store`.

**Review findings.** One pass, 28 findings: 4 medium, 22 low, 2 false.
- **Patched:**
  - medium:
    - the runbook order, which would fail the existing builder's starts until it wrote its STOP;
    - the runbook's reload, which SIGTERMed a running lane (now drained first);
    - the untested claim that the fallback head conflicts as the commit did (now a real-git test, together with the intent-alignment row).
  - low:
    - the needless coordinator reinstall;
    - an assertion that both builders worked in the race test, now deterministic;
    - the runbook note on a lock left after SIGTERM;
    - a duplicate test row.
- **Deferred:** none.
- **Rejected**, each with its reason in the Review Triage Log:
  - low:
    - a `ps` failure reading a live lock as gone (blind, edge);
    - the three-process restore race (blind, edge);
    - a non-EEXIST restore error;
    - the retry-create EEXIST branch untested (it needs a filesystem seam);
    - the empty-park reason after the fallback;
    - `LANE_TOOLS` fixed to `claude`;
    - the fallback PR not saying it conflicts;
    - relative `PATH` entries (blind, edge);
    - the Epic context's uniqueness wording;
    - the spec's check-order sentence;
    - no two-OS-process lock test;
    - the stubbed race harness;
    - no coordinator mid-unit STOP row;
    - the recompiled Epic context (intent, edge).
  - false:
    - per-(host, repo) name uniqueness;
    - the `invalid` error kind.

**Follow-up review recommended:** true. Patched: 0 high, 3 medium, 4 low (entries).
- The unverified risk is the lock's rarest race branches: the retry after a takeover and the restore after a mismatched rename. They run in no test.
- The new reload procedure in the runbook has not been exercised on the host.

**Verification.**
- `bun test`: 4096 pass, 283 skip, 0 fail. The 3 new `hostTest` rows that use real `ps` skip in this sandbox; their matrix rows are also covered by stub-table tests that ran.
- `bun --bun tsc`: exit 0.
- `bun --bun oxlint`: exit 0.
- Matrix audit: every I/O & Edge-Case Matrix row is covered by a test that ran and passed. Two rows rely on existing tests: the limit across repos (`lane-run` "builders over the limit") and a builder's host STOP at start.

**Residual risks.**
- **Live behaviour is untested.** The lock is exercised through stub and real-`ps` tables in one process, and the race on the fake forge. Story 2.12 is the live proof.
- **A lock left by a signal.** A lane killed by SIGTERM leaves `lane.lock`, and the next start takes it over as stale (documented).
- **Fallback scope.** The fallback is builder-only. Planning, retro, retro-item and `reconcile` commit conflicts are still failed attempts.
- **Not committed.** The task rules require the changes to stay in the working tree, so the stock finalize commit and the clean-tree check were not done. `epic-2-context.md` holds step-01's recompile of a stale context file; the runner reverts any session change to an Epic context file before the squash.
