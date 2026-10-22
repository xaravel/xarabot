---
title: Implementation readiness, xarabot 0.x (re-gate)
date: 2026-10-21
gate: FAIL
reviewed_at: ff2708a
previous_gate: a338d2f (FAIL at 4024723; B1-B3 and C1-C13 fixed by 1738280 and ff2708a)
inputs:
  - _bmad-output/specs/spec-xarabot/SPEC.md (and companions)
  - _bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/epics.md
  - .xarabot/epics.yaml
next: bmad-correct-course
---

# Implementation readiness: xarabot 0.x (re-gate)

**Verdict: FAIL.** The Epic 1 bootstrap can be built as recorded. From the self-host switch on, the runner stalls in three places: Epic 2 deadlocks on `depends_on` before `reconcile` exists, the write check refuses every retro diff, and no build can find its Story spec. `sprint-status.yaml` was not generated.

The correct course worked. Of the previous gate's findings, B1–B3, nearly all of C1–C13 and every Minor item are resolved in the current artifacts. Two items are partly open (below). A dry run of `sprint_plan.py generate` parses `epics.md` cleanly: 7 Epics, 62 Stories and 7 optional retros. `1.17a` and `5.1a` produce the keys `1-17a-…` and `5-1a-…`. The only warnings are the document title (line 14) and `## Epic List` (line 221). Once the gate passes, generation is one command.

Line references are to the files at commit `ff2708a`. Abbreviations: E = `epics.md`, S = `ARCHITECTURE-SPINE.md`.

## Blockers

### N1. Epic 2 deadlocks on `depends_on` before `reconcile` exists

- The Story 1.20 runbook has the Maintainer write Epic 2's manifests "with `depends_on` where a Story builds on an earlier one" (E:1072).
- `next` returns a Story only when every `depends_on` Story is `done` in `sprint-status.yaml` on `main` (E:495-497; S:232, S:321). A `merged` record does not count (E:492).
- Only Story 2.5's `reconcile` writes `done` (E:1221; S:96). Until Story 2.5 merges and the coordinator lane runs, a merged Story stays `merged`, and Story 1.17a writes only that (E:946).
- Example: Story 2.5 builds on Story 2.4's coordinator lane. A manifest with `2.5 depends_on [2.4]` means Story 2.5 is never returned, because Story 2.4 can only become `done` once Story 2.5 exists. With one builder, Epic 2 stops.
- Also unrecorded: when the Maintainer advances `runner_version`, and tags it (E:1026), during Epic 2. Story 2.6 is the only mention (E:1262).
- **Fix, either:**
  - (recommended) a Story listed in `depends_on` is satisfied when it is `done`, **or** has a `merged` record. Either way the predecessor is on `main`, which is what `depends_on` protects. Change spine AD-10/AD-13 and Story 1.6.
  - a runbook rule that Epic 2 manifests name no Story before 2.5 in `depends_on`. Builder limit 1 plus lowest-Story-first already orders them.
- Also record the `runner_version` steps in the runbook.

### N2. The write check refuses every retro unit

- Retro units hold only `sprint-status.yaml`, `retro-gates.yaml` and the Epic context path (S:314; E:1197).
- Coordinator diffs may touch only the paths their unit holds (S:652; E:1199-1201).
- Stock `bmad-retrospective` writes `{implementation_artifacts}/epic-<N>-retro-<date>.md` (`.claude/skills/bmad-retrospective/references/retro-document.md`), and Story 2.9 needs that file in the diff to validate the verdict (E:1374).
- Effect: Epic 2's retro never lands, so Epic 3 never starts.
- The same kind of gap: on a FAIL, a headless `bmad-sprint-planning` can write `{planning_artifacts}/implementation-readiness.md` (`.claude/skills/bmad-sprint-planning/references/readiness-gate.md`). That path is outside the status unit's paths.
- **Fix:**
  - add `retro_doc_glob` to the retro unit's held paths (spine AD-13, AD-30; Stories 2.4 and 2.9);
  - either add the readiness findings path to the status unit, or tell the status unit's prompt not to write it.

### N3. The Story spec path is not pinned

