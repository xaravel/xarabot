---
title: 'Story 2.6: `reconcile` enqueues approved PRs'
type: 'feature'
created: '2026-10-24'
baseline_revision: '721977cf6493063ee46cdade8d8f0f7c23d73e55'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A PR parked `awaiting-approval` still needs the Maintainer to add it to the merge queue by hand after approving it. The first attempt (`spec-2-6-reconcile-enqueues-approved-prs.md`, now in the tree) stopped on two intent gaps, which the Maintainer settled on 2026-10-25 (`epics.md` Story 2.6, AD-6). FR13, AR8, AR17.

**Approach:**
- Keep the attempt's `Forge.reviews`, take, fence, enqueue and gated queue check.
- Apply the after-park rule only to a coordinator-written park.
- Let any coordinator lane park a coordinator-held `merging` record at its generation.
- Apply the first review's `patch` findings.

## Boundaries & Constraints

**Always:**
- **The approval** (pure, `standingApproval`):
  - Count only reviews by the PR owner (`pr_owner`, logins compared case-insensitively) with a non-null `submitted_at`.
  - The decisive states are `approved`, `changes_requested` and `dismissed`. The latest decisive review (by `submitted_at`, ties by list order) must be `approved` on the PR's current head.
  - `commented` and `pending` reviews never count.
- **The after-park rule:**
  - It applies only to a re-park, which is a `parked` `awaiting-approval` record whose `lane` is `coordinator`. Such a record counts only reviews submitted strictly after its `heartbeat_at`.
  - A builder's first park (any other `lane`) counts any owner review, including one given while CI still ran.
  - No schema change.
- **A take candidate** is a `parked` `awaiting-approval` record of any kind with `pr`, `pr_owner` and `head_sha` set, whose PR the snapshot shows `open` at the record's `head_sha`. The run's own unit is never a candidate. A PR whose head moved after the park is never auto-queued (AD-14).
- **Order of a take:**
  1. `reviews`.
  2. Once per run, a fresh snapshot and `loadRepoConfig`. An invalid config or Standing Authority ends the step `stop`, and the record stays `parked`. A failed snapshot skips every take, with a note.
  3. Skip the candidate if the fresh snapshot shows the PR not open or at another head.
  4. `takeApproved`.
  5. A fence on the taken record (`heartbeat`, `passed_sha` = head). A refused fence means no enqueue.
  6. `enqueue(pr, head)`, retried on back-off up to `ENQUEUE_TRIES` with each retry fenced.
- **Enqueue outcomes:**
  - `ok`: done.
  - `conflict`: a Story or planning record re-parks. A `reconcile` record has its PR closed and is then `releaseReconcile`d. Its "closed, released" reason is pushed only after both succeed.
  - Any other failure leaves the record `merging` for the next run's queue check.
- **The queue check** covers coordinator-held, non-`reconcile` `merging` records whose PR has not merged:
  - `merged`: `markMerged`.
  - Queued at `approved_sha` (or at `head_sha` when `approved_sha` is null): leave it.
  - Queued at another head: a fenced `dequeue`, then a re-park.
  - Open and not queued, `closed`, or `not-found`: re-park.
  - Any other error: leave it, with a note.
- **Re-park:**
  - The edit: `park` `awaiting-approval` with `diffPaths` = `globs` and `inboxOwner` = `pr_owner`. This clears `approved_sha` and stamps `heartbeat_at`.
  - `park` of a `merging` record whose `lane` is `coordinator` accepts any writer whose lane is `coordinator` at the record's generation, as `releaseReconcile` does. Every other `park` still requires the exact holder.
  - A best-effort 🤖 comment, chosen by cause:
    - not queued: a new approving review of the current head re-queues it;
    - conflict: the queue refused it; once it can merge, a new approval re-queues it, and a pushed fix needs hand queueing or `xarabot rule rebuild`;
    - head moved: never auto-queued; queue it by hand or run `xarabot rule rebuild`;
    - closed: reopen it, then approve its current head again, or run `xarabot rule rebuild`.
  - `not-found` gets no comment.
- Every note and reason about another unit starts with `${unit}:`.
- **Ledger work order:**
  1. `markMerged`;
  2. reconcile `checkQueue`;
  3. the gated queue check;
  4. takes;
  5. dead and released reconcile records;
  6. `deleteMerged`.

  Each ledger item is fenced on the run's own unit.
