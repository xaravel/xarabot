---
title: 'Story 2.10: Retro-item units'
type: 'feature'
created: '2026-10-25'
baseline_revision: '8a265b5b983dcaf85ff34e4073248c7fc0c45fb1'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      The `lane run` wiring of the retro-item step, including `secrets: [credential.value]` for redaction, is checked only as "is a function".
    evidence: |-
      test/cli/lane-run.test.ts asserts typeof d.steps["retro-item"] === "function" and nothing more; dropping secrets from the wiring would leave PR text unredacted with no failing test. The planning and retro steps' identical wiring has the same unverified pattern, and closing it needs a lane-run-level harness change beyond this Story.
    location: >-
      src/cli/lane-run.ts:333
    severity: low
---

<intent-contract>

## Intent

**Problem:** The coordinator never works the open retro action items that `reconcile` writes to `retro-gates.yaml` (FR10, AR10, AR14). `next` has no retro-items position. `lane run` wires no `retro-item` step, so such a unit would end idle and unclaimed. Nothing sets an item `done` after its PR merges, so its gate holds dependents for good.

**Approach:**
- `next(snapshot, 'coordinator')` gains the retro-items position (AD-13, step 5), after retro.
- A new retro-item coordinator step runs one no-skill `build` session for the item. Its PR then follows a Story's path: the commit and push, CI with CI-fix and conflict sessions, the graph-change and approval gates, and Story 2.6's enqueue.
- The next `reconcile` after a merge sets the item `done`.
- The builder PR/CI/merge helpers are generalized from `NextStory` to a named unit, so the Story path is reused, not copied.

## Boundaries & Constraints

**Always:**
- **Retro-items position**, after retro:
  - Epics are taken in ascending order from `snapshot.retro_gates.epics`, then items in file order.
  - Only `status: open` items with `route: lane` are candidates. `route: maintainer` and every other status are skipped with no reason; Epic 4 lists maintainer items in the inbox.
  - An item with `globs: []` is never returned. It gets a reason with code `unclaimable` and subject `retro-item:<id>`.
  - The unit is `retro-item:<id>`, its globs `coordinatorGlobs({kind:"retro-item", globs})`. Its branch is `unitBranch(branches.xarabot, unit)`, which gives `<xarabot-namespace>retro-item-<id>`.
  - The record and overlap rules are the retro position's:
    - none: claim it new;
    - `released`: re-claim at its generation;
    - stale `claimed` with no open PR: take it over;
    - otherwise it holds (`record-state`);
    - an overlap with any held glob passes the item over (`overlap`).
- **Retro-item step** (`src/lane/retro-item-step.ts`, `steps["retro-item"]` in `lane-run`):
  - **The item** is read from the step's snapshot `retro_gates`. A missing item, or one not `open`, is a failed attempt.
  - **An adopted PR** (`record.pr` set) runs no session: it goes to CI and then the merge step.
  - **Otherwise**, one session at `main` (`kind: "build"`), with a prompt from `buildRetroItemPrompt`:
    - the prompt runs no skill;
    - it names the unit and the item (id, Epic, action text and globs), plus the Human Live Steps and repo sections;
    - the result is `build`, with no `story_spec_path` cross-check. A `human-live-step` result must name an offered step (`checkHumanLiveStep`);
    - `blocked` parks `blocked` with `blocked.kind`, and `no-op` parks `no-op`.
  - **A `done` result's push** (and each CI fix's):
    - fresh `main` and the config (a bad config ends the step `stop`);
    - the commit onto fresh `main` under `coordinatorWriteRules` with the record's globs and `refused`. A refusal parks `write-check`, an empty commit parks `no-op` and a conflict is a failed attempt;
    - the lease (`branchHead` for a new PR, else `record.head_sha`), fence, push;
    - a build opens the PR, closing orphans when `openPr` fails; a fix keeps the PR;
    - the `record` beat with the PR and SHAs, then the 🤖 status comment.
    - The commit message and PR title are `<unit>: <summary>`; the body is the summary, the body and the item's action text.
  - **CI**: `createCiStep`, with fix and conflict sessions in `ci-fix` mode, `CI_FIX_CAP`, lockfile regeneration and no spec file needed.
  - **The merge step** runs with `watch: false`:
    - the graph gate, then the approval gate (`owner_approval_paths` + `effective_protected_paths`), which parks `awaiting-approval`;
    - else fence `passed_sha`, `startMerging`, enqueue at the head, then end `progress` `merging`. The coordinator stops the unit's keeper (AD-6), and `reconcile` checks the queue (Story 2.6).
  - **No write to `retro-gates.yaml`**: the claimed item stays `open`.
