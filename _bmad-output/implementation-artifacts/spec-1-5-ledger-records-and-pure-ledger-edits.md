---
title: 'Story 1.5: Ledger records and pure ledger edits'
type: 'feature'
created: '2026-10-22'
status: 'done'
baseline_revision: '66b79aa72c50ae9ae120bbdf87a5f748c39d91cd'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      A builder PR ejected from the merge queue again and again can cycle claimed → merging → claimed with attempts rising past ATTEMPTS_CAP, and never park.
    evidence: |-
      `ejected` (merging → claimed) adds 1 to attempts with no cap, because the diagram has no attempts-cap edge out of merging, and `startMerging` does not test attempts. The loop needs the lane's re-enqueue-after-ejection code (AD-16, Story 1.17a), which does not exist yet. That Story must check attempts >= ATTEMPTS_CAP before re-enqueueing, either by calling failAttempt, which parks from claimed, or by asking the Maintainer to settle a startMerging precondition.
    location: >-
      src/core/ledger/edits.ts:659
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Lanes need one definition of the `xarabot/claims` ledger records and of every allowed state change. Without one, a swap could write a transition outside the normative diagram, or skip a precondition that no longer holds on the tip (AR5, AR6, AR8, AR35).

**Approach:** Add zod schemas for unit records and `coordinator.json`, a pure codec (parse the ledger files from a tip, serialize records byte-stably), the diagram's edge table, and one pure edit per diagram edge. Each edit parses the whole tip, re-checks its preconditions there, and returns the files to write plus a `[skip ci]` commit message, or an error.

## Boundaries & Constraints

**Always:**
- Core stays pure (AR2): it returns `Result` and never throws, never reads a clock, and imports only `zod` and core. `now` is an ISO date-time parameter that comes from the forge. Staleness is computed with `Date.parse` on the parameters.
- **Unit ids (AR35):** `story:<story_id>` (`STORY_ID_PATTERN`), `retro:<N>`, `retro-item:<id>` (`RETRO_ITEM_ID_PATTERN`), `checkpoint:<N>`, `planning:<slug>.<n>` (kebab slug), `reconcile:<n>`. `N` and `n` match `^[1-9][0-9]*$`. Each unit's file is `units/<id with ":" replaced by "__">.json`. The coordinator's file is `coordinator.json`.
- **Unit record (AR6):** a strict object. All fields are required and `null` stands for absence, in this key order: `schema_version` (1), `unit`, `state` (`claimed | merging | parked | released | merged`), `owner` (GitHub login), `host` (UUID), `lane` (`coordinator` or `builder-<n>`), `generation` (int ≥ 1), `globs` (normalized globs), `heartbeat_at` (ISO date-time), `pr` (int ≥ 1 | null), `pr_owner` (login | null), `base_sha`, `head_sha`, `reviewed_sha`, `passed_sha`, `approved_sha` (git SHA, 40 or 64 lowercase hex, | null), `builder_providers` (non-empty strings), `park` (`{kind, reason, inbox_owner, globs_held}` | null), `attempts`, `loopbacks`, `ci_fixes` (int ≥ 0), `approval` (`{by, manifest_sha}` | null).
  - `park.kind` is `awaiting-approval | needs-approval | blocked`. `park.reason` is a blocked kind (`escalation | human-live-step | intent-gap | verification | other`) or a runner cause (`review-cap | ci-fix-cap | ci-timeout | write-check | no-op | attempts-cap | unclaimable | graph-invalid`). Any other value is invalid. `reason` is required when `kind` is `blocked` and `null` otherwise.
  - `park` is non-null exactly when `state` is `parked`.
