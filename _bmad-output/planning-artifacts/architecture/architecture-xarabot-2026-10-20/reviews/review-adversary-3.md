---
review: adversary-3
target: ../ARCHITECTURE-SPINE.md (status final, updated 2026-10-21, after the round-2 edits)
prior: review-adversary.md, review-adversary-2.md, review-rubric.md, review-reconcile-spec.md, review-reconcile-findings.md, review-currency.md
spec: _bmad-output/specs/spec-xarabot/SPEC.md (+ companions)
date: 2026-10-21
lens: (1) closure of round-2 N1-N5, F1-F5 and its still-open list; (2) a fresh attack on the current text. It looks for units that obey every AD yet build incompatibly, and for event sequences where every AD is obeyed yet a unit is built twice, merges unreviewed, merges after revocation, an agent reaches a GitHub or operator credential, or a lane can't be stopped. The focus is AD-3, AD-5, AD-6, AD-7, AD-9, AD-13, AD-16 and the normative state diagram.
---

# Adversarial review, round 3: Xarabot architecture spine

## Verdict

**The ledger is ready to bind lanes. The trust boundary around the agent is not.** The round-2 edits closed the ledger state-machine contradictions (N3, N4, N5a). AD-3, AD-6, AD-13 and the diagram now agree on takeover, `released → merged` and stale `merging`. The `next`, gates, ledger and claims Epics can start.

Three S1 holes remain. Each one sits where the runner or a reviewer trusts something the builder agent wrote:
- The runner's own git still runs inside the agent-writable `.git`.
- The reviewer session runs in an environment the builder shaped.
- The owner's approval of a Protected Path PR is not tied to a SHA.

Round 2 recommended the fix for the first (a runner-private repo), but the spine adopted a denylist instead. The second and third come from the round-2 edits themselves: ejection now returns a reconcile-enqueued PR to `claimed`, and the review gate has no environment rule. Each fix is a few lines in AD-16, AD-17, AD-18, AD-30, AD-33 or the diagram. None overturns a Maintainer ruling.

Severity is as in rounds 1 and 2: **S1** is a lens outcome. **S2** means Epics build incompatibly, or the success path deadlocks.

---

## Part 1: Closure of round 2

| Item | Status | Where closed / what remains |
| --- | --- | --- |
| **N1** Blocking findings merge (gate checks the SHA, not the verdict) | **Closed** | AD-5 adds `passed_sha`, `loopbacks` and `ci_fixes` to the record. In AD-16, enqueue is allowed only at `passed_sha`, and a blocking review never sets it. In AD-9, `rebuild` closes the PR and clears both SHAs. Residuals: how rulings affect the counters (new hole 5), and how the lane proves the "clean merge of `main` made by the runner" exception (further item F-c). |
| **N2** Agent reaches operator credentials through the shared vendor state | **Closed** for the operator's homes | AD-17 gives each lane a private vendor home, uses `CLAUDE_CODE_OAUTH_TOKEN`, and denies the operator's `~/.claude`, `~/.codex` and `~/.pi`. Residuals: the reviewer's vendor home is unspecified, and a lane's vendor home persists across units, writable by every session (folded into new hole 2). |
| **N3** Expired-claim takeover impossible; no `released → merged` | **Closed** | AD-13 makes stale `claimed` and `merging` records eligible. AD-3 adds the takeover row at `generation` + 1. AD-6 sets `attempts` + 1 and parks on the 3rd. The diagram has `claimed → claimed` (takeover), `claimed → parked` (3rd) and `released → merged`. Wording residual: AD-7's row "a claim that expired and was taken over → `released` with `attempts` + 1" still disagrees with AD-6 and the diagram, which keep it `claimed` at `generation` + 1. Align AD-7. |
| **N4** Reconcile stops after its first merged PR | **Closed** | Per-run ids `planning:<slug>.<n>` and `reconcile:<n>` (AD-9, conventions), and "done on `main`" defined per kind. Residual: a recurring unit that claims and then finds nothing to commit has no AD-7 row (further item F-a). |
| **N5a** `merging` has no exit when its holder dies | **Closed** | AD-6 heartbeats `merging`, and a stale record goes to `merged`, takeover or `released`. AD-7 says every exit other than `merged` dequeues first. |
| **N5b** Reconcile's enqueue has no legal holder | **Partially closed** | AD-3 now lets the coordinator take a held record at `generation` + 1, and the diagram has `parked → merging`. But round 2's fix said "on ejection or dequeue, return the record to `parked` held, never to `claimed`". The spine draws `merging → claimed: ejected (same holder)` instead, so the coordinator now holds a builder Story in `claimed` and runs AD-19's conflict and CI-fix agent sessions on an owner-approved PR. That edge is the root of new hole 3. It also leaves one coordinator process holding many `merging` records, which conflicts with AD-2 (further item F-a). |
| **F1** `stop --now` does not stop | **Closed** | AD-22 writes the lane `STOP` before killing, so a relaunch can't claim. The kill order (`lane.pid` first) is not stated: if `agent.pid` dies first, the lane process may log a crash and count an attempt, racing the no-attempt release. Minor. |
| **F2** Runner git trusts the agent-writable `.git` | **Partially closed** | AD-18 hardens flags (`hooksPath`, `GIT_NO_REPLACE_OBJECTS`, `protocol.file.allow=never`, no submodules). AD-17 adds `.git/info` and `.git/modules` to the unwritable list. But the runner-private repo was not adopted. `.git/commondir` is still agent-writable, and so are the `.git` entry itself (it can be renamed and replaced by a `gitdir:` file), `objects/info/alternates` and the refs. Inherited system and global git config is not cleared. See new hole 1. |
| **F3** BMAD artifacts collide across parallel Stories | **Partially closed** | AD-13 has the coordinator compile `epic-<N>-context.md` in planning, and the runner reverts builder edits to it. But the context file's path is not among AD-13's planning paths (`epics.md`, the manifest directory, `sprint-status.yaml`, `retro-gates.yaml`). AD-30 lets coordinator diffs touch only those paths, so the planning PR that compiles the context is refused and parks blocked. The exact path of the builder's own BMAD spec file is still unnamed (AD-10, AD-30). Further item F-d. |
| **F4** Infrastructure approval never surfaces; approver ambiguous | **Closed** | AD-7 adds the `needs-approval` park with an inbox item. AD-28 accepts `go` and `approve` only from the Maintainer. Residual: AD-10 says an Infrastructure Story "can be claimed only while" an approval exists, yet the diagram reaches `needs-approval` only through `claimed`. Add `[*] → parked (needs-approval)`, or allow a claim whose only legal move is that park. |
| **F5** Self-host fails the AD-25 pin check | **Closed** | AD-25: `runner_version` alone is the pin for Xarabot's own repo. |

