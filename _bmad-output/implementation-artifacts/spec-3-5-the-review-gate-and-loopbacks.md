---
title: 'Story 3.5: The review gate and loopbacks'
type: 'feature'
created: '2026-10-25'
status: 'done'
baseline_revision: '71ec3f566df1b93e4033aea06ae9fd6db3439502'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The spine's AD-5 and AD-7 do not yet name the ledger field `enqueued_sha` or the park reason `review-findings`, which this Story names (readiness concern on 71ec3f5).
    evidence: |-
      The Maintainer's decisions in epics.md (Story 3.5) ask for "a separate ledger field" and "a named park reason" without naming them; ARCHITECTURE-SPINE.md AD-5 lists no enqueue field and AD-7 lists runner causes up to `readiness`. Changing the spine is the Maintainer's call (AGENTS.md).
    location: >-
      _bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md (AD-5, AD-7)
    severity: low
---

<intent-contract>

## Intent

**Problem:** No production path runs Story 3.4's review step, so `passed_sha` is still written at the enqueue fence with no review, and nothing loops review findings back to the builder or caps them. `passed_sha` is also overloaded as the coordinator's "enqueued" marker. So a PR can enter the merge queue with a diff no reviewer passed (FR8, AR17, AR20, AR21, AD-16).

**Approach:** Add a runner-side passed gate (head equals `passed_sha`, or a clean `main` merge of it recomputed in `runner.git`), a review-gate step that reviews a head that has not passed and runs capped loopbacks, and wire both into the builder sequence, the retro-item step, the planning and retro steps, the merge step and `reconcile`'s takes. Move the "enqueued" meaning to a new ledger field, `enqueued_sha` (ledger `schema_version` 5). Re-check allowances before each session and enqueue, and have `lane run` compose every allowed reviewer.

## Boundaries & Constraints

**Always:**
- **Ledger v5:** `LEDGER_SCHEMA_VERSION = 5`, and the reader accepts 1 to 5.
  - New field `enqueued_sha: GitSha | null`, serialized right after `passed_sha`. It is the head the runner enqueued the PR at, or fenced before re-parking a taken record. `passed_sha` now means only "a review round with no blocking pass passed this head".
  - New runner cause `review-findings` in `RUNNER_CAUSES`, after `readiness`.
  - Reading a record whose `schema_version` is below 5 and that has no `enqueued_sha` key maps it to `{ enqueued_sha: <stored passed_sha>, passed_sha: null }`. Before this Story, only enqueue paths ever wrote `passed_sha`. Stored records are never rewritten by the reader.
- **Edits:**
  - `claim`, a `claimed` `takeOverStale` and `applyRuling` `rebuild` also clear `enqueued_sha`. `HeartbeatSetSchema` accepts `enqueued_sha`.
  - `park`'s `passedSha` becomes `enqueuedSha`: a park from `merging` sets `enqueued_sha`, and it stays invalid from `claimed`. `parkNew` loses its unused `passedSha`.
  - `takeApproved` clears `enqueued_sha` and keeps `passed_sha`.
  - `startMerging` still needs `passed_sha`, except for a `reconcile:<n>` unit, which gets no review.
- **Passed gate** (`src/lane/passed-gate.ts`, AD-16): `PassedGate({ headSha, passedSha, mainSha, signal }) → Result<{ kind: "passed", how: "head" | "clean-merge" } | { kind: "unreviewed", why }>`. Its git version works in `runner.git` only, fetching any missing SHA first.
  - `passedSha` `null` is `unreviewed`. A head equal to `passedSha` is `passed` `head`, with no git call.
  - Otherwise `passed` `clean-merge` needs all of these:
    - the head has exactly two parents, one of them `passedSha`;
    - the other parent X is `mainSha` or an ancestor of it;
    - `git merge-tree --write-tree passedSha X` is clean;
    - that tree equals `headSha^{tree}`.
  - Anything else is `unreviewed`, with the reason. The record and the commit's author are never trusted.
- **Review loop** (pure, `src/core/review/gate.ts`): `LOOPBACK_CAP = 2`. `reviewNext({ loopbacks, blocking })` gives:
  - `cap` when `loopbacks ≥ 2`, whatever the verdict;
  - else `loopback` when the round is blocking;
  - else `pass`.
- **Review-gate step** (`src/lane/review-gate.ts`, `createReviewGateStep`): on a claimed record with an open PR it takes these steps.
  1. Fresh `main`.
  2. The passed gate at the record's head. `passed` ends the step `progress` `claimed`, with no review.
  3. Otherwise one review round (`ReviewStep`). Any ending other than `progress` `claimed` is passed through as it is.
  4. Then `reviewNext` decides:
     - `cap` parks `blocked` `review-cap`; the inbox owner is the record's owner (the writer).
     - `pass` ends `progress` `claimed`.
     - `loopback` runs the `loopback` edit (cap 2), then a loopback session at the head with the round's findings text.
  5. After a loopback session:
     - `blocked` parks with `blocked.kind`, and `no-op` parks `no-op`.
     - A `done` result needs a spec when `needsSpec`. It is pushed through `pushFix`, and the step ends `progress` `claimed` with `pushed: true`.
  - A `Halt` from the review or the session reaches the caller; anything else never throws.
