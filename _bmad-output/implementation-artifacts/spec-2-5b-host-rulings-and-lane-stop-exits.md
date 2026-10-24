---
title: 'Story 2.5b: Host rulings and lane-stop exits'
type: 'feature'
created: '2026-10-24'
baseline_revision: 'f711931878f3a0591363f4eff768a85469037655'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
warnings: ['oversized', 'multiple-goals']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Two gaps remain from Story 2.5a.
- Releasing a parked unit takes a hand-written ledger commit (F4).
- A lane that meets a lane-stop condition ends `stop` but exits 0. launchd restarts it forever into the same failure, and the failed-start count resets before each run, so it never reaches 3 (F10, retro A5).

Three smaller gaps sit in the same area:
- An unmapped 4xx, or a push a GitHub rule refuses, maps to `forbidden`, which stops the lane instead of failing the unit's attempt.
- A heartbeat beat that meets a lane-stop condition retries until the lapse, so a usage-limit sleep runs on (retro C3).
- `applyRuling` requires the coordinator role.

**Approach:**
- Add `xarabot rule release|rebuild <unit-id>`: one fenced `applyRuling` ledger edit, with no coordinator role required.
- Count a run's lane stop as a failed start, after the run.
- Add the forge error kind `rejected`.
- Give the heartbeat keeper a `stop` end that aborts its signal, and so the sleep.

## Boundaries & Constraints

**Always:**
- **`applyRuling`** (pure, `src/core/ledger/edits.ts`) drops `requireCoordinator`. It stays the same edit:
  - `parked` only, at the record's `generation`;
  - `release` and `rebuild` set `attempts`, `loopbacks` and `ci_fixes` to 0;
  - `rebuild` also clears `builder_providers`, `reviewed_sha`, `passed_sha` and `approved_sha`;
  - `approve` is unchanged.
- **`xarabot rule <verb> <unit-id> [--repo <owner>/<name>]`** (`src/cli/rule.ts`; `main.ts` dispatches `rule`):
  - **Verb.** Any verb other than `release` or `rebuild` exits 1 with `<verb>: not before Story 4.6`, before any file or forge access. A unit id that is not one (`isUnitId`) is a usage error, exit 1.
  - **Repo.** Read `host.yaml` (it needs `host_id`). The repo is `--repo`, or the only repo among its lanes. Several repos and no `--repo`, or a `--repo` no lane has, is refused, exit 1.
  - **Writer identity.** `<lane owner>/<host_id>/<lane>`, where the lane is the repo's `coordinator` lane if `host.yaml` has one, else its lowest-numbered `builder-<n>`. A non-`story` unit with no coordinator lane on the host is refused, because `next` counts coordinator PRs only on records whose `lane` is `coordinator`.
  - **Forge.** Injectable; the default is GitHub with that lane owner's App credentials, as `stop --now` uses.
- **The ruling** (`applyHostRuling`, new `src/lane/rule.ts`):
  1. Take one snapshot.
  2. With no record, refuse with `<unit> has no ledger record`. In any state but `parked`, refuse with `<unit> is <state>, not parked`. Either way the ledger is unchanged.
  3. `rebuild` only: when the record's `pr` is set and the snapshot shows that PR `open`, close it (`closePr`) before the edit. A failed close refuses, with the ledger unchanged.
  4. One `swapLedger` of `applyRuling({ unit, by, now: snap.now, generation: rec.generation, ruling })`. The generation and state re-check on each re-fetched tip is the fence.
  5. Report the unit, its generation and any closed PR.

  Each forge call and the swap has a deadline (default 60 s). Output: `closed PR #<n>` when one was closed, then `released <unit> (<park kind>[ <reason>])`, exit 0. Any failure prints its reason, exit 1.
- **Lane-stop outcome.** A run whose outcome is `stop` for any reason other than a STOP marker is a lane stop. STOP markers are the host or lane `STOP` seen by `checkStop`, and a STOP during a usage-limit sleep.
  - `LaneProcessResult` gains optional `laneStop?: string`, the stop's reason, set by `runLaneProcess` and `runCoordinatorProcess`.
  - The journal and `outcome` file still say `stop`.
