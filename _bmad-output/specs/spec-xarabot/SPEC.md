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

Xarabot makes Xaravel's unattended delivery layer its own versioned, open-source product, built on top of BMAD: a durable harness for team management, product management, the SDLC and agent management. It carries what Xaravel learned about bot identities and about stopping agents deterministically with paths and permissions. It is built to run any BMAD project unattended: a team adds it with `bun add`, and from then on works in BMAD with the orchestration layer and the coding job runners. Its first and reference consumer is Xaravel, run unattended on the M1.
- **What Xaravel proved:** its unattended loop (`tools/orchestrator/` in `xaravel/framework`) builds, reviews and merges BMAD Stories with no human watching: 51 Stories in 73 hours.
- **What holds it back:** it runs as one lane, picks its work from prompt prose, and spent a third of those hours between Epics (`baseline-metrics.md`).
- **Why now:** it lives inside one repo, so no other project can run unattended without copying it. The Maintainer is about to bring other people onto agent-built work and needs a planned way to do it.

## Capabilities

- **CAP-1 · Packaged and pinned (0.x)**
  - **intent:** Xarabot ships the runner (lanes, scheduled jobs, STOP marker, history), unit selection, claims, CI and merge plumbing, agent adapters, status reporting and prompt templates. A consuming repo adds it as a pinned dependency and supplies only its config, project-specific prompt sections, verification commands, policy files (Standing Authority, Actor registry, Human Live Steps) and Story manifests.
  - **success:** Xaravel runs every lane from a pinned Xarabot version, its tree holds no orchestration code beyond those supplied files, a Xarabot upgrade reaches it as a PR, and each Xarabot release has a changelog entry.
- **CAP-2 · Deterministic `next` (0.x)**
  - **intent:** A `next` command chooses the one unit a lane builds, in code, from Story manifests, sprint status, the dependency graph (`epics.md` dependencies, plus `package.json` workspace dependencies where the repo turns them on with an Epic-to-package map), open claims and the retro and checkpoint gates.
  - **success:** Unit tests cover each input and each gate; a repo with no `package.json` gets a correct graph from `epics.md` alone; the agent's prompt names the unit ("Build Story X") and contains no selection rules.
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
  - **intent:** One host, macOS or Linux, runs a coordinator lane (retros, retro action items, planning) and N builder lanes (Stories only), each builder with its own worktree, state folder and scheduled job (launchd or systemd).
  - **success:** On the M1, the coordinator and 2 builder lanes run for 24 hours with no unit built twice and no write to `sprint-status.yaml` or `retro-gates.yaml` from a builder.
- **CAP-5 · Parallel Epics (0.x)**
  - **intent:** Epics whose dependencies are done run at the same time, ordered by the dependency graph instead of strictly in sequence.
  - **success:** In Xaravel Phase 1, after `runtime` and then `contracts`, Stories from the `macroable`, `conditionable` and `json-schema` Epics are in flight at once, and a checkpoint Epic still stops later Epics until the Maintainer's go.
- **CAP-6 · Plumbing in code (0.x)**
  - **intent:** CI polling, the merge queue, mergeability checks, conflict resolution in the status YAML files, status comments, the progress line and sleeping through usage limits run in Xarabot code; the agent session only does the unit's work and returns a JSON result. The lessons in `brownfield-xaravel.md` § Lessons (CI polling, Conflicts, Merges) bind this code.
  - **success:** The agent prompt carries no CI, merge or status instructions; every session's output validates against the result schema; a usage-limit hit makes the lane sleep until the reset instead of failing.
- **CAP-7 · Agent adapters (0.x)**
  - **intent:**
    - Each lane runs its coding agent through an adapter: `claude`, `codex` or `pi`.
    - Every adapter takes the same three lane settings: `agent`, `model` and `effort`. `effort` is one scale for all adapters (`low`, `medium`, `high`, `xhigh`, `max`); each adapter maps it onto its CLI's own setting.
    - Each adapter's default settings use a top model; lane config can change model and effort.
    - The consuming repo's policy says which adapters may run unattended.
  - **success:**
    - The same unit runs to a valid JSON result through each adapter.
    - A lane with no `model` set runs its adapter's default top model; switching agent, model or effort is a config change only.
    - Each adapter maps `effort` per `agent-adapters.md` § Model and effort; a value an adapter cannot honor stops the lane at start instead of being dropped silently.
    - A lane whose adapter the repo's policy does not allow unattended refuses to start unattended.
- **CAP-8 · Cross-vendor review (0.x)**
  - **intent:** A diff built by one vendor's agent is reviewed by another vendor's agent before it merges: Claude reviews Codex- and pi-built diffs, and Codex reviews Claude-built ones. Its findings are blocking review loopbacks.
  - **success:** Every builder PR carries a review from a vendor other than its builder's, and no PR merges with that review's findings unresolved. If the two vendors still disagree after the loopback cap, or the reviewer adapter is not allowed or unavailable, the unit does not merge and is listed in its owner's inbox.
