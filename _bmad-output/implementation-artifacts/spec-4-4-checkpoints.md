---
title: 'Story 4.4: Checkpoints'
type: 'feature'
created: '2026-10-26'
baseline_revision: 'deeddb71448314d9fefde540813ac8707c0d2ef3'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `checkpoint: true` in `.xarabot/epics.yaml` holds nothing today. `epicHolds` knows dependency, rejected-retro and retro-item holds, but no checkpoint hold. So once checkpoint Epic C's Stories are done and its retro is recorded, every Epic depending on C starts with no Maintainer go. The digest lists a waiting go only when C's retro is recorded, so a bootstrapped checkpoint Epic never shows its go (FR5, AR12, AR13, AR14).

**Approach:**
- Add a `checkpoint` hold to the pure `epicHolds`. `next`, the builder's idle reason and the `waiting-on-maintainer:` journal prefix then follow from the code that already exists.
- Let the digest list a bootstrapped checkpoint's go, since a bootstrapped Epic counts as retro done.
- Prove each Story AC with case tables. The graph-change gate's refusal of a checkpoint retired with no go is already built (Story 2.8), so add only the case table rows the AC names.

## Boundaries & Constraints

**Always:**
- Checkpoint Epic C is an Epic in `graph.checkpoints`. Its go is recorded when `retro_gates.epics[C].checkpoint` exists. Its retro is done when `retro_gates.epics[C].retro` exists, or when C is in `bootstrapped_epics`.
- A checkpoint C with no recorded go holds every Epic that reaches C along dependency edges, at distance 1 or more, with one reason per held Epic: `{ subject: "epic:<N>", code: "checkpoint", message }` (AD-12). C itself, and Epics that do not reach C, are never held by it.
  - When C's retro is done, the message is `Epic <N> is held by checkpoint Epic <C> (checkpoint:<C>), which has no go`, and the reason carries `maintainer: true`.
  - Before C's retro is done, the message is `Epic <N> is held by checkpoint Epic <C> (checkpoint:<C>), whose retro is not done`, with no `maintainer` flag, because the go is not yet due.
  - An Epic whose every Story is `done` is never held by a checkpoint: it has nothing left to hold.
- Epic N's `dependency-epic` reason on Epic X is a Maintainer cause when X still has a Story not `done` and X itself carries a Maintainer-cause hold (`checkpoint` with its go due, `retro-rejected`, or a Maintainer-routed `retro-item`). X's Stories wait on the Maintainer, so N's wait on X does too. So in the chain, a lane idle only for C's go records `waiting-on-maintainer: ` (AC 1).
- A recorded go releases the hold. A checkpoint no longer in the graph holds nothing, and its go record is left in `retro-gates.yaml`.
- Gates read only the snapshot, so a checkpoint added after C's retro holds from the next `next` call. A held Epic takes no new Stories, but its stale `claimed` Story and its builder-held `merging` Story are still taken over (Story 4.1's deferral). An Epic not depending on C keeps running.
- The Maintainer's digest lists `checkpoint:<C>` once when C's retro is done and no go is recorded. A recorded retro keeps its current line and age. A bootstrapped C with no retro record reads `Epic <C> is bootstrapped`, has no age, and keeps the verb `/xarabot go checkpoint:<C>`.
- No `checkpoint` unit ever runs. `checkpoint:<C>` is only a `go` target.

**Never:**
- No ruling parser and no applying of `go` (Stories 4.5/4.6), and no edit to `retro-gates.yaml` from code here.
- No change to the graph gate's behaviour, the write check, schemas, `.github/`, docs, or any epic context file.
- No change outside the manifest globs: `src/core/{next,graph,inbox,reconcile}/**`, `src/lane/**` and their tests.
- No mocks in the core case tables, and no token-shaped literals.

## I/O & Edge-Case Matrix

