---
title: 'Story 2.5a: Resuming a blocked Story'
type: 'feature'
created: '2026-10-24'
baseline_revision: '46a1b85d53ce9a30c8d49258dc9f18ee9d918cb6'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
warnings: ['oversized', 'multiple-goals']
deferred:
  - summary: >-
      Committed file contents are never scanned for credentials, so a credential an agent writes into a file (a spec, fixture or log) reaches the PR and, through the merge, main.
    evidence: |-
      commitSession redacts only the commit message, and the PR step redacts only the PR title, body and comment. The squash pushes agent-written blobs unscanned, as it has since Story 1.15. A refusal class that scans blobs is a new write-check rule and needs a Maintainer decision.
    location: >-
      src/lane/commit.ts:commitSession
    severity: medium
  - summary: >-
      Closing orphan or superseded reconcile PRs leaves their xarabot/reconcile-<n> branches on the forge.
    evidence: |-
      closeBranchPrs and Story 2.5's closes close PRs but never delete branches, and the Forge port has no branch-delete operation. This dates from Story 2.5.
    location: >-
      src/lane/reconcile-step.ts:closeBranchPrs
    severity: low
---

<intent-contract>

## Intent

**Problem:** A Story that parked `blocked` cannot be re-run. On the re-run, `bmad-build-auto` writes a second spec file next to the `blocked` one, and the lane fails on "2 files match" (F2). Four other gaps remain:
- The prompt's `summary`/`body` wording produces session notes, not change descriptions.
- The sanitizer neither redacts credentials nor caps text length.
- The write check's case folding misses `ſ`.
- Four small review findings from PRs #59, #61 and #65 are still open.

**Approach:** The runner picks the spec file by status, drops superseded matches from the squash, and journals the wip ref at a blocked park. The template wording, the sanitizer, the write check, `lane run`'s role check and `reconcile`'s orphan-PR handling each get their fixes.

## Boundaries & Constraints

**Always:**
- **Spec pick** (pure, `src/core/lane/build-check.ts`). The matches are the clone's files matching `story_spec_path`; a match's status is its frontmatter `status`, and a file that cannot be read or parsed has none.
  - **`done` or `no-op` result:** exactly one match must be `done`, and every other match must be `blocked`. That one is the spec file, the others are `superseded`, and anything else is `invalid`, a failed attempt. `checkBuildSpec` then runs on the spec file.
  - **`blocked` result:** with exactly one match, `checkBuildSpec` runs on it, and a miss is a failed attempt. With 0 or 2+ matches there is no cross-check and no failure. Either way, the unit then parks `blocked` with its `blocked.kind`.
- **Superseded matches are dropped from the squash.** Under builder rules, `commitSession` sets each one back to `baseSha`'s version (or removes it), as it does for the Epic context file, before the write check runs. CI-fix sessions pick the same way. Their `blocked`/`no-op` results park as today, so a fix needs a spec file only for `done`.
- **Wip ref.** When a unit run ends with the record parked with `park.kind` `blocked` after at least one session, the unit log gets a line naming `refs/wip/<unit-file-id>` (`wipRef`), and the journal unit record gets a new optional field, `wip_ref`. The wip is never pushed. The run after a release claims at `generation` + 1, so the clone starts fresh from `main` and the old wip is not resumed.
- **`RESULT_FIELDS` wording** (exact):
  - `summary`: "one line saying what the change does (it becomes the commit title)".
  - `body`: "a description of the change for a reviewer: never this session, the runner, the working tree or how the skill ran".
- **Sanitizer:** `sanitizeAgentText(text, opts?)` with `secrets` and `max`.
  - `secrets`: every non-empty trimmed secret is replaced by `[REDACTED]`.
  - Token-shaped strings are always redacted: `sk-…` (Anthropic and OpenAI), `gh[pousr]_…`, `github_pat_…`, `AKIA…`, `xox[abprs]-…`, a JWT (`eyJ….eyJ….…`) and a PEM private-key block.
  - `max` caps the length in UTF-16 code units, never splitting a surrogate pair. Text over `max` is cut and ends with the marker `\n\n[truncated by xarabot]`, and the result is at most `max` long.
  - Limits (`FORGE_TEXT_LIMITS`): title 256, body and comment 65,536.
  - Redaction runs before the other rules, on the whole text.
