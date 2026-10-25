---
title: 'Story 2.8: The graph-change gate'
type: 'feature'
created: '2026-10-24'
baseline_revision: '6eeb30386d240dd2e0df9b270eb6647643413fb3'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      approved_graph is bound at reconcile's take, not to the delta posted at the park, so if main's graph moves between the Maintainer's approval and the take, the new hash is recorded and nothing voids the approval.
    evidence: |-
      The take (parked -> merging) is the only diagram edge that can record the hash. There is no parked -> parked edge, and AD-5 has no park field to hold the hash posted with the delta. The case is a second graph PR that waits while another holds xarabot:graph, then is taken against a main that the first PR changed. Binding the approval to the posted hash needs a Maintainer decision: a new edge or a new record field.
    location: >-
      src/lane/reconcile-step.ts (takeApprovedWork, take), src/core/ledger/edits.ts (takeApproved)
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Nothing checks what a PR does to the effective Epic graph before it is enqueued. A planning or builder PR can re-order, add or drop work under the owner's approval alone, a broken merge result is caught only after it merges, and the ledger has no `approved_graph` (FR2, NFR18, AR6, AR12, AR17).

**Approach:**
- Before any agent-made PR is enqueued, the runner recomputes the PR's merge with fresh `main` in `runner.git`. It resolves the graph of both trees and compares them.
- An invalid merge result, or a refused change, parks the PR `blocked` `graph-invalid`.
- A changed graph needs the Maintainer's approval of the head. The runner posts the delta on the PR.
- When `reconcile` takes an approved graph-changing PR, the record takes `xarabot:graph` and stores `approved_graph`. Just before the enqueue, the runner recomputes the hash against current `main`.
- The ledger `schema_version` goes to 3.

## Boundaries & Constraints

**Always:**
- **Where the gate runs.** It runs at three points:
  - the builder merge step, after the fresh-`main` re-check and before the approval gate (not on a `merging` takeover);
  - the planning step for graph units, after CI;
  - `reconcile`'s `takeApproved` work, before the take.
  - The ungated status planning enqueue and `reconcile`'s own PR skip the gate. Their diffs can hold no graph input (Design Notes).
- **The comparison.** Resolve the graph of `main`'s tree and of the merge tree, `git merge-tree --write-tree <head> <main>`, both from `runner.git`.
  - Each side reads its own `.xarabot/config.yaml`, its `graphInputPaths` and `sprint_status_path`.
  - "Changed" means the two `ResolvedGraph.hash` values differ.
  - A merge conflict:
    - the builder: a failed attempt;
    - planning: a failed attempt;
    - `reconcile`: take, then re-park (`conflict` comment), as an enqueue conflict does today.
  - `main` itself not resolving fails the step. In `reconcile`, it skips the take.
- **Refusals** park `blocked` `graph-invalid`, with a 🤖 comment naming them, whether or not the hash changed:
  - the merge tree fails `resolveGraph` (missing or invalid config included);
  - an Epic number or Story id on `main` (a heading or a manifest) is missing from the merge result while it is used:
    - a Story id is used when its sprint key is beyond `backlog`, it has a `story:<id>` ledger record, or a PR in any state sits on `<branches.story><id>`. Its key is the manifest's `sprint_key`, else any `<epic>-<n><letter>-` key;
    - an Epic is used when `epic-<N>` is beyond `backlog`, `retro-gates.yaml` has an `epics.<N>` entry, or a `retro:<N>`, `checkpoint:<N>` or `retro-item:epic-<N>-…` record exists;
  - a Story id new to an Epic that has a `retro` entry on `main`, or is in `bootstrapped_epics`;
  - `checkpoint: true` removed from an Epic still present, unless `main`'s `retro-gates.yaml` records that Epic's `checkpoint` go.
- **The Maintainer gate.** Only `config.maintainer`'s standing approval of the head counts for a changed graph. Logins are compared case-insensitively, under the existing `standingApproval` rule, with the same `parked_at`. An owner who is not the Maintainer never suffices. An unchanged graph keeps today's owner rule.
- **Parks for a change.**
  - The builder merge step and the graph planning step park `awaiting-approval` with `inbox_owner` set to the Maintainer.
  - One 🤖 comment carries the delta, then any gated paths.
  - An unchanged graph unit parks as today.