- **`coordinator.json`:** a strict object `{schema_version: 1, owner, host, lane: "coordinator", generation, heartbeat_at, digest_posted_at (date-time | null), rulings_cursor (non-empty string | null)}`. The schema and codec are in scope; its edits belong to Epic 2.
- **Reading:** `parseLedger(files)` takes `Record<path, JSON text>`. A file under `units/` must match the file-name pattern, parse as JSON, and carry a `unit` that matches its file name. Paths outside `units/` other than `coordinator.json` are ignored. An integer `schema_version` other than 1, in any record, returns kind `stop`. Any other malformation returns `invalid`. Every edit parses the whole tip first, so it returns `stop` as well.
- **Serialization:** `JSON.stringify` with keys in the fixed schema order, 2-space indentation and a trailing newline. `globs`, `globs_held` and `builder_providers` are sorted and de-duplicated. The same edit on the same tip gives identical bytes.
- **Edit result:** `Result<LedgerCommit | null>`, where `LedgerCommit` is `{message, writes: Record<path, text>, deletes: path[]}`. `null` means the tip already holds the target, as with `markMerged` on a `merged` record. The message is `ledger: <edit> <unit> [skip ci]`.
- **Error kinds:** `stop`, `invalid` (malformed tip or bad parameters, such as a bad unit id, bad glob or cap < 1), `precondition` (the tip no longer allows the edit), `illegal-transition`. Every edit passes its `(from, to)` pair through `checkTransition` and validates its output record against the schema before serializing it.
- **Every write** sets `owner`/`host`/`lane` to the writer `by` and `heartbeat_at` to `now`. `generation` rises by 1 only on the edges labelled `generation + 1`, and is otherwise unchanged. Caps are tested with `>=`: `ATTEMPTS_CAP = 3` after the increment, and loopback and CI-fix caps (parameters) before it. `STALE_AFTER_MS = 30 min`, and a record is stale when `now − heartbeat_at >= STALE_AFTER_MS`.
- **Held globs** of a record: `globs` when `claimed` or `merging`, `park.globs_held` when `parked`, otherwise none. A claim fails `precondition` when any of its globs overlaps (`globsOverlap`) a held glob of another unit's record.
- **"Held" edits** require `by` to equal the record's `owner`/`host`/`lane` and `generation` to equal the record's generation. Coordinator edits require `by.lane === "coordinator"`.

**Never:**
- No `next`, gates, forge port, swap or retry loop, lane process, coordinator-claim edits, rulings parsing, or Escalation-resolution release. These belong to Stories 1.6, 1.7, 1.16 and Epic 2+.
- No new dependency and no change to existing schemas, apart from new exports.

## I/O & Edge-Case Matrix

Edits (`by` is the writer, `g` the expected generation). Each row is one diagram edge and one test case:

| Edit | From → To | Preconditions | Effect |
|---|---|---|---|
| `claim` | none → claimed | no record; `expectGeneration: null`; no overlap; Infrastructure `manifest_sha` given → fail (no record means no approval) | gen 1, counters 0, `globs`, `pr`/`pr_owner`/`head_sha`/`base_sha` from optional adopted PR |
| `claim` | released → claimed | `expectGeneration` = gen; no overlap; given `manifest_sha` must equal `approval.manifest_sha` | gen + 1, counters and `approval` kept, PR fields from param (else null), `reviewed/passed/approved_sha` cleared |
| `parkNew` | none → parked | Story unit only; no record | gen 1, `needs-approval` or `blocked`/`escalation`, `globs: []`, `globs_held: []` |
| `heartbeat` | claimed → claimed, merging → merging | held | optional `set` of `pr`, `pr_owner`, `base_sha`, `head_sha`, `reviewed_sha`, `passed_sha`, `builder_providers` |
| `loopback` / `ciFix` | claimed → claimed / → parked | held; cap ≥ 1 | counter < cap: counter + 1; else parked blocked `review-cap` / `ci-fix-cap`, globs released |
| `takeOverStale` | claimed → claimed / → parked | stale; gen = g | gen + 1, attempts + 1; attempts ≥ 3 → parked blocked `attempts-cap` |
| `takeOverStale` | merging → merging | stale; gen = g; holder lane ≠ coordinator; caller asserts the PR is still queued | gen + 1, attempts unchanged |
| `startMerging` | claimed → merging | held; `pr` and `passed_sha` non-null | — |
| `park` | claimed → parked | held; reason ≠ `unclaimable` | `awaiting-approval` holds `globs_held` = diff paths; `blocked` and `needs-approval` hold none |
| `park` | merging → parked | held; `awaiting-approval` only | holds diff paths, `approved_sha` cleared |
| `failAttempt` | claimed → released / → parked | held | attempts + 1; ≥ 3 → parked blocked `attempts-cap` |
| `failAttempt` | merging → released | held | attempts + 1 (the diagram has no attempts-cap edge out of `merging`) |
| `release` | claimed / merging → released | held | no attempt counted (`stop --now`) |
| `releaseStale` | merging → released | stale; gen = g; holder lane ≠ coordinator | attempts + 1, `pr` kept |
| `ejected` | merging → claimed | held; lane ≠ coordinator | attempts + 1 |
| `markMerged` | released / claimed / merging / parked → merged | a record exists | `park` cleared; already `merged` → `null` |
| `finishRecurring` | claimed → merged | held; unit is `planning` or `reconcile` | `pr: null` |
| `takeApproved` | parked → merging | coordinator; gen = g; `awaiting-approval` | gen + 1, `approved_sha` from param, `globs` = previous `globs_held`, `park` cleared |
| `applyRuling` | parked → released | coordinator; gen = g; `approve` needs `needs-approval` | `release`: counters reset to 0. `rebuild`: counters reset, `builder_providers`, `reviewed_sha`, `passed_sha` and `approved_sha` cleared. `approve`: `approval = {by, manifest_sha}` |
| `deleteMerged` | merged → none | coordinator; state `merged` | deletes the file |

