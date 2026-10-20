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

## Why

A pain and a vision.
- **What Xaravel proved:** its unattended loop (`tools/orchestrator/` in `xaravel/framework`) builds, reviews and merges BMAD Stories with no human watching: 51 Stories in 73 hours.
- **What holds it back:** it runs as one lane, picks its work from prompt prose, and spent a third of those hours between Epics (`baseline-metrics.md`).
- **Why now:** it lives inside one repo, so no other project can run unattended without copying it. The Maintainer is about to bring other people onto agent-built work and needs a planned way to do it.

Xarabot makes this layer its own versioned, open-source product, built on top of BMAD. It is a durable harness for team management, product management, the SDLC and agent management. It carries what Xaravel learned about bot identities and about stopping agents deterministically with paths and permissions. Xarabot is built to run any BMAD project unattended: a team adds it to its project with `bun add`, and from then on works in BMAD with the orchestration layer and the coding job runners. Its first and reference consumer is Xaravel, run unattended on the M1.

## Capabilities

- **CAP-1**
  - **intent:** Xarabot ships the runner (lanes, scheduled jobs, STOP marker, history), unit selection, claims, CI and merge plumbing, agent adapters, status reporting and prompt templates. A consuming repo adds it as a pinned dependency and supplies only a config file, its project-specific prompt sections and its verification commands.
  - **success:** Xaravel runs every lane from a pinned Xarabot version, its tree holds no orchestration code beyond that config, a Xarabot upgrade reaches it as a PR, and each Xarabot release has a changelog entry.
- **CAP-2**
  - **intent:** A `next` command chooses the one unit a lane builds, in code, from Story manifests, sprint status, the dependency graph (`package.json` deps and `epics.md` dependencies), open claims and the retro and checkpoint gates.
  - **success:** Unit tests cover each input and each gate; the agent's prompt names the unit ("Build Story X") and contains no selection rules.
- **CAP-3**
  - **intent:**
    - A lane's runner, never its coding agent, claims a unit, its bot identity and its manifest globs by compare-and-swap on one claims ref.
    - A unit whose globs overlap an open claim is refused.
    - A claim lives by heartbeat, is released on merge or block, and expires 30 minutes after its last heartbeat.
  - **success:**
    - Two lanes racing for one unit, or for two units with overlapping globs: exactly one wins.
    - A killed lane's unit becomes claimable 30 minutes after its last heartbeat.
    - Both hold across machines.
- **CAP-4**
  - **intent:** One host, macOS or Linux, runs a coordinator lane (retros, retro action items, planning) and N builder lanes (Stories only), each builder with its own worktree, state folder and scheduled job (launchd or systemd).
  - **success:** On the M1, the coordinator and 2 builder lanes run for 24 hours with no unit built twice and no write to `sprint-status.yaml` or `retro-gates.yaml` from a builder.
- **CAP-5**
  - **intent:** Epics whose dependencies are done run at the same time, ordered by the dependency graph instead of strictly in sequence.
  - **success:** In Xaravel Phase 1, after `runtime` and then `contracts`, Stories from the `macroable`, `conditionable` and `json-schema` Epics are in flight at once, and a checkpoint Epic still stops later Epics until the Maintainer's go.
- **CAP-6**
  - **intent:** CI polling, the merge queue, mergeability checks, conflict resolution in the status YAML files, status comments, the progress line and sleeping through usage limits run in Xarabot code; the agent session only does the unit's work and returns a JSON result.
  - **success:** The agent prompt carries no CI, merge or status instructions; every session's output validates against the result schema; a usage-limit hit makes the lane sleep until the reset instead of failing.
- **CAP-7**
  - **intent:**
    - Each lane runs its coding agent through an adapter: `claude`, `codex` or `pi`.
    - Every adapter takes the same three lane settings: `agent`, `model` and `effort`. `effort` is one scale for all adapters (`low`, `medium`, `high`, `xhigh`, `max`); each adapter maps it onto its CLI's own setting.
    - The consuming repo's policy says which adapters, and which models, may run unattended.
  - **success:**
    - The same unit runs to a valid JSON result through each adapter.
    - Switching a lane's agent, model or effort is a config change only.
    - The lane's `effort` reaches each CLI as its own setting (`claude --effort`, `pi --thinking`, codex's reasoning-effort config), and a value an adapter cannot honor stops the lane at start instead of being dropped silently.
    - A lane whose adapter or model the repo's policy does not allow unattended refuses to start unattended.
