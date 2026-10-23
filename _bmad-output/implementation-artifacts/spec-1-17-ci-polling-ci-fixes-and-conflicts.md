---
title: 'Story 1.17: CI polling, CI fixes and conflicts'
type: 'feature'
created: '2026-10-23'
baseline_revision: '33bde75c2fe78263392f0cd5d73c1f767b9fe5ad'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      A merge push that succeeds before its record heartbeat fails leaves the ledger's head_sha behind the branch, so every later leased push conflicts until the unit parks at attempts-cap.
    evidence: |-
      pushMerge pushes, then beat("record") sets head_sha; a failed or lost heartbeat leaves the old head_sha, and the next push leased on it is conflict. Same root as Story 1.16a's deferred push-then-record gap: fixing it needs a lease against the branch's real head, which the Forge port cannot read. The unit parks at attempts-cap, so it surfaces to the Maintainer rather than looping.
    location: >-
      src/lane/ci-step.ts pushMerge
    severity: medium
---

<intent-contract>

## Intent

**Problem:** After Story 1.16a opens the PR, nothing takes it through CI. Nothing polls checks, resolves a conflict with `main`, runs a CI-fix session or parks the unit at the CI caps, so the lessons Xaravel paid for (AR20, AD-19) are not in code (FR6, AR8, AR20, AR44).

**Approach:** Add `createCiStep(deps)` in `src/lane/ci-step.ts`. It runs after a PR step that leaves the unit `claimed` with a PR. For each head it takes one fresh snapshot and loads config and the Standing Authority. It merges `main` into a conflicting PR through a narrow `Merger` port. It then polls the head's checks with back-off. An unexpected failure, or a conflict no rule resolves, runs a builder session that `runLaneProcess` provides, and the PR step pushes the fix. The pure parts live in `src/core/ci/`: check classification, poll delays and the status-YAML merge. `createGitMerger` in `src/lane/merger.ts` does the merge in `runner.git`.

## Boundaries & Constraints

