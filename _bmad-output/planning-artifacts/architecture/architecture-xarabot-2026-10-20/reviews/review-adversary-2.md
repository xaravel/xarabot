---
review: adversary-2
target: ../ARCHITECTURE-SPINE.md (status final, updated 2026-10-21)
prior: review-adversary.md, review-rubric.md, review-reconcile-spec.md, review-reconcile-findings.md, review-currency.md
spec: _bmad-output/specs/spec-xarabot/SPEC.md (+ companions)
date: 2026-10-21
lens: (1) closure of every prior high/S1/blocking item; (2) fresh attack on the revised text — units that obey every AD yet build incompatibly, or event sequences where every AD is obeyed yet a unit is built twice, merges unreviewed, merges after revocation, an agent reaches a GitHub credential, or a lane can't be stopped; new internal contradictions
---

# Adversarial review, round 2: Xarabot architecture spine

## Verdict

**Not yet ready to bind lanes, but close.** Every prior S1 sequence is closed as it was written. The revision added states (`released`, `merging`) and a new actor (`reconcile`). AD-3, AD-13 and the normative state diagram did not follow those additions, and four of the five new holes sit on those seams. None needs a new paradigm or overturns a Maintainer ruling. Each fix is a few lines in AD-3, AD-7, AD-9, AD-13, AD-16, AD-17, AD-22 or the diagram.