- **`lane run` counting:**
  - The reset of `failed-starts` to 0 moves from "the start passed" to after the run, for a run with no `laneStop`.
  - A run with `laneStop` goes through `failedStart`: exit 1, the count + 1, and at the 3rd in a row the lane's `STOP` and one `lane-start-failed` alert on the alert forge.
  - Both roles count this way. A start check that heals before the 3rd lets the next start run, and that run, if it ends without a lane stop, resets the count.
- **Forge kind `rejected`** (`FORGE_ERROR_KINDS`). It is neither a lane-stop kind nor a back-off kind, so every step's generic failure path fails the unit's attempt (`failAttempt`: `released`, `attempts` + 1, parked at the cap).
  - GitHub `mapHttpError`: every 4xx that no earlier rule maps becomes `rejected` (400, 409/422 without `conflictOn`, 418, 429 without rate-limit headers, …). 401, 403, 404 and the rate limits are unchanged.
  - `mapPushResult`: a `[remote rejected]` ref line becomes `rejected`, except a lock, which stays `transient`.
  - The fake forge gains `control.refusePushes(branch)`: later pushes to that branch return `rejected` and move nothing.
- **Contract:** a new control `refusePushes` and a scenario "a push a rule refuses is rejected and moves nothing", passed by the fake. The GitHub emulator implements the control as a `pre-receive` hook in the git server's bare repo, which refuses the listed refs.
- **Keeper `stop` end** (`src/lane/heartbeat.ts`). A beat whose swap fails with a forge lane-stop kind, or with the edit error `stop`, ends the keeper with `{ kind: "stop", condition, message }`. `condition` is `forge-<kind>` or `ledger-schema-version`. The end aborts the keeper's signal, so the usage-limit wait ends at once, and with it any session.
  - `checkHeld` (lane process) and `checkClaim`/`checkUnit` (coordinator) become async. For this end, each calls its `laneStop(condition, "heartbeat: …")`: the alert, then outcome `stop` with `laneStop` set. The record is left as is, as for every lane stop.

**Never:**
- No ledger schema change, no new `Forge` operation, no `.github/`, `.xarabot/` or `AGENTS.md` change.
- No other ruling verb, no inbox or comment rulings (Story 4.6), no `lane.lock` (Story 2.11), no `branchHead` (Story 2.6b), no `TMPPREFIX` (Story 2.5c).
- No change to how a STOP marker ends a run (exit 0, nothing counted).
- No change to GraphQL error mapping, or to the adapter's own local `forbidden` refusals (reserved branch, no `runner.git`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Release | `parked` blocked, attempts 2, loopbacks 1, ci_fixes 1, providers `[claude]` | `released`, counters 0, providers kept, park null, generation unchanged | exit 0 |
| Rebuild | `parked` awaiting-approval, PR #7 open, SHAs set | PR #7 closed, then `released`, counters 0, providers `[]`, SHAs null | close fails: exit 1, ledger unchanged |
| Not parked | `claimed` / `merging` / `released` / `merged` / none | `story:2.6 is claimed, not parked` / `has no ledger record` | exit 1, ledger unchanged |
| Other verb | `rule approve story:2.6`, `rule go checkpoint:2` | `approve: not before Story 4.6` | exit 1, no forge call |
| Race | generation moves between snapshot and swap | edit precondition | exit 1, nothing written |
| Lane stop ×3 | 3 starts, each run's snapshot `auth` | counts 1, 2, then `STOP` + `lane-start-failed`, count 0; 4th start exits 0 on STOP | — |
| Heals | lane stop, lane stop, then an idle run | count 1, 2, then 0 | — |
| STOP marker | run ends `stop` on lane `STOP` | exit 0, count reset | — |
| Unmapped 4xx | 422 on createCommit | `rejected` | step fails the attempt |
| Rule push | `! … [remote rejected] (push declined due to repository rule violations)` | `rejected`; PR step: `released`, attempts + 1 | — |
| Keeper stop | beat `auth` during usage-limit sleep | sleep ends at once, `forge-auth` alert, outcome `stop` with `laneStop`, no second session | — |

</intent-contract>

## Code Map

