---
title: 'Story 1.17a: Approval gate and merge queue'
type: 'feature'
created: '2026-10-23'
baseline_revision: 'b4c8913b5a11481ab24953464812cd0de6027068'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      A PR whose merge-queue entry is gone while GitHub still reports it OPEN at the same head (a brief gap after the merge group lands, or a Maintainer dequeue) is treated as an ejection.
    evidence: |-
      Unverified. The watch loop reads one queueState and treats "open, not queued, same head" as ejected (attempts + 1, CI again, re-enqueue). If GitHub can report the PR OPEN with no entry for a moment after its merge group merges, the lane counts a spurious attempt; the re-enqueue then conflicts on the merged PR and the next claim writes merged. To settle it, observe live whether mergeQueueEntry clears before state becomes MERGED. A re-read after a delay before ejecting would guard it.
    location: >-
      src/lane/merge-step.ts watch loop (ejected branch)
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** After Story 1.17 the CI step stops at a PR whose checks pass. Nothing parks a PR that needs its owner's approval, takes the others through the merge queue, handles an ejection, or writes `merged`, so the gate and queue rules (FR6, FR13, FR22, AR7, AR8, AR20, AR21) are not in code.

**Approach:** Add `createMergeStep(deps)` in `src/lane/merge-step.ts`. It runs after a CI step that leaves the unit `claimed` with a PR. It re-checks config and the Standing Authority on fresh `main`, then reads the PR's changed paths from `runner.git`. A gated PR parks `awaiting-approval`. Any other PR is fenced, written `merging`, enqueued at its head and watched. Watching needs a read the `Forge` port lacks, so the port gains a read-only `queueState(pr)`. `runLaneProcess` loops CI step → merge step after each ejection. Before `next`, it also marks `merged` every parked or merging record whose PR has merged.

## Boundaries & Constraints

**Always:**
- **Pure core (`src/core/ci/approval.ts`):** `approvalPaths(paths, globs)` returns, sorted, the paths that match any glob under `Bun.Glob` rules, comparing both case-folded. The gate globs are `policy.owner_approval_paths` followed by `policy.effective_protected_paths`.
- **`Forge.queueState(pr, opts)`** returns `ForgeResult<{state: ForgePrState, head_sha, queued: boolean}>`. A missing PR is `not-found`. It is listed in `FORGE_OPERATIONS` after `dequeue` and passes the aborted-signal contract case.
  - The GitHub adapter reuses its `pullQueueState` query: `OPEN`, `CLOSED` and `MERGED` map to lowercase, and any other state is malformed.
  - The fake forge reads the state from its PRs and queue. Its control gains `eject(pr): boolean`, which takes a queued PR out of the queue without merging it.
- **`DiffPaths` (`src/lane/diff-paths.ts`):** `createGitDiffPaths({gitDir, fetch})` returns `(req: {headSha, mainSha, signal}) => Promise<Result<readonly string[], WorkspaceErrorKind>>`. It never throws, and it fetches a missing SHA through `FetchShas`, as `createGitMerger` does. The result is `git diff --name-only -z --no-renames <merge-base> <head>`, sorted and unique. With no merge base, it diffs the empty tree.
- **`createMergeStep(deps)`** returns a `MergeStep`. Its output is `PrStepOutput` plus `ejected?: true`.
  - `MergeStepDeps`: `forge`, `diffPaths`, `identity`, `repo`, and optional `callTimeoutMs`, `now`, `sleep` and `random`.
  - `MergeStepInput`: `unit`, `record`, `signal` and `log`.
  - It follows the `End`/`call`/`swap`/`held`/`failed`/`lost` pattern of `ci-step.ts`.

  The step runs in this order:
  1. **Fresh `main`.** It reads `snapshot({read: readsPath})` and runs `loadRepoConfig` on it. Any config error, the Standing Authority included, returns `stop` with no ledger edit, no enqueue and no comment. A PR that `snap.prs` reports as `merged` gets `markMerged` and returns `progress`/`merged`. A `closed` PR, or one whose head differs from `head_sha`, is a failed attempt.
  2. **Gate.** It calls `diffPaths(head, main)`; a failure is a failed attempt. If `approvalPaths` is not empty, it writes `park` with kind `awaiting-approval` and `diffPaths` = every changed path. It posts one best-effort 🤖 comment naming the gated paths and saying the Maintainer approves and queues the PR by hand, then returns `progress`/`parked`.
  3. **Enqueue.** It writes a heartbeat with `set: {passed_sha: head}`, then `startMerging`; both are held swaps at the record's `generation`. It then calls `enqueue(pr, head)`. A `transient` or `rate-limited` reply is retried up to 3 calls in all, sleeping `pollDelayMs(n)` (or `retry_after`, when that is longer). Any other failure, or a third backoff reply, **leaves `merging`**, then counts a failed attempt.
  4. **Watch.** Between calls to `queueState(pr)` it sleeps `pollDelayMs(n)`. It writes a heartbeat once at least 5 minutes of host time have passed since the last one.
     - `transient` and `rate-limited` replies count as pending.
     - `queued` at the same head: keep watching.
     - `merged`: `markMerged`, then return `progress`/`merged`.
     - `closed`, a moved head, `not-found` or `conflict`: leave `merging`, then count a failed attempt.
     - `open`, not queued, at the same head (**ejected**): leave `merging`, then write `ejected` (`attempts` + 1). If `attempts` ≥ `ATTEMPTS_CAP`, it writes `park` blocked `attempts-cap` and returns `progress`/`parked`. Otherwise it returns `progress`/`claimed` with `ejected: true`.
     - An aborted `input.signal` (the budget passed): leave `merging`, then count a failed attempt (`merging → released`).
  - **Leaving `merging`** always calls `dequeue(pr)` first. If `dequeue` fails with a kind that does not stop the lane, the record stays `merging`, no edit is made and the step returns `failed`.
  - **Errors.** A lane-stop kind from any call, or a ledger `stop`, alerts and returns `stop`. A lost fence (`precondition`) returns `failed` with no further edit, so there is no enqueue. Any other swap failure is a failed attempt.
