---
review: adversary
target: ../ARCHITECTURE-SPINE.md
spec: _bmad-output/specs/spec-xarabot/SPEC.md (+ companions)
date: 2026-10-21
lens: two units one level down, each obeying every AD to the letter, that still build incompatibly; event sequences where every AD is obeyed yet a unit is built twice, merges unreviewed, merges after authority revocation, an agent gets a GitHub credential, or a lane can't be stopped
---

# Adversarial review: Xarabot architecture spine

## Verdict

**Not ready to bind lanes.** The paradigm (functional core, ports, one ledger with CAS) is sound, and no hole needs a new paradigm. But the spine has 6 holes that let separately built Epics obey every AD and still double-build a unit, merge code that no reviewer saw, merge after STOP or revocation, or put a GitHub token within an agent's reach. They share three roots:

1. **The ledger records are under-specified as state machines.** Record deletion loses `attempts` and `generation`; the CAS retry does not say the edit re-checks its preconditions; there is no state between "claimed" and "merged" while GitHub merges on its own clock.
2. **Things happen outside the fenced lane process** (merge queue, owner merges a parked PR, a crash between merge and tombstone) and no AD says who reconciles them.
3. **The diff that merges is not pinned to the diff that was reviewed** (squash baseline undefined; conflict sessions after review).

The remaining holes are id/name collisions and two-owner conflicts that a few lines in AD-3, AD-9, AD-10 and the conventions table close.

Severity: **S1** = a safety outcome named in the lens (built twice, unreviewed merge, merge after revocation/STOP, agent credential, unstoppable). **S2** = two Epics build incompatibly, or the success path deadlocks. **S3** = drift or ambiguity likely to cost a Story.

---

## Top 6 (ranked)

### H1 (S1): Merges happen outside the fenced process, so a unit is built twice and merges after STOP or revocation

**Event sequence (every AD obeyed):**
1. Lane A holds `story:9.3`. It passes the AD-6 fence and the AD-20 Standing Authority check, and enqueues the PR (AD-19).
2. While the PR waits in the queue, one of three things happens: (a) the host reboots or the lane process crashes, or (b) the operator runs `stop --now` (AD-7: "record removed without counting an attempt"), or (c) the Maintainer deletes the Standing Authority file on `main`.
3. GitHub's merge queue merges the PR anyway, on its own clock. In (b) and (c), no runner action is involved, so no AD-20 re-check can run.
4. In (a), the record stays `claimed` and expires 30 minutes later. In (b), no record exists at all. Either way, no `merged` tombstone is written, because AD-3 says only the holding runner writes it.
5. Lane B runs `next`. `main` does not mark 9.3 done yet (the coordinator has not acted), and the ledger has no tombstone, so B claims 9.3. AD-9 tells B to adopt "the existing branch and PR **if there is one**". The PR is merged, not open, so B "starts from `origin/main`" and **builds 9.3 a second time**.

**A related snapshot race:** AD-4 says `next` "reads `main` and the ledger together" but gives no read order. The coordinator merges "9.3 done" on `main`, then deletes the tombstone. A lane that fetched `main` before that merge and the ledger after the deletion sees 9.3 as not done and not in the ledger, and builds it again.

**Fix: new AD-28, "Merge reconciliation", plus tightened AD-4, AD-7, AD-9 and AD-22:**
- Add the ledger state `merging` (`pr`, `head_sha`, `enqueued_at`). The runner writes it, with a fence, **before** it enqueues.
- A `claimed` or `merging` record is never treated as expired or released until the forge shows its PR closed without a merge. Any lane, or the coordinator, that finds a PR merged for a unit writes the tombstone. This is an idempotent, pure edit, and it is the one place AD-3 allows a second writer.
- Takeover (AD-9) looks for the unit branch's PRs in **every** state. If one is merged, it writes the tombstone and builds nothing.
- `stop --now`, the STOP marker, an expiring claim and a failed Standing Authority check all **dequeue first** (and disable auto-merge) before they release. The rule "Never enable GitHub auto-merge" goes in AD-15.
- Within one snapshot, read the ledger tip **before** `main`. The coordinator deletes a tombstone only after its "done" commit is an ancestor of `origin/main`.
- Standing Authority in the merge group needs a required check that reads it from the base branch, or a Human Live Step that sets one up. Until CAP-19 ships, record "revocation does not stop PRs already in the queue" as an accepted 0.x gap, in AD-20.

