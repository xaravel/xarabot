---
title: 'Story 2.2: Stale takeover'
type: 'feature'
created: '2026-10-24'
baseline_revision: '96b313a926cf3811fea1503b9a472b5e9ec232b5'
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

**Problem:** `next` passes over every `claimed` or `merging` record (`record-state`), however old its heartbeat. So a lane that dies keeps its unit and its globs forever. The pure `takeOverStale` and `releaseStale` edits exist (Story 1.5), but no lane code uses them (FR3, AR7, AR10).

**Approach:** `next` treats a `claimed` record, or a builder-held `merging` record, as eligible once its `heartbeat_at` is 30 min or more before the snapshot's `now`. The lane process then takes it over. A stale `claimed` record goes through the existing claim-time PR inspection, then `takeOverStale` at `generation` + 1 and `attempts` + 1. That edit parks at the attempts cap. A stale `merging` record is decided by its PR's queue state: a merged PR is marked `merged`; a PR still queued is taken over and the merge step keeps watching it; otherwise `releaseStale` runs.

## Boundaries & Constraints

**Always:**
- Staleness uses only the snapshot's `now` (the forge's time), never the host clock. The rule is `now − heartbeat_at ≥ 30 min`, one shared pure `isStale` from `src/core/ledger/edits.ts`. The takeover edit re-checks it on the swap's tip.
- `parked` records never expire. `released` and `merged` records keep today's rules. A `merging` record whose `lane` is `coordinator` is never stale.
- A stale record is eligible only under every existing `next` rule (Epic gates, `depends_on`, escalations, glob overlap with other records). Other records' globs block it as before, stale or not.
- A takeover of a `claimed` record behaves like a claim of a `released` one. It re-resolves the manifest's globs and re-checks their overlap. It inspects the branch's PRs: open → adopt it with `head_sha` = the PR's head and `base_sha` = `main`; closed or none → `pr` null and `base_sha` = `main`. It clears `reviewed_sha`/`passed_sha`/`approved_sha`. A merged PR → `markMerged` straight away, with no takeover.
- The adopted head reaches `runner.git` through `Workspace.prepare`'s `fetch` before the session (AR16), as for a claimed open PR today.
- A `merging` takeover keeps the record's PR, SHAs and globs, and sets `head_sha` to the queue's head. The merge step then skips the gate, fence, `startMerging` and enqueue, and only watches. After an ejection, the CI step and merge step run as usual.
- Every unit the lane takes over gets the heartbeat keeper (Story 2.1) while it is `claimed` or `merging`. A takeover that parks or releases starts no keeper. Each run journals one unit record.
- Carried deferral from Story 2.1: `releaseHeld` (`stop --now`) runs a fencing `heartbeat` swap before it dequeues a `merging` record. A failed fence means no dequeue and no release for that record.

**Never:**
- No ledger schema change, no new ledger states, and no new forge operation.
- No cross-owner close-and-reopen (AR10 "Cross-owner takeover (v1)"). Takeover adopts the PR exactly as today's claim does. One owner per repo holds until Epic 5.
- No per-run nonce or PID lock (retro C10), no coordinator claim (Story 2.4), and no `runLaneProcess` split (retro item 11).
- No change to `.github/`, `AGENTS.md`, `_bmad/`, the specs folder or the skills.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Not yet stale | `claimed` record, `heartbeat_at` = now − 29:59 | `next`: `record-state`, not eligible | none |
| Stale claimed | `claimed` record, `heartbeat_at` = now − 30:00, G, attempts 0 | `next` returns it with `take_over: "claimed"`, `expect_generation` G; the lane writes `claimed` at G+1, attempts 1, held by itself; session runs | another lane wins the swap → precondition → next round |
| 3rd takeover | stale `claimed`, attempts 2 | `parked` `blocked` `attempts-cap`, G+1, attempts 3; no session, no keeper; outcome `progress` | none |
| Stale claimed, PR merged | branch has a merged PR | `markMerged`; no `takeOverStale` commit; outcome `progress` | none |
| Stale merging, merged | builder-held stale `merging`, PR merged | `merged` (sweep or `queueState`) | none |
| Stale merging, queued | PR `open` and `queued` | `takeOverStale` with `stillQueued`: `merging` at G+1, attempts unchanged; the merge step watches until merged or ejected | none |
| Stale merging, not queued | PR open and not queued, closed, or `not-found` | `releaseStale`: `released`, attempts + 1, `pr` kept; outcome `progress`; no dequeue (nothing queued) | none |
| `queueState` fails | `transient`/`rate-limited` | run ends `failed`, no ledger edit | lane-stop kinds stop the lane, as with every `call` |
| Coordinator-held merging | stale `merging`, lane `coordinator` | never eligible | none |
| Parked | `parked`, `heartbeat_at` years old | never eligible, never taken over | none |
| Infrastructure, approval mismatch | stale record whose `approval.manifest_sha` ≠ the manifest SHA | not eligible, `record-state` reason saying why | none |

