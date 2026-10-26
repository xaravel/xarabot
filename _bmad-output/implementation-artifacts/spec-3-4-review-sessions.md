---
title: 'Story 3.4: Review sessions'
type: 'feature'
created: '2026-10-25'
status: 'done'
baseline_revision: '6af7bbad55208b274fd585cb73a3cdfdf6ed4149'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      An empty `builder_providers` set makes `chooseReviewer` return `claude` marked cross-vendor, but a unit can hold agent commits with an empty set: a claim that adopts an open PR with no prior record (`fresh()`), or a unit pushed by a runner older than Story 3.3. Carried over from spec-3-3. The review step applies AD-16 as written and does not special-case the empty set.
    evidence: |-
      spec-3-3's deferral asks the Maintainer whether an empty set on a unit with a PR means "builders unknown" (same-vendor, or refuse) or whether the adopting claim should record a vendor. SPEC and AD-16 do not settle it, so it stays the Maintainer's decision. No production path launches a review yet (next entry), so there is no wrong review today.
    location: src/lane/review-step.ts, src/core/review/reviewer.ts:chooseReviewer
    severity: medium
  - summary: >-
      No Epic 3 Story manifest's globs cover `src/cli/**`, but `xarabot lane run` (src/cli/lane-run.ts) has to compose the reviewer `Agent`s and the review step before any lane runs a review. This Story builds the step and its deps; wiring it into lane-run and the lane sequence is left for the Maintainer to assign.
    evidence: |-
      stories/3.4.md, 3.5.md and 3.6.md list no `src/cli/**` glob. The reviewer adapter is built with `adapterFor` (src/cli/lane-run.ts:120), and `src/lane` may not import `src/adapters/agent`. Story 3.5 places the review round in the lane sequence; it still needs a lane-run edit to pass `reviewers` in.
    location: src/cli/lane-run.ts, stories/3.5.md
    severity: medium
  - summary: >-
      Review (intent audit): no lane, coordinator or CLI path calls `createReviewStep` or `createGitReviewCheckout`, so in production no review is posted and `merge-step.ts` still fences `passed_sha: head` with no review.
    evidence: |-
      grep finds no caller of `createReviewStep` in src. The cause is the planning gap in the previous entry (no Epic 3 manifest covers `src/cli/**`), together with Story 3.5 owning the lane sequence and the merge gate. It is not a defect in this Story's code.
    location: src/lane/review-step.ts, src/lane/merge-step.ts:207, src/cli/lane-run.ts
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Nothing reviews a unit's diff. There is no review prompt, no clean checkout to review on, no `Forge.postReview`, and nothing records `reviewed_sha` or sets `passed_sha` from a review (FR8, AR15, AR17, AD-16).

**Approach:** Add `Forge.postReview` to the port and both forges. Add a review prompt builder and template parts to `core/prompt`. Add a runner-made review checkout of `head_sha` in `runner.git`, with agent config restored from `main` and hooks off. Add a review step in `src/lane` that runs one review round through the sandbox with the chosen reviewer, posts each pass's review and records `reviewed_sha` and `passed_sha` itself.

## Boundaries & Constraints

**Always:**
- **Checkout:** `<lane>/review`, a new `laneLayout.review`, never `layout.clone`. Its `.git` is written by hand like `rebuildClone`'s, with a detached `HEAD` at `head_sha`, `core.hooksPath = /dev/null` in its config, and one pack of everything reachable from `head_sha` and `main`. The working tree is `head_sha`'s tree with every agent config path replaced by `main`'s version, or removed when `main` has none. The index stays at `head_sha`, so restored paths show as uncommitted changes.
  - Agent config means `AGENT_CONFIG_PATHS`, plus any path whose last segment is `.agents`, `.claude`, `.codex` or `.pi`, case-folded as in write-check.
  - Missing SHAs are fetched into `runner.git` first. No marker ref, wip ref or builder clone state is read or written.
