---
id: SPEC-xarabot
companions:
  - glossary.md
  - releases.md
  - baseline-metrics.md
  - agent-adapters.md
  - brownfield-xaravel.md
sources:
  - /Users/ea/Desktop/orchestrator-brief.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Xarabot: unattended BMAD delivery as its own product

Terms are defined in `glossary.md`; each capability's release is in its heading and in `releases.md`.

## Why

Xarabot makes Xaravel's unattended delivery layer its own versioned, open-source product, built on top of BMAD: a durable harness for team management, product management, the SDLC and agent management. It carries what Xaravel learned about bot identities and about stopping agents deterministically with paths and permissions. It is built to run any BMAD project unattended: a team adds it with `bun add`, and from then on works in BMAD with the orchestration layer and the coding job runners. Its first and reference consumer is Xaravel, run unattended on its Xarabot host.
- **What Xaravel proved:** its unattended loop (`tools/orchestrator/` in `xaravel/framework`) builds, reviews and merges BMAD Stories with no human watching: 51 Stories in 73 hours.
- **What holds it back:** it runs as one lane, picks its work from prompt prose, and spent a third of those hours between Epics (`baseline-metrics.md`).
- **Why now:** it lives inside one repo, so no other project can run unattended without copying it. The Maintainer is about to bring other people onto agent-built work and needs a planned way to do it.

## Capabilities

- **CAP-1 · Packaged and pinned (0.x)**
  - **intent:** Xarabot ships the runner (lanes, scheduled jobs, STOP marker, history), unit selection, claims, CI and merge plumbing, agent adapters, status reporting and prompt templates. A consuming repo adds it as a pinned dependency and supplies only its config, project-specific prompt sections, verification commands, policy files (Standing Authority, Actor registry, Human Live Steps) and Story manifests.
  - **success:** Xaravel runs every lane from a pinned Xarabot version, its tree holds no orchestration code beyond those supplied files, a Xarabot upgrade reaches it as a PR, and each Xarabot release has a changelog entry.
- **CAP-2 · Deterministic `next` (0.x)**
  - **intent:** A `next` command chooses the one unit a lane builds, in code, from Story manifests, sprint status, the dependency graph, open claims and the retro and checkpoint gates. The graph comes from the repo's Epic graph file (`.xarabot/epics.yaml`), where an Epic the file does not list depends on the next lower Epic number in `epics.md` and a checkpoint is never inferred, plus `package.json` workspace dependencies where the repo turns them on with an Epic-to-package map. It never comes from `epics.md` prose or a BMAD override.
  - **success:** Unit tests cover each input and each gate; a repo with no graph file and no `package.json` runs its Epics serially in number order; a listed Epic runs in parallel exactly as its entry allows; the agent's prompt names the unit ("Build Story X") and contains no selection rules.
- **CAP-3 · Claims (0.x)**
  - **intent:**
    - A lane's runner, never its coding agent, claims a unit, its bot identity and its manifest globs by compare-and-swap on one claims ref.
    - A unit whose globs overlap an open claim is refused; a Story without globs is never claimed.
    - A claim lives by heartbeat, is released on merge or block, and expires 30 minutes after its last heartbeat.
  - **success:**
    - Two lanes racing for one unit, or for two units with overlapping globs: exactly one wins.
    - A killed lane's unit becomes claimable 30 minutes after its last heartbeat.
    - Both hold across machines.
- **CAP-4 · Parallel lanes (0.x)**
  - **intent:** One Xarabot host, a macOS or Linux computer set in config (`XARABOT_HOST`), runs a coordinator lane (retros, retro action items, planning) and N builder lanes (Stories only), each builder with its own full clone (never a linked worktree), state folder and scheduled job (launchd or systemd). The host's builder limit is config (`XARABOT_MAX_BUILDERS`).
  - **success:** On Xaravel's Xarabot host, the coordinator and 2 builder lanes run for 24 hours with no unit built twice and no write to `sprint-status.yaml` or `retro-gates.yaml` from a builder.
- **CAP-5 · Parallel Epics (0.x)**
  - **intent:** Epics run at the same time, ordered by the dependency graph instead of strictly in sequence: an Epic starts once every Epic it depends on has all its Stories `done` in sprint status and its retro done. A checkpoint Epic holds only the Epics that depend on it, directly or through others, until the Maintainer's go.
  - **success:** In Xaravel Phase 1, after `runtime` and then `contracts`, Stories from the `macroable`, `conditionable` and `json-schema` Epics are in flight at once. While a checkpoint go is pending, Epics depending on the checkpoint Epic take no new Stories, and Epics not depending on it keep running.
