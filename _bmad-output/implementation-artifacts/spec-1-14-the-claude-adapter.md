---
title: 'Story 1.14: The `claude` adapter'
type: 'feature'
created: '2026-10-23'
baseline_revision: 'd6fbd698424fb49461de42b703b6f2650847d284'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      The keep (resume) path's unlockTree in seedVendorHome is never exercised by a test.
    evidence: |-
      No vendor-home, sandbox or contract test leaves a non-writable vendor home before a keep: true seed; deleting the unlockTree call passes every test. Only a homeFile-mode vendor reaches the failure, and claude uses env mode. Add a keep: true homeFile case with a 0o500 home when such an adapter lands.
    location: >-
      src/sandbox/vendor-home.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** There is no `Agent` port and no `claude` adapter, so a lane cannot turn a unit and its lane settings (`model`, `effort`) into a sandboxed `claude -p` session, check the CLI before starting, read the session's usage, or resume a session that left no result. Claude Code also fails to start inside the sandbox (`EPERM`), because it ignores `TMPDIR` and writes to `/tmp/claude-<uid>` (FR7, AR15, AR18, AR22, AR30, AR42).

**Approach:** Record the AR42 `claude` spike in the adapter and its tests, declare the `Agent` port, write the `claude` adapter (`launchSpec`, `parseUsage`, `effortValues`, start check, resume) on top of the existing `Sandbox` port, make the sandbox set `CLAUDE_CODE_TMPDIR` inside the session's temp folder for `claude`, and pass an `Agent` contract suite with a stub CLI.

## Boundaries & Constraints

**Always:**
- Spike record (AR42 `claude` half), as a doc comment in the adapter and asserted by tests:
  - **Output format:** `--output-format stream-json --verbose` (stream-json needs `--verbose` under `-p`). Observed on 2.1.309: a `system`/`init` line carries `session_id`, `model`, `apiKeySource`; a final `result` line carries `session_id`, `usage`, `modelUsage` (per model: `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD`), `total_cost_usd`, `is_error`, `result`; a `rate_limit_event` line carries `rate_limit_info` {`status`, `resetsAt` epoch seconds}. `json` gives only the result line (no `model`, no reset time).
  - **Outcome mapping:** `bmad-build-auto` halts `done`, `blocked` or `ready-for-dev` (only when told to halt after planning) and never yields `no-op`. `done` → `done`; `blocked` → `blocked` with the kinds already in the template; `ready-for-dev` or any other halt → `blocked`/`other`. The first-build result step never offers `no-op`; the fix result step keeps it.
  - **Resume:** the same argv plus `--resume <session_id>`, run in the same vendor home, which the sandbox then does not empty (the transcript lives there); the prompt (on stdin) asks only for the result, naming the result path. One resume, never more (the lane counts; this Story supplies the means).