Chain 1 → 2 → 3 → 4, and Epic 5 depends on nothing. Epic 2 is a checkpoint, its Story is `done`, and its retro is recorded, unless a row says otherwise.

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| No go | no `checkpoint` record for 2 | Epics 3 (d1) and 4 (d2) held, `checkpoint`, maintainer; Epic 5 picked | — |
| Only held | Epic 5 done too | `idle` with reason `waiting-on-maintainer: Epic 3 is held by checkpoint Epic 2 …` | — |
| Go recorded | `checkpoint.go` for 2 | Story 3.1 picked; no `checkpoint` reason | — |
| In flight | fresh `claimed` 3.1, 3.2 free | 3.2 not picked; 3.1's record unchanged | — |
| Stale in flight | stale `claimed` or builder `merging` 3.2 | 3.2 taken over, hold among the reasons | — |
| Late checkpoint | same retro, first without and then with `checkpoint: true` | first call picks 3.1, second holds 3 and 4 | — |
| Retro not done | 2's retro not recorded | 3 and 4 held by `checkpoint`, not maintainer, alongside the dependency hold | — |
| Bootstrapped C | 2 bootstrapped, no retro record | 3 and 4 held, maintainer; digest lists `checkpoint:2 · Epic 2 is bootstrapped` | — |
| Retired | `checkpoint: true` removed, go kept | nothing held; the go stays in `retro-gates.yaml` | — |
| Retired without go | PR removes `checkpoint: true`, no go | graph gate refuses: `Epic 2's checkpoint is removed, but its go is not recorded` | parks `blocked` `graph-invalid` (existing merge step) |
| Digest | retro done, no go / go recorded | lists `checkpoint:2` with `/xarabot go checkpoint:2` / lists nothing for 2 | — |
| No unit | coordinator `next` | never returns a `checkpoint` unit | — |

</intent-contract>

## Code Map

- `src/core/next/epic-gates.ts:9-107` -- `epicHolds`. `distance` (:44) and the per-source loop (:89-104) are the pattern to follow. `graph.checkpoints`, `bootstrapped` and `snap.retro_gates.epics[..].checkpoint` are already in scope. Add the checkpoint sources and the hold, and update the module doc (:9-24).
- `src/core/next/reasons.ts:7-20` -- add `"checkpoint"` to `ReasonCode`. Nothing switches over it exhaustively.
- `src/core/next/next.ts:66-77,141-167,216-221` -- `nextBuilder` already skips a held Epic's new Stories, still yields takeovers, and adds the `waiting-on-maintainer: ` prefix when every reason is a Maintainer cause. Doc only: add checkpoint to the list of holds at :74.
- `src/core/next/coordinator.ts:23,31,223,374-381` -- no checkpoint unit runs (`CoordinatorKind` excludes it). `epicHolds` also gates status planning's Epic contexts, so a held Epic is not due for one. Read-only.
- `src/core/inbox/render-digest.ts:13-14,163-177` -- the checkpoint item. Widen the condition to "retro recorded or bootstrapped", and give the bootstrapped line and no `since`. Update the doc.
- `src/core/graph/graph-gate.ts:166-190,301-308` -- the delta's `holds` (the same reach rule) and refusal 4. Read-only.
- `src/lane/merge-step.ts:276-283` -- a refusal parks `blocked` `graph-invalid`. Read-only, already tested at `test/lane/merge-step.test.ts:360`.
- Tests:
  - `test/core/next/fixtures.ts:31-154` -- `World` and `retroGates`. Add `checkpointGo?: readonly number[]`, which writes `checkpoint: go: {by, at, ruling: maintainer-pr}` for each listed Epic.
  - `test/core/next/next.test.ts:187-420` -- the shape of the retro-item gate tables and the takeover `describe`.
  - `test/core/inbox/render-digest.test.ts:78,130-165` -- `CHECKPOINTS`, and the existing checkpoint lines for Epic 2 (no go) and Epic 3 (go).
  - `test/core/graph/graph-gate.test.ts:251-262` -- the retire-with-no-go case.

## Tasks & Acceptance