</intent-contract>

## Code Map

- `src/core/ledger/edits.ts` -- `STALE_AFTER_MS`, the private `isStale` (~line 141), and `requireStale`. `takeOverStale` (~line 345) keeps all PR fields today; `releaseStale` (~line 475) is ready as is. `claim` (~line 197) is the model for the `globs`/`adoptPr`/`baseSha` handling and the overlap loop. `heldGlobs` is unchanged.
- `src/core/next/next.ts` -- the per-Story loop (~line 152): `rec.state !== "released"` gives `record-state`. `NextStory.expect_generation` (~line 36). The Infrastructure `park` check (~line 240) must not fire for a takeover.
- `src/lane/lane-process.ts` -- `body()` round loop (~line 924): snapshot → `sweepMerged` → `next` → claim. `sweepMerged` (~line 457) marks parked/merging records whose snapshot PR is merged, but `next` still sees the pre-sweep records. `decidePr` (~line 209). Keeper start (~line 1029). `work()` (~line 482): session → PR step → the CI/merge loop (~line 875).
- `src/lane/merge-step.ts` -- `steps()`: 1 snapshot (sets `base` for forge time; keep it), 2 gate, 3 fence + `startMerging` + enqueue, 4 watch. A `merging` input skips 2 and 3.
- `src/lane/ci-step.ts` -- `CiStepInput.specPath` (~line 60) is never read. Remove it so the watch path needs no spec path; `test/lane/ci-step.test.ts:247` passes it.
- `src/lane/stop.ts` -- `releaseHeld` (~line 97) dequeues with no fence (Story 2.1 deferral).
- `src/ports/forge.ts` -- `queueState(pr)` → `{ state, head_sha, queued }`; a missing PR is `not-found`.
- `src/adapters/forge/fake/fake-forge.ts` -- `setNow`, `writeForeignLedger`, `eject`, `mergeQueueHead`, `queue()`, `ledgerLog()`.
- Tests: `test/core/ledger/edits.test.ts` (~line 142 takeOverStale rows, fixtures `T0`/`LATE` in `test/core/ledger/fixtures.ts`), `test/core/next/next.test.ts` (~line 187 the record-state table; `NOW` is T0 + 10 min), `test/lane/lane-process.test.ts` (`harness`, `pr()`, `foreignRecords`, `fake.control.setNow`), `test/lane/merge-step.test.ts`, `test/lane/stop.test.ts`.
- Sandbox: about 73 tests fail at the baseline in a sandboxed session (loopback listen, `ps`/`kill`). Compare failures by name with the baseline.

## Tasks & Acceptance