- **The delta comment** lists, against `main`:
  - edges added and removed, package edges included;
  - checkpoints added and removed;
  - Epics added and removed, and Stories added and removed per Epic;
  - for each checkpoint of the merge result with no recorded go, the Epics that depend on it directly or through others;
  - the merge result's hash.
  - Text goes through `sanitizeAgentText` and is capped at `FORGE_TEXT_LIMITS.comment`. It names the Maintainer in backticks, with no `@`.
- **The take (`reconcile`).** `takeApproved` gains an optional `approvedGraph`. With it, the record's `globs` are `globs_held` plus `xarabot:graph`, and `approved_graph` is set. The edit refuses (precondition) when another record holds a glob overlapping `xarabot:graph`; the PR stays parked and waits for a later run.
  - After the `passed_sha` fence and before the first enqueue, a record with `approved_graph` re-reads fresh `main`. When the SHA moved, it re-runs the gate:
    - a refusal parks `blocked` `graph-invalid` (a coordinator-held `merging` record may now park `blocked`);
    - a different hash voids the approval: re-park `awaiting-approval` for the Maintainer, with a 🤖 comment asking for a new approval and the new delta;
    - an equal hash enqueues.
- **Schema v3 (ledger only).** `LEDGER_SCHEMA_VERSION = 3`, and the reader accepts 1, 2 and 3.
  - `approved_graph` sits after `approved_sha`, as `sha256:<64 hex>` or `null`. A v1 or v2 record without it reads as `null`.
  - Any move that clears `approved_sha` also clears `approved_graph`: a claim from `released`, a claimed takeover, a park from `merging`, and `rule rebuild`.

**Never:**
- No parked → parked ledger edge, and no new park reason. No CI check running `resolveGraph` on human PRs (v1). No change to `xarabot graph check` output, `.github/`, `AGENTS.md`, `_bmad/`, the spec folder or the `runner_version` pin. No mocks: stub ports and the fake forge only.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Unchanged | merge result hash equals `main`'s | today's path | — |
| Story added | new manifest 2.13 in Epic 2 (no retro) | changed; delta lists `+2.13`; builder/graph unit parks for the Maintainer | — |
| Edge / checkpoint | `epics.yaml` adds `3: {depends_on: [1], checkpoint: true}` | delta: edge `3 → 2` removed, `3 → 1` added, checkpoint 3 added, holds Epics 4–7 | — |
| Package edge | `epic_packages` set; `package.json` dependency added | changed; edge listed | — |
| Invalid merge | merge result has a cycle | park `blocked` `graph-invalid` | — |
| Used Story removed | heading 2.7 dropped, `2-7-…: done` | park `graph-invalid` | — |
| Unused Story removed | 2.12 backlog, no record, no PR on `story/2.12` | changed (not refused) | listPrsByBranch failure: a failed attempt (`reconcile`: no take) |
| Retro'd Epic grows | Epic 1 bootstrapped, or `retro-gates` Epic 2 retro; adds a Story | park `graph-invalid` | — |
| Checkpoint retired | `checkpoint` removed, no go / go recorded | refused / changed | — |
| Owner-only approval | owner ≠ Maintainer approved, graph changes | not taken; noted | — |
| Second graph PR | A `merging` with `xarabot:graph`; B approved | B's take refused; B stays parked | — |
| Main moved at enqueue | after take, fresh `main` gives a different hash | re-park for the Maintainer, approval void | — |
| Ledger versions | records at 1, 2, 3 | parse; a write stamps 3; `approved_graph` null when absent | 0 and 4 stop (`ledger-schema-version`) |

</intent-contract>

## Code Map

