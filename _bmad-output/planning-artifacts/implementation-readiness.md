---
title: Implementation readiness, xarabot 0.x (third gate)
date: 2026-10-22
gate: FAIL
override: Maintainer, 2026-10-22. sprint-status.yaml generated so Epic 1's bootstrap build can start; the blockers below must be fixed before the self-host switch.
reviewed_at: 6e2cdbe
previous_gates: a338d2f (FAIL at 4024723), 23e7f91 (FAIL at ff2708a); both fixed by correct course (proposals 2026-10-21 and 2026-10-22)
inputs:
  - _bmad-output/specs/spec-xarabot/SPEC.md (and companions)
  - _bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/epics.md
  - .xarabot/epics.yaml
next: bmad-correct-course (before the self-host switch)
---

# Implementation readiness: xarabot 0.x (third gate)

**Verdict: FAIL, overridden by the Maintainer.** The Epic 1 bootstrap can be built as recorded. Two blockers stall the self-hosted runner from Epic 2 on:

- a parked PR that is merged by hand never becomes `merged` before `reconcile` exists;
- retro items routed to the Maintainer, or with no globs, can never close.

The Maintainer chose to generate `sprint-status.yaml` now and fix these before the switch.

Every finding from the previous gate (N1–N3, C1–C11 and the Minor items) is resolved in substance. Each was traced through these walks:

- Epic 2 at the switch with `2.5 depends_on [2.4]`;
- a retro diff through the write check;
- a `1-17a` build through the `story_spec_path` glob.

`sprint_plan.py generate` parses `epics.md` to 7 Epics, 63 Stories and 7 optional retros.

Line references are to the files at commit `6e2cdbe`. E = `epics.md`, S = `ARCHITECTURE-SPINE.md`.

## Blockers

### R1. A hand-merged parked PR never becomes `merged` before `reconcile` exists

- Under the every-path approval rule, a builder PR parks for the Maintainer's approval, and the Maintainer queues it by hand while `reconcile` does not exist (E:282, E:988).
- E:282 and E:988 say "a lane that later sees it merged writes `merged`" (AD-3 allows any lane to, S:112). No acceptance criterion builds that step:
  - Story 1.16 inspects only the branch of the unit it just claimed (E:889);
  - `next` never returns a `parked` record (E:507);
  - only Story 2.5's `reconcile` writes `merged` for merged PRs (E:1221).
- Trace: Story 2.4 parks, and the Maintainer merges it by hand. Its record stays `parked`, holding its globs, so `2.5 depends_on [2.4]` is never met (D14, E:513). Story 2.5 is never chosen, `reconcile` never exists, and Epic 2 stops. This reopens N1.
- **Fix:** at lane start, after the snapshot, any lane writes `merged` for each `parked` record whose PR the snapshot shows merged. The edit is idempotent. Change Story 1.16 or 1.17a, and AR8/AD-7 if a row is needed.

### R2. Maintainer-routed and glob-less retro items can never close

- Story 4.3 sets `route: maintainer` items to `waiting` (E:1828), which counts as open (S:297). Items with no globs stay `open` and can't be claimed (S:324; E:1449-1451).
- The only status writer is `reconcile`, which marks an item `done` when its retro-item PR merges (E:1457-1459). Nothing writes `deferred`.
- No ruling verb changes an item's status: `dismiss` removes only the inbox item (S:631-637; E:1938-1940). A Maintainer hand edit of `retro-gates.yaml` is not an allowed write, beyond the rejected-retro go (SPEC:175-178; S:100).
- Trace: Epic 2's retro routes one item to the Maintainer. Once Story 4.1's distance gates are pinned, the item holds every Epic at distance 2 or more from Epic 2. That is Epic 4's remaining Stories, then Epics 5–7 for good.
- **Decide:** how a Maintainer-routed or glob-less item closes or is deferred. For example, a ruling verb `/xarabot done <item-id>` or `/xarabot defer <item-id>`, applied by `reconcile`. Change AD-28, AD-12 (the writer of `deferred` and `done`), and Stories 4.3, 4.5 and 4.6.

## Concerns

- **R3. No git identity for the agent's own commit.**
  - Stock `bmad-build-auto` commits inside the clone at the end of a run. If the working copy isn't clean it halts `blocked` ("finalization left repository dirty") (`.claude/skills/bmad-build-auto/step-04-review.md`, finalize steps 1–2).
  - The session's `HOME` is fresh (S:436-437), and nothing records a git identity for that commit. If the commit fails, every build parks.
  - **Fix:** the runner writes a clone-local identity when it rebuilds the clone (AD-15, Story 1.15). The runner's own commit still sets the real author.
- **R4. A crashed lane has no recovery before Story 2.2.**
  - A `claimed` record from a dead process is never returned (E:507). Story 1.16 always runs `next` (E:884), and stale takeover arrives in Story 2.2.
  - `stop --now` releases a live lane's unit (E:1035-1039), but nothing says it works when the lane is already dead.
  - **Fix:** Story 1.16 resumes the lane's own live claim before `next`, or `stop --now` releases a dead lane's claim. Either way, the Story 1.20 runbook names the recovery.
