---
title: 'Story 4.3: Batch routing of Maintainer-only retro items'
type: 'feature'
created: '2026-10-26'
status: 'done'
baseline_revision: 'ce3e18393a1beba7bde8af38b5affdb12fa9428c'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** When `reconcile` records a merged retro, it appends every item as `open`, including the items routed to the Maintainer. The digest's routed-item line does not name the item's Epic. Nothing in `reconcile`'s code can set an item `deferred`, and it sets `done` only for a merged `retro-item:` unit (FR9, AR13, AR14, AR24).

**Approach:**
- In the same pure `retro-gates.yaml` edit that records a retro, write each new `route: maintainer` item as `waiting` instead of `open`. That edit is part of `reconcile`'s runner-written PR.
- Add the Epic to the digest's routed-item line.
- Add a pure item-status edit for a ruled `done` or `defer`, which Story 4.6's rulings call.
- Prove each Story AC end to end with case tables.

## Boundaries & Constraints

**Always:**
- `applyRetroResults` appends a new item with `status: waiting` when `route: maintainer`, and with `status: open` when `route: lane`. Its summary line says `added as waiting` or `added as open`. Items already listed keep their status. The verdict, `recorded_at` and ordering stay unchanged.
- Each open (`open`, `in-progress` or `waiting`) `route: maintainer` item is one item of the Maintainer's digest, with one line: `- [retro-item:<id>](<gates url>) · Epic <N> · <status>[, blocking]: <text> · <age> · \`/xarabot done|defer retro-item:<id>\``. The age is counted from the Epic's `retro.recorded_at`, and there is no age when the Epic has no retro record. A rejected retro's course-correction lines under the retro's own item stay as they are, and they do not add to the count.
- `next(snapshot, 'coordinator')` returns only `route: lane` `open` items as `retro-item` units. This is already true, and the case tables pin it for a `waiting` and an `open` Maintainer item.
- The new pure edit `applyItemStatuses(gates, [{epic, id, status: "done" | "deferred"}])`:
  - sets each listed item that is not already `done` to the given status, so `deferred` → `done` is allowed and an item already `done` stays `done`;
  - ignores an item already at the given status, an unknown id and an unknown Epic;
  - writes one summary line per change: `epics.<N>.items: <id> <old> -> <new>`.
- `applyItemsDone` becomes `applyItemStatuses` with `done`. `editRetroGates` takes the ruled statuses as an optional parameter, after the merged-unit `done` list, and applies them last.
- A `done` or `deferred` item leaves the digest and holds no Epic in `epicHolds`. This already follows from `CLOSED_ITEM`, and a test pins it on the edited file.

**Never:**
- No ruling parser, cursor, 🤖 reply, or wiring of `/xarabot done|defer` or of `xarabot rule` (Stories 4.5/4.6).
- No rewrite of items already in `retro-gates.yaml`: Epic 3's existing `open` Maintainer items stay `open`.
- No agent session, no `.github/` change, no hand edit of `retro-gates.yaml` or any epic context file.
- No change outside the manifest globs: `src/core/{inbox,reconcile,next,graph}/**`, `src/lane/**` and their tests.
- No mocks in the core case tables, and no token-shaped literals.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Mixed retro | merged retro:2 result: lane item A, Maintainer item B | A `open`, B `waiting`; summary `B added as waiting`; one reconcile PR | — |
| Already listed | B already listed `open` before the retro is recorded | B keeps `open` | — |
| Digest | B `waiting`, retro recorded 3 days ago | one Maintainer item: `retro-item:B · Epic 2 · waiting: … · 3d · done\|defer verb` | — |
| Coordinator next | only B (waiting or open, Maintainer) | no `retro-item` unit | — |
| Ruled done | `{2, B, done}` on a `waiting` B | B `done`; leaves the digest; holds nothing | — |
| Ruled defer | `{2, B, deferred}` | B `deferred`; leaves the digest; holds nothing | — |
| Done stays | `{2, C, deferred}` on a `done` C | unchanged, no summary | — |
| Unknown | an unknown id or Epic | unchanged, no summary | — |

</intent-contract>

## Code Map

- `src/core/reconcile/retro-gates-edit.ts:33-55,63-86,180-202`:
  - `applyItemsDone`: generalize to `applyItemStatuses` and keep `applyItemsDone` as its `done` wrapper.
  - `applyRetroResults` :80: the status by route, and the summary text :85.
  - `editRetroGates`: a new optional `statuses` parameter. Update the module doc.