- **CAP-6 · Plumbing in code (0.x)**
  - **intent:** CI polling, the merge queue, mergeability checks, conflict resolution in the status YAML files, status comments, the progress line and sleeping through usage limits run in Xarabot code; the agent session only does the unit's work and returns a JSON result. The lessons in `brownfield-xaravel.md` § Lessons (CI polling, Conflicts, Merges) bind this code.
  - **success:** The agent prompt carries no CI, merge or status instructions; every session's output validates against the result schema; a usage-limit hit makes the lane sleep until the reset instead of failing.
- **CAP-7 · Agent adapters (0.x)**
  - **intent:**
    - Each lane runs its coding agent through an adapter: `claude` or `codex` (0.x); `pi` follows in v1.
    - Every adapter takes the same three lane settings: `agent`, `model` and `effort`. `effort` is one scale for all adapters (`low`, `medium`, `high`, `xhigh`, `max`); each adapter maps it onto its CLI's own setting.
    - `claude` and `codex` default to a top model. Lane config can change model and effort.
    - The consuming repo's policy says which adapters may run unattended.
  - **success:**
    - The same unit runs to a valid JSON result through each adapter.
    - A `claude` or `codex` lane with no `model` set runs its adapter's default top model; a lane with `agent: pi` refuses to start in 0.x, naming the deferral. Switching agent, model or effort is a config change only.
    - Each adapter maps `effort` per `agent-adapters.md` § Model and effort; a value an adapter cannot honor stops the lane at start instead of being dropped silently.
    - A lane whose adapter the repo's policy does not allow unattended refuses to start unattended.
- **CAP-8 · Cross-vendor review (0.x)**
  - **intent:** Before a diff merges, the runner has it reviewed by an agent whose model comes from a vendor other than every model that built it, whenever the repo's policy allows an adapter from such a vendor. Vendor means the model's vendor, never the adapter's: Codex reviews Anthropic-built diffs, and Claude reviews the rest (`agent-adapters.md`). When the policy allows no adapter from another vendor, as for a user with only a Claude or only a Codex subscription, a separate same-vendor review session reviews the diff instead, under the same rules. The review binds to the commit it reviewed; any later agent change, such as a CI fix or a conflict resolution, re-runs it. When the Story's spec recommends a follow-up review, a second review pass runs on the same commit before the PR parks or is enqueued, under the same rules. Runner-written `reconcile` PRs carry no agent change and get no review. Its findings are blocking review loopbacks. BMAD's own review hook may run for earlier feedback but never counts as this review.
  - **success:** Every builder PR carries a review naming the commit it reviewed: from a model vendor outside its builders' when the repo allows one, otherwise from a separate same-vendor session. No PR merges with blocking findings unresolved or with a diff other than the reviewed one. A repo that allows a single vendor merges its PRs on their required checks after the same-vendor review. After 2 loopbacks, the unit does not merge and is listed in its owner's inbox.
- **CAP-9 · Inboxes (0.x)**
  - **intent:** Each owner sees everything waiting on them in one inbox and rules on it in one sitting a day: their bot's PRs awaiting approval and their blocked units. The Maintainer's inbox also holds rulings, Escalations, waiting retro items and Human Live Steps. On a solo repo the two are one list.
  - **success:** One daily digest per inbox lists every waiting item with its link and age; an item that newly stops all lanes notifies at once; no other per-item waiting notices are sent.
- **CAP-10 · Retro gating (0.x)**
  - **intent:** A retro action item from Epic E holds back the Epics that depend directly on E only when the retro tags it `blocking`; other items are worked alongside later Stories. The retro's tag stands unless the Maintainer changes it with a ruling.
  - **success:** `next` tests on the dependency graph: an untagged open item does not gate an Epic one step from E but does gate one two or more steps away; a `blocking` item gates every Epic depending on E.
- **CAP-11 · Telemetry (0.x)**
  - **intent:** Each lane records per unit: agent, model, effort, unit, start, end, outcome, review loopbacks, CI fixes, and tokens and wall-clock cost (labeled an estimate for subscription runs), so agents and lanes can be compared.
  - **success:** A report over a chosen period shows, per agent and model, units done, median unit time, first-pass review rate, CI-fix count and cost, and feeds the consuming repo's dashboard.