Severity is as in round 1: **S1** is a lens outcome (a unit built twice, an unreviewed merge, a merge after revocation, an agent credential, a lane that can't be stopped). **S2** means Epics build incompatibly, or the success path deadlocks.

---

## Part 1: Closure of prior high, S1 and blocking items

### review-adversary.md (S1)

| Item | Status | Where closed / what remains |
| --- | --- | --- |
| H1 Merges outside the fenced process; unit built twice; merge after STOP or revocation | **Closed** (residuals → new N3, N5) | The `merging` state is written before enqueue (AD-7). Any lane writes `merged` (AD-3). Every claim checks PRs in every state (AD-9). Snapshot order is ledger → `main` → PRs (AD-4). `stop --now` dequeues (AD-7, AD-22). Auto-merge is banned (AD-15). Revocation in the queue is an accepted 0.x gap (Deferred). Residuals: the diagram has no `released → merged` edge (N3), and a `merging` record has no exit once its holder is dead (N5). |
| H2 Blind CAS retry | **Closed** | AD-4 re-checks every precondition against the new tip. Contract race suite in AD-27. |
| H3 Fence is check-then-act; counters deleted | **Closed** (minor residual) | AD-5: records are never deleted, `generation` is monotonic, `attempts` is kept. AD-6: the heartbeat swap is the fence, plus `--force-with-lease` on `head_sha` and the expected head on enqueue. AD-7: an expiry takeover counts as an attempt. Residual: no AD orders "push, then fenced write of `head_sha`". If a lane crashes between the two, every later lease fails against a stale `head_sha`, unless AD-9's adopt step re-reads the PR head into the record. Add that sentence to AD-9. |
| H4 Adapter spawns agent; token readable | **Closed** (new path → N2) | AD-17: only the sandbox launches agents, a lint rule enforces it, reads are denied by default, `~/.xarabot/**` is denied, Linux uses `--unshare-pid`, sessions get prefetched data only. AD-18: the token goes to a credential helper over stdin. A new credential path opened through the writable vendor state folder (N2). |
| H5 Reviewed diff ≠ merged diff; squash baseline undefined | **Closed** (gate gap → N1) | AD-15 defines the squash and `base_sha`. AD-16 binds the review to `head_sha`, and any agent change re-runs it. But the enqueue gate checks SHA equality only, not the verdict (N1). |
| H6 Protected Paths and Infrastructure approval unenforced | **Closed** | AD-30 is the 0.x write check. AD-10 and AD-5 put `approval {by, manifest_sha}` in the ledger. AD-16 covers coordinator PRs. AD-33 makes the owner-review ruleset a prerequisite. |

### review-rubric.md (high)

| Item | Status | Where closed / what remains |
| --- | --- | --- |
| H1-a Port operations and Snapshot | **Partially closed** | The ports table lists the operations. The decision snapshot's fields beyond `Forge.snapshot()` (manifests, `epics.md`, status files, `retro-gates.yaml`, config from `main`) are not named, and Snapshot is missing from AD-27's schema list. The `next`/gates Epic and the lane Epic can each shape it differently. One AD-27 line closes this. |
| H1-b Adapter/sandbox seam | **Closed** | `Agent.launchSpec`, `Sandbox.run`, and the lint rule (AD-17). |
| H1-c Reviewer output and re-review rule | **Closed** (see N1) | AD-14 `review` kind; AD-16 re-review rule. |
| H2-a Ledger state machine contradicts itself | **Partially closed** → N3 | `released` was added and counters survive. But the takeover path now contradicts AD-3 and AD-13 (N3). |
| H2-b No actor for parked-held → merged | **Partially closed** → N5 | AD-13 `reconcile` enqueues the PR and any lane writes `merged`. But who holds the record after reconcile enqueues it is undefined, and it contradicts AD-3 and AD-13 (N5). |
| H2-c Inbox writer contradictions | **Closed** | AD-23 any-lane alert; AD-28 rulings; AD-3 rows. |
| H3-a 0.x write ban unenforced | **Closed** (see N6, N7) | AD-30. |
| H7-a No repo dimension on the host | **Closed** | AD-21 `repo` and the per-repo state path; `XARABOT_MAX_BUILDERS` counts across repos. |
| H7-b Operations silent | **Closed enough** | AD-25 upgrades, AD-33 restart throttle, AD-24 retention, AD-32 forge errors. Backups are Deferred. The vendor-credential placement chosen in AD-17 created N2. |

### review-reconcile-spec.md (blocking)

| Item | Status | Where closed |
| --- | --- | --- |
| B1 Inbox and rulings loop | **Closed** | AD-23, AD-28, AD-3 rows. One v1 ambiguity in who may `approve` (see further hole F4). |
| B2 Result contract only for builders | **Closed** | AD-14 union keyed by `kind`. |
| B3 No prompt AD | **Closed** | AD-29. |
| B4 0.x enforcement and `.agents/skills` | **Closed** | AD-30, AD-20 Protected Paths, AD-10 approval. |
| B5 CI-fix loop and idle telemetry | **Closed** | AD-19 (cap 2, expected-check list), AD-24 idle and wait spans. |

### review-reconcile-findings.md (safety and divergence GAPs)

| GAP | Status | Where |
| --- | --- | --- |
| F1 Sandbox order vs bootstrap | **Closed** | AD-31 (dedicated macOS user; self-hosting waits for AD-17). |
| F44 0.x write ban | **Closed** | AD-30. |
| F39 Ruling channel and author | **Closed** | AD-28. |
| F67 Unknown `schema_version` | **Closed** | AD-5 fails closed before `next`, with an alert. |
| F33 Tombstone writer after owner merge or crash | **Closed** (residual → N5) | AD-3 any-lane `merged`; AD-13 reconcile. |
| F52 `attempts` lost on removal | **Closed** (contradiction → N3) | AD-5 `released`. |
| F34 Adoption only on takeover | **Closed** | AD-9 "every claim". |
| F43 Inbox writer when the coordinator is dead | **Closed** | AD-8 + AD-23. AD-23's trigger reads "a condition that newly stops every lane", and a dead coordinator doesn't stop builders. Say in AD-23 that AD-8's case qualifies. |
| F69 Forge failure classes | **Closed** | AD-32. |
| F17 Standing Authority validity | **Partially closed** | The frontmatter rule and AD-27 schema exist, but the fields are still `[ASSUMPTION]`. This is acceptable until Xaravel's adoption Epic. |
| F11/F51 Vendor by provider; pi model | **Closed** | AD-16. |
| F41 `waiting`/`deferred` items | **Closed** | AD-12. |
| X1–X3 | **Closed** | AD-6, AD-16/AD-19, AD-30 (but see N7: BMAD writes more than a `status:` line). |
| X4 Prefetch contract | **Partially closed** | The location is set (temp folder, AD-17). There is no schema; low risk. |
| X5 Unset defaults | **Partially closed** | CI wait 60 min and exit-lag 5 min are set. The CAS retry bound is still unset; low risk. |

### review-currency.md

It had no high items. F-1 is closed (`bun --bun`), F-2 (pi 1.3.0), F-6 (`[ASSUMPTION]` + spike), F-7 (re-test note), F-8/F-11 (AD-33), F-9 (AD-26), F-10 (open item). F-5 is still open at low severity: nobody has verified that an App token can pin the Maintainer's issue, and no AD makes pinning a Human Live Step.

**Still open after round 1:** rubric H1-a (Snapshot schema), H2-a and H2-b as residual contradictions (now N3 and N5), F17 fields (an accepted assumption), X4/X5 minor values, and currency F-5 (pinning).

---

## Part 2: New holes, ranked

### N1 (S1): A PR with unresolved blocking findings merges, because the enqueue gate checks the SHA and not the verdict

**ADs obeyed:** AD-16, AD-9, AD-7, AD-6.

1. Lane A builds `story:9.3`, squashes and pushes head `H`. The AD-16 review runs and returns `verdict: changes`, with blocking findings. The record gets `reviewed_sha = H`. AD-5 has no verdict field, so nothing records the verdict.
2. Lane A crashes (or reboots, or exceeds its budget) before the loopback session.
3. The claim expires. Lane B claims the unit, and AD-9 says "an open PR means adopt it". B's resume logic starts at the first step not yet done. The PR head equals `reviewed_sha`, so B goes straight to CI.
4. AD-16: "Enqueue happens only if the PR head equals `reviewed_sha`." It does, so B enqueues, and the PR merges with its blocking findings unresolved. That breaks CAP-8 ("no PR merges with that review's findings unresolved").

The same path opens through rulings. A unit parked for "review disagreement past the cap" gets `/xarabot release` or `rebuild`. The next claim adopts the open PR, whose head is still the blocked `reviewed_sha`. `rebuild` cannot rebuild anyway, because AD-9 always adopts an open PR.

The review loopback count and `ci_fixes` count live only in the lane journal (AD-24), not the record. Each takeover therefore gets a fresh cap of 2.

**Fix (AD-16, AD-5, AD-9):**
- The ledger records `passed_sha`, set only by a review with no blocking findings. Enqueue requires head = `passed_sha`, or a runner-made clean merge of `main` onto it.
- Store `loopbacks` and `ci_fixes` in the record.
- `rebuild` closes the open PR, so AD-9 then starts from `origin/main`; `release` keeps it.

### N2 (S1): An agent reaches the operator's GitHub credentials through the shared vendor state folder

**ADs obeyed:** AD-17, AD-31.

- AD-17 makes the agent's state folder (`~/.claude`, `~/.codex`, `~/.pi`) readable and **writable** inside the sandbox.
- AD-31 puts only the bootstrap loop under a dedicated macOS user. Self-hosted lanes run as the operator's own user on the Xarabot host. Today that host is the Maintainer's laptop, which has a `gh` keychain login, `~/.ssh` and an osxkeychain git helper (memlog).

The sequence:
1. A sandboxed session writes a hook into `~/.claude/settings.json`, a `notify` program or MCP server into `~/.codex/config.toml`, or a skill or command into `~/.claude/`. Nothing in AD-17 forbids it.
2. The Maintainer next runs `claude` or `codex` interactively, unsandboxed, as the same user. The hook runs with the keychain, `gh` and ssh available. The agent has reached a GitHub credential, and it is the human's own, not even the bot's.
3. The same write also injects code into every other lane's sessions (lane-to-lane contamination). Those sessions are sandboxed, but they write other units' diffs.

**Fix (AD-17, extend AD-31):**
- Each lane's agent gets a private vendor home under its lane state folder (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and pi's equivalent, verified in the adapter Story). It is seeded only with the vendor credential, and it is never the operator's own `~/.claude`, `~/.codex` or `~/.pi`.
- Alternatively, all lanes, not only the bootstrap, run under a dedicated OS user.
- The claude credential then has to come from a file or environment variable rather than the Keychain. That joins the existing Keychain verification item (reconcile-spec M8).