**Execution:**
- `src/core/next/reasons.ts` -- add the `checkpoint` reason code -- so the hold has its own code.
- `src/core/next/epic-gates.ts` -- the checkpoint hold as the Boundaries define it, and the doc -- AC 1, 3 and 4.
- `src/core/next/next.ts` -- doc line only.
- `src/core/inbox/render-digest.ts` -- list a bootstrapped checkpoint's go, and the doc -- AC 2.
- `test/core/next/fixtures.ts` -- `checkpointGo`.
- `test/core/next/checkpoints.test.ts` (new) -- one case table over the I/O matrix rows for `next` (builder and coordinator), the idle reasons and the `maintainer` flags. It also has digest rows for "retro done, no go", "go recorded" and "bootstrapped", and graph-gate rows for "retired without go" (refused) and "retired with go" (allowed). The last row checks that the go record is still in the merge result's `retroGates`.
- `test/core/inbox/render-digest.test.ts` -- a bootstrapped checkpoint row.

**Acceptance Criteria:**
- Given checkpoint Epic C with its retro done and no go, when a builder's `next` runs, then no Epic reaching C takes a new Story, an Epic not reaching C is picked, and a lane idle only for it gets an idle reason starting `waiting-on-maintainer: `.
- Given the same state, when the Maintainer's digest renders, then it lists `checkpoint:<C>` once with `/xarabot go checkpoint:<C>`, and coordinator `next` returns no `checkpoint` unit.
- Given `checkpoint: true` added after C's retro, when `next` next runs, then C's dependents are held until the go.
- Given a go recorded for C, when `next` runs, then C's dependents are eligible and the digest no longer lists C.
- Given a PR that removes `checkpoint: true` from C, when C has no recorded go, then the graph gate refuses it. With a go recorded it is allowed, and the go record stays.

## Spec Change Log

- 2026-10-26, review revision: AC 1 and the "Only held" row failed on any chain deeper than one Epic. Epic 4's `dependency-epic` reason on Epic 3 was a lane cause, so the every-reason rule never added the `waiting-on-maintainer: ` prefix. A dependency reason on an Epic that is itself held by a Maintainer cause, and still has a Story not `done`, is now a Maintainer cause too. The "Only held" row is tested on the full chain. An Epic whose every Story is `done` is no longer held by a checkpoint, so a lane with nothing left reports `no Story left to build`.

## Review Triage Log

