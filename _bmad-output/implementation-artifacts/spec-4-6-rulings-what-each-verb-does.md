---
title: 'Story 4.6: Rulings: what each verb does'
type: 'feature'
created: '2026-10-27'
status: 'done'
baseline_revision: '9dda8ce3d21b8da75ec0b21158c4de3e0e06749f'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
resolves: ["4.5-d1"]
deferred:
  - id: "4.6-d1"
    summary: >-
      A host `go` (`xarabot rule go checkpoint:<N>` or `go retro:<N>`) records `ruling: xarabot-rule` in `retro-gates.yaml`, a value the spine does not name.
    evidence: |-
      ARCHITECTURE-SPINE.md AD-12 says every go's `ruling` is "the id of the ruling comment (AD-28), or `maintainer-pr`". A host ruling has no comment, and Story 4.6's ACs and the Maintainer's decisions do not say what it records. The build chose `xarabot-rule` (HOST_RULING_ID), in the style of `maintainer-pr`. The schema accepts any non-empty string, and no reader branches on the value. A Maintainer ruling that names another value is a one-constant change, plus a spine line.
    location: >-
      src/core/rulings/effects.ts (HOST_RULING_ID)
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Story 4.5 reads, judges and acknowledges `/xarabot <verb> <unit-id>` rulings, but no verb does anything. A `go`, an approval, a tag flip, a status change, a release, a rebuild or a dismissal is acknowledged and lost (deferred `4.5-d1`). `xarabot rule` takes only `release` and `rebuild` (FR5, FR9, FR10, FR13, AR29, AD-28).

**Approach:**
- Each valid ruling gets an effect, built by pure core code from the run's snapshot:
  - `approve`, `release` and `rebuild`: a ledger edit (`applyRuling`). `rebuild` closes the open PR first.
  - `go`, `block`, `unblock`, `done` and `defer`: a pending entry in `coordinator.json` (Maintainer decision 1). `reconcile` writes every pending entry into `retro-gates.yaml` in its PR, on every run, until `main` shows it.
  - `dismiss`: a dismissal in `coordinator.json` (Maintainer decision 2). The digest leaves the item out until the item comes back as a new instance.
- All of a batch's effects go into the rulings cursor swap, so a batch lands whole or not at all. `xarabot rule` applies every verb with the same edits.

## Boundaries & Constraints

**Always:**

`coordinator.json` (ledger `schema_version` stays 6, Maintainer decision 1):
- It gains two optional lists. Each is written only when it is non-empty, so older records and their texts are unchanged:
  - `pending_rulings`: `{verb, unit, by, at, ruling}`. `verb` is `go`, `block`, `unblock`, `done` or `defer`. `go` takes a `checkpoint:<N>` or `retro:<N>` unit; the other verbs take a `retro-item:<id>` unit.
  - `dismissals`: `{unit, subject, since}`. `since` is `null` when nothing dates the item.
- Every coordinator edit keeps both lists, including the claim and a takeover.
- A new edit, `recordRulings`, refuses unless the writer holds `coordinator.json` at `generation`. It then:
  - optionally moves `rulings_cursor` (refusing unless the cursor is still `from`);
  - drops the listed entries;
  - adds new entries. A pending entry replaces any entry with the same unit and family; the families are `go`, `block`/`unblock` and `done`/`defer`. A dismissal replaces any dismissal of the same unit.
  - It writes nothing when nothing changes.

Judging a batch (pure, `src/core/rulings/`):
- Comments are judged in order, each against a view. The view is the snapshot with every pending entry applied to `retro_gates` and with each earlier valid ruling of the batch applied.
  - So a second `release` of the same unit is refused.
  - `unblock` while a `block` is pending is valid and replaces it.
  - A second `go` is refused because there is already a go.
