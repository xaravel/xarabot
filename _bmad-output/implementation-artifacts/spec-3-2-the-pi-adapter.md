---
title: 'Story 3.2: The `pi` adapter, deferred to v1'
type: 'feature'
created: '2026-10-25'
status: 'done'
baseline_revision: 'df46b4d14f9a247044fd0c6a44a8ab3fa06010b7'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `lane install` does not check the lane's own agent against `main`'s `unattended_adapters`, so `--agent codex` under `[claude]` installs and then fails every start until the third writes STOP.
    evidence: |-
      Pre-existing: install never read the policy before this Story; it now reads it only for the pi reviewer refusal. Applying `unattendedRefusal(policy, agent)` at install is new install behaviour the Story does not ask for, so it is the Maintainer's call.
    location: >-
      src/cli/lane-install.ts:mainPolicyRefusal
    severity: low
---

<intent-contract>

## Intent

**Problem:** 0.x has no `pi` adapter (stock pi 1.4.0 gives `bmad-build-auto` no subagents; Maintainer, 2026-10-25), but `agent: pi` still installs when a `pi` binary is on `PATH` and fails at start only with a generic "no adapter" message, and a policy that allows neither `claude` nor `codex` leaves a lane with no possible reviewer (FR7, AR34; SPEC § Assumptions "Same-vendor reviewer").

**Approach:** One pure module in `src/cli/` holds the deferral text and two refusals: `agent: pi`, and a policy whose `unattended_adapters` allows neither `claude` nor `codex` (its only reviewer would be pi). `lane install` and `lane run` apply both and name the deferral; the composition types narrow to `claude | codex`, so no code path can build a `pi` agent. The runbook records the finding and what the v1 adapter needs first.

## Boundaries & Constraints

**Always:**
- Deferral text, verbatim in every refusal: ``the `pi` adapter is deferred to v1: stock pi 1.4.0 gives `bmad-build-auto` no subagents``.
- `lane run`: in step 5, after the repo config loads, check in order: `agent: pi` → reviewer (policy allows neither `claude` nor `codex`) → the existing `unattendedRefusal`. Each is a failed start (`failedStart`, counted, third writes STOP).
- `lane install`: refuse `--agent pi` right after the lane parses, before the tools check (a `pi` on `PATH` changes nothing). Read `.xarabot/policy.yaml` in the same snapshot as `config.yaml`; when present and valid, apply the reviewer refusal; when present and invalid, refuse naming the parse error; when absent, skip (lane start already refuses a missing policy). Refuse before anything is installed or written.
- `AdapterName` keeps `pi`; a policy listing `pi` still parses.
- `adapterFor`, `AGENT_COMMANDS` and `laneTools` take only `claude | codex` (a `SessionAdapter` type), so a `pi` agent cannot be composed.

**Never:** No `src/adapters/agent/pi/`. No edits outside the manifest globs (`src/core/lane/runner.ts`, `src/core/config/**`, `src/sandbox/**`, `src/adapters/**` stay as they are; the `~/.pi` read denial and the `.pi` agent-config/protected path stay). No reviewer selection logic (Story 3.3). No removal of `pi` from `VENDORS` or `AdapterName`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| pi lane, start | host lane `agent: pi`, policy `[pi]` or `[claude]` | refused naming the deferral, `failed-starts` + 1, no session | failed start |
| pi-only policy, start | lane `agent: claude`, policy `[pi]` | refused: allows neither claude nor codex, only reviewer would be pi, deferral text | failed start |
| empty policy, start | lane `agent: claude`, policy `[]` | refused with the reviewer refusal (allowed: none) | failed start |
| not allowed, start | lane `agent: claude`, policy `[codex]` | existing "is not in .xarabot/policy.yaml unattended_adapters" | failed start |
| codex lane, policy `[claude, codex]` | normal | starts | — |
| pi install | `--agent pi`, `pi` on PATH | exit 1, deferral text, no host.yaml, no runner install, no snapshot | — |
| pi-only policy, install | `--agent claude`, main policy `[pi]` | exit 1, reviewer refusal, no host.yaml written, no runner installed | — |
| invalid / absent policy, install | policy text `nope: 1` / no policy file | invalid → exit 1 naming `.xarabot/policy.yaml`; absent → installs | — |
| policy parse | `unattended_adapters: [claude, pi]` | parses | — |