- **CAP-12 · TUI (0.x)**
  - **intent:** An operator sees every lane at once in a read-only terminal UI: its unit, claim, CI and merge state, and the inbox, on the host itself or from another machine over ssh.
  - **success:** One command on a laptop shows the live state of every lane on the Xarabot host named by `XARABOT_HOST`, over ssh, and refreshes on its own; the same command works locally on the host.
- **CAP-13 · Bot identity (0.x)**
  - **intent:**
    - Each human owns one bot: a GitHub App owned by their own account, `<login>-xarabot` (for example `edanisko-xarabot`), acting as `<login>-xarabot[bot]`. `xarabot join` creates it from a manifest and installs it once per consuming org, with that org owner's approval: on all repositories by default, so a repo adopts Xarabot by adding its files with no GitHub step, or on selected repositories where the org prefers.
    - Every commit, push and PR their lanes make is made as that bot, never as the human. The owning human is responsible for the bot's work.
    - The bot has no admin, bypass or approve rights. The runner mints short-lived installation tokens from the App's private key; no long-lived token is stored.
    - A PR touching no Protected Path merges on its required checks and the CAP-8 review; a PR touching a Protected Path needs its owner's approving review. A repo's policy can require more.
  - **success:**
    - `xarabot join` creates the owner's App with one confirm click and installs it with one more, or with an install request an org owner approves.
    - With a selected-repositories installation, adopting a repo the installation does not cover stops with the repo to add.
    - Every lane-made commit and PR is authored by the owner's bot.
    - The owner can approve and merge their bot's PR straight away, a Protected Path PR included.
    - The bot cannot approve any PR or merge past required checks or reviews, and Xarabot never issues an admin merge.
- **CAP-14 · Team onboarding (v1)**
  - **intent:** A team member joins by running `xarabot join`, which creates their `<login>-xarabot` App and installs it on the org or requests the install, and by registering it under their name with the setup docs; they then run lanes on their own machine against the same repo, with claims shared across machines.
  - **success:** A second person on a second machine follows the docs, runs `xarabot join`, starts a lane, and neither person's lanes build a unit the other holds.
- **CAP-15 · Deterministic stop (0.x)**
  - **intent:** An operator stops one lane or all lanes deterministically. Process control follows `brownfield-xaravel.md` § Lessons (Process control, Exit lag).
  - **success:** A STOP marker for a lane, or for the host, makes the affected lanes finish their current unit and exit, with no new claim taken.
- **CAP-16 · Pipelining (optional, after v1)**
  - **intent:** A lane starts its next Story while its previous PR is still in CI or the merge queue.
  - **success:** With pipelining on, a lane claims its next unit before its previous PR merges, and no unit merges out of dependency order.
- **CAP-17 · Actor registry (v1)**
  - **intent:** The consuming repo keeps an Actor registry: humans by GitHub login, their roles and tracks, and the `<login>-xarabot` App each one owns (its App ID). CODEOWNERS, rulesets and guard policy are generated from it.
  - **success:** Registering a person and their bot and merging gives them their role's rights everywhere; a bot not registered to a human is refused; a hand edit to a generated file fails a drift check.
