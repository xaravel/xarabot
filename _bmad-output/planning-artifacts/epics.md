---
status: draft
stepsCompleted: [1, 2]
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

FR4 [0.x] (CAP-4, Parallel lanes): One Xarabot host, a macOS or Linux computer set in config (`XARABOT_HOST`), runs a coordinator lane (retros, retro action items, planning) and N builder lanes (Stories only). Each builder has its own worktree, state folder and scheduled job (launchd or systemd). The host's builder limit is config (`XARABOT_MAX_BUILDERS`). Success: on Xaravel's Xarabot host, the coordinator and 2 builder lanes run for 24 hours with no unit built twice and no write to `sprint-status.yaml` or `retro-gates.yaml` from a builder.

FR5 [0.x] (CAP-5, Parallel Epics): Epics run at the same time, ordered by the dependency graph instead of strictly in sequence. An Epic starts once every Epic it depends on has all its Stories merged and its retro done. A checkpoint Epic holds only the Epics that depend on it, directly or through others, until the Maintainer's go. Success: in Xaravel Phase 1, after `runtime` and then `contracts`, Stories from the `macroable`, `conditionable` and `json-schema` Epics are in flight at once; while a checkpoint go is pending, Epics depending on the checkpoint Epic take no new Stories, and Epics not depending on it keep running.

FR6 [0.x] (CAP-6, Plumbing in code): CI polling, the merge queue, mergeability checks, conflict resolution in the status YAML files, status comments, the progress line and sleeping through usage limits run in Xarabot code. The agent session only does the unit's work and returns a JSON result. The lessons in `brownfield-xaravel.md` § Lessons (CI polling, Conflicts, Merges) bind this code. Success: the agent prompt carries no CI, merge or status instructions; every session's output validates against the result schema; a usage-limit hit makes the lane sleep until the reset instead of failing.

FR7 [0.x] (CAP-7, Agent adapters): Each lane runs its coding agent through an adapter: `claude`, `codex` or `pi`. Every adapter takes the same three lane settings: `agent`, `model` and `effort`. `effort` is one scale for all adapters (`low`, `medium`, `high`, `xhigh`, `max`), and each adapter maps it onto its CLI's own setting. `claude` and `codex` default to a top model (`claude-opus-5-5`, `gpt-6.1-sol`); a `pi` lane sets its model explicitly. Lane config can change model and effort. The consuming repo's policy says which adapters may run unattended. Success: the same unit runs to a valid JSON result through each adapter; a `claude` or `codex` lane with no `model` runs its adapter's default top model; a `pi` lane with no `model` refuses to start; switching agent, model or effort is a config change only; each adapter maps `effort` per `agent-adapters.md` § Model and effort, and a value an adapter cannot honor stops the lane at start instead of being dropped silently; a lane whose adapter the repo's policy does not allow unattended refuses to start unattended.

FR8 [0.x] (CAP-8, Cross-vendor review): Before a diff merges, the runner has it reviewed by an agent whose model comes from a vendor other than every model that built it. Vendor means the model's vendor, never the adapter's: Codex reviews Anthropic-built diffs, and Claude reviews the rest. The review binds to the commit it reviewed; any later agent change, such as a CI fix or a conflict resolution, re-runs it. Its findings are blocking review loopbacks. BMAD's own review hook may run for earlier feedback but never counts as this review. Success: every builder PR carries a review, naming the commit it reviewed, from a model vendor outside its builders'; no PR merges with blocking findings unresolved or with a diff other than the reviewed one; after 2 loopbacks, or when no allowed reviewer from another vendor is left, the unit does not merge and is listed in its owner's inbox.

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
- Sandbox (0.x): the coding agent runs with only its unit's worktree writable, with no GitHub credentials and no GitHub host.
- Write check (0.x): before the squash, the runner refuses a builder diff that touches coordinator-owned files, Story manifests, `.xarabot/**`, the Standing Authority file, `.github/**`, agent config (`.agents/skills`, `.claude/skills`, `AGENTS.md`) or Protected Paths. There are only three exceptions: an approved Infrastructure Story's Protected Paths, the unit's own BMAD Story spec file, and the `status:` line of its own Story file.
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

NFR2 (Models): `claude` and `codex` default to a top model and `pi` lanes name theirs; lane config can change them; Xarabot enforces no model floor.

NFR3 (Planning shape): 0.x reads the classic BMAD shape only: `epics.md`, `sprint-status.yaml` and Story manifests, plus the Epic graph file. The spec-folder shape (`stories.yaml`) waits until a consumer uses it.

NFR4 (No BMAD overrides): Xarabot runs stock BMAD skills. Anything else it needs comes from its own prompt template, its own files or artifacts the runner reads; it never writes or requires `_bmad/custom/` in a consuming repo.

NFR5 (Interactive skills stay with the Maintainer): lanes drive only BMAD skills with a headless run (`bmad-build-auto`, `bmad-retrospective`, `bmad-sprint-planning`). `bmad-create-epics-and-stories` and `bmad-correct-course` are run by the Maintainer; when a retro or a blocked unit calls for a course correction, it goes to the Maintainer's inbox.

NFR6 (Forges): GitHub (0.x) and local-only (v1), each behind one forge interface (FR24). GitLab and other forges come later.

NFR7 (No platform assumptions): Xarabot does not assume AWS, SSO, hardware signing keys, a Claude-only sandbox, a JavaScript repo or a particular repo layout; any of those is an optional repo-supplied integration.

NFR8 (Agents never touch GitHub, from 0.x): coding agents run sandboxed with no GitHub credentials (FR18). Only the Xarabot runner holds the bot's private key, mints its tokens and talks to GitHub: claims, pushes, PRs, CI polling and merges; in local-only mode the same holds for the local `main` and the claims ref. No session gets a GitHub token or reaches a GitHub host; a session that needs GitHub data reads files the runner fetched beforehand.

NFR9 (Identity): lanes act only as their owner's bot (FR13): never a shared bot, an org-owned App, a bot user account or a human's own account.

NFR10 (No co-author markers): no `Co-Authored-By` trailers or similar non-authoritative markers. The bot account is the only marker of lane-made work.

NFR11 (License and release): open source as `xaravel/xarabot`, MIT license, published to npm as `@xaravel/xarabot` and installed with `bun add`. Consumers pin it exactly. Releases are cut only by the Maintainer, from CI.

NFR12 (Xarabot builds itself): Xarabot has its own repo, BMAD plan, epics and changelog.

NFR13 (Bootstrap): a copy of Xaravel's `tools/orchestrator` runs against the Xarabot repo on the Xarabot host as `edanisko-xarabot` (created before bootstrap by `bootstrap/join.ts`, which `xarabot join` later absorbs), with no admin merges, and builds only the first Epic: a single `claude` lane with `next`, plumbing in code, STOP, history and the agent sandbox (FR18). The copy runs as a dedicated macOS user on the Xarabot host that holds only the bot's private key, the Claude credential and its own clone: no `gh` login, ssh key or GitHub keychain item.

NFR14 (Self-host): the moment that lane works with its sandbox, Xarabot's own runner replaces the copy, and every later Xarabot Story is built by Xarabot. No Xarabot lane runs unsandboxed. The self-host success signal: Xarabot builds the rest of its own 0.x (the `codex` and `pi` adapters, the TUI, claims and parallel lanes) with its own pinned runner before Xaravel adopts it.

NFR15 (Pinned runner): the self-hosted runner runs a pinned Xarabot version (release or tag) that only the Maintainer advances, never re-execing from the branch it builds. Recovery is pinning back to the last good version.

NFR16 (Releases): a 0.x release carries only what Xaravel's adoption needs; v1 adds the rest (`releases.md`).

NFR17 (Xaravel adoption is out of scope here): adoption is planned and run in Xaravel, by a Xaravel course correction that adds an Epic before Epic 9. No Xarabot Epic performs it; Xarabot supplies what it needs (see the Additional Requirements, "Adoption inputs").