- `src/core/ledger/edits.ts` ~l.660 `applyRuling`: remove the `requireCoordinator` call; update its doc comment ("any lane identity: the coordinator's comment rulings (4.6) or the Maintainer's `xarabot rule`").
- `src/ports/forge.ts` -- `FORGE_ERROR_KINDS` + `"rejected"`; the header comment.
- `src/adapters/forge/github/http.ts` ~l.198 `mapHttpError`: `status >= 400 && status < 500` → `rejected` before the final fallback (which stays `forbidden` for non-4xx).
- `src/adapters/forge/github/github-forge.ts` ~l.206 `mapPushResult`: `remote rejected` → `rejected` (lock → `transient`).
- `src/adapters/forge/fake/fake-forge.ts` -- `FakeForgeControl.refusePushes(branch)`; `pushBranch` checks the set after the reserved-branch check.
- `test/contracts/forge.contract.ts` -- `ForgeContractControls.refusePushes`; a scenario under pushBranch (~l.375): after `refusePushes("story/2.9")`, a push to `story/2.9` is `rejected` and creates no branch (`openPr` on it is `not-found`), and a push to `story/2.8` still succeeds.
- `test/contracts/forge.contract.test.ts` -- `CONTROLS.refusePushes`; `test/contracts/forge.github.contract.test.ts` -- emulator `refusePushes` via `server.refuse(branch)`; live harness lacks it (skipped).
- `test/adapters/forge/github/git-server.ts` -- `GitServer.refuse(branch)`: writes `hooks/pre-receive` (sh, reads `$GIT_DIR/refused-refs`, exits 1 on a listed ref) and appends `refs/heads/<branch>`.
- `src/lane/heartbeat.ts` -- `KeeperEnd` + `{ kind: "stop"; condition; message }`; in `loop`, after the precondition check: `e.kind === "forge" && isLaneStopKind(e.forge.kind)` → `forge-${kind}`, `e.kind === "edit" && e.edit === "stop"` → `ledger-schema-version`; `finish` aborts for every kind but `moved-on` already.
- `src/lane/lane-process.ts`:
  - `LaneProcessResult` (l.181) + `laneStop?: string`;
  - `checkStop` (l.366): marker stops throw `MarkerStop extends Halt`;
  - `stopAfterLimit` (l.789) sets a run-level `markerStop = true`;
  - `checkHeld` (l.399) async, with the `stop` end → `laneStop`; each `checkHeld(t)` call → `await` (l.431, 634, 638, 663, 772, 894, 938, 982);
  - the end (l.1246-1314): `laneStop = outcome === "stop" && !markerStop ? (unit reason ?? Halt reason) : undefined`.
