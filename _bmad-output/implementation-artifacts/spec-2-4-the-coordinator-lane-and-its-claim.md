---
title: 'Story 2.4: The coordinator lane and its claim'
type: 'feature'
created: '2026-10-24'
baseline_revision: '46d31bf2011f1a666778789e4c97a4a595c4f583'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      The planning artifacts disagree on whether a reconcile run with nothing to commit deletes its record at once, while Story 2.4's timing needs the newest reconcile:<n> record to stay.
    evidence: |-
      epics.md Story 2.5 says a reconcile run with nothing to commit becomes merged with no PR and is deleted at once. Story 2.4's AC (the Maintainer's 2026-10-24 decision) says reconcile never deletes the newest reconcile:<n> record. If 2.5 deletes it, reconcileDue reads "no reconcile run" and reconcile is always due. Planning artifacts are the Maintainer's to settle; this run edits neither.
    location: >-
      _bmad-output/planning-artifacts/epics.md (Story 2.5 vs Story 2.4)
    severity: medium
---

<intent-contract>

## Intent

**Problem:** `xarabot lane run` refuses every coordinator lane, `next(snapshot, 'coordinator')` returns `stop`, and nothing claims `coordinator.json`. So two coordinators could run, and builders cannot tell that the coordinator is gone (FR4, AR9, AR14, AD-8, AD-13).

**Approach:**
- **The claim.** Pure edits claim and heartbeat `coordinator.json`. `lane run` claims it as a start check, and a coordinator process keeps the claim live through its round and its trailing wait.
- **Selection.** `next` gets its coordinator branch: `reconcile` when due, then an open coordinator PR, then `idle`. The process runs an injected step per unit kind; a kind with no step ends `idle` without a claim.
- **Guards.** Builders alert when the claim is missing or expired. A pure `coordinatorGlobs` gives each coordinator unit kind its globs, and the write check gains coordinator rules.

## Boundaries & Constraints

**Always:**
- **Claim edit** (`claimCoordinator`), by a writer whose lane is `coordinator`:
  - no record: write generation 1, `digest_posted_at` and `rulings_cursor` `null`;
  - same `owner/host/lane`, live or stale: re-stamp `heartbeat_at` at the same generation. This is not a takeover;
  - a different identity, stale (`now` ≥ `heartbeat_at` + 30 min): take it over at generation + 1, keeping `digest_posted_at` and `rulings_cursor`;
  - a different identity, live: a `precondition` error naming the holder and its heartbeat.
- **Keep edit** (`keepCoordinator`): stamps `heartbeat_at` only when identity and generation match, else `precondition` (the claim is lost).
- **`lane run` for a coordinator lane.** The same start checks as a builder, except `builderRefusal`. The claim is the last check, and a failure is a failed start (three in a row write STOP and alert). Only then is `failed-starts` reset and the coordinator process started.
- **Lane names.** `lane install` refuses role `coordinator` unless the lane is named `coordinator`, and refuses the name `coordinator` for a builder.
- **Coordinator process** (`runCoordinatorProcess`), one round per run, like the builder process:
  1. It writes `lane.pid` and starts a `coordinator.json` keeper at once. The keeper beats every 5 min with `keepCoordinator`. It never releases; a lost or lapsed claim aborts its signal.
  2. It checks STOP, then takes the snapshot (`role: 'coordinator'`). A `coordinator.json` in the snapshot that isn't its own identity and generation ends the run `failed`.
  3. It calls `next`. A unit whose kind has no step in `deps.steps` is not claimed: the run ends `idle` with an idle span. The reason is `no <kind> step (Story <S>)`, S being `reconcile` 2.5, `planning` 2.7, `retro` 2.9, `retro-item` 2.10, `checkpoint` 4.4.
  4. With a step, it claims the unit. A stale `claimed` record is taken with `takeOverStale`. Otherwise `claim` is used, with `expectGeneration`, and with `adoptPr` when the unit has an open PR, else `baseSha` main. It then starts a unit keeper, runs the step and journals one unit record.
  5. The trailing wait runs while the `coordinator.json` keeper still beats. Both keepers stop at the end.
