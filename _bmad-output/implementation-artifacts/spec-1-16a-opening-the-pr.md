---
title: 'Story 1.16a: Opening the PR'
type: 'feature'
created: '2026-10-23'
baseline_revision: '8600401eac44e651ebb76cc8efa338cab3c54f44'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      A push that succeeds before openPr or the record heartbeat fails leaves a branch the ledger does not know about, so each retry's null lease conflicts until the unit parks at attempts-cap.
    evidence: |-
      failAttempt keeps the stale head_sha; the next claim finds no open PR and claim() writes head_sha null (edits.ts claim prFields); pushBranch with expected_sha null against an existing branch is conflict (fake forge and --force-with-lease alike). The same gap hits a branch left by a closed PR. Fixing it needs a lease against the branch's real head, which the Forge port cannot read (no branch-head operation), or a claim that keeps head_sha, both outside this Story. The unit parks at attempts-cap, so it surfaces to the Maintainer rather than looping.
    location: >-
      src/lane/pr-step.ts (push, then openPr), src/core/ledger/edits.ts claim
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Story 1.16 hands a validated `done` build result to an injected `PrStep`, but no real PR step exists. Nothing commits the session's work as the bot, re-checks the Standing Authority before the push, pushes with a lease, opens the PR, records `pr` and `head_sha`, or posts the 🤖 status comment (FR6, FR13, FR22, NFR10, AR7, AR16, AR21, AR44).

**Approach:** Add `createPrStep(deps)` in `src/lane/pr-step.ts`, which returns a `PrStep`. It runs one fresh forge snapshot, a commit through a narrow injected `Committer`, a config and Standing Authority check on that snapshot, a fencing heartbeat, `pushBranch` with a lease, `openPr` (or `updatePr` for an adopted PR), a heartbeat that records `pr`/`head_sha`/`base_sha`, and one `Forge.comment`. `createGitCommitter` in `src/lane/committer.ts` wires the `Committer` to `runner.git` through `commitSession`. Tests drive the step with the fake forge and a stub committer, and run it end to end through `runLaneProcess` with a stub agent.

## Boundaries & Constraints

**Always:**
- **`Committer`** (`src/lane/committer.ts`): `commit({unit, ontoSha, message, signal})` returns `Result<CommitOutcome, WorkspaceErrorKind>` and never throws. `createGitCommitter({gitDir, clone, bot, fetch})` does the following:
  - fetches `ontoSha` through the injected `FetchShas` only when `needCommit` reports it `missing-object`;
  - reads the clone marker and requires its `unit` to equal the request's unit (else `no-session`);
  - takes `baseSha` = `git merge-base <marker.start> <ontoSha>` (no merge base is `invalid`);
  - calls `commitSession({gitDir, clone, baseSha, ontoSha, bot, message, signal})`.
- **`createPrStep(deps)`**. `PrStepDeps` holds `forge`, `committer`, `identity`, `repo` (the slug), and optional `callTimeoutMs` (default 60 000), `now`, `sleep` and `random`. The step runs in this order and never throws:
  1. **Snapshot.** `forge.snapshot({read: readsPath})` is the "freshly fetched `main`". Its `main.sha` is `ontoSha`, and its `now` is the base for ledger times. A later edit's time is that `now` plus the host time since.
  2. **Commit.** `committer.commit` with the message `<story_id>: <result.summary>` (`commitSession` sanitizes it). The signal is `AbortSignal.any([input.signal, call deadline])`.
     - `committed`: continue.
     - `empty`: `park` blocked, reason `no-op`; outcome `progress`.
     - `conflict` or any error: a failed attempt.
  3. **Standing Authority re-check.** `loadRepoConfig` runs on the same snapshot. Any error returns outcome `stop`, with no push, no PR, no ledger edit and no alert. The reason names the error kind. This matches Story 1.16's assembler stop.
  4. **Fence.** `heartbeat({generation: record.generation})` goes through `swapLedger`. A `precondition` failure means the unit was lost: outcome `failed`, with no further ledger edit. Any other swap failure is a failed attempt.
  5. **Push.** `pushBranch({branch: <config.branches.story><story_id>, expected_sha: record.head_sha, sha: head_sha})`. Any failure, `conflict` included, is a failed attempt.
  6. **PR.** Title: `Story <story_id>: <story.title>`. Body: the summary, a blank line, then the body (just the summary when the body is blank). Both go through `sanitizeAgentText`. When `record.pr` is null, call `openPr({branch, base: "main", title, body})`; otherwise call `updatePr(record.pr, {title, body})`. A failure is a failed attempt.
  7. **Record.** `heartbeat` with `set: {pr, pr_owner: identity.owner, head_sha, base_sha: <commit base_sha>}`. A failure follows the step-4 rule.
  8. **Status comment.** `forge.comment(pr, text)`. The text starts with `🤖`, names the Story, the short head SHA and the lane, and then lists the denied actions:
     - the line `Denied actions:`, then one `- <sanitized action>` line per entry in result order;
     - or `Denied actions: none.` when there are none.

     A failed comment is logged and noted in the reason. The outcome stays `progress`.
  9. Success returns outcome `progress` and state `claimed`, with the record as written.