**Always:**
- **Pure core (`src/core/ci/`):**
  - `classifyChecks(checks, expected)` returns `pending`, `passed` or `failed` with the failing check names.
    - An empty list is `pending`.
    - Passing conclusions are `success`, `neutral` and `skipped`. Any other completed conclusion is a failure.
    - A failure whose check name is in `expected` is ignored.
    - A completed unexpected failure is `failed` at once, even while other checks are pending.
    - `passed` means every check is completed and none failed unexpectedly.
  - `pollDelayMs(n)` gives 30 000 ms for poll 0 and doubles each poll, capped at 300 000 ms (30, 60, 120, 240, 300, 300 s).
  - `mergeStatusYaml({base, pr, main})` starts from `main`'s text and its lines, comments included. It re-applies each mapping entry the PR changed against `base`: a changed value is taken whole, an added entry goes after its PR predecessor (else at the end), and a deleted one is deleted. Nested mappings that both sides changed are merged recursively; any other entry both sides changed takes the PR's version. Text it cannot split into block-mapping entries (flow style, tabs, multiple documents), or a result that does not parse as YAML, is an error.
  - `isLockfile(path)` matches these basenames: `bun.lock`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml` and `yarn.lock`.
- **`Merger` port (`src/lane/merger.ts`):** `merge({unit, headSha, mainSha, message, statusPaths, lockfiles?, signal})` returns `Result<MergeOutcome, WorkspaceErrorKind>` and never throws. It fetches a missing SHA through `FetchShas`. The outcome is one of these kinds:
  - `up-to-date`: `main` is an ancestor of the head.
  - `clean`: `merge-tree` finds no conflict, so there is nothing to push.
  - `merged {head_sha, resolved}`: every conflict was resolved, and a bot-authored commit with parents (head, main) was written to `headRef(unit)`.
  - `lockfile {candidate_sha, paths}`: only status and lockfile conflicts remain, and `lockfiles` was not given.
  - `needs-session {candidate_sha, paths}`: some conflict is neither a status file nor a lockfile, or a status merge failed.

  Status paths are resolved with `mergeStatusYaml`. A lockfile takes the given `lockfiles[path]` text, or `main`'s blob in a candidate. A candidate is a runner-identity commit with parents (head, main). Its tree keeps the conflict markers of the paths it lists.
- **`createCiStep(deps)`** returns a `CiStep`. `CiStepDeps` holds `forge`, `merger`, `identity`, `repo`, and optional `callTimeoutMs`, `now`, `sleep` and `random`. `CiStepInput` holds `unit`, `record`, `specPath`, `clone`, `signal`, `log`, `scratchDir`, `prStep`, `session` and `regenerate`. Each round, for the record's `head_sha`, runs these steps:
  1. **Snapshot and config.** `snapshot({read: readsPath})` is fresh `main`, and `loadRepoConfig` runs on it. Any config error returns `stop`, with no push and no ledger edit (the Standing Authority re-check of AR21).
  2. **Merge.** `merger.merge` runs with `statusPaths` = `[sprint_status_path, retro_gates_path]`.
     - `up-to-date` or `clean`: poll.
     - `merged`: fence with a heartbeat, `pushBranch` with lease `head_sha`, then a heartbeat setting `head_sha` and `base_sha` = main. Post one 🤖 comment naming the merged `main`, then poll the new head.
     - `lockfile` with `lockfile_command` set: `regenerate({start: candidate, paths, command})`, then `merge` again with those texts. A regeneration failure becomes a session.
     - `lockfile` with no command, or `needs-session`: a **conflict session**.
  3. **Poll.** Call `checks(head)`, and between polls sleep `pollDelayMs(n)`, or `retry_after` when that is longer.
     - `transient` and `rate-limited` replies count as pending.
     - `passed`: return `progress`, state `claimed`.
     - Once the host time since the round's first poll is at least `ci_max_wait_minutes`: `park` blocked `ci-timeout`, return `progress`.
     - `failed`: a **CI-fix session**.
  4. **Sessions.**
     - First, `ciFix({cap: 2})`. If that parks the unit (`ci-fix-cap`), return `progress`.
     - A CI fix calls `prefetch({kind: "ci-log", sha: head, dir})` into a fresh folder under `scratchDir`. Its log text names the unexpected failing checks, then gives each prefetched file under a header.
     - A conflict session's log text lists the conflicted paths and says the clone is `main` merged into the PR, with conflict markers in those paths.
     - Then `session({start: head or candidate, logText})`.
       - A session failure is a failed attempt.
       - A `blocked` result parks blocked with `blocked.kind`, and `no-op` parks blocked `no-op`. Either returns `progress`.
       - `done` calls `prStep({..., kind: "fix"})`. A PR step that does not leave the unit `claimed` ends the CI step with its output; otherwise the next round runs on the new head.
- **Forge and ledger errors.**
  - A lane-stop kind from any call, or a ledger `stop`, alerts and returns `stop`.
  - A lost fence (`precondition`) returns `failed` with no further edit.
  - Any other failure of `pushBranch`, `prefetch`, `merger`, `checks` (`conflict`, `not-found` or `not-fast-forward`) or a swap is a failed attempt.
  - An aborted `input.signal` ends the step with `failed` and leaves the record `claimed`; `runLaneProcess` then releases it under the budget rule.
- **`lane-process.ts` (additive):**
  - `LaneDeps.ciStep?: CiStep` is called when the PR step returns `progress` with state `claimed` and a record whose `pr` is set. When it is absent, the run ends after the PR step as today.
  - `PrStepInput.kind?: "build" | "fix"`. For `fix`, `createPrStep` pushes, records and comments, but does not call `updatePr`.
  - `runLaneProcess` builds `session` and `regenerate` from its own machinery. Each one empties `tmp` and prepares the clone at `start`.
    - `session` writes `logText` to `tmp/ci-fix-log.md` and runs the `ci-fix` prompt with the one resume. It parses a build result and requires exactly one spec match, with no status cross-check.
    - `regenerate` runs the agent's launch spec with `argv` = the command and no stdin. It requires exit 0, then reads each path from the clone as a regular file.

**Never:**
- No approval gate, enqueue, merge, dequeue or review (Story 1.17a, Epic 2). No STOP or usage-limit handling inside the poll loop (Story 1.18).
- No `gh pr checks --watch`, no `timeout` binary, no `pkill`. No `Bun.spawn` in `src/lane/`. No GitHub token in any session or in the lockfile command.
- No counting of a conflict session as an attempt or a loopback.
- No change to the `Forge`, `Agent`, `Sandbox` or `LaneStore` ports, or to `commitSession`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Empty then pass | checks `[]`, then all `success` | sleeps 30 s, then `progress`/`claimed` | none |
| Back-off | pending 6 polls | sleeps 30, 60, 120, 240, 300, 300 s | none |
| Expected failure | `protected-paths` fails, listed in `expected_checks` | `passed` | none |
| First unexpected failure | `lint` failed, `test` still running | CI fix at once; `ci_fixes` 1; session log names `lint` | none |
| Fix pushes, then pass | session `done` | `prStep` kind `fix` with the new record; next poll on new head passes | none |
| Fix cap | `ci_fixes` 2, CI fails | `parked` blocked `ci-fix-cap`, no session | outcome `progress` |
| Max wait | pending past 60 min | `parked` blocked `ci-timeout` | outcome `progress` |
| Status conflict | merger `merged` | push lease old head; record new `head_sha`; 🤖 comment; poll new head | none |
| Lockfile, command set | merger `lockfile` | `regenerate` with command; merge again; push | none |
| Lockfile, no command | merger `lockfile`, no `lockfile_command` | conflict session; `ci_fixes` + 1 | none |
| Other conflict | merger `needs-session` | session at candidate; `ci_fixes` + 1; `attempts` and `loopbacks` unchanged | none |
| Conflict at cap | `ci_fixes` 2, `needs-session` | `parked` `ci-fix-cap` | outcome `progress` |
| Poll transient | `checks` returns `transient` | counted as pending | none |
| Forge stop | `checks` returns `forbidden` | alert `forge-forbidden` | outcome `stop` |
| SA revoked | fresh `main` lacks the SA | no merge push, no poll | outcome `stop` |
| Session fails | `session` returns a failure | `released`, `attempts` + 1 | outcome `failed` |
| Fix blocked | result `blocked` `verification` | `parked` blocked `verification` | outcome `progress` |
| Merge push lease conflict | `pushBranch` returns `conflict` | `released`, `attempts` + 1 | outcome `failed` |

</intent-contract>

## Code Map

- `src/lane/lane-process.ts` -- `work` (prepare → prompt → `runOnce` → resume → parse → spec match), `PrStep`, `PrStepInput`, `readsPath`, `writtenRecord`, the budget release after the PR step. `session` and `regenerate` come from this machinery; extract it into one helper that both the build and the fix session use.
- `src/lane/pr-step.ts` -- the step pattern to mirror: the `End` class, `call`, `swap`, `failed`, `lost`, `beat`, `laneStop`, `forgeNow`. The `updatePr` branch gains the `kind: "fix"` skip.
- `src/lane/committer.ts`, `src/lane/clone.ts` -- `git`, `gitRun`, `failed`, `needCommit`, `headRef`, `RUNNER_IDENTITY`, the temp-index pattern in `snapshotTree`; `merge-tree --write-tree -z --name-only --no-messages`, as in `commit.ts`.
- `src/core/ledger/edits.ts` -- `ciFix({cap})` (increment below the cap, else park `ci-fix-cap`), `park`, `failAttempt`, `heartbeat({set})`.
- `src/core/schemas/config.ts` -- `ci_max_wait_minutes`, `lockfile_command`, `sprint_status_path`, `retro_gates_path`. `src/core/schemas/policy.ts` -- `expected_checks`. `src/core/schemas/ledger.ts` -- `ci-timeout`, `ci-fix-cap`.
- `src/core/prompt/build-prompt.ts` -- mode `{mode: "ci-fix", log_path}`.
- `src/core/schemas/common.ts` -- `parseYaml` for checking the merge result.
- `src/adapters/forge/fake/fake-forge.ts` -- `setChecks`, `setCiLog`, `prefetch` (writes one file per failing check), `injectError`, `setMain`, `makeCommit`, `comments`, `alerts`.
- `test/lane/pr-step.test.ts`, `test/lane/lane-process.test.ts`, `test/lane/git-fixture.ts`, `test/core/ledger/fixtures.ts` -- harnesses to copy.

## Tasks & Acceptance

**Execution:**
- `src/core/ci/checks.ts` -- `classifyChecks`, `pollDelayMs`, `PASSING_CONCLUSIONS`.
- `src/core/ci/status-merge.ts` -- `mergeStatusYaml`, `isLockfile`, `LOCKFILE_NAMES`.
- `src/lane/merger.ts` -- `Merger`, `MergeRequest`, `MergeOutcome`, `createGitMerger({gitDir, bot, fetch})`.
- `src/lane/ci-step.ts` -- `CiStep`, `CiStepInput`, `CiStepDeps`, `createCiStep`, `ciLogText`, `conflictLogText`.
- `src/lane/lane-process.ts` -- `LaneDeps.ciStep`, the shared session helper, `session` and `regenerate`, `PrStepInput.kind`.
- `src/lane/pr-step.ts` -- skip `updatePr` for `kind: "fix"` when the record has a PR.
- `test/core/ci/checks.test.ts`, `test/core/ci/status-merge.test.ts` -- case tables.
- `test/lane/merger.test.ts` -- real git: `up-to-date`, `clean`, a status conflict merged with two parents and the bot author, `lockfile` then `merged` with the given text, `needs-session` with markers in the candidate, a fetch only for a missing SHA.
- `test/lane/ci-step.test.ts` -- one case per matrix row, against the fake forge with a stub merger, session, regenerate and PR step, plus end-to-end `runLaneProcess` cases: CI passes after the PR step; a failing check runs a real fix session through the stub sandbox and the journal shows `ci_fixes` 1.

**Acceptance Criteria:**
- Given a unit PR whose checks pass, when `runLaneProcess` runs with a `ciStep`, then the outcome is `progress`, the record stays `claimed` with its `pr`, and the agent got no CI or poll instruction.
- Given an unexpected failure, when the fix session runs, then its prompt is in `ci-fix` mode, its `log_path` file holds the prefetched log, and the journal record's `ci_fixes` is 1.
- Given `bun test`, `bun --bun oxlint` and `bun --bun tsc`, when they run, then each exits 0 and the boundaries test passes.

## Spec Change Log

## Review Triage Log

### 2026-10-23 — Review pass
- verdicts: 26 findings — high 0, medium 4, low 18, false 4, maybe-false 0 (plus 3 descriptive intent-alignment divergences, recorded last)
- findings:
  - `[low]` `[reject]` (blind) CI-fix and conflict-session pushes rebuild the PR onto fresh `main` instead of fast-forwarding it, and a fix whose rebuild conflicts with a moved `main` is a failed attempt — this is the 1.16a commit model that the spec reuses through `prStep({kind: "fix"})`. Only the `merged` path is a fast-forward, as the Design Notes say. The conflict case needs `main` to move during the session, and changing it means a new commit model.
  - `[low]` `[reject]` (blind) an expected check that is still running keeps the result `pending` — the contract says `passed` needs every check completed. The expected checks it names (e.g. `protected-paths`) complete as failures, so they are not left waiting.
  - `[medium]` `[patch]` (blind) a `needs-session` candidate silently takes `main`'s lockfile and does not tell the session — `needs-session` now reports these lockfiles, and the conflict log says they hold `main`'s version and need regenerating.
  - `[medium]` `[patch]` (blind) the conflict log for the `lockfile` fallback falsely says the lockfiles hold conflict markers — same root as the row above, fixed by the same change.
  - `[low]` `[reject]` (blind) fix sessions build their prompt and Human Live Steps from the claim-time snapshot — the Standing Authority and config are re-checked on fresh `main` every round. Prompt sections that change inside one unit's budget are rare, and the fix adds a parameter through `CiSessionRequest`.
  - `[low]` `[reject]` (blind) `ci_fixes` is charged before the prefetch, so a failed prefetch costs a slot and an attempt — the spec orders `ciFix` first, which keeps the cap safe against a crash. A prefetch failure is rare, and the cap bounds the cost.
  - `[medium]` `[defer]` (blind) a merge push followed by a failed record heartbeat leaves the ledger's `head_sha` stale — same root as Story 1.16a's deferred push-then-record gap; deferred in frontmatter.
  - `[low]` `[reject]` (blind) `ci-timeout` can fire up to one delay (≤ 5 min) or one `retry_after` after the max wait — the contract parks once the wait is "at least" the max. Overshooting 60 minutes by 5 does no harm.
  - `[low]` `[reject]` (blind) a comment-only PR edit to a status entry counts as a change and overrides `main`'s value — status files are machine-written, and comments on entries are rare. A parsed-value compare is extra machinery.
  - `[low]` `[reject]` (blind) core `CheckRun` duplicates the port's `ForgeCheck` — `src/core/` is pure and does not import ports. `ForgeCheck` is structurally assignable, and `tsc` would flag drift at the call site in `ci-step.ts`.
  - `[false]` `[reject]` (blind) merge candidates have no ref and can be pruned — `git gc --auto` prunes only unreachable objects older than the 2-week `gc.pruneExpire`. A candidate is used within the same unit (≤ 6 h).
  - `[low]` `[reject]` (blind) further test gaps: the second `lockfile` after regenerating, a prefetch or scratch-folder failure, a failed merge comment, a partial `lockfiles` map, CRLF and quoted keys, `kind: "fix"` with no PR — each is a pass-through or fallback branch of a path already tested. The budget end-to-end gap is patched under the verification rows below.
  - `[low]` `[patch]` (verification-gap) no end-to-end test shows the budget passing during the CI step releasing the unit — a `runLaneProcess` case was added.
  - `[low]` `[patch]` (verification-gap) the real `regenerate`'s exit-code check is untested — an end-to-end case with a non-zero exit was added.
  - `[low]` `[patch]` (verification-gap) nothing checks that fix and lockfile runs prepare the clone at their own `start` — the end-to-end workspace stub now records `prepare`, and the cases assert the start.
  - `[low]` `[reject]` (verification-gap other) fix sessions use the claim-time snapshot — same as the blind row above.
  - `[false]` `[reject]` (edge) a re-run check leaves a stale failure under the same name — the GitHub adapter reads `check-runs?filter=latest`, which returns one run per name.
  - `[low]` `[reject]` (edge) a repo with no CI checks always parks `ci-timeout` — the AC says an empty reply is pending, and CI is a consumer prerequisite.
  - `[false]` `[reject]` (edge) a PR deleting an entry `main` modified drops `main`'s change — the contract says a PR-deleted entry is deleted (the PR's own entries are re-applied).
  - `[false]` `[reject]` (edge) an entry `main` deleted but the PR modified comes back — re-applying the PR's own entries is the contract.
  - `[low]` `[reject]` (edge) a base with an inline scalar where both sides now have block children takes the PR's whole mapping — this is the contract's "PR's version" rule for anything other than nested mappings; the case is rare.
  - `[medium]` `[patch]` (edge) lockfile conflicts next to another conflict quietly take `main`'s lockfile — same root as the blind lockfile row; patched there.
  - `[low]` `[reject]` (edge) after a failed regeneration, the command's leftovers are saved as a wip and resumed into the conflict session — the leftover is a partly regenerated lockfile on the same candidate, a usable start for a session asked to resolve that lockfile. Clearing it adds a branch.
  - `[low]` `[reject]` (edge) duplicate of the claim-time snapshot row.
  - `[low]` `[reject]` (edge) a fix session that reports `done` with no change re-pushes the rebuilt PR — that is the agent misreporting its result; the CI-fix cap of 2 bounds it.
  - `[low]` `[reject]` (edge) duplicate of the `ciFix`-before-prefetch row.
  - intent alignment (descriptive): the diff implements the library reading. It is wired through an optional `LaneDeps.ciStep`, with no production caller, as in Stories 1.16 and 1.16a; the launcher is Story 1.19. Conflict kinds are tested as merger outcomes in the fake-forge suite, and real conflicts are tested separately in `merger.test.ts`. The lockfile command runs with the vendor credential but never a GitHub token (AD-18).

## Design Notes

**Why a merge, not a rebuild.** The PR step rebuilds one commit onto fresh `main`. The CI step instead merges `main` into the PR as AR20 says, so the push is a fast-forward of the PR. A session after a conflict starts at the candidate (parents head and main), so the committer's `merge-base(candidate, fresh main)` is `main`, and the resolved tree lands cleanly.

**The lockfile command's sandbox.** The command runs under the agent's own launch spec with `argv` replaced. It sees exactly what a builder session sees: the vendor credential, but never a GitHub token. That matches AD-18, and the `Sandbox` port needs no change.

**Expected checks** are the ones Xaravel's `--fail-fast` wrongly stopped on, such as `protected-paths`, which waits for the owner's approval. Their failures are ignored, never awaited.

## Verification

**Commands:**
- `bun test` -- expected: exit 0
- `bun --bun oxlint` -- expected: exit 0
- `bun --bun tsc` -- expected: exit 0

## Auto Run Result

Status: done

**Summary:** `createCiStep(deps)` takes a unit's open PR through CI after the PR step. Each round runs these steps:
1. Takes one fresh snapshot and re-checks config and the Standing Authority on it. A failure stops the lane.
2. Merges `main` into a conflicting PR in `runner.git` through the `Merger` port.
   - Status YAML conflicts keep `main`'s lines and re-apply the PR's own entries.
   - Lockfile conflicts are regenerated with `lockfile_command` in the sandbox.
   - Any other conflict goes to a builder session counted as a CI fix.
3. Pushes a merge with a lease, records the new head and posts a 🤖 comment.
4. Polls the head's checks by hand: 30 s backing off to 5 min, an empty reply pending, expected failures ignored, and a stop at the first unexpected failure.
5. On an unexpected failure, prefetches the CI log and runs a `ci-fix` session at `head_sha` (`ci_fixes` + 1). The PR step pushes the fix.

The unit parks blocked `ci-fix-cap` once `ci_fixes` reaches 2 and another session is needed, and `ci-timeout` past `ci_max_wait_minutes`. `runLaneProcess` calls an optional `LaneDeps.ciStep` and provides the `session` and `regenerate` callbacks from its own session machinery.

**Files changed:**
- `src/core/ci/checks.ts`: `classifyChecks` and `pollDelayMs`.
- `src/core/ci/status-merge.ts`: `mergeStatusYaml` and `isLockfile`.
- `src/lane/merger.ts`: the `Merger` port and `createGitMerger`, a `merge-tree` merge in `runner.git`.
- `src/lane/ci-step.ts`: `createCiStep` and the log and comment text helpers.
- `src/lane/lane-process.ts`: a shared session helper, the `ci-fix` session, `regenerate`, `LaneDeps.ciStep` and `PrStepInput.kind`.
- `src/lane/pr-step.ts`: `kind: "fix"` skips `updatePr`.
- Tests:
  - `test/core/ci/checks.test.ts` and `test/core/ci/status-merge.test.ts`
  - `test/lane/merger.test.ts` (real git)
  - `test/lane/ci-step.test.ts`: every matrix row, plus end-to-end `runLaneProcess` cases
  - one new case in `test/lane/pr-step.test.ts`

**Review findings:** 26 findings: 4 medium, 18 low, 4 false.
- **Patched:**
  - 1 medium entry: lockfiles that silently took `main`'s blob in a conflict session, and the false "conflict markers" wording. `needs-session` now reports them, and the session's log says to regenerate them.
  - 3 low entries, each a new end-to-end test: the budget passing during the CI step releases the unit; a non-zero exit from the lockfile command is refused; and each session prepares the clone at its own start.
- **Deferred:** 1 medium. A merge push followed by a failed record heartbeat leaves `head_sha` stale. This has the same root as Story 1.16a's deferred gap.
- **Rejected:** the rest, each with its reason in the Review Triage Log.

**Follow-up review recommended:** false. One medium entry and three low entries were patched, and none was high.

**Verification:**
- `bun install`: no changes.
- `bun test`: 2176 pass, 61 skip, 0 fail.
- `bun --bun oxlint` and `bun --bun tsc`: both exit 0.
- Every matrix row has a test that ran and passed.

**Residual risks:**
- Nothing in production calls the step yet: the launcher (Story 1.19) must wire `createCiStep` and `createGitMerger`.
- Fix sessions build their prompt from the claim-time snapshot.
- A fix rebuilt onto a `main` that moved and conflicts is a failed attempt.
- The budget end-to-end test uses a 1.8 s budget, so it could become timing-sensitive on a very slow machine.
