---
title: 'Story 1.16: The lane process: one unit from claim to result'
type: 'feature'
created: '2026-10-23'
baseline_revision: 'd04c49b72da6c074745b42b0039471e69a053430'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Every building block exists (snapshot, `next`, ledger edits and the CAS loop, prompt, result schemas, `Agent`, `Sandbox`, clone rebuild), but nothing runs them in order. No process takes one unit from STOP check and claim through a sandboxed session to a validated result, and nothing leaves a ledger state, a journal record, a log and an `outcome` that say what happened (FR3, FR6, FR11, FR22, AR3, AR8, AR10, AR15, AR25).

**Approach:** Add the `LaneStore` port with a filesystem implementation, a journal schema, a pure build-spec cross-check, and `runLaneProcess(deps)` in `src/lane/`. It runs one unit end to end against injected `Forge`, `Agent`, `Sandbox`, `LaneStore`, a `Workspace` (clone preparation) and a `PrStep` (Story 1.16a). Tests drive it with the fake forge, a stub agent, a stub sandbox and a stub workspace.

## Boundaries & Constraints

**Always:**
- **Port** `src/ports/lane-store.ts`, `LaneStore`. Every method is synchronous, never throws, and returns `Result`:
  - `stopMarkers()` returns `{host, lane}` booleans;
  - `writePid(name)` and `clearPid(name)`, for `lane`, `agent` and `wait`;
  - `appendJournal(record)` appends one validated JSON line;
  - `writeOutcome(outcome)` writes the word and a newline;
  - `appendLog(file, text)` returns the log's absolute path, under `logs/`.