- `launchSpec(unit, settings, resultPath)` returns `Result<LaunchSpec>`: argv `claude -p --model <model> --effort <effort> --permission-mode auto --output-format stream-json --verbose --settings {"attribution":false,"sandbox":{"enabled":false}}` (plus `--resume <id>` on resume); prompt on stdin, never in argv; `vendor` `claude`; `vendorHomeEnv` `CLAUDE_CONFIG_DIR`; credential `{file: "oauth-token", env: "CLAUDE_CODE_OAUTH_TOKEN"}`; `apiHosts` `["api.anthropic.com"]`. `XARABOT_RESULT` and the clone as working directory come from the sandbox (profile `resultPath`, `clone`). Unset `model` → `claude-opus-5-5`; `effort` default `high`.
- Credential form (for Story 1.20's runbook): `$XDG_CONFIG_HOME/xarabot/vendors/claude/oauth-token` (fallback `~/.config`), mode 600, holding the one-line token printed by `claude setup-token`. Recorded in `docs/maintainer/claude-credential.md`.
- `effortValues(model)`: exact model ids → offered efforts. `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-haiku-5-5`: all five; `claude-opus-4-6`, `claude-sonnet-4-6`: `low medium high max`; any other model: none (fails closed).
- Start check `startCheck(settings, versionOutput)`: refuses an effort not in `effortValues(model)` (message names model, effort and the offered list), an unparseable version, and a version below `2.1.304`. Never drops or rounds an effort.
- `parseUsage(stdout)` returns session id, reported model (init line), token totals (sum of `modelUsage`, else `usage`), cost in USD with `estimate: true` unless `apiKeySource` names an API key, and a usage-limit hit `{resetAt: epoch ms | null}` from a `rejected` `rate_limit_event`, or from an error result whose text says the usage limit was hit (`resetAt` from a `|<epoch>` suffix, else `null`). Non-JSON lines are skipped. `checkModel(usage, configured)` refuses a missing or different reported model.
- Sandbox: `sessionDirs` gains `cliTmp` (`<tempDir>/cli-tmp`), rebuilt every session; for vendor `claude` the env gets `CLAUDE_CODE_TMPDIR=<tempDir>/cli-tmp` (the per-vendor name lives in `src/sandbox/`, no general vendor-variables field); `CLAUDE_CODE_TMPDIR` is reserved; a `resultPath` inside `cli-tmp` is refused. `LaunchSpec.resume?: boolean` keeps the vendor home's contents (credential still re-checked and, in `homeFile` mode, rewritten).
- `src/sandbox/tools.ts` exports `cliVersion(cmd, launching)` (resolved on `PATH`, `--version`, via the existing probe) for the start check's input.

**Never:** No `Bun.spawn`, `child_process` or `sandbox-exec` under `src/adapters/agent/`. No GitHub token or host for the session. No lane loop, retries, journal or usage-limit sleep (Stories 1.16, 1.18). No `codex`/`pi` adapters. No model aliases (`opus`) — ids only. No prompt in argv.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Defaults | `{}` settings, fresh unit | argv with `claude-opus-5-5`, `high`, stream-json, settings JSON; stdin = prompt | none |
| Resume | `{kind:"resume", sessionId}` | argv + `--resume <id>`, `resume: true`, stdin asks only for the result at `resultPath` | bad session id → `err("invalid", …)` |
| Bad input | relative `resultPath`, empty prompt, NUL in prompt | — | `err("invalid", …)` naming the field |
| Effort not offered | `claude-opus-4-6` + `xhigh`; unknown model | — | start check `err("refused", …)` |
| Old CLI | `2.1.303 (Claude Code)`, `garbage` | — | `err("refused", …)` |
| Usage | stub stream-json | id, model, tokens, cost estimate, no limit | no result line → tokens/cost `null` |
| Usage limit | `rate_limit_event` rejected `resetsAt` 1761300000 | `usageLimit.resetAt` 1761300000000 | unparseable → `resetAt: null` |
| Model mismatch | reported `claude-sonnet-5-5`, configured `claude-opus-5-5` | — | `err("model-mismatch", …)` |

</intent-contract>

## Code Map

- `src/ports/sandbox.ts` -- `LaunchSpec`, `SandboxProfile`; add `resume?`.
- `src/sandbox/environment.ts` -- `sessionDirs`, `buildSessionEnv`, `isReservedEnvName`; add `cliTmp` and the vendor's temp variable.
- `src/sandbox/macos.ts` -- `validateProfile` (rebuilt folders list), `session` (removeTree/mkdir of session dirs, `seedVendorHome` call, `buildSessionEnv` call).
- `src/sandbox/vendor-home.ts` -- `seedVendorHome`; add a keep-contents option for resume.
- `src/sandbox/tools.ts` -- `which`, private `probe`; add `cliVersion`.
- `src/core/prompt/template.ts` -- `result_build` mapping: drop `no-op`, add `ready-for-dev`.
- `src/core/schemas/host.ts` -- `Effort` enum and `LaneSchema` (`model`, `effort`) to reuse.
- `src/core/result.ts` -- `Result`, `ok`, `err`.
- `test/sandbox/macos.test.ts` -- env allowlist expectation (add `CLAUDE_CODE_TMPDIR`), fixtures (`spec`, `launching`, `profile`, `credFile` `oauth-token`).
- `test/sandbox/environment.test.ts` -- `buildSessionEnv` cases.
- `test/core/prompt/build-prompt.test.ts:65` -- mapping test lists `no-op`; update.
- `test/contracts/run-contract.ts` -- `runContract` for the agent suite.
- `test/support/sandbox.ts`, `test/support/live.ts` -- `sandboxTest`, `liveSandboxTest`.
- `test/support/boundaries.ts` -- agent adapters may not spawn; checked by `test/boundaries.test.ts`.

## Tasks & Acceptance

**Execution:**
- `src/ports/agent.ts` -- `AgentUnit` (`{kind:"fresh", prompt}` | `{kind:"resume", sessionId}`), `AgentSettings` (`model?`, `effort`), `AgentUsage`, `Agent` with `launchSpec`, `parseUsage`, `effortValues`, `startCheck`, `defaultModel`, `minVersion` -- the AR1 port.
- `src/sandbox/environment.ts`, `src/sandbox/vendor-home.ts`, `src/sandbox/macos.ts`, `src/ports/sandbox.ts` -- `cli-tmp` folder, `CLAUDE_CODE_TMPDIR` for `claude`, reserved name, resultPath refusal, resume keeps the vendor home.
- `src/sandbox/tools.ts` -- `cliVersion`.
- `src/adapters/agent/claude/claude-agent.ts` -- spike record, `createClaudeAgent()`, effort table, version compare, resume prompt.
- `src/adapters/agent/claude/usage.ts` -- pure `parseClaudeUsage`, `checkModel`.
- `src/core/prompt/template.ts` + its test -- outcome mapping per the spike.
- `docs/maintainer/claude-credential.md` -- credential file name, form, mode, command.
- `test/adapters/agent/claude/claude-agent.test.ts`, `test/adapters/agent/claude/usage.test.ts` -- matrix rows, the spike record's argv and mapping.
- `test/contracts/agent.contract.ts`, `test/contracts/agent.claude.contract.test.ts` -- contract suite: pure properties everywhere; sandboxed stub-CLI cases (env holds `XARABOT_RESULT`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_TMPDIR` inside the temp folder; cwd is the clone; stdin is the prompt; resume keeps the vendor home); a live sandboxed `claude -p` start with no `EPERM` (`liveSandboxTest`, needs the credential file); a live smoke (`liveSandboxTest`) that writes a result and parses usage.
- `test/sandbox/*.test.ts` -- updated allowlist and new folder/refusal/resume cases.

**Acceptance Criteria:**
- Given the `Agent` contract suite, when it runs with a stub CLI, then the `claude` adapter passes, and the live cases report skipped without `XARABOT_LIVE=1`, on non-macOS, or under `XARABOT_SANDBOXED=1`.
- Given the boundaries test, when it runs, then nothing under `src/adapters/agent/` spawns or imports another adapter.

## Spec Change Log

## Review Triage Log

### 2026-10-23 — Review pass
- verdicts: 30 findings — high 0, medium 2, low 22, false 6, maybe-false 0
- findings:
  - `[false]` `[reject]` (intent) "resumes once" is not enforced in the adapter — the adapter may not spawn (AR18, boundaries test); Story 1.16 owns the flow ("its result is missing after the one resume"); this Story supplies the resume launch.
  - `[low]` `[reject]` (intent) `checkModel` is not on the port or called — grouped with the blind `checkModel` row; the lane compares `usage.model` with its configured model in Story 1.16, and a port method is new public surface for a check any caller can do.
  - `[false]` `[reject]` (intent) the start check is not called before a session — Story 1.19's lane start runs "its adapter's start check"; this Story supplies it.
  - `[medium]` `[patch]` (intent) the real sandboxed `claude -p` no-`EPERM` case needed `XARABOT_LIVE=1`, beyond the AC's skip conditions — the case now runs as a sandbox case with a dummy credential, skipped off macOS, under `XARABOT_SANDBOXED=1` or without `claude` on `PATH`.
  - `[false]` `[reject]` (intent) the spike is not backed by real observation — planning ran the real 2.1.309 CLI (init/assistant/result lines recorded), and the implementation's live runs confirmed `model`, `apiKeySource` and `resetsAt`.
  - `[low]` `[reject]` (intent) an unset `effort` is never seen by `launchSpec` — lane settings come from `LaneSchema`, whose `effort` defaults to `high`; making the port field optional adds surface for no caller.
  - `[false]` `[reject]` (intent) efforts come from a table, not the CLI — the CLI exposes no per-model list; the table fails closed as the spec states.
  - `[low]` `[reject]` (intent) "claude's own sandbox off" is checked only as argv — verifying the CLI honours a setting needs a live probe of CLI internals; the live cases run the real CLI with it.
  - `[false]` `[reject]` (intent) the epic context and spec are outside the reviewed diff — the spec is the claims file by design; the epic context is the step-01 regeneration.
  - `[low]` `[patch]` (edge) a later usage-limit error text without `|<epoch>` overwrote a known `resetsAt` with `null` — the earlier reset is kept.
  - `[low]` `[patch]` (edge) a rejected event followed by a successful result still reported a limit — grouped with the blind row; a non-error result now clears `usageLimit`.
  - `[low]` `[reject]` (edge) a banner line before the version — `claude --version` prints one line; adds a branch for an unseen case.
  - `[low]` `[reject]` (edge) a CLI whose shebang needs an interpreter off the probe `PATH` — the session's own `PATH` is `<tempDir>/bin` plus system dirs, so such a CLI cannot run in the sandbox either; refusing early is right.
  - `[low]` `[reject]` (edge) a backtick or newline in `resultPath` breaks the resume prompt — the lane builds the path under its state folder, and `buildPrompt` already refuses such paths for every fresh prompt; a second guard is complexity for an unreachable input.
  - `[low]` `[reject]` (edge) a resume into an empty vendor home fails inside the session — the session then leaves no result, which Story 1.16 counts as a failed attempt, the correct outcome.
  - `[low]` `[patch]` (verification-gap) `epochMs`'s milliseconds branch was untested — a `resetsAt: 1761300000000` case added.
  - `[low]` `[defer]` (verification-gap) `unlockTree` on the `keep` path is never exercised — only a `homeFile`-mode vendor reaches it, and `claude` uses `env` mode; deferred to the first `homeFile` adapter.
  - `[medium]` `[patch]` (blind) the first-build prompt still lets `no-op` through via the embedded build JSON Schema — the result step now says `bmad-build-auto` has no `no-op` outcome and never to report one; the schema stays shared with the fix step, which keeps `no-op`.
  - `[low]` `[reject]` (blind) `checkModel` is not on the `Agent` port — same group as the intent row above.
  - `[low]` `[patch]` (blind) `usageLimit` is never cleared — same group as the edge row; same fix.
  - `[low]` `[reject]` (blind) a resume keeps config files the session wrote to its vendor home — the session could already run anything its sandbox allows, and it keeps the clone (with its own `.claude/`) between sessions too; the sandbox, not the CLI's config, is the boundary, and only this session's own leftovers survive.
  - `[low]` `[reject]` (blind) the sandbox trusts `resume: true` — the lane sets it only right after the same session (Story 1.16); tracking session ids per vendor home adds state for a caller bug not yet written.
  - `[low]` `[reject]` (blind) `launchSpec` does not check per-model efforts — the start check runs at lane start (Story 1.19) and refuses; duplicating it adds a second refusal path.
  - `[low]` `[reject]` (blind) `resultPath` unescaped in the resume prompt — same as the edge row.
  - `[low]` `[patch]` (blind) the runbook put the token in shell history and created folders before `umask 077` — rewritten to read from the clipboard with `umask 077` first, plus the minimum CLI version and renewal.
  - `[low]` `[reject]` (blind) malformed `modelUsage` gives zero totals instead of `null` — needs a CLI format change to happen; the journal labels tokens as reported.
  - `[low]` `[reject]` (blind) the version check and the launch may resolve different binaries — both resolve the same launching `PATH` moments apart; threading a path through adds surface for an unlikely race.
  - `[low]` `[reject]` (blind) prerelease versions pass as releases — Claude Code ships plain `x.y.z` versions.
  - `[low]` `[reject]` (blind) contract gaps (token absent from argv/stdin, usage-limit and `homeFile` resume cases, where the CLI wrote) — argv and stdin are built without the token by construction; usage-limit parsing is covered in `usage.test.ts`.
  - `[false]` `[reject]` (blind) the diff omits the epic context and spec — same as the intent row.

## Design Notes

A resume is a continuation of the same session, not a new one: AR18's re-seed protects one session from another, and the vendor home at that point holds only this session's own transcript, which `--resume` needs. The env-mode credential is still re-read and re-checked.

## Verification

**Commands:**
- `bun test` -- expected: exit 0
- `bun --bun oxlint` -- expected: exit 0
- `bun --bun tsc` -- expected: exit 0

## Auto Run Result

Status: done

**Summary:** Added the `Agent` port and the `claude` adapter. The adapter does `launchSpec`, `parseUsage`, `effortValues`, a start check and a resume launch. The AR42 `claude` spike is recorded in the adapter and asserted by tests: the output format is `stream-json --verbose`; `bmad-build-auto` halts map onto the `build` result with `ready-for-dev` going to `blocked`/`other` and no `no-op`; a resume is `--resume <id>` in the kept vendor home. The sandbox now sets `CLAUDE_CODE_TMPDIR` inside the session's temp folder, so Claude Code starts without `EPERM`.

**Files changed:**
- `src/ports/agent.ts`: the `Agent` port (unit, settings, usage types; `launchSpec`, `parseUsage`, `effortValues`, `startCheck`).
- `src/adapters/agent/claude/claude-agent.ts`: the spike record, argv, defaults (`claude-opus-5-5`, `high`), effort table, version check (2.1.304) and resume prompt.
- `src/adapters/agent/claude/usage.ts`: `parseClaudeUsage` (session id, model, tokens, cost estimate, usage limit) and `checkModel`.
- `src/sandbox/environment.ts`, `macos.ts`, `vendor-home.ts`, `src/ports/sandbox.ts`: the `cli-tmp` folder, `CLAUDE_CODE_TMPDIR` for `claude`, reserved name, and `LaunchSpec.resume` keeping the vendor home.
- `src/sandbox/tools.ts`: `cliVersion` for the start check.
- `src/core/prompt/template.ts`: the first-build outcome mapping per the spike.
- `docs/maintainer/claude-credential.md`: the credential file (`vendors/claude/oauth-token`, mode 600, the `claude setup-token` token) for Story 1.20's runbook.
- Tests: `test/adapters/agent/claude/*`, `test/contracts/agent.contract.ts` and `agent.claude.contract.test.ts` (new); sandbox and prompt tests updated.

**Review findings:** 30 findings: 0 high, 2 medium, 22 low, 6 false.
- **Patched (6 entries):** the no-`EPERM` real-CLI case now runs as a sandbox case with a dummy credential (medium); the first-build result step forbids `no-op` (medium); a known reset time is kept and a later success clears the usage limit; the milliseconds reset branch is tested; the runbook keeps the token out of shell history.
- **Deferred (1):** an untested `unlockTree` on the resume path, reached only by a `homeFile`-mode vendor.
- **Rejected:** 17 low and 6 false; each reason is in the Review Triage Log.

**Follow-up review recommended:** true. Two medium entries were patched. The named unverified risk: the new no-`EPERM` sandbox case calls the real CLI, which makes a network request with a dummy token on every macOS `bun test` run; its behaviour on a host with no network (it relies on a 60 s abort) was not checked.

**Verification:**
- `bun test`: 1849 pass, 61 skip, 0 fail.
- `bun --bun oxlint` and `bun --bun tsc` exit 0.
- The implementation ran the live cases (`XARABOT_LIVE=1`) against Claude Code 2.1.309 in the sandbox: a start with no `EPERM`, a smoke session that wrote its result and reported usage, and a real `--resume` in the kept vendor home.

**Residual risks:**
- Whether `--settings {"attribution": false, "sandbox": {"enabled": false}}` passes Claude Code's settings validation was not confirmed (in `-p` mode an invalid settings value is silently ignored).
- `effortValues` is a fixed table of model ids; a new model refuses until it is added.
- The lane (Stories 1.16, 1.19) must call the start check, `checkModel` and the one resume; this Story supplies them only.
- The implementation subagent once rewrote `src/sandbox/environment.ts` wholesale with a script rather than the Edit tool; the content matches targeted edits.