- `src/core/graph/resolve-graph.ts`: `resolveGraph`, `graphInputPaths`, `GraphSnapshot`, `GraphConfig`, `hash` (number, depends_on, checkpoint, stories). `src/core/graph/epics-md.ts`: `parseEpicsMd`, for heading ids, including those of bootstrapped Epics. `src/cli/graph-check.ts` (`graphConfig`): the config → `GraphConfig` mapping to reuse.
- `src/core/schemas/ledger.ts`: `LEDGER_SCHEMA_VERSION(S)`, `LedgerSchemaVersion`, `UnitRecordSchema`, `GRAPH_PSEUDO_GLOB`. `src/core/ledger/codec.ts:37`: the version stop and its message. `src/core/ledger/edits.ts`:
  - `takeApproved` (line 647), `park` (line 528; merging allows only `awaiting-approval` today), `claim`, `takeOverStale`, `applyRuling`;
  - `fresh` (line 201) and `heldGlobs` / `globsOverlap`, the overlap pattern used in `claim`.
- `src/core/reconcile/approval.ts`: `standingApproval`. `src/core/reconcile/plan.ts`: `ApprovalTarget.parked_at`.
- `src/lane/merge-step.ts`: `gateAndEnqueue` and `steps` (fresh `main`, then the gate). `gateComment` and `approvalComment` stay as they are.
- `src/lane/planning-step.ts:272` (`ciAndGate`): `kind === "graph"` parks.
- `src/lane/reconcile-step.ts`:
  - `takeApprovedWork` (reviews, standing approval, `freshMain`) and `take` (takeApproved, the fence, the enqueue loop, conflict → `repark`);
  - `repark`, `reparkComment` and `ReparkCause`.
- `src/lane/diff-paths.ts` and `src/lane/merger.ts`: the models for a `runner.git` port. `needCommit` + `fetch` for missing SHAs, `merge-tree --write-tree` exit 0/1, and `blobText` (`cat-file blob rev:path`).
- `src/lane/clone.ts`: the `git` / `gitRun` helpers.
- `src/cli/lane-run.ts:296-329`: wire the new port into the reconcile, planning and merge steps (`createGitDiffPaths({ gitDir: runnerGit, fetch })` is the pattern).
- `docs/maintainer/self-host.md:540` ("Graph PRs" until Story 2.8) and the rollout list around line 471.
- Tests:
  - harnesses: `test/lane/{merge-step,planning-step,reconcile-step}.test.ts` (stub `DiffPaths` pattern) and `test/lane/git-fixture.ts` (real temp git repos);
  - `test/core/ledger/{fixtures,schema,codec,edits}.test.ts`, `test/core/next/snapshot.test.ts` and `test/lane/{pr-step,lane-process}.test.ts`: these use 3 as the "unknown" version and move to 4;
  - `test/core/graph/*`.

## Tasks & Acceptance

**Execution:**
- `src/core/schemas/ledger.ts`, `src/core/ledger/codec.ts`, `src/core/ledger/edits.ts`:
  - schema v3 and the `approved_graph` field (`GraphHash` schema);
  - `takeApproved({ approvedGraph? })`, with the `xarabot:graph` overlap refusal;
  - `park` lets a coordinator-held `merging` record park `blocked` `graph-invalid`;
  - every move that clears `approved_sha` also clears `approved_graph`.
- `src/core/graph/graph-gate.ts` (new, pure):
  - the config text → `GraphConfig` helper;
  - `graphReadPaths(tree, configText)`;
  - `checkGraphChange({ main, merged, ledgerUnits })`, which returns `main-invalid`, `invalid`, or `checked` with `changed`, both hashes, the delta, the refusals, and the removed Story ids still to check for branch PRs;
  - `graphDeltaComment(subject, …)` and `graphRefusalComment(subject, …)`.