### 2026-10-26 — Review pass
- verdicts: 19 findings — high 0, medium 0, low 16, false 3, maybe-false 0
- findings:
  - `[low]` `[patch]` (verification) The `planningDue` doc in `src/core/next/coordinator.ts` lists only the dependency, retro-rejected and retro-item holds as keeping an Epic's context back — added `checkpoint` to the list (doc only).
  - `[low]` `[reject]` (edge) An Epic whose Stories are all `done` still gets a checkpoint reason, so a lane with nothing left can idle as `waiting-on-maintainer` — this is real but rare: it needs a checkpoint added after its dependents finished. The dependency, retro-rejected and retro-item holds already behave this way for a finished Epic. The fix adds a done-Epic guard to every hold.
  - `[false]` `[reject]` (edge) The digest lists the go of a checkpoint that no Epic depends on, so the go releases nothing — AC 2 lists the go whenever C's retro is done and no go is recorded, whatever depends on C. A go recorded early also releases any Epic appended later that depends on C.
  - `[false]` `[reject]` (intent) Holding before C's retro is done (reading A2) changes the pick at distance 2 or more, when the Epic in between is done or bootstrapped — this is the Boundaries' rule ("whether or not C's retro is done") and AD-12's wording. The Design Note names this case ("an edge added later past an Epic already done"). The hold is not a Maintainer cause until the go is due.
  - `[false]` `[reject]` (intent) A bootstrapped checkpoint holding its dependents (reading B2) goes beyond the AC text — AD-12 counts a bootstrapped Epic as retro done, and the Boundaries settle it. The digest lists its go, so the hold is visible.
  - `[low]` `[reject]` (intent) No lane-level test shows a Story in flight finishing after its Epic becomes held — no defect. Lane code calls `next` only to pick work and never re-checks Epic holds after a claim (`epicHolds` is called only from `next.ts` and `coordinator.ts`). Story 4.1's takeover tests already pin the selection side.
  - `[low]` `[reject]` (intent) A late checkpoint is tested on two snapshots, not through a graph PR merging while a Story is claimed — no defect. Gates read only the snapshot, and the graph PR path is Story 2.8's, which is already tested.
  - `[low]` `[patch]` (intent) AC 5 is tested only on the pure refusal: the merge-step park is generic, and the "go record stays" test holds by construction — the merge step parks every refusal alike (`test/lane/merge-step.test.ts:360`). The go-stays test now runs reconcile's real `editRetroGates` rewrite on a file that holds Epic 2's `checkpoint.go`, and asserts that the go is unchanged.
  - `[low]` `[patch]` (intent) AC 2's "no unit runs" coordinator rows assert only `idle` — removed the four rows. A comment points at the existing `test/core/next/coordinator.test.ts` case "a checkpoint record with its PR open is never a coordinator unit". `CoordinatorKind` excludes `checkpoint`.
  - `[low]` `[reject]` (blind) The "go is due" rule is written in both `epic-gates.ts` and `render-digest.ts` — both read "retro recorded or bootstrapped, no go" today, and tests pin both sides on the same worlds. A shared exported helper adds public surface. These two modules already restate the open-item rule the same way.
  - `[low]` `[reject]` (blind) The reach rule has two implementations, with no diamond, two-checkpoint or bootstrapped-intermediate test — the hold uses the same `distance` search as the retro-item gate, which has diamond rows in `next.test.ts`. Reading the code: there is one reason per source Epic, and a bootstrapped Epic in between does not cut the path, the same as `graph-gate.ts` `holds()`.
  - `[low]` `[patch]` (blind) No case for a checkpoint whose own retro is `rejected` — added a builder row (both `checkpoint` and `retro-rejected` on Epics 3 and 4, as Maintainer causes) and a digest row (`go checkpoint:2` and `go retro:2` both listed).
  - `[low]` `[reject]` (blind) A finished Epic still gets a hold reason — the same as the edge-layer finding on finished Epics, rejected for the same reason.
  - `[low]` `[patch]` (blind) The "go record stays" test cannot fail — same root cause as the intent-layer AC 5 finding, fixed by the same test.
  - `[low]` `[patch]` (blind) The four coordinator rows prove little — same root cause as the intent-layer AC 2 finding, fixed by the same deletion.
  - `[low]` `[patch]` (blind) The fixture writes `checkpoint` before `items`, unlike `serializeRetroGates` — moved the `checkpoint` lines after `items`.
  - `[low]` `[patch]` (blind) `maintainerItems` builds the bootstrapped set twice — it is now built once.
  - `[low]` `[patch]` (blind) The new doc comments in `render-digest.ts` and `epic-gates.ts` read badly — rewrote both as plain sentences with the same meaning.
  - `[low]` `[reject]` (blind) The bootstrapped-checkpoint rows in `render-digest.test.ts` repeat rows of `checkpoints.test.ts` — the spec's tasks put a row in the digest's own table and the end-to-end rows in the new file, and the overlap costs nothing.

## Design Notes

**Why the hold does not wait for C's retro.** AD-12 holds C's dependents "until the Maintainer's go is recorded", and the graph gate's delta already reports every checkpoint without a go as holding every Epic that reaches it. Before C's retro is done, the dependency hold already stops C's direct dependents, so holding them by checkpoint too changes no pick. It also covers an edge added later past an Epic already done. The reason is a Maintainer cause only once the go is due, so a lane waiting on C's own Stories is not reported as waiting on the Maintainer.