- **Findings text** (pure): a heading naming the subject and the reviewed SHA, then one line per finding (`severity`, blocking or not, the file, the text), or "No findings." Agent text goes through `sanitizeAgentText` with the lane's secrets. The lane writes it after `prepare`, to `<tmp>/review-findings.md` (`REVIEW_FINDINGS`, beside `CI_FIX_LOG`).
- **Builder sequence** (`lane-process.ts`): PR step, then a loop of the CI step, the review gate and the merge step.
  - `pushed` loops back to the CI step.
  - The merge step's `ejected` loops back to the CI step, as now.
  - The step comes in as a new optional `LaneDeps.reviewGate` (a `ReviewGateStep`). Without it, the run ends after the CI step and never reaches the merge step.
  - The loopback session is a builder session in prompt mode `loopback` (the existing `t.loopback` part, `findings_path`). Only a `done` result picks a spec, as a CI-fix session does. It is pushed by the PR step with `kind: "fix"`.
  - CI-fix and conflict sessions still count `ci_fixes` and never `loopbacks`. Their new head fails the passed gate, so the review runs again.
- **Merge step:** for a record that is not `merging`, before the graph gate, the approval park and the enqueue:
  1. `allowanceRefusal` on fresh `main`'s policy;
  2. then the passed gate.
  - Either failing is a failed attempt naming why.
  - The enqueue fence sets `enqueued_sha: head`. It never sets `passed_sha`.
  - A stale `merging` takeover is watched only when `enqueued_sha` equals the head.
- **Retro-item step:** CI, then the review gate (`storyId` `null`, `needsSpec` `false`), then the merge step.
  - Its loopback session uses a new prompt mode, `buildRetroItemPrompt` `{ mode: "loopback", findings_path }`, with a new template part `retro_item_loopback`. Like `retro_item_ci_fix` it names the item and its globs, and it carries the same "Never change" list. It is pushed as a `fix`.
- **Planning and retro steps:** after CI passes and before the approval gate or the enqueue:
  1. The passed gate. `unreviewed` runs one review round (normal pass only).
  2. A blocking round parks `blocked` `review-findings`, with no loopback.
  3. Before the enqueue: `allowanceRefusal` (a failed attempt), then the fence `{ enqueued_sha: head }`.
  - A `Halt` from the review reaches the coordinator process, as a session's does.
- **`reconcile`:**
  - In `takeApprovedWork`, after fresh `main` and before any take of a unit that is not `reconcile`:
    - `allowanceRefusal(policy, agent, builder_providers)` refused: no take this run, with the reason;
    - then the passed gate at the approved head: `unreviewed` or an error is not taken, noted, the record left `parked`.
  - Its own PR, and `reconcile` takes, skip both checks.
  - Every use of `passed_sha` as an "enqueued" or "re-park" marker reads or writes `enqueued_sha` instead: the re-park's `enqueuedSha`, `untake` when `enqueued_sha` is `null`, the fence after a take's enqueue, and its own PR's fence.
  - `plan.ts`: `GatedTarget.enqueued_sha`; `ApprovalTarget` gains `passed_sha` and `builder_providers`; `parked_at` keys on `enqueued_sha`. `coordinator.ts` `maintainerApproved` does the same.
- **Allowances** (AD-16, AD-21): pure `allowanceRefusal(policy, agent, builderProviders)` in `src/core/review/allowance.ts`. It is the `unattendedRefusal` text when `agent` is not allowed, else a reason when `chooseReviewer(builderProviders, allowed)` is `null`, else `null`.
  - New optional `SessionContext.allowed?: () => Promise<string | null>`. The runner calls it at the start of each `sessionRuns`, which is every fresh session including a restart after a usage limit. A non-null value fails the session with that reason (a failed attempt).
  - The builder, review, retro-item, planning and retro contexts each set it, through a shared helper that takes one snapshot and loads the config. A failed snapshot or an invalid config is a refusal reason too.
- **`lane run`:**
  - Compose `reviewers` for every adapter of `REVIEWER_ORDER` that the policy allows: the lane's own `agent`, or `adapterFor` plus `readReviewerCredential`.
    - A start-check choice whose credential fails still refuses the start.
    - Any other failing one is left out, with a `say` line.
  - Every read reviewer credential joins `secrets`.
  - Build `createGitReviewCheckout`, `createReviewStep` and `createGitPassedGate` once for both roles. Pass `reviewGate` (from `createReviewGateStep`) to the builder's `LaneDeps`, and `agent` and `passed` to the merge step and `reconcile`. `SessionStepDeps` gains `review: ReviewStep` and `passed: PassedGate`.