- **`next(snapshot, 'coordinator')`**, positions in order:
  1. **`reconcile`.** It is due when any of these holds:
     - the snapshot shows work: a record not `merged` whose PR is `merged` in `prs`; a `merged` record whose unit is done on `main` (Design Notes); or the digest slot passed;
     - there is no `reconcile:<n>` record;
     - `now` ≥ the newest `reconcile:<n>` record's `heartbeat_at` + 10 min.

     When due, `next` returns `reconcile:<max n + 1>` (`reconcile:1` when there is none), with globs `[]` and no takeover. When not due, it adds a reason and goes on.
  2. **Open coordinator PR.** The records whose lane is `coordinator`, whose kind is not `story`, whose state is `claimed`, `merging` or `released`, and whose PR is `open` in `prs`, in unit order:
     - `released`: returned with its generation and PR;
     - stale `claimed`: returned as `take_over: 'claimed'`;
     - live `claimed` or `merging`: a `record-state` reason.

     If none is returned but one exists, `next` returns `idle`: later positions wait until that PR merges or parks.
  3. **Planning, retro, retro items and checkpoint** do not exist yet. `next` returns `idle`, with reason `no coordinator unit due`, plus each reason's message.
- **Stops.** An invalid snapshot, a role mismatch or an invalid graph stop the coordinator as they stop a builder.
- **Builders.** The builder branch never returns a coordinator unit, and the coordinator branch never returns a Story.
- **Builder alert.** After the snapshot, a builder whose `ledger.coordinator` is `null` posts `forge.alert('coordinator-missing', main)`, and one whose claim is stale posts `coordinator-expired`. The post is best effort, its failure is ignored, and the builder goes on building.
- **`coordinatorGlobs(spec, config)`:**
  - graph planning: `epics_path`, `.xarabot/epics.yaml`, `<manifests.dir>/*.md` (when set) and `xarabot:graph`;
  - status planning: `sprint_status_path`, `retro_gates_path` and `epic_context_path` with `<N>`→`*`;
  - `retro:<N>`: the two status files, Epic N's context path and `retro_doc_glob` with `<N>`=N;
  - `checkpoint:<N>`: the two status files and Epic N's context path;
  - retro item: its own globs;
  - `reconcile`: `[]`.
- **Coordinator write check.** `coordinatorWriteRules({ config, globs, graphUnit })` gives rules with `role: 'coordinator'`. `checkWrite` dispatches on `role`. Every comparison is case-folded. A path is refused with the first class that fits:
  1. `xarabot`: under `.xarabot/**` and not `.xarabot/epics.yaml`;
  2. `graph-input`: a graph input in a unit that is not graph planning;
  3. `outside-unit`: matched by none of the unit's globs;
  4. `graph-and-status`: the diff touches both a graph input and a status file, so every graph input and status file path left is refused.

  `commitSession` accepts either rule set. It reverts Epic context files and reads the own manifest only for builder rules.
- **Self-host doc.** `docs/maintainer/self-host.md` lists the coordinator steps in this order:
  1. once Stories 2.4 and 2.5 have merged, tag a `main` commit holding both;
  2. advance `runner_version` to that tag in a Maintainer PR (Story 1.19);
  3. install with `xarabot lane install coordinator --role coordinator …`, which Epic 2's retro, and so Epic 3, waits on.

  It says the coordinator lane is never installed while `runner_version` lacks Stories 2.4 and 2.5.

**Never:**
- No `reconcile`, planning, retro or retro-item step. `lane run` wires no steps, so a real coordinator ends `idle` "no reconcile step (Story 2.5)".
- No retro verdict, item or go field check (moved to Story 2.9).
- No ledger schema change, and no new forge operation.
- No change to `.github/`, `AGENTS.md`, `_bmad/`, the specs folder or the skills.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First coordinator | no `coordinator.json` | claimed at generation 1; process runs | none |
| Restart, same identity | live record, same `owner/host/coordinator` | same generation, `heartbeat_at` = now | none |
| Second coordinator | live record of another identity | `lane run` failed start, the holder named; no process | 3rd in a row → STOP + `lane-start-failed` |
| Old coordinator dead | stale record of another identity | taken at generation + 1, cursor kept | none |
| Claim lost mid-run | keeper beat finds another generation | keeper aborts; run ends `failed` | none |
| No reconcile step | no `reconcile:<n>`, no steps | `idle` "no reconcile step (Story 2.5)", nothing claimed, coordinator keeper beat through the wait | none |
| Reconcile, work shown | `story:2.1` parked, PR merged | `reconcile:<n+1>` | none |
| Reconcile, under 10 min | newest `reconcile:4` merged 9 min ago, no work | not due; an open coordinator PR or `idle` | none |
| Reconcile, at 10 min | newest heartbeat exactly 10 min ago | `reconcile:5` | none |
| Open coordinator PR | `planning:status.1` released, PR #9 open | that unit, generation and PR #9 | none |
| PR in flight | `planning:status.1` merging, PR open | `idle` naming it | none |
| Builder, coordinator gone | no `coordinator.json` | alert `coordinator-missing` once per main SHA; Story claimed | alert failure ignored |
| Coordinator diff outside unit | status unit writes `src/a.ts` | `outside-unit` | refusal |