- **Reviewer:** `chooseReviewer(record.builder_providers, policy.unattended_adapters)` on fresh `main`'s policy. The `Agent` comes from `deps.reviewers[adapter]`. If it is the lane's own adapter, it runs with the lane's model and effort; otherwise with the adapter default model and effort `high`.
  - Each pass gets a fresh vendor home: the sandbox empties and seeds `layout.vendorHome` from the reviewer's credential on every fresh run.
  - The session uses its own `SessionRunner` (reviewer agent, review workspace) with `profile.clone = layout.review`.
- **Prompts:** `buildReviewPrompt` with new parts `review`, `review_followup` and `result_review`, and the `REVIEW_RESULT_JSON_SCHEMA` constant.
  - The prompt names the unit, the reviewed SHA, `main`'s SHA (the diff is `main...HEAD`) and, for a Story, the spec path.
  - It ends with the `$XARABOT_RESULT` result part.
  - It has no selection, CI, merge, PR, push, approval, status or ledger instruction, and must pass the `BANNED` table.
  - The follow-up part names the spec and tells the reviewer to check the unverified risks named in the spec's `## Auto Run Result` section. It needs a spec path.
- **Spec at head (Stories):** the files that match `storySpecGlob(config.story_spec_path, storyId)` in the checkout's tree. `pickSpec("done", …)` must give one `done` match (AR11). `followup_review_recommended: true` in its frontmatter adds the follow-up pass. A unit given no Story id (a retro item or a coordinator PR) gets the normal review only.
- **A round:** the normal pass, then the follow-up pass when the spec is flagged. Each pass is its own session on a freshly rebuilt checkout of the same `head_sha` and `main`. After each result:
  1. fence `{ reviewed_sha: head, passed_sha: null }`;
  2. `postReview(pr, { commit_sha: head, body })`.
  - After the last pass, with no blocking finding in any pass: `beat("record", { passed_sha: head })`.
  - A pass is blocking when any finding has `blocking: true` or `verdict` is not `pass`.
  - The agent's `reviewed_sha` is ignored. A mismatch is only noted in the log.
- **Review body:** built by a pure `reviewComment`. It holds a 🤖 line naming the subject, the full reviewed SHA, `cross-vendor` or `same-vendor`, the reviewer adapter and model, and the pass (review or follow-up review). Then the verdict and each finding as `severity`, blocking or not, path and text, or "Findings: none."
  - Agent text is passed through `sanitizeAgentText` with `secrets`, and the body is capped at `FORGE_TEXT_LIMITS.comment`.
- **`postReview`:** a `COMMENT` review only, never an approval or a change request. The fake records it as a `commented` review at `commit_sha`, by the bot, and keeps the body for a control. GitHub sends `POST /pulls/{n}/reviews` `{ commit_id, body, event: "COMMENT" }` after `getPr`, with a new op `createReview` (`pull_requests: write`). A missing PR is `not-found`.