- `src/lane/coordinator-process.ts` -- the same `MarkerStop`, `laneStop` result, and async `checkClaim`/`checkUnit` (l.272-289, calls l.319, 408, 421, 422).
- `src/cli/lane-run.ts` -- drop the pre-run reset (l.253-259); after both `start` calls: `laneStop` → `failedStart(\`lane stop: ${reason}\`)`, else reset and return 0. `failedStart`'s message prefix becomes a parameter ("start refused" / "run ended in a lane stop"). Update the header comment.
- `src/lane/rule.ts` (new) -- `applyHostRuling`, modelled on `releaseHeld` in `src/lane/stop.ts` (snapshot, `parseLedger`, `swapLedger`, deadlines).
- `src/cli/rule.ts` (new) -- `RULE_USAGE`, `ruleCommand(args, deps: { env, forge?, out?, errOut? })`; reuse `hostPaths`, `readHostConfig` (`src/cli/host-paths.ts`) and `githubForge`'s pattern in `src/cli/lane-commands.ts`; `src/cli/main.ts` dispatch and `USAGE`.
- `docs/maintainer/self-host.md` "While Epic 2 is built" -- a "Releasing a parked unit" bullet (commands as `edanisko-xarabot`, release vs rebuild, refusals, takes effect once `runner_version` has 2.5b, replaces the hand ledger commit); a "Lane stops" note (exit 1, counted, 3rd writes STOP + `lane-start-failed`; remove the lane `STOP` once fixed).
- Tests:
  - `test/core/ledger/edits.test.ts` l.275-298: "applyRuling by a builder" becomes a success row; add `rebuild` from each park kind and a refusal row for every non-`parked` state and for no record.
  - `test/ports/forge.test.ts` -- `AR33Kinds` + `rejected`; it is neither lane-stop nor back-off.
  - `test/adapters/forge/github/http.test.ts` l.28-102 -- the unmapped-4xx rows become `rejected` (403 stays `forbidden`).
  - `test/adapters/forge/github/push.test.ts` l.244 -- the rule row becomes `rejected`; add a lock row (`transient`) and a "repository rule violations" row.
  - `test/adapters/forge/fake-forge.test.ts` -- `refusePushes`.
  - `test/lane/pr-step.test.ts` ~l.678 -- `test.each(FORGE_ERROR_KINDS)` on `pushBranch`: lane-stop kinds stop with the alert and leave the record; every other kind (with `rejected`) is a failed attempt, `released`, attempts + 1.
  - `test/lane/heartbeat.test.ts` -- beat `auth`/`forbidden`/`uninstalled` → end `stop` `forge-<kind>`, signal aborted, no release; edit `stop` → `ledger-schema-version`; `rejected` still retries.
  - `test/lane/lane-process.test.ts` ~l.1117 -- keeper `stop` in a usage-limit sleep; `laneStop` set for a forge-auth stop and absent for a STOP marker and a usage-limit STOP.
  - `test/lane/coordinator-process.test.ts` -- `laneStop` on a forge lane stop, absent on a STOP marker.
  - `test/cli/lane-run.test.ts` -- three restarts through real `runLaneProcess` with a forge whose `snapshot` returns `auth`; the heal row; the STOP-marker row; the coordinator row; the "passing start" row now resets after the run.
  - `test/lane/rule.test.ts` and `test/cli/rule.test.ts` (new) -- the matrix rows against the fake forge, plus the repo and identity choice rows.
  - `test/cli/main.test.ts` -- `rule` dispatch.
- Baseline at `f711931` (after `bun install --frozen-lockfile`): 3043 pass, 73 fail, 162 skip. All 73 failures are sandbox-only (socket binding, `ps`/`kill`); compare by name with `../tmp/baseline-fails.txt`. The emulator contract and git-server push tests are among them, so the emulator `refusePushes` case cannot run here.

## Tasks & Acceptance

**Execution:**
- `src/core/ledger/edits.ts` -- drop the coordinator requirement from `applyRuling` -- AC "no longer requires the coordinator role".
- `src/ports/forge.ts`, `src/adapters/forge/github/http.ts`, `src/adapters/forge/github/github-forge.ts`, `src/adapters/forge/fake/fake-forge.ts` -- kind `rejected` and its mappings; `refusePushes` -- AR33.
- `test/contracts/*`, `test/adapters/forge/github/git-server.ts` -- the contract control and scenario on the fake and the emulator.
- `src/lane/heartbeat.ts` -- the `stop` end -- AR23.
- `src/lane/lane-process.ts`, `src/lane/coordinator-process.ts` -- `MarkerStop`, `laneStop` in the result, async checks with the `stop` end.
- `src/cli/lane-run.ts` -- lane stops counted after the run.
- `src/lane/rule.ts`, `src/cli/rule.ts`, `src/cli/main.ts` -- the command.
- `docs/maintainer/self-host.md` -- the ruling and lane-stop notes.
- Tests listed in the Code Map, covering every matrix row.

**Acceptance Criteria:**
- Given a `parked` record, when the Maintainer runs `xarabot rule release <unit-id>` as the lane user, then one ledger commit makes it `released` with `attempts`, `loopbacks` and `ci_fixes` 0 and `builder_providers` kept.
- Given a `parked` record with an open PR, when the Maintainer runs `xarabot rule rebuild <unit-id>`, then the PR is closed, `reviewed_sha`, `passed_sha` and `builder_providers` are cleared, the counters are 0 and the record is `released`.
- Given a record in any other state, no record, or another verb, when `xarabot rule` runs, then it exits 1 naming the state (or "not before Story 4.6") and the ledger is unchanged.
- Given three launchd-style starts whose runs each end in a lane stop, when each `xarabot lane run` exits, then the exits are non-zero, `failed-starts` reads 1 then 2, the 3rd writes the lane's `STOP` and posts `lane-start-failed`, and a 4th start exits 0 on STOP.
- Given an unmapped 4xx or a rule-refused push, when the adapter maps it, then the kind is `rejected` and the PR step fails the attempt (`released`, `attempts` + 1); the contract scenario passes on the fake.
- Given a beat failing `auth` during a usage-limit sleep, when it happens, then the sleep ends at once and the run ends a lane stop.
- Given `bun test`, when it runs, then no failure falls outside the baseline's sandbox-only set, and `bun --bun oxlint` and `bun --bun tsc` exit 0.

