---
title: Sprint Change Proposal, Epic 2 course correction
date: 2026-10-24
status: approved
trigger: the self-hosted lane's intent-gap parks on Stories 2.4, 2.5 and 2.6; readiness R1–R11 still open; `epic-1-retro-2026-10-23.md` action items 1–14; lane findings F1–F19
mode: hybrid (decisions one at a time; mechanical edits in batch)
scope: moderate
approved: 2026-10-24 (Maintainer; every DECISION item's recommended option and every MECHANICAL item, plus D-R from the review of PRs #59, #61 and #65)
edits: spine, epics (requirements inventory and Stories, 5 new Stories), runbook, manifests, sprint status, AGENTS.md (one Policy line), Epic 1 retro (human decision)
---

# Sprint Change Proposal: Epic 2 course correction

## 1. Issue summary

Xarabot's own runner has built Epic 2 since the self-host switch: Stories 2.1–2.5 merged as PRs #57, #58, #59, #61 and #65. The lane still runs `runner-2` (tagged at `8ae6e6d`, before Story 2.1), so none of that code runs yet. Four problems came together:

- **The lane stops on intent gaps.** Stories 2.4, 2.5 and 2.6 each parked `blocked` (`intent-gap`) on a question the plan did not settle. The Maintainer answered them in #62 (2.4), #63 and #64 (2.5) and #66 (2.6). Epic 2 is strictly serial: every manifest has the same globs and names the Story before it in `depends_on`, so one parked Story stops the whole Epic. Each park costs a Maintainer round trip, because no GitHub notice is sent for a parked PR and no ruling path exists before Epic 4.
- **Readiness R1–R11 are still open in part.** R1, R3, R4, R7 (most of it), R8c and R9 are settled in code or by earlier decisions. R2, R5, R6, R8, R10 and R11 needed a plan change.
- **The Epic 1 retro left open items.** Its machine verdict was `rejected` on a narrow ground (A1, the unwired model check). Action items 1–4 and 7–13 needed a home, and item 14 asked for `epic-1: done`.
- **The lane found more gaps (F1–F19).** The worst: a re-run of a blocked Story finds two spec files and fails (F2); no command releases a parked unit (F4); a lane-stop outcome exits 0, so launchd restarts the lane every 60 s (F10); `reconcile`'s enqueue is refused by `Protect main`'s review rule (F14); zsh heredocs fail in the sandbox (F7); 73 tests always fail inside a session (F8); and `runLaneProcess` is 1,282 lines with the session machinery inside it (F19).

A follow-up review of PRs #59, #61 and #65 (Stories 2.3–2.5) added one medium and four low findings, and decision D-R.

## 2. Impact analysis

**Epics.** No Epic is added, removed or reordered, and `.xarabot/epics.yaml` is unchanged. Epic 2 gains five Stories: 2.5a, 2.5b, 2.5c, 2.6a and 2.6b. `epics.md` now has 17 Stories in Epic 2. The `depends_on` chain is 2.5 → 2.5a → 2.5b → 2.5c → 2.6 → 2.6a → 2.6b → 2.7. `xarabot graph check` exits 0 with no warning for any Epic 2 Story.

| Epic | Stories changed | Main reasons |
|---|---|---|
| 1 | 1.20 | accepted deviation (item 34) |
| 2 | 2.3, 2.4, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12; new 2.5a, 2.5b, 2.5c, 2.6a, 2.6b | items 5–25, 26, 33; review findings; D-R |
| 3 | 3.1, 3.2, 3.3 | credential path (item 28) |
| 4 | 4.2, 4.3, 4.4, 4.5, 4.6; Epic 4 notes | items 30, 31, 32 |
| 7 | 7.3 | credential path (item 28) |

**Requirements inventory** in `epics.md`: FR18 (agent config list), AR1, AR2, AR3, AR4, AR6, AR8, AR10, AR11, AR13, AR14, AR15, AR16, AR18, AR21, AR25, AR29, AR31, AR33, AR34, AR37, and the test strategy line on sandbox suites.

**Artifact conflicts.**
- **SPEC** (stands in for the PRD). Item 2 first conflicted with CAP-13 ("no admin, bypass or approve rights"); the chosen option, code-owner review, removes that conflict. SPEC still needs edits through `bmad-spec`, listed in section 5.
- **Architecture spine.** Affected: the Ports table, AD-1, AD-2, AD-3, AD-5, AD-7, AD-9, AD-10, AD-12, AD-13, AD-14, AD-15, AD-16, AD-17, AD-20, AD-22, AD-24, AD-25, AD-26, AD-28, AD-30, AD-32, AD-33, the Consistency Conventions and the Structural Seed (one diagram line and the host layout). AD-5's record fields grow (`approved_graph`, `retro_result`, the `readiness` cause), which needs ledger `schema_version` bumps in Stories 2.7 and 2.8. AD-7's rows gain causes but keep their outcomes, and the state diagram changes in one line only (`released --> [*]` also covers superseded planning records).
- **`AGENTS.md`.** "The bot's PRs always need the Maintainer's approval" contradicted #63's exemption for `reconcile` PRs. The Maintainer asked for the one Policy wording change.
- **UX.** None exists, so N/A.

**Technical impact.** All code changes go to the new Stories and to Stories not yet built. Merged Stories keep their code; where a merged Story's AC is superseded (2.3's spec exception, 2.4's checkpoint position), the new Story or the later one carries the change.

## 3. Recommended approach

**Direct adjustment, with five inserted Stories.** Edit the spine, the requirements inventory and the Story ACs in place, and add the new Stories as AD-3's new bootstrap write 4: in one Maintainer correct-course PR, each new Story's `epics.md` section, manifest and `sprint-status.yaml` key (`backlog`), gated by `xarabot graph check`.

| New Story | Content (items) | `depends_on` | Lands before |
|---|---|---|---|
| 2.5a Resuming a blocked Story | 5 (F2, R8), 6 (F3), 7 (F6 text, C6, retro 8b, the text cap of retro 3); the review findings; D-R | 2.5 | 2.6's re-run |
| 2.5b Host rulings and lane-stop exits | 8 (F4), 9 (F10, retro 3) | 2.5a | the next park |
| 2.5c Honest sandboxed sessions | 10 (F7), 11 (F8, retro 4, A14) | 2.5b | 2.6 |
| 2.6a One session runner | 16 (F19, retro 11) | 2.6 | 2.7 |
| 2.6b Epic 1 retro fixes | 17 (retro 1, 2, 9; A2; F11, F12; the 2.1 deferral); 33's `graph check` git fix | 2.6a | 2.7 |

Changed edges: `stories/2.6.md` `depends_on: ["2.5c"]`; `stories/2.7.md` `depends_on: ["2.6b"]`.

- **Effort:** moderate. Five lane-built Stories of one unit each; the rest are AC edits to Stories not yet built.
- **Risk:** low to moderate. Every inserted Story is lane-built, in the plan and graph-checked. The live steps (section 5) are the Maintainer's.
- **Rejected:** folding every fix into 2.6, 2.7, 2.11 and 2.12 (each would go past one 6-hour unit, and the F2 fix would ride in 2.6, the Story F2 can block); Maintainer-built fixes with no Story; a rollback, since the merged Stories are sound; an MVP review, since 0.x scope stands.

**Maintainer sequence.**
1. Merge this correct course's planning PR.
2. Make the `Protect main` change (decision 2).
3. `epic-1: done` is set in this PR (item 3).
4. Tag current `main`, advance `runner_version`, then install the coordinator lane at once (item 4).
5. The lane builds 2.5a–2.5c. Story 2.6 stays parked.
6. Advance the runner again, then release 2.6 (by hand once more, or with 2.5b's `xarabot rule release`).
7. The lane builds 2.6. Advance the runner. Then come 2.6a, 2.6b, 2.7 and the rest, with an advance after 2.7, 2.8 and 2.9.

## 4. Detailed change proposals

### 4a. Decisions (Maintainer, 2026-10-24)

The Maintainer accepted the recommended option of every decision.

| # | Decision | Chosen option |
|---|---|---|
| 1 | How new Stories enter Epic 2 now | **(a)** The Maintainer adds each new Story's `epics.md` section, manifest and `sprint-status.yaml` key (`backlog`) in one correct-course PR, gated by `xarabot graph check`. AD-3 records it as bootstrap write 4, until Story 2.7's graph units run. |
| 2 | `reconcile` enqueue against `Protect main`'s review rule (F14) | **(c)** Code-owner review instead of a blanket approval: `.github/CODEOWNERS` has `* @edanisko` plus owner-less lines for `sprint-status.yaml` and `retro-gates.yaml`; `Protect main` sets required approvals to 0 and requires Code Owner review. No bypass actor, so no SPEC CAP-13 conflict. |
| 5 | Which spec file counts (F2, R8a, R8b) | **(a)** The runner picks by status. A `done` result needs exactly one `done` match; every other match must be `blocked`, is superseded and is dropped from the squash. A `blocked` result parks whatever the matches; the cross-check runs only on exactly one. |
| 6 | Keeping a blocked Story's work (F3) | **(a)** Keep it as is: wip stays on the host, never pushed, and the re-run starts fresh from `main`. The park journals the wip ref, and the runbook shows how to read it. |
| 8 | A Maintainer command to release a parked unit (F4) | **(a)** `xarabot rule release|rebuild <unit-id>`, run by the Maintainer on the host as the lane user, one fenced ledger edit. Story 4.6 reuses the edit. |
| 9 | What "stop the lane" does (F10) | **(a)** A lane-stop outcome counts as a failed start: non-zero exit, and the 3rd in a row writes STOP and posts `lane-start-failed`. Plus a Forge error kind `rejected` that fails the unit's attempt, and a `Halt` inside the usage-limit heartbeat ends the sleep. |
| 10 | zsh heredocs in the sandbox (F7) | **(a)** Add `TMPPREFIX`, set inside the session's temp folder, to the env allowlist. |
| 14 | Notifying the Maintainer of a parked PR | **(a)** No code: the Maintainer watches the repo with "All Activity" until Story 4.2's digest. |
| 15 | A blocked status planning unit (R6) | **(a)** A new runner cause `readiness`: the record parks `blocked`; no status unit is due while it stands; `release` clears it; `reconcile` deletes superseded `released` planning records. |
| 20 | A retro waits for the Maintainer's live evidence (R10.3) | **(a)** `retro:<N>` is due only once the evidence file (`live_evidence_glob`, default `docs/maintainer/evidence/epic-<N>.md`) is on `main`; until then `next` idles `waiting-on-maintainer`, and the write check refuses builder diffs to it. |
| 23 | Two processes of one lane (F9, retro 10b) | **(a)** A host-local exclusive `lane.lock`; a second process exits 0 without claiming; a dead holder's lock is taken over. |
| 29 | A macOS CI job (retro 13) | **(a)** The repo is public, so a GitHub-hosted `macos-latest` job runs `bun test test/sandbox/ test/contracts/` on every PR as a required check, once `sandbox-exec` is verified there. |
| 30 | Closing or deferring retro items (R2) | **(a)** Maintainer-only verbs `done` and `defer` on `retro-item:<id>`, through the comment ruling and `xarabot rule`; `reconcile` writes the status. |
| 31 | What the checkpoint unit does (R5) | **(a)** Drop the unit. The pure gate holds dependents and the digest lists the go; `checkpoint:<epic>` stays only as the `go` target. |
| 32 | Carrying deferrals across Stories (retro 12) | **(a)** now (each correct course sweeps merged specs' deferrals; this one did), and **(b)** in Story 4.2 (the digest lists every unclaimed `deferred` entry). |
| 33 | AD-1 and AD-2 as enforced (retro 7, D4) | **(a)** Amend AD-1: `src/lane/` may also read the clock and the filesystem; "a lint rule" becomes "a boundary test"; fix `graph check`'s git call in Story 2.6b. |
| 35 | Epic 1's human verdict | **(a)** `accepted-with-open-items`, with retro items 1–4 and 7–13 tracked as placed here. |
| D-R | Agent config paths (review of #59) | Add `CLAUDE.local.md` and `AGENTS.override.md` at any depth. |

The mechanical items (3, 4, 7, 11, 12, 13, 16, 17, 18, 19, 21, 22, 24, 25, 26, 27, 28, 34) follow from the findings with no new decision.

**Review findings (PRs #59, #61, #65), all in Story 2.5a.**
- **Medium.** The write check's `fold` uses `toLowerCase()`, but APFS folds `ſ` (U+017F) to `s`, so `.mcp.jſon` passes the check and is read as `.mcp.json`. Fix: full case folding for builder and coordinator rules, with a case row per refused class.
- **Low.** `lane-run.ts` runs the role and name check before `alertForge` is set, so the third failure writes STOP with no alert.
- **Low.** The coordinator write check ignores file mode; status files and graph inputs must be `100644`.
- **Low.** An orphan `reconcile` PR (the process died between `openPr` and the record beat) is never closed.
- **Low.** `openPr` is computed before the ledger work, so a run that just closed a PR still reports it open.

**Settled, no change:** R1 (`sweepMerged`, 1.17a); F5 (`next` sees the swept records, Story 2.2; it reaches the lane at the runner advance); R3 (the runner commits); R4 (Story 2.2's takeover and `stop --now`; runbook line added); R7 (#63, #64, #66; the remainder is items 13 and 18); R8c (accepted cost); R9 (absent `retro-gates.yaml` reads empty; the remainder is item 21); R11(2) (the Standing Authority covers the 2.5–2.6 window); retro items 5, 6 and 10a; F18's coordinator half; spec-2-4's deferral (#62). Deferred unchanged: A9–A12, C4, C5, C7, C8, C9, C11, C12, C13, C15, E5, and spec-2-5's "a persistent `reconcile` failure repeats with no alert".

### 4b. Architecture spine

File: `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md` (`updated: 2026-10-24`).

| Section | Change | Item |
|---|---|---|
| Ports table, `Forge` | `snapshot()`'s `read` filter and `blob_shas`; `listPrsByBranch`, `branchHead` (2.6b), `reviews` (2.6), `enqueue(pr, expectedHead)`, `queueState` | 12, 17, 34 |
| AD-1 | `src/lane/` may also read the clock and the filesystem | 33 |
| AD-2 | `lane.lock`; the coordinator waits 10 min after idle | 23, 13 |
| AD-3 | bootstrap write 4; `released` records also written by the Maintainer's `xarabot rule` | 1, 8 |
| AD-5 | fields `approved_graph`, `retro_result`; cause `readiness`; superseded planning records deleted | 19, 15 |
| AD-7 | blocked row gains `readiness`; crash row gains a forge `rejected` error | 15, 9 |
| AD-9 | `checkpoint` is no longer a one-shot unit; done-on-`main` for `reconcile`, status and graph planning units | 31, 13 |
| AD-10 | the spec file is the single `done` match; `blocked` matches are superseded | 5 |
| AD-12 | `in-progress` not written in 0.x; `reconcile` writes `deferred` and `done` | 22, 30 |
| AD-13 | no checkpoint unit globs; status-planning exception to approval-gated PRs; planning held by a `readiness` park; retro due on live evidence; "6. Checkpoint" removed | 31, 18, 15, 20 |
| AD-14 | the cross-check and the invalid rule follow AD-10 | 5 |
| AD-15 | the sanitizer redacts credentials and caps text | 7 |
| AD-16 | `reconcile` PRs are closed and replaced, not regenerated; "(below)" → "(above)" | 13 |
| AD-17 | "a boundary test"; `TMPPREFIX` on the allowlist | 33, 10 |
| AD-20 | `live_evidence_glob`; an absent `retro-gates.yaml` reads as empty; `**/AGENTS.override.md`, `**/CLAUDE.local.md` | 20, 21, D-R |
| AD-22 | the start-time check is `ps -o lstart` against the PID file's mtime | 34 |
| AD-24 | `waiting-on-maintainer` includes an Epic's live evidence | 20 |
| AD-25 | install prints the `sudo` commands; `runner_version` read through the snapshot | 34 |
| AD-26 | `contents` row: `branchHead`; `pull_requests` row: review reads | 17, 12 |
| AD-28 | verbs `done` and `defer` (Maintainer only); `xarabot rule` applies `release` and `rebuild` from 0.x | 30, 8 |
| AD-30 | builders refused the evidence files; the spec exception after superseded matches are dropped | 20, 5 |
| AD-32 | kind `rejected`; a lane stop counts as a failed start | 9 |
| AD-33 | a lane-stop outcome counts as a failed start; Xarabot's repo uses code-owner review | 9, 2 |
| Conventions, Tests | sandboxed sessions also skip cases that bind sockets or need denied access | 11 |
| Structural Seed | `released --> [*]` covers planning records; `lane.lock` in the host layout | 15, 23 |

### 4c. Epics and Stories

File: `_bmad-output/planning-artifacts/epics.md`.

- **Requirements inventory:** FR18 (D-R); AR1 (12, 17, 34); AR2 (33); AR3 (23, 13); AR4 (1, 8); AR6 (15, 19); AR8 (9, 15); AR10 (31); AR11 (5); AR13 (22, 30); AR14 (15, 18, 20, 31); AR15 (5); AR16 (7); AR18 (10, 33); AR21 (20, 21, D-R); AR25 (20); AR29 (8, 30); AR31 (5, 20); AR33 (9); AR34 (2, 9); AR37 (23). The test strategy line on sandbox suites (11).
- **Epic 2 intro:** names the inserted Stories and the chain.
- **New Stories:** 2.5a, 2.5b, 2.5c (after 2.5), 2.6a, 2.6b (after 2.6), each with As-a/I-want/So-that and Given/When/Then ACs.
- **Story 1.20:** the canary is an in-process `laneRun` as `builder-1` (34).
- **Story 2.3:** the spec exception follows AR11 (5).
- **Story 2.4:** the coordinator case table no longer waits for 4.4 (31).
- **Story 2.6:** `Forge.reviews(pr)`, and "after the park" reads the parked record's `heartbeat_at` (12).
- **Story 2.7:** the `readiness` park, hold and release, with a `schema_version` bump and case rows (15).
- **Story 2.8:** `approved_graph` stored in the record, with a `schema_version` bump (19).
- **Story 2.9:** `retro_result`; the live-evidence gate and `live_evidence_glob`; prefetched PRs; `reconcile` creates `retro-gates.yaml` (19, 20, 21).
- **Story 2.10:** a retro-item session returns a `build` result; `in-progress` not written (22).
- **Story 2.11:** `lane.lock`; `builder-<n>` names; tool checks on the plist `PATH`; a commit conflict is a CI fix (23, 24, 25).
- **Story 2.12:** the `lane.lock` case; the `bun install --frozen-lockfile` live case; evidence rows; the evidence file (23, 26, 20).
- **Stories 3.1, 3.2, 3.3, 7.3:** `vendors/<vendor>/` (28).
- **Epic 4 notes; Stories 4.2, 4.3, 4.4, 4.5, 4.6:** deferrals in the digest (32); `done` and `defer` (30); no checkpoint unit (31).

### 4d. Runbook

File: `docs/maintainer/self-host.md`.

- Step 1: the macOS CI job (29).
- The canary: `edanisko/xarabot-canary` → `xaravel/xarabot-scratch` (26).
- Step 13: the `PATH` prefix for `lane install` (24).
- Step 15: watch the repo with "All Activity" (14).
- "While Epic 2 is built": when to advance the runner (4); the coordinator install order, with the `Protect main` change first and the install at once (2, 4); "`reconcile` PRs and `Protect main`", with the CODEOWNERS file, the ruleset change and the verify commands (2); hand edits wording (13); a crashed lane (27); recovering a blocked Story's work (6).

### 4e. Manifests, sprint status and other files

- `stories/2.5a.md`, `2.5b.md`, `2.5c.md`, `2.6a.md`, `2.6b.md`: new, with the Epic 2 globs and the chain above.
- `stories/2.6.md` → `depends_on: ["2.5c"]`; `stories/2.7.md` → `depends_on: ["2.6b"]`.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`: `epic-1: done`; new keys `2-5a-resuming-a-blocked-story`, `2-5b-host-rulings-and-lane-stop-exits`, `2-5c-honest-sandboxed-sessions`, `2-6a-one-session-runner`, `2-6b-epic-1-retro-fixes`, all `backlog`, in order. 2-1…2-5 stay for `reconcile`.
- `AGENTS.md` Policy: "the bot's PRs always need the Maintainer's approval, except runner-written `reconcile` PRs, which touch only the status files (Standing Authority)" (2; the Maintainer's request).
- `_bmad-output/implementation-artifacts/epic-1-retro-2026-10-23.md`: a "Human decision" section, `accepted-with-open-items` (35).

## 5. Implementation handoff

**Scope: moderate.** Five new Stories, AC edits to Stories not yet built, and Maintainer live steps.

| Work | Who | How |
|---|---|---|
| Stories 2.5a, 2.5b, 2.5c, 2.6a, 2.6b and the changed ACs | the lane | built from `next` in the chain above |
| This proposal's planning edits | the Maintainer | one planning PR, checked with `bun src/cli/main.ts graph check` |
| SPEC edits | `bmad-spec`, per AGENTS.md | listed below |
| `.github/CODEOWNERS` and the `Protect main` change (decision 2) | the Maintainer | a Maintainer `.github/` PR and the ruleset settings, then the verify commands in the runbook |
| The macOS CI job (decision 29) | the Maintainer | a Maintainer `.github/` PR, `self-host.md` step 1 |
| The runner advance and the coordinator install order (item 4) | the Maintainer | `self-host.md`, "While Epic 2 is built" |
| `epic-1: done` | the Maintainer | in this PR (item 3) |
| Confirm that the admin-bypass merges of PRs #21 and #23–#28 were intended (retro E1) | the Maintainer | a note on the retro, or a reply on the PR |

**SPEC edits still needed, through `bmad-spec`:**
- Write authority (SPEC:175-178): bootstrap write 4 (item 1), and the Maintainer's Epic 1 retro write (#53, item 34).
- CAP-18 write check (SPEC:105): `AGENTS.override.md`, `CLAUDE.md` and `CLAUDE.local.md` in the agent config list (D-R); the spec-file exception as the `done` match (item 5).
- SPEC:220: delete the merge-queue permission item, settled by AR38 (item 34).

**Success criteria.**
- `bun src/cli/main.ts graph check` exits 0, lists Epic 2's 17 Stories, and warns for no Epic 2 Story.
- `bun test test/cli/graph-check.test.ts` passes.
- After the `Protect main` change, the first `reconcile` PR merges with no review.
- Story 2.6, re-run after 2.5a–2.5c are in the runner, does not park on two spec matches.