- `approve` also needs the Story's manifest on `main`; otherwise it is refused with the reason.
- The effects:
  - `approve`: `applyRuling` `approve` at the record's generation, with `approval` = {the ruling's author, the manifest's `sha`}.
  - `release` and `rebuild`: `applyRuling` with that verb, unchanged from Story 2.5b. `rebuild` also closes the PR when the snapshot shows it open.
  - `go`, `block`, `unblock`, `done` and `defer`: a pending entry, where `by` is the author, `at` is the comment's `created_at`, and `ruling` is the comment id. From the host, `by` is `config.maintainer`, `at` is the snapshot's `now`, and `ruling` is `xarabot-rule`.
  - `dismiss`: `{unit, subject, since}`, where `subject` and `since` are the inbox item's text and start time as `renderDigest` shows them in the view.

Applying the entries to `retro-gates.yaml` (pure, in order):
- `go checkpoint:<N>` sets `epics.<N>.checkpoint.go` = {by, at, ruling}, unless one is already there.
- `go retro:<N>` sets `epics.<N>.retro.go`, only on a rejected retro that has no go.
- `block` and `unblock` set the item's `blocking`.
- `done` and `defer` set the item's status through the existing `applyItemStatuses`.
- Each change adds a summary line.
- An entry is "shown on `main`" when applying it to `main`'s file changes nothing. This covers an entry that cannot apply, such as an item that is no longer listed.

The rulings step (`reconcile`, after the ledger work, before the inbox step):
1. Read the new comments and judge the batch.
2. For each valid `rebuild` whose PR is open, close the PR. If the close fails, that ruling is refused instead: "closing PR #n failed: …", and its effect is dropped.
3. One swap writes `fenced(heartbeat(run record), allOf(recordRulings(...), ...applyRuling edits))`. `recordRulings`:
   - moves the cursor;
   - adds this batch's pending entries and dismissals;
   - drops the snapshot's pending entries that `main` shows, and the dismissals whose unit the final view lists as a new instance (another subject or start time). A dismissal whose item is not listed stays: it is no new instance (Maintainer decision 2).
   - When the cursor does not move but there is something to drop, the swap holds only `recordRulings`.
4. Only after the swap lands, reply as Story 4.5 does. A refused swap posts no reply, leaves the cursor where it was, and is logged; the next run reads the comments again against a fresh snapshot.
5. After the step:
   - `retro_gates_path` is planned again with the pending list as it now stands, so this run's PR carries this batch's gates rulings. A gates edit whose summary is empty is `none`.
   - The inbox renders from the final view: pending entries applied, released records out, and dismissed items left out. A swap that did not land leaves the snapshot's view.

`renderDigest` leaves out an item whose unit, `what` and `since` match a stored dismissal.

`xarabot rule <verb> <unit-id>` takes all nine verbs:
- `release` and `rebuild` keep Story 2.5b's path.
- The other verbs assemble the snapshot (`assembleSnapshot`) and judge as the Maintainer (`config.maintainer`). A refusal exits 1 with the reason. The command then swaps the same `applyRuling` or `recordRulings` edit, without moving the cursor.
- The gates verbs and `dismiss` write `coordinator.json`, so they need the repo's coordinator lane on the host.

**Never:**
- No agent session. No hand edit of `retro-gates.yaml`, `coordinator.json` or any Epic context file. No `.github/` change.
- No change to `next`, the gates or the due rule: the gates read only `main`'s `retro-gates.yaml`, so they follow at the next claim after the `reconcile` PR merges.
- No ledger `schema_version` bump. No change to the reply texts or to the write check's refusals.
- No mocks in the core case tables, and no token-shaped literals.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| go checkpoint | `/xarabot go checkpoint:4`, the Maintainer | pending go; this run's PR sets `epics.4.checkpoint.go`; the item leaves the inbox | — |
| go rejected retro | `/xarabot go retro:2` | pending; the PR sets `retro.go`; the rejected-retro item leaves the inbox | — |
| approve | parked needs-approval 2.2 | `released`, `approval` = {author, manifest sha} | no manifest: refused |
| block/unblock | on a listed item | pending; the PR flips `blocking` | — |
| release / rebuild | parked unit | released; counters 0. rebuild also closes the PR and clears its SHAs and providers; release keeps the providers | close fails: refused, record unchanged |
| dismiss | listed item | dismissal stored; the item is gone from the inbox; ledger and gates unchanged | — |
| dismissal expiry | the item is listed again with another `since` or `what` | the dismissal is dropped; the item shows again | an unlisted item keeps its dismissal |
| done/defer | open retro item | pending; the PR sets the status | — |
| pending survives | PR closed or failed, or the run died | the next run writes it again | — |
| shown on main | `main` holds the effect | the entry is dropped | — |
| same unit twice | `release story:2.1` twice | first valid, second refused | — |
| swap refused | a record moved | no reply, cursor kept | logged |
| host rule | `xarabot rule go checkpoint:4` | the same pending entry | refused target: exit 1 |