## Spec Change Log

## Review Triage Log

### 2026-10-24 — Review pass
- verdicts: 29 findings — high 0, medium 1, low 21, false 7, maybe-false 0 (the pre-verified verification gap is counted as low)
- findings:
  - `[low]` `[patch]` (verification-gap 1) The `stop` branch in the coordinator's `checkUnit` is never reached by a test. The existing keeper-stop test fails the `coordinator.json` keeper's beat, so deleting the `checkUnit` line passes the suite. -- Pre-verified. Added a coordinator-process test in which only the unit keeper's beat fails.
  - `[low]` `[reject]` (verification-gap other 1) Dropping `requireCoordinator` also lets any lane identity apply `approve`. -- The AC drops the role check from the edit as a whole. No caller applies `approve` before Story 4.6, whose comment rulings decide who may approve, and the CLI refuses the verb. A role check for one verb adds a branch for a path nobody reaches.
  - `[low]` `[reject]` (verification-gap other 2) The emulator `refusePushes` contract case has never passed: it fails in the sandbox on `listen`, like the other 31 emulator cases. -- Running it needs sockets, which this sandbox denies. The subagent checked the `pre-receive` hook by hand: a push to a local bare repo was answered `[remote rejected] (pre-receive hook declined)`, which maps to `rejected`. CI's `bun test` will run it first. Listed as a residual risk.
  - `[false]` `[reject]` (blind 1) `rebuild` checks the snapshot's PR state but closes `rec.pr`, so the two numbers can differ. -- The snapshot's `prs[unit]` is read from the record's own `pr` (`github-forge.ts:414`, `fake-forge.ts:235`), so they are always the same PR. The record-has-no-PR half is edge 4.
  - `[medium]` `[patch]` (blind 2) Until Story 2.6b, a rebuilt Story whose branch exists conflicts on every push and re-parks at `attempts-cap`, and the docs do not say so. -- Confirmed. After a closed PR, `decidePr` gives `none`, so the claim's `head_sha` is null and the push lease expects no branch. The runbook now says to delete the Story's branch after `rebuild` until Story 2.6b.
  - `[low]` `[reject]` (blind 3) A ledger that refuses every write with an unmapped 4xx now fails attempts instead of stopping the lane, and restarts with no alert. -- AR33 maps an unmapped 4xx to `rejected`, which fails the unit's attempt, for every operation. A ruleset refusing `xarabot/claims` is a Human Live Step checked at lane start. Changing the kind for ledger calls needs a Maintainer decision. Listed as a residual risk.
  - `[low]` `[reject]` (blind 4) A 429 without rate-limit headers, a 408 and a 425 now cost an attempt. -- The AC sends every unmapped 4xx to `rejected`. Before this change these statuses stopped the lane (`forbidden`), so failing the attempt is milder.
  - `[low]` `[reject]` (blind 5) A run that throws is neither counted nor reset. -- `runLaneProcess` and `runCoordinatorProcess` catch every error by design. Before this change a thrown run was not counted either, and the fix adds a new branch.
  - `[low]` `[reject]` (blind 6) Any lane identity can now apply `approve`. -- Same as verification-gap other 1.
  - `[low]` `[patch]` (blind 7) The runbook does not say what to do when `rebuild` closes the PR but the edit fails. -- The runbook now says to run the same command again: the re-run finds the PR closed, skips the close and makes only the edit.
  - `[low]` `[patch]` (blind 8) `test/lane/rule.test.ts` has no row for a swap failure after a close, and no `rebuild` assertion that `approved_sha` is cleared. -- Both rows added. The rows for a merged-PR close conflict, the deadline and an unparseable ledger were not added: those paths go through the same `err` returns.
  - `[low]` `[reject]` (blind 9) The contract covers only a rule-refused push, not an unmapped 4xx, and the emulator case is unverified. -- The AC asks for "a case for it", meaning the kind. The unmapped 4xx is covered by the `mapHttpError` table. The unverified part is the same as verification-gap other 2.
  - `[low]` `[patch]` (blind 10) The `laneStop` text puts the unit's accumulated reasons before the stop's own cause. -- Both processes now prefer the `Halt` reason over the unit's reason.
  - `[low]` `[reject]` (blind 11) The spec's Code Map shows a doubled "lane stop" prefix and names a lane-local baseline path. -- The fix would edit this spec. The code prints the reason once.
  - `[false]` `[reject]` (blind 12) The command does not print the generation. -- The spec fixes the output line as `released <unit> (<park kind>[ <reason>])`. Step 5's report, which includes the generation, is `applyHostRuling`'s return value.
  - `[low]` `[reject]` (blind 13) The "Lane stops" note leaves out the carry-over after `stop --now`, the unreadable-marker case, and whether to reset `failed-starts` when removing STOP. -- `failedStart` already writes 0 when it writes STOP, so there is nothing to reset. The other two are edge details recorded in the Design Notes.
  - `[low]` `[reject]` (edge 1) A lapse release whose swap fails with a lane-stop kind ends `lapsed`, not `stop`. -- It needs beats that fail with a non-lane-stop kind and then a release that meets a lane-stop kind, because a lane-stop beat now ends the keeper at once. The fix adds a branch for a rare sequence.
  - `[low]` `[reject]` (edge 2) A `stop()` while a beat is in flight can set the end to `stop` after the plain stop. -- The new branches sit where the existing `lost` branch already does. Nothing reads `end()` after the run's final `stop()` in a way that changes the outcome.
  - `[low]` `[reject]` (edge 3) `/lock/` also matches "blocked", so such a refusal would be `transient`. -- The regex is unchanged from before this Story, and GitHub's refusal summaries ("push declined due to repository rule violations", "pre-receive hook declined") contain no "lock".
  - `[low]` `[reject]` (edge 4) `rebuild` of a record with no `pr` leaves an orphan PR open on the branch, and the next claim adopts it. -- It needs a crash between `openPr` and the record's beat, followed by a park. Closing orphans needs the branch name from `main`'s config, which is new loading in the command.
  - `[low]` `[reject]` (edge 5) A thrown run is neither counted nor reset. -- Same as blind 5.
  - `[low]` `[reject]` (edge 6) `approve` is no longer role-checked. -- Same as verification-gap other 1.
  - `[false]` `[reject]` (intent 1) The restarts are driven in-process, not under launchd, and `KeepAlive` restarts whatever the exit code. -- The AC asks for "launchd-style restarts" through `lane run`. The count and the STOP are what end the loop, and both are asserted.
  - `[false]` `[reject]` (intent 2) The restart test fails only the run's forge, not the start check. -- That is the F10 gap this Story closes. A start-check failure was already counted, and its own rows still pass.
  - `[low]` `[reject]` (intent 3) The sleep test uses a stub waiter. -- The wait receives `AbortSignal.any([budget, ...keeperSignals()])`, and the existing lost-unit-in-sleep test shows the abort ends the wait.
  - `[false]` `[reject]` (intent 4) The GitHub half of the contract AC is unverified. -- Same as verification-gap other 2. The case exists on both adapters.
  - `[false]` `[reject]` (intent 5) `rejected` failing the attempt is shown only at `pushBranch`. -- Every step routes a non-lane-stop forge error through the same `failed` → `failAttempt` path, and the `pushBranch` table covers every kind.
  - `[low]` `[reject]` (intent 6) No test covers the OS user or the default GitHub forge for `rule`. -- `rule` reuses `stop --now`'s credential path. Testing the OS user needs a second account.
  - `[false]` `[reject]` (intent 7) The writer identity and how wide a lane stop reaches are local decisions. -- No bad outcome: both satisfy the AC, and both are recorded in the Design Notes and flagged for the Maintainer in the Auto Run Result.