- `src/core/reconcile/plan.ts:294-310,400-406`: `itemsDone` and the `editRetroGates` call. No change in behaviour; Story 4.6 passes the ruled statuses through here.
- `src/core/inbox/render-digest.ts:175-200`: the routed-item `what` gains `Epic <N> · `. Update the module doc :13-20.
- `src/core/next/coordinator.ts:656-672`: `retroItemCandidates`, already filtered to `route === "lane"` and `open`. Doc only, if needed.
- `src/core/next/epic-gates.ts:6,96-103`: `CLOSED_ITEM` and the `maintainer` flag. Read-only.
- `src/lane/reconcile-step.ts:1083-1121`: puts the edit's summary in the reconcile PR body. Read-only. Its test `test/lane/reconcile-step.test.ts:2416-2455` expects the Maintainer item to be `open`; change it to `waiting` and assert `added as waiting` in the PR body.
- Tests:
  - `test/core/reconcile/retro-gates-edit.test.ts:60-90,116-160`;
  - `test/core/reconcile/plan.test.ts:550-560,715`, the summary lines;
  - `test/core/inbox/render-digest.test.ts:130-160`, the routed line;
  - `test/core/next/coordinator.test.ts:1018-1030,1092`, the retro-item table;
  - `test/core/next/fixtures.ts`: `snapshotOf`, `World.files`, `RETRO`, `itemId`.

## Tasks & Acceptance

**Execution:**
- `src/core/reconcile/retro-gates-edit.ts` -- the route-based initial status, `RetroItemStatus`, `applyItemStatuses`, the `applyItemsDone` wrapper, the `statuses` parameter of `editRetroGates`, and the docs -- AC 1 and AC 4's edit.
- `src/core/inbox/render-digest.ts` -- the Epic in the routed line, and the doc -- AC 2.
- `test/core/reconcile/retro-gates-edit.test.ts` -- rows for a mixed lane/Maintainer retro, an already-listed item, and `applyItemStatuses` (each matrix row on statuses), plus `editRetroGates` with statuses.
- `test/core/reconcile/plan.test.ts`, `test/lane/reconcile-step.test.ts` -- `waiting` and `added as waiting` for Maintainer items, in the plan and in the reconcile PR.
- `test/core/inbox/render-digest.test.ts` -- the new line, including a `waiting` item.
- `test/core/next/coordinator.test.ts` -- a `waiting` Maintainer item row, if one is missing.
- `test/core/reconcile/maintainer-routing.test.ts` (new) -- one end-to-end case table over a retro with lane and Maintainer items:
  - `editRetroGates` writes the file;
  - `snapshotOf` over it: the digest lists each Maintainer item once with its id, text, Epic and age;
  - `next(…, 'coordinator')` returns only the lane item;
  - after `applyItemStatuses` `done` or `deferred`, the item leaves the digest and `epicHolds` no longer names it.

**Acceptance Criteria:**
- Given a merged retro whose result has Maintainer and lane items, when `reconcile` runs on the fake forge, then its one runner-written PR writes the Maintainer items `waiting` and the lane items `open`, and no session runs.
- Given that file on `main`, when the digest renders, then the Maintainer's inbox lists each routed item exactly once, with its id, text, `Epic <N>` and age.
- Given that file, when `next(snapshot, 'coordinator')` runs, then no routed item is returned as a `retro-item` unit.
- Given a ruled `done` or `defer` on a routed item, when `editRetroGates` applies it, then its status is `done` or `deferred`, the next digest omits it, and the gates stop counting it as open.

## Spec Change Log

## Review Triage Log

