# Review: reconcile spec against spine

- **Spine:** `ARCHITECTURE-SPINE.md` (status draft, updated 2026-10-21), rationale `.memlog.md`
- **Inputs:** `_bmad-output/specs/spec-xarabot/SPEC.md`, `glossary.md`, `releases.md`, `baseline-metrics.md`, `agent-adapters.md`, `brownfield-xaravel.md`. Cross-checked: `spec-xarabot-review-2026-10-20.json` (the spec delegates claim and gate mechanics to it), the spec `.memlog.md`, `bootstrap/join.ts`.
- **Date:** 2026-10-21. Read-only. The spine was not edited.

## Verdict

**Revise before Epics.** The spine covers the claim, gate, sandbox, identity and pinning mechanics well. Most review JSON items are closed. The gaps are in the loops that close around a unit:

- the agent result for coordinator and reviewer sessions;
- inbox rulings and their writer;
- what happens after CI fails or an owner approves;
- prompt content;
- the 0.x enforcement of who writes which files.

Five findings are blocking (B), 12 should be fixed (S), and 12 are minor (M). None of them says the spine is wrong in principle. Each one names a missing AD, a missing rule in an existing AD, or a missing Deferred entry.

Severity:
- **B (blocking):** an Epic builder would have to make a decision that converging lanes need to share, or a 0.x success criterion cannot be met as written.
- **S (should fix):** a rule from the spec or a lesson that is dropped or weakened.
- **M (minor):** a terminology, completeness or sequencing note.

---

## Blocking findings

### B1. The inbox and rulings loop is not closed, and AD-23 conflicts with AD-8

- **Source:**
  - CAP-9: one inbox per owner, ruled on in one sitting, and an item that newly stops all lanes notifies at once.
  - CAP-14: a second person's lanes.
  - glossary § Inbox.
  - brownfield § What exists, PR #216: batch routing of Maintainer-only retro items.
  - `baseline-metrics.md`: one iteration per routed item was wasted.
- **Spine:**
  - AD-23 makes the coordinator the only inbox writer.
  - AD-8: "When the coordinator's claim expires … the Maintainer's inbox gets an item."
  - AD-7: "A ruling in the inbox clears `parked`."
  - AD-3: the writer of parked records is "the runner that holds or parks the unit".
- **Problems:**
  1. **Contradiction.** When the coordinator is dead, nothing may write the inbox item that reports it. The urgent @mention for "an item that newly stops every lane" has the same problem: graph invalid (AD-11) and Standing Authority missing (AD-20) also stop the coordinator.
  2. **Rulings have no input path.** The spine does not say how a human records a ruling (issue comment, checkbox, file on `main`), who reads it, or which process writes the ledger edit that clears `parked`. AD-3's single-writer table has no row for clearing parked records or for recording the checkpoint go. The memlog says "cleared by the ruling". A ruling is not a writer.
  3. **GitHub caps pinned issues at 3 per repository.** "One pinned issue per owner" breaks once a fourth owner joins (CAP-14, v1).
  4. **Batch routing is not stated.** PR #216's batch routing of Maintainer-only retro items is a ported behaviour. The spine does not say that routing happens in code, in one pass, and not as one session per item.