</intent-contract>

## Code Map

- `src/cli/lane-run.ts:115-129` -- `adapterFor`: narrow to `SessionAdapter`, drop the pi fallback; `:336` step 5 refusals: add the two pi checks before `unattendedRefusal`; doc comment `:118`.
- `src/cli/lane-install.ts:53-58` -- `AGENT_COMMANDS`, `laneTools`: narrow to `SessionAdapter`; `:212-226` lane parse and tools check: insert the agent refusal between them; `:240-245` snapshot `read` only takes `CONFIG_PATH` -- add `POLICY_PATH`, then the reviewer refusal before `ensureRunner`; header comment `:22-35`.
- `src/core/lane/runner.ts:78` -- READ-ONLY: `unattendedRefusal` message format to mirror (`allowed: none` for an empty list).
- `src/core/config/load-repo-config.ts:11` -- READ-ONLY: `POLICY_PATH`; `src/core/schemas/common.ts` `parseVersionedYaml` and `src/core/schemas/policy.ts` `PolicySchema` for the install-time parse.
- `test/cli/lane-fixture.ts:25` -- `mainFiles({ unattended })` already writes the policy; extend with an optional raw policy override (or omit) for the install cases.
- `test/cli/lane-run.test.ts:448-466` -- refusal table: the `agent not allowed` row uses `unattended: []`, which now hits the reviewer refusal first -- change it to `["codex"]`; replace the `no adapter` row with the deferral rows above.
- `test/cli/lane-install.test.ts:282-300` -- `laneTools`/codex install cases; add pi install and policy cases.
- `test/core/lane/write-check.test.ts:404` -- comment says "Story 3.2 adds `pi`": reword to the v1 deferral.
- `docs/maintainer/self-host.md:734` -- after "The `codex` adapter (Story 3.1)", add a pi section.

## Tasks & Acceptance

**Execution:**
- `src/cli/pi-deferral.ts` -- new pure module: `PI_DEFERRAL`, `SessionAdapter` (`Exclude<AdapterName, "pi">`), `piAgentRefusal(agent): Result<SessionAdapter, "refused">`, `piReviewerRefusal(policy): Result<void, "refused">` -- one home for the text both CLIs name.
- `src/cli/lane-run.ts` -- use both refusals in step 5 in the order above; `adapterFor(agent: SessionAdapter, env)`.
- `src/cli/lane-install.ts` -- agent refusal before tools; policy read and reviewer refusal before the runner install; narrowed types and updated header comment.
- `test/cli/pi-deferral.test.ts` -- case table for both refusals (pi / claude / codex agents; policies `[]`, `[pi]`, `[claude]`, `[codex]`, `[claude, pi]`, `[pi, codex]`), exact deferral text, plus `PolicySchema` parsing a list with `pi`, and a check that `src/adapters/agent/pi` does not exist.
- `test/cli/lane-run.test.ts`, `test/cli/lane-install.test.ts`, `test/cli/lane-fixture.ts` -- the matrix rows at the CLI surface.
- `test/core/lane/write-check.test.ts` -- comment only.
- `docs/maintainer/self-host.md` -- section "The `pi` adapter, deferred to v1 (Story 3.2)": the escalation's finding (2026-10-25, stock pi 1.4.0, no subagents for `bmad-build-auto`), what 0.x does (both refusals, at install and start), and what the v1 adapter needs first: subagents for `bmad-build-auto`, pi's agent-directory override (AR41), and its attribution-off and own-sandbox-off switches; then its credential (OpenRouter key), minimum version and `--thinking` mapping.

**Acceptance Criteria:**
- Given `agent: pi` on a lane, or a policy allowing neither `claude` nor `codex`, when `xarabot lane install` or `xarabot lane run` runs, then it exits 1 with the deferral text in its error output, and at lane start `failed-starts` goes up by one.
- Given the policy schema, when a policy lists `pi`, then it parses; and `src/adapters/agent/pi/` does not exist and `adapterFor` cannot be called with `pi` (type-checked).
- Given `docs/maintainer/self-host.md`, when read, then it has the pi section with the finding and the three v1 prerequisites.

## Spec Change Log