### 2026-10-26 — Review pass
- verdicts: 23 findings — high 0, medium 0, low 15, false 8, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) `applyItemStatuses` silently drops a ruling that does not apply (unknown id or Epic, a `done` item, same status) and does not report it — no caller passes rulings yet. Story 4.5 validates a ruling's target and replies with the reason before applying it. Returning a `skipped` list adds public surface for a caller that does not exist yet.
  - `[low]` `[reject]` (blind) `RetroItemStatusChange` carries both `epic` and `id`, which can disagree — it matches the existing `RetroItemDone` shape. A mismatch acts like an unknown Epic and changes nothing. Deriving or checking the Epic adds parsing for a caller (Story 4.6) that builds the change from a parsed unit id.
  - `[false]` `[reject]` (blind) Nothing checks the route, so a ruling can close a lane item, even one under a live claim — AR29 and Story 4.5 apply `done`/`defer` to any `retro-item:<id>` with no route restriction. `in-progress` is never written in 0.x, and a later merge of the lane unit setting `deferred` → `done` is Story 2.10's existing behaviour.
  - `[low]` `[reject]` (blind) `planReconcile`'s guard `additions.length > 0 || done.length > 0` will skip a run that has only rulings once Story 4.6 passes `statuses` — no caller passes `statuses` today. Story 4.6 changes that call and its guard together, and nothing in this change is wrong.
  - `[false]` `[reject]` (blind) Conflicting rulings in one batch depend on input order — the result is the rulings applied one at a time in order, which is how a ruling cursor delivers them. Defer then done ends `done` with two real transitions. Done then defer ends `done`, because `done` is final. Each summary line records a change that happened.
  - `[false]` `[reject]` (blind) AC 1's "no session" is asserted only through the PR body text — `createReconcileStep`'s deps hold no `Agent` (`agent` is a vendor-name string), so the step cannot start a session. The coordinator-process tests already pin `sessions: []` for reconcile runs (`test/lane/reconcile-step.test.ts:2262`).
  - `[low]` `[patch]` (blind) No test covers a rejected retro with a `waiting` Maintainer item, and the "no age" case does not assert `count` — added a rejected-retro case: one routed-item line, the course-correction sub-line, the count. Added the `count` assertion to the "no age" case.
  - `[low]` `[patch]` (blind) The `heldBy` helper in the e2e test drops the `maintainer: true` flag — the test now asserts that the holds from B and C carry `maintainer: true` and the hold from A does not.
  - `[low]` `[patch]` (blind) The test helper `retroItemUnit(gates)` shadows the exported `retroItemUnit(id)` — renamed it to `coordinatorRetroItemUnit`.
  - `[low]` `[patch]` (blind) The name `RetroItemStatus` reads like the full status enum — renamed it to `RuledItemStatus`.
  - `[low]` `[patch]` (blind) Doc comments: the `applyRetroResults` summary format is wrong, and the `render-digest.ts` module doc is ragged — fixed the summary format and reflowed the paragraph.
  - `[low]` `[patch]` (blind) The digest mixes `open` and `waiting` Maintainer items with no explanation — the `render-digest.ts` doc now says they list alike, and that items recorded before Story 4.3 stay `open`.
  - `[false]` `[reject]` (edge) A ruling on an `in-progress` `route: lane` item flips it under a live claim — same as the blind-layer route finding: AR29 does not restrict by route, and `in-progress` is never written in 0.x.
  - `[low]` `[reject]` (edge) A ruling that does not apply cannot be told apart from one that does — same as the blind-layer silent-drop finding.
  - `[low]` `[reject]` (edge) `editRetroGates` with only no-op statuses rewrites the file with an empty summary — no caller passes only statuses. `planReconcile` calls the edit only when there are additions or items done, and both always change the file. Story 4.6 owns the rulings-only call.
  - `[false]` `[reject]` (edge) Two rulings on one item in one batch give an order-dependent result — same as the blind-layer ordering finding: sequential application is the defined meaning.
  - `[false]` `[reject]` (edge) A rejected retro lists a routed item twice — the `course correction:` line is a sub-line of the `retro:N` item, which Story 4.2 requires ("rejected retros with their course-correction item"). It is not a second inbox item, and the count lists the routed item once. The new rejected-retro case pins this.
  - `[false]` `[reject]` (intent) AC 4 cannot be reached through a `reconcile` run (reading R2) — its trigger is a ruling, which needs Story 4.5's parser and cursor and Story 4.6's application. The epic's dependency order puts 4.6 after 4.3. This Story supplies the edit the ruling lands in and proves its effect on the inbox and the gates, and Story 4.6's own AC repeats the wiring.
  - `[low]` `[reject]` (intent) Maintainer items already on `main` stay `open` (reading R4) — AC 1 is about the retro that `reconcile` is writing. `open` and `waiting` gate and list alike, and rewriting records this run did not create would change items with no ruling behind them. The doc note added above explains the mix.
  - `[low]` `[patch]` (intent) "Once" is not tested for a rejected retro — same root cause as the blind-layer rejected-retro test gap, fixed by the same case.
  - `[false]` `[reject]` (intent) "No agent session" is shown only by a string — same as the blind-layer entry: the reconcile step has no agent dependency.
  - `[low]` `[reject]` (intent) `deferred` → `done` is allowed, which no Story states — Story 2.10's merged-unit `done` already moves `deferred` → `done`, and the ruled path keeps the same rule, so the two cannot disagree.
  - `[low]` `[patch]` (intent) The routed line shows `open` for older items and `waiting` for new ones — same root cause as the blind-layer mixed-status entry, fixed by the same doc note.

## Design Notes