NFR18 (Consuming-repo rules bind Xarabot): lanes never push to `main`; lanes never change `AGENTS.md` unless the Maintainer asks; lanes change Protected Paths only through a Maintainer-approved Infrastructure Story, or, for the Epic graph, a planning PR the Maintainer approves; a PR that changes the effective Epic graph (the graph file, the Epic headings in `epics.md`, or a manifest's Epic) merges only with the Maintainer's approval, never just its bot owner's; Xarabot config and `.agents/skills` become Protected Paths in the consumer.

NFR19 (Set by the consuming repo, never fixed in Xarabot): merge authority beyond FR13's default and which humans may approve and merge; the lane branch namespace; which adapters may run unattended; roles, tracks, Protected Paths, the dependency-command list and Human Live Steps.

NFR20 (Write authority): the coordinator lane is the only writer of `sprint-status.yaml` and `retro-gates.yaml`; the 0.x write check (FR18) enforces it on builder diffs.

NFR21 (Capacity): a host runs at most `XARABOT_MAX_BUILDERS` builder lanes (Xaravel's host: 2).

NFR22 (Throughput target, 0.x success signal): in Xaravel's adoption Epic, a coordinator and 2 builder lanes on Xaravel's Xarabot host build Phase 1 Epics in parallel as `edanisko-xarabot`, choosing units with `next`, with no unit built twice and no admin merge; edanisko approves the bot's Protected Path PRs directly; Xarabot telemetry shows at least 1.4 Stories per hour (twice the baseline's 51 in 73 hours, `baseline-metrics.md`), computed as merged Stories divided by wall-clock hours over one stated 7-day window of Xaravel work, excluding hours when every lane waits on the Maintainer (a checkpoint go included). All lanes and adapters count; Story size is not normalized.

NFR23 (v1 success signal): a new project runs `bun add` for Xarabot plus the join command, and its team builds in BMAD with lanes: a second person creates their bot, joins on their own machine and starts a `codex` or `pi` lane; the guard enforces paths and commands for that lane; claims keep both people's lanes off each other's units; a project with no remote runs the same lanes in local-only mode.

### Additional Requirements

**Starter template: none.** The spine names no starter or scaffold. Xarabot is greenfield apart from `bootstrap/join.ts`. The package layout comes from the spine's Structural Seed, and the first Story must set up the Bun package, TypeScript 7, oxlint and the layer directories.

Requirements from the architecture spine (AR*n* cites the spine's AD):

- AR1 (Paradigm, layers): functional core, imperative shell, ports and adapters. Layers and allowed imports: `src/core/` (core only); `src/ports/` (core); `src/adapters/forge/*` and `src/adapters/agent/*` (ports, core); `src/sandbox/` (ports, core); `src/lane/` (everything above); `src/cli/` (lane and everything it may import). Ports: `Forge` (`snapshot()` with ledger tip, `main` SHA, PR states and server `now`; `ledgerSwap(oldSha, edit)` returning `ok` or `conflict`; `pushBranch(lease)`; PR open/update/close; `postReview`; `checks`; `enqueue(expectedHead)`; `dequeue`; inbox `renderDigest`, `alert`, `readRulings(cursor)`; `prefetch(kind)`; no approve operation), `Agent` (`launchSpec`, `parseUsage`, `effortValues`), `Sandbox` (`run(LaunchSpec, profile)`, the only agent spawner), `LaneStore` (PIDs, journal, outcome, STOP). The compare-and-swap retry loop lives in `src/lane/`; adapters do one attempt per call.
- AR2 (AD-1): `src/core/` never calls `fetch`, `Bun.spawn`, the filesystem, `Date.now()` or `process.env`; only adapters and `src/sandbox/` touch the forge, agents, the OS or the clock; adapters never import each other.
- AR3 (AD-2): one process per unit, started by the lane's launchd or systemd job, which runs at most one unit, waits, then exits. PID in `lane.pid`; heartbeats continue through the trailing wait; every wait is a child `sleep` with its PID in `wait.pid` (1 min after progress, 30 after idle, 15 after a failure, and usage-limit sleeps); `xarabot wake <lane>` kills exactly that PID after checking it. Every forge, git or HTTP call has an `AbortSignal` deadline; git runs with `GIT_TERMINAL_PROMPT=0`. Unit wall-clock budget is config (default 6 h); overrun stops heartbeating and releases as a failed attempt. Code never calls `pkill` or a `timeout` binary.
- AR4 (AD-3): every piece of state has one home and one writer, per the spine's AD-3 table (sprint status: coordinator; `retro-gates.yaml`: `reconcile` runner code only; ledger records by state; forge objects: the runner; the `status:` line of the unit's own Story file: the agent session; journal, PIDs, outcome: the lane process; `STOP`: the operator). Any other write is a defect.
- AR5 (AD-4): the ledger is the branch `xarabot/claims`, holding `units/<unit-file-id>.json` and `coordinator.json`. Every write fetches the tip and applies a pure edit that re-checks every precondition (state, owner, generation, glob overlap against `claimed`, `merging` and held `parked` records) against that tip; the swap is fast-forward-only (`PATCH git/refs` with `force: false`; `git update-ref <ref> <new> <old>` locally). On conflict, re-fetch and retry with jittered back-off; on a failed precondition, run `next` again. Ledger commits carry `[skip ci]`. Snapshot order: ledger, then `main`, then each ledger unit's PR state; the ledger wins over `main`.
- AR6 (AD-5): ledger records are a versioned state machine with the fields `schema_version`, `unit`, `state`, `owner`, `host`, `lane`, `generation`, `globs`, `heartbeat_at`, `pr`, `pr_owner`, `base_sha`, `head_sha`, `reviewed_sha`, `passed_sha`, `approved_sha`, `builder_providers[]`, `park` {`kind`, `reason`, `inbox_owner`, `globs_held`}, `attempts`, `loopbacks`, `ci_fixes`, `approval` {`by`, `manifest_sha`}. States `claimed`, `merging`, `parked`, `released`, `merged`; the Structural Seed state diagram is normative. Only `merged` records are deleted (by the coordinator); `generation` only goes up; `attempts` survives release. `now` is the forge server's time from `Forge.snapshot()` (host clock only in local-only mode and for sleep lengths). An unknown or newer `schema_version` stops the lane before `next`, with an alert. `host` is a UUID written to `host.yaml` by `xarabot lane install`.
- AR7 (AD-6): heartbeat every 5 minutes for `claimed` records and builder-held `merging` records. A stale `claimed` record (30 min) may be taken over at `generation` + 1, `attempts` + 1, parking on the 3rd. A stale builder-held `merging` record: merged PR → `merged`; still queued → any lane may take it over; otherwise → `released` with `attempts` + 1 and `pr` kept. `parked` never expires. CAS retry loops give up after 10 tries or the call's deadline. Before each push, PR change, enqueue or merge, a fencing heartbeat swap requires the lane's own `owner/host/lane` and `generation`, or the unit is abandoned. Pushes use `--force-with-lease` against `head_sha`; enqueue and merge pass the expected head SHA.
- AR8 (AD-7): each outcome's ledger effect per the spine's AD-7 table, including: `merging` written before enqueue; awaiting approval → `parked` holding only the diff's paths; blocked kinds → `parked` with globs released and an inbox item; crash, missing or invalid result, timeout or budget overrun → `released` with `attempts` + 1, `parked` at ≥ 3; recurring units with nothing to commit → `merged` with no PR, deleted at once; an ejected or dequeued approval-gated PR → `parked`, `approved_sha` cleared; Infrastructure Story without approval → `parked` (`needs-approval`); `stop --now` or STOP during a usage-limit sleep → `released` without counting an attempt. Every move out of `merging` other than to `merged` dequeues first; every cap is tested with `>=`. Coordinator-held `merging` records are checked by later `reconcile` runs, never by heartbeat.
- AR9 (AD-8): the coordinator role is a claim in `coordinator.json`, heartbeated through its units and waits; the same `<owner>/<host>/coordinator` identity re-claims without a takeover; a different identity refuses to start while it is live; if expired or missing, builders continue and post the alert.
- AR10 (AD-9): one branch and one PR per unit. Branches: `<story-namespace><story-id>` (Xarabot: `story/9.3`) and `<xarabot-namespace><kind>-<id>` (default `xarabot/retro-item-9.12`), both namespaces set by repo config. `story`, `retro`, `retro-item` and `checkpoint` are one-shot; `planning:<slug>.<n>` and `reconcile:<n>` recur with a run number. Every claim inspects the unit's branch and all its PRs (merged → `merged`; open → adopt, `head_sha` from the PR; closed or none → start from `origin/main`). A `rebuild` ruling closes the open PR and clears `reviewed_sha`/`passed_sha`. "Done on `main`" per kind as in AD-9. Wip is snapshotted as `wip/<unit>` in `runner.git` before any reset, never pushed; a restart resumes wip only at the same claim generation. Cross-owner takeover (v1) closes the old PR and opens a new one under the new bot.
- AR11 (AD-10): the Story manifest is one file per Story in a repo-configured directory (Xaravel: `stories/<id>.md`); config says whether it doubles as the BMAD Story file. Required frontmatter `story_id`, `epic`, `sprint_key`, `title`; paths as `globs` or a repo-mapped key (Xaravel: `component`); optional `depends_on`, `infrastructure: true`; repo-only fields and `status` ignored. Glob normalization: strip `./`; reject `!`, `..` and absolute paths; compare by case-folded character prefix; globs overlap unless their literal prefixes are disjoint. Resolved globs are stored at claim time. A Story whose globs resolve to nothing is unclaimable and goes to the inbox. Outside its globs a Story's diff may carry only its own BMAD Story spec file (`story_spec_path`, default `implementation_artifacts/spec-<sprint_key>.md`) and the `status:` line of its own Story file. Infrastructure Stories are claimable only with a ledger approval whose `manifest_sha` matches.
- AR12 (AD-11): one pure `resolveGraph(snapshot)` in `src/core` builds the effective graph from `.xarabot/epics.yaml`, the Epic and Story headings in `epics.md`, each manifest's `epic` and the package edges, from one `main` SHA; gates and `next` read only its output. Strict versioned schema (`version`; `epics` map; keys `^[1-9][0-9]*$` converted to numbers; `depends_on` a list of positive integers; `checkpoint` only literal `true`; duplicate keys detected from the raw text; multi-document or null `epics` invalid). Default: an unlisted Epic, or one without `depends_on`, depends on the next lower Epic number in `epics.md`; no file means serial; checkpoints never inferred. The `epics.md` grammar is stock output: Epic = level-2 `## Epic <int>:` outside fenced code (lines under `## Epic List` ignored); Story = level-3 `### Story <int>.<int>[a-z]?:` under its Epic. An Epic's Stories are exactly the manifests naming it; a heading with no manifest is unclaimable, listed in the Maintainer's inbox, and keeps its Epic from being done. Absence of the file is decided only from the tree listing; other read errors fail closed. Validation (invalid file, unknown Epic, cycle, manifest mismatch, a checkpoint wait the graph doesn't mark) stops every lane with an alert. Graph-changing PRs: validated on the merge result before enqueue, hold the pseudo-glob `xarabot:graph`, need the Maintainer's approval with `approved_graph` hash re-checked at enqueue, and get the delta posted on the PR. Epic numbers and Story ids are fixed once used; only a checkpoint with a recorded go may be retired. The same validator ships as `xarabot graph check`.
- AR13 (AD-12): gates on the graph, measuring distance along dependency edges from Epic E: Epic D starts only when every Epic it depends on has all Stories merged and its retro done; a `blocking` item holds every Epic at distance ≥ 1, any other open item (`open`, `in-progress`, `waiting`) holds distance ≥ 2; a checkpoint holds all transitive dependents until the go, while in-flight Epics finish held Stories. Retro results carry each item's stock BMAD action-item id (`epic-<N>-retro-item-<seq>-<slug>`), `blocking`, `route` and `globs`; the runner validates them one to one against the `action_items` the diff appends and the verdict against the retro document's frontmatter, stores the result in the ledger record, and `reconcile` writes `retro-gates.yaml` once. Graph changes take effect at the next claim.
- AR14 (AD-13): `next(snapshot, laneRole)` returns a unit or `idle` with a reason. Every unit kind holds globs (planning: graph inputs, status files and the Epic context path, plus `xarabot:graph` when it changes a graph input; retro and checkpoint: status files and Epic context, never graph inputs; retro items: their `globs` from `retro-gates.yaml`, never graph inputs, status files or write-check paths, unclaimable without globs; `reconcile`: none; a parked approval-gated PR: only its diff's paths); the overlap check applies to every role. Builders take only eligible Stories whose record is absent, `released` or stale, lowest Epic number first, then lowest Story number. The coordinator compiles each Epic's `epic-<N>-context.md` in planning before its Stories become eligible; the runner reverts builder changes to it. Coordinator order: `reconcile` (apply rulings; enqueue approved held PRs; write `merged`; mark done; batch-route Maintainer-only retro items), open coordinator PR, planning, retro, retro items, checkpoint. Approval-gated coordinator PRs never touch the status files.
- AR15 (AD-14): every session writes JSON to `XARABOT_RESULT` (in the sandbox temp folder, outside the clone) as the prompt's last step, never from a skill hook. Union keyed by `kind`: `build` (`outcome` `done`/`blocked`/`no-op`, `blocked` {`kind`, `text`, `step_id`}, `summary`, `body`, `verification[]`); `review` (`reviewed_sha`, `verdict`, `findings[]` {`severity`, `blocking`, `file`, `text`}); `retro` (`verdict`, `items[]` {`id`, `text`, `route`, `blocking`, `globs`}); `planning` (`outcome`, `summary`); all carry `denied_actions[]`. A missing result gets one resume asking only for the result (`claude -p --resume`; codex and pi confirmed in their adapter Stories); builds also cross-check the Story spec's `status` and `## Auto Run Result`. Still missing or invalid → failed attempt. Agent, model, effort, tokens, cost, timings, diff, files touched and authorship are never taken from the agent.
- AR16 (AD-15): each lane has a runner-private `runner.git` in its state folder that the sandbox can neither read nor write. The runner never runs git against the agent clone's `.git`; it rebuilds the clone, `.git` included, from `runner.git` before every session (first build at `base_sha`; loopback or CI fix at `head_sha` with findings or CI log prefetched), then reads only the working tree. Before acting on a PR this lane didn't build, it fetches the PR head and `passed_sha` into `runner.git`. The commit: working-tree changes against `base_sha`, three-way merged onto `origin/main`, one commit authored by `<login>-xarabot[bot]`, recording `base_sha` and `head_sha`. A pure sanitizer strips trailers, closing keywords and `@mentions` from agent `summary`/`body` before any forge text. Only the runner pushes, opens PRs, comments, enqueues and merges; never an admin merge or GitHub auto-merge.
- AR17 (AD-16): the reviewer must come from a provider not in `builder_providers[]`: the first allowed adapter of (`claude`, `codex`) whose provider is outside the set (provider = the model's vendor; pi's from its `<provider>/<id>`); none left → park blocked; a session whose reported model differs from config fails. The review runs on a fresh `runner.git` checkout of `head_sha` with agent config paths restored from `main`, hooks off and a freshly seeded vendor home; the runner records `reviewed_sha` and posts the review naming it. No blocking findings → `passed_sha`. Enqueue only if the head equals `passed_sha` or its tree equals the merge of `passed_sha` with the head's `main` parent, recomputed by the enqueuing lane. Owner-gated PRs need `approved_sha` = head; graph-changing PRs need the Maintainer's approval on the head and a matching `approved_graph`. `reconcile` PRs get no agent review. Any later agent change re-runs the review, each re-run a loopback, at most 2. A lane refuses to start if its reviewer adapter isn't allowed.
- AR18 (AD-17): only `src/sandbox/` spawns agent and reviewer processes; a lint rule bans `Bun.spawn` under `src/adapters/agent/`. macOS: `sandbox-exec` with a generated profile, re-tested on each macOS major; Linux: `bwrap` with `--unshare-pid`; each agent's own sandbox off inside it. A per-lane vendor home under the state folder is re-seeded before every session with only that vendor's credential (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, pi's agent directory; on macOS `claude` gets `CLAUDE_CODE_OAUTH_TOKEN`); the operator's `~/.claude`, `~/.codex`, `~/.pi` are inaccessible. Reads denied by default except system paths, the lane clone, vendor home and temp folder; `~/.xarabot/**`, `$XDG_CONFIG_HOME/xarabot`, `~/.config/gh`, `~/.ssh`, `~/Library/Keychains`, `~/.git-credentials`, `~/.netrc` always denied. Writes allowed to the full clone (never a linked worktree), vendor home and temp folder; `runner.git` never accessible. Env allowlist only; git credential helper reset; Unix sockets denied. Network only through Xarabot's Bun proxy to vendor API hosts, `pypi.org`, `files.pythonhosted.org` and repo-added hosts; a GitHub host is never allowed. Fail closed if the sandbox can't be set up.
- AR19 (AD-18): repo commands the runner needs (e.g. lockfile regeneration) run inside the sandbox with no token. The runner's own git runs only against `runner.git` with `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `credential.helper=` reset before its own helper, `core.hooksPath=/dev/null`, no fsmonitor/filters/external diff/textconv/signing program, `GIT_NO_REPLACE_OBJECTS=1`, `protocol.file.allow=never`, no submodule recursion. Write-check and review diffs are computed from git objects under those settings. The token reaches git only through a credential helper over stdin, scoped to the forge URL; never in env, argv, a file or a log.
- AR20 (AD-19, adopted Lessons): poll CI by hand every 30 s backing off to 5 min, never `gh pr checks --watch`; stop at the first failure not on `policy.yaml`'s expected-checks list; an empty reply means pending; CI max wait default 60 min, then park blocked. An unexpected failure starts a CI-fix builder session, at most 2 per unit, journaled as `ci_fixes` and re-reviewed. Merge `origin/main` into a conflicting PR before polling; status YAML conflicts keep `main`'s lines and re-apply the PR's entries; lockfiles regenerated in the sandbox; other conflicts go to a builder session, counted as an attempt. Squash through the merge queue, never `--delete-branch`; an ejection merges `main`, re-polls and re-enqueues, counted toward `attempts`.
- AR21 (AD-20): config in three layers: package (defaults, schemas, prompt template); repo (`.xarabot/config.yaml`, `policy.yaml`, `human-live-steps.yaml`, `epics.yaml`, `prompts/`, plus the Standing Authority file at the configured path), read only from freshly fetched `origin/main`; host (`host.yaml`, `XARABOT_HOST`, `XARABOT_MAX_BUILDERS`). All YAML with versioned schemas. The Standing Authority is valid when it exists on `main` and its YAML frontmatter validates. Missing, invalid or unfetchable config, policy or Standing Authority stops the lane (an absent `epics.yaml` alone means serial). Re-checked from fresh `main`: the Standing Authority before every claim, push, enqueue and merge; adapter and reviewer allowances before every session launch and enqueue. Consumer Protected Paths: `.xarabot/**`, the Standing Authority file, `.github/**`, and agent config at any depth (`**/.agents/**`, `**/.claude/**`, `**/.codex/**`, `**/.pi/**`, `**/.mcp.json`, `**/AGENTS.md`, `**/CLAUDE.md`).
- AR22 (AD-21): lanes are host config: each lane in `host.yaml` has `repo`, `role`, `owner`, `agent`, `model`, `effort`; state under `~/.xarabot/repos/<owner>__<name>/lanes/<lane>/`. Unset `model` → adapter default; unset `effort` → `high`. A lane refuses to start if its agent isn't allowed unattended, its effort isn't offered for its model, the reviewer adapter isn't allowed, the App installation doesn't cover the repo, or the host would exceed `XARABOT_MAX_BUILDERS` across all repos.
- AR23 (AD-22): `~/.xarabot/STOP` stops the host and a lane's `STOP` stops that lane, checked at process start, before `next` and before each claim; a STOP ends a usage-limit sleep. `stop --now`: write the lane's `STOP`, kill by recorded PID in the order `lane.pid`, `agent.pid`, `wait.pid` after checking each PID's start time and command, then apply AD-7. An agent session has 3 hours; a session alive 5 minutes after its result file appears is killed. Usage limits: sleep until reset + 2 min, or 15 min if unparseable, never over 8 h; wakeable; heartbeat continues; the unit budget still applies.
- AR24 (AD-23): one `xarabot-inbox`-labelled issue per owner, assigned to them; only the Maintainer's is pinned, by hand. The coordinator rewrites the digest daily from `parked` records, PR states and `retro-gates.yaml`, routing Maintainer-only retro items in batch. Any lane may post a single @mention alert for a condition that newly stops every lane, deduplicated by (condition, `main` SHA), allowed even while failing closed. The App gains `issues: write`.
- AR25 (AD-24): each lane appends to `journal.jsonl` one record per unit (AD-14 facts plus `outcome`, `loopbacks`, `ci_fixes`) and one per idle or waiting span with its reason (`waiting-on-maintainer`, `usage-limit`, `idle`); subscription cost labelled an estimate. `xarabot report` computes Stories per hour excluding all-lanes-`waiting-on-maintainer` hours. `xarabot status --json --watch` is the only status interface; the TUI draws it locally or over `ssh $XARABOT_HOST`. Logs kept 30 days; journals forever.
- AR26 (AD-25): a lane runs `~/.xarabot/runner/<version>/`, the version from `runner_version` in `.xarabot/config.yaml` on `origin/main`. A consumer's exact `@xaravel/xarabot` pin must equal `runner_version` or the lane refuses to start; Xarabot's own repo uses `runner_version` alone. Only the Maintainer advances it. `xarabot lane install` installs that version and writes the launchd plist or systemd unit with a restart throttle.
- AR27 (AD-26, adopted from `bootstrap/join.ts`): the App key lives at `$XDG_CONFIG_HOME/xarabot/apps/<login>-xarabot/private-key.pem` (fallback `~/.config`), mode 600, with `app.json` recording App ID and slug. Installation tokens are minted on demand, last 1 hour, memory only. The App has no admin, bypass or approve rights and no `workflows: write`; a diff touching `.github/workflows/**` is a write-check refusal.
- AR28 (AD-27): every runtime-validated shape has one zod schema in `src/core/schemas/` with its TS type inferred (config, policy, Standing Authority, manifests, ledger records, results, `retro-gates.yaml`, rulings, prefetched GitHub data, journal, status, `Snapshot`). The `Snapshot`'s named fields: `now`; ledger tip and records; `main` SHA; config, policy, Standing Authority; manifests and the resolved graph; `sprint-status.yaml` and `retro-gates.yaml`; PR state of every ledger unit; lane identity and role. YAML via `Bun.YAML`, globs via `Bun.Glob`. Each port has one contract suite in `test/contracts/` that every adapter passes, including many lanes racing on the ledger and every forge error kind.
- AR29 (AD-28): rulings are comment commands on the inbox issue: `/xarabot <verb> <unit-id>` with `go`, `approve`, `block`, `unblock` (Maintainer only) and `rebuild`, `release`, `dismiss` (item owner or Maintainer). `release` and `rebuild` reset `attempts`, `loopbacks`, `ci_fixes`; `rebuild` also closes the PR and clears `builder_providers[]`; `release` keeps them; `dismiss` removes only the inbox item. `reconcile`'s runner code applies rulings (the checkpoint go included), never an agent, reading new comments from a cursor in `coordinator.json` and replying with a 🤖 acknowledgement. Local-only mode (v1) uses `xarabot rule <verb> <unit-id>`.
- AR30 (AD-29): `core/prompt` builds every prompt purely from the package template, the repo's `prompts/` sections, the unit id, the Human Live Steps list, the result path and (v1) Lessons, all from fetched `origin/main`. The prompt names the unit; a test asserts it has no selection, CI, merge or status instruction. It runs the stock skill for the unit (`story` first build: `bmad-build-auto`; loopback or CI fix: none, apply prefetched findings or log; `retro`: `bmad-retrospective -H <epic>` then the item fields; `planning`: `bmad-sprint-planning` headless, plus manifests, Epic context and graph edits; `retro-item`: none, the prompt names it), then writes the result as its last step. Never run by a lane: `bmad-create-epics-and-stories`, `bmad-correct-course`. The clone is on the unit's branch before the session. Adapters pass their CLI's attribution-off setting (e.g. `claude --settings {"attribution": false}`).
- AR31 (AD-30): the 0.x write check refuses builder diffs touching coordinator-owned files, manifests, `.xarabot/**`, the Standing Authority file, `.github/**`, agent config at any depth or the repo's Protected Paths, with only three exceptions (an approved Infrastructure Story's Protected Paths, never coordinator files, manifests or `.xarabot/**`; the unit's own BMAD Story spec file; the `status:` line of its own Story file). Coordinator diffs may touch only the paths their unit holds; only `planning` may touch a graph input, and under `.xarabot/**` only `epics.yaml`; a diff touching both a graph input and a status file is refused. Any agent diff changing a retro verdict, item or checkpoint go is refused. Only the session's own change is checked, never runner-written content. A refusal parks blocked and is logged.
- AR32 (AD-31): the bootstrap loop copy runs under a dedicated macOS user holding only the bot key, the Claude credential and its own clone (no `gh` login, ssh key or GitHub keychain item); the Maintainer's home is mode 700; the loop mints installation tokens each iteration. Self-hosting happens only once AD-17's sandbox runs in the first Epic.
- AR33 (AD-32): `Forge` error kinds: `conflict`, `not-fast-forward`, `auth`, `forbidden`, `rate-limited` (with `retry_after`), `not-found`, `uninstalled`, `transient`. `rate-limited` and `transient` back off within the call's deadline, and a heartbeat that would lapse releases the unit; `auth`, `forbidden` and `uninstalled` stop the lane with an alert.
- AR34 (AD-33): launchd and systemd restarts are throttled; 3 failed starts in a row write the lane's own `STOP` and post an alert. Consumer prerequisites, Human Live Steps checked at lane start where the API allows: the `xarabot/claims` ruleset (no force-push or deletion; no other ruleset matching it); the merge queue on `main`; squash messages set to PR title + body; Protected Paths requiring the owner's review with stale approvals dismissed and most-recent-push approval required; the App installed with `issues: write`.
- AR35 (Consistency Conventions): integer Epic keys; `story_id` matches `^\d+\.\d+[a-z]?$`, sorted numerically by part then suffix. Unit ids `story:<story_id>`, `retro:<epic>`, `retro-item:<bmad-action-item-id>`, `checkpoint:<epic>`, `planning:<slug>.<n>`, `reconcile:<n>`; ledger file names replace `:` with `__`. Lane identity `<owner>/<host-uuid>/<lane>`, lanes `coordinator` and `builder-1` … `builder-N`. kebab-case files, `camelCase` functions, `PascalCase` types, one port per file in `src/ports/`. `src/core/` returns `{ ok: true, value } | { ok: false, error: { kind, message } }` and never throws; the shell catches at the unit boundary. ISO 8601 UTC timestamps. Logs at `logs/<unit-file-id>-<start>.log`. Forge text only by the runner after sanitizing; status comments start with 🤖. Tests with `bun test`: core tests are case tables with no mocks, each gate and each `next` input has its own test, adapters go through contract suites. Lint and types with `bun --bun oxlint` and `bun --bun tsc`, never through Node.
- AR36 (Stack): Bun 1.4.3 (runtime, tests, packages, `Bun.YAML`, `Bun.Glob`); TypeScript 7.0.2; oxlint 1.89.0; zod 4.6.7; adapter CLI minimum tested versions claude 2.1.304, codex-cli 0.163.0, pi 1.3.0 (minimums, not pins); bubblewrap 0.13.1 on Linux.
- AR37 (Structural Seed): the host layout (`~/.xarabot/STOP`, `runner/<version>/`, `repos/<owner>__<name>/lanes/<lane>/` with `clone/`, `runner.git/`, `vendor/`, `journal.jsonl`, `lane.pid`, `agent.pid`, `wait.pid`, `outcome`, `STOP`, `logs/`; `$XDG_CONFIG_HOME/xarabot/` with `host.yaml` and `apps/<login>-xarabot/`) and the source tree (`src/core/` with `schemas/`, `src/ports/`, `src/adapters/forge/github/`, `src/adapters/agent/{claude,codex,pi}/`, `src/sandbox/`, `src/lane/`, `src/cli/` with `join`, `lane install`, `wake`, `stop`, `rule`, `status`, `tui`, `report`; `test/contracts/`; `bootstrap/`).

Open items and spikes the spine assigns to specific Stories:

- AR38: verify live which App permission the merge queue's `enqueuePullRequest` needs, before the merge-plumbing Story.
- AR39: the forge contract suite settles which `PATCH git/refs` response (409 or 422) means "retry the swap".
- AR40: the sandbox Story proves the proxy's hostname allowlist with a spike.
- AR41: the pi adapter Story confirms pi's agent-directory override.
- AR42: the codex and pi adapter Stories settle whether `codex exec` and pi give `bmad-build-auto` the subagents it requires, how its outcomes (a `ready-for-dev` halt; it never yields `no-op`) map onto the `build` result, and session resume per CLI.
- AR43: Xaravel's MAINT file gains Standing Authority frontmatter in its adoption Epic (Xarabot defines the schema).

Brownfield lessons and adoption inputs (`brownfield-xaravel.md`):

- AR44 (Lessons): interrupted work is kept as wip and resumed (AR10); CI polling, conflicts and merges per AR20; macOS has no `timeout`; kill by exact PID, never `pkill -f`; a `claude -p` session can linger about 12 minutes after its final result (AR23's 5-minute kill); a denied auto-mode action is reported, never worked around (`denied_actions[]`); live GitHub settings, rulesets and secrets are written by the Maintainer, never a lane.
- AR45 (Adoption inputs Xarabot must support, without performing the adoption): a repo path mapping such as Xaravel's `component` for manifest globs; a configurable Standing Authority path (Xaravel's `decisions/MAINT-2026-10-16-unattended-orchestrator.md`); reading Xaravel's `tools/escalations/` through config under 0.x; Xaravel's `.xarabot/epics.yaml` with Epic 8's checkpoint (`8: {depends_on: [7], checkpoint: true}`); Story headings without manifests reported as unclaimable (47 today in Xaravel); the existing Maintainer inbox and batch routing of Maintainer-only retro items (Xaravel PR #216) ported into FR9.

Scope bounds (SPEC § Non-goals): no faster or cheaper default model tier; no project-specific platform parts (product eval gates, per-worktree service stacks, cloud transcript sinks, SSO roles, production deploy reviewers), which consumers supply as integrations; no planning or running of Xaravel's adoption; no hosted service; no vendoring, forking or re-implementing BMAD's skills; no GitLab or other forges before a later release.

Deferred in the spine (no 0.x Story builds these): the spec-folder planning shape; the local-only forge adapter (v1); the v1 guard diff check and CI re-check; a CI `resolveGraph` check on human-authored PRs (v1, CAP-19); removing a queued PR when authority is revoked (v1); Xarabot-owned Escalations (v1); injecting Lessons (v1); the Actor registry and generated CODEOWNERS and rulesets (v1); detecting Human Live Steps beyond `blocked.kind` (v1); pipelining; cross-host telemetry and journal backup (v1); App key rotation; Linux sandbox packaging (AppArmor profile on Ubuntu 24.04+, `bwrap` source).

### UX Design Requirements

None. There is no UX design contract. The only interface beyond the CLI is the read-only TUI (FR12), whose behaviour AR25 fixes: it draws `xarabot status --json --watch`, locally or over ssh.

### FR Coverage Map

FR1: Epic 1 - pinned runner install from `runner_version`; Epic 7 - consumer exact-pin check, changelog, upgrade as a PR
FR2: Epic 1 - builder `next`, `resolveGraph`, `xarabot graph check`, the "dependencies merged and retro done" gate; Epic 2 - coordinator unit order; Epic 4 - retro-item distance gates and checkpoints
FR3: Epic 1 - ledger records and compare-and-swap for one lane; Epic 2 - heartbeat, takeover, fencing, glob overlap, across machines
FR4: Epic 2 - coordinator and N builder lanes on a macOS host; Epic 7 - Linux hosts (systemd)
FR5: Epic 4 - Epics in parallel by the graph, checkpoints hold only their dependents
FR6: Epic 1 - CI polling, merge queue, conflicts, status comments, usage-limit sleep, JSON result
FR7: Epic 1 - `claude` adapter; Epic 3 - `codex` and `pi`, the common effort scale, unattended policy
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
- Story 1.1 sets up `bun test`, `bun --bun oxlint` and `bun --bun tsc`, the import-boundary lint, the `Bun.spawn` ban under `src/adapters/agent/` and the `test/contracts/` skeleton. The CI workflow that runs them as a required check on `main` is a Maintainer step (`.github/**` is never a lane's to write).
- An in-memory fake `Forge` passes the same contract suite as the GitHub adapter, so lane, claims and plumbing code is tested without GitHub, including many lanes racing on the ledger (AR28).
- Every Story names its tests in its acceptance criteria: core Stories their case tables (no mocks), adapter Stories the contract suite they pass, sandbox Stories a refusal test per adapter, security-sensitive Stories their negative tests.
- Every Epic ends with a verification Story that proves its success criteria end to end on the real repo.
- Live acceptance runs that do not fit a unit's 6-hour budget are Maintainer-run checks, not Stories: FR4's 24-hour run of a coordinator and 2 builders (after Epic 3 lifts the 1-builder limit) and NFR22's throughput, measured in Xaravel.

### Epic 1: One sandboxed lane builds Stories unattended
The Maintainer installs a pinned Xarabot runner on the Xarabot host, and one `claude` lane builds Stories with no human watching. `next` picks the Story in code. The agent runs in the sandbox with no GitHub credential or host. The runner commits as `edanisko-xarabot[bot]`, opens the PR, polls CI, parks a PR until the Maintainer approves it, merges through the queue, sleeps through usage limits, keeps a journal and obeys STOP. This is the self-host threshold.
**FRs covered:** FR2 (builder), FR3 (one lane), FR6, FR7 (`claude`), FR9 (alerts), FR11 (journal), FR13 (tokens, authorship, approval gate), FR15, FR18 (sandbox, macOS), FR22, FR24 (GitHub), FR1 (pinned install)
**Notes:** the scaffold and test harness come first. macOS only (`sandbox-exec`, launchd). Spikes AR38 (merge-queue App permission), AR39 (409 or 422) and AR40 (proxy allowlist). Ends with a canary Story run from `next` to merge on the real repo, with a STOP mid-wait and a usage-limit sleep exercised.

### Epic 2: A coordinator lane and claims let builders run side by side
Xarabot runs its own coordinator: `reconcile`, planning, retro and retro-item units, under a coordinator claim. Builder lanes share a host, or several hosts, without building a unit twice or colliding on globs, and no builder can write coordinator-owned files, manifests, agent config or policy.
**FRs covered:** FR2 (coordinator order), FR3 (heartbeat, takeover, fencing, overlap), FR4 (macOS), FR18 (write check)
**Notes:** the builder limit stays at 1 until Epic 3 merges. Ends with two lanes racing against the real `xarabot/claims` for one unit and for overlapping globs, exactly one winning, and a killed lane's unit becoming claimable 30 minutes after its last heartbeat.

### Epic 3: No diff merges without another vendor's review
`codex` and `pi` lanes run beside `claude` with the same `agent`, `model` and `effort` settings, and the runner has every diff reviewed by a model from another vendor, bound to the reviewed SHA, before it merges.
**FRs covered:** FR7 (`codex`, `pi`, effort mapping, unattended policy), FR8
**Notes:** spikes AR41 (pi's directory override) and AR42 (subagents, outcome mapping, resume per CLI). After it merges, the Maintainer lifts the every-path approval rule and the 1-builder limit. Ends with the same unit run to a valid result through each adapter, and a review re-run after a later agent change.

### Epic 4: Epics run in parallel behind retro and checkpoint gates, ruled from one inbox
Epics start as soon as the graph allows, retro items and checkpoints hold exactly the Epics they should, and each owner rules on everything waiting on them from one daily inbox digest by comment command.
**FRs covered:** FR2 (distance and checkpoint gates), FR5, FR9 (inbox, digest), FR10
**Notes:** includes graph-change approval with `approved_graph` (AR12) and the rulings grammar (AR29). Ends with a graph fixture proving the distance and `blocking` gates, and a checkpoint holding only its dependents until `/xarabot go`.

### Epic 5: Each human runs lanes as their own bot
`xarabot join` creates a person's `<login>-xarabot` App from a manifest and installs it or requests the install, replacing `bootstrap/join.ts`. A lane whose installation does not cover its repo stops and names the repo to add.
**FRs covered:** FR13 (join, installation scope)
**Notes:** ends with `xarabot join` against a test org, and proof that the bot can neither approve nor admin-merge while its owner can approve and merge a Protected Path PR.

### Epic 6: Operators can see and measure every lane
`xarabot status --json --watch` reports every lane's unit, claim, CI and merge state and the inbox; the TUI draws it locally or over `ssh $XARABOT_HOST`; `xarabot report` compares agents and models and computes Stories per hour.
**FRs covered:** FR11 (report), FR12
**Notes:** ends with `xarabot report` reproducing a hand-computed Stories-per-hour figure from a fixture journal.

### Epic 7: Xarabot 0.x is ready for a consuming repo
A consuming repo adds `@xaravel/xarabot` with `bun add`, pins it exactly, and runs lanes on macOS or Linux. Lanes check the consumer prerequisites at start, and Xarabot supports what Xaravel's adoption needs.
**FRs covered:** FR1 (consumer pin, changelog, upgrade as a PR), FR4 (Linux), FR18 (sandbox on Linux)
**Notes:** covers AR34's prerequisite checks and AR45's adoption inputs. The release workflow in `.github/` is a Maintainer step. Ends with a throwaway consumer repo that pins the package and refuses to start on a pin mismatch.

**Epic dependencies** (input for `.xarabot/epics.yaml`): 1 → 2 → 3 → 4; Epics 5 and 6 each depend on 4 and can run in parallel; Epic 7 depends on 5 and 6. No checkpoints in 0.x.

## Epic 1: One sandboxed lane builds Stories unattended

The Maintainer installs a pinned Xarabot runner on the Xarabot host, and one `claude` lane builds Stories with no human watching: `next` picks the Story in code, the agent runs in the sandbox with no GitHub credential or host, and the runner commits as `edanisko-xarabot[bot]`, opens the PR, polls CI, parks a PR for the Maintainer's approval, merges through the queue, sleeps through usage limits, keeps a journal and obeys STOP. This is the self-host threshold (NFR13, NFR14). The bootstrap copy of Xaravel's loop builds these Stories in order; each depends only on earlier ones.

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
**Then** it holds versioned zod schemas, with inferred types, for `.xarabot/config.yaml` (including `runner_version`, the Maintainer's login, the Standing Authority path, the manifest directory and path-key mapping, `story_spec_path`, both branch namespaces, the unit budget defaulting to 6 hours, the CI max wait defaulting to 60 minutes and repo-added proxy hosts), `.xarabot/policy.yaml` (adapters allowed unattended, the expected-checks list, the repo's Protected Paths and the paths that need the owner's approval), the Standing Authority frontmatter and `host.yaml` (AR21, AR22).

**Given** a snapshot of `main` as a tree listing plus file contents
**When** the pure `loadRepoConfig` runs
**Then** it returns the typed package and repo layers, or an error with a `kind`
**And** it never reads the filesystem, the clock or the environment (AR2).

**Given** the case table: config missing, config with invalid YAML, config with an unknown or newer version, policy missing, the Standing Authority file absent at its configured path, Standing Authority frontmatter invalid
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

### Story 1.3: Story manifests and the `epics.md` grammar

As a lane,
I want every Story manifest and every Epic and Story heading parsed one way,
So that claims, the guard and the graph all see the same Stories and globs (AR11, AR12).

**Acceptance Criteria:**

**Given** a manifest file in the configured directory
**When** it is parsed
**Then** it requires `story_id` matching `^\d+\.\d+[a-z]?$`, `epic`, `sprint_key` and `title`, plus either `globs` or the configured path key
**And** it accepts optional `depends_on` and `infrastructure: true`, and ignores repo-only fields and `status`
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
**And** a fixture copy of this repo's own `epics.md` parses to Epics 1–7 and their Stories.

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

**Given** a `retro-gates.yaml` schema for Epic verdicts, action items (stock BMAD ids, `blocking`, `route`, `globs`, status) and checkpoint go records
**When** `retro-gates.yaml` is read
**Then** it validates against that schema.

**Given** the validation case table: an invalid file; an entry or `depends_on` naming an Epic with no heading; a cycle; a manifest with no heading or a mismatched `epic`; `retro-gates.yaml` marking an Epic as awaiting a checkpoint go that the graph doesn't mark
**When** the pure `resolveGraph(snapshot)` runs on each
**Then** each returns a validation failure naming the problem.

**Given** a valid snapshot
**When** `resolveGraph` runs
**Then** it returns the edges, checkpoints, Epic set, each Epic's Story set (exactly the manifests naming it), the Story headings with no manifest (reported, not failures) and a stable hash of the resolved graph.

**Given** a local checkout
**When** `xarabot graph check` runs
**Then** it reads the working tree's `epics.md`, `.xarabot/epics.yaml`, manifests and `retro-gates.yaml`, prints the resolved graph, prints headings with no manifest as warnings, and exits non-zero on any validation failure
**And** on this repo with no `.xarabot/epics.yaml` it reports Epics 1–7 in serial order and exits 0.

### Story 1.5: Ledger records and pure ledger edits

As a lane,
I want ledger records and every state change defined once as pure edits,
So that each swap re-checks its preconditions against the tip and no transition outside the normative diagram can be written (AR5, AR6, AR8).

**Acceptance Criteria:**

**Given** `src/core/schemas/`
**When** the Story is done
**Then** it holds the unit record schema with every AR6 field and the `coordinator.json` schema
**And** unit ids follow AR35 (`story:<id>`, `retro:<epic>`, `retro-item:<id>`, `checkpoint:<epic>`, `planning:<slug>.<n>`, `reconcile:<n>`), with `:` replaced by `__` in file names.

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
**When** a dependency Epic has a Story not merged, or no retro verdict in `retro-gates.yaml`
**Then** no Story of D is returned, and the idle reason names the Epic that holds it.

**Given** Story records in each state
**When** `next` runs
**Then** a Story whose record is absent or `released` is eligible, and `claimed`, `merging`, `parked` and `merged` are not (stale takeover is Epic 2).

**Given** an eligible Story whose globs overlap a `claimed`, `merging` or held `parked` record
**When** `next` runs
**Then** it is skipped.

**Given** an Infrastructure Story with no ledger approval matching its current `manifest_sha`
**When** it would be chosen
**Then** `next` returns it to be parked as `needs-approval`.

**Given** Story headings with no manifest, or manifests whose globs resolve to nothing
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
**Then** it declares `snapshot`, `ledgerSwap`, `pushBranch`, PR open, update, close and list-by-branch, `checks`, `enqueue(expectedHead)`, `dequeue`, `alert` and `prefetch`, with no approve operation
**And** errors carry the kinds `conflict`, `not-fast-forward`, `auth`, `forbidden`, `rate-limited` (with `retry_after`), `not-found`, `uninstalled` and `transient`.

**Given** any port operation
**When** it is called
**Then** it takes an `AbortSignal` deadline, and a passed deadline returns `transient` (AR3).

**Given** the in-memory fake forge
**When** the contract suite runs against it
**Then** it passes: a swap from a stale tip returns `conflict`; N concurrent swaps from one tip yield exactly one `ok`; `snapshot()` reads the ledger, then `main`, then PR states, and returns the forge's `now`; `enqueue` with a wrong expected head fails; each error kind is observable.

**Given** the compare-and-swap retry loop in `src/lane/`
**When** it meets injected conflicts on the fake
**Then** it re-fetches, re-applies the pure edit, backs off with jitter, and gives up after 10 tries or at the call's deadline (AR7)
**And** a failed precondition on the new tip ends the loop, so the caller runs `next` again.

### Story 1.8: GitHub adapter: tokens, snapshot and ledger swap

As the runner,
I want to talk to GitHub as the owner's bot with short-lived tokens,
So that the ledger lives on `xarabot/claims` and no long-lived token exists (FR13, FR24, AR27, AR39).

Precondition (Human Live Step): the Maintainer has created a scratch repo with the owner's App installed, for live contract tests.

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
I want to push unit branches and manage PRs as the bot without the token leaving memory,
So that only the runner talks to GitHub, and a lane that lost its claim cannot push over another (NFR8, AR7, AR19).

**Acceptance Criteria:**

**Given** the runner's git
**When** it pushes
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

**Given** the forge contract suite
**When** it runs on the fake and live
**Then** the push and PR cases pass.

### Story 1.10: GitHub adapter: checks, merge queue and alerts

As the runner,
I want to read checks, use the merge queue and raise urgent alerts through the `Forge` port,
So that merges never bypass required checks, and a condition that stops every lane reaches the Maintainer at once (FR6, FR9, FR13, AR24, AR38).

**Acceptance Criteria:**

**Given** a PR head SHA
**When** `checks` runs
**Then** it returns every check run and status for that SHA, and an empty set means pending.

**Given** a PR
**When** `enqueue(expectedHead)` runs
**Then** it calls `enqueuePullRequest` with `expectedHeadOid`, and `dequeue` removes the PR from the queue
**And** the adapter has no code path for an admin merge, GitHub auto-merge or `--delete-branch`.

**Given** the AR38 open item
**When** the Story starts
**Then** it first verifies live, on the scratch repo, which App permission `enqueuePullRequest` needs
**And** it records the finding in the adapter and in `docs/maintainer/app-permissions.md`, and maps a missing permission to `forbidden` with a message naming it.

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
**Then** reads succeed only in system paths, the lane clone, the lane's vendor home, its temp folder and the uv-managed Python install
**And** reads of `~/.xarabot/**`, `$XDG_CONFIG_HOME/xarabot`, `~/.config/gh`, `~/.ssh`, `~/Library/Keychains`, `~/.git-credentials`, `~/.netrc`, `~/.claude`, `~/.codex` and `~/.pi` fail, with one test per path
**And** writes succeed only in the clone (`.git` included), the vendor home and the temp folder; `runner.git` can be neither read nor written; Unix sockets are denied.

**Given** a launching environment that holds `GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK` and other variables
**When** the session starts
**Then** only allowlisted variables pass through, and the git credential helper is reset.

**Given** a lane vendor home
**When** a session starts
**Then** it is re-seeded to hold only that vendor's credential.

**Given** a clone that is a linked worktree (its `.git` is a file)
**When** a session is requested
**Then** it is refused.

**Given** `sandbox-exec` missing, or a profile that fails to generate
**When** a session is requested
**Then** it is refused with an error; the sandbox never falls back to running unsandboxed.

**Given** a host that is not macOS
**When** the sandbox suite runs
**Then** its cases are reported as skipped, never as passed.

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
**Then** it allows only the adapter's vendor API hosts, `pypi.org`, `files.pythonhosted.org` and the hosts repo config adds, and denies everything else.

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

### Story 1.13: Result schemas and prompt assembly

As a lane,
I want every session's prompt built by one pure function and every result validated against one schema,
So that prompts carry no selection, CI, merge or status instructions, and sessions cannot return shapes of their own (FR2, FR6, NFR4, AR15, AR30).

**Acceptance Criteria:**

**Given** `src/core/schemas/`
**When** the Story is done
**Then** it holds the result union keyed by `kind`: `build`, `review`, `retro` and `planning`, with AR15's fields, each also carrying `denied_actions[]`.

**Given** the package template, the repo's `.xarabot/prompts/` sections, the unit id, the Human Live Steps list and the result path, all from a `main` snapshot
**When** the pure `core/prompt` runs for a `story` first build
**Then** the prompt names the unit ("Build Story 1.7") and runs stock `bmad-build-auto` for it
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

**Given** lane settings
**When** `launchSpec` runs
**Then** it returns `claude -p --model <model> --effort <effort> --permission-mode auto` with the attribution-off setting (`--settings {"attribution": false}`), `CLAUDE_CONFIG_DIR` set to the lane's vendor home, `CLAUDE_CODE_OAUTH_TOKEN` on macOS, `XARABOT_RESULT`, and the clone as working directory
**And** an unset `model` is `claude-opus-5-5` and an unset `effort` is `high`.

**Given** a model
**When** `effortValues` runs
**Then** it returns the efforts that model offers, and a lane whose `effort` is not among them refuses to start, with no silent drop or rounding.

**Given** CLI output
**When** `parseUsage` runs
**Then** it returns tokens, cost (labelled an estimate on a subscription), the reported model, and a usage-limit hit with its reset time when present
**And** a reported model that differs from the configured one fails the attempt.

**Given** a session that ends with no result file
**When** the adapter handles it
**Then** it resumes once with `claude -p --resume <session>` and a prompt that asks only for the result.

**Given** an installed `claude` older than 2.1.304
**When** a lane starts
**Then** it refuses to start.

**Given** the `Agent` contract suite
**When** it runs with a stub CLI
**Then** the adapter passes
**And** a live smoke test runs only when credentials are present, and is reported as skipped otherwise.

### Story 1.15: `runner.git`: clone rebuild, bot commit and sanitizer

As the Maintainer,
I want the runner to keep its own repository, rebuild the agent's clone from it and make every commit itself as the bot,
So that nothing an agent plants in git runs as the runner, and no co-author trailer, closing keyword or @mention reaches GitHub (FR13, NFR10, AR10, AR16, AR19).

**Acceptance Criteria:**

**Given** a lane state folder
**When** the lane first runs
**Then** it creates `runner.git` there, and every runner git command runs against it with AR19's settings (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `core.hooksPath=/dev/null`, no fsmonitor, filters, external diff, textconv or signing program, `GIT_NO_REPLACE_OBJECTS=1`, `protocol.file.allow=never`, no submodule recursion).

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

### Story 1.16: The lane process: one unit from claim to PR

As an operator,
I want one lane process to take one unit from claim to an open PR,
So that a Story is built unattended in the sandbox and leaves a bot-authored PR, a journal record and a ledger state that says what happened (FR3, FR6, FR11, FR22, AR3, AR8, AR10, AR25).

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

**Given** a `done` build result
**When** the runner handles it
**Then** it commits (Story 1.15), re-checks the Standing Authority, pushes with a lease, opens the PR with the sanitized summary and body, records `pr` and `head_sha`, and posts a status comment starting with 🤖.

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
**Then** `journal.jsonl` gets one record with the AR25 facts (agent, model, effort, tokens and cost from the adapter, timings, `outcome`, `loopbacks`, `ci_fixes`), the log is at `logs/<unit-file-id>-<start>.log`, and `outcome` holds `progress`, `idle` or `stop`.

**Given** the lane tests
**When** they run against the fake forge and a stub agent
**Then** each outcome above has a case.

### Story 1.17: CI, conflicts, approval gate and merge queue

As an operator,
I want the lane to take its open PR through CI, conflicts, the approval gate and the merge queue in code,
So that the agent never polls CI or merges, and Xaravel's CI and merge lessons hold (FR6, FR13, AR8, AR20, AR44).

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
**And** any other conflict goes to a builder session that counts as an attempt.

**Given** an unexpected CI failure
**When** the lane handles it
**Then** it prefetches the CI log, runs a CI-fix session at `head_sha` and records `ci_fixes` + 1
**And** once `ci_fixes` ≥ 2 and CI still fails, the unit parks blocked.

**Given** a PR whose diff touches a path the policy says needs its owner's approval
**When** its checks pass
**Then** the record becomes `parked`, holding only the paths its diff changes, and the lane moves on
**And** while Epic 2's `reconcile` does not exist, the Maintainer approves and queues the PR by hand, and a lane that later sees it merged writes `merged`.

**Given** a PR that needs no approval and whose checks pass
**When** the lane enqueues it
**Then** it first writes `merging` with a swap that requires its own `owner`/`host`/`lane` and `generation`, then calls `enqueue` with the expected head
**And** a failed swap abandons the unit.

**Given** a queued PR
**When** the queue ejects it
**Then** the lane merges `main`, polls again and re-enqueues, counting toward `attempts`
**And** every move out of `merging` other than to `merged` dequeues first.

**Given** a merged PR
**When** the lane sees it
**Then** the record becomes `merged`, and the journal records the unit.

**Given** the suite
**When** it runs
**Then** each poll reply, conflict kind and outcome has a case against the fake forge.

### Story 1.18: Waits, STOP, `wake`, `stop --now` and usage limits

As an operator,
I want every wait to be a sleep I can wake or kill, and every stop to act by exact PID,
So that a lane stops deterministically and never kills the wrong process (FR15, AR3, AR23, AR44).

**Acceptance Criteria:**

**Given** a finished unit
**When** the process waits
**Then** it runs a child `sleep` with its PID in `wait.pid`, for 1 minute after progress, 30 after idle or 15 after a failure, then exits.

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
**When** the lane is installed or started
**Then** that version is installed at `~/.xarabot/runner/<version>/` (from the `xaravel/xarabot` git tag until npm releases exist)
**And** the lane runs only from that path, never from a lane clone or the branch it builds.

**Given** a lane
**When** it is installed
**Then** a launchd plist with a restart throttle is written, checked against a golden file
**And** a lane that fails to start 3 times in a row writes its own `STOP` and posts an alert.

**Given** the refusal case table
**When** a lane starts
**Then** it refuses if its agent is not allowed unattended by policy, its effort is not in `effortValues` for its model, the App installation does not cover the repo, or the host would run more builders than `XARABOT_MAX_BUILDERS` across all repos.

**Given** `runner_version` changed on `main`
**When** the lane next starts
**Then** it installs and runs the new version
**And** pinning back to the previous version restores the previous runner.

### Story 1.20: Canary and self-host runbook

As the Maintainer,
I want an end-to-end canary and a runbook,
So that I can switch from the bootstrap loop to Xarabot's own pinned runner with evidence that it works (NFR13, NFR14).

**Acceptance Criteria:**

**Given** the scratch repo and live credentials
**When** the canary suite in `test/e2e/` runs
**Then** a real lane, with a stub agent CLI inside the real sandbox, claims a Story, commits as the bot, opens the PR, passes CI, enqueues and records `merged`
**And** the commit is authored by `<login>-xarabot[bot]` with no trailers.

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
**Then** it lists every Maintainer step for the switch, each with the command or file content to apply: the CI workflow as a required check; the `xarabot/claims` ruleset; the merge queue on `main`; squash messages set to PR title + body; the App permissions, including AR38's finding and `issues: write`; this repo's `.xarabot/config.yaml` with `runner_version`; a `policy.yaml` that makes every path need the Maintainer's approval and allows only `claude` unattended; the Standing Authority file; Epic 2's Story manifests; `XARABOT_MAX_BUILDERS=1`; `xarabot lane install`; and stopping the bootstrap loop.