- **CAP-8**
  - **intent:** A diff built by one vendor's agent is reviewed by another vendor's agent before it merges: Codex reviews Claude-built diffs, and Claude reviews Codex-built ones. Its findings are blocking review loopbacks.
  - **success:** Every builder PR carries a review from a vendor other than its builder's, and no PR merges with that review's findings unresolved. If the two vendors still disagree after the loopback cap, the unit is blocked and listed in the inbox.
- **CAP-9**
  - **intent:** The Maintainer sees everything waiting on them (rulings, Escalations, blocked units, waiting retro items, Human Live Steps, PRs awaiting their approval) in one inbox and rules on it in one sitting a day.
  - **success:** One daily digest lists every waiting item with its link and age; an item that newly stops all lanes notifies at once; no other per-item waiting notices are sent.
- **CAP-10**
  - **intent:** A retro action item holds back the next Epic only when the retro tags it `blocking`; other items are worked alongside later Stories.
  - **success:** `next` tests: an untagged open item does not gate the next Epic but does gate the Epic after it; a `blocking` item gates the next Epic.
- **CAP-11**
  - **intent:** Each lane records per unit: agent, model, unit, start, end, outcome, review loopbacks, CI fixes, and tokens and wall-clock cost (labeled an estimate for subscription runs), so agents and lanes can be compared.
  - **success:** A report over a chosen period shows, per agent and model, units done, median unit time, first-pass review rate, CI-fix count and cost, and feeds the consuming repo's dashboard.
- **CAP-12**
  - **intent:** An operator sees every lane at once in a read-only terminal UI: its unit, claim, CI and merge state, and the inbox, on the host itself or from another machine over ssh.
  - **success:** One command on a laptop shows the live state of every lane on the M1 over ssh and refreshes on its own; the same command works locally on the host.
- **CAP-13**
  - **intent:**
    - Each human owns one bot user account, `<login>-xarabot` (for example `edanisko-xarabot`).
    - Every commit, push and PR their lanes make is made as that bot, never as the human. The owning human is responsible for the bot's work.
    - The bot has no admin, bypass or approve rights.
    - The owner, or any human the repo's rules allow, reviews and merges.
  - **success:**
    - Every lane-made commit and PR is authored by the owner's bot.
    - The owner can approve and merge their bot's PR straight away, a Protected Path PR included.
    - The bot cannot approve any PR or merge past required checks or reviews, and Xarabot never issues an admin merge.
- **CAP-14**
  - **intent:** A team member joins by creating their `<login>-xarabot` bot, registering it under their name, and running one join command with setup docs; they then run lanes on their own machine against the same repo, with claims shared across machines.
  - **success:** A second person on a second machine follows the docs, runs the join command, starts a lane, and neither person's lanes build a unit the other holds.
- **CAP-15**
  - **intent:** An operator stops one lane or all lanes deterministically.
  - **success:** A STOP marker for a lane, or for the host, makes the affected lanes finish their current unit and exit, with no new claim taken.
- **CAP-16**
  - **intent:** (Optional, last.) A lane starts its next Story while its previous PR is still in CI or the merge queue.
  - **success:** With pipelining on, a lane claims its next unit before its previous PR merges, and no unit merges out of dependency order.
- **CAP-17**
  - **intent:** The consuming repo keeps an Actor registry: humans by GitHub login, their roles and tracks, and the `<login>-xarabot` bot each one owns. CODEOWNERS, rulesets and guard policy are generated from it.
  - **success:** Registering a person and their bot and merging gives them their role's rights everywhere; a bot not registered to a human is refused; a hand edit to a generated file fails a drift check.
