---
review: adversary-4
target: ../ARCHITECTURE-SPINE.md (status final, updated 2026-10-21, after the round-3 edits)
prior: review-adversary.md (1), review-adversary-2.md (2), review-adversary-3.md (3), review-rubric.md, review-reconcile-spec.md, review-reconcile-findings.md, review-currency.md
spec: _bmad-output/specs/spec-xarabot/SPEC.md (+ companions)
date: 2026-10-21
lens: (1) closure of round 3 — the 5 top holes, F-a..F-f, and the partially-closed round-2 items; (2) a fresh attack on the current text, with weight on what round 3 added: runner-private runner.git and the rebuilt clone (AD-15, AD-17, AD-18, AD-9), the fresh reviewer checkout (AD-16), approved_sha and owner-gated ejection (AD-5, AD-7, AD-16, AD-33), builder_providers[] (AD-5, AD-16), ruling counter resets (AD-28), reconcile-held merging (AD-7, AD-13), and the state diagram. It looks for units that build incompatibly, and sequences where every AD is obeyed yet a unit is built twice, merges unreviewed, merges after revocation, an agent reaches a credential, or a lane can't be stopped. Severity: S1 = a lens outcome; S2 = Epics build incompatibly or the success path deadlocks.
---

# Adversarial review, round 4: Xarabot architecture spine

## Verdict

**The agent trust boundary is now sound; the remaining holes have moved to the seam round 3 created.** Round 3's three S1 holes are all closed in the text: the runner-private `runner.git` (AD-15, AD-17, AD-18), the fresh reviewer checkout with restored config and a per-session vendor home (AD-16, AD-17, AD-20, AD-30), and `approved_sha` with owner-gated ejection to `parked` held (AD-5, AD-7, AD-16, AD-33). The two S2 holes (`builder_providers[]`, ruling counter resets) and all of F-a..F-f are closed. No new S1 found: I could not construct a merge-unreviewed, merge-after-revocation, build-twice, credential-reach or unstoppable-lane sequence that obeys every AD.