## Review Triage Log

### 2026-10-25 — Review pass
- verdicts: 19 findings — high 0, medium 0, low 13, false 6, maybe-false 0
- findings:
  - `[low]` `[patch]` (blind) A `pi` lane is checked in step 5, so a run that only switches the runner version (or fails at connect or repo config) exits without the deferral, contradicting the runbook's "a failed start at every lane run" — real; the intent contract places the check in step 5, so the runbook wording was corrected to "refused at the start checks of every run that reaches them".
  - `[low]` `[patch]` (blind) `adapterFor` lost its explicit `codex` branch, so a v1 widening of `SessionAdapter` would silently build a codex agent — restored the `codex` branch with an exhaustive `never` check.
  - `[low]` `[defer]` (blind) `lane install` reads the policy but does not check the lane's own agent against it — pre-existing (install never checked it); deferred.
  - `[low]` `[patch]` (blind) The invalid-policy install test cannot tell a parse refusal from the reviewer refusal — now also asserts no deferral text and no runner install.
  - `[low]` `[patch]` (blind) `piReviewerRefusal` hard-codes `.xarabot/policy.yaml` — now uses `POLICY_PATH` (same text).
  - `[low]` `[patch]` (blind) The runbook's recovery omits removing `STOP` and the re-install's `sudo` commands — added.
  - `[low]` `[patch]` (blind) `LANE_INSTALL_USAGE` says `--agent <agent>` and runbook step 13 omits the new refusals — usage now `--agent <claude|codex>`; step 13 gains one sentence pointing to the pi section.
  - `[low]` `[patch]` (blind) Unclear runbook wording ("after a `pi` lane", "the pi review rows", "keeps denying") — reworded.
  - `[low]` `[patch]` (edge) Runner-mismatch run of a `pi` lane exits 0 with no deferral — same root cause as the first row; runbook corrected.
  - `[low]` `[defer]` (edge) Install passes a lane whose own agent the policy does not allow — same as the blind row; deferred.
  - `[low]` `[patch]` (edge) A `pi` lane whose connect or repo config fails exits without the deferral text — same root cause as the first row (still a failed start, with that failure named); runbook corrected.
  - `[false]` `[reject]` (edge) A pi builder lane already in `host.yaml` takes an `XARABOT_MAX_BUILDERS` slot — install now refuses pi, a lane in `host.yaml` is a lane the host runs (it starts and refuses each time), and counting installed lanes is AR22's rule; no wrong outcome.
  - `[low]` `[patch]` (edge) The removed runtime guard in `adapterFor` — same root cause as the blind `adapterFor` row; patched together.
  - `[false]` `[reject]` (intent) The `[]` policy is relabelled as a pi deferral, beyond a reading where only pi-listing policies count — Story 3.3 says a policy allowing neither `claude` nor `codex` "refuses at lane start (Story 3.2)", and SPEC § Assumptions says such a repo's lanes refuse; the message still shows `allowed: none`.
  - `[false]` `[reject]` (intent) Install refusing an invalid policy and passing an absent one goes beyond the ACs — an invalid policy stops every lane start anyway and an absent one is refused at start; no wrong outcome.
  - `[false]` `[reject]` (intent) Failed starts are counted only at `lane run`, not install — install has no failed-starts counter (AR34 counts lane starts); the install refusal exits 1.
  - `[low]` `[patch]` (intent) A pi lane with a stale runner file is not refused on that run — same root cause as the first row; runbook corrected.
  - `[false]` `[reject]` (intent) No test covers a coordinator `pi` lane — step 5 runs before the role branch, so a coordinator lane takes the same tested refusal path; no untested behaviour.
  - `[false]` `[reject]` (intent) Under the slug's literal reading (build the adapter) the diff does the opposite — the Maintainer rewrote Story 3.2 as the deferral on 2026-10-25 (epics.md, manifest title).
  - (verification-gap) no findings.

## Design Notes

"A policy whose only reviewer would be pi" is read as SPEC's "a repo that allows neither [`claude` nor `codex`] has no reviewer, and its lanes refuse to start": under the pre-deferral rule the fallback reviewer for such a repo was pi. The reviewer check runs before `unattendedRefusal` because, after a passing unattended check on a `claude`/`codex` lane, the policy always allows one of them, so a later check could never fire. An absent policy at install is left to the lane start (`loadRepoConfig` refuses it) so install keeps working for repos whose policy lands in the same bootstrap PR.