### N3 (S2, contradiction): Expired-claim takeover is impossible to the letter, and the normative diagram forbids `released → merged`

**ADs involved:** AD-3, AD-6, AD-7, AD-13, the state diagram.

- AD-6: a `claimed` record expires after 30 minutes.
- AD-7: "a claim that expired and was taken over → `released` with `attempts` + 1; the 3rd time `parked`".
- **AD-13:** builders take only Stories "whose record is absent or `released`". An expired record is still `claimed`, so `next` never selects it.
- **AD-3:** `released` is written only by "the lane releasing the unit, or the coordinator applying a ruling", and `claimed` only by "the lane that holds the unit". No third lane may turn someone else's expired claim into `released`, or take it in place.
- The diagram draws takeover as `claimed → claimed (generation + 1)`, a transition with no AD-3 writer and no attempt increment.

**Result:** a lane that crashes for good (host lost, or a launchd job removed) holds its unit and its globs forever. CAP-3's success test ("a killed lane's unit becomes claimable 30 minutes after its last heartbeat") fails. The `next` Story, the ledger-edit Story and the transition-table Story each resolve this differently.

There is a second gap in the diagram. AD-9 (claim from a `released` record whose PR has merged) and AD-3 (any lane writes `merged`) both need `released → merged`. That happens, for example, when a `stop --now` dequeue loses a race with the queue, or after a budget-overrun release. The "normative" diagram has no such edge. A pure transition validator built from it rejects the write, so the unit either wedges or is rebuilt.