**AC 4's split with Story 4.6.** Story 4.6 parses the ruling and applies it. This Story provides the `reconcile` edit the ruling lands in (`applyItemStatuses` through `editRetroGates`) and proves its effect on the inbox and the gates. Then Story 4.6 only connects a parsed ruling to it.

**Only new items become `waiting`.** The AC is about the retro being written. Changing the status of items already on `main` would rewrite records that `reconcile` did not create in this run, so they keep their status. Both `open` and `waiting` count as open, so the gates read them the same.

## Verification

**Commands:**
- `bun test` -- expected: all pass
- `bun --bun oxlint` -- expected: no errors
- `bun --bun tsc` -- expected: no errors

## Auto Run Result

Status: done

**Summary:** `reconcile` now routes a retro's Maintainer-only items to the Maintainer in the same runner-written edit that records the retro:
- **Routing:** `applyRetroResults` writes each new `route: maintainer` item as `waiting` and each `route: lane` item as `open`, and the reconcile PR's change list says `added as waiting` or `added as open`. Items already listed keep their status.
- **Digest:** each open Maintainer item is one item of the Maintainer's inbox: its id, `Epic <N>`, its status and text, its age from the retro's `recorded_at`, and `/xarabot done|defer retro-item:<id>`.
- **`next`:** a Maintainer item, `waiting` or `open`, is never a coordinator `retro-item` unit. This already held, and case-table rows now pin it.
- **Rulings:** a new pure `applyItemStatuses` sets a ruled `done` or `deferred`. `editRetroGates` takes the ruled statuses as an optional last parameter, so Story 4.6's rulings land in it. A ruled item leaves the digest and stops holding Epics.

**Files changed:**
- `src/core/reconcile/retro-gates-edit.ts` -- the status by route; `RuledItemStatus`, `RetroItemStatusChange` and `applyItemStatuses`; `applyItemsDone` as its `done` wrapper; the `statuses` parameter of `editRetroGates`.
- `src/core/inbox/render-digest.ts` -- `Epic <N>` in the routed-item line, and the doc.
- `src/core/next/coordinator.ts` -- doc only.
- `test/core/reconcile/maintainer-routing.test.ts` (new) -- the end-to-end case table: the edit, then the digest, `next` and `epicHolds` before and after each ruling.
- `test/core/reconcile/{retro-gates-edit,plan}.test.ts`, `test/core/inbox/render-digest.test.ts`, `test/core/next/coordinator.test.ts`, `test/lane/reconcile-step.test.ts` -- new rows, and the Maintainer item now `waiting`.

**Review:** 23 findings from 4 layers (high 0, medium 0, low 15, false 8).
- Patched: 7 low entries, which share 5 root causes. Two entries are tied to blind-layer root causes; they came from the intent layer and are listed with their roots below.
  - The rejected-retro digest case, with the `count` check. The intent layer's "once" finding is the same root.
  - The `maintainer` flag in the e2e holds.
  - The test-helper rename.
  - `RuledItemStatus`.
  - Doc fixes, and a note that `open` and `waiting` list alike. The intent layer's mixed-status finding is the same root.
- Deferred: 0.
- Rejected lows:
  - silent drop of an unapplicable ruling;
  - `epic`/`id` mismatch;
  - `planReconcile`'s guard once rulings are passed;
  - a rewrite with only no-op statuses;
  - existing `open` items not rewritten;
  - `deferred` → `done`.
  All but the last concern a caller that Story 4.6 adds, or a choice the Boundaries already settle. `deferred` → `done` matches Story 2.10's merged-unit rule.
- False:
  - route not checked (AR29 has no route restriction);
  - batch order (rulings apply in sequence);
  - "no session" (the reconcile step has no agent dependency);
  - a rejected retro lists an item twice (the course-correction line is a sub-line, which Story 4.2 requires);
  - AC 4 not reachable through `reconcile` (the ruling trigger is Stories 4.5 and 4.6).

**Follow-up review recommended:** false. Only low entries were patched: 7 low, 0 medium, 0 high.

**Verification:**
- `bun test`: 5777 pass, 373 skip, 0 fail.
- `bun --bun oxlint`: exit 0.
- `bun --bun tsc`: exit 0.
- Every I/O matrix row is covered by a test that ran and passed.
- A diff scan finds no token-shaped literals.

**Residual risks:**
- No production code passes `statuses` yet. Story 4.6 wires the `done`/`defer` rulings into `planReconcile`, and its guard `additions.length > 0 || done.length > 0` must then also count the rulings.
- Epic 3's existing Maintainer items 7 and 10 stay `open` on `main`. They gate and list the same as `waiting`.
- Not committed: the run's instructions leave the changes in the working tree for the runner.