- **`createFsLaneStore({laneDir, hostStop})`** lives in `src/lane/lane-store.ts`. The lane folder holds `lane.pid`, `agent.pid`, `wait.pid`, `journal.jsonl`, `outcome`, `STOP` and `logs/` (AR37). `hostStop` is `~/.xarabot/STOP`. Each write creates its parent folder.
- **`laneLayout(laneDir)`** gives `clone/`, `runner.git/`, `vendor/`, `tmp/` (the session temp folder) and `tmp/result.json`.
- **Journal schema** goes in `src/core/schemas/journal.ts` (zod, types inferred). `LaneOutcome` is `progress`, `idle`, `failed` or `stop`. A record is one of two kinds:
  - **Unit record:** `schema_version: 1`, `type: "unit"`, `unit`, `lane`, `generation` (or null), `started_at`, `ended_at`, `duration_ms`, `agent`, `model` and `effort` (the lane's configured values, never the agent's), `tokens` and `cost` (summed over the session's runs from `agent.parseUsage`, or null), `sessions` (the run count), `outcome`, `result` (`done`, `blocked`, `no-op` or null), `state` (the ledger state after, or null), `attempts`, `loopbacks`, `ci_fixes`, `denied_actions`, `reason` (or null) and `log`.
  - **Span record:** `schema_version: 1`, `type: "span"`, `span: "idle"`, `reason` (`next`'s idle reason), `started_at` and `ended_at`.
- **Pure core** `src/core/lane/build-check.ts`:
  - `specMatches(glob, paths)` keeps the paths that match a `Bun.Glob`.
  - `checkBuildSpec(outcome, specText)` maps `done` and `no-op` to `done`, and `blocked` to `blocked`. The spec's frontmatter `status` must equal the mapped status. It must also have a `## Auto Run Result` heading whose section has a `Status: <s>` line (an optional `**` around the label) with `s` equal to the mapped status. Any miss returns `err("invalid")`, naming what differed.
- **`runLaneProcess(deps)`** returns `{outcome}` and writes that outcome to the `outcome` file. In order:
  1. `writePid("lane")`.
  2. If a host or lane STOP marker exists, the outcome is `stop` and nothing else runs.
  3. Take a snapshot and assemble it. `read` takes `.xarabot/**` plus every `.md`, `.yaml` and `.yml` file. The forge reads the ledger, then `main`, then PRs. `assembleSnapshot` re-checks config and the Standing Authority. Then run `next(snapshot, "builder")`.
  4. On `idle`, append an idle span with the reason; the outcome is `idle`.
  5. Re-check STOP before the claim.
  6. Call `listPrsByBranch(<branches.story><id>)`. The newest PR in each state decides:
     - merged: claim, then `markMerged`; outcome `progress`, with no session;
     - open: claim with `adoptPr` (`pr`, `pr_owner` = the lane's owner, `head_sha` = the PR's head, `base_sha` = the snapshot's `main`), and the session starts at `head_sha`;
     - closed or none: claim with `base_sha` = the snapshot's `main`, and the session starts there.
  7. A claim goes through `swapLedger(claim(...))`. A failed precondition (`edit`) runs steps 3 to 6 again, at most 3 rounds. After that the outcome is `failed`, with no record.
  8. When `next` returns `park` (`needs-approval`), apply `parkNew({kind: "needs-approval"})`; outcome `progress`.
- **The session:**
  - Empty `tmp/` first, then `workspace.prepare({unit, branch, start, generation, fetch: [start]})`.
  - Build the prompt with `PACKAGE_TEMPLATE`, mode `build`, the `.xarabot/prompts/*.md` sections from `main`, the Human Live Steps from `loadRepoConfig` on the same snapshot data, and the result path.
  - Launch `agent.launchSpec({kind: "fresh"})` through `sandbox.run`. The profile holds the layout's paths and `repoHosts: config.proxy_hosts`. `onSpawn` writes `agent.pid`; clear it after the run.
  - With no result file and a `sessionId` from `parseUsage`, run once more with `{kind: "resume", sessionId}`.
  - Each run's stdout and stderr go to `logs/<unit-file-id>-<start>.log`. `<start>` is the ISO start time with `:` as `-` and no milliseconds.
- **Result handling.** The result is read with `parseSessionResult(path, text, "build")`. Then the spec file is checked: expand `storySpecGlob(config.story_spec_path, id)`, list the clone's working-tree files (skip `.git/`), and require exactly one match that passes `checkBuildSpec`.
  - Missing, still missing after the resume, invalid, a spec mismatch, a sandbox `refused`, a failed `prepare`, or a budget overrun: `failAttempt` (`released`, `attempts + 1`, or `parked` `attempts-cap` at 3 or more); outcome `failed`.
  - `blocked`: `park({kind: "blocked", reason: blocked.kind})`; outcome `progress`.
  - `no-op`: `park({kind: "blocked", reason: "no-op"})`; outcome `progress`.
  - `done`: call `deps.prStep({unit, record, result, specPath, clone, signal})`. It returns `{outcome, state}`.
- **Budget.** `config.unit_budget_hours` starts at the claim and covers the session and the PR step through one `AbortSignal`. Once it passes, the session is aborted and the unit is released through `failAttempt` under a fresh deadline.
- **Deadlines.** Every forge call gets its own `AbortSignal` deadline: `deps.callTimeoutMs`, default 60 000.
- **Lane-stop conditions.** A ledger `stop` (unknown `schema_version`), from the assembler or from a swap's `edit`, or a forge `auth`, `forbidden` or `uninstalled` error from any call: post `alert(<condition>, <main SHA, or 40 zeros if unknown>)`, ignore whether the alert itself fails, and finish with outcome `stop`. The condition is `ledger-schema-version` or `forge-<kind>`. Any other assembler error or `next` `stop` is outcome `stop` with no alert.
- **Journal.** Every path past a chosen unit appends exactly one unit record. Timings come from `deps.now()` (the host clock, default `Date.now`). Ledger times come from the forge's `now`.
- **`createGitWorkspace({gitDir, clone, fetch})`** in `src/lane/workspace.ts`. It calls `fetch(missing, signal)` only for SHAs not in `runner.git`, then `rebuildClone({..., resumeWip: true})`. `fetch` is injected.

**Never:**
- No commit, push, PR or comment; no PR step body (that is Story 1.16a).
- No CI, review, loopback or merge.
- No heartbeat or takeover (Epic 2).
- No waits, `wait.pid` sleep, usage-limit sleep, `stop --now`, or 3-hour session cap (Story 1.18).
- No CLI entry, launcher or start-refusal table (Story 1.19).
- No GitHub-backed `fetch` implementation.
- No `waiting-on-maintainer` classification.
- No `Bun.spawn` in `src/lane/`.
- No STOP file written by the lane.
- No change to the `Forge`, `Agent` or `Sandbox` ports.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| STOP | host or lane `STOP` present | outcome `stop`; no snapshot, no ledger commit | none |
| Idle | every Story done | idle span with reason; outcome `idle` | none |
| Merged PR | branch has a merged PR | record `merged`; no session | none |
| Open PR | branch has an open PR | `pr`/`head_sha` adopted; session starts at head | none |
| Missing result | session and resume write none | `released`, `attempts` 1, two runs (second a resume) | outcome `failed` |
| Attempts cap | released record with `attempts` 2, failure | `parked` (`attempts-cap`) | outcome `failed` |
| Spec mismatch | `done` result, spec `status: in-review` | `released` | outcome `failed` |
| Spec ambiguous | zero or two `spec-1-1-*.md` | `released` | outcome `failed` |
| Done | valid result, spec `done` | `prStep` called once | its outcome |
| Blocked | `blocked.kind: intent-gap` | `parked` blocked, reason `intent-gap`, `globs_held: []` | outcome `progress` |
| No-op | `outcome: no-op`, spec `done` | `parked` blocked, reason `no-op` | outcome `progress` |
| Schema | ledger record `schema_version: 2` | alert `ledger-schema-version` | outcome `stop` |
| Forge stop | `auth`/`forbidden`/`uninstalled` on a call | alert `forge-<kind>` | outcome `stop` |
| Budget | session outlives the budget | session aborted; `released` | outcome `failed` |
| Lost claim | another lane claims first | `next` again, picks the next Story | none |

</intent-contract>

## Code Map

- `src/ports/forge.ts` -- `Forge`, `isLaneStopKind`, `ForgeError`; `listPrsByBranch`, `alert`, `snapshot({read})`.
- `src/ports/agent.ts`, `src/ports/sandbox.ts` -- `Agent.launchSpec/parseUsage/defaultModel/vendor`, `Sandbox.run(spec, profile, signal, {onSpawn})`, `SandboxProfile`.
- `src/lane/ledger-cas.ts` -- `swapLedger({forge, edit, signal})`; error kinds `edit` (with `.edit` = `stop|precondition|…`), `forge` (with `.forge`), `exhausted`, `deadline`.
- `src/core/ledger/edits.ts` -- `claim` (with `adoptPr`, `expectGeneration`), `markMerged`, `parkNew`, `park`, `failAttempt`; `ATTEMPTS_CAP`.
- `src/core/next/snapshot.ts:58` -- `assembleSnapshot(AssembleInput)`; the error kind `stop` comes from `parseLedger`.
- `src/core/next/next.ts:86` -- `next(snapshot, "builder")` → `unit | park | idle | stop`; `NextStory.expect_generation`, `globs`, `sprint_key`, `infrastructure`, `manifest_sha`.
- `src/core/config/load-repo-config.ts` -- `loadRepoConfig` (gives `humanLiveSteps`), `splitFrontmatter`.
- `src/core/config/story-spec-path.ts` -- `storySpecGlob`.
- `src/core/prompt/build-prompt.ts`, `src/core/prompt/template.ts` -- `buildPrompt`, `PACKAGE_TEMPLATE`.
- `src/core/schemas/session-result.ts` -- `parseSessionResult(path, text, "build")`, `BuildResult`.
- `src/core/schemas/host.ts` -- `Lane` (`agent`, `model`, `effort`); `src/core/schemas/ledger.ts` -- `LaneIdentity`, `UnitRecord`, `unitFileName`.
- `src/lane/clone.ts` -- `rebuildClone`, `needCommit`, `unitFileId`; `src/sandbox/vendor-home.ts:85` -- `removeTree`, `emptyDir`.
- `src/adapters/forge/fake/fake-forge.ts` -- the test forge; `control.trace()`, `alerts()`, `injectError`, `writeForeignLedger`, `ledgerLog()`; PRs via `pushBranch` + `openPr` (+ `enqueue`/`mergeQueueHead`, `closePr`).
- `test/core/next/fixtures.ts` -- the `main` file shapes (config with `manifests.dir: stories`, policy, human-live-steps, Standing Authority, epics.md, manifests). The lane tests need real sprint keys (`1-1-<slug>`) because `buildPrompt` checks them.
- `test/lane/git-fixture.ts` -- `setup`, `commit`, `cleanup` for the git workspace test.
- `test/support/boundaries.ts` -- the layer table; lane may import adapters, sandbox, ports and core; no spawn in lane.

## Tasks & Acceptance

**Execution:**
- `src/core/schemas/journal.ts` -- `LaneOutcome`, `UnitJournalRecordSchema`, `SpanJournalRecordSchema`, `JournalRecordSchema` -- AR25/AR28.
- `src/core/lane/build-check.ts` -- `specMatches`, `checkBuildSpec` -- AR11/AR15 cross-check, pure.
- `src/ports/lane-store.ts` -- `LaneStore`, `PidName` -- AR1 port.
- `src/lane/lane-store.ts` -- `createFsLaneStore`, `laneLayout`, `logFileName` -- the AR37 layout.
- `src/lane/workspace.ts` -- the `Workspace` type and `createGitWorkspace` -- the clone before each session (AR10/AR16).
- `src/lane/lane-process.ts` -- `runLaneProcess`, `LaneDeps`, `PrStep` -- the process.
- `test/core/schemas/journal.test.ts`, `test/core/lane/build-check.test.ts` -- case tables.
- `test/lane/lane-store.test.ts` -- files written where AR37 says; invalid journal record refused.
- `test/lane/workspace.test.ts` -- fetch called only for a missing SHA; the clone at the start SHA (real git).
- `test/lane/lane-process.test.ts` -- one case per matrix row against the fake forge, a stub agent, a stub sandbox and a stub workspace, asserting the ledger record, the journal line, the `outcome` file and the log file.

**Acceptance Criteria:**
- Given a lane start with no STOP, when it runs, then `lane.pid` holds the process PID, and the fake forge's trace shows `ledger`, `main`, `prs` before the claim commit.
- Given a Standing Authority missing on `main`, when the lane starts, then the outcome is `stop` and the ledger has no claim.
- Given any unit that ends, when `journal.jsonl` is read, then it has exactly one unit record that parses against `UnitJournalRecordSchema`, with `outcome` equal to the `outcome` file, and `log` names an existing `logs/<unit-file-id>-<start>.log`.
- Given `bun test`, `bun --bun oxlint` and `bun --bun tsc`, when they run, then each exits 0 and the boundaries test passes.

## Spec Change Log

## Review Triage Log

### 2026-10-23 — Review pass
- verdicts: 32 findings — high 0, medium 8, low 21, false 3, maybe-false 0
- findings:
  - `[medium]` `[patch]` (verification-gap) budget passing during the PR step is untested — cases added: release when the step returns `claimed`; the step's state kept when it moved the unit on.
  - `[medium]` `[patch]` (verification-gap) a forge lane-stop kind from a ledger swap is untested at the lane — `test.each` over `auth`/`forbidden`/`uninstalled` on `ledgerSwap` added.
  - `[low]` `[patch]` (verification-gap) cost `estimate` combining untested — grouped with the estimate fix; mixed-flag cases added.
  - `[low]` `[patch]` (verification-gap) a throwing PR step and the catch-all are untested — grouped with the PR-step release fix; a throwing-PR-step case added.
  - `[medium]` `[patch]` (edge) a throwing `prStep` leaves the unit `claimed` — the catch now releases through `failUnit`.
  - `[low]` `[reject]` (edge) `markMerged` lost/failed right after a claim leaves the record `claimed` — needs another lane to write between two of this lane's swaps; a stale record is taken over (Epic 2); the fix adds a branch.
  - `[low]` `[patch]` (edge) the Halt reason is dropped by `??=` after markMerged fails — grouped with the reason fix; the Halt reason is now appended.
  - `[medium]` `[patch]` (edge) budget passing during the PR step releases a `merging` record without a dequeue — the release now runs only when the step left the unit `claimed`.
  - `[false]` `[reject]` (edge) a claim swap that is ok but writes no record falls back to generation 1 — `claim` never returns `null` (only `markMerged`/`deleteMerged` do) and the written text is the codec's own serialization, so `writtenRecord` cannot return `null` after a claim.
  - `[low]` `[patch]` (edge) a lane stop inside the catch-all's `failUnit` ends `failed`, not `stop` — a caught `Halt` there now sets the outcome.
  - `[medium]` `[patch]` (edge) journal/outcome write failures are ignored — failures now go to the unit log and stderr.
  - `[low]` `[reject]` (edge) a failed `appendLog` makes the journal cite a missing log — needs the log write to fail while the journal write succeeds in the same folder; rare.
  - `[low]` `[reject]` (edge) three lost claim rounds leave no unit record — the spec says so ("outcome `failed`, with no record"); no unit was held.
  - `[low]` `[patch]` (edge) a run with no cost lets the total read exact — `estimate` is now `true` when any run reported no cost.
  - `[low]` `[patch]` (edge) a PR-step-threw reason is overwritten by the budget reason — moot after the PR-step release fix (the throw path returns before the budget branch).
  - `[low]` `[reject]` (edge) a fenced block in `## Auto Run Result` can end the section early — build-auto writes that section as plain lines; fence tracking adds a parser branch for a shape not met.
  - `[low]` `[reject]` (edge) the working-tree walk covers `node_modules` — one walk per unit, seconds at worst; a pruned scan adds code for no wrong result.
  - `[medium]` `[patch]` (blind) the PR step can leave the unit claimed — same root as the throwing-`prStep` row; a step that returns `failed` itself owns its ledger move (Story 1.16a).
  - `[low]` `[reject]` (blind) a Halt after the claim never releases the unit — the lane-stop part is intended (the lane stops; a stale record is taken over in Epic 2); the markMerged part is the rejected edge row above; the swallowed-stop part is patched above.
  - `[medium]` `[patch]` (blind) `forgeNow` falls back to an hours-old forge time — the fallback now advances the last forge `now` by the host-clock time since it was read.
  - `[medium]` `[patch]` (blind) store results ignored — same root as the journal/outcome row; patched there.
  - `[low]` `[patch]` (blind) cost marked exact when a run is missing — same root as the estimate row.
  - `[low]` `[reject]` (blind) `checkBuildSpec` ignores fences — same as the edge fence row.
  - `[low]` `[reject]` (blind) `listWorkingTree` walks everything, including nested `.git` — same as the walk row; a nested `.git` match would need a spec-named file inside it.
  - `[low]` `[reject]` (blind) config and prompt failures come after `prepare` and cost attempts — config already passed in `assembleSnapshot`; a bad `sprint_key` parks the Story at the attempts cap, which surfaces it; reordering saves only a rebuild.
  - `[low]` `[reject]` (blind) lost rounds leave logs, and `lane.pid` stays after exit — the log is harmless; `stop --now` (Story 1.18) checks a PID's start time and command before killing.
  - `[low]` `[patch]` (blind) `??=` drops the stop reason — same root as the edge reason row.
  - `[low]` `[reject]` (blind) a symlinked or unreadable result is reported as missing and costs a resume — still a failed attempt; a separate reason adds a branch for a planted file.
  - `[low]` `[patch]` (blind) tests missing for the cleanup paths — the cases tied to this pass's patches were added; the rest cover rejected rows.
  - `[false]` `[reject]` (intent) no operator entrypoint runs `runLaneProcess` — no AC observes a CLI; the last AC tests against the fake forge and a stub agent; the launcher is Story 1.19.
  - `[low]` `[reject]` (intent) the `no-op` spec-status mapping was decided locally — build-auto has only `done`/`blocked` as finished statuses, so `done` is the one consistent reading (Design Notes).
  - `[false]` `[reject]` (intent) no inbox item for a blocked park — inbox items are rendered from `parked` records by `reconcile` (AD-23), not written by the lane.

## Design Notes

**Adopted PRs.** An open PR's session starts at its head (AD-9: adopt; AD-15: a restart re-reads the PR head), so earlier work is never thrown away. The prompt stays `build`, so build-auto resumes from the spec's status in the clone. `base_sha` is recorded as the snapshot's `main` because the claim schema needs one. Story 1.16a computes the commit's real base (the merge-base of head and `main` in `runner.git`) when it commits.

**`no-op` cross-check.** Build-auto never writes a `no-op` status (spine Deferred). A finished run that changed nothing leaves `status: done`, so `no-op` is checked against `done`.

**Workspace.** The lane depends on a narrow `Workspace` instead of git, so the process can be tested against the fake forge, whose SHAs are not real objects. The git workspace's `fetch` is injected. Wiring the GitHub credential-helper fetch is part of the launcher (Story 1.19).

## Verification

**Commands:**
- `bun test` -- expected: exit 0
- `bun --bun oxlint` -- expected: exit 0
- `bun --bun tsc` -- expected: exit 0

## Auto Run Result

Status: done

**Summary:** `runLaneProcess(deps)` takes one unit from the STOP check and claim, through a sandboxed session, to a validated build result. It then leaves a ledger state, one journal record, a log and the `outcome` file. It checks STOP markers at the start and before the claim. It writes `lane.pid`, then snapshots in the order ledger, `main`, PRs, and re-checks config and the Standing Authority through `assembleSnapshot`. It runs `next`, inspects the branch's PRs (merged → `merged`; open → adopted at its head; closed or none → from `main`) and claims with the CAS loop, running `next` again on a lost claim. The session runs through `Workspace`, `Agent` and `Sandbox` with one resume. The result is validated against the single `story_spec_path` match (frontmatter `status` plus `## Auto Run Result`). The ledger move follows AR8: a failed attempt releases, or parks at 3 attempts; `blocked` and `no-op` park with reasons; `done` goes to the injected `PrStep` (Story 1.16a). An unknown `schema_version` or a forge `auth`, `forbidden` or `uninstalled` error alerts and stops the lane. The unit budget aborts the session and releases the unit.

**Files changed:**
- `src/ports/lane-store.ts`: the `LaneStore` port (PIDs, journal, outcome, logs, STOP markers).
- `src/lane/lane-store.ts`: `createFsLaneStore`, `laneLayout`, `logFileName` (the AR37 lane folder).
- `src/lane/workspace.ts`: the `Workspace` type and `createGitWorkspace` (fetches only missing SHAs, then `rebuildClone` with wip resume).
- `src/lane/lane-process.ts`: `runLaneProcess`, `LaneDeps`, `PrStep`.
- `src/core/schemas/journal.ts`: `LaneOutcome` and the unit and idle-span journal schemas.
- `src/core/lane/build-check.ts`: `specMatches`, `checkBuildSpec` (pure).
- `src/core/ledger/edits.ts`: `claim` takes an optional `baseSha`, so a claim with no PR records `main` as `base_sha`.
- Tests: `test/lane/lane-process.test.ts` (46 cases on the fake forge, stub agent, stub sandbox and stub workspace), `test/lane/lane-store.test.ts`, `test/lane/workspace.test.ts` (real git), `test/core/lane/build-check.test.ts`, `test/core/schemas/journal.test.ts`, and new rows in `test/core/ledger/edits.test.ts`.

**Review findings:** 32 findings: 0 high, 8 medium, 21 low, 3 false.
- **Patched (5 medium entries, plus 6 low rows):**
  - A throwing PR step now releases the unit.
  - The budget release after the PR step runs only on a still-`claimed` unit, so a `merging` record is never released without a dequeue.
  - A lane stop inside the cleanup ends `stop`.
  - Halt reasons are appended, not dropped.
  - Store write failures go to the log and stderr.
  - `estimate` is true when any run reported no cost.
  - The `forgeNow` fallback advances the last forge time by the host clock.
  - Tests were added for the budget during the PR step (both branches), lane-stop kinds on `ledgerSwap`, a throwing PR step, and mixed cost flags.
- **Deferred:** none.
- **Rejected:** 15 low and 3 false, each with its reason in the Review Triage Log. Among them: fenced code in the spec section, the full working-tree walk, markMerged lost right after a claim, no operator entrypoint (Story 1.19), and the inbox item (rendered by `reconcile`).

**Follow-up review recommended:** true. Five medium entries were patched. The named unverified risk: the patched `forgeNow` fallback (forge time plus host-clock elapsed) and the `Halt` raised inside the unexpected-error cleanup have no test, and the patched cleanup paths were not reviewed again.

**Verification:**
- `bun install` made no changes.
- `bun test`: 2053 pass, 61 skip, 0 fail, boundaries test included.
- `bun --bun oxlint` and `bun --bun tsc` exit 0.
- Every row of the I/O matrix has a test that ran and passed.

**Residual risks:**
- Nothing runs `runLaneProcess` yet. The launcher (Story 1.19) must wire the GitHub forge, the `claude` agent, the macOS sandbox and a credential-helper `fetch` for `createGitWorkspace`.
- For an adopted PR, `base_sha` is the snapshot's `main`. Story 1.16a must commit against the merge-base of head and `main`.
- An Infrastructure Story with a released record and no matching approval: `next` returns `park`, and `parkNew` always fails because a record exists. The lane then fails 3 rounds on every run (this comes from the existing edits).
- The boundaries checker has no `Bun.spawn` ban for `src/lane/`. The new lane code does not spawn.
- Usage-limit sleeps, waits, the 3-hour session cap and heartbeats are not here (Story 1.18, Epic 2).