**Never:** No `Forge` port change and no new forge operation (`src/ports/**` and `test/contracts/**` are outside the globs). Never edit `src/core/lane/**` (import only), `.github/`, docs, the spine or `epics.md`. No review or loopback for `reconcile` PRs. No change to the `ci_fixes` cap or its counting. No special case for an empty `builder_providers` (Story 3.4's deferral stands). No rewrite of stored records. The status-YAML or lockfile rules are never recomputed in the gate: such a merge counts as a change and is reviewed again.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| gate: head | head = `passed_sha` | `passed` `head`, no git call | — |
| gate: clean merge | head = merge(P, X), X ancestor of main, tree = clean merge-tree(P, X) | `passed` `clean-merge` | — |
| gate: later change | head is a single-parent commit on P | `unreviewed` | — |
| gate: other cases | `passed_sha` null; merge with X not on main; conflicting merge-tree; tree differs | `unreviewed`, with why | git failure → `Result` error |
| review passes | gate `unreviewed`, round clean | `passed_sha` = head; merge step enqueues; `enqueued_sha` = head | — |
| loopback | round blocking, `loopbacks` 0 | `loopbacks` 1; session prompt has `findings_path` holding the finding; fix pushed; CI then review again | — |
| loopback cap | after 2 loopbacks, the next round (pass or block) | parked `blocked` `review-cap`, inbox the owner; no enqueue | — |
| CI fix | CI fails once, fix pushed | `ci_fixes` 1, `loopbacks` 0; review re-runs on the new head | — |
| conflict session | merge needs a session | `ci_fixes` 1, `loopbacks` 0; review re-runs | — |
| ejection, same head | queue ejects; head = `passed_sha` | CI again; no review; enqueued again | — |
| flagged spec | Story spec `followup_review_recommended: true`, both clean | two passes, then enqueue | — |
| flagged, follow-up blocks | normal clean, follow-up blocking | loopback; next round runs both passes | — |
| unflagged / no spec | flag false, or a retro item | one pass | — |
| loopback blocked / no-op | loopback result `blocked` / `no-op` | parked `blocked` kind / `no-op` | — |
| revoked allowance, session | fresh policy drops the lane's adapter before a session | no sandbox run; failed attempt naming the allowance | failed attempt |
| revoked allowance, enqueue | policy drops the adapter between CI and the merge step | no enqueue; failed attempt | failed attempt |
| merge step unreviewed | record `passed_sha` ≠ head and no clean merge | no park, no enqueue; failed attempt | failed attempt |
| takeover | stale claimed record whose review blocked | no enqueue before a new review passes | — |
| retro-item loopback | blocking review of a retro-item PR | `retro_item_loopback` prompt, `loopbacks` + 1, same cap | — |
| planning / retro blocked | blocking review of a planning or retro PR | parked `blocked` `review-findings`, no loopback, no enqueue | — |
| reconcile take | approved parked builder PR, `passed_sha` = head | taken, enqueued, `enqueued_sha` = head | — |
| reconcile unreviewed | approved, `passed_sha` null | not taken, left `parked`, reason noted | — |
| reconcile own PR | `reconcile:<n>` PR | no review, no gate; enqueued; `enqueued_sha` = head | — |
| legacy record | v4 JSON, `passed_sha` S, no `enqueued_sha` | reads `enqueued_sha` S, `passed_sha` null | — |
| reviewers composed | policy `[claude, codex]`, claude lane, codex credential present | `reviewers` has both; codex secrets redacted | — |

</intent-contract>

## Code Map

- `src/core/schemas/ledger.ts:13-23,132-146,183-189` -- the version constants, `RUNNER_CAUSES` and `UnitRecordSchema`. Add `enqueued_sha: GitSha.nullable().default(null)` after `passed_sha`.
- `src/core/ledger/codec.ts:34-51,76,111-145` -- `parseRecord`: apply the v<5 mapping to unit records only, on the raw object before `schema.safeParse`. `serializeUnitRecord`: the key order.
- `src/core/ledger/edits.ts`:
  - `fresh:214`, `claim:266` (it clears the review SHAs around L322), `ParkNewParams:336`, `HeartbeatSetSchema:369`;
  - `capped`/`loopback:430-448` (reuse as it is), `takeOverStale:480` (claimed branch about L505);
  - `startMerging:536`, `ParkParams:548` and `park:575-610`, `takeApproved:727-770`, `applyRuling:783` (`rebuild`).
- `src/core/next/coordinator.ts:255-270` -- `maintainerApproved` `parkedAt`.
- `src/core/reconcile/plan.ts:30-75,337-366` -- `ApprovalTarget`, `GatedTarget` and their construction.
- `src/core/review/reviewer.ts` -- `chooseReviewer`, `REVIEWER_ORDER`, `SessionAdapter`. `src/core/lane/runner.ts:78` `unattendedRefusal` (READ-ONLY, import it). New: `src/core/review/allowance.ts`, `src/core/review/gate.ts`, and a findings-text function (new `src/core/review/findings.ts`).
- `src/core/review/review-comment.ts` -- `isBlocking`, and the style of the finding lines. `src/core/sanitize.ts:101` -- `sanitizeAgentText`.
- `src/core/prompt/template.ts:28-62,73-100,276-286` -- `PromptTemplate`, `PLACEHOLDERS`, `retro_item_ci_fix` (the model for `retro_item_loopback`). `src/core/prompt/build-prompt.ts:96-118,443,454-470,514` -- `TemplateSchema`, `RetroItemPromptMode`, the mode union and the parts pick.
- `test/core/prompt/build-prompt.test.ts:260,657` -- `BANNED`, `ITEM_PARTS`. The new part must pass `BANNED` and be listed.
- `src/lane/review-step.ts:104-131,372-385` -- `ReviewStep`, its input, `ReviewRound` (`findings` across passes), the `passed_sha` beat. Reuse as it is. Its `ctx` (L245) gains `allowed`.
- `src/lane/ci-step.ts:248-282` -- `session()`: the model for the review gate's loopback handling (blocked and no-op parks, `needsSpec`, `pushFix`, the `PrStepOutput` adopted). `CiSessionDone`, `PushFix` at L35-76.
- `src/lane/session.ts:80` (`CI_FIX_LOG`), `:313-486` `stepKit`, `:551-648` `stepOps` (`freshMain`, `parkBlocked`), `:907-922` `SessionContext`, `:1117` `sessionRuns`.
- `src/lane/lane-process.ts`:
  - `LaneDeps:125-165`, `builderPrompt:361-393` (prompt mode; write the findings file like the CI log), `sessionAt:412-446` (generalize `ciLog` into a mode);
  - `ciSession:459`, `pushFix:536`, the CI/merge loop `:577-611`, `ctx:342`.
- `src/lane/merge-step.ts:61-77` (deps), `:207` (fence), `:269-305` (the gate goes after the PR checks, before `graphGate`), `:296-301` (the watch check).
- `src/lane/retro-item-step.ts:357-384` (prompt), `:389-410` (sessions), `:424-450` (`ciAndMerge`), `:306` `ctx`.
- `src/lane/planning-step.ts:224-325` (`ciAndGate`, the fence at L304, the adopted path L428). `src/lane/retro-step.ts:207-262` (`ciAndGate`, the fence at L244). Both run `ciAndGate` in `kit.run`; a `Halt` from the review must be rethrown (mirror `retro-item-step.ts:453` `runKit`).
- `src/lane/reconcile-step.ts:333-390` (`parkAwaiting`, `repark`, `untake`), `:437` (`untake` condition), `:573-650` (`take`, the enqueue fence L624), `:657-750` (`takeApprovedWork`, where fresh `main` is read), `:884` (its own PR's fence). `ReconcileStepDeps:120`.
- `src/lane/coordinator-process.ts:112-140` -- `SessionStepDeps`.
- `src/lane/graph-trees.ts:74-117`, `src/lane/merger.ts:128-170` -- fetching missing SHAs, `merge-tree --write-tree`, and `git`/`gitRun`/`needCommit` from `clone.ts`: the model for `createGitPassedGate`.
- `src/cli/lane-run.ts:122-180` (`adapterFor`, `readReviewerCredential`), `:382-387` (the start-check reviewer), `:416-462` (composition). `src/lane/review-checkout.ts:30-37` `createGitReviewCheckout({ gitDir, laneDir, fetch })`.
- Tests and harnesses:
  - `test/core/ledger/fixtures.ts:20-46` `rec()`: add `enqueued_sha: null`, `schema_version: 5`.
  - `test/lane/git-fixture.ts` (a real `runner.git`, commits).
  - `test/lane/review-step.test.ts:60-200` (stub agents, sandbox, checkout, spec helpers).
  - `test/lane/lane-process.test.ts:1475-1570,1999-2050` (CI and merge-step harnesses), and the merge, retro-item, planning, retro, reconcile and coordinator-process step tests.
  - `test/cli/lane-run.test.ts`.

## Tasks & Acceptance

**Execution:**
- `src/core/schemas/ledger.ts`, `src/core/ledger/codec.ts`, `src/core/ledger/edits.ts` -- v5, `enqueued_sha`, `review-findings`, the legacy read mapping, and the edit changes above. Tests: `test/core/ledger/{schema,codec,edits}.test.ts` and `fixtures.ts` -- the mapping (with and without the key, v4 and v5), the v6 stop, each edit's handling of `enqueued_sha`, `startMerging`'s `reconcile` exemption, and `takeApproved` keeping `passed_sha`.
- `src/core/next/coordinator.ts`, `src/core/reconcile/plan.ts` -- read `enqueued_sha`, and carry `passed_sha` and `builder_providers` on approval targets. Tests: `test/core/next/coordinator.test.ts` and `test/core/reconcile/plan.test.ts` -- a re-park is detected through `enqueued_sha`, and `passed_sha` alone does not count.
- `src/core/review/allowance.ts`, `gate.ts`, `findings.ts` (new) -- `allowanceRefusal`, `LOOPBACK_CAP`, `reviewNext` and the findings text. Tests: `test/core/review/*.test.ts` -- case tables, including `cap` with a passing round.
- `src/core/prompt/template.ts`, `build-prompt.ts` -- `retro_item_loopback` and the retro-item `loopback` mode. Tests: `test/core/prompt/build-prompt.test.ts` -- names the item, the globs and `findings_path`; passes `BANNED`; a bad path is `invalid-input`.
- `src/lane/passed-gate.ts` (new) -- the port, `createGitPassedGate`, and a `headPassedGate` that compares the head only, for fakes. Tests: `test/lane/passed-gate.test.ts` -- every gate row of the matrix on a real `runner.git`.
- `src/lane/session.ts` -- `SessionContext.allowed`, the call in `sessionRuns`, the shared allowance helper, `REVIEW_FINDINGS`. Tests: `test/lane/session.test.ts` -- a refusal runs no sandbox and fails with the reason, and `allowed` runs again after a usage-limit restart.
- `src/lane/review-gate.ts` (new) -- `createReviewGateStep`. Tests: `test/lane/review-gate.test.ts`, with the fake forge and stub review step and session:
  - passed with no review; pass; loopback; cap after 2 whatever the verdict; `blocked`/`no-op` loopback; `Halt` propagation.
  - Plus the flagged-both-clean, follow-up-blocks and unflagged rows, composed with the real `createReviewStep` and the stub sandbox and checkout from `review-step.test.ts`.
- `src/lane/lane-process.ts`, `merge-step.ts` -- the sequence, the loopback session mode, the merge-step gate, allowance and `enqueued_sha`. Tests: `test/lane/lane-process.test.ts` and `test/lane/merge-step.test.ts`:
  - the builder rows: review passes, loopback, cap, CI fix, conflict session, ejection, takeover, revoked allowance (session and enqueue), merge step unreviewed;
  - existing enqueue tests updated to records reviewed at the head.
- `src/lane/retro-item-step.ts`, `planning-step.ts`, `retro-step.ts`, `coordinator-process.ts`, `reconcile-step.ts` -- as specified. Tests: their test files gain the retro-item loopback, planning/retro `review-findings`, reconcile take gated/unreviewed/own-PR rows; existing tests get stub `review` and `passed` deps.
- `src/cli/lane-run.ts` -- the reviewer composition and the new deps. Tests: `test/cli/lane-run.test.ts` -- both reviewers composed, a failing non-choice credential is left out, its secrets used.

**Acceptance Criteria:**
- Given any lane about to enqueue a PR other than a `reconcile` PR, when the head is neither `passed_sha` nor its clean merge with a `main` parent recomputed in `runner.git`, then nothing is enqueued and nothing parks for approval.
- Given a blocking review, when the runner handles it, then the next agent session is a loopback at the head with the findings in its temp folder, `loopbacks` counts it, and after 2 loopbacks the unit parks `review-cap` whatever the next verdict.
- Given a ledger written by this runner, when read back, then every enqueue is recorded in `enqueued_sha` and `passed_sha` is set only by a review round.
- Given `bun test`, `bun --bun tsc` and `bun --bun oxlint`, when run, then each passes.

## Spec Change Log

## Review Triage Log

### 2026-10-25 — Review pass
- verdicts: 34 findings — high 0, medium 7, low 24, false 3, maybe-false 0
- findings:
  - `[medium]` `[patch]` (verification-gap) Nothing fails a session through the allowance in the review, retro and retro-item steps (dropping their `allowed:` or the review step's `also` breaks no test). Added a fresh-`main` policy row to each, and a review-step row for a dropped reviewer.
  - `[medium]` `[patch]` (verification-gap) No gate-level test shows a secret redacted from the findings file, and `lane-run` never checks the gate's `secrets`. Added a gate row with `sekrit-credential` in a finding, and a `lane-run` assertion.
  - `[medium]` `[patch]` (verification-gap) No test covers a STOP during a loopback session's usage-limit sleep. Added a builder row (`stop`, `released`, attempts unchanged) and a retro-item row (`MarkerStop`).
  - `[low]` `[patch]` (verification-gap) The planning and retro adopted-PR paths' `runKit` is untested for a `Halt`. Added one adopted-PR row each.
  - `[low]` `[reject]` (intent) The git passed gate is tested alone; the step tests use `headPassedGate` or stubs. The gate is a one-function port, every gate row runs on a real `runner.git`, and composing it into each step test adds git fixtures for no new branch.
  - `[low]` `[reject]` (intent) No test runs a review through the `lane run` composition. `lane-run.test.ts` checks the wiring; the real sandbox cannot run inside a sandboxed session (Story 3.4's same residual risk).
  - `[low]` `[patch]` (intent) The takeover row named "whose review blocked" seeded `passed_sha` = head. It now seeds `reviewed_sha` = head with `passed_sha` null.
  - `[medium]` `[patch]` (intent) A blocking planning or retro review parked in the coordinator owner's inbox, but epics.md says "for the Maintainer". `reviewOrPark` now parks with `inbox_owner` = fresh `main`'s `config.maintainer`.
  - `[false]` `[reject]` (intent) The v5 bump does not share item 24's bump. Item 24 has not shipped, so this Story's bump to 5 is the shared one and item 24 rides it, adding `park.graph_posted` without another bump. Runner pins advancing together is the Maintainer's release step, not code.
  - `[low]` `[defer]` (intent) `enqueued_sha` and `review-findings` are not yet named in the spine's AD-5 and AD-7. The fix is a spine edit, which only the Maintainer may ask for (AGENTS.md).
  - `[low]` `[reject]` (intent) PRs parked awaiting approval before this Story read as unreviewed, so `reconcile` never takes them, and nothing tells the Maintainer beyond the run's reasons. A one-time cost at the switch, recorded in the Design Notes and residual risks. The fix (a comment, or an automatic release) adds new behaviour.
  - `[low]` `[reject]` (blind) PRs parked awaiting approval before this Story read as unreviewed, so `reconcile` never takes them, and nothing tells the Maintainer beyond the run's reasons. A one-time cost at the switch, recorded in the Design Notes and residual risks. The fix (a comment, or an automatic release) adds new behaviour.
  - `[low]` `[reject]` (edge) PRs parked awaiting approval before this Story read as unreviewed, so `reconcile` never takes them, and nothing tells the Maintainer beyond the run's reasons. A one-time cost at the switch, recorded in the Design Notes and residual risks. The fix (a comment, or an automatic release) adds new behaviour.
  - `[low]` `[reject]` (edge) PRs parked awaiting approval before this Story read as unreviewed, so `reconcile` never takes them, and nothing tells the Maintainer beyond the run's reasons. A one-time cost at the switch, recorded in the Design Notes and residual risks. The fix (a comment, or an automatic release) adds new behaviour.
  - `[medium]` `[patch]` (blind) `maintainerApproved` kept `reconcile` due on every coordinator round for an approved PR with no `passed_sha`, which the take always refuses. It now requires `passed_sha` for a unit that is not `reconcile`, with a test.
  - `[false]` `[reject]` (blind) A loopback session that fails still counts a loopback. The AC counts "a review-driven fix session" as a loopback, the same way `ci_fixes` counts a CI-fix session before it runs (`ci-step.ts` `session`).
  - `[false]` `[reject]` (edge) A loopback session that fails still counts a loopback. The AC counts "a review-driven fix session" as a loopback, the same way `ci_fixes` counts a CI-fix session before it runs (`ci-step.ts` `session`).
  - `[medium]` `[patch]` (blind) After a review round, the planning and retro gates ran on the snapshot read before the review. `ciAndGate` now starts again after a round, so every check runs on fresh `main`.
  - `[low]` `[patch]` (blind) Planning and retro checked the allowance only after the approval park. The check now runs right after the review, before the graph and approval gates, as in the merge step.
  - `[low]` `[reject]` (blind) `sessionAllowance`'s snapshot has no retry and no link to the unit's signals. A transient failure costs one attempt (cap 3), and its deadline bounds the wait. Routing it through each caller's `call` adds a parameter at five sites.
  - `[low]` `[reject]` (edge) `sessionAllowance`'s snapshot has no retry and no link to the unit's signals. A transient failure costs one attempt (cap 3), and its deadline bounds the wait. Routing it through each caller's `call` adds a parameter at five sites.
  - `[low]` `[reject]` (edge) `sessionAllowance`'s snapshot has no retry and no link to the unit's signals. A transient failure costs one attempt (cap 3), and its deadline bounds the wait. Routing it through each caller's `call` adds a parameter at five sites.
  - `[low]` `[reject]` (blind) An extra snapshot before every session. An efficiency cost only; a cache adds state.
  - `[low]` `[reject]` (blind) `builderProviders` cannot change `allowanceRefusal`'s result in 0.x. It is kept for the reviewer choice the spec names (and v1 `pi`); harmless.
  - `[low]` `[reject]` (blind) The passed gate accepts one merge on top of `passed_sha` only. As specified; a second merge is reviewed again, which fails closed.
  - `[low]` `[reject]` (blind) A reviewer left out by `composeReviewers` stops the review step only later. Unreachable with 0.x's two adapters, since the other adapter is always the start check's choice.
  - `[low]` `[reject]` (blind) A v5 record with no `enqueued_sha` key reads `null`. Every v5 writer emits the key, and this matches `approved_graph`'s and `retro_result`'s defaults.
  - `[low]` `[reject]` (blind) `retro_item_loopback` does not say what to do when a fix needs a path outside the globs. Unlikely, and the `retro_item` build prompt has the same constraint; such a fix is refused by the write check either way.
  - `[low]` `[reject]` (blind) The findings file does not list blocking findings first or count them. Cosmetic; each line says blocking or not.
  - `[low]` `[patch]` (blind) No test applies an edit over a raw v4 record. Added an edits row: a `heartbeat` over a v4 tip writes v5 with the mapped `enqueued_sha`.
  - `[medium]` `[patch]` (edge) A round that blocks by verdict with no blocking finding gave the loopback "No findings." or only non-blocking lines. `findingsText` now says the verdict requested changes.
  - `[low]` `[patch]` (edge) The planning and retro park reason read "0 blocking finding(s) of 0" for a verdict-only block. It now names the verdict.
  - `[low]` `[reject]` (edge) The passed gate's fetch and git calls share one deadline. The same pattern as the graph trees and the merger, and a timeout is a failed attempt, not a wrong pass.
  - `[low]` `[reject]` (edge) A `reconcile` PR's own enqueue and `reconcile` takes skip the allowance. They carry runner-written content only, with no agent session or review, and the coordinator's next start check refuses a revoked agent. The spec keeps them exempt along with the gate.

## Design Notes

The order is CI, then review, then the merge step. Reviewing after CI means a CI fix costs no review: its head is reviewed after CI passes, and a review is never wasted on a head that fails CI. Because the gate runs before the merge step, every approval park carries a reviewed head, and `reconcile` can enqueue it on approval.

The merger never pushes a clean merge: it reports `clean` and pushes nothing. So the clean-merge rule passes only a merge someone else made, such as GitHub's "Update branch". A rule-resolved status or lockfile merge fails the gate and is reviewed again, which is the fail-closed reading of "recomputes itself".

A refused allowance is a failed attempt, never a stop: no session runs and nothing is enqueued, the unit is released, and the next `lane run` start check refuses the lane with the same reason.

A stale takeover already clears `reviewed_sha` and `passed_sha`, so the taking lane can never enqueue before its own review passes ("picks up the loopback, not the enqueue").

Names chosen here, which the spine's AD-5 and AD-7 do not list yet (readiness concern on `71ec3f5`): `enqueued_sha` and `review-findings`. A PR parked awaiting approval before this Story has no `passed_sha` after the mapping, so `reconcile` leaves it parked until the Maintainer releases it, and the claim that adopts it reviews it.

Findings file golden:
```
# Review findings for Story 3.5 at 0123…cdef

- high, blocking, `src/a.ts`: the loop never ends.
- low, not blocking, `src/b.ts`: a name could be clearer.
```

## Verification

**Commands:**
- `bun test` -- expected: 0 fail; sandbox and live cases skipped inside the session.
- `bun --bun tsc` -- expected: exit 0.
- `bun --bun oxlint` -- expected: exit 0.

## Auto Run Result

Status: done

**Summary:** No PR other than a `reconcile` PR can now park for approval or enter the merge queue unless a review passed its head. Blocking reviews loop back to the builder, at most twice.
- **Passed gate** (`src/lane/passed-gate.ts`). A head passes when it equals `passed_sha`, or when it is a clean merge of `passed_sha` with a commit on `main`. The lane recomputes that merge itself in `runner.git`, trusting neither the record nor the commit's author.
- **Review-gate step** (`src/lane/review-gate.ts`) runs after CI on a head that has not passed. It runs a review round, and a blocking round gets a loopback session at the head, with the findings prefetched into `tmp/review-findings.md`.
  - The loopback is counted in `loopbacks`, and its fix is pushed and taken through CI and review again.
  - After 2 loopbacks, the next round parks the unit `blocked` `review-cap`, whatever its verdict.
  - CI-fix and conflict sessions still count only `ci_fixes`. Their new head simply fails the gate, so the review runs again.
- **Where it is wired:**
  - The builder sequence becomes CI, review gate, merge step.
  - The merge step checks the allowance, then the gate, before any park or enqueue.
  - The retro-item step gets the gate with a new `retro_item_loopback` prompt.
  - The planning and retro steps get one review round. A blocking round parks `blocked` `review-findings` in the Maintainer's inbox, and every check then runs again on fresh `main`.
  - `reconcile`'s takes of approved PRs need the allowance and the gate.
- **Ledger `schema_version` 5:**
  - The new `enqueued_sha` holds the "enqueued or re-parked" marker that `passed_sha` used to carry, and `passed_sha` now means only "a review passed this head".
  - A v1 to v4 record is read with its `passed_sha` moved to `enqueued_sha`. Stored records are never rewritten.
  - `coordinator.ts` and `reconcile` read the new field.
- **Allowance re-check:** before every fresh session (including a restart after a usage limit) and before every enqueue, fresh `main`'s policy must still allow the lane's agent and a reviewer, and for a review pass also the chosen reviewer. A refusal is a failed attempt.
- **`lane run`** composes every allowed reviewer. The builder and coordinator roles share one review step and one git passed gate.

**Files changed:**
- `src/core/schemas/ledger.ts`, `src/core/ledger/codec.ts`, `src/core/ledger/edits.ts`: v5, `enqueued_sha`, `review-findings`, the legacy read mapping, and the edit changes (`startMerging` exempts `reconcile`; `takeApproved` keeps `passed_sha`).
- `src/core/next/coordinator.ts`, `src/core/reconcile/plan.ts`: re-park detection through `enqueued_sha`. `maintainerApproved` needs a `passed_sha` for a unit that is not `reconcile`, and approval targets carry `passed_sha` and `builder_providers`.
- `src/core/review/allowance.ts`, `gate.ts`, `findings.ts` (new): `allowanceRefusal`, `LOOPBACK_CAP`/`reviewNext`, and the findings text.
- `src/core/prompt/template.ts`, `build-prompt.ts`: the `retro_item_loopback` part and the retro-item `loopback` mode.
- `src/lane/passed-gate.ts`, `src/lane/review-gate.ts` (new): the gate (git and head-only), `createReviewGateStep` and `reviewOrPark`.
- `src/lane/session.ts`: `SessionContext.allowed`, `sessionAllowance` and `REVIEW_FINDINGS`.
- `src/lane/lane-process.ts`, `merge-step.ts`, `retro-item-step.ts`, `planning-step.ts`, `retro-step.ts`, `reconcile-step.ts`, `review-step.ts`, `coordinator-process.ts`: the wiring above.
- `src/cli/lane-run.ts`: `composeReviewers`, and the shared review step, review gate and passed gate.
- Tests:
  - new: `test/core/review/{allowance,gate,findings}.test.ts`, `test/lane/passed-gate.test.ts` (a real `runner.git`), `test/lane/review-gate.test.ts` (including the real `createReviewStep` for the flagged, follow-up-blocks and unflagged rows), and the helper `test/lane/review-stub.ts`;
  - updated: the ledger, plan, coordinator, prompt, session, lane-process, merge, retro-item, planning, retro, reconcile, coordinator-process and lane-run tests, and fixtures moved to v5. The builder's matrix rows run through the real PR, CI, review-gate and merge steps in `test/lane/merge-step.test.ts`.

**Review findings:** 34 findings (high 0, medium 7, low 24, false 3, maybe-false 0).
- Patched: 14 entries (medium 7, low 7).
  - The four verification gaps (session allowance in the review, retro and retro-item steps; findings redaction at the gate and in `lane run`; a STOP during a loopback's usage-limit sleep; a `Halt` on the adopted-PR path).
  - `maintainerApproved` no longer keeps `reconcile` due on approved but unreviewed PRs.
  - Planning and retro run every check again on fresh `main` after a review round, with the allowance before the gates.
  - `review-findings` parks in the Maintainer's inbox.
  - The findings text and park reason for a verdict-only block.
  - The takeover row's seed.
  - A v4-edit test.
- Deferred: 1 entry. The spine's AD-5 and AD-7 do not name `enqueued_sha` and `review-findings` yet; that is a Maintainer planning edit.
- Rejected:
  - Each step test using the head-only gate (low, the git gate is tested on its own).
  - No end-to-end `lane run` review (low, the sandbox cannot nest).
  - Item 24's shared bump (false, this bump is the shared one).
  - Legacy approval parks left parked with no notice, reported four times (low, one-time at the switch, noted below).
  - A failed loopback session still counting, reported twice (false, the AC counts sessions, as `ci_fixes` does).
  - `sessionAllowance` with no retry or signal link, reported three times (low).
  - The extra snapshot per session (low, efficiency).
  - `builderProviders` not changing the result (low).
  - One merge only on top of `passed_sha` (low, fails closed).
  - A left-out reviewer stopping only later (low, unreachable in 0.x).
  - A v5 record missing the key reading `null` (low, matches the other defaults).
  - The retro-item loopback prompt's glob conflict (low).
  - Findings ordering (low).
  - The gate's shared deadline (low).
  - The `reconcile` PR's own enqueue skipping the allowance (low, runner-only content, exempt as in the spec).

**Follow-up review recommended:** true. 7 medium entries were patched on this first pass. The unverified risk: the composed real path has never run end to end. That is `lane run`'s `createGitPassedGate` and the shared `createReviewStep` deciding a real PR head in `runner.git`, and a loopback session in the real macOS sandbox reading `tmp/review-findings.md`. The planning and retro flow after a review round (CI and every gate again on fresh `main`) is also tested only against the fake forge.

**Verification:**
- `bun test`: 5164 pass, 322 skip, 0 fail. The skips are the same sandbox, host-only and live cases as at the baseline (322 before this change), so every new test ran. Before review: 5148 pass, 0 fail.
- `bun --bun tsc`: exit 0.
- `bun --bun oxlint`: exit 0.
- Matrix audit: every I/O row maps to a named test that ran and passed, in `passed-gate.test.ts`, `review-gate.test.ts`, `merge-step.test.ts`, `lane-process.test.ts`, the step tests, `codec.test.ts`, `reconcile-step.test.ts` or `lane-run.test.ts`.

**Residual risks:**
- PRs parked awaiting approval before this change read as unreviewed after the v5 mapping. `reconcile` will not take them, and nothing posts a notice. The Maintainer must `release` each one, so the adopting claim reviews it.
- Every lane's `runner_version` must advance together. A v4 runner stops on v5 records.
- The end-to-end path described above has not run.
- Each fresh session and each review pass costs one extra `main` snapshot for the allowance re-check.

**Not committed:** per this run's instructions, the changes stay in the working tree, so the skill's commit-and-clean-tree finalization was not run.