**Execution:**
- `src/core/ledger/edits.ts` -- export `isStale`. Give `takeOverStale` optional `globs`, `adoptPr` and `baseSha`, validated like `claim`'s. For `claimed`: normalize `globs` (default: the record's), check their overlap with other records, apply the claim's PR fields, and clear `reviewed_sha`/`passed_sha`/`approved_sha`. For `merging`: `adoptPr.pr` must equal `record.pr` and sets `head_sha` only. -- One edit holds every takeover rule.
- `src/core/next/next.ts` -- add `NextStory.take_over: "claimed" | "merging" | null`. Make a stale `claimed` record, or a stale non-coordinator `merging` record, eligible, with `expect_generation` set to its generation. Give an Infrastructure takeover whose approval does not match `record-state`; never the `park` outcome. -- AC 1, 4.
- `src/core/lane/takeover.ts` (new) -- pure `staleMergingAction(q: { state, queued } | "not-found") → "merged" | "take-over" | "release"`. -- One case table for the `merging` outcomes.
- `src/lane/lane-process.ts` -- have `sweepMerged` return the records it wrote, and feed them to `next`. Route `take_over` as the matrix says (claimed: PR inspection + `takeOverStale`; merging: `queueState` + `staleMergingAction`). Start the keeper only for `claimed`/`merging`. Give `work()` a watch mode that goes straight to the merge step, then the usual CI/merge loop after an ejection. Update the header comment. -- AC 1–3.
- `src/lane/merge-step.ts` -- an input record in state `merging` skips the gate, fence, `startMerging` and enqueue, and watches. Update the header. -- AC 2.
- `src/lane/ci-step.ts`, `test/lane/ci-step.test.ts` -- drop the unused `specPath` input.
- `src/lane/stop.ts` -- add a fencing `heartbeat` before the dequeue in `releaseHeld`.
- Tests -- add case tables: `test/core/ledger/edits.test.ts` (new takeover params, overlap, adopt); `test/core/next/next.test.ts` (29:59/30:00 for claimed and merging, coordinator merging, parked old, Infrastructure mismatch, `take_over` values); `test/core/lane/takeover.test.ts`. Add lane-level cases in `test/lane/lane-process.test.ts` against the fake: stale claimed taken over with no PR, with an open PR (prepare start/fetch = PR head, record `head_sha`/`pr_owner`), with a merged PR; 3rd takeover parks; 29:59 not taken; stale merging queued then merged by the fake's queue; ejected after takeover runs CI again; not queued released with `pr` kept; merged. Add a merge-step watch-only case and a `stop.test.ts` lost-fence case.

**Acceptance Criteria:**
- Given BOB's `claimed` record for Story 1.1 with `heartbeat_at` exactly 30 min before the fake forge's `now`, when ALICE's lane process runs, then the ledger shows one `takeOverStale` commit: the record is held by ALICE at `generation` + 1 and `attempts` + 1, and the session runs. With `heartbeat_at` 29:59 old instead, Story 1.1 is passed over with a `record-state` reason.
- Given BOB's stale `merging` record whose PR is still queued, when ALICE's lane process runs, then ALICE holds it `merging` at `generation` + 1 with no session and no enqueue. When the fake's queue merges the PR, the record becomes `merged` and the run ends `progress`.
- Given a stale `claimed` record and an open PR on the Story's branch, when the new holder takes it over, then the record's `head_sha` is the PR's head, and `Workspace.prepare` gets `start` and `fetch` equal to that head before the first session.
- Given `releaseHeld` whose snapshot shows this lane holding a queued `merging` record, when another lane takes that record at `generation` + 1 before the fence, then `releaseHeld` neither dequeues the PR (it stays in `queue()`) nor releases the record, and reports the unit failed.
- Given `bun test`, when it runs, then it shows no failure that is not in the baseline's sandbox-only set.

## Spec Change Log

## Review Triage Log