- `gateComment`: once the owner approves the PR's current head, a coordinator lane running Story 2.6 adds it to the merge queue.
- **Docs:**
  - `self-host.md` covers:
    - the first-park and re-park rules;
    - the same-run re-park on a conflict;
    - that `reconcile` PRs are closed, not re-parked;
    - that GitHub turns a dismissed review's own state to `DISMISSED`;
    - queueing by hand or `rule rebuild` after a push;
    - that a moved coordinator leaves nothing stuck.
  - `app-permissions.md` lists `listReviews`.

**Never:**
- No approve, merge or auto-merge. No graph-approval, ruling, digest or Escalation work.
- No ledger schema change. The only ledger edit that changes is `park`, as above.
- No change to `.github/`, `AGENTS.md`, `_bmad/`, the spec folder, `standing-authority.md` or `reconcileDue`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First park, approved during CI | builder-parked `story:1.1`, PR #7 at H; owner approved H before the park | taken: `merging`, gen + 1, `approved_sha` = `passed_sha` = H; queued at H | none |
| Approved after the park | same, approval after `heartbeat_at` | taken | none |
| Older head / not owner / superseded / dismissed | approval on H0; another login; a later `changes_requested`; the approval's own state `dismissed` | not taken | none |
| Head moved | PR head H2 ≠ record `head_sha` | not a candidate | none |
| Invalid authority | approval stands; fresh `main` authority invalid | `stop`; stays `parked`; no enqueue | none |
| Taken record fence lost | the `heartbeat` on the taken record is refused | no enqueue; `merging` left for the queue check | none |
| Two approved | two candidates approved | one fresh snapshot; both taken and queued | none |
| Enqueue conflict | `enqueue` → `conflict` | re-parked; globs = diff paths; `approved_sha` null; conflict comment | none |
| Still queued | gated `merging`, queued at `approved_sha` | unchanged | none |
| Not queued / closed / not-found | gated `merging` | re-parked; not-queued, closed or no comment | none |
| Queued at another head | queued at H2 | dequeued, re-parked, head-moved comment | dequeue failure leaves it |
| Re-park, old approval | coordinator-parked; the approval predates the park | not taken | none |
| Re-park, fresh approval | plus an owner approval after the re-park | taken again | none |
| Coordinator moved | gated `merging` held by `COORD_2`, the run is `COORD`; PR ejected | re-parked by `COORD` | none |
| Merged | gated `merging`, PR merged | `merged` | none |
| Reconcile PR | `reconcile:3` parked (protected path), approved after the park | taken; a conflict closes the PR, then releases | none |
| Reviews | PR with reviews / none / missing | author, state, SHA, time in order / `[]` / `not-found` | a malformed item → `transient` |

</intent-contract>

## Code Map

The attempt's code is in the tree at `721977c`. The paths below say what changes from there.

- `src/core/reconcile/approval.ts`:
  - `ApprovalQuery.parkedAt` becomes `string | null`, where `null` means no time filter.
  - A non-null value that does not parse still returns `null`.
  - Update the header doc.
- `src/core/reconcile/plan.ts`:
  - `ApprovalTarget.parked_at` becomes `string | null`: `r.heartbeat_at` when `r.lane === "coordinator"`, else `null`.
  - Document it.
- `src/core/ledger/edits.ts`:
  - `park` (l.520): after the reason and diff-path checks, a record in `merging` with `lane === "coordinator"` written by `ctx.by.lane === "coordinator"` is checked by state and generation only (`requireRecord`, `requireState`, `requireGeneration`), the same pattern as `releaseReconcile` (l.733).
  - Otherwise keep `requireHeld`.
  - Update the doc comment.
- `src/lane/reconcile-step.ts`:
  - `reparkComment(unit, cause)` with `cause` one of `"not-queued" | "conflict" | "head-moved" | "closed"`, with literal texts as in Boundaries.
  - `repark(t, why, cause | null)`.
  - `checkGated` reasons:
    - "is not in the merge queue" (cause `not-queued`);
    - "is closed" (cause `closed`);
    - queued at another head (cause `head-moved`);
    - `not-found` (no comment).
  - `take`:
    - a conflict uses the `conflict` cause;
    - the reconcile conflict's reason is pushed after `closePr` and `releaseReconcile` succeed;
    - a note when the taken record's fence is refused.
  - Prefix `${t.unit}:` on every note and reason about another unit (re-park comment failures, `queueState`, `reviews`, enqueue).
  - Update the header doc (the after-park rule applies to re-parks only).