- **Failed attempt** means `failAttempt` at the record's generation through `swapLedger`, returning outcome `failed` with the state after (`released`, or `parked` at the cap).
- **Forge stop kinds.** An `auth`, `forbidden` or `uninstalled` error from any call, or a ledger `stop` from a swap, posts `alert(<condition>, <ontoSha or 40 zeros>)`, ignores whether the alert fails, and returns outcome `stop`, as Story 1.16 does.
- **Budget.** If `input.signal` is aborted before the push, the step does a failed attempt and does not push.
- **`PrStep` contract.** These are additive changes in `src/lane/lane-process.ts`:
  - `PrStepInput` gains `log(text)`, which writes a note to the unit log.
  - `PrStepOutput` gains an optional `record` (the latest ledger record) and an optional `reason`.
  - `runLaneProcess` passes `note` as `log`, sets `t.record` from `out.record`, and adds `out.reason` to the journal reason.
  - `readsPath` is reused.

**Never:**
- No CI polling, conflict resolution, CI fix, review, enqueue or merge (Stories 1.17, 1.17a).
- No conflict resolution at commit time. A three-way conflict is a failed attempt (readiness R10 leaves this open).
- No git run against the clone's `.git`. No GitHub-backed `fetch` (the launcher, Story 1.19).
- No change to the `Forge`, `Agent`, `Sandbox` or `LaneStore` ports, or to `commitSession`.
- No `Co-Authored-By` or similar marker in the commit, PR or comment. No agent text reaches the forge unsanitized.
- No `Bun.spawn` in `src/lane/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path | new unit, valid SA | commit onto fresh `main`; push lease `null`; PR opened with sanitized text; record `pr`, `head_sha`, `base_sha`; 🤖 comment | outcome `progress` |
| Adopted PR | record has `pr` 7, `head_sha` H | push lease H; `updatePr(7)`; no new PR | outcome `progress` |
| SA missing / invalid | fresh `main` without the SA, or expired | no push, no PR, record still `claimed` | outcome `stop` |
| Denied actions | `["git push", "@bob rm"]` | comment lists both, sanitized; journal `denied_actions` holds both | none |
| None denied | `[]` | comment says `Denied actions: none.` | none |
| Lease conflict | branch already at another SHA | no PR; `released`, `attempts` + 1 | outcome `failed` |
| Commit conflict | committer returns `conflict` | no push; `released` | outcome `failed` |
| Empty commit | committer returns `empty` | `parked` blocked `no-op`; no push | outcome `progress` |
| Lost claim | record generation bumped by another lane | no push; no ledger edit | outcome `failed` |
| Forge stop | `forbidden` on `pushBranch` | alert `forge-forbidden` | outcome `stop` |
| Comment fails | `comment` returns `transient` | PR recorded | outcome `progress`, reason notes it |
| Budget | signal aborted before push | no push; `released` | outcome `failed` |

</intent-contract>

## Code Map

- `src/lane/lane-process.ts` -- `PrStep`, `PrStepInput`, `PrStepOutput`, `readsPath`; the call site at the `deps.prStep(...)` call in `work`; the journal record built at the end; the `Halt`, `laneStop` and `swap` patterns to mirror.
- `src/lane/commit.ts` -- `commitSession(CommitParams)` → `CommitOutcome` (`committed` {base_sha = ontoSha, head_sha} | `conflict` | `empty`); it sanitizes the message and requires `baseSha` to be the marker start or its ancestor.
- `src/lane/clone.ts` -- `readMarker` (unit, start), `needCommit` (`missing-object`), `git`/`gitRun` (hardened runner git).
- `src/lane/workspace.ts` -- `FetchShas`, `WorkspaceErrorKind`, and the missing-SHA fetch pattern to copy.
- `src/lane/ledger-cas.ts` -- `swapLedger({forge, edit, signal, sleep, random})`; the error kinds `edit` (`.edit`), `forge` (`.forge`), `exhausted` and `deadline`.
- `src/core/ledger/edits.ts` -- `heartbeat({..., set})` (fenced by `requireHeld`), `failAttempt`, `park`.
- `src/core/config/load-repo-config.ts` -- `loadRepoConfig(snap)`, which does the SA check (`missing`, `authority-*`).
- `src/core/sanitize.ts` -- `sanitizeAgentText`.
- `src/core/bot-identity.ts` -- `BotIdentity`.
- `src/ports/forge.ts` -- `pushBranch(lease)`, `openPr`, `updatePr`, `comment`, `alert`, `isLaneStopKind`.
- `src/adapters/forge/fake/fake-forge.ts` -- `pushBranch` returns `conflict` when the head is not `expected_sha`; `control.comments(pr)`, `alerts()`, `injectError`, `makeCommit`, `setMain`, `writeForeignLedger`.
- `test/lane/lane-process.test.ts` -- the harness (main files, stub agent/sandbox/workspace, `finishes`, `pr()`), to copy for the end-to-end cases.
- `test/lane/git-fixture.ts` -- `setup`, `commit`, `files`, `rg`, `BOT` for the real-git committer test.
- `test/core/ledger/fixtures.ts` -- `rec`, `tip` for seeding ledger records.

## Tasks & Acceptance

**Execution:**
- `src/lane/committer.ts` -- `Committer`, `CommitRequest`, `createGitCommitter` -- the commit behind a narrow port, so the step runs against the fake forge.
- `src/lane/pr-step.ts` -- `PrStepDeps`, `createPrStep`, `statusComment` (exported, pure) and `prText` -- the PR step.
- `src/lane/lane-process.ts` -- the additive `PrStepInput.log`, `PrStepOutput.record`/`reason` and their use.
- `test/lane/committer.test.ts` -- real git: commit onto a newer `main` with the bot author; a fetch called only for a missing `ontoSha`; an adopted head's base is the merge-base; a marker for another unit refused.
- `test/lane/pr-step.test.ts` -- one case per matrix row, against the fake forge and a stub committer, asserting the ledger record, the PR list, the comments and alerts. Also end-to-end `runLaneProcess` cases with a stub agent: the happy path, and denied actions in both the journal and the comment.

**Acceptance Criteria:**
- Given a `done` result, when the PR step succeeds, then the fake forge holds one open PR on `story/<id>` whose head is the committed SHA, and the record has `pr`, `pr_owner`, `head_sha` and `base_sha` set.
- Given a summary carrying `Co-Authored-By:` and `@someone`, when the PR opens, then its title, body and comment contain neither.
- Given `bun test`, `bun --bun oxlint` and `bun --bun tsc`, when they run, then each exits 0 and the boundaries test passes.

## Spec Change Log

## Review Triage Log

### 2026-10-23 — Review pass
- verdicts: 27 findings — high 0, medium 6, low 16, false 5, maybe-false 0
- findings:
  - `[medium]` `[defer]` (edge) push succeeds, then openPr or the record heartbeat fails: stale lease, conflict on every retry until attempts-cap — the claim from Story 1.16 resets `head_sha` to null when no PR is open, and the `Forge` port has no branch-head read; the fix lies outside this Story; deferred in frontmatter.
  - `[false]` `[reject]` (edge) a unit lost at the record heartbeat leaves an orphaned PR — the lane that took the unit lists the branch's PRs at its claim and adopts the open one (`decidePr`), so the PR has an owner.
  - `[low]` `[reject]` (edge) budget passing after the PR is recorded releases the unit and counts an attempt — this is AR3's rule ("overrun … releases as a failed attempt") and Story 1.16's tested contract; the next claim adopts the open PR, so no work is lost.
  - `[low]` `[reject]` (edge) an adopted PR closed between claim and push is updated and recorded — needs the Maintainer to close the PR during a session; the fix adds a guard branch; Story 1.17 polls the PR next.
  - `[low]` `[reject]` (edge) an unparseable snapshot `now` throws in `forgeNow` — both forges return ISO server times; the throw is caught and the step returns `failed`; adding validation is a guard for a state not shown reachable.
  - `[medium]` `[patch]` (edge) an empty-after-sanitizing denied action renders a bare `- ` bullet — grouped with the sanitizer bypass below; empty actions are now skipped.
  - `[false]` `[reject]` (edge) a clone marker from an older generation is committed — the lane rebuilds the clone with `prepare` for the current generation earlier in the same process, so the marker always matches the claim.
  - `[low]` `[reject]` (edge) a fetch that reports ok but leaves `ontoSha` missing gives an opaque git error — it is still a failed attempt with the git message; the extra check is a guard for a broken fetch.
  - `[low]` `[patch]` (verification-gap) `runLaneProcess` copying the step's `record`/`reason` into the journal is untested — end-to-end lease-conflict case added (journal `failed`, `released`, `attempts` 1, reason), plus an end-to-end Standing Authority stop.
  - `[low]` `[patch]` (verification-gap) ledger heartbeat times from the forge clock are never asserted — a case with a skewed host clock asserting `heartbeat_at` added.
  - `[low]` `[patch]` (verification-gap) the `ledger-schema-version` stop in the step's swap is untested — case added.
  - `[medium]` `[defer]` (verification-gap other) push ok then openPr fails leaves an unknown branch — same as the first edge row; deferred there.
  - `[false]` `[reject]` (verification-gap other) `createPrStep` and `createGitCommitter` are not wired in production — the launcher (Story 1.19) wires them, as it does `runLaneProcess` and `createGitWorkspace`; no AC observes a CLI.
  - `[medium]` `[defer]` (blind) the branch can be orphaned after a successful push — same as the first edge row.
  - `[low]` `[reject]` (blind) an adopted PR's state is not checked against the fresh snapshot — same as the closed-PR edge row.
  - `[medium]` `[patch]` (blind) `statusComment` sanitizes before collapsing newlines, so `"fixes\n#12"` becomes `- fixes #12` — whitespace is now collapsed first, then sanitized; test cases added.
  - `[medium]` `[patch]` (blind) a sanitized-to-empty action keeps a bullet — same root as the row above.
  - `[low]` `[reject]` (blind) budget after the PR is recorded releases the unit — same as the edge budget row.
  - `[low]` `[patch]` (blind) the budget is first checked after the commit, and the test's stub ignores the signal — `overBudget()` now also runs before the snapshot.
  - `[low]` `[reject]` (blind) the commit and its fetch share the 60 s call deadline — the fetch of one `main` SHA into an existing `runner.git` is incremental; a timeout is a failed attempt that retries; a separate deadline adds a parameter.
  - `[low]` `[patch]` (blind) `pr-step.test.ts` misses failure paths — `openPr` failure, ledger stop and end-to-end failed/stop cases added; the throw and catch-all paths stay untested (rejected: they are wrappers around paths already tested).
  - `[low]` `[reject]` (blind) `committer.test.ts` misses error paths (no marker, throwing fetch, other `needCommit` errors, aborted signal) — each is a pass-through of a `clone.ts` error already tested in Story 1.15.
  - `[false]` `[reject]` (blind) a lost unit's `record` overwrites `t.record` — the record returned is this lane's last held record (its own generation), which is what the journal should report for this lane's run.
  - `[low]` `[reject]` (blind) `message(e)` is defined three times — a two-line helper; sharing it adds an export across files for no behaviour change.
  - `[false]` `[reject]` (intent) the step is not production-wired (reading R2) — Story 1.19 builds the launcher; Story 1.16 shipped `runLaneProcess` the same way.
  - `[low]` `[patch]` (intent) the Standing Authority re-check is tested only at step level — end-to-end stop case added (grouped with the journal-propagation patch).
  - `[low]` `[reject]` (intent) a failed status comment still counts as `progress` — the PR and record exist; failing the attempt would release a unit with a live PR; the failure is in the journal reason.

