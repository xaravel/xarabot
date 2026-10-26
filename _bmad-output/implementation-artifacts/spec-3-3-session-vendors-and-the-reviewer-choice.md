---
title: 'Story 3.3: Session vendors and the reviewer choice'
type: 'feature'
created: '2026-10-25'
status: 'done'
baseline_revision: '7d7f8ee51cac1456dc2bd940d11a413354df16e1'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      An empty `builder_providers` set makes `chooseReviewer` return `claude` marked cross-vendor, but a unit can hold agent commits with an empty set: a claim that adopts an open PR with no prior record (`fresh()`), or a unit pushed by a runner older than this Story.
    evidence: |-
      `claim` with `adoptPr` and no record builds the record from `fresh()` (src/core/ledger/edits.ts:306, `builder_providers: []`), and the planning step's adopted-PR path runs no session, so no push fence ever adds a vendor. AD-16 read literally gives `claude` for an empty set. Nothing reads the set yet, so there is no wrong review today. Story 3.4, which first launches reviews, has to decide whether an empty set on a unit with a PR means "builders unknown" (same-vendor, or refuse) or whether the adopting claim should record a vendor. SPEC does not settle this, so it is the Maintainer's decision.
    location: >-
      src/core/review/reviewer.ts:chooseReviewer, src/core/ledger/edits.ts:306
    severity: medium
---

<intent-contract>

## Intent

**Problem:** The runner does not know which model vendor changed a unit's diff: `builder_providers[]` exists on every ledger record but nothing ever adds to it. There is no reviewer choice, and a lane starts without its reviewer's credential (FR8, AR17, AR18, AR22; AD-16, AD-17).

**Approach:** A pure module `src/core/review/reviewer.ts` holds the session vendor function (`claude` → `anthropic`, `codex` → `openai`), the set addition, and the reviewer choice. Every step that pushes an agent-made commit adds the lane's vendor to `builder_providers[]` in the fence just before its push. At lane start, `xarabot lane run` picks the lane's reviewer from `[own vendor]` and the policy, and refuses a missing or unreadable reviewer credential.

## Boundaries & Constraints

**Always:**
- Vendor ids are lowercase, OpenRouter-style: `anthropic`, `openai` (`Provider`). The vendor comes from the session's adapter: `claude` and `codex` models each come from one vendor, so the model never changes it in 0.x. The function takes `{ adapter, model }` so that v1 pi can read `<provider>/<id>`.
- `addProvider(set, p)`: sorted, without duplicates. It only ever adds and never removes.
- `chooseReviewer(builderProviders, allowed)`: the first of (`claude`, `codex`) that `allowed` lists and whose vendor is not in the set → `{ adapter, crossVendor: true }`. Otherwise the first of (`claude`, `codex`) that `allowed` lists → `{ adapter, crossVendor: false }`. When `allowed` lists neither → `null`. `pi` in `allowed` is ignored, and an unknown string in the set never matches.
- Recording: the push fence `beat("fence", { builder_providers: addProvider(record.builder_providers, provider) })` runs right before the agent-commit push in `pr-step.ts` (build and CI or conflict fix), `retro-item-step.ts`, `planning-step.ts` and `retro-step.ts`. That vendor is added before the branch moves, so a crash after the push never leaves it out.
- `provider` is a required dep on `PrStepDeps` and `SessionStepDeps`. `lane-run.ts` builds it from the narrowed `SessionAdapter` and `lane.model ?? agent.defaultModel`.
- Lane start (`lane-run.ts` step 5): after the lane's own credential is read, run `chooseReviewer([own vendor], policy.unattended_adapters)`. A `null` is a failed start. If the reviewer adapter differs from the lane's agent, build it with `adapterFor`, take the credential file from a probe `launchSpec` (default model, effort `high`), then run `credentialPath` and `readCredential`. Any failure is a failed start, prefixed `reviewer <adapter>: `. The reviewer credential's `credentialSecrets` are added to `secrets`.
- `SessionAdapter` moves to `src/core/review/reviewer.ts`. `src/cli/pi-deferral.ts` re-exports it.