- `src/lane/merge-step.ts` `gateComment` (l.79) -- "a coordinator lane running Story 2.6 adds it to the merge queue".
- `src/lane/lane-process.ts` l.524 -- the `sweepMerged` doc: the Maintainer queued it by hand, or the coordinator queued it on approval.
- `docs/maintainer/self-host.md` l.448-452 and l.486 -- rewrite as in Boundaries. l.514 "Until `runner_version` has Story 2.6…" stays, and gains that a gated record the old coordinator left `merging` is moved on by the new one.
- `test/core/reconcile/approval.test.ts` -- rows for `parkedAt: null` (an approval before the park counts; superseded still voids), and the real dismissed shape (a single review whose own state is `dismissed`).
- `test/core/reconcile/plan.test.ts` -- `parked_at` is `null` for a builder-lane park and `heartbeat_at` for a coordinator-lane park.
- `test/core/ledger/edits.test.ts` near l.230 -- `park` rows:
  - a coordinator-held `merging` record parked by `COORD_2` (l.447, move the const up or reuse it) at its generation;
  - the wrong generation → `precondition`;
  - a builder writer → `precondition`;
  - a builder-held `merging` record parked by another identity → `precondition`;
  - a coordinator-held `claimed` record parked by another coordinator → `precondition`.
- `test/adapters/forge/github/pulls.test.ts` -- `toReview` malformed rows: a non-object `user`, a non-string `submitted_at`, and a missing `submitted_at` key (→ `null`, valid).
- `test/lane/reconcile-step.test.ts` (Story 2.6 describe, l.844):
  - new rows: First park approved during CI; Taken record fence lost (a `beforeSwap` refusal modelled on `test/lane/merge-step.test.ts:368`); Two approved; Coordinator moved;
  - literal `reparkComment` texts per cause;
  - the existing re-park and conflict rows assert the cause's comment;
  - "Re-approval needed" and "Fresh approval" use a coordinator-lane parked record;
  - the existing "Approved" row stays (its approval is after the park).
- `test/lane/merge-step.test.ts` l.204 -- the new gate comment text.
- Read-only: `src/core/next/next.ts` l.72 (builders never take a coordinator-held `merging` record) and `src/core/ledger/transitions.ts` (`merging → parked` is allowed).

## Tasks & Acceptance

**Execution:**
- `src/core/reconcile/{approval,plan}.ts` -- after-park rule only for coordinator-lane parks -- Maintainer 2026-10-25.
- `src/core/ledger/edits.ts` -- `park` accepts any coordinator writer for coordinator-held `merging` -- AD-6.
- `src/lane/reconcile-step.ts`, `src/lane/merge-step.ts`, `src/lane/lane-process.ts` -- re-park causes, reason order, unit prefixes, gate text, `sweepMerged` doc -- review patches.
- `docs/maintainer/self-host.md` -- the runbook.
- Tests listed in the Code Map -- every matrix row.

**Acceptance Criteria:**
- Given a coordinator lane with a 2.6 runner and `story:1.1` parked by its builder awaiting approval, PR #7 open at H, when the owner's approval of H stands (given before or after the park) and a `reconcile` run happens, then `story:1.1` is `merging` at `generation` + 1 with `approved_sha` H, PR #7 is queued at H, and no agent session ran.
- Given that PR ejected, when the next run happens, then `story:1.1` is `parked` awaiting approval, with lane `coordinator`, `approved_sha` null and globs equal to its diff paths. No later run takes it until a new owner approval of the current head lands after that park.
- Given the coordinator moved hosts while a gated record was `merging`, when the new coordinator's run finds its PR ejected, then the record is parked and holds no globs beyond its diff paths.
- Given `bun --bun oxlint` and `bun --bun tsc`, when they run, then both exit 0.

## Spec Change Log

## Review Triage Log