## Design Notes

**One snapshot.** The snapshot is taken at the start of the step. It gives the commit's `ontoSha` and the `main` the Standing Authority is checked on. The check runs after the commit and right before the fence and the push, so its order matches the AC. A local commit takes seconds, and Story 1.17 handles `main` moving after that.

**Base.** `merge-base(start, ontoSha)` covers both cases with one rule. For a fresh unit, the start is the claim's `main`, which is an ancestor of the fresh `main`, so the base is the start. For an adopted PR, the base is the point where the PR forked, so the one bot commit carries the whole PR onto fresh `main`.

**Stop leaves `claimed`.** This matches Story 1.16's lane-stop paths. A stopped lane writes nothing more, and Epic 2 takes over a stale record.

## Verification

**Commands:**
- `bun test` -- expected: exit 0
- `bun --bun oxlint` -- expected: exit 0
- `bun --bun tsc` -- expected: exit 0

## Auto Run Result

Status: done

**Summary:** `createPrStep(deps)` is the real `PrStep` that Story 1.16's lane process calls after a validated `done` result. It runs these steps in order:
1. Takes one fresh forge snapshot, the "freshly fetched `main`".
2. Makes the bot commit onto that `main` through a `Committer`. `createGitCommitter` fetches the SHA only when `runner.git` lacks it, takes the base from `merge-base(start, main)`, then calls `commitSession`.
3. Re-checks config and the Standing Authority on that `main`. Any failure stops the lane with no push, no PR and no ledger edit.
4. Fences with a heartbeat.
5. Pushes with a lease against the record's `head_sha`.
6. Opens the PR, or updates an adopted one. The title is `Story <id>: <title>` and the body is the summary and body; both are sanitized.
7. Records `pr`, `pr_owner`, `head_sha` and `base_sha` with a heartbeat.
8. Posts one 🤖 status comment listing the sanitized denied actions.