**Never:** No lane-process or `lane-run` wiring, no merge gate change (`merge-step.ts`'s `passed_sha: head` fence stays until Story 3.5), no loopback, no prefetched findings, no caps and no allowance re-check beyond the round's own reviewer choice (Story 3.5). No ledger schema or `schema_version` change. No `reconcile` PR review. No legacy `builder_providers` name mapping (retro item 27). No edits outside the manifest globs.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| cross pass | claude-built `[anthropic]`, policy `[claude, codex]`, codex result `pass`, no findings | codex session in `layout.review` at head; one review posted "cross-vendor"; record `reviewed_sha` = `passed_sha` = head; outcome `progress`, `claimed` | — |
| same-vendor | `[anthropic]`, policy `[claude]` | claude reviewer with lane model; body says "same-vendor" | — |
| blocking | a finding `blocking: true` | review posted; `reviewed_sha` = head, `passed_sha` null; output `blocking: true` | — |
| verdict only | `changes-requested`, no blocking finding | treated as blocking | — |
| agent SHA | result `reviewed_sha` ≠ head | record and body use head; note logged | — |
| flagged spec | spec `done`, flag `true` | two sessions, two reviews; `passed_sha` only if both clean | — |
| flagged, follow-up blocks | normal clean, follow-up blocking | `passed_sha` null | — |
| unflagged / no Story id | flag `false`, or retro item | one session | — |
| bad spec | Story with 0 or 2+ `done` matches | failed attempt | `failAttempt` |
| no reviewer | fresh policy allows neither | outcome `stop`, no session | stop |
| reviewer not composed | `deps.reviewers` lacks the choice | outcome `stop`, no session | stop |
| post fails | `postReview` error | failed attempt, `passed_sha` never set | `failAttempt` |
| session fails | no result, model mismatch, sandbox refused | failed attempt | `failAttempt` |
| PR moved | snapshot head ≠ record head, or PR closed | failed attempt, no session | `failAttempt` |
| checkout | head adds `CLAUDE.md`, changes `.claude/x`; `main` has `.claude/x` | checkout lacks `CLAUDE.md`, has main's `.claude/x`; `HEAD` = head; config has `hooksPath = /dev/null` | — |

</intent-contract>

## Code Map

- `src/ports/forge.ts:185-188` -- `reviews`, `comment`; add `postReview` after `comment`. `FORGE_OPERATIONS:206-223` must list it in order. Header L6-18 notes there is no approve; say a review is comment-only.
- `src/adapters/forge/fake/fake-forge.ts:156-158,352-367,474-480` -- state, `reviews`/`comment`, controls `addReview`/`comments`; add `reviewBodies(pr)` to `FakeForgeControl:54-87`.
- `src/adapters/forge/github/github-forge.ts:746-757` (comment via `guarded`, `getPr`, `api`), `:1054-1071` return object, header L46-61; `http.ts:46-79` `GITHUB_OPERATIONS` (add `createReview`).
- `test/adapters/forge/github/fake-github.ts:95-104,235,662-703,897-899` -- emulator; add a `POST /pulls/{n}/reviews` route storing `{login: botLogin, state: "COMMENTED", commit_id, body}` and a control for bodies.
- `test/contracts/forge.contract.ts:34-51` controls, `:102-136` `scenario`, `:322-339` aborted table (add `postReview`), `:381-391` aborted model, `:568-576` comment case. Harnesses: `forge.contract.test.ts:5-19` `CONTROLS`, `forge.github.contract.test.ts:44` (emulator controls), `:192-218` (live controls: add a raw `GET /pulls/{pr}/reviews` body read).
- `test/ports/forge.test.ts:22-38,66-68`, `test/adapters/forge/github/github-forge.test.ts:474-486`, `test/adapters/forge/github/pulls.test.ts:276-291` -- exhaustive op tables and a model unit test.
- `src/core/prompt/template.ts:24-85,88-103` -- keys, `PLACEHOLDERS`, `resultHead`; `build-prompt.ts:39-45` schema constants, `:92-110` `TemplateSchema`, `:129-160` `checkTemplate`/`fill`, `:56,257` `AbsolutePath`/`SafeText`; `buildRetroPrompt:394` is the model for a new builder.
- `test/core/prompt/build-prompt.test.ts:257-276` `BANNED`, `:327,532` part exclusions: review parts must pass `BANNED` unexcluded.
- `src/core/lane/build-check.ts:16,27,39,58` -- `specMatches`, `SpecMatch`, `specStatus`, `pickSpec`. READ-ONLY. `src/core/config/load-repo-config.ts:68` `splitFrontmatter`, `src/core/schemas/common.ts` `parseYaml`, `src/core/config/story-spec-path.ts:10`, `src/core/config/protected-paths.ts:2-12`. READ-ONLY.
- `src/core/lane/write-check.ts:222-226,304-305` -- `fold` and `AGENT_CONFIG_DIRS`. READ-ONLY, outside the globs; mirror them in core/review.
- `src/core/review/reviewer.ts` -- `chooseReviewer`, `SessionAdapter`.
- `src/lane/clone.ts:302-395` -- `rebuildClone`. Factor its `.git` writing and pack (L318-369) into shared helpers so it keeps its exact behaviour, and add the review checkout beside it. `git`/`gitRun`/`needCommit` L49-80. Temp index pattern in `src/lane/merger.ts:82-122`.
- `src/lane/workspace.ts:12-74` -- `Workspace`, `FetchShas`; the review workspace adapts the checkout to `Workspace.prepare` (ignore branch, generation, wip).
- `src/lane/lane-store.ts:18-52` -- `laneLayout`; add `review: <lane>/review`. Sandbox roots must sit inside the lane dir and not overlap (src/sandbox/macos.ts:113-160).
- `src/lane/session.ts:313-488` `stepKit`, `:495-650` `stepOps` (`freshMain`, `aborted`), `:887-1210` `createSessionRunner`/`SessionContext`; `src/lane/retro-step.ts:450-538` is the session pattern to mirror (budget, ctx, `onLimitStop`, `MarkerStop`, `Halt`).
- `src/lane/coordinator-process.ts:112-140` -- `SessionStepDeps`, the deps shape to follow.
- `src/core/sanitize.ts:19,57,101` -- `FORGE_TEXT_LIMITS`, `capText`, `sanitizeAgentText`.
- Tests: `test/lane/retro-step.test.ts:191-340` (stub agent, sandbox, workspace harness), `test/lane/git-fixture.ts:46-107` (real runner.git, `commit`, `files`, `plainClone`), `test/lane/clone.test.ts`, `test/lane/lane-store.test.ts`.

## Tasks & Acceptance

**Execution:**
- `src/ports/forge.ts`, `src/adapters/forge/fake/fake-forge.ts`, `src/adapters/forge/github/github-forge.ts`, `src/adapters/forge/github/http.ts` -- `postReview(pr, { commit_sha, body }, opts): ForgeResult<{ id }>`.
- `test/contracts/forge.contract.ts` and the three harnesses, `test/adapters/forge/github/fake-github.ts`, `test/ports/forge.test.ts`, `test/adapters/forge/github/github-forge.test.ts`, `test/adapters/forge/github/pulls.test.ts`, `test/adapters/forge/fake-forge.test.ts` -- contract cases (the body is posted verbatim; one `commented` review appears at `commit_sha`; a missing PR is `not-found`; an aborted call posts nothing), plus the op tables.
- `src/core/prompt/template.ts`, `src/core/prompt/build-prompt.ts` -- review parts, placeholders, `REVIEW_RESULT_JSON_SCHEMA`, `buildReviewPrompt({ template, unit: { id, head_sha, main_sha, spec_path: string | null }, pass: "normal" | "followup", result_path })`. A follow-up with no spec is `invalid-input`.
- `test/core/prompt/build-prompt.test.ts` -- the review prompt names the unit, SHAs and spec; ends with the result part and schema; `BANNED` finds nothing in either pass; the follow-up names the spec and the Auto Run Result risks; invalid inputs.
- `src/core/review/agent-config.ts` -- `isAgentConfigPath`. `src/core/review/review-spec.ts` -- `followupRecommended(specText)` (frontmatter `followup_review_recommended === true`; anything else `false`). `src/core/review/review-comment.ts` -- `isBlocking(result)` and `reviewComment(...)`.
- `test/core/review/*.test.ts` -- case tables for these three.
- `src/lane/clone.ts` -- shared helpers and `writeReviewCheckout`. `src/lane/review-checkout.ts` -- `ReviewCheckout` port and its git implementation (fetch missing, then write). `src/lane/lane-store.ts` -- `layout.review`.
- `test/lane/clone.test.ts` or `test/lane/review-checkout.test.ts` -- the checkout row of the matrix on a real `runner.git`: no builder marker or wip changed, `rebuildClone` tests unchanged.
- `src/lane/review-step.ts` -- `createReviewStep(deps)` returning `(input) => Promise<ReviewStepOutput>`, with `ReviewStepOutput = StepOutput & { review?: { sha, blocking, crossVendor, adapter, passes, findings } }`. Its deps are `SessionStepDeps`-like (forge, sandbox, store, waiter, laneDir, lane, identity, secrets, limits, clock and the rest) plus `reviewers` and `checkout`. Its input is `{ unit: StepUnit, storyId: string | null, record, track, signal, log }`. Never throws, except a `Halt` or `MarkerStop` from the session.
- `test/lane/review-step.test.ts` -- every step row of the matrix with the fake forge and stub agent, sandbox and checkout: the ledger order (fence before `postReview`, `passed_sha` after), the profile's `clone` = `layout.review`, the reviewer agent used, the prompt passed.

**Acceptance Criteria:**
- Given a claimed unit with an open PR at `head_sha`, when the review step runs, then the reviewer session runs in `<lane>/review` built from `runner.git` at `head_sha` with `main`'s agent config and hooks off, never in `<lane>/clone`, through `deps.sandbox`.
- Given any review result, when it is handled, then the posted review and the record name the head the runner checked out, and only a round with no blocking pass sets `passed_sha`.
- Given `bun test`, `bun --bun tsc` and `bun --bun oxlint`, when run, then each passes.

## Spec Change Log

## Review Triage Log

### 2026-10-25 — Review pass
- verdicts: 28 findings — high 0, medium 7, low 15, false 6, maybe-false 0
- findings:
  - `[low]` `[patch]` (verification-gap) No step test shows the lane's secret redacted from the posted review body. Added a row whose finding holds `sekrit-credential` and asserts `[REDACTED]` in `reviewBodies`.
  - `[low]` `[patch]` (verification-gap) `isAgentConfigPath`'s full case folding (`ſ`, Kelvin `K`) is untested. Added the write-check table's fold rows.
  - `[medium]` `[patch]` (verification-gap) The "mirrors the write check" test never runs the write check, so the two copies of the agent-config rule could drift apart and the review checkout would take head files the builder check refuses. Replaced it with a parity check against `checkWrite` builder rules over the whole path table.
  - `[low]` `[patch]` (verification-gap) The caller's track update on a STOP during a usage-limit sleep is unasserted. The STOP test now passes a track and asserts `released`.
  - `[medium]` `[patch]` (blind) The review prompt carried the shared rules part ("Leave your changes in the clone's working tree…"), which contradicts "change no file". Added a `review_rules` part without that line, worded for the checkout, and used it instead.
  - `[medium]` `[patch]` (blind) The reviewer's `denied_actions` were dropped everywhere, against AGENTS.md's rule that denials reach the Maintainer. The posted body now lists them ("Denied actions: none." or a list), and the unit log notes them.
  - `[low]` `[patch]` (blind) The body printed "Verdict: pass." for a pass that blocks (a blocking finding with a `pass` verdict). Added an "Outcome: blocking./not blocking." line from `isBlocking`.
  - `[low]` `[reject]` (blind) With `--replace`, a head file at a folder path under which `main` has agent config (head `tools`, main `tools/AGENTS.md`) is replaced in the review checkout. Real, but rare. The reviewer still sees the file in `git diff main...HEAD`, and the alternative fix adds conflict filtering branches.
  - `[medium]` `[patch]` (blind) `writeReviewCheckout` wipes any `dir`, so a wrong wiring could delete the agent's clone; and the checkout folder could differ from the step's `profile.clone`. `createGitReviewCheckout` now takes `laneDir` and always writes `laneLayout(laneDir).review`, with a test that the clone is untouched.
  - `[false]` `[reject]` (blind) A head symlink leaving the checkout (for example to `../clone`) could feed the reviewer builder-controlled config. The write check refuses any agent diff that adds a symlink whose target is absolute or leaves the repo root (AD-30 content class `symlink`, retro item 18), so such a head cannot be pushed.
  - `[low]` `[patch]` (blind) "Run the verification commands" sat next to "change no file", and tests write caches. Reworded to "change no tracked file", adding that files the commands write are thrown away with the checkout.
  - `[low]` `[reject]` (blind) `checkoutFiles` and the fetch-missing loop duplicate `listWorkingTree` and `createGitWorkspace`. A refactor with no defect today.
  - `[medium]` `[patch]` (blind) The "mirrors" test does not compare against the write check. Same root cause as the verification-gap parity row; patched with it.
  - `[low]` `[reject]` (blind) Each pass packs all of head's and main's history. An efficiency cost only; reusing a pack across passes adds state.
  - `[false]` `[reject]` (blind) The follow-up pass runs even after a blocking normal pass. AD-16 says "each review round runs a second session" and "findings from either are loopbacks", so both passes run, and their findings feed the loopback.
  - `[low]` `[reject]` (blind) The live `reviewBodies` control returns every review body from the first page. It mirrors the live `comments` control, and a scratch PR holds only the bot's reviews. Test-only, and the live suite is opt-in.
  - `[low]` `[reject]` (blind) Missing step tests: a `Halt` reaching the caller, the record after a first-pass post failure, a review budget overrun. The redaction part was patched (first row). The rest follow `retro-step.ts`'s pattern, which its own tests cover, and a post failure is a failed attempt with `passed_sha` null (tested).
  - `[low]` `[reject]` (blind) Neither fake checks that `commit_sha` is on the PR. GitHub's 422 maps to `rejected`, which the step handles as a failed attempt (tested through `injectError`).
  - `[false]` `[reject]` (blind) `spec_path` is only `SafeText`. The step takes it from the checkout listing (`specMatches` over repo-relative paths), so it is never absolute or `..`.
  - `[low]` `[patch]` (edge) `setUp` did not check that the snapshot's PR number is the record's `pr`. The step now fails the attempt with no session when they differ (test row added).
  - `[medium]` `[patch]` (edge) `dir` equal to or containing the agent's clone would be wiped. Same root cause as the blind checkout-folder row; patched with it.
  - `[low]` `[reject]` (edge) The live `reviewBodies` control diverges from the emulator's. Same as the blind live-control row.
  - `[medium]` `[defer]` (intent) Nothing calls the review step, so production still sets `passed_sha` without a review. This is the planning gap already deferred (no Epic 3 manifest covers `src/cli/**`), and Story 3.5 owns the sequence. Appended to `deferred`.
  - `[low]` `[reject]` (intent) The real git checkout and the step are tested apart, never composed with the real sandbox. The seam is the one-method `ReviewCheckout.prepare`; the real macOS sandbox cannot run inside a sandboxed session. Recorded as the residual risk the follow-up review should check.
  - `[false]` `[reject]` (intent) The reviewer's vendor home is not seeded by new code. The sandbox empties and seeds `profile.vendorHome` from the reviewer agent's `LaunchSpec` credential on every fresh run (src/sandbox/vendor-home.ts:141-176, src/sandbox/macos.ts:326-333).
  - `[false]` `[reject]` (intent) The follow-up prompt points at `## Auto Run Result` instead of inlining the risks. Story 3.4's AC asks the prompt to tell the reviewer "to check the unverified risks the spec's Auto Run Result names", which it does.
  - `[false]` `[reject]` (intent) `passed_sha` is per round, not per result. For an unflagged unit the two readings agree; for a flagged one AD-16 sets it "only when both passes have no blocking findings".
  - `[low]` `[reject]` (intent) The GitHub adapter is shown against the emulator; the live contract case is opt-in. This is the repo's rule: live cases need `XARABOT_LIVE=1` and report skipped otherwise.

## Design Notes

The round lives in one step because AD-16 binds `passed_sha` to both passes. A single-pass step would have to set `passed_sha` and then clear it after a failing follow-up, which leaves a window where a takeover could enqueue. Story 3.5 places the step in the sequence and adds loopbacks, caps and the enqueue gate. Its "case tables gain rows" then extend this step's tests.

Each pass rebuilds the checkout, so the first reviewer's writes never reach the second. Both passes are at the same `head_sha` and the same `main`.

The cross-vendor reviewer runs with its adapter's defaults (AR22: an unset `model` is the default, an unset `effort` is `high`). The lane's `model` belongs to the lane's adapter, so only a same-adapter reviewer reuses the lane's settings.

The step keeps its own `UnitTrack` (the caller's `logName`), so a reviewer from another vendor never overwrites the builder's `reportedModel` in the unit's journal record. Per-session review telemetry is CAP-11's.

Golden body:
```
🤖 Story 3.4: cross-vendor review by codex (gpt-6.1-sol) of 0123…cdef.

Verdict: changes requested.
Outcome: blocking.

Findings:
- high, blocking, `src/a.ts`: the loop never ends.

Denied actions: none.
```

## Verification

**Commands:**
- `bun test` -- expected: 0 fail; sandbox and live cases skipped inside the session.
- `bun --bun tsc` -- expected: exit 0.
- `bun --bun oxlint` -- expected: exit 0.

## Auto Run Result

Status: done

**Summary:** The runner can now review a unit's PR. A review step, `createReviewStep`, runs one review round on a claimed unit's open PR:
- It reads fresh `main`, checks that the PR is open at the record's head and number, and picks the reviewer with `chooseReviewer` from the record's `builder_providers` and the policy.
- Each pass runs through the sandbox in `<lane>/review`: a fresh checkout of `head_sha`, written from `runner.git` by hand. It has a detached `HEAD`, a `main` ref, `core.hooksPath = /dev/null` and `main`'s agent config, and is never the builder's clone. The vendor home is freshly seeded.
- The prompt comes from new package template parts: it names the unit, the SHAs and the Story spec, and ends with a `review` result. A spec at the head with `followup_review_recommended: true` adds a follow-up pass, whose prompt names the spec and its Auto Run Result risks.
- After each pass, the runner records `reviewed_sha` as the head it checked out, ignoring the agent's own SHA. It then posts a comment-only review through the new `Forge.postReview`, naming the SHA, cross- or same-vendor, the verdict, the runner's outcome, the findings and the denied actions.
- `passed_sha` is set only after a round in which no pass blocked.

**Files changed:**
- `src/ports/forge.ts`, `src/adapters/forge/fake/fake-forge.ts`, `src/adapters/forge/github/github-forge.ts`, `src/adapters/forge/github/http.ts`: `postReview` (a `COMMENT` event only; new op `createReview`, `pull_requests: write`).
- `src/core/prompt/template.ts`, `src/core/prompt/build-prompt.ts`: `review`, `review_followup`, `review_rules` and `result_review` parts, `REVIEW_RESULT_JSON_SCHEMA`, `buildReviewPrompt`.
- `src/core/review/agent-config.ts`, `review-spec.ts`, `review-comment.ts` (new): `isAgentConfigPath`, `followupRecommended`, `isBlocking` and `reviewComment`.
- `src/lane/clone.ts`: the `.git` writing and pack code shared with `rebuildClone`, unchanged in behaviour; `writeReviewCheckout`.
- `src/lane/review-checkout.ts` (new): the `ReviewCheckout` port, its git version (always `laneLayout(laneDir).review`), and the session `Workspace` adapter.
- `src/lane/lane-store.ts`: `laneLayout.review`.
- `src/lane/review-step.ts` (new): the review round.
- Tests: `test/core/review/*` (new); `test/lane/review-checkout.test.ts` and `review-step.test.ts` (new); the forge contract with its three harnesses and the GitHub emulator's review route; the op tables; the prompt and lane-store tests.
- `test/ports/forge.test.ts`: the operation list. This is outside the manifest's globs, but `tsc` needs it, because the test pins `keyof Forge`.

**Review findings:** 28 findings (high 0, medium 7, low 15, false 6, maybe-false 0).
- Patched: 10 entries (medium 4, low 6).
  - The review rules part, and the "no tracked file" wording.
  - The reviewer's denied actions in the body and the log.
  - The outcome line.
  - The checkout folder fixed to `laneLayout(laneDir).review`.
  - The PR number check.
  - Tests: the redaction step test, the fold rows, the write-check parity test, and the STOP track assertions.
- Two fixes found while reading the diff before review are in the tree: the follow-up pass is added once even when a usage limit restarts the normal pass, and `--replace` on the agent-config restore, so a file/folder clash does not fail the checkout.
- Deferred: three entries in frontmatter `deferred`, all for the Maintainer.
  - The empty `builder_providers` case (carried from spec-3-3).
  - No Epic 3 manifest covers `src/cli/**`, where `lane run` must compose the reviewers and the step.
  - The step has no caller yet, so `merge-step.ts` still sets `passed_sha` without a review.
- Rejected:
  - A head file replaced by `main`'s agent config at a clashing path (low, rare, the diff still shows it).
  - Duplicated helpers (low, refactor).
  - Packing twice per round (low, efficiency).
  - The live `reviewBodies` control (low, mirrors `comments`, opt-in).
  - Further step tests for `Halt`, budget and first-pass post failure (low, existing patterns and coverage).
  - The fakes not checking `commit_sha` (low, `rejected` is handled).
  - The emulator-only GitHub run (low, the live rule).
  - Uncomposed checkout and step tests (low, recorded as the risk below).
  - Symlinks leaving the repo (false, the write check refuses them).
  - The follow-up pass after a blocking normal pass (false, AD-16).
  - `spec_path` validation (false, derived from the listing).
  - Vendor-home seeding (false, the sandbox seeds on every fresh run).
  - The follow-up prompt pointing at the section (false, matches the Story AC).
  - Per-round `passed_sha` (false, AD-16).

**Follow-up review recommended:** true. On this first pass, 4 medium entries were patched (0 high, 6 low). The unverified risk: the real path has never run end to end. That path is `createGitReviewCheckout` writing `<lane>/review`, then `createReviewStep` launching a reviewer through the real macOS sandbox with `profile.clone = <lane>/review`. In particular, it is unchecked whether the sandbox's root checks and profile accept the new folder, and whether a reviewer can run `git diff main...HEAD` there. The step tests use stub checkouts and sandboxes, and the checkout tests run no session.

**Verification:**
- `bun test`: 4919 pass, 322 skip, 0 fail. The skips are sandbox, host-only and live cases that cannot run in a sandboxed session, including the GitHub emulator contract harness. Also run before review (4902 pass, 0 fail).
- `bun --bun tsc`: exit 0.
- `bun --bun oxlint`: exit 0.
- Matrix audit: each I/O row is covered by a test in `test/lane/review-step.test.ts`, `test/lane/review-checkout.test.ts`, `test/core/review/*` or the fake forge contract harness. Each of those tests ran and passed, which I checked against a JUnit report; none is skipped.

**Residual risks:**
- The end-to-end sandbox run described above.
- The review step is not wired into `lane run` or the lane sequence (deferred). Until it is, production `passed_sha` is still set by the merge step with no review.
- The empty `builder_providers` decision (deferred).
- The reviewer's sessions are kept off the unit's journal record (its own track). Per-session review telemetry is still to come with CAP-11.
- `docs/maintainer/app-permissions.md` does not list `createReview` under `pull_requests: write`. It is outside this Story's globs, and the App already has that permission.

**Not committed:** per this run's instructions, the changes stay in the working tree, so the skill's commit-and-clean-tree finalization was not run.
