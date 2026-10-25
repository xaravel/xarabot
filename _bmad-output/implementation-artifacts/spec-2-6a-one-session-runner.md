---
title: 'Story 2.6a: One session runner'
type: 'refactor'
created: '2026-10-24'
baseline_revision: '31bab27085f1fb9fe3643847285c42f0baa0a732'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      Small helpers are still copied across src/lane and src/cli: `message(e)`, `DEFAULT_CALL_TIMEOUT_MS` and the `reportStore` closures.
    evidence: |-
      `function message` is still declared in heartbeat.ts, merger.ts, wait.ts, committer.ts, diff-paths.ts, runner-install.ts and reconcile-commit.ts. `DEFAULT_CALL_TIMEOUT_MS = 60_000` is in ledger-cas.ts, stop.ts and src/cli/lane-install.ts. The lane and coordinator `reportStore` closures differ (only the lane one writes to stderr). These predate Story 2.6a, and its AC does not name them (retro D3's wider list).
    location: >-
      src/lane/stop.ts, src/cli/lane-install.ts, src/lane/{heartbeat,merger,wait,committer,diff-paths,runner-install,reconcile-commit}.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** The session machinery is inside `runLaneProcess`'s `work` closure in `src/lane/lane-process.ts`, which is 1,344 lines long. The step helpers are copied, with drift, into `lane-process.ts`, `coordinator-process.ts`, `pr-step.ts`, `ci-step.ts`, `merge-step.ts` and `reconcile-step.ts`. Two-file import cycles run through `lane-process.ts`, and the boundary test does not detect cycles. Stories 2.7 and 2.9 and Epic 3's reviews would each need a copy of the runner (F19, retro D1–D3 and item 11; AR1, AR3, AR23).

**Approach:**
- Move the session runner, the step helpers and the shared lane types into one new module, `src/lane/session.ts`. The lane process, the coordinator process and the four steps all use it.
- Break every import cycle in `src/lane`.
- Teach the boundary test to find import cycles.
- Keep behavior the same, apart from the one documented choice where the copies differ (Design Notes).

## Boundaries & Constraints

**Always:**
- `src/lane/session.ts` is the only declaration site in `src/` of:
  - the session runner: prepare (empty `tmp`, `workspace.prepare`), the sandboxed run under the unit budget, the session limit, the keeper signals and the result-linger kill (`RESULT_LINGER_MS`, 5 min after the result file is first seen), the fresh run plus one resume, the usage-limit sleep loop with its `usage-limit` span, and the result read and `parseSessionResult` for a given `ResultKind`;
  - the step helpers `call`, `swap`, `forgeNow`, `laneStop`, `held`, `beat` and the `End` class.
- `runLaneProcess` and `runCoordinatorProcess` both import from it, and so do the PR, CI, merge and `reconcile` steps.
- The runner takes the prompt, the result kind and the unit's track as inputs. It holds no Story-specific logic (spec pick, `ci-fix` log, lockfile paths), so Story 2.7's planning sessions can call it with `kind: "planning"`.
- **One behavior where the copies differ:** a forge call whose port method throws is a `transient` error, in the processes as well as in the steps. The processes used to let the throw escape as an "unexpected error".
- `src/lane` has no import cycle, type-only imports included. The boundary test checks the real tree, and fails on a fixture cycle.
- `test/lane/lane-process.test.ts` stays byte-identical and passes. Every other existing test passes. Change an existing test only where it imports a name that moved, and change only that import line.
- Names that tests and `src/cli` import from `lane-process.ts` stay importable from it, as re-exports: `readsPath`, `CI_FIX_LOG`, `LaneProcessResult`, `PrStep`, `PrStepInput`, `PrStepOutput` and `SessionLimits`.
- Every log line, journal record, ledger edit, reason text and outcome stays the same, apart from the `transient` row in the matrix and the coordinator's switch to the shared track helpers: an `abandoning the unit` log line when its unit keeper ends (`checkHeld`), and `failUnit` reading a fresh forge time, checking the keeper first and setting the reason as the lane process does.

**Never:**
- No new behavior: no model check (Story 2.6b), and no coordinator planning or retro session wiring (Stories 2.7 and 2.9).
- No ledger schema, journal schema, port, CLI or doc change.
- No change to `.github/`, `AGENTS.md`, `_bmad/`, the spec folder, `standing-authority.md` or anything under `src/core/`, `src/ports/`, `src/adapters/` or `src/sandbox/`.
- Do not merge the steps' own policies into the module: `aborted` and `overBudget`, `parkBlocked`, `leaveMerging`, `item` and `merged` stay in their steps.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Real tree | `src/lane/*.ts` after the change | `laneCycles` → `[]` | none |
| Two-file cycle | `a.ts` imports `./b.ts`; `b.ts` imports `./a.ts` | one cycle, `["a.ts", "b.ts", "a.ts"]` | none |
| Type-only cycle | `a.ts` has `import type { X } from "./b.ts"`; `b.ts` imports `./a` (no extension) | one cycle | none |
| Three-file cycle | a → b → c → a, through `export * from` and `await import()` | one cycle | none |
| Self import | `a.ts` imports `./a.ts` | `["a.ts", "a.ts"]` | none |
| Acyclic | a → b, a → c, b → c; plus `../core/x.ts` and `zod` imports | `[]` | none |
| Unresolved | `a.ts` imports `./missing.ts` | `[]` (not a cycle) | none |
| Process call throws | lane process: `forge.listPrsByBranch` throws `boom` | run `failed`, reason contains `listPrsByBranch transient: listPrsByBranch threw: boom` | none |
| Step kit `call` throws | the kit's `call("x", …)` with a throwing run | `{ ok: false, error: { kind: "transient", message: "x threw: …" } }` | none |
| Lane-stop kind | `call` gets `auth` | alert `forge-auth` at the kit's main SHA (else the zero SHA), then `End` `stop` with the record's state; the reason is pushed | alert failure ignored |
| `held` lost / failed | `held("park", edit)`: precondition / deadline | lost: `End` `failed`, state `null`, reason `park: unit lost: …`; failed: `failAttempt`, `End` `failed` with the released state | none |
| `beat` | `beat("fence", { passed_sha })` | a heartbeat at the kit's generation with `set`; the record is read back; `lastBeat` advances | as `held` |
| Unexpected throw | the steps body throws `Error("x")` | one `failed("unexpected error: x")`; never throws | a throw inside it → `failed`, state `null` |

</intent-contract>

## Code Map

The baseline is `31bab27`. Every line number below is at that commit.

- `src/lane/session.ts` (new). Header doc: the module and who uses it (lane process, coordinator process, PR, CI, merge and `reconcile` steps; later Stories 2.7 and 2.9 and Epic 3). It holds:
  - **Moved as they are:**
    - from `lane-process.ts`: `MAX_CLAIM_ROUNDS` (l.90), `ZERO_SHA`, `readsPath` with `UNREAD_TREES` (l.208–214), `CI_FIX_LOG`, `PrStepInput`, `PrStepOutput` and `PrStep` (l.95–124), `SessionLimits` (l.169), `LIMIT_STOP_REASON`, `LaneProcessResult`, `Halt`, `Abandon` and `MarkerStop` (l.189–202), `readRegular` (l.282) and `message`;
    - `checkStop(store)` (lane-process l.376, coordinator l.236).
  - `StepOutput = PrStepOutput & { readonly ejected?: true }`. `merge-step.ts` l.42 `MergeStepOutput` becomes an alias of it.
  - **`forgeClock(clock, seed?)`:**
    - `see(now)` records a forge time and the host time it was seen.
    - `forgeNow()` returns the last forge time plus the host time since, or the host time if no forge time has been seen.
    - It replaces lane-process l.305–312 and l.384–387, coordinator l.191–199 (seeded with the claim's `heartbeat_at`), and the `base` and `forgeNow` pairs in the four steps (`reconcile` is seeded with `snapshot.now`).
  - **`forgeOps({ forge, callTimeoutMs, sleep?, random?, clock, alertSha, stop })`:**
    - `call(operation, run)` uses its own deadline. A throw becomes `transient`, `"<operation> threw: <message>"`. A lane-stop kind goes to `laneStop("forge-<kind>", "<operation>: <message>")`.
    - `swap(edit, unit)` returns `{ kind: "ok", record: writtenRecord(commit, unit) } | { kind: "lost" | "failed", message }`, with the same mapping as lane-process l.429–443.
    - `laneStop(condition, why)` sends a best-effort `forge.alert(condition, alertSha() ?? ZERO_SHA)`, then calls `stop(condition, why)`, which throws.
    - `freshNow()` is lane-process `forgeNow` (l.390): a snapshot through `call`, then `see`, else `clock.forgeNow()`.
  - **`stepKit({ name, forge, identity, record, log, clock, callTimeoutMs, sleep?, random?, seen?, mainSha?, beforeFail? })`**, built on `forgeClock` and `forgeOps`. It has:
    - mutable `record` and `mainSha`;
    - `reasons`, `generation` (from the input record) and `lastBeat`;
    - `note` (`"<name>: "` prefix, swallows log throws);
    - `see`, `forgeNow`, `end(outcome, state, extra?)` and `End`;
    - `laneStop`, whose `stop` pushes `"<condition>: <why>"`, notes `stop: …` and throws `end("stop", record.state)`;
    - `call`;
    - `swap(edit)`, which adopts a non-null written record for the kit's unit;
    - `failed`, which runs `beforeFail` first and then `failAttempt` at `generation` (pr-step l.205–216);
    - `lost`, `held`, `beat(what, set?)` (merge-step's `lastBeat`, l.230–234, moves into the kit);
    - `run(body)`, the shared catch wrapper (pr-step l.351–363).
  - **The unit track**, shared by both processes:
    - `UnitTrack` is lane-process l.221 minus `story` and `result`, plus `unit: string`.
    - `addReason`.
    - `checkHeld(t, keeper)` (lane-process l.411).
    - `held(t, make, what)` and `failUnit(t, reason)` (lane-process l.446–472, with `freshNow`), taking `forgeOps`, `identity`, `note` and the keeper getter.
    - `journalUnit` (lane-process l.474–521), with the lane's `agent`, `model` and `effort` and an optional build `result`.
    - **The session runner**, `createSessionRunner(deps)` with `agent`, `sandbox`, `store`, `workspace`, `waiter`, `layout`, `settings`, `limits`, `clock`, `note`, `log` and `reportStore`. Its per-unit context has `track`, `branch`, `profile`, `budget`, `overBudget`, `signals()` (the keeper signals), `checkHeld()` and `onLimitStop()`. It exposes:
    - `prepare(ctx, at)` (lane-process l.581);
    - `sandboxed(ctx, spec)` (l.613);
    - `logRun` (l.322);
    - `session(ctx, { at, kind, prompt })`, which is `runOnce`, `sessionRuns`, `usageLimitSleep` and the result parse (l.647–840). Here `prompt()` runs after `prepare` and returns `{ ok: true, value } | { ok: false, reason }`. The result is `{ ok: true, result: SessionResultOf<K> } | { ok: false, reason }`. On a `stopped` wait it awaits `onLimitStop()` and fails with `LIMIT_STOP_REASON`. Token and cost totals are added to `track` as at l.662–678.
- `src/lane/ledger-cas.ts` -- now home to `writtenRecord` (lane-process l.242) and `DEFAULT_CALL_TIMEOUT_MS`, so `heartbeat.ts` no longer imports `lane-process.ts`. `session.ts` imports types from `heartbeat.ts`; `heartbeat.ts` must never import `session.ts`.
- `src/lane/lane-process.ts`:
  - Keeps `LaneDeps`, the claim loop, `sweepMerged`, the takeovers, `decidePr` and `listWorkingTree`.
  - The builder prompt (l.714–740, as the runner's `prompt` callback, including the `ci-fix` log write).
  - The spec pick (l.842–864), `ciSession`, `regenerate` (built on `prepare`, `sandboxed` and `logRun`), `settle`, `build`, `mergeRound` and the CI and merge loop.
  - `BuilderTrack = UnitTrack & { story; result }`.
  - Re-exports the names listed in Boundaries. Update the header doc.
- `src/lane/coordinator-process.ts`:
  - Delete its copies (`Halt`, `MarkerStop`, `message`, `ZERO_SHA`, `call`, `swap`, `laneStop`, `checkStop`, `estimatedNow`, `checkUnit`, `failUnit`, the inline journal record, `Swapped`, `Track`).
  - Use the module's versions. Its unexpected-error path calls `failUnit` only when `t.state === "claimed"`.
  - Import `MAX_CLAIM_ROUNDS`, `readsPath`, `LaneProcessResult` and `PrStepOutput` from `session.ts`, never from `lane-process.ts`.
  - `checkClaim` and the `coordinator.json` keeper stay.
- `src/lane/pr-step.ts`, `ci-step.ts`, `merge-step.ts`, `reconcile-step.ts`:
  - Replace the local `End`, `message`, `ZERO_SHA`, `note`, `end`, `forgeNow`, `laneStop`, `call`, `swap`, `failed`, `lost`, `held`, `beat` and the catch wrapper with one `stepKit` per invocation. The names are `"PR step"`, `"CI step"`, `"merge step"` and `"reconcile step"`.
  - Merge-step's `beforeFail` is `leaveMerging`. `leaveMerging`'s fence uses `kit.swap` directly, as now.
  - Import from `session.ts` and `ledger-cas.ts`, never from `lane-process.ts`.
- `src/lane/heartbeat.ts` -- imports from `ledger-cas.ts`. Rename its keeper-internal `swap` (l.137, which returns the raw outcome and never alerts) to `trySwap`.
- `test/support/boundaries.ts` -- add the pure `findCycles(graph: ReadonlyMap<string, readonly string[]>): string[][]`, where each cycle is listed from its smallest file and closes on it, and the cycles are sorted. Also add `laneGraph(files: Record<path, source>)`, using `strip` and `importsOf`: relative specifiers resolved within the same directory, a missing `.ts` appended, unresolved names dropped. Add `laneCycles(root)`, which reads `src/lane/*.ts`.
- `test/boundaries.test.ts` -- a `describe("import cycles in src/lane")` with every cycle matrix row. Add a copy guard: no file under `src/lane` other than `session.ts` declares a function named `call`, `swap`, `forgeNow`, `laneStop`, `held` or `beat` (`function <name>`, or `const`/`let <name> =` an arrow or `async` arrow, generic or not), or a `class End`. A plain value such as `stop.ts`'s `const held = [...]` is not a match.
- `test/lane/session.test.ts` (new) -- the step-kit and `forgeOps` matrix rows against the fake forge (`createFakeForge`, `injectError`, `beforeSwap` as in `test/lane/merge-step.test.ts:368`).
- `test/lane/lane-process.test.ts` -- read-only. The "Process call throws" row goes in `test/lane/session.test.ts`, with a minimal `runLaneProcess` harness modelled on `test/lane/pr-step.test.ts`.

## Tasks & Acceptance

**Execution:**
- `src/lane/ledger-cas.ts` -- take `writtenRecord` and `DEFAULT_CALL_TIMEOUT_MS` -- breaks the heartbeat cycle.
- `src/lane/session.ts` -- the module as in the Code Map -- the one runner and helper set (AC 1).
- `src/lane/lane-process.ts`, `src/lane/coordinator-process.ts` -- use the module and delete the copies -- AC 1.
- `src/lane/{pr-step,ci-step,merge-step,reconcile-step}.ts` -- `stepKit` -- AC 1, no cycle.
- `src/lane/heartbeat.ts` -- imports and the `trySwap` rename -- no cycle.
- `test/support/boundaries.ts`, `test/boundaries.test.ts` -- the cycle finder and the copy guard -- AC 2.
- `test/lane/session.test.ts` -- the kit and process rows of the matrix.

**Acceptance Criteria:**
- Given `runLaneProcess` in `src/lane/lane-process.ts`, when the Story is done, then:
  - the session runner (prepare, the sandboxed run, the one resume, the usage-limit sleep, the kill 5 minutes after the result file appears, the result parse) and the step helpers (`call`, `swap`, `forgeNow`, `laneStop`, `held`, `beat`, `End`) are in `src/lane/session.ts`;
  - the lane process and the coordinator process both use that module;
  - no other copy of them remains.
- Given the `src/lane` imports, when the boundary test runs, then no import cycle remains in `src/lane`, and the test fails on one.
- Given the existing lane-process tests, when they run, then they pass unchanged (`git diff 31bab27 -- test/lane/lane-process.test.ts` is empty).
- Given `bun --bun oxlint` and `bun --bun tsc`, when they run, then both exit 0.

## Spec Change Log

## Review Triage Log

### 2026-10-24 — Review pass
- verdicts: 27 findings — high 0, medium 0, low 24, false 3, maybe-false 0
- findings:
  - `[false]` `[reject]` (blind 1) `epic-2-context.md` is edited outside the Story's scope. — It is the workflow's epic-context recompile (step 1), not Story code: the planning artifacts were newer than the cached file. The spec's "no doc change" covers `docs/`. The runner's write check reverts a builder's change to the Epic context file anyway.
  - `[low]` `[patch]` (blind 2) `stepKit.beat` takes the merge step's `lastBeat` before the swap, not after it, so a slow swap makes the next queue heartbeat come early. — The merge step sets `kit.lastBeat = clock()` after each `beat` again, as before `31bab27`. The kit is unchanged, so the PR step's clock reads stay the same.
  - `[low]` `[reject]` (blind 3) The coordinator gains an unlisted `stopping the lane: heartbeat: …` log line. — Real, but it is one harmless extra unit-log line, and the only fix would be an edit to this spec.
  - `[low]` `[reject]` (blind 4) The coordinator's `failUnit` sets state `null` when the track has no record yet, and it replaces the reason instead of appending. — This is reachable only through a non-`Halt` throw between track creation and the claim of a stale `claimed` record, a forge contract violation. The lane process already behaves this way, which is the unification this Story asks for.
  - `[low]` `[patch]` (blind 5) None of the coordinator's changed behavior is tested. — New coordinator tests cover the fresh forge stamp and journal reason on a throwing step, and the unexpected-error branch.
  - `[low]` `[patch]` (blind 6) The runner's generic `ResultKind` path is never tested directly. — New `session.test.ts` cases drive `createSessionRunner().session` with `kind: "planning"`, and with a prompt that fails.
  - `[low]` `[reject]` (blind 7) The copy guard misses typed-annotation and method forms, and other names (`failed`, `checkHeld`, `Halt`…). — It covers the seven names AC 1 lists, in the form every deleted copy used. Widening the regex adds complexity against an unlikely form.
  - `[low]` `[defer]` (blind 8) Other copies remain: `message` in 7 more lane files, `DEFAULT_CALL_TIMEOUT_MS` in `stop.ts` and `cli/lane-install.ts`, and the two `reportStore` closures. — These predate this Story, and AC 1 does not name them. Deferred.
  - `[low]` `[reject]` (blind 9) `session.ts` has two `held` and two `swap`, with different contracts. — They are methods of different objects with different signatures, so `tsc` keeps them apart, and each is documented. Renaming them is churn with no named breakage.
  - `[low]` `[patch]` (blind 10) The coordinator journal passes no `sessions`, `tokens` or `cost`. `JournalEntry.result` is build-only. — The coordinator now passes the track's `sessions`, `tokens` and `cost`. The result typing is Story 2.7's decision, since it adds the first non-build session.
  - `[low]` `[reject]` (blind 11) The profile, budget and `onLimitStop` setup stays in `lane-process.ts`. — Each is a few lines that depend on the unit kind's config and release rule. Sharing them now would be a guess at Story 2.7's needs.
  - `[low]` `[patch]` (blind 12) `laneGraph` drops `../lane/x.ts` and `./x.js` specifiers, so a cycle written that way passes. — Relative specifiers now resolve against the file's directory and are kept when they land in `src/lane`. `.js` maps to `.ts`. Two fixture rows were added.
  - `[low]` `[patch]` (edge 1) A sibling import through `../lane/x.ts`, `.js` or an index path is missed by `laneCycles`. — Same root cause as blind 12. Patched there. `src/lane` has no subdirectories, so index paths cannot occur.
  - `[low]` `[reject]` (edge 2) The copy-guard regex misses typed arrows, function expressions and `var`. — Same root cause as blind 7.
  - `[low]` `[reject]` (edge 3) `forgeOps.swap` does not catch a throw inside `swapLedger`, so the "throw is transient" claim does not hold for swaps. — The spec states the rule for `call`. Swaps behave exactly as both old copies did (neither wrapped them), and the forge port never throws by contract.
  - `[low]` `[reject]` (edge 4) The coordinator writes new `stopping the lane`, `failed:` and `failAttempt:` log lines. — Same root cause as blind 3.
  - `[low]` `[reject]` (edge 5) A track with no record journals state `null`, where it used to keep `claimed`. — Same root cause as blind 4.
  - `[low]` `[patch]` (edge 6) The merge step's queue-heartbeat baseline moved before the swap. — Same root cause as blind 2. Patched there.
  - `[low]` `[patch]` (verification-gap 1) The coordinator's `failUnit` fresh stamp has no test (pre-verified). — Same root cause as blind 5. A new test asserts `heartbeat_at` equal to the forge's `now`, and the journal reason.
  - `[low]` `[patch]` (verification-gap 2) The coordinator's new unexpected-error branch has no test (pre-verified). — Same root cause as blind 5. New tests cover it.
  - `[low]` `[patch]` (verification-gap other) `beat`'s `lastBeat` timing changed without a note. — Same root cause as blind 2.
  - `[false]` `[reject]` (intent 1) The coordinator uses the module, but not the runner itself. — AC 1 says "one `src/lane` module that the lane process and the coordinator process both use", and the coordinator does use it. Coordinator sessions are Stories 2.7 and 2.9, as `epics.md` says.
  - `[low]` `[patch]` (intent 2) The runner has no direct test. — Same root cause as blind 6.
  - `[low]` `[reject]` (intent 3) The copy guard is narrower than "no other copy". — Same root cause as blind 7. A grep found no session machinery outside `session.ts`.
  - `[low]` `[patch]` (intent 4) `laneGraph` reads only `./` edges. — Same root cause as blind 12.
  - `[low]` `[patch]` (intent 5) The coordinator's behavior changes are untested. — Same root cause as blind 5.
  - `[false]` `[reject]` (intent 6) The `epic-2-context.md` edit is outside the manifest's globs. — Same root cause as blind 1.

## Design Notes

- **One choice where the copies differ** (retro D3). `call` turned a throw into `transient` in the steps but let it escape in the processes. The forge port never throws by contract, so the steps' guard is kept everywhere. `forgeNow` was async in the lane process (it read a snapshot) and synchronous in the steps. Both stay, under two names: `forgeNow` for the estimate and `freshNow` for the read, because the lane-process tests pin the freshly read stamps.
- **Why two levels.** Processes end through `Halt`, and steps end through `End` with a `PrStepOutput` (retro D5 accepts both for 0.x). Both levels use the same `forgeOps`. Only `stop` differs: the processes pass `throw new Halt("stop", …)`, and the kit passes the push-and-`end` version.
- **The cycle rule counts `import type`**, so the graph is acyclic on the page and not just at runtime. The types that `ci-step` and `merge-step` took from `lane-process` therefore live in `session.ts`.
- **Shared runner call shape** (sketch):
  ```ts
  const ran = await runner.session(ctx, { at, kind: "build", prompt: () => builderPrompt(ciLog) });
  if (!ran.ok) return fail(ran.reason);   // LIMIT_STOP_REASON after onLimitStop()
  t.result = ran.result;                   // then the builder's spec pick
  ```

## Verification

**Commands:**
- `bun test` -- expected: 0 fail (sandboxed, the socket-binding and emulator cases report skipped)
- `bun test test/boundaries.test.ts test/lane test/cli` -- expected: 0 fail
- `git diff 31bab27 -- test/lane/lane-process.test.ts` -- expected: empty
- `grep -nE '\b(const|let) (call|swap|forgeNow|laneStop|held|beat) = (async )?(<[^>]*> *)?\(|\bfunction (call|swap|forgeNow|laneStop|held|beat)\b|class End\b' src/lane/*.ts` -- expected: matches only in `src/lane/session.ts`
- `bun --bun oxlint` -- expected: exit 0
- `bun --bun tsc` -- expected: exit 0

## Auto Run Result

Status: done

**Summary.** The session runner and the step helpers now live in one module, `src/lane/session.ts`:
- **The session runner** covers prepare, the sandboxed run under the unit budget and session limit, the kill 5 minutes after the result file appears, the fresh run plus one resume, the usage-limit sleep and its span, and the result parse for any `ResultKind`.
- **The step helpers** are `forgeClock`, `forgeOps` (`call`, `swap`, `laneStop`, `freshNow`), `stepKit` (`End`, `held`, `beat`, `failed`, `lost`, `run`), and the unit track (`checkHeld`, the track's `held`, `failUnit`, `journalUnit`).

Who uses it:
- The lane process uses the runner and the helpers.
- The coordinator process, and the PR, CI, merge and `reconcile` steps, use the helpers.
- No other copy remains.

Other changes:
- `src/lane` has no import cycle, type-only imports included. The boundary test finds cycles and has a copy guard for the named helpers.
- `test/lane/lane-process.test.ts` is unchanged.
- One documented choice where the old copies differed: a forge call that throws is `transient` in the processes too, as it already was in the steps.

**Files changed:**
- `src/lane/session.ts` (new): the runner, the helpers, the shared lane types and the `Halt` family.
- `src/lane/lane-process.ts`: down from 1,344 to 919 lines. It keeps the claim loop, the takeovers, the builder prompt, the spec pick, `regenerate` and the PR, CI and merge sequence. It re-exports its old public names.
- `src/lane/coordinator-process.ts`: its copies are gone. It uses the shared forge ops, the track helpers and the journal, and passes the track's sessions, tokens and cost to the journal.
- `src/lane/{pr-step,ci-step,merge-step,reconcile-step}.ts`: each uses one `stepKit`. The merge step's `beforeFail` is `leaveMerging`, and it reads the clock after each beat as before.
- `src/lane/ledger-cas.ts`: now home to `writtenRecord` and `DEFAULT_CALL_TIMEOUT_MS`.
- `src/lane/heartbeat.ts`: imports only `ledger-cas.ts`, and its internal swap is renamed `trySwap`.
- `test/support/boundaries.ts` and `test/boundaries.test.ts`: `findCycles`, `laneGraph` and `laneCycles`, plus the cycle rows and the copy guard. Only the existing import line changed.
- `test/lane/session.test.ts` (new): the `forgeOps`, step-kit, `forgeClock` and runner (`planning` kind, failed prompt) cases, and the lane process's throwing forge call.
- `test/lane/coordinator-process.test.ts`: new cases for the shared track helpers. No existing case was edited.
- `_bmad-output/implementation-artifacts/epic-2-context.md`: recompiled for the 2026-10-25 Story 2.6 decisions.

**Review findings:** 27 findings. By verdict: high 0, medium 0, low 24, false 3.
- **Patched, 5 entries, all low:**
  - the merge step's `lastBeat` timing (blind 2, edge 6, verification-gap other);
  - coordinator tests (blind 5, verification-gap 1–2, intent 5);
  - direct runner tests (blind 6, intent 2);
  - the coordinator journal's usage fields (blind 10);
  - `laneGraph` specifier resolution (blind 12, edge 1, intent 4).
- **Deferred, 1:** the small helpers still copied across `src/lane` and `src/cli` (blind 8).
- **Rejected, with the reasons recorded in the Review Triage Log:**
  - the epic-context recompile is a workflow artifact (blind 1, intent 6, both false);
  - the coordinator's added log lines are harmless, and the only fix is a spec edit (blind 3, edge 4);
  - a coordinator track with no record is unreachable under the forge contract and matches the lane process (blind 4, edge 5);
  - the copy-guard regex forms are unlikely (blind 7, edge 2, intent 3);
  - the two `held` and `swap` contracts are typed apart (blind 9);
  - sharing the profile and budget setup now would be a guess at Story 2.7's needs (blind 11);
  - throws inside a swap behave as both old copies did (edge 3);
  - the coordinator uses the module, which is what AC 1 says (intent 1, false).

**Follow-up review recommended:** false. Patched entries by verdict: high 0, medium 0, low 5.

**Verification:**
- `bun test` (`XARABOT_SANDBOXED=1`): 3360 pass, 269 skip, 0 fail. The baseline before the change was 3309 pass, 269 skip, 0 fail.
- `bun test test/boundaries.test.ts test/lane test/cli`: 0 fail.
- `git diff 31bab27 -- test/lane/lane-process.test.ts`: empty.
- The Verification grep matches only `src/lane/session.ts` (9 matches).
- `bun --bun oxlint`: exit 0.
- `bun --bun tsc`: exit 0.
- Matrix audit: every I/O row has a covering test that ran and passed. The JUnit output for `test/boundaries.test.ts` and `test/lane/session.test.ts` shows no skips.
- `laneCycles` against the baseline tree reports 3 cycles: `ci-step`↔`lane-process`, `heartbeat`↔`lane-process` and `lane-process`↔`merge-step`. It reports none now.

**Not committed:** the run's instructions say to leave the changes in the clone's working tree for the runner, so the finalize commit was skipped and the tree is intentionally dirty.

**Residual risks:**
- The coordinator now uses the lane process's track semantics: a fresh forge time on `failUnit`, the keeper check first, the reason replaced, and extra unit-log lines.
- Throws inside a ledger swap still escape as an unexpected error (unchanged).
- The copy guard matches only the declaration forms the old copies used.
