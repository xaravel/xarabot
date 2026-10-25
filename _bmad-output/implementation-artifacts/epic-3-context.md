# Epic 3 Context: Every diff is reviewed before it merges, by another vendor where allowed

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

`codex` and `pi` lanes run beside `claude` with the same `agent`, `model` and `effort` settings, and the runner reviews every diff before it merges, bound to the reviewed SHA. The reviewer is a model from another vendor when the repo's policy allows one. Otherwise it is a separate same-vendor session, so a user with a single LLM subscription can still merge. The adapters come first, so the cross-vendor path can be proven once the reviewer choice lands; allowing `codex` in this repo's policy turns it on. Once this Epic merges, the Maintainer lifts the every-path approval rule and the 1-builder limit, with Story 3.6's live proof as the evidence.

## Stories

- Story 3.1: The `codex` adapter
- Story 3.2: The `pi` adapter
- Story 3.3: Session vendors and the reviewer choice
- Story 3.4: Review sessions
- Story 3.5: The review gate and loopbacks
- Story 3.6: Cross-vendor verification

## Requirements & Constraints

- **One lane shape for every adapter:** `agent` (`claude` | `codex` | `pi`), `model` and `effort` (`low` … `max`). An unset `effort` is `high`. `codex` defaults to `gpt-6.1-sol`. A `pi` lane with no `model` refuses to start. An effort the adapter does not offer for that model stops the lane at start; it is never dropped or rounded.
- **Launch lines:** `codex exec -m <model> --json -c model_reasoning_effort=<effort>`, with skills exposed through `.agents/skills`. `pi -p --mode json --model <provider/id> --thinking <effort>`. Each CLI's own sandbox and attribution are off inside Xarabot's sandbox.
- **Minimum CLI versions** (a floor, not a pin): codex-cli 0.163.0, pi 1.3.0. An older CLI refuses to start.
- **Credentials:** one mode-600 file per vendor under `$XDG_CONFIG_HOME/xarabot/vendors/<vendor>/` (fallback `~/.config`): codex's auth file or API key, or the OpenRouter key for pi. The lane process seeds a fresh per-lane vendor home (`CODEX_HOME`, pi's agent directory) before every session, builder or reviewer. A missing or unreadable credential for the lane's agent or its reviewer stops the lane at start.
- **Network:** a session reaches only its vendor's API hosts (OpenAI or OpenRouter), the Python package hosts and repo-added hosts. A GitHub host is never allowed.
- **Spikes first:** 3.1 and 3.2 each start by establishing with the real CLI whether it gives `bmad-build-auto` the subagents it needs, how its outcomes map onto the `build` result (a `ready-for-dev` halt; it never yields `no-op`) and how a session is resumed. 3.2 also confirms pi's agent-directory override and how its sandbox and attribution are turned off. If the CLI can't do what is required, the Story stops and raises it to the Maintainer instead of working around it.
- **Usage parsing:** `parseUsage` returns tokens, cost, the reported model and a usage-limit hit with its reset time. A reported model that differs from config fails the attempt.
- **Tests:** each adapter passes the `Agent` contract suite, the sandbox refusal suite and the write-check case table. Live cases need `XARABOT_LIVE=1` and otherwise report skipped, never passed. Inside a sandboxed session (`XARABOT_SANDBOXED=1`), nested sandbox cases are skipped and the Maintainer runs them on the host. Core logic uses case tables with no mocks; the forge parts run against the fake forge.
- **Limits stay in force until this Epic merges:** `XARABOT_MAX_BUILDERS=1`, and every path needs the Maintainer's approval (except `reconcile` PRs). Agents never touch GitHub.

## Technical Decisions

- **Vendor is the model's, never the adapter's:** `claude` is Anthropic and `codex` is OpenAI. A `pi` session's vendor is the one in its `<provider>/<id>` model; through OpenRouter, it is the underlying model's vendor. Every session that changes the diff (build, loopback, CI fix, conflict resolution) adds its vendor to the record's `builder_providers[]`.
- **Reviewer choice (pure):** the first allowed adapter of (`claude`, `codex`) whose vendor is not in `builder_providers[]`, marked cross-vendor. When the policy allows no such adapter, a same-vendor reviewer is used: the first allowed of (`claude`, `codex`), else `pi` on the builder's model. `pi` is never a cross-vendor reviewer in 0.x. A unit never parks for lack of a reviewer. A lane refuses to start if its reviewer adapter isn't allowed.
- **Review session:** a fresh checkout of `head_sha` made from `runner.git`, never the builder's clone. Agent config paths are restored from `main`, hooks are off, the vendor home is freshly seeded, and the session is launched only through `src/sandbox/`. The prompt comes from the package review template and has no selection, CI, merge or status instruction. The session writes a `review` result (`reviewed_sha`, `verdict`, `findings[]` with `severity` and a separate `blocking` flag).
- **Runner-owned facts:** the runner records `reviewed_sha` itself and ignores any SHA the agent reports. It posts the review through `Forge.postReview` as a comment review with no approval, naming the SHA, cross- or same-vendor, and the findings. No blocking findings sets `passed_sha`; blocking findings never do, so a lane that takes over picks up the loopback, not the enqueue.
- **Merge gate:** enqueue only if the head equals `passed_sha`, or the head's tree equals the merge of `passed_sha` with the head's `main` parent, recomputed by the enqueuing lane in `runner.git`. The same gate applies to coordinator PRs, except `reconcile` PRs. Before any session launch or enqueue, re-check the adapter and reviewer allowances from freshly fetched `main`.
- **Loopbacks and caps:** blocking findings are prefetched into the temp folder, a loopback session runs at `head_sha`, and the review runs again. Any later agent change re-runs the review. A review-driven fix counts as `loopbacks`; CI fixes and conflict resolutions count as `ci_fixes`, never as loopbacks. At `loopbacks` ≥ 2 the unit parks blocked (`review-cap`, inbox owner set), whatever the verdict; past the `ci_fixes` cap it parks blocked with `ci-fix-cap`. Counters live in the ledger record, so a takeover never resets them.
- **Spawning:** only `src/sandbox/` spawns agent or reviewer processes; `Bun.spawn` is banned under `src/adapters/agent/`.

## Cross-Story Dependencies

- 3.1 and 3.2 depend on Story 2.6a's shared session runner and can run in either order. 3.3 needs both. Then the chain is strictly serial: 3.3 → 3.4 → 3.5 → 3.6.
- 3.6 records its live command and expected results in `docs/maintainer/self-host.md`, together with the nested sandbox cases from 3.1 and 3.2. The Maintainer runs them on the host, outside the sandbox and with every vendor's credential, before Epic 3's retro. It also lists the switch: drop the every-path rule, allow the adapters unattended, raise `XARABOT_MAX_BUILDERS`, then run the 24-hour acceptance check.
- Open lane-routed Epic 2 retro items touch the same code: moving the model check behind the agent port, consolidating the coordinator steps into the shared session module, and keeping approvals through runner failures. Check `retro-gates.yaml` for their status and globs.
- Merged code takes effect only after the Maintainer advances `runner_version`.