- **CAP-9 · Inboxes (0.x)**
  - **intent:** Each owner sees everything waiting on them in one inbox and rules on it in one sitting a day: their bot's PRs awaiting approval and their blocked units. The Maintainer's inbox also holds rulings, Escalations, waiting retro items and Human Live Steps. On a solo repo the two are one list.
  - **success:** One daily digest per inbox lists every waiting item with its link and age; an item that newly stops all lanes notifies at once; no other per-item waiting notices are sent.
- **CAP-10 · Retro gating (0.x)**
  - **intent:** A retro action item holds back the next Epic only when the retro tags it `blocking`; other items are worked alongside later Stories.
  - **success:** `next` tests: an untagged open item does not gate the next Epic but does gate the Epic after it; a `blocking` item gates the next Epic.
- **CAP-11 · Telemetry (0.x)**
  - **intent:** Each lane records per unit: agent, model, effort, unit, start, end, outcome, review loopbacks, CI fixes, and tokens and wall-clock cost (labeled an estimate for subscription runs), so agents and lanes can be compared.
  - **success:** A report over a chosen period shows, per agent and model, units done, median unit time, first-pass review rate, CI-fix count and cost, and feeds the consuming repo's dashboard.
- **CAP-12 · TUI (0.x)**
  - **intent:** An operator sees every lane at once in a read-only terminal UI: its unit, claim, CI and merge state, and the inbox, on the host itself or from another machine over ssh.
  - **success:** One command on a laptop shows the live state of every lane on the M1 over ssh and refreshes on its own; the same command works locally on the host.
- **CAP-13 · Bot identity (0.x)**
  - **intent:**
    - Each human owns one bot: a GitHub App owned by their own account, `<login>-xarabot` (for example `edanisko-xarabot`), acting as `<login>-xarabot[bot]`. `xarabot join` creates it from a manifest and installs it once per consuming org, with that org owner's approval.
    - Every commit, push and PR their lanes make is made as that bot, never as the human. The owning human is responsible for the bot's work.
    - The bot has no admin, bypass or approve rights. The runner mints short-lived installation tokens from the App's private key; no long-lived token is stored.
    - A PR touching no Protected Path merges on its required checks and the CAP-8 review; a PR touching a Protected Path needs its owner's approving review. A repo's policy can require more.
  - **success:**
    - `xarabot join` creates the owner's App with one confirm click and installs it with one more, or with an install request an org owner approves.
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
- **CAP-18 · Guard (sandbox 0.x; diff check and CI v1)**
  - **intent:** One fail-closed guard, the same for every adapter:
    - **Sandbox (0.x):** the coding agent runs with only its unit's worktree writable and no GitHub credentials (§ Constraints, "Agents never touch GitHub").
    - **Diff check (v1):** the runner refuses a returned diff that touches files outside the claim's globs, Protected Paths outside an approved Infrastructure Story, or dependency files the repo has not allowed.
    - **CI (v1):** CI re-checks the same rules.
    - **Hooks:** per-agent write-time hooks, where an agent has them, give earlier feedback but are never the boundary.
  - **success:**
    - Each refusal case has a test for each adapter.
    - An out-of-scope diff is never committed, and is logged with its reason.
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
- **Models:** each adapter's default lane settings use a top model (`agent-adapters.md`); lane config can change them, and Xarabot enforces no model floor.
- **Forges:** GitHub (0.x) and local-only (v1), each behind one forge interface (CAP-24). GitLab and other forges come later.
- **No platform assumptions:** Xarabot does not assume AWS, SSO, hardware signing keys, a Claude-only sandbox, a JavaScript repo or a particular repo layout; any of those is an optional repo-supplied integration.

**Security and identity**
- **Agents never touch GitHub (from 0.x):**
  - Coding agents run sandboxed with no GitHub credentials (CAP-18).
  - Only the Xarabot runner holds the bot's private key, mints its tokens and talks to GitHub: claims, pushes, PRs, CI polling and merges. In local-only mode the same holds for the local `main` and the claims ref.
  - A session that needs to read GitHub, such as a retro reading PR history, gets a read-only token or data the runner prefetched.
- **Identity:** lanes act only as their owner's bot (CAP-13): never a shared bot, an org-owned App, a bot user account or a human's own account.
- **No co-author markers:** no `Co-Authored-By` trailers or similar non-authoritative markers. The bot account is the only marker of lane-made work.

**Process and release**
- **License and release:** open source as `xaravel/xarabot`, MIT license, published to npm as `@xaravel/xarabot` and installed with `bun add`. Consumers pin it exactly. Releases are cut only by the Maintainer, from CI.
- **Xarabot builds itself:** it has its own repo, BMAD plan, epics and changelog.
  - **Bootstrap:** a copy of Xaravel's `tools/orchestrator` runs against the Xarabot repo on the M1, as `edanisko-xarabot`, created before bootstrap by `bootstrap/join.ts` (which `xarabot join` later absorbs), with no admin merges, and builds only the first Epic: a single `claude` lane with `next`, plumbing in code, STOP and history.
  - **Self-host:** the moment that lane works, Xarabot's own runner replaces the copy, and every later Xarabot Story is built by Xarabot.
  - **Pinned runner:** the self-hosted runner runs a pinned Xarabot version (release or tag) that only the Maintainer advances, never re-execing from the branch it builds. Recovery is pinning back to the last good version.