Cross-cutting cases: wrong state, wrong holder, wrong generation, not stale, or overlap → `precondition`; every `(from, to)` pair outside the diagram → `illegal-transition`; a tip record with `schema_version: 2` or `0` → `stop` from `parseLedger` and from every edit; bad JSON, a file-name/`unit` mismatch, a bad `park.reason`, or `park` set on a non-parked record → `invalid`; attempts 1 → fail → released with attempts 2, and 2 → fail → parked; the same edit applied twice to the same tip → byte-identical writes.

</intent-contract>

## Code Map

- `src/core/result.ts` -- `Result`, `ok`, `err`; reuse.
- `src/core/schemas/common.ts` -- `SchemaVersion`, `SCHEMA_VERSION`, `GitHubLogin`, `IsoDateTime`, `NonEmpty`, `describeIssues`; reuse.
- `src/core/story-id.ts:STORY_ID_PATTERN` -- the `story:` unit id body.
- `src/core/schemas/retro-gates.ts:RETRO_ITEM_ID_PATTERN` -- the `retro-item:` unit id body.
- `src/core/manifests/globs.ts` -- `normalizeGlob` (validate glob params and schema globs), `globsOverlap` (claim overlap); reuse.
- `src/core/schemas/host.ts` -- `host_id` is `z.uuid()`; use the same for `host`.
- `test/support/boundaries.ts` -- core may import only `zod` and core; enforced by `test/boundaries.test.ts`.
- Tests are case tables with `bun:test` (`describe`/`test` loops), as in `test/core/manifests/globs.test.ts`.

## Tasks & Acceptance

**Execution:**
- `src/core/schemas/ledger.ts` -- unit id schema and helpers (`unitKind`, `unitFileName`, `unitPath`, `unitFromPath`), `LaneIdentity`, `GitSha`, `UNIT_STATES`, `PARK_KINDS`, `BLOCKED_KINDS`, `RUNNER_CAUSES`, `ParkSchema`, `ApprovalSchema`, `UnitRecordSchema`, `CoordinatorRecordSchema`, inferred types.
- `src/core/ledger/codec.ts` -- `COORDINATOR_PATH`, `parseLedger(files)` → `Result<Ledger>` (`units: Map<unit, record>`, `coordinator | null`), `serializeUnitRecord`, `serializeCoordinator`.
- `src/core/ledger/transitions.ts` -- `LEDGER_EDGES`, `checkTransition(from, to)`, where `from`/`to` are a `UnitState` or `"none"`.
- `src/core/ledger/edits.ts` -- `LedgerFiles`, `LedgerCommit`, `LedgerEdit`, the constants and every edit in the matrix.
- `test/core/ledger/schema.test.ts`, `codec.test.ts`, `transitions.test.ts`, `edits.test.ts` -- case tables for every matrix row and cross-cutting case.