Other outcomes:
- Failures release the unit as a failed attempt (or park it at the attempts cap).
- An empty commit parks the unit blocked `no-op`.
- A lost claim ends the step with no further ledger edit.
- A forge `auth`, `forbidden` or `uninstalled` error, or an unknown ledger `schema_version`, alerts and stops the lane.

`runLaneProcess` now passes a `log` to the step. It also takes the step's `record` and `reason` into the journal record.

**Files changed:**
- `src/lane/committer.ts`: the `Committer` port and `createGitCommitter`.
- `src/lane/pr-step.ts`: `createPrStep`, `prText` and `statusComment`.
- `src/lane/lane-process.ts`: additive changes. `PrStepInput.log`, `PrStepOutput.record` and `reason`, journal propagation, and `writtenRecord` exported.
- `test/lane/committer.test.ts`: 6 cases against real git.
- `test/lane/pr-step.test.ts`: 28 cases. One per matrix row against the fake forge and a stub committer, the pure helpers, and four end-to-end `runLaneProcess` runs with a stub agent: happy path, denied actions, lease conflict, and Standing Authority removed.

**Review findings:** 27 findings: 0 high, 6 medium, 16 low, 5 false.
- **Patched:** 1 medium entry and 5 low entries. All are recorded in the Review Triage Log.
  - The status comment collapsed newlines after sanitizing, so `"fixes\n#12"` came back as a closing keyword. It now collapses whitespace first and skips actions that sanitize to nothing.
  - The budget is now also checked before the snapshot.
  - New tests cover the journal taking the step's record and reason, the forge-clock `heartbeat_at`, the `ledger-schema-version` stop, an `openPr` failure, and an end-to-end Standing Authority stop.