- **Where the sanitizer runs:**
  - The PR step redacts the lane's credential (new `PrStepDeps.secrets`, default `[]`) in the commit message, the PR title and body, and the status comment. Title and body are capped.
  - Every forge comment builder caps its text: the status comment, the CI merge comment, the gate comment, and the reconcile PR body.
  - `lane run` passes the vendor credential it already reads at start (`readCredential`) as `secrets`.
- **`fold`** = `s.toUpperCase().toLowerCase()`, everywhere `write-check.ts` folds (both roles, `epicContextMatch`).
- **Agent config list:** `AGENT_CONFIG_PATHS` gains `**/AGENTS.override.md` and `**/CLAUDE.local.md`, so `MANDATORY_PROTECTED_PATHS` and `effective_protected_paths` include them.
- **Coordinator mode rule:** `WriteChange` gains `mode` (the new side's git mode, `000000` when deleted). Under coordinator rules, a status file or graph input whose `mode` is not `100644` is refused as the new last class, `mode`, and a missing `mode` is refused too. `commitSession` passes the mode for every change.
- **`lane run`:** a failed role and lane-name check prints its reason and exits 1. It does not count as a failed start, writes no `STOP` and posts no alert, like the other static `host.yaml` errors.
- **`reconcile`, orphan PRs:** before acting on each `releaseDead` or `deleteReleased` target, the step:
  1. lists `listPrsByBranch(reconcileBranch(branches.xarabot, unit))`;
  2. closes every open PR on it with a fenced `prChange`, plus the record's own PR if the snapshot shows it open and the list missed it;
  3. on a listing failure or a failed close, leaves the target for a later run.
- **`reconcile`, open PRs:** the plan lists every other `reconcile` record with an open PR (`openPrs`). After the ledger work, the step leaves out the units whose PR it closed or whose record it released or deleted. Only what remains stops a new PR.

**Never:**
- No ledger schema change, no new forge operation, no `.github/` change, no `.xarabot/` change, no `AGENTS.md` change.
- No `xarabot rule` or lane-stop exits (2.5b), no `TMPPREFIX` (2.5c).
- No new wip saving: the ref is still written when the lane next rebuilds its clone.
- No other `toLowerCase` call site changes (`approval.ts`, `globs.ts`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Re-run done | matches: A `blocked` (on main), B `done` | B is the spec; A dropped from the squash; write check passes | none |
| Two done | outcome `done`, two `done` matches | invalid | failed attempt |
| No done | outcome `done`, 0 matches, or one `blocked` | invalid | failed attempt |
| Other status | outcome `done`, `done` + `draft` | invalid | failed attempt |
| Blocked, 0 / 2 matches | outcome `blocked` `intent-gap` | parks `blocked` `intent-gap`, no cross-check | none |
| Blocked, 1 match | outcome `blocked`, spec `blocked` / `done` | parks / invalid | failed attempt on miss |
| Blocked park | session ran, parked `blocked` | log and journal `wip_ref` `refs/wip/story__2.5a` | none |
| Credential in body | body holds the seeded token | `[REDACTED]` in PR body, commit, comment | none |
| Huge body | body 70,000 chars | PR body ≤ 65,536, ends with marker | none |
| Fold | builder `.mcp.jſon`, `pkg/AGENTſ.md` | refused `agent-config` | none |
| Mode | coordinator status file `100755` / `120000` / `160000` / `000000` | refused `mode` | none |
| Role check | builder lane named `coordinator` | exit 1, failed starts unchanged | no STOP, no alert |
| Orphan reconcile PR | `reconcile:3` released, record `pr` null, PR open on its branch | PR closed, record deleted | list fails: target left |
| Just-closed PR | `reconcile:3` merging, ejected, closed and released; status change due | run opens its own PR | none |

</intent-contract>

## Code Map

- `src/core/lane/build-check.ts` -- `specMatches`, `expectedSpecStatus`, `checkBuildSpec`; add a pure `pickSpec(outcome, matches: {path, text | null}[])`, reading status via `splitFrontmatter`/`parseYaml` as `checkBuildSpec` does.
- `src/lane/lane-process.ts`:
  - `sessionAt` (~l.782): the match-count failure at l.811 becomes `pickSpec`; read each match with `readRegular` (`null` on error); `Ran` carries `specPath: string | null`, `specText` and `superseded`.
  - `build` (~l.886): route on the pick; a `blocked` park with no spec skips `checkBuildSpec`.
  - `ciSession` (~l.826).
  - `PrStepInput` (~l.88): add `superseded: readonly string[]`.
  - `journalUnit`/`JournalEntry` (~l.446): the end-of-run journal call is near l.1249; add `wip_ref` there plus the log note.
- `src/lane/ci-step.ts` -- `CiSessionDone` (~l.36) gains `superseded`, and `specPath` becomes `string | null`. `session` (~l.340) passes both to `prStep`, and a `done` with a `null` spec fails.
- `src/lane/pr-step.ts`:
  - `writeRules(...)` (~l.234): pass `superseded`.
  - The commit message (~l.248) and `prText`/`statusComment` (~l.41-64) use secrets and caps.
  - The reverted-path note (~l.259) names "superseded spec" or "Epic context".
  - `PrStepDeps.secrets`.
- `src/core/lane/write-check.ts` -- `fold` (l.111); `WriteRules.superseded`; `WriteChange.mode`; `COORDINATOR_WRITE_CLASSES` + `mode`; `checkCoordinatorWrite` (l.212).
- `src/lane/commit.ts` -- `contextChanges` (l.150) also takes exact `rules.superseded` paths; `writeChanges` (l.99) sets `mode: c.newMode`.
- `src/core/config/protected-paths.ts` -- `AGENT_CONFIG_PATHS`.
- `src/core/sanitize.ts` -- `sanitizeAgentText`; add `FORGE_TEXT_LIMITS`. The callers are in `ci-step.ts` (l.143), `merge-step.ts` (l.76 `gateComment`), `reconcile-step.ts` (l.90 `reconcilePrText`), `commit.ts`, `pr-step.ts` and `reconcile-commit.ts`.
- `src/core/prompt/template.ts` -- `RESULT_FIELDS` (l.42).
- `src/core/schemas/journal.ts` -- `UnitJournalRecordSchema` gains `wip_ref: NonEmpty.optional()`.
- `src/lane/clone.ts` -- `wipRef`, `unitFileId` (reuse; read only).
- `src/cli/lane-run.ts` -- the role check (l.172): `say` + `return 1`; `credential.value` (l.231) goes into `createPrStep({ ..., secrets: [credential.value] })` (l.286).
- `src/core/reconcile/plan.ts` -- `openPr` → `openPrs` (l.144); `src/lane/reconcile-step.ts`:
  - `ledgerWork` (l.331) returns the settled units;
  - `closeIfOpen` becomes a branch-listing close for `releaseDead`/`deleteReleased`;
  - `steps` (l.520) picks the first open PR not settled.
- `docs/maintainer/self-host.md` ~l.508 -- the wip section: the journal's `wip_ref`; the ref is written when the lane next rebuilds its clone, until then the work is in the lane's `clone/`.
- Tests:
  - `test/core/lane/build-check.test.ts`, `test/core/lane/write-check.test.ts` (the `AGENT_CONFIG_PATHS` row at l.361; coordinator section l.421+);
  - `test/core/sanitize.test.ts`, `test/core/prompt/*`, `test/core/reconcile/plan.test.ts` (l.53 `openPr`);
  - `test/lane/{commit,lane-process,pr-step,ci-step,reconcile-step}.test.ts`, `test/cli/lane-run.test.ts` (l.409 role rows), `test/core/schemas/*journal*`.
- Baseline at `46a1b85` (after `bun install`): 2918 pass, 73 fail, 162 skip. All 73 failures are sandbox-only; compare them by name against `tmp/baseline-fails.txt`.

## Tasks & Acceptance

**Execution:**
- `src/core/lane/build-check.ts` -- `pickSpec` and its result type -- the status rule (AR11, AR15).
- `src/lane/lane-process.ts`, `src/lane/ci-step.ts`, `src/lane/pr-step.ts` -- route on the pick; `superseded` through to the rules; the wip note and `wip_ref`; secrets and caps in PR text.
- `src/core/lane/write-check.ts`, `src/lane/commit.ts` -- `fold`, `superseded` reverts, `mode` and its class.
- `src/core/config/protected-paths.ts` -- the two agent config paths.
- `src/core/sanitize.ts` + callers -- redaction and caps.
- `src/core/prompt/template.ts` -- the wording.
- `src/core/schemas/journal.ts` -- `wip_ref`.
- `src/cli/lane-run.ts` -- the uncounted role check; `secrets`.
- `src/core/reconcile/plan.ts`, `src/lane/reconcile-step.ts` -- orphan closing and `openPrs`.
- `docs/maintainer/self-host.md` -- the wip note.
- Tests:
  - a `pickSpec` case table with 0, 1 and 2 matches for each outcome (`done`, `no-op`, `blocked`), plus a `done` + `draft` row and an unreadable-match row;
  - a commit test with real git: a superseded spec is dropped and the Epic context file is reverted;
  - lane-process rows:
    - re-run `done` with a `blocked` + `done` pair reaches the PR step with `superseded`;
    - `blocked` with 0 or 2 matches parks;
    - the journal `wip_ref` and the log line;
    - the re-claim after a release prepares at `main` with `generation` + 1;
  - a template wording test;
  - sanitizer rows: one per credential form, a seeded secret, the caps and the surrogate edge;
  - fold rows with `ſ`/`K` for each refused class, both roles;
  - two agent config rows and the list assertion;
  - mode rows for `100755`, `120000`, `160000` and `000000`, a `100644` pass row, and a graph-input row;
  - the lane-run role rows changed to "not counted";
  - reconcile-step rows: an orphan PR found by branch listing for each target kind, a listing failure leaves the target, and a just-closed PR does not stop a new PR.

**Acceptance Criteria:**
- Given a re-run of a Story whose `blocked` spec is on `main`, when the session returns `done` with a new `done` spec, then the PR's commit holds the new spec and no change to the `blocked` one, and the write check passes.
- Given a `blocked` result, when the unit parks, then the journal line's `wip_ref` is `refs/wip/<unit-file-id>`, and no push of that ref ever happens.
- Given `bun test`, when it runs, then no failure falls outside the baseline's sandbox-only set, and `bun --bun oxlint` and `bun --bun tsc` exit 0.

## Spec Change Log

## Review Triage Log

### 2026-10-24 — Review pass
- verdicts: 37 findings (blind 8 split into two claims) — high 0, medium 2, low 27, false 8, maybe-false 0 (pre-verified verification gaps counted as low)
- findings:
  - `[low]` `[patch]` (verification-gap 1) The lane's real `ciSession` spec pick is never run through a `done` CI fix with a `blocked` + `done` pair, and no CI-fix `blocked` 0-match row exists. -- Pre-verified. Added both rows to `test/lane/lane-process.test.ts`.
  - `[low]` `[patch]` (verification-gap 2) No `wip_ref` test for a write-check park. -- Pre-verified. Added a lane-process row where the PR step parks `blocked` `write-check`.
  - `[low]` `[patch]` (verification-gap 3) The `lane run` wiring `secrets: [credential.value]` is untested. -- Pre-verified. Routed as a patch, but not added: `lane run` builds the real git committer over its own `runner.git`, and the fake forge's SHAs are not git objects, so a commit cannot reach the forge without an injectable committer in `LaneRunDeps`, which is new production surface. Each link it relies on is tested (the PR step passes `secrets` to the commit, title, body and comment, and the committer passes them to `commitSession`). Listed as a residual risk.
  - `[low]` `[patch]` (verification-gap 4) `createGitCommitter` forwarding `secrets` is untested. -- Pre-verified. Added a `test/lane/committer.test.ts` row.
  - `[low]` `[patch]` (verification-gap other) `statusComment` collapses whitespace in a denied action before redacting, so a secret containing whitespace no longer matches. -- Confirmed at `pr-step.ts` `statusComment`. Secrets are now redacted before the collapse, with a test row.
  - `[false]` `[reject]` (intent 1) A `blocked` result with one non-`blocked` or unreadable match is a failed attempt, not a park. -- AR15: the cross-check runs on exactly one match, and "still missing or invalid → failed attempt". The AC's "parks whatever the matches" covers the match count, not a cross-check miss.
  - `[false]` `[reject]` (intent 2) A CI-fix `blocked` result gets no cross-check even with one match. -- CI-fix sessions never had a status cross-check (`ciSession`, Story 1.17), and AR15's cross-check is the build's.
  - `[low]` `[reject]` (intent 3) The journal names the wip ref before it exists. -- Decision 6 ("keep it as is") and the Design Notes. The doc and the log line say the ref is written at the next clone rebuild.
  - `[low]` `[patch]` (intent 4) "Never pushed" is not checked by the tests. -- Same root as blind 5; fixed there.
  - `[low]` `[reject]` (intent 5) The re-claim row starts from a seeded `released` record, not a park → release → re-run. -- The release is the Maintainer's (2.5b's `xarabot rule release`). The generation + 1 fresh-from-`main` path is what the row covers.
  - `[low]` `[reject]` (intent 6) No single test runs lane-process → real PR step → real committer on a re-run. -- Every link is covered: `pickSpec`, lane-process → PR step input, PR step → rules, and real-git `commitSession` with the revert and the write check. An end-to-end harness is new test infrastructure.
  - `[false]` `[reject]` (intent 7) The merge comment, gate comment and reconcile text get no credential redaction. -- They carry no agent `summary`/`body` text, only runner text and git paths. AR16 scopes the credential to agent text.
  - `[false]` `[reject]` (intent 8) Caps equal GitHub's limits rather than staying below them, and the commit message is not capped. -- The AC defines the cap as "a `body` over 65,536 characters is truncated". A commit message is not forge text.
  - `[false]` `[reject]` (intent 9) `openPrs` is filtered in the step and "settled" is broader than the AC; an existing test changed to opening a PR. -- Units are settled only when their PR is closed or not open, so none still has an open PR. The behaviour change is the 2.5a AC's purpose (proposal review finding "a run that just closed a PR still reports it open").
  - `[low]` `[reject]` (intent 10) The mode rule refuses a deletion and a missing mode. -- Fail-closed, recorded in the Design Notes; no coordinator unit deletes a status file.
  - `[low]` `[reject]` (intent 11) The diff edits `epic-2-context.md`. -- Stock step-01 recompiled it because `epics.md` changed after it. The runner reverts a builder's change to it before the squash, as in Stories 2.4 and 2.5.
  - `[false]` `[reject]` (intent 12) The new spec is a `story_spec_path` match left `in-review`. -- That was a snapshot taken mid-review. Finalize sets `status: done`, so it is the single `done` match.
  - `[low]` `[reject]` (intent 13) `no-op` follows `done`'s rule, which no AC names. -- `bmad-build-auto` never writes `no-op`, and `expectedSpecStatus` already maps it to `done`. Recorded in the Design Notes.
  - `[medium]` `[patch]` (edge 1) `closeBranchPrs` marks a unit settled after its first successful close. If a later close fails, its open PR no longer stops a new PR, and two reconcile PRs end up open. -- Confirmed. The unit is now settled only after every close for that target succeeded, with a test row.
  - `[low]` `[patch]` (edge 2) A blocked park on a clean clone names a wip ref `saveWip` never writes, or one holding an older wip. -- Confirmed (`saveWip` keeps the earlier wip on a clean clone). The log line and the doc now say "if the session changed any file".
  - `[low]` `[reject]` (edge 3) A re-run that deletes or renames `main`'s `blocked` spec deletes it in the squash. -- `bmad-build-auto` writes a new `-2` spec and never deletes the old one. The fix needs base-side glob matching in `commitSession`.
  - `[low]` `[reject]` (edge 4) A capped title holds the `\n\n` marker. -- Titles are `Story <id>: <manifest title>` and `reconcile:<n>: …`, far below 256. A title-specific marker adds a parameter.
  - `[low]` `[reject]` (edge 5) `capText` with a `max` below the marker's length returns a marker fragment. -- Only 256 and 65,536 are used. The result still holds its "at most `max`" contract.
  - `[low]` `[patch]` (blind 1) The wip line can name work that was never saved. -- Same root as edge 2; fixed there.
  - `[low]` `[reject]` (blind 2) The truncation marker puts newlines into titles. -- Same claim as edge 4; rejected there.
  - `[medium]` `[defer]` (blind 3) Committed file contents are never scanned for credentials, so a credential an agent writes into a file reaches `main`. -- Real, and not caused by this Story: the squash has never scanned blobs. A new write-check class is a Maintainer decision. Deferred.
  - `[false]` `[reject]` (blind 4) Opening a PR in the run that closed an ejected one contradicts "the next due run opens a fresh PR". -- The 2.5a AC, accepted by the Maintainer on 2026-10-24 after the 2.5 text, requires that a run that just closed a PR not report it open; `openPr`'s only effect is to stop a new PR. The Story 2.5 wording still holds when the closing run has no status change.
  - `[low]` `[patch]` (blind 5) The "nothing is pushed" assertion is vacuous. -- Confirmed. The wip test now asserts that the fake forge recorded no push.
  - `[low]` `[reject]` (blind 6) Kelvin coverage is thin, and `toUpperCase().toLowerCase()` is not exact APFS folding. -- The AC prescribes this exact fold, and an `ſ` row exists for every refused class in both roles. Over-folding only widens refusals.
  - `[low]` `[patch]` (blind 7) The `lane run` secrets wiring is untested. -- Same root as verification-gap 3.
  - `[low]` `[reject]` (blind 8a) Whole-file credential matching fails for multi-field credential files. -- Only `claude` has an adapter, and its `oauth-token` file holds one token. Epic 3's adapters bring their own credential forms.
  - `[low]` `[patch]` (blind 8b) `statusComment` collapses whitespace before redaction. -- Same root as the verification-gap "other" finding; fixed there.
  - `[false]` `[reject]` (blind 9) A `blocked` spec created in the same session is silently dropped. -- AR11 and the AC: every match other than the `done` one must be `blocked`, is superseded, and is dropped from the squash, wherever it came from.
  - `[low]` `[reject]` (blind 10) On a re-run, the `blocked` cross-check is inert. -- Decision 5 runs the cross-check only on one match, and the unit parks `blocked` either way. Excluding unchanged base files is new matching logic.
  - `[low]` `[patch]` (blind 11) The token shapes miss `npm_`, `glpat-`, `AIza` and `sk_live_`/`rk_live_`. -- A direct addition: one pattern and one test row per form.
  - `[low]` `[reject]` (blind 12) The Code Map lists `reconcile-commit.ts` as a sanitizer caller, but the diff does not touch it. -- `reconcile-commit.ts` only commits runner-written text. The fix would edit this spec.
  - `[low]` `[defer]` (blind 13) Closing orphan reconcile PRs leaves their branches. -- Not caused by this Story: Story 2.5 never deleted reconcile branches, and branch deletion is no forge operation today. Deferred.

## Design Notes

- **`no-op`** follows `done`'s rule, because `expectedSpecStatus` already maps it to a `done` spec. `bmad-build-auto` never writes `no-op`.
- **A deleted status file** has no mode, so it fails "must be `100644`" and is refused. No coordinator unit deletes one, so failing closed costs nothing.
- **Seeded credential.** The token shapes catch the Claude OAuth form, and redacting the exact credential also catches a credential of any shape. The lane already reads it at start, so no new file access is added.
- **Wip timing.** `saveWip` runs inside `rebuildClone`, so the ref appears at the lane's next clone rebuild. The journal names the ref the work will be saved under, which is how decision 6 ("keep it as is") reads.

## Verification

**Commands:**
- `bun test` -- expected: at most 73 failures, every one in `tmp/baseline-fails.txt` by name.
- `bun test test/core test/lane test/cli` -- expected: every failure is in the baseline set.
- `bun --bun oxlint` -- expected: exit 0.
- `bun --bun tsc` -- expected: exit 0.

## Auto Run Result

Status: done

**Summary.** Story 2.5a is complete.
- **Spec pick by status.** The runner picks the spec file by status (`pickSpec`).
  - A `done` (or `no-op`) result needs exactly one `done` match, and every other match must be `blocked`. Those are superseded and dropped from the squash, as the Epic context file is reverted. Anything else is a failed attempt.
  - A `blocked` result parks with its `blocked.kind` whatever the matches. The cross-check runs only on exactly one match.
  - CI-fix sessions pick the same way, for a `done` fix only.
- **Wip ref.** A run that ends parked `blocked` after a session names its host-only wip ref, `refs/wip/<unit-file-id>`, in the unit log and in the journal's new optional `wip_ref` field. The re-run after a release claims at `generation` + 1 and starts fresh from `main`.
- **Prompt.** The template's `summary`/`body` wording describes the change, never the session.
- **Sanitizer.** It redacts the lane's vendor credential (passed by `lane run`) and token-shaped strings: Anthropic and OpenAI `sk-`, GitHub, AWS, Slack, JWT, PEM, npm, GitLab, Google and Stripe live keys. It caps forge text: a 256 title, and a 65,536 body or comment, ending with a marker.
- **Write check.**
  - It folds paths fully (`toUpperCase().toLowerCase()`), so `.mcp.jſon` and `pkg/AGENTſ.md` are refused.
  - The agent config list adds `**/AGENTS.override.md` and `**/CLAUDE.local.md`.
  - Coordinator rules refuse a status file or graph input whose mode is not `100644`.
- **`lane run`.** Its role and lane-name check is no longer counted as a failed start.
- **`reconcile`.**
  - Before releasing or deleting a dead or released record, it closes every open PR on that record's branch, found with `listPrsByBranch`.
  - PRs the ledger work closed, or records it released or deleted, no longer stop the run's own PR.

**Files changed (baseline `46a1b85d53ce9a30c8d49258dc9f18ee9d918cb6` → working tree):**
- `src/core/lane/build-check.ts` -- `pickSpec`, `specStatus`, `SpecMatch`/`SpecPick`.
- `src/lane/lane-process.ts` -- the session routes on the pick; `superseded` reaches the PR step; the wip log line and `wip_ref`.
- `src/lane/ci-step.ts` -- `CiSessionDone.specPath` nullable plus `superseded`; a `done` fix with no spec fails; the merge comment is capped.
- `src/lane/pr-step.ts` -- `PrStepDeps.secrets`; redaction and caps in the PR title, body, status comment and commit message; the reverted-path note.
- `src/lane/commit.ts`, `src/lane/committer.ts` -- superseded specs reverted under builder rules; each change's mode; message `secrets`.
- `src/core/lane/write-check.ts` -- full `fold`, `WriteRules.superseded`, `WriteChange.mode`, the coordinator class `mode`.
- `src/core/config/protected-paths.ts` -- the two agent config paths.
- `src/core/sanitize.ts` -- `redactSecrets`, `capText`, `FORGE_TEXT_LIMITS`, the token shapes; `sanitizeAgentText(text, { secrets, max })`.
- `src/core/prompt/template.ts` -- the `RESULT_FIELDS` wording.
- `src/core/schemas/journal.ts` -- the optional `wip_ref`.
- `src/cli/lane-run.ts` -- the role check not counted; `secrets: [credential.value]` for the PR step.
- `src/core/reconcile/plan.ts`, `src/lane/reconcile-step.ts` -- `openPrs`; branch-listing orphan closes; settled units; capped reconcile PR text.
- `src/lane/merge-step.ts` -- the gate comment is capped.
- `docs/maintainer/self-host.md` -- the wip paragraph: `wip_ref`, when the ref is written, and a clean session saving nothing.
- Tests: rows in `test/core/lane/{build-check,write-check}.test.ts`, `test/core/{sanitize,config/protected-paths,prompt/build-prompt,reconcile/plan,schemas/journal}.test.ts`, `test/lane/{commit,committer,lane-process,pr-step,ci-step,merge-step,reconcile-step}.test.ts`, `test/cli/lane-run.test.ts`.
- `_bmad-output/implementation-artifacts/epic-2-context.md` -- recompiled by step-01, because `epics.md` and the spine changed after it. The runner reverts a builder's change to it before the squash.

**Review findings.** 37 findings: high 0, medium 2, low 27, false 8, maybe-false 0.
- **Patched (9 entries):**
  - 1 at medium: `closeBranchPrs` marked a unit settled before every close succeeded.
  - 8 at low:
    - the wip line's wording on a clean clone;
    - the whitespace collapse before redaction in `statusComment`;
    - four more token forms;
    - tests for the real `ciSession` pick through the CI step, the write-check park's `wip_ref`, `createGitCommitter` passing `secrets` on, and an assertion that nothing is pushed.

  The `lane run` secrets wiring test was routed as a patch but not added. It needs an injectable committer in `LaneRunDeps`, which is new production surface.
- **Deferred (2):**
  - Committed file contents are not scanned for credentials (medium, from before this Story; needs a Maintainer decision on a new write-check class).
  - Closed reconcile PRs leave their branches (low, from before this Story).
- **Rejected (26: 18 low, 8 false).** Each reason is in the Review Triage Log. The most notable:
  - **The run that closes an ejected reconcile PR now opens its own PR when a status change is due.** Story 2.5's wording has the next run do it, but 2.5a's AC asks that a just-closed PR not count as open.
  - **A `blocked` result with one mismatched spec is a failed attempt**, per AR15's cross-check.
  - **A superseded `blocked` spec is dropped wherever it came from**, per AR11.

**Follow-up review recommended: false.** This pass patched one medium entry and no high one.

**Verification:**
- **Baseline** at `46a1b85`, after `bun install --frozen-lockfile` (the fresh clone had no `node_modules`): `bun test` gave 2918 pass, 73 fail, 162 skip. All 73 failures are sandbox-only (loopback listen, `ps`/`kill`).
- **After the implementation:** 3033 pass, 73 fail, 162 skip. **After the review patches:** 3043 pass, 73 fail, 162 skip. Both times the failures match the baseline by name, with none new and none fixed.
- **Lint and types:** `bun --bun oxlint` exit 0 and `bun --bun tsc` exit 0, both before and after the patches.
- **Matrix audit:** every I/O row has a covering test that ran and passed. The coverage is in:
  - the `pickSpec` table;
  - the lane-process re-run, blocked and `wip_ref` rows;
  - the real-git commit tests;
  - the sanitizer and PR-step rows;
  - the write-check fold and mode rows;
  - the lane-run role rows;
  - the reconcile-step orphan and just-closed rows.

**Residual risks:**
- **No `lane run` test for the credential.** Nothing checks that `lane run` passes the credential to the PR step. Each link after it is tested.
- **Uncommitted changes.** The changes are left uncommitted in the working tree, as the lane runner's rules require, and the runner makes the commit. This deliberately departs from this workflow's commit and clean-tree steps.
- **No effect until the runner advances.** The fixes take effect only after the Maintainer advances `runner_version` past 2.5c, per the self-host runbook.