**Acceptance Criteria:**
- Given `src/core/schemas/ledger.ts`, when a record carries every AR6 field with valid values, then it parses, and a `park.reason` or unit id outside the lists fails validation.
- Given each matrix row, when its edit is applied to a tip built with the codec, then it returns the expected record bytes under the expected path, and the commit message ends in `[skip ci]`.
- Given all 36 `(from, to)` pairs over `none` and the five states, when `checkTransition` runs, then exactly the diagram's edges are ok.
- Given the repo, when `bun install`, `bun test`, `bun --bun oxlint` and `bun --bun tsc` run, then each exits 0 and the boundary check is clean.

## Spec Change Log

## Review Triage Log

### 2026-10-22 — Review pass
- verdicts: 35 findings — high 0, medium 2, low 21, false 12, maybe-false 0
- findings:
  - `[low]` `[reject]` (verification-gap) the `checkTransition` and output-schema guards in `makeEdit` are never exercised through an edit — real. The `requireState` checks in each edit run first, and every edit's legal and illegal source states are tested. The only fix is to export `makeEdit` or add a test-only edit, which is new public surface for a guard that exists only as defence in depth.
  - `[low]` `[reject]` (intent-alignment) illegal transitions are tested only on the table, and arrive through an edit as `precondition` — same root as the verification-gap finding. The AC's "returns an error" holds for every off-diagram attempt in the edit tables.
  - `[false]` `[reject]` (intent-alignment) no real swap, commit or read surface — the epic places `ledgerSwap` and the retry loop in Stories 1.7 and 1.8, and the Story title says "pure ledger edits".
  - `[low]` `[reject]` (intent-alignment) a string or missing `schema_version` is `invalid`, not `stop` — both fail closed, and the spec settles that only an integer version other than 1 means a newer runner.
  - `[false]` `[reject]` (intent-alignment) only `claim` checks overlap — `park` and `takeApproved` only narrow holdings the unit already has, and AD-4's overlap rule is about a record taking globs.
  - `[false]` `[reject]` (intent-alignment) `generation` restarts after `deleteMerged` — the record is deleted only once the unit is done on `main`, so it is never claimed again, and no record's generation ever decreases.
  - `[false]` `[reject]` (intent-alignment) `applyRuling` resets `attempts` — AD-28 requires `release` and `rebuild` to reset the counters. "Attempts survives release" is about lane releases.
  - `[false]` `[reject]` (intent-alignment) no Escalation-resolved release — the Story's intent does not ask for it. It belongs to the Escalation Stories.
  - `[false]` `[reject]` (intent-alignment) budget overrun from `merging` counts no attempt — a budget overrun is `failAttempt`, which adds 1. `release` is only for `stop --now`.
  - `[false]` `[reject]` (intent-alignment) the `coordinator.json` field set is invented — it holds the identity, heartbeat, digest time and rulings cursor that AD-8, AD-23 and AD-28 place in that file. It is not a defect.
  - `[false]` `[reject]` (intent-alignment) a merging failure never parks, which conflicts with AD-7 — the spine declares the diagram normative, which settles it. The cap trips on the next failure from `claimed`.
  - `[low]` `[reject]` (edge-case) `heartbeat` on a `merging` record can rewrite `pr` or `passed_sha` — no caller exists until Story 1.17a, and the fix changes this spec's matrix row.
  - `[low]` `[reject]` (edge-case) `takeApproved` on an awaiting-approval park with `pr: null` — only an approval-gated PR parks awaiting approval, so it always has a PR. A guard would add a precondition the matrix does not list.
  - `[low]` `[reject]` (edge-case) `markMerged` after `deleteMerged` gives `precondition`, not `null` — this matches the matrix ("a record exists"), and the caller then runs `next`, where the unit is done.
  - `[false]` `[reject]` (edge-case) `markMerged` overwrites the holder — a merged unit has nothing left to hold, so a later held edit by the old holder is meant to fail.
  - `[medium]` `[defer]` (edge-case) repeated `ejected` lets attempts pass the cap without parking — the loop needs Story 1.17a's re-enqueue code. Deferred with that note.
  - `[low]` `[reject]` (edge-case) `park` awaiting-approval with an empty `diffPaths` — an empty diff parks blocked `no-op`, not awaiting approval. Unlikely, and a guard adds a branch.
  - `[low]` `[reject]` (edge-case) `diffPaths` is ignored for blocked and needs-approval parks — harmless, because such parks hold nothing by design.
  - `[low]` `[reject]` (edge-case) `claim` with an empty `globs` list — coordinator units may hold no paths, and next refuses an unclaimable Story (Story 1.6).
  - `[low]` `[patch]` (edge-case) malformed `expectGeneration` with no record gives `precondition` — `claim` now validates a non-null `expectGeneration` first and returns `invalid`. A test row was added.
  - `[low]` `[reject]` (edge-case) `finishRecurring` keeps `pr_owner` and SHAs — a recurring unit with nothing to commit never opened a PR, so they are already null. The matrix says only `pr: null`.
  - `[low]` `[reject]` (edge-case) a non-JSON file such as `units/.gitkeep` makes the ledger invalid — only the runner writes the ledger, and the spec fails closed on a stray file in `units/`.
  - `[low]` `[reject]` (edge-case) the coordinator takes over a builder's stale merging record — AD-6 lets any lane take it over. A coordinator-held merging record is then handled by `reconcile`.
  - `[false]` `[reject]` (blind) `markMerged` has no fence, so an old PR's merge marks a new attempt merged — if any PR on the unit's branch merged, the unit's work is on `main`, so `merged` is correct (AD-9).
  - `[low]` `[reject]` (blind) `heartbeat` can rewrite the merge fence — same as the edge-case finding.
  - `[low]` `[reject]` (blind) `approve` records the coordinator's owner as approver — in 0.x the coordinator runs under the Maintainer's bot, and recording a separate ruling author adds a parameter (public surface) that the matrix does not define.
  - `[low]` `[reject]` (blind) `ParkSchema` allows `globs_held` on blocked and needs-approval parks — no edit writes it, so only a hand-edited ledger reaches it. A new refinement guards a state that was not shown to be reachable.
  - `[low]` `[patch]` (blind) inconsistent error kind for a wrong unit kind — `finishRecurring` on a non-recurring unit and `park` with `unclaimable` now return `invalid`, like `parkNew`. The test rows were updated.
  - `[low]` `[reject]` (blind) cap parks cannot choose an inbox — after a takeover the taker is the unit's owner, and its inbox is the right one. Adding the option adds parameters.
  - `[low]` `[reject]` (blind) contradictory parameters are ignored (`manifestSha` on `release`, `stillQueued` on `claimed`, `diffPaths`) — harmless. The `expectGeneration` part is patched with the edge-case row.
  - `[low]` `[reject]` (blind) the `illegal-transition` and output-schema guards are untested — same as the verification-gap finding.
  - `[low]` `[patch]` (blind) the codec round trip is not byte-level — added `serialize(parse(text)) === text` cases for a unit record and `coordinator.json`, and a `stop` case for coordinator `schema_version: 0`.
  - `[low]` `[patch]` (blind) missing matrix cases — added rows for `releaseStale`, `takeApproved` and `applyRuling` at the wrong generation or state, the staleness boundary at 1 ms before and exactly at it, and direct `heldGlobs` cases.
  - `[low]` `[patch]` (blind) `text` shadows the serializer helper in `parseLedger` — the local was renamed.
  - `[false]` `[reject]` (blind) `unitFromPath` replaces only the first `__` — no unit id body can contain `:` or `_`, and the `unitPath(id) === path` round-trip check rejects anything else.