### 2026-10-24 — Review pass
- verdicts: 28 findings — high 0, medium 3, low 15, false 10, maybe-false 0
- findings:
  - `[low]` `[patch]` (verification-gap) No test shows the keeper beating after a stale `merging` takeover; deleting `keep()` before watch mode fails nothing. — Pre-verified gap. Added a lane test: the watch's first sleep waits for keepAlive commits, which land with the record held by ALICE at generation 4.
  - `[low]` `[patch]` (verification-gap) The claimed takeover's re-resolved manifest globs are unverified at the lane (the fixture's globs equal the manifest's). — Pre-verified gap. The no-PR takeover test now seeds `src/old/**` and asserts the record holds `src/s0/**`.
  - `[low]` `[patch]` (verification-gap) The merging takeover's `head_sha` from `queueState` is unverified at the lane (record head = queue head in the fixture). — Pre-verified gap. Added a lane test with the record at another head: the takeover writes the queue's head, then the new `passed_sha` guard fails it.
  - `[low]` `[reject]` (intent-alignment 1) A stale `merging` record is met only when `next` picks it, so a stale record in an ineligible Story keeps its globs until it is eligible again. — Real but narrow: eligibility held at claim time, and it lapses only if an escalation opens or the Epic context breaks afterwards. Meeting records outside `next` would add a second sweep path.
  - `[false]` `[reject]` (intent-alignment 2) The 3rd-takeover cap counts the shared `attempts` counter, not takeovers alone. — AD-6/AD-7 say "Once `attempts` ≥ 3 it becomes `parked`", and AD-5 says counters live in the record so a takeover never resets a cap; that is the normative rule.
  - `[low]` `[reject]` (intent-alignment 3) No real `runner.git` fetch is exercised; the merging path fetches nothing and `passed_sha` is never fetched. — `Workspace.prepare` (with its own tests) fetches the adopted head before the session. A claimed takeover clears `passed_sha`; a merging one has `passed_sha` = head and only reads the queue. Any later git step (merger, diff paths) fetches what is missing.
  - `[low]` `[reject]` (intent-alignment 4) The fixtures are cross-owner, and `pr_owner` becomes the new owner on the claimed path but stays the old owner on the merging path; AR10's v1 close-and-reopen is absent. — One owner per repo until Epic 5 (one Maintainer, `XARABOT_MAX_BUILDERS=1`), so no user meets it yet. The claimed path copies today's claim adoption; close-and-reopen is a new forge flow.
  - `[low]` `[reject]` (intent-alignment 5) No lane test separates the host clock far from forge time for staleness. — The lane passes `snap.now` to every takeover edit, and the edit re-checks staleness on that `now`; the pure tables pin the boundaries. No wrong outcome is shown.
  - `[false]` `[reject]` (intent-alignment 6) A stale claimed record with a merged PR is marked merged with no generation bump. — AD-3 lets any lane write `merged`, and AD-9 says a merged PR means write `merged`. The Design Notes record this choice.
  - `[false]` `[reject]` (intent-alignment 7) The diff goes beyond the Story (the `releaseHeld` fence, `specPath` removal, sweep feed, merge-step watch mode). — Each one is a spec task. The fence is Story 2.1's deferral, and its evidence names this Story.
  - `[false]` `[reject]` (blind) `takeOverStale` does not re-check the Infrastructure approval on the tip, unlike `claim`. — While a record is `claimed`, no edit changes its `approval` (only `applyRuling` on a `parked` record does). `next` checks it against the snapshot's manifest SHA, so the tip check could never differ.
  - `[medium]` `[patch]` (blind) A `merging` takeover accepts any queue head, and watch mode skips the gate and CI, so a head other than the one that passed could be watched through to `merged`. — Real if the queue ever holds a head other than `passed_sha`. Watch mode now fails such a record through `failed()` (fence, dequeue, failAttempt), with a merge-step test.
  - `[low]` `[reject]` (blind) `adoptPr` is reused for the merging takeover, where `pr_owner` and `base_sha` are ignored. — True, but the edit's doc says so and it changes no outcome. A new parameter is new public surface.
  - `[false]` `[reject]` (blind) Watch mode with no merge step strands a `merging` record. — `src/cli/lane-run.ts:254` always wires `mergeStep`; only test harnesses leave it out.
  - `[low]` `[patch]` (blind) No test shows the keeper beating after a successful takeover. — Same root as the first verification-gap row; fixed there.
  - `[low]` `[reject]` (blind) The `releaseHeld` fence stamps `heartbeat_at`, so a dequeue that then fails delays takeover by up to 30 min. — Real but rare: it needs a failed dequeue right after a successful fence, and before this Story the record also stayed `merging` then. A non-stamping fence would be a new edit.
  - `[low]` `[reject]` (blind) Watch mode lacks failure-path tests (head moved, closed, budget), and step 1 loads policy it does not use. — The watch loop is the same code as in normal mode, where those paths are tested. The gate ran when the PR was first enqueued.
  - `[low]` `[reject]` (blind) The `prNumber as number` / `q as QueueState` casts rely on `staleMergingAction`'s outputs, and `pr === null` has no test. — Cosmetic: `pr` null goes to `not-found` and so to `release`, so neither cast can be reached with a bad value. A tagged union would change the public type.
  - `[low]` `[reject]` (blind) For a `merging` takeover, `next` checks the manifest's current globs for overlap, while the record keeps its old globs. — Real only when a manifest's globs change while its unit sits stale in `merging`; graph planning units (Story 2.7) don't exist yet. A role-specific overlap set adds a branch to `next`.
  - `[false]` `[reject]` (blind) The merged-PR shortcut stamps `snap.now`, not `forgeNow()`. — A `merged` record's `heartbeat_at` is never read: `merged` is never stale-checked and is deleted once done.
  - `[false]` `[reject]` (blind) `work()` uses `start: null` as a hidden mode switch. — Its doc comment states the null mode; no caller can misread it, and no harm is named.
  - `[false]` `[reject]` (blind) The review diff leaves out the spec file. — By design: the spec goes only to the edge-case layer, as the claims file.
  - `[medium]` `[patch]` (edge) A queued head other than `passed_sha` is held `merging` and watched. — Same root as the blind queue-head row; fixed there.
  - `[medium]` `[patch]` (edge) Watch mode accepts a `merging` record whose head never passed CI. — Same root as the blind queue-head row; fixed there with the `passed_sha` guard.
  - `[false]` `[reject]` (edge) A merging takeover with `mergeStep` undefined goes stale again. — Same refutation as the blind no-merge-step row.
  - `[low]` `[reject]` (edge) The `releaseHeld` fence stamps `snap.now`, older than a later keeper beat. — `stopNow` kills the lane process (and with it the keeper) before `releaseHeld` takes its snapshot, so no later beat exists; at most the stamp is a few seconds old.
  - `[low]` `[reject]` (edge) A merging takeover can be blocked by manifest globs it never holds. — Same as the blind `merging` globs row.
  - `[false]` `[reject]` (edge, claim) "One edit holds every takeover rule", yet only `next` checks Infrastructure approval. — Same refutation as the blind approval row.

