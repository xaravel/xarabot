# Epic 3 Context: Every diff is reviewed before it merges, by another vendor where allowed
<!-- source: sha256:beb83a48483fcccfbac87d47aff919b628332e72f13d1c64c9710398813c2069 -->

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

`codex` lanes run beside `claude` with the same `agent`, `model` and `effort` settings, and the runner has every diff reviewed before it merges, bound to the reviewed SHA. The reviewer is a model from another vendor when the repo's policy allows one; otherwise it is a separate same-vendor session, so a user with a single LLM subscription can still merge. The `pi` adapter is deferred to v1, because stock pi gives `bmad-build-auto` no subagents, so in 0.x a lane or reviewer set to `pi` refuses clearly. The adapters come first so the cross-vendor path can be proven once the reviewer choice lands; allowing `codex` in this repo's policy turns it on. Once this Epic merges, the Maintainer lifts the every-path approval rule and the 1-builder limit, with Story 3.6's live proof as the evidence.

## Stories

- Story 3.1: The `codex` adapter
- Story 3.2: The `pi` adapter, deferred to v1
- Story 3.3: Session vendors and the reviewer choice
- Story 3.4: Review sessions
- Story 3.5: The review gate and loopbacks
- Story 3.6: Cross-vendor verification

## Requirements & Constraints

- **One lane shape for every adapter:** `agent` (`claude` | `codex`), `model` and `effort` (`low` … `max`). An unset `effort` is `high`; `codex` defaults to `gpt-6.1-sol`. An effort the model does not offer stops the lane at start; codex's `ultra`, `none` and `minimal` are not on Xarabot's scale.
- **`pi` in 0.x:** `pi` still parses as an adapter name, so a policy listing it is valid, but `agent: pi`, or a policy whose only reviewer would be `pi`, refuses at install or lane start, naming the deferral, and counts as a failed start. No code path launches a `pi` session.
- **codex sessions:** launched with its own approvals and sandbox off inside Xarabot's sandbox, a closed stdin (codex reads a piped stdin into the prompt), `CODEX_HOME` set to the lane's vendor home, a CA bundle through `SSL_CERT_FILE` (the sandbox denies the keychain service on purpose) and skills exposed through `.agents/skills`. A codex-cli older than 0.163.0 refuses to start. codex ignores its attribution setting, so the sanitizer strips its forced co-author trailer and "Generated with Codex" line before any forge text.
- **Credentials:** one mode-600 file per vendor under `$XDG_CONFIG_HOME/xarabot/vendors/<vendor>/` (fallback `~/.config`). The lane process seeds a fresh per-lane vendor home before every session, builder or reviewer. A missing or unreadable credential for the lane's agent or its reviewer stops the lane at start. A session rewriting its credential is journaled, never copied back.
- **Network:** a codex session reaches only OpenAI's login and API hosts, the Python package hosts and repo-added hosts. A host found missing in a live run is raised to the Maintainer, never added silently. A GitHub host is never allowed.
- **Usage:** tokens, the reported model and usage-limit resets come from codex's JSON output and its session file, read before the vendor home is re-seeded; the reset time comes from the structured field, never the message text. Cost is an estimate from tokens. A reported model that differs from config fails the attempt.
- **Tests:** adapters pass the `Agent` contract suite, the sandbox refusal suite and the write-check case table. Live cases need `XARABOT_LIVE=1` and otherwise report skipped, never passed. Inside a sandboxed session (`XARABOT_SANDBOXED=1`), nested sandbox cases are skipped and the Maintainer runs them on the host. Core logic uses case tables; forge parts run against the fake forge.
- **Limits stay in force until this Epic merges:** one builder, and every path needs the Maintainer's approval (except `reconcile` PRs). Agents never touch GitHub.

## Technical Decisions