### H2 (S1): The CAS retry re-applies a blind edit, so two lanes win one unit or overlapping globs

**The two units:** Story "ledger client" (Epic: claims) implements AD-4 as "fetch tip → `putRecord(units/X.json)` → PATCH ff-only → on reject re-fetch, re-apply, retry". Story "`next` + claim" (Epic: selection) computes `next` once, then calls the ledger client.

**The sequence:**
1. Lanes A and B both pick 9.3, or they pick 9.3 and 9.4 whose globs overlap.
2. A's swap wins. B's swap is rejected.
3. B re-fetches and "re-applies the pure edit". Nothing in AD-4 says the edit re-checks that the unit is absent and that its globs don't overlap against the **new** tip. B's write lands as a fast-forward on top of A's commit.
4. Both lanes now hold the unit, or both hold overlapping globs. That directly breaks CAP-3.

**Fix: tighten AD-4.** Every ledger edit is a pure function `(tip snapshot, intent) → Result<newTree>`, and it re-checks all of its preconditions against the tip it is given:
- a claim needs the unit absent and the globs disjoint from every claimed, `merging` and parked-held record;
- a heartbeat or update needs the same owner, host, lane and generation.

On a rejected swap, run the edit again against the fresh tip. A precondition failure ends the attempt and the lane calls `next` again. Contract test: N lanes race for one unit, and for overlapping globs; exactly one wins.

### H3 (S1): Fencing is check-then-act, and `generation`/`attempts` live in a record that gets deleted

**First sequence: a stale lane force-pushes over a takeover.**
1. Lane A passes the AD-6 fence (owner, host, lane and generation 5 all match).
2. The host suspends between the fence and the push (lid, power, a stall of 30 minutes or more).
3. Lane B takes over at generation 6, squashes, pushes and gets reviewed.
4. A resumes and pushes. Because of the AD-15 squash, every push is a rewrite, so A's push is a force-push over B's reviewed head. A can also enqueue. Every AD was obeyed: A really did fence before the push.

**Second sequence: ABA and an endless retry loop.**
1. AD-7 says a crash means "record removed … `attempts` + 1 is kept". The record that holds `attempts` and `generation` is gone, so neither number survives.
2. The ledger Story deletes the file; the outcome Story expects the counter. The unit retries forever and never parks at 3. `stop --now` resets the counter as a side effect.
3. `generation` restarts at 1 on the next claim. The same lane can reclaim at generation 1, and AD-9's "resume local wip only at the same generation" then resumes wip from an earlier attempt that should have been discarded.

**Fix: tighten AD-5, AD-6 and AD-7.**
- Unit records are never deleted except tombstone cleanup. Add the state `released` (no globs, keeps `attempts`, `generation` and `last_head_sha`). `generation` is monotonic per unit for the ledger's lifetime.
- Add `head_sha` to the record. Every push uses `--force-with-lease=<branch>:<head_sha from the ledger>`. Every enqueue or merge passes the expected head (`expectedHeadOid` on enqueue, `sha` on REST merge).
- A push that succeeded is followed by a fenced ledger write of the new `head_sha`.
- State in AD-7 whether an expiry-takeover counts as an attempt. Recommendation: yes, so a unit that kills its host stops after 3.

### H4 (S1): Nothing forbids an agent adapter from spawning the agent itself, and same-uid processes can read the token

**The two units:** Story "claude adapter" (Epic: adapters) and Story "sandbox launcher" (Epic: sandbox).
- AD-1 says "only adapters touch … agents, the OS". The layer table forbids `src/adapters/agent/*` from importing `src/sandbox/`. So the obvious build, and an AD-compliant one, is an adapter that calls `Bun.spawn(["claude","-p",…])` directly.
- The sandbox Epic builds a launcher that nobody is forced to call. The reviewer session (AD-16, built by a third Story) does the same.
- Result: the agent runs unsandboxed, with the host's `gh` keychain token and `SSH_AUTH_SOCK`.

**Even with the sandbox used, two paths remain:**
- AD-18 passes the token "through config passed in its environment" to `git push`. A sandboxed agent in a parallel lane runs as the same uid. Unless the profile denies `process-info*` (macOS `KERN_PROCARGS2`, `ps eww`) and bwrap uses `--unshare-pid`, the agent can read `GIT_CONFIG_VALUE_n` from another lane's push process.
- AD-17's unreadable list is a denylist, so `~/.xarabot/lanes/*/logs/` (another lane's logs, where a token-mint error body can land) and the other lanes' clones stay readable.
- The token can then leave the host through a repo-added proxy host, or be committed into the diff.

