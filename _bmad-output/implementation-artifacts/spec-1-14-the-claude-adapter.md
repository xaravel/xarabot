---
title: 'Story 1.14: The `claude` adapter'
type: 'feature'
created: '2026-10-23'
status: 'blocked'
baseline_revision: '1f4a0a590c39648d36416a69b753039a70c9a02a'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A lane has no `Agent` port and no way to run Claude Code: nothing turns lane settings into a sandboxed `claude -p` launch, reads the session id, tokens, cost, model and usage limit back from its output, resumes a session that wrote no result, or refuses an unsupported effort or a too-old CLI (FR7, AR15, AR18, AR22, AR30, AR42).

**Approach:** Add `src/ports/agent.ts` and the `claude` adapter in `src/adapters/agent/claude/`, which returns a `LaunchSpec` for the existing `Sandbox` port, parses `--output-format stream-json` output, and records the AR42 spike (outcome mapping, resume, output format) in its code and tests. Fix the `story` prompt's first-build result mapping to match, and add a contract suite run against a stub CLI.

## Boundaries & Constraints

**Always:**
- Port `Agent`: `launchSpec(unit, settings, resultPath)`, `parseUsage(output)`, `effortValues(model)`, plus `startCheck(settings, versionOutput)` and `verifyModel(usage, settings)`. Every function returns `Result` and never throws.
- `unit` is `{kind: "session", prompt}` or `{kind: "resume", session}`; `settings` is `{model?, effort?}`; defaults `claude-opus-5-5` and `high`.
- argv: `claude -p --model <m> --effort <e> --permission-mode auto --output-format stream-json --verbose --settings <json>` (resume adds `--resume <session>`). The prompt goes on stdin, never argv (brownfield: `pkill -f` matches argv). Settings JSON turns attribution off (`includeCoAuthoredBy: false`, `attribution: {commit: "", pr: ""}`) and claude's own sandbox off (`sandbox.enabled: false`).
- `vendor: "claude"`, `vendorHomeEnv: "CLAUDE_CONFIG_DIR"`, credential `{file: "oauth-token", env: "CLAUDE_CODE_OAUTH_TOKEN"}`, `apiHosts: ["api.anthropic.com"]`. The sandbox supplies `XARABOT_RESULT` (= the profile's result path) and runs in the clone.
- `effortValues`: all five efforts for `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-haiku-5-5`; `low|medium|high|max` for `claude-opus-4-6`, `claude-sonnet-4-6`; `[]` otherwise. `startCheck` and `launchSpec` refuse an effort outside it (unknown model included), naming model and effort.
- `startCheck` parses `claude --version` output (`2.1.309 (Claude Code)`) and refuses below `2.1.304` or when unparseable.
- `parseUsage` reads stream-json lines, skipping non-JSON lines: session id and model from the `system`/`init` line (session id also from `result`); tokens from the `result` line's `usage`; cost `total_cost_usd` labelled `estimate: true` (OAuth subscription); `isError` from `result.is_error`; usage limit from a `rate_limit_event` with `rate_limit_info.status` `rejected` (`resetsAt` epoch s → ms) or from limit text ("hit your … limit", "usage limit reached") with `resetAt: null` unless a `|<epoch>` suffix gives it. Missing parts are `null`.
- `verifyModel` fails (`model-mismatch`) when the reported model is null or differs from the configured one (default applied).
- `src/sandbox/tools.ts` gains `agentVersion(launching, command)`, which runs `<command> --version` through the existing probe and returns its output or `refused`.

**Never:** No `Bun.spawn`, `Bun.$` or `child_process` under `src/adapters/agent/`. No GitHub host or token anywhere in a spec. No lane loop, resume orchestration or session kill timing (Story 1.16/1.18); the adapter only builds the resume spec. No `codex` or `pi` adapter. Never read the operator's `~/.claude`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Defaults | `{}` settings, session unit | argv with `claude-opus-5-5`, `high`, stdin = prompt | none |
| Resume | `{kind:"resume", session:<uuid>}` | argv has `--resume <uuid>`; stdin asks only for the result and names the result path | non-UUID session → `invalid-input` |
| Bad effort | `claude-opus-4-6` + `xhigh`; unknown model | — | `refused` naming model and effort |
| Old CLI | `2.1.303 (Claude Code)`, `garbage` | — | `refused` |
| Usage limit | `rate_limit_event` rejected, `resetsAt` 1761234567 | `usageLimit.resetAt` 1761234567000 | none |
| Limit text only | result "You've hit your session limit · resets 11:50pm" | `usageLimit` with `resetAt: null`, text kept | none |
| Model mismatch | configured `claude-opus-5-5`, init reports `claude-sonnet-5-5` or none | — | `model-mismatch` |

</intent-contract>

## Code Map

- `src/ports/sandbox.ts` -- `LaunchSpec`, `LaunchCredential`, `Vendor`, `refused`; the adapter's output type. The sandbox sets `XARABOT_RESULT`, cwd = clone, stdin from `spec.stdin`.
- `src/sandbox/macos.ts` -- `createMacSandbox().run`: consumes the spec; used by the live smoke test.
- `src/sandbox/tools.ts:71` -- private `probe(argv, launching)` and `which`; reuse for `agentVersion`.
- `src/sandbox/vendor-home.ts` -- credential at `<config>/xarabot/vendors/claude/oauth-token`, mode 600, trimmed into the env var.
- `src/core/schemas/host.ts` -- `Effort` enum and `Lane` (`model?`, `effort`).
- `src/core/prompt/template.ts:96` -- `result_build` mapping: drop the `no-op` row, add the `ready-for-dev` row.
- `src/core/network/hosts.ts` -- `isGitHubHost` for the contract's host check.
- `test/contracts/run-contract.ts` -- `runContract`; `test/support/live.ts`, `test/support/sandbox.ts` -- `liveSandboxTest`.
- `test/support/boundaries.ts` -- the agent spawn ban; `test/boundaries.test.ts` runs it over `src/`.
- `test/adapters/agent/claude/fixtures/spike-not-logged-in.jsonl` -- real `claude` 2.1.309 stream-json output from the spike (init, assistant, result lines; not logged in, so `is_error: true`, empty `modelUsage`); use it as a parse fixture.
- `bootstrap/loop/run.sh:28,37,60` -- read-only evidence: settings JSON, `oauth-token` file, limit text.

## Tasks & Acceptance

**Execution:**
- `src/ports/agent.ts` -- `AgentUnit`, `AgentSettings`, `AgentUsage`, `AgentErrorKind`, `Agent` type.
- `src/adapters/agent/claude/claude-agent.ts` -- constants (default model/effort, min version, credential, hosts, settings JSON), `BUILD_AUTO_OUTCOMES` spike record, `createClaudeAgent()`.
- `src/sandbox/tools.ts` -- `agentVersion`.
- `src/core/prompt/template.ts` -- first-build mapping per AR42.
- `test/adapters/agent/claude/claude-agent.test.ts` -- matrix rows, argv/settings shape, effort table, parse cases (real spike output fixture), mapping recorded.
- `test/contracts/agent.contract.ts`, `test/contracts/agent.contract.test.ts`, `test/contracts/fixtures/stub-claude.ts` -- contract suite run through a stub CLI that mimics the sandbox env, writes a result and prints stream-json; plus a `liveSandboxTest` smoke test that needs the credential file.
- `test/core/prompt/build-prompt.test.ts` -- the first-build result step states each `BUILD_AUTO_OUTCOMES` row and offers no `no-op`.
- `test/sandbox/tools.test.ts` -- `agentVersion` against a stub script.
- `docs/maintainer/vendor-credentials.md` -- the `claude` credential file name and form, for Story 1.20's runbook.

**Acceptance Criteria:**
- Given the stub CLI, when the `Agent` contract suite runs, then the adapter passes: the session sees the credential, `CLAUDE_CONFIG_DIR`, `XARABOT_RESULT` and the prompt on stdin, and `parseUsage` returns the stub's session id, model and tokens.
- Given no credential file or no `XARABOT_LIVE=1`, when the suite runs, then the live smoke test reports skipped.
- Given `src/adapters/agent/`, when the boundary test runs, then it finds no spawn.

## Spec Change Log

## Review Triage Log

## Design Notes

AR42 spike (claude 2.1.309, recorded in the adapter): `bmad-build-auto` halts only `done`, `blocked` or `ready-for-dev` (after planning) and never yields `no-op`; so `done`→`done`, `blocked`→`blocked` with the kind table, `ready-for-dev` or any other halt→`blocked`/`other`. Resume is `claude -p --resume <session_id>` with the same flags. `--output-format json` gives only the final result; `stream-json` (needs `--verbose`) adds the `init` line (session id, model) and `rate_limit_event` (reset time), so it is chosen. The spike's init/result lines are the parse fixture.

The epics' `{"attribution": false}` is an example form (the spine says "for example"); the adapter uses the form the bootstrap loop runs with in this CLI version, which turns both commit and PR attribution off.

## Verification

**Commands:**
- `bun test` -- expected: exit 0
- `bun --bun oxlint` -- expected: exit 0
- `bun --bun tsc` -- expected: exit 0

## Auto Run Result

Status: blocked
Blocking condition: escalation — the real `claude` 2.1.309 cannot start inside the Xarabot sandbox. It opens `/tmp/claude-<uid>` (`EPERM: operation not permitted, open '/tmp/claude-502'`, exit 1) before any work, and only moves that folder when `CLAUDE_CODE_TMPDIR` is in its process environment. AD-17's environment allowlist does not pass that variable, and `LaunchSpec` has no field the adapter could set it with. Putting it in the `--settings` `env` object was tried and fails the same way, because settings are applied too late. A throwaway wrapper that set `CLAUDE_CODE_TMPDIR` to a mode-700 folder inside the session temp folder ran a live session end to end: the token from the environment, the proxy to `api.anthropic.com`, stream-json output and the result file. The Maintainer has to choose one of these:
1. The sandbox sets `CLAUDE_CODE_TMPDIR` (inside the temp folder) for `claude` sessions. This extends AD-17's allowlist.
2. `LaunchSpec` gets a field for vendor-specific variables, which the sandbox validates and sets. This changes the `Sandbox` port and AD-17.

**Done so far (review pending):**
- `src/ports/agent.ts`: the `Agent` port.
- `src/adapters/agent/claude/claude-agent.ts`:
  - `launchSpec`, `parseUsage`, `effortValues`, `startCheck` and `verifyModel`;
  - the AR42 spike record `BUILD_AUTO_OUTCOMES`.
- `src/sandbox/tools.ts`: `agentVersion`.
- `src/core/prompt/template.ts`: the first-build mapping now has `ready-for-dev` mapped to `blocked`/`other`, and no `no-op`.
- Tests:
  - the adapter tests;
  - the `Agent` contract suite against a stub CLI, run in both a stand-in sandbox and the real macOS sandbox;
  - the prompt mapping test;
  - the `agentVersion` tests.
- `docs/maintainer/vendor-credentials.md`: the credential is `$XDG_CONFIG_HOME/xarabot/vendors/claude/oauth-token`, mode 600, holding the token from `claude setup-token`.

**Verification:**
- `bun test`: 1823 pass, 61 skip, 0 fail.
- `bun --bun oxlint` and `bun --bun tsc` exit 0.
- With `XARABOT_LIVE=1` and the credential present, the live smoke test fails on the EPERM above.

**Not done:** the step-04 review pass has not run. Run it once the Maintainer's decision is in.