- `src/cli/graph-check.ts`: use the shared config helper. The output does not change.
- `src/lane/graph-trees.ts` (new): the `GraphTrees` port and `createGitGraphTrees({ gitDir, fetch })`. It returns `{ kind: "clean", main, merged }` (tree listing plus the files `graphReadPaths` names) or `{ kind: "conflict", paths }`. It never throws.
- `src/lane/graph-gate.ts` (new): `gateGraph`, shared by the steps. It runs the port, `checkGraphChange` and the `listPrsByBranch` lookups, and returns `pass`, `change`, `refuse`, `conflict` or `error`.
- `src/lane/merge-step.ts`, `src/lane/planning-step.ts`, `src/lane/reconcile-step.ts`: the gate as in Boundaries; the `graphTrees` dependency is required.
- `src/cli/lane-run.ts`: wire `createGitGraphTrees`.
- `docs/maintainer/self-host.md`: the gate replaces the manual graph-check step, and the v3 rollout (advance every lane together).
- Tests:
  - `test/core/graph/graph-gate.test.ts`: each change kind and each refusal of the matrix;
  - `test/lane/graph-trees.test.ts`: real git, covering clean, conflict, a missing SHA fetched, and the files read;
  - step rows for each gate outcome in the three step test files;
  - edits rows (take with a graph, overlap, clears, the blocked park from merging);
  - v1/v2/v3/v4 rows.

**Acceptance Criteria:**
- Given an approved graph-changing PR, when `reconcile` takes it, then the record is `merging` with `xarabot:graph` in `globs` and `approved_graph` equal to the merge result's hash, and the PR is enqueued at its head.
- Given a graph-changing PR approved only by a non-Maintainer owner, when `reconcile` runs, then it is not taken.
- Given a builder PR whose merge result changes the graph, when CI passed, then it parks `awaiting-approval` with `inbox_owner` set to the Maintainer, and the delta comment is posted.
- Given a graph planning PR whose merge result fails validation, when CI passed, then it parks `blocked` `graph-invalid`, and nothing is enqueued.
- Given `bun test`, `tsc` and `oxlint`, when run, then they report 0 fail and no error.

## Spec Change Log

## Review Triage Log