**Bootstrapped C.** A bootstrapped Epic counts as Stories done and retro done (AD-12). If such an Epic is a checkpoint (Xaravel's Epic 8 at adoption), it holds its dependents. Its go must therefore be in the inbox, or nobody would see the hold.

## Verification

**Commands:**
- `bun test` -- expected: all pass
- `bun --bun oxlint` -- expected: no errors
- `bun --bun tsc` -- expected: no errors

## Auto Run Result

Status: done

**Summary:** A checkpoint Epic now holds the Epics that depend on it until the Maintainer's go is recorded (FR5, AR12, AR13, AD-12):
- **Hold:** `epicHolds` adds a `checkpoint` reason to every Epic that reaches a checkpoint Epic C with no recorded go. Once C's retro is done (recorded, or C bootstrapped), the reason is a Maintainer cause, so a builder idle only for it records `waiting-on-maintainer: `. Before that, the hold is not a Maintainer cause.
- **What the hold changes in `next`:** a held Epic takes no new Stories. Its stale `claimed` Story and its builder-held `merging` Story are still taken over. Epics that do not reach C keep running. A recorded go releases the hold, and so does retiring the checkpoint. A checkpoint added late holds from the next `next` call. A held Epic's missing context is not due for status planning.
- **Digest:** the Maintainer's digest also lists a bootstrapped checkpoint's go, as `Epic <C> is bootstrapped` with no age. A checkpoint with a recorded retro keeps its existing line.
- **Retiring a checkpoint:** no new code. The graph gate already refuses retiring a checkpoint with no go (Story 2.8). The new case table pins that refusal, and pins that reconcile's rewrite keeps a retired checkpoint's go.

**Files changed:**
- `src/core/next/epic-gates.ts` -- the checkpoint hold and its `maintainer` rule; module doc.
- `src/core/next/reasons.ts` -- the `checkpoint` reason code.
- `src/core/next/next.ts`, `src/core/next/coordinator.ts` -- doc only.
- `src/core/inbox/render-digest.ts` -- a bootstrapped checkpoint's go is listed; the bootstrapped set is built once; module doc.
- `test/core/next/checkpoints.test.ts` (new) -- case tables:
  - builder `next`: distances 1 and 2, the sibling Epic, in flight, stale takeovers, late checkpoint, retro not done, bootstrapped C, rejected C, retired, and only held;
  - `planningDue`;
  - the digest;
  - the graph gate's retire rows;
  - the go surviving reconcile's rewrite.
- `test/core/next/fixtures.ts` -- `World.checkpointGo`.
- `test/core/inbox/render-digest.test.ts` -- bootstrapped checkpoint rows.

**Review:** 19 findings from 4 layers (high 0, medium 0, low 16, false 3).
- Patched: 9 low rows, which share 7 root causes:
  - the `planningDue` doc;
  - a go-stays test that now runs reconcile's real rewrite;
  - the weak coordinator rows, removed in favour of the existing coordinator test;
  - rejected-checkpoint builder and digest rows;
  - the fixture's key order;
  - the bootstrapped set built once;
  - doc rewording.
- Deferred: 0.
- Rejected lows:
  - a finished Epic still gets a hold reason (rare; every Epic hold behaves this way);
  - no lane-level in-flight test (lanes never re-check holds after a claim);
  - no late checkpoint through a graph PR (gates read only the snapshot);
  - the due rule is written in two modules (a shared helper adds public surface);
  - no reach-rule diamond rows (the same `distance` search already has them);
  - duplicate digest rows.
- False:
  - the go of a checkpoint nothing depends on is listed (AC 2 lists it);
  - holding before C's retro (the Boundaries and AD-12);
  - a bootstrapped C holds (AD-12, Boundaries).

**Follow-up review recommended:** false. Only low entries were patched: 7 low, 0 medium, 0 high.

**Verification:**
- `bun test`: 5808 pass, 373 skip, 0 fail.
- `bun --bun oxlint`: exit 0.
- `bun --bun tsc`: exit 0.
- `test/core/next/checkpoints.test.ts`: 29 pass.
- A diff scan finds no token-shaped literals.

**Matrix audit:** every I/O matrix row has a test that ran and passed, the "Only held" row on the full chain 1 → 2 → 3 → 4 (see the Spec Change Log).

**Residual risks:**
- A bootstrapped checkpoint Epic now holds its dependents until its go. Xarabot's own repo has no checkpoint today.
- No code applies a `go checkpoint:<C>` ruling yet. Until Story 4.6 merges, a go is written by hand in a Maintainer PR with `ruling: maintainer-pr`.
