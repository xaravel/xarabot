---
title: 'Story 2.5: `reconcile` marks units done'
type: 'feature'
created: '2026-10-24'
baseline_revision: '100eb40e5576963cb5caadd5c6a1ca8568d2d1ff'
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

**Problem:** The coordinator lane claims `reconcile:<n>` units but has no step for them, so it idles with "no reconcile step (Story 2.5)". Nothing records merged PRs, marks Stories `done` in `sprint-status.yaml`, or deletes ledger records. Sprint status therefore never follows merges (FR2, NFR20, AR4, AR10, AR14).

**Approach:**
- A runner-only `reconcile` step, with no agent session, wired into `lane run`.
- A pure planner reads the snapshot. The step then does the ledger work and edits `sprint-status.yaml` in place.
- When the file changes, the step opens a runner-written PR, polls its CI, and enqueues it itself. That PR is exempt from owner approval and is disposable when ejected.

## Boundaries & Constraints

**Always:**
- **No agent.** The step starts no session and has no review, loopback or CI-fix session. Its PR holds only runner-written content.
- **Ledger work.** Each item is one fenced CAS swap. The current unit `U` = `reconcile:<n>` is never a target. For each other record:
  1. Its PR is `merged` in the snapshot and its state is not `merged`: `markMerged`.
  2. A coordinator-held `merging` `reconcile` record whose PR has not merged: `queueState`.
     - If the PR is queued at the record's `head_sha`: no change.
     - If it is queued at another head: `dequeue`, then go on as below.
     - Otherwise (ejected, dequeued, closed or unknown): close it if open, then `releaseReconcile` (`merging → released`, no attempt).
  3. A stale `claimed` `reconcile` record (a run that died): close its open PR, then `releaseDeadReconcile` (`→ released`, `attempts` + 1, per AD-7's crash row).
  4. A `released` `reconcile` record found in the snapshot (released by an earlier run): close its open PR, then `deleteReleasedReconcile` (`released → none`, the new diagram edge).
  5. A `merged` record whose unit is done on `main` (rule below): `deleteMerged`.
- **Done on `main`** (`doneOnMain`, which also feeds Story 2.4's due rule):
  - `story`: its manifest's `sprint_key` is `done`.
  - `planning`: a graph unit (its `globs` hold `xarabot:graph`) is done once every graph Epic's `epic-<N>` key and every manifest's `sprint_key` has a `development_status` entry. A status unit is always done.
  - `reconcile`: every `merged` record except the newest `merged` one.
  - `retro`, `retro-item` and `checkpoint`: unchanged from Story 2.4.
- **Status changes**, computed from `main`, over records that are `merged` or marked `merged` in this run:
  - a Story whose `sprint_key` is not `done` gets `done`; a missing key is added as `done`;
  - a graph planning unit not yet done gets its missing `epic-<N>` and Story keys added as `backlog`.

  The edit keeps every other line, comments included. Added keys go after the last key of their Epic, or as a new block at the end of `development_status`, Epic key first. Re-parsing must give exactly the old map with the changes applied, or the run fails.
- **Ending the run:**
  - No status change, an absent `sprint-status.yaml`, or another `reconcile` record whose PR the snapshot shows `open`: `finishRecurring` (`merged`, no PR, no inbox item), then delete every other `merged` `reconcile` record.
  - Otherwise, the PR path:
    1. bot commit onto the snapshot's `main`, in `runner.git`;
    2. fence, then push `<branches.xarabot>reconcile-<n>` with lease `null`;
    3. fence, then open the PR and record `pr`, `pr_owner`, `head_sha` and `base_sha`;
    4. poll checks as Story 1.17 does (`classifyChecks`, `pollDelayMs`, `expected_checks`). An unexpected failure parks `blocked` `verification`, `ci_max_wait_minutes` parks `ci-timeout`, and there is no fix session;
    5. on a pass, take a fresh snapshot and load the config: the Standing Authority re-check, where a failure ends `stop`. A merged PR is `markMerged`; a closed one or a moved head is a failed attempt. A path matching `effective_protected_paths` parks `awaiting-approval` with the gate comment. `owner_approval_paths` is skipped;
    6. fence with `passed_sha` = head, `startMerging`, then `enqueue` at the head, retried on back-off as the merge step does. A `conflict` closes the PR and runs `releaseReconcile` on `U`. Otherwise the step ends `progress`, `merging`, and does not watch the queue.
- **Coordinator process:**
  - after a step that ends `merging`, the unit keeper stops, since coordinator-held `merging` records have no heartbeat (AD-6);
  - the trailing wait after `idle` is 10 min; other outcomes keep the builder's waits.
- **Selection:**
  - `reconcileDue` drops the digest condition until Story 4.2. The last run time is the `heartbeat_at` of the newest `merged` `reconcile:<n>` record, and `n` stays the highest number of any state, plus 1.
  - The open-coordinator-PR position never returns a `reconcile` record, though a live one still makes later positions wait.
- **Edits:** the three new edits require a writer whose lane is `coordinator`, a `reconcile` unit and the expected generation. `releaseReconcile` also requires `merging` and a holder whose lane is `coordinator`; `releaseDeadReconcile` requires a stale `claimed` record.

**Never:**
- No retro verdicts or items, no retro-item status, checkpoint go, rulings, digest or inbox body (Stories 2.9, 2.10, 4.2, 4.4, 4.6). No `takeApproved` or enqueue of builder PRs (2.6). No Epic status change or retrospective key.
- No PR is opened while another `reconcile` PR is open, a closed `reconcile` PR is never reopened, and a released `reconcile` record is never re-claimed.
- No ledger schema change, no new forge operation, no `.github/` change, no Standing Authority edit (its exemption text is already on `main`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Story merged | `story:2.1` parked, PR #7 merged; status `backlog` | `merged`; PR on `xarabot/reconcile-<n>` sets `2-1-…: done`; enqueued after CI; `U` `merging` | none |
| Nothing to do | no work | `U` `merged`, no PR; older `merged` reconcile records deleted | none |
| Done on main | `story:2.1` merged, status `done` | record deleted; `U` `merged`, no PR | none |
| Earlier PR open | `reconcile:3` parked, PR open; new Story merged | `markMerged` only; no PR; `U` `merged` | none |
| Earlier PR queued / merged | coordinator `reconcile:3` merging, queued / PR merged | unchanged / `merged` (and later deleted) | none |
| Earlier PR ejected | `reconcile:3` merging, open, not queued | PR closed, record `released`, attempts unchanged; no new PR this run | none |
| Released record | `reconcile:3` released | PR closed if open, record deleted | none |
| Dead run | `reconcile:3` claimed, heartbeat 30 min old | `released`, attempts + 1 | none |
| CI fails / times out | checks fail / pending past max wait | `U` parked `blocked` `verification` / `ci-timeout` | no fix session |
| Enqueue conflict | `enqueue` → `conflict` | PR closed, `U` `released`, attempts unchanged | none |
| Graph unit merged | `planning:graph.1` merged; manifest `2.13` not in status | `2-13-…: backlog` added after `2-12-…` | none |
| Unparseable status | flow-style `development_status` | `U` released (`failAttempt`), reason logged | no PR |

</intent-contract>

## Code Map

- `src/core/next/coordinator.ts` -- `reconcileDue` (~line 160, drop the digest clause; `newestReconcile` → newest `merged`; `n` from the highest number of any state), `doneOnMain` (graph planning and reconcile rules), `nextCoordinator` position 2 (skip returning `reconcile` records), `GRAPH_PSEUDO_GLOB`. `digestDue` stays, unused by `reconcileDue`.
- `src/core/ledger/edits.ts` -- `makeEdit`, `requireCoordinator`, `requireStale`, `isStale`, `markMerged`, `finishRecurring`, `deleteMerged`, `startMerging`, `park`, `heartbeat` (`set.passed_sha`), `failAttempt`. Add the three reconcile edits.
- `src/core/ledger/transitions.ts` -- add `["released", "none"]`; `test/core/ledger/transitions.test.ts` checks the edge list.
- `src/core/next/sprint-status.ts` (`parseSprintStatus`) and `src/core/ci/status-merge.ts` (the line-level YAML idiom, `parseYaml`) -- reuse for the new pure status editor.
- `src/core/schemas/snapshot.ts` -- `Snapshot.graph.value.epics[].{number,stories}`, `manifests[].{story_id,epic,sprint_key}`, `sprint_status.development_status`, `prs`, `config.{sprint_status_path,branches.xarabot,ci_max_wait_minutes}`, `policy.{expected_checks,effective_protected_paths}`.
- `src/lane/merge-step.ts` -- the pattern for `call`/`swap`/`held`/`lost`/`failed`, the enqueue retry (`ENQUEUE_TRIES`, `isBackoffKind`) and `approvalComment`. `src/lane/ci-step.ts` `poll` is the CI loop to mirror, without sessions or main merges.
- `src/lane/merger.ts` `rewriteTree` and `src/lane/clone.ts` (`git`, `needCommit`, `headRef`) -- the temp-index tree-rewrite idiom for the git reconcile committer; `FetchShas` lives in `src/lane/workspace.ts`.
- `src/lane/coordinator-process.ts` -- `CoordinatorStep` contract (`PrStepOutput`), unit keeper handling after the step (~line 430), trailing wait (`trailingWaitMs`, ~line 485).
- `src/core/lane/waits.ts` -- `TRAILING_WAIT_MS`; add the coordinator's.
- `src/cli/lane-run.ts` ~line 270 -- `steps: {}` becomes `{ reconcile: createReconcileStep(...) }`, with `connection.fetchShas(runnerGit)` and `bot.value`.
- `docs/maintainer/self-host.md` ~line 436 -- the coordinator bullet.
- Tests: `test/core/next/coordinator.test.ts` (digest rows change; `world`, `coord`, `reconciled`), `test/core/next/fixtures.ts` (`World`, `snapshotOf`, `storyRec`, manifests), `test/core/ledger/{edits,transitions}.test.ts`, `test/lane/coordinator-process.test.ts` (harness, `claimRec`, `coordUnit`), `test/lane/git-fixture.ts` (real git repos), `test/cli/lane-run.test.ts` (coordinator start with `startCoordinator`).
- Baseline at `100eb40`: 2774 pass, 73 fail, 162 skip. All 73 are sandbox-only (loopback listen, `ps`/`kill`), the same set as Story 2.4's. Compare failures by name.

## Tasks & Acceptance

**Execution:**
- `src/core/ledger/transitions.ts`, `src/core/ledger/edits.ts` -- the `released → none` edge; `releaseReconcile`, `releaseDeadReconcile` and `deleteReleasedReconcile`, each with a `ledger: <name> <unit> [skip ci]` message.
- `src/core/next/coordinator.ts` -- the due-rule, `doneOnMain` and position-2 changes, plus an exported `newestMergedReconcile` and `missingStatusEntries(snapshot)`, the graph's Epic and Story keys absent from `development_status`.
- `src/core/reconcile/status-edit.ts` (new, pure) -- `editDevelopmentStatus(path, text, changes)`, returning the new text or `invalid`.
- `src/core/reconcile/plan.ts` (new, pure) -- `planReconcile(snapshot, unit)`: the ledger work lists, the status changes and new text, and any other open `reconcile` PR.
- `src/lane/reconcile-commit.ts` (new) -- `ReconcileCommitter` port and `createGitReconcileCommitter({ gitDir, bot, fetch })`: one bot commit onto `ontoSha` replacing given files, written to `headRef(unit)`.
- `src/lane/reconcile-step.ts` (new) -- `createReconcileStep(deps)`, a `CoordinatorStep` doing the work in Boundaries. It never throws, and a lost unit ends `failed` with state `null`.
- `src/core/lane/waits.ts`, `src/lane/coordinator-process.ts` -- the 10-min idle wait; stopping the unit keeper after a `merging` step.
- `src/cli/lane-run.ts` -- wire the step.
- `docs/maintainer/self-host.md` -- what a runner with 2.5 does, and that its PRs are queued by the runner, needing no approval.
- Tests:
  - `test/core/reconcile/status-edit.test.ts`: set, add into an Epic, new Epic block, comments kept, CRLF, unparseable refused;
  - `test/core/reconcile/plan.test.ts`: a case table per matrix row, plus each kind's `doneOnMain`;
  - edits rows for each new edit and its refusals;
  - coordinator rows for the due rule (no digest, newest `merged`) and position 2;
  - `test/lane/reconcile-commit.test.ts` against real git;
  - `test/lane/reconcile-step.test.ts` against the fake forge, covering every matrix row with a fake committer;
  - coordinator-process rows for the keeper stop and the 10-min wait;
  - a `lane-run` row showing a reconcile step is wired.

**Acceptance Criteria:**
- Given a coordinator lane with the reconcile step, a parked `story:2.1` whose PR merged and a `backlog` status, when it runs a round, then no agent session runs; `story:2.1` is `merged`; a PR from `xarabot/reconcile-<n>` changes only `sprint-status.yaml`, setting `2-1-…` to `done`; after CI passes it is enqueued with no approval; and `reconcile:<n>` is `merging` with no further heartbeat.
- Given that PR merged, when the next due round runs, then `reconcile:<n>` and `story:2.1` are deleted, the new run ends `merged` with no PR, and it is the only `merged` `reconcile` record.
- Given `bun test`, when it runs, then no failure falls outside the baseline's sandbox-only set, and `bun --bun oxlint` and `bun --bun tsc` exit 0.

## Spec Change Log

## Review Triage Log

### 2026-10-24 — Review pass
- verdicts: 30 findings — high 0, medium 7, low 20, false 3, maybe-false 0 (verification-gap gaps counted as low)
- findings:
  - `[low]` `[patch]` (verification-gap 1) `checkQueue`'s closed-PR, `not-found` and merged-after-snapshot branches have no test. — Pre-verified gap. Added three matrix rows to `test/lane/reconcile-step.test.ts`.
  - `[low]` `[reject]` (blind 1) A persistent failure, such as an unparseable status file, repeats every run and never parks or alerts, because each run is a new unit number. — Real, but needs an unusual repo state. A cross-run failure count is new state and new behaviour; every failed run is still journaled `failed` with its reason. Listed as a residual risk.
  - `[medium]` `[patch]` (blind 2) A PR opened but not recorded is orphaned. This happens when `openPr` errors after GitHub created the PR, or when the record heartbeat fails. Later runs never see it, and a second reconcile PR can open. — Confirmed: `snapshot.prs` is keyed by `record.pr`. Now a failed `openPr` closes any open PR on the branch, and a failed record beat closes the PR before the step ends. Both have tests.
  - `[medium]` `[patch]` (blind 3) The self-host doc says to "let the PR through by hand" after a `forbidden` enqueue. The next run would close that PR as ejected, and under the current ruleset every enqueue is refused. — Confirmed. The doc now says the review requirement must be lifted for reconcile PRs first (a `github-settings` decision for the Maintainer), not to install the coordinator before that, and that a later run closes a refused PR.
  - `[low]` `[patch]` (blind 4) A parked reconcile PR blocks later PRs, and the doc does not say how to clear it. A closed parked record stays. — The AC keeps parked records until their inbox item is resolved. The doc now says to close the PR so a later run opens a fresh one.
  - `[low]` `[reject]` (blind 5) The diff rewrites `epic-2-context.md`. — Stock step-01 recompiled it because `epics.md` changed after it. The runner reverts a builder's change to it before the squash (Story 2.3), as in Story 2.4.
  - `[low]` `[reject]` (blind 6) An enqueue failure other than a conflict counts an attempt and leaves the PR open, unlike a conflict. — The next run sees the released record, closes its open PR and deletes it, the same end state one cycle later. The attempt is deleted with the record.
  - `[low]` `[reject]` (blind 7) A merged Story with no manifest on `main` is skipped silently and its record is never deleted. — Story 2.8 forbids removing a used id, so the case is unlikely. A report path is new surface.
  - `[low]` `[reject]` (blind 8) The graph rule adds every missing graph key, not only the merged unit's own. — The record stores no delta. Missing keys are added as `backlog` and then the unit is done, so the rule converges. A status planning unit (2.7) would add the same keys.
  - `[low]` `[patch]` (blind 9) The PR body promises automatic queueing even when a Protected Path gates the PR. — The body now says "unless a Protected Path gates it".
  - `[low]` `[reject]` (blind 10) A record `checkQueue` marks merged mid-run survives next to the new merged run; the finish deletes are not fenced. — The next run deletes it (not the newest merged), so it converges. `U` is `merged` by then and cannot be fenced, and deleting a superseded merged record is correct whoever writes it.
  - `[low]` `[reject]` (blind 11) An empty `development_status:` is refused, and a new Epic block goes above trailing comments. — `bmad-sprint-planning` never writes an empty block. Comment placement is cosmetic.
  - `[low]` `[patch]` (blind 12) Several failure branches have no test. — The `checkQueue` branches and the two orphan-PR branches got tests (verification-gap 1, blind 2). The rest (dequeue or close failing, enqueue exhaustion, non-back-off checks) are plain failed-attempt paths, already covered by the shared `failed()` tests.
  - `[low]` `[patch]` (blind 13) The self-host doc does not tell the Maintainer to stop marking Stories done by hand. — Added a sentence on hand edits while a reconcile PR is open.
  - `[medium]` `[patch]` (edge 1) The record beat after `openPr` can fail and leave the PR unrecorded. — Same root as blind 2; fixed there.
  - `[medium]` `[patch]` (edge 2) After a `forbidden` enqueue, the next run closes the PR the doc says to let through. — Same root as blind 3; fixed there through the doc. Distinguishing a refusal from an ejection would need new record state.
  - `[medium]` `[patch]` (edge 3) A PR refused at enqueue is treated as ejected. — Same root as blind 3.
  - `[false]` `[reject]` (edge 4) If `checkUnit`/`checkClaim` throws before the keeper stop on a `merging` step, the keeper beats through the wait. — `checkUnit` throws only once the unit keeper has already ended. When `checkClaim` throws, the end path stops the unit keeper, because the coordinator keeper did not end `moved-on`.
  - `[low]` `[reject]` (edge 5) A merged Story whose manifest is missing is never deleted. — Same claim as blind 7; rejected there.
  - `[low]` `[reject]` (edge 6) The finish deletes are unfenced. — Same claim as blind 10; rejected there.
  - `[medium]` `[patch]` (edge 7) A PR whose record beat fails lets the next run open a second reconcile PR. — Same root as blind 2; fixed there.
  - `[false]` `[reject]` (edge 8) An aborted signal ends with `record.state`, not `null`. — The process's `checkUnit` takes the state from the keeper's end (`null` when lost), so the journal never records a stale state.
  - `[low]` `[reject]` (edge 9) A missing `epic-<N>` for an Epic whose Stories have keys goes below them. — Needs a hand-damaged file; cosmetic.
  - `[low]` `[reject]` (intent 1) The graph-planning done rule reinterprets AD-9 without a Maintainer decision. — It follows from the AC's "writes that unit's status entries" with disposable PRs (Design Notes). AD-9's planning rule still holds for status units.
  - `[low]` `[reject]` (intent 2) The diff adds behaviour the ACs do not name: dead-run release, the protected-path gate, the absent-file finish, `forbidden` stopping. — Each one fails closed or cleans up under spine rules (AD-7's crash row, AD-20, AD-32). No wrong outcome is named.
  - `[low]` `[reject]` (intent 3) The Epic context rewrite is out of scope. — Same as blind 5.
  - `[medium]` `[patch]` (intent 4) "Enqueued with no approval" depends on a GitHub ruleset the diff cannot change, and is proven only on the fake forge. — Same root as blind 3: the doc now names the `github-settings` decision. Listed as a residual risk.
  - `[false]` `[reject]` (intent 5) Nothing is committed and no PR is opened. — The lane runner's rules require leaving the changes in the working tree; the runner commits and opens the PR.
  - `[low]` `[reject]` (intent 6) The end-to-end test uses a fake committer and `setMain`, not `lane run` with real git. — The git committer has real-git tests, and `lane run` has a wiring row. A live suite is outside this Story's scope.
  - `[low]` `[reject]` (intent 7) No test asserts "no other code deletes ledger records". — A grep confirms that only `reconcile-step.ts` calls the delete edits. A grep-based test adds little.

## Design Notes

- **Fresh PR after an ejection.** The run that closes an ejected PR saw it `open` in its snapshot, so it opens no new PR. The next due run deletes the released record and opens a fresh one from fresh `main`, as the AC words it. The cost is at most one 10-min cycle.
- **Graph planning done on `main`.** AD-9 says a planning unit is done once its PR merged. A graph unit's status entries, though, land only through a later `reconcile` PR, which is disposable. Deleting the record at its merge would lose them if that PR is ejected, so a graph unit counts as done once its entries are on `main`.
- **A dead run** (a stale `claimed` reconcile record) follows AD-7's crash row: released with `attempts` + 1, then deleted by the next run like any released reconcile record. Its run number is never reused, because the newest-numbered record is never deleted.
- **Branch collisions.** A leftover `reconcile-<n>` branch makes the `null`-lease push `conflict`. That is a failed attempt: `U` is released, deleted next run, and the following run uses `n + 1`.
- **The protected-path gate is kept.** Only `owner_approval_paths` is exempt (AC), so a `sprint_status_path` under a Protected Path still parks.
- **Live merge queue.** The `Protect main` ruleset requires one approving review. GitHub may refuse to enqueue a reconcile PR until the Maintainer lets it through, a `github-settings` Human Live Step. A `forbidden` enqueue stops the lane with an alert, failing closed.

## Verification

**Commands:**
- `bun test` -- expected: 73 failures at most, all in the baseline set by name
- `bun test test/core test/lane/reconcile-step.test.ts test/lane/reconcile-commit.test.ts test/lane/coordinator-process.test.ts test/cli/lane-run.test.ts` -- expected: all pass apart from baseline sandbox-only failures
- `bun --bun oxlint` -- expected: exit 0
- `bun --bun tsc` -- expected: exit 0

## Auto Run Result

Status: done

**Summary.** Story 2.5 is complete. The coordinator lane now runs a runner-only `reconcile` step, with no agent session, review, loopback or CI-fix session.
- **Ledger work.** Each step is one fenced swap:
  - records whose PR merged become `merged`;
  - earlier `reconcile` runs are checked:
    - a queued PR is left alone;
    - an ejected, dequeued or closed PR is closed, and its record released with no attempt;
    - a dead run's record is released with an attempt;
    - a released record's PR is closed and the record deleted;
  - `merged` records whose unit is done on `main` are deleted.
- **Status.** It edits `sprint-status.yaml` in place, keeping comments: a merged Story's key becomes `done`, and a merged graph planning unit's missing Epic and Story keys are added as `backlog`.
- **PR.** When the file changes and no other `reconcile` PR is open:
  1. it opens a runner-written PR from `xarabot/reconcile-<n>`;
  2. it polls CI, parking `verification` or `ci-timeout`;
  3. it re-checks the Standing Authority on fresh `main`;
  4. it keeps the Protected Path gate, but skips `owner_approval_paths`;
  5. it writes `merging` and enqueues the PR itself.

  An enqueue conflict closes the PR and releases the record with no attempt. A run with nothing to commit ends `merged` with no PR, as the only `merged` `reconcile` record.
- **Coordinator changes:**
  - Its idle trailing wait is 10 min.
  - It stops the unit keeper once a step leaves the record `merging`.
  - The due rule no longer counts the digest; it reads the newest `merged` `reconcile` record, and `n` is the highest number of any state, plus 1.
  - The open-PR position never returns a `reconcile` record.
- **`lane run`** wires the step in production.

**Files changed (baseline `100eb40e5576963cb5caadd5c6a1ca8568d2d1ff` → working tree):**
- `src/core/reconcile/plan.ts` (new) -- `planReconcile`, the pure plan of one run.
- `src/core/reconcile/status-edit.ts` (new) -- `editDevelopmentStatus`, the in-place `sprint-status.yaml` editor, checked by re-parsing.
- `src/lane/reconcile-step.ts` (new) -- `createReconcileStep`: the ledger work, the PR, CI, re-check, gate and enqueue path, and orphan-PR cleanup.
- `src/lane/reconcile-commit.ts` (new) -- the `ReconcileCommitter` port and its `runner.git` implementation.
- `src/core/ledger/edits.ts`, `src/core/ledger/transitions.ts` -- `releaseReconcile`, `releaseDeadReconcile`, `deleteReleasedReconcile` and `fenced`; the `released → none` edge.
- `src/core/next/coordinator.ts` -- the due rule, `doneOnMain` (graph planning and reconcile), position 2, `missingStatusEntries` and helpers.
- `src/lane/coordinator-process.ts`, `src/core/lane/waits.ts` -- `files` in the step input, the keeper stop after `merging`, and the 10-min idle wait.
- `src/cli/lane-run.ts` -- wires `steps: { reconcile }`.
- `src/core/ci/status-merge.ts`, `src/lane/merger.ts`, `src/lane/merge-step.ts` -- export existing helpers for reuse (`parseStatusText`, `keyLine`, `rewriteTree`, `gateComment`); no behaviour change.
- `docs/maintainer/self-host.md` -- what a 2.5 runner does, the ruleset prerequisite, parked reconcile PRs, and hand edits.
- Tests:
  - new: `test/core/reconcile/plan.test.ts`, `test/core/reconcile/status-edit.test.ts`, `test/lane/reconcile-commit.test.ts` (real git) and `test/lane/reconcile-step.test.ts`, which covers the whole matrix plus an end-to-end test of the ACs through `runCoordinatorProcess`;
  - rows added in the edits, transitions, coordinator, waits, coordinator-process and lane-run tests.
- `_bmad-output/implementation-artifacts/epic-2-context.md` -- recompiled by step-01 because `epics.md` and the spine changed after it was written. The runner reverts a builder's change to it before the squash.

**Review findings.** 30 findings: high 0, medium 7, low 20, false 3, maybe-false 0.
- **Patched, in 6 entries:**
  - 2 at medium:
    - an unrecorded, orphaned reconcile PR after a failed `openPr` or record beat;
    - the self-host doc's "let it through by hand" advice, which contradicts what the next run does. The doc now names the ruleset prerequisite.
  - 4 at low:
    - the PR body wording;
    - parked reconcile PR guidance in the doc;
    - the hand-edit guidance;
    - tests for `checkQueue`'s non-open branches.
- **Deferred:** none.
- **Rejected, 17 (14 low, 3 false).** Each reason is in the Review Triage Log. The most notable:
  - A persistent failure, such as an unparseable status file, repeats every run with no park or alert.
  - The graph rule adds every missing graph key, not only the unit's own delta.
  - Deleting superseded records after the finish is not fenced.

**Follow-up review recommended: true.** This pass patched 2 medium entries, which no fresh review has seen. The specific unverified risks:
- the orphan-PR cleanup in `openAndQueue`: the `listPrsByBranch` close after a failed `openPr`, and the close after a failed record beat;
- the rewritten coordinator section of `docs/maintainer/self-host.md`.

**Verification:**
- `bun test` at the baseline: 2774 pass, 73 fail, 162 skip. All 73 failures are sandbox-only (loopback listen, `ps`/`kill`).
- `bun test` after the implementation: 2912 pass, 73 fail, 162 skip. After the review patches: 2918 pass, 73 fail, 162 skip. Both times the failures match the baseline's by name: none new, none fixed.
- The targeted command (`test/core`, the reconcile, coordinator-process and lane-run tests): 1785 pass, 0 fail.
- `bun --bun oxlint`: exit 0. `bun --bun tsc`: exit 0. Both before and after the patches.
- Matrix audit: every I/O row has a covering test in `test/lane/reconcile-step.test.ts` and `test/core/reconcile/plan.test.ts`, and each ran and passed.

**Residual risks:**
- **Live merge queue.** `Protect main` requires one approving review, so GitHub will refuse the runner's enqueue of reconcile PRs. Letting them in is a `github-settings` Human Live Step for the Maintainer, a security decision about bypassing review. Until then the coordinator lane must not be installed; the doc says so. The no-approval path is proven only on the fake forge.
- **Persistent failures** loop every cycle with only a journal record and no alert.
- **The Epic context file on `main`** is older than the 2026-10-24 planning changes. The Maintainer may want to recompile it in a Maintainer PR.
- **Uncommitted changes.** The changes are left uncommitted in the working tree, as the lane runner's rules require, and the runner makes the commit. This deliberately departs from this workflow's commit step.