## Verification

**Commands:**
- `bun test` -- expected: 0 fail; sandbox and live cases skipped inside the session.
- `bun --bun oxlint` -- expected: exit 0.
- `bun --bun tsc` -- expected: exit 0.

## Auto Run Result

Status: done

**Summary:** A lane set to `agent: pi`, or a policy whose `unattended_adapters` allows neither `claude` nor `codex` (so its only reviewer would be `pi`), is refused by `xarabot lane install` and by `xarabot lane run`. Each refusal names the deferral ("the `pi` adapter is deferred to v1: stock pi 1.4.0 gives `bmad-build-auto` no subagents"), and at lane start it is a failed start. `pi` still parses in a policy, `src/adapters/agent/pi/` does not exist, and the composition types (`SessionAdapter`) make a `pi` agent impossible to compose. The maintainer runbook records the escalation's finding and what the v1 adapter needs first.

**Files changed:**
- `src/cli/pi-deferral.ts` (new): `PI_DEFERRAL`, `SessionAdapter`, `piAgentRefusal`, `piReviewerRefusal`.
- `src/cli/lane-run.ts`: step 5 checks the `pi` lane, then the reviewer, then the existing `unattendedRefusal`; `adapterFor` takes only `claude | codex`, with an exhaustive `never` check.
- `src/cli/lane-install.ts`: refuses `--agent pi` before the tools check; reads `main`'s policy with `config.yaml` (`mainPolicyRefusal`: absent passes, invalid or reviewer-less refuses) before the runner install; `AGENT_COMMANDS`/`laneTools` narrowed; usage `--agent <claude|codex>`.
- `test/cli/pi-deferral.test.ts` (new), `test/cli/lane-run.test.ts`, `test/cli/lane-install.test.ts`, `test/cli/lane-fixture.ts`: case tables and CLI cases for every matrix row; `@ts-expect-error` guards that `pi` is not a session adapter.
- `test/core/lane/write-check.test.ts`: comment only.
- `docs/maintainer/self-host.md`: step 13 names the new install refusals; new section "The `pi` adapter, deferred to v1 (Story 3.2)".

**Review findings:** 19 findings (high 0, medium 0, low 13, false 6, maybe-false 0).
- Patched (all low): the runbook's "every lane run" wording (with its edge and intent duplicates); `adapterFor`'s exhaustiveness (with the removed-guard duplicate); the invalid-policy test now tells a parse refusal from the reviewer refusal; `POLICY_PATH` in the reviewer message; runbook recovery (STOP removal, re-install commands); install usage and runbook step 13; unclear runbook wording.
- Deferred (1 entry in frontmatter `deferred`): install does not check the lane's own agent against the policy (pre-existing).
- Rejected: a pi lane taking a builder slot (false: counting installed lanes is AR22's rule); the `[]` policy carrying the deferral (false: Story 3.3 and SPEC say such a repo's lanes refuse at start, Story 3.2); install's invalid/absent policy handling (false: no wrong outcome); install not counting failed starts (false: install has no counter); no coordinator pi test (false: step 5 precedes the role branch); the literal "build the adapter" reading (false: the Maintainer rewrote the Story).

**Follow-up review recommended:** false. Patched entries: 0 high, 0 medium, 6 low (root-cause entries).

**Verification:**
- `bun test`: 4700 pass, 316 skip, 0 fail (the skips are the sandbox, host-only and live cases that cannot run in a sandboxed session); run before and after the review patches.
- `bun --bun tsc`: exit 0.
- `bun --bun oxlint`: exit 0.
- Matrix audit: every I/O row is covered by a CLI or pure-module test that ran and passed (30 matching cases, 0 skipped).

**Residual risks:** a `pi` lane is refused at the start checks, so a run that only switches the runner version, or fails earlier (connect, snapshot, repo config), exits without the deferral text; the next run that reaches the checks refuses. Install does not refuse a lane whose own agent the policy does not allow (deferred).

**Not committed:** per this run's instructions, the changes stay in the working tree, so the skill's commit-and-clean-tree finalization was not run.