### 2026-10-24 — Review pass
- verdicts: 34 findings — high 0, medium 7, low 22, false 5, maybe-false 0
- findings:
  - `[low]` `[patch]` (verification-gap) No test proves `reconcile`'s own PRs skip the gate; every reconcile-PR test uses the always-unchanged stub. — Added tests with a never-called stub and a conflict stub, asserting no gate call and the PR taken and enqueued.
  - `[medium]` `[patch]` (verification-gap) `recheckGraph`'s failure branches are untested: a failed snapshot after the fence, and a second gate answer of `error` or `conflict`. Flipping any of them to enqueue goes unnoticed. — Added a case for each.
  - `[medium]` `[patch]` (verification-gap) No `createGitGraphTrees` fixture tells the merge tree apart from head's tree, so reading head instead of the merge would pass every test. — Added a clean merge where `main` and head each add a different graph input.
  - `[medium]` `[defer]` (intent) `approved_graph` is bound at the take, not to the delta posted at the park. If `main` moves between the Maintainer's approval and the take (for example while another PR holds `xarabot:graph`), the take records the new hash, and nothing voids it. — The normative state diagram has no parked → parked edge and AD-5 has no park field to hold the posted hash, so binding it earlier needs a Maintainer decision. Deferred.
  - `[medium]` `[patch]` (intent) "It posts the delta": `reconcile` posts nothing when it first finds that a PR parked under the owner rule now changes the graph. — Grouped with the blind finding on gate verdicts that flip between the park and the take, and fixed there.
  - `[false]` `[reject]` (intent) The status-planning and `reconcile` exemptions rest on an untested write-check premise. — The coordinator write check, from Stories 2.3 and 2.7 and tested there, refuses graph inputs in a status unit. `reconcile` commits only `sprint_status_path`, which is runner-written.
  - `[false]` `[reject]` (intent) A claimed graph planning unit also blocks a graph take. — That is intended: the unit holds `xarabot:graph` so graph changes go one at a time (AD-11). The documentation gap is covered by the blind docs row below.
  - `[false]` `[reject]` (intent) Human-authored PRs are not gated. — The architecture defers the human-PR CI check to v1 (CAP-19), and the spec's Never list excludes it.
  - `[low]` `[patch]` (intent) "Noted" means a line in the lane log only, for an owner-only approval of a graph change. — Grouped with the verdict-flip fix, which now re-parks the PR for the Maintainer with the delta comment.
  - `[low]` `[reject]` (blind) `recheckGraph` `pass` after `main` moved: when `main` already carries the change, the approval is voided with a misleading comment. — This needs `main` to absorb the same graph change in the seconds between the take and the enqueue. The fix adds a branch.
  - `[medium]` `[patch]` (blind) Nothing updates the inbox or comments when the gate verdict flips between the park and the take: an owner-parked PR that now changes the graph sits in the owner's inbox with only a log line. — An owner-approved PR now gets the take, a fence, and a re-park for the Maintainer with the delta comment, so only the Maintainer's later approval takes it. The reverse flip is the edge row "Maintainer-parked, now unchanged" below.
  - `[low]` `[patch]` (blind) `graph-trees.ts`: any non-zero `cat-file` exit is read as "no blob", so a transient git failure on the merge side becomes a `graph-invalid` refusal. — Every path read comes from the same tree's `ls-tree`, so a failed read of a listed path is now a `git` error. Test added.
  - `[low]` `[patch]` (blind) The comment cap can cut the merge result hash at the end of the delta. — The hash is now in the lead paragraph, so the cap (65 536) never drops it.
  - `[low]` `[reject]` (blind) The graph comments skip credential redaction (`secrets`). — The texts are graph ids, paths and parse messages from files the PR's own diff already publishes. Threading `secrets` through adds a parameter to every comment builder.
  - `[low]` `[reject]` (blind) A take whose gate returned `pass` is never re-checked before the enqueue. — The gap is seconds within one run. A diff that leaves the graph unchanged against `main` cannot change it unless `main` moves its graph inputs in that window. A re-check adds a snapshot and git work to every take.
  - `[low]` `[reject]` (blind) The gate runs every run for approved PRs that cannot be taken, and the builder runs it on diffs with no graph input. — This costs only git time: about one `merge-tree` per such PR every 10 minutes. Skipping on paths would need the tree-listing rules duplicated.
  - `[false]` `[reject]` (blind) A merge conflict now costs a builder attempt. — Before this change, a conflicting builder PR also cost an attempt: the enqueue error was not a back-off kind (`failed`), or the queue ejected it (`ejected`, attempts + 1).
  - `[low]` `[patch]` (blind) `self-host.md` says "you stop running it", though human PRs are not gated. — The doc now keeps the manual `graph check` for PRs a lane did not open.
  - `[low]` `[patch]` (blind) `self-host.md` understates the one-at-a-time rule: a running graph planning unit also holds the take. — Documented, with the journal reason as the only signal.
  - `[low]` `[patch]` (blind) `checkGated`: a graph-changing record that leaves the queue re-parks into the owner's inbox. — `repark` now defaults the inbox to the Maintainer for a record holding `xarabot:graph`. Test added.
  - `[low]` `[patch]` (blind) Missing tests: the re-check snapshot and error branches, the queue check of a graph record, the blob-read failure, and a codec tip mixing versions 2 and 3. — Added together with the rows above. Rejected as low value: the `merge-tree` exit codes other than 0 and 1 (handled like the merger), the planning `listPrsByBranch` failure (the same `gateGraph` path as the tested merge step), and comment-post failures (the existing best-effort pattern).
  - `[medium]` `[patch]` (edge) An owner-parked PR whose merge now changes the graph never reaches the Maintainer. — Grouped with the blind verdict-flip row; fixed.
  - `[low]` `[reject]` (edge) A Maintainer-parked PR whose graph is no longer changed needs the owner's approval, and nobody is told. — This happens only when the owner is not the Maintainer (not 0.x's single-owner setup) and `main` absorbed the change. In this repo the owner is the Maintainer, whose approval counts.
  - `[low]` `[patch]` (edge) A not-queued re-park of a graph take goes to the owner's inbox. — Grouped with the `checkGated` inbox row; fixed.
  - `[low]` `[patch]` (edge) An enqueue-conflict re-park of a graph take goes to the owner. — Grouped with the `checkGated` inbox row; fixed. The gate-conflict take carries no graph hash, since the change is unknown, so the owner's inbox is right there.
  - `[low]` `[reject]` (edge) A `main` whose own graph does not resolve fails every builder attempt. — A graph that does not resolve already stops every lane at the next round's snapshot (AD-11). The step sees it only when `main` broke mid-unit.
  - `[low]` `[reject]` (edge) A builder PR may pass the gate while another graph PR is queued. — A PR whose merge leaves the graph unchanged against `main` changes no graph input that composes with the queued change, except by text-only edits to those files. That case is contrived, and the fix adds queue-wide checks.
  - `[low]` `[reject]` (edge) The ledger or branch PRs may change between the gate and the enqueue with `main` unchanged. — The window is seconds, and a Story would have to become used in it.
  - `[low]` `[reject]` (edge) Later targets in one run reuse the fresh snapshot after a re-check saw `main` move. — Rare, and each later target's gate still runs against a `main` of the same run.
  - `[low]` `[reject]` (edge) A broad glob such as `**` overlaps `xarabot:graph` and blocks graph takes. — This matches Story 2.7's claim overlap rule for graph planning units, and `globsOverlap` is the shared rule. Changing it only here would split the two.
  - `[low]` `[patch]` (edge) A `cat-file` failure other than a missing blob parks the PR `graph-invalid`. — Grouped with the blind `graph-trees.ts` row; fixed.
  - `[low]` `[reject]` (edge) A ledger `stop` in `gateGraph` skips the take instead of stopping the lane. — The next round's snapshot stops the lane on the same record (`ledger-schema-version`). Surfacing a stop from the gate adds a new outcome kind.
  - `[medium]` `[patch]` (edge) Claim: the runner posts the delta for every change, but `reconcile`'s first detection posts none. — Grouped with the verdict-flip row; fixed.
  - `[false]` `[reject]` (edge) The docstring says a record with `approved_graph` re-reads `main`, yet later runs never re-check it. — The text describes the take, between the fence and the enqueue, which is where the code does it. Later runs check the queue as AD-7 says.