- **Write check.**
  - `CoordinatorWriteRules` gains `refused: RefusedPaths | null`, the builder's path classes with no exceptions (`coordinator-file` … `protected-path`).
  - `coordinatorWriteRules` sets it only when given `builderRefusals: {config, policy}`. The retro-item step always passes it, so a retro item is refused every path a builder is (AD-13, AD-30), case-folded.
  - Coordinator classes win; then a builder class is reported.
- **`reconcile`.**
  - For each `retro-item:<id>` record `merged` as of the run whose item is listed and not `done`, the `retroGates` edit sets the item's `status: done`, with the summary line `epics.<N>.items: <id> <old> -> done`. This happens in the same deterministic rewrite as the retro additions.
  - A merged record whose item is not listed is logged and skipped (`retroItemsMissing`).
  - Once that PR merges, `doneOnMain` deletes the record (already).
- **Generalized helpers.**
  - `CiStepInput.unit: CiUnit` {`unit`, `subject`, `branch(config)`, `needsSpec`}, and `prStep` becomes `pushFix(CiFix)`.
  - `MergeStepInput.unit: StepUnit` {`unit`, `subject`}, plus `watch?: boolean` (default `true`).
  - `statusComment` and `mergeComment` take `subject`. `approvalComment` is replaced by `gateComment`.
  - The Story subject is `Story <id>`; a coordinator unit's is `Unit <unit>`.
  - Lockfile regeneration moves to `src/lane/regenerate.ts`, shared by the lane process and the step.
  - Builder behaviour and texts are unchanged.

**Never:**
- No ledger schema change and no new park reason.
- No `in-progress` write.
- No queue watching by the coordinator.
- No `/xarabot done|defer` rulings (Epic 4).
- No change to `.github/`, `AGENTS.md`, `_bmad/`, the spec folder or the `runner_version` pin.
- No agent GitHub access.
- No mocks.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Due | Epic 2 item `open`, `route: lane`, globs `["src/x/**"]`, nothing else due | `retro-item:<id>`, globs `["src/x/**"]`, branch `xarabot/retro-item-<id>` | — |
| No globs | item `globs: []` | not returned; reason `unclaimable` naming it | — |
| Maintainer | `route: maintainer` | skipped | — |
| Done | item `done` | skipped | — |
| Order | retro due and item due | `retro:<N>` first | — |
| Held | record `parked` / `merged` | `record-state` reason | — |
| Overlap | another record holds `src/**` | `overlap` reason | — |
| Happy | session `done`, CI passes, `owner_approval_paths: ["**"]` | PR opened, parked `awaiting-approval` with the gate comment | — |
| Ungated | no gated path | `merging`, enqueued, step ends | enqueue error: failed attempt |
| CI fails | first check fails, fix `done` | one CI-fix session in `ci-fix` mode, fix pushed, `ci_fixes` 1 | cap: park `ci-fix-cap` |
| Blocked | result `blocked` `intent-gap` | park `blocked` `intent-gap` | — |
| Write check | diff touches `src/CLAUDE.md` or a path outside the globs | park `write-check` (`agent-config` / `outside-unit`) | — |
| Adopted | released record with open PR | no session; CI, then gate | — |
| Reconcile | `retro-item:<id>` merged, item `open` | PR sets the item to `done`; next run deletes the record | item absent: logged, skipped |

</intent-contract>

## Code Map

- `src/core/next/coordinator.ts`: `nextCoordinator` (line 440, "Retro items arrive in Story 2.10"), `nextRetro` (the record/overlap model), `coordinatorGlobs`, `unitBranch`, `doneOnMain` (`retro-item`, already) and `describeHold`. `src/core/schemas/retro-gates.ts`: `RetroItemSchema` (globs normalized at parse).
- `src/core/prompt/{template,build-prompt}.ts`: the parts, `PLACEHOLDERS`, `TemplateSchema`, `checkTemplate`/`fill`, `SafeText`, `AbsolutePath`, `buildRetroPrompt` (the model) and `BUILD_RESULT_JSON_SCHEMA`.
- `src/core/lane/write-check.ts`: `classify` (builder classes; uses only the refused-path fields), `checkCoordinatorWrite` and `coordinatorWriteRules`.
- `src/core/reconcile/{plan,retro-gates-edit}.ts`: `retroAdditions`, `planReconcile`'s `retroGates`, `applyRetroResults` and `editRetroGates`. `src/lane/reconcile-step.ts:882`: `retroWithoutResult` logging.
- `src/lane/ci-step.ts`: `CiStepInput`, `session()` (spec check line 274, `prStep` call 277), `mergeComment`, `conflictLogText` ("this Story's PR"), the branch at line 334. `src/lane/merge-step.ts`: `MergeStepInput`, `approvalComment`, `gateAndEnqueue` and the watch loop at line 310. `src/lane/pr-step.ts`: the publish sequence to mirror, plus `statusComment`, `prText` and `shown`.
- `src/lane/lane-process.ts`:
  - `regenerate` (line 466) moves out;
  - `ciSession`/`sessionAt` (`ci-fix` mode, `CI_FIX_LOG`), the `ciStep`/`mergeStep` calls (lines 571, 603) and `checkHumanLiveStep`.