## Design Notes

- **Lane stop = any non-marker `stop`.** The AC names the `laneStop` helpers (forge `auth`/`forbidden`/`uninstalled`, ledger schema). Other `stop`s fail closed on bad config, policy, graph or snapshot from `main` (spine "the lane stops"). Counting them too satisfies the AC under either reading, and meets its "never restarts forever" goal. A STOP marker is the operator's choice and is never counted.
- **Reset after the run.** Resetting at the passed start would undo every lane-stop count. A run killed mid-unit (`stop --now`) now leaves the count as it was.
- **Keeper `stop` everywhere.** The end aborts the keeper's signal wherever it is joined (the session, the usage-limit sleep), not only in the sleep. A lane-stop kind on the ledger means no later push or edit can land, and AR33 says these kinds stop the lane.
- **Rebuild closes first.** If the edit fails after the close, a re-run finds the PR closed, skips the close and makes the edit. Editing first would leave a `released` record whose PR is still open, which the next claim would adopt.
- **Writer identity.** Prefer the coordinator lane, the identity Story 4.6's rulings will write with. Fall back to a builder, so `rule` works on a host with no coordinator lane yet.

## Verification

**Commands:**
- `bun test` -- expected: every failure is in `../tmp/baseline-fails.txt` by name.
- `bun --bun oxlint` -- expected: exit 0.
- `bun --bun tsc` -- expected: exit 0.

