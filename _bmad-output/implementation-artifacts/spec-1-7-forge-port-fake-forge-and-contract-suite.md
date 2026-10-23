---
title: 'Story 1.7: `Forge` port, fake forge and contract suite'
type: 'feature'
created: '2026-10-22'
status: 'done'
baseline_revision: 'd7fa1d74391477e8559a3a0c21ab7e81d244e9f1'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      A ledger swap whose write lands just before its deadline returns transient, and the CAS retry then reports a precondition failure on the lane's own claim.
    evidence: |-
      The fake applies nothing on an aborted call, so this cannot happen today. A real HTTP adapter can have PATCH git/refs land after the deadline passes.
      Settle it in Story 1.8: check what the GitHub adapter returns for a swap that was aborted mid-request, and whether swapLedger needs an idempotency check (is the intended record already on the re-fetched tip?).
    location: >-
      src/lane/ledger-cas.ts
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** Lane, claims and merge code (Stories 1.8–1.17a, Epic 2) needs one `Forge` port to code against, a way to test it without GitHub, and one shared contract that every forge adapter must pass (FR24, AR1, AR28, AR33). The compare-and-swap retry loop over pure ledger edits (AR7) has no home yet.

**Approach:** Declare the `Forge` port in `src/ports/forge.ts` with typed errors and an `AbortSignal` deadline on every call. Add an in-memory fake forge in `src/adapters/forge/fake/`, a reusable contract suite in `test/contracts/` that the fake passes (and Story 1.8's GitHub adapter will reuse through a harness), and the CAS retry loop in `src/lane/ledger-cas.ts`.

## Boundaries & Constraints

**Always:**
- **Operations** (all `async`, each takes `opts: {signal: AbortSignal}` as its last argument, each returns `ForgeResult<T>` = `{ok:true,value}|{ok:false,error:ForgeError}` and never throws):
  - `snapshot(opts & {read?: (path) => boolean})` → `{now, ledger: {tip, files}, main: {sha, tree, files, blob_shas}, prs}`. It reads the ledger tip and files first, then `main` (tree listing, blob SHA per path, contents of the paths `read` accepts; default none), then the PR state (`{number, state, head_sha}`) of every unit record whose `pr` is set, keyed by unit id. `now` is the forge's server time. `ledger.files` and `main` are shaped to feed `assembleSnapshot` directly.
  - `ledgerSwap(oldSha, commit: LedgerCommit, opts)` → `{tip}`. Fast-forward only: the tip must still be `oldSha`, else `conflict`. Applies `writes` and `deletes` in one new commit.
  - `pushBranch(lease: {branch, expected_sha: GitSha | null, sha}, opts)` → `{sha}`. `expected_sha: null` means the branch must not exist. A remote head other than `expected_sha` is `conflict`.
  - `openPr({branch, base, title, body})`, `updatePr(number, {title?, body?})`, `closePr(number)` → `ForgePr`; `listPrsByBranch(branch)` → every PR on the branch in any state, ascending by number. `ForgePr` = `{number, branch, base, state: open|closed|merged, head_sha, title, body}`. Opening on a missing branch is `not-found`; a second open PR on one branch is `conflict`; updating or closing a merged PR is `conflict`.
  - `comment(pr, body)` → `{id}`: posts `body` verbatim as one comment on PR `pr`.
  - `checks(sha)` → `{checks: {name, status: queued|in_progress|completed, conclusion: string|null}[]}`; an empty list means pending.
  - `enqueue(pr, expectedHead)` → `{queued: true}`; the PR must be open and its head must equal `expectedHead`, else `conflict`. Enqueueing an already-queued PR is `ok`. `dequeue(pr)` → `{queued: false}`, `ok` when not queued.
  - `alert(condition, mainSha)` → `{posted: boolean}`: the first call for a (condition, `mainSha`) pair posts; a repeat posts nothing.
  - `prefetch({kind: "ci-log", sha, dir})` → `{files}`: writes the failing checks' logs for `sha` into `dir`, one file per check, returning their absolute paths.
  - No approve, merge, admin-merge, auto-merge or branch-delete operation exists.
- **Errors:** `ForgeError` kinds are exactly `conflict`, `not-fast-forward`, `auth`, `forbidden`, `rate-limited` (carrying `retry_after`, whole seconds ≥ 0), `not-found`, `uninstalled`, `transient`, each with a `message`. Export `FORGE_ERROR_KINDS`, the lane-stopping kinds (`auth`, `forbidden`, `uninstalled`) and the back-off kinds (`rate-limited`, `transient`).
- **Deadline:** a call whose signal is already aborted, or aborts before the call completes, returns `transient` and changes nothing.
- **Fake forge** (`createFakeForge(options?)`): pure in-memory state, one attempt per call, a yield (`await` a macrotask) before every state change so concurrent calls interleave, and the compare-and-set itself is synchronous. SHAs are 40-hex: blob SHAs are real git blob SHA-1s; commit SHAs are deterministic per forge instance. The ledger starts at an empty root commit. Its test controls (a `control` object, not part of `Forge`): set `main` files, set `now`, write a foreign ledger commit (as another lane), set checks and CI logs for a SHA, inject one error for the next call of a named operation, hook before a swap, merge the head of the queue, read comments, alerts, queue and the read trace.
- **Contract suite:** `forgeContract(harness)` in `test/contracts/forge.contract.ts` runs through `runContract`; the harness supplies the `Forge` plus the controls a case needs. A case whose control is absent from the harness reports skipped, never passed.
- **CAS loop** (`swapLedger` in `src/lane/ledger-cas.ts`): each try re-fetches the tip with `snapshot`, re-applies the pure `LedgerEdit` to the tip's files, and swaps. Conflict → back off with full jitter (`random() * min(cap, base·2^(try−1))`, base 100 ms, cap 5 s) and retry. `rate-limited` → wait `retry_after` seconds; `transient` → jitter back-off; both count as tries. Gives up after 10 tries or when the signal aborts, whichever first. Sleep and random are injectable.

**Never:**
- No GitHub code, tokens or HTTP (Stories 1.8–1.10); no `postReview`, `renderDigest` or `readRulings` (Epics 3–4); no lane process, no alert routing on lane-stopping kinds (Story 1.16).
- No new dependency; no change to existing exports' behaviour. The fake never touches the network.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected |
|---|---|---|
| Stale swap | swap from tip T0 after the tip moved to T1 | `conflict`; tip stays T1 |
| Racing swaps | 8 concurrent swaps from one tip | exactly one `ok`, seven `conflict`; tip has one new commit |
| Snapshot order | trace after `snapshot()` | `ledger`, `main`, `prs`; `now` equals the set server time; PR state for each unit with `pr` |
| Deadline | aborted signal, any operation | `transient`, no state change |
| Wrong head | `enqueue(pr, wrongSha)` | `conflict`, PR not queued |
| Comment | `comment(7, "🤖 hi")` | PR 7 has exactly that body; missing PR → `not-found` |
| Error kinds | inject each kind on an operation | that kind (with `retry_after` for `rate-limited`) |
| Push lease | `expected_sha` differs, or `null` on an existing branch | `conflict` |
| CAS retry | 3 injected foreign commits, then a free tip | `ok` on try 4, edit applied on the latest tip, 3 jittered sleeps |
| CAS precondition | foreign commit claims the unit | `edit` failure (`precondition`), no retry |
| CAS give-up | conflict every try | `exhausted` after exactly 10 tries; aborted signal mid-loop → `deadline` |
| CAS forge stop | `auth` on swap | `forge` failure with `auth`, no retry |
| CAS no-op | edit returns `null` | `ok` with `commit: null`, no swap |

</intent-contract>

## Code Map

- `src/core/ledger/edits.ts` -- `LedgerEdit` (files → `Result<LedgerCommit|null, LedgerEditErrorKind>`), `LedgerCommit {message, writes, deletes}`, `claim`, `heartbeat`. The CAS loop applies these; the port takes `LedgerCommit`.
- `src/core/ledger/codec.ts:parseLedger` -- the fake parses the tip to find each record's `pr` for `snapshot().prs`.
- `src/core/schemas/ledger.ts` -- `GitSha`, `unitPath`, `UnitRecord.pr`. `src/core/schemas/snapshot.ts:PrStateSchema` -- PR state shape `{number, state, head_sha}`; reuse its type.
- `src/core/next/snapshot.ts:AssembleInput` -- `tree`, `files`, `blob_shas`, `ledger_tip`, `ledger_files`, `prs`; the snapshot result maps onto it.
- `src/core/result.ts` -- `Result`, `ok`, `err` (no `retry_after`, hence a port-level `ForgeResult`).
- `test/contracts/run-contract.ts:runContract`, `test/contracts/example.contract.test.ts` -- contract suite shape.
- `test/support/boundaries.ts` -- layers: ports import core only; adapters import ports and core and never another adapter dir; lane imports anything below it. The fake lives in `src/adapters/forge/fake/`.
- `test/core/ledger/fixtures.ts` -- `ALICE`, `BOB`, `rec`, `tip` fixtures for CAS tests.
- `src/ports/.gitkeep`, `src/lane/.gitkeep` -- placeholders to remove once real files exist.

## Tasks & Acceptance

**Execution:**
- `src/ports/forge.ts` -- the `Forge` type, request/response types, `ForgeError`, `ForgeResult`, kind lists, and helpers `forgeOk`, `forgeErr`, `rateLimited`, `deadlinePassed`.
- `src/adapters/forge/fake/fake-forge.ts` -- `createFakeForge` returning `{forge, control}`.
- `src/lane/ledger-cas.ts` -- `swapLedger({forge, edit, signal, sleep?, random?, maxTries?})` and its outcome type (`ok {tip, commit, tries}`; errors `edit`, `forge`, `exhausted`, `deadline`).
- `test/contracts/forge.contract.ts` -- `ForgeHarness` type and `forgeContract`; `test/contracts/forge.contract.test.ts` -- runs it on the fake.
- `test/adapters/forge/fake-forge.test.ts` -- fake-only cases (controls, SHA format, queue merge, prefetch files).
- `test/lane/ledger-cas.test.ts` -- every CAS matrix row against the fake.
- Delete `src/ports/.gitkeep` and `src/lane/.gitkeep`.

**Acceptance Criteria:**
- Given `src/ports/forge.ts`, when a type-level test lists `keyof Forge`, then it is exactly the operations above, with no approve operation, and the error kinds equal the eight AR33 kinds.
- Given each matrix row, when the contract suite and lane tests run on the fake, then each returns the expected result.
- Given the repo, when `bun install`, `bun test`, `bun --bun oxlint` and `bun --bun tsc` run, then each exits 0 and the boundary check is clean.

## Spec Change Log

## Review Triage Log

### 2026-10-22 — Review pass
- verdicts: 33 findings — high 0, medium 0, low 24, false 6, maybe-false 3
- findings:
  - `[low]` `[patch]` (blind) the before-swap hook test asserts inside the hook, where a throw becomes `transient` on a swap already expected to fail. Fixed: `oldSha` values are recorded in the hook and asserted afterwards.
  - `[maybe-false]` `[defer]` (blind) a network write that lands just before its deadline returns `transient`, and the CAS retry then reports `precondition` on the lane's own claim. The fake can't produce this. It is settled by how Story 1.8's adapter reports an aborted `PATCH git/refs`. If true: medium.
  - `[low]` `[patch]` (blind) `swapLedger` retries `not-fast-forward`, but the spec retries only conflict, `rate-limited` and `transient`. Fixed: it now ends the loop as a `forge` failure, and the test was updated.
  - `[low]` `[patch]` (blind) an abort check ran before classification, hiding `auth`/`forbidden`/`uninstalled` as `deadline`. Fixed: non-retried kinds are classified first, and a test was added.
  - `[low]` `[reject]` (blind) `snapshot().prs` is `{}` on an unparsable ledger and omits PRs the forge doesn't know. The raw ledger files still reach `assembleSnapshot`, which stops on the parse error. A record naming a PR that doesn't exist is unlikely, and settling it would add contract surface.
  - `[low]` `[reject]` (blind) the contract never calls `dequeue` on a missing PR. The spec does not define that case, and pinning it would add contract surface for no caller.
  - `[low]` `[reject]` (blind) the contract hardcodes branch names, `MISSING_PR` and an empty `main`. `ForgeHarness.make` gives each case a fresh fixture, and Story 1.8 owns the live harness and its namespacing.
  - `[low]` `[patch]` (blind) `ALL_CONTROLS` is hand-listed with no completeness check. Fixed: it is now derived from a `satisfies Record<ForgeControlName, true>` literal.
  - `[false]` `[reject]` (blind) nothing checks that a case is skipped rather than passed. `scenario` uses `test.skipIf`, and a case run without its control calls `need()`, which throws, so the case fails and cannot pass.
  - `[low]` `[reject]` (blind) the racing-swap contract case doesn't check "one new commit". It checks that the tip equals the winner's tip and the files equal the old tip plus the winner's write. A further commit count needs a new control.
  - `[low]` `[reject]` (blind) three fake behaviours are tested only on the fake: dequeue on push, dequeue on close, and refusing pushes to protected branches. The spec does not require them, so they aren't contract rules.
  - `[low]` `[reject]` (blind) `GitSha` is redeclared as `string` in the port, with separate regexes in the fake and the contract. Cosmetic: the zod `GitSha` infers `string` too, and the contract regex is deliberately independent.
  - `[low]` `[reject]` (blind) the fake's `pushBranch` accepts any well-formed SHA. Real pushes send objects from `runner.git`, so an unknown commit isn't a case the lane meets. Tracking commits adds state.
  - `[low]` `[reject]` (blind) `mergeQueueHead` doesn't change `main`'s files. No current test reads them after a merge, and `setMain` covers that.
  - `[low]` `[reject]` (blind) `prefetch` writes an empty file for a missing log, leaves old files, and what counts as "failing" is open. These are temp-folder details, and the reader is Story 1.17.
  - `[low]` `[reject]` (blind) gaps in the spec artifact. The fix would edit this build's spec, and `bun test` runs the boundary check.
  - `[maybe-false]` `[defer]` (edge-case) a `transient` after the write was applied: same root cause and deferral as the blind row above.
  - `[low]` `[reject]` (edge-case) a hand-built `rate-limited` with a NaN or negative `retry_after`. Adapters build it with `rateLimited`, which clamps the value. A guard would cover a state nobody has shown can happen.
  - `[false]` `[reject]` (edge-case) `swapLedger` rejects when an edit or forge call throws. Core edits never throw (AR2), and the port contract is never-throw.
  - `[low]` `[patch]` (edge-case) log names that differ only by case collide on macOS. Fixed: names are de-duplicated case-insensitively, and a test was added.
  - `[low]` `[reject]` (edge-case) a second `injectError` replaces the first. The control is documented as one error for the next call, and a FIFO adds code no test needs.
  - `[low]` `[reject]` (edge-case) `pushBranch` accepts unknown commits: same as the blind row.
  - `[low]` `[reject]` (edge-case) an aborted `prefetch` may leave a directory or partial files. They are local temp files, not forge state, and the session's temp folder is rebuilt.
  - `[low]` `[reject]` (edge-case) `snapshot().prs` drops PR state: same as the blind row.
  - `[low]` `[patch]` (edge-case) the `not-fast-forward` retry: same root cause and fix as the blind row.
  - `[low]` `[patch]` (verification-gap) no contract case checks a merged or closed PR in `snapshot().prs`. Fixed: a scenario now asserts `merged` after a queue merge and `closed` after `closePr`.
  - `[low]` `[patch]` (verification-gap) the unknown-PR test never reached the guard. Fixed: it is split into a valid-record unknown-PR case and an unparsable-ledger case.
  - `[low]` `[reject]` (verification-gap other) `prs: {}` on an unparsable ledger: same as the blind row.
  - `[maybe-false]` `[reject]` (intent-alignment A) on an adapter without `injectError`, only injection shows the error kinds. Story 1.8 maps HTTP statuses to kinds with its own tests. A miss would be low.
  - `[false]` `[reject]` (intent-alignment B) the snapshot read order is self-reported. Read order is only observable through instrumentation, and a GitHub harness can record its request order the same way.
  - `[false]` `[reject]` (intent-alignment C) coverage on a real adapter depends on its controls. The intent-contract requires this ("reports skipped, never passed").
  - `[false]` `[reject]` (intent-alignment D) the signatures differ from AR1. `enqueue` needs a PR to name, and taking a `LedgerCommit` is how "adapters do one attempt" is met (Design Notes).
  - `[false]` `[reject]` (intent-alignment E/F) the CAS loop matches R4, and concurrency is in-process. The fake is in-memory by definition. The `not-fast-forward` part is patched above.

## Design Notes

- **The port takes a `LedgerCommit`, not a `LedgerEdit`.** The adapter does one attempt; re-applying the edit to a re-fetched tip is the lane loop's job (AR1, AR7).
- **Re-fetch uses `snapshot` with no `main` reads.** That keeps the port to the operations the spine lists; the cost is one tree listing and the PR reads per try, capped at 10 tries.
- **A failed edit ends the loop.** `precondition`, `illegal-transition`, `stop` and `invalid` come back as `edit` failures so the caller runs `next` again.

## Verification

**Commands:**
- `bun install` -- expected: exit 0, `bun.lock` unchanged.
- `bun test` -- expected: exit 0.
- `bun --bun oxlint` -- expected: exit 0.
- `bun --bun tsc` -- expected: exit 0.

## Auto Run Result

Status: done

**Summary:** Added the `Forge` port, an in-memory fake forge, a reusable forge contract suite, and the ledger compare-and-swap retry loop.
- The port declares 13 operations and no approve, merge or branch-delete. Errors use the eight AR33 kinds, and `rate-limited` carries `retry_after`. Every call takes an `AbortSignal` and returns `transient` once the deadline has passed.
- The fake passes the contract suite.
- `swapLedger` retries a pure edit over re-fetched tips. It backs off with full jitter, gives up after 10 tries or at the deadline, and ends on an edit failure.

**Files changed:**
- `src/ports/forge.ts`: the `Forge` type, request and response types, `ForgeError` and `ForgeResult`, the kind lists, the helpers, and `FORGE_OPERATIONS` with a compile-time completeness check.
- `src/adapters/forge/fake/fake-forge.ts`: `createFakeForge`, which returns `{forge, control}`. The fake holds ledger, `main`, branches, PRs, comments, checks, CI logs, queue and alerts, and test controls drive it.
- `src/lane/ledger-cas.ts`: `swapLedger`, `jitterDelay` and `defaultSleep`.
- `test/contracts/forge.contract.ts` and `test/contracts/forge.contract.test.ts`: `ForgeHarness` and `forgeContract`, run on the fake twice, with all controls and with none (those cases report skipped).
- `test/adapters/forge/fake-forge.test.ts`, `test/lane/ledger-cas.test.ts`, `test/ports/forge.test.ts`: fake-only cases, every CAS matrix row, and the type-level operation and kind checks.
- `src/ports/.gitkeep` and `src/lane/.gitkeep`: deleted.

**Review findings:** 33 findings: low 24, false 6, maybe-false 3. Every finding has a row in the Review Triage Log.
- Patched (7 entries, all low):
  - `not-fast-forward` is no longer retried;
  - non-retried kinds are classified before the abort check;
  - the hook-test assertion now runs outside the hook;
  - `ALL_CONTROLS` is exhaustive;
  - log names are de-duplicated case-insensitively;
  - the contract checks merged and closed PR states;
  - the unknown-PR test is split in two.
- Deferred (1, medium, unverified): a swap that lands just before its deadline and then reads as `precondition` on retry. It is settled by Story 1.8's adapter.
- Rejected, with reasons in the log:
  - how `snapshot().prs` handles unparsable or unknown records;
  - `dequeue` on a missing PR;
  - live-harness namespacing (Story 1.8);
  - the racing-swap commit count;
  - fake-only behaviours;
  - `GitSha` redeclarations;
  - unknown-commit pushes;
  - the merge model;
  - `prefetch` temp-file details;
  - spec-artifact gaps;
  - hand-built `retry_after` values;
  - throwing edits;
  - `injectError` replacing an earlier injection;
  - intent-alignment notes A–F.

**Follow-up review recommended:** false. Seven low entries were patched, with no high and no medium.

**Verification:**
- `bun install`: exit 0, `bun.lock` unchanged.
- `bun test`: 1018 pass, 21 skip (the no-controls harness), 0 fail.
- `bun --bun oxlint`: exit 0.
- `bun --bun tsc`: exit 0.

**Residual risks:**
- The contract suite has run only against the fake. Story 1.8's GitHub harness may need branch namespacing and its own controls.
- The deferred lost-ack case on ledger swaps is still open.
- The CAS loop re-fetches with a full `snapshot`, which costs one tree listing and the PR reads per try.