- **CAP-18**
  - **intent:** One fail-closed guard, the same for every adapter:
    - **Sandbox:** the coding agent runs with only its unit's worktree writable and no GitHub credentials.
    - **Diff check:** the runner refuses a returned diff that touches files outside the claim's globs, Protected Paths outside an approved Infrastructure Story, or dependency files the repo has not allowed.
    - **CI:** CI re-checks the same rules.
    - **Hooks:** per-agent write-time hooks, where an agent has them, give earlier feedback but are never the boundary.
  - **success:**
    - Each refusal case has a test for each adapter.
    - An out-of-scope diff is never committed, and is logged with its reason.
    - An agent session cannot push, approve or merge, because it has no token.
    - A guard error blocks rather than allows.
- **CAP-19**
  - **intent:** Required gates (scope, Protected Paths, open escalations) are evaluated from the base branch, never from the PR's own code, with no bypass.
  - **success:** A PR that edits a gate's own code or config is still judged by `main`'s version of it.
- **CAP-20**
  - **intent:** An agent raises an escalation instead of deciding a contract question; a human decision binds to the escalation's exact text by hash, and an open escalation blocks its unit's merge.
  - **success:** Changing a decided escalation's text invalidates its decision; a unit with an open escalation cannot merge.
- **CAP-21**
  - **intent:** New Lessons and decision records reach every unit's session, whatever its adapter.
  - **success:** A Lesson merged before a unit starts appears in that unit's agent context, for each adapter.
- **CAP-22**
  - **intent:** A Standing Authority file in the consuming repo grants the lanes their authority; when it is absent or invalid, every lane stops.
  - **success:** Deleting the file on `main` stops every lane before its next claim.
- **CAP-23**
  - **intent:** The consuming repo lists Human Live Steps (live settings, secrets, rulesets and the like); lanes never attempt them and route them to the inbox.
  - **success:** A unit that reaches a listed step is marked waiting, and the step appears in the inbox with no attempt logged.

## Constraints

- **Toolchain:** Bun only: Bun 1.4.3, TypeScript 7 with `--strict`, oxlint. No Node, npm, pnpm, Jest, Vitest, ESLint or Prettier as tools.
- **Models:** building and reviewing use top models (Opus for `claude`, `gpt-sol-6.1` for `codex`). The one exception: `pi` lanes may use a flash-tier model where the repo allows it. Models are per-lane config.
- **License and release:** open source as `xaravel/xarabot`, MIT license, published to npm as `@xaravel/xarabot` and installed with `bun add`. Consumers pin it exactly. Releases are cut only by the Maintainer, from CI.
- **Platforms:** macOS (launchd) and Linux (systemd).
- **Agents never touch GitHub:**
  - Coding agents run with no GitHub credentials.
  - Only the Xarabot runner holds the `<login>-xarabot` token and talks to GitHub: claims, pushes, PRs, CI polling and merges.
  - A session that needs to read GitHub, such as a retro reading PR history, gets a read-only token or data the runner prefetched.
- **Process:** Xarabot has its own repo, BMAD plan, epics and changelog, and builds itself.
  - **Bootstrap:** a copy of Xaravel's `tools/orchestrator` runs against the Xarabot repo on the M1 and builds only the first Epic: a single `claude` lane with `next`, plumbing in code, STOP and history.
  - **Self-host:** the moment that lane works, Xarabot's own runner replaces the copy in its own repo, and every later Xarabot Story is built by Xarabot.
- **Releases:** a 0.x release carries only what Xaravel's Epic 8 cutover needs; v1 adds the rest (`releases.md`).
- **Cutover:** Xaravel's running loop must not be stopped or broken. Xarabot is built while Xaravel's Epic 8 runs; Xaravel cuts over at the Epic 8 checkpoint, which needs the Maintainer's go (`brownfield-xaravel.md`).
- **Identity:** lanes act only as their owner's `<login>-xarabot` bot user: one bot per human, never a shared bot, an App or a human's own account. A human's review is what makes a merge authoritative, Protected Path PRs included; the bot's own output never is.
- **No co-author markers:** no `Co-Authored-By` trailers or similar non-authoritative markers. The bot account is the only marker of lane-made work.
- **Consuming-repo rules bind Xarabot:**
  - Lanes never push to `main`.
  - Lanes never change `AGENTS.md` unless the Maintainer asks.
  - Lanes change Protected Paths only through a Maintainer-approved Infrastructure Story.
  - Xarabot config and `.agents/skills` become Protected Paths in the consumer.