## Design Notes

- **Edits are values over a tip.** `edit(params)` returns `(files) => Result<LedgerCommit | null>`, so the Story 1.7 retry loop can re-apply the same edit to a re-fetched tip, and each application re-checks every precondition against that tip.
- **`park.reason` is `null` unless the park is `blocked`.** AD-7 names a reason only for the blocked outcomes, so this is the tightest reading that still lets every listed value validate.
- **`takeApproved` holds the parked diff paths.** A parked awaiting-approval record holds only the paths its diff changes (AD-7). Moving it to `merging` keeps that holding by copying `globs_held` into `globs`, so it never collides with a claim that was made while it was parked.
- **Out of `merging`, attempts never park.** The diagram allows `merging → parked` only for an approval-gated ejection, so `failAttempt` and `releaseStale` from `merging` release with attempts + 1. The cap trips on the next failure from `claimed`. Dequeueing first stays the caller's duty.

## Verification

**Commands:**
- `bun install` -- expected: exit 0, `bun.lock` unchanged.
- `bun test` -- expected: exit 0.
- `bun --bun oxlint` -- expected: exit 0.
- `bun --bun tsc` -- expected: exit 0.

## Auto Run Result

Status: done

**Summary:** Added the `xarabot/claims` ledger records and pure edits:
- zod schemas for unit records (every AR6 field) and `coordinator.json`, with AR35 unit ids and `__` file names;
- a pure codec that parses a tip and fails closed with `stop` on an unknown `schema_version`, and serializes byte-stably;
- the normative state diagram's edge table, `checkTransition`;
- one pure edit per diagram edge. Each edit parses the whole tip, re-checks state, holder, generation, staleness and glob overlap there, and returns the writes and deletes with a `[skip ci]` message.