## Design Notes

- **Why `takeOverStale` gets claim's PR handling.** AD-9 says every claim inspects the branch, and AC 3 says a takeover adopts the open PR. Doing both in one CAS keeps the record consistent with the PR on any re-fetched tip.
- **Why the sweep's results reach `next`.** Without them, `next` could pick a stale `merging` record that the sweep just marked `merged`. The takeover swap would then fail, and the round would be wasted.
- **A merged PR skips the takeover.** `markMerged` has no holder check, and AD-3 lets any lane write `merged`, so taking the unit first would only count a needless attempt.
- **Lazy fetch.** A merging takeover only watches the queue through forge reads. Any later git action (the CI step's merge after an ejection) fetches missing SHAs into `runner.git` first, through the merger's existing fetch.

## Verification

**Commands:**
- `bun test` -- expected: no failure outside the baseline's sandbox-only set (compare with the same run at `96b313a926cf3811fea1503b9a472b5e9ec232b5`)
- `bun test test/core/next test/core/ledger test/core/lane test/lane/lane-process.test.ts test/lane/merge-step.test.ts test/lane/stop.test.ts` -- expected: all pass apart from baseline sandbox-only failures
- `bun --bun oxlint` -- expected: exit 0
- `bun --bun tsc` -- expected: exit 0

## Auto Run Result

Status: done

**Summary.** Story 2.2 is complete:
- `next` now offers a `claimed` record, or a builder-held `merging` record, once its `heartbeat_at` is 30 min or more before the snapshot's `now` (`take_over`). `parked` records and coordinator-held `merging` records never expire.
- **Stale `claimed`:** the lane inspects the branch's PRs. A merged PR gets `markMerged`. Otherwise `takeOverStale` runs at `generation` + 1 and `attempts` + 1, re-resolving the manifest's globs and adopting the open PR at its head, or starting from `main`. At the attempts cap it parks `blocked` `attempts-cap` instead.
- **Stale `merging`:** its PR's queue state decides. A merged PR gets `markMerged`. A PR still queued is taken over at `generation` + 1, and the merge step only watches it, failing it if the queued head is not `passed_sha`. Any other state gets `releaseStale` (attempts + 1, `pr` kept).
- The keeper runs for every unit taken over as `claimed` or `merging`.
- The sweep's `merged` records now reach `next`.
- `stop --now`'s dequeue is now fenced (Story 2.1's deferral).

