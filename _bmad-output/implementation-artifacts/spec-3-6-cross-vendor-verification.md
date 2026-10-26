---
title: 'Story 3.6: Cross-vendor verification'
type: 'feature'
baseline_revision: 'f24bda9e03bb273292164aa3507aa264f1992c23'
created: '2026-10-25'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Nothing yet proves, on a real GitHub repo with real `claude` and `codex` sessions, that one Story builds through each adapter, that the review gate (Stories 3.3–3.5) posts a review bound to the reviewed SHA and enqueues only that SHA, and that a later agent change re-runs the review. Without that proof the Maintainer cannot lift the every-path approval rule and the 1-builder limit (FR7, FR8).

**Approach:** Add a live suite, `test/e2e/cross-vendor.test.ts`, that runs the real `laneRun` against the canary's scratch repo with the real CLIs and the operator's credentials, over a forge wrapper that overlays the Story set and policy and records every push, posted review and enqueue. Seed the scratch repo with a tiny stand-in `bmad-build-auto` skill so a real session builds the Story in a minute. Record the command, each case's expected result and the post-Epic-3 switch in `docs/maintainer/self-host.md`.

## Boundaries & Constraints

**Always:**
- Only `test/e2e/**`, `test/fixtures/**` and `docs/maintainer/self-host.md` change (the manifest's globs). The suite composes existing `src/` code; it never changes it.
- **Live switch:** each live case runs only when `canSandbox` (macOS, `XARABOT_SANDBOXED` unset) and `liveGithubEnabled` (`XARABOT_LIVE=1`, `XARABOT_LIVE_GITHUB_REPO`, `XARABOT_LIVE_GITHUB_LOGIN`); otherwise it reports skipped, never passed. Two nested-run tests prove it, as the canary's "live switch" block does. With the switch on, a missing CLI or operator credential fails the case at a named step; it never skips.
- **The unit:** one Story, `1.6` "Cross-vendor verification", glob `verify/**`, overlaid on each lane's view of scratch `main` (with `epics.md`, `sprint-status.yaml` and `.xarabot/policy.yaml`) through `overlayMain` from `race-harness.ts`. Each case gets a fresh sprint key `1-6-xv-<case>-<8 hex>`, a fresh `xarabot/test-<uuid>` ledger branch and `xarabot-test/<uuid>/` unit branches, all removed by `cleanupScratch` whether the case passes or fails. Policy overlay: `unattended_adapters` as the case needs, `expected_checks: []`.
- **The stand-in skill** (`scratchSeed` gains `.claude/skills/bmad-build-auto/SKILL.md`, the same text at `.agents/skills/bmad-build-auto/SKILL.md`, and an `AGENTS.md` saying what the scratch repo is for): for input `Build Story <e>.<s> (`<key>`)` it writes `verify/<key>.md` (one line) and `_bmad-output/implementation-artifacts/spec-<e>-<s>-verify.md` (`status: done`, `followup_review_recommended: false`, `## Auto Run Result` with `Status: done`), changes nothing else, and halts `done`. The canary's stub and Story 1.1 are unaffected.
- **The host:** a temp `HOME` and `XDG_CONFIG_HOME` with `host.yaml` (one `builder-1` lane, `effort: low`, the case's `agent`), the lane's `runner` file at scratch `main`'s `runner_version`, and copies (mode 600) of the operator's vendor credential files from `configDir(process.env)/xarabot/vendors/{claude,codex}/`. `PATH` is the caller's, so the real CLIs run. The lane runs to its trailing wait, then STOP, as the canary does.
- **Observation** (`observe` wrapper, outermost, unprefixed names): it records `push` (branch, sha), `review` (pr, `commit_sha`, body) and `enqueue` (pr, head, held or forwarded) events in order, and forwards each call.
- **Gate invariant** (pure, `checkReviewGate(events)`): every enqueue's head has a posted review at exactly that SHA whose body says `Verdict: pass.` and `Outcome: not blocking.`, and no push to a different SHA lies between that review and the enqueue. Each live case asserts it returns no violation.
- **Later change injection** (case 3 only, `injectLaterChange`): the first `enqueue` is held (not forwarded; returns `queued: true`) and the `dequeue` that follows returns `queued: false` unforwarded, so the real `queueState` reads the PR as ejected. From then on, `checks(<held head>)` adds a completed `xarabot-verify` check with conclusion `failure`, and `prefetch` for that SHA writes `<dir>/xarabot-verify.log` asking for one added line in `verify/<key>.md`. Every other call is forwarded.
- **Assertions per case** (each in a named `step`, with the lane's output and unit-log tails on failure):
  - laneRun exits 0, outcome `progress`; the ledger holds only `story:1.6`, `merged`.
  - The record's `builder_providers` names the builders' vendors; `passed_sha` equals `head_sha`, `enqueued_sha` equals `head_sha`; the PR on GitHub is merged with that head.
  - The recorded reviews' first line is `🤖 Story 1.6: <cross-vendor|same-vendor> review by <adapter> (` and ends with the reviewed full SHA; GitHub lists a `commented` review whose `commit_sha` is that SHA.
  - `checkReviewGate` has no violation; the journal's unit line for `story:1.6` is `result: done`, `state: merged`.
  - These checks (all but the GitHub reads and the review checkout's `git`) live in one pure function per case, `caseProblems(case, observed)`, returning a list of problems; the live case and its rehearsal both assert it is empty.
- **Rehearsals:** each of the four cases also runs in every `bun test` against the fake forge: the real `runLaneProcess` with the real PR, CI, review-gate and merge steps, the case's `withOverlay`, `observe` and (case 3) `injectLaterChange` wrappers, a stub builder agent of the case's adapter whose stub sandbox writes what the stand-in skill writes, and `reviewStub` from `test/lane/review-stub.ts` (import only) as the reviewer. The fake queue merges the enqueued head. Each rehearsal asserts `caseProblems` is empty, so every line of the suite but the GitHub, CLI and sandbox wiring runs in the session.

**Never:** No change under `src/`, `.github/`, `.xarabot/` or `AGENTS.md` of this repo, and no live GitHub setting. No push to the scratch `main` from the suite (only the merge queue merges). No GitHub token for a session. No new Forge operation. No assertion on a real reviewer's findings or verdict beyond the gate invariant: a real loopback is allowed if the gate holds. No `pi`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 1 claude builds (live and rehearsal) | lane `claude`, policy `[claude, codex]` | `builder_providers` ⊇ `anthropic`; a cross-vendor review by `codex` at the merged head; merged | named step fails |
| 2 codex builds (live and rehearsal) | lane `codex`, policy `[claude, codex]` | `builder_providers` ⊇ `openai`; a cross-vendor review by `claude` at the merged head; merged | named step fails |
| 3 later change (live and rehearsal) | case 1 plus `injectLaterChange` | held enqueue at H1 after a passing review at H1; `ci_fixes` ≥ 1; a passing review at the merged head H2 ≠ H1 posted after the CI-fix push and before the forwarded enqueue; `attempts` ≥ 1 | named step fails |
| 4 single vendor (live and rehearsal) | lane `claude`, policy `[claude]` | a same-vendor review by `claude` at the merged head; merged on its required checks; live only: `<laneDir>/review` is a separate checkout whose `HEAD` is that SHA and whose `core.hooksPath` is `/dev/null` | named step fails |
| case problems | observed runs that break each rule | `caseProblems` names the broken rule (wrong vendor word or adapter, missing review at the merged head, gate violation, not merged, case 3 without a held enqueue or a re-review) | — |
| switch off | `XARABOT_LIVE` unset, or `XARABOT_SANDBOXED=1` | every live case reports skipped; `0 pass` for them, `0 fail` | — |
| gate rows | event lists | no violation for review-then-enqueue; violation for enqueue with no review, a blocking review, a review at another SHA, a push between review and enqueue | — |
| injector rows | fake forge | held enqueue and dequeue; failing `xarabot-verify` on the held head only after the hold; log file written in the asked dir; other SHAs untouched | — |

</intent-contract>

## Code Map

- `test/e2e/canary.test.ts:330-604` -- the live pattern to mirror: `step`, `must`, `connect`, host setup, the STOP-in-trailing-wait watcher, `diagnostics`, `cleanupScratch`. `:280-320` the nested "live switch" tests.
- `test/e2e/race-harness.ts:59-124` -- `overlayMain` (exported; reuse), `raceStories` (the overlay's file shapes for `epics.md`, `sprint-status.yaml`, manifests).
- `test/e2e/scratch-seed.ts` -- `scratchSeed`; add the skill files and `AGENTS.md`. The canary test's seed rows still pass.
- `test/support/live-github.ts` -- `liveGithubEnabled`, `liveRepo`, `liveCredentials`, `prefixed`, `cleanupScratch`, `RawCall`. `test/support/sandbox.ts` -- `canSandbox`, `isSandboxed`.
- `src/cli/lane-run.ts:97-119` -- `LaneRunDeps` (`env`, `connect`, `out`, `errOut`). Start checks read the policy and the reviewer credential once (`:417-446`); `composeReviewers` `:218-239`.
- `src/lane/merge-step.ts:224-237,345-373` -- enqueue, then an immediate `queueState`; open, same head, not queued is `ejected` (attempts + 1, `dequeue` through `leaveMerging` `:136-155`), back to the CI step.
- `src/lane/ci-step.ts:248-307,321` -- `checks(sha)` classified by `classifyChecks` (`src/core/ci/checks.ts`: a failing check *outside* `expected_checks` fails); `prefetch({kind:"ci-log", sha, dir})` then reading each returned absolute path.
- `src/core/review/review-comment.ts` -- `reviewComment` first line `🤖 <subject>: <cross-vendor|same-vendor> review by <adapter> (<model>) of <sha>.`, then `Verdict: …` and `Outcome: …`.
- `src/lane/review-step.ts:329-392` -- fence `{reviewed_sha, passed_sha: null}`, `postReview(pr, {commit_sha, body})`, then `passed_sha`. `src/lane/review-checkout.ts:37-60` and `src/lane/clone.ts:521-551` -- the checkout at `laneLayout(laneDir).review`, `hooksPath = /dev/null`, kept after the run.
- `src/core/lane/build-check.ts:57-122` -- the `done` spec rules the skill's spec must meet; `CONFIG_DEFAULTS.story_spec_path` `spec-<epic>-<story>-*.md`.
- `src/core/review/reviewer.ts:13-27` -- `PROVIDERS` `anthropic`, `openai`. `src/core/ledger/codec.ts:80` `parseLedger`.
- `src/adapters/forge/github/github-forge.ts` `reviews` -- `ForgeReview { author, state, commit_sha }`. `src/adapters/forge/fake/fake-forge.ts` -- for the injector, observer and rehearsals (`control.setChecks`, `control.makeCommit`, `control.mergeQueueHead`).
- `test/lane/merge-step.test.ts:851-1057` -- the rehearsal's model: `runLaneProcess` with a stub agent and sandbox, a stub workspace and committer, the real `createPrStep`, `createCiStep`, `createReviewGateStep` and `createMergeStep` on the fake forge, `headPassedGate`, a fake clock, and the queue merged at the merge step's sleep. `test/lane/review-stub.ts` `reviewStub` -- a real review step on stub `claude` and `codex` reviewers (import only; never edit `test/lane/**`). `test/lane/graph-stub.ts` `unchangedGraph`.
- `docs/maintainer/self-host.md:532-543` -- "Several builder lanes" drain step (wait for `lane.lock`'s PID to be gone); `:710-734` "After Epic 3"; `:736-822` the codex section and its evidence list.

## Tasks & Acceptance

**Execution:**
- `test/e2e/scratch-seed.ts` -- add the stand-in skill (both paths, one text, exported as `SEED_SKILL`), `AGENTS.md`, and `XV_STORY` constants (`1.6`, glob `verify/**`). Rationale: a real session needs a build skill in the scratch clone.
- `test/e2e/cross-vendor-harness.ts` (new) -- `xvOverlay(key, adapters)`, `withOverlay(forge, files)`, `observe(forge, events)`, `injectLaterChange(forge, key, state)`, pure `checkReviewGate(events)`, `reviewHead(body)` (parses the first line), `copyVendorCredentials(fromConfig, toConfig)`, and `runLiveLane(case)` that sets up the host, runs `laneRun` to its trailing wait with STOP, and returns the lane output, layout, events and the final ledger record.
- `test/e2e/cross-vendor.test.ts` (new) -- non-live: the seed's skill and spec text meet `checkBuildSpec`/`specMatches` for a sample key; the overlay loads through `loadRepoConfig` and `next` picks `story:1.6` with the case's policy; `checkReviewGate`, `reviewHead` and `caseProblems` case tables; the observer and injector against the fake forge; the four rehearsals; the two nested live-switch tests. Live: the four cases of the matrix, each with a 50-minute timeout.
- `docs/maintainer/self-host.md` -- a new "Epic 3's live evidence (Story 3.6)" section: re-seeding the scratch repo, both vendors' credentials at once, the command `XARABOT_LIVE=1 XARABOT_LIVE_GITHUB_REPO=xaravel/xarabot-scratch XARABOT_LIVE_GITHUB_LOGIN=edanisko bun test test/e2e/cross-vendor.test.ts` and each case's expected result, Story 3.1's nested sandbox cases and the codex live commands, `bun test test/sandbox/` on the host as an evidence row until the macOS CI job runs, the skip rule, and committing `docs/maintainer/evidence/epic-3.md`. A "The switch after Epic 3" list: drop `owner_approval_paths: ["**"]`, allow the adapters (`unattended_adapters: [claude, codex]`), confirm `epic-2-retro-item-23-harden-the-lane-lock` is `done`, raise `XARABOT_MAX_BUILDERS`, run the 24-hour check; the note on status planning PRs and spec-2-7. Fix the "Several builder lanes" drain step to wait for `lane.lock`'s PID to be gone.

**Acceptance Criteria:**
- Given the scratch repo and live credentials for each vendor, when the suite runs on the host, then Story 1.6 runs to a valid `build` result and merges through a `claude` lane and through a `codex` lane.
- Given a `claude`-built PR, when it reaches review, then a `codex` review naming the reviewed SHA is posted and the PR is enqueued and merged only at that SHA.
- Given a later agent change after a passed review, when the lane continues, then the review runs again at the new head before the PR is enqueued.
- Given a `claude`-only policy, when the unit is ready for review, then a same-vendor `claude` review on a separate fresh checkout names the reviewed SHA, and the PR merges on its required checks.
- Given `bun test` inside a sandboxed session, when it runs, then every live case of the suite reports skipped and none passes.
- Given `bun test`, `bun --bun tsc` and `bun --bun oxlint`, when run, then each passes.

## Spec Change Log

## Review Triage Log

### 2026-10-25 — Review pass
- verdicts: 30 findings — high 0, medium 0, low 24, false 5, maybe-false 1
- findings:
  - `[false]` `[reject]` (intent) The harness requires a review at exactly each enqueued head, stricter than the AC's "or a clean `main` merge". The merger never pushes a clean merge (Story 3.5 Design Notes), and nothing in the suite pushes one onto the PR, so an exact-head enqueue is the only reachable kind. The stricter check still satisfies the AC.
  - `[false]` `[reject]` (intent) Case 3 simulates the trigger and covers only a CI fix. The AC asks for "a later agent change", and one kind meets it. The held enqueue is the recorded design (Design Notes); the session, push, re-review and enqueue are real.
  - `[low]` `[reject]` (intent) Case 4 does not assert that the review session is separate or that its checkout was fresh. `<laneDir>/review` is rewritten by `freshDir` on every prepare (`src/lane/clone.ts:538`), and Story 3.4's `test/lane/review-checkout.test.ts` asserts HEAD and `hooksPath` in every run. A session-identity check would need new plumbing.
  - `[false]` `[reject]` (intent) The lane reads an overlaid policy, not the scratch repo's committed one. That is the AC's "Given a policy that allows only claude", applied through every snapshot the lane takes, including the fresh-`main` re-checks.
  - `[false]` `[reject]` (intent) The doc's counts are not observed. The sandbox counts were measured (95/12; the suite 61/4). The host and live counts are exact sums: 37+61 pass and 5+4 skip, and 61+4 with no skip.
  - `[false]` `[reject]` (intent) The live builds run a stand-in skill, not BMAD. The AC asks for a valid `build` result through each adapter, and the package's own build prompt runs; the scratch repo has no BMAD install (Design Notes).
  - `[low]` `[patch]` (verification-gap) The `holds no file` branch of `copyVendorCredentials` is untested. Added a test row for an empty or symlink-only vendor folder.
  - `[low]` `[patch]` (verification-gap) The doc names the wrong step for a folder with no credential file. Grouped with the two rows below; the doc now names `host setup` for that case.
  - `[low]` `[patch]` (blind) The same wrong step name for an empty credential folder. Same fix as above.
  - `[low]` `[patch]` (blind) Nothing checks what the build wrote. Added `cloneProblems`: the lane's clone must hold the key's verify file and a spec naming the key, in each live case and rehearsal. The case-3 extra line is not required, since a real loopback may legitimately rework it.
  - `[low]` `[patch]` (blind) The shared spec path lets a session that never wrote its spec pass, once an earlier run left a `done` spec on `main`. The same `cloneProblems` check requires the spec in the clone to name this run's key.
  - `[low]` `[patch]` (blind) The skill's "exactly one line" conflicts with case 3's CI log. The skill now writes the file "holding this line", and `AGENTS.md` says a CI check may ask for one more line.
  - `[low]` `[patch]` (blind) The scratch-main preflight misses a stale or partial seed. It now requires both skill files and `AGENTS.md` to equal the current seed text.
  - `[low]` `[patch]` (blind) The doc says 50 minutes per case, but the lane is cut off at 40. The doc now says 40 minutes inside the 50-minute timeout.
  - `[low]` `[patch]` (blind) The claude-only case's review effort is undocumented. The doc now says a same-adapter reviewer runs at the lane's model and effort (`low`).
  - `[low]` `[patch]` (blind) The drain loop ignores PID reuse. It now also needs the process's command name to equal `lane.lock`'s second line.
  - `[low]` `[patch]` (blind) The `bun test test/sandbox/` evidence row has no expected counts. It now points at "The sandbox suites" table.
  - `[low]` `[patch]` (blind) The gate's "last review at that SHA" rule and held enqueues are untested. Added rows: pass then blocking (a violation), blocking then pass (none), and a held enqueue with no review (a violation).
  - `[low]` `[reject]` (blind) `caseProblems` checks neither `reviewed_sha` nor PR numbers, and `checkReviewGate` counts pushes to any branch. `passed_sha` equal to the head already implies the head was reviewed. A builder run has one PR and pushes only its unit branch (ledger writes are `ledgerSwap`, not `pushBranch`), so the mismatches are unreachable.
  - `[low]` `[patch]` (blind) The overlay's `epics.md` keeps a literal `<key>`. It now uses `xvVerifyPath(key)`.
  - `[low]` `[reject]` (blind) `copyVendorCredentials` skips symlinks silently and does not enforce exactly one codex credential. The lane's own credential read refuses a non-regular file and two codex files, naming them in its start-check output, which the case's diagnostics print. Unlikely, and the guard adds branches.
  - `[low]` `[reject]` (blind) An App-credential failure is not inside a named step. `loadAppCredentials`'s message already names the file and the problem. Unlikely on a host that runs the canary.
  - `[maybe-false]` `[reject]` (blind) The re-seed's `gh pr merge --squash` comment may overstate what it does: auto-merge vs queue. Settling it needs `gh`'s behaviour on a merge-queue branch with a pending check. If true it is only low (the PR still merges once `check` passes), so it is rejected with this note.
  - `[low]` `[reject]` (edge) A push or enqueue that errors after GitHub applied it is not recorded. The steps retry with leases, and the retry's `ok` is recorded. Rare, and recording failures adds a second event semantics.
  - `[low]` `[reject]` (edge) A lane still running 30 s after its deadline STOP can overlap cleanup and the next case. This is the canary's same pattern; it is logged, and it happens only on a run that already failed.
  - `[low]` `[patch]` (edge) An empty folder fails later than the doc says. Same fix as the step-name rows above. Two codex credentials are rejected with the symlink row.
  - `[low]` `[reject]` (edge) A symlinked credential is skipped silently. Same as the blind row above: the lane refuses a non-regular credential anyway.
  - `[low]` `[patch]` (edge) A stale `SKILL.md` or a missing `AGENTS.md` passes the preflight. Same fix as the preflight row above.
  - `[low]` `[patch]` (edge) The drain loop can wait forever on a reused PID. Same fix as the drain row above.
  - `[low]` `[reject]` (edge) `runLiveLane` hands its run to a callback instead of returning it, unlike the spec's task wording. Cleanup must run after the checks, and the callback gives the same data. The fix would be a spec edit.

## Design Notes

Why a held enqueue: after a passed review the only way back to an agent change is an ejection followed by a CI fix or a conflict. A real ejection or a real conflict on the scratch repo needs a second merged PR or a failing workflow, both slow and racy. Holding the first enqueue makes the real `queueState` read "ejected"; the extra failing check makes the CI step run a real CI-fix session, whose new head the real review gate must review again. Only the trigger is simulated; the session, the push, the review and the enqueue are real.

Why a stand-in skill: the scratch repo has no BMAD install, and the AC asks for a valid `build` result, not a BMAD run. The build prompt is the package's own ("Run the stock `bmad-build-auto` skill"), so the real CLIs find the scratch repo's skill as they would find BMAD's.

Golden skill result for key `1-6-xv-claude-0a1b2c3d`: `verify/1-6-xv-claude-0a1b2c3d.md` = `Built for 1-6-xv-claude-0a1b2c3d.` and `_bmad-output/implementation-artifacts/spec-1-6-verify.md` with `status: done`.

## Verification

**Commands:**
- `bun test` -- expected: 0 fail; the suite's live cases skipped inside the session.
- `bun test test/e2e/` -- expected: 0 fail; 4 more skips than before (the live cases).
- `bun --bun tsc` -- expected: exit 0.
- `bun --bun oxlint` -- expected: exit 0.

## Auto Run Result

Status: done

**Summary:** A live cross-vendor verification suite, `test/e2e/cross-vendor.test.ts`, for the Maintainer to run on the host before Epic 3's retro. It runs the real `laneRun` against the scratch repo with the real `claude` and `codex` CLIs.
- **Case 1:** a `claude` lane builds Story 1.6, `codex` reviews it cross-vendor, and it merges.
- **Case 2:** a `codex` lane builds Story 1.6, `claude` reviews it cross-vendor, and it merges.
- **Case 3:** a later agent change after a passed review is reviewed again before its enqueue. The test holds the first enqueue, so the real queue read sees the PR ejected, and adds a failing `xarabot-verify` check with its log, which makes a real CI-fix session run.
- **Case 4:** under a `claude`-only policy, a same-vendor `claude` review runs on the separate review checkout (HEAD at the merged SHA, hooks off), and the PR merges on its required check.
- **Shared checks:** one pure `caseProblems`, the gate invariant `checkReviewGate`, and `cloneProblems` for what the build wrote. Each live case and its fake-forge rehearsal both assert them; the rehearsals run in every `bun test` through the real lane process and the real PR, CI, review-gate and merge steps.
- **Skipping:** live cases skip without `XARABOT_LIVE=1` and the scratch variables, or inside a sandbox. Nested runs prove it.
- **The scratch seed** gains a stand-in `bmad-build-auto` skill (at `.claude/skills` and `.agents/skills`) and an `AGENTS.md`.
- **The runbook** records:
  - the live command and each case's expected result;
  - re-seeding the scratch repo and having both vendors' credentials in place;
  - Story 3.1's commands, with `bun test test/sandbox/` on the host as an evidence row;
  - the evidence file, and "The switch after Epic 3": drop the every-path rule, allow both adapters, confirm lane item 23, raise `XARABOT_MAX_BUILDERS`, then the 24-hour check;
  - the spec-2-7 note, and the drain step, which now waits for `lane.lock`'s PID to be gone.

**Files changed:**
- `test/e2e/scratch-seed.ts`: `SEED_SKILL`, `SEED_AGENTS`, `XV_STORY` and the stand-in skill's exact output (`xvSkillFiles`).
- `test/e2e/cross-vendor-harness.ts` (new):
  - the overlay and the forge wrappers (`withOverlay`, `observe`, `injectLaterChange`);
  - the pure checks `checkReviewGate`, `reviewHead`, `caseProblems` and `cloneProblems`;
  - the credential copy, and `runLiveLane`.
- `test/e2e/cross-vendor.test.ts` (new): the case tables, the observer and injector tests, four rehearsals, the live-switch tests and the four live cases.
- `docs/maintainer/self-host.md`: "Epic 3's live evidence (Story 3.6)", "The switch after Epic 3", the drain step, and the updated e2e counts.

**Review findings:** 30 findings (high 0, medium 0, low 24, false 5, maybe-false 1).
- **Patched:** 17 rows, all low, in 11 fixes:
  - a test row for the `holds no file` credential branch;
  - the doc's step name for a folder with no credential file;
  - `cloneProblems`, the build-output check, in every live case and rehearsal;
  - the skill wording and an `AGENTS.md` note for case 3's extra line;
  - the preflight now requires the current seed texts;
  - the doc's 40-minute lane limit;
  - the claude-only reviewer's effort;
  - the drain loop now checks the command name, so a reused PID cannot hold it;
  - expected counts for the sandbox evidence row;
  - three `checkReviewGate` rows;
  - the overlay's real key in `epics.md`.
- **Deferred:** none.
- **Rejected:**
  - the stricter exact-SHA gate (false: the clean-merge case is unreachable);
  - the simulated later-change trigger (false: the recorded design);
  - no session-identity check in case 4 (low; Story 3.4's checkout tests cover it);
  - the policy overlay (false: it is the AC's policy);
  - the doc counts (false: measured or exact sums);
  - the stand-in skill (false: the AC asks for a build result);
  - no `reviewed_sha`/PR-number cross-checks and the push filter (low, unreachable);
  - silently skipped symlinks and two codex files, reported twice (low; the lane refuses them itself);
  - the App credential outside a step (low);
  - `gh pr merge --squash` (maybe-false; low if true);
  - unrecorded failed calls that landed (low);
  - a lane leaked past its deadline (low; the canary's pattern);
  - `runLiveLane` taking a callback (low; fixing it would be a spec edit).

**Follow-up review recommended:** false. Only low entries were patched (0 high, 0 medium).

**Verification:**
- `bun test`: 5236 pass, 326 skip, 0 fail. The skips are the baseline's 322 plus the 4 new live cases.
- `bun test test/e2e/`: 106 pass, 12 skip, 0 fail. Before this change it was 34 pass, 8 skip.
- `bun test test/e2e/cross-vendor.test.ts`: 72 pass, 4 skip, 0 fail. `bun test test/e2e/canary.test.ts test/e2e/claims-race.test.ts`: 34 pass, 8 skip, 0 fail.
- `bun --bun tsc` and `bun --bun oxlint`: exit 0.
- **Matrix audit:** every row has a test that ran and passed. Rows 1–4 are covered by the rehearsals. Row 4's checkout HEAD and `hooksPath` are also covered by `test/lane/review-checkout.test.ts`. The remaining rows have their own tables: the live switch, the gate, the injector and `caseProblems`.

**Residual risks:**
- **No live case has run yet.** They need the host, both vendors' credentials and a re-seeded scratch repo. Until the re-seed PR merges, every live case fails at `scratch main loads`.
- **Case 3 is unproven on GitHub.** It assumes GitHub's queue read, right after the held enqueue, shows the PR open and not queued. That matches the merge step's code but has not been checked against GitHub.
- **Real reviewers may block.** That sends the unit through loopbacks, which the checks allow. Repeated blocks would park it at `review-cap` and fail the case.
- **The host counts are worked out, not measured.** That covers the host totals in the doc and the live suite's `76 pass`.
- **The live clone check is unconfirmed.** It assumes the lane's clone still holds the last session's files after the run. The code rebuilds the clone only at a session's start, but this has not been seen on a real run.

**Not committed:** per this run's instructions, the changes stay in the working tree, so the skill's commit-and-clean-tree finalization was not run.
