---
title: 'Story 4.1: Retro-item distance gates'
type: 'feature'
created: '2026-10-26'
status: 'done'
baseline_revision: '797c878d82fcafe04cdf457de6b92158f25da04b'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      A stale claimed (or builder-held merging) Story in an Epic that becomes held can no longer be taken over, so it waits until the hold clears.
    evidence: |-
      src/core/next/next.ts skips a held Epic (`if (held) continue`) before takeOverOf runs. This predates Story 4.1 for dependency-epic and retro-rejected holds; 4.1 extends it to retro-item holds. AC "an already-claimed Story finishes" holds while its lane lives; whether a takeover counts as "the next claim" (held) or as finishing an in-flight Story (exempt) is a Maintainer decision, which Story 4.4's checkpoint rule ("in-flight Epics finish held Stories") will also need.
    location: >-
      src/core/next/next.ts:140
    severity: medium
---

<intent-contract>

## Intent

**Problem:** `next` gates an Epic only on its dependencies being done and on a rejected retro with no go; open retro items in `retro-gates.yaml` hold nothing, so a `blocking` item from Epic E does not stop E's dependents and an untagged one never holds Epics further downstream (FR10, AR13).

**Approach:** Extend the pure Epic hold check (`epicHolds`) with the AR13 distance rule: measure each Epic's distance from E along dependency edges; an open `blocking` item of E holds every Epic at distance ≥ 1, any other open item at distance ≥ 2, and a `rejected` retro with no go at distance ≥ 1. A held Epic takes no new Stories, and the idle reason names each holding item.

## Boundaries & Constraints

**Always:**
- Distance from E to Epic D is the length of the shortest path of dependency edges from D down to E (standard graph distance); D does not reach E means no hold. E itself (distance 0) is never held by its own retro.
- Open means status `open`, `in-progress` or `waiting`; `deferred` and `done` hold nothing. Route (`lane`/`maintainer`) does not change the gate.
- A verdict of `accepted` or `accepted-with-open-items` holds nothing by itself; its items gate by the rule above. A recorded `go` releases a rejected verdict, never its items.
- Gates stay pure: they read only the snapshot (`resolveGraph` output and `retro-gates.yaml` of one `main` SHA). Item holds apply to Epics in `bootstrapped_epics` as sources (their items still gate dependents).
- One `retro-item` reason per holding item per held Epic, subject `epic:<N>`, message naming `retro-item:<id>`, its Epic, whether it is `blocking`, and the distance.
- The change takes effect at the next claim: `next` is the only consumer; a claimed Story's record is never touched by the gate.

**Never:**
- No checkpoint gates (Story 4.4), inbox/digest (4.2), routing (4.3), rulings (4.5/4.6), or `waiting-on-maintainer` journal changes.
- No edits to `retro-gates.yaml`, its schema, the epic context files, `.github/`, or the coordinator's retro-item position.
- No mocks in the case tables.

## I/O & Edge-Case Matrix

Chain 1 → 2 → 3 → 4 (each depends on the previous); E = 1 with Stories and retro done everywhere upstream.

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Untagged open item | E item `blocking: false`, `open` | Epic 2 (d=1) not held; Epics 3, 4 (d≥2) held, `retro-item` reason | None |
| Blocking item | E item `blocking: true`, `open` | Epics 2, 3, 4 held | None |
| Closed item | status `done` or `deferred` | holds nothing | None |
| `waiting` / `in-progress` | untagged | holds d≥2 as `open` does | None |
| Diamond | D depends on E and on F; F depends on E; untagged item on E | D at distance 1: not held by the item | None |
| Rejected, no go | verdict `rejected` | holds d≥1 (`retro-rejected`) | None |
| Rejected with go | `go` recorded | verdict holds nothing; open items still gate by tag | None |
| Unrelated Epic | Epic not reaching E | never held | None |

</intent-contract>

## Code Map