- The runner expects the Story spec at `story_spec_path`, by default `implementation_artifacts/spec-<sprint_key>.md` (S:240; AR11 at E:144).
- Story 1.16 cross-checks the result against that spec's `status` and `## Auto Run Result`, and treats a mismatch as an invalid result (E:876-878).
- The write check lets a builder diff carry, outside its globs, only that one spec file (E:62, E:1148; S:650).
- Story 1.13's prompt says only "Build Story 1.7" and runs stock `bmad-build-auto` (E:757). Outside folder+id dispatch, build-auto derives its own slug from the intent and leads it with the tracking id, e.g. `3-2-digest-delivery` (`.claude/skills/bmad-build-auto/step-01-clarify-and-route.md`, Route). So the slug need not equal `sprint_key`.
- Effect: every self-hosted build fails the cross-check, or its spec file is refused. It uses up 3 attempts and parks.
- **Fix, either:**
  - the prompt names the exact spec path for build-auto to use (Story 1.13; spine AD-29);
  - `story_spec_path` matches `spec-<epic>-<story>-*.md`, and the runner takes the single match (spine AD-10; Stories 1.2 and 1.16).

## Partly open from the previous gate

- **C10, Story 2.7 before 2.8.** E:1302 now states the gap, but the order is unchanged. Graph PRs merge under the every-path approval rule only, with no merge-result `resolveGraph` and no `approved_graph` binding until Story 2.8. The runbook does not tell the Maintainer to run `xarabot graph check` (E:423-425) on each graph PR in the meantime.
- **C11, sandbox env.** Spine AD-17 passes through "the variable that points the CLI at its vendor home" (S:417). The allowlist in AR18 (E:151) and Story 1.11 (E:682) omits it, yet Stories 1.14 and 3.1 set `CLAUDE_CONFIG_DIR` and `CODEX_HOME` (E:791, E:1497).

## Concerns

- **C1. Live tests cannot be switched on.**
  - The convention is `bun test --live <suite>` (S:701; E:233, E:1056, E:1475 and peers).
  - Bun 1.4.3 accepts `--live` silently and does not pass it into `Bun.argv`, so a test cannot tell it is live (checked 2026-10-21).
  - No Story builds a live switch (Story 1.1, E:290-319).
  - **Fix:** an environment variable (e.g. `XARABOT_LIVE=1`) in spine Conventions and Story 1.1, and update every verification Story's command.
- **C2. The loopback cap pre-empts the CI-fix cap.**
  - Every later agent change, CI fixes included, re-runs the review and counts as a loopback, at most 2 (S:399).
  - CI fixes have their own cap of 2 (S:446), and Story 3.5 parks at `loopbacks ≥ 2` "whatever the review's verdict" (E:1644-1645).
  - So `ci-fix-cap` can never fire, and two CI fixes park a unit whose checks pass.
  - **Fix:** decide whether CI fixes count against the loopback cap (spine AD-16/AD-19, Story 3.5).
- **C3. Where vendor credentials come from is not recorded.** The vendor home is "re-seeded" with a credential (S:411-412; E:685-687, E:1544). Nothing says where the runner reads the Claude OAuth token, the Codex auth or the OpenRouter key, including for a reviewer of another vendor. **Fix:** spine AD-17.
- **C4. `retro-gates.yaml` has no field schema.**
  - The spine names the file only (S:591). The fields for verdict, items, checkpoint go, a rejected retro's go and "awaiting go" appear nowhere, so Story 1.4 would invent them (E:411).
  - Story 1.4's scope also omits the rejected-retro go that Story 1.6 reads (E:485-488).
  - The Maintainer's hand-written go before Story 4.6 (S:100; E:1079) has no defined format.
  - **Fix:** spine AD-12 and Story 1.4.
- **C5. How a status unit compiles Epic context is not recorded.**
  - No stock headless skill does it. `compile-epic-context.md` is internal to `bmad-build-auto`.
  - S:312, S:634 and Story 2.7 (E:1285) leave it open.
  - Story 1.6 also lacks the "context compiled before eligible" gate that S:323 implies.
  - **Fix:** spine AD-13/AD-29 and Stories 1.6 and 2.7.