- **Releases:** a 0.x release carries only what Xaravel's adoption needs; v1 adds the rest (`releases.md`).
- **Xaravel adoption:** planned and run in Xaravel. Xaravel is paused after Phase 0, its old loop stopped; a Xaravel course correction adds an Epic before Epic 9 that adopts Xarabot and removes `tools/orchestrator/` (`brownfield-xaravel.md`).

**Repo policy**
- **Consuming-repo rules bind Xarabot:**
  - Lanes never push to `main`.
  - Lanes never change `AGENTS.md` unless the Maintainer asks.
  - Lanes change Protected Paths only through a Maintainer-approved Infrastructure Story.
  - Xarabot config and `.agents/skills` become Protected Paths in the consumer.
- **Set by the consuming repo, never fixed in Xarabot:**
  - merge authority beyond CAP-13's default, and which humans may approve and merge;
  - the lane branch namespace;
  - which adapters may run unattended;
  - roles, tracks, Protected Paths, dependency-command list and Human Live Steps.

**Operating limits**
- **Write authority:** the coordinator lane is the only writer of `sprint-status.yaml` and `retro-gates.yaml`.
- **Capacity:** at most 2 builder lanes on the M1.

## Non-goals

- A faster or cheaper default model tier.
- Project-specific platform parts, such as product eval gates, per-worktree service stacks, cloud transcript sinks, SSO roles or production deploy reviewers. A consuming repo supplies these as integrations.
- Planning or running Xaravel's adoption: Xaravel's own course correction does it.
- A hosted service: lanes run on the operators' own machines.
- Vendoring, forking or re-implementing BMAD's skills.
- GitLab and other forges before a later release.

## Success signal

- **Self-host:** Xarabot built the rest of its own 0.x (the `codex` and `pi` adapters, the TUI, claims and parallel lanes) with its own pinned runner before Xaravel adopts it.
- **0.x:** in its adoption Epic (before Epic 9), Xaravel replaces `tools/orchestrator/` with a pinned Xarabot 0.x release.
  - A coordinator and 2 builder lanes on the M1 build Phase 1 Epics in parallel as `edanisko-xarabot`, choosing units with `next`, with no unit built twice and no admin merge.
  - edanisko approves the bot's Protected Path PRs directly.
  - Xarabot telemetry shows at least 1.4 Stories per hour, twice the baseline's 51 in 73 hours (`baseline-metrics.md`): merged Stories divided by wall-clock hours over one stated 7-day window of Xaravel work, excluding hours when every lane waits on the Maintainer (a checkpoint go included). All lanes and adapters count; Story size is not normalized.
- **v1:** a new project runs `bun add` for Xarabot plus the join command, and its team builds in BMAD with lanes. Concretely: a second person creates their bot, joins on their own machine, and starts a `codex` or `pi` lane. The guard enforces paths and commands for that lane, and claims keep both people's lanes off each other's units. A project with no remote runs the same lanes in local-only mode.

## Assumptions

- **BMAD:** Xarabot drives the BMAD skills installed in the consuming repo (`bmad-build-auto`, `bmad-retrospective`, `bmad-sprint-planning`, `bmad-correct-course`). "Product management" in scope means driving those planning artifacts (sprint status, epics, retros, course corrections), not a separate tool.
- **Bot cost:** an App takes no seat, on public or private org repos. It is marked public only so other orgs can install it.
- **For architecture to decide or verify:**
  - Claims live on a dedicated `xarabot/claims` branch, updated by fast-forward-only push as the compare-and-swap; a custom `refs/` namespace is used only if GitHub accepts and protects it.
  - The sandbox wrapper per OS and adapter: codex's own sandbox, Claude Code's own sandbox, and a generic wrapper for `pi` (Seatbelt on macOS, bubblewrap or landlock on Linux).
  - Codex's reasoning-effort key and values, and how `effort: max` maps onto them.
  - The JSON result schema and the Story manifest format.
  - The bot App's minimum permissions (Contents, Pull requests, Checks, and what the merge queue needs), whether an App review could count toward required approvals (the guard refuses approvals either way), and where `xarabot join` stores the private key on macOS and Linux.
  - The forge interface, and the local-only adapter's claims and checks on a single host.
  - The claim and gate mechanics the 2026-10-20 review raised (heartbeat interval and fencing, claim rule per outcome, takeover, coordinator uniqueness across machines, gate scope on the dependency graph, guard diff details, token-free install and verify): `_bmad-output/planning-artifacts/reviews/spec-xarabot-review-2026-10-20.json`.

## Open Questions

None.