- `src/core/next/epic-gates.ts` -- `epicHolds(snap)`: the shared Epic hold check; today `dependency-epic` + `retro-rejected` (via `reaches`, i.e. distance ≥ 1). Replace `reaches` with a shortest-distance BFS over `depsOf` and add item holds.
- `src/core/next/reasons.ts` -- `ReasonCode` union; add `"retro-item"`.
- `src/core/next/next.ts:118-150` -- `nextBuilder` consumes `holdsOf(n)`: any hold skips the Epic's Stories and pushes reasons into the idle reason. No change needed.
- `src/core/next/coordinator.ts:345-350,376` -- `planningDue` skips context planning for a held Epic; update its doc comment to name the `retro-item` hold.
- `src/core/next/coordinator.ts:652` -- `retroItemUnit(id)` builds `retro-item:<id>`; importing it into `epic-gates.ts` would create an import cycle (coordinator imports epic-gates) — format the string inline.
- `src/core/schemas/retro-gates.ts` -- `RetroItem` (`id`, `blocking`, `status`, `route`) and `RetroSchema` (`verdict`, `go`); read-only.
- `test/core/next/fixtures.ts` -- `World.retro` writes verdict-only entries via `retroGates()`; extend with per-Epic items (id, blocking, status).
- `test/core/next/next.test.ts:155-180` -- existing rejected-retro describe; add the FR10 case table next to it.
- `test/boundaries.test.ts:335` -- pins `core/next` import lines; keep `epic-gates.ts` free of new imports from `next.ts`/`coordinator.ts`.

## Tasks & Acceptance

**Execution:**
- `src/core/next/reasons.ts` -- add `"retro-item"` to `ReasonCode` -- the new hold's code.
- `src/core/next/epic-gates.ts` -- compute `distance(n, e)` (shortest path along `depends_on`, undefined when unreachable); keep `retro-rejected` at d ≥ 1; for each Epic E in `snap.retro_gates.epics`, each item with status `open`/`in-progress`/`waiting` holds n when `d ≥ (blocking ? 1 : 2)`, pushing `{ subject: "epic:<n>", code: "retro-item", message }` naming `retro-item:<id>`; update the module doc -- the FR10/AR13 gate.
- `src/core/next/coordinator.ts` -- update the `planningDue` doc comment to list the `retro-item` hold -- docs stay true.
- `test/core/next/fixtures.ts` -- add a `World.items` option (Epic → items) rendered into `retro-gates.yaml` alongside verdicts -- fixtures for the table.
- `test/core/next/next.test.ts` -- add the FR10 case table (every I/O matrix row, chain and diamond), idle-reason assertions that name the item, a test that a claimed Story in a newly held Epic keeps its record while no new Story of that Epic is picked, and a test that a held Epic falls through to an unrelated Epic -- AC coverage.

**Acceptance Criteria:**
- Given the FR10 case table, when it runs, then an untagged open item from E does not gate an Epic one step from E but gates one two steps away, a `blocking` item gates every Epic depending on E directly or transitively, and a `rejected` verdict gates every dependent until `go retro:<E>` is recorded and no longer after it.
- Given a builder `next` and an Epic held by a retro item or a rejected retro, when no other Epic is eligible, then the outcome is `idle` and its reason names the item (`retro-item:<id>`) or the rejected retro (`retro:<E>`).
- Given a claimed Story in an Epic that becomes held, when `next` runs, then the claimed record is untouched and no other Story of that Epic is picked.

## Spec Change Log

## Review Triage Log

### 2026-10-26 — Review pass
- verdicts: 16 findings — high 0, medium 3, low 8, false 5, maybe-false 0
- findings:
  - `[medium]` `[defer]` (blind) A held Epic blocks takeover of its own stale claimed/merging Stories — real, but the skip in next.ts predates this story for every Epic hold; deferred to frontmatter `deferred` for a Maintainer decision on whether a takeover is exempt.
  - `[low]` `[patch]` (blind) The claimed-Story test's ledger-unchanged assertion is vacuous because `next` is pure — dropped the `structuredClone` equality; idle, codes and record assertions kept.
  - `[medium]` `[patch]` (blind) `planningDue` now skips context planning for an Epic held by a retro item, with no test — added two planningDue rows in test/core/next/coordinator.test.ts (blocking item: not due; untagged at distance 1: due).
  - `[low]` `[patch]` (blind) `OPEN_ITEM` is an untyped allow-list contradicting its comment, failing open on a new status — replaced with `CLOSED_ITEM: ReadonlySet<RetroItem["status"]>` = {deferred, done}.
  - `[low]` `[patch]` (blind) The idle message says "open" for waiting/in-progress items — message now carries the actual status: `(waiting, blocking, distance 1)`.
  - `[low]` `[patch]` (blind) No test with items on more than one source Epic — added a two-source test asserting exact codes and messages in order.
  - `[low]` `[reject]` (blind) One BFS per (held Epic, source Epic) pair — Epic graphs are a handful of nodes; negligible, and a memoised restructure adds complexity.
  - `[false]` `[reject]` (blind) Merging switches on holds against live retro-gates.yaml data (Epic 4 onward held) — this is AR13's intended effect, recorded in readiness R2 and commit ff5cd14, and it takes effect only when the Maintainer advances runner_version; also a spec edit.
  - `[low]` `[patch]` (blind) `ItemSpec` doc says "no globs unless given" but there is no globs field; also spec Code Map line refs/empty logs — fixed the fixture doc comment; the spec-artifact parts are spec edits, rejected.
  - `[low]` `[patch]` (edge) `OPEN_ITEM` untyped Set fails open on a new status enum value — same root cause as the blind finding; fixed by the same `CLOSED_ITEM` change.
  - `[medium]` `[patch]` (verification-gap) planningDue's retro-item hold has no test — same root cause as the blind planningDue finding; fixed by the same two rows.
  - `[false]` `[reject]` (intent) AC1/AC2 are tested through `next`, not `epicHolds` directly — FR10's success criterion is "`next` tests on the dependency graph", the outer surface; `next` is the gate's only consumer for builders.
  - `[low]` `[reject]` (intent) Epics with every Story done still get retro-item reasons in the idle text — same as the existing retro-rejected behaviour (pinned by the existing rejected-retro test); cosmetic, and filtering adds a branch.
  - `[false]` `[reject]` (intent) AC4 lifecycle: claimed Stories finishing depends on the lane, not on `next` — no lane code re-checks holds after a claim (epicHolds is used only by next and planningDue), so a live claim always finishes; the takeover sub-case is the deferred item above.
  - `[false]` `[reject]` (intent) Shortest-path vs any-path distance not escalated — FR10's intent ("holds back the Epics that depend directly on E only when … `blocking`") selects shortest path; any-path would hold a direct dependent with an untagged item.
  - `[false]` `[reject]` (intent) R4 coordinator surface: planningDue also gated — intended: AR13 holds an Epic, and planning a context for an Epic that can take no Stories is not due, as for the existing holds; its test gap is the patched finding above.