**Fix:**
- AD-13: eligible means absent, `released`, or `claimed` with `heartbeat_at + 30 min < now`.
- AD-3: any lane may take an expired claim by CAS. That edit increments `attempts` and writes `parked` (blocked) on the 3rd attempt.
- Diagram: add `claimed → claimed: takeover after expiry (generation + 1, attempts + 1)`, `claimed → parked: 3rd takeover`, and `released → merged: PR found merged`.

### N4 (S2): The coordinator stops reconciling forever after its first reconcile PR merges

**ADs obeyed:** AD-9, AD-3, AD-13, the conventions table.

1. Unit id `reconcile` has no `<id>` part. Under AD-9 its branch is the fixed `xarabot/reconcile-` on every run. AD-3 says the coordinator marks units done in `sprint-status.yaml` through its own PRs, so reconcile makes PRs.
2. The first reconcile PR merges, and the record becomes `merged`.
3. AD-3 lets the coordinator delete a `merged` record "only once `main` marks the unit done". Nothing on `main` ever marks `reconcile` done, so the record stays `merged`.
4. Even if the record were deleted, AD-9 would write `merged` again on the next claim, because a merged PR is on the unit's branch.

**Result:** after its first merge, reconcile never runs again. Rulings are never applied, held PRs are never enqueued, and nothing is marked done. Gates freeze for every Epic. The same applies to any `planning:<slug>` reused across runs.

For `retro-item`, `planning`, `checkpoint` and `reconcile` records, "main marks the unit done" is not defined at all.

**Fix (conventions table, AD-9, AD-3):**
- Recurring kinds take a per-run id, for example `reconcile:<n>` from a counter in `coordinator.json`, and planning slugs must be unique.
- Alternatively, AD-9's merged-PR rule applies only to one-shot kinds.
- AD-3 states, per kind, what "done on `main`" means before a `merged` record may be deleted: `retro-gates.yaml` item `done`, checkpoint go recorded, and so on.

### N5 (S2, contradiction): `merging` has no exit when its holder is gone, and reconcile's enqueue has no legal holder

**ADs involved:** AD-6, AD-7, AD-3, AD-13, AD-2, the state diagram.

**(a) Dead holder.** AD-6 says `merging` never expires. The diagram's `merging → claimed: ejected or dequeued` assumes a live holder. Three sequences strand the record:
- The lane writes `merging`, then the host reboots before or after the enqueue call. Either the PR is never queued, or the queue ejects it on a conflict.
- The record stays `merging` forever, with its globs held. Overlapping Stories starve, and no inbox item is posted, because AD-23's digest reads `parked` records.
- Separately, AD-7 releases on a budget overrun, session timeout or failed result without dequeuing, unlike `stop --now`. A unit released while its PR is still queued merges later, with the record `released` (this is the missing edge in N3).

**(b) Reconcile.** The diagram's `parked → merging: reconcile enqueues approved PR` and AD-13 ("enqueue approved held PRs under the fence") clash with three rules:
- AD-6: the fence requires the caller's own `owner/host/lane` and `generation`, and the coordinator is not the holder.
- AD-3: `merging` is written by "the lane that holds the unit".
- AD-13: the coordinator never builds Stories. After a reconcile enqueue, an ejection sends `merging → claimed`, which leaves a builder Story claimed by the coordinator. The coordinator then has to run the AD-19 conflict-fix and re-review sessions for it.

The reconcile Story and the merge-plumbing Story will each pick a different owner here.

**Fix (AD-6, AD-7, AD-3, diagram):**
- `merging` heartbeats like `claimed`. A `merging` record with a stale heartbeat whose PR is neither merged nor in the queue may be moved by any lane (CAS) to `released` with `attempts` + 1 and `pr` kept.
- Every release out of `merging`, not only `stop --now`, dequeues first.
- Reconcile's enqueue takes the record at `generation` + 1 under the coordinator's identity. That is an AD-3 row. On ejection or dequeue, it returns the record to `parked` held, never to `claimed`.

---

## Further holes (real consequence, ranked below the top 5)