- **R5. Story 4.4 is stale.** It still has runner code "mark C as awaiting a go in `retro-gates.yaml`" (E:1853). The 2026-10-22 schema has no such record (S:308; E:146), and S:104 names no writer for it. State what the checkpoint unit does now, and add an AD-7 row for a one-shot unit with nothing to commit.
- **R6. A blocked status unit.**
  - Readiness findings make the `planning` outcome `blocked` (S:655), but AD-7 has no `park.reason` for it (S:182), and nothing stops `planning:<slug>.<n+1>` re-running the same thing.
  - Epic context compiling rides on the same unit, so one finding holds the next Epic's start (D19).
  - **Fix:** a park reason, a rule against re-running the same finding, and how the Maintainer clears it.
- **R7. Coordinator PRs under the every-path rule.**
  - Each `reconcile:<n>` can open another PR while the last one is parked (E:1263-1273), and no rule says to reuse it.
  - Nothing says whether `reconcile` PRs need approval during Epic 2.
  - S:328's "approval-gated coordinator PRs (a Protected Path or a graph change)" does not cover status units that the every-path rule gates (E:1347).
  - The runbook doesn't say which policy list "every path" goes in (Story 1.2 has two, E:336). In Protected Paths, Story 2.3 would refuse every builder diff (S:668).
- **R8. Other stock `bmad-build-auto` behaviours nothing records.**
  - A halt before routing writes `bmad-build-auto-result-*.md` (`workflow.md`, write-back). A genuine `blocked` result then has zero `story_spec_path` matches, so it counts as invalid and is retried (S:364; E:897-898).
  - On wip resume, an existing non-draft spec makes it create a `-2` file (`step-01-clarify-and-route.md`, Route), giving two matches and an invalid result.
  - Its context-validity check also requires that no planning file is newer (`step-01`, item 2). The spine's two-condition check (S:332) differs, so a rebuilt clone may recompile the context every session. The runner reverts it, which costs only time.
- **R9. Gaps at the switch.**
  - `retro-gates.yaml` is created by no bootstrap write, and fail-closed exempts only a missing `epics.yaml` (S:506).
  - An Epic 2 `depends_on` naming an Epic 1 Story has no manifest to resolve against. Validation may call it unknown and stop every lane (E:425), and `next` can't map its id to a sprint key (E:510).
  - Xarabot's own manifest directory, and whether the manifest is also the BMAD Story file, are undecided (S:233).
- **R10. Smaller gaps in Stories and the spine.**
  - Story 1.16a has no branch for a three-way conflict at commit time (E:858, E:934).
  - AD-5 lists no ledger field for `approved_graph` (S:287) or the stored retro result (S:303).
  - Nothing gates a retro on the Maintainer's live checks having run (E:233, E:1407).
- **R11. Epic 2 runbook.**
  - The `runner_version` advances that Story 2.9 (Epic 2's retro) and Story 2.7 (Epic 3's context) need are covered only by the generic rule (E:1113).
  - "Queue by hand while `reconcile` does not exist" (E:282, E:988) doesn't fit the window between Stories 2.5 and 2.6, when `reconcile` exists but doesn't yet enqueue.

## Minor

- Stories 3.1, 3.2 and 3.3 drop the `<vendor>/` folder from the credential path (E:1544, E:1596, E:1651; S:430).
- SPEC's Write authority leaves out the Maintainer's interactive Epic 1 retro, which writes `sprint-status.yaml`; AD-3 includes it (S:101).
- S:415 says "except `reconcile` PRs (below)", but that bullet is above (S:410).
- The "coordinator missing" alert fires again on every new `main` SHA until the coordinator is installed (S:204, S:552).
- Story size: 2.7 and 1.17 are the largest.

## Changes by artifact

For `bmad-correct-course`; each artifact changes through its own skill, per AGENTS.md.

| Artifact | Changes |
|---|---|
| Spine (`bmad-architecture`) | AD-7 rows (R1, R5, R6); AD-28 and AD-12 item close/defer (R2); AD-15 clone identity (R3); AD-13 and S:328 coordinator PRs under every-path (R7); AD-13 context check (R8); fail-closed for `retro-gates.yaml` (R9); AD-5 fields (R10); S:415 |
| Spec (`bmad-spec`) | Write authority: the interactive Epic 1 retro write, if the Maintainer agrees |
| Epics (`bmad-create-epics-and-stories`) | Stories 1.16/1.17a (R1, R4); 4.3, 4.5, 4.6 (R2); 1.15 (R3); 4.4 (R5); 2.7 (R6); 2.5, 2.6, 1.2, 1.20 runbook (R7, R9, R11); 1.13/1.16 result handling (R8); 1.16a (R10); 3.1–3.3 path |
| `.xarabot/` | unchanged |