The SPEC also allows "a read-only token" for retro sessions, which contradicts AGENTS.md ("never give an agent session a GitHub token").

**Fix: tighten AD-17 and AD-18, and add a lint rule in the conventions.**
- The agent port returns a **launch spec** (`argv`, env allowlist, writable paths, network hosts). Only `src/sandbox/launcher` calls `Bun.spawn` for an agent or reviewer, and oxlint/CI bans `Bun.spawn` under `src/adapters/agent/`.
- Reads are default-deny outside the lane's own clone, the agent state folder, temp and the system paths. Add `~/.xarabot/**` (other lanes and logs) to the deny list explicitly.
- Deny `process-info*`, signals and ptrace to processes outside the sandbox; Linux uses `--unshare-pid`.
- The token reaches git only through a credential helper the runner feeds over stdin or an fd, never through env or argv. Token responses are never logged.
- Retro and other GitHub-reading sessions get **prefetched data only**. Route the SPEC "read-only token" clause to `bmad-spec` for removal.

### H5 (S1): The diff that merges isn't pinned to the diff that was reviewed, and the squash baseline is undefined

**The two units:** Story "commit and push" (AD-15: squash `baseline..HEAD`) and Story "CI and merge plumbing" (AD-19: merge `origin/main` into a conflicting PR; lockfile regeneration; "any other conflict goes to a builder session on the unit branch").

**Sequence 1: no review after the last change.**
1. AD-16 review runs on the squashed diff.
2. CI then reports a conflict. AD-19 starts a builder session that resolves it by editing code.
3. The runner pushes and enqueues. No AD says the review runs again; AD-16's "final" is read as "after the build session".
4. Agent-written conflict code merges without any cross-vendor review. That breaks CAP-8.

**Sequence 2: a silent revert.**
1. `baseline` is never defined. A takeover lane adopts a branch cut from `main@M0` and sets `baseline` = `origin/main@M1`.
2. `reset --soft M1; commit` produces a tree that reverts every unit merged between M0 and M1.
3. The reviewer may not notice; CI may pass. It merges, and other lanes' merged Stories disappear.
4. The same happens after AD-19's "merge `origin/main`" if a loopback squash runs later from the original baseline: the squash pulls `main`'s changes into the unit's diff.

**Fix: tighten AD-15 and AD-16.**
- Squash is defined as: merge `origin/main` into the branch, then `git reset --soft origin/main`, then commit. `baseline` is always the current `origin/main` tip, recorded in the ledger as `base_sha`.
- The AD-16 review is bound to the PR's `head_sha`, and the posted review names that SHA.
- The runner enqueues only if the head is the reviewed SHA, or differs from it only by a runner-made clean merge of `origin/main`. Any agent-made change, conflict sessions and lockfile regeneration included, re-runs the review and counts toward the 2-loopback cap.

### H6 (S1): Protected Paths and Infrastructure approval have no enforcer and no home in 0.x, so an agent can rewrite its own policy