- `src/lane/retro-step.ts`: the coordinator step model: `stepKit`, `aborted`, `parkBlocked`, `closeOrphans`, the session context and runner, `onLimitStop`/`MarkerStop`, and the sections from `input.files`.
- `src/lane/coordinator-process.ts`: the `merging` keeper stop and the docs. `src/cli/lane-run.ts:296`: wiring (`createGitMerger`, `createGitDiffPaths`, `graphTrees`).
- `docs/maintainer/self-host.md:496`: the retro paragraph, the model for a retro-item one.
- Tests:
  - `test/core/next/coordinator.test.ts` (case table, `world()`, the retro-gates fixture at line 348);
  - `test/core/prompt/build-prompt.test.ts` (word tests);
  - `test/core/lane/write-check.test.ts:547`;
  - `test/core/reconcile/{plan,retro-gates-edit}.test.ts`;
  - `test/lane/{ci-step,merge-step,pr-step,retro-step,lane-process}.test.ts` (harnesses).

## Tasks & Acceptance

**Execution:**
- `src/core/next/coordinator.ts` -- add `retroItemCandidates` and `nextRetroItem`, and call it after `nextRetro` -- the position.
- `src/core/prompt/template.ts`, `src/core/prompt/build-prompt.ts`:
  - add the parts `retro_item`, `retro_item_ci_fix` and `result_retro_item`;
  - add the placeholders `retro_item_unit`, `retro_item_id`, `retro_item_epic`, `retro_item_text` and `retro_item_globs`;
  - add `buildRetroItemPrompt`, with modes `build` and `ci-fix` -- the no-skill prompt.
- `src/core/lane/write-check.ts` -- add `refused` and `builderRefusals` -- the builder refusals for retro items.
- `src/core/reconcile/retro-gates-edit.ts`, `src/core/reconcile/plan.ts`, `src/lane/reconcile-step.ts` -- add item `done` edits and `retroItemsMissing` -- the merged-item write.
- `src/lane/session.ts`, `src/lane/ci-step.ts`, `src/lane/merge-step.ts`, `src/lane/pr-step.ts`, `src/lane/regenerate.ts` (new), `src/lane/lane-process.ts` -- generalize to a named unit and add `watch` -- reuse of the Story path.
- `src/lane/retro-item-step.ts` (new) -- add `createRetroItemStep` and `retroItemPrText` -- the step. `src/cli/lane-run.ts`, `src/lane/coordinator-process.ts` -- wiring and docs.
- `docs/maintainer/self-host.md` -- add a retro-items paragraph covering what is due, the branch, the PR path, `done` after merge, and no-glob and maintainer items.
- Tests:
  - every matrix row;
  - the coordinator case-table rows;
  - prompt rows and the retro-item word test;
  - write-check rows for the builder classes under retro-item rules;
  - plan and edit rows;
  - retro-item-step rows;
  - the adapted CI and merge harnesses plus a `watch: false` row.

**Acceptance Criteria:**
- Given an open `route: lane` item with globs and nothing earlier due, when `next(snapshot, 'coordinator')` runs, then it returns `retro-item:<id>` on `xarabot/retro-item-<id>`, and the lane runs its step instead of idling `no retro-item step`.
- Given a retro-item session that ends `done`, when its PR's CI passes in this repo, then it parks `awaiting-approval`, and `retro-gates.yaml` on `main` still shows the item `open`.
- Given the merged PR, when `reconcile` runs, then its PR sets the item `done`.
- Given `bun test`, `bun --bun tsc` and `bun --bun oxlint`, when run, then they report 0 fail and no error.

## Spec Change Log

## Review Triage Log