## Design Notes

- **Skipped enqueues.** Two enqueues skip the gate, and the merge proves it safe. A status planning diff is limited by the coordinator write check to the status files and Epic context, and `reconcile`'s PR to `sprint-status.yaml`. Neither is a graph input or the config. A merge that changes no graph input yields `main`'s graph inputs byte for byte, so the hash is unchanged. Gated status PRs still pass the gate at `reconcile`'s take.
- **Where `approved_graph` is recorded.** There is no parked → parked edge, so the approval is recorded at the take (parked → merging). "At enqueue" re-reads fresh `main` after the fence. A refused or void PR goes merging → parked through the existing diagram edge.
- **Bootstrapped Epics.** AD-11 makes the gates read a bootstrapped Epic as retro done, so it takes no new Stories, like an Epic with a recorded retro.

## Verification

**Commands:**
- `bun test` -- expected: 0 fail (live cases skipped)
- `bun --bun tsc` -- expected: no error
- `bun --bun oxlint` -- expected: no warning or error

## Auto Run Result

Status: done

**Summary.** Before any agent-made PR is enqueued, the runner checks what its merge with fresh `main` does to the effective Epic graph.
- It recomputes the merge in `runner.git` and resolves the graph of `main` and of the merge result.
- A refused merge result parks `blocked` `graph-invalid`, with a 🤖 comment naming why. That covers a result that does not resolve, a used Epic number or Story id dropped, a new Story in a retro'd or bootstrapped Epic, and a checkpoint retired with no go.
- A changed graph waits for the Maintainer's approval of the head, with the delta posted on the PR.
- When `reconcile` takes an approved graph change, the record holds `xarabot:graph` (a second one waits) and stores `approved_graph`. Just before the enqueue it re-reads `main`; if `main` moved, a different hash voids the approval.
- The ledger `schema_version` is now 3, and the reader accepts 1, 2 and 3.