**The sequence:**
1. A builder Story's diff edits `.xarabot/policy.yaml` (adds a repo network host, allows `pi` unattended, raises a cap) or `.xarabot/prompts/`.
2. AD-20 calls these Protected Paths, but the diff check is v1 (Deferred). AD-7's "Finished PR waiting for its owner's approval" depends on the runner knowing the PR needs approval, and no AD says how it knows.
3. In a consumer whose rulesets don't require the owner's review (Xarabot's own `Protect main` ruleset only blocks pushes and deletion), the PR merges on CI plus the bot reviewer.
4. AD-20 then reads the new policy from `main`. The agent has widened its own sandbox allowlist with no human involved.

**The two units:** Epic "planning" (the coordinator) writes a manifest with `infrastructure: true`. Epic "builder flow" treats that flag as the Maintainer's approval. AD-10 has the flag, but no AD records the Maintainer's approval (glossary: "approved by the Maintainer before a lane builds it"). The coordinator can therefore authorize Protected Path work for itself. Coordinator PRs (epics.md, manifests, sprint-status) are also not clearly under AD-16 ("after the builder session").

**Fix: tighten AD-10 and AD-20, and add rows to AD-3.**
- Even in 0.x, a pure core check runs before push. It reads the Protected Path list from `main`'s config; any diff touching it parks the unit as **held** for the owner's approval. If the Story is not an approved Infrastructure Story, it parks as blocked.
- Infrastructure approval gets a home in AD-3: an entry in `retro-gates.yaml` or `.xarabot/approvals.yaml`, written by the Maintainer only, keyed by `story_id` plus a manifest hash. `infrastructure: true` alone grants nothing.
- AD-16 applies to every lane PR, coordinator PRs included.
- At lane start, the lane checks (or the docs make a Human Live Step) that the consumer requires the owner's review on Protected Paths. If not, the lane refuses to run.

---

## Further holes (ranked)

### H7 (S2): Nobody owns a parked-held unit after the owner approves; rulings have no input channel

- AD-2 means the lane process exits after it parks. AD-3 makes the parking runner the only writer of `parked`.
- When the owner approves, nothing enqueues the PR. If the owner merges by hand, which CAP-13 allows, no tombstone is written. The record stays `parked`, its globs stay held for good, and overlapping Stories starve.
- AD-7 says "a ruling in the inbox clears `parked`", but the inbox is an issue whose body the coordinator rewrites. No AD names where a ruling is entered (a comment? a label? a file on `main`?), its format, or who removes the record.
- The state diagram's "ruling: rebuild" has no matching unit kind.
- Is `parked` subject to heartbeat expiry? It has a `heartbeat_at` field, and AD-6 says "a claim expires", so one builder could expire it and another could not.

**Fix:**
- Add a coordinator unit kind `reconcile` that, each cycle, enqueues approved parked-held PRs (with a fence, under its own generation), writes tombstones for merged PRs (see H1), and applies rulings.
- Define the ruling channel and schema, for example the owner's `/xarabot <ruling> <unit>` comment from an allowed login, or a file on `main`.
- State that `parked` and `merging` never expire.
- Name the coordinator as the writer of ruling-driven record changes in AD-3.

### H8 (S2): Unit branch names collide across unit kinds

AD-9 names a unit's branch `<namespace>/<unit-id without kind>`, with a single repo namespace (`story/`). The collisions:
- `story:9.1` and `retro-item:9.1` both map to `story/9.1`.
- `retro:9` and `checkpoint:9` both map to `story/9`.

The coordinator's retro-item unit then "adopts the existing branch and PR" (AD-9) belonging to a builder Story: two owners of one branch and one PR.

**Fix:** use `<namespace>/<kind>-<id>`, or one namespace per kind in repo config. Also escape `.` and `:` and give the exact branch-name grammar. Separately, AGENTS.md says `story/<story-id>` and the spine says `story/<epic>.<n>`, which must be reconciled.

### H9 (S2): In Xaravel the Story manifest is the Story spec file, and two ADs give it opposite writers

- Xaravel's manifest is `stories/<id>.md`, and it carries `status` today (memlog reality check).
- `bmad-build-auto` writes `status` into `stories/<id>-*.md`.
- AD-3 makes "the agent session (BMAD)" the writer of Story spec `status`, inside the PR diff. AD-10 says "a builder may never change a manifest".

Built to the letter: the BMAD Story lets every diff touch `stories/9.3.md`. The v1 guard Story refuses every diff that touches a manifest, and every diff with a file outside the claim's globs, since `stories/` is outside `src/macroable/**`. Every Xaravel Story is then refused.

**Fix:** AD-10 states that the manifest file and the BMAD Story spec file are distinct paths (the repo config names both), **or** that the runner exempts exactly the `status` frontmatter line of the unit's own Story file from the manifest and glob rules. Also state whether the runner reverts or keeps that change.

### H10 (S2): The `no-op` outcome and three `blocked.kind` values have no row in AD-7

AD-14's result allows `outcome: no-op` and `blocked.kind ∈ {intent-gap, verification, other}`; AD-7 maps none of them. Three Stories can read them three ways:
- `no-op` as merged: a tombstone is written, the coordinator marks the Story done with no PR and no CAP-8 review, and the agent alone has declared the Story finished.
- `no-op` as idle: no record is written, so the unit is reselected forever.
- `no-op` as a failure: `attempts` + 1.

**Fix:** add AD-7 rows. Recommendation: `no-op` parks the unit as blocked with an inbox item ("agent says nothing to do"), and never counts as done without a merged PR. `intent-gap`, `verification` and `other` park as blocked.

### H11 (S2): Coordinator units have no globs, so their code changes run alongside builders

Retro items are "worked alongside later Stories" (CAP-10) and can change code; planning and retro units write `epics.md` and manifests. AD-13 checks glob overlap only for builders, and AD-10's "a Story without globs is never claimed" covers Stories only. The coordinator's retro-item diff and a builder's Story can therefore edit the same files at once, with conflicts and a review over a moving base.

**Fix:** every unit kind declares its globs. Retro items carry `globs` in `retro-gates.yaml`; a retro item without globs gets no files, or the whole tree. Planning, retro and checkpoint units hold the planning paths (`epics.md`, the manifest dir, `sprint-status.yaml`, `retro-gates.yaml`). AD-13's overlap check applies to every role.

### H12 (S2): The alert writer is the lane that just stopped

- AD-23 makes the coordinator the only inbox writer, and an item that "newly stops every lane" gets an @mention.
- But the conditions that stop every lane stop the coordinator first: a missing or invalid Standing Authority, invalid config (AD-20), or a bad Epic graph (AD-11).
- AD-8: "When the coordinator's claim expires … the Maintainer's inbox gets an item", but its only writer is the expired coordinator.

As built to the letter, urgent alerts never fire.

**Fix:** AD-23 allows **any** lane to post exactly one idempotent alert comment keyed by `(condition, main SHA)`, through the forge port. This is the only inbox write outside the coordinator, and fail-closed still permits it. The digest stays coordinator-only.

### H13 (S2): A hung lane keeps its claim forever, and `stop --now` may not stop it

- The heartbeat timer runs independently of progress (AD-2, AD-6). A runner stuck in a `fetch` with no deadline, a `git push` waiting on a credential prompt, or a CI poll loop keeps heartbeating, so its claim never expires.
- `stop --now` "kills the agent by exact PID". When no agent is running (CI wait, usage-limit sleep, hung fetch), it kills nothing.
- Usage-limit sleeps repeat without limit (8 h each), and STOP waits for "the current unit" to finish. The 3-hour session limit, 2 loopbacks, conflict sessions and the CI wait add up to no bound on how long a STOP takes.

**Fix:**
- Every external call has a deadline, using AbortSignal (never `timeout`), and git runs with `GIT_TERMINAL_PROMPT=0`.
- Add a per-unit wall-clock budget in config. When it is exceeded, the heartbeat stops and the unit is released as a failed attempt.
- `stop --now` kills the lane process tree by recorded PIDs (`lane.pid`, `agent.pid`, `wait.pid`), then dequeues (H1) and releases.
- A STOP marker also ends any usage-limit sleep and parks or releases the unit.

### H14 (S2): The coordinator's claim expires on every idle cycle

`coordinator.json` is heartbeated "for the whole unit" (AD-2), but the coordinator process exits between units. The idle wait is 30 minutes, which equals the expiry. After every idle cycle the claim lapses, the Maintainer gets an "expired" inbox item, and a second coordinator on another host can start, which is what AD-8 was meant to prevent. It is also undefined whether the same coordinator lane's next process is "a second coordinator" (refuse) or a takeover (generation + 1).

**Fix:** AD-8 says the coordinator claim is renewed by the inter-unit `sleep` wrapper too, or is keyed to `<owner>/<host>/coordinator` and re-claimable by that identity without counting as a takeover. Its expiry is longer than the longest idle wait.

### H15 (S2): The squash commit message on `main` comes from agent text

- AD-15 strips trailers from the commit the runner pushes. With merge-queue squash, the commit on `main` is built from the PR title and body, depending on the repo's squash-message setting.
- `summary` and `body` come straight from the agent (AD-14).
- An agent body containing `Co-authored-by: someone <…>` lands a co-author trailer on `main`, which breaks SPEC "No co-author markers" and attributes the commit to a stranger. `Closes #<inbox issue>` closes the Maintainer's inbox on merge, and `@mentions` page people.

**Fix:** a pure core sanitizer strips trailers, closing keywords and @mentions from `summary` and `body` before any forge write. The setup docs make "squash message = PR title only", or "title + runner-composed message", a Human Live Step.

### H16 (S2): Epic and Story ids have no grammar that ties the sources together

- CAP-5 names Epics by slug (`macroable`, `json-schema`). AD-11's bullets say `Epic N`. AD-13 orders by "lowest Epic number, then lowest Story number". Unit ids use `story:<epic>.<n>`.
- The manifest has `story_id`, `epic` and `sprint_key`, but no AD says how `story_id` becomes `<epic>.<n>`, whether `epic` is a number or a slug, or how `9.10` sorts against `9.2`.

The graph parser (keyed by number) and the manifest loader (keyed by the frontmatter's `epic` value) therefore join on different keys. AD-12's "all its Stories" can come from manifests, `epics.md` headings or `sprint-status.yaml`, so two gate Stories count different sets.

**Fix:** add a conventions row.
- The Epic key is an integer; any Epic slug is metadata only.
- `story_id` matches `^<epic>\.<n>$` with integer parts, compared numerically.
- An Epic's Stories are exactly the manifests with that `epic`. A Story listed in `epics.md` without a manifest, or the reverse, is a graph-validation stop (AD-11).

### H17 (S3): Two owners of `now`

`src/ports/clock.ts` exists, but AD-5 says `now` is the forge's `Date` header. One Story implements the Clock port with `Date.now()`; the forge Story returns server time. Heartbeats then mix the two clocks.

**Fix:** AD-5 says the forge port supplies `now` with every ledger read, and the Clock port is used only for local sleep durations. Or remove the Clock port.

### H18 (S3): The `host` field has no defined source

The `host` field in the record and in the lane identity (`<owner>/<host>/<lane>`) could be `os.hostname()`, the `XARABOT_HOST` value (an ssh target configured on the laptop) or a host.yaml key. Two hosts of the same owner with the same default hostname (`mac-mini`) get the same lane identity and pass each other's fences. The status/TUI Story and the ledger Story will each pick a different one.

**Fix:** `host` is a stable id generated at `xarabot lane install` (a UUID in `host.yaml`), plus a display name. Its uniqueness is checked at claim time against live records.

### H19 (S3): Glob overlap edge cases

- "Literal prefix" is not defined as by character or by path segment.
- No case folding is applied, although macOS APFS is case-insensitive (`Src/` vs `src/`).
- `./` prefixes, braces and `!negation` are not normalized.
- It is unclear whether the ledger stores the raw globs or the globs resolved through the `component` map at claim time. Two lanes on different pinned versions, or different `main` fetches, can resolve them differently.

**Fix:** AD-10 sets normalization (strip `./`, reject `!` and `..`, compare by character prefix with case folding) and stores the **resolved** globs in the record at claim time.

### H20 (S3): `.xarabot/` is both repo config and per-run scratch

The agent writes `.xarabot/result.json` into the clone, and `.xarabot/**` is a Protected Path (AD-20). A guard or Protected Path check that runs before the runner deletes the result refuses every diff. Agents are also invited to write inside the policy directory.

**Fix:** the result path is outside the tree (an env-provided path in the agent's temp dir) or `.git/xarabot/result.json`. The runner diff ignores nothing implicitly.

### H21 (S3): Cross-owner takeover in v1

In v1, owner B's lane takes over A's expired claim and pushes to A's bot's PR. AD-7's "owner's approval" no longer says which owner, so A approves code that B's bot wrote, against CAP-13's "the owning human is responsible".

**Fix:** a cross-owner takeover closes the old PR (with a comment) and opens a new one under B's bot. The record keeps a `pr_owner` field.

### H22 (S3): Port signatures are not fixed

AD-27 requires contract suites, but the spine doesn't fix where the CAS retry loop lives (forge adapter or lane) or the agent port's shape (see H4). The GitHub adapter Story and the lane Story can each implement the retry, or neither can.

**Fix:** a short port table in the spine:
- `forge.ledgerSwap(oldSha, tree) → ok | conflict`, with the retry in `src/lane`;
- `agent.launchSpec(unit, settings) → LaunchSpec` and `agent.parseUsage(stdout)`;
- `sandbox.run(LaunchSpec) → exit`.

---

## Checks that held

- Two builders with different `next` orderings: closed by AD-13's single ordering plus a pure `next`.
- The coordinator singleton across hosts: closed by AD-8, apart from H14.
- An agent pushing directly: there is no token in the sandbox and no GitHub host in the proxy, apart from H4.
- An admin merge: AD-15 and AD-26 together.
- A runner re-execing its own build: AD-25.
- Config read from the lane's own branch: AD-20, apart from H6's self-edit landing on `main`.