## Auto Run Result

Status: done

**Summary.** Story 2.5b is complete.
- **`xarabot rule release|rebuild <unit-id> [--repo <owner>/<name>]`.** The Maintainer's host ruling on a `parked` unit, one fenced `applyRuling` ledger edit.
  - `release` sets `attempts`, `loopbacks` and `ci_fixes` to 0 and keeps `builder_providers`.
  - `rebuild` first closes the record's open PR, then also clears the providers and the reviewed, passed and approved SHAs.
  - It refuses, naming the state, a record that is not `parked` or does not exist, and the ledger stays unchanged. Any other verb is refused as "not before Story 4.6" before any file or forge access.
  - `applyRuling` no longer requires the coordinator role.
- **Lane-stop exits.** A run that ends `stop` for any reason but a STOP marker sets `laneStop`. `lane run` then exits 1 and counts it as a failed start, and the 3rd in a row writes the lane's `STOP` and posts `lane-start-failed`. The count now resets after a run without a lane stop, not when the start passes. Both roles count this way.
- **Forge kind `rejected`.** An unmapped 4xx, or a push a rule refuses (`[remote rejected]`, except a lock), is `rejected`. It fails the unit's attempt: `released`, `attempts` + 1. The fake forge gains `refusePushes`, and the contract suite has a matching scenario. On the GitHub emulator it is a `pre-receive` hook.
- **Heartbeat.** A beat that meets a forge lane-stop kind or an unknown ledger `schema_version` ends the keeper with `stop` and aborts its signal. The usage-limit sleep, or the session, therefore ends at once, and the lane stops with the alert.

**Files changed (baseline `f711931878f3a0591363f4eff768a85469037655` → working tree):**
- `src/core/ledger/edits.ts` -- `applyRuling` without `requireCoordinator`.
- `src/ports/forge.ts` -- kind `rejected`.
- `src/adapters/forge/github/http.ts`, `src/adapters/forge/github/github-forge.ts` -- an unmapped 4xx and a rule-refused push map to `rejected`.
- `src/adapters/forge/fake/fake-forge.ts` -- `control.refusePushes`.
- `src/lane/heartbeat.ts` -- the keeper end `stop`.
- `src/lane/lane-process.ts`, `src/lane/coordinator-process.ts` -- `MarkerStop`, `LaneProcessResult.laneStop`, and async `checkHeld`/`checkClaim`/`checkUnit` that stop the lane on the keeper's `stop`.
- `src/cli/lane-run.ts` -- lane stops counted after the run.
- `src/lane/rule.ts` (new) -- `applyHostRuling`.
- `src/cli/rule.ts` (new), `src/cli/main.ts`, `src/cli/lane-commands.ts` -- the `rule` command, its dispatch, and `githubForge` exported.
- `src/lane/ledger-cas.ts` -- a comment.
- `docs/maintainer/self-host.md` -- "Releasing a parked unit" and "Lane stops".
- Tests:
  - new `test/lane/rule.test.ts` and `test/cli/rule.test.ts`;
  - rows in `test/core/ledger/edits.test.ts`, `test/ports/forge.test.ts` and `test/adapters/forge/{fake-forge,github/http,github/push,github/pulls,github/github-forge}.test.ts`;
  - the contract files and `test/adapters/forge/github/git-server.ts`;
  - `test/lane/{heartbeat,lane-process,coordinator-process,pr-step}.test.ts`, `test/cli/{lane-run,main}.test.ts`.