- **`lane-process.ts` (additive):**
  - `LaneDeps.mergeStep?: MergeStep` is called when the CI step returns `progress`/`claimed`. While the merge step returns `ejected`, the lane runs the CI step again on the returned record (merge `main`, poll), then the merge step (Standing Authority re-check, re-enqueue). `settle` records each output.
  - **Merged sweep.** After `assembleSnapshot` and before `next`, each `parked` or `merging` record whose `snap.prs` state is `merged` gets `markMerged`. Each one appends one unit journal record: `outcome` `progress`, `state` `merged`, `reason` `PR #<n> merged`. A lost swap is skipped; any other swap failure ends the run `failed`.

**Never:**
- No merge call, admin merge, auto-merge, approve or `--delete-branch`; the merge queue does every merge. No review or `reviewed_sha` (Epic 2), no `reconcile`, no `takeApproved`, and no stale takeover.
- No change to `Agent`, `Sandbox`, `LaneStore`, the ledger edits or the CI step, beyond what is named above.
- No `pkill`, no `timeout` binary, and no `Bun.spawn` in `src/lane/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Gated PR | diff `src/a.ts`, `owner_approval_paths: ["**"]` | `parked` `awaiting-approval`, `globs_held` `[src/a.ts]`; 🤖 comment; no enqueue | outcome `progress` |
| Protected path | diff `.github/x.yml`, no owner paths | parked `awaiting-approval` | none |
| Ungated enqueue | diff `src/a.ts`, no gate match | heartbeat `passed_sha`, `merging`, `enqueue(pr, head)` in that order | none |
| SA revoked | fresh `main` lacks the SA | no ledger edit, no enqueue | outcome `stop` |
| Fence lost | foreign generation bump before `startMerging` | no enqueue, record untouched by the lane | outcome `failed` |
| Enqueue conflict | `enqueue` returns `conflict` | `dequeue`, then `released`, `attempts` + 1 | outcome `failed` |
| Enqueue transient | `transient` once, then ok | queued after one retry | none |
| Merged | queue head merged | `merged`; journal `state` `merged` | outcome `progress` |
| Ejected | `eject(pr)` | `dequeue`, then `claimed` with `attempts` + 1 and `ejected: true` | none |
| Ejected at cap | `attempts` 2, ejected | `parked` blocked `attempts-cap` | outcome `progress` |
| Closed while queued | PR closed | `dequeue`, then `released` | outcome `failed` |
| Budget passes | signal aborted while queued | `dequeue`, then `released`, `attempts` + 1 | outcome `failed` |
| Dequeue fails | `dequeue` `transient` on leaving | record stays `merging` | outcome `failed` |
| Queue read stop | `queueState` `forbidden` | alert `forge-forbidden` | outcome `stop` |
| End to end | CI passes, ejected once, then merged | CI step runs twice, enqueue twice, `merged`, `attempts` 1 | outcome `progress` |
| Sweep | parked record whose PR merged by hand | `merged` before `next`; one journal record | none |

</intent-contract>

## Code Map

- `src/lane/ci-step.ts` -- the step pattern to mirror: `End`, `call`, `swap`, `held`, `beat`, `failed`, `lost`, `laneStop`, `forgeNow`, `aborted`. `CiStep` is called again after an ejection.
- `src/lane/lane-process.ts:543-595` -- `settle` and the CI step call, where the merge loop goes. `body()` lines 611-631 hold `assembleSnapshot` and `next`; the sweep goes between them. Lines 748-778 write the journal record; extract a helper so the sweep reuses it.
- `src/core/ledger/edits.ts` -- `heartbeat({set: {passed_sha}})`, `startMerging` (needs `pr` and `passed_sha`), `park({kind: "awaiting-approval", diffPaths})`, `ejected`, `failAttempt` (`merging → released`), `markMerged` (any writer), and `ATTEMPTS_CAP`.
- `src/core/ci/checks.ts` -- `pollDelayMs`.
- `src/core/config/load-repo-config.ts` -- `policy.owner_approval_paths`, `policy.effective_protected_paths`.
- `src/core/lane/build-check.ts:15` -- `Bun.Glob` use in core, the matching idiom to follow.
- `src/lane/merger.ts`, `src/lane/clone.ts` -- `needCommit`, `git`, `gitRun`, `failed`, and the fetch-missing pattern for `createGitDiffPaths`.
- `src/ports/forge.ts` -- `Forge`, `FORGE_OPERATIONS`, `ForgePrState`.
- `src/adapters/forge/github/github-forge.ts:783-838` -- `queueState` helper, `enqueue` and `dequeue`; add the `queueState` operation through `guarded`.
- `src/adapters/forge/fake/fake-forge.ts` -- `queue`, `dequeueNumber`, `mergeQueueHead`; add `queueState` and `eject`.
- `test/contracts/forge.contract.ts:288-300, 470-500` -- the aborted-signal map and the queue cases. `test/adapters/forge/github/github-forge.test.ts:285` has the same map. `test/ports/forge.test.ts:32,65` lists the operations. `test/adapters/forge/github/queue.test.ts` and `fake-github.ts` already answer the state query.
- `test/lane/ci-step.test.ts`, `test/lane/lane-process.test.ts`, `test/lane/git-fixture.ts`, `test/core/ledger/fixtures.ts` -- harnesses to copy.

## Tasks & Acceptance

**Execution:**
- `src/ports/forge.ts` -- `QueueState`, `Forge.queueState`, and `FORGE_OPERATIONS` entry.
- `src/adapters/forge/fake/fake-forge.ts` -- `queueState`; `control.eject`.
- `src/adapters/forge/github/github-forge.ts` -- `queueState` operation.
- `src/core/ci/approval.ts` -- `approvalPaths`.
- `src/lane/diff-paths.ts` -- `DiffPaths`, `DiffPathsRequest`, `createGitDiffPaths`.
- `src/lane/merge-step.ts` -- `MergeStep`, `MergeStepInput`, `MergeStepDeps`, `MergeStepOutput`, `createMergeStep`, `approvalComment`.
- `src/lane/lane-process.ts` -- `LaneDeps.mergeStep`, the CI ↔ merge loop, the merged sweep, and the shared journal helper.
- Tests:
  - `test/core/ci/approval.test.ts` -- case table: `**`, a root `AGENTS.md` against `**/AGENTS.md`, case folding, no match.
  - `test/lane/diff-paths.test.ts` -- real git: changed, added, deleted and renamed paths; `main` moving after the branch; fetch only for a missing SHA.
  - `test/lane/merge-step.test.ts` -- one case per matrix row, against the fake forge with a stub `diffPaths` and a sleep that drives `mergeQueueHead`/`eject`.
  - `test/lane/lane-process.test.ts` or `merge-step.test.ts` -- the end-to-end and sweep rows through `runLaneProcess`.
  - The contract gets a `queueState` case covering open, queued, dequeued, closed, merged and `not-found`, plus the aborted maps. The fake forge gets an `eject` test, the GitHub queue tests a `queueState` case, and the `FORGE_OPERATIONS` list test is updated.

**Acceptance Criteria:**
- Given a passing PR that needs no approval, when `runLaneProcess` runs with `ciStep` and `mergeStep`, then the ledger log shows the heartbeat, `startMerging` and then the enqueue, and after the fake queue merges it the journal's unit record has `state` `merged`.
- Given every move out of `merging` other than to `merged`, when the merge step makes it, then the fake forge saw `dequeue` before the ledger swap.
- Given `bun test`, `bun --bun oxlint` and `bun --bun tsc`, when they run, then each exits 0 and the boundaries test passes.

## Spec Change Log

## Review Triage Log

### 2026-10-23 — Review pass
- verdicts: 19 findings — high 0, medium 0, low 14, false 4, maybe-false 1 (plus 3 descriptive intent-alignment divergences, recorded last)
- findings:
  - `[low]` `[patch]` (blind) a `markMerged` that is a no-op (the tip already says `merged`) leaves the step's `record` at `merging`, so the step and the journal report a stale state — after `markMerged` the step now ends in state `merged`; a test with a foreign `merged` write was added.
  - `[false]` `[reject]` (blind) the sweep and step 1 trust `snap.prs[unit]` without checking it is `record.pr` — both adapters key `prs` by the record's own `pr` (`readPrs` in `github-forge.ts` fetches `/pulls/<record.pr>`; the fake reads `prs.get(record.pr)`), so it is always that PR.
  - `[low]` `[patch]` (blind) the sweep writes a journal record when its `markMerged` changed nothing — the sweep now skips the journal record when no commit was made.
  - `[low]` `[reject]` (blind) one transient snapshot or diff read costs an attempt — this is the CI step's pattern. Such failures are rare, and a retry loop adds branches.
  - `[low]` `[reject]` (blind) a heartbeat that fails while queued dequeues a healthy PR — this needs the ledger CAS loop to fail 10 times, and the unit is released rather than lost. Retrying heartbeats adds machinery.
  - `[low]` `[reject]` (blind) the watch has no limit but the unit budget — the 6 h budget bounds it and then dequeues and releases. A separate cap is extra machinery.
  - `[low]` `[reject]` (blind) alerts before the first snapshot share the `ZERO_SHA` key and are deduplicated — this copies the CI step's pattern. The first alert of that condition is posted, and later ones would repeat the same stop.
  - `[low]` `[patch]` (blind) missing tests for `queueState` `not-found`/`conflict` and for the sweep's merging, lost and failed branches — same root as the two verification-gap rows; tests added there.
  - `[low]` `[patch]` (blind) the `approvalComment` sanitising test does not check closing keywords — an assertion was added.
  - `[low]` `[patch]` (blind) hygiene: a duplicate import, an unindented contract scenario and an over-long doc line — fixed.
  - `[low]` `[patch]` (edge) a no-op `markMerged` leaves a stale state — same as the first blind row.
  - `[low]` `[reject]` (edge) a long `retry_after` can delay a heartbeat past the stale threshold — stale takeover is Epic 2, and GitHub's `retry_after` is usually a minute or less. Clamping the sleep adds a branch.
  - `[maybe-false]` `[defer]` (edge) "open, not queued, same head" may be a merged PR seen mid-transition or a Maintainer dequeue, giving a spurious ejection — this needs a live check of whether `mergeQueueEntry` clears before `MERGED`. Deferred in frontmatter as medium (unverified).
  - `[low]` `[reject]` (edge) a sweep swap failure on any record halts the run — the contract says a non-lost failure ends the run `failed`. The lane retries after its 15-minute wait.
  - `[false]` `[reject]` (edge) a parked record whose current PR is open is marked merged because an older PR merged — `prs` is keyed by the record's own `pr` (see the blind row).
  - `[false]` `[reject]` (edge) a budget abort after an ejection counts two attempts — the ejection and the budget overrun are each an attempt under AD-7. This is the intended effect, not a double count of one event.
  - `[false]` `[reject]` (edge) a config error stops the lane with no alert — this matches the contract ("returns `stop` with no ledger edit, no enqueue and no comment") and the CI step and lane start. Alerts are for forge lane-stop kinds and the ledger `stop`.
  - `[low]` `[patch]` (verification-gap) the sweep's `merging`, lost and failed branches are untested — three `runLaneProcess` cases were added.
  - `[low]` `[patch]` (verification-gap) `queueState` `not-found` and `conflict` mid-watch are untested — cases were added asserting dequeue, then `released`.
  - intent alignment (descriptive):
    - The diff implements the library reading: an optional `LaneDeps.mergeStep` with no production caller, as in Stories 1.16 to 1.17. The launcher is Story 1.19.
    - The Standing Authority is re-checked once per merge-step round, including after each ejection, but not between enqueue retries or during the watch. The queue does every merge, so there is no runner merge call to guard.
    - A lost fence while `merging` ends without a dequeue, because the unit is no longer this lane's to move.

## Design Notes

**Why `queueState`.** The port can enqueue and dequeue, but it cannot tell a queued PR from an ejected one. Both are open at the same head, and `enqueue` is idempotent, so calling it would re-queue an ejected PR before `main` is merged and CI re-polled. AR7's "still queued" takeover needs the same read. The GitHub adapter already sends the query for `enqueue`. The new operation is read-only and needs no permission beyond `pull_requests: write`, which `pullQueueState` already names.

**`passed_sha` without a review.** `startMerging` requires `passed_sha`. Epic 1 has no review step (Epic 2 adds it, AR17), so the merge step records the head whose checks just passed as `passed_sha` in the fencing heartbeat. Epic 2's review step takes over writing it.

**Gated PRs in Epic 1.** Xarabot's own policy gates every path until Epic 3, so in practice every PR parks. The Maintainer approves it and queues it by hand, and the next lane process's sweep writes `merged`.

## Verification

**Commands:**
- `bun test` -- expected: exit 0
- `bun --bun oxlint` -- expected: exit 0
- `bun --bun tsc` -- expected: exit 0

## Auto Run Result

Status: done

**Summary:** After the CI step passes a PR, `createMergeStep(deps)` takes it through the approval gate and the merge queue.
1. It re-checks config and the Standing Authority on fresh `main`. A failure stops the lane with no edit and no enqueue.
2. It reads the PR's changed paths from `runner.git`. A path that matches `owner_approval_paths` or a Protected Path parks the PR `awaiting-approval`, holding every changed path, with a 🤖 comment. The Maintainer then approves and queues it by hand.
3. Any other PR is fenced (a heartbeat that also records `passed_sha`), written `merging`, enqueued at its head and watched through the new read-only `Forge.queueState`.
   - **Merged:** the record becomes `merged`.
   - **Ejected:** the step dequeues, writes `ejected` (`attempts` + 1, or a park at the cap), and `runLaneProcess` runs the CI step (merge `main`, poll) and then the merge step again.
   - **Every other move out of `merging`:** the step dequeues first.
4. Before `next`, `runLaneProcess` sweeps every parked or merging record whose PR has merged to `merged`, with a journal record each.

**Files changed:**
- Port and adapters:
  - `src/ports/forge.ts`: the `QueueState` type and `Forge.queueState`.
  - `src/adapters/forge/fake/fake-forge.ts`: `queueState` and `control.eject`.
  - `src/adapters/forge/github/github-forge.ts`: `queueState` over the existing `pullQueueState` query.
- New modules:
  - `src/core/ci/approval.ts`: `approvalPaths`, a case-folded `Bun.Glob` gate.
  - `src/lane/diff-paths.ts`: `createGitDiffPaths`, which diffs the merge base against the head in `runner.git`.
  - `src/lane/merge-step.ts`: `createMergeStep` and `approvalComment`.
- `src/lane/lane-process.ts`: `LaneDeps.mergeStep`, the CI step ↔ merge step loop, `sweepMerged` and a shared `journalUnit` helper.
- Tests:
  - `test/core/ci/approval.test.ts`
  - `test/lane/diff-paths.test.ts` (real git)
  - `test/lane/merge-step.test.ts`: every matrix row, the sweep branches, and end-to-end `runLaneProcess` cases.
  - A `queueState` contract case, plus updates to the fake forge, GitHub queue and operations-list tests.

**Review findings:** 19 findings: 14 low, 4 false, 1 maybe-false, plus 3 descriptive intent rows.
- **Patched (low):**
  - A no-op `markMerged` left a stale state.
  - The sweep wrote a journal record for a no-op.
  - Missing tests: the sweep's merging, lost and failed branches, and `queueState` `not-found`/`conflict`.
  - The closing-keyword assertion was missing from the comment test.
  - Hygiene: a duplicate import, an unindented contract scenario and an over-long doc line.
- **Deferred:** 1 maybe-false, medium if true. A spurious ejection may occur if GitHub clears the queue entry before it reports `MERGED`.
- **Rejected:** the rest, each with its reason in the Review Triage Log.

**Follow-up review recommended:** false. 0 high and 0 medium entries were patched; 5 low entries were patched.

**Verification:**
- `bun install`: no changes.
- `bun test`: 2227 pass, 63 skip, 0 fail.
- `bun --bun oxlint` and `bun --bun tsc`: both exit 0.
- Every matrix row has a test that ran and passed.

**Residual risks:**
- Nothing in production wires `createMergeStep` or `createGitDiffPaths` yet; the launcher is Story 1.19.
- The GitHub `queueState` is tested only against the emulator, not live.
- `passed_sha` is the head whose CI passed until Epic 2's review writes it.
- The deferred possible spurious ejection, above.