- **Repo policy:** these are set by the consuming repo, never fixed in Xarabot:
  - which humans may approve and merge;
  - the lane branch namespace;
  - which adapters may run unattended;
  - roles, tracks, Protected Paths, dependency-command list and Human Live Steps.
- **No platform assumptions:** Xarabot does not assume AWS, SSO, hardware signing keys, a Claude-only sandbox or a particular repo layout; any of those is an optional repo-supplied integration.
- **Write authority:** the coordinator lane is the only writer of `sprint-status.yaml` and `retro-gates.yaml`.
- **Capacity:** at most 2 builder lanes on the M1.
- **Checkpoints:** checkpoints hold under parallel Epics.
- **Grok:** a Grok adapter comes only after lanes run as bot identities (CAP-13).

## Non-goals

- A faster or cheaper model tier.
- Project-specific platform parts, such as product eval gates, per-worktree service stacks, cloud transcript sinks, SSO roles or production deploy reviewers. A consuming repo supplies these as integrations.
- Changes to Xaravel's running loop before the Epic 8 cutover, beyond the quick wins in Xaravel PR #216.
- A hosted service: lanes run on the operators' own machines.
- Re-implementing BMAD's skills: Xarabot drives the BMAD skills installed in the consuming repo.

## Success signal

- **Self-host:** Xarabot built the rest of its own 0.x (the `codex` and `pi` adapters, the TUI, claims and parallel lanes) with its own runner before Xaravel adopts it.
- **0.x:** at the Epic 8 checkpoint, Xaravel replaces `tools/orchestrator/` with a pinned Xarabot 0.x release.
  - A coordinator and 2 builder lanes on the M1 build Phase 1 Epics in parallel as `edanisko-xarabot`, choosing units with `next`, with no unit built twice and no admin merge.
  - edanisko approves the bot's Protected Path PRs directly.
  - Over a week of Xaravel work, Xarabot telemetry shows at least 1.4 Stories per hour, twice the baseline's 51 in 73 hours (`baseline-metrics.md`).
- **v1:** a new project runs `bun add` for Xarabot plus the join command, and its team builds in BMAD with lanes. Concretely: a second person creates their bot, joins on their own machine, and starts a `codex` or `pi` lane. The guard enforces paths and commands for that lane, and claims keep both people's lanes off each other's units.

## Assumptions

- **Local checkout:** `~/repos/xarabot`. The GitHub repo `xaravel/xarabot` is not created yet.
- **BMAD:** Xarabot drives the BMAD skills installed in the consuming repo (`bmad-build-auto`, `bmad-retrospective`, `bmad-sprint-planning`, `bmad-correct-course`); it does not vendor or fork BMAD. "Product management" in scope means driving those planning artifacts (sprint status, epics, retros, course corrections), not a separate tool.
- **Quick wins:** CAP-9 and the batch routing of Maintainer-only retro items port what Xaravel PR #216 adds to `iteration.md`. CAP-10's blocking tag was trimmed from #216, because it pays off only with parallel lanes; it is first built in Xarabot.
- **Pipelining:** CAP-16 is optional and built last.
- **Bot seats:** GitHub's terms allow one free machine account per person, so one bot per human fits. On private organization repos each bot needs a seat.
- **For architecture to verify:**
  - Claims live on a dedicated `xarabot/claims` branch, updated by fast-forward-only push as the compare-and-swap; a custom `refs/` namespace is used only if GitHub accepts and protects it.
  - The sandbox wrapper per OS and adapter: codex's own sandbox, Claude Code's own sandbox, and a generic wrapper for `pi` (Seatbelt on macOS, bubblewrap or landlock on Linux).

## Open Questions

- **pi model:** the exact OpenRouter model for `pi` lanes (given as roughly "glm-flash 5.3" or "gpt luna"). The operator picks it when signing in to OpenRouter through pi.
- **Codex effort values:** the reasoning-effort setting codex accepts, and how `effort: max` maps onto it.
- **Xaravel cutover identity:** creating `edanisko-xarabot`, adapting `docs/ops/identities.md` and `ruleset:identity` to the `<login>-xarabot` naming, and the `Agent pushes` ruleset redesign need a Xaravel Maintainer ruling at cutover.