### 2026-10-24 — Review pass
- verdicts: 22 findings — high 0, medium 1, low 17, false 4, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind 1) The coordinator also writes first parks (a `reconcile` PR's protected-path park), so they use the after-park rule, and an approval given during CI is ignored. — Real, but the Maintainer's 2026-10-25 rule defines a re-park by `lane: coordinator` with no schema change, and `epic-2-context.md` says the same. A gated `reconcile` PR is rare, and its gate comment goes out right after the park. Telling first parks from re-parks needs new record state.
  - `[low]` `[patch]` (blind 2) No test pins a coordinator-written first park's `parked_at`. — Added a `plan.test.ts` case: `reconcile:3`'s first protected-path park gets `parked_at` = `heartbeat_at`.
  - `[low]` `[patch]` (blind 3) `self-host.md` says a parked `reconcile` PR "is taken the same way" right after the builder-park rule, which suggests an approval during CI counts. — The runbook now says the coordinator parks a `reconcile` PR itself, so only an approval after its gate comment counts.
  - `[low]` `[reject]` (blind 4) A coordinator re-park released by a ruling, then re-parked by a builder at the same head, counts the old approval again. — Within the Maintainer's rule ("a builder's first park counts any approving review … with no schema change"). The Maintainer released it by hand, and the fix needs new record state.
  - `[false]` `[reject]` (blind 5) A refused retry fence in the enqueue loop returns with no trace. — `item` pushes `heartbeat <unit> skipped: …` to the reasons and the log on every refused fence (`reconcile-step.ts`, `item`).
  - `[low]` `[reject]` (blind 6) A refused fence or a non-conflict enqueue failure leaves the record `merging`, and the next run re-parks it, costing a re-approval. — Rejected by design in the first pass (edge 1, edge 2): telling "never queued" from "ejected" needs new record state. The comment now reads "is not in the merge queue", which is accurate.
  - `[low]` `[patch]` (blind 7) `self-host.md` never covers a push while the PR is queued; it also says every re-park posts a comment, but `not-found` posts none. — The push paragraph now covers a push while queued (dequeued, re-parked, head-moved comment). The `not-found` wording stays: a PR the forge does not know is not met in everyday use.
  - `[low]` `[patch]` (blind 8) The relaxed `park` path has no unit-kind guard, and no row shows that a non-`awaiting-approval` kind is still refused on it. — No caller parks a coordinator-held `reconcile` record (the plan routes them to `checkQueue`), and the holder could already do so before this change. Added the edits row "park coordinator-held merging blocked by another coordinator" → `precondition`.
  - `[low]` `[patch]` (blind 9) The `sweepMerged` doc line runs past the wrap width. — Re-flowed.
  - `[low]` `[patch]` (blind 10) An explicit `submitted_at: null` row is missing, and the runbook omits pending reviews. — The explicit-null row already exists (`pulls.test.ts:215`). The runbook now says "Comments and pending reviews never count".
  - `[medium]` `[patch]` (edge 1) A push to a queued PR's branch makes GitHub drop it from the queue. The queue check then sees the PR open and not queued at a new head, and its `not-queued` comment promises that a new approval re-queues it, which a moved head never does. — `checkGated` now re-parks with cause `head-moved` whenever the queue's head differs from `approved_sha`, before the closed and not-queued branches. Added a step test.
  - `[low]` `[reject]` (edge 2) A non-conflict enqueue failure is re-parked as not-queued. — Same root cause as blind 6.
  - `[low]` `[reject]` (edge 3) A coordinator-written first park counts as a re-park. — Same root cause as blind 1.
  - `[low]` `[reject]` (edge 4) A builder re-park after a ruling revives an old approval. — Same root cause as blind 4.
  - `[low]` `[patch]` (verification-gap 1) No test shows that a refused `releaseReconcile` after a successful close omits the "closed, released" reason. — Pre-verified. Added "Reconcile PR approved, enqueue conflict, the release refused" (a `beforeSwap` generation bump).
  - `[low]` `[reject]` (intent A) No live test of the App's enqueue under `Protect main`, or of the 10-minute timing. — Needs live credentials and the ruleset, which this session lacks. Recorded as a residual risk.
  - `[low]` `[reject]` (intent B) The re-park test keys on `lane`, not on the cause. — Same root cause as blind 1.
  - `[low]` `[reject]` (intent C) A head-moved re-park keeps the first park's diff paths, not the PR's current diff. — Real only after someone pushes to a bot PR by hand. Recomputing the diff needs a `runner.git` diff in the coordinator. The comment and the runbook point at `rule rebuild`, which releases the paths.
  - `[low]` `[reject]` (intent D) A parked PR whose head moved gets no forge-visible signal. — Rejected in the first pass (blind 5): it needs a new plan output, and the runbook covers it.
  - `[false]` `[reject]` (intent E) The coordinator claim handover is not exercised. — The `park` edit does not read `coordinator.json`. The handover is Story 2.4's code and tests.
  - `[false]` `[reject]` (intent F) The runbook's dismissed-review claim is backed only by fixtures. — GitHub's REST API reports a dismissed review with state `DISMISSED`, and the rule rejects it either way.
  - `[false]` `[reject]` (intent G) The reviews AC is mostly in `721977c`. — Descriptive; no defect is claimed.

## Design Notes

- **Re-park test is `lane === "coordinator"`** (Maintainer, 2026-10-25). Taken literally, a `reconcile` PR's protected-path park (written by the coordinator) also uses the after-park rule. That is harmless: the gate comment goes out right after that park, and the PR exists only from CI start.
- **The attempt's rejected findings stay rejected** (first spec's Triage Log): an enqueue that failed without queueing is re-parked, and the Standing Authority is checked once per run.
- **Reuse the `releaseReconcile` precedent** for `park`'s relaxed holder check, so the one ledger edit change is small and symmetric.