**Never:** No review sessions, prompts, `postReview`, `reviewed_sha`/`passed_sha` changes, merge gate, loopbacks or allowance re-checks before a launch (Stories 3.4 and 3.5). No ledger schema or `schema_version` change. No vendor added for runner-only pushes (the CI step's merge of `main`, `reconcile`, lockfile regeneration). No reviewer check in `lane install`. No edits outside the manifest globs (`src/core/review/**`, `src/core/ledger/**`, `src/core/config/**`, `src/core/schemas/**`, `src/cli/**`, `src/lane/**` and their tests), with one exception: the `provider` argument in `test/e2e/race-harness.ts`'s `createPrStep` call, which the required dep needs in order to type-check.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| vendor | `claude` + any model / `codex` + any model | `anthropic` / `openai` | — |
| cross, claude-built | `[anthropic]`, `[claude, codex]` | `codex`, cross-vendor | — |
| cross, codex-built | `[openai]`, `[claude, codex]` | `claude`, cross-vendor | — |
| both built | `[anthropic, openai]`, `[claude, codex]` | `claude`, same-vendor | — |
| claude-only | `[anthropic]`, `[claude]` (or `[claude, pi]`) | `claude`, same-vendor | — |
| codex-only | `[openai]`, `[codex]` | `codex`, same-vendor | — |
| neither | any, `[]` or `[pi]` | `null` (lane start refuses, Story 3.2) | — |
| build push | Story `done`, claude lane, record `[]` | record `builder_providers: [anthropic]` at the push fence | — |
| fix push | CI fix on a codex lane, record `[anthropic]` | `[anthropic, openai]` | — |
| start, both allowed | claude lane, policy `[claude, codex]`, no codex credential | refused `reviewer codex: …credential missing…`, failed-starts + 1 | failed start |
| start, both allowed | codex lane, policy `[claude, codex]`, no claude credential | refused `reviewer claude: …`, failed-starts + 1 | failed start |
| start, single vendor | claude lane, `[claude]` / codex lane, `[codex]` | starts with its own credential only | — |
| start, both credentials | claude lane, `[claude, codex]`, both files | starts; both credentials in `secrets` | — |

</intent-contract>

## Code Map

- `src/cli/pi-deferral.ts:13` -- `SessionAdapter` is defined here. Move it to core and re-export it. `piReviewerRefusal` stays first in step 5 and keeps the deferral text.
- `src/cli/lane-run.ts:334-361` -- step 5's refusal order: pi agent → pi reviewer → unattended → `adapterFor` → probe `launchSpec` → version → `startCheck` → own `credentialPath`/`readCredential` (`:356-359`) → builder limit. The reviewer check goes after the own credential. `:394` `secrets`; `:400` `SessionStepDeps` literal; `:425` `createPrStep(...)`. Reuse `adapterFor` (`:120`) and `PROBE_PROMPT`.
- `src/lane/pr-step.ts:236` -- the push fence `await beat("fence")` before `pushBranch` (`:238`); `PrStepDeps` `:30`; the kit record is `kit.record` (check the local name).
- `src/lane/retro-item-step.ts:253` -- `await k.beat("fence")` before its push; `k.record`.
- `src/lane/planning-step.ts:366`, `src/lane/retro-step.ts:361` -- the push fences.
- `src/lane/coordinator-process.ts:111` -- `SessionStepDeps`: add `provider`.
- `src/lane/session.ts:436` -- `beat(what, set?)` passes `HeartbeatSet` to `heartbeat`. READ-ONLY.
- `src/core/ledger/edits.ts:369-411` -- `HeartbeatSetSchema` already accepts `builder_providers` (replace semantics); `claim`/`release` keep the field and `rebuild` clears it. READ-ONLY.
- `src/core/ledger/codec.ts:137` -- stores `builder_providers` as a sorted set. READ-ONLY.
- `src/core/schemas/policy.ts` -- `AdapterName`, `Policy`. READ-ONLY.
- Tests: `test/lane/pr-step.test.ts:159,934`, `test/lane/ci-step.test.ts:239,766`, `test/lane/merge-step.test.ts:832`, `test/lane/several-lanes.test.ts:162`, `test/e2e/race-harness.ts:454` (the one edit outside the globs: `provider` in the `createPrStep` call); `test/lane/planning-step.test.ts`, `retro-step.test.ts`, `retro-item-step.test.ts` deps builders; `test/cli/lane-run.test.ts:595` ("a policy allowing claude and codex: the codex lane starts" now needs the claude credential, `credential: true`), `:704` wiring test.

## Tasks & Acceptance

**Execution:**
- `src/core/review/reviewer.ts` -- new pure module: `PROVIDERS`, `Provider`, `SessionAdapter`, `REVIEWER_ORDER`, `sessionProvider`, `addProvider`, `ReviewerChoice`, `chooseReviewer`, each with a doc comment citing AD-16.
- `src/cli/pi-deferral.ts` -- re-export `SessionAdapter` from core.
- `src/lane/pr-step.ts`, `src/lane/retro-item-step.ts`, `src/lane/planning-step.ts`, `src/lane/retro-step.ts`, `src/lane/coordinator-process.ts` -- the `provider` dep and the push-fence set; update the header comments where they list what each step records.
- `src/cli/lane-run.ts` -- compose `provider`; the reviewer choice and its credential check in step 5; add the reviewer secrets; update the header comment.
- `test/core/review/reviewer.test.ts` -- case tables for every pure row of the matrix, including the `agent-adapters.md` table (`claude` → `codex`, `codex` → `claude`), the `claude`-only, `codex`-only and neither policies, `[claude, pi]`, an empty set, an unknown string in the set, `addProvider` order and dedupe.
- `test/lane/pr-step.test.ts`, `test/lane/ci-step.test.ts` (a fix push), `test/lane/retro-item-step.test.ts`, `test/lane/planning-step.test.ts`, `test/lane/retro-step.test.ts` -- the record after the push holds the lane's vendor, and the ledger write that carries it lands before `pushBranch`. Add `provider` to every existing deps builder.
- `test/cli/lane-run.test.ts` -- the lane-start rows of the matrix; the wiring test asserts the `provider` given to the steps.

**Acceptance Criteria:**
- Given a unit's agent-made commit pushed by any of the four steps, when the ledger record is read afterwards, then `builder_providers` holds that lane's vendor alongside any vendor it held before.
- Given a runner-only push (the CI step's merge of `main`, `reconcile`), when it runs, then `builder_providers` is unchanged.
- Given `bun test`, `bun --bun tsc` and `bun --bun oxlint`, when run, then each passes.

## Spec Change Log

## Review Triage Log

### 2026-10-25 — Review pass
- verdicts: 20 findings — high 0, medium 2, low 8, false 10, maybe-false 0
- findings:
  - `[medium]` `[defer]` (blind) An empty `builder_providers` gives a false cross-vendor `claude` choice for adopted-PR claims and units pushed before this Story. Real: `fresh()` on an adopting claim with no record, and a planning unit adopted with its PR runs no session. Pre-existing claim behaviour, and nothing reads the set until Story 3.4. Deferred to frontmatter `deferred` as a Maintainer decision for 3.4.
  - `[false]` `[reject]` (blind) `sessionProvider` ignores the model; nothing checks that the lane's model belongs to the adapter's vendor. Both adapters' `effortValues` fail closed on a model outside their own table (`claudeEffortValues` `Object.hasOwn(CLAUDE_EFFORTS, …)`; codex's "a claude model on a codex lane" start refusal), so `startCheck` refuses any other vendor's model at lane start.
  - `[low]` `[reject]` (blind) The reviewer pre-flight does not check the reviewer CLI's presence or version. Real, but no review session runs before Story 3.4. The Story AC and AD-21's start list name only the allowance and the credential, and an operator who allows `codex` installs it. The fix adds a version probe and branches.
  - `[false]` `[reject]` (blind) The `choice === null` branch is unreachable and untested. It is a defensive guard behind `piReviewerRefusal`. Code that fails loudly on an unreachable state is correct, and its type (`ReviewerChoice | null`) needs the narrowing.
  - `[low]` `[patch]` (blind) `PrStepDeps.secrets` and the `pr-step.ts` header still describe one credential. Both reworded to name the lane's and its reviewer's credentials.
  - `[low]` `[patch]` (blind) Ledger and CLI test fixtures use adapter names (`claude`, `codex`) as `builder_providers` values, against the new vendor ids. Changed to `anthropic`/`openai` with each test's meaning kept. The union-in-edit suggestion is not taken: only the holder writes the field, and every writer uses `addProvider`.
  - `[false]` `[reject]` (blind) Runner-only pushes (`reconcile`, lockfile regeneration) and the conflict-fix push are untested. `createReconcileStep` and the CI step get no `provider`, so they cannot add one. A conflict fix goes through the same `pushFix` → PR step `fix` path that the CI-fix test covers.
  - `[false]` `[reject]` (blind) No test shows a failed push or a takeover keeping the added vendor. `failAttempt`, `release`, `park` and `claim` all `stamp` the record and keep `builder_providers` (src/core/ledger/edits.ts), so the bad outcome does not occur.
  - `[low]` `[reject]` (blind) `readReviewerCredential` repeats the lane's own credential sequence. This is a refactor with no defect today; the fix is more than a direct correction.
  - `[low]` `[reject]` (blind) "vendor" means both the adapter credential directory and the model vendor, and the message reads `reviewer codex: codex: credential missing`. Cosmetic: the message names the reviewer and the cause, and renaming the existing `Vendor` port type is churn outside this Story.
  - `[low]` `[patch]` (blind) In `test/cli/lane-run.test.ts`, the `built` doc comment was not rewrapped; `built.pr` is not reset in every test. Rewrapped the comment. The reset half is false: the tests without a reset never call `prDeps()`.
  - `[low]` `[patch]` (blind) The new `reviewer.ts` and `push-providers.ts` imports are out of path order in several files. Moved into order.
  - `[medium]` `[defer]` (edge) Same root cause as the first row (an empty set when `claim` adopts a PR) — deferred with it.
  - `[low]` `[reject]` (edge) A reviewer CLI that is missing or too old is not refused at start. Same as the blind CLI row; rejected for the same reason.
  - `[false]` `[reject]` (intent) `chooseReviewer` is never fed a unit's recorded set at runtime. Review launch is Story 3.4's: the Story's ACs ask for the pure choice, the recording and the lane-start refusal, and all three are here.
  - `[false]` `[reject]` (intent) The vendor comes from the adapter, not the model. Same refutation as the blind model row: each adapter refuses another vendor's model at start.
  - `[false]` `[reject]` (intent) The lane-start "neither" refusal comes from Story 3.2 code. Story 3.3's AC itself says that case "refuses at lane start (Story 3.2)".
  - `[false]` `[reject]` (intent) "Reviewer not allowed" holds by construction rather than by a check. `chooseReviewer` only returns adapters the policy lists, so a disallowed reviewer cannot be chosen.
  - `[false]` `[reject]` (intent) There is no conflict-specific or loopback test. A conflict fix shares the tested `fix` push path, and loopback sessions do not exist until Story 3.5.
  - `[false]` `[reject]` (intent) Lowercase vendor ids, the probe model and the race-harness edit. The ids are the spec's stated vocabulary, the probe only names the credential file, and the harness edit is the spec's named exception. No wrong outcome.

## Design Notes

"Its reviewer adapter" (Story AC) is the choice for `[own vendor]`. In 0.x that set of credentials is the same as AD-17's "every reviewer the lane may launch". With `[claude, codex]` allowed, a claude lane gets `codex` and a codex lane gets `claude`, so either lane needs both credentials. A builder set that holds both vendors (after a takeover) picks `claude`, and a codex-only builder set picks `claude` too, so no other reviewer can come up. With a single allowed adapter, the reviewer is the lane's own adapter. The vendor goes into the push fence instead of the record step: adding a vendor too early is harmless (fewer cross-vendor choices), but leaving one out could mark a same-vendor review cross-vendor.

## Verification

**Commands:**
- `bun test` -- expected: 0 fail; sandbox and live cases skipped inside the session.
- `bun --bun tsc` -- expected: exit 0.
- `bun --bun oxlint` -- expected: exit 0.

## Auto Run Result

Status: done

**Summary:** The runner now knows which model vendor changed a unit's diff. A pure module, `src/core/review/reviewer.ts`, provides:
- the session vendor (`claude` → `anthropic`, `codex` → `openai`);
- an add-only set addition;
- the AD-16 reviewer choice. It takes the first allowed of `claude`, `codex` from a vendor not in `builder_providers[]`, marked cross-vendor. Failing that, it takes the first allowed one, marked same-vendor. With neither allowed it returns `null`.

Every step that pushes an agent-made commit adds the lane's vendor to the unit's `builder_providers` in the fence just before the push, so the vendor is recorded before the branch moves. These steps are the Story PR step (build, CI fix and conflict fix), retro item, planning and retro. At lane start, `xarabot lane run` picks the lane's reviewer from its own vendor and the policy. When that reviewer is another adapter, it reads the reviewer's credential and refuses a missing or unreadable one as a failed start (`reviewer <adapter>: …`). The reviewer's credential is also added to the redaction secrets.

**Files changed:**
- `src/core/review/reviewer.ts` (new): `PROVIDERS`, `Provider`, `SessionAdapter` (moved from `pi-deferral.ts`), `REVIEWER_ORDER`, `sessionProvider`, `addProvider`, `chooseReviewer`.
- `src/cli/lane-run.ts`: `provider` composed and passed to the steps; reviewer choice and `readReviewerCredential` in step 5; reviewer secrets.
- `src/cli/pi-deferral.ts`: re-exports `SessionAdapter`.
- `src/lane/pr-step.ts`, `retro-item-step.ts`, `planning-step.ts`, `retro-step.ts`, `coordinator-process.ts`: required `provider` dep; the push fence adds it to `builder_providers`; header comments updated.
- `test/core/review/reviewer.test.ts` (new) and `test/lane/push-providers.ts` (new helper that reads the ledger at each `pushBranch`).
- `test/lane/*-step.test.ts`, `test/cli/lane-run.test.ts`: the vendor at each push fence, and the lane-start reviewer rows.
- Ledger and rule test fixtures moved to the `anthropic`/`openai` vocabulary.
- `test/e2e/race-harness.ts`: `provider` in its `createPrStep` call (the spec's one exception to the globs).

**Review findings:** 20 findings (high 0, medium 2, low 8, false 10, maybe-false 0).
- Patched (all low): the `pr-step.ts` secrets comments; the fixture vendor vocabulary; the rewrap of a `lane-run.test.ts` comment; import order.
- Deferred (one entry in frontmatter `deferred`, medium): an empty `builder_providers` on a unit that holds agent commits (an adopting claim with no prior record, or a unit pushed by an older runner) reads as cross-vendor `claude`. Story 3.4 has to settle this with the Maintainer before it launches reviews.
- Rejected:
  - Reviewer CLI presence or version not checked at start (low): not in the Story AC or AD-21's start list, and no review runs before 3.4.
  - Duplicated credential sequence (low, refactor).
  - The two meanings of "vendor" and the doubled `codex:` prefix (low, cosmetic).
  - The model being ignored (false): both adapters refuse another vendor's model at start.
  - The unreachable `null` guard (false: defensive).
  - Runner-only, conflict and failed-push tests (false): no provider is wired there, the conflict fix shares the tested path, and the ledger edits keep the field.
  - The intent auditor's descriptive divergences (false): review launch belongs to 3.4 and loopbacks to 3.5, and the "neither" refusal is Story 3.2's by the AC's own wording.

**Follow-up review recommended:** false. Patched entries: 0 high, 0 medium, 4 low.

**Verification:**
- `bun test`: 4765 pass, 316 skip, 0 fail. The skips are the sandbox, host-only and live cases that cannot run in a sandboxed session. Run before and after the review patches.
- `bun --bun tsc`: exit 0.
- `bun --bun oxlint`: exit 0.
- Matrix audit: every I/O row is covered by a test that ran and passed, checked from the JUnit report. None of those tests are skipped.

**Residual risks:**
- An empty `builder_providers` on an adopted or pre-upgrade unit (deferred).
- A reviewer CLI that is missing or too old is caught only when Story 3.4 first launches a review.
- `chooseReviewer` is not yet called on a unit's recorded set: review sessions come with Story 3.4.

**Not committed:** per this run's instructions, the changes stay in the working tree, so the skill's commit-and-clean-tree finalization was not run.