</intent-contract>

## Code Map

- `src/core/schemas/ledger.ts:212-221` -- `CoordinatorRecordSchema`: add `PendingRulingSchema` and `DismissalSchema`, and the two `.optional()` arrays. The type stays assignable from the old fixtures.
- `src/core/ledger/codec.ts:173-186` -- `serializeCoordinator`: write each list after `rulings_cursor`, only when it is non-empty.
- `src/core/ledger/edits.ts`:
  - `makeCoordinatorEdit` :1092 (let its body return `null`), `coordinatorStamp` :1110 (keep the lists), `advanceRulingsCursor` :1200 (the model);
  - `applyRuling` :864. Add an `approver` param for `approve`, defaulting to `ctx.by.owner`, which the host path keeps;
  - `fenced` :1051. Add `allOf(edits)`: apply the edits in sequence, merge the writes and deletes, skip `null`s, return the first error.
- `src/core/rulings/rulings.ts` -- `target()`: `approve` also needs the manifest. Export `bodyOf` if useful.
- `src/core/rulings/effects.ts` (new) -- `withPending`, `judgeRulings(snapshot, comments, source)` and the effect and view types, `pendingKey`, `rulingsDrops(view, snapshot)`, and `rulingsEdit({by, now, coordinatorGeneration, cursor, judged, drops})`, which returns `allOf` of `recordRulings` and the `applyRuling` edits.
- `src/core/reconcile/retro-gates-edit.ts` -- `applyPendingRulings(gates, pending)` → `{gates, summary}`. `editRetroGates` gains a `rulings` param, applied last.
- `src/core/reconcile/plan.ts:398-406` -- `planReconcile(..., pending = snapshot coordinator's)`. Call the edit when there are additions, items done or rulings; an empty summary is `none`.
- `src/core/inbox/render-digest.ts` -- extract the item collection so `inboxInstance(snapshot, unit)` → `{subject, since} | null` (with no files), and filter dismissed items in `renderDigest`.
- `src/lane/rulings-step.ts` -- `answerRulings`: `judge(comments)` → judged list, the rebuild closes, then `commit(from, to, judged)`, then the replies. The return value carries the judged list and whether the swap landed.
- `src/lane/reconcile-step.ts:905-944,1196-1197` -- the `rulings()` closure builds the swap, does the drop-only swap and returns the final view and pending list. `steps()` re-plans the retro gates with that list, and `inboxes(view)` renders from it.
- `src/lane/rule.ts`, `src/cli/rule.ts` -- every verb. `RULE_USAGE` lists them. The new path uses `forge.snapshot({read: readsPath})` and `assembleSnapshot`, as `coordinator-process.ts:315-339` does.
- Tests: `test/core/next/fixtures.ts` (`snapshotOf`, `World.coordinator`), `test/core/rulings/rulings.test.ts` (the world to reuse), `test/lane/rulings-step.test.ts`, `test/lane/reconcile-step.test.ts:3005+` (Story 4.5's describe), `test/lane/rule.test.ts`, `test/cli/rule.test.ts`, `test/core/ledger/edits.test.ts`, `test/core/ledger/codec.test.ts`, `test/core/reconcile/maintainer-routing.test.ts`, `test/core/inbox/*`, `test/core/lane/write-check.test.ts`.

## Tasks & Acceptance

**Execution:**
- `src/core/schemas/ledger.ts`, `src/core/ledger/codec.ts`, `src/core/ledger/edits.ts` and their tests -- the lists, `recordRulings`, `allOf` and the `approver`. Cases:
  - add, drop and supersede;
  - a cursor mismatch, a wrong generation and another holder each refuse;
  - nothing changed writes nothing;
  - a claim and a takeover keep the lists;
  - the old texts round-trip unchanged.
- `src/core/reconcile/retro-gates-edit.ts`, `src/core/reconcile/plan.ts` and tests -- `applyPendingRulings` (each verb, and each no-op), `editRetroGates` with rulings, and `planReconcile` with only rulings (an edit) and with only shown ones (`none`).
- `src/core/rulings/effects.ts`, `src/core/rulings/rulings.ts` and `test/core/rulings/effects.test.ts` (new) -- the case tables, with no mocks:
  - each verb's effect;
  - judging in sequence (twice, superseding, a second go);
  - `approve` with no manifest;
  - the pending view;
  - drops (shown, a new instance, an unlisted item kept);
  - the dismissal instance.
- `src/core/inbox/render-digest.ts` and tests -- dismissed items left out, and a new instance shown.
- `src/lane/rulings-step.ts`, `test/lane/rulings-step.test.ts` -- the rebuild close and its failure, the swap before the replies, and a refused swap with no reply.
- `src/lane/reconcile-step.ts`, `test/lane/reconcile-step.test.ts` -- one end-to-end case per verb on the fake forge. Also:
  - pending survives a run with no PR;
  - drop once `main` shows it;
  - the inbox after a dismissal;
  - the item leaves the inbox after `go retro`.
- `src/lane/rule.ts`, `src/cli/rule.ts` and tests -- each new verb through the host, a refused target, and gates verbs needing the coordinator lane.
- `test/core/lane/write-check.test.ts` -- a builder diff that adds a checkpoint go or flips `blocking` is still refused.

**Acceptance Criteria:**
- Given `/xarabot go checkpoint:<N>` or `go retro:<N>` (rejected), when `reconcile` applies it, then runner code records the go in `retro-gates.yaml` through its PR, and `next` on the merged `main` no longer holds the dependents.
- Given `approve` on an Infrastructure Story, when it is applied, then the record is `released` with `approval` {Maintainer, manifest sha}, and `next` with a changed manifest sha parks it `needs-approval` again.
- Given `release` or `rebuild`, when it is applied, then the counters are 0. `release` keeps the providers. `rebuild` closes the PR and clears `reviewed_sha`, `passed_sha` and the providers.
- Given `dismiss`, when it is applied, then only the inbox item goes, and the ledger records and `retro-gates.yaml` are unchanged.
- Given `xarabot rule <verb> <unit-id>` for each verb, when it runs, then it writes the same edit as the comment ruling.
- Given any ruling, when it is applied, then no agent session runs, and the write check still refuses an agent diff that changes a verdict, an item or a go.

## Spec Change Log

## Review Triage Log

### 2026-10-27 — Review pass
- verdicts: 38 findings — high 0, medium 2, low 29, false 7, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) When a rebuild's PR close fails, later rulings in the batch keep judgements made as if the rebuild landed. Real, but it needs a failed close and a second ruling on the same unit in one batch, and re-posting recovers. The fix re-judges the batch, which adds a second judging pass to the step.
  - `[low]` `[reject]` (blind) One stale ledger effect refuses the whole batch. This is the spec's design ("a batch lands whole or not at all"): the refusal is logged, and the next run judges the same comments against a fresh snapshot, where the moved record is refused with its reason.
  - `[low]` `[patch]` (blind) `applyEffect`'s rebuild view cleared fewer fields than `applyRuling`. It now also clears `enqueued_sha`, `approved_sha`, `approved_graph` and `retro_result`.
  - `[low]` `[patch]` (blind) The `allOf` delete/write test ran only one edit, so `merged()` never ran. It is now two edits, delete then write, with write then delete added.
  - `[low]` `[patch]` (blind) New failure paths are untested. Added the throwing-judge case. The rest (the drop-only swap's refusal log, `applyHostVerb`'s snapshot and assembly errors) are plain log and error passthrough, so they were rejected.
  - `[low]` `[reject]` (blind) The drop-only swap is not fenced on the run's record. The spec says it holds only `recordRulings`, and `recordRulings` still needs the writer to hold `coordinator.json` at its generation, so a run that lost the coordinator claim cannot write it.
  - `[low]` `[patch]` (blind) The `plan:` note logged the first plan's retro-gates kind. A note with the kind re-planned after the rulings step was added.
  - `[low]` `[patch]` (blind) Verb lists and `bodyOf` were duplicated. The lists are now derived from `PENDING_RULING_VERBS`, and `retro-gates-edit.ts` imports `bodyOf` from `rulings.ts`.
  - `[low]` `[reject]` (blind) Dismissals of items that never return pile up in `coordinator.json`. Maintainer decision 2 drops a dismissal only when its item comes back as a new instance. A pruning rule changes that decision; noted under residual risks.
  - `[low]` `[reject]` (blind) A pre-4.6 runner reads a `coordinator.json` holding the new lists as `invalid`, not as a newer version. Maintainer decision 1 keeps `schema_version` 6 and has every lane's pin advance together at the tag that carries 6.
  - `[low]` `[patch]` (blind) `reported()` in `src/cli/rule.ts` printed "approved" for any ledger effect. It now switches on the verb and sits below the constants.
  - `[low]` `[patch]` (blind) Doc typo "come back" in `render-digest.ts`. Fixed.
  - `[low]` `[reject]` (blind) An extra blank line in `test/cli/rule.test.ts`. Cosmetic, and the linter accepts it.
  - `[false]` `[reject]` (blind) The spec's `created` date is in the future. The system date (UTC) is 2026-10-27.
  - `[low]` `[reject]` (blind) The spec's Code Map line numbers are stale. The fix edits this build's spec.
  - `[medium]` `[patch]` (edge) With `main`'s graph unresolved, `snapshot.retro_gates` is empty, so every pending block/unblock/done/defer/go-retro looked "shown" and was dropped for good. `rulingsDrops` now drops no pending entry while the graph does not resolve. Core and step tests added.
  - `[low]` `[reject]` (edge) A failed rebuild close leaves later judgements in the batch stale. Same as the first blind entry.
  - `[low]` `[reject]` (edge) `withPending` or `rulingsDrops` throwing would fail the run. Both are pure functions over a validated snapshot, and a guard adds a branch for a bug that is not shown.
  - `[low]` `[reject]` (edge) Dismissals pile up. Same as the blind entry on Maintainer decision 2.
  - `[low]` `[reject]` (edge) A unit with two inbox items (a parked record and an unmanifested heading) dismisses the first. That needs a parked Story with no manifest, which next never claims; rare, and the fix adds owner matching.
  - `[low]` `[patch]` (edge) `dismiss checkpoint:N` on a bootstrapped Epic with no retro was refused, though the digest lists it. `maintainerLists` now counts a bootstrapped Epic as retro done, as `renderDigest` does. Test row added.
  - `[low]` `[reject]` (edge) A judge that always throws now keeps the cursor stuck. `judgeRulings` is pure, so a deterministic throw is a bug. The throw is logged, and a per-comment catch adds a branch for a case that is not shown.
  - `[low]` `[reject]` (edge) Rebuild PRs are closed before a swap that may be refused. The spec closes before the swap on purpose (Story 2.5b's order), so a released record never keeps an open PR a builder would adopt. A re-run finds the PR closed.
  - `[low]` `[patch]` (verification-gap) The inbox view with a seeded pending ruling and no new comment was unverified. Added a step test: a pending `go checkpoint:1` keeps the item out of the Maintainer's inbox.
  - `[low]` `[patch]` (verification-gap) The batch swap's own drops were unverified at step level. Added a step test: a seeded pending entry `main` shows, plus a ruling comment; the landed `coordinator.json` no longer holds the entry.
  - `[low]` `[patch]` (verification-gap) A throwing judge was untested. Same fix as the blind failure-path entry.
  - `[low]` `[reject]` (verification-gap) A throwing judge now stops rulings. Same as the edge entry.
  - `[low]` `[patch]` (verification-gap) The `allOf` test name overstates its coverage. Same fix as the blind entry.
  - `[false]` `[reject]` (intent) Gates follow only after the PR merges, not at the claim right after the ruling. AD-3 and Maintainer decision 1 put `retro-gates.yaml` on `main`, written only by `reconcile`'s PR, and an effects test runs `go checkpoint` through `next` on the resulting text.
  - `[low]` `[reject]` (intent) The inbox clears an item before the gate lifts. This is the spec's chosen view (pending applied). The pending entry is written again on every run until `main` shows it.
  - `[medium]` `[defer]` (intent) The host go's `ruling: xarabot-rule` is a value the spine does not name. Recorded as deferred `4.6-d1` for the Maintainer.
  - `[false]` `[reject]` (intent) `dismiss` writes `coordinator.json`, so "the ledger is unchanged" fails. Maintainer decision 2 and the spine's `dismiss` line sanction the dismissal list. No unit record or retro gate changes.
  - `[false]` `[reject]` (intent) The host gates verbs need a coordinator lane. `coordinator.json` is written only as the coordinator lane (AD-3), and the edit is the same as the comment path's.
  - `[false]` `[reject]` (intent) A comment `approve` records the author's spelling. That is the GitHub login, already matched to `config.maintainer` case-insensitively, so it is the Maintainer's login.
  - `[false]` `[reject]` (intent) Rebuild clears more fields than the AC names. That is Story 2.5b's `applyRuling`, which this Story reuses, and the AC's fields are all cleared.
  - `[low]` `[reject]` (intent) Rebuild closes the PR before the swap. Same as the edge entry.
  - `[low]` `[reject]` (intent) A rulings-only reconcile PR is titled "retro gates for merged units". Cosmetic, and the body lists each change.
  - `[false]` `[reject]` (intent) "No agent session runs" is never asserted. Rulings are applied inside `reconcile`'s runner step, which starts no session by construction (Story 2.4).

## Design Notes

**One swap per batch.** All of a batch's effects ride the cursor swap. A refused swap leaves the cursor where it was, so the next run judges the same comments against a fresh snapshot, where a record that moved is refused with its reason. Judging in sequence keeps a batch from refusing itself, for example the same `release` twice.

**Why gates rulings wait in a list.** `retro-gates.yaml` lives on `main`, and only `reconcile`'s PR writes it. The pending entry carries the ruling across a PR that never opens, closes or fails, and across a run that dies. The supersede key keeps a later ruling from being undone by an earlier one, so every entry eventually shows on `main` or is dropped.

**The host `ruling` id.** A host go has no comment. It records `ruling: xarabot-rule`, in the style of `maintainer-pr`; the spine names only a comment id and `maintainer-pr`.

Example pending entry and the resulting go:

```json
{"verb": "go", "unit": "checkpoint:4", "by": "edanisko", "at": "2026-10-27T09:00:00Z", "ruling": "1234567"}
```
```yaml
    checkpoint:
      go:
        by: "edanisko"
        at: "2026-10-27T09:00:00Z"
        ruling: "1234567"
```

## Verification

**Commands:**
- `bun test` -- expected: all pass
- `bun --bun oxlint` -- expected: no errors
- `bun --bun tsc` -- expected: no errors

## Auto Run Result

Status: done

**Summary:** Each `/xarabot <verb> <unit-id>` ruling now makes its defined change, and `xarabot rule` applies every verb with the same edit.
- **Ledger verbs:** `approve` releases a parked needs-approval Story with `approval` = {the Maintainer, the manifest's sha on `main`}; a later manifest change voids it in `next`. `release` and `rebuild` apply Story 2.5b's `applyRuling`, and `rebuild` closes the open PR first; a failed close refuses that ruling.
- **Gates verbs:** `go`, `block`, `unblock`, `done` and `defer` become pending entries in `coordinator.json` (Maintainer decision 1). Every `reconcile` run writes them into `retro-gates.yaml` in its PR, and drops each one once `main` shows it. It never drops one while `main`'s graph does not resolve.
- **`dismiss`:** stores {unit, subject, since} in `coordinator.json` (Maintainer decision 2). The digest leaves the item out until it comes back as a new instance.
- **One swap per batch:** a batch is judged in order against a view with the pending entries applied, and all its effects ride the rulings cursor swap, landing whole or not at all. The inbox renders from the final view.
- **Not changed:** no ledger schema bump, no change to `next`, the gates, the due rule or the write check, and no agent session.

**Files changed:**
- `src/core/schemas/ledger.ts` -- `PendingRulingSchema`, `DismissalSchema`, `pendingKey`, and the two optional lists on `coordinator.json`.
- `src/core/ledger/codec.ts` -- writes the lists only when non-empty.
- `src/core/ledger/edits.ts` -- `recordRulings`, `allOf`, `changeRulingLists`, `applyRuling`'s `approver`; coordinator edits keep the lists.
- `src/core/rulings/effects.ts` (new) -- batch judging, effects, views, drops and the batch edit.
- `src/core/rulings/rulings.ts` -- `approve` needs the manifest; `manifestOf`; bootstrapped checkpoints count as listed.
- `src/core/reconcile/retro-gates-edit.ts` -- `applyPendingRulings`; `editRetroGates` takes rulings.
- `src/core/reconcile/plan.ts` -- `planRetroGates`; `planReconcile` takes the pending list, and an empty summary is `none`.
- `src/core/inbox/render-digest.ts` -- `inboxInstance`; dismissed items are left out.
- `src/lane/rulings-step.ts` -- judge the batch, close the rebuild PRs, one commit, then the replies.
- `src/lane/reconcile-step.ts` -- the batch swap, the drop-only swap, re-planning the gates after the rulings step, and the inbox from the final view.
- `src/lane/rule.ts`, `src/cli/rule.ts` -- all nine verbs (`applyHostVerb`).
- Tests: `test/core/rulings/effects.test.ts` (new), plus the rulings, edits, codec, retro-gates-edit, plan, render-digest, write-check, rulings-step, reconcile-step, rule and CLI tests.

**Review:** 38 findings from 4 layers (high 0, medium 2, low 29, false 7).
- **Patched** (12 entries: medium 1, low 11):
  - pending entries kept while the graph does not resolve (medium);
  - the rebuild view clears the same fields as `applyRuling`;
  - a bootstrapped checkpoint can be dismissed;
  - derived verb lists and a shared `bodyOf`;
  - `reported()` switches on the verb;
  - a note for the re-planned gates kind;
  - a doc typo;
  - two-edit `allOf` tests;
  - a throwing-judge test;
  - step tests for the pending inbox view and for the batch swap's drops.
- **Deferred:** `4.6-d1` (medium). A host go records `ruling: xarabot-rule`, a value the spine does not name; the Maintainer should confirm it or name another.
- **Rejected:**
  - stale judgements after a failed rebuild close;
  - a whole-batch refusal on one stale effect (the spec's design);
  - the drop-only swap not fenced;
  - dismissal growth and the old-build `invalid` read (both follow the Maintainer's decisions);
  - pure-code throw guards;
  - two inbox items for one unit;
  - closing before the swap;
  - the inbox running ahead of the gates;
  - the reconcile PR title;
  - a blank line;
  - stale spec line numbers.
- **False:** the spec date; gates via `main`; dismiss and the ledger; host gates verbs needing the coordinator lane; the approver's spelling; rebuild's extra fields; the no-agent-session assertion.

**Follow-up review recommended:** false. One medium and no high were patched.

**Verification:**
- `bun test`: 6191 pass, 390 skip, 0 fail.
- `bun --bun oxlint`: exit 0.
- `bun --bun tsc`: exit 0.
- Every I/O matrix row is covered by a test that ran and passed.
- A diff scan finds no token-shaped literals.

**Residual risks:**
- `4.6-d1`: the host go's `ruling` value awaits the Maintainer.
- Dismissals of items that never come back stay in `coordinator.json` (Maintainer decision 2), and `subject` is not capped.
- A runner without Story 4.6 reads a `coordinator.json` holding the new lists as invalid. Every lane's pin must advance together at the tag carrying ledger v6, and Stories 4.5 and 4.6 should ship in one tag.
- A failed rebuild close can wrongly refuse a later ruling on the same unit in the same batch; re-posting recovers.
- Not committed: the run's instructions leave the changes in the working tree for the runner.