- **Vendor is the model's, never the adapter's:** `claude` is Anthropic, `codex` is OpenAI. Every session that changes the diff (build, loopback, CI fix, conflict resolution) adds its vendor to the record's `builder_providers[]`. Older records hold the adapter names; map them on read (`claude` → Anthropic, `codex` → OpenAI) before the reviewer choice, and never rewrite stored records.
- **Reviewer choice (pure):** the first allowed adapter of (`claude`, `codex`) whose vendor is not in `builder_providers[]`, marked cross-vendor. If none is allowed, a same-vendor reviewer: the first allowed of (`claude`, `codex`). With neither allowed there is no reviewer and the lane refuses to start, so a unit never parks for lack of one. `lane run` composes every allowed reviewer agent and hands them to the review step, so cross-vendor review works.
- **Review session:** a fresh checkout of `head_sha` from `runner.git`, never the builder's clone. Agent config paths are restored from `main`, hooks are off, the vendor home is freshly seeded, and only `src/sandbox/` launches it. The prompt comes from the package review template, names the unit and the Story spec, has no selection, CI, merge or status instruction, and ends by writing a `review` result.
- **Follow-up pass:** when the Story's spec at `head_sha` has `followup_review_recommended: true`, each review round also runs a second session on the same checkout, prompted with the spec's named unverified risks. `passed_sha` is set only when neither pass has blocking findings. A unit with no spec (retro item, coordinator PR) or the flag `false` gets the normal review only.
- **Runner-owned facts:** the runner records `reviewed_sha` itself, ignoring any SHA the agent reports, and posts the review through `Forge.postReview` as a comment review with no approval, naming the SHA, cross- or same-vendor, and the findings. Blocking findings never set `passed_sha`, so a lane that takes over picks up the loopback, not the enqueue.
- **Merge gate:** enqueue only if the head equals `passed_sha`, or the head's tree equals the merge of `passed_sha` with the head's `main` parent, recomputed by the enqueuing lane in `runner.git`. Coordinator PRs get the same gate, except `reconcile` PRs. Before any session launch or enqueue, re-check the adapter and reviewer allowances from freshly fetched `main`.
- **Enqueue is its own ledger field:** `passed_sha` keeps only its review meaning; a separate field records that the runner enqueued the PR, and the coordinator and `reconcile` read it to tell an enqueue or a re-park. The ledger `schema_version` goes up by one (sharing the graph-approval retro item's bump if that has not shipped), with every lane's runner pin advancing together.
- **Loopbacks and caps:** blocking findings are prefetched into the temp folder, a loopback runs at `head_sha`, and the review runs again; any later agent change re-runs it. Review-driven fixes count as `loopbacks`; CI fixes and conflict resolutions count as `ci_fixes`, never loopbacks. At `loopbacks` ≥ 2 the unit parks blocked (`review-cap`, inbox owner set), whatever the verdict; past the `ci_fixes` cap it parks with `ci-fix-cap`.
- **Coordinator PRs under review:** a retro-item PR with blocking findings gets a loopback like a Story's, through a `retro-item` loopback prompt mode, counted in `loopbacks` under the same cap. A planning or retro PR with blocking findings gets no loopback; it parks blocked with a named park reason, for the Maintainer.
- **A missing result** gets one resume (`codex exec resume <thread_id>`) asking only for the result.

## Cross-Story Dependencies

- 3.1 and 3.2 depend on the shared session runner (Story 2.6a). Then the chain is serial: 3.1 → 3.3 → 3.4 → 3.5 → 3.6.
- 3.6 records its live command and expected results in `docs/maintainer/self-host.md`, with 3.1's nested sandbox cases and the host `bun test test/sandbox/` row. The Maintainer runs them on the host with every vendor's credential before Epic 3's retro. It also lists the switch: drop the every-path rule, allow the adapters unattended, confirm the lane-lock hardening retro item is done, raise `XARABOT_MAX_BUILDERS`, then run the 24-hour acceptance check.
- Open Epic 2 retro items touch nearby code: write-check content rules, `reconcile` PR hygiene, coordinator claim fencing, lane-lock hardening, graph-approval binding (its ledger bump), the planning attempts cap, the idle waits and the legacy `builder_providers` names. Check `retro-gates.yaml` for their status and globs.
- Merged code takes effect only after the Maintainer advances `runner_version`.