### 2026-10-25 — Review pass
- verdicts: 29 findings — high 0, medium 1, low 22, false 6, maybe-false 0
- findings:
  - `[low]` `[patch]` (blind) The `template.ts` header says the retro-item parts "carry what the Story parts do not", the reverse of the rule the word test checks. — Reworded: they carry no word the Story parts may not carry.
  - `[low]` `[reject]` (blind) A `merged` `retro-item` record whose item was removed from `retro-gates.yaml` is never deleted and is logged every run. — Real, but it needs the Maintainer to delete an item after its PR merged. The fix adds a delete branch to the plan; the log line names it for a hand clean-up.
  - `[low]` `[patch]` (blind) The runbook gives no recovery for a parked item, and omits that an ejected ungated PR re-parks for a fresh approval. — Added both sentences to the retro-items paragraph.
  - `[low]` `[reject]` (blind) A `merged` record's reason reads "is due but its record is merged". — Cosmetic, and the same wording as the retro position's; a separate message adds a branch.
  - `[low]` `[reject]` (blind) `publish` copies the PR step instead of reusing it; `closeOrphans`, `describeError` and `HOUR_MS` are copied too. — Real drift risk, but the spec's Boundaries and Code Map chose a mirror, because `pr-step` is builder-specific (spec files, Infrastructure approval, the Story file). Extracting a shared push is a refactor beyond a direct correction; 2.9 took the same call for retro and planning.
  - `[low]` `[reject]` (blind) `plan.ts` `itemsDone` repeats `findRetroItem`'s lookup. — Core cannot import `src/lane`; moving the helper is a refactor for one five-line lookup.
  - `[low]` `[reject]` (blind) `conflictLogText` picks "Story" or "unit" from the subject's prefix. — It is correct for both subjects that exist (`storySubject`, `unitSubject`, both tested); passing a noun adds a parameter.
  - `[false]` `[reject]` (blind) Lane-process `pushFix` returns `failed` with no ledger edit for a null spec path. — Unreachable: the CI step calls `pushFix` for a Story only after its `needsSpec && specPath === null` check fails the attempt (`src/lane/ci-step.ts:300`).
  - `[low]` `[patch]` (blind) The prompt does not warn that agent config, status files, `.xarabot/`, `.github/`, the Standing Authority, evidence files and Protected Paths are refused even inside the globs; it never names the verification commands. — Added the warning to both retro-item parts. The commands are the repository's own (its instructions and repo sections), as for a CI fix.
  - `[low]` `[reject]` (blind) The prompt does not point at the retro document or the Epic context. — Both are in the clone, and the item text is the retro's own action line. A new placeholder needs config plumbing; an unclear item parks `intent-gap` for the Maintainer.
  - `[low]` `[reject]` (blind) Conflict sessions get the `ci-fix` wording ("CI log", "failing commands"). — Same as the Story `ci_fix` part; the log file itself says the clone holds conflict markers and what to do. A conflict mode adds a variant for no observed failure.
  - `[low]` `[patch]` (blind) Test gaps: `findRetroItem` untested; STOP in a CI session; a refused CI-fix publish; bad config; budget mid-CI; `watch: false` on a `merging` record; reconcile re-park of an ejected ungated item. — Added `findRetroItem` cases. The others use the shared CI/merge/kit code paths, which their own suites cover; the coordinator never passes a `merging` record to the step, and `checkGated` is kind-agnostic.
  - `[low]` `[reject]` (edge) An adopted released record whose item is no longer open fails each attempt until `attempts-cap`, holding later positions meanwhile. — It needs a hand edit of an item while its PR is open. It ends on its own at the cap (`parked` is not an open-PR state); a skip guard adds a branch.
  - `[low]` `[reject]` (edge) Whitespace-only item text, or a glob with a backtick, fails the prompt build every attempt. — Real (`NonEmpty` is `min(1)`), but such items come only from a hand edit or a bad retro result. It parks at `attempts-cap` with the prompt error in the reason; an extra `next` guard adds a branch.
  - `[low]` `[reject]` (edge) A merged record with a removed item is never deleted. — Same as the blind row above.
  - `[low]` `[reject]` (edge) A `released` `retro-item` record, its PR not open and its item since done, lingers. — Unlikely in 0.x (no `done`/`defer` rulings until Epic 4); a released `retro:` record has the same pre-existing shape. Cleanup belongs with those rulings.
  - `[low]` `[patch]` (edge) A `merging` retro-item PR holds every later coordinator position, which the runbook does not say. — This is AR14's order (an open coordinator PR waits). Added it to the runbook paragraph.
  - `[low]` `[reject]` (edge) `publish` reimplements the PR step. — Same as the blind row above.
  - `[low]` `[patch]` (verification-gap) The Story subject the lane process passes to the CI and merge steps is pinned by no test. — Added a lane-process-level assertion.
  - `[medium]` `[patch]` (verification-gap) The retro-item step's CI merge push to its own branch and its lockfile regeneration are never exercised. — Added `merged` and `lockfile` cases to the retro-item CI tests.
  - `[low]` `[defer]` (verification-gap) The `lane run` wiring, including credential redaction, is checked only as "is a function". — Deferred: the planning and retro wiring share the pattern, and closing it needs a lane-run harness change.
  - `[low]` `[reject]` (intent) Story 2.6's take-on-approval and queue check are not tested for a `retro-item` record. — `takeApproved` and `checkGated` have no unit-kind filter and are covered for Story, planning and retro records.
  - `[false]` `[reject]` (intent) The runner's own enqueue of an ungated PR is a path R1 does not describe. — A Story's merge step enqueues an ungated PR the same way; the spec settles it, and AD-6 adds only that the coordinator does not watch.
  - `[low]` `[reject]` (intent) Merge → reconcile PR → `done` → deletion is tested in pieces. — Each seam is tested; a chained fixture adds no new branch (2.9's call).
  - `[false]` `[reject]` (intent) "In this repo" is tested with a fixture policy. — The fixture is this repo's own policy value, `owner_approval_paths: ["**"]`.
  - `[false]` `[reject]` (intent) The builder refusals are stricter than R1. — AD-13 and AD-30 forbid those paths for items; the commit check enforces what 2.9's glob check approximates.
  - `[false]` `[reject]` (intent) `in-progress`, `waiting` and `deferred` items are skipped. — Only `open` items are lane work: `in-progress` is never written in 0.x, and `waiting`/`deferred` are Maintainer states.
  - `[low]` `[reject]` (intent) The PR step is mirrored, not reused. — Same as the blind row above.
  - `[false]` `[reject]` (intent) The copy has no `updatePr` path and adds orphan closing. — An adopted PR runs no session, so nothing updates its text; the orphan close matches the retro step's.

### 2026-10-25 — Review pass (follow-up)
- verdicts: 34 findings — high 0, medium 1, low 28, false 4, maybe-false 1
- findings:
  - `[medium]` `[patch]` (blind) The open-PR position adopts a `released` (or stale `claimed`) coordinator record with its PR open without the overlap check the claim enforces. A retro item's globs can overlap a Story's (`src/**`), so after a failed attempt a builder may claim an overlapping Story. Then every coordinator run's `claim` hits the precondition, `swap` reports `lost`, and the run ends `failed` after `MAX_CLAIM_ROUNDS`. — Position 2 now passes over such a record with an `overlap` reason, and later positions still wait on the open PR. Added two coordinator tests (released and stale), both of which fail without the fix.
  - `[low]` `[patch]` (blind) The prompt shows the snapshot item's globs, but the commit is checked against the record's. For an adopted PR whose item globs were edited after the claim, a CI-fix session is told one set and refused against the other. — The prompt now takes `input.record.globs`. Added an adopted CI-fix test that fails without it.
  - `[low]` `[reject]` (blind) The step checks `status: open` but not `route: lane`, so an item rerouted to `maintainer` after its claim is still worked. — It needs a hand edit of a claimed item, and the fix adds a guard branch. A `rule rebuild`/`release` after the reroute ends the unit: `next` no longer offers it.
  - `[low]` `[reject]` (blind) Retro-item commits do not refuse or revert Epic context files, unlike a builder's silent revert. — This needs an item glob that covers `_bmad-output/implementation-artifacts/epic-*-context.md`. A `planning:status` unit holding those globs passes the item over (`overlap`). The fix adds a revert class to the coordinator rules, and the spec's refusals are the write-check classes (AD-13, AD-30).
  - `[low]` `[reject]` (blind) `nextRetroItem` repeats `nextRetro`'s record and overlap logic. — The drift risk is real, but a shared picker is a refactor of the 2.7/2.9 positions too. Both copies are covered by their own case tables.
  - `[low]` `[reject]` (blind) The prompt names the refused path classes only in prose, not the configured paths. — A refusal parks `write-check` naming the path and class. Listing them needs new placeholders and config plumbing (public template surface).
  - `[low]` `[reject]` (blind) `result_retro_item` nearly copies `result_fix`. — These are template texts that the word tests pin. Building both from one function is a refactor for no observed failure.
  - `[low]` `[reject]` (blind) `needsSpec` is a runtime flag over a nullable `specPath`, which leaves an unreachable branch and a test shim. — A discriminated union is a type refactor across the CI step and both callers. The dead branch is the carried `false` row from the first pass.
  - `[low]` `[reject]` (blind) The runbook paragraph is one long block and omits how the Maintainer closes a maintainer item before Epic 4. — The neighbouring Story 2.7/2.9 paragraphs share the style. Closing an item by hand is the existing whole-file `retro-gates.yaml` edit, which the retro paragraph already covers.
  - `[low]` `[patch]` (blind) The runbook says `rule release` keeps "its open PR" with no new session, but a unit parked before its first push has no PR and gets a new session from `main`. — Reworded the parenthetical to cover both cases.
  - `[false]` `[reject]` (blind) The diff includes an unrelated `sprint-status.yaml` change. — The hunk comes from the review diff's base (`baseline_revision` predates `reconcile:52`, `1840ef0`). The branch's own commit does not touch the file (`git show --stat HEAD`).
  - `[low]` `[patch]` (blind) Test gaps: an adopted record overlapping a Story, two retro-item records overlapping, an item rerouted or re-globbed after the claim, a STOP in a CI-fix sleep. Also, the write-check test name misstates its exclusions. — Added the adopted-overlap tests (with the medium row) and the re-globbed adopted test, and renamed the test to "every builder class the coordinator classes do not catch first". Not added: retro-item overlapping retro-item, because the overlap loop is kind-agnostic and tested against a Story; reroute is rejected above; STOP is carried below.
  - `[low]` `[reject]` (blind) `retroItemId` does not check the `retro-item:` prefix, and the parse/format pair is split across files. — Every caller passes a unit that `next` or the ledger typed as `retro-item`. `findRetroItem` validates the id against `RETRO_ITEM_ID_PATTERN` and returns `null` otherwise.
  - `[low]` `[reject]` (edge) A merged record with a removed item is never deleted. — carried: the same row as the first pass's rejection; `itemsDone` still logs and skips it.
  - `[low]` `[reject]` (edge) Whitespace-only item text or an unsafe glob fails the prompt every attempt. — carried: the first pass's rejection; it still ends at `attempts-cap`.
  - `[low]` `[reject]` (edge) An adopted released record whose item is no longer open fails until `attempts-cap`. — carried: the first pass's rejection.
  - `[low]` `[reject]` (edge) A change to `branches.xarabot` on `main` mid-unit makes the CI step's merge push target a different branch than `publish`. — The builder's `CiUnit` derives its branch from the fresh config the same way (`src/lane/lane-process.ts:533`), as the spec's `branch(config)` says. Renaming the namespace mid-unit is a Maintainer edit that strands every open unit alike.
  - `[maybe-false]` `[reject]` (edge) A `unit_budget_hours` above about 596 h overflows the timer. — It would need a check of Bun's `AbortSignal.timeout` clamping. If true it is only `low`: budgets are hours, and the lane process, planning step and retro step use the same expression.
  - `[low]` `[reject]` (edge) A fence failure inside `closeOrphans` ends the step mid-loop and drops the `openPr` reason. — The fence's purpose is to stop a lane that lost the unit from acting. The next holder's orphan close handles the rest, and the code is identical to the retro step's.
  - `[low]` `[reject]` (edge) `publish` reimplements the PR step. — carried: the first pass's rejection (the spec chose a mirror).
  - `[low]` `[patch]` (verification-gap) A STOP during a CI-fix session's usage-limit sleep is untested. — carried: the first pass's test-gap row (same claim). Not patched again.
  - `[low]` `[patch]` (verification-gap) The re-claim lease from an existing branch head is untested. — Added "a re-claim with a stale branch: the push leases from its head and the PR opens".
  - `[low]` `[patch]` (verification-gap) The unit budget and the lost-claim endings are untested. — The budget mid-CI part is carried from the first pass. Added "an aborted signal (the claim lost): a failed attempt, nothing pushed".
  - `[low]` `[patch]` (verification-gap) A bad config on fresh `main` ending `stop` is untested. — carried: the first pass's test-gap row ("bad config"). Not patched again.
  - `[low]` `[patch]` (verification-gap) Step-level credential redaction in the PR title, body and status comment is unchecked. — Added "a session result echoing the credential: the PR title, body and status comment are redacted". The `lane run` wiring itself stays the deferred row.
  - `[false]` `[reject]` (verification-gap) The `sprint-status.yaml` hunk is not this branch's change. — The same base artifact as the blind row above; not a defect of the change.
  - `[low]` `[reject]` (intent) The push and PR-open are a second implementation of the PR step, not reused. — carried: the first pass's rejection.
  - `[low]` `[defer]` (intent) The `lane run` test checks the retro-item step only as "is a function", so the real adapters are never driven with a retro-item unit. — carried: the existing deferred item; not deferred again.
  - `[low]` `[reject]` (intent) The real git committer's path from diff to `WriteChange` under rules carrying `refused` is not exercised for a retro item. — The committer passes the rules through as data to `checkWrite`, and its generic suite covers the diff mapping. The step stub runs the real `checkWrite` over the request's rules.
  - `[low]` `[reject]` (intent) Matrix rows (adopted, reconcile → deletion, approval → queue) are tested in pieces across surfaces. — carried: the first pass's rejection ("tested in pieces").
  - `[false]` `[reject]` (intent) The runbook describes behaviour beyond the intent's text. — Each sentence describes existing generic code (rules, Story 2.6 re-park, AR14 order) as it applies to retro items. Nothing in the intent excludes documenting it.
  - `[low]` `[reject]` (intent) The `ci-step` harness's `pushFix` shim and the lane process's unreachable null-spec guard. — Covered by the carried `false` row and the `needsSpec` rejection above. The lane process's closure is exercised through the `runLaneProcess` with `createCiStep` tests.
  - `[low]` `[reject]` (intent) A retro-item commit does not drop Epic-context changes as a builder's does. — The same root cause as the blind Epic-context row, so the same route.
  - `[false]` `[reject]` (intent) The `sprint-status.yaml` hunk is a base artifact. — The same as the blind row above.

## Design Notes

- **"A Story's path"** separates retro items from planning and retro units, which skip CI fixes. Retro items get AD-19's CI fixes and conflict sessions, the graph gate (package edges can change the graph whatever the globs) and the approval gate. The one coordinator difference is AD-6: a coordinator `merging` record has no heartbeat. So the step enqueues and ends, and `reconcile` checks the queue: an ejection re-parks the PR for approval (Story 2.6).
- **An adopted PR runs no session**, like the retro step. Its work is already on the PR, and the CI step merges `main` into it and fixes it.
- **Builder refusals on top of the globs.** A broad item glob (`src/**`) could cover `src/CLAUDE.md`. 2.9's item-glob check is a conservative approximation and defers that case to the commit-time check.

## Verification

**Commands:**
- `bun test` -- expected: 0 fail (live cases skipped)
- `bun --bun tsc` -- expected: no error
- `bun --bun oxlint` -- expected: no warning or error

## Auto Run Result

Status: done

**Summary.** The coordinator now works open retro action items as `retro-item:<id>` units.
- `next(snapshot, 'coordinator')` gains the retro-items position, after retro. A `status: open`, `route: lane` item with globs is returned on `xarabot/retro-item-<id>`.
  - Epics go in ascending order, then items in file order.
  - An item with no globs is never returned and is listed `unclaimable` in the reasons.
  - `route: maintainer` items and items in any other status are skipped.
- The new retro-item step runs one no-skill `build` session. Its PR follows a Story's path:
  - the commit is refused anything outside the item's globs and every path a builder is refused;
  - CI runs with CI-fix and conflict sessions and lockfile regeneration;
  - then the graph and approval gates;
  - an ungated PR is enqueued with no queue watch, and `reconcile` checks the queue (Story 2.6).
- The item stays `open` while its unit runs. The next `reconcile` after the merge sets it `done`.
- The PR/CI/merge helpers now take a named unit, so the builder path is shared; the builder's texts are unchanged.

**Files changed.**
- `src/core/next/coordinator.ts`: `retroItemCandidates`, `retroItemUnit` and `nextRetroItem`, the retro-items position.
- `src/core/prompt/{template,build-prompt}.ts`: the `retro_item`, `retro_item_ci_fix` and `result_retro_item` parts, their placeholders and `buildRetroItemPrompt`.
- `src/core/lane/write-check.ts`: `RefusedPaths`/`refusedPaths`, and the coordinator rules' `refused` (`builderRefusals`).
- `src/core/reconcile/{plan,retro-gates-edit}.ts`, `src/lane/reconcile-step.ts`: `applyItemsDone`, `itemsDone` and `retroItemsMissing`, the item `done` write.
- `src/lane/session.ts`: `StepUnit`, `storySubject` and `unitSubject`.
- `src/lane/ci-step.ts`: `CiUnit`, `CiFix`/`PushFix` and `needsSpec`, plus the subject in the merge comment and conflict log.
- `src/lane/merge-step.ts`: a `StepUnit` input and `watch`; `approvalComment` is folded into `gateComment`.
- `src/lane/pr-step.ts`: `statusComment` takes `subject`.
- `src/lane/regenerate.ts` (new): the lockfile regeneration, moved out of `src/lane/lane-process.ts` and shared.
- `src/lane/retro-item-step.ts` (new): `createRetroItemStep`, `retroItemPrText`, `findRetroItem` and `retroItemId`.
- `src/cli/lane-run.ts`, `src/lane/coordinator-process.ts`: the wiring and docs.
- `docs/maintainer/self-host.md`: the retro-items paragraph, with recovery (`rule release|rebuild retro-item:<id>`), the re-park after an ejection, and the open-PR wait.
- Tests:
  - new: `test/lane/retro-item-step.test.ts`;
  - extended: the coordinator, prompt, write-check, plan, retro-gates-edit and reconcile-step tests;
  - adapted: the ci-step, merge-step, pr-step and lane-run harnesses.

**Review findings.** One pass, 29 findings: 1 medium, 22 low, 6 false.
- **Patched:**
  - medium: tests for the retro-item CI merge push and the lockfile regeneration;
  - low:
    - the template header wording;
    - the refused-paths warning in both retro-item prompt parts;
    - the runbook's recovery, re-park and open-PR-wait sentences;
    - `findRetroItem` tests;
    - a lane-process-level Story-subject assertion.
- **Deferred:** the lane-run wiring check (redaction secrets), low.
- **Rejected**, each with its reason in the Review Triage Log:
  - low:
    - a merged record with a removed item never deleted (blind and edge);
    - the merged-record reason wording;
    - the PR step mirrored, not reused (blind, edge and intent);
    - the `itemsDone` lookup duplication;
    - the conflict-log noun from the subject prefix;
    - no retro document in the prompt;
    - the conflict wording in `ci-fix` mode;
    - the remaining test gaps (shared paths);
    - an adopted record whose item closed;
    - whitespace-only text or backtick globs;
    - a lingering released record;
    - 2.6's enqueue untested for retro items;
    - the merge-to-done chain tested in pieces.
  - false:
    - the unreachable `pushFix` branch;
    - the runner's own enqueue;
    - the fixture policy;
    - the stricter builder refusals;
    - the skipped statuses;
    - no `updatePr` / the orphan close.

**Follow-up review recommended:** false. Patched: 0 high, 1 medium, 5 low.

**Verification.**
- `bun test`: 4002 pass, 280 skip (live and sandbox-refused cases), 0 fail.
- `bun --bun tsc`: exit 0.
- `bun --bun oxlint`: exit 0.
- Matrix audit: every row of the I/O & Edge-Case Matrix is covered by a test that ran and passed.

**Residual risks.**
- **Live behaviour is untested.** The step runs against the fake forge, a stub agent and a stub committer that applies the real write-check rules. A real no-skill session and the real git committer and merger are exercised only by their own generic suites.
- **Open-PR wait.** A retro-item PR that is `claimed` or `merging` holds every later coordinator position until it merges or parks (AR14's order). A long CI or a slow queue delays planning and retros.
- **Rollout.** The code takes effect only once the Maintainer advances `runner_version`. There is no ledger schema change.
- **Not committed.** The task rules require the changes to stay in the working tree, so the stock finalize commit was not made. `epic-2-context.md` holds step-01's recompile of a stale context file; the runner reverts any session change to an Epic context file before the squash.

### Follow-up review pass (2026-10-25)

Status: done

**Summary.** A second review of the whole Story change found one medium defect, now fixed. The open-PR position (AD-13 step 2) adopted a `released` or stale `claimed` coordinator record with its PR open without the overlap check that the claim edit enforces. Retro items are the first coordinator units whose globs can overlap a Story's. After a failed attempt, a builder could claim an overlapping Story, and every later coordinator run would then lose its claim three times and end `failed` until that Story finished. Such a record is now passed over with an `overlap` reason, and later positions still wait on the open PR.

**Files changed in this pass.**
- `src/core/next/coordinator.ts`: the overlap check in the open-PR position.
- `src/lane/retro-item-step.ts`: the prompt names the record's globs, which the commit is checked against, not the snapshot item's.
- `docs/maintainer/self-host.md`: `rule release` keeps an open PR when the unit has one. A unit parked before its first push gets a new session from `main`.
- Tests:
  - `test/core/next/coordinator.test.ts`: adopted-with-overlap cases, released and stale;
  - `test/lane/retro-item-step.test.ts`: four cases: a re-claim with a stale branch, credential redaction in the PR text and status comment, an aborted signal, and an adopted PR with edited item globs;
  - `test/core/lane/write-check.test.ts`: one test renamed.

**Review findings.** 34 findings: 1 medium, 28 low, 4 false, 1 maybe-false. Of these, 11 repeat rows from the first pass and keep those routes.
- **Patched:**
  - medium: the open-PR overlap;
  - low:
    - the prompt globs;
    - the runbook `rule release` wording;
    - the test rename;
    - tests for the re-claim lease, an aborted signal and step-level redaction.
- **Deferred:** nothing new; the `lane run` wiring item carries over.
- **Rejected**, each with its reason in the Review Triage Log:
  - low:
    - no `route` re-check;
    - Epic-context files not reverted for items;
    - `nextRetroItem` duplication;
    - refused paths named only in prose;
    - the `result_retro_item` copy;
    - the `needsSpec` design;
    - the runbook layout;
    - the `retroItemId` prefix;
    - `branches.xarabot` changing mid-unit;
    - the fence in `closeOrphans`;
    - the real committer not exercised;
    - the `ci-step` shim;
  - maybe-false: the budget timer overflow;
  - false:
    - the `sprint-status.yaml` hunk (a base artifact, three rows);
    - the runbook going beyond the intent.

**Follow-up review recommended:** false. On a follow-up pass, only a patched `high` counts. Patched: 0 high, 1 medium, 6 low.

**Verification.**
- New tests confirmed against the code without the fix:
  - with the old `coordinator.ts`, both new coordinator tests fail;
  - with the prompt reading `item.globs`, the edited-globs test fails.
- `bun test`: 4008 pass, 280 skip, 0 fail.
- `bun --bun tsc`: exit 0.
- `bun --bun oxlint`: exit 0.

**Residual risks.**
- **Live behaviour is untested.** The retro-item path still runs only against the fake forge and stub agent and committer.
- **Overlap wait.** An adopted retro-item PR that overlaps a running Story now waits for that Story to release or merge. Meanwhile the coordinator idles behind the open PR (AR14's order), and the journal names the overlap.
- **Not committed.** The changes stay in the working tree for the runner.