What round 3 did not finish is the cross-lane handoff of the new per-lane `runner.git`. `runner.git` lives in each lane's own state folder, but three operations now act on a PR a *different* lane built — takeover (AD-9), reconcile-enqueue of a held approved PR (AD-13), and the reviewer/clean-merge recompute (AD-16) — and no AD says the acting lane first brings the PR's objects into its own `runner.git`. That one omission drives holes 1 and 5. One internal contradiction (AD-6 vs AD-7 on reconcile-held `merging`) and two narrow gaps (`builder_providers[]` not reset by `rebuild`; pi's provider undefined) round out the list.

## Convergence judgement

**Implementation-level for the ledger/`next`/claims/gates core; design-level but narrow for the plumbing and review seam.** The core Epics (`next`, gates, graph, claims, ledger) are converged — their holes were closed in rounds 2 and 3 and nothing here reopens them; they are safe to bind, guarded by their case-table tests. The five holes below are all design-level — each needs a spine edit, not just a test — but every one is localized to a single mechanism (the per-lane `runner.git` and its cross-lane handoff) and is a few lines in one or two ADs. None overturns a Maintainer ruling; none reopens the ledger state machine. Recommendation: make these edits (holes 1, 2 and 4 especially) before binding the **merge-plumbing** and **cross-vendor-review** Epics, since they sit on those Epics' success paths and on CAP-8; the core Epics need not wait.

## Round-3 items not closed

None of substance. All five top holes, F-a..F-f, and the called-out round-2 residuals (N3 AD-7 wording, F1 kill order, F4 diagram entry edge, F2/N5b via `runner.git`, F3 via the context path) are present in the text. Two items remain only as *accepted* carryovers, not regressions:

- **F17 (Standing Authority frontmatter):** still `[ASSUMPTION]` in AD-20, accepted until Xaravel's adoption Epic. Unchanged.
- **H3 residual (same-generation restart doesn't re-read the PR head):** AD-9 "Restart" still resumes wip without re-reading the live PR head. Round 3 rated this low (the stale lease self-heals at the cost of one attempt); unchanged. Note it now compounds hole 1 — a restarted lane also needs the PR objects in its `runner.git`.

## New holes, ranked

### 1 (S2): A lane acting on a PR it did not build has none of that PR's git objects in its own `runner.git`

**ADs obeyed:** AD-15, AD-16, AD-9, AD-13.
`runner.git` is per-lane (`lanes/<lane>/runner.git/`, AD-15). But a stale-claim takeover (AD-9 "adopt the open PR"), a reconcile-enqueue of a held approved PR (AD-13, diagram `parked → merging`), and every reviewer checkout and clean-merge recompute (AD-16: "a fresh checkout of `head_sha` … from `runner.git`" and "recomputes that merge itself in `runner.git`") assume the acting lane's `runner.git` already holds `head_sha` and `passed_sha`. For a lane that didn't build the PR — the taking-over builder, and always the coordinator at reconcile-enqueue — those objects were only ever in another lane's `runner.git`. AD-15 says only "rebuild the clone … at `base_sha`," never "fetch the adopted PR head into `runner.git`." So the reviewer checkout, the AD-16 merge recompute and the loopback adoption cannot proceed; a correct implementation deadlocks (can't verify, won't enqueue), and a naive one trusts the record's `passed_sha`/`approved_sha` — exactly what AD-16 forbids — and enqueues an unverified head.
**Fix (AD-15, AD-16, AD-9):** state that any lane acting on a PR it did not build first fetches the PR branch (and `passed_sha`) from `origin` into its own `runner.git`, and makes the review checkout, the clean-merge recompute and the loopback rebuild from those fetched objects.

### 2 (S2, internal contradiction): AD-6 and AD-7 disagree on reconcile-held `merging` records, so a builder steals the coordinator's queued owner-gated PR

**ADs in conflict:** AD-6, AD-7, AD-13.
AD-7 says a `merging` record reconcile holds "is checked by later `reconcile` runs, **not by heartbeat**." AD-6 says a heartbeat runs "for `claimed` and `merging` records alike," and a `merging` record with no heartbeat for 30 minutes "still in the queue" may be "taken over by any lane." A reconcile cycle also runs planning, retro and checkpoints, so successive `reconcile` runs can be well over 30 minutes apart. The coordinator's held `merging` record therefore goes stale, and AD-6 (plus AD-13, which lets builders take "a stale … `merging` record") makes a builder take over the coordinator's queued PR — including an owner-gated Infrastructure Story the coordinator was holding in the queue. Nothing distinguishes a coordinator-held `merging` record from a builder's.
**Fix (AD-6, AD-13):** exclude coordinator-held `merging` records from AD-6's stale-takeover (by holder identity or an explicit held flag), or require reconcile to heartbeat the records it holds. Align AD-7's "not by heartbeat" wording with whichever is chosen.

### 3 (S2, revocation/recovery): `rebuild` and `release` don't reset `builder_providers[]`, so a reviewer-exhausted unit can never be rescued

**ADs obeyed:** AD-5, AD-9, AD-16, AD-28.
`builder_providers[]` only ever grows (AD-5), and AD-16 parks a unit blocked once no provider is left outside it. AD-9's `rebuild` clears `reviewed_sha` and `passed_sha`; AD-28 resets `attempts`, `loopbacks` and `ci_fixes`. Neither clears `builder_providers[]`. So after a cross-vendor takeover or a `rebuild` that lands on the other vendor, `builder_providers[]` holds both Anthropic and OpenAI, and the Maintainer's `rebuild` — meant to give a clean restart — immediately re-parks the unit blocked with no reviewer. The only working move becomes a hand merge, which breaks the recovery contract.
**Fix (AD-28, AD-9):** `rebuild` (which rebuilds the Story from scratch) also clears `builder_providers[]`; decide explicitly whether `release` does. State it beside the other counter resets.

### 4 (S2, CAP-8): pi's provider is undefined, so a pi diff built on an Anthropic model is reviewed by `claude`

**ADs obeyed:** AD-16, AD-5.
AD-16 picks the reviewer as a provider not in `builder_providers[]`, with preference "`claude` for any other," and requires pi to "set `model` explicitly." pi runs `<provider>/<id>` via OpenRouter (agent-adapters.md), so a pi lane can run an Anthropic model. The spine never says how a pi session's entry in `builder_providers[]` is derived — the OpenRouter model's vendor (Anthropic) or a distinct "pi" provider. If it is treated as a distinct provider, `claude` reviews a Claude-family diff, which is not the cross-vendor review CAP-8 requires; if it is treated as the model's vendor, the "`claude` for any other" preference line is wrong for pi-on-Anthropic. Either way the rule is undefined exactly where CAP-8's guarantee depends on it.
**Fix (AD-16, AD-5):** define `builder_providers[]` membership for pi as the underlying model's vendor (so a pi-on-Anthropic diff excludes `claude` and routes to `codex`), and drop or qualify "`claude` for any other" accordingly.

### 5 (S2, leaning implementation): the clone is rebuilt at `base_sha` every session, so loopback and CI-fix agents start from clean `main` with no sight of the code they are fixing

**ADs obeyed:** AD-15, AD-16, AD-19.
AD-15 rebuilds the clone "at `base_sha`" before *every* session and afterward diffs "the working tree's changes against `base_sha`." A review loopback (AD-16) and a CI-fix (AD-19) are sessions on an existing head, but the agent is handed clean `base_sha`, not the current PR head, so it cannot see the code the reviewer flagged or the code CI failed on. Each loopback becomes a from-scratch rebuild rather than a fix, which risks never converging within the cap-2 loopback / cap-2 CI-fix budget and burns up to 3-hour sessions. Prefetched GitHub data (AD-17) could carry the prior diff, but no AD says it does.
**Fix (AD-15, AD-16, AD-19):** for loopback and CI-fix sessions, either rebuild the clone at the current `head_sha` (from the lane's `runner.git`, after hole 1's fetch) or state that the runner seeds the prior diff and the findings/CI-log into the session's prefetch folder.

## Checks that held (no hole found)

- **Merge unreviewed:** `passed_sha` gate with the runner-recomputed clean-merge exception (AD-16); owner-gated PRs gated on `approved_sha == head` (AD-16, AD-7). Sound given hole 1's fetch fix.
- **Merge after revocation:** AD-20 re-checks the Standing Authority and the adapter/reviewer allowances from fetched `main` before each claim, push, session launch, enqueue and merge; the already-queued PR is the accepted Deferred 0.x gap.
- **Build twice:** per-run ids and done-per-kind (AD-9); `claimed/released/parked/merging → merged` edges plus "any lane writes `merged`" (AD-3, diagram).
- **Agent reaches a credential:** `runner.git` sandbox-unreadable, runner git with `GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL=/dev/null` and the helper reset (AD-18); per-session vendor homes and operator homes denied (AD-17). Round-3 holes 1 and 2 are genuinely closed.
- **Lane can't be stopped:** lane `STOP` written first, then kill lane/agent/wait by PID (AD-22); reviewer sandbox is the same launcher (AD-17).
- **Owner-gated PR merges unseen changes:** `approved_sha` cleared on ejection/dequeue, record returns to `parked` held, dismiss-stale-approvals prerequisite (AD-7, AD-16, AD-33).

---

File: `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/reviews/review-adversary-4.md`