</intent-contract>

## Code Map

- `src/core/ledger/edits.ts` -- `makeEdit` is unit-only. Coordinator edits need their own wrapper over `parseLedger`, writing `COORDINATOR_PATH` with `serializeCoordinator` (`src/core/ledger/codec.ts`). `isStale` and `STALE_AFTER_MS` (30 min) are reused. `claim`, `takeOverStale` and `heartbeatGlobs` are generic over unit ids. `finishRecurring` stamps `heartbeat_at` on `reconcile:<n>` when it goes `merged`.
- `src/core/schemas/ledger.ts` -- `CoordinatorRecordSchema`, `unitKind`, `UNIT_KINDS`, `LaneIdentity`.
- `src/core/next/next.ts` -- `next()` returns `stop` for the coordinator today (~line 82). Builder logic, `takeOverOf` and `storyKey` (the manifest join key). Add the coordinator branch, keeping the builder output identical.
- `src/core/next/snapshot.ts` -- `assembleSnapshot` already carries `ledger.coordinator`, `prs`, `retro_gates`, `sprint_status`, `role`; `epicContextPath`.
- `src/core/schemas/config.ts` -- `digest_time` `HH:MM` UTC; `retro_doc_glob` and `epic_context_path` carry `<N>`; `manifests.dir`.
- `src/core/lane/write-check.ts` -- `WriteRules`, `writeRules`, `checkWrite`, `fold`, `matchesAny`. Add `role: 'builder'` to `WriteRules`.
- `src/lane/commit.ts` -- `CommitParams.rules`. The Epic context revert and `writeChanges` storyFile reads become builder-only.
- `src/lane/committer.ts` -- `CommitRequest.rules` type.
- `src/lane/heartbeat.ts` -- `startHeartbeat` (unit `keepAlive`/`release`). Generalize the loop to a beat edit and an optional release, so a coordinator keeper reuses the same timing and lapse logic.
- `src/lane/lane-process.ts` -- the builder process. `call`, `swap`, `journalUnit`, the trailing wait (`trailingWaitMs`) and the keeper start are the patterns. Add the best-effort coordinator alert after `assembleSnapshot` (~line 1010). Export what the coordinator process reuses (`PrStepOutput` as the step output type).
- `src/lane/coordinator-process.ts` (new) -- `runCoordinatorProcess`, `CoordinatorStep`, `claimCoordinatorRecord` (the `lane run` start check through `swapLedger`).
- `src/cli/lane-run.ts` -- ~line 199: `if (lane.role === "coordinator") return failedStart(...)` is replaced. `LaneRunDeps.start` is the builder hook; add `startCoordinator`.
- `src/cli/lane-install.ts` -- `parseInstallArgs`/`laneInstall`: the lane-name check for the role.
- `docs/maintainer/self-host.md` -- "While Epic 2 is built" → "The coordinator lane" bullet (~line 436).
- Tests: `test/core/next/fixtures.ts` (`World`, `snapshotOf`, `input`, `prs: {}`, `storyRec`), `test/core/next/next.test.ts` (the existing "coordinator → stop" test changes), `test/core/ledger/fixtures.ts` (`COORD`, `NOW`, `LATE`, `tip`), `test/core/ledger/edits.test.ts`, `test/core/lane/write-check.test.ts`, `test/lane/commit.test.ts` + `git-fixture.ts` (`rules()`), `test/lane/heartbeat.test.ts`, `test/lane/lane-process.test.ts` (the harness ledger gets a live `coordinator.json` by default, so existing `alerts()` assertions hold), `test/cli/lane-run.test.ts` + `lane-fixture.ts`, `test/cli/lane-install.test.ts`.
- Baseline sandbox: about 73 tests fail in a sandboxed session (loopback listen, `ps`/`kill`). Compare failures by name with the baseline run.

## Tasks & Acceptance

**Execution:**
- `src/core/ledger/edits.ts` -- add `claimCoordinator({ by, now })` and `keepCoordinator({ by, now, generation })` as `LedgerEdit`s, each with message `ledger: <name> coordinator [skip ci]`. Add `coordinatorClaimState(record, now)`, returning `live`, `missing` or `expired`.
- `src/core/next/coordinator.ts` (new) -- pure. It holds:
  - `coordinatorGlobs`;
  - `reconcileDue(snapshot)`, returning `{ due, why, last }`;
  - `doneOnMain(record, snapshot)`;
  - `digestDue(now, digestTime, postedAt)`;
  - `nextCoordinator(snapshot)`, which returns `CoordinatorUnit` `{ unit, kind, globs, expect_generation, take_over, pr, why }`.