- **F1 (S1): `stop --now` does not stop the lane.** AD-22 kills the process tree and releases the unit, but writes no `STOP`. Under AD-2 the launchd or systemd job relaunches the process. The new process finds no `STOP`, runs `next`, and claims again, likely the same unit, since a `stop --now` release costs no attempt. The emergency stop acts as abort-and-restart. *Fix:* `stop --now` writes the lane `STOP` (host `STOP` with `--all`) before killing, and kills `lane.pid` first so the lane can't launch a new agent between kills.
- **F2 (S1): the runner's git trusts the agent-writable `.git`.** AD-17 lets the agent write all of `.git` except `hooks` and `config`. That includes `refs/replace/`, `objects/info/alternates`, `info/grafts`, the index, and `.git/modules/*/config`.
  - The squash (AD-15), the AD-30 write check and any review diff read from that clone honour replace refs. An agent can replace `origin/main`'s commit with a lookalike, so the local diff hides an edit to `sprint-status.yaml` or a manifest, while `git push` sends the real objects.
  - A populated submodule's `.git/modules/x/config` is also agent-written. A recursive fetch by the runner can send the token to a host the agent chose, if the credential helper isn't scoped to the forge host.
  - *Fix (AD-18):* the runner fetches the session's HEAD into a runner-private repo and computes the squash, write check and review diff there. Run it with `GIT_NO_REPLACE_OBJECTS=1`, no alternates or grafts, and `--recurse-submodules=no`. The credential helper answers only for the forge host.
- **F3 (S2): glob-disjoint Stories of one Epic always conflict on BMAD's own artifacts.** Installed `bmad-build-auto` 6.12.4 never touches the manifest when the prompt is "Build Story 9.3" (AD-29). It writes a whole `spec-<slug>.md` and compiles a shared `_bmad-output/implementation-artifacts/epic-<N>-context.md` (step-01 §1.A.2–3), and step-04 commits both. Two parallel Stories of Epic 9 each add `epic-9-context.md` with different text, so the second PR conflicts. Under AD-19 that goes to a builder session, costing an attempt and a re-review. AD-3 and AD-30 describe a "`status:` line of the unit's own Story file" that BMAD doesn't write in this mode, and the v1 glob guard would refuse both files. *Fix (AD-29, AD-30, AD-19):*
  - Either point build-auto at a per-unit spec path in the prompt, or keep the epic-context cache out of the clone (temp folder, or a coordinator planning artifact).
  - Name the exact BMAD artifact paths a builder may write.
  - Have the runner resolve `epic-*-context.md` conflicts by taking `main`'s version.
- **F4 (S2, v1): Infrastructure approval never reaches anyone, and the approver is ambiguous.** An unapproved `infrastructure: true` Story has no ledger record, and AD-23's digest reads only `parked` records, PR states and `retro-gates.yaml`. The Story is skipped silently forever, and its Epic, with every dependent, stalls. Separately, AD-28 "accepted only from the item's owner, or from the Maintainer for `go` and `approve`" can be read so that a v1 item owner approves their own Protected Path Story. *Fix:* the digest also lists manifests marked `infrastructure: true` that have no matching approval. AD-28 states that `go` and `approve` are accepted **only** from the Maintainer.
- **F5 (S2): self-host can't pass AD-25's start check.** "A consumer's exact `@xaravel/xarabot` pin must equal it, and the lane refuses to start if it doesn't." The Xarabot repo *is* `@xaravel/xarabot` and has no such dependency, so its lanes refuse to start, or each Story invents its own exemption. *Fix:* state that the pin check is skipped when the repo's own `package.json` name is `@xaravel/xarabot`. In that case, `runner_version` alone governs.

## Checks that held

- **Two lanes racing one unit or overlapping globs:** AD-4's precondition re-check on the new tip, plus the contract race suite.
- **Stale lane pushing over a takeover:** AD-6's heartbeat-swap fence plus `--force-with-lease` against `head_sha`. Only the narrow residual noted under H3 remains.
- **Owner merges a parked-held PR by hand:** the snapshot reads the PR states of every ledger unit (AD-4), and any lane writes `merged` (AD-3).
- **Snapshot race against the coordinator deleting a `merged` record:** the ledger is read before `main`, and the record is deleted only after `main` marks the Story done.
- **Agent widening its own policy through `.xarabot/**`:** the AD-30 write check, AD-20 reading from `origin/main`, and the AD-33 owner-review prerequisite. Only the F2 bypass remains.
- **Coordinator double-start, or false expiry while idle:** AD-8's identity re-claim, and heartbeats through the waits (AD-2).
- **Unknown schema between versions:** AD-5 fails closed before `next`.
- **Merge after revocation:** before enqueue it is closed by AD-20's re-checks. A PR already in the queue is an explicitly accepted 0.x gap (Deferred), so it is not re-raised.
