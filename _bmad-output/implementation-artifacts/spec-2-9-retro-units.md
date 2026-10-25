---
title: 'Story 2.9: Retro units'
type: 'feature'
created: '2026-10-25'
baseline_revision: '08c3f89e2ebf99cf4738bad8b20b8e23de3eabb5'
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

**Problem:** The coordinator never runs an Epic's retrospective (FR10, AR13, AR15, AR30). `next` has no retro position and there is no retro step. Nothing records a verdict or items in `retro-gates.yaml`, so no non-bootstrapped Epic's dependents can ever start.

**Approach:**
- `next(snapshot, 'coordinator')` gains the retro position (AD-13, step 4). It is due once an Epic's Stories are all `done`, it has no verdict, and its live evidence file is on `main`.
- A new retro step:
  - prefetches the Epic's PRs into the session's temp folder;
  - runs `bmad-retrospective -H <epic>` through the shared session runner;
  - validates the `retro` result against the committed diff;
  - opens the PR like a status planning unit, and stores the result in the record's new `retro_result` (ledger schema 4).
- The next `reconcile` writes the verdict and items to `retro-gates.yaml` once.
- The write check gains live evidence files (builder) and the retro-record fields (coordinator).

## Boundaries & Constraints

**Always:**
- **Config.** `live_evidence_glob` is a `patternWith("<N>")` key, default `docs/maintainer/evidence/epic-<N>.md`.
  - The snapshot gains `live_evidence: Record<EpicKey, boolean>` for each graph Epic: `true` when some `main` tree path matches the glob with `<N>` set to that Epic.