- **CAP-18 · Guard (sandbox and write check 0.x; diff check and CI v1)**
  - **intent:** One fail-closed guard, the same for every adapter:
    - **Sandbox (0.x):** the coding agent runs with only its unit's clone writable, and with no GitHub credentials and no GitHub host (§ Constraints, "Agents never touch GitHub").
    - **Write check (0.x):** before the squash, the runner refuses a builder diff that touches coordinator-owned files, Story manifests, `.xarabot/**`, the Standing Authority file, `.github/**`, agent config (`.agents/skills`, `.claude/skills`, `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `CLAUDE.local.md`) or Protected Paths. Only three exceptions: an approved Infrastructure Story's Protected Paths, the unit's spec file, and the `status:` line of its own Story file. The spec file is the single `story_spec_path` match whose `status` is `done`; any other match must be `blocked`, is superseded and is dropped from the squash.
    - **Diff check (v1):** extends the write check to refuse files outside the claim's globs and dependency files the repo has not allowed.
    - **CI (v1):** CI re-checks the same rules.
    - **Hooks:** per-agent write-time hooks, where an agent has them, give earlier feedback but are never the boundary.
  - **success:**
    - Each refusal case has a test for each adapter.
    - An out-of-scope diff is never committed, and is logged with its reason; from 0.x, a builder diff touching a write-check path parks its unit blocked.
    - From 0.x, an agent session cannot push, approve or merge, because it has no token.
    - A guard error blocks rather than allows.
- **CAP-19 · Gates from the base branch (v1)**
  - **intent:** Required gates (scope, Protected Paths, open escalations) are evaluated from the base branch, never from the PR's own code, with no bypass.
  - **success:** A PR that edits a gate's own code or config is still judged by `main`'s version of it.
- **CAP-20 · Escalations (v1)**
  - **intent:** An agent raises an escalation instead of deciding a contract question; a human decision binds to the escalation's exact text by hash, and an open escalation blocks its unit's merge.
  - **success:** Changing a decided escalation's text invalidates its decision; a unit with an open escalation cannot merge.
- **CAP-21 · Lessons reach every session (v1)**
  - **intent:** New Lessons and decision records reach every unit's session, whatever its adapter.
  - **success:** A Lesson merged before a unit starts appears in that unit's agent context, for each adapter.
- **CAP-22 · Standing Authority (0.x)**
  - **intent:** A Standing Authority file in the consuming repo grants the lanes their authority; when it is absent or invalid, every lane stops.
  - **success:** Deleting the file on `main` stops every lane before its next claim.
- **CAP-23 · Human Live Steps (v1)**
  - **intent:** The consuming repo lists Human Live Steps; lanes never attempt them and route them to the Maintainer's inbox.
  - **success:** A unit that reaches a listed step is marked waiting, and the step appears in the inbox with no attempt logged.
- **CAP-24 · Forge adapters (GitHub 0.x; local-only v1)**
  - **intent:** Lanes, claims and `next` reach the forge only through a forge adapter: identity, PRs or their local equivalent, CI, merges and the claims ref. GitHub ships first. The local-only adapter runs a repo with no remote on one host: lanes merge into the local `main` after its checks, lane commits are signed with the owner's lane key, and a Protected Path change waits for a `xarabot approve` signed with the owner's own key.
  - **success:** The same unit runs end to end on GitHub and on a local-only repo with no remote; in local-only mode a Protected Path change merges only after the owner's signed approval.

## Constraints

**Stack**
- **Toolchain:** Bun only: Bun 1.4.3, TypeScript 7 with `--strict`, oxlint. No Node, npm, pnpm, Jest, Vitest, ESLint or Prettier as tools.
- **Models:** `claude` and `codex` default to a top model (`agent-adapters.md`); lane config can change them, and Xarabot enforces no model floor.
- **Planning shape:** 0.x reads the classic BMAD shape only: `epics.md`, `sprint-status.yaml` and Story manifests, plus the Epic graph file. The spec-folder shape (`stories.yaml`) waits until a consumer uses it.
- **No BMAD overrides:** Xarabot runs stock BMAD skills. Anything else it needs comes from its own prompt template, its own files or artifacts the runner reads; it never writes or requires `_bmad/custom/` in a consuming repo.
- **Interactive skills stay with the Maintainer:** lanes drive only BMAD skills with a headless run (`bmad-build-auto`, `bmad-retrospective`, `bmad-sprint-planning`). `bmad-create-epics-and-stories` and `bmad-correct-course` are run by the Maintainer; when a retro or a blocked unit calls for a course correction, it goes to the Maintainer's inbox.
- **Forges:** GitHub (0.x) and local-only (v1), each behind one forge interface (CAP-24). GitLab and other forges come later.
- **No platform assumptions:** Xarabot does not assume AWS, SSO, hardware signing keys, a Claude-only sandbox, a JavaScript repo or a particular repo layout; any of those is an optional repo-supplied integration.

**Security and identity**
- **Agents never touch GitHub (from 0.x):**
  - Coding agents run sandboxed with no GitHub credentials (CAP-18).
  - Only the Xarabot runner holds the bot's private key, mints its tokens and talks to GitHub: claims, pushes, PRs, CI polling and merges. In local-only mode the same holds for the local `main` and the claims ref.
  - No session gets a GitHub token or reaches a GitHub host. A session that needs GitHub data, such as a retro reading PR history, reads files the runner fetched beforehand.
- **Identity:** lanes act only as their owner's bot (CAP-13): never a shared bot, an org-owned App, a bot user account or a human's own account.
- **No co-author markers:** no `Co-Authored-By` trailers or similar non-authoritative markers. The bot account is the only marker of lane-made work. The `Co-authored-by: <login>-xarabot[bot]` trailer that GitHub's squash merge adds itself is that marker, and is allowed (Maintainer, 2026-10-25).

**Process and release**
- **License and release:** open source as `xaravel/xarabot`, MIT license, published to npm as `@xaravel/xarabot` and installed with `bun add`. Consumers pin it exactly. Releases are cut only by the Maintainer, from CI.
- **Xarabot builds itself:** it has its own repo, BMAD plan, epics and changelog.
  - **Bootstrap:** a copy of Xaravel's `tools/orchestrator` runs against the Xarabot repo on the Xarabot host, as `edanisko-xarabot`, created before bootstrap by `bootstrap/join.ts` (which `xarabot join` later absorbs), with no admin merges, and builds only the first Epic: a single `claude` lane with `next`, plumbing in code, STOP, history and the agent sandbox (CAP-18). The copy runs as a dedicated macOS user on the Xarabot host that holds only the bot's private key, the Claude credential and its own clone: no `gh` login, ssh key or GitHub keychain item.
  - **Self-host:** the moment that lane works with its sandbox, Xarabot's own runner replaces the copy, and every later Xarabot Story is built by Xarabot. No Xarabot lane runs unsandboxed.
  - **Pinned runner:** the self-hosted runner runs a pinned Xarabot version (release or tag) that only the Maintainer advances, never re-execing from the branch it builds. Recovery is pinning back to the last good version.
- **Releases:** a 0.x release carries only what Xaravel's adoption needs; v1 adds the rest (`releases.md`).
- **Xaravel adoption:** planned and run in Xaravel. Xaravel is paused after Phase 0, its old loop stopped; a Xaravel course correction adds an Epic before Epic 9 that adopts Xarabot and removes `tools/orchestrator/` (`brownfield-xaravel.md`).

**Repo policy**
- **Consuming-repo rules bind Xarabot:**
  - Lanes never push to `main`.
  - Lanes never change `AGENTS.md` unless the Maintainer asks.
  - Lanes change Protected Paths only through a Maintainer-approved Infrastructure Story, or, for the Epic graph, a planning PR the Maintainer approves.
  - A PR that changes the effective Epic graph (the graph file, the Epic headings in `epics.md`, or a manifest's Epic) merges only with the Maintainer's approval, never just its bot owner's.
  - Xarabot config and `.agents/skills` become Protected Paths in the consumer.
- **Set by the consuming repo, never fixed in Xarabot:**
  - merge authority beyond CAP-13's default, and which humans may approve and merge;
  - the lane branch namespace;
  - which adapters may run unattended;
  - roles, tracks, Protected Paths, dependency-command list and Human Live Steps.

**Operating limits**
- **Write authority:** the coordinator lane is the only writer of `sprint-status.yaml` and `retro-gates.yaml`. Its runner-code unit, `reconcile`, alone sets a Story's or an Epic's (`epic-<N>`) status to `done`, writes retro verdicts and items, and opens PRs that are exempt from owner approval (Standing Authority). Its sessions are held to field rules: status planning only adds missing keys; a retro only appends its Epic's `action_items` and sets its own retro key. The 0.x write check (CAP-18) enforces all of this, on builder and coordinator diffs. Besides the coordinator, the Maintainer makes these bootstrap writes, all in Xarabot's own repo and each in a Maintainer PR:
  - at the self-host switch, running `bmad-sprint-planning` so that `sprint-status.yaml` has the bootstrapped Epic's Stories `done`, creating the file or updating it, and running Epic 1's retro, which writes its retro doc and its entry and action items in `sprint-status.yaml` (PR #53);
  - at the switch, Epic 2's Story manifests and Epic 2's Epic context file;
  - until the rulings Story merges, the go for a rejected retro, in `retro-gates.yaml`;
  - until graph planning units run (Story 2.7), in a correct-course PR, the `epics.md` section, Story manifest and `sprint-status.yaml` key (`backlog`) of each Story added to a started Epic.
- **Live evidence:** an Epic's retro runs only once the Maintainer's live evidence file is on `main` and, for each live command config lists for that Epic (`live_evidence_checks`), holds that command and a passing result.
- **Capacity:** a host runs at most `XARABOT_MAX_BUILDERS` builder lanes (Xaravel's host: 2).

## Non-goals

- A faster or cheaper default model tier.
- Project-specific platform parts, such as product eval gates, per-worktree service stacks, cloud transcript sinks, SSO roles or production deploy reviewers. A consuming repo supplies these as integrations.
- Planning or running Xaravel's adoption: Xaravel's own course correction does it.
- A hosted service: lanes run on the operators' own machines.
- Vendoring, forking or re-implementing BMAD's skills.
- GitLab and other forges before a later release.

## Success signal

- **Self-host:** Xarabot built the rest of its own 0.x (the `codex` adapter, the TUI, claims and parallel lanes) with its own pinned runner before Xaravel adopts it.
- **0.x:** in its adoption Epic (before Epic 9), Xaravel replaces `tools/orchestrator/` with a pinned Xarabot 0.x release.
  - A coordinator and 2 builder lanes on Xaravel's Xarabot host build Phase 1 Epics in parallel as `edanisko-xarabot`, choosing units with `next`, with no unit built twice and no admin merge.
  - edanisko approves the bot's Protected Path PRs directly.
  - Xarabot telemetry shows at least 1.4 Stories per hour, twice the baseline's 51 in 73 hours (`baseline-metrics.md`): merged Stories divided by wall-clock hours over one stated 7-day window of Xaravel work, excluding hours when every lane waits on the Maintainer (a checkpoint go included). All lanes and adapters count; Story size is not normalized.
- **v1:** a new project runs `bun add` for Xarabot plus the join command, and its team builds in BMAD with lanes. Concretely: a second person creates their bot, joins on their own machine, and starts a `codex` or `pi` lane. The guard enforces paths and commands for that lane, and claims keep both people's lanes off each other's units. A project with no remote runs the same lanes in local-only mode.

## Assumptions

- **BMAD:** Xarabot drives the stock BMAD skills installed in the consuming repo that run headless (`bmad-build-auto`, `bmad-retrospective`, `bmad-sprint-planning`). "Product management" in scope means driving those planning artifacts (sprint status, retros) and routing course corrections to the Maintainer, not a separate tool.
- **Same-vendor reviewer:** when the repo allows no adapter from another vendor, the reviewer is the first allowed adapter of `claude`, `codex`. A repo that allows neither has no reviewer, and its lanes refuse to start (0.x has no `pi` adapter). pi as a builder and a reviewer comes with the v1 adapter.
- **Bot cost:** an App takes no seat, on public or private org repos. It is marked public only so other orgs can install it.
- **Decided in the architecture spine** (`../../planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`), including the mechanics the 2026-10-20 spec review raised and the Maintainer's decisions of 2026-10-21:
  - the claims ledger on the `xarabot/claims` branch, heartbeat, fencing and takeover (AD-4 to AD-8), with the ledger's `park` values (AD-5, AD-7);
  - the Story manifest and its `depends_on`, met when each listed Story is `done` on `main` or has a `merged` ledger record (AD-10);
  - the Epic graph and gates: a Story is done when `sprint-status.yaml` on `main` says so, bootstrapped Epics count as done, and a rejected retro holds its dependents until the Maintainer's go (AD-11, AD-12, AD-28);
  - status and graph planning units, the Epic context file an Epic's Stories wait for, and the coordinator's order (AD-13);
  - the result schema and its values (AD-14);
  - the same-vendor reviewer (AD-16);
  - one sandbox for every adapter, and the vendor credential files it seeds sessions from (AD-17);
  - the Standing Authority frontmatter, the config paths and the 0.x Escalation source (AD-20);
  - effort mapping (AD-21);
  - the daily digest (AD-23);
  - the pinned runner's launcher, its version switch and upgrade PRs (AD-25);
  - keys, App rights and the App permission table, with no merge-queue permission (AD-26);
  - the forge port's contract suite and error kinds (AD-27, AD-32);
  - the write check (AD-30).
- **Still open in the spine:**
  - which `PATCH git/refs` response means "retry the swap" (409 or 422);
  - the `codex` adapter's outcome mapping, confirmed in Story 3.1 (the spike settled subagents, resume and usage: `../../planning-artifacts/notes/codex-ar42-spike-2026-10-25.md`).
  The local-only adapter (v1) is Deferred in the spine, not open.

## Open Questions

None.
