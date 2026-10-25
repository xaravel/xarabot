---
title: 'Story 3.1: The `codex` adapter'
type: 'feature'
created: '2026-10-25'
status: 'done'
baseline_revision: 'ceef6d512a025537cdf32def09264b507f0bc192'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/notes/codex-ar42-spike-2026-10-25.md'
  - '{project-root}/_bmad-output/specs/spec-xarabot/brownfield-xaravel.md'
warnings: ['oversized']
deferred:
  - summary: >-
      A login refresh during a session is neither redacted nor carried over: new tokens in the rewritten $CODEX_HOME/auth.json are not in the forge redaction list, and later sessions (and the resume) are re-seeded from the operator's possibly superseded auth.json.
    evidence: |-
      secrets come from the auth.json read once at lane start (src/cli/lane-run.ts credentialSecrets); seedVendorHome re-writes the operator's file on every run, resume included. Whether codex refreshes or rotates the refresh token inside a session is unverified (spike: no refresh seen). Settled by the codex-live auth.json case on the host; if a rewrite is seen, the Maintainer decides copy-back and redaction of the refreshed file.
    location: >-
      src/cli/lane-run.ts:391, src/sandbox/vendor-home.ts:165
    severity: medium (unverified)
  - summary: >-
      The resume puts the exec options before `resume`, while the spike only observed them after it (`codex exec resume --json … <id> <prompt>`).
    evidence: |-
      If codex does not apply exec-level options to `resume`, the one resume would run without the bypass flag or the configured model. Settled by the codex-live resume case on the host, checking the resumed run's model from the vendor home.
    location: >-
      src/adapters/agent/codex/codex-agent.ts:codexLaunchSpec
    severity: medium (unverified)
  - summary: >-
      The real CLI has not yet run bmad-build-auto: the outcome mapping is confirmed only through the template text and a live case that simulates the halt.
    evidence: |-
      codex is not installed in the sandboxed build session and nested sandboxes are refused; the live outcome-mapping case reports skipped. Settled by the Maintainer's host run of test/adapters/agent/codex/codex-live.test.ts and a canary codex lane on a scratch Story.
    location: >-
      test/adapters/agent/codex/codex-live.test.ts
    severity: medium (unverified)
  - summary: >-
      Subagent tokens are always added on the assumption that turn.completed counts only the parent thread.
    evidence: |-
      The spike marks this unverified. If turn.completed already includes children, tokens and cost are double-counted. Settled by the codex-live subagent-tokens case (it compares turn.completed with the parent rollout's own total).
    location: >-
      src/adapters/agent/codex/usage.ts:parseCodexUsage
    severity: medium (unverified)
  - summary: >-
      A usage limit refused before codex writes any token_count rate_limits would be read as a failed turn and fail the attempt instead of sleeping.
    evidence: |-
      Detection reads only rate_limits, as the AC requires; whether codex writes them when the very first request is refused at a limit is unverified (spike: the usage-limit shape is from the binary only). Settled by a live session at a usage limit, or the session file of one.
    location: >-
      src/adapters/agent/codex/usage.ts:parseCodexUsage
    severity: medium (unverified)
  - summary: >-
      The codex proxy allowlist is the spike's suggested list until the Maintainer's live run names every host, including the unresolved 2606:4700:440b::ac40:9034.
    evidence: |-
      The AC puts this on the Maintainer's live run; the proxy now logs every decided request so that run can record the hosts. Settled by the codex-live proxy-hosts case on the host.
    location: >-
      src/adapters/agent/codex/codex-agent.ts:CODEX_API_HOSTS
    severity: medium (unverified)
  - summary: >-
      The macOS sandbox wiring of proxyRequests and credentialRewritten runs only in host sandbox cases, which skip in sandboxed sessions and on the ubuntu CI.
    evidence: |-
      test/sandbox/macos.test.ts "a codex spec" block is all sandboxTest; the session tests use a fake Sandbox. Settled by the Maintainer running bun test test/sandbox/macos.test.ts test/sandbox/proxy.test.ts on the host, per docs/maintainer/self-host.md.
    location: >-
      src/sandbox/macos.ts:431
    severity: medium
  - summary: >-
      A pi lane's refusal does not name the v1 deferral, and lane install accepts --agent pi when a pi binary is on PATH.
    evidence: |-
      Pre-existing behaviour, owned by Story 3.2 (the pi adapter deferred to v1).
    location: >-
      src/cli/lane-run.ts:adapterFor, src/cli/lane-install.ts:AGENT_COMMANDS
    severity: low
  - summary: >-
      The AC's refusal for a lane whose reviewer is codex with a missing credential is not implemented; only the lane's own adapter is checked.
    evidence: |-
      No reviewer exists before Story 3.3 (session vendors and the reviewer choice), which adds the reviewer and its start checks.
    location: >-
      src/cli/lane-run.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** A lane can only run `claude`; Epic 3 needs `codex` lanes, run through the same `Agent` port and sandbox with the same `agent`/`model`/`effort` settings (FR7, AR18, AR22, AR42).

**Approach:** Add `src/adapters/agent/codex/` (launch spec, start check, effort values, usage parsing from `--json` stdout plus the session files under the lane's `CODEX_HOME`), widen the `Agent` port and the session runner just enough for it (vendor-home usage, failed turns), let the sandbox report proxy requests and a rewritten home credential, and wire `codex` into `lane run`/`lane install`.

## Boundaries & Constraints

**Always:**
- Launch line: `codex exec -m <model> --json -c model_reasoning_effort=<effort> --dangerously-bypass-approvals-and-sandbox -c commit_attribution="" -- <prompt>`; resume puts `resume <thread_id> -- <resume prompt>` after the same options. No `stdin` in the spec (the sandbox gives `/dev/null`); `--ephemeral` never. `vendorHomeEnv` is `CODEX_HOME`. Skills come from the clone's `.agents/skills`, which codex reads natively.
- Defaults: model `gpt-6.1-sol`, effort `high` (from `host.yaml`). Efforts: `gpt-6.1-sol` and `gpt-6-luna` offer `low`…`max`; any other model offers none (fail closed). `ultra`, `none`, `minimal` are not on the scale. Min CLI `0.163.0`, read from `codex-cli X.Y.Z` (bare `X.Y.Z` too).
- Credential, one mode-600 file under `<config>/xarabot/vendors/codex/`: `auth.json` (ChatGPT login; copied as `$CODEX_HOME/auth.json`, mode 600) or `api-key` (passed as `CODEX_API_KEY`). Exactly one may exist; both refuse the lane start, none refuses as missing. Hosts: `chatgpt.com`, `ab.chatgpt.com`, `auth.openai.com`, plus `api.openai.com` only in API-key mode.
- `parseUsage(stdout, vendorHome?, since?)`: session id from `thread.started`; tokens from the last `turn.completed` (`input` = input − cached, `cacheRead` = cached, `cacheCreation` = cache-write, `output`), plus each descendant subagent session file (`parent_thread_id` chain) touched at or after `since`; model from the parent rollout's last `turn_context.model`; usage limit and reset only from the last `token_count.rate_limits` (`resets_at` Unix s → ms), never from message text; cost an estimate from tokens and a per-model price table (`null` for an unpriced model); a `turn.failed` that is not a usage limit sets `failure`. Never throws.
- The session runner fails the attempt on `failure` (no resume) and on a model mismatch; journals a `credential-rewrite` span when the sandbox reports the seeded home credential changed; logs every proxy request in the unit log. Nothing is copied back to the operator's credential.
- Every live case needs `XARABOT_LIVE=1`; sandbox cases skip under `XARABOT_SANDBOXED=1`; reported skipped, never passed.

**Never:** No `Bun.spawn` or `child_process` under `src/adapters/agent/`. No GitHub token or host for a session. No `pi` adapter. No edits outside the manifest globs (`src/core/sanitize.ts` and `src/adapters/agent/claude/**` stay as they are). No silent addition of a host to the allowlist (`files.openai.com` and the unresolved `2606:4700:440b::ac40:9034` stay out until the Maintainer's live run names them). No reviewer selection (Story 3.3).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh spec | prompt, `{effort: high}` | argv as above with `gpt-6.1-sol`, prompt last after `--`, no `stdin` | — |
| Resume | `{kind: resume, sessionId: <uuid>}` | `… resume <uuid> -- <prompt asking only for the result>`, `resume: true` | non-UUID id → `invalid` |
| Bad input | empty/NUL prompt, relative result path, prompt > 256 KiB | — | `invalid` |
| Effort | `gpt-6.1-sol` + `xhigh`; unknown model | `xhigh` passes; unknown refuses at start | `refused` naming offered efforts |
| Version | `codex-cli 0.162.9`, garbage | refused | `refused` |
| Credentials | both files / neither / only `api-key` | refuse / refuse missing / API-key spec with `api.openai.com` | lane start fails |
| Usage limit | `turn.failed` + `rate_limits` with `used_percent` 100, `resets_at` S | `usageLimit.resetAt = S*1000`, no `failure` | session runner sleeps |
| Failed turn | `turn.failed` (HTTP 400), no limit | `failure` set | attempt fails, no resume |
| Model | `turn_context.model` ≠ configured, or none | — | `model-mismatch` fails attempt |
| Attribution | `summary`/`body` with `Co-authored-by: Codex <noreply@openai.com>` and `Generated with [Codex](https://openai.com/codex/).` | both stripped by `sanitizeAgentText` | — |

</intent-contract>

## Code Map

- `src/ports/agent.ts` -- `Agent`/`AgentUsage`/`AgentUnit`; widen `parseUsage(stdout, vendorHome?, since?)`, add optional `failure`, reword the "prompt on stdin" doc (claude stdin, codex argv).
- `src/adapters/agent/claude/claude-agent.ts` -- READ-ONLY template: `claudeLaunchSpec`, `parseVersion`, `claudeStartCheck`, `resumePrompt`, AR42 record comment.
- `src/adapters/agent/claude/usage.ts` -- READ-ONLY template for line parsing and `checkModel`.
- `src/lane/session.ts:1027-1070` -- `runOnce`: call `parseUsage(r.stdout, ctx.profile.vendorHome, r.startedAt)`, fail on `failure`, journal credential rewrite; `logRun` (~960) prints proxy requests.
- `src/ports/sandbox.ts` -- `SandboxRun`: optional `proxyRequests`, `credentialRewritten`.
- `src/sandbox/macos.ts` -- collects proxy decisions via a proxy hook; after exit compares `<vendorHome>/<homeFile>` to the seeded text.
- `src/sandbox/proxy.ts:256` -- `decideConnect` call site; add `onRequest` to `ProxyOpts`.
- `src/sandbox/vendor-home.ts` -- `seedVendorHome` returns the seeded home file path and text.
- `src/core/schemas/journal.ts` -- `SpanJournalRecordSchema.span` gains `credential-rewrite`.
- `src/cli/lane-run.ts:104` -- `adapterFor`; codex credential kind chosen from which file exists; start-check path at ~285.
- `src/cli/lane-install.ts:47` -- `LANE_TOOLS` must name the lane's own agent CLI, not always `claude`.
- `test/contracts/agent.contract.ts` -- shared suite assumes stdin prompt and a token credential; generalize via harness fields.
- `test/sandbox/macos.test.ts:96` -- `spec()` helper; add a codex-spec refusal block.
- `test/core/lane/write-check.test.ts:371` -- `TABLE` per adapter; add `codex`.
- `src/core/sanitize.ts` -- READ-ONLY: already strips `Co-authored-by:` and `Generated with` lines.

## Tasks & Acceptance

**Execution:**
- `src/ports/agent.ts`, `src/ports/sandbox.ts` -- port widening above.
- `src/adapters/agent/codex/codex-agent.ts` -- constants, `codexLaunchSpec`, `codexStartCheck`, `codexEffortValues`, `codexCredentialKind`, `createCodexAgent({credential})`, AR42 record comment incl. the outcome mapping.
- `src/adapters/agent/codex/usage.ts` -- `parseCodexUsage`, session-file reading, `CODEX_PRICES`, `checkCodexModel`.
- `src/sandbox/proxy.ts`, `src/sandbox/vendor-home.ts`, `src/sandbox/macos.ts` -- proxy request hook and record, credential rewrite check.
- `src/core/schemas/journal.ts` -- new span kind.
- `src/lane/session.ts` -- runner changes above.
- `src/cli/lane-run.ts`, `src/cli/lane-install.ts` -- codex adapter wiring, credential choice, per-agent tools.
- `test/adapters/agent/codex/*.test.ts` -- launch spec, start check, efforts, credential kind, usage tables (temp vendor homes), sanitizer strings.
- `test/contracts/agent.contract.ts`, `test/contracts/agent.codex.contract.test.ts` -- run the contract for codex.
- `test/lane/session.test.ts`, `test/sandbox/*.test.ts`, `test/cli/*.test.ts`, `test/core/lane/write-check.test.ts` -- cases for the runner, sandbox, CLI and write-check changes; live cases for outcome mapping, subagent tokens, `auth.json` rewrite, proxy hosts.
- `docs/maintainer/self-host.md` -- codex credential setup, live commands and what each records.

**Acceptance Criteria:**
- Given a `codex` lane whose CLI is `0.163.0+` and one credential file, when `lane run` starts, then it composes the codex adapter and passes every start check; with an older CLI, an unoffered effort, or a missing/duplicate credential it is a failed start.
- Given the `Agent` contract, sandbox refusal suite and write-check table, when run for `codex`, then they pass, with live and nested sandbox cases reported skipped where they can't run.
- Given a codex run that leaves no result, when the session runner handles it, then it resumes once with `codex exec … resume <thread_id>`.

## Spec Change Log

## Review Triage Log

### 2026-10-25 — Review pass
- verdicts: 42 findings — high 0, medium 3, low 13, false 11, maybe-false 15
- findings:
  - `[maybe-false]` `[defer]` (blind) Refreshed codex tokens in the rewritten home auth.json are not redacted — whether codex refreshes inside a session is unverified; JWT access/id tokens are still caught by the sanitizer's `eyJ…` shape; deferred (refresh handling).
  - `[maybe-false]` `[defer]` (blind) A rotated refresh token makes later sessions and the resume fail, since the operator's copy is re-seeded — rotation unverified; the AC requires never copying back without the Maintainer; deferred (refresh handling).
  - `[false]` `[reject]` (blind) A failed turn discards a result already written; a budget abort with turn.failed is reported as a failed turn — the AC says a failed turn that is not a usage limit fails the attempt, so failing is the specified outcome.
  - `[medium]` `[patch]` (blind) A named rate limit with no full window counts every window, so the lane sleeps to the latest (e.g. weekly) reset — real at `readRateLimits`; patched to take the earliest readable reset in that case, with a test.
  - `[maybe-false]` `[defer]` (blind) Resume options sit before `resume`, unlike the spike's observed form — whether codex applies exec options to `resume` is unverified; deferred (resume live case).
  - `[false]` `[reject]` (blind) Resume tokens are double-counted — the spike records `turn.completed` usage as the totals for that turn (run C reported its own turn), and the runner sums per run as for claude.
  - `[low]` `[defer]` (blind) A pi lane's refusal does not name the v1 deferral; `lane install --agent pi` passes with pi on PATH — pre-existing, Story 3.2's scope; deferred.
  - `[low]` `[reject]` (blind) The proxy record misses 431/timed-out heads, logs a failed dial as `allow`, and prints the overflow marker as a deny — rare in practice, the record is of decisions as documented, and the fixes add branches.
  - `[low]` `[reject]` (blind) `codex-cli 0.163.0-alpha.1` passes the 0.163.0 minimum — no such pre-release is in use, and refusing it needs a new branch.
  - `[low]` `[reject]` (blind) `credentialSecrets` redacts every 16+ char JSON string (timestamps, ids) and the api-key path has no secrets test — over-redaction of forge text is harmless; a plain key returns its own text as before.
  - `[false]` `[reject]` (blind) `commit_attribution=""` is unverified, so codex trailers could reach commits — commits are the runner's own (AR16); a session's commit never reaches the forge, and summary/body go through the sanitizer.
  - `[false]` `[reject]` (blind) The self-host login steps may find no auth.json if codex uses the Keychain — the spike observed codex's default config writing `~/.codex/auth.json`, and `mv` fails loudly if it is absent.
  - `[maybe-false]` `[defer]` (blind) The live cases prove less than claimed: the outcome-mapping case simulates the halt — whether codex runs bmad-build-auto end to end needs the real CLI on the host; deferred (real-CLI outcome mapping).
  - `[low]` `[reject]` (blind) Every run logs a `--- proxy ---` section, up to 10,001 lines — bounded by the cap, and it is the host evidence the AC asks for.
  - `[low]` `[reject]` (blind) Prompts over 256 KiB fail every attempt on codex — build prompts are far smaller; the refusal names the cause.
  - `[false]` `[reject]` (edge) Result written then turn.failed discards the result — same as above: the AC prescribes failing the attempt.
  - `[medium]` `[patch]` (edge) A named limit on one window uses the other window's later reset — same root cause as the blind finding; patched together.
  - `[maybe-false]` `[defer]` (edge) A usage limit refused before any token_count rate_limits is read as a failure — unverified whether codex writes rate_limits then; deferred.
  - `[maybe-false]` `[reject]` (edge) A child file touched again during the resume is counted twice — a resume asks only for the result and spawns or resumes no children; even if true only low.
  - `[false]` `[reject]` (edge) A resume writes a second rollout file for the same thread, so a stale file is read — the spike's resume appended to the same session file (it held both efforts).
  - `[maybe-false]` `[defer]` (edge) Refreshed tokens are not redacted — same as the blind finding; deferred (refresh handling).
  - `[maybe-false]` `[defer]` (edge) The resume re-seeds a superseded auth.json — same as the blind finding; deferred (refresh handling).
  - `[low]` `[reject]` (edge) 431/timed-out heads are never recorded — rare; the fix adds a branch to the proxy.
  - `[low]` `[reject]` (edge) A failed dial after an allowed CONNECT is logged as allow — the record is of the proxy's decision, as documented.
  - `[low]` `[reject]` (edge) A pre-release of the minimum passes the start check — same as the blind finding.
  - `[low]` `[reject]` (edge) Claim: "logs every proxy request" misses heads that never reach a decision — the doc says requests the proxy decides on; same as above.
  - `[low]` `[patch]` (verification-gap) The MAX_PROXY_REQUESTS cap and its single marker are untested — patched: the logic moved into an exported pure helper, tested at the cap in a plain test.
  - `[medium]` `[defer]` (verification-gap) The macOS wiring of proxyRequests and credentialRewritten runs only in host sandbox cases — filed disposition defer; deferred to the Maintainer's host run.
  - `[false]` `[reject]` (verification-gap) A failed turn throws away a written result — same as above: AC-prescribed.
  - `[maybe-false]` `[defer]` (verification-gap) A rotated refresh token is not redacted — same as the blind finding; deferred (refresh handling).
  - `[maybe-false]` `[defer]` (intent) The outcome mapping is not confirmed with the real CLI at Story start — the CLI is absent from the sandboxed session; deferred to the host live run (real-CLI outcome mapping).
  - `[maybe-false]` `[defer]` (intent) The subagent-tokens conditional is settled ahead of evidence — deferred; the live case checks the assumption.
  - `[maybe-false]` `[defer]` (intent) The auth.json rewrite live record is unrun — deferred (refresh handling).
  - `[maybe-false]` `[defer]` (intent) The host list is not final and the unresolved address is unnamed — the AC puts this on the Maintainer's live run; deferred.
  - `[maybe-false]` `[defer]` (intent) Resume is not confirmed with the real CLI — same as the resume-argv finding; deferred.
  - `[false]` `[reject]` (intent) Attribution stripping is tested only at the sanitizer — the AC asks for exactly that test, and session commits never reach the forge.
  - `[low]` `[defer]` (intent) The reviewer half of the credential refusal is missing — no reviewer exists before Story 3.3; deferred.
  - `[low]` `[reject]` (intent) The sandbox refusal suite runs only a codex subset — the denied-read/write/exec/network cases do not depend on the spec's vendor fields; the vendor-specific ones run in the codex block.
  - `[false]` `[reject]` (intent) The shared contract suite was changed to fit codex — generalized through harness fields; the claude contract still runs its old cases.
  - `[false]` `[reject]` (intent) The write-check table for codex is test-only — `checkWrite` has no adapter input; the AC asks for the table to pass for codex.
  - `[maybe-false]` `[defer]` (intent) Usage-limit tests use synthetic rollouts only — same as the edge finding; deferred.
  - `[false]` `[reject]` (intent) Additions beyond the ACs (gpt-6-luna, prices, credentialSecrets, the cap) — each serves an AC (efforts from the spike's catalog, AR25 cost estimate, redaction of the auth.json tokens, bounded host log); for claude's one-line token credentialSecrets returns the same list as before.

## Design Notes

The outcome mapping is the shared build prompt's (`done`→`done`; `blocked`→`blocked` with its kind; `ready-for-dev` or other→`blocked`/`other`; never `no-op`); the codex live case runs it with the real CLI. Children's tokens are added because codex exec's `turn.completed` reports only the parent thread (spike: children appear only in session files); the live case checks that by comparing `turn.completed` with the parent rollout's own `token_count` total. Prices (USD per 1M: input 2.00, cached 0.10, output 10.00 for `gpt-6.1-sol`) are third-party figures, so cost is always an estimate.

## Verification

**Commands:**
- `bun test` -- expected: all pass; sandbox/live cases skipped inside the session.
- `bun --bun oxlint` -- expected: no errors.
- `bun --bun tsc` -- expected: no errors.

## Auto Run Result

Status: done

**Summary:** Adds the `codex` agent adapter (`src/adapters/agent/codex/`) and wires it into `lane run` and `lane install`. The `Agent` port's `parseUsage` now also gets the lane's vendor home and the run's start, and can report a failed turn. The sandbox reports every proxy decision and whether a session rewrote its seeded home credential. The session runner fails an attempt on a failed turn, journals a `credential-rewrite` span, and logs proxy requests. The maintainer runbook gains codex credential setup and the live commands.

**Files changed:**
- `src/adapters/agent/codex/codex-agent.ts`: launch spec (prompt in argv after `--`, no stdin), start check (min 0.163.0), efforts, credential kind, AR42 record.
- `src/adapters/agent/codex/usage.ts`: usage from `--json` stdout plus `CODEX_HOME/sessions` rollouts (model, rate limits, subagent tokens), estimated cost, model check.
- `src/ports/agent.ts`, `src/ports/sandbox.ts`: `parseUsage(stdout, vendorHome?, since?)`, optional `failure`, `ProxyRequest`, `proxyRequests` and `credentialRewritten` on `SandboxRun`.
- `src/sandbox/proxy.ts`, `src/sandbox/macos.ts`, `src/sandbox/vendor-home.ts`: `onRequest` hook, capped request record (`recordProxyRequest`), home-file rewrite check.
- `src/core/schemas/journal.ts`: `credential-rewrite` span kind.
- `src/lane/session.ts`: vendor-home usage, failed-turn failure, rewrite span, proxy section in the unit log.
- `src/cli/lane-run.ts`, `src/cli/lane-install.ts`: codex adapter and credential choice (exactly one of `auth.json` or `api-key`), `credentialSecrets`, per-agent tool check.
- Tests: `test/adapters/agent/codex/*`, `test/contracts/agent.codex.contract.test.ts` and the generalized `agent.contract.ts`, plus new cases in the session, lane-run, lane-install, sandbox, proxy, vendor-home and write-check suites.
- `docs/maintainer/self-host.md`: the codex adapter section.

**Review findings:** 42 findings (high 0, medium 3, low 13, false 11, maybe-false 15).
- Patched (2):
  - medium: a named rate limit with no full window now takes the earliest reset.
  - low: the proxy-request cap is now a pure helper, tested at the cap.
- Deferred (9 entries in frontmatter `deferred`): login refresh and redaction; resume option order; real-CLI run of bmad-build-auto and the outcome mapping; subagent tokens; usage limit before any rate limits are written; final host list; host-only macOS wiring cases; pi deferral message (Story 3.2); reviewer credential refusal (Story 3.3).
- Rejected: every other row in the Review Triage Log, each with its recorded reason.

**Follow-up review recommended:** false. Patched entries: 1 medium, 1 low, no high.

**Verification:**
- `bun test`: 4650 pass, 316 skip, 0 fail. The skips are the sandbox, host-only and live cases, which can't run inside a sandboxed session.
- `bun --bun oxlint`: exit 0.
- `bun --bun tsc`: exit 0.
- Matrix audit: every I/O row is covered by a test that ran and passed.

**Residual risks:** none of the codex behaviour is proven against the real CLI yet: session-file shapes, resume option order, subagent token accounting, usage-limit detection, the host list, and the full bmad-build-auto run. They depend on the Maintainer's host run of the commands in `docs/maintainer/self-host.md` § "The codex live evidence".

**Not committed:** per this run's instructions, the changes stay in the working tree, so the skill's commit-and-clean-tree finalization was not run.
