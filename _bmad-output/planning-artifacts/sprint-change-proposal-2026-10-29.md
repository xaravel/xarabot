---
title: Sprint Change Proposal, Epic 3 retro item 7
date: 2026-10-29
status: approved (Maintainer, 2026-10-29)
approved_by: edanisko
approved_at: '2026-10-29'
trigger: Epic 3 retro (`epic-3-retro-2026-10-26.md`) item 7 (A4, A6–A10, C4, C6, C7, E3); the sweep of merged Epic 3 and Epic 4 spec deferrals
mode: batch
scope: minor
edits: SPEC and `agent-adapters.md` (through `bmad-spec`, a separate PR), spine, epics (AR3, AR6, Stories 3.1, 3.5, 3.6, Epic 3 retro decisions), `self-host.md` (the switch after Epic 3), `retro-gates.yaml` (new items 16–19)
---

# Sprint Change Proposal: Epic 3 retro item 7

## Approval (Maintainer, 2026-10-29)

Ed approved this proposal as recommended, in batch mode, including recording items 18 and 19 as `deferred`.

## 1. Issue summary

Epic 3's retro (2026-10-26, machine verdict rejected) found that the spine, SPEC and companions had drifted from the as-built code (A8), that a few Story criteria were reinterpreted while being built (A4, A6, A7), and that several Epic 3 deferrals had no receiving Story or item (A9, C4, C6, C7, E3). Item 7 asks for one correct course to reconcile the documents, decide the open points and route the deferrals.

Since the retro, later work settled part of this:
- the cap no longer parks a passing round (Maintainer Q2, item 11);
- a takeover in a held Epic finishes in-flight work (item 13);
- globs cover tests and wiring, and an Epic's open questions are decided before it starts (items 14 and 15, and the config-supplied ruling of 2026-10-29);
- the cadence outage's cause, the unauthenticated bot-id lookup, is cached (Epic 2 item 36);
- `createReview` is in `app-permissions.md` (Epic 2 item 37).

Evidence: the code on `main` at d1e8aab, `docs/maintainer/evidence/epic-3.md` and `epic-4.md`, and `retro-gates.yaml`.

## 2. Impact analysis

- **Epics:** no Epic changes scope, order or dependencies. No manifest or graph change: `graph check` is unchanged.
- **Stories:** done Stories 3.1 and 3.5 get recorded amendments that match the code. Story 3.6's switch list gains the codex-builder condition.
- **Artifacts:** the spine (AD-2, AD-5, AD-6, AD-12, AD-16, AD-17, AD-20, Conventions, Deferred, the host layout), the requirements inventory (AR3, AR6), and SPEC and `agent-adapters.md` (through `bmad-spec`).
- **Code:** two small lane items (16, 17). No runner change is needed for anything else.
- **Distance gates:** items 16 and 17 are open lane items, so they hold Epic 5 until they merge. Items 18 and 19 are `deferred` and hold nothing.

## 3. Recommended approach

Direct adjustment: reconcile the documents with the code, accept the reinterpretations that are safe, and route the rest as two lane items and two deferred Maintainer items. Effort low, risk low, no timeline impact beyond the two lane items.

## 4. Detailed change proposals

### 4a. Decisions

| # | Point | Decision |
|---|---|---|
| B1 | The cap parks a passing round (A7) | Settled by Q2 and item 11. Only SPEC's wording follows (4c). |
| B2 | Takeover re-reviews (A6) | Accepted as built: after a blocking round, a takeover clears the review SHAs, keeps `loopbacks`, and builds and reviews afresh; it never enqueues. Safe, rare and bounded by the cap. Story 3.5 and spine AD-16 amended. |
| B3 | Codex usage limit with no `rate_limits` (C4) | No code now. Before codex runs unattended, the Maintainer captures a real over-limit codex session, and the fix is decided from it. The 3.1 criteria forbid text matching. Item 18. |
| B4 | No-output watchdog (C6) | Deferred for 0.x (spine, Deferred). Item 35 closed the known hang. Any watchdog must watch vendor-home or temp-folder activity, since `claude -p` is silent until it ends. |
| B5 | `lane install` checks the lane's agent (A9) | Refuse at install, as lane start does. Item 16. |
| B6 | A real `bmad-build-auto` codex canary (A9) | One recorded real-skill codex run before any `agent: codex` builder lane; codex may review without it. Story 3.6 and the runbook amended. Item 18. |
| B7 | The review prompt's agent-config line (C7) | Reworded so a committed agent-config change counts as part of the change. Item 17. |
| E3 | The cadence change outage | Recorded as a planning rule (epics) and a spine Convention: a cadence change lists its forge calls against the forge's limits. |

### 4b. Spine (`ARCHITECTURE-SPINE.md`)

- AD-5: `enqueued_sha`; `passed_sha` set only by a passing round; the `review-findings` park reason; item 29's adopting-lane rule for `builder_providers`; ledger `schema_version` 5 (Story 3.5, with item 24's field) and 6 (Story 4.2's `park.text`, with Story 4.6's `coordinator.json` fields).
- AD-6 table: the blocked row gains `review-findings`.
- AD-2: idle waits are 1 minute for builders and the coordinator (Epic 2 item 26); a session's end or abort signals the sandbox's `setsid` process group (item 1).
- AD-12: a held Epic still yields stale takeovers (item 13).
- AD-16: the takeover rule (B2); the passed gate's chain of up to 32 clean `main` merges (item 4); a planning or retro PR's blocking review parks `review-findings`; lane start checks every reviewer's CLI (item 3).
- AD-17: review passes have their own vendor home and temp folder (item 1); codex's native package folder is readable (item 31); `SSL_CERT_FILE` for codex (item 28); the macOS Mach-lookup allow list with `configd` and `(with no-report)` denials (items 34, 35).
- AD-20: the optional `glob_coverage` key (item 14).
- Ports: `parseUsage(output, vendorHome, since)`.
- Host layout: `review/`, `review-vendor/`, `review-tmp/`, `tmp/`, `bot-user.json`.
- Conventions: the lane cadence row (E3).
- Deferred: the no-output watchdog (B4); the adapter-spike note says Story 3.1 confirmed the outcome mapping with the stand-in skill, and the real skill under codex is open.