- **C6. Maintainer writes beyond SPEC's "one exception" (Maintainer decision).**
  - SPEC:175 makes the coordinator the only writer of `sprint-status.yaml` and `retro-gates.yaml`, with "the one exception" being the Maintainer's one-time `sprint-status.yaml` write at the self-host switch.
  - The spine adds a second Maintainer write: a rejected retro's go recorded by hand in `retro-gates.yaml` until Story 4.6 (S:100; E:1079).
  - Separately, the spine names the coordinator as sole writer of manifests and `epics.md` (S:101), yet the runbook has the Maintainer supply Epic 2's manifests (E:1072).
  - **Decide:** widen SPEC:175, and the matching AD-3 rows, to the bootstrap-period Maintainer writes, or remove those writes from the plan. Per AGENTS.md this is the Maintainer's call. A SPEC change goes through `bmad-spec`.
- **C7. Creating `sprint-status.yaml` before the switch.** AR4 and S:97 describe the Maintainer's switch-time write as the one that *creates* the file. If the Maintainer runs `bmad-sprint-planning` during the Epic 1 bootstrap, that switch-time write instead updates it with Epic 1 `done`. **Fix:** word AR4, S:97 and E:1072 so either order works.
- **C8. Story size.** Story 1.16 (E:851-906) covers claim, branch adoption, session, result validation and cross-check, commit, push, PR, comments, denied actions, parking, budget, journal and the outcome file. It is unlikely to fit one 6-hour unit; split it. Story 2.7 (E:1266-1315) is borderline.

## Minor

- FR4 and FR18 still say "worktree" (E:32, E:61); SPEC:44 and SPEC:104 say "full clone".
- SPEC CAP-5 (SPEC:47) and FR5 (E:34) still say "all its Stories merged"; D1 means `done` in `sprint-status.yaml`.
- AR37 (E:170) omits `graph` from the CLI list (S:787 has it).
- AR28 (E:161) omits Escalation statuses from the `Snapshot` (S:599 and E:2319 have them).
- AR24 (E:157) omits open Escalations from the digest sources (S:529 has them).
- NFR20 (E:120) omits SPEC:175's self-host write exception.
- AD-33 (S:687) checks only `issues: write`; Story 7.5 (E:2287) also checks the merge-queue permission.
- `/xarabot go <epic>` (E:1858, E:1912) does not match the rulings grammar, which takes AR35 ids such as `checkpoint:<epic>` (E:1831).
- The Escalation decision file is `<decisions-dir>/ESC-<id>.md` in AR21 (E:154) but `<id>.md` in the spine and Story 7.6 (S:484; E:2315).
- `[ASSUMPTION: zod 4]` (S:591) is already settled by the Stack table (S:711).

## Checked, no finding

- Every 0.x capability traces into Story acceptance criteria. No Story lacks recorded intent.
- `.xarabot/epics.yaml` matches the stated Epic dependencies (E:272).
- All 62 `### Story N.M:` headings are well formed, with no duplicate ids.
- The remaining spine `[ASSUMPTION]` tags (pi directory override S:414, proxy allowlist S:420) are spiked first, in Stories 3.2 and 1.12.
- Within Epic 1 the only forward references are deliberate and fixture-backed: 1.12 → 1.14's host list, and 1.17a → Epic 2's `reconcile`.

## Changes by artifact

For `bmad-correct-course`; each artifact changes through its own skill, per AGENTS.md.

| Artifact | Changes |
|---|---|
| Spine (`bmad-architecture`) | AD-10/AD-13 `depends_on` satisfaction (N1); AD-13/AD-30 retro unit paths and status unit findings path (N2); AD-10/AD-29 spec path (N3); Conventions live switch (C1); AD-16/AD-19 caps (C2); AD-17 credential source (C3); AD-12 `retro-gates.yaml` schema (C4); AD-13/AD-29 Epic context compile (C5); AD-3 rows per the C6 decision; S:97 wording (C7); AD-33 (Minor); stale zod tag |
| Spec (`bmad-spec`) | SPEC:175 per the C6 decision; CAP-5 wording |
| Epics (`bmad-create-epics-and-stories`) | Story 1.6 (N1, C5); 1.20 runbook (N1 `runner_version` steps, C10 `graph check`, C7); 2.4, 2.9 (N2); 1.2, 1.13, 1.16 (N3); 1.1 and every verification Story (C1); 3.5 (C2); 1.4 (C4); 2.7 (C5); AR18 and 1.11 env (C11); split 1.16 (C8); the requirements-inventory wording in Minor |
| `.xarabot/` | unchanged |

After those land, re-run `bmad-sprint-planning`: the gate, then generation.