## Verification

**Commands:**
- `bun test` -- expected: 0 fail (sandboxed: the socket-binding and emulator cases report skipped)
- `bun test test/core test/lane test/contracts test/adapters/forge test/ports` -- expected: 0 fail
- `bun --bun oxlint` -- expected: exit 0
- `bun --bun tsc` -- expected: exit 0

## Auto Run Result

Status: done

**Summary.** The coordinator's `reconcile` run queues a parked PR once the owner's approval of its current head stands. The first attempt is completed with the Maintainer's 2026-10-25 decisions:
- A builder's first park counts any owner approval of the current head, including one given while CI still ran. Only a coordinator-written park (`lane: coordinator`) needs a review submitted after the park.
- Any coordinator lane may park a coordinator-held `merging` record at its generation, so a coordinator that moved hosts leaves nothing stuck (AD-6).
- A moved head is never queued automatically (AD-14).

The first review's patches are applied:
- the re-park comment is chosen by cause (`not-queued`, `conflict`, `head-moved`, `closed`);
- the reconcile "closed, released" reason is pushed only after both steps succeed;
- notes and reasons about another unit carry its prefix;
- the gate comment names a coordinator lane running Story 2.6;
- the runbook is fixed.

**Files changed:**
- `src/core/reconcile/approval.ts`: `parkedAt` is `string | null`; `null` means no after-park filter.
- `src/core/reconcile/plan.ts`: `parked_at` is `heartbeat_at` for a coordinator-lane park, else `null`.
- `src/core/ledger/edits.ts`: `park` accepts any coordinator-lane writer for a coordinator-held `merging` record at its generation.
- `src/lane/reconcile-step.ts`: `ReparkCause` and the four comments; a moved head (whether queued, ejected or closed) re-parks with the head-moved comment; the reason order; unit prefixes; a note when the taken record's fence is refused.
- `src/lane/merge-step.ts`: the gate comment text.
- `src/lane/lane-process.ts`: the `sweepMerged` doc comment.
- `docs/maintainer/self-host.md`: the Story 2.6 runbook (first park and re-park rules, dismissals, pending reviews, `reconcile` PRs, pushes while parked or queued, a moved coordinator).
- `_bmad-output/implementation-artifacts/epic-2-context.md`: recompiled for the 2026-10-25 decisions.
- Tests: `approval.test.ts`, `plan.test.ts`, `edits.test.ts`, `pulls.test.ts`, `reconcile-step.test.ts`, `merge-step.test.ts`.

**Review findings:** 22 findings, 9 patched. By verdict: high 0, medium 1, low 17, false 4.
- Patched: medium 1 (edge 1, a moved head re-parked with the wrong comment) and low 8 (blind 2, 3, 7, 8, 9, 10, verification-gap 1, plus test rows).
- Deferred: none.
- Rejected, with the reason recorded in the Review Triage Log:
  - blind 1, edge 3 and intent B: the Maintainer's lane rule;
  - blind 4 and edge 4: within the Maintainer's rule, and the fix needs new record state;
  - blind 6 and edge 2: rejected by design in the first pass;
  - intent A: no live credentials;
  - intent C: a rare hand push, remedied by `rule rebuild`;
  - intent D: rejected in the first pass;
  - false: blind 5, intent E, intent F, intent G.

**Follow-up review recommended:** false. One `medium` and no `high` entry was patched.

**Verification:**
- `bun install --frozen-lockfile`: installed; the clone had no `node_modules`.
- `bun test` (`XARABOT_SANDBOXED=1`): 3309 pass, 269 skip, 0 fail.
- `bun test test/core test/lane test/contracts test/adapters/forge test/ports`: 2770 pass, 140 skip, 0 fail.
- `bun --bun oxlint`: exit 0.
- `bun --bun tsc`: exit 0.
- Matrix audit: every I/O row has a covering test that ran and passed (checked in JUnit output). The only skips in the covering files are the forge contract's "fake without controls" cases.

**Residual risks:**
- The GitHub-emulator and live contract cases for `reviews` are skipped when sandboxed; CI runs the emulator cases.
- No live check that GitHub accepts the App's enqueue of an approved PR under `Protect main`.
- A typeless GraphQL error that maps to `forbidden` could stop the coordinator lane on a refusal of a single PR (first pass, blind 8; unverified).
- A gated `reconcile` PR's first park, written by the coordinator, needs an approval after its gate comment (the Maintainer's lane rule).