**Files changed (baseline `96b313a926cf3811fea1503b9a472b5e9ec232b5` → working tree):**
- `src/core/ledger/edits.ts` -- `isStale` exported; `takeOverStale` gains `globs`/`adoptPr`/`baseSha`, the overlap check and the claim's PR fields. A merging takeover changes only `head_sha`.
- `src/core/next/next.ts` -- `NextStory.take_over`; stale `claimed` and builder-held `merging` records are eligible. An Infrastructure takeover with a mismatched approval gets `record-state`.
- `src/core/lane/takeover.ts` (new) -- the pure `staleMergingAction`.
- `src/lane/lane-process.ts` -- takeover routing, the sweep feeding `next`, the keeper only for held units, and `work()`'s watch mode.
- `src/lane/merge-step.ts` -- a `merging` input skips the gate, fence, `startMerging` and enqueue, and watches. A head other than `passed_sha` fails the attempt (fence, dequeue, failAttempt).
- `src/lane/ci-step.ts` -- drops the unused `specPath` input.
- `src/lane/stop.ts` -- a fencing `heartbeat` before `releaseHeld`'s dequeue.
- `test/core/ledger/edits.test.ts`, `test/core/next/next.test.ts`, `test/core/lane/takeover.test.ts` -- case tables: 29:59/30:00, each merging outcome, the cap, parked/coordinator/merged never stale, Infrastructure approval.
- `test/lane/lane-process.test.ts` -- lane-level cases against the fake forge for every matrix row. They include the keeper beating during a merging takeover, re-resolved globs, a queue head other than `passed_sha`, and `queueState` lane-stop kinds. Two existing lost-claim tests now seed fresh heartbeats.
- `test/lane/merge-step.test.ts` -- watch-only cases: merged, ejected, and queued at a head other than `passed_sha`.
- `test/lane/stop.test.ts` -- a lost fence means no dequeue and no release.
- `test/lane/ci-step.test.ts`, `test/lane/pr-step.test.ts` -- fixtures follow the type changes.

**Review findings.** 28 findings: high 0, medium 3, low 15, false 10, maybe-false 0.
- Patches applied, in 4 entries:
  - The `passed_sha` guard in watch mode (medium: 3 findings).
  - A keeper test after a merging takeover (low: 2 findings).
  - Re-resolved globs at lane level (low).
  - The queue head at lane level (low).
- Deferred: none.
- Rejected: 21 findings. Each one's reason is in the Review Triage Log above. The most notable:
  - A stale record in a Story that became ineligible keeps its globs until it is eligible again.
  - Cross-owner close-and-reopen (AR10 v1) is absent; one owner per repo holds until Epic 5.
  - For a `merging` takeover, `next` checks overlap on the manifest's current globs.
  - A fence that succeeds before a failed dequeue in `releaseHeld` refreshes the heartbeat.

**Follow-up review recommended: false.** Patched by entry verdict: high 0, medium 1, low 3. This was a first pass with no high and fewer than two medium patches.

**Verification:**
- `bun install --frozen-lockfile`: installed the lockfile's 10 packages; `node_modules` was missing.
- `bun test` at the baseline (before any change): 2423 pass, 73 fail, 162 skip. All 73 are sandbox-only (loopback listen, `ps`/`kill`).
- `bun test` after the patches: 2510 pass, 73 fail, 162 skip. The 73 failures match the baseline's by name; there are no new failures.
- `bun test test/lane/lane-process.test.ts -t "stale takeover"`: 20 pass, 0 fail in each of 5 runs.
- The targeted suites (`test/core/next test/core/ledger test/core/lane` plus the lane-process, merge-step and stop tests): only the 5 baseline sandbox-only failures, in each of 5 runs.
- `bun --bun tsc`: exit 0. `bun --bun oxlint`: exit 0.

**Residual risks:**
- A stale record held by a Story that is no longer eligible (an escalation opened, or a broken Epic context) is not met until it is eligible again.
- Cross-owner takeover adopts the old owner's PR, as today's claim does.
- If the manifest's globs change while the unit is stale in `merging`, `next` checks overlap on the new globs while the record keeps the old ones.
- The changes are left uncommitted in the working tree, as the lane runner's rules require, and the runner makes the commit. This is a deliberate departure from this workflow's commit step.