- **Retro position**, after planning: Epics in ascending order.
  - Skip an Epic in `bootstrapped_epics`, an Epic with a `retro_gates` `retro` entry, and an Epic with no Story, an unmanifested heading, or a Story not `done`.
  - Evidence absent: a reason with code `live-evidence` naming the file (the glob with `<N>` set). The unit is not due.
  - The `retro:<N>` record:
    - none: claim it new;
    - `released`: re-claim at its generation (an open PR is the open-PR position's);
    - stale `claimed` with no open PR: take it over;
    - otherwise it holds (`record-state` reason).
  - Globs come from `coordinatorGlobs({kind:"retro"})`. An overlap with any held glob passes the Epic over (`overlap`).
  - An idle outcome with any `live-evidence` reason starts its `reason` with `waiting-on-maintainer: ` followed by those reasons' messages.
- **Retro step** (`src/lane/retro-step.ts`, `steps.retro` in `lane-run`):
  - **An adopted PR** (`record.pr` set) runs no session. Without a `retro_result` it is a failed attempt; with one, it goes to CI and the gate.
  - **Prefetch.**
    - For each Story id of the Epic, in graph order, `listPrsByBranch(<branches.story><id>)`, then `reviews(pr)` for each PR.
    - The data is written after `prepare`, from the prompt callback, as `<tmp>/epic-<N>-prs.json`, checked against an `EpicPrsSchema` (`src/core/schemas/epic-prs.ts`).
    - Each PR carries `story`, `number`, `title`, `body`, `state`, `head_sha`, `merge_sha` and `reviews[]` {`author`, `state`, `submitted_at`, `commit_sha`}.
    - Any forge failure is a failed attempt.
  - **Prompt** (`buildRetroPrompt`, template parts `retro` and `result_retro`):
    - it names the unit, `bmad-retrospective -H <N>` and the prefetched file's absolute path;
    - it asks for each appended action item's `id`, `text`, `blocking`, `route` and `globs`;
    - the result schema is `RetroResultSchema`'s JSON Schema.
    - The retro parts contain no CI, push, queue, approval, claim, `next`, ledger, `sprint-status` or selection word.
  - **Validation.**
    - Before the commit, a result fails when:
      - an item id is not `epic-<N>-…`, or ids repeat;
      - a glob does not normalize;
      - a glob is refused (`refusedItemGlobs`).
    - After the commit and before any push, the step reads `onto` (fresh `main`) and the committed head through a new `TreeFiles` port. The result fails when:
      - its item ids differ, as a set, from the ids of the `action_items` entries in the head's `sprint_status_path` that `onto` lacks;
      - the files matching `retro_doc_glob` (with `<N>` set) that the commit adds or changes are not exactly one;
      - that file's frontmatter `verdict` differs from the result's.
    - Any failure is a failed attempt, with nothing pushed.
  - **Publish.** It works like `planning-step` for a status unit:
    - the coordinator write check, with a refusal parking `write-check`;
    - `branchHead` lease, push, `openPr`, then a `beat("record")` that also sets `retro_result`;
    - CI, with a failure parking `verification` and a timeout parking `ci-timeout`;
    - a fresh `main` re-check;
    - park `awaiting-approval` when `owner_approval_paths` or `effective_protected_paths` gate a diff path;
    - else fence `passed_sha`, `startMerging` and enqueue at the head.
    - An enqueue `conflict` parks `awaiting-approval` with the diff paths and a 🤖 comment. Retro PRs are never disposable, and they skip the graph-change gate, since their diff holds no graph input.
- **`refusedItemGlobs(globs, config, policy)`** (core): a glob is refused when it overlaps (`globsOverlap`) a refused glob that has a literal prefix. When the refused glob starts with a wildcard, the glob is refused when `Bun.Glob(refused)` matches its text, case-folded.
  - The refused globs are the graph inputs, the status files, `.xarabot/**`, the Standing Authority path, `.github/**`, `AGENT_CONFIG_PATHS`, `live_evidence_glob` with `<N>` as `*`, and the policy's `effective_protected_paths`.
- **Ledger v4.**
  - `LEDGER_SCHEMA_VERSION = 4`, and the reader accepts 1–4.
  - `retro_result` ({`verdict`, `items[]` as `RetroResultItemSchema`} or `null`; absent reads as `null`) is serialized after `approved_graph`.
  - `HeartbeatSetSchema` gains `retro_result`.
  - `claim` from `released` and a `claimed` `takeOverStale` keep it only when they adopt a PR, and clear it otherwise. `applyRuling rebuild` clears it.
- **`reconcile`.**
  - The plan adds `retroGates` (`none` | `edit` {`text`, `summary`} | `invalid` {`message`}). For each `retro:<N>` record `merged` as of the run, with a `retro_result` and no `retro_gates` `retro` entry for `<N>`, it sets `epics.<N>.retro` = {`verdict`, `unit`, `recorded_at`: snapshot `now`} and appends each item not already listed, with `status: open`.
  - An absent file starts from `{schema_version: 1, epics: {}}`. The text is serialized deterministically and must re-parse (`parseRetroGates`) to that value; otherwise the plan is `invalid`, and the run fails.
  - A merged retro record with no `retro_result` is logged and skipped.
  - The run's one PR carries the changed `sprint_status_path` and `retro_gates_path` texts (either or both). The protected-path gate covers both paths, and the PR text lists each file's changes.
- **Write check.**
  - **Builders:** the new class `live-evidence`, after `coordinator-file`. It matches the glob with `<N>` as `*`, case-folded. Infrastructure approval never excepts it.
  - **Coordinators:** rules gain `retroGatesPath`.
    - `commitSession` passes the before and after texts of that path (`null` when absent) as `retroGates`.
    - Parsing both sides, a change to an Epic's `retro` other than `go` is `retro-verdict`; to `items`, `retro-item`; to `retro.go`, `retro-go`; to `checkpoint`, `checkpoint-go`.
    - A side that does not parse, or missing texts, is `retro-gates-invalid`.
- **Forge.**
  - `ForgePr` gains `merge_sha: GitSha | null`, set only for a merged PR.
    - GitHub: `merge_commit_sha`.
    - Fake forge: the `main` SHA its `mergeQueueHead` makes.
    - Test emulator: `merge_commit_sha`.
  - The contract suite gains a scenario for it.

**Never:**
- No retro-item units (2.10).
- No `/xarabot go` or rulings.
- No change to `.github/`, `AGENTS.md`, `_bmad/`, the spec folder or the `runner_version` pin.
- No agent GitHub access.
- No mocks: stub ports and the fake forge only.
- No new park reason.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Due | Epic 2 all `done`, no verdict, evidence on `main` | `retro:2` (globs: status files, context, retro doc) | — |
| Story not done | 2.1 `backlog` | no retro; planning/idle as before | — |
| No evidence | all `done`, file absent | idle `waiting-on-maintainer: …docs/maintainer/evidence/epic-2.md…` | — |
| Bootstrapped | Epic 1 in `bootstrapped_epics`, all done | never `retro:1` | — |
| Recorded | `retro_gates` has `2.retro` | not due | — |
| Released | `retro:2` released, no PR | re-claim at its generation | — |
| Valid result | 2 appended items, doc `verdict: accepted` | PR opened; record `retro_result` set | — |
| Item mismatch | result lists 1 of 2 appended ids | failed attempt, nothing pushed | — |
| Verdict mismatch | doc `rejected`, result `accepted` | failed attempt | — |
| Bad globs | item glob `.github/**`, `stories/*.md`, `**` | failed attempt | — |
| Retro write | session edits `2.retro.verdict` in retro-gates | park `write-check` (`retro-verdict`) | — |
| Reconcile writes | `retro:2` merged with result; file absent | PR creates `retro-gates.yaml` `schema_version: 1`, verdict + items `open` | invalid text: failed |
| Rejected | result `rejected` | written like any other verdict; no `go` | — |
| Builder evidence | builder diff `docs/maintainer/evidence/epic-2.md` | refused `live-evidence` | — |
| Ledger versions | records at 1–4 | parse; writes stamp 4; `retro_result` null when absent | 0 and 5 stop |

</intent-contract>

## Code Map

- `src/core/next/coordinator.ts`: `nextCoordinator` (the retro position goes after `nextPlanning`, at line 431), `coordinatorGlobs` retro (already), `doneOnMain` retro (already `gates[N].retro`), and the `nextPlanning` overlap pattern. `src/core/next/next.ts`: `ReasonCode`. `src/core/next/epic-gates.ts`: the done-check idiom.
- `src/core/schemas/config.ts`: `CONFIG_DEFAULTS` and `ConfigSchema`. `src/core/schemas/snapshot.ts` and `src/core/next/snapshot.ts` (`assembleSnapshot`): `live_evidence`. Tests build snapshots through `assembleSnapshot` (`test/core/next/fixtures.ts`).
- `src/core/schemas/session-result.ts`: `RetroResultSchema` and `RetroResultItemSchema` exist. `src/core/schemas/retro-gates.ts`: `RetroGatesSchema` and `RETRO_ITEM_ID_PATTERN`. `src/core/graph/retro-gates.ts`: `parseRetroGates` and `emptyRetroGates`.
- `src/core/schemas/ledger.ts`: `LEDGER_SCHEMA_VERSION(S)` and `UnitRecordSchema`. `src/core/ledger/codec.ts:113`: `serializeUnitRecord`. `src/core/ledger/edits.ts`:
  - `fresh` (line 202), `HeartbeatSetSchema` (349), `claim` (254), `takeOverStale` (449) and `applyRuling` (723);
  - `park`: a coordinator `merging` record may park `awaiting-approval`;
  - `isDisposable` (792): retro is not disposable.
- `src/core/prompt/{template,build-prompt}.ts`: the parts, `PLACEHOLDERS`, `TemplateSchema` and `buildPlanningPrompt`, which is the model for `buildRetroPrompt`.
- `src/core/lane/write-check.ts`: `WRITE_CLASSES`, `classify`, `COORDINATOR_WRITE_CLASSES`, `checkCoordinatorWrite` and `epicContextMatch`. `src/lane/commit.ts:111`: `writeChanges`, which gives the before and after blobs; the `storyFile` pattern.
- `src/core/config/protected-paths.ts`: `AGENT_CONFIG_PATHS`. `src/core/manifests/globs.ts`: `normalizeGlob`, `literalPrefix` and `globsOverlap`.
- `src/lane/planning-step.ts`: the whole step to mirror:
  - `freshMain`, `poll`, `ciAndGate` and `publish`;
  - `closeOrphans`, `parkBlocked`, the session context and runner, and the sections.
  - `src/lane/lane-process.ts:356`: the prompt callback that writes a tmp file after `prepare`.
- `src/lane/graph-trees.ts`: `blobText` and `readTree`, the model for `createGitTreeFiles({gitDir, fetch})` in `src/lane/tree-files.ts`. Its result: `{tree, files}` for a SHA and a path filter, with a missing SHA fetched.
- `src/core/reconcile/plan.ts`: `planReconcile` and `asMerged`. `src/lane/reconcile-step.ts`:
  - `steps` (line 849): the status switch;
  - `openAndQueue` (737): `files`, and the gate at line 806;
  - `reconcilePrText` (124).
  - `src/lane/reconcile-commit.ts` already writes several files.
- `src/ports/forge.ts`: `ForgePr`. `src/adapters/forge/github/github-forge.ts:567`: `toPr`. `src/adapters/forge/fake/fake-forge.ts`: `PrRecord`, `view` and `mergeQueueHead` (446). `test/adapters/forge/github/fake-github.ts`: `pullJson` (333) and `mergeQueueHead` (877). `test/contracts/forge.contract.ts`.
- `src/lane/coordinator-process.ts`: `STEP_STORY` (retro is "2.9"). `src/cli/lane-run.ts:294`: wiring.
- `docs/maintainer/self-host.md:471` (rollout) and `:493` (the planning paragraph, the model for a retro paragraph).
- Tests:
  - `test/core/next/coordinator.test.ts` (2.4's case table, `world()`);
  - `test/core/lane/write-check.test.ts`, `test/core/reconcile/plan.test.ts` and `test/core/prompt/build-prompt.test.ts` (`PLANNING_PARTS` word test);
  - `test/core/ledger/*` and every "unknown version" fixture, which moves from 4 to 5;
  - `test/lane/{planning-step,reconcile-step,commit,graph-trees}.test.ts` (harness models) and `test/lane/git-fixture.ts`.

## Tasks & Acceptance

**Execution:**
- `src/core/schemas/config.ts`, `src/core/schemas/snapshot.ts`, `src/core/next/snapshot.ts`: `live_evidence_glob` and `live_evidence`.
- `src/core/schemas/ledger.ts`, `src/core/ledger/codec.ts`, `src/core/ledger/edits.ts`: v4 and `retro_result` (keep and clear rules, the heartbeat set).
- `src/core/next/coordinator.ts`, `src/core/next/next.ts`: the retro position, a `retroDue`/`retroCandidates` helper, the `live-evidence` reason and the `waiting-on-maintainer` idle text.
- `src/core/retro/validate.ts` (new, pure): `refusedItemGlobs`, `checkRetroResult` (pre-commit) and `checkRetroDiff({ epic, result, config, onto, head })`, which reads action items and doc frontmatter with `parseYaml`.
- `src/core/schemas/epic-prs.ts` (new): `EpicPrsSchema`.
- `src/core/prompt/template.ts`, `src/core/prompt/build-prompt.ts`: the `retro` and `result_retro` parts, `buildRetroPrompt` and `RETRO_RESULT_JSON_SCHEMA`.
- `src/core/lane/write-check.ts`, `src/lane/commit.ts`: `live-evidence` and the retro-record classes. The callers of `writeRules` pass `live_evidence_glob`.
- `src/lane/tree-files.ts` (new): the `TreeFiles` port and its git reader.
- `src/lane/retro-step.ts` (new): `createRetroStep` and `retroPrText`. `src/cli/lane-run.ts`: wiring.
- `src/core/reconcile/plan.ts`, `src/core/reconcile/retro-gates-edit.ts` (new: the apply and serialize steps), `src/lane/reconcile-step.ts`: the `retro-gates.yaml` write.
- `src/ports/forge.ts`, both adapters, `test/adapters/forge/github/fake-github.ts`, `test/contracts/forge.contract.ts`: `merge_sha`.
- `docs/maintainer/self-host.md`: a retro-units paragraph, covering the evidence file, the PR gate, what reconcile writes and a failed validation, plus the v4 rollout in the advancing list.
- Tests:
  - every matrix row;
  - the coordinator case-table rows: all done with no verdict; a Story not done; no evidence; bootstrapped;
  - a write-check row per retro field, plus `live-evidence`;
  - plan rows;
  - retro-step rows: happy path to enqueue or park, adopted PR, prefetch file content, each validation failure, write-check park, enqueue conflict park;
  - real-git `tree-files` rows;
  - prompt rows and the retro word test;
  - ledger rows for v1–v5;
  - the contract `merge_sha` scenario.

**Acceptance Criteria:**
- Given Epic 2 with every Story `done`, no verdict and its evidence file on `main`, when `next(snapshot, 'coordinator')` reaches retro, then it returns `retro:2`.
- Given a valid retro result whose PR merged, when the next `reconcile` runs, then its PR writes `retro-gates.yaml` with `epics.2.retro` and the items `open`, and once that merges, `retro:2` is done on `main` and its record is deleted.
- Given a retro session, when it runs, then `$TMP/epic-<N>-prs.json` holds the Epic's PRs with review states and merge SHAs, the prompt names that path, and the session got no GitHub access.
- Given `bun test`, `tsc` and `oxlint`, when run, then they report 0 fail and no error.

## Spec Change Log

## Review Triage Log

### 2026-10-25 — Review pass
- verdicts: 28 findings — high 1, medium 1, low 17, false 9, maybe-false 0
- findings:
  - `[medium]` `[patch]` (verification-gap) The retro step's CI-timeout park, fresh-`main` branches (Standing Authority stop, PR merged, closed, head moved) and protected-path gate have no test. — Added `retro-step` cases for each.
  - `[low]` `[patch]` (verification-gap) The step's `openPr` orphan close and usage-limit STOP (`MarkerStop`) have no test. — Added `retro-step` cases for both.
  - `[false]` `[reject]` (intent) The diff-dependent checks run after the squash commit, not literally before it. — The commit is local to `runner.git`; nothing leaves the host before both checks pass (Design Notes). Committing first is the only way to read the merged result.
  - `[false]` `[reject]` (intent) `retro_result` is stored at PR open, not "when the PR merges". — Only the step holds the session result; the record must carry it to the merge for `reconcile` (Design Notes).
  - `[low]` `[reject]` (intent) AR25 makes `waiting-on-maintainer` a journal span category; only the `next` idle reason carries it. — No cause journals that category yet (the journal span enum is `idle`/`usage-limit`, unchanged by any Epic 2 Story). The AC is on `next`'s idle, which names the file.
  - `[low]` `[reject]` (intent) No test chains the step's own written record through merge and `reconcile`. — Each seam is tested: the step writes `retro_result` (asserted), and `reconcile` reads it from a record of the same shape. A chained test adds a large fixture for no new branch.
  - `[false]` `[reject]` (intent) The bootstrapped half ("the gates read its retro as done") is untested here. — `epicHolds` skips bootstrapped dependencies and the graph gate treats them as retro'd; both are covered by their existing tests and unchanged.
  - `[low]` `[reject]` (intent) The diff rewrites `epic-2-context.md` and drops the "Maintainer note … do not implement it" bullet. — The workflow's step-01 recompiled the stale context file. The runner reverts any session change to an Epic context file before the squash (AD-30), so it never lands.
  - `[false]` `[reject]` (intent) AR18's network enforcement is not exercised. — The sandbox and proxy enforce it, in pre-existing code with its own suites; the step's test asserts the profile carries no GitHub host.
  - `[low]` `[reject]` (edge) An item glob with a literal prefix (`pkg/**`) can cover a wildcard-led refused glob (`**/CLAUDE.md`). — This is the spec's conservative rule: refusing every broad glob would refuse `src/**`. The write check still refuses those paths when a unit commits.
  - `[low]` `[reject]` (edge) A commit that removes earlier `action_items` still validates. — The stock script only appends; `action_items` is never read by gates (AD-12). Adding a guard is more than a direct correction.
  - `[low]` `[reject]` (edge) A duplicated appended id is hidden by the set comparison. — The stock script numbers items uniquely; same guard argument.
  - `[false]` `[reject]` (edge) A `rebuild` of a parked retro with its PR still open fails every adopted attempt. — `rule rebuild` closes the record's PR first (`src/lane/rule.ts:57`), so no open PR is adopted.
  - `[false]` `[reject]` (edge) A `retro:<N>` merged with `retro_result` null is stuck for good. — `pr` and `retro_result` are only ever set together (the `record` beat), kept together on release, adoption and takeover, and cleared together on a fresh claim or `rebuild` (which closes the PR); `markMerged` needs `pr`. No reachable state merges a retro PR without a result.
  - `[low]` `[reject]` (edge) An adopted PR whose head was pushed after the park is CI'd and queued with the stored result. — Only a person can push to `xarabot/retro-<N>`, and the gate parks it for approval in this repo; the planning step has the same rule. Re-validation adds a branch.
  - `[false]` `[reject]` (edge) A gitlink at `retro_gates_path` makes `cat-file` fail before the `mode` refusal. — `commitSession` rejects any added or changed gitlink before `writeChanges` runs.
  - `[high]` `[patch]` (blind) Stock item ids keep `_` and Unicode letters (`_slugify` uses `[^\w]+`), which `RETRO_ITEM_ID_PATTERN` refuses, so a retro whose action text names a snake_case identifier fails every attempt. — Widened the slug segment to runs of Unicode letters, marks, digits and `_` joined by `-`; tests for an `_` id and a non-ASCII id.
  - `[false]` `[reject]` (blind) Merged retro with no result is stuck. — Grouped with the edge row above: unreachable.
  - `[low]` `[patch]` (blind) A retro-gates text that does not re-parse (U+2028 in an item) fails every `reconcile` run, status edits included. — The serializer now escapes every non-printable-ASCII character as `\uXXXX`, so the text round-trips; test added.
  - `[low]` `[patch]` (blind) `retro_result` and the PR text keep the raw globs; only `retro-gates.yaml` normalizes them. — The step stores and shows normalized globs.
  - `[low]` `[patch]` (blind) The prompt's glob guidance omits the Standing Authority and Protected Paths. — Added both.
  - `[low]` `[reject]` (blind) `text`, `blocking`, `route` and `globs` are not checked against the commit. — By design: the stock output has only `id` and `action`, and the AC checks ids and the verdict.
  - `[false]` `[reject]` (blind) Refused item globs omit the Epic context path, so a retro-item unit could never land it. — The builder revert does not apply: retro-item units commit under coordinator rules (their own globs, Story 2.10).
  - `[low]` `[patch]` (blind) `self-host.md` omits two hazards: setting `live_evidence_glob` before every pin has 2.9 stops older runners (strict config), and what to do after an enqueue-conflict park. — Both added.
  - `[low]` `[reject]` (blind) Live-evidence matching is case-sensitive in the snapshot but folded in the write check; `<N>` substitution is unbounded. — Only a non-default name or config reaches it; the write check folding only widens a refusal.
  - `[low]` `[reject]` (blind) `retro-step.ts` duplicates `planning-step.ts`; `fold` is defined three times. — The spec chose a sibling step; extracting shared step helpers is a refactor beyond a direct correction.
  - `[low]` `[reject]` (blind) Nothing limits `retro_result` to `retro:` units. — Only the retro step sets it; a refine adds schema surface for no reachable case.
  - `[low]` `[reject]` (blind) The diff edits `epic-2-context.md`, which a Story branch should not touch. — Same as the intent row: a workflow recompile the runner reverts before the squash.

## Design Notes

- **When `retro_result` is stored.** The AC says "when the PR merges". Only `reconcile` sees the merge, and the session result exists only in the step. So the step stores the result on the record together with the PR fields, and the record carries it to the merge. A takeover that adopts the PR keeps it.
- **"The Epic's PRs"** are the PRs on the Epic's Story branches. They are the only PRs the runner can attribute to one Epic deterministically. The stock skill reads the rest from git history.
- **The gate.** As with a status planning PR, the PR parks only when policy gates a path. In this repo `owner_approval_paths: ["**"]` gates every path, so the Maintainer approves each retro PR. A retro is one-shot and costly, so an enqueue conflict parks it, where status planning would close it.
- **The `retro-gates.yaml` rewrite** is whole-file and deterministic. Comments in a hand-edited file are not kept; its data, including a hand-recorded `go`, is kept.

## Verification

**Commands:**
- `bun test` -- expected: 0 fail (live cases skipped)
- `bun --bun tsc` -- expected: no error
- `bun --bun oxlint` -- expected: no warning or error

## Auto Run Result

Status: done

**Summary.** The coordinator now runs each Epic's retrospective as a `retro:<N>` unit and records a validated verdict.
- `next(snapshot, 'coordinator')` gains the retro position after planning. A retro is due once every Story of an Epic outside `bootstrapped_epics` is `done`, the Epic has no verdict, and its live evidence file (new config `live_evidence_glob`, default `docs/maintainer/evidence/epic-<N>.md`) is on `main`. Until that file is on `main`, the lane idles with a reason starting `waiting-on-maintainer: ` that names the file.
- The retro step:
  - prefetches the PRs on the Epic's Story branches, with their reviews and merge SHAs, to `<tmp>/epic-<N>-prs.json`;
  - runs `bmad-retrospective -H <N>` in the sandbox;
  - validates the `retro` result:
    - before the commit: item ids and globs;
    - after the commit and before any push: the items must be exactly the appended `action_items`, and the commit must add or change exactly one retro document whose frontmatter `verdict` is the result's;
  - opens the PR like a status planning PR, storing the result as the record's new `retro_result` (ledger schema 4).
- The next `reconcile` writes the verdict and items, `open`, to `retro-gates.yaml` once, creating the file at `schema_version: 1` when it is absent.
- The write check refuses builders any live evidence file. It refuses coordinator sessions any change to a retro verdict, item, retro go or checkpoint go.
- `ForgePr` gains `merge_sha`.

**Files changed.**
- `src/core/schemas/{config,snapshot,ledger,retro-gates,session-result,epic-prs}.ts`:
  - `live_evidence_glob` and `live_evidence`;
  - ledger v4 with `retro_result`;
  - the shared retro result schemas;
  - a widened retro item id slug;
  - `EpicPrsSchema`.
- `src/core/next/{coordinator,next,snapshot}.ts`: the retro position, `retroCandidates`/`retroDue`, the `live-evidence` reason and the idle text.
- `src/core/retro/validate.ts` (new): `refusedItemGlobs`, `checkRetroResult` and `checkRetroDiff`.
- `src/core/reconcile/{plan,retro-gates-edit}.ts`: the `retro-gates.yaml` write, with a deterministic, escaped serializer.
- `src/core/lane/write-check.ts`, `src/lane/commit.ts`: the `live-evidence` class and the retro-record classes.
- `src/core/ledger/{codec,edits}.ts`: `retro_result` serialization and its keep and clear rules.
- `src/core/prompt/{template,build-prompt}.ts`: the retro prompt.
- `src/lane/retro-step.ts` (new), `src/lane/tree-files.ts` (new), `src/lane/reconcile-step.ts` (several files in one PR), `src/cli/lane-run.ts` (wiring), `src/lane/coordinator-process.ts` (comment).
- `src/ports/forge.ts`, `src/adapters/forge/{github/github-forge,fake/fake-forge}.ts`: `merge_sha`.
- `docs/maintainer/self-host.md`: retro units, the v4 rollout, the config-key ordering and enqueue-conflict recovery.
- Tests:
  - new: `test/core/retro/validate.test.ts`, `test/core/reconcile/retro-gates-edit.test.ts`, `test/lane/{retro-step,tree-files}.test.ts`;
  - extended: the coordinator, write-check, commit, plan, reconcile-step, prompt, ledger, schema, forge and contract tests;
  - "unknown version" fixtures moved from 4 to 5.

**Review findings.** One pass, 28 findings: 1 high, 1 medium, 17 low, 9 false.
- **Patched:**
  - high: stock item ids with `_` or Unicode letters were refused, so the id slug was widened to match the stock `_slugify` output;
  - medium: retro-step tests for the CI timeout, the fresh-`main` branches and the protected-path gate;
  - low:
    - tests for the orphan close and the usage-limit STOP;
    - the retro-gates serializer escapes non-ASCII and controls;
    - globs are normalized in `retro_result` and the PR text;
    - the prompt names the Standing Authority and Protected Paths;
    - two `self-host.md` hazards.
- **Deferred:** none.
- **Rejected:** each with its reason in the Review Triage Log.
  - low:
    - AR25 journal span;
    - no chained step→reconcile test;
    - `epic-2-context.md` recompile (intent and blind);
    - the wildcard-led refused-glob approximation;
    - removed or duplicated action items;
    - an adopted PR with a moved head;
    - `text`, `blocking`, `route` and `globs` unchecked against the commit;
    - live-evidence case and `<N>` bounds;
    - retro/planning step duplication;
    - `retro_result` on non-retro records.
  - false:
    - validation after the local commit;
    - `retro_result` stored at PR open;
    - the bootstrapped gate half;
    - AR18 enforcement;
    - rebuild with an open PR;
    - a merged retro with no result (edge and blind);
    - a gitlink at the retro-gates path;
    - Epic context missing from the refused globs.

**Follow-up review recommended:** true. Patched: 1 high, 1 medium, 5 low. Unverified risk: no reviewer has read the widened `RETRO_ITEM_ID_PATTERN` (Unicode and `_` slugs). It now flows into unit ids, ledger file names (`units/retro-item__<id>.json`) and Story 2.10's retro-item branch names.

**Verification.**
- `bun test`: 3892 pass, 280 skip (live and sandbox-refused cases), 0 fail.
- `bun --bun tsc`: exit 0.
- `bun --bun oxlint`: exit 0.
- Matrix audit: every row of the I/O & Edge-Case Matrix is covered by a test that ran and passed.

**Residual risks.**
- **Live behaviour is untested.** The step runs against a stub agent, committer and tree reader. A real `bmad-retrospective -H` session's output is matched only to the fixtures, which agree with the skill's reference docs.
- **The GitHub emulator `merge_sha` contract scenario** is skipped in the sandbox, because the socket is refused. It first runs in CI.
- **Rollout.** A runner without 2.9 stops on a v4 record, and on a config that sets `live_evidence_glob`. Every lane's pin must advance together.
- **Not committed.** The task rules require the changes to stay in the working tree, so the stock finalize commit was not made. `epic-2-context.md` holds the workflow's recompile, which the runner reverts.