- `src/core/next/next.ts` -- the coordinator branch calls `nextCoordinator`, after the shared validation and the graph check. `NextOutcome` gains `{ kind: 'coordinator', unit, reasons }`. Overloads type `next(s, 'builder')` without it and `next(s, 'coordinator')` without `unit`/`park`.
- `src/core/lane/write-check.ts` -- `role` on both rule sets, `CoordinatorWriteRules`, `coordinatorWriteRules`, the `COORDINATOR_WRITE_CLASSES` and the dispatching `checkWrite`.
- `src/lane/commit.ts`, `src/lane/committer.ts` -- accept both rule sets; the revert and the own-manifest read are builder-only.
- `src/lane/heartbeat.ts` -- an internal generic keeper. `startHeartbeat` keeps its contract, and `startCoordinatorHeartbeat({ forge, identity, generation, … })` beats `keepCoordinator` with no release.
- `src/lane/coordinator-process.ts` (new) -- `claimCoordinatorRecord` and `runCoordinatorProcess` as in Boundaries.
- `src/lane/lane-process.ts` -- the builder's best-effort alert; export the shared helpers the coordinator process needs.
- `src/cli/lane-run.ts`, `src/cli/lane-install.ts` -- the coordinator start path and the lane-name rule.
- `docs/maintainer/self-host.md` -- the ordered coordinator steps and the never-before rule.
- `test/core/next/coordinator.test.ts` (new) -- a case table, with no mocks, for:
  - the reconcile cases: work shown (each of the three kinds), under 10 min, exactly 10 min, no earlier run, and a later position returned while not due;
  - the open-PR cases: released, stale claimed, live claimed, merging, a Story record held by the coordinator ignored, and a parked record not blocking;
  - `idle`, a Story never returned, and a builder never getting a coordinator unit;
  - a `coordinatorGlobs` row per kind, and the overlap check (a builder claim refused against a coordinator unit's globs);
  - `doneOnMain` per kind, and `digestDue`.
- `test/core/ledger/edits.test.ts` -- the claim and keep tables: none, same live, same stale, other live, other stale, wrong lane, keep with the wrong generation or identity.
- `test/core/lane/write-check.test.ts` -- a coordinator table with a row per class and rule, case-folded rows, and a graph unit allowed its inputs.
- `test/lane/commit.test.ts` -- with coordinator rules, a refused path writes nothing, and a status unit's Epic context change is committed, not reverted.
- `test/lane/heartbeat.test.ts` -- the coordinator keeper: beats, lost, lapsed.
- `test/lane/coordinator-process.test.ts` (new) -- against the fake forge:
  - no step → `idle`, no unit record, an idle span with the 2.5 reason;
  - a fake step → claim, step, journal, `progress`;
  - a stale claimed open-PR unit taken over;
  - the claim lost mid-round → `failed`;
  - STOP → `stop`;
  - the coordinator keeper beats during the trailing wait.
- `test/lane/lane-process.test.ts` -- a missing and an expired claim each alert once, and the builder still claims; a live claim posts nothing.
- `test/cli/lane-run.test.ts`, `test/cli/lane-install.test.ts` -- a coordinator start claims and calls `startCoordinator`; another live identity is a failed start; the lane-name rule.

**Acceptance Criteria:**
- Given an installed coordinator lane and no `coordinator.json`, when `xarabot lane run` starts it, then `coordinator.json` holds `<owner>/<host>/coordinator` at generation 1, and the process ends `idle` with reason "no reconcile step (Story 2.5)" and no unit record. Its keeper keeps beating through the trailing wait.
- Given a live `coordinator.json` of another identity, when a coordinator lane starts, then the start is refused and counted, and no ledger write happens. Given the same identity, the start re-claims at the same generation.
- Given a builder lane and an expired or missing coordinator claim, when it runs, then it posts one alert per (condition, main SHA) and still claims its Story.
- Given `bun test`, when it runs, then it shows no failure outside the baseline's sandbox-only set, and `bun --bun oxlint` and `bun --bun tsc` exit 0.

## Spec Change Log

## Review Triage Log

### 2026-10-24 — Review pass
- verdicts: 31 findings — high 0, medium 7, low 18, false 6, maybe-false 0 (verification-gap gaps counted as low)
- findings:
  - `[medium]` `[patch]` (blind 1) The coordinator alerts get the GitHub body "`<condition>` stops every lane", but builders keep building. — Confirmed in `alertBody` (`src/adapters/forge/github/github-forge.ts:91`). The body for `coordinator-missing`/`coordinator-expired` now says the claim is gone and builders keep going, with an alert-test row.
  - `[low]` `[reject]` (blind 2) `lane run` stamps the claim with the start snapshot's `now`, and the keeper's baseline is the process start. — The gap is the seconds of the `--version` probe, `openRunnerGit` and one API call, against a 30-min stale age and a 60-s call deadline. An older `now` only makes a foreign claim look live longer, which fails closed. The fix needs a fresh snapshot plus plumbing.
  - `[low]` `[reject]` (blind 3) While idle, the coordinator rechecks `reconcile` every ~31 min (`idle` trailing wait 30 min), not every 10. — It is real once a reconcile step exists. In 2.4 no step runs, and the lane is never installed before 2.5 (self-host doc). Choosing the coordinator's idle wait is Story 2.5's call; it is listed as a residual risk.
  - `[low]` `[reject]` (blind 4) Always returning `reconcile:<max n + 1>` leaves released or claimed reconcile records orphaned, and a failing reconcile never reaches the attempts cap. — Not reachable in 2.4: no reconcile step claims a reconcile unit. Design Notes hand the cleanup to Story 2.5; listed as a residual risk.
  - `[medium]` `[defer]` (blind 5) The planning artifacts disagree on deleting a nothing-to-commit reconcile record at once versus never deleting the newest one. — The contradiction is in epics.md (Story 2.5 vs 2.4's 2026-10-24 decision), not in this diff. Planning is the Maintainer's, so it is deferred for the Maintainer.
  - `[low]` `[reject]` (blind 6) The coordinator write check has no `.github`/agent-config backstop when a unit's globs are wide (a retro item with `**`). — No coordinator session runs before 2.7. Retro-item globs are validated against write-check paths in Story 2.9 (AR14), and every unit kind's `coordinatorGlobs` excludes them. Adding the builder classes is new behaviour beyond AD-30's coordinator rule.
  - `[low]` `[reject]` (blind 7) `lane install` compares the name `coordinator` without folding case. — A builder named `Coordinator` gets the ledger lane `Coordinator`, which `LaneName` rejects, so it stops at its first snapshot (self-host step 13). Case collisions between lane folders exist for every name already.
  - `[medium]` `[patch]` (blind 8) A coordinator lane under another name is reported as "held" and counted, and `lane run` has no role/name check. — Same root as edge 1; fixed there.
  - `[low]` `[patch]` (blind 9) The self-host doc omits that `coordinator-missing` alerts are expected until the coordinator lane is installed, and has no steps for moving the coordinator. — Added both sentences.
  - `[low]` `[reject]` (blind 10) The builder alert ignores failures and is called once per claim round. — Best effort by design (spec). The forge dedupes per (condition, main SHA), so extra rounds post nothing; they only cost a dedupe read on a lost-claim round.
  - `[false]` `[reject]` (blind 11) A coordinator claim lost during the trailing wait goes unnoticed. — Nothing acts after the wait: the outcome is already final, and the process exits. The keeper logs its own end (`finish` → `note`), and the next start re-claims or is refused.
  - `[low]` `[reject]` (blind 12) `coordinator-process.ts` duplicates `lane-process.ts` helpers. — Real duplication, but sharing the closures over each process's state means a large refactor of the builder process for no behaviour change.
  - `[low]` `[reject]` (blind 13) `nextBuilder` re-checks `snap.graph.ok` after `next` has. — Harmless at runtime, and the check is what narrows `snap.graph` to its `value` for `tsc`. Removing it needs a type assertion.
  - `[false]` `[reject]` (blind 14) `graphInputGlobs` uses `<dir>/*.md` while the builder rule treats everything under the dir as a manifest. — The builder's `classify` takes only a `.md` directly inside `manifests.dir` (no further `/`), the same set as `<dir>/*.md` under `Bun.Glob`.
  - `[low]` `[patch]` (verification-gap 1) No `next`/`reconcileDue` case sets a non-default `digest_time`. — Pre-verified gap. Added rows using the `digestTime` fixture option.
  - `[low]` `[patch]` (verification-gap 2) No process test claims a released coordinator unit with an open PR (`claim` with `expectGeneration` and `adoptPr`). — Pre-verified gap. Added the process case.
  - `[low]` `[patch]` (verification-gap 3) No test covers a coordinator takeover that parks at the attempts cap. — Pre-verified gap. Added the process case.
  - `[medium]` `[patch]` (verification-gap other) After the coordinator claim is lost mid-step, the unit keeper keeps beating the unit through the trailing wait. — Same root as edge 3; fixed there.
  - `[false]` `[reject]` (intent a) The lane-name rule is an addition the AC does not state. — The spec makes it a rule. It follows from AD-8's identity `<owner>/<host>/coordinator` and from `LaneName`, and it narrows behaviour toward fail-closed. No defect is named.
  - `[false]` `[reject]` (intent b) "Refuses to start" became a counted failed start. — The spec's reading is the existing failed-start path (Design Notes), which ends in STOP and an alert. No wrong outcome is named.
  - `[false]` `[reject]` (intent c) The unit-time heartbeat runs only with a fake step. — The AC itself says no step is wired before 2.5. The beat through waits runs in production, and the unit beat is tested with an injected step, as the AC asks.
  - `[low]` `[reject]` (intent d) `coordinatorGlobs` has no production caller. — The AC asks for the globs to be computed; their consumers (planning, retro, retro items) arrive in 2.7, 2.9 and 2.10. Reconcile's `[]` matches it.
  - `[low]` `[reject]` (intent e) `coordinatorWriteRules` has no production caller. — Coordinator sessions start in Story 2.7. The committer accepts the rules now, with real-git tests.
  - `[low]` `[reject]` (intent f) The diff rewrites the coordinator-owned `epic-2-context.md` from a builder lane. — Stock `bmad-build-auto` step-01 recompiled it because epics.md changed after it. The runner reverts any builder change to it before the squash (Story 2.3, AD-13), so it never lands. A residual risk says `main`'s copy is stale.
  - `[medium]` `[patch]` (edge 1) A host.yaml from before 2.4, or edited by hand, can run a builder named `coordinator`, or a coordinator under another name. — `lane run` now refuses a role/name mismatch as a failed start, with test rows.
  - `[medium]` `[patch]` (edge 2) The alert body says the condition stops every lane. — Same root as blind 1; fixed there.
  - `[medium]` `[patch]` (edge 3) A lost coordinator claim leaves the unit claimed, its keeper beating through the wait. — The unit keeper is now stopped once the coordinator keeper has ended, before the trailing wait, with a test.
  - `[low]` `[reject]` (edge 4) The claim is backdated by the start snapshot's `now`. — Same claim as blind 2; rejected there.
  - `[low]` `[reject]` (edge 5) An unsupported `schema_version` at the claim is an ordinary failed start, with no `ledger-schema-version` alert. — The third start still writes STOP and posts `lane-start-failed`. A schema bump is rare, and a new error kind adds surface.
  - `[low]` `[reject]` (edge 6) Glob metacharacters in config paths confuse the coordinator's glob matching. — Config paths are Maintainer-owned and contain none in any known repo. It is the same `Bun.Glob` use as the builder's `protected_paths`.
  - `[false]` `[reject]` (edge 7) The pseudo-glob `xarabot:graph` would allow a root file of that literal name. — No graph unit runs before 2.7. A file named `xarabot:graph` changes nothing the graph reads, and the write check's job is graph inputs and status files, which stay governed.

## Design Notes

- **Re-claim keeps the generation.** AD-8 says the same identity "re-claims without a takeover". A takeover is generation + 1, so the re-claim keeps the generation, and a restarted process fences at the same generation as before. Only one process per identity runs: `lane.pid`, launchd and the host lane name enforce that.
- **The claim is a start check.** A second coordinator refusing to start is then the existing failed-start path, with its counter, STOP and alert. It needs no new outcome.
- **When `reconcile` is due** follows the Maintainer's 2026-10-24 decision.
  - The timing reads the newest `reconcile:<n>` record (`finishRecurring` stamps it).
  - Following AD-9 literally, the unit is always `reconcile:<max n + 1>`. Story 2.5 owns any cleanup of an orphaned, non-`merged` reconcile record.
  - Done on `main`, per AD-9:
    - `story`: the manifest's `sprint_key` is `done`;
    - `retro:<N>`: a retro verdict is recorded;
    - `retro-item`: the item's status is `done`;
    - `checkpoint:<N>`: a `checkpoint` record exists;
    - `planning`: always, since a `merged` recurring record is done;
    - `reconcile`: every record but the newest, which is never work, or reconcile would always be due.
  - The digest slot is today's `digest_time` (UTC). It is due when `now` ≥ the slot and `digest_posted_at` is `null` or before it.
- **Open coordinator PR.** Story 2.7 says the coordinator takes no new planning unit until its open PR merges or parks. So a live or queued coordinator PR makes `next` return `idle` instead of later positions. A Story record the coordinator holds (`takeApproved`) is `reconcile`'s, not this position's.
- **The step contract** is `(input: { unit, record, snapshot, signal, log }) => Promise<PrStepOutput>`, the shape the PR, CI and merge steps already return. Story 2.5 wires the first real one.

## Verification

**Commands:**
- `bun test` -- expected: no failure outside the baseline's sandbox-only set (compare by name with a run at `46d31bf2011f1a666778789e4c97a4a595c4f583`)
- `bun test test/core test/lane/coordinator-process.test.ts test/lane/heartbeat.test.ts test/lane/commit.test.ts test/lane/lane-process.test.ts test/cli` -- expected: all pass apart from baseline sandbox-only failures
- `bun --bun oxlint` -- expected: exit 0
- `bun --bun tsc` -- expected: exit 0

## Auto Run Result

Status: done

**Summary.** Story 2.4 is complete. There is now one coordinator per repo, held as a claim, and builders alert when it is gone.
- **The claim:**
  - `lane run` on a coordinator lane runs the builder's start checks, except the builder limit.
  - It refuses a lane whose role and name disagree.
  - Its last check claims `coordinator.json`:
    - no record: generation 1;
    - the same `<owner>/<host>/coordinator` identity: re-stamped at the same generation, which is not a takeover;
    - another identity's stale record: taken over at generation + 1, keeping the digest time and rulings cursor;
    - another identity's live record: a counted failed start naming the holder. Three in a row write STOP and post `lane-start-failed`.
- **The coordinator process:**
  - Its keeper beats `coordinator.json` every 5 min, through the round and the trailing wait.
  - It runs `next(snapshot, 'coordinator')` and an injected step per unit kind.
  - With no step it claims nothing and ends `idle`, "no reconcile step (Story 2.5)". This is what production does now, since `lane run` wires no steps.
  - With a step, it claims or takes over the unit, runs the step and journals one unit record.
  - A lost or lapsed claim ends the run `failed` and stops the unit keeper.
- **Selection.** `next(snapshot, 'coordinator')` returns, in order:
  1. `reconcile:<max n + 1>` when due: work shown, no earlier run, or 10 min since the newest run's `heartbeat_at`;
  2. an open coordinator PR: released, or claimed and stale;
  3. otherwise `idle`, either waiting on a live or queued coordinator PR, or "no coordinator unit due".

  It never returns a Story, and a builder never receives a coordinator unit. The `next` overloads enforce both in the types.
- **Builder alert.** A builder whose coordinator claim is missing or expired posts `coordinator-missing` or `coordinator-expired`, best effort and once per (condition, main SHA). The GitHub body says builders keep going, and the builder still builds.
- **Globs and write check:**
  - `coordinatorGlobs` gives every coordinator unit kind its globs (AD-13).
  - `checkWrite` takes coordinator rules: `xarabot`, `graph-input`, `outside-unit` and `graph-and-status`, all case-folded.
  - `commitSession` reverts Epic context files and reads the own manifest only under builder rules.
- **Install and docs.** `lane install` refuses role `coordinator` unless the lane is named `coordinator`, and refuses that name for a builder. `docs/maintainer/self-host.md` lists, in order:
  1. tag a `main` commit holding Stories 2.4 and 2.5;
  2. advance `runner_version` to it;
  3. install the coordinator lane, never before.

  It also says when to expect alerts and how to move the coordinator to another host.

**Files changed (baseline `46d31bf2011f1a666778789e4c97a4a595c4f583` → working tree):**
- `src/core/next/coordinator.ts` (new) -- the pure coordinator side: `coordinatorGlobs`, `graphInputGlobs`, `statusFiles`, `doneOnMain`, `digestDue`, `reconcileDue` and `nextCoordinator`.
- `src/core/next/next.ts` -- the coordinator branch, the `coordinator` outcome and the role overloads.
- `src/core/ledger/edits.ts` -- `claimCoordinator`, `keepCoordinator` and `coordinatorClaimState`; `isStale` widened to any heartbeat.
- `src/core/story-id.ts` -- `storyKey`, moved here so both selectors share it.
- `src/core/lane/write-check.ts` -- `role` on the rules; `CoordinatorWriteRules`, `coordinatorWriteRules` and the coordinator classes; `checkWrite` dispatches on `role`.
- `src/lane/commit.ts`, `src/lane/committer.ts` -- accept either rule set; the Epic context revert and the own-manifest read are builder-only.
- `src/lane/heartbeat.ts` -- a generic keeper; `startCoordinatorHeartbeat`, which never releases.
- `src/lane/coordinator-process.ts` (new) -- `claimCoordinatorRecord`, `runCoordinatorProcess`, `CoordinatorStep` and `missingStepReason`.
- `src/lane/lane-process.ts` -- the builder's best-effort coordinator alert.
- `src/cli/lane-run.ts` -- the coordinator start path, with the claim as its last check, and the role/name start check.
- `src/cli/lane-install.ts` -- the role/name rule.
- `src/adapters/forge/github/github-forge.ts` -- the body of the two coordinator alerts.
- `src/adapters/forge/fake/fake-forge.ts` -- a `ledger` seed option (tests).
- `docs/maintainer/self-host.md` -- the coordinator lane steps.
- Tests:
  - `test/core/next/coordinator.test.ts` (new): the coordinator case table;
  - `test/lane/coordinator-process.test.ts` (new);
  - rows added in `test/core/ledger/edits.test.ts`, `test/core/lane/write-check.test.ts`, `test/core/next/next.test.ts` + `fixtures.ts`, `test/lane/commit.test.ts`, `test/lane/heartbeat.test.ts`, `test/lane/lane-process.test.ts`, `test/lane/pr-step.test.ts`, `test/cli/lane-run.test.ts`, `test/cli/lane-install.test.ts` and `test/adapters/forge/github/alert.test.ts`.
- `_bmad-output/implementation-artifacts/epic-2-context.md` -- recompiled by step-01, because `epics.md` changed after it was written. The runner reverts a builder's change to it before the squash.

**Review findings.** 31 findings: high 0, medium 7, low 18, false 6, maybe-false 0.
- **Patched, in 7 entries:**
  - 3 at medium:
    - the coordinator alerts' "stops every lane" text;
    - `lane run`'s missing role/name check;
    - the unit keeper still beating after the coordinator claim was lost.
  - 4 at low:
    - the self-host doc's alert window and moving the coordinator;
    - the `digest_time` test rows;
    - the released-unit-with-open-PR process test;
    - the attempts-cap takeover test.
- **Deferred, 1 (medium):** `epics.md` contradicts itself on whether a nothing-to-commit reconcile record is deleted at once (Story 2.5) or the newest one is never deleted (Story 2.4). This is for the Maintainer.
- **Rejected, 18 (12 low, 6 false).** Each reason is in the Review Triage Log. The most notable:
  - The idle trailing wait (30 min) makes the coordinator recheck `reconcile` about every 31 min, not every 10.
  - `reconcile:<max n + 1>` leaves non-merged reconcile records and never reaches the attempts cap. Neither is reachable before Story 2.5.
  - The coordinator write check has no `.github`/agent-config backstop beyond the unit's globs.
  - The claim is stamped with the start snapshot's `now`, seconds old.
  - `coordinator-process.ts` duplicates helpers from `lane-process.ts`.

**Follow-up review recommended: true.** This first pass patched 3 medium entries, and no fresh review has seen them. The specific unverified risks:
- the new `lane run` role/name start check, which runs before the connect and can refuse lanes that started before;
- the unit-keeper stop on a lost coordinator claim, an ordering change inside the process's end path.

**Verification:**
- `bun test` at the baseline (before any change): 2629 pass, 73 fail, 162 skip. All 73 failures are sandbox-only (loopback listen, `ps`/`kill`).
- `bun test` after the implementation: 2766 pass, 73 fail, 162 skip. After the review patches: 2774 pass, 73 fail, 162 skip. Both times the 73 failures match the baseline's by name: none new, none fixed.
- `bun test test/core test/lane/coordinator-process.test.ts test/lane/heartbeat.test.ts test/lane/commit.test.ts test/lane/lane-process.test.ts test/cli`: 1879 pass and 4 fail before the patches. All 4 are in the baseline set.
- `bun --bun oxlint`: exit 0. `bun --bun tsc`: exit 0. Both before and after the patches.
- Matrix audit: every I/O row has a covering test that ran and passed, across the coordinator, edits, lane-run, coordinator-process, lane-process and write-check tests.

**Residual risks:**
- **Reconcile cadence.** The coordinator's idle trailing wait is 30 min, so once Story 2.5 wires `reconcile`, the "due after 10 min" rule fires only on the next round. Story 2.5 should decide the coordinator's idle wait.
- **Reconcile records.** Story 2.5 must decide how a released, claimed or parked newest reconcile record is retried or cleaned up, together with the deferred delete-at-once contradiction.
- **Production callers.** `coordinatorGlobs` and `coordinatorWriteRules` have none yet; Stories 2.7, 2.9 and 2.10 add them. Coordinator rules have no infrastructure backstop beyond the unit's globs, and Story 2.9 must validate retro-item globs.
- **Epic context on `main`.** `epic-2-context.md` on `main` is older than `epics.md`, which changed on 2026-10-24. The runner reverts this run's recompiled copy, so the Maintainer may want to recompile it in a Maintainer PR (AR4).
- **Uncommitted changes.** The changes are left uncommitted in the working tree, as the lane runner's rules require, and the runner makes the commit. This deliberately departs from this workflow's commit step.