## Design Notes

Why shortest-path distance: FR10's intent says an item "holds back the Epics that depend directly on E only when the retro tags it `blocking`". In a diamond (D → E and D → F → E), D depends directly on E, so an untagged item must not hold it; any-path distance would. Shortest path is also the standard meaning of "distance".

Example message: `Epic 3 is held by Epic 1's open retro item retro-item:epic-1-retro-item-2-x (untagged, distance 2)`; blocking: `... open blocking retro item retro-item:<id> (distance 1)`.

## Verification

**Commands:**
- `bun test` -- expected: all pass
- `bun --bun oxlint` -- expected: no errors
- `bun --bun tsc` -- expected: no errors

## Auto Run Result

Status: done

**Summary:** `epicHolds` (the shared Epic hold check behind builder `next` and coordinator `planningDue`) now applies AR13's distance gates. Distance is the shortest dependency path from the held Epic down to Epic E. An open retro item of E (`open`, `in-progress`, `waiting`) holds every Epic at distance ≥ 1 when `blocking` and ≥ 2 otherwise, under the new reason code `retro-item`, whose message names `retro-item:<id>`, its status, tag and distance. A rejected retro with no go still holds distance ≥ 1 (`retro-rejected`).

**Files changed:**
- `src/core/next/epic-gates.ts` -- shortest-distance BFS replaces `reaches`; item holds; doc comment.
- `src/core/next/reasons.ts` -- `retro-item` reason code.
- `src/core/next/coordinator.ts` -- `planningDue` doc comment names the new hold.
- `test/core/next/fixtures.ts` -- `World.items` / `ItemSpec` / `itemId` to write retro items into `retro-gates.yaml`.
- `test/core/next/next.test.ts` -- FR10 case table (chain, diamond, unrelated Epic, statuses, verdicts, bootstrapped source, two sources) and idle-reason, claimed-Story and fall-through tests.
- `test/core/next/coordinator.test.ts` -- planningDue rows for a retro-item hold.

**Review:** 16 findings. 6 entries patched (1 medium, 5 low); 1 deferred (medium: takeover of a stale Story in a newly held Epic); 2 rejected low (BFS per pair; reasons on all-done Epics); 5 false. Patched counts by verdict: high 0, medium 1, low 5.

**Follow-up review recommended:** false. No high was patched, and only one medium.

**Verification:** `bun test` 5490 pass / 330 skip / 0 fail; `bun --bun oxlint` exit 0; `bun --bun tsc` exit 0. Every I/O matrix row is covered by a passing test in `next: retro-item distance gates (FR10, AR13)`.

**Residual risks:** Once a runner tag includes this, the live `retro-gates.yaml` holds Epic 4 onward. Epic 3's blocking items 1 and 2, and the untagged open items of Epics 2 and 3 at distance ≥ 2, hold until they close, and some of them are Maintainer-routed with no globs (readiness R2). The takeover question is deferred above.