- **Deferred:** 1 medium. A push that succeeds before `openPr` fails leaves a branch the next claim's null lease conflicts with, until the unit parks at the attempts cap. The `Forge` port can't read a branch head, and the claim from Story 1.16 resets `head_sha`. Details are in the frontmatter `deferred`.
- **Rejected:** 16 low and 5 false, each with its reason in the Review Triage Log. Among them:
  - the budget overrun after the PR is recorded (AR3's rule, and Story 1.16's tested contract);
  - an adopted PR closed mid-session;
  - the shared 60 s deadline for commit and fetch;
  - the step not being wired in production yet (Story 1.19);
  - a failed status comment counting as `progress`.

**Follow-up review recommended:** false. Only one medium entry was patched, and none was high.

**Verification:**
- `bun install`: no changes.
- `bun test`: 2087 pass, 61 skip, 0 fail, boundaries test included.
- `bun --bun oxlint` and `bun --bun tsc`: both exit 0.
- Every I/O matrix row has a test that ran and passed.

**Residual risks:**
- Nothing builds the real step yet. The launcher (Story 1.19) must wire `createPrStep`, `createGitCommitter` and a GitHub-backed `fetch`.
- A three-way conflict at commit time is a failed attempt and is not resolved (readiness R10 leaves this open).
- The branch orphaned after a push, deferred above. The same lease conflict hits a branch left by a closed PR.
- An adopted PR closed between the claim and the push is updated and recorded as if it were open.