**Round 2's still-open list:**

| Item | Status |
| --- | --- |
| Rubric H1-a (Snapshot schema) | **Closed** (AD-27 names the fields) |
| H2-a, H2-b residuals (became N3, N5) | See N3 and N5 above |
| F17 Standing Authority fields | Still `[ASSUMPTION]`; accepted until Xaravel's adoption Epic |
| X4 prefetch schema | **Closed** (AD-27 lists prefetched GitHub data) |
| X5 CAS retry bound | **Closed** (AD-6: 10 tries or the deadline) |
| Currency F-5 (pinning the inbox) | **Closed** (AD-23: Maintainer pins by hand) |
| F43 (AD-8's case triggers the alert) | **Closed** (AD-8 says builders post the AD-23 alert) |
| H3 residual (push, then fenced write of `head_sha`) | **Closed for takeovers** (AD-9 sets `head_sha` to the PR's actual head). A same-generation restart (AD-9 "Restart") still doesn't re-read the PR head. Low: the failed lease self-heals at the cost of one attempt. |

**Round-2 items not closed:** N5b and F2 are partially closed, and both lead into new S1 holes. F3 is partially closed. Small residuals remain on N3 (AD-7 wording), F1 (kill order) and F4 (diagram entry edge). F17 is still an accepted assumption.

---

## Part 2: New holes, ranked

### 1 (S1): The runner's own git reads config the agent wrote, so an agent runs code as the runner and reaches the App private key

**ADs obeyed:** AD-17, AD-18, AD-15.

AD-17 makes the whole clone writable, `.git` included, except `.git/hooks`, `.git/config`, `.git/info` and `.git/modules`. AD-15 and AD-18 run the runner's own git (merge, `reset --soft`, commit, write-check diff, push) in that same clone, unsandboxed, as the user that can read `private-key.pem`.

1. The builder session writes `.git/commondir` containing a path inside its temp folder, and a `config` file there. Git reads `$GIT_DIR/commondir` for any repository, not only linked worktrees, and then takes its config from the common dir. A second route needs no `commondir`: the session renames `.git` to `.git2`, which has no denied subpath, and writes a `.git` file containing `gitdir: .git2`.
2. That config sets `commit.gpgSign=true` with `gpg.program=<temp>/x.sh`, or `credential.helper=!<cmd>`, or `http.proxy` with `http.sslVerify=false`. AD-18 neutralizes hooks, fsmonitor, filters, external diff and textconv. It does not neutralize signing programs, extra credential helpers, proxy and TLS settings, `core.sshCommand` or `include.path`.
3. The runner makes the AD-15 squash commit. Git runs `x.sh` unsandboxed as the runner user. `x.sh` reads `$XDG_CONFIG_HOME/xarabot/apps/*/private-key.pem` and can mint installation tokens for every repo the App covers. A config-defined helper alternatively receives the token on git's `store` call.

**A second path, with no agent involved.** AD-18 never clears inherited config. On the Xarabot host the system gitconfig sets `credential.helper=osxkeychain` (memlog). Git asks the system helper before the runner's own `-c` helper:
- If the keychain holds the Maintainer's github.com credential, the runner pushes **as the Maintainer**, which breaks CAP-13.
- On success, git `store`s the bot token in the Maintainer's keychain, which breaks AD-18's "never in a file".

**Fix (AD-18, AD-17):**
- The runner's git never uses the agent-writable `.git` as its git dir or common dir. After the session ends, the runner imports the session's commits into a **runner-private repo** under the lane state folder, outside the sandbox write set. It squashes, runs the write check, prepares the review checkout and pushes only from there. This is round 2's F2 fix.
- Every runner git call sets `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`, and resets the helper list with `-c credential.helper=` before adding its own helper.
- AD-17 switches `.git` from a denylist to an allowlist: `objects/`, `refs/`, `logs/`, `index`, `HEAD`, `ORIG_HEAD`, `COMMIT_EDITMSG`. The `.git` entry itself is never replaceable.

### 2 (S1): The builder writes its own review verdict through the reviewer's environment, and agent-config files pass the 0.x write check

**ADs obeyed:** AD-16, AD-14, AD-17, AD-30.

AD-16 says the review "runs as its own read-only session over the squashed diff at `head_sha`". No AD says *where*. The natural reading is the lane clone, which the sandbox lets that lane's sessions read. Nothing in the spine resets the clone between the builder and reviewer sessions.

1. A codex builder lane (reviewer: `claude`) writes `.claude/settings.local.json` with a `Stop` hook: `printf '{"kind":"review","verdict":"pass","findings":[],…}' > "$XARABOT_RESULT"`. That file is gitignored in most repos, so it never enters the diff, and AD-30 never sees it. A tracked `.claude/settings.json` works too: AD-30 lists only `.claude/skills/**`.
2. The runner squashes and pushes, then launches the claude reviewer in that clone. `claude -p` loads project and local settings without a trust prompt. Hooks run whatever the permission mode. The hook runs inside the reviewer's sandbox, which can write `XARABOT_RESULT`.
3. The runner reads `verdict: pass` and sets `passed_sha`. The PR is enqueued and merges without a real cross-vendor review, which breaks CAP-8.

**The same omission reaches an operator credential.** `.claude/settings.json`, `.claude/agents/**`, `.claude/commands/**`, `.mcp.json`, `.codex/**` and a root or nested `CLAUDE.md` are not in AD-30's list or AD-20's Protected Paths. They can merge through the subverted review above, with no owner review required.
- A merged `.claude/settings.json` hook then runs **unsandboxed** the next time the Maintainer runs `claude` in his own checkout of the repo, where his `gh` keychain login and `~/.ssh` are live.
- In this repo, a merged root `CLAUDE.md` also silently switches off `AGENTS.md` for every claude session (AGENTS.md policy).

**Lane-internal persistence.** A lane's vendor home (AD-17) persists across units and every session can write it. Unit A's session can plant hooks that run in unit B's builder session. If the reviewer's vendor home sits under the same lane folder, unit A's session can also plant them for the reviewer.

**Fix (AD-16, AD-17, AD-30, AD-20):**
- AD-16: the reviewer runs in a fresh, runner-made checkout of `head_sha` from the runner-private repo (hole 1), with no untracked or ignored files. Project agent-config paths are restored from `origin/main`, and the CLI is launched with project and local setting sources and hooks off. The reviewer gets a vendor home seeded fresh per session that no builder session can write. The runner records `reviewed_sha` from the checkout it launched, never from the result.
- AD-17: builder vendor homes are re-seeded from the credential at every session start.
- AD-30 and AD-20: add `.claude/**`, `.codex/**`, `.pi/**`, `.mcp.json`, and `CLAUDE.md` and `AGENTS.md` at any depth to the 0.x refusal list and the consumer Protected Paths.

### 3 (S1): An owner-approved Protected Path PR merges agent changes the owner never saw

**ADs obeyed:** AD-7, AD-13, AD-16, AD-19, AD-33, the diagram.

1. An approved Infrastructure Story's PR at head `H1` touches `.github/**` or `.xarabot/policy.yaml`. It parks held (AD-7). The owner approves `H1`. Reconcile takes the record at `generation` + 1 and enqueues it (AD-13, diagram `parked → merging`).
2. `main` has moved and the merge group conflicts, so the queue ejects the PR. The diagram sends `merging → claimed: ejected (same holder)`, so the coordinator now holds a builder Story in `claimed`.
3. AD-19: the conflict goes to a builder session, or CI fails and a CI-fix session runs. Either is an agent change producing `H2`. AD-16 re-runs the cross-vendor review and sets `passed_sha = H2`. The diagram allows `claimed → merging: fence + enqueue at passed_sha`, with no step back to the owner.
4. AD-33 requires only "Protected Paths requiring the owner's review". GitHub does not dismiss stale approvals by default, so the approval of `H1` still satisfies the rule. `H2` merges with Protected Path content the owner never saw.

The same thing happens without reconcile: the owner approves early while the builder still holds the claim, then a CI-fix session changes the head.

If the consumer *does* dismiss stale approvals, the reverse breaks: no state models "approval lost". The coordinator holds a `claimed` Story it can't enqueue, and that is undefined.

**Fix (AD-33, AD-5, AD-7, AD-16, diagram):**
- AD-33: the Protected Path ruleset must dismiss stale approvals on push and require approval of the most recent push.
- AD-5: the record stores `approved_sha`.
- AD-16 and AD-7: an owner-gated PR is enqueued only while the owner's approving review's `commit_id` equals the head. Any other change returns the record to `parked` (held, awaiting owner).
- Diagram: replace `merging → claimed (ejected)` with `merging → parked (held)` for owner-gated PRs, as round 2 proposed. The coordinator never holds a Story in `claimed`.

### 4 (S2, CAP-8): A cross-vendor takeover leaves a diff reviewed only by its own vendor

**ADs obeyed:** AD-9, AD-6, AD-16, AD-21.

1. Claude lane A builds `story:9.3`. Its codex review has blocking findings, so A has to run a loopback.
2. A crashes. Codex lane B (CAP-4 mixed lanes; Self-host builds the codex adapter) takes over the stale claim and adopts the PR (AD-9). B runs the loopback with codex and picks the reviewer by "the builder's model provider". For B that is OpenAI, so the reviewer is `claude`.
3. Claude reviews the final head, which is mostly Claude-written code from A. It passes, and the PR merges.

CAP-8 says "every builder PR carries a review from a vendor other than its builder's". Here no other-vendor review of the merged diff exists: codex reviewed only the superseded head.

The two Stories diverge. The review Story keys on the current lane, while the ledger Story keeps no history of who built.

**Fix (AD-5, AD-16):**
- The record carries `builder_providers[]`, appended on every agent change, takeovers included.
- The reviewer must be a provider absent from that set. If none is left (Anthropic and OpenAI both built), the unit parks blocked in the owner's inbox.
- Alternatively, two reviews, one per provider.

### 5 (S2): Rulings have no defined effect on the counters, so `release` either loops forever or does nothing, and `dismiss` has no transition

**ADs involved:** AD-5, AD-6, AD-7, AD-16, AD-19, AD-28, the diagram.

- **A 3-attempt park.** AD-5 keeps `attempts` across a release, and AD-6 and AD-7 say "on the 3rd it becomes `parked`". After `/xarabot release` on a unit parked at `attempts = 3`, the next failure makes it 4.
  - A ledger Story that tests `== 3` never parks again, and each retry burns a session of up to 3 hours, forever.
  - A Story that tests `>= 3` parks after exactly one try.
- **A loopback-cap or CI-fix-cap park.** `loopbacks` (2) and `ci_fixes` (2) stay at the cap.
  - `release` adopts the PR. Its first blocking review is over the cap, so the unit parks again with no loopback run.
  - `rebuild` (AD-9) closes the PR and rebuilds the whole Story, then parks on the first blocking finding.
  - For these parks, the Maintainer's only working move is to merge by hand.
- **`dismiss`** is in AD-28's grammar, but no AD and no diagram edge says what it does to a ledger record.

**Fix (AD-28, AD-6, AD-7, diagram):**
- Per verb:
  - `release`: keep the PR, reset `attempts`, `loopbacks` and `ci_fixes` to 0.
  - `rebuild`: close the PR, clear the SHAs, reset all counters.
  - `dismiss`: clear the inbox item only, with no ledger change (or define a terminal state).
- The caps compare with `>=`.
- Add a `parked → released` label for `release`/`rebuild` with "counters reset".

---

## Further holes (real consequence, ranked below the top 5)

- **F-a (S2): reconcile doesn't fit a one-unit process.**
  - AD-2 gives each process one unit and one heartbeat. Reconcile, though, takes *several* approved held PRs into `merging` under the coordinator's identity. Either the coordinator blocks on every queue outcome (planning and retro stall), or it exits and those records go stale. Then each ejection costs an `attempts` + 1 through the stale-`merging` path, and the 3rd parks a PR the owner already approved.
  - A reconcile (or planning) run that claims and finds nothing to commit has no AD-7 row. "Idle: no record" would need a deletion that AD-5 forbids. `no-op` parks it with an inbox item every quiet day, which breaks CAP-9's "no other per-item waiting notices".
  - *Fix:* reconcile hands each enqueued PR to the existing stale-`merging` watch with no attempt cost, combined with hole 3's return to `parked`. Recurring kinds claim only once they have a diff, or end `released` with no attempt and no inbox item.
- **F-b (S2): diagram edges missing against AD-7.**
  - `stop --now`, and a budget overrun, while `merging`. AD-7's last row releases, and AD-7 dequeues first, but the diagram allows `merging → released` only when stale and not queued.
  - A transition validator built from the diagram rejects the stop's release. The record waits 30 minutes to go stale and then costs an attempt.
  - *Fix:* add `merging → released: stop --now / budget (dequeue first)`.
- **F-c (S2): the "clean merge of `main` made by the runner" exception (AD-16) is a provenance claim.**
  - Every commit is bot-authored, and the push precedes the ledger write (AD-6). Suppose lane A pushes an agent CI-fix head and crashes before recording it. A taking-over lane that decides from the record or from authorship enqueues an unreviewed head.
  - *Fix:* the enqueuing lane recomputes the merge from the runner-private objects: `tree(head) == merge-tree(passed_sha, parent-from-main(head))`. It never trusts the record or the author.
- **F-d (S2): the epic context path isn't a planning path (F3 residual).**
  - AD-13 has the coordinator compile `epic-<N>-context.md` in planning, but AD-30 refuses any coordinator diff outside the four planning paths. That planning PR parks blocked.
  - *Fix:* add the configured context path to AD-13's planning paths and name the builder's BMAD spec-file path in AD-10.
- **F-e (S2): AD-30's Infrastructure exception is unscoped.**
  - It exempts an approved Infrastructure Story from the *whole* refusal list, `sprint-status.yaml`, `retro-gates.yaml` and manifests included. That is a builder write to coordinator-owned files, which breaks CAP-4's success test and the SPEC's write authority.
  - *Fix:* the exception covers only Protected Paths, never AD-3's coordinator-owned files or manifests.
- **F-f (S2, revocation): AD-20 re-checks only the Standing Authority before each claim, push, enqueue and merge.**
  - A `policy.yaml` change that disallows the builder's or reviewer's adapter is enforced only at lane start (AD-21). A unit in flight keeps running loopbacks and reviews with a revoked adapter, then enqueues.
  - *Fix:* re-check the adapter and reviewer allowances from fetched `main` before each session launch and each enqueue.

## Checks that held

- **Two lanes racing one unit or overlapping globs:** AD-4's precondition re-check on the tip; the takeover CAS at `generation` + 1 (AD-3, AD-6).
- **Zombie holder after a stale takeover, including stale `merging` while queued:** AD-6's fence before push, PR change, enqueue and merge, plus the lease on `head_sha`.
- **Merged outside the process, in any state:** the `claimed → merged`, `released → merged`, `parked → merged` and `merging → merged` edges, plus "any lane writes `merged`" (AD-3).
- **Blocking findings merging after a crash:** the `passed_sha` gate (AD-16), with counters in the record.
- **Recurring units never re-running:** per-run ids and done-per-kind (AD-9).
- **Lane relaunching after an emergency stop:** `STOP` is written first (AD-22).
- **Agent reaching the operator's vendor homes:** the private vendor home (AD-17). Holes 1 and 2 are other routes.
- **Merge after revocation before enqueue:** AD-20's Standing Authority re-check (only F-f remains). A PR already in the queue is the accepted 0.x gap (Deferred), so it is not re-raised.
