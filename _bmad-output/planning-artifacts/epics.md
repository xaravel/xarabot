---
status: final
stepsCompleted: [1, 2, 3, 4]
inputDocuments:
  - _bmad-output/specs/spec-xarabot/SPEC.md
  - _bmad-output/specs/spec-xarabot/glossary.md
  - _bmad-output/specs/spec-xarabot/releases.md
  - _bmad-output/specs/spec-xarabot/baseline-metrics.md
  - _bmad-output/specs/spec-xarabot/agent-adapters.md
  - _bmad-output/specs/spec-xarabot/brownfield-xaravel.md
  - _bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md
---

# xarabot - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for xarabot, decomposing the requirements from the spec (`SPEC.md` and its companions, which stand in for the PRD) and the architecture spine into implementable stories. There is no UX design contract.

FR*n* is SPEC CAP-*n*. Each FR carries its release from `releases.md`: **[0.x]**, **[v1]** or **[after v1]**. Terms are as defined in `glossary.md`.

## Requirements Inventory

### Functional Requirements

FR1 [0.x] (CAP-1, Packaged and pinned): Xarabot ships as the npm package `@xaravel/xarabot` and contains the runner (lanes, scheduled jobs, STOP marker, history), unit selection, claims, CI and merge plumbing, agent adapters, status reporting and prompt templates. A consuming repo adds it as an exactly pinned dependency and supplies only its config, project-specific prompt sections, verification commands, policy files (Standing Authority, Actor registry, Human Live Steps) and Story manifests. Success: Xaravel runs every lane from a pinned Xarabot version; its tree holds no orchestration code beyond those supplied files; a Xarabot upgrade reaches it as a PR; each Xarabot release has a changelog entry.

FR2 [0.x] (CAP-2, Deterministic `next`): A `next` command chooses, in code, the one unit a lane builds, from Story manifests, sprint status, the dependency graph, open claims and the retro and checkpoint gates. The graph comes from `.xarabot/epics.yaml`: an Epic the file does not list depends on the next lower Epic number in `epics.md`, and a checkpoint is never inferred. Where the repo turns them on with an Epic-to-package map, `package.json` workspace dependencies add edges. The graph never comes from `epics.md` prose or a BMAD override. Success: unit tests cover each input and each gate; a repo with no graph file and no `package.json` runs its Epics serially in number order; a listed Epic runs in parallel exactly as its entry allows; the agent's prompt names the unit ("Build Story X") and contains no selection rules.

FR3 [0.x] (CAP-3, Claims): A lane's runner, never its coding agent, claims a unit, its bot identity and its manifest globs by compare-and-swap on one claims ref. A unit whose globs overlap an open claim is refused; a Story without globs is never claimed. A claim lives by heartbeat, is released on merge or block, and expires 30 minutes after its last heartbeat. Success: when two lanes race for one unit, or for two units with overlapping globs, exactly one wins; a killed lane's unit becomes claimable 30 minutes after its last heartbeat; both hold across machines.

FR4 [0.x] (CAP-4, Parallel lanes): One Xarabot host, a macOS or Linux computer set in config (`XARABOT_HOST`), runs a coordinator lane (retros, retro action items, planning) and N builder lanes (Stories only). Each builder has its own full clone (never a linked worktree), state folder and scheduled job (launchd or systemd). The host's builder limit is config (`XARABOT_MAX_BUILDERS`). Success: on Xaravel's Xarabot host, the coordinator and 2 builder lanes run for 24 hours with no unit built twice and no write to `sprint-status.yaml` or `retro-gates.yaml` from a builder.

FR5 [0.x] (CAP-5, Parallel Epics): Epics run at the same time, ordered by the dependency graph instead of strictly in sequence. An Epic starts once every Epic it depends on has all its Stories `done` and its retro done. A checkpoint Epic holds only the Epics that depend on it, directly or through others, until the Maintainer's go. Success: in Xaravel Phase 1, after `runtime` and then `contracts`, Stories from the `macroable`, `conditionable` and `json-schema` Epics are in flight at once; while a checkpoint go is pending, Epics depending on the checkpoint Epic take no new Stories, and Epics not depending on it keep running.

FR6 [0.x] (CAP-6, Plumbing in code): CI polling, the merge queue, mergeability checks, conflict resolution in the status YAML files, status comments, the progress line and sleeping through usage limits run in Xarabot code. The agent session only does the unit's work and returns a JSON result. The lessons in `brownfield-xaravel.md` § Lessons (CI polling, Conflicts, Merges) bind this code. Success: the agent prompt carries no CI, merge or status instructions; every session's output validates against the result schema; a usage-limit hit makes the lane sleep until the reset instead of failing.

FR7 [0.x] (CAP-7, Agent adapters): Each lane runs its coding agent through an adapter: `claude` or `codex` (0.x); `pi` follows in v1. Every adapter takes the same three lane settings: `agent`, `model` and `effort`. `effort` is one scale for all adapters (`low`, `medium`, `high`, `xhigh`, `max`), and each adapter maps it onto its CLI's own setting. `claude` and `codex` default to a top model (`claude-opus-5-5`, `gpt-6.1-sol`); `pi` moves to v1. Lane config can change model and effort. The consuming repo's policy says which adapters may run unattended. Success: the same unit runs to a valid JSON result through each adapter; a `claude` or `codex` lane with no `model` runs its adapter's default top model; a lane with `agent: pi` refuses to start in 0.x, naming the deferral; switching agent, model or effort is a config change only; each adapter maps `effort` per `agent-adapters.md` § Model and effort, and a value an adapter cannot honor stops the lane at start instead of being dropped silently; a lane whose adapter the repo's policy does not allow unattended refuses to start unattended.

FR8 [0.x] (CAP-8, Cross-vendor review): Before a diff merges, the runner has it reviewed by an agent whose model comes from a vendor other than every model that built it, whenever the repo's policy allows an adapter from such a vendor. Vendor means the model's vendor, never the adapter's: Codex reviews Anthropic-built diffs, and Claude reviews the rest. When the policy allows no adapter from another vendor, as for a user with only a Claude or only a Codex subscription, a separate same-vendor review session reviews the diff instead, under the same rules. The review binds to the commit it reviewed; any later agent change, such as a CI fix or a conflict resolution, re-runs it. Its blocking findings loop back to the builder; on a planning or retro PR, they park it for the Maintainer instead. BMAD's own review hook may run for earlier feedback but never counts as this review. Success: every builder PR carries a review naming the commit it reviewed, from a model vendor outside its builders' when the repo allows one, otherwise from a separate same-vendor session; no PR merges with blocking findings unresolved or with a diff other than the reviewed one; a repo that allows a single vendor merges its PRs on their required checks after the same-vendor review; a blocking review after 2 loopbacks stops the unit: it does not merge and is listed in its owner's inbox, and a passing review after 2 loopbacks proceeds.

FR9 [0.x] (CAP-9, Inboxes): Each owner sees everything waiting on them in one inbox and rules on it in one sitting a day: their bot's PRs awaiting approval and their blocked units. The Maintainer's inbox also holds rulings, Escalations, waiting retro items and Human Live Steps. On a solo repo the two are one list. Success: one daily digest per inbox lists every waiting item with its link and age; an item that newly stops all lanes notifies at once; no other per-item waiting notices are sent.

FR10 [0.x] (CAP-10, Retro gating): A retro action item from Epic E holds back the Epics that depend directly on E only when the retro tags it `blocking`; other items are worked alongside later Stories. The retro's tag stands unless the Maintainer changes it with a ruling. Success: `next` tests on the dependency graph show that an untagged open item does not gate an Epic one step from E but does gate one two or more steps away, and that a `blocking` item gates every Epic depending on E.

FR11 [0.x] (CAP-11, Telemetry): Each lane records per unit: agent, model, effort, unit, start, end, outcome, review loopbacks, CI fixes, and tokens and wall-clock cost (labeled an estimate for subscription runs), so agents and lanes can be compared. Success: a report over a chosen period shows, per agent and model, units done, median unit time, first-pass review rate, CI-fix count and cost, and feeds the consuming repo's dashboard.

FR12 [0.x] (CAP-12, TUI): An operator sees every lane at once in a read-only terminal UI: its unit, claim, CI and merge state, and the inbox, on the host itself or from another machine over ssh. Success: one command on a laptop shows the live state of every lane on the Xarabot host named by `XARABOT_HOST`, over ssh, and refreshes on its own; the same command works locally on the host.

FR13 [0.x] (CAP-13, Bot identity): Each human owns one bot: a GitHub App owned by their own account, `<login>-xarabot`, acting as `<login>-xarabot[bot]`. `xarabot join` creates it from a manifest and installs it once per consuming org with that org owner's approval, on all repositories by default or on selected repositories where the org prefers. Every commit, push and PR their lanes make is made as that bot, never as the human; the owning human is responsible for the bot's work. The bot has no admin, bypass or approve rights; the runner mints short-lived installation tokens from the App's private key, and no long-lived token is stored. A PR touching no Protected Path merges on its required checks and the FR8 review; a PR touching a Protected Path needs its owner's approving review; a repo's policy can require more. Success: `xarabot join` creates the owner's App with one confirm click and installs it with one more, or with an install request an org owner approves; with a selected-repositories installation, adopting a repo the installation does not cover stops with the repo to add; every lane-made commit and PR is authored by the owner's bot; the owner can approve and merge their bot's PR straight away, a Protected Path PR included; the bot cannot approve any PR or merge past required checks or reviews, and Xarabot never issues an admin merge.

FR14 [v1] (CAP-14, Team onboarding): A team member joins by running `xarabot join`, which creates their `<login>-xarabot` App and installs it on the org or requests the install, and by registering it under their name with the setup docs. They then run lanes on their own machine against the same repo, with claims shared across machines. Success: a second person on a second machine follows the docs, runs `xarabot join` and starts a lane, and neither person's lanes build a unit the other holds.

FR15 [0.x] (CAP-15, Deterministic stop): An operator stops one lane or all lanes deterministically. Process control follows `brownfield-xaravel.md` § Lessons (Process control, Exit lag). Success: a STOP marker for a lane, or for the host, makes the affected lanes finish their current unit and exit, with no new claim taken.

FR16 [after v1, optional] (CAP-16, Pipelining): A lane starts its next Story while its previous PR is still in CI or the merge queue. Success: with pipelining on, a lane claims its next unit before its previous PR merges, and no unit merges out of dependency order.

FR17 [v1] (CAP-17, Actor registry): The consuming repo keeps an Actor registry: humans by GitHub login, their roles and tracks, and the `<login>-xarabot` App each one owns (its App ID). CODEOWNERS, rulesets and guard policy are generated from it. Success: registering a person and their bot and merging gives them their role's rights everywhere; a bot not registered to a human is refused; a hand edit to a generated file fails a drift check.