- **Fix:**
  - Extend AD-23:
    - Name the ruling input format and its reader (the coordinator's `rulings` unit). Add rows to AD-3 for "parked cleared" and "checkpoint go" with the coordinator as writer.
    - Let any lane post the stop-everything @mention on a deduplicated key (for example, a ledger flag or a fixed comment marker), because the coordinator may be one of the stopped lanes.
    - Drop "pinned", or pin only the Maintainer's inbox and find other owners' issues by label.
    - State that Maintainer-only retro items are routed in batch, in code.

### B2. The result contract covers only builder sessions

- **Source:**
  - CAP-6: "every session's output validates against the result schema".
  - CAP-8: the reviewer's "findings are blocking review loopbacks".
  - CAP-10: the retro tags an item `blocking`.
  - CAP-11: first-pass review rate.
  - SPEC § Assumptions: "The JSON result schema" is for architecture to decide.
  - brownfield § What exists: Xaravel's `blocking` tag was trimmed out, and "CAP-10 is first built in Xarabot".
- **Spine:**
  - AD-14 gets the result only "through `bmad-build-auto`'s `on_complete` hook". Its fields are `done|blocked|no-op` plus PR text.
  - AD-16 does not give the reviewer's output a shape.
  - AD-27 names a `retro-gates.yaml` schema but gives no fields.
- **Problems:**
  - Coordinator units (retro, retro item, planning, checkpoint) run `bmad-retrospective`, `bmad-sprint-planning` and `bmad-correct-course`, not `bmad-build-auto`. They have no hook and no result path.
  - Reviewer sessions also have no hook and no result path, and they need a findings list with a blocking flag.
  - Nothing produces the `blocking` tag. Stock BMAD 6.12.4 has none (memlog, reality check).
  - The memlog decision that "retro-gates.yaml is coordinator-only and Xarabot owns its versioned schema: per Epic verdict and checkpoint go; per item id, text, owner, status, blocking", plus migration of Xaravel's file, never reached the spine.
- **Fix:**
  - Make AD-14 a result union keyed by unit kind: `build`, `review` (findings with `blocking: bool`, file and line, text), `retro` (verdict, items with owner and `blocking`), `planning`, `checkpoint`.
  - Give each kind the delivery mechanism it uses: a hook or override per skill, or a prompt-instructed file write.
  - Add the `retro-gates.yaml` fields to an AD.
  - Add "how retros emit the `blocking` tag" as a `bmad-customize` override, alongside AD-11's epics override.

### B3. No AD governs what goes into the agent's prompt

- **Source:**
  - CAP-1: the consumer supplies "project-specific prompt sections".
  - CAP-2 success: "the agent's prompt names the unit ('Build Story X') and contains no selection rules".
  - CAP-6 success: "The agent prompt carries no CI, merge or status instructions".
  - CAP-23: lanes never attempt Human Live Steps, so the agent must know the list.
  - CAP-21 (v1): Lessons.
  - brownfield § Lessons, Auto-mode limits: edit tracked files in place, and "A denied action must be reported, never worked around".
  - agent-adapters.md: skills reach codex through `.agents/skills`.
- **Spine:** AD-20 names `prompts/` and package prompt templates. No rule says what a prompt must and must not contain, how the parts are put together, or that they come from fetched `main`. CAP-21 is Deferred with only a freshness rule.
- **Fix:** add a new AD for prompt assembly. It covers:
  - It is a pure function in `src/core/` over (unit, package template, repo `prompts/` from `origin/main`, Human Live Steps list, and later Lessons).
  - The prompt must name the unit.
  - It must not contain selection, CI, merge, status or GitHub instructions. Add a test that greps rendered prompts.
  - It carries the "report a denied action through `blocked`, never work around it" rule.
  - Consider adding a `blocked.kind` value `permission-denied`, so telemetry and the inbox can tell these cases apart.

### B4. 0.x has no enforcement of coordinator-owned files and Protected Paths, and the Protected Paths list drops `.agents/skills`

- **Source:**
  - CAP-4 success (0.x): "no write to `sprint-status.yaml` or `retro-gates.yaml` from a builder".
  - SPEC § Constraints, Repo policy: "Xarabot config and `.agents/skills` become Protected Paths in the consumer". Also: "Lanes never change `AGENTS.md` unless the Maintainer asks", and "Lanes change Protected Paths only through a Maintainer-approved Infrastructure Story".
  - brownfield § Adoption: add `.agents/skills` to `conformance/protected-paths`.
  - Review JSON item 44.
- **Spine:**
  - AD-20 lists only `.xarabot/**` and the Standing Authority file as consumer Protected Paths.
  - AD-10 says "A builder may never change a manifest, `epics.md`, `sprint-status.yaml` or `retro-gates.yaml`". The memlog says such a diff "is refused". But the whole guard diff check is Deferred to v1, so nothing enforces this in 0.x.
  - AD-3 says the agent session writes the Story spec `status` frontmatter inside the PR diff. In Xaravel's classic shape the Story file is the manifest (`stories/<id>.md` carries `status`, memlog reality check), so AD-3 and AD-10 contradict each other for the first consumer.
  - `infrastructure: true` is a manifest field the coordinator writes. Nowhere is the Maintainer's approval of an Infrastructure Story recorded or checked.
- **Fix:**
  - Add `.agents/skills/**` (and `.claude/skills/**`, which Claude Code reads), and `AGENTS.md`, to AD-20's default consumer Protected Paths.
  - Add a minimal 0.x runner-side refusal to AD-10 or AD-18: refuse a builder diff that touches coordinator-owned files or manifests. This is a fixed path list, not the v1 glob guard.
  - Settle the Story-file-equals-manifest case: either allow only the `status` key to change, or keep the manifest and the Story spec in separate files.
  - Record Infrastructure Story approval, for example a Maintainer ruling or an `infrastructure_approved_by` field set only from a ruling. `next` must refuse an unapproved Infrastructure Story.

### B5. No CI-failure loop, and telemetry cannot compute the 0.x success metric

- **Source:**
  - CAP-11 records "CI fixes" and reports a CI-fix count.
  - brownfield § CI polling: "Stop on the first unexpected failure". This implies a known set of expected failures, such as Xaravel's `protected-paths` check while it waits for the owner's review.
  - SPEC § Success signal (0.x): the rate excludes "hours when every lane waits on the Maintainer (a checkpoint go included)".
  - `releases.md`: CAP-11 is in 0.x "because the 0.x success signal is measured from its telemetry".
- **Spine:**
  - AD-19 says when to stop polling, but not what follows an unexpected failure: a CI-fix builder session, its cap, whether it counts as an attempt, and whether it re-runs the AD-16 review.
  - Nothing classifies a check as expected to fail. AD-7's "waiting for owner's approval" assumes the runner knows.
  - AD-24 journals one record per unit, so idle periods and their reasons (AD-13 `idle` with a reason) are never recorded. "Every lane waits on the Maintainer" cannot be computed.
- **Fix:** extend AD-19 with:
  - Unexpected failure → a CI-fix session on the unit branch. It counts in `ci_fixes`, has a cap, and parks blocked at the cap.
  - Any change to the diff after review triggers a new review over the new final diff (keeps AD-16's "reviewed diff = merged diff"). This applies to CI fixes, conflict sessions and queue-ejection merges that touch the unit's own lines.
  - An expected-check list in `policy.yaml`.

  Extend AD-24 so the journal also records idle and wait intervals with their reason (`waiting-maintainer`, `checkpoint`, `usage-limit`, `stop`), and `xarabot report` computes the success-signal rate as the spec defines it.

---

## Should fix

### S1. Owner-approved PRs have no path to `merged`

- **Source:** CAP-13 success: "The owner can approve and merge their bot's PR straight away". CAP-3: a claim is released on merge.
- **Spine:**
  - AD-7 has `parked`, globs held, and the state diagram has `parked_held → merged: approved and merged`.
  - AD-2 says the lane process exits after the unit.
  - AD-3 gives the tombstone writer as "the runner that holds or parks the unit".
- **Gaps:**
  - No process watches for the approval or the manual merge.
  - No process enqueues the PR after approval when the owner only approves.
  - No process keeps the PR mergeable (conflicts with `main`, ejections) while it is parked.
  - No process writes the tombstone after a manual merge. Until one does, `next` sees `parked` (ledger wins) and the unit never counts as done.
- **Fix:** give these to the coordinator's `rulings` or `open coordinator PR` step, or to a builder step that runs before `next`. Add the writer to AD-3. State whether parked records ever expire. The spec's 30-minute expiry is written for claims, and the parked states are an extension (see Approved extensions).

### S2. The coordinator role claim cannot survive the idle wait

- **Spine:**
  - AD-8 keeps `coordinator.json` alive "exactly like a unit".
  - AD-6 heartbeats through the agent session, CI waits and usage-limit sleeps.
  - AD-2 says the process waits 30 minutes after `idle` and then exits.
  - AD-7 says idle leaves "no record".
- **Problem:** a coordinator that idles lets its role claim lapse at 30 minutes, every cycle. A second coordinator elsewhere could then take the role, and AD-8's expiry inbox item would fire constantly.
- **Source:** CAP-4 and CAP-14 need one coordinator across machines (review JSON items 4 and 42).
- **Fix:** heartbeat the role claim during inter-unit waits too, or exempt the role claim from the 30-minute rule with a longer, documented TTL. Say which in AD-8.

### S3. AD-7 releases globs for blocks that happen after a PR exists, against the user decision

- **Source:** spine memlog line 26 (by user): "a unit blocked **before a PR exists** releases its globs".
- **Spine:** AD-7 releases globs for "review disagreement after the cap" and "CI wait exceeded". Both happen after the PR exists, because the review is posted on the PR. If the ruling is "merge it", another unit may already hold overlapping globs, and the reviewed diff no longer merges cleanly.
- **Fix:** split the AD-7 row by whether a PR exists (held after a PR exists, released before), or record the Maintainer's choice explicitly.

### S4. Bootstrap and self-host order versus "Agents never touch GitHub (from 0.x)"

- **Source:**
  - SPEC § Constraints, Bootstrap: the first Epic is "a single `claude` lane with `next`, plumbing in code, STOP and history". There is no sandbox.
  - Self-host: "the moment that lane works, Xarabot's own runner replaces the copy".
  - releases.md: the CAP-18 sandbox is 0.x "because without it a lane's agent inherits the host's GitHub login".
  - spec memlog 134: the copied loop uses the bot token in-session.
- **Spine:** the stated audience is "the bootstrap claude lane first", but no AD says which ADs the first self-hosted runner must already meet.
- **Problem:** as written, the self-hosted runner can run before AD-17 exists, with the agent inheriting the host's `gh` login.
- **Fix:** add a short section listing what must exist before the copy is retired: AD-15, AD-17 (at least credential denial), AD-25 and AD-20. Also list the cutover step: STOP the copy and confirm it has exited before the first ledger claim, because the copy does not read the ledger (review JSON items 14 and 68). Self-host before the sandbox is a decision only the Maintainer can make, so ask if Epic 1 cannot carry AD-17.

### S5. The bot's "no approve rights" is not enforced by construction

- **Source:**
  - CAP-13: "The bot has no admin, bypass or approve rights"; "The bot cannot approve any PR".
  - SPEC § Assumptions: "whether an App review could count toward required approvals (the guard refuses approvals either way)".
- **Spine:** AD-26 states the property. AD-16 says "The review is posted on the PR".
- **Problem:** `pull_requests: write`, which `bootstrap/join.ts` requests, lets an App submit an `APPROVE` review. No App permission removes that right.
- **Fix:** add to AD-15 or AD-23 that the forge port has no approve operation and that the AD-16 review is posted as a comment or a `COMMENT` review, never `APPROVE`. Add a contract-suite test. Answer the spec's open question (does an App review count toward required approvals?) or list it under Deferred open items.

### S6. The App permissions list is incomplete

- **Source:** SPEC § Assumptions asks for "The bot App's minimum permissions (Contents, Pull requests, Checks, and what the merge queue needs)".
- **Spine:** only `issues: write` is added (AD-23), and merge-queue enqueue is an open item.
- **Gaps:**
  - GitHub rejects a push that changes `.github/workflows/**` unless the App has `workflows: write`. Infrastructure Stories in Xaravel, and Xarabot's own CI, will touch workflows.
  - The spine does not list the full permission set: contents, pull_requests, checks, statuses, actions read, metadata, issues, and whatever merge-queue enqueue needs.
- **Fix:** add the full list to AD-26, and either add `workflows: write` or state that workflow changes are Human Live Steps.

### S7. The Standing Authority file has no validity rule, and its relation to `policy.yaml` is undefined

- **Source:**
  - CAP-22: "absent or invalid" stops every lane.
  - Review JSON item 17: "a schema for validity".
  - brownfield § Adoption: Xaravel's MAINT file becomes its Standing Authority file, "covering Codex's review mode, lanes and parallel Epics". So the file grants scopes.
- **Spine:** AD-20 re-checks the file's presence from `main`, but never says what "valid" means. Xaravel's MAINT file is Markdown prose. Adapter allowances live in `policy.yaml`, while the Standing Authority file supposedly grants authority. Two files could disagree.
- **Fix:** define the minimum machine-checked content of the Standing Authority file in AD-20, for example frontmatter `xarabot_authority: {version, grants: [...], expires?}`. State which file wins: policy can only narrow what the Standing Authority file grants.

### S8. A selected-repositories installation is not checked at lane start

- **Source:** CAP-13 success: "With a selected-repositories installation, adopting a repo the installation does not cover stops with the repo to add". spec memlog 164.
- **Spine:** AD-21's start checks do not include it.
- **Fix:** add to the AD-21 start checks: the owner's installation must cover the repo, or the lane stops with a message that names the repo to add.

### S9. Token failures and GitHub rate limits are not handled

- **Source:** review JSON item 69: a bot token expires, is revoked or is rate-limited mid-unit. CAP-6 requires usage limits to make the lane sleep rather than fail. GitHub limits are the forge-side counterpart, and N lanes poll CI.
- **Spine:** AD-22 covers agent usage limits only.
- **Fix:** add a forge-side rule to AD-22:
  - On 401, re-mint the token.
  - On 403 or 429 for a rate limit, sleep until reset with the heartbeat kept.
  - On repeated failure, park and add an inbox item.
  - Set a CI poll interval in config, so lanes × polls stays within the installation's rate limit.

### S10. Verification and install commands: source and lifecycle scripts

- **Source:**
  - CAP-1: the consumer supplies "verification commands".
  - Review JSON items 15 and 59: run them sandboxed, "with command definitions from the base branch", with lifecycle scripts, hooks and filters off.
- **Spine:**
  - AD-18 sandboxes repo commands and turns off git hooks.
  - It does not say verification commands are read from `origin/main`. They are not in AD-20's listed repo files.
  - It does not say whether the runner runs them at all, or only trusts the agent's `verification` array (AD-14).
  - It does not say package-manager lifecycle scripts are off when the runner regenerates a lockfile.
- **Fix:** add these to AD-18 and AD-20.

### S11. Checkpoint scope differs from the glossary, and `Depends on: none` lets an Epic skip the checkpoint

- **Source:**
  - glossary § Checkpoint Epic: "before later Epics start".
  - CAP-5: "a checkpoint Epic still stops later Epics until the Maintainer's go".
- **Spine:**
  - AD-12 holds only Epics that depend on C, transitively. This is a Maintainer-approved reading (memlog line 57, by user).
  - AD-11 accepts `Depends on: none`, so an Epic can opt out of a checkpoint without leaving the bullet out. The memlog's claim that "no Epic escapes a checkpoint by omission" is true only for a missing bullet.
- **Fix:**
  - Route the glossary and CAP-5 wording change through `bmad-spec`, so the spec says "dependent Epics".
  - In the Xaravel adoption inputs (S12), require every Phase 1 Epic to depend, directly or transitively, on Epic 8.
  - Optionally have graph validation warn when an Epic numbered after a checkpoint does not depend on it.

### S12. Consumer adoption inputs that the architecture creates are not listed

- **Source:** brownfield § Adoption lists what Xaravel's course correction needs. Planning the adoption is a non-goal, but the spine creates new consumer obligations that the Xaravel Epic must know about.
- **Missing obligations:**
  - `Depends on` and `Checkpoint` bullets in Xaravel's `epics.md`, which today orders Epics in prose (memlog line 38).
  - Migration of `retro-gates.yaml` to Xarabot's schema (memlog line 59).
  - The `bmad-build-auto` `on_complete` result hook and the epics and retro overrides under `_bmad/custom/`.
  - The `xarabot/claims` ruleset (a Human Live Step).
  - Escalations read through config.
  - The `Agent pushes` ruleset redesign must allow the bot to push `xarabot/claims` and the unit namespace, and must not block the merge queue or `gh-pages`.
- **Fix:**
  - Add a short "Consumer obligations" section, or a Deferred entry that points at it.
  - Also check CAP-1's "no orchestration code beyond those supplied files" against the `_bmad/custom/` overrides. Either add them to CAP-1's supplied list (a `bmad-spec` change) or have Xarabot install them.

---

## Minor findings

- **M1 · Worktree versus clone.** CAP-4 and the glossary say each lane has its own worktree. AD-17 requires "the lane's own full clone (never a linked worktree)", for codex and sandbox reasons. This is acceptable, but say in AD-17 that this is how CAP-4's "worktree" is met, so a builder does not "fix" it back to `git worktree`.
- **M2 · Read-only GitHub data for sessions.** SPEC § Constraints allows "a read-only token or data the runner prefetched" for sessions that read GitHub, for example a retro reading PR history. AD-17 forbids every GitHub host, which leaves prefetch as the only option, but no AD defines prefetch. The memlog records the approval as "'No' read as agreeing". Confirm this with the Maintainer, then add a prefetch rule (what is fetched, and where it lands in the clone) to the coordinator-unit result and prompt ADs (B2 and B3).
- **M3 · Status comments and the progress line.** CAP-6 lists "status comments, the progress line" as plumbing in code, and brownfield names status issue #10 and `progress.sh`. The spine has only the 🤖 prefix convention. Name the writer, place and cadence, for example the coordinator rewriting one status comment, so N lanes do not each post comments.
- **M4 · Changelog and release.** CAP-1 success says "each Xarabot release has a changelog entry". SPEC § Process says "Releases are cut only by the Maintainer, from CI" and "Xarabot builds itself … its own … changelog". No AD covers the changelog. Who writes it (a unit's PR, or the coordinator at release), and how do disjoint-glob units avoid conflicts on `CHANGELOG.md`? Review JSON item 56 names CHANGELOG as a shared-file conflict source. AD-19 regenerates only lockfiles. Add a changelog rule (for example, fragment files per unit) or a Deferred entry.
- **M5 · Runner version source.** AD-25 runs `~/.xarabot/runner/<version>/`, and the consumer pins with `bun add -E`. It does not say whether a lane runs the consumer's pinned version from `main`'s `package.json` or a host-pinned version. CAP-1 says "Xaravel runs every lane from a pinned Xarabot version … upgrade reaches it as a PR", which suggests the consumer's pin on `main`. State it, and state who opens the upgrade PR.
- **M6 · `--permission-mode auto` and adapter command lines.** agent-adapters.md fixes each adapter's invocation, for example claude `--permission-mode auto`, and codex `--json` with skills through `.agents/skills`. The spine does not say that the adapters keep these invocations apart from the sandbox change. One sentence in AD-17 or AD-21 settles it.
- **M7 · The pi default model is hidden state.** agent-adapters.md gives pi's default as "the model picked at OpenRouter sign-in". Review JSON item 51 says to always pass `--model` and stop if the reported model differs. AD-21's "unset model uses the adapter's default" lets the pi lane's model depend on that sign-in. Resolve the default to an explicit value at lane start and journal it.
- **M8 · Keychain denial may break claude authentication on macOS.** AD-17 makes `~/Library/Keychains` unreadable, which was tested to block `gh`. Claude Code stores subscription OAuth credentials in the macOS Keychain, so the same rule may lock the `claude` adapter out. This is a verification item for the sandbox Story. It may need an allowlisted credential environment variable. Add it to Deferred open items.
- **M9 · Retro item tags beyond `blocking`.** Xaravel's file has `waiting_on_maintainer`, and review JSON item 41 asks about `waiting` and `deferred` tags. AD-12 defines only `blocking` and untagged. State that any other tag counts as untagged for gating, or list the tags.
- **M10 · Commit identity and signed commits.** AD-15 says the runner squashes "authored by the owner's bot". Add the convention `bootstrap/join.ts` already prints, `<slug>[bot] <<bot-user-id>+<slug>[bot]@users.noreply.github.com>`. Also note that a consumer ruleset requiring signed commits ("a repo's policy can require more", CAP-13) needs commits created through the API, not `git push`.
- **M11 · "Unattended" implies an attended mode.** CAP-7 says a disallowed adapter "refuses to start unattended". The spine has no attended mode, so AD-21's refusal is correct for 0.x. Note that attended runs are out of scope, or define them.
- **M12 · The TUI's inbox and CI state.** CAP-12 shows "unit, claim, CI and merge state, and the inbox". AD-24 makes `status --json --watch` the only interface, but does not say where it gets CI, merge and inbox state. The options are lane-written state files or forge reads by the status command on the host. Choose one, to keep "the TUI never decides" honest.

---

## Spine decisions that go beyond or reinterpret the spec

These are not contradictions. Each one is recorded in the spine memlog. Where the spec text now reads differently, a `bmad-spec` update is recommended so the two do not drift apart.

| Spine | Spec text | Status |
| --- | --- | --- |
| AD-16: the runner enforces CAP-8 in a fresh read-only session over the final diff, and the BMAD hook is never the gate. | agent-adapters.md: "Xarabot uses that hook point instead of forking the skill." | **Approved extension** (memlog line 46, by user). Spec update recommended. |
| AD-17: one Xarabot wrapper (`sandbox-exec` or `bwrap`) for every adapter, with the agents' own sandboxes off. | SPEC § Assumptions: "codex's own sandbox, Claude Code's own sandbox, and a generic wrapper for `pi`". agent-adapters.md: codex "network turned on in its sandbox". | **Approved** (memlog line 61, by user). The assumption was explicitly left for architecture to decide. |
| AD-4 and AD-7: the ledger holds `parked` and `merged` records beyond live claims, and `parked` holds globs while waiting for approval. | CAP-3: a claim "is released on merge or block, and expires 30 minutes after its last heartbeat". | **Approved extension** (memlog lines 24 and 26, by user). Spell out that parked and merged records do not expire (see S1). |
| AD-12: a checkpoint holds only its dependents. | glossary and CAP-5: "later Epics". | **Approved reinterpretation** (memlog line 57, by user). Update the spec wording (S11). |
| AD-17: no GitHub host ever, so prefetch is the only option. | SPEC § Constraints: "a read-only token or data the runner prefetched". | **Narrowing.** The approval is recorded as "'No' read as agreeing". Confirm it (M2). |
| AD-8: builders keep going when the coordinator's claim expires. | Review JSON item 43 suggested idling the builders. The spec is silent. | Spine choice, not marked "by user". Acceptable, but B1 must fix who reports the expiry. |
| AD-21: default effort `high`. AD-22: 3-hour session limit. AD-16: loopback cap 2. AD-7: attempts cap 3. | The spec gives no values. | **Approved** (by user). |
| AD-9: the runner never pushes wip. | brownfield: commit wip locally and "resume from that branch". | Consistent. Local wip is kept, and resuming is gated on generation (by user). |

No spine AD contradicts the spec outside the rows above.

## What the spine covers well (no action)

These are listed so a later reader does not re-raise them:

- The CAP-3 mechanics: AD-4, AD-5 and AD-6, covering ledger CAS, forge time, schema version, heartbeat and fencing.
- Takeover (AD-9) and the claim rule per outcome (AD-7).
- Gate scope on the graph (AD-12) and the `next` signature and ordering (AD-13).
- Every brownfield lesson except Auto-mode limits (B3) and the Identities ruleset note (S12):
  - no `--watch`;
  - no `timeout`;
  - exact-PID kill with a start-time check;
  - wip before reset;
  - merge `origin/main` before polling;
  - the status YAML conflict rule;
  - the merge queue without `--delete-branch`;
  - exit lag;
  - the usage-limit sleep values;
  - waits of 1, 30 and 15 minutes.
- The CAP-22 re-check before claim, push, enqueue and merge.
- No admin merge, no trailers, and runner-owned authorship (AD-15).
- The pinned runner and its recovery (AD-25).
- Key storage (AD-26).
- The Bun-only toolchain and version table.
- No platform assumptions: `epics.md` is the core graph source, and `package.json` edges are opt-in.
- v1 items correctly Deferred, each with a constraint: CAP-16, CAP-17, CAP-18 diff check, CAP-19, CAP-20, CAP-21, CAP-23 detection, and the local-only adapter.
- The codex default model typo is already routed to `bmad-spec`.