**Review findings.** 29 findings: high 0, medium 1, low 21, false 7, maybe-false 0.
- **Patched (5):**
  - medium: until Story 2.6b, a rebuilt Story whose branch exists conflicts on every push. The runbook now says to delete the branch after `rebuild`.
  - low:
    - the coordinator `checkUnit` stop branch had no test reaching it; now it does;
    - the runbook's re-run note for a `rebuild` that closed the PR but failed the edit;
    - the `rule.test.ts` row for a swap failing after a close;
    - the `laneStop` text now leads with the `Halt` reason.
- **Deferred:** none.
- **Rejected (24: 17 low, 7 false).** Each reason is in the Review Triage Log. The most notable:
  - **`approve` by any identity.** Dropping the role check lifts it for `approve` too. No caller reaches `approve` before Story 4.6, and the CLI refuses the verb.
  - **A ledger that refuses every write with an unmapped 4xx** now fails attempts instead of stopping the lane (AR33 as written).
  - **A 429 without rate-limit headers, a 408 or a 425** now costs an attempt. These statuses used to stop the lane.
  - **A thrown run is not counted.** Both processes catch every error by design.
  - **An orphan PR on a record with no `pr`** is not closed by `rebuild`.

**Follow-up review recommended: false.** This pass patched one medium entry and no high one.

**Decisions for the Maintainer to confirm.** None of these is settled by the epic or the spine; each is recorded in the Design Notes.
- **Which stops count.** Every non-marker `stop` counts as a lane stop, including bad config, policy or graph on `main` and unreadable STOP markers, not only the alerting `laneStop` kinds.
- **The writer identity.** A ruling is written as the repo's `coordinator` lane, else the lowest-numbered `builder-<n>`. A non-Story unit needs the coordinator lane on the host.
- **`--repo`.** Required only when `host.yaml`'s lanes span several repos.

**Verification:**
- **Baseline** at `f711931`, after `bun install --frozen-lockfile`: 3043 pass, 73 fail, 162 skip. All 73 failures are sandbox-only (socket binding, `ps`/`kill`).
- **After the review patches:** 3142 pass, 74 fail, 164 skip.
  - 73 failures match the baseline by name.
  - The 74th is the new emulator contract case "a push a rule refuses is rejected and moves nothing". It fails on the sandbox's `listen` refusal, like the other 31 emulator cases. The fake passes it, and the no-controls and live harnesses skip it.
- **Lint and types:** `bun --bun tsc` and `bun --bun oxlint` exit 0.
- **Matrix audit:** every I/O row has a covering test that ran and passed. The coverage is in:
  - the rule CLI and lane tests;
  - the lane-run restart, heal and STOP-marker rows;
  - the `http` and `push` mapping rows;
  - the PR-step kind table;
  - the lane-process usage-limit keeper row.

**Residual risks:**
- **The emulator's `refusePushes` hook has not run under `git http-backend`.** A local bare-repo push showed the hook refusing the ref. CI's `bun test` is its first real run.
- **A persistent unmapped 4xx on ledger writes** fails attempts and restarts every 15 min with no lane-stop alert.
- **Until Story 2.6b, `rebuild` needs the Maintainer to delete the Story's branch by hand.**
- **Uncommitted changes.** The changes are left uncommitted in the working tree, as the lane runner's rules require, and the runner makes the commit. This deliberately departs from this workflow's commit and clean-tree steps.
- **No effect until the runner advances.** The changes take effect only after the Maintainer advances `runner_version`.