**Files changed:**
- `src/core/schemas/ledger.ts`: unit ids and path helpers, lane identity, git SHA, park kinds, reasons, and the unit-record and coordinator schemas.
- `src/core/ledger/codec.ts`: `parseLedger`, `serializeUnitRecord`, `serializeCoordinator`.
- `src/core/ledger/transitions.ts`: `LEDGER_EDGES` (18 edges), `checkTransition`.
- `src/core/ledger/edits.ts`: `claim`, `parkNew`, `heartbeat`, `loopback`, `ciFix`, `takeOverStale`, `startMerging`, `park`, `failAttempt`, `release`, `releaseStale`, `ejected`, `markMerged`, `finishRecurring`, `takeApproved`, `applyRuling`, `deleteMerged`, `heldGlobs`, `ATTEMPTS_CAP`, `STALE_AFTER_MS`.
- `test/core/ledger/{schema,codec,transitions,edits}.test.ts` and `fixtures.ts`: case tables for every matrix row, all 36 transition pairs, stop on `schema_version` 2 and 0 for `parseLedger` and every edit, byte-identical re-application, byte-level round trips, and the attempts sequence 1 → 2 → parked at 3.

**Review findings:** 35 findings: medium 2, low 21, false 12. Every finding has a row in the Review Triage Log.
- Patched (5 entries, all low):
  - wrong-kind parameters now return `invalid` (`finishRecurring`, `park` `unclaimable`);
  - a malformed `expectGeneration` is validated first;
  - byte-level codec round trips and a coordinator `stop` case;
  - extra matrix rows (wrong generation and state, the staleness boundary, `heldGlobs`);
  - a renamed shadowed local.
- Deferred (1, medium): a builder PR ejected repeatedly can push attempts past the cap without parking. Story 1.17a's re-enqueue code must check the cap.
- Rejected, with reasons in the log:
  - untested defence-in-depth guards in `makeEdit` (the fix needs new public surface);
  - heartbeat rewriting fenced fields while `merging` (the fix would edit the spec's matrix);
  - the approver recorded as the coordinator's owner;
  - `globs_held` not refined by park kind in the schema;
  - empty globs and diff paths, and ignored parameters;
  - `.gitkeep` in `units/`, and the coordinator taking over a builder's merge;
  - the false findings: the `markMerged` fence, the swap surface, generation reset, counter resets under rulings, the budget path, the `unitFromPath` replace, and others.

**Follow-up review recommended:** false. The only patches were 5 low entries, with no high and no medium.

**Verification:**
- `bun install`: exit 0, `bun.lock` unchanged.
- `bun test`: 836 pass, 0 fail.
- `bun --bun oxlint`: exit 0.
- `bun --bun tsc`: exit 0.

**Residual risks:**
- The deferred ejection loop.
- `heartbeat` lets a `merging` record's `pr` and SHAs be rewritten.
- `approval.by` names the coordinator lane's owner, not the ruling's author.
- The `coordinator.json` field set (`digest_posted_at`, `rulings_cursor`) is this Story's choice. No AR item enumerates it, and Epic 2 may revise it.