### 4c. SPEC and `agent-adapters.md` (through `bmad-spec`, a separate PR)

- CAP-8 and FR8: "Its findings are blocking review loopbacks" → its blocking findings loop back to the builder; on a planning or retro PR they park it for the Maintainer instead.
- CAP-8 success: "After 2 loopbacks, the unit does not merge…" → a blocking review after 2 loopbacks stops the unit; a passing one proceeds.
- "Still open": drop the codex outcome-mapping bullet (confirmed in Epic 3's live run 3).
- `agent-adapters.md`: codex inside the sandbox gets `SSL_CERT_FILE` (system CA bundle) and read access to its native package folder; the pi version note.

### 4d. Epics (`epics.md`)

- AR3: idle waits as in AD-2. AR6: `enqueued_sha`, `review-findings`, ledger versions 5 and 6.
- Story 3.1: the launch criterion drops `-c commit_attribution=""` (codex ignores it; the sanitizer strips the trailer) and adds `SSL_CERT_FILE`.
- Story 3.5: the enqueue criterion records item 4's chain of merges; the takeover criterion records B2.
- Story 3.6: the switch list allows codex as a builder only after item 18's recorded run.
- Epic 3 retro decisions: the cadence rule (E3) under "Planning lessons", and this proposal's decisions under "Item 7".

### 4e. Runbook (`docs/maintainer/self-host.md`)

- "The switch after Epic 3", step 2: codex may review unattended; no `agent: codex` builder lane until item 18's run is recorded.

### 4f. `retro-gates.yaml`: new Epic 3 items

| Id | Route | Blocking | Status | Globs |
|---|---|---|---|---|
| `epic-3-retro-item-16-lane-install-checks-the-lanes-agent` | lane | no | open | `src/cli/lane-install.ts`, `test/cli/lane-install.test.ts`, `docs/maintainer/self-host.md` |
| `epic-3-retro-item-17-review-prompt-counts-committed-agent-config` | lane | no | open | `src/core/prompt/template.ts`, `test/core/prompt/**` |
| `epic-3-retro-item-18-codex-builder-evidence` | maintainer | no | deferred | none |
| `epic-3-retro-item-19-xarabot-glob-coverage-table` | maintainer | no | deferred | none |

### 4g. Routing of the deferrals

| Deferral | Home |
|---|---|
| A4 (`commit_attribution` in the 3.1 criteria) | 4d |
| A6 (takeover re-reviews) | B2 |
| A7 (cap parks a pass) | settled (item 11); SPEC wording in 4c |
| A8 (document drift) | 4b, 4c, 4d |
| A9 (usage limit, real skill, install check, watchdog, pre-v5 parks) | items 18, 18, 16; B4; settled by item 9 |
| A10 (globs miss the wiring) | settled (items 14, 15); its tail is item 19 |
| C4 | B3, item 18 |
| C6 | B4 |
| C7 | item 17 |
| E3 | 4b Conventions, 4d planning rule |
| spec-3-1: the resumed run's model is unverified | item 18 |
| spec-3-1: the macOS sandbox wiring is checked only on the host | accepted: the host evidence rows stand in, and the macOS CI job is deferred (item 10's decision) |
| spec-3-1: token refresh, subagent tokens, host list, pi refusal, reviewer credential | settled (runs 2 and 3; items 2, 12, 32; Stories 3.2, 3.3) |
| spec-3-2: install check | item 16 |
| spec-3-3, spec-3-4: empty `builder_providers`; review step wiring | settled (item 29; Story 3.5's decision) |
| spec-3-5: spine fields | 4b |
| spec-4-1: takeover in a held Epic | settled (item 13); spine in 4b |
| spec-4-5-d1: a runner with 4.5 but not 4.6 consumes rulings | settled by the tag order: runner-13 predates Story 4.5, runner-14 follows Story 4.6 |
| spec-4-6-d1: a host go records `xarabot-rule` | settled (the 2026-10-29 ruling, already in the spine) |

## 5. Implementation handoff

- **Scope:** minor.
- **The Maintainer's planning PR** carries 4b, 4d, 4e and 4f, and this file. Once it merges, the Maintainer runs `xarabot rule done retro-item:epic-3-retro-item-7-correct-course-for-epic-3-drift`.
- **A `bmad-spec` PR** carries 4c.
- **The coordinator** works items 16 and 17 as retro-item units.
- **Success:** `graph check` passes; item 7 is `done`; items 16 and 17 merge; no document names a superseded rule from 4b–4d.

## Appendix: checklist status

- 1, trigger and context: [x] Epic 3 retro item 7, with the evidence above.
- 2, Epic impact: [x] no Epic changes; Epic 5 is held only by items 16 and 17 until they merge.
- 3, artifact conflicts: [x] SPEC (4c), spine (4b), epics (4d); UX [N/A].
- 4, path forward: [x] direct adjustment; rollback [N/A]; MVP review [N/A].
- 5, proposal components: [x] sections 1–5.
- 6, final review and handoff: [x] approved by the Maintainer, 2026-10-29.