FR18 [sandbox and write check 0.x; diff check and CI v1] (CAP-18, Guard): One fail-closed guard, the same for every adapter.
- Sandbox (0.x): the coding agent runs with only its unit's clone writable, with no GitHub credentials and no GitHub host.
- Write check (0.x): before the squash, the runner refuses a builder diff that touches coordinator-owned files, Story manifests, `.xarabot/**`, the Standing Authority file, `.github/**`, agent config (`.agents/skills`, `.claude/skills`, `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `CLAUDE.local.md`) or Protected Paths. There are only three exceptions: an approved Infrastructure Story's Protected Paths, the unit's own BMAD Story spec file (the single file matching `story_spec_path`), and the `status:` line of its own Story file.
- Diff check (v1): extends the write check to refuse files outside the claim's globs and dependency files the repo has not allowed.
- CI (v1): CI re-checks the same rules.
- Hooks: per-agent write-time hooks, where an agent has them, give earlier feedback but are never the boundary.
- Success: each refusal case has a test for each adapter; an out-of-scope diff is never committed and is logged with its reason; from 0.x, a builder diff touching a write-check path parks its unit blocked; from 0.x, an agent session cannot push, approve or merge, because it has no token; a guard error blocks rather than allows.

FR19 [v1] (CAP-19, Gates from the base branch): Required gates (scope, Protected Paths, open escalations) are evaluated from the base branch, never from the PR's own code, with no bypass. Success: a PR that edits a gate's own code or config is still judged by `main`'s version of it.

FR20 [v1] (CAP-20, Escalations): An agent raises an escalation instead of deciding a contract question; a human decision binds to the escalation's exact text by hash, and an open escalation blocks its unit's merge. Under 0.x, Xarabot reads Xaravel's existing `tools/escalations/` through config; v1 makes the mechanism Xarabot-owned. Success: changing a decided escalation's text invalidates its decision; a unit with an open escalation cannot merge.

FR21 [v1] (CAP-21, Lessons reach every session): New Lessons and decision records reach every unit's session, whatever its adapter. Success: a Lesson merged before a unit starts appears in that unit's agent context, for each adapter.

FR22 [0.x] (CAP-22, Standing Authority): A Standing Authority file in the consuming repo grants the lanes their authority; when it is absent or invalid, every lane stops. Success: deleting the file on `main` stops every lane before its next claim.

FR23 [v1] (CAP-23, Human Live Steps): The consuming repo lists Human Live Steps; lanes never attempt them and route them to the Maintainer's inbox. Success: a unit that reaches a listed step is marked waiting, and the step appears in the inbox with no attempt logged.

FR24 [GitHub 0.x; local-only v1] (CAP-24, Forge adapters): Lanes, claims and `next` reach the forge only through a forge adapter: identity, PRs or their local equivalent, CI, merges and the claims ref. GitHub ships first. The local-only adapter runs a repo with no remote on one host: lanes merge into the local `main` after its checks, lane commits are signed with the owner's lane key, and a Protected Path change waits for a `xarabot approve` signed with the owner's own key. Success: the same unit runs end to end on GitHub and on a local-only repo with no remote; in local-only mode a Protected Path change merges only after the owner's signed approval.

### NonFunctional Requirements

NFR1 (Toolchain): Bun only: Bun 1.4.3, TypeScript 7 with `--strict`, oxlint. No Node, npm, pnpm, Jest, Vitest, ESLint or Prettier as tools.

NFR2 (Models): `claude` and `codex` default to a top model; lane config can change them; Xarabot enforces no model floor.

NFR3 (Planning shape): 0.x reads the classic BMAD shape only: `epics.md`, `sprint-status.yaml` and Story manifests, plus the Epic graph file. The spec-folder shape (`stories.yaml`) waits until a consumer uses it.

NFR4 (No BMAD overrides): Xarabot runs stock BMAD skills. Anything else it needs comes from its own prompt template, its own files or artifacts the runner reads; it never writes or requires `_bmad/custom/` in a consuming repo.

NFR5 (Interactive skills stay with the Maintainer): lanes drive only BMAD skills with a headless run (`bmad-build-auto`, `bmad-retrospective`, `bmad-sprint-planning`). `bmad-create-epics-and-stories` and `bmad-correct-course` are run by the Maintainer; when a retro or a blocked unit calls for a course correction, it goes to the Maintainer's inbox.

NFR6 (Forges): GitHub (0.x) and local-only (v1), each behind one forge interface (FR24). GitLab and other forges come later.

NFR7 (No platform assumptions): Xarabot does not assume AWS, SSO, hardware signing keys, a Claude-only sandbox, a JavaScript repo or a particular repo layout; any of those is an optional repo-supplied integration.

NFR8 (Agents never touch GitHub, from 0.x): coding agents run sandboxed with no GitHub credentials (FR18). Only the Xarabot runner holds the bot's private key, mints its tokens and talks to GitHub: claims, pushes, PRs, CI polling and merges; in local-only mode the same holds for the local `main` and the claims ref. No session gets a GitHub token or reaches a GitHub host; a session that needs GitHub data reads files the runner fetched beforehand.

NFR9 (Identity): lanes act only as their owner's bot (FR13): never a shared bot, an org-owned App, a bot user account or a human's own account.

NFR10 (No co-author markers): no `Co-Authored-By` trailers or similar non-authoritative markers. The bot account is the only marker of lane-made work. The `Co-authored-by: <login>-xarabot[bot]` trailer that GitHub's squash merge adds itself is that marker, and is allowed (Maintainer, 2026-10-25).

NFR11 (License and release): open source as `xaravel/xarabot`, MIT license, published to npm as `@xaravel/xarabot` and installed with `bun add`. Consumers pin it exactly. Releases are cut only by the Maintainer, from CI.

NFR12 (Xarabot builds itself): Xarabot has its own repo, BMAD plan, epics and changelog.

NFR13 (Bootstrap): a copy of Xaravel's `tools/orchestrator` runs against the Xarabot repo on the Xarabot host as `edanisko-xarabot` (created before bootstrap by `bootstrap/join.ts`, which `xarabot join` later absorbs), with no admin merges, and builds only the first Epic: a single `claude` lane with `next`, plumbing in code, STOP, history and the agent sandbox (FR18). The copy runs as a dedicated macOS user on the Xarabot host that holds only the bot's private key, the Claude credential and its own clone: no `gh` login, ssh key or GitHub keychain item.

NFR14 (Self-host): the moment that lane works with its sandbox, Xarabot's own runner replaces the copy, and every later Xarabot Story is built by Xarabot. No Xarabot lane runs unsandboxed. The self-host success signal: Xarabot builds the rest of its own 0.x (the `codex` adapter, the TUI, claims and parallel lanes) with its own pinned runner before Xaravel adopts it.

NFR15 (Pinned runner): the self-hosted runner runs a pinned Xarabot version (release or tag) that only the Maintainer advances, never re-execing from the branch it builds. Recovery is pinning back to the last good version.

NFR16 (Releases): a 0.x release carries only what Xaravel's adoption needs; v1 adds the rest (`releases.md`).

NFR17 (Xaravel adoption is out of scope here): adoption is planned and run in Xaravel, by a Xaravel course correction that adds an Epic before Epic 9. No Xarabot Epic performs it; Xarabot supplies what it needs (see the Additional Requirements, "Adoption inputs").

NFR18 (Consuming-repo rules bind Xarabot): lanes never push to `main`; lanes never change `AGENTS.md` unless the Maintainer asks; lanes change Protected Paths only through a Maintainer-approved Infrastructure Story, or, for the Epic graph, a planning PR the Maintainer approves; a PR that changes the effective Epic graph (the graph file, the Epic headings in `epics.md`, or a manifest's Epic) merges only with the Maintainer's approval, never just its bot owner's; Xarabot config and `.agents/skills` become Protected Paths in the consumer.

NFR19 (Set by the consuming repo, never fixed in Xarabot): merge authority beyond FR13's default and which humans may approve and merge; the lane branch namespace; which adapters may run unattended; roles, tracks, Protected Paths, the dependency-command list and Human Live Steps.

NFR20 (Write authority): the coordinator lane is the only writer of `sprint-status.yaml` and `retro-gates.yaml`. Its runner-code unit, `reconcile`, alone sets a Story's or an Epic's (`epic-<N>`) status to `done`, writes retro verdicts and items, and opens PRs that are exempt from owner approval (Standing Authority). Its sessions are held to field rules: status planning only adds missing keys; a retro only appends its Epic's `action_items` and sets its own retro key. The 0.x write check (FR18) enforces all of this, on builder and coordinator diffs. The only exceptions are the Maintainer's bootstrap writes in Xarabot's own repo, each in a Maintainer PR: at the self-host switch, a `bmad-sprint-planning` run that creates or updates `sprint-status.yaml` so Epic 1's Stories are `done`, plus Epic 2's Story manifests and Epic 2's context file; and, until the rulings Story (4.6) merges, a rejected retro's go in `retro-gates.yaml`.

NFR21 (Capacity): a host runs at most `XARABOT_MAX_BUILDERS` builder lanes (Xaravel's host: 2).

NFR22 (Throughput target, 0.x success signal): in Xaravel's adoption Epic, a coordinator and 2 builder lanes on Xaravel's Xarabot host build Phase 1 Epics in parallel as `edanisko-xarabot`, choosing units with `next`, with no unit built twice and no admin merge; edanisko approves the bot's Protected Path PRs directly; Xarabot telemetry shows at least 1.4 Stories per hour (twice the baseline's 51 in 73 hours, `baseline-metrics.md`), computed as merged Stories divided by wall-clock hours over one stated 7-day window of Xaravel work, excluding hours when every lane waits on the Maintainer (a checkpoint go included). All lanes and adapters count; Story size is not normalized.

NFR23 (v1 success signal): a new project runs `bun add` for Xarabot plus the join command, and its team builds in BMAD with lanes: a second person creates their bot, joins on their own machine and starts a `codex` or `pi` lane; the guard enforces paths and commands for that lane; claims keep both people's lanes off each other's units; a project with no remote runs the same lanes in local-only mode.

### Additional Requirements

**Starter template: none.** The spine names no starter or scaffold. Xarabot is greenfield apart from `bootstrap/join.ts`. The package layout comes from the spine's Structural Seed, and the first Story must set up the Bun package, TypeScript 7, oxlint and the layer directories.

Requirements from the architecture spine (AR*n* cites the spine's AD):

- AR1 (Paradigm, layers): functional core, imperative shell, ports and adapters. Layers and allowed imports: `src/core/` (core only); `src/ports/` (core); `src/adapters/forge/*` and `src/adapters/agent/*` (ports, core); `src/sandbox/` (ports, core); `src/lane/` (everything above); `src/cli/` (lane and everything it may import). Ports: `Forge` (`snapshot()` with ledger tip, `main` SHA, PR states and server `now`, reading the contents of only the `main` paths its `read` filter passes and returning their `blob_shas`; `ledgerSwap(oldSha, edit)` returning `ok` or `conflict`; `pushBranch(lease)`; PR open/update/close; `listPrsByBranch(branch)`; `branchHead(branch)` (Story 2.6b); `reviews(pr)` (Story 2.6); `comment(pr, body)` for 🤖 status comments; `postReview`; `checks`; `enqueue(pr, expectedHead)`; `dequeue`; `queueState(pr)`; inbox `renderDigest`, `alert`, `readRulings(cursor)`; `prefetch(kind)`; no approve operation), `Agent` (`launchSpec`, `parseUsage`, `effortValues`), `Sandbox` (`run(LaunchSpec, profile)`, the only agent spawner), `LaneStore` (PIDs, journal, outcome, STOP). The compare-and-swap retry loop lives in `src/lane/`; adapters do one attempt per call.
- AR2 (AD-1): `src/core/` never calls `fetch`, `Bun.spawn`, the filesystem, `Date.now()` or `process.env`; only adapters and `src/sandbox/` touch the forge, agents, the OS or the clock, and `src/lane/` (the imperative shell) may also read the clock and the filesystem; adapters never import each other.
- AR3 (AD-2): one process per unit, started by the lane's launchd or systemd job, which runs at most one unit, waits, then exits. PID in `lane.pid`; the process holds the lane's exclusive lock (`lane.lock`), and a second process of the same lane exits without claiming; heartbeats continue through the trailing wait; every wait is a child `sleep` with its PID in `wait.pid` (1 min after progress, 1 after idle for builders and the coordinator (Epic 2 retro item 26), 15 after a failure, and usage-limit sleeps); `xarabot wake <lane>` kills exactly that PID after checking it. Every forge, git or HTTP call has an `AbortSignal` deadline; git runs with `GIT_TERMINAL_PROMPT=0`. Unit wall-clock budget is config (default 6 h); overrun stops heartbeating and releases as a failed attempt. Code never calls `pkill` or a `timeout` binary.
- AR4 (AD-3): every piece of state has one home and one writer, per the spine's AD-3 table (sprint status: coordinator, with field rules (AR31); `reconcile`'s runner code alone sets a Story or an Epic `done`; `retro-gates.yaml`: `reconcile` runner code only; Story manifests and `epics.md`: graph planning units; Epic context at `epic_context_path` on `main`: the coordinator's status planning unit; ledger records by state, a `released` record by the releasing lane, or by the coordinator or the Maintainer's `xarabot rule` on the host applying a ruling; forge objects: the runner; the `status:` line of the unit's own Story file: the agent session; journal, PIDs, outcome: the lane process; `STOP`: the operator). The only other writes are the Maintainer's bootstrap writes in Xarabot's own repo, each in a Maintainer PR: at the self-host switch, a `bmad-sprint-planning` run that creates or updates `sprint-status.yaml` so Epic 1's Stories are `done`, Epic 2's Story manifests and Epic 2's context file; until the rulings Story (4.6) merges, a rejected retro's go in `retro-gates.yaml`; and, until graph planning units run (Story 2.7), the `epics.md` section, Story manifest and `sprint-status.yaml` key (`backlog`) of each Story a Maintainer correct course adds to a started Epic. Any other write is a defect.
- AR5 (AD-4): the ledger is the branch `xarabot/claims`, holding `units/<unit-file-id>.json` and `coordinator.json`. Every write fetches the tip and applies a pure edit that re-checks every precondition (state, owner, generation, glob overlap against `claimed`, `merging` and held `parked` records) against that tip; the swap is fast-forward-only (`PATCH git/refs` with `force: false`; `git update-ref <ref> <new> <old>` locally). On conflict, re-fetch and retry with jittered back-off; on a failed precondition, run `next` again. Ledger commits carry `[skip ci]`. Snapshot order: ledger, then `main`, then each ledger unit's PR state; the ledger wins over `main`.
- AR6 (AD-5): ledger records are a versioned state machine with the fields `schema_version`, `unit`, `state`, `owner`, `host`, `lane`, `generation`, `globs`, `heartbeat_at`, `pr`, `pr_owner`, `base_sha`, `head_sha`, `reviewed_sha`, `passed_sha` (set only by a review round with no blocking pass), `enqueued_sha` (the head the runner enqueued at, or fenced at before a coordinator re-park; Story 3.5), `approved_sha`, `approved_graph` (Story 2.8), `retro_result` (a retro unit's validated result, Story 2.9), `builder_providers[]`, `park` {`kind` (`awaiting-approval` | `needs-approval` | `blocked`), `reason` (a `blocked.kind`, or a runner cause: `review-cap` | `ci-fix-cap` | `ci-timeout` | `write-check` | `no-op` | `attempts-cap` | `unclaimable` | `graph-invalid` | `readiness`, a planning unit's `planning` result `blocked`, status or graph, Story 2.7 | `review-findings`, a planning or retro PR's blocking review, parked for the Maintainer with no loopback, Story 3.5), `inbox_owner`, `globs_held`, `text` (a sanitized, capped reason text for an inbox item, Story 4.2), `graph_posted` (the hash of the graph delta the runner last posted, retro item 24)}, `attempts`, `loopbacks`, `ci_fixes`, `approval` {`by`, `manifest_sha`}. States `claimed`, `merging`, `parked`, `released`, `merged`; the Structural Seed state diagram is normative. Only `merged` records, and superseded `released` `reconcile:<n>` and planning records (Stories 2.5 and 2.7), are deleted (by the coordinator); `generation` only goes up; `attempts` survives release. `now` is the forge server's time from `Forge.snapshot()` (host clock only in local-only mode and for sleep lengths). An unknown or newer `schema_version` stops the lane before `next`, with an alert. The ledger `schema_version` was 4 at the end of Epic 2 (Stories 2.7, 2.8 and 2.9 each bumped it), a ledger-only constant. Story 3.5's `enqueued_sha` made it 5, and retro item 24's `park.graph_posted` rode the same bump. Story 4.2's `park.text` made it 6, and Story 4.6's `coordinator.json` pending rulings and dismissals ride 6. `host` is a UUID written to `host.yaml` by `xarabot lane install`.
- AR7 (AD-6): heartbeat every 5 minutes for `claimed` records and builder-held `merging` records. A stale `claimed` record (30 min) may be taken over at `generation` + 1, `attempts` + 1, parking on the 3rd. A stale builder-held `merging` record: merged PR → `merged`; still queued → any lane may take it over; otherwise → `released` with `attempts` + 1 and `pr` kept. `parked` never expires. CAS retry loops give up after 10 tries or the call's deadline. Before each push, PR change, enqueue or merge, a fencing heartbeat swap requires the lane's own `owner/host/lane` and `generation`, or the unit is abandoned. Pushes use `--force-with-lease` against `head_sha`; enqueue and merge pass the expected head SHA.
- AR8 (AD-7): each outcome's ledger effect per the spine's AD-7 table, including: `merging` written before enqueue; awaiting approval → `parked` holding only the diff's paths; blocked kinds (including a `planning` result `blocked`, `readiness`) → `parked` with globs released and an inbox item; crash, missing or invalid result, timeout, budget overrun or a forge `rejected` error → `released` with `attempts` + 1, `parked` at ≥ 3; recurring units with nothing to commit → `merged` with no PR, deleted at once, except the newest `reconcile:<n>` record, which stays as the last run's time (Story 2.4); an ejected or dequeued approval-gated PR → `parked`, `approved_sha` cleared; Infrastructure Story without approval → `parked` (`needs-approval`); `stop --now` or STOP during a usage-limit sleep → `released` without counting an attempt. Every move out of `merging` other than to `merged` dequeues first; every cap is tested with `>=`. Coordinator-held `merging` records are checked by later `reconcile` runs, never by heartbeat.
- AR9 (AD-8): the coordinator role is a claim in `coordinator.json`, heartbeated through its units and waits; the same `<owner>/<host>/coordinator` identity re-claims without a takeover; a different identity refuses to start while it is live; if expired or missing, builders continue and post the alert.
- AR10 (AD-9): one branch and one PR per unit. Branches: `<story-namespace><story-id>` (Xarabot: `story/9.3`) and `<xarabot-namespace><kind>-<id>` (default `xarabot/retro-item-9.12`), both namespaces set by repo config. `story`, `retro` and `retro-item` are one-shot (no `checkpoint` unit runs; `checkpoint:<epic>` is only a `go` target); `planning:<slug>.<n>` and `reconcile:<n>` recur with a run number. Every claim inspects the unit's branch and all its PRs (merged → `merged`; open → adopt, `head_sha` from the PR; closed or none → start from `origin/main`). A `rebuild` ruling closes the open PR and clears `reviewed_sha`/`passed_sha`. "Done on `main`" per kind as in AD-9. Wip is snapshotted as `wip/<unit>` in `runner.git` before any reset, never pushed; a restart resumes wip only at the same claim generation. Cross-owner takeover (v1) closes the old PR and opens a new one under the new bot.
- AR11 (AD-10): the Story manifest is one file per Story in a repo-configured directory (Xaravel: `stories/<id>.md`); config says whether it doubles as the BMAD Story file. Required frontmatter `story_id`, `epic`, `sprint_key`, `title`; paths as `globs` or a repo-mapped key (Xaravel: `component`); optional `depends_on` (a list of Story ids, each in the same Epic or an Epic it depends on, transitively; the Story is eligible only once each listed Story is `done` in `sprint-status.yaml` on `main` or has a `merged` ledger record, either way on `main`; planning units write it where a Story builds on an earlier one), `infrastructure: true`; repo-only fields and `status` ignored. Glob normalization: strip `./`; reject `!`, `..` and absolute paths; compare by case-folded character prefix; globs overlap unless their literal prefixes are disjoint. Resolved globs are stored at claim time. A Story whose globs resolve to nothing is unclaimable and goes to the inbox. Outside its globs a Story's diff may carry only its own BMAD Story spec file and the `status:` line of its own Story file. `story_spec_path` is a glob pattern, default `_bmad-output/implementation-artifacts/spec-<epic>-<story>-*.md` (Story 1.7: `spec-1-7-*.md`; Story 1.17a: `spec-1-17a-*.md`); the Story's spec file is the single match whose `status` is `done`; any other match must be `blocked`, is superseded, and is dropped from the squash; a `blocked` result parks whatever the matches. Infrastructure Stories are claimable only with a ledger approval whose `manifest_sha` matches.
- AR12 (AD-11): one pure `resolveGraph(snapshot)` in `src/core` builds the effective graph from `.xarabot/epics.yaml`, the Epic and Story headings in `epics.md`, each manifest's `epic` and the package edges, from one `main` SHA; gates and `next` read only its output. Strict versioned schema (`version`; `epics` map; keys `^[1-9][0-9]*$` converted to numbers; `depends_on` a list of positive integers; `checkpoint` only literal `true`; duplicate keys detected from the raw text; multi-document or null `epics` invalid). Default: an unlisted Epic, or one without `depends_on`, depends on the next lower Epic number in `epics.md`; no file means serial; checkpoints never inferred. The `epics.md` grammar is stock output: Epic = level-2 `## Epic <int>:` outside fenced code (lines under `## Epic List` ignored); Story = level-3 `### Story <int>.<int>[a-z]?:` under its Epic. An Epic's Stories are exactly the manifests naming it; a heading with no manifest is unclaimable, listed in the Maintainer's inbox, and keeps its Epic from being done; an Epic with no Stories is never done. An Epic listed in config's `bootstrapped_epics` (a Maintainer-approved list of Epic numbers, default `[]`; Xarabot's own repo sets `[1]` at the self-host switch) reads as all Stories done and retro done, is exempt from that rule, and its Story headings are not reported as unclaimable. Absence of the file is decided only from the tree listing; other read errors fail closed. Validation (invalid file, unknown Epic, cycle, manifest mismatch, a manifest `depends_on` naming a Story outside its own Epic and the Epics it depends on) stops every lane with an alert. Graph-changing PRs: validated on the merge result before enqueue, hold the pseudo-glob `xarabot:graph`, need the Maintainer's approval with `approved_graph` hash re-checked at enqueue, and get the delta posted on the PR. Epic numbers and Story ids are fixed once used; only a checkpoint with a recorded go may be retired. The same validator ships as `xarabot graph check`.
- AR13 (AD-12): gates on the graph, measuring distance along dependency edges from Epic E: Epic D starts only when every Epic it depends on has all its Stories `done` in `sprint-status.yaml` on `main` and its retro done (an Epic in `bootstrapped_epics` counts as both); a `blocking` item holds every Epic at distance ≥ 1, any other open item (`open`, `in-progress`, `waiting`) holds distance ≥ 2; a retro verdict `rejected` holds every Epic at distance ≥ 1, like a `blocking` item, and puts a course-correction item in the Maintainer's inbox until the Maintainer's `/xarabot go retro:<N>` (`accepted` and `accepted-with-open-items` release as before); a checkpoint holds all transitive dependents until the go, while in-flight Epics finish held Stories. Retro results carry each item's stock BMAD action-item id (`epic-<N>-retro-item-<seq>-<slug>`), `blocking`, `route` and `globs`; the runner validates them one to one against the `action_items` the diff appends and the verdict against the `verdict` field of the stock retro document's frontmatter (`{implementation_artifacts}/epic-<N>-retro-<date>.md`), stores the result in the ledger record, and `reconcile` writes `retro-gates.yaml` once. `retro-gates.yaml` has `schema_version: 1` and an `epics` map keyed by Epic number; each Epic has a `retro` record that `reconcile` writes once (`verdict`, `unit` `retro:<N>`, `recorded_at`, and for a `rejected` verdict a `go` {`by`, `at`, `ruling`}, absent until the go; a go the Maintainer writes by hand before Story 4.6 has `ruling: maintainer-pr`), `items` (`id` `epic-<N>-retro-item-<seq>-<slug>`, `text`, `route`, `blocking`, `globs`, `status` `open`/`in-progress`/`waiting`/`deferred`/`done`; `in-progress` is not written in 0.x, so a claimed item stays `open`; `reconcile` writes `done` and `deferred`, from a merged retro-item PR or a ruling) and a `checkpoint` record holding the checkpoint's `go` {`by`, `at`, `ruling`}, which `reconcile` writes when the go is recorded and which stays when the checkpoint is retired; a checkpoint Epic with no `checkpoint` record is awaiting its go. Graph changes take effect at the next claim.
- AR14 (AD-13): `next(snapshot, laneRole)` returns a unit or `idle` with a reason. Every unit kind holds globs (planning comes in two kinds: a status unit, which runs `bmad-sprint-planning` and compiles Epic context, holds the status files and every Epic's context path (the `epic_context_path` pattern for any `<N>`, Story 2.4) and is not approval-gated; a graph unit holds the graph inputs and `xarabot:graph`, is approval-gated and never touches the status files; retro: status files, Epic context and the retro document path (`retro_doc_glob`, AR21), so the stock `epic-<N>-retro-<date>.md` can land, never graph inputs; no `checkpoint` unit runs, and `checkpoint:<epic>` is only a `go` target; retro items: their `globs` from `retro-gates.yaml`, never graph inputs, status files or write-check paths, unclaimable without globs; `reconcile`: none; a parked approval-gated PR: only its diff's paths); the overlap check applies to every role. Builders take only eligible Stories that are not `done` in `sprint-status.yaml` on `main`, whose record is absent, `released` or stale, and whose manifest `depends_on` Stories are each `done` there or have a `merged` ledger record, lowest Epic number first, then lowest Story number. An Epic's Stories are eligible only once its Epic context file (`epic_context_path`) exists on `main` and is valid: non-empty and starting with `# Epic <N> Context:`, the stock check in `bmad-build-auto` step-01; an Epic in `bootstrapped_epics` is exempt. A status planning unit compiles it by following the installed stock `bmad-build-auto` skill's `compile-epic-context.md` with the Epic number, the epics path, the planning artifacts directory and the output path; the Maintainer compiles Epic 2's at the self-host switch (AR4). The runner reverts builder changes to it. Coordinator order: `reconcile` (apply rulings; enqueue approved held PRs; write `merged`; mark done; batch-route Maintainer-only retro items; rewrite each changed inbox digest and post the daily digest mention, AR24; due only when the snapshot shows `reconcile` work or 10 minutes have passed since the last run, decided by the Maintainer on 2026-10-24, or a PR parked `awaiting-approval` that the Maintainer approved at the parked head, 2026-10-25), open coordinator PR, planning (a due graph unit before a status unit; no planning unit of a kind, status or graph, is due while a planning record of that kind is parked `blocked` for any reason; a status unit is also due for an Epic with unfinished Stories whose context is stale: its `<!-- source: sha256:<hex> -->` header line, written when a status planning unit compiles it, is missing or differs from the SHA-256 of the Epic's own `epics.md` section on `main`, from its `## Epic <N>:` heading up to the next `## Epic` heading, which `planningDue` recomputes each round; this extends the missing-or-invalid rule, Maintainer 2026-10-25, retro item 12), retro (due once the Epic's live evidence file, `live_evidence_glob` (AR21), is on `main` and, for each command `live_evidence_checks` (AR21) lists for the Epic, holds that command and a `bun test` summary with `0 fail`; until then `next` idles `waiting-on-maintainer`, naming the file or each missing or failing command), retro items. Approval-gated coordinator PRs (a Protected Path or a graph change; not a status planning unit gated only by `owner_approval_paths`) never touch the status files; after a graph unit merges, `reconcile` writes its status entries.
- AR15 (AD-14): every session writes JSON to `XARABOT_RESULT` (in the sandbox temp folder, outside the clone) as the prompt's last step, never from a skill hook. Union keyed by `kind`: `build` (`outcome` `done`/`blocked`/`no-op`, `blocked` {`kind` `escalation`/`human-live-step`/`intent-gap`/`verification`/`other`, `text`, `step_id`}, `summary`, `body`, `verification[]`); `review` (`reviewed_sha`, `verdict` `pass`/`changes-requested`, `findings[]` {`severity` `high`/`medium`/`low`, `blocking` a separate boolean, `file`, `text`}); `retro` (`verdict` `accepted`/`accepted-with-open-items`/`rejected`, `items[]` {`id`, `text`, `route` `lane`/`maintainer`, `blocking`, `globs`}); `planning` (`outcome` `done`/`nothing-due`/`blocked`, `summary`); all carry `denied_actions[]`. A missing result gets one resume asking only for the result (`claude -p --resume`, confirmed in Story 1.14; `codex exec resume <thread_id>`, confirmed in Story 3.1; pi with its v1 adapter); builds also cross-check the `status` and `## Auto Run Result` of the Story's spec file (AR11), and for a `blocked` result only when `story_spec_path` has exactly one match. Still missing or invalid → failed attempt; a `done` build result is invalid unless exactly one match is `done` and every other match is `blocked` (AR11). Agent, model, effort, tokens, cost, timings, diff, files touched and authorship are never taken from the agent.
- AR16 (AD-15): each lane has a runner-private `runner.git` in its state folder that the sandbox can neither read nor write. The runner never runs git against the agent clone's `.git`; it rebuilds the clone, `.git` included, from `runner.git` before every session (first build at `base_sha`; loopback or CI fix at `head_sha` with findings or CI log prefetched), then reads only the working tree. Before acting on a PR this lane didn't build, it fetches the PR head and `passed_sha` into `runner.git`. The commit: working-tree changes against `base_sha`, three-way merged onto `origin/main`, one commit authored by `<login>-xarabot[bot]`, recording `base_sha` and `head_sha`. A pure sanitizer strips trailers, closing keywords and `@mentions`, redacts the seeded vendor credential and token-shaped strings, and caps each text below the forge's limits, in agent `summary`/`body` before any forge text. Only the runner pushes, opens PRs, comments, enqueues and merges; never an admin merge or GitHub auto-merge.
- AR17 (AD-16): the reviewer must come from a provider not in `builder_providers[]`: the first allowed adapter of (`claude`, `codex`) whose provider is outside the set (provider = the model's vendor); if the policy allows none, a separate same-vendor session reviews under the same rules (the first allowed of `claude`, `codex`; decided by the Maintainer 2026-10-21); a policy allowing neither has no reviewer, and its lanes refuse to start (pi returns as a builder and a reviewer with its v1 adapter); a session whose reported model differs from config fails. The review runs on a fresh `runner.git` checkout of `head_sha` with agent config paths restored from `main`, hooks off and a freshly seeded vendor home; the runner records `reviewed_sha` and posts the review naming it. No blocking findings → `passed_sha`. Enqueue only if the head equals `passed_sha` or its tree equals the merge of `passed_sha` with the head's `main` parent, recomputed by the enqueuing lane. Owner-gated PRs need `approved_sha` = head; graph-changing PRs need the Maintainer's approval on the head and a matching `approved_graph`. `reconcile` PRs get no agent review. Any later agent change re-runs the review. A review-driven fix session counts as a loopback (`loopbacks`, at most 2); a CI-fix session, or an agent session resolving a merge conflict, counts as a CI fix (`ci_fixes`, at most 2, AR20) and never as a loopback. Past either cap the unit parks blocked (`review-cap` or `ci-fix-cap`). A lane refuses to start if its reviewer adapter isn't allowed.
- AR18 (AD-17): only `src/sandbox/` spawns agent and reviewer processes; a boundary test bans `Bun.spawn` under `src/adapters/agent/`. macOS: `sandbox-exec` with a generated profile, re-tested on each macOS major; Linux: `bwrap` with `--unshare-pid`; each agent's own sandbox off inside it. A per-lane vendor home under the state folder is re-seeded before every session with only that vendor's credential (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`; on macOS `claude` gets `CLAUDE_CODE_OAUTH_TOKEN`); the operator's `~/.claude`, `~/.codex`, `~/.pi` are inaccessible. Vendor credentials live in one mode-600 file per vendor under `$XDG_CONFIG_HOME/xarabot/vendors/<vendor>/` (fallback `~/.config`), next to the App key, written once by the operator; each adapter Story confirms the exact form (`claude`: the token from `claude setup-token`, passed as `CLAUDE_CODE_OAUTH_TOKEN`; `codex`: `auth.json` (ChatGPT login) in the lane's `CODEX_HOME`, or an API key as `CODEX_API_KEY`, per the AR42 spike, Story 3.1; pi's comes with its v1 adapter). The lane process reads the file and seeds the vendor home or the credential variable before each session, builder or reviewer. A missing or unreadable credential for the lane's adapter or its reviewer makes the lane refuse to start, and a session whose credential can't be read is refused. Reads denied by default except system paths, the resolved real paths of the agent CLI, `bun`, `uv`, `git` and the uv-managed Python install (computed at session start), the lane clone, vendor home and temp folder; the session's `HOME` is a fresh directory inside the temp folder; `~/.xarabot/**`, `$XDG_CONFIG_HOME/xarabot`, `~/.config/gh`, `~/.ssh`, `~/Library/Keychains`, `~/.git-credentials`, `~/.netrc` always denied. Writes allowed to the full clone (never a linked worktree), vendor home and temp folder; `runner.git` never accessible. Env allowlist only: `PATH` (rebuilt from allowed directories), `HOME`, `TMPDIR`, `LANG`, `LC_*`, `TERM`, the vendor credential variable, the variable that points the CLI at its vendor home, the variable that points the CLI at its temp folder, always set inside the session's temp folder (`claude`: `CLAUDE_CODE_TMPDIR`), `TMPPREFIX` (zsh's temp prefix), inside the session's temp folder, `XARABOT_RESULT`, `XARABOT_SANDBOXED`, the proxy variables and `UV_CACHE_DIR` (in the temp folder); git credential helper reset; Unix sockets denied. Network only through Xarabot's Bun proxy to vendor API hosts, `pypi.org`, `files.pythonhosted.org` and repo-added hosts; a GitHub host is never allowed. Fail closed if the sandbox can't be set up.
- AR19 (AD-18): repo commands the runner needs (e.g. lockfile regeneration) run inside the sandbox with no token. The runner's own git runs only against `runner.git` with `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `credential.helper=` reset before its own helper, `core.hooksPath=/dev/null`, no fsmonitor/filters/external diff/textconv/signing program, `GIT_NO_REPLACE_OBJECTS=1`, `protocol.file.allow=never`, no submodule recursion. Write-check and review diffs are computed from git objects under those settings. The token reaches git only through a credential helper over stdin, scoped to the forge URL; never in env, argv, a file or a log.
- AR20 (AD-19, adopted Lessons): poll CI by hand every 30 s backing off to 5 min, never `gh pr checks --watch`; stop at the first failure not on `policy.yaml`'s expected-checks list; an empty reply means pending; CI max wait default 60 min, then park blocked. An unexpected failure starts a CI-fix builder session, at most 2 per unit, journaled as `ci_fixes` and re-reviewed. Merge `origin/main` into a conflicting PR before polling; status YAML conflicts keep `main`'s lines and re-apply the PR's entries; lockfiles regenerated in the sandbox; other conflicts go to a builder session, counted as a CI fix (`ci_fixes`, sharing the cap of 2 with CI fixes), never as an attempt or a loopback, and re-reviewed (AR17); past the cap the unit parks blocked (`ci-fix-cap`). Squash through the merge queue, never `--delete-branch`; an ejection merges `main`, re-polls and re-enqueues, counted toward `attempts`.
- AR21 (AD-20): config in three layers: package (defaults, schemas, prompt template); repo (`.xarabot/config.yaml`, `policy.yaml`, `human-live-steps.yaml`, `epics.yaml`, `prompts/`, plus the Standing Authority file at the configured path), read only from freshly fetched `origin/main`; host (`host.yaml`, `XARABOT_HOST`, `XARABOT_MAX_BUILDERS`). All YAML with versioned schemas. The Standing Authority is valid when it exists on `main` and its YAML frontmatter validates: `schema_version: 1`; `granted_by` (a GitHub login equal to config's Maintainer login); `granted_at` (ISO 8601 date); `repo` (`owner/name`, equal to this repo); optional `expires` (ISO 8601 date; a past date makes it invalid); the body is free prose. `.xarabot/config.yaml` also holds the planning paths, with defaults: `epics_path` (`_bmad-output/planning-artifacts/epics.md`), `sprint_status_path` (`_bmad-output/implementation-artifacts/sprint-status.yaml`), `retro_gates_path` (`_bmad-output/implementation-artifacts/retro-gates.yaml`), `retro_doc_glob` (`_bmad-output/implementation-artifacts/epic-<N>-retro-*.md`) and `epic_context_path` (`_bmad-output/implementation-artifacts/epic-<N>-context.md`); `live_evidence_glob` (default `docs/maintainer/evidence/epic-<N>.md`, the Maintainer's record of an Epic's live run, which its retro waits for, AR14); `live_evidence_checks` (optional: Epic number → the exact live commands its runbook requires, which the retro waits for in the evidence file, AR14; retro item 14); `bootstrapped_epics` (default `[]`, AR12); `digest_time` (default `08:00` UTC, AR24); and an optional Escalation source read with Xaravel's rule (source: Xaravel `tools/escalations/escalations.ts`): Escalation files `ESC-<story-id>-<n>.md` or `ESC-bot-<n>.md` in a configured directory, and decision files in `<decisions-dir>` with the same file name as their Escalation file (e.g. `decisions/ESC-9.3-1.md`), carrying `decision: approved | rejected` and `escalation_sha256`, the lowercase hex SHA-256 of the Escalation file's text with CRLF normalised to LF. An Escalation is open when its decision is missing, invalid or stale; a Story with an open Escalation is not claimed or enqueued, parks blocked (`park.reason: escalation`) and appears in the Maintainer's digest (Story 7.6). Missing, invalid or unfetchable config, policy or Standing Authority stops the lane (an absent `epics.yaml` means serial, and an absent `retro-gates.yaml` reads as empty). Re-checked from fresh `main`: the Standing Authority before every claim, push, enqueue and merge; adapter and reviewer allowances before every session launch and enqueue. Consumer Protected Paths: `.xarabot/**`, the Standing Authority file, `.github/**`, and agent config at any depth (`**/.agents/**`, `**/.claude/**`, `**/.codex/**`, `**/.pi/**`, `**/.mcp.json`, `**/AGENTS.md`, `**/AGENTS.override.md`, `**/CLAUDE.md`, `**/CLAUDE.local.md`).
- AR22 (AD-21): lanes are host config: each lane in `host.yaml` has `repo`, `role`, `owner`, `agent`, `model`, `effort`; state under `~/.xarabot/repos/<owner>__<name>/lanes/<lane>/`. Unset `model` → adapter default; unset `effort` → `high`. A lane refuses to start if its agent isn't allowed unattended, its effort isn't offered for its model, the reviewer adapter isn't allowed, the App installation doesn't cover the repo, or the host has more builder lanes installed in `host.yaml` than `XARABOT_MAX_BUILDERS`, counted across all repos.
- AR23 (AD-22): `~/.xarabot/STOP` stops the host and a lane's `STOP` stops that lane, checked at process start, before `next` and before each claim; a STOP ends a usage-limit sleep. `stop --now`: write the lane's `STOP`, kill by recorded PID in the order `lane.pid`, `agent.pid`, `wait.pid` after checking each PID's start time and command, then apply AD-7. An agent session has 3 hours; a session alive 5 minutes after its result file appears is killed. Usage limits: sleep until reset + 2 min, or 15 min if unparseable, never over 8 h; wakeable; heartbeat continues; the unit budget still applies.
- AR24 (AD-23): one `xarabot-inbox`-labelled issue per owner, assigned to them; only the Maintainer's is pinned, by hand. Each `reconcile` run rewrites an owner's issue body from `parked` records, PR states, `retro-gates.yaml` and open Escalations (AR21) when its content changed, routing Maintainer-only retro items in batch. GitHub sends no notification for a body edit, so once a day, at config `digest_time` (default `08:00` UTC), `reconcile` posts one @mention comment per inbox linking the body, keeping the last post time in `coordinator.json`; that is FR9's one daily digest. Any lane may post a single @mention alert for a condition that newly stops every lane, deduplicated by (condition, `main` SHA), allowed even while failing closed. The App gains `issues: write`.
- AR25 (AD-24): each lane appends to `journal.jsonl` one record per unit (AD-14 facts plus `outcome`, `loopbacks`, `ci_fixes`) and one per idle or waiting span with its reason (`waiting-on-maintainer`, `usage-limit`, `idle`); a lane is `waiting-on-maintainer` when `next` idles only because of a checkpoint go, a parked approval, a rejected retro, a Maintainer-routed item, or an Epic's live evidence (AR14); subscription cost labelled an estimate. `xarabot report` computes Stories per hour excluding all-lanes-`waiting-on-maintainer` hours. `xarabot status --json --watch` is the only status interface; the TUI draws it locally or over `ssh $XARABOT_HOST`. Logs kept 30 days; journals forever.
- AR26 (AD-25): a lane runs `~/.xarabot/runner/<version>/`, the version from `runner_version` in `.xarabot/config.yaml` on `origin/main`. A consumer's exact `@xaravel/xarabot` pin must equal `runner_version` or the lane refuses to start; Xarabot's own repo uses `runner_version` alone. Only the Maintainer advances it. `xarabot lane install` installs that version and writes the launchd plist or systemd unit, with a restart throttle, to run a fixed launcher, `~/.xarabot/bin/xarabot-lane <repo> <lane>`, which runs the version named in the lane's `runner` file (in the lane state folder) and sets `XARABOT_SANDBOXED` only for agent sessions, never for itself. A lane that sees a different `runner_version` on `main` installs that version at `~/.xarabot/runner/<version>/`, rewrites `runner` and exits without claiming; the next start runs it. Pinning back works the same way, and nothing re-execs mid-unit.
- AR27 (AD-26, adopted from `bootstrap/join.ts`): the App key lives at `$XDG_CONFIG_HOME/xarabot/apps/<login>-xarabot/private-key.pem` (fallback `~/.config`), mode 600, with `app.json` recording App ID and slug; vendor credentials sit next to it under `vendors/<vendor>/` (AR18). Installation tokens are minted on demand, last 1 hour, memory only. The App has no admin, bypass or approve rights and no `workflows: write`; a diff touching `.github/workflows/**` is a write-check refusal. The App asks for exactly `contents: write`, `pull_requests: write`, `issues: write`, `checks: read`, `statuses: read`, `actions: read`, `metadata: read` (granted to every App); AR38 found the merge queue needs no permission of its own. One table maps each GitHub operation to the permission it needs (Story 5.1a): git pushes go through the credential helper and are covered by `contents: write`; `join`'s manifest-conversion and App-JWT calls need no installation permission; branch-protection reads need `administration: read`, which the App never has, so those checks report "unverified" and the lane continues with a warning.
- AR28 (AD-27): every runtime-validated shape has one zod schema in `src/core/schemas/` with its TS type inferred (config, policy, Standing Authority, manifests, ledger records, results, `retro-gates.yaml`, rulings, prefetched GitHub data, journal, status, `Snapshot`). The `Snapshot`'s named fields: `now`; ledger tip and records; `main` SHA; config, policy, Standing Authority; manifests and the resolved graph; `sprint-status.yaml` and `retro-gates.yaml`; the Escalation statuses, when config names an Escalation source (AR21); each Epic's context file at `epic_context_path`, for the context gate (AR14); PR state of every ledger unit; lane identity and role. YAML via `Bun.YAML`, globs via `Bun.Glob`. Each port has one contract suite in `test/contracts/` that every adapter passes, including many lanes racing on the ledger and every forge error kind.
- AR29 (AD-28): rulings are comment commands on the inbox issue: `/xarabot <verb> <unit-id>` with `go` (a checkpoint, or a rejected retro as `go retro:<N>`), `approve`, `block`, `unblock`, `done`, `defer` (`done` and `defer` on `retro-item:<id>`; all six Maintainer only) and `rebuild`, `release`, `dismiss` (item owner or Maintainer). `release` and `rebuild` reset `attempts`, `loopbacks`, `ci_fixes`; `rebuild` also closes the PR and clears `builder_providers[]`; `release` keeps them; `dismiss` removes only the inbox item; `done` and `defer` set the retro item's status to `done` or `deferred`, written by `reconcile`'s runner code. `reconcile`'s runner code applies rulings (the checkpoint go included), never an agent, reading new comments from a cursor in `coordinator.json` and replying with a 🤖 acknowledgement. `xarabot rule <verb> <unit-id>`, run by the Maintainer on the Xarabot host, applies `release` and `rebuild` with the same ledger edit from 0.x (Story 2.5b); the other verbs follow Story 4.6, and local-only mode (v1) uses it for all.
- AR30 (AD-29): `core/prompt` builds every prompt purely from the package template, the repo's `prompts/` sections, the unit id, the Human Live Steps list, the result path and (v1) Lessons, all from fetched `origin/main`. The prompt names the unit; a test asserts it has no selection, CI, merge or status instruction. It runs the stock skill for the unit (`story` first build: `bmad-build-auto`, the prompt naming the Story by its id and `sprint_key`, e.g. "Build Story 1.7 (`1-7-forge-port-fake-forge-and-contract-suite`)", so build-auto's spec slug leads with the id (AR11); loopback or CI fix: none, apply prefetched findings or log; `retro`: `bmad-retrospective -H <epic>` then the item fields; `planning`: a status unit runs `bmad-sprint-planning` headless, returns any readiness findings in its `planning` result (`outcome: blocked`, the findings in `summary`) and never saves a findings file, and compiles Epic context by following the installed stock `bmad-build-auto` skill's `compile-epic-context.md` with the Epic number, the epics path, the planning artifacts directory and the output path (AR14), and a graph unit makes the manifest, `epics.md` and `.xarabot/epics.yaml` edits; `retro-item`: none, the prompt names it), then writes the result as its last step. Never run by a lane: `bmad-create-epics-and-stories`, `bmad-correct-course`. The clone is on the unit's branch before the session. Adapters pass their CLI's attribution-off setting (e.g. `claude --settings {"attribution": false}`).
- AR31 (AD-30): the 0.x write check refuses builder diffs touching coordinator-owned files (`epics.md` included), manifests, `.xarabot/**`, the Standing Authority file, `.github/**`, agent config at any depth, an Epic's live evidence file (`live_evidence_glob`, AR21) or the repo's Protected Paths, with only three exceptions (an approved Infrastructure Story's Protected Paths, never coordinator files, manifests or `.xarabot/**`; the unit's own BMAD Story spec file (AR11), after superseded matches are dropped; the `status:` line of its own Story file). Coordinator diffs may touch only the paths their unit holds; only a planning graph unit may touch a graph input, and under `.xarabot/**` only `epics.yaml`; a diff touching both a graph input and a status file is refused. Any agent diff changing a retro verdict, item or checkpoint go is refused. Only the session's own change is checked, never runner-written content. A refusal parks blocked and is logged. Field-level status-file rules (Maintainer decision 2026-10-25, Epic 2 retro C5, built by retro item `epic-2-retro-item-15-field-level-status-file-rules`): in `sprint-status.yaml` a status planning session may only add missing keys and never change an existing value; a retro session may only append its Epic's `action_items` and set its own `epic-<N>-retrospective` key; no coordinator session sets a Story `done`, which only `reconcile`'s runner code does. The coordinator check does not case-fold its own allow-list. Two further refusal classes come from retro items: `symlink` (a target outside the clone, item 18) and `credential` (a blob holding the seeded credential or a token-shaped string, item 20).
- AR32 (AD-31): the bootstrap loop copy runs under a dedicated macOS user holding only the bot key, the Claude credential and its own clone (no `gh` login, ssh key or GitHub keychain item); the Maintainer's home is mode 700; the loop mints installation tokens each iteration. Self-hosting happens only once AD-17's sandbox runs in the first Epic.
- AR33 (AD-32): `Forge` error kinds: `conflict`, `not-fast-forward`, `auth`, `forbidden`, `rate-limited` (with `retry_after`), `not-found`, `uninstalled`, `transient`, `rejected` (an unmapped 4xx, or a push refused by a rule). `rate-limited` and `transient` back off within the call's deadline, and a heartbeat that would lapse releases the unit; `auth`, `forbidden` and `uninstalled` stop the lane with an alert, and the run counts as a failed start (AR34); `rejected` fails the unit's attempt (AR8).
- AR34 (AD-33): launchd and systemd restarts are throttled; 3 failed starts in a row write the lane's own `STOP` and post an alert, and a lane-stop outcome counts as a failed start. Consumer prerequisites, Human Live Steps checked at lane start where the API allows: the `xarabot/claims` ruleset (no force-push or deletion; no other ruleset matching it); the merge queue on `main`; squash messages set to PR title + body; Protected Paths requiring the owner's review with stale approvals dismissed and most-recent-push approval required (Xarabot's repo: code-owner review, with the status files owner-less so `reconcile` PRs need none); the App installed with `issues: write` (AR38 found the merge queue needs no permission of its own).
- AR35 (Consistency Conventions): integer Epic keys; `story_id` matches `^\d+\.\d+[a-z]?$`, sorted numerically by part then suffix. Unit ids `story:<story_id>`, `retro:<epic>`, `retro-item:<bmad-action-item-id>`, `checkpoint:<epic>`, `planning:status.<n>`, `planning:graph.<n>`, `reconcile:<n>`; ledger file names replace `:` with `__`. Lane identity `<owner>/<host-uuid>/<lane>`, lanes `coordinator` and `builder-1` … `builder-N`. kebab-case files, `camelCase` functions, `PascalCase` types, one port per file in `src/ports/`. `src/core/` returns `{ ok: true, value } | { ok: false, error: { kind, message } }` and never throws; the shell catches at the unit boundary. ISO 8601 UTC timestamps. Logs at `logs/<unit-file-id>-<start>.log`. Forge text only by the runner after sanitizing; status comments start with 🤖. Tests with `bun test`: core tests are case tables with no mocks, each gate and each `next` input has its own test, adapters go through contract suites. Lint and types with `bun --bun oxlint` and `bun --bun tsc`, never through Node.
- AR36 (Stack): Bun 1.4.3 (runtime, tests, packages, `Bun.YAML`, `Bun.Glob`); TypeScript 7.0.2; oxlint 1.89.0; zod 4.6.7; adapter CLI minimum tested versions claude 2.1.304, codex-cli 0.163.0 (minimums, not pins; pi 1.3.0 goes with the v1 adapter); bubblewrap 0.13.1 on Linux.
- AR37 (Structural Seed): the host layout (`~/.xarabot/STOP`, `bin/xarabot-lane` (the fixed launcher, AR26), `runner/<version>/`, `repos/<owner>__<name>/lanes/<lane>/` with `clone/`, `runner.git/`, `vendor/`, `runner` (the version the launcher runs), `journal.jsonl`, `lane.pid`, `lane.lock`, `agent.pid`, `wait.pid`, `outcome`, `STOP`, `logs/`; `$XDG_CONFIG_HOME/xarabot/` with `host.yaml`, `apps/<login>-xarabot/` and `vendors/<vendor>/`) and the source tree (`src/core/` with `schemas/`, `src/ports/`, `src/adapters/forge/github/`, `src/adapters/agent/{claude,codex}/` (`pi/` with the v1 adapter), `src/sandbox/`, `src/lane/`, `src/cli/` with `join`, `lane install`, `wake`, `stop`, `rule`, `status`, `tui`, `report`, `upgrade`, `graph`; `test/contracts/`; `bootstrap/`).

Open items and spikes the spine assigns to specific Stories:

- AR38 (settled 2026-10-23): `enqueuePullRequest` and `dequeuePullRequest` need no merge-queue permission. With `contents: write` and `pull_requests: write` granted, GitHub authorized `enqueuePullRequest` live on the scratch repo, so the adapter names `contents: write` for them (AD-26).
- AR39: the forge contract suite settles which `PATCH git/refs` response (409 or 422) means "retry the swap".
- AR40: the sandbox Story proves the proxy's hostname allowlist with a spike.
- AR41: deferred with the pi adapter (v1).
- AR42: the adapter Stories settle, per CLI, how `bmad-build-auto`'s outcomes (a `ready-for-dev` halt; it never yields `no-op`) map onto the `build` result and how session resume works. The `claude` half is a spike in Story 1.14, which also settles the `--output-format` that yields session id, tokens, model and reset time for `parseUsage`. The codex half is answered by the spike (`notes/codex-ar42-spike-2026-10-25.md`): subagents yes, resume by `codex exec resume <thread_id>`, usage from the session file; Story 3.1 confirms the outcome mapping. The pi half is deferred.
- AR43: Xaravel's MAINT file gains Standing Authority frontmatter in its adoption Epic (Xarabot defines the schema).

Brownfield lessons and adoption inputs (`brownfield-xaravel.md`):

- AR44 (Lessons): interrupted work is kept as wip and resumed (AR10); CI polling, conflicts and merges per AR20; macOS has no `timeout`; kill by exact PID, never `pkill -f`; a `claude -p` session can linger about 12 minutes after its final result (AR23's 5-minute kill); a denied auto-mode action is reported, never worked around (`denied_actions[]`); live GitHub settings, rulesets and secrets are written by the Maintainer, never a lane.
- AR45 (Adoption inputs Xarabot must support, without performing the adoption): a repo path mapping such as Xaravel's `component` for manifest globs; a configurable Standing Authority path (Xaravel's `decisions/MAINT-2026-10-16-unattended-orchestrator.md`); reading Xaravel's `tools/escalations/` through config under 0.x; Xaravel's `.xarabot/epics.yaml` with Epic 8's checkpoint (`8: {depends_on: [7], checkpoint: true}`); Story headings without manifests reported as unclaimable (47 today in Xaravel); the existing Maintainer inbox and batch routing of Maintainer-only retro items (Xaravel PR #216) ported into FR9.

Scope bounds (SPEC § Non-goals): no faster or cheaper default model tier; no project-specific platform parts (product eval gates, per-worktree service stacks, cloud transcript sinks, SSO roles, production deploy reviewers), which consumers supply as integrations; no planning or running of Xaravel's adoption; no hosted service; no vendoring, forking or re-implementing BMAD's skills; no GitLab or other forges before a later release.

Deferred in the spine (no 0.x Story builds these): the spec-folder planning shape; the local-only forge adapter (v1); the v1 guard diff check and CI re-check; a CI `resolveGraph` check on human-authored PRs (v1, CAP-19); removing a queued PR when authority is revoked (v1); Xarabot-owned Escalations (v1; 0.x reads Xaravel's Escalation files through an optional config source and holds a Story with an open one, Story 7.6); injecting Lessons (v1); the Actor registry and generated CODEOWNERS and rulesets (v1); detecting Human Live Steps beyond `blocked.kind` (v1); pipelining; cross-host telemetry and journal backup (v1); App key rotation; Linux sandbox packaging (AppArmor profile on Ubuntu 24.04+, `bwrap` source).

### UX Design Requirements

None. There is no UX design contract. The only interface beyond the CLI is the read-only TUI (FR12), whose behaviour AR25 fixes: it draws `xarabot status --json --watch`, locally or over ssh.

### FR Coverage Map

FR1: Epic 1 - pinned runner install from `runner_version`; Epic 7 - consumer exact-pin check, changelog, upgrade as a PR
FR2: Epic 1 - builder `next`, `resolveGraph`, `xarabot graph check`, the "dependencies merged and retro done" gate; Epic 2 - coordinator unit order, the graph-change gate; Epic 4 - retro-item distance gates and checkpoints
FR3: Epic 1 - ledger records and compare-and-swap for one lane; Epic 2 - heartbeat, takeover, fencing, glob overlap, across machines
FR4: Epic 2 - coordinator and N builder lanes on a macOS host; Epic 7 - Linux hosts (systemd)
FR5: Epic 4 - Epics in parallel by the graph, checkpoints hold only their dependents
FR6: Epic 1 - CI polling, merge queue, conflicts, status comments, usage-limit sleep, JSON result
FR7: Epic 1 - `claude` adapter; Epic 3 - `codex`, the common effort scale, unattended policy; `pi` v1
FR8: Epic 3 - SHA-bound cross-vendor review
FR9: Epic 1 - urgent alerts; Epic 4 - per-owner inbox, daily digest
FR10: Epic 4 - `blocking` tag and distance gates
FR11: Epic 1 - per-unit journal; Epic 6 - `xarabot report`
FR12: Epic 6 - `xarabot status --json --watch` and the TUI
FR13: Epic 1 - tokens from the existing App key, bot-authored commits, owner-approval-gated PRs; Epic 5 - `xarabot join`, installation scope
FR14: not planned (v1; needs a spine update first)
FR15: Epic 1 - STOP markers, `stop --now`, `wake`
FR16: not planned (optional, after v1)
FR17: not planned (v1; needs a spine update first)
FR18: Epic 1 - sandbox (macOS); Epic 2 - write check; Epic 7 - sandbox on Linux (`bwrap`); diff check and CI re-check not planned (v1)
FR19: not planned (v1; needs a spine update first)
FR20: not planned (v1; under 0.x, Xaravel's `tools/escalations/` is read through config, Epic 7)
FR21: not planned (v1; needs a spine update first)
FR22: Epic 1 - Standing Authority validated from `main`, fail closed
FR23: not planned (v1; needs a spine update first)
FR24: Epic 1 - the `Forge` port and GitHub adapter with its contract suite; local-only adapter not planned (v1)

## Epic List

**Scope.** This plan covers Xarabot 0.x only (`releases.md`). The v1 FRs (FR14, FR17, FR19, FR20, FR21, FR23, and the v1 parts of FR18 and FR24) get their Epics in a later `bmad-create-epics-and-stories` or `bmad-correct-course` run, after the spine's Deferred items have an architecture update. FR16 stays unplanned.

**Planning decisions (Maintainer, 2026-10-21).**
- **Merge gate before cross-vendor review.** From self-hosting until Epic 3 merges, Xarabot's own repo policy makes every path need the Maintainer's approving review, and the host runs `XARABOT_MAX_BUILDERS=1`. CAP-13 allows a repo to require more. Epic 1 therefore includes approval-gated PRs.
- **Bootstrap.** Epic 1 is built by the bootstrap copy of Xaravel's loop (NFR13), which picks work from `epics.md` prose; its Stories are strictly serial and each stands alone. Every later Epic is built by Xarabot's own pinned runner (NFR14).

**Test strategy (applies to every Epic).**
- Story 1.1 sets up `bun test` with its live switch (`XARABOT_LIVE=1`), `bun --bun oxlint` and `bun --bun tsc`, the import-boundary lint, the `Bun.spawn` ban under `src/adapters/agent/` and the `test/contracts/` skeleton. The CI workflow that runs them as a required check on `main` is a Maintainer step (`.github/**` is never a lane's to write).
- An in-memory fake `Forge` passes the same contract suite as the GitHub adapter, so lane, claims and plumbing code is tested without GitHub, including many lanes racing on the ledger (AR28).
- Every Story names its tests in its acceptance criteria: core Stories their case tables (no mocks), adapter Stories the contract suite they pass, sandbox Stories a refusal test per adapter, security-sensitive Stories their negative tests.
- Every Epic ends with a verification Story that proves its success criteria end to end on the real repo. The Story writes its live command (`XARABOT_LIVE=1 bun test <suite>`) and expected result into `docs/maintainer/self-host.md`, and the Maintainer runs it on the Xarabot host, outside the sandbox, with the credentials it needs (Story 3.6: every vendor's), before that Epic's retro. Live cases run only when `XARABOT_LIVE=1` is set and otherwise report skipped, as they do inside a sandboxed session.
- Sandbox suites (Stories 1.11 and 1.12, the sandbox re-run in Story 3.1, and Story 7.3) detect that they already run inside the Xarabot sandbox (`XARABOT_SANDBOXED=1`, set by the launcher) and skip their nested cases and cases that bind sockets or need other access the profile denies, reporting them skipped; the Maintainer runs those live too.
- Live acceptance runs that do not fit a unit's 6-hour budget are Maintainer-run checks, not Stories: FR4's 24-hour run of a coordinator and 2 builders (after Epic 3 lifts the 1-builder limit) and NFR22's throughput, measured in Xaravel.

### Epic 1: One sandboxed lane builds Stories unattended
The Maintainer installs a pinned Xarabot runner on the Xarabot host, and one `claude` lane builds Stories with no human watching. `next` picks the Story in code. The agent runs in the sandbox with no GitHub credential or host. The runner commits as `edanisko-xarabot[bot]`, opens the PR, polls CI, parks a PR until the Maintainer approves it, merges through the queue, sleeps through usage limits, keeps a journal and obeys STOP. This is the self-host threshold.
**FRs covered:** FR2 (builder), FR3 (one lane), FR6, FR7 (`claude`), FR9 (alerts), FR11 (journal), FR13 (tokens, authorship, approval gate), FR15, FR18 (sandbox, macOS), FR22, FR24 (GitHub), FR1 (pinned install)
**Notes:** the scaffold and test harness come first. macOS only (`sandbox-exec`, launchd). AR38 (merge-queue App permission) is settled (AD-26). Spikes AR39 (409 or 422), AR40 (proxy allowlist) and AR42's `claude` half (outcome mapping, resume, `--output-format`; Story 1.14). Precondition (Human Live Step, AR32): the bootstrap copy runs as a dedicated macOS user on the Xarabot host. Epic 1 has no Story manifests; at the self-host switch, `bootstrapped_epics: [1]` in `.xarabot/config.yaml` makes the gates read it as all Stories done and retro done (Story 1.20). Ends with a canary Story run from `next` to merge on the real repo, with a STOP mid-wait and a usage-limit sleep exercised.

### Epic 2: A coordinator lane and claims let builders run side by side
Xarabot runs its own coordinator: `reconcile`, planning, retro and retro-item units, under a coordinator claim. Builder lanes share a host, or several hosts, without building a unit twice or colliding on globs, and no builder can write coordinator-owned files, manifests, agent config or policy.
**FRs covered:** FR2 (coordinator order, graph-change gate), FR3 (heartbeat, takeover, fencing, overlap), FR4 (macOS), FR18 (write check)
**Notes:** planning splits into a status unit (stock sprint planning and Epic context; not approval-gated) and a graph unit (manifests, `epics.md`, `.xarabot/epics.yaml`; approval-gated; never status files), and `reconcile` writes a graph unit's status entries after it merges. Graph units change the effective graph, so the AD-11 graph-change gate (`xarabot:graph`, validation on the merge result, Maintainer approval bound to `approved_graph`) lands here. The builder limit stays at 1 until Epic 3 merges. Ends with two lanes racing against the real `xarabot/claims` for one unit and for overlapping globs, exactly one winning, and a killed lane's unit becoming claimable 30 minutes after its last heartbeat.

### Epic 3: Every diff is reviewed before it merges, by another vendor where allowed
`codex` lanes run beside `claude` with the same `agent`, `model` and `effort` settings (the `pi` adapter is deferred to v1: stock pi 1.4.0 gives `bmad-build-auto` no subagents; Maintainer, 2026-10-25), and the runner has every diff reviewed by a model from another vendor, bound to the reviewed SHA, before it merges.
**FRs covered:** FR7 (`codex`, effort mapping, unattended policy; `pi` v1), FR8
**Notes:** spike AR42 for `codex` (subagents, outcome mapping, resume; answered by `notes/codex-ar42-spike-2026-10-25.md` except the outcome mapping, which Story 3.1 confirms; `claude`'s half is in Story 1.14). The `pi` adapter and AR41 are deferred to v1. After it merges, the Maintainer lifts the every-path approval rule and the 1-builder limit. Ends with the same unit run to a valid result through each adapter, and a review re-run after a later agent change.

### Epic 4: Epics run in parallel behind retro and checkpoint gates, ruled from one inbox
Epics start as soon as the graph allows, retro items and checkpoints hold exactly the Epics they should, and each owner rules on everything waiting on them from one daily inbox digest by comment command.
**FRs covered:** FR2 (distance and checkpoint gates), FR5, FR9 (inbox, digest), FR10
**Notes:** includes the checkpoint gate (no checkpoint unit runs; the digest lists the go) and the rulings grammar (AR29), with `go` also releasing a rejected retro (`/xarabot go retro:<N>`). Ends with a graph fixture proving the distance and `blocking` gates, and a checkpoint holding only its dependents until `/xarabot go`.

### Epic 5: Each human runs lanes as their own bot
`xarabot join` creates a person's `<login>-xarabot` App from a manifest and installs it or requests the install, replacing `bootstrap/join.ts`. A lane whose installation does not cover its repo stops and names the repo to add.
**FRs covered:** FR13 (join, installation scope)
**Notes:** Story 5.1a maps every GitHub operation to its App permission. Epics 5 and 6 both touch `src/adapters/forge/github/**` (Story 5.1a, and the forge reads of Stories 6.1 and 6.2), so claims serialize those Stories; the graph keeps the two Epics parallel. Ends with `xarabot join` against a test org, and proof that the bot can neither approve nor admin-merge while its owner can approve and merge a Protected Path PR.

### Epic 6: Operators can see and measure every lane
`xarabot status --json --watch` reports every lane's unit, claim, CI and merge state and the inbox; the TUI draws it locally or over `ssh $XARABOT_HOST`; `xarabot report` compares agents and models and computes Stories per hour.
**FRs covered:** FR11 (report), FR12
**Notes:** Stories 6.1 and 6.2 add forge reads under `src/adapters/forge/github/**`, which Epic 5 also changes, so claims serialize them (Epic 5 notes). Ends with `xarabot report` reproducing a hand-computed Stories-per-hour figure from a fixture journal.

### Epic 7: Xarabot 0.x is ready for a consuming repo
A consuming repo adds `@xaravel/xarabot` with `bun add`, pins it exactly, and runs lanes on macOS or Linux. Lanes check the consumer prerequisites at start, and Xarabot supports what Xaravel's adoption needs.
**FRs covered:** FR1 (consumer pin, changelog, upgrade as a PR), FR4 (Linux), FR18 (sandbox on Linux)
**Notes:** covers AR34's prerequisite checks and AR45's adoption inputs. The release workflow in `.github/` is a Maintainer step. Ends with a throwaway consumer repo that pins the package and refuses to start on a pin mismatch.

**Epic dependencies** (input for `.xarabot/epics.yaml`): 1 → 2 → 3 → 4; Epics 5 and 6 each depend on 4 and can run in parallel; Epic 7 depends on 5 and 6. No checkpoints in 0.x.

## Epic 1: One sandboxed lane builds Stories unattended

The Maintainer installs a pinned Xarabot runner on the Xarabot host, and one `claude` lane builds Stories with no human watching: `next` picks the Story in code, the agent runs in the sandbox with no GitHub credential or host, and the runner commits as `edanisko-xarabot[bot]`, opens the PR, polls CI, parks a PR for the Maintainer's approval, merges through the queue, sleeps through usage limits, keeps a journal and obeys STOP. This is the self-host threshold (NFR13, NFR14). The bootstrap copy of Xaravel's loop builds these Stories in order; each depends only on earlier ones.

Precondition (Human Live Step, AR32): the bootstrap copy runs under a dedicated macOS user on the Xarabot host that holds only the bot's private key, the Claude credential and its own clone, with no `gh` login, ssh key or GitHub keychain item, and the Maintainer's home is mode 700.

Epic 1 has no Story manifests. At the self-host switch the Maintainer sets `bootstrapped_epics: [1]`, so the gates read Epic 1 as all Stories done and retro done (Story 1.20).

Until Epic 2 adds `reconcile`, a PR parked for approval is approved and added to the merge queue by the Maintainer by hand; the lane then records it `merged` (AR4: any lane may). No lane takes a held record.

### Story 1.1: Package scaffold and test harness

As a Xarabot developer,
I want a Bun package with the spine's layers, lint rules and test harness,
So that every later Story lands in the right layer and is checked the same way locally and in CI.

**Acceptance Criteria:**

**Given** a fresh clone of the repo
**When** `bun install`, `bun test`, `bun --bun oxlint` and `bun --bun tsc` run
**Then** each exits 0
**And** `package.json` names `@xaravel/xarabot` with the MIT license, a `xarabot` bin entry that prints its version, and exact versions of Bun 1.4.3, TypeScript 7.0.2, oxlint 1.89.0 and zod 4.6.7 (AR36)
**And** no Node, npm, pnpm, Jest, Vitest, ESLint or Prettier dependency, lockfile or config exists (NFR1).

**Given** the layer table in AR1
**When** a file imports against it (for example `src/core/` importing `src/ports/`, or one adapter importing another)
**Then** the boundary check (a lint rule or a `bun test` over the import graph) fails
**And** a fixture test proves each forbidden direction is caught.

**Given** a file under `src/core/`
**When** it calls `fetch`, `Bun.spawn`, the filesystem, `Date.now()` or `process.env`
**Then** the check fails (AR2).

**Given** a file under `src/adapters/agent/`
**When** it references `Bun.spawn`
**Then** the check fails (AR18).

**Given** the test harness
**When** `bun test` runs without `XARABOT_LIVE=1` in the environment
**Then** every live case reports skipped, never passed
**And** with `XARABOT_LIVE=1` set, the live cases run, proven by a test (Bun 1.4.3 accepts `bun test --live` silently and never passes it to `Bun.argv`, so the switch is the variable).

**Given** the layer directories of AR37
**When** the Story is done
**Then** `src/core/schemas/`, `src/ports/`, `src/adapters/forge/github/`, `src/adapters/agent/claude/`, `src/sandbox/`, `src/lane/`, `src/cli/` and `test/contracts/` exist
**And** `src/core/` exports the `Result` type `{ ok: true, value } | { ok: false, error: { kind, message } }` (AR35) with a test
**And** `test/contracts/` has a helper that runs one suite against a list of implementations, proven by an example suite.

**Given** that lanes never write `.github/**`
**When** the Story is done
**Then** `docs/maintainer/ci-workflow.yml` holds a proposed workflow that runs the three commands on Bun 1.4.3, for the Maintainer to copy into `.github/workflows/` and make a required check on `main`.

### Story 1.2: Config, policy and Standing Authority, failing closed

As the Maintainer,
I want lanes to read Xarabot's config, policy and Standing Authority only from `main`, and to stop when any of them is missing or invalid,
So that revoking authority or breaking config stops every lane before its next claim (FR22).

**Acceptance Criteria:**

**Given** `src/core/schemas/`
**When** the Story is done
**Then** it holds versioned zod schemas, with inferred types, for `.xarabot/config.yaml` (including `runner_version`, the Maintainer's login, the Standing Authority path, the planning paths with their defaults (`epics_path`, `sprint_status_path`, `retro_gates_path`, `retro_doc_glob`, `epic_context_path`, AR21), `bootstrapped_epics` (a list of Epic numbers, default `[]`), `digest_time` (default `08:00` UTC), the manifest directory and path-key mapping, `story_spec_path` (a glob pattern, default `_bmad-output/implementation-artifacts/spec-<epic>-<story>-*.md`, AR11), both branch namespaces, the unit budget defaulting to 6 hours, the CI max wait defaulting to 60 minutes, repo-added proxy hosts, the lockfile regeneration command and the optional map from Epics to workspace packages), `.xarabot/policy.yaml` (adapters allowed unattended, the expected-checks list, the repo's Protected Paths and the paths that need the owner's approval), `.xarabot/human-live-steps.yaml`, the Standing Authority frontmatter (`schema_version: 1`, `granted_by`, `granted_at`, `repo`, optional `expires`; the body is free prose) and `host.yaml` (AR21, AR22).

**Given** a snapshot of `main` as a tree listing plus file contents
**When** the pure `loadRepoConfig` runs
**Then** it returns the typed package and repo layers, or an error with a `kind`
**And** it never reads the filesystem, the clock or the environment (AR2).

**Given** the case table: config missing, config with invalid YAML, config with an unknown or newer version, policy missing, the Standing Authority file absent at its configured path, Standing Authority frontmatter invalid, `granted_by` not the configured Maintainer login, `repo` not this repo, `expires` before the snapshot's `now`
**When** each case is loaded
**Then** each returns a stop error naming the file and the reason.

**Given** a snapshot with no `.xarabot/epics.yaml`
**When** it is loaded
**Then** loading succeeds; the absence of that one file is not an error (AR21).

**Given** a policy that lists its own Protected Paths
**When** it is loaded
**Then** the effective Protected Paths always also contain `.xarabot/**`, the Standing Authority file, `.github/**` and agent config at any depth (`**/.agents/**`, `**/.claude/**`, `**/.codex/**`, `**/.pi/**`, `**/.mcp.json`, `**/AGENTS.md`, `**/CLAUDE.md`)
**And** a policy can add paths but never remove these.

**Given** a host layer
**When** it sets a value that belongs to the repo layer
**Then** loading refuses it; repo policy comes only from `main`.

**Given** the default `story_spec_path`
**When** it is expanded for the Stories `1.7` and `1.17a`
**Then** it gives `_bmad-output/implementation-artifacts/spec-1-7-*.md` and `_bmad-output/implementation-artifacts/spec-1-17a-*.md`.

### Story 1.3: Story manifests and the `epics.md` grammar

As a lane,
I want every Story manifest and every Epic and Story heading parsed one way,
So that claims, the guard and the graph all see the same Stories and globs (AR11, AR12).

**Acceptance Criteria:**

**Given** a manifest file in the configured directory
**When** it is parsed
**Then** it requires `story_id` matching `^\d+\.\d+[a-z]?$`, `epic`, `sprint_key` and `title`, plus either `globs` or the configured path key
**And** it accepts optional `depends_on`, a list of Story ids each matching that pattern, and `infrastructure: true`, and ignores repo-only fields and `status`
**And** a manifest whose `epic` differs from its `story_id` prefix is an error.

**Given** the glob case table
**When** globs are normalized
**Then** a leading `./` is stripped, and `!`, `..` and absolute paths are rejected
**And** overlap is decided by case-folded literal prefix: `src/a/**` overlaps `src/A/b.ts`, `src/a*` overlaps `src/ab/x.ts`, and `src/a/**` does not overlap `src/ab/**`.

**Given** a manifest that uses the configured path key
**When** the key maps to no paths
**Then** the Story is reported unclaimable with that reason.

**Given** an `epics.md`
**When** it is parsed
**Then** an Epic is a level-2 `## Epic <int>:` heading outside fenced code; level-3 Epic lines under `## Epic List` and any heading inside fenced code are ignored
**And** a Story is a level-3 `### Story <int>.<int>[a-z]?:` heading under its Epic, and its id keeps the letter (`2.6a`)
**And** a Story heading whose Epic number differs from the Epic it sits under is an error
**And** a fixture copy of this repo's own `epics.md` parses to Epics 1–7 and their Stories, the lettered `1.16a`, `1.17a` and `5.1a` included.

**Given** Story ids
**When** they are sorted
**Then** they sort numerically by part, then by suffix: `2.6`, `2.6a`, `2.10`.

### Story 1.4: `resolveGraph` and `xarabot graph check`

As the Maintainer,
I want one validator that builds the effective Epic graph and rejects a bad one,
So that I can check a graph change from an interactive planning session before merging it, and lanes never act on a broken graph (FR2, AR12).

**Acceptance Criteria:**

**Given** `.xarabot/epics.yaml`
**When** it is parsed
**Then** it has `version` and an `epics` map whose keys match `^[1-9][0-9]*$` and become numbers; `depends_on` is a list of positive integers; `checkpoint` accepts only the literal `true`
**And** duplicate Epic keys are found by scanning the raw text, and a multi-document file or a null `epics` is invalid.

**Given** the default rule
**When** an Epic is not listed, or is listed without `depends_on`
**Then** it depends on the next lower Epic number present in `epics.md`, and the lowest depends on none
**And** a repo with no file runs serially, and no checkpoint is ever inferred.

**Given** a configured map from Epics to workspace packages
**When** `package.json` workspace dependencies link two mapped packages
**Then** the matching Epic edge is added; with no map, no package edges are added.

**Given** the `retro-gates.yaml` schema of AR13: `schema_version: 1`; per Epic, a `retro` record (`verdict`, `unit`, `recorded_at`, and for a `rejected` verdict a `go` {`by`, `at`, `ruling`} that is absent until the go), `items` (stock BMAD `id`, `text`, `route`, `blocking`, `globs`, and `status` `open`, `in-progress`, `waiting`, `deferred` or `done`) and a `checkpoint` record holding a checkpoint's `go` {`by`, `at`, `ruling`}, present only once the go is recorded
**When** `retro-gates.yaml` is read
**Then** it validates against that schema
**And** a case-table test reads a rejected retro's go, both from a ruling and as the Maintainer writes it by hand before Story 4.6 (`ruling: maintainer-pr`), since Story 1.6 reads it.

**Given** the validation case table: an invalid file; an entry or `depends_on` naming an Epic with no heading; a cycle; a manifest with no heading or a mismatched `epic`; a manifest `depends_on` naming an unknown Story, or a Story outside its own Epic and the Epics that Epic depends on, transitively; `bootstrapped_epics` naming an Epic with no heading
**When** the pure `resolveGraph(snapshot)` runs on each
**Then** each returns a validation failure naming the problem.

**Given** a valid snapshot
**When** `resolveGraph` runs
**Then** it returns the edges, checkpoints, Epic set, each Epic's Story set (exactly the manifests naming it), the Story headings with no manifest outside the Epics in config's `bootstrapped_epics` (reported, not failures) and a stable hash of the resolved graph.

**Given** a local checkout
**When** `xarabot graph check` runs
**Then** it reads the working tree's `epics.md`, `.xarabot/epics.yaml`, `.xarabot/config.yaml` when present (for `bootstrapped_epics` and the configured paths), manifests and `retro-gates.yaml`, prints the resolved graph, prints headings with no manifest as warnings, and exits non-zero on any validation failure
**And** on a fixture repo with no `.xarabot/epics.yaml` it reports the fixture's Epics in serial order and exits 0
**And** on this repo it reports the graph of its `.xarabot/epics.yaml`: 6 → [4], 7 → [5, 6], and every other Epic depending on the next lower one, and exits 0.

### Story 1.5: Ledger records and pure ledger edits

As a lane,
I want ledger records and every state change defined once as pure edits,
So that each swap re-checks its preconditions against the tip and no transition outside the normative diagram can be written (AR5, AR6, AR8).

**Acceptance Criteria:**

**Given** `src/core/schemas/`
**When** the Story is done
**Then** it holds the unit record schema with every AR6 field and the `coordinator.json` schema
**And** unit ids follow AR35 (`story:<id>`, `retro:<epic>`, `retro-item:<id>`, `checkpoint:<epic>`, `planning:<slug>.<n>`, `reconcile:<n>`), with `:` replaced by `__` in file names.
**And** `park.kind` is `awaiting-approval`, `needs-approval` or `blocked`, and `park.reason` is a `blocked.kind` (`escalation`, `human-live-step`, `intent-gap`, `verification`, `other`) or a runner cause (`review-cap`, `ci-fix-cap`, `ci-timeout`, `write-check`, `no-op`, `attempts-cap`, `unclaimable`, `graph-invalid`); any other value fails validation.

**Given** the state diagram in the spine's Structural Seed
**When** the pure edit functions are tested
**Then** one case per diagram edge produces the expected record
**And** any transition not in the diagram returns an error.

**Given** an edit applied to a tip
**When** its preconditions no longer hold (state, `owner`/`host`/`lane`, `generation`, or a glob overlap with a `claimed`, `merging` or held `parked` record)
**Then** the edit returns a precondition error, not a record.

**Given** any edit
**When** it runs
**Then** `generation` never decreases, `attempts` survives release, and every cap is tested with `>=` (a 3rd failed attempt yields `parked`, blocked).

**Given** a tip holding a record with an unknown or newer `schema_version`
**When** any edit or read runs
**Then** it returns a stop error (AR6).

**Given** the same edit applied twice to the same tip
**When** the records are serialized
**Then** the bytes are identical (stable key order)
**And** the ledger commit message carries `[skip ci]`.

### Story 1.6: `next` for a builder lane

As a builder lane,
I want `next` to return exactly one eligible Story, or `idle` with a reason,
So that unit selection is code with a test for each input instead of prompt prose (FR2, AR14).

**Acceptance Criteria:**

**Given** the `Snapshot` schema with AR28's named fields
**When** `next(snapshot, 'builder')` runs
**Then** it is pure and returns a Story unit, an Infrastructure Story to park as `needs-approval`, `idle` with a reason, or `stop` with a reason.

**Given** Epic D, whose dependencies come from `resolveGraph`
**When** a dependency Epic has a Story not `done` in `sprint-status.yaml` on `main`, has no Stories, or has no retro verdict in `retro-gates.yaml`
**Then** no Story of D is returned, and the idle reason names the Epic that holds it.

**Given** a dependency Epic listed in config's `bootstrapped_epics`
**When** `next` runs
**Then** that Epic counts as all Stories done and retro done, even with no Stories, and its Story headings are not listed as unclaimable.

**Given** an Epic whose context file at `epic_context_path` is missing on `main`, empty, or does not start with `# Epic <N> Context:`
**When** `next` runs
**Then** none of its Stories is returned, and the idle reason names the Epic waiting on its context
**And** an Epic listed in `bootstrapped_epics` is exempt (AR14).

**Given** an Epic E whose retro verdict in `retro-gates.yaml` is `rejected`
**When** `next` runs before the Maintainer's `/xarabot go retro:<N>` for E is recorded
**Then** no Story of any Epic at distance ≥ 1 from E is returned, and the idle reason names E's rejected retro
**And** a verdict of `accepted` or `accepted-with-open-items` holds none of them.

**Given** Story records in each state
**When** `next` runs
**Then** a Story whose record is absent or `released` is eligible unless it is `done` in `sprint-status.yaml` on `main`, and `claimed`, `merging`, `parked` and `merged` are not (stale takeover is Epic 2)
**And** a `done` Story whose `merged` record was deleted is never returned again.

**Given** a Story whose manifest `depends_on` lists a Story that is neither `done` in `sprint-status.yaml` on `main` nor has a `merged` ledger record
**When** `next` runs
**Then** it is not returned, and its reason names the Story it waits on
**And** a listed Story with a `merged` record satisfies `depends_on` before `reconcile` marks it `done`, since either way it is on `main` (AR11).

**Given** an eligible Story whose globs overlap a `claimed`, `merging` or held `parked` record
**When** `next` runs
**Then** it is skipped.

**Given** an Infrastructure Story with no ledger approval matching its current `manifest_sha`
**When** it would be chosen
**Then** `next` returns it to be parked as `needs-approval`.

**Given** Story headings with no manifest outside a `bootstrapped_epics` Epic, or manifests whose globs resolve to nothing
**When** `next` runs
**Then** they are never returned, and they are listed in the result's reasons.

**Given** several eligible Stories
**When** `next` runs
**Then** it returns the lowest Epic number first, then the lowest Story id in AR35 order.

**Given** a snapshot whose graph fails validation
**When** `next` runs
**Then** it returns `stop` with the validation reason.

**Given** the suite
**When** it runs
**Then** each input of `next` and each gate has its own case-table test with no mocks (AR35).

### Story 1.7: `Forge` port, fake forge and contract suite

As a Xarabot developer,
I want the `Forge` port defined once, with a contract suite and an in-memory fake that passes it,
So that lane code is tested without GitHub and every forge adapter behaves the same (FR24, AR1, AR28, AR33).

**Acceptance Criteria:**

**Given** `src/ports/forge.ts`
**When** the Story is done
**Then** it declares `snapshot`, `ledgerSwap`, `pushBranch`, PR open, update, close and list-by-branch, `comment(pr, body)` for 🤖 status comments, `checks`, `enqueue(expectedHead)`, `dequeue`, `alert` and `prefetch`, with no approve operation
**And** errors carry the kinds `conflict`, `not-fast-forward`, `auth`, `forbidden`, `rate-limited` (with `retry_after`), `not-found`, `uninstalled` and `transient`.

**Given** any port operation
**When** it is called
**Then** it takes an `AbortSignal` deadline, and a passed deadline returns `transient` (AR3).

**Given** the in-memory fake forge
**When** the contract suite runs against it
**Then** it passes: a swap from a stale tip returns `conflict`; N concurrent swaps from one tip yield exactly one `ok`; `snapshot()` reads the ledger, then `main`, then PR states, and returns the forge's `now`; `enqueue` with a wrong expected head fails; `comment` posts its body on the named PR; each error kind is observable.

**Given** the compare-and-swap retry loop in `src/lane/`
**When** it meets injected conflicts on the fake
**Then** it re-fetches, re-applies the pure edit, backs off with jitter, and gives up after 10 tries or at the call's deadline (AR7)
**And** a failed precondition on the new tip ends the loop, so the caller runs `next` again.

### Story 1.8: GitHub adapter: tokens, snapshot and ledger swap

As the runner,
I want to talk to GitHub as the owner's bot with short-lived tokens,
So that the ledger lives on `xarabot/claims` and no long-lived token exists (FR13, FR24, AR27, AR39).

Precondition (Human Live Step): the Maintainer has created an org-owned scratch repo with a merge queue on `main` and the owner's App installed, for live contract tests.

**Acceptance Criteria:**

**Given** `$XDG_CONFIG_HOME/xarabot/apps/<login>-xarabot/` (falling back to `~/.config`) holding `private-key.pem` and `app.json`
**When** the adapter starts
**Then** it reads the App ID and key, and refuses if the key's mode is not 600.

**Given** a repo
**When** the adapter needs a token
**Then** it mints an App JWT, exchanges it for a 1-hour installation token for that repo's installation, keeps it in memory only, and refreshes it before expiry
**And** a test proves the token never appears in the environment, argv, a file, a log or the journal.

**Given** an installation that does not cover the repo
**When** a token is requested
**Then** the adapter returns `uninstalled`.

**Given** a repo
**When** `snapshot()` runs
**Then** it reads the `xarabot/claims` tip and records, then the `main` SHA, then the PR state of every ledger unit, and takes `now` from the GitHub response's `Date` header
**And** a missing `xarabot/claims` branch is created from an empty root commit, returning `conflict` if another lane created it first.

**Given** a ledger edit
**When** `ledgerSwap(oldSha, edit)` runs
**Then** it writes blobs, tree and commit through the git data API and moves the ref with `PATCH git/refs` and `force: false`
**And** the live test records which status (409 or 422) GitHub returns for a non-fast-forward swap, and the adapter maps exactly that status to `conflict` (AR39).

**Given** HTTP failures
**When** they are mapped
**Then** 401 is `auth`; 403 with an exhausted or secondary rate limit is `rate-limited` with `retry_after`; any other 403 is `forbidden`; 404 is `not-found`; 5xx and network failures are `transient`.

**Given** the forge contract suite
**When** it runs live against the scratch repo
**Then** the ledger and snapshot cases pass
**And** without live credentials the live cases are reported as skipped, never as passed.

### Story 1.9: GitHub adapter: pushes and PRs

As the runner,
I want to push unit branches from the runner's own repository and manage PRs as the bot without the token leaving memory,
So that only the runner talks to GitHub, and a lane that lost its claim cannot push over another (NFR8, AR7, AR16, AR19).

**Acceptance Criteria:**

**Given** a lane state folder
**When** the lane first runs
**Then** it creates `runner.git` there, and every runner git command runs against it with AR19's settings (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `core.hooksPath=/dev/null`, no fsmonitor, filters, external diff, textconv or signing program, `GIT_NO_REPLACE_OBJECTS=1`, `protocol.file.allow=never`, no submodule recursion).

**Given** the runner's git
**When** it pushes from `runner.git`
**Then** the token reaches git only through a credential helper over stdin, scoped to the forge URL, after `credential.helper=` is reset
**And** a test proves the token is absent from the environment, argv (as `ps` sees it), files and logs.

**Given** `pushBranch(lease)` with the record's `head_sha`
**When** the remote branch head differs
**Then** the push, made with `--force-with-lease` against that SHA, returns `conflict`.

**Given** a unit branch
**When** PRs are opened, updated, closed or listed
**Then** listing returns every PR on the branch in any state (merged, open, closed), for AR10's claim-time inspection.

**Given** `prefetch(kind)` for a CI log
**When** it runs
**Then** the failing checks' logs are written into the given temp folder for a later sandboxed session.

**Given** `comment(pr, body)`
**When** it runs
**Then** it posts the body as one comment on the PR, as the bot.

**Given** the forge contract suite
**When** it runs on the fake and live
**Then** the push, PR and comment cases pass.

### Story 1.10: GitHub adapter: checks, merge queue and alerts

As the runner,
I want to read checks, use the merge queue and raise urgent alerts through the `Forge` port,
So that merges never bypass required checks, and a condition that stops every lane reaches the Maintainer at once (FR6, FR9, FR13, AR24, AR38).

Precondition (Human Live Step): the owner's App has `issues: write`, and the scratch repo has a merge queue on `main` with a required check, for the live checks, queue and alert tests.

**Acceptance Criteria:**

**Given** a PR head SHA
**When** `checks` runs
**Then** it returns every check run and status for that SHA, and an empty set means pending.

**Given** a PR
**When** `enqueue(expectedHead)` runs
**Then** it calls `enqueuePullRequest` with `expectedHeadOid`, and `dequeue` removes the PR from the queue
**And** the adapter has no code path for an admin merge, GitHub auto-merge or `--delete-branch`.

**Given** AR38's finding (AD-26)
**When** the adapter names the permission for `enqueuePullRequest` and `dequeuePullRequest`
**Then** it names `contents: write`, and `docs/maintainer/app-permissions.md` records the live result, with no merge-queue row
**And** a missing permission maps to `forbidden` with a message naming it.

**Given** the live AR38 probe
**When** it runs against the scratch repo
**Then** it sets its own timeout, longer than Bun's 5-second default, and closes its scratch PR even when it fails
**And** it counts `ok` or `conflict` as proof that the permission suffices, since its `[skip ci]` commits never satisfy a required check.

**Given** a condition that newly stops every lane
**When** `alert(condition, mainSha)` runs
**Then** one comment @mentioning the Maintainer is posted on the Maintainer's `xarabot-inbox` issue, which is created and assigned if missing
**And** a second alert for the same (condition, `main` SHA) posts nothing
**And** alerting works while the lane is failing closed.

**Given** the forge contract suite
**When** it runs on the fake and live
**Then** the checks, queue and alert cases pass.

### Story 1.11: macOS sandbox: profile, launcher and vendor home

As the Maintainer,
I want every agent process launched only inside Xarabot's sandbox,
So that no agent reaches a GitHub credential, another lane's secrets or the runner's own repository (FR18, NFR8, AR18).

**Acceptance Criteria:**

**Given** `src/ports/sandbox.ts`
**When** the Story is done
**Then** `run(LaunchSpec, profile)` returns the exit status, PID and timings, and `src/sandbox/` is the only code that spawns agent processes.

**Given** a generated `sandbox-exec` profile
**When** a probe process runs inside it
**Then** reads succeed only in system paths, the resolved real paths of the agent CLI, `bun`, `uv`, `git` and the uv-managed Python install (computed at session start), the lane clone, the lane's vendor home and its temp folder
**And** reads of `~/.xarabot/**`, `$XDG_CONFIG_HOME/xarabot`, `~/.config/gh`, `~/.ssh`, `~/Library/Keychains`, `~/.git-credentials`, `~/.netrc`, `~/.claude`, `~/.codex` and `~/.pi` fail, with one test per path
**And** writes succeed only in the clone (`.git` included), the vendor home and the temp folder; the `runner.git` path from the Structural Seed layout (an empty directory at that path in the test) can be neither read nor written; Unix sockets are denied.

**Given** a launching environment that holds `GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK` and other variables
**When** the session starts
**Then** only `PATH` (rebuilt from allowed directories), `HOME`, `TMPDIR`, `LANG`, `LC_*`, `TERM`, the vendor credential variable, the variable that points the CLI at its vendor home, the variable that points the CLI at its temp folder, always set inside the session's temp folder (`claude`: `CLAUDE_CODE_TMPDIR`) (added by Story 1.14), `XARABOT_RESULT`, `XARABOT_SANDBOXED`, the proxy variables and `UV_CACHE_DIR` (in the temp folder) pass through, and the git credential helper is reset
**And** `HOME` is a fresh directory inside the temp folder, and `XARABOT_SANDBOXED` is `1`.

**Given** a lane vendor home and the operator's mode-600 credential file for that vendor under `$XDG_CONFIG_HOME/xarabot/vendors/<vendor>/` (falling back to `~/.config`)
**When** a session starts
**Then** the lane process reads that file and re-seeds the vendor home, or sets the credential variable, to hold only that vendor's credential
**And** the session itself cannot read the file (the `$XDG_CONFIG_HOME/xarabot` read test covers it)
**And** a missing or unreadable credential file refuses the session, with an error naming the file.

**Given** a clone that is a linked worktree (its `.git` is a file)
**When** a session is requested
**Then** it is refused.

**Given** `sandbox-exec` missing, or a profile that fails to generate
**When** a session is requested
**Then** it is refused with an error; the sandbox never falls back to running unsandboxed.

**Given** a host that is not macOS
**When** the sandbox suite runs
**Then** its cases are reported as skipped, never as passed.

**Given** the sandbox suite running inside the Xarabot sandbox (`XARABOT_SANDBOXED=1`)
**When** it reaches a case that needs a nested sandbox
**Then** the case is reported as skipped, never as passed, and the Maintainer runs it live on the host (Story 1.20's runbook).

### Story 1.12: Sandbox network proxy

As the Maintainer,
I want an agent's network limited to an allowlist that never includes GitHub,
So that a session can reach its vendor's API and Python packages but cannot reach GitHub by any route (FR18, NFR8, AR18, AR40).

**Acceptance Criteria:**

**Given** a session
**When** it starts
**Then** the sandbox starts Xarabot's Bun proxy, and the profile allows outbound connections only to it.

**Given** the proxy
**When** it receives HTTPS `CONNECT` requests
**Then** it allows only the vendor API hosts it takes as input (Story 1.14 supplies `claude`'s; the tests pass a fixture list), `pypi.org`, `files.pythonhosted.org` and the hosts repo config adds, and denies everything else.

**Given** repo config that adds a GitHub host (`github.com`, `api.github.com`, `*.githubusercontent.com` or any other GitHub domain)
**When** config is loaded
**Then** it is rejected; a GitHub host is never allowed.

**Given** the AR40 spike
**When** the Story starts
**Then** it first proves that the allowlist binds: a direct connection that bypasses the proxy fails, and a raw-IP connection to a GitHub address fails
**And** if the spike shows the allowlist cannot be enforced, the Story stops and raises it to the Maintainer instead of weakening the rule.

**Given** a sandboxed session
**When** it runs `uv run --no-cache` with Python 3.11+ and `ruamel.yaml`
**Then** it succeeds, as stock skills need.

**Given** the proxy tests
**When** they run
**Then** an allowed host connects, and each denied class (GitHub by name, GitHub by IP, an unlisted host) fails.

**Given** the proxy tests running inside the Xarabot sandbox (`XARABOT_SANDBOXED=1`)
**When** a case needs a nested sandbox
**Then** it is reported as skipped, never as passed, and the Maintainer runs it live on the host (Story 1.20's runbook).

### Story 1.13: Result schemas and prompt assembly

As a lane,
I want every session's prompt built by one pure function and every result validated against one schema,
So that prompts carry no selection, CI, merge or status instructions, and sessions cannot return shapes of their own (FR2, FR6, NFR4, AR15, AR30).

**Acceptance Criteria:**

**Given** `src/core/schemas/`
**When** the Story is done
**Then** it holds the result union keyed by `kind`: `build`, `review`, `retro` and `planning`, with AR15's fields, each also carrying `denied_actions[]`.
**And** the enumerated fields accept only these values: `build.outcome` `done`, `blocked`, `no-op`; `blocked.kind` `escalation`, `human-live-step`, `intent-gap`, `verification`, `other`; `review.verdict` `pass`, `changes-requested`; `findings[].severity` `high`, `medium`, `low`, with `blocking` a separate boolean; `retro.verdict` `accepted`, `accepted-with-open-items`, `rejected`; item `route` `lane`, `maintainer`; `planning.outcome` `done`, `nothing-due`, `blocked`.

**Given** the package template, the repo's `.xarabot/prompts/` sections, the unit id, the Human Live Steps list and the result path, all from a `main` snapshot
**When** the pure `core/prompt` runs for a `story` first build
**Then** the prompt names the unit by its Story id and `sprint_key` ("Build Story 1.7 (`1-7-forge-port-fake-forge-and-contract-suite`)"), so build-auto's spec slug leads with the id and its spec file matches `story_spec_path` (AR11), and runs stock `bmad-build-auto` for it
**And** its last step writes the result to `$XARABOT_RESULT` in the `build` schema.

**Given** a `story` loopback or CI fix
**When** the prompt is built
**Then** it runs no skill and tells the session to apply the prefetched findings or CI log in its temp folder.

**Given** every unit kind the function builds
**When** the prompt test runs
**Then** it asserts the prompt contains no selection, CI, merge or status instruction.

**Given** the package
**When** any prompt is built
**Then** nothing reads or writes `_bmad/custom/` (NFR4).

### Story 1.14: The `claude` adapter

As an operator,
I want a lane to run `claude` through the `Agent` port inside the sandbox,
So that a Story is built by Claude Code with the lane's model and effort and returns a valid result (FR7, AR15, AR18, AR22, AR30).

**Acceptance Criteria:**

**Given** `src/ports/agent.ts`
**When** the Story is done
**Then** it declares `launchSpec(unit, settings, resultPath)`, `parseUsage(output)` and `effortValues(model)`.

**Given** AR42's `claude` half
**When** the Story starts
**Then** it first records, in the adapter and its tests, how `bmad-build-auto`'s outcomes map onto the `build` result (a `ready-for-dev` halt; it never yields `no-op`), how a session is resumed, and which `--output-format` yields the session id, tokens, model and reset time that `parseUsage` needs
**And** the `story` prompt's result step (Story 1.13) follows that outcome mapping, with a test.

**Given** lane settings
**When** `launchSpec` runs
**Then** it returns `claude -p --model <model> --effort <effort> --permission-mode auto` with the `--output-format` the spike chose, the attribution-off setting (`--settings {"attribution": false}`), claude's own sandbox turned off (AR18), `CLAUDE_CONFIG_DIR` set to the lane's vendor home, `CLAUDE_CODE_OAUTH_TOKEN` on macOS (the token from `claude setup-token`, read from the operator's credential file under `$XDG_CONFIG_HOME/xarabot/vendors/claude/`, AR18), `XARABOT_RESULT`, and the clone as working directory
**And** an unset `model` is `claude-opus-5-5` and an unset `effort` is `high`
**And** the adapter supplies `claude`'s vendor API hosts to the proxy (Story 1.12)
**And** the Story confirms the name and form of `claude`'s credential file under `$XDG_CONFIG_HOME/xarabot/vendors/claude/` and records it for Story 1.20's runbook.

**Given** a `claude` session launched through the sandbox
**When** it starts
**Then** the sandbox sets `CLAUDE_CODE_TMPDIR` to a folder inside the session's temp folder and passes it through (AR18, AD-17), since Claude Code otherwise writes to `/tmp/claude-<uid>`, which the profile denies
**And** a sandbox case starts a real sandboxed `claude -p` with no `EPERM`, skipped off macOS or under `XARABOT_SANDBOXED=1`.

**Given** a model
**When** `effortValues` runs
**Then** it returns the efforts that model offers, and the adapter's start check refuses a lane `effort` not among them, with no silent drop or rounding.

**Given** CLI output
**When** `parseUsage` runs
**Then** it returns the session id, tokens, cost (labelled an estimate on a subscription), the reported model, and a usage-limit hit with its reset time when present
**And** a reported model that differs from the configured one fails the attempt.

**Given** a session that ends with no result file
**When** the adapter handles it
**Then** it resumes once, as the spike recorded (`claude -p --resume <session>`), with a prompt that asks only for the result.

**Given** an installed `claude` older than 2.1.304
**When** the adapter's start check runs
**Then** it refuses.

**Given** the `Agent` contract suite
**When** it runs with a stub CLI
**Then** the adapter passes
**And** a live smoke test runs only when credentials are present, and is reported as skipped otherwise.

### Story 1.15: `runner.git`: clone rebuild, bot commit and sanitizer

As the Maintainer,
I want the runner to rebuild the agent's clone from its own `runner.git` (Story 1.9) and make every commit itself as the bot,
So that nothing an agent plants in git runs as the runner, and no co-author trailer, closing keyword or @mention reaches GitHub (FR13, NFR10, AR10, AR16, AR19).

**Acceptance Criteria:**

**Given** the lane's `runner.git` with AR19's settings (Story 1.9)
**When** the runner rebuilds the clone, diffs and commits
**Then** every git command runs against `runner.git` with those settings, never against the clone's `.git`.

**Given** an agent clone with planted hooks, fsmonitor, filters and `includeIf` config
**When** the runner rebuilds, diffs and commits
**Then** none of them runs.

**Given** a session about to start
**When** the clone is rebuilt from `runner.git`, `.git` included
**Then** a first build starts at `base_sha` on the unit's branch, and a loopback or CI fix starts at `head_sha`.

**Given** a finished session
**When** the runner commits
**Then** it reads only the clone's working tree, computes the change against `base_sha` from git objects in `runner.git`, and applies it on `origin/main` as a three-way merge (a conflict is returned, not resolved)
**And** it makes one commit authored and committed by `<login>-xarabot[bot]`, recording `base_sha` and `head_sha`.

**Given** any reset of the clone
**When** it is about to happen
**Then** the working tree is first saved as `wip/<unit>` in `runner.git`
**And** wip is never pushed, and a restarted lane resumes it only while it holds the claim at the same generation.

**Given** the sanitizer's case table
**When** agent `summary` and `body` text passes through it
**Then** git trailers (including `Co-Authored-By` and `Signed-off-by`), closing keywords with issue references (`closes #12`, `fixes <url>`) and `@mentions` are stripped, and other text is unchanged.

### Story 1.16: The lane process: one unit from claim to result

As an operator,
I want one lane process to take one unit from claim to a validated result,
So that a Story is built unattended in the sandbox and leaves a journal record and a ledger state that says what happened (FR3, FR6, FR11, FR22, AR3, AR8, AR10, AR15, AR25).

**Acceptance Criteria:**

**Given** a lane start
**When** a host or lane `STOP` marker exists
**Then** the process exits without running `next` or claiming.

**Given** a lane start
**When** the process runs
**Then** it writes `lane.pid`, takes a snapshot (ledger, then `main`, then PRs), re-checks the Standing Authority and config from fresh `main`, runs `next`, and claims the unit with the compare-and-swap retry loop
**And** an `idle` result records an idle span in `journal.jsonl` with its reason, and the process exits with outcome `idle`.

**Given** a claimed unit
**When** its branch is inspected
**Then** a merged PR writes `merged`, an open PR is adopted with `head_sha` set to its head, and a closed PR or none starts from `origin/main` (AR10).

**Given** a session run through the `Agent` and `Sandbox` ports
**When** its result is missing after the one resume, or invalid
**Then** the record becomes `released` with `attempts` + 1, or `parked` (blocked) once `attempts` ≥ 3.

**Given** a `build` result
**When** the runner validates it
**Then** it finds the Story's spec file as the single file in the clone's working tree matching `story_spec_path` (AR11), and cross-checks the result's `outcome` against that file's `status` and `## Auto Run Result` (AR15)
**And** zero or several matches, or a mismatch, count as an invalid result.

**Given** a valid `done` build result
**When** the runner handles it
**Then** it passes the unit to the PR step (Story 1.16a).

**Given** a `blocked` or `no-op` result
**When** the runner handles it
**Then** the record becomes `parked` with its globs released and `park.kind` and `park.reason` set (AR8).

**Given** a ledger record with an unknown `schema_version`, or a forge `auth`, `forbidden` or `uninstalled` error
**When** the lane meets it
**Then** the lane stops and posts an alert (AR6, AR33).

**Given** a unit over its wall-clock budget (default 6 hours)
**When** the budget passes
**Then** the record is released as a failed attempt.

**Given** any unit
**When** it ends
**Then** `journal.jsonl` gets one record with the AR25 facts (agent, model, effort, tokens and cost from the adapter, timings, `outcome`, `loopbacks`, `ci_fixes`), the log is at `logs/<unit-file-id>-<start>.log`, and `outcome`, in the journal record and the `outcome` file, holds `progress`, `idle`, `failed` (a crashed session, a missing or invalid result, or a budget overrun) or `stop`.

**Given** the lane tests
**When** they run against the fake forge and a stub agent
**Then** each outcome above has a case.

### Story 1.16a: Opening the PR

As an operator,
I want the lane to turn a `done` build result into a bot-authored PR in code,
So that only the runner commits, pushes and writes forge text, and a revoked Standing Authority stops the push (FR6, FR13, FR22, NFR10, AR7, AR16, AR21, AR44).

**Acceptance Criteria:**

**Given** a `done` build result that passed validation (Story 1.16)
**When** the runner handles it
**Then** it commits (Story 1.15), re-checks the Standing Authority from freshly fetched `main`, pushes with a lease, opens the PR with the sanitized summary and body, records `pr` and `head_sha`, and posts a status comment starting with 🤖 through `Forge.comment` (Story 1.9).

**Given** a Standing Authority that is absent or invalid on fresh `main`
**When** the lane is about to push
**Then** it stops before the push, with no push and no PR (AR21).

**Given** a result whose `denied_actions[]` is not empty
**When** the runner handles it
**Then** each action is recorded in the unit's journal record and listed in the PR's 🤖 status comment (AR44).

**Given** the lane tests
**When** they run against the fake forge and a stub agent
**Then** the commit, the push with its lease, the PR, the status comment, the Standing Authority re-check and the denied-actions listing each have a case.

### Story 1.17: CI polling, CI fixes and conflicts

As an operator,
I want the lane to take its open PR through CI, CI fixes and conflicts in code,
So that the agent never polls CI, and Xaravel's CI and conflict lessons hold (FR6, AR8, AR20, AR44).

**Acceptance Criteria:**

**Given** an open unit PR
**When** the lane polls checks
**Then** it polls every 30 seconds, backing off to 5 minutes, treats an empty reply as pending, and stops at the first failure not on `policy.yaml`'s expected-checks list
**And** past the CI max wait (default 60 minutes) the record becomes `parked`, blocked.

**Given** a PR that conflicts with `main`
**When** the lane handles it
**Then** it merges `origin/main` into the PR in `runner.git` before polling
**And** conflicts in `sprint-status.yaml` and `retro-gates.yaml` keep `main`'s lines and re-apply the PR's own entries
**And** a lockfile conflict is regenerated with the configured command inside the sandbox, with no token
**And** any other conflict goes to a builder session that counts as a CI fix (`ci_fixes` + 1), never as an attempt or a loopback.

**Given** an unexpected CI failure
**When** the lane handles it
**Then** it prefetches the CI log, runs a CI-fix session at `head_sha` and records `ci_fixes` + 1
**And** once `ci_fixes` ≥ 2 and CI still fails, or another conflict needs a session, the unit parks blocked (`ci-fix-cap`).

**Given** the suite
**When** it runs
**Then** each poll reply, conflict kind and CI-fix outcome has a case against the fake forge.

### Story 1.17a: Approval gate and merge queue

As an operator,
I want the lane to park a PR that needs approval and take every other passing PR through the merge queue in code,
So that the agent never merges, nothing merges past the approval gate or required checks, and a revoked Standing Authority stops every enqueue and merge (FR6, FR13, FR22, AR7, AR8, AR20, AR21).

**Acceptance Criteria:**

**Given** a PR whose diff touches a path the policy says needs its owner's approval
**When** its checks pass
**Then** the record becomes `parked`, holding only the paths its diff changes, and the lane moves on
**And** while Epic 2's `reconcile` does not exist, the Maintainer approves and queues the PR by hand, and a lane that later sees it merged writes `merged`.

**Given** a PR that needs no approval and whose checks pass
**When** the lane enqueues it
**Then** it first re-checks the Standing Authority from fresh `main`, then writes `merging` with a swap that requires its own `owner`/`host`/`lane` and `generation`, then calls `enqueue` with the expected head
**And** a failed swap abandons the unit.

**Given** a Standing Authority that is absent or invalid on fresh `main`
**When** the lane is about to enqueue or merge
**Then** it stops before the call, with no enqueue or merge (AR21).

**Given** a queued PR
**When** the queue ejects it
**Then** the lane merges `main`, polls again, re-checks the Standing Authority and re-enqueues, counting toward `attempts`
**And** every move out of `merging` other than to `merged` dequeues first.

**Given** a merged PR
**When** the lane sees it
**Then** the record becomes `merged`, and the journal records the unit.

**Given** the suite
**When** it runs
**Then** the approval gate, each queue outcome, the ejection and the Standing Authority re-check have a case against the fake forge.

### Story 1.18: Waits, STOP, `wake`, `stop --now` and usage limits

As an operator,
I want every wait to be a sleep I can wake or kill, and every stop to act by exact PID,
So that a lane stops deterministically and never kills the wrong process (FR15, AR3, AR23, AR44).

**Acceptance Criteria:**

**Given** a finished unit
**When** the process waits
**Then** it runs a child `sleep` with its PID in `wait.pid`, for 1 minute after progress, 30 after idle or 15 after a failure (`outcome` `failed`, Story 1.16), then exits.

**Given** `xarabot wake <lane>`
**When** it runs
**Then** it kills exactly the PID in `wait.pid` after checking that the process is that `sleep` (command and start time), and does nothing otherwise.

**Given** `xarabot stop <lane>` or a host-wide stop
**When** it runs
**Then** it writes the lane's `STOP`, or `~/.xarabot/STOP`
**And** the affected lanes finish their current unit and exit with no new claim.

**Given** `xarabot stop --now <lane>`
**When** it runs
**Then** it writes the lane's `STOP` first, then kills by recorded PID in the order `lane.pid`, `agent.pid`, `wait.pid` after checking each PID's start time and command
**And** it releases the unit without counting an attempt (AR8).

**Given** an agent session
**When** it runs past 3 hours, or is still alive 5 minutes after its result file appears
**Then** it is killed by its exact PID.

**Given** a usage-limit hit
**When** the lane sleeps
**Then** it sleeps until the reset plus 2 minutes, or 15 minutes if the reset can't be parsed, never more than 8 hours
**And** the sleep can be woken, a `STOP` ends it and releases the unit without an attempt, and the unit budget still applies.
**And** `journal.jsonl` gets one `usage-limit` span from the start of the sleep to its end (AR25).

**Given** the source tree
**When** the suite runs
**Then** a test proves no code calls `pkill` or a `timeout` binary.

### Story 1.19: `xarabot lane install` and the pinned runner

As the Maintainer,
I want to install a lane that runs only the runner version pinned on `main`,
So that a bad Story can never break the runner that would build its fix, and recovery is pinning back (FR1, NFR15, AR22, AR26, AR34).

**Acceptance Criteria:**

**Given** `xarabot lane install` with a repo, role, owner, agent, model and effort
**When** it runs
**Then** it writes the lane to `host.yaml`, generating the host UUID once, and creates the lane state folder under `~/.xarabot/repos/<owner>__<name>/lanes/<lane>/`.

**Given** `runner_version` in `.xarabot/config.yaml` on the repo's freshly fetched `origin/main`
**When** the lane is installed
**Then** that version is installed at `~/.xarabot/runner/<version>/` (from the `xaravel/xarabot` git tag until npm releases exist) and named in the lane's `runner` file in its state folder
**And** the lane runs only from that path, never from a lane clone or the branch it builds.

**Given** a lane
**When** it is installed
**Then** `xarabot lane install` writes the fixed launcher `~/.xarabot/bin/xarabot-lane <repo> <lane>` and a launchd plist, with a restart throttle, that runs it, checked against a golden file
**And** the launcher runs the version named in the lane's `runner` file, and `XARABOT_SANDBOXED` is set only in agent sessions, never in the launcher or the runner
**And** a lane that fails to start 3 times in a row writes its own `STOP` and posts an alert.

**Given** the refusal case table
**When** a lane starts
**Then** it refuses if its agent is not allowed unattended by policy, its adapter's start check fails (an effort not in `effortValues` for its model, or a CLI below the minimum tested version), its vendor's credential file under `$XDG_CONFIG_HOME/xarabot/vendors/<vendor>/` is missing or unreadable (AR18), the App installation does not cover the repo, or the host would run more builders than `XARABOT_MAX_BUILDERS` across all repos.

**Given** a lane that sees a different `runner_version` on `main`
**When** it starts
**Then** it installs that version at `~/.xarabot/runner/<version>/`, rewrites its `runner` file and exits without claiming, and the next start runs that version; nothing re-execs mid-unit
**And** pinning back to the previous version restores the previous runner the same way.

### Story 1.20: Canary and self-host runbook

As the Maintainer,
I want an end-to-end canary and a runbook,
So that I can switch from the bootstrap loop to Xarabot's own pinned runner with evidence that it works (NFR13, NFR14).

**Acceptance Criteria:**

**Given** the scratch repo and live credentials
**When** the canary suite in `test/e2e/` runs
**Then** a real lane, run as an in-process `laneRun` as `builder-1` with a stub agent CLI inside the real sandbox, claims a Story, commits as the bot, opens the PR, passes CI, enqueues and records `merged`
**And** the commit is authored by `<login>-xarabot[bot]` with no trailers.
**And** `docs/maintainer/self-host.md` holds the canary's live command (`XARABOT_LIVE=1 bun test <suite>`) and expected result, which the Maintainer runs on the Xarabot host, outside the sandbox, before Epic 1's retro; inside a sandboxed session the live cases report skipped.

**Given** the canary
**When** a `STOP` is written during the lane's trailing wait
**Then** the sleep ends and the lane exits with no new claim.

**Given** a stub agent that reports a usage-limit hit with a near reset time
**When** the lane handles it
**Then** it sleeps until the reset plus 2 minutes, then continues.

**Given** this repo
**When** `xarabot graph check` runs
**Then** it exits 0.

**Given** `docs/maintainer/self-host.md`
**When** the Story is done
**Then** it lists every Maintainer step for the switch, each with the command or file content to apply: the CI workflow as a required check; the `xarabot/claims` ruleset; the merge queue on `main`; squash messages set to PR title + body; the App permissions (`issues: write` is a Story 1.10 precondition; AR38 found no merge-queue permission is needed); storing the Claude credential, the token from `claude setup-token`, in its mode-600 file under `$XDG_CONFIG_HOME/xarabot/vendors/claude/` on the Xarabot host, in the form Story 1.14 recorded (AR18); this repo's `.xarabot/config.yaml` with `runner_version` and `bootstrapped_epics: [1]`; a `policy.yaml` that makes every path need the Maintainer's approval and allows only `claude` unattended; the Standing Authority file; the Maintainer's bootstrap writes, each in a Maintainer PR (AR4): running `bmad-sprint-planning` once so that `sprint-status.yaml` has Epic 1's Stories `done`, whether the run creates the file or updates it, Epic 2's Story manifests, with `depends_on` where a Story builds on an earlier one, and Epic 2's context file at `epic_context_path`, compiled by following the installed stock `bmad-build-auto` skill's `compile-epic-context.md` with the Epic number, the epics path, the planning artifacts directory and the output path, and checked to be non-empty and to start with `# Epic 2 Context:`; running Epic 1's retro interactively; `XARABOT_MAX_BUILDERS=1`; `xarabot lane install`; and stopping the bootstrap loop
**And** it lists the Maintainer's steps while Epic 2 is built: a lane runs only the pinned `runner_version` (Story 1.19), so after a Story whose code the lanes need has merged, the Maintainer tags that `main` commit in `xaravel/xarabot` and advances `runner_version` to the tag in a Maintainer PR, added to the merge queue by hand, and each lane installs it at its next start; the coordinator lane is installed only once `runner_version` includes Stories 2.4 and 2.5; until Story 2.8 merges, the Maintainer runs `xarabot graph check` on each graph PR before approving it; and until Story 4.6 merges, the Maintainer records a rejected retro's go by hand in `retro-gates.yaml` (`ruling: maintainer-pr`, AR13), in a Maintainer PR
**And** it lists the live commands and expected results of the sandbox suites' nested cases (Stories 1.11 and 1.12), for the Maintainer to run on the host.

## Epic 2: A coordinator lane and claims let builders run side by side

Xarabot runs its own coordinator, under a coordinator claim: `reconcile`, planning, retro and retro-item units. Builder lanes share a host, or several hosts, without building a unit twice or colliding on globs, and no builder can write coordinator-owned files, manifests, agent config or policy. Graph planning units change the effective graph, so the graph-change gate lands here too. The builder limit stays at 1 until Epic 3 merges; Story 2.12 writes the race proof that the Maintainer runs on the scratch repo before Epic 2's retro.

Until Story 4.6 adds `/xarabot go retro:<N>`, a `rejected` retro of Epic 2 or Epic 3 holds its dependents until the Maintainer records the go by hand in `retro-gates.yaml`, in a Maintainer PR (AD-3).

Stories 2.5a, 2.5b, 2.5c, 2.6a and 2.6b were added by the Maintainer's correct course of 2026-10-24 (`sprint-change-proposal-2026-10-24.md`), as AD-3's bootstrap write 4. Epic 2 runs strictly in order: 2.5 → 2.5a → 2.5b → 2.5c → 2.6 → 2.6a → 2.6b → 2.7.

**Accepted deviations (Epic 2 retro A6, A7; Maintainer, 2026-10-25; `sprint-change-proposal-2026-10-25.md`).**
- 2.1: a lane releases its unit about 2 minutes before the 30-minute lapse.
- 2.4: the status planning unit holds every Epic's context file (`epic-*-context.md`), not one Epic's.
- 2.5: `reconcile` adds every missing graph key while any merged graph record is not done.
- 2.5b: the lane-stop count also covers config, policy and graph failures.
- 2.5b: `xarabot rule` writes as the coordinator lane for non-Story units.
- 2.6b: the first push leases against `branchHead` read at that push, not at the lease.
- 2.7: the ledger `schema_version` reached 4 by the end of the Epic (2.8 and 2.9 each bumped it), not 2.
- 2.9: the PR prefetch covers Story-branch PRs only.
- 2.11: `XARABOT_MAX_BUILDERS` counts builder lanes installed in `host.yaml`, not running ones; a commit conflict's session runs at the CI step, after the PR opens.
- 2.12: the 30-minute case also needs `XARABOT_LIVE_LONG=1`.
- 2.8: the gate runs at the builder merge step, the graph planning step and `reconcile`'s take (spine AD-11).

### Story 2.1: Heartbeat and fencing

As an operator,
I want a lane to keep its claim alive and to prove it still holds the claim before every outward action,
So that a lane that went quiet can never push or merge over the lane that took its unit over (FR3, AR7, AR33).

**Acceptance Criteria:**

**Given** a lane holding a `claimed` record, or a builder lane holding a `merging` record
**When** its unit runs, including during the agent session and the trailing wait
**Then** it swaps `heartbeat_at` every 5 minutes.

**Given** a lane about to push, change a PR, enqueue or merge
**When** it acts
**Then** it first makes a heartbeat swap that requires its own `owner`/`host`/`lane` and `generation`
**And** if that swap fails, the lane abandons the unit: it kills its agent session by PID, pushes nothing and exits.

**Given** `rate-limited` or `transient` forge errors during a heartbeat
**When** the back-off would let the heartbeat lapse past 30 minutes
**Then** the lane releases the unit instead (AR33).

**Given** the lane tests against the fake forge
**When** another lane takes the record at `generation` + 1 between two heartbeats
**Then** the first lane's next fence fails, and no push, PR change or enqueue from it reaches the fake.

### Story 2.2: Stale takeover

As an operator,
I want a unit whose lane died to become claimable again 30 minutes after its last heartbeat,
So that a killed lane never holds its unit or its globs forever (FR3, AR7, AR10).

**Acceptance Criteria:**

**Given** a `claimed` record whose `heartbeat_at` is 30 minutes or more before the forge's `now`
**When** `next` runs for a builder
**Then** the Story is eligible, and claiming it sets `generation` + 1 and `attempts` + 1
**And** on the 3rd such takeover the record becomes `parked`, blocked, instead.

**Given** a stale `merging` record that a builder lane holds
**When** a lane meets it
**Then** a merged PR makes it `merged`; a PR still in the queue lets that lane take it over and keep watching it; otherwise it becomes `released` with `attempts` + 1 and `pr` kept.

**Given** a taken-over unit with an open PR
**When** the new holder claims it
**Then** it adopts the PR with `head_sha` set to the PR's head, fetching the head into its own `runner.git` before acting (AR16).

**Given** `parked` records
**When** any amount of time passes
**Then** they never expire.

**Given** the case tables
**When** they run
**Then** each staleness boundary (29:59, 30:00), each `merging` outcome and the 3rd-takeover cap has a case, with time taken only from the snapshot's `now`.

### Story 2.3: The 0.x write check

As the Maintainer,
I want the runner to refuse any agent diff that writes outside what its unit may touch,
So that builders cannot write coordinator-owned files, manifests, agent config or policy, or widen their own authority, before v1's diff check exists (FR18, NFR20, AR31).

**Acceptance Criteria:**

**Given** a builder session's change, computed by the runner from git objects in `runner.git` (AR19)
**When** it touches `sprint-status.yaml`, `retro-gates.yaml`, `epics.md`, a manifest, `.xarabot/**`, the Standing Authority file, `.github/**`, agent config at any depth or the repo's Protected Paths
**Then** the squash is refused, the unit becomes `parked`, blocked (`park.reason: write-check`), and the refusal is logged with the path and reason.

**Given** the three exceptions
**When** a builder diff touches the unit's own BMAD Story spec file (its spec file under `story_spec_path`, by default `_bmad-output/implementation-artifacts/spec-<epic>-<story>-*.md`, after superseded matches are dropped, AR11), the `status:` line of its own Story file, or the repo's Protected Paths for an Infrastructure Story with a matching approval
**Then** it is allowed
**And** the Infrastructure exception never covers coordinator-owned files, manifests or `.xarabot/**`.

**Given** a builder session that changed the Epic context file (`epic-<N>-context.md`)
**When** the runner squashes
**Then** it reverts that change first (AR14).

**Given** any agent diff
**When** it changes a retro verdict, a retro item or a checkpoint go in `retro-gates.yaml`
**Then** it is refused.

**Given** runner-written content, such as a `reconcile` PR
**When** it is committed
**Then** the write check does not apply.

**Given** the write-check case table
**When** it runs
**Then** each refused path class and each exception has a case for the `claude` adapter, and the table is keyed so Epic 3 adds rows per adapter.

### Story 2.4: The coordinator lane and its claim

As the Maintainer,
I want exactly one coordinator per repo, held as a claim,
So that two coordinators never run, and builders keep going and raise an alert when the coordinator is gone (FR4, AR9, AR14).

**Acceptance Criteria:**

**Given** `xarabot lane install --role coordinator`
**When** the lane starts
**Then** it claims `coordinator.json` as `<owner>/<host>/coordinator` and heartbeats it through its units and waits.

**Given** a live coordinator claim
**When** a coordinator with a different identity starts
**Then** it refuses to start
**And** the same identity re-claiming after a restart is not a takeover.

**Given** an expired or missing coordinator claim
**When** a builder lane runs
**Then** it keeps building and posts the deduplicated alert.

**Given** `next(snapshot, 'coordinator')`
**When** it runs
**Then** it returns units in AR14's order: `reconcile`, then an open coordinator PR, then planning (a due graph unit before a due status unit), retro and retro items, or `idle` with a reason
**And** it never returns a Story, and a builder never receives a coordinator unit
**And** the case table tests the positions that exist in this Story, `reconcile` and an open coordinator PR; Stories 2.7, 2.9 and 2.10 each add their position's cases.

**Given** `next(snapshot, 'coordinator')`
**When** it decides whether `reconcile` is due
**Then** `reconcile` is due when the snapshot shows `reconcile` work, or when 10 minutes have passed by the forge's `now` since the last `reconcile` run, and is otherwise skipped for the later positions
**And** `reconcile` work in the snapshot is: a ledger record not `merged` whose PR has merged, a `merged` record whose unit is done on `main`, or the daily digest time passed
**And** (amended by the Maintainer on 2026-10-25) `reconcile` work also includes a record parked `awaiting-approval` whose open PR the Maintainer has approved at the parked head, so an approval is acted on in the next coordinator round, not after the 10-minute backstop. The snapshot carries each such PR's review decision from the snapshot's own forge query (for example GitHub's `reviewDecision`), with no extra call per PR. This adds no ledger schema change. Built by retro item `epic-2-retro-item-13-act-on-approvals-in-the-next-round`.
**And** the last run's time is the `heartbeat_at` of the highest-numbered `reconcile:<n>` record, which `finishRecurring` stamps; `reconcile` never deletes the newest `reconcile:<n>` record, so no ledger schema change is needed; with no `reconcile:<n>` record, `reconcile` is due
**And** the case table covers: work shown, under 10 minutes, at 10 minutes, no earlier run, and a later position returned while `reconcile` is not due.

**Given** a coordinator unit whose kind has no step wired yet (before Story 2.5, `reconcile`)
**When** the coordinator process reaches it
**Then** the process takes an injected step per unit kind, the way `ciStep` and `mergeStep` were injected in Epic 1; with no step for the kind, it does not claim the unit and ends `idle` with the reason "no reconcile step (Story 2.5)".

**Given** coordinator units
**When** their globs are computed
**Then** a graph planning unit holds the graph inputs and the pseudo-glob `xarabot:graph`; a status planning unit holds both status files and the Epic context path, never the graph inputs; a retro unit holds the status files, the Epic context path and the retro document path (`retro_doc_glob`), never the graph inputs; `reconcile` holds none; and the overlap check applies to the coordinator as to builders.

**Given** a coordinator session's change
**When** it touches a path its unit does not hold, a graph input from a unit that is not a graph planning unit, anything under `.xarabot/**` other than `epics.yaml`, or both a graph input and a status file
**Then** the write check (Story 2.3) refuses it, and the case table gains a row per rule (AR31).

**Given** `docs/maintainer/self-host.md`
**When** the Story is done
**Then** it adds the Maintainer steps, in order: once Stories 2.4 and 2.5 have merged, tag a `main` commit that includes both and advance `runner_version` to that tag in a Maintainer PR (Story 1.19); then install the coordinator lane with `xarabot lane install --role coordinator`, which Epic 2's retro, and so Epic 3, waits on
**And** it says the coordinator lane is never installed while `runner_version` lacks Stories 2.4 and 2.5.

### Story 2.5: `reconcile` marks units done

As the Maintainer,
I want runner code, not an agent, to record what merged and mark units done on `main`,
So that sprint status follows merges with no agent writing status, and merged ledger records are cleaned up (FR2, NFR20, AR4, AR10, AR14).

**Acceptance Criteria:**

**Given** a `reconcile:<n>` unit, with `n` one more than the last on the ledger
**When** the coordinator runs it
**Then** it runs no agent session.

**Given** ledger units whose PRs merged
**When** `reconcile` runs
**Then** it writes their `merged` records, and marks each unit done on `main` per AR10's rule for its kind (a Story becomes `done` in `sprint-status.yaml`, which is where `next` and the gates read that it is done, since its record is later deleted; until then its `merged` record already meets a `depends_on` that names it, Story 1.6)
**And** for a merged graph planning unit, it writes that unit's status entries to `sprint-status.yaml` (the Epics and Stories it added), so a graph unit never writes a status file itself
**And** it opens a `reconcile` PR holding only runner-written content, which gets no agent review and no agent loopback.

**Given** a `merged` record whose unit is done on `main`
**When** `reconcile` runs
**Then** it deletes the record; no other code deletes ledger records (the one other deletion, superseded `released` `reconcile:<n>` records, is also `reconcile`'s, below).

**Given** a `reconcile` PR that is ejected or dequeued, or whose enqueue is refused because it conflicts
**When** `reconcile` sees it
**Then** the PR is disposable, since it holds only runner-written content: the run dequeues it if needed, closes it, and releases its record with no attempt counted
**And** the next due run deletes that `released` record and opens a fresh PR from fresh `main` on its own record and branch, so one record carries one PR and no unit works on another's branch.

**Given** a `reconcile` run with nothing to commit
**When** it ends
**Then** its record becomes `merged` with no PR and raises no inbox item
**And** it is kept as the newest `reconcile:<n>` record, the last run's time that Story 2.4's due rule reads; the record it replaces as newest is deleted, so at most one `merged` `reconcile:<n>` record stays on the ledger.

**Given** a `merging` record that `reconcile` holds for its own `reconcile` PR (approved gated PRs are Story 2.6's)
**When** a later `reconcile` runs
**Then** a merged PR makes it `merged`, a still-queued PR leaves it unchanged, and an ejected or dequeued PR is closed and the record `released` (above), with no attempt counted.

The Maintainer's decisions of 2026-10-24 (readiness R7 and this Story's intent gap):

**Given** a `reconcile` PR, which holds only runner-written content
**When** its CI passes
**Then** it is exempt from `owner_approval_paths`: the runner re-checks the Standing Authority, fences, writes `merging` and enqueues it itself, giving the coordinator-held `merging` record above
**And** the Standing Authority (`docs/maintainer/standing-authority.md`) names this exemption.

**Given** an earlier `reconcile` PR that is still open (parked or queued)
**When** a later `reconcile` run has work
**Then** it does the ledger work but opens no new PR; once that PR is ejected, dequeued or conflicting, it is closed and replaced as above (revised by the Maintainer on 2026-10-24 from "regenerate it").

**Given** a `reconcile` PR
**When** it is opened
**Then** the run holds its claim and polls CI as a builder does (Story 1.17); an unexpected failure parks it `blocked` (`verification`), the CI max wait parks it `ci-timeout`, and no agent fix is attempted.

**Given** the coordinator lane
**When** a round ends `idle`
**Then** its trailing wait is 10 minutes, matching the due rule (Story 2.4); builders keep 30 minutes.
**And** (amended by the Maintainer on 2026-10-26) the coordinator's trailing wait after `idle` is 1 minute, so each round picks up the reconcile work an approval makes (Story 2.4's 2026-10-25 amendment) within about a minute; the 10-minute due rule stays as `reconcile`'s backstop. A builder's trailing wait after `idle` is also 1 minute (amended by the Maintainer on 2026-10-26), so an idle builder claims the next Story within about a minute of the one it waits on merging; its `progress` and `failed` waits are unchanged. Built by retro item `epic-2-retro-item-26-coordinator-idle-wait-one-minute`.

**Given** Story 2.4's due rule
**When** `reconcile` work is read from the snapshot
**Then** a passed digest time is not work until Story 4.2 posts the digest and stamps `digest_posted_at`; Story 4.2 adds the condition back.

**Given** earlier `reconcile:<n>` records that ended `released`
**When** a later `reconcile` run finishes
**Then** it deletes them, since it supersedes them (the spine's `released → [*]` edge, `reconcile` only); their PRs were already closed when they were released; `parked` ones (a CI failure or timeout) stay until their inbox item is resolved; the due rule reads the newest `merged` `reconcile:<n>` record.

### Story 2.5a: Resuming a blocked Story

As the Maintainer,
I want a Story that parked blocked to run again cleanly once I have answered it, with forge text that describes the change and a write check that cannot be fooled,
So that one blocked park does not stall the serial Epic 2 chain, and nothing an agent writes puts a credential or a session note on `main` (FR6, FR18, AR11, AR15, AR16, AR21, AR31).

**Acceptance Criteria:**

**Given** two `story_spec_path` matches, one with `status: done` and one with `status: blocked`
**When** a `done` build result is checked
**Then** the `done` match is the Story's spec file, the `blocked` match is superseded and dropped from the squash, as the Epic context file is reverted (AR14), and the write check passes.

**Given** a `done` build result
**When** no match is `done`, more than one match is `done`, or a match other than the `done` one is not `blocked`
**Then** the result is invalid and counts as a failed attempt (AR15).

**Given** a `blocked` build result with no match, one match or several matches
**When** it is checked
**Then** the unit parks `blocked` with its `blocked.kind`, with no halt before routing, and the spec cross-check runs only when there is exactly one match
**And** the case table covers 0, 1 and 2 matches for each outcome.

**Given** a `blocked` park
**When** the lane parks the unit
**Then** it writes the name of the unit's wip ref in `runner.git` (`refs/wip/<unit-file-id>`) to the journal and to the unit log
**And** the wip stays on the host and is never pushed (AR10); the run after a release starts fresh from `main`, which carries the Maintainer's answer.

**Given** the prompt template's result fields (`RESULT_FIELDS` in `src/core/prompt/template.ts`)
**When** a prompt is built
**Then** the `summary` line reads "one line saying what the change does (it becomes the commit title)", and the `body` line reads "a description of the change for a reviewer: never this session, the runner, the working tree or how the skill ran"
**And** a test asserts the template's wording.

**Given** agent `summary` and `body` text
**When** the sanitizer runs before any commit message, PR text or comment (AR16)
**Then** it redacts the seeded vendor credential and token-shaped strings, with one case per credential form
**And** it caps each text below the forge's limits: a `body` over 65,536 characters is truncated with a marker, so no forge write fails on its length.

**Given** the write check's case folding (`fold` in `src/core/lane/write-check.ts`)
**When** it folds a path, under builder rules and under coordinator rules
**Then** it uses full case folding (`toUpperCase().toLowerCase()`), so `ſ` (U+017F) and the Kelvin sign (U+212A) fold as APFS folds them, and a path such as `.mcp.jſon` or `pkg/AGENTſ.md` is refused as `.mcp.json` or `AGENTS.md`
**And** the case table has a row with such a path for each refused class.

**Given** the agent config paths (AR21)
**When** the write check and the Protected Paths list are built
**Then** they include `**/CLAUDE.local.md` and `**/AGENTS.override.md` at any depth (Maintainer, 2026-10-24), and the case table has a row for each.

**Given** a coordinator session's change, under coordinator rules
**When** it touches a status file or a graph input
**Then** the file must have mode `100644`; any other mode is refused, with a case row for each mode.

**Given** `xarabot lane run`'s role and lane-name start check (`src/cli/lane-run.ts`)
**When** the check fails
**Then** it is treated as a static `host.yaml` error that is not counted as a failed start (like the other `host.yaml` errors), so it never writes `STOP` without posting `lane-start-failed`.

**Given** a `reconcile` run with `releaseDead` or `deleteReleased` targets (`src/lane/reconcile-step.ts`)
**When** it handles each target
**Then** it first lists the PRs on that record's `reconcile` branch (`listPrsByBranch`) and closes any open one, so an orphan PR left by a process that died between `openPr` and the record's heartbeat is closed.

**Given** a `reconcile` run whose ledger work closed or deleted a unit's PR
**When** the run reports `openPr`
**Then** those units are left out of it, so a run that has just closed a PR does not report it as open.

### Story 2.5b: Host rulings and lane-stop exits

As the Maintainer,
I want to release or rebuild a parked unit with one command on the host, and a lane that meets a lane-stop condition to stop for good after three tries,
So that a parked Story costs me one command instead of a hand-written ledger commit, and launchd never restarts a lane forever into the same failure (FR6, FR15, AR4, AR29, AR33, AR34).

**Acceptance Criteria:**

**Given** a `parked` record
**When** the Maintainer runs `xarabot rule release <unit-id>` on the Xarabot host, as the lane's macOS user
**Then** it makes one fenced ledger edit, as `stop --now` does (AR23): the record becomes `released`, with `attempts`, `loopbacks` and `ci_fixes` set to 0 and `builder_providers[]` kept (AR29).

**Given** a `parked` record
**When** the Maintainer runs `xarabot rule rebuild <unit-id>`
**Then** it closes the unit's open PR, clears `reviewed_sha`, `passed_sha` and `builder_providers[]`, sets the counters to 0, and the record becomes `released`.

**Given** a record in any state other than `parked`, or no record
**When** `xarabot rule release` or `rebuild` names it
**Then** it refuses, naming the state, and the ledger is unchanged
**And** any other verb is refused as "not before Story 4.6".

**Given** the ruling edit (`applyRuling`)
**When** `xarabot rule` uses it
**Then** it no longer requires the coordinator role, and it is the same pure edit that Story 4.6's comment rulings reuse.

**Given** a run that ends in a lane-stop outcome (`auth`, `forbidden`, `uninstalled`, or any other `laneStop`)
**When** `xarabot lane run` exits
**Then** it exits non-zero and the run counts as a failed start, so the 3rd in a row writes the lane's `STOP` and posts `lane-start-failed` (AR34); a cause that heals before then lets the next start run.

**Given** an unmapped 4xx response, or a push that a GitHub rule refuses
**When** the forge adapter maps it
**Then** it is the error kind `rejected`, not `forbidden`, and it fails the unit's attempt: `released` with `attempts` + 1 (AR8, AR33)
**And** the forge contract suite has a case for it on the fake and GitHub adapters.

**Given** a `Halt` raised inside the usage-limit sleep's heartbeat
**When** it happens
**Then** the sleep ends at once (AR23).

**Given** the case tables
**When** they run
**Then** each forge error kind has a case for its action, each verb has a case from `parked` and a refusal case for every other state, and a test drives three launchd-style restarts through a lane-stop outcome and asserts the failed-start count, the `STOP` and the alert
**And** `docs/maintainer/self-host.md` documents `xarabot rule release|rebuild <unit-id>` in place of the hand ledger commit.

### Story 2.5c: Honest sandboxed sessions

As the Maintainer,
I want agent sessions to run zsh heredocs, to see a test suite that passes inside the sandbox, and the lockfile command to run without the vendor credential,
So that sessions stop reporting false failures and denials, and no repo command the runner starts sees a credential (FR18, AR18, AR19, AR35).

**Acceptance Criteria:**

**Given** an agent session
**When** its environment is built
**Then** `TMPPREFIX` is set inside the session's temp folder and passes the allowlist (AR18)
**And** a nested sandbox test runs a zsh heredoc in a session and it succeeds; inside a sandboxed session that case reports skipped.

**Given** a sandboxed session (`XARABOT_SANDBOXED=1`)
**When** it runs `bun test`
**Then** it gives 0 fail: cases that bind sockets (`test/sandbox/proxy.test.ts` and the users of `git-server.ts`) or need other access the profile denies report skipped.

**Given** the real-CLI case of the agent contract suite (`agent.contract.ts`)
**When** `XARABOT_LIVE=1` is not set
**Then** it reports skipped, whatever `canSandbox` returns.

**Given** `docs/maintainer/self-host.md`'s evidence table
**When** the Story is done
**Then** the `XARABOT_SANDBOXED=1 bun test test/sandbox/` row is replaced with an in-session check: a `bun test` run inside a real sandboxed session, with its expected result of `0 fail`.

**Given** a lockfile conflict
**When** the runner regenerates the lockfile inside the sandbox (AR19, Story 1.17)
**Then** the launch spec carries no credential, and a test asserts it.

**Given** `test/lane/merger.test.ts` "createGitMerger > fetches only the SHA runner.git lacks", which fails intermittently under full-suite load and passes alone (the flaky test the Epic 1 retro and Story 1.20 saw)
**When** this Story is done
**Then** its cause is found and fixed without weakening the assertion, and the full suite passes 10 runs in a row.

### Story 2.6: `reconcile` enqueues approved PRs

As the Maintainer,
I want an approved, parked PR to merge without me queueing it by hand,
So that my approving review is the only step a gated PR needs from me (FR13, AR8, AR17).

**Acceptance Criteria:**

**Given** a `parked` record awaiting its owner's approval
**When** `reconcile` sees an approving review from the owner on the PR's current head
**Then** it records `approved_sha`, re-checks the Standing Authority from freshly fetched `main`, takes the record at `generation` + 1, fences, writes `merging` and enqueues with the expected head
**And** a missing or invalid Standing Authority stops the lane before it enqueues, and the record stays `parked` (AR21).

**Given** an approval on an older head
**When** `reconcile` runs
**Then** the PR is not enqueued.

**Given** an approval-gated PR that the queue ejects or dequeues
**When** this is seen
**Then** the record becomes `parked`, holding only the paths its diff changes, with `approved_sha` cleared; it never returns to `claimed`
**And** the same applies when its enqueue is refused because it conflicts; only `reconcile`'s own PRs are closed and released instead (Story 2.5).

**Given** an approval that still stands on a PR parked after an ejection or dequeue
**When** `reconcile` runs
**Then** it does not take the PR again; it takes it only for an approving review submitted after the park, on the current head, so a PR that keeps failing does not loop and a manual dequeue sticks (Maintainer, 2026-10-24).

**Given** the `Forge` port
**When** `reconcile` reads a PR's approvals
**Then** `Forge.reviews(pr)` returns each review's author, state, commit SHA and submitted time, and the fake and GitHub adapters pass its contract-suite cases (AR1)
**And** "submitted after the park" compares the review's submitted time with the parked record's `heartbeat_at`, which the park edit stamps
**And** the after-park rule applies only to a re-park, which is a parked `awaiting-approval` record whose `lane` is `coordinator` (the coordinator wrote the park after an ejection, a dequeue or a conflict); a builder's first park counts any approving review from the owner on the PR's current head, including one given while CI still ran, with no schema change (Maintainer, 2026-10-25).

**Given** a coordinator-held `merging` record whose holder is a coordinator on another host (the coordinator moved)
**When** its gated PR is ejected, dequeued or refused for a conflict
**Then** `park` accepts any coordinator-lane writer at the record's `generation`, fencing on the generation, as Story 2.5's `releaseReconcile` does, so the record never stays stuck holding globs (Maintainer, 2026-10-25).

**Given** a parked PR whose head moved after the park
**When** `reconcile` runs
**Then** it is never enqueued automatically, since the queue only ever gets the head the lane's CI passed (AD-14); the Maintainer queues it by hand or runs `xarabot rule rebuild` (Maintainer, 2026-10-25).

**Given** this Story merged and the runner version advanced
**When** a gated PR is approved
**Then** the Maintainer no longer queues it by hand, and `docs/maintainer/self-host.md` says so
**And** the Standing Authority says that after the Maintainer's approving review, the coordinator adds the PR to the merge queue.

### Story 2.6a: One session runner

As a developer of Xarabot,
I want the session machinery and the shared step helpers in one `src/lane` module,
So that the coordinator's planning and retro sessions (Stories 2.7 and 2.9) and Epic 3's review sessions reuse one session runner instead of a copy of it (AR1, AR3, AR23).

**Acceptance Criteria:**

**Given** `runLaneProcess` in `src/lane/lane-process.ts`
**When** the Story is done
**Then** the session runner (prepare, the sandboxed run, the one resume, the usage-limit sleep, the kill 5 minutes after the result file appears, the result parse) and the step helpers (`call`, `swap`, `forgeNow`, `laneStop`, `held`, `beat`, `End`) are in one `src/lane` module that the lane process and the coordinator process both use, and no other copy of them remains.

**Given** the `src/lane` imports
**When** the boundary test runs
**Then** no import cycle remains in `src/lane`, and the test fails on one.

**Given** the existing lane-process tests
**When** they run
**Then** they pass unchanged.

### Story 2.6b: Epic 1 retro fixes

As the Maintainer,
I want the open code items from Epic 1's retro fixed before the coordinator starts its sessions,
So that a wrong model, a lost ledger swap or a stale lease can no longer stop a unit, and the Epic 1 deferrals are not lost (FR3, FR7, AR3, AR7, AR10, AR17, AR23).

**Acceptance Criteria:**

**Given** a session whose reported model differs from the lane's configured model
**When** the lane reads the session's usage
**Then** the attempt fails, and the journal records the reported model (Story 1.14's AC; `checkModel` in `src/adapters/agent/claude/usage.ts` is wired in), with a lane-process test.

**Given** the coordinator's `next` and globs from Story 2.4
**When** this Story is done
**Then** the checkpoint position and the checkpoint unit's globs are removed, since no `checkpoint` unit runs (AR14; `checkpoint:<epic>` stays only as a `go` target), and the coordinator case table drops their rows.

**Given** a `build` result `blocked` with `kind: human-live-step`
**When** its `step_id` is not configured in `.xarabot/human-live-steps.yaml`
**Then** the result is invalid.

**Given** a ledger swap that lands and then reports `transient`
**When** `swapLedger` would return `deadline` or `exhausted`
**Then** it reconciles the swap once against the tip first, and a fake-forge mode that lands a swap and then reports `transient` tests it
**And** a `Halt("failed")` after a claim releases the record at once, instead of leaving it for Story 2.2's 30-minute takeover.

**Given** a re-claim of a unit that has no open PR
**When** the lane takes its lease
**Then** it reads `Forge.branchHead(branch)` and takes the lease from the branch's real head (AR10, "every claim looks at the unit's branch"), so a stale `head_sha` no longer conflicts on every attempt until `attempts-cap`
**And** the fake and GitHub adapters pass `branchHead`'s contract-suite cases (AR1).

**Given** `xarabot stop --now` on a `merging` unit
**When** it dequeues the PR
**Then** the dequeue is fenced (Story 2.1's deferral, `src/cli/stop.ts`).

**Given** the production `githubConnect` (`src/cli/lane-connection.ts`)
**When** a test drives it against the fake GitHub
**Then** alerts post and pushes go through.

**Given** `xarabot graph check`
**When** it runs git
**Then** each git call has a deadline and runs with `GIT_TERMINAL_PROMPT=0` (AR3).

### Story 2.7: Planning units

As the Maintainer,
I want the coordinator to keep sprint status and Epic context current through stock BMAD planning, and manifests and the Epic graph current through planning PRs I approve,
So that Stories become eligible without me running sprint planning by hand (FR2, NFR5, AR14, AR30).

**Acceptance Criteria:**

**Given** a snapshot where `epics.md` has Epics or Stories missing from `sprint-status.yaml`, or an Epic not listed in `bootstrapped_epics` whose Stories wait only on its Epic context file (`epic_context_path`), missing or invalid on `main` (Story 1.6)
**When** `next(snapshot, 'coordinator')` reaches planning
**Then** it returns a status planning unit, `planning:<slug>.<n>`, naming what is due.

**Given** a snapshot where `epics.md` has Story headings with no manifest, outside the Epics listed in `bootstrapped_epics`
**When** `next(snapshot, 'coordinator')` reaches planning
**Then** it returns a graph planning unit, `planning:<slug>.<n>`, naming what is due
**And** when a graph unit and a status unit are both due, it returns the graph unit first.

**Given** a status planning unit
**When** its prompt is built
**Then** it runs stock `bmad-sprint-planning` told to run headless, and never touches a graph input
**And** for each due Epic context it follows the installed stock `bmad-build-auto` skill's `compile-epic-context.md` with the Epic number, the epics path, the planning artifacts directory and the output path (`epic_context_path`)
**And** it tells the session to return any readiness findings in the `planning` result (`outcome: blocked`, the findings in `summary`) and never to save a findings file, so the unit holds no findings path.

**Given** a graph planning unit
**When** its prompt is built
**Then** it names the due manifests and graph edits to `epics.md` and `.xarabot/epics.yaml`, with the `.xarabot/epics.yaml` schema stated in the package template (AR12), does not run `bmad-sprint-planning`, and never touches a status file
**And** it asks for `depends_on` in each manifest whose Story builds on an earlier Story, listing those Story ids, each in the same Epic or an Epic it depends on.

**Given** either planning unit
**When** its result is read
**Then** it is the `planning` kind, with `outcome` `done`, `nothing-due` or `blocked`.

**Given** a planning diff
**When** it is squashed
**Then** the write check (Story 2.3) applies: a status unit's diff touches only the status files and the Epic context path, a graph unit's diff touches only the graph inputs, and no diff touches both a graph input and a status file.

**Given** a graph planning unit's PR
**When** its checks pass
**Then** it parks for the Maintainer's approval (under the every-path approval rule until Story 2.8's graph-change gate exists), and the next `reconcile` after it merges writes its status entries (Story 2.5)
**And** a status planning unit's PR is not approval-gated, except where repo policy makes every path need approval.

**Given** a recurring planning unit with nothing to commit
**When** it ends
**Then** its record becomes `merged` with no PR and is deleted at once.

**Given** the coordinator
**When** it has an open coordinator PR
**Then** it takes no new planning unit until that PR merges or parks (AR14 order).

**Given** a status planning unit whose `planning` result is `blocked` (readiness findings in `summary`)
**When** the runner handles it
**Then** the record parks `blocked` with the new runner cause `readiness` (`park.reason: readiness`, AR6), with an inbox item that carries the findings (AR8's inbox item for a blocked park)
**And** the new enum value bumps the ledger `schema_version` (AR6).

**Given** a `parked` (`readiness`) planning record
**When** `next(snapshot, 'coordinator')` reaches planning
**Then** no status planning unit is due, so `planning:<slug>.<n+1>` does not re-run the same findings.

**Given** the Maintainer has fixed the plan and released the parked record (`xarabot rule release`, Story 2.5b)
**When** the coordinator next reaches planning
**Then** a status planning unit may be due again, and a later `reconcile` run deletes the superseded `released` planning record (the spine's `released → [*]` edge).

**Given** the coordinator case table from Story 2.4
**When** it runs
**Then** it gains the planning position's cases: a status unit due, a status unit due only for an Epic waiting on its context file, a graph unit due, both due with the graph unit first, and a Story heading with no manifest, or no Epic context file, in an Epic listed in `bootstrapped_epics`, which makes nothing due
**And** it gains rows for a `readiness` park, a status unit held while the park stands, and the release.

Decisions of 2026-10-25 for this Story's intent gap (the session's proposed readings, accepted by the Maintainer):

**Given** a graph planning unit whose result is `blocked`
**When** the runner parks it
**Then** it parks `blocked` with reason `readiness`, and that park holds only later graph units, as a status unit's `readiness` park holds only status units.

**Given** a planning record parked `blocked` for any reason (`readiness`, `write-check`, `verification`, `ci-timeout` or `attempts-cap`)
**When** `next` reaches planning
**Then** no new unit of that record's kind (status or graph) is due until the park is released, so a blocked planning unit never re-runs into the same park.

**Given** a planning PR
**When** its CI fails unexpectedly
**Then** it parks `blocked` (`verification`) with no agent fix, as Story 2.5 decided for `reconcile`'s own PR
**And** an ungated status planning PR that is ejected, dequeued or refused for a conflict is disposable, like `reconcile`'s PR: it is closed, the record released, and a later run re-plans from fresh `main`; a gated graph PR keeps Story 2.6's re-park.

**Given** planning run ids
**When** a planning unit is claimed
**Then** the ids are `planning:status.<n>` and `planning:graph.<n>`, with `n` one more than the highest of that slug on the ledger; a reused `n` and branch name after records are deleted is accepted, because the claim reads only the record's own PR and the push leases from `branchHead`.

**Given** the new `readiness` park reason and fields
**When** the ledger schema goes up
**Then** a ledger-only `schema_version` constant becomes 2; the reader accepts 1 and 2 (AD-5 stops only on an unknown or newer version) and every ledger write stamps 2
**And** the Maintainer advances `runner_version` for every lane together right after this Story merges, since a lane on an older runner stops (`ledger-schema-version`) once it reads a v2 record, then restarts onto the new pin.

### Story 2.8: The graph-change gate

As the Maintainer,
I want every change to the effective Epic graph to wait for my approval on exactly the graph it would produce,
So that no planning PR, or any other PR, can quietly re-order, add or drop work (FR2, NFR18, AR12, AR17).

**Acceptance Criteria:**

**Given** a PR whose merge result, recomputed in `runner.git`, changes the resolved graph (edges including package edges, checkpoints, the Epic set and numbers, or any Epic's Story set), whatever files it touches
**When** it is about to be enqueued
**Then** its record takes the pseudo-glob `xarabot:graph`, and a second such PR waits.

**Given** that merge result
**When** `resolveGraph` and the full validation list run on it
**Then** any failure parks the PR, blocked.

**Given** a graph-changing PR
**When** the runner handles it
**Then** it posts the delta on the PR: changed edges and checkpoints, and the Epics each checkpoint without a go would hold.

**Given** the Maintainer's approving review on the PR's head
**When** the runner records it
**Then** it stores `approved_graph`, the hash of the resolved graph of that head's merge result, in the record's `approved_graph` field (AR6); the new field bumps the ledger `schema_version`
**And** at enqueue it recomputes the hash against current `main`; on a mismatch the approval is void and requested again
**And** the bot owner's approval alone never counts.

**Given** a PR that renumbers or removes an Epic or Story id that has a status beyond `backlog`, a `retro-gates.yaml` record, a ledger record or a PR on its branch
**When** it is checked
**Then** it parks, blocked.

**Given** an Epic with a retro verdict
**When** a PR adds a Story to it
**Then** it parks, blocked; new work goes in a new Epic.

**Given** the case tables
**When** they run
**Then** each kind of graph change and each refusal has a case.

### Story 2.9: Retro units

As the Maintainer,
I want the coordinator to run each Epic's retrospective through stock BMAD and record a validated verdict,
So that an Epic's dependents start only after a real retro, and retro items carry the tags gates need (FR10, AR13, AR15, AR30).

**Acceptance Criteria:**

**Given** an Epic whose Stories are all `done` in `sprint-status.yaml`, with no retro verdict, and whose live evidence file is on `main`
**When** `next(snapshot, 'coordinator')` reaches retro
**Then** it returns `retro:<epic>`
**And** an Epic listed in `bootstrapped_epics` never gets a retro unit; the gates read its retro as done.

**Given** config `live_evidence_glob` (default `docs/maintainer/evidence/epic-<N>.md`), added to the config schema (AR21)
**When** an Epic's Stories are all `done` but its live evidence file is not on `main`
**Then** `retro:<N>` is not due, and `next` idles `waiting-on-maintainer`, naming the file (AR25)
**And** the write check refuses any builder diff that touches an evidence file (AR31).

**Given** a retro unit
**When** the runner prepares its session
**Then** it prefetches the Epic's PRs (number, title, body, review states, merge SHA) into the session's temp folder, and the prompt names the file; the session never reaches GitHub (AR18).

**Given** a retro unit
**When** its prompt is built
**Then** it runs `bmad-retrospective -H <epic>`, then asks for each action item's `id`, `blocking`, `route` (`lane` or `maintainer`) and `globs`, and the result is the `retro` kind, with `verdict` `accepted`, `accepted-with-open-items` or `rejected`.

**Given** a retro result
**When** the runner validates it before the squash
**Then** it fails a result whose items do not match one to one the `action_items` the diff appends to `sprint-status.yaml` (by stock BMAD id), or whose `verdict` differs from the `verdict` field in the frontmatter of the retro document, stock BMAD's `epic-<N>-retro-<date>.md`, found by the configured `retro_doc_glob`
**And** a result that fails validation counts as a failed attempt.

**Given** a valid retro result
**When** the PR merges
**Then** the runner stores the result in the record's `retro_result` field (AR6; a new field, so the ledger `schema_version` goes up, as in Story 2.8), and the next `reconcile` writes the verdict and items to `retro-gates.yaml` once, marking the retro done
**And** when `retro-gates.yaml` is absent on `main`, `reconcile` creates it with `schema_version: 1` at that first write.

**Given** a valid retro result with verdict `rejected`
**When** `reconcile` writes it
**Then** it is written like any other verdict; Epic 4 holds the Epics that depend on this one until the Maintainer's `/xarabot go retro:<N>`, and lists the course-correction item in the Maintainer's inbox.

**Given** an item's globs
**When** they include graph inputs, status files or anything the write check refuses a builder
**Then** the result fails validation.

**Given** a coordinator session's change to `retro-gates.yaml`
**When** the write check runs before the squash
**Then** it refuses any change to a retro verdict, item or go (AD-30); only `reconcile`'s runner code writes them. The write-check case table gains a row per field. (Moved here from Story 2.4 by the Maintainer on 2026-10-24: retro units are where coordinator sessions first touch retro records.)

**Given** the coordinator case table from Story 2.4
**When** it runs
**Then** it gains the retro position's cases: an Epic with every Story `done` and no verdict, an Epic with a Story not yet `done`, an Epic with every Story `done` and no live evidence file, and an Epic listed in `bootstrapped_epics`.

### Story 2.10: Retro-item units

As the Maintainer,
I want the coordinator to work open retro action items that have globs,
So that retro follow-ups get done alongside later Stories without me routing each one (FR10, AR10, AR14).

**Acceptance Criteria:**

**Given** an open item in `retro-gates.yaml` with globs and `route: lane`
**When** `next(snapshot, 'coordinator')` reaches retro items
**Then** it returns `retro-item:<bmad-action-item-id>` on branch `<xarabot-namespace>retro-item-<id>`.

**Given** an item with no globs
**When** `next` runs
**Then** it is never returned, and it is listed in the reasons.

**Given** a retro-item unit
**When** its prompt is built
**Then** it runs no skill and names the item.

**Given** a retro-item session
**When** its result is read
**Then** it is a `build` result with no `story_spec_path` cross-check, and its PR follows a Story's path (CI, approval, Story 2.6's enqueue)
**And** the claimed item's status stays `open`; `in-progress` is not written in 0.x (AR13).

**Given** a merged retro-item PR
**When** the next `reconcile` runs
**Then** it sets the item's status to `done` in `retro-gates.yaml`.

**Given** an item with `route: maintainer`
**When** `next` runs
**Then** it is skipped; Epic 4 lists it in the inbox.

**Given** the coordinator case table from Story 2.4
**When** it runs
**Then** it gains the retro-items position's cases: an open item with globs and `route: lane`, an item with no globs, an item with `route: maintainer`, and an item already `done`.

### Story 2.11: Several builder lanes on one host

As an operator,
I want to install several builder lanes on one host, each with its own clone, state folder and launchd job,
So that one host builds several Stories at once within its builder limit (FR4, NFR21, AR22, AR35).

**Acceptance Criteria:**

**Given** `xarabot lane install --role builder` run for `builder-1` … `builder-N`
**When** each is installed
**Then** each gets its own state folder, `runner.git`, clone, vendor home and launchd job, and lane names are unique per host and repo.

**Given** `XARABOT_MAX_BUILDERS`
**When** a builder would start that makes the host's builder count, across all repos, exceed it
**Then** that lane refuses to start.

**Given** a host-wide `~/.xarabot/STOP`
**When** it is written
**Then** every lane on the host, coordinator included, finishes its current unit and takes no new claim.

**Given** two builder lanes and a coordinator against the fake forge
**When** they run concurrently
**Then** no unit is built twice, and no builder diff writes `sprint-status.yaml` or `retro-gates.yaml`.

**Given** a lane process already running
**When** a second process of the same lane starts on the host
**Then** it cannot create the lane's exclusive `lane.lock` (created exclusively, holding the PID and start time), exits 0 without claiming, and is not counted as a failed start (AR3)
**And** a `lane.lock` whose PID is dead, by the start-time check `stop --now` uses, is taken over.

**Given** `xarabot lane install --role builder`
**When** the lane name is not `builder-<n>` with n ≥ 1
**Then** install refuses it, as the ledger's lane names require (AR35).

**Given** `xarabot lane install`
**When** `claude`, `bun`, `git` or `uv` does not resolve on the `PATH` it writes into the plist
**Then** install refuses, naming the missing tool.

**Given** a conflict while the runner applies the session's changes onto `origin/main` (AR16)
**When** it commits
**Then** it starts a conflict session counted in `ci_fixes` (AR20), not a failed attempt; with several builders this is common.

### Story 2.12: Claims race verification

As the Maintainer,
I want proof against the real claims branch that lanes cannot both win a unit,
So that I can lift the builder limit after Epic 3 with evidence that claims hold (FR3).

**Acceptance Criteria:**

**Given** the scratch repo and two lanes with different host UUIDs
**When** both race to claim one unit
**Then** exactly one wins.

**Given** two Stories with overlapping globs
**When** two lanes race for them
**Then** exactly one is claimed, and the other lane gets the next eligible unit or `idle`.

**Given** a lane killed by PID mid-unit
**When** 30 minutes pass after its last heartbeat
**Then** another lane takes the unit over at `generation` + 1, and the killed lane's late push (replayed by the test) is refused by its fence.

**Given** two processes of the same lane on one host
**When** both start
**Then** only one holds `lane.lock` and claims; the other exits without claiming (Story 2.11).

**Given** a clone of this repo and a sandboxed session
**When** the session runs `bun install --frozen-lockfile` through the proxy
**Then** it exits 0 (a live case).

**Given** the suite
**When** it runs without live credentials, or inside a sandboxed session (`XARABOT_SANDBOXED=1`)
**Then** the live cases are reported as skipped, never as passed; the 30-minute case is marked long-running and runs only when asked.

**Given** `docs/maintainer/self-host.md`
**When** the Story is done
**Then** it records this suite's live command (`XARABOT_LIVE=1 bun test <suite>`, the 30-minute case included) and its expected result, which the Maintainer runs on the host, outside the sandbox, before Epic 2's retro
**And** it adds evidence rows, also run before Epic 2's retro, for the `bun install --frozen-lockfile` case above and for the agent-contract live smoke (`XARABOT_LIVE=1 bun test test/contracts/`)
**And** it says the Maintainer commits the run's result as `docs/maintainer/evidence/epic-2.md`, which Epic 2's retro waits for (Story 2.9)
**And** it adds the Maintainer-run acceptance check for after Epic 3: a coordinator and 2 builders for 24 hours with no unit built twice and no builder write to the status files (FR4).

## Epic 3: Every diff is reviewed before it merges, by another vendor where allowed

`codex` lanes run beside `claude` with the same `agent`, `model` and `effort` settings (the `pi` adapter is deferred to v1: stock pi 1.4.0 gives `bmad-build-auto` no subagents; Maintainer, 2026-10-25), and the runner has every diff reviewed before it merges, bound to the reviewed SHA: by a model from another vendor when the repo's policy allows one, otherwise by a separate same-vendor session, so a user with a single LLM subscription still merges. The adapters come first so that the cross-vendor path can be proven once Story 3.3 lands; allowing `codex` in this repo's policy turns it on. Once this Epic merges, the Maintainer lifts the every-path approval rule and the 1-builder limit.

### Story 3.1: The `codex` adapter

As an operator,
I want a lane to run `codex` through the `Agent` port inside the sandbox,
So that Stories can be built by an OpenAI model with the same lane settings as `claude` (FR7, AR18, AR22, AR42; spike: `notes/codex-ar42-spike-2026-10-25.md`).

**Acceptance Criteria:**

**Given** the AR42 spike
**When** the Story starts
**Then** it reads the AR42 spike note, which settled subagents (yes, `multi_agent` stable), resume (`codex exec resume <thread_id>`, the id from the first `--json` line, `thread.started`; never `--ephemeral`) and where usage lives, and it confirms with the real CLI only how `bmad-build-auto`'s outcomes (a `ready-for-dev` halt; it never yields `no-op`) map onto the `build` result; if that mapping cannot be made, the Story stops and raises it
**And** if `codex exec` cannot run `bmad-build-auto` as required, the Story stops and raises it to the Maintainer instead of working around it.

**Given** lane settings
**When** `launchSpec` runs
**Then** it returns `codex exec -m <model> --json -c model_reasoning_effort=<effort>` with `--dangerously-bypass-approvals-and-sandbox` inside Xarabot's sandbox, no attribution setting (codex 0.163.0 ignores `-c commit_attribution`; the sanitizer criterion below strips its trailer; Epic 2 retro item 28), `SSL_CERT_FILE` set to the system CA bundle (Epic 2 retro item 28), `stdin` left unset so the sandbox gives the session a closed stdin (codex reads a piped stdin into the prompt), `CODEX_HOME` set to the lane's vendor home, `XARABOT_RESULT`, the clone as working directory and the skills exposed through `.agents/skills`
**And** an unset `model` is `gpt-6.1-sol` and an unset `effort` is `high`
**And** a test asserts the codex `LaunchSpec` has no `stdin`.

**Given** codex's built-in prompt that forces `Co-authored-by: Codex <noreply@openai.com>` and a `Generated with [Codex](https://openai.com/codex/).` PR line
**When** a codex result's `summary` or `body` carries either
**Then** the sanitizer strips it before any forge text, and a test feeds both strings through it; commits are the runner's own (AR16), so a session's own commit never reaches the forge.

**Given** the operator's `codex` credential, its auth file or API key, written once to a mode-600 file under `$XDG_CONFIG_HOME/xarabot/vendors/<vendor>/` (falling back to `~/.config`)
**When** a `codex` session, builder or reviewer, is about to launch
**Then** the lane process reads that file and seeds the lane's vendor home with it, as `auth.json` (mode 600) in the lane's `CODEX_HOME`, or as `CODEX_API_KEY` for an API key (spike Q6)
**And** a live case records whether a session rewrites `auth.json` (a token refresh); a rewrite is journaled, never copied back without the Maintainer's decision
**And** a lane whose adapter or reviewer is `codex` refuses to start while that file is missing or unreadable (AR18).

**Given** a model
**When** `effortValues` runs
**Then** it returns the efforts that model offers, and an effort it does not offer stops the lane at start; for `gpt-6.1-sol` the values are `low` … `max`; codex's `ultra`, `none` and `minimal` are not on Xarabot's scale.

**Given** the `--json` output and the session file `$CODEX_HOME/sessions/…/rollout-*-<thread_id>.jsonl`
**When** `parseUsage` runs, before the vendor home is re-seeded
**Then** it takes tokens from `turn.completed`, the model from `turn_context.model`, and a usage-limit hit and its reset from `token_count.rate_limits` (`resets_at`, Unix seconds; never from the message text); cost is an estimate from tokens (AR25); a failed turn (`turn.failed`, exit 1) that is not a usage limit fails the attempt, and a reported model that differs from config fails the attempt
**And** a live case records whether subagent tokens are in the parent's totals; if not, the child session files (`parent_thread_id`) are added.

**Given** a session that ends with no result file
**When** the adapter handles it
**Then** it resumes once in the way the spike established, asking only for the result.

**Given** the proxy allowlist for `codex` sessions
**When** a session runs
**Then** only `chatgpt.com`, `ab.chatgpt.com`, `auth.openai.com` (and `api.openai.com` with an API key), the Python package hosts and repo-added hosts are reachable
**And** the Maintainer's live run records every host a codex session asks the proxy for; the spike's unresolved address (`2606:4700:440b::ac40:9034`) is named from that log before the list is final, and a host not on the list is raised to the Maintainer, never added silently.

**Given** an installed `codex` older than 0.163.0
**When** a lane starts
**Then** it refuses to start.

**Given** the `Agent` contract suite, the sandbox refusal suite and the write-check case table
**When** they run for `codex`
**Then** each passes, with live cases skipped without credentials
**And** inside a sandboxed session (`XARABOT_SANDBOXED=1`) the sandbox refusal suite skips its nested cases and reports them as skipped; the Maintainer runs them live on the host with Story 3.6's proof.

### Story 3.2: The `pi` adapter, deferred to v1

As the Maintainer,
I want a lane or reviewer set to `pi` to refuse clearly in 0.x,
So that nothing waits on an adapter that cannot run `bmad-build-auto` (FR7, Story 3.2's escalation of 2026-10-25).

**Acceptance Criteria:**

**Given** `agent: pi` on a lane, or a policy whose only reviewer would be `pi`
**When** `xarabot lane install` or a lane start runs
**Then** it refuses, naming the deferral ("the `pi` adapter is deferred to v1: stock pi 1.4.0 gives `bmad-build-auto` no subagents"), and counts as a failed start like any refusal (AR34).

**Given** the policy schema's `AdapterName` (`claude`, `codex`, `pi`)
**When** this Story is done
**Then** `pi` still parses, so a policy that lists it is not invalid, but no code path launches a `pi` session, and `src/adapters/agent/pi/` does not exist.

**Given** `docs/maintainer/self-host.md`
**When** the Story is done
**Then** it records the escalation's finding and what the v1 adapter needs first: subagents for `bmad-build-auto`, the agent-directory override (AR41), and the attribution and sandbox switches.

### Story 3.3: Session vendors and the reviewer choice

As the Maintainer,
I want the runner to know the vendor of every model that changed a diff, and to pick a reviewer from another vendor when the repo allows one,
So that no diff is reviewed by the vendor that built it unless the repo has only that vendor (FR8, AR17).

**Acceptance Criteria:**

**Given** a session's adapter and model
**When** the pure vendor function runs
**Then** `claude` is Anthropic and `codex` is OpenAI.

**Given** a unit
**When** any session changes its diff (first build, loopback, CI fix or conflict resolution)
**Then** that session's vendor is added to the record's `builder_providers[]`.

**Given** `builder_providers[]` and the repo's allowed adapters
**When** the pure reviewer choice runs
**Then** it returns the first allowed adapter of (`claude`, `codex`) whose vendor is not in the set, marked cross-vendor
**And** the case table reproduces `agent-adapters.md` § Cross-vendor review: `claude` → `codex`, `codex` → `claude`.

**Given** a policy that allows no adapter from another vendor
**When** the pure reviewer choice runs
**Then** it returns a same-vendor reviewer, marked same-vendor: the first allowed of (`claude`, `codex`)
**And** the case table has rows for a `claude`-only and a `codex`-only policy, and for a policy allowing neither, which refuses at lane start (Story 3.2), so a unit never parks for lack of a reviewer.

**Given** a lane
**When** it starts
**Then** it refuses to start if its reviewer adapter is not allowed by the repo's policy, or if the reviewer's credential file under `$XDG_CONFIG_HOME/xarabot/vendors/<vendor>/` is missing or unreadable (AR17, AR18, AR22).

**Maintainer decision (2026-10-26, the empty-set deferral of Stories 3.3 and 3.4):** an empty `builder_providers[]` on a unit with an open PR (an adopted PR with no prior record, or a record from a runner older than Story 3.3) is not read as "no builder". The lane that adopts the PR adds its own vendor to the set before any CI, review or merge step, so the reviewer choice is cross-vendor relative to that lane. A non-empty set is never changed. Routed as Epic 2 retro item 29.

### Story 3.4: Review sessions

As the Maintainer,
I want each review to run on a clean checkout of the exact head, with nothing the builder wrote able to configure the reviewer,
So that a review result describes the diff that will merge and cannot be steered by the builder (FR8, AR15, AR17).

**Acceptance Criteria:**

**Given** a unit ready for review
**When** the runner starts the review session
**Then** it makes a fresh checkout of `head_sha` from `runner.git`, never the builder's clone, restores the agent config paths from `main`, turns hooks off, seeds a fresh vendor home for the reviewer from that vendor's credential file (AR18), and launches it through the sandbox.

**Given** the review prompt
**When** `core/prompt` builds it
**Then** it comes from the package review template, names the unit and the Story spec, and ends by writing a `review` result to `$XARABOT_RESULT`
**And** the prompt test asserts it has no selection, CI, merge or status instruction.

**Given** a Story whose spec file at `head_sha` (the single `done` match, AR11) has `followup_review_recommended: true`
**When** `core/prompt` builds the review prompts
**Then** it builds a second, follow-up prompt from the package review template that names the spec and tells the reviewer to check the unverified risks the spec's Auto Run Result names, ending with a `review` result
**And** the prompt test covers it.

**Given** a review result
**When** the runner handles it
**Then** it records `reviewed_sha` itself, ignoring any SHA the agent reports, and posts the review on the PR through `Forge.postReview`, naming that SHA, saying whether it is cross-vendor or same-vendor and listing the findings, as a comment review with no approval
**And** a result with no blocking findings sets `passed_sha` to the reviewed SHA; one with blocking findings never does.

**Given** `Forge.postReview`
**When** the forge contract suite runs
**Then** the fake and GitHub adapters pass it.

### Story 3.5: The review gate and loopbacks

As the Maintainer,
I want no PR to enter the merge queue unless its head is the reviewed and passed diff,
So that every merged diff is one another vendor reviewed, and disagreements stop after 2 loopbacks (FR8, AR17, AR20, AR21).

**Acceptance Criteria:**

**Given** a PR about to be enqueued
**When** the enqueuing lane checks it
**Then** it enqueues only if the head equals `passed_sha`, or the head's tree equals the merge of `passed_sha` with the head's `main` parent, a merge the lane recomputes itself in `runner.git` without trusting the record or the commit's author. (Amended by Epic 3 retro item 4: the head may also reach `passed_sha` through a chain of such clean merges, at most 32, one per queue ejection.)

**Given** a review with blocking findings
**When** the runner handles it
**Then** it prefetches the findings into the temp folder, runs a loopback session at `head_sha` and reviews again
**And** a lane that takes the unit over never enqueues: after a blocking round it clears the review SHAs, keeps `loopbacks`, and builds and reviews afresh (amended as built; Maintainer, 2026-10-29, Epic 3 retro A6).

**Given** any later agent change to the diff (a loopback, a CI fix or a conflict resolution)
**When** it is committed
**Then** the review re-runs
**And** a review-driven fix session counts as a loopback (`loopbacks` + 1); a CI-fix session, or an agent session resolving a merge conflict, counts as a CI fix (`ci_fixes` + 1, Story 1.17) and never as a loopback
**And** once `loopbacks` ≥ 2, the unit becomes `parked`, blocked (`park.reason: review-cap`), whatever the review's verdict, with `park.inbox_owner` set to its owner; past the `ci_fixes` cap it becomes `parked`, blocked (`park.reason: ci-fix-cap`), as Story 1.17 says.

**Given** a unit whose spec recommends a follow-up review
**When** a review round runs, before the PR parks for approval or is enqueued
**Then** the runner runs the normal review and then the follow-up pass, each a separate session on the same fresh checkout under Story 3.4's rules, and sets `passed_sha` only when neither has blocking findings
**And** blocking findings from either pass start one loopback (`loopbacks` + 1), and every later round runs both passes again
**And** a unit with no spec (a retro item or a coordinator PR) or with the flag `false` gets the normal review only
**And** the case tables gain rows for a flagged Story passing both, failing the follow-up only, and an unflagged Story.

**Given** coordinator PRs
**When** they are enqueued
**Then** the same gate applies, except `reconcile` PRs, which carry only runner-written content.

The Maintainer's decisions of 2026-10-26 (this Story's intent gap):

**Given** a unit whose reviewer is another vendor's adapter
**When** the review step needs that reviewer
**Then** `lane run` (`src/cli/lane-run.ts`) composes every allowed reviewer agent and passes them to the review step, so cross-vendor review works from this Story on (Story 3.4's deferral).

**Given** a blocking review on a coordinator PR
**When** the unit is a retro item
**Then** it gets a loopback like a Story's: a `retro-item` loopback prompt mode in `src/core/prompt/**`, counted in `loopbacks` with the same cap
**And** when the unit is a planning or retro PR, the review's blocking findings park it `blocked` with a named park reason, for the Maintainer, with no loopback.

**Given** the review binds `passed_sha` to the reviewed diff
**When** `reconcile` or the coordinator needs to know whether the runner enqueued a PR, or whether a park is a re-park
**Then** a separate ledger field records the runner's enqueue (`passed_sha` keeps only its review meaning), with `src/core/next/coordinator.ts` and `reconcile` reading the new field
**And** the ledger `schema_version` goes up by one (riding the same bump as retro item 24's posted-delta hash if it has not yet shipped, otherwise the next one), every lane's runner pin advancing together.

**Given** a lane
**When** it is about to launch any session or enqueue
**Then** it re-checks the adapter and reviewer allowances from freshly fetched `main`, and refuses if either is no longer allowed.

**Given** the case tables
**When** they run against the fake forge
**Then** head equal to `passed_sha`, head with only a clean `main` merge on top, head with a later agent change, the loopback cap, a CI fix and a conflict resolution that each re-run the review and count toward `ci_fixes`, not `loopbacks`, and a revoked allowance each have a case.

**Maintainer amendment (2026-10-26, Epic 3 retro open question 2, finding A7):** the cap stops a third loopback, never a pass. Once `loopbacks` ≥ 2, a round with no blocking pass sets `passed_sha` and proceeds, as any passing round does. Only a blocking round parks `blocked` (`park.reason: review-cap`), with `park.inbox_owner` set to the unit's owner. This replaces "whatever the review's verdict" above. It is routed as Epic 3 retro item 11.

### Story 3.6: Cross-vendor verification

As the Maintainer,
I want proof that the same unit builds through each adapter and that the review gate holds on the real repo,
So that I can lift the every-path approval rule and the 1-builder limit with evidence (FR7, FR8).

**Acceptance Criteria:**

**Given** the scratch repo and live credentials for each vendor
**When** the verification suite runs
**Then** the same unit runs to a valid `build` result through `claude` and `codex`.

**Given** a `claude`-built PR on the scratch repo
**When** it reaches review
**Then** a `codex` review is posted naming the reviewed SHA, and the PR merges only at that SHA or a clean `main` merge on top of it.

**Given** a later agent change after a passed review
**When** the lane continues
**Then** the review re-runs before the PR can be enqueued.

**Given** a policy that allows only `claude`
**When** a `claude`-built unit is ready for review
**Then** a separate `claude` session reviews it on a fresh checkout, the posted review names the reviewed SHA and says it is same-vendor, and the PR merges on its required checks.

**Given** `docs/maintainer/self-host.md`
**When** the Story is done
**Then** it records this suite's live command (`XARABOT_LIVE=1 bun test <suite>`) and the expected result of each case above, and the nested sandbox cases of Story 3.1, plus `bun test test/sandbox/` on the host as an evidence row until the macOS CI job runs (2.5c deferral; Epic 1 item 13); the Maintainer runs them on the host, outside the sandbox, with every vendor's credential at once (a lane's vendor home holds only one), before Epic 3's retro
**And** inside a sandboxed session the live cases are reported as skipped, never as passed
**And** it lists the switch after this Epic: drop the every-path approval rule from this repo's `policy.yaml`, allow the adapters to be used unattended (codex as a builder only after the Maintainer's recorded real-skill codex run, Epic 3 retro item 18; codex may review before it), confirm lane item 23 (lane-lock hardening) is done, raise `XARABOT_MAX_BUILDERS`, and run the 24-hour acceptance check. Dropping the every-path rule makes status planning PRs ungated and so disposable, which settles spec-2-7's stale gated status PR. The 'Several builder lanes' runbook step waits for the lock's PID to be gone, not for 'no `lane.lock`' or an `outcome` (2.11 F3, F4).

**The Maintainer's decisions on Epic 3's retro (2026-10-26; `epic-3-retro-2026-10-26.md`, machine verdict rejected):**
- **The go.** Epic 4 may start. The switch after this Epic (above) waits until Epic 3 retro item 1 (reap session processes, isolate review passes; finding C1) has merged in a runner tag, and item 2 (the codex resume re-run after item 35) is recorded in `docs/maintainer/evidence/epic-3.md`. Until the switch, every path still needs the Maintainer's approving review, so a forged review cannot merge a change on its own.
- **Q1:** C1's threat, a builder's leftover process reaching the reviewer's result file or vendor home, is in scope for 0.x.
- **Q2:** a passing round after the second loopback proceeds (Story 3.5 amendment above).
- **Q3:** from Epic 4 on, each Epic's runbook commands are listed under `live_evidence_checks` in `.xarabot/config.yaml`, so a failed live row holds the retro. They are added when that Epic's runbook names them.
- **Q4:** `retro-gates.yaml` is the authoritative tracker for retro action items, the file the runner reads and routes. The `action_items` that `bmad-retrospective` appends to `sprint-status.yaml` are the skill's copy, and are not reconciled by hand.
- **Q5:** the macOS CI job (the 2026-10-24 decision, Epic 1 item 13) is still wanted. The Maintainer adds it in a `.github/` PR.
- **Q6:** PRs #21 and #23–#28 used the admin bypass as intended during the bootstrap.
- **Item 10 (2026-10-29):** Q4 stands: `sprint-status.yaml`'s 25 earlier `action_items` are not synced by hand. Q5 is amended: the macOS CI job is deferred, not built now; the Maintainer's recorded host runs stand in. Epic 4's runbook command is listed under `live_evidence_checks` in `.xarabot/config.yaml` (Q3). With these three, item 10 is done.
- **Item 6:** the follow-up reviews of Stories 3.4 and 3.5 were done by the Maintainer's walkthrough of #157 and #168 on 2026-10-26. It covered the passed gate (with its clean-merge rule), the review checkout, loopbacks and the cap, the v5 ledger and allowances. Run 2 of the live evidence then exercised the composed `lane run` path end to end. No loopback ran live, so it remains covered by the case tables only.
- **Item 1, how a session's processes are reaped (2026-10-27, its escalation, option a):** the runner may kill the process group that the sandbox itself created for a session with `setsid`, by signalling that group's id. The id is the session's exact PID, so the kill reaches only that session's descendants and never matches processes by command line the way `pkill -f` does. "Kill by exact PID" (AR3, AR44) still holds everywhere else. `test/no-pkill.test.ts` exempts only `src/sandbox/macos.ts`'s group kill, and the Sandbox port doc (`src/ports/sandbox.ts`) says abort signals go to that exact group.
- **Planning lessons, as rules (2026-10-27; Epic 3 retro finding A10 and item 7; most units that parked for the Maintainer on 2026-10-26 to 27 parked over globs):**
  - **Globs cover tests and wiring.** Every Story manifest and every lane-routed retro item names, beside each `src/` path it changes, that path's tests (`src/<p>.ts` with `test/<p>.test.ts`, `src/<dir>/**` with `test/<dir>/**`). It also names the wiring files a known kind of change needs, kept as a table in code. For example, a Forge port operation also needs `test/ports/forge.test.ts`, `test/contracts/forge.contract.ts` and `src/adapters/forge/**`. `graph check` reports a manifest that breaks the rule. A retro's result check refuses a new lane item that breaks it. The graph planning prompt states the rule. Routed as Epic 3 retro item 14.
    - **Config-supplied (Maintainer ruling, 2026-10-29).** #259's review found the rule hard-coded Xarabot's own layout, against SPEC § Constraints' "no platform assumptions". The test-counterpart mapping and the wiring pairs come from an optional `glob_coverage` table in the repo's `.xarabot/config.yaml`; with no table the rule is off. Xarabot's own table is added in a later Maintainer PR, once every lane's runner knows the key.
  - **Decide an Epic's open questions before it starts.** When a status planning unit compiles an Epic's context for the first time (no context file on `main`), it also reads every Story of that Epic and lists each design question the acceptance criteria and the recorded Maintainer decisions leave open: the kind a build session would stop on as an `intent-gap`. If there are any, it compiles no context, ends `blocked`, and names each question, by Story, in one batch for the Maintainer. Until the Maintainer records the answers and releases the unit, that Epic has no context file, so none of its Stories is claimed. Applies from Epic 5 on. Routed as Epic 3 retro item 15.
  - **A cadence change counts its forge calls (2026-10-29; Epic 3 retro E3).** A change to lane cadence (waits, due rules) lists the forge calls each start and round makes and checks them against the forge's limits (GitHub: 60 an hour unauthenticated, per IP). Epic 2 retro item 26's 1-minute idle wait exhausted that limit and stopped both lanes until item 36 cached the bot's user id.
- **Item 7, the correct course for Epic 3's drift (2026-10-29; `sprint-change-proposal-2026-10-29.md`):**
  - **Takeover re-reviews (A6):** accepted as built. After a blocking round, a takeover clears the review SHAs, keeps `loopbacks`, and builds and reviews afresh; it never enqueues (Story 3.5 amended above).
  - **Codex usage limits with no `rate_limits` (C4):** no code change now. Before codex runs unattended, the Maintainer captures a real over-limit codex session (its `--json` output and rollout file), and the fix is decided from that. Item 18.
  - **A no-output watchdog (C6):** deferred for 0.x (spine, Deferred). Any watchdog must watch vendor-home or temp-folder activity, since `claude -p` is silent until it ends.
  - **`lane install` checks the lane's own agent (A9):** it refuses an agent outside `main`'s `unattended_adapters`, as lane start does. Item 16.
  - **A real `bmad-build-auto` codex canary (A9):** one recorded real-skill codex run before any `agent: codex` builder lane; codex may review without it. Item 18.
  - **The review prompt's agent-config line (C7):** reworded so a committed agent-config change counts as part of the change. Item 17.
  - **Xarabot's own `glob_coverage` table (A10's tail):** added by the Maintainer once every lane's runner tag includes #276. Item 19.
  - Items 18 and 19 are recorded `deferred`: each waits on an event (a codex builder lane, a runner tag), so neither holds Epic 5.

## Epic 4: Epics run in parallel behind retro and checkpoint gates, ruled from one inbox

Epics start as soon as the graph allows, retro items and checkpoints hold exactly the Epics they should, and each owner rules on everything waiting on them from one daily inbox digest, by comment command.

### Story 4.1: Retro-item distance gates

As the Maintainer,
I want an open retro item to hold back only the Epics it should,
So that untagged follow-ups are worked alongside later Stories, while a `blocking` item stops its Epic's dependents (FR10, AR13).

**Acceptance Criteria:**

**Given** the resolved graph and Epic E's retro items in `retro-gates.yaml`
**When** the pure gate computes distance along dependency edges from E
**Then** a `blocking` item holds every Epic at distance 1 or more, and any other open item holds every Epic at distance 2 or more
**And** items with status `open`, `in-progress` or `waiting` count as open, and `deferred` and `done` do not.

**Given** E's retro verdict `rejected` and no `go retro:<E>` recorded in `retro-gates.yaml`
**When** the pure gate runs
**Then** it holds every Epic at distance 1 or more, as a `blocking` item does
**And** a verdict of `accepted` or `accepted-with-open-items` holds nothing by itself, and a recorded `go retro:<E>` releases a rejected one.

**Given** `next` for a builder
**When** an Epic is held by a retro item or a rejected retro
**Then** it takes no new Stories from that Epic, and the idle reason names the item or the rejected retro.

**Given** a graph change or a tag change
**When** a Story was already claimed
**Then** it finishes; the change takes effect at the next claim.

**Given** the FR10 case table
**When** it runs
**Then** an untagged open item from E does not gate an Epic one step from E but does gate one two steps away, and a `blocking` item gates every Epic depending on E, directly or through others
**And** a `rejected` verdict on E gates every Epic depending on E until `go retro:<E>` is recorded, and no longer after it.

**Maintainer decision (2026-10-26, Story 4.1's deferral):** a takeover finishes in-flight work; it is not "the next claim". A held Epic takes no new Stories, but a stale `claimed` Story, or a builder-held `merging` one, in an Epic that becomes held is still taken over as usual. A crashed lane's PR is therefore never stranded behind a hold that came after its claim. This applies to every Epic hold: dependency, retro-rejected, retro-item, and Story 4.4's checkpoint holds ("Epics already in flight finish the Stories they hold"). It is routed as Epic 3 retro item 13.

### Story 4.2: Owner inboxes and the daily digest

As an owner,
I want one inbox listing everything waiting on me, kept current and announced once a day,
So that I rule on it in one sitting with no other per-item notices (FR9, AR24).

**Acceptance Criteria:**

**Given** an owner
**When** the coordinator first needs their inbox
**Then** it finds or creates one issue labelled `xarabot-inbox` and assigned to that owner; on a solo repo the Maintainer's inbox is the only one.

**Given** a `reconcile` run
**When** `renderDigest` renders an owner's issue body from the ledger's `parked` records, PR states and `retro-gates.yaml`
**Then** it lists their bot's PRs awaiting approval and their blocked units, each with its link, its age and the ruling verbs that apply
**And** it rewrites the body only when its content changed; GitHub sends no notification for a body edit.

**Given** the Maintainer's inbox
**When** the digest is rendered
**Then** it also lists checkpoint gos waiting, Infrastructure Stories needing approval, Maintainer-routed retro items, rejected retros with their course-correction item and the `go retro:<N>` ruling, graph-changing PRs awaiting approval, Story headings with no manifest outside the Epics listed in `bootstrapped_epics`, and units waiting on a Human Live Step (`blocked.kind: human-live-step`)
**And** it lists each `deferred` entry of a merged Story spec, with its spec, until a later spec names it, so a deferral is never lost between Stories (Epic 1 retro item 12).

**Given** a unit parked `blocked` with text (a build result's `blocked.text`, or a status or graph planning unit's readiness findings in `summary`)
**When** the runner parks it
**Then** it stores the sanitized text, capped below the forge's limit, in `park.text` (AR6; ledger `schema_version` + 1), and the digest lists it under the item.

**Given** config `digest_time` (default `08:00` UTC), added to the config schema
**When** the first `reconcile` run at or after that time each day runs
**Then** it posts one @mention comment per inbox, linking the body, and records the post time in `coordinator.json`
**And** no other digest comment is posted that day, whether or not the body changed.

**Given** a lane whose `next` returns `idle` only because of a checkpoint go, a parked approval, a rejected retro or a Maintainer-routed item
**When** it records the span in `journal.jsonl`
**Then** the span's reason is `waiting-on-maintainer`, not `idle` (AR25).

**Given** a condition that newly stops every lane
**When** it occurs
**Then** the alert from Story 1.10 notifies at once, and is the only notice outside the digest.

**Given** the forge contract suite
**When** it runs
**Then** the fake and GitHub adapters pass the `renderDigest` cases
**And** `docs/maintainer/self-host.md` adds the Human Live Step of pinning the Maintainer's inbox issue once by hand.

**Given** Story 2.4's `reconcile` due rule
**When** this Story stamps `digest_posted_at` on each digest
**Then** it adds back "the daily digest time passed with no digest posted" as `reconcile` work, which Story 2.5 left out until now; the due-rule case table gains its cases.

**The Maintainer's decisions of 2026-10-26 (this Story's intent gap, from its draft spec's open questions):**
1. **Deferred entries are named by id.** Each entry of a Story spec's `deferred` list has the id `<story-id>-d<n>`, where `n` is its 1-based position in that list. The list is append-only, so an entry in an older spec with no `id` key has the same id by position. New entries write it as `id:` (`_bmad/custom/bmad-build-auto.toml`). A spec names an entry it settles in a frontmatter `resolves: [<id>, …]` list. The digest lists each `deferred` entry of a merged Story spec until a spec merged after it names the entry's id in `resolves`. "Later" means merge order, not Story id order.
2. **`waiting-on-maintainer` is the existing `idle` span** with a reason starting `waiting-on-maintainer:`, as Story 2.9's live-evidence rule already writes. It is not a new span value. A lane is idle "only because of" Maintainer causes when every reason it idles for is a Maintainer cause.
3. **Inbox noise.** An inbox with nothing in it gets no daily mention. `reconcile` enumerates every inbox issue, so a body left stale by an owner who no longer holds any record is cleared.
4. **Ruling verbs:** the digest shows only AR29's fixed verbs for each item kind (`go`, `done`/`defer`, `approve`). This Story adds no verbs.
5. **Mention posts are at-most-once.** The runner stamps the post time before it posts. A failed post loses that day's mention and never re-posts to every inbox.
6. **Scope:** open Escalations stay in Story 7.6. Waiting checkpoint gos are listed by this Story.

### Story 4.3: Batch routing of Maintainer-only retro items

As the Maintainer,
I want retro items routed to me to land in my inbox in one batch, by runner code,
So that no agent session is spent only to route items to me (FR9, AR14, AR24).

**Acceptance Criteria:**

**Given** a retro whose items include ones with `route: maintainer`
**When** `reconcile` writes `retro-gates.yaml`
**Then** those items are set to `waiting` in the same runner-written PR, with no agent session.

**Given** routed items
**When** the next digest is rendered
**Then** each appears once in the Maintainer's inbox with its id, text, Epic and age.

**Given** routed items
**When** `next(snapshot, 'coordinator')` reaches retro items
**Then** they are never returned as `retro-item` units.

**Given** a routed item
**When** the Maintainer rules `done` or `defer` on it (Story 4.6)
**Then** `reconcile` sets its status to `done` or `deferred`, and it leaves the inbox and stops counting as open (AR13).

### Story 4.4: Checkpoints

As the Maintainer,
I want a checkpoint Epic to hold only the Epics that depend on it until I say go,
So that independent Epics keep running while I review a checkpoint (FR5, AR12, AR13).

**Acceptance Criteria:**

**Given** a checkpoint Epic C with its retro done and no go recorded
**When** `next` runs
**Then** every Epic depending on C, directly or through others, takes no new Stories, and Epics not depending on C keep running
**And** Epics already in flight finish the Stories they hold and take no new ones.

**Given** C's retro done and no go recorded
**When** the Maintainer's digest is rendered
**Then** it lists the go; no unit runs, and `checkpoint:<C>` is only the target of the `go` ruling (AR14).

**Given** a checkpoint added after C's retro
**When** the next claim happens
**Then** C's dependents are held from that claim until the go.

**Given** a go recorded
**When** `next` runs
**Then** C's dependents become eligible.

**Given** a PR that removes `checkpoint: true` from C
**When** C has no recorded go
**Then** the graph-change gate parks it, blocked; with a go recorded it may be retired, and the go record stays.

**Given** the case tables
**When** they run
**Then** dependents at distance 1 and 2, a sibling not depending on C, an in-flight Epic and a late-added checkpoint each have a case
**And** the digest cases cover C's retro done with no go, and C with its go recorded.

**Maintainer decision (2026-10-27, from Story 4.4's review):** a hold that exists only because of a wait on the Maintainer counts as a Maintainer cause, through the dependency chain. An Epic's `dependency-epic` hold on an Epic that is itself held only by Maintainer causes (a checkpoint with its retro done and no go, a rejected retro with no go, or a Maintainer-routed retro item) is a Maintainer cause too. So a builder idle only behind a checkpoint go records `waiting-on-maintainer:` however deep the chain is. This applies Story 4.2's every-reason rule; it does not loosen it. A lane cause anywhere in the chain still keeps the prefix off.

### Story 4.5: Rulings: grammar, authority and cursor

As the Maintainer,
I want to rule by commenting `/xarabot <verb> <unit-id>` on an inbox issue, and to have only authorized rulings count,
So that parked units, checkpoints and approvals have one way to clear, and nobody else can clear them (FR9, AR29).

**Acceptance Criteria:**

**Given** comments on inbox issues
**When** `reconcile` runs
**Then** it reads new comments through `Forge.readRulings(cursor)`, from the cursor kept in `coordinator.json`, and advances the cursor in the same ledger swap that applies the rulings.

**Given** the pure ruling parser
**When** it reads a comment
**Then** it accepts only `/xarabot <verb> <unit-id>` with a verb of `go`, `approve`, `block`, `unblock`, `done`, `defer`, `rebuild`, `release` or `dismiss` and a unit id in AR35 form, and ignores any other text
**And** `go` applies to a `checkpoint:<epic>` unit, or to a `retro:<epic>` unit whose verdict is `rejected`
**And** `done` and `defer` apply only to a `retro-item:<id>` unit.

**Given** the author of a ruling
**When** its authority is checked
**Then** `go`, `approve`, `block`, `unblock`, `done` and `defer` count only from the Maintainer named in config, and `rebuild`, `release` and `dismiss` count from the item's owner or the Maintainer.

**Given** a ruling that is malformed, unauthorized, or names a unit the verb doesn't apply to
**When** `reconcile` handles it
**Then** nothing changes, and it replies with a 🤖 comment giving the reason.

**Given** a valid ruling
**When** it is applied
**Then** `reconcile` replies with a 🤖 acknowledgement naming the verb and unit.

**Given** the case tables
**When** they run
**Then** each verb, each author class and each malformed form has a case, and `go` has a case on a rejected retro and on a retro that is not rejected.

### Story 4.6: Rulings: what each verb does

As the Maintainer,
I want each ruling to make exactly its defined change to the ledger or `retro-gates.yaml`,
So that a ruling clears what it names and nothing else (FR5, FR9, FR10, FR13, AR29).

**Acceptance Criteria:**

**Given** `/xarabot go checkpoint:<epic>`
**When** `reconcile` applies it
**Then** the go is recorded in `retro-gates.yaml` by runner code, and the Epic's dependents become eligible at the next claim.

**Given** `/xarabot go retro:<N>` for an Epic whose retro verdict is `rejected`
**When** `reconcile` applies it
**Then** the go is recorded in `retro-gates.yaml` by runner code, the course-correction item leaves the Maintainer's inbox, and the rejected verdict no longer holds Epic N's dependents from the next claim.

**Given** `/xarabot approve story:<id>` for a parked Infrastructure Story
**When** `reconcile` applies it
**Then** the ledger records `approval` with the Maintainer's login and the current `manifest_sha`, and the record becomes `released`
**And** a later change to the manifest voids the approval.

**Given** `/xarabot block` or `unblock` on a retro item
**When** `reconcile` applies it
**Then** the item's `blocking` tag in `retro-gates.yaml` changes, and the gates follow at the next claim.

**Given** `/xarabot release <unit>`
**When** `reconcile` applies it
**Then** the record becomes `released` with `attempts`, `loopbacks` and `ci_fixes` set to 0 and `builder_providers[]` kept.

**Given** `/xarabot rebuild <unit>`
**When** `reconcile` applies it
**Then** it closes the unit's open PR, clears `reviewed_sha`, `passed_sha` and `builder_providers[]`, sets the counters to 0, and the record becomes `released`.

**Given** `/xarabot dismiss <unit>`
**When** `reconcile` applies it
**Then** only the inbox item goes; the ledger is unchanged.

**Given** `/xarabot done retro-item:<id>` or `/xarabot defer retro-item:<id>`
**When** `reconcile` applies it
**Then** runner code sets the item's `status` in `retro-gates.yaml` to `done` or `deferred`, and the gates follow at the next claim (AR13).

**Given** `xarabot rule <verb> <unit-id>` on the Xarabot host (Story 2.5b)
**When** this Story is done
**Then** it applies every verb above with the same edit as the comment ruling (AR29).

**Given** any ruling
**When** it is applied
**Then** no agent session runs, and the write check still refuses any agent diff that changes a verdict, an item or a go (Story 2.3).

**The Maintainer's decisions of 2026-10-27 (this Story's intent gap, from its draft spec's open questions):**
1. **A `retro-gates.yaml` ruling waits in a pending list until `main` shows it.** `go`, `block`, `unblock`, `done` and `defer` are written by `reconcile`'s PR. Each acknowledged one goes into a pending list in `coordinator.json`, in the same ledger swap that moves the rulings cursor. `reconcile` re-applies every pending ruling on each run until `main`'s `retro-gates.yaml` shows it, then drops it. So a ruling survives a PR that never opens, is closed or fails CI, and a run that dies in between. `xarabot rule` writes the same pending entry.
   - The new `coordinator.json` fields ride Story 4.2's ledger `schema_version` 6, because no runner tag has shipped 6 yet. There is no bump to 7, and every lane's runner pin still advances together at the tag that carries 6.
2. **`dismiss` is kept in `coordinator.json` too.** Each dismissal names the item's id and the instance it dismissed: its subject and its start time. The digest leaves out an item matching a stored dismissal. The dismissal expires, and is dropped, once that item comes back as a new instance, meaning its subject or start time changes, so a fresh problem is never hidden. It changes no unit record or retro gate; the spine's `dismiss` line says so.

### Story 4.7: Parallel Epics and gates verification

As the Maintainer,
I want proof that Epics run in parallel exactly as the graph allows and that the gates hold,
So that a consuming repo can turn on parallel Epics with evidence (FR5, FR10).

**Acceptance Criteria:**

**Given** a graph fixture shaped like Xaravel Phase 1 (`runtime`, then `contracts`, then `macroable`, `conditionable` and `json-schema` each depending on `contracts`)
**When** `runtime` and then `contracts` are done with their retros
**Then** `next` hands builders Stories from all three later Epics at once.

**Given** the same fixture with `contracts` as a checkpoint and its go pending
**When** builders run
**Then** the dependent Epics take no new Stories, and an Epic not depending on `contracts` keeps running.

**Given** the same fixture with `contracts`' retro verdict `rejected`
**When** builders run
**Then** the Epics depending on `contracts` take no new Stories until `/xarabot go retro:<N>` for `contracts` is recorded, and take Stories after it.

**Given** the scratch repo with a checkpoint pending
**When** the Maintainer comments `/xarabot go checkpoint:<epic>` on the inbox issue
**Then** the next `reconcile` records the go and acknowledges it, and the dependents' Stories are claimed afterwards.

**Given** retro items on the fixture
**When** the gates run
**Then** the FR10 cases hold end to end through `next`.

**Given** the scratch repo's inbox
**When** the digest is rendered
**Then** every waiting item appears once, with its link and age.

**Given** `docs/maintainer/self-host.md`
**When** the Story is done
**Then** it records this suite's live command (`XARABOT_LIVE=1 bun test <suite>`) and the expected result of each scratch-repo case above, which the Maintainer runs on the host, outside the sandbox, before Epic 4's retro
**And** inside a sandboxed session the live cases are reported as skipped, never as passed.

## Epic 5: Each human runs lanes as their own bot

`xarabot join` creates a person's `<login>-xarabot` App from a manifest and installs it, or requests the install, replacing `bootstrap/join.ts`. A lane whose installation does not cover its repo stops and names the repo to add. The owner's approval is what makes their bot's Protected Path PRs mergeable; the bot's own review never is.

### Story 5.1: `xarabot join` creates the owner's App

As a human joining a repo,
I want one command that creates my own `<login>-xarabot` App with one confirm click and stores its key for the runner,
So that my lanes can act as my bot with no long-lived token and no shared identity (FR13, NFR9, AR27).

**Acceptance Criteria:**

**Given** `xarabot join --repo <owner/name>`
**When** no App record exists for the caller's login
**Then** it serves the App manifest on `127.0.0.1`, opens GitHub's manifest page, and on the callback (with a matching `state`) converts the code into the App
**And** it writes `private-key.pem` (mode 600, in a folder of mode 700) and `app.json` with the App ID, slug and owner at `$XDG_CONFIG_HOME/xarabot/apps/<login>-xarabot/`, falling back to `~/.config`, and never prints the key.

**Given** the pure manifest builder
**When** it runs
**Then** the manifest names `<login>-xarabot`, is public so other orgs can install it, has no webhook, and asks for exactly `contents: write`, `pull_requests: write`, `issues: write`, `checks: read`, `statuses: read`, `actions: read` and `metadata: read`, with no merge-queue permission (AR38)
**And** it never asks for `administration`, `workflows` or any bypass right, and a test pins the permission set.

**Given** an App record already present
**When** `xarabot join` runs again
**Then** it skips creation
**And** if the existing App lacks a permission in the manifest, it stops and names each permission to add in the App's settings (a Human Live Step), because GitHub does not let the API change it.

**Given** JWT minting and installation tokens
**When** `xarabot join` needs them
**Then** it uses the GitHub adapter's code from Story 1.8; there is one implementation.

**Given** `xarabot join` working
**When** the Story is done
**Then** `bootstrap/join.ts` is removed, and `docs/maintainer/self-host.md` points to `xarabot join` instead.

### Story 5.1a: The GitHub adapter's permission table

As the Maintainer,
I want every GitHub call the adapter makes to name the App permission it needs, in one table checked against the App manifest,
So that each owner's App asks for exactly the rights Xarabot uses, and no call needs a right the App lacks (FR13, NFR9, AR27).

**Acceptance Criteria:**

**Given** the GitHub adapter
**When** it calls GitHub
**Then** every REST and GraphQL operation goes through one request function that takes an entry from a single table in the adapter, naming the operation and the App permission it needs, and no other code in the adapter calls `fetch`.

**Given** that table
**When** it is checked
**Then** it has an entry for `metadata: read`, which GitHub grants every App
**And** git pushes, which go through the credential helper and not `fetch`, are listed under `contents: write`
**And** `xarabot join`'s manifest-conversion and App-JWT calls are listed as needing no installation permission.

**Given** that table and the manifest from Story 5.1
**When** the permission test runs
**Then** it fails if any operation needs a permission the manifest does not ask for, or at a lower level than the operation needs
**And** it fails if the manifest asks for a permission no operation needs, so the set stays exactly what Xarabot uses.

**Given** the permission table in the architecture spine's AD-26 (AR27)
**When** the Story is done
**Then** the adapter's table matches it, and any difference is raised to the Maintainer instead of decided in the Story.

**Maintainer decision (2026-10-30, `planning:status.1`'s open question):** AD-26's table records the three calls the adapter already makes, as built. `deleteRef` is listed under `contents: write`. The bot user lookup (`GET /users/<slug>[bot]`) and the CI log download from GitHub's signed URL are listed in the no-token row, as public calls with no credential. The signed download must never carry the token. The spine's AD-26 is updated to match.

**Maintainer decision (2026-10-30, `planning:status.1`'s second open questions):** the adapter's table lists only the calls the adapter makes today. AD-26's `administration: read` row (branch-protection reads, which the App never has) is not added here: Story 7.5 adds it with the reads themselves, together with the permission test's exemption for a permission the App deliberately lacks.

### Story 5.2: Installing the App and checking its reach

As a human joining a repo,
I want `xarabot join` to install my App on the repo's org, or request the install, and to check that it reaches the repo,
So that adopting Xarabot in a repo needs no further GitHub step, or tells me exactly which one (FR13, AR22).

**Acceptance Criteria:**

**Given** an App with no installation on the repo's org
**When** `xarabot join` runs
**Then** it opens the App's install page with "All repositories" as the default, and waits up to 15 minutes for the installation to appear
**And** a caller who is not an org owner is told that GitHub sends an install request for an owner to approve, and a re-run picks up the approved installation.

**Given** an installation
**When** `xarabot join` verifies it
**Then** it mints an installation token, lists the repositories it reaches, and prints the installation's scope, the bot login `<login>-xarabot[bot]` and its commit identity.

**Given** a selected-repositories installation that does not cover the repo
**When** `xarabot join` runs
**Then** it stops, naming the repo to add and where to add it; a lane start for that repo is refused by Story 1.19's check.

**Given** the waits in `xarabot join`
**When** they run
**Then** each is a killable sleep with a deadline, and no `timeout` binary is called (AR3).

**Given** the CLI tests
**When** they run against a fake GitHub
**Then** the create, re-run, install, install-request and uncovered-repo paths each have a case.

### Story 5.3: Owner approvals and bot rights verification

As the Maintainer,
I want proof that my bot cannot approve or force a merge, and that my own approval clears its Protected Path PRs at once,
So that the bot is never more than its owner's hands (FR13, AR17, AR27).

Precondition (Human Live Step): the Maintainer provides a test org with an App created there by `xarabot join` through the browser confirm click, installed on a test repo whose Protected Path requires the owner's review.

**Acceptance Criteria:**

**Given** a test org with an App created by `xarabot join` and a Protected Path that requires the owner's review
**When** the verification suite runs
**Then** the bot opens a PR touching that path, and the PR is not mergeable until the owner approves it.

**Given** that PR
**When** an APPROVE review is submitted with the bot's own installation token
**Then** the PR still is not mergeable on that review
**And** the source has no code path that submits an approving review, which a test asserts against the `Forge` port and the GitHub adapter.

**Given** the owner's approving review on the PR's head
**When** `reconcile` next runs
**Then** it enqueues the PR, and it merges straight away on its required checks and the cross-vendor review.

**Given** the bot's token
**When** the suite tries an admin merge or a bypass of required checks
**Then** GitHub refuses it, and the adapter has no such code path.

**Given** every lane-made commit and PR in the suite
**When** it is inspected
**Then** it is authored by `<login>-xarabot[bot]`.

**Given** `docs/maintainer/self-host.md`
**When** the Story is done
**Then** it records this suite's live command (`XARABOT_LIVE=1 bun test <suite>`) and the expected result of each case above, which the Maintainer runs on the host, outside the sandbox, against the test org, before Epic 5's retro
**And** inside a sandboxed session the live cases are reported as skipped, never as passed.

**Maintainer decision (2026-10-30, `planning:status.1`'s second open questions):** GitHub App names are global and `edanisko-xarabot` already exists, so the precondition's App is made by a second GitHub account. That account runs `xarabot join`, which creates `<that-login>-xarabot` and installs it on the test org's repo. That account is the owner whose review clears the PR in the cases above, and it provides the Human Live Step.

## Epic 6: Operators can see and measure every lane

`xarabot status --json --watch` reports every lane's unit, claim, CI and merge state and the inbox; the TUI draws it locally or over `ssh $XARABOT_HOST`; `xarabot report` compares agents and models and computes Stories per hour. All of it reads; none of it decides (AR25).

### Story 6.1: `xarabot status --json`

As an operator,
I want one command that reports the state of every lane on a host as JSON,
So that the TUI, scripts and dashboards all read the same status (FR12, AR25, AR28).

**Acceptance Criteria:**

**Given** a host with lanes for one or more repos
**When** `xarabot status --json` runs
**Then** it prints one document, valid against the status schema in `src/core/schemas/`, with each lane's identity, role, agent, model and effort; its state (running a unit, waiting with its reason, idle, stopped by STOP); its unit and claim (`generation`, heartbeat age); and its PR, CI and merge-queue state.

**Given** each repo on the host
**When** status is built
**Then** it includes the inbox summary per owner (item count and oldest age) and a progress line: Stories done of Stories planned, with a loose ETA from the recent merge rate.

**Given** the lane state folders and one `Forge.snapshot()` per repo
**When** status is built
**Then** it is read-only: a test asserts that no ledger swap, push, PR change, enqueue, comment or file write happens.

**Given** a forge that cannot be reached
**When** status runs
**Then** it still reports the local lane state and marks the forge fields unavailable with the error kind.

**Maintainer decision (2026-10-30, `planning:status.1`'s fourth open question):** the ETA's merge rate comes from the host's builder journals: unit records for Stories that end `merged`, over the last 7 days (or since the first such record, if newer). While every path needs the Maintainer's approval, `reconcile` merges most Stories and the ETA runs long; it is a loose estimate, and no forge read or graph change is added for it.

### Story 6.2: Watching status, locally and over ssh

As an operator,
I want `xarabot status --json --watch` to keep reporting as things change, on the host or from my laptop,
So that I can follow lanes live without logging in to the Xarabot host (FR12, AR25).

**Acceptance Criteria:**

**Given** `xarabot status --json --watch`
**When** it runs
**Then** it prints a new status document as one JSON line whenever lane state changes, and at least every 30 seconds otherwise, with forge reads rate-limited to stay within API limits.

**Given** a watch over `ssh $XARABOT_HOST xarabot status --json --watch`
**When** the ssh session ends or the process receives SIGINT or SIGTERM
**Then** the watch exits at once, leaving no child process.

**Given** `XARABOT_HOST` set on a laptop
**When** `xarabot status --json --watch --host` runs
**Then** it runs the same command over ssh on that host and relays its lines unchanged.

**Maintainer decisions (2026-10-30, `planning:status.1`'s second open questions):**
- **What runs on the host.** `xarabot lane install` also writes a fixed launcher, `~/.xarabot/bin/xarabot`, beside `xarabot-lane`. It runs the runner version named in the lane `runner` file written most recently (corrected 2026-10-30, `planning:status.1`'s third open questions: version names are free-form, such as `runner-14` or an npm pin like `0.3.0`, so they have no order; the latest-written `runner` file always names a version some lane pins now, and after a pin-back it follows the pin-back). The ssh command runs that launcher.
- **The flag.** `--host` is a bare switch, here and on `xarabot tui` (Story 6.3), and `XARABOT_HOST` supplies the host's name (FR12). `XARABOT_HOST` alone never switches a command to ssh.

### Story 6.3: The TUI

As an operator,
I want a read-only terminal view of every lane and the inbox that refreshes itself,
So that I see at a glance what each lane is doing and what is waiting on me (FR12, AR25).

**Acceptance Criteria:**

**Given** `xarabot tui`
**When** it runs on the host
**Then** it draws the status stream from `xarabot status --json --watch`: one row per lane with its unit, claim, CI and merge state, and the inbox summary below.

**Given** `xarabot tui` on a laptop with `XARABOT_HOST` set
**When** it runs
**Then** it draws the same view from the stream over `ssh $XARABOT_HOST`, and refreshes on its own.

**Given** the TUI
**When** it runs
**Then** it has no key or command that acts on lanes, claims or PRs; it only reads the stream, and quits on `q` or Ctrl-C.

**Given** the TUI
**When** it is built
**Then** it draws with plain ANSI output and adds no runtime dependency, and its rendering is tested against golden frames from fixture status lines.

**Maintainer decision (2026-10-30, `planning:status.1`'s open questions; corrected the same day):** the TUI switches to ssh only with `--host`, a bare switch as on `status` (Story 6.2), and `XARABOT_HOST` supplies the host's name. Without `--host`, it reads the local host's stream. `XARABOT_HOST` is host-layer config and may be set on the host itself, so it never switches the TUI to ssh by itself. This replaces the laptop criterion above: with `XARABOT_HOST` set, `xarabot tui --host` draws the same view over `ssh $XARABOT_HOST`.

### Story 6.4: `xarabot report` and log retention

As the Maintainer,
I want a report that compares agents and models and computes the Stories-per-hour figure,
So that I can compare lanes and measure the 0.x success signal from Xarabot's own journals (FR11, NFR22, AR25).

**Acceptance Criteria:**

**Given** `xarabot report --from <time> --to <time>`
**When** it runs over the host's lane journals
**Then** it shows, per agent and model: units done, median unit time, first-pass review rate (units whose first review passed), CI-fix count and cost, with subscription cost labelled an estimate.

**Given** the same period
**When** the report computes Stories per hour
**Then** it divides merged Stories by wall-clock hours, leaving out hours when every lane's journal span is `waiting-on-maintainer`, and counts all lanes and adapters with no Story-size normalization.

**Given** `xarabot report --json`
**When** it runs
**Then** it prints the same figures as a schema-valid document a consuming repo's dashboard can read.

**Given** lane logs and journals
**When** a lane process runs
**Then** logs older than 30 days are deleted, and journals are never deleted.

**Given** the report's case tables
**When** they run on fixture journals
**Then** each figure, an all-lanes-waiting span, a span where only some lanes wait, and an all-lanes `usage-limit` span, whose hours are not left out, each have a case.

**Maintainer decisions (2026-10-30, `planning:status.1`'s open questions):**
- **Merged Stories** are read from the forge: the Stories whose PR merged within the period, by merge time. Journals alone miss or misattribute a Story that `reconcile` merged, since it gets a `merged` record only if a builder's sweep marks it first.
- **Hours when every lane waits on the Maintainer** count builder lanes only. Each builder's `waiting-on-maintainer` span lasts until that lane's next journal record, and the hours left out are where every builder's span overlaps. The coordinator is not counted, because it runs `reconcile` at least every 10 minutes and its idle spans record only the seconds of a round.

**Maintainer decisions (2026-10-30, `planning:status.1`'s third open questions):**
- **Per repo.** The report gives one figure per repo: each repo's merged Stories over its own builders' spans, so a host that also runs Xarabot's lanes still gives the SPEC's figure for Xaravel's work.
- **The forge read.** This Story adds the read of PRs merged in a period to the `Forge` port, the GitHub and fake forges, and the forge contract suite. Its manifest globs are widened to cover them (`src/ports/forge.ts`, `src/adapters/forge/**` and their tests and contracts), with no graph change.

**Maintainer decisions (2026-10-30, `planning:status.2`'s open questions):**
- **Units done** are the unit journal records whose result is `done`, of every unit kind, including one that then parks awaiting approval. The median unit time and the first-pass review rate are taken over the same records. The Stories-per-hour figure still counts merged Stories from the forge.
- **Review cost** goes on the builder's row: the agent and model of the unit record, which today includes its review passes' tokens and cost. The report says that a row's cost includes its reviews, whoever the reviewer was. No journal field is added.

**Maintainer decisions (2026-10-31, `planning:status.1`'s fourth open questions):**
- **Coordinator results.** This Story makes the coordinator fill the unit record's existing `result` field from its session: a planning or retro-item unit that finishes reports `done`, and a retro whose document validates reports `done`. `reconcile` runs no session and never counts. From then on, coordinator units count as units done on the coordinator's agent and model row; older records with `result: null` do not.
- **First-pass review rate.** This Story adds an optional journal field for the first review's verdict on a unit record. The rate is units whose first review passed over units with that field, so a unit that never reached review (a write-check park, a crash before review) and older records without the field are left out. This field is the one exception to the review-cost decision's "no journal field".

### Story 6.5: Status and report verification

As the Maintainer,
I want proof that the report's numbers and the live view are right,
So that I can trust the success-signal figure and the TUI during Xaravel's adoption (FR11, FR12).

**Acceptance Criteria:**

**Given** a fixture journal for a stated 7-day window, with `waiting-on-maintainer` spans (Story 4.2) and `usage-limit` spans (Story 1.18), and a hand-computed Stories-per-hour figure
**When** `xarabot report` runs over it
**Then** it reproduces that figure exactly.

**Given** the Xarabot host with lanes running
**When** the operator runs `xarabot tui` on a laptop with `XARABOT_HOST` set
**Then** it shows the live state of every lane and refreshes on its own, and the same command works locally on the host.

**Given** the status and report commands
**When** they run during a lane's unit
**Then** the lane's ledger record, journal and outcome are unchanged by them.

**Given** `docs/maintainer/self-host.md`
**When** the Story is done
**Then** it records the live checks, each with its command (`XARABOT_LIVE=1 bun test <suite>`, and `xarabot tui` on a laptop with `XARABOT_HOST` set) and expected result, which the Maintainer runs on the host and the laptop, outside the sandbox, before Epic 6's retro
**And** inside a sandboxed session the live cases are reported as skipped, never as passed.

**Maintainer decision (2026-10-30, `planning:status.1`'s second open questions):** following Story 6.3's decision, the laptop check above and its runbook entry run `xarabot tui --host` on a laptop with `XARABOT_HOST` set; on the host, `xarabot tui` runs with no flag.

## Epic 7: Xarabot 0.x is ready for a consuming repo

A consuming repo adds `@xaravel/xarabot` with `bun add`, pins it exactly, and runs lanes on macOS or Linux. Lanes check the consumer prerequisites at start, upgrades arrive as PRs, each release has a changelog entry, and Xarabot supports what Xaravel's adoption needs, without performing that adoption (NFR17).

### Story 7.1: The consumer pin and package contents

As a consuming repo's Maintainer,
I want to add Xarabot as one exactly pinned dependency and supply only my own config, prompts, policy and manifests,
So that my repo holds no orchestration code and my lanes always run the version I pinned (FR1, AR26).

**Acceptance Criteria:**

**Given** the published package
**When** a consumer runs `bun add --exact @xaravel/xarabot@<version>`
**Then** the package carries the runner, the CLI, the schemas and the package prompt templates, and nothing the consumer must copy into its tree.

**Given** a consuming repo
**When** a lane starts
**Then** it refuses unless the repo's `@xaravel/xarabot` dependency is an exact version equal to `runner_version` in `.xarabot/config.yaml` on `main`, naming both values
**And** Xarabot's own repo, which has no such dependency, uses `runner_version` alone.

**Given** `docs/consumer-setup.md`
**When** the Story is done
**Then** it lists what a consumer supplies (`.xarabot/config.yaml`, `policy.yaml`, `prompts/`, `epics.yaml` when Epics run in parallel, the Standing Authority file, Story manifests, verification commands) and what it must never add (orchestration code, `_bmad/custom/` overrides), with a minimal example of each file validated by the schemas in a test.

### Story 7.2: Changelog and upgrades as PRs

As a consuming repo's Maintainer,
I want each Xarabot release to have a changelog entry and to reach my repo as a PR I approve,
So that I upgrade deliberately and can pin back (FR1, NFR11, NFR15).

**Acceptance Criteria:**

**Given** `CHANGELOG.md`
**When** the package version changes
**Then** a test fails unless `CHANGELOG.md` has an entry for that version.

**Given** `xarabot upgrade <version>` run by the Maintainer on the Xarabot host for a consuming repo
**When** it runs
**Then** it opens, as the Maintainer's bot, a PR that changes the exact pin and `runner_version` together, with no ledger unit
**And** the PR body carries that version's changelog entry
**And** the Maintainer approves the PR and adds it to the merge queue by hand; no lane and no `reconcile` run enqueues it.

**Given** a version not published, or older than the current pin
**When** `xarabot upgrade` runs
**Then** it stops with the reason; pinning back to an older version needs `--downgrade`, so recovery is one deliberate command.

**Given** that only the Maintainer releases, from CI
**When** the Story is done
**Then** `docs/maintainer/release-workflow.yml` holds a proposed publish workflow for the Maintainer to add to `.github/workflows/`; no code in the package publishes or handles publish credentials.

### Story 7.3: The Linux sandbox

As an operator on Linux,
I want the same sandbox boundary as on macOS, built with `bwrap`,
So that a Linux Xarabot host gives agents no GitHub credential or host either (FR18, NFR8, AR18).

**Acceptance Criteria:**

**Given** a Linux host with `bwrap` 0.13.1 or newer
**When** the sandbox launches a session
**Then** it uses `bwrap` with `--unshare-pid`, with the same read, write, environment and Unix-socket rules as the macOS profile (Story 1.11), and the proxy rules (Story 1.12).

**Given** a Linux host where `bwrap` is missing, or user namespaces are blocked
**When** a session is requested
**Then** it is refused, naming the cause; the sandbox never falls back to running unsandboxed
**And** `docs/consumer-setup.md` records that AppArmor packaging on Ubuntu 24.04+ is deferred and what the operator must allow.

**Given** the sandbox refusal suite and the proxy suite
**When** they run on Linux for each adapter
**Then** each case passes; on macOS the Linux cases are reported as skipped
**And** inside a sandboxed session (`XARABOT_SANDBOXED=1`) their nested cases are reported as skipped, and the Maintainer runs them live on the Linux host with Story 7.7's proof.

**Given** `claude` on Linux
**When** its vendor home is seeded
**Then** it holds only the Claude credential, which the lane process reads from the operator's `claude` credential file under `$XDG_CONFIG_HOME/xarabot/vendors/<vendor>/` and passes by the means the adapter documents for Linux (AR18).

### Story 7.4: Linux lanes under systemd

As an operator on Linux,
I want `xarabot lane install` to write systemd units with the same behaviour as launchd jobs,
So that a Linux machine can be a Xarabot host (FR4, AR3, AR26, AR34).

**Acceptance Criteria:**

**Given** a Linux host
**When** `xarabot lane install` runs
**Then** it writes a systemd user unit per lane with a restart throttle, checked against a golden file, that starts one process per unit through the fixed launcher `~/.xarabot/bin/xarabot-lane <repo> <lane>`, which runs the version named in the lane's `runner` file, as on macOS (Story 1.19).

**Given** a lane that fails to start 3 times in a row
**When** systemd restarts it
**Then** the lane writes its own `STOP` and posts an alert, as on macOS.

**Given** waits, `wake`, `stop` and `stop --now`
**When** they run on Linux
**Then** they behave as Story 1.18 specifies, by exact PID with start-time checks read from `/proc`.

### Story 7.5: Consumer prerequisite checks at lane start

As a consuming repo's Maintainer,
I want each lane to check the GitHub settings Xarabot relies on before it starts,
So that a missing setting stops lanes with the step to fix instead of failing later in a merge (AR34).

**Acceptance Criteria:**

**Given** a lane start
**When** the prerequisites are checked through the `Forge` port
**Then** it verifies, where the API allows: a ruleset that blocks force-push and deletion of `xarabot/claims`, with no other ruleset matching it; the merge queue on `main`; squash messages set to PR title and body; Protected Paths requiring the owner's review, with stale approvals dismissed and approval of the most recent push required; and the App installed with `issues: write`.

**Given** a prerequisite verified missing
**When** the lane starts
**Then** it refuses to start and posts an alert naming the Human Live Step to perform.

**Given** a prerequisite the App's permissions cannot read, such as the branch-protection reads, which need `administration: read`, a permission the App never has
**When** the lane starts
**Then** it starts with a warning in its log naming that prerequisite as unverified, and the Maintainer's digest lists that prerequisite once as unverified.

**Given** a lane start
**When** the ledger holds a `claimed`, `merging` or `parked` record whose `owner` is another human
**Then** the lane refuses to start, naming that owner and unit; 0.x runs one owner per repo, and cross-owner takeover is v1 (AD-9).

**Given** the case tables
**When** they run against the fake forge
**Then** each prerequisite, missing and unverifiable, has a case.

**Maintainer decision (2026-10-30, Story 5.1a's open question):** this Story adds the `administration: read` row to the GitHub adapter's operation table with the branch-protection reads, and changes Story 5.1a's permission test to exempt a permission the App deliberately lacks; those reads report "unverified".

### Story 7.6: Adoption inputs for Xaravel

As Xaravel's Maintainer,
I want Xarabot to read what Xaravel's adoption Epic will supply,
So that the adoption needs only config and policy files on Xaravel's side (NFR17, AR43, AR45).

**Acceptance Criteria:**

**Given** an optional Escalation source added to the repo config schema, naming the Escalation directory (Xaravel: `conformance/escalations/`) and the decisions directory (Xaravel: `decisions/`)
**When** config is loaded
**Then** the source validates, and its absence changes nothing.

**Given** a configured Escalation source
**When** the pure Escalation reader runs, with Xaravel's rule from `tools/escalations/escalations.ts`
**Then** it reads Escalation files named `ESC-<story-id>-<n>.md` or `ESC-bot-<n>.md` from the Escalation directory, and for each the decision file in the decisions directory with the same file name as its Escalation file (e.g. `decisions/ESC-9.3-1.md`), carrying `decision: approved | rejected` and `escalation_sha256`
**And** an Escalation is open when its decision file is missing, invalid, or stale: its `escalation_sha256` is not the lowercase hex SHA-256 of the Escalation file's text with CRLF normalised to LF
**And** the case table has a case for each of these, for a valid decision, and for an Escalation file with CRLF line endings.

**Given** a snapshot of a repo whose config names an Escalation source
**When** it is taken
**Then** it carries each Escalation's id, Story id and status, open or decided, read from the snapshot's one `main` SHA.

**Given** a Story with an open Escalation
**When** `next` runs for a builder, or a lane or `reconcile` is about to enqueue its PR
**Then** the Story is not claimed and its PR is not enqueued: its record becomes `parked`, blocked, with `park.reason: escalation` and its globs released (AR8).
**And** once every Escalation on that Story has a valid decision, approved or rejected, the next `reconcile` releases the record without counting an attempt.

**Given** a repo config that names an Escalation source
**When** the coordinator renders the Maintainer's digest
**Then** open Escalations from that source are listed with their links and ages, each with the Story parked on it
**And** a unit whose build result is `blocked` with `blocked.kind: escalation` parks with its globs released, per AR8.

**Given** the Standing Authority frontmatter schema
**When** the Story is done
**Then** `docs/adoption/xaravel.md` gives the frontmatter Xaravel's MAINT file must gain (`schema_version`, `granted_by`, `granted_at`, `repo` and optional `expires`), validated by a test against the schema.

**Given** `docs/adoption/xaravel.md`
**When** the Story is done
**Then** it lists, as inputs for Xaravel's own course correction: the `component` path-key mapping in config; the Standing Authority path; the Escalation source; the Protected Paths additions; an `.xarabot/epics.yaml` example carrying Epic 8's checkpoint (`8: {depends_on: [7], checkpoint: true}`); and the effect of Story headings with no manifest
**And** each example file in it validates against the schemas in a test.

### Story 7.7: Consumer readiness verification

As the Maintainer,
I want proof on a throwaway consumer repo and a Linux host that 0.x works for a repo other than Xarabot's own,
So that Xaravel's adoption starts from evidence (FR1, FR4).

Precondition (Human Live Step): the Maintainer provides a throwaway consumer repo with the App installed and the prerequisites set, and a Linux host: a fresh VM on the Proxmox system, outside its k8s cluster, with systemd, user namespaces allowed, `bwrap --version` at 0.13.1 or newer, and outbound access to GitHub and the vendor APIs. Not an OrbStack machine on the macOS host, which shares the Mac's files and would test the wrong boundary.

**Acceptance Criteria:**

**Given** the throwaway consumer repo
**When** it runs `bun add --exact @xaravel/xarabot@<version>` from a local package build and installs a lane
**Then** the lane builds a Story end to end as the owner's bot.

**Given** a pin that differs from `runner_version`
**When** the lane starts
**Then** it refuses to start, naming both values.

**Given** a prerequisite removed on the consumer repo
**When** the lane starts
**Then** it refuses, naming the Human Live Step.

**Given** the Linux host
**When** a lane runs a unit there
**Then** the unit completes inside `bwrap` under systemd, and the sandbox and proxy suites pass on that host.

**Given** `xarabot upgrade`
**When** it runs on the consumer repo for a newer local build
**Then** it opens one PR changing the pin and `runner_version` together, with no ledger record, for the Maintainer to approve and queue by hand.

**Given** `docs/maintainer/self-host.md`
**When** the Story is done
**Then** it records this suite's live command (`XARABOT_LIVE=1 bun test <suite>`) and the expected result of each case above, and the nested Linux sandbox cases of Story 7.3; the Maintainer runs them on the macOS host and on the Linux host, outside the sandbox, with the credentials they need, before Epic 7's retro
**And** inside a sandboxed session the live cases are reported as skipped, never as passed.