**Files changed.**
- `src/core/schemas/ledger.ts`: `LEDGER_SCHEMA_VERSION` 3, the `GraphHash` schema and `approved_graph`, which reads as `null` when absent.
- `src/core/ledger/codec.ts`: serializes `approved_graph`; the version-stop message.
- `src/core/ledger/edits.ts`: `takeApproved({ approvedGraph })` with the `xarabot:graph` overlap refusal; a coordinator-held `merging` record may park `blocked` `graph-invalid`; `approved_graph` is cleared wherever `approved_sha` is.
- `src/core/graph/graph-gate.ts` (new): `graphSettings`, `graphReadPaths`, `checkGraphChange` (delta and refusals), and the delta and refusal comments.
- `src/lane/graph-trees.ts` (new): the `GraphTrees` port and its `runner.git` implementation (`merge-tree --write-tree`).
- `src/lane/graph-gate.ts` (new): `gateGraph`, shared by the steps, including the branch-PR lookups.
- `src/lane/merge-step.ts`, `src/lane/planning-step.ts`, `src/lane/reconcile-step.ts`: the gate at the builder merge step, after a graph unit's CI, and at `reconcile`'s take, with the re-check just before the enqueue.
- `src/cli/lane-run.ts`: wires `createGitGraphTrees`. `src/cli/graph-check.ts`: shares `graphSettings`; its output is unchanged.
- `docs/maintainer/self-host.md`: what the gate does, the manual check still needed for PRs no lane opened, and the v3 rollout.
- Tests:
  - new: `test/core/graph/graph-gate.test.ts`, `test/lane/graph-trees.test.ts` (real git) and `test/lane/graph-stub.ts`;
  - gate rows in the merge, planning and reconcile step tests;
  - edits and codec rows;
  - "unknown version" fixtures moved from 3 to 4.

**Review findings.** One pass with 34 findings: 0 high, 7 medium, 22 low, 5 false.
- **Patched:**
  - medium: an owner-parked PR whose merge now changes the graph is taken and re-parked for the Maintainer with the delta (grouped intent, blind and edge rows);
  - medium: tests for `recheckGraph`'s failure branches;
  - medium: a merge-tree fixture that tells the merge result apart from head;
  - low: graph-holding re-parks go to the Maintainer's inbox; an unreadable listed blob is a git error, not a refusal; the hash leads the delta comment; two `self-host.md` corrections; tests that `reconcile` PRs skip the gate; a codec v2+v3 row.
- **Deferred** (frontmatter `deferred`): `approved_graph` is bound at the take, not to the delta posted at the park. Changing that needs a Maintainer decision on a state edge or a new field.
- **Rejected**, each with its reason in the Review Triage Log:
  - low: `pass` after `main` moved; secrets in the graph comments; no re-check for `pass` takes; gate frequency; a Maintainer-parked PR now unchanged; a `main` that does not resolve; a builder PR passing beside a queued graph PR; ledger drift between the gate and the enqueue; a stale fresh snapshot for later targets; broad globs overlapping `xarabot:graph`; a ledger `stop` inside the gate;
  - false: the exemption premise, a planning unit blocking the take, human PRs, a conflict's attempt cost, the docstring claim.

**Follow-up review recommended:** true. Patched: 3 medium, 7 low, 0 high. Unverified risk: the post-review `reconcile` path for owner-only approvals (`after: "maintainer"`) and the inbox default for graph-holding re-parks changed after the review pass, and no reviewer has read them.

**Verification.**
- `bun test`: 3686 pass, 277 skip (live cases), 0 fail.
- `bun --bun tsc`: exit 0.
- `bun --bun oxlint`: exit 0.
- Every row of the edge-case table is covered by a test that ran (matrix audit).

**Residual risks.**
- **Live behavior is untested.** The steps run against a stub `GraphTrees`; only the git reader runs against real repositories. The real merge → gate → comment chain runs for the first time live.
- **Rollout.** A runner without 2.8 stops on a v3 record, so every lane's `runner_version` must advance together.
- **Approval timing.** The deferred approval-timing window (see `deferred`).
- **Not committed.** The task rules required the changes to stay uncommitted in the working tree, so the stock finalize commit was not made.
