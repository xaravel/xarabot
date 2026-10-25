---
title: Sprint Change Proposal, Epic 2 retro item 7
date: 2026-10-25
status: approved (Maintainer, 2026-10-25)
approved_by: edanisko
approved_at: '2026-10-25'
trigger: Epic 2 retro (`epic-2-retro-2026-10-25.md`) item 7 (A6–A9, E1, open questions); the Epic 2 follow-up reviews; the codex AR42 spike (`notes/codex-ar42-spike-2026-10-25.md`); Story 3.2's escalation (stock pi 1.4.0 gives `bmad-build-auto` no subagents) and the Maintainer's decision to defer the pi adapter for 0.x
mode: batch
scope: moderate
edits: SPEC and companions (through `bmad-spec`), spine, epics (requirements inventory, Epic 2 notes, Stories 2.4, 3.1–3.6, 4.2, 7.5), manifests (3.2, 3.3, 7.3), `retro-gates.yaml` (new lane items 20–25; item 7 done)
---

# Sprint Change Proposal: Epic 2 retro item 7

## Approval (Maintainer, 2026-10-25)

Ed approved this proposal as recommended, with the specifics below. This file records the approved form: C6 and every edit that depends on it (P17, P22, E7 and item 12 in 4g) carry the hash rule, not the commit-time rule of the draft.

- **Q1, Q2, Q3 and Q5:** yes, as recommended. Q2 brings ledger `schema_version` 5 and a new `parked → parked` edge in the spine's normative state diagram.
- **Q4:** no change. Keep closing an approved `reconcile` PR that the runner failed to enqueue, and record the rule.
- **C1–C8:** as recommended, except C6, which changes to the hash rule:
  - When a status planning unit compiles `epic-<N>-context.md`, it writes a header line `<!-- source: sha256:<hex> -->`. The hex is the SHA-256 of Epic N's own section of `epics.md`, from its `## Epic <N>:` heading up to the next `## Epic` heading, text as on `main`.
  - Each coordinator round, `planningDue` recomputes that hash from the snapshot's `epics.md` text. The snapshot already reads both files, so no commit-history reads and no snapshot schema change are needed.
  - Correction (2026-10-25, when applying): the snapshot keeps only an `epic_context` state per Epic, not `epics.md`'s text. So the snapshot builder (`src/core/next/snapshot.ts`) computes the hash and reports a new in-memory `epic_context` state `stale`, which `planningDue` treats as due. That adds one value to the in-memory snapshot type (`src/core/schemas/snapshot.ts`, now in item 12's globs), with no ledger or stored schema change. The source line goes directly below the `# Epic <N> Context:` heading, so the context stays valid, and the last Epic's section runs to the end of the file.
  - A mismatch, or a missing source line, means the context is stale. A status planning unit is then due for an Epic with unfinished Stories. This extends Story 2.7's missing-or-invalid rule and does not replace it.
  - Item 12 then becomes `route: lane`, with globs for `coordinator.ts` and `next`, the planning step and prompt, and their tests. It needs no snapshot schema or forge adapter globs.
- **C9:** stays an open question to the Maintainer, with no plan change.

## 1. Issue summary

Epic 2 is done (17 of 17 Stories). Its retro was `rejected` on narrow grounds, and the Maintainer recorded the go (`retro-gates.yaml`, 2026-10-25T18:19Z). Items 1–6, 8–11 and 13 are done. Item 7 asks for this correct course. Five inputs feed it:

- **Drift (A7, A8).** Merged code reinterprets some ACs in small ways (A6, A7). The spine, SPEC and glossary lag the Epic 2 decisions, including three made today: the field-level status-file rules (AR31), approvals acted on in the next round (Story 2.4 amendment) and the evidence-contents gate (item 14).
- **Deferrals with no receiving Story (A9, A3–A5).** These are the committed-content credential scan, branch cleanup for closed `reconcile` PRs, 2.5c's host-only sandbox paths, 2.7's four mediums, 2.8's `approved_graph` timing and gate scope, and AR10's cross-owner close.
- **Follow-up reviews.** The six missing reviews ran: no high findings, three mediums, now lane items 17–19. Nine low findings and five decision points remain. The Maintainer decided that a spec's `followup_review_recommended: true` triggers another review pass before the PR parks, to be built in Epic 3 (E1).
- **Codex spike.** `codex exec` runs subagents (observed), so Story 3.1 proceeds. Four open points need a home in 3.1's ACs: the forced attribution trailer, closed stdin, one unidentified host, and `resets_at` as the reset source.
- **pi.** Story 3.2 parked `blocked` (`escalation`, ledger `story:3.2`, generation 1, no PR): stock pi 1.4.0 gives `bmad-build-auto` no subagents. The Maintainer decided to defer the pi adapter for 0.x.

## 2. Impact analysis

**Epics.**

| Epic | Change |
|---|---|
| 2 (done) | Accepted deviations recorded; two stale clauses in Story 2.4 fixed |
| 3 | pi removed from 0.x scope; Story 3.2 rewritten as the pi deferral; 3.1 takes the spike results; 3.3 drops pi; 3.4 and 3.5 add the follow-up review pass; 3.6 drops pi and gains three switch items |
| 4 | Story 4.2: a park carries its text, so readiness findings reach the inbox |
| 5, 6 | none |
| 7 | Story 7.3 loses its 3.2 edge; Story 7.5 gains the one-owner guard (confirm C5) |

**No Epic is added, removed or reordered, and no Story id is removed or renumbered** in the recommended option. Two manifest `depends_on` edits and one manifest title and globs edit change the graph inputs (section 4f).

**Artifact conflicts.**
- **SPEC (stands in for the PRD).** The pi deferral changes 0.x scope: CAP-7, the Self-host success signal, the same-vendor assumption, `releases.md` and `agent-adapters.md` all name pi for 0.x. These need `bmad-spec`. So do SPEC's lags: write authority, `reconcile`, the live-evidence gate, the co-author rule, the follow-up pass and the stale "still open" list. The glossary needs `bmad-spec` too.
- **Spine.** 22 edits across the Ports table, AD-3, AD-5, AD-6, AD-7, AD-9, AD-11, AD-13, AD-15, AD-16, AD-17, AD-19, AD-20, AD-21, AD-27, AD-30, the Conventions, the Stack, the state diagram and Deferred.
- **UX.** None exists, so N/A.
- **AGENTS.md.** No change. #129 already allows GitHub's bot squash trailer.

**Technical impact.** No merged code is reverted. All code changes go to Stories not yet built (3.1–3.6, 4.2, 7.5) and to six new lane retro items (20–25). The ledger gains fields in two places (Story 4.2's `park.text`; item 24's posted graph hash), and each bumps the ledger `schema_version` past 4 (item 24's to 5, Q2).

## 3. Recommended approach

**Direct adjustment.** Edit the plan in place. Route each small, local fix to a lane retro item, as was done with items 13–19, and each Epic-sized fix to a Story not yet built. Rewrite Story 3.2 rather than remove it.

- **Why not remove Story 3.2.** AD-11's "fixed once used" rule forbids removing a Story id that has a ledger record in any state, and `story:3.2` has one, parked. Removal would need a graph PR, the Maintainer's hand deletion of the ledger record (no command deletes a parked record) and removal of the `sprint-status.yaml` key. A rewritten 3.2 keeps the graph, lets Epic 3 finish and makes `agent: pi` refuse clearly instead of failing later.
- **Effort:** moderate. Six small lane items, about one unit each. Story 3.2 becomes smaller. Stories 3.1, 3.3–3.6, 4.2 and 7.5 change in scope by a few ACs each.
- **Risk:** low. The one behaviour added to the review gate (the follow-up pass) adds a session; it removes no check.
- **Rejected:** a rollback (merged code is sound; the findings are fixed forward); an MVP review beyond pi (0.x scope otherwise stands).

**Maintainer sequence.**
1. Answer section 4a's questions and section 4b's confirmations.
2. Apply the SPEC edits (4c) through `bmad-spec`, in one PR.
3. Apply the spine, epics, manifest and `retro-gates.yaml` edits (4d–4g) in one planning PR. Check it with `bun src/cli/main.ts graph check`, and mark item 7 `done` in the same PR.
4. Run `xarabot rule release story:3.2` so the lane rebuilds 3.2 under its new ACs. Release `story:3.1` too if it is parked by then (it is `released` now).

## 4. Detailed change proposals

### 4a. Decisions needed (from the follow-up reviews)

| # | Question | Recommended answer |
|---|---|---|
| Q1 | **2.8 F2.** A Maintainer approval given before the runner posted the graph delta (for example, during CI) counts today. Should a graph-change park set a park time, so that only a later review counts? | **Yes.** Apply 2.6's after-park rule to every graph-change park: only an approval submitted after the delta comment counts. The approval then always follows a delta the Maintainer could read. |
| Q2 | **2.8 F3.** When the owner is the Maintainer and the gate's answer changes between the park and the take, the PR is taken with no delta ever posted. Require an approval after a runner-posted delta comment? | **Yes.** Store the hash of the posted delta in the park (a new park field, ledger `schema_version` + 1). At the take, if the gate's current hash differs from the posted one, or none was posted, re-park, post the new delta and wait for a later approval. This also closes spec-2-8's deferral (an approval bound to the take, not to the posted delta). It needs a new `parked → parked` edge in the spine's normative diagram. |
| Q3 | **2.8 F4 (race).** Reviews are read at `reconcile-step.ts:637`, but the re-park stamps `heartbeat_at` later (`:344`), so an approval given in that gap is ignored. Use the reviews' read time as the park time? | **Yes.** Stamp the re-park with the forge `now` of the snapshot taken before the reviews are read, never a later time. |
| Q4 | **2.5 F2.** An approved `reconcile` PR that the runner failed to enqueue is closed on the next run, and its approval is lost. Route such records through item 3's re-enqueue path instead? | **No; keep closing it and record the rule.** `reconcile` PRs need no approval: they are exempt from `owner_approval_paths`, and the status files have no code owner. Closing one costs a CI run, not a human step. Item 21 states the rule in a test, and the spine says so (AD-7). |
| Q5 | **2.4 design note.** Coordinator-unit ledger edits are fenced only by the unit's generation, not by `coordinator.json`'s, so a coordinator that lost its claim acts until its next beat. Also fence those edits on `coordinator.json`'s holder and generation? | **Yes.** Every swap re-checks its preconditions against the tip, so the same pure edit can also require `coordinator.json`'s holder and generation unchanged, at no extra forge call. Built in item 22, with 2.4 F1 and F2. |

### 4b. Other confirmations this proposal needs

| # | Point | Recommendation |
|---|---|---|
| C1 | Story 3.2's disposition | Rewrite it as the pi deferral (4e). Removal is the alternative; it needs a graph PR the Maintainer approves, plus hand removal of the `story:3.2` ledger record and its sprint-status key (section 3). |
| C2 | Where pi goes in `releases.md` | v1, beside CAP-14: SPEC's v1 success signal already names "a `codex` or `pi` lane". |
| C3 | The committed-content credential scan (2.5a, medium; the spec says it needs a decision) | A new write-check class, `credential`: refuse any added or changed blob that contains the seeded vendor credential or a string the sanitizer would redact as token-shaped. The refusal names the path only, never the match. Item 20. |
| C4 | The planning attempts cap across runs (A4; the spec says it needs a decision) | A new planning record starts with the `attempts` of the newest `released` record of its kind (status or graph), so the 3rd failed run in a row parks `attempts-cap`. A `done` or `nothing-due` run resets the count. Item 25. |
| C5 | AR10's cross-owner close (spec-2-2: "one owner per repo holds until Epic 5") | 0.x stays one owner per repo. Story 7.5's lane start refuses while the ledger holds a live record of another owner. Close-and-reopen stays v1 (AD-9). |
| C6 | Item 12: re-plan a stale Epic context (open, routed to the Maintainer) | **Approved as the hash rule (Maintainer, 2026-10-25; replaces the draft's commit-time rule).** When a status planning unit compiles `epic-<N>-context.md`, it writes a header line `<!-- source: sha256:<hex> -->`: the SHA-256 of Epic N's own section of `epics.md`, from its `## Epic <N>:` heading up to the next `## Epic` heading, text as on `main`. Each coordinator round, `planningDue` recomputes that hash from the snapshot's `epics.md` text; the snapshot already reads both files, so there are no commit-history reads and no snapshot schema change. A mismatch, or a missing source line, means the context is stale, and a status planning unit is due for an Epic with unfinished Stories whose context is stale. That extends Story 2.7's missing-or-invalid rule and does not replace it. Item 12 becomes `route: lane` with globs for `src/core/next/**` (`coordinator.ts`, `next`), the planning step and prompt, and their tests; no snapshot schema or forge adapter globs. |
| C7 | The follow-up pass mechanics (E1, decided rule) | Every review round of a flagged Story runs two passes. This needs no record field. The other option, one pass per unit, needs a field and a schema bump. |
| C8 | Codex token refresh (spike Q6, unverified) | A live case in Story 3.1 records whether a session rewrites `auth.json`. If it does, the lane journals it and the Maintainer decides any write-back. The lane never copies a session-written credential back without that decision. |
| C9 | Retro open question 6, carried from Epic 1 item 14 | Were PRs #21 and #23–#28 an intended use of the admin bypass? A reply on the retro is enough; there is no plan change. **Answered by the Maintainer, 2026-10-25: yes, intended during the bootstrap** (Stories 1.1–1.7, merged by hand before the approval rule existed). No change. |

### 4c. SPEC and companions (through `bmad-spec`)

Every edit here is a **SPEC update**.

| # | Where | Old | New | Why |
|---|---|---|---|---|
| S1 | SPEC CAP-7 intent | "Each lane runs its coding agent through an adapter: `claude`, `codex` or `pi`." … "`claude` and `codex` default to a top model; a `pi` lane sets its model explicitly." | "Each lane runs its coding agent through an adapter: `claude` or `codex` (0.x); `pi` follows in v1." … "`claude` and `codex` default to a top model." | pi deferred |
| S2 | SPEC CAP-7 success | "A `claude` or `codex` lane with no `model` set runs its adapter's default top model; a `pi` lane with no `model` refuses to start." | "A `claude` or `codex` lane with no `model` set runs its adapter's default top model; a lane with `agent: pi` refuses to start in 0.x, naming the deferral." | pi deferred |
| S3 | SPEC CAP-8 intent, after "re-runs it." | — | add: "When the Story's spec recommends a follow-up review, a second review pass runs on the same commit before the PR parks or is enqueued, under the same rules. Runner-written `reconcile` PRs carry no agent change and get no review." | E1 decision; A8 (`reconcile`) |
| S4 | SPEC § Constraints, Models | "`claude` and `codex` default to a top model and `pi` lanes name theirs" | "`claude` and `codex` default to a top model" | pi deferred |
| S5 | SPEC § Constraints, No co-author markers | "no `Co-Authored-By` trailers or similar non-authoritative markers. The bot account is the only marker of lane-made work." | add: "The `Co-authored-by: <login>-xarabot[bot]` trailer that GitHub's squash merge adds itself is that marker, and is allowed (Maintainer, 2026-10-25)." | E7, item 9 |
| S6 | SPEC § Operating limits, Write authority (line 175) | "the coordinator lane is the only writer of `sprint-status.yaml` and `retro-gates.yaml`; the 0.x write check (CAP-18) enforces it on builder diffs." | "the coordinator lane is the only writer of `sprint-status.yaml` and `retro-gates.yaml`. Its runner-code unit, `reconcile`, alone sets a Story's or an Epic's (`epic-<N>`) status to `done`, writes retro verdicts and items, and opens PRs that are exempt from owner approval (Standing Authority). Its sessions are held to field rules: status planning only adds missing keys; a retro only appends its Epic's `action_items` and sets its own retro key. The 0.x write check (CAP-18) enforces all of this, on builder and coordinator diffs." | A8; AR31; item 16 |
| S7 | SPEC § Operating limits, new bullet | — | "**Live evidence:** an Epic's retro runs only once the Maintainer's live evidence file is on `main` and, for each live command config lists for that Epic (`live_evidence_checks`), holds that command and a passing result." | A8; item 14 |
| S8 | SPEC § Success signal, Self-host | "(the `codex` and `pi` adapters, the TUI, claims and parallel lanes)" | "(the `codex` adapter, the TUI, claims and parallel lanes)" | pi deferred |
| S9 | SPEC § Assumptions, Same-vendor reviewer | "…the first allowed adapter of `claude`, `codex`; with neither allowed (a pi-only repo), a `pi` session on the builder's model. Confirmed by the Maintainer (2026-10-21); pi as a reviewer is revisited for v1." | "…the first allowed adapter of `claude`, `codex`. A repo that allows neither has no reviewer, and its lanes refuse to start (0.x has no `pi` adapter). pi as a builder and a reviewer comes with the v1 adapter." | pi deferred |
| S10 | SPEC § Assumptions, Still open | the adapter-spikes bullet and "AD-17's two assumptions" bullet | "the `codex` adapter's outcome mapping, confirmed in Story 3.1 (the spike settled subagents, resume and usage: `notes/codex-ar42-spike-2026-10-25.md`)". Delete the pi items (deferred), the `claude` items (settled in Story 1.14) and the proxy allowlist (proven in Story 1.12). | A8 |
| S11 | `agent-adapters.md` table | `pi` row: status `0.x` | status `v1 (deferred 2026-10-25: stock pi 1.4.0 gives bmad-build-auto no subagents)` | pi deferred |
| S12 | `agent-adapters.md` table, `codex` row | "`codex exec -m <model> --json -c model_reasoning_effort=<effort>`, with the skills exposed through `.agents/skills`." | add: "`--dangerously-bypass-approvals-and-sandbox` inside Xarabot's sandbox, a private `CODEX_HOME`, closed stdin; usage, model and the reset time come from the session file under `CODEX_HOME`." | spike |
| S13 | `agent-adapters.md`, Credentials and CLI versions | "for `codex`, its auth file or API key; for `pi`, the OpenRouter key" … "pi 1.3.0" | "for `codex`, its `auth.json` (ChatGPT login) or an API key passed as `CODEX_API_KEY`" (the pi clause and pi's version go to a "v1" note) | spike Q6; pi |
| S14 | `agent-adapters.md` § Model and effort, § Cross-vendor review | the `pi` column; rows "`pi` with an Anthropic model" and "`pi` with any other vendor's model"; "with neither allowed, a `pi` session on the builder's model" | drop them for 0.x; add the note "pi rows return with the v1 adapter" | pi deferred |
| S15 | `releases.md` | 0.x row "CAP-7 (`claude`, `codex` and `pi`, with the common `model` and `effort` settings)"; note "**CAP-7 and CAP-12** are in 0.x: all three adapters…"; note "**CAP-8** is in 0.x because `codex` and `pi` lanes ship there" | 0.x row "CAP-7 (`claude` and `codex`…)"; v1 row adds "CAP-7 (`pi` adapter)"; the notes say "`claude` and `codex`; `pi` moved to v1 (Maintainer, 2026-10-25, Story 3.2's escalation)" and "because `codex` lanes ship there" | pi deferred; C2 |
| S16 | glossary, Unit | "a Story, a retro, a retro action item, a planning step, or a checkpoint record." | "a Story, a retro, a retro action item, a planning step or a `reconcile` run. A checkpoint is only the target of a `go` ruling." | A8 |
| S17 | glossary, Write check | "refuses a builder diff touching coordinator-owned files, manifests, agent config or Protected Paths before the squash (CAP-18)." | "refuses, before the squash, a builder diff touching coordinator-owned files, manifests, agent config or Protected Paths, and a coordinator diff outside its unit's paths or its status-file field rules (CAP-18)." | A8; AR31 |
| S18 | glossary, new term | — | "**`reconcile`:** the coordinator's runner-code unit. It records merges, marks units and Epics done, writes retro gates, applies rulings and enqueues approved PRs. Its PRs carry only runner-written content, get no agent review and need no owner approval." | A8 |

### 4d. Architecture spine

File: `architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`. Set `updated: '2026-10-25'`. No spine edit needs a SPEC change beyond 4c.

| # | Section | Old | New | Source |
|---|---|---|---|---|
| P1 | Ports, `Agent` | "`parseUsage(output)`" | "`parseUsage(output, vendorHome)`, which may also read the CLI's session files in the lane's vendor home before it is re-seeded (codex: model, rate limits and `resets_at` are only there)" | spike Q4 |
| P2 | Ports, `Forge` | "`snapshot()` returns the ledger tip, `main` SHA, PR states and the server's `now`" … "`dequeue`" | "…PR states, each parked PR's review decision (item 13)…"; add "`deleteBranch(branch)` for closed `reconcile` and disposable planning PRs (item 21)" | item 13; A9 |
| P3 | AD-3 table, "Epic and Story planned or done" | "coordinator (its own PRs): a status planning unit, or `reconcile` marking units done and writing a merged graph planning unit's status entries (AD-13)" | "coordinator (its own PRs): a status planning unit, which only adds missing keys; a retro unit, which only appends its Epic's `action_items` and sets its own `epic-<N>-retrospective` key; or `reconcile`'s runner code, which alone sets a Story or an Epic (`epic-<N>`, once all its Stories are `done`) to `done`, and writes the status entries of a merged graph planning unit (AD-13, AD-30)" | AR31; item 16 |
| P4 | AD-3 table, "Ledger records in `released`" | "…or the Maintainer's `xarabot rule` on the host, applying a ruling (AD-28)" | add: "`xarabot rule` writes as the coordinator lane identity for a non-Story unit" | A7 |
| P5 | AD-5 `reason` | "`readiness` (a status planning unit's `planning` result `blocked`, Story 2.7)" | "`readiness` (a planning unit's `planning` result `blocked`, status or graph, Story 2.7)". Add the fields "`park.text`, a sanitized, capped reason text for an inbox item (Story 4.2)" and "`park.graph_posted`, the hash of the delta the runner last posted (item 24)". | 2.7 decision; A3; Q2 |
| P6 | AD-5, Unknown schema | — | add: "The ledger `schema_version` was 4 at the end of Epic 2 (2.7, 2.8 and 2.9 each bumped it); it is a ledger-only constant." | A7 |
| P7 | AD-6 | "A heartbeat runs every 5 minutes…" | add: "A lane releases its own unit about 2 minutes before its heartbeat would lapse (Story 2.1's margin). A coordinator unit's fence also requires `coordinator.json`'s holder and generation unchanged (Q5)." | A7; Q5 |
| P8 | AD-6 | "Pushes use `--force-with-lease` against the record's `head_sha`." | add: "The first push of a unit leases against `branchHead` read at that push (Story 2.6b)." | A7 |
| P9 | AD-7, coordinator-held records (line 198) | "`reconcile` takes it again only for an approval submitted after the park, on the current head." | "`reconcile` takes it again only for an approval submitted after this re-park, on the current head. A builder's first park counts any approval from the owner on the current head (Story 2.6). A graph-change park counts only an approval submitted after the runner posted its delta (Q1)." | 2.6; Q1 |
| P10 | AD-7, line 199 | "**`reconcile`'s own PR**: it holds only runner-written content, so it is disposable." | "**`reconcile`'s own PR, and an ungated status planning PR** (Story 2.7): each is disposable." Add: "A `reconcile` PR the runner failed to enqueue is closed and replaced the same way (Q4). A planning PR whose CI fails parks `blocked` (`verification`) with no agent fix." | 2.7 decisions; Q4 |
| P11 | AD-9 and Conventions, unit ids | "`planning:<slug>.<n>`" | "`planning:status.<n>` and `planning:graph.<n>`, with `n` one more than the highest of that slug on the ledger" | 2.7 decision |
| P12 | AD-9, Cross-owner takeover | "**Cross-owner takeover (v1).**" | add before it: "**One owner per repo (0.x).** A lane refuses to start while the ledger holds a live record of another owner (Story 7.5)." | C5 |
| P13 | AD-11 (line 289) | "A PR whose merge result changes the resolved graph, whatever files it touches, takes `xarabot:graph`…" | add: "In 0.x the gate runs at the builder merge step, the graph planning step and `reconcile`'s take. Status planning and `reconcile` PRs cannot touch graph inputs (AD-30). A stale `merging` takeover was gated before its enqueue, and human-authored PRs wait for CAP-19 (Deferred)." | A5, accepted |
| P14 | AD-11 (line 293) | "When the Maintainer approves, the runner records `approved_graph`…" | "At `reconcile`'s take of the approved PR, the runner records `approved_graph`… A re-take at a different hash voids the approval (item 17). The posted hash binds the approval: a take whose current hash differs from `park.graph_posted` re-parks, posts the new delta and waits for a later approval (Q2)." | A5; item 17; Q2 |
| P15 | AD-13, status planning unit | "It holds `sprint-status.yaml`, `retro-gates.yaml` and the configured Epic context path (`epic-<N>-context.md`)." | "…and every Epic's context path (the `epic_context_path` pattern for any `<N>`, Story 2.4)." | A7 |
| P16 | AD-13, coordinator order step 1 | "1. `reconcile`:" | add: "It is due when the snapshot shows `reconcile` work (a record not `merged` whose PR merged; a `merged` record done on `main`; a PR parked `awaiting-approval` that the Maintainer approved at the parked head, read from the snapshot's own review decision; the digest time passed, from Story 4.2) or 10 minutes after the last run (Stories 2.4 and 2.5; amended 2026-10-25)." | 2.4 amendment |
| P17 | AD-13, steps 3 and 4 | "no status unit is due while a `parked` (`readiness`) planning record exists." / "due once the Epic's live evidence file … is on `main`" | "no planning unit of a kind (status or graph) is due while a planning record of that kind is parked `blocked` for any reason. A status unit is also due for an Epic with unfinished Stories whose context is stale: its `<!-- source: sha256:<hex> -->` line is missing or differs from the SHA-256 of the Epic's own `epics.md` section on `main` (C6). A status planning unit writes that line when it compiles the file." / "due once the Epic's live evidence file is on `main` and, for each command `live_evidence_checks` lists for the Epic, holds that command and a `bun test` summary with `0 fail`" | 2.7 decision; C6; item 14 |
| P18 | AD-15, Prevents | "wrong authors and co-author trailers;" | add: "GitHub's own squash trailer naming the bot is allowed (Maintainer, 2026-10-25)." | E7 |
| P19 | AD-16 | "with neither allowed, a `pi` session on the builder's model. … pi as a reviewer is revisited for v1." / "pi lanes must set `model` explicitly." | "With neither allowed, there is no reviewer and the lane refuses to start (AD-21); pi returns with its v1 adapter." Delete the "pi lanes" line. Add: "**Follow-up pass.** When the Story's spec file at `head_sha` has `followup_review_recommended: true`, each review round runs a second session on the same checkout, prompted with the spec's named unverified risks. `passed_sha` is set only when both passes have no blocking findings; findings from either are loopbacks (Story 3.5)." | pi; E1 |
| P20 | AD-17 | "`[ASSUMPTION: pi's directory override is confirmed in the pi adapter Story]`" / "`[ASSUMPTION: the proxy's hostname allowlist is proven by a spike in the sandbox Story]`" | delete both; pi's override moves to Deferred, and Story 1.12 built and tested the allowlist | pi; A8 |
| P21 | AD-19, Conflicts / AD-21 | "Hand any other conflict to a builder session…" / "the host would run more builders than `XARABOT_MAX_BUILDERS`" / "**Effort mapping:** `claude --effort`, `pi --thinking`, …" | add "in 0.x a commit conflict's session starts at the CI step after the PR opens (Story 2.11)"; "the host has more builder lanes installed in `host.yaml` than `XARABOT_MAX_BUILDERS`, counted across all repos"; drop `pi --thinking` | A6; pi |
| P22 | AD-20 config; AD-27 Snapshot; AD-30; Conventions Tests; Stack; diagram; Deferred | see "New" | AD-20: add "`live_evidence_checks` (optional): Epic number → the exact live commands its runbook requires (item 14)". AD-27: add "each parked PR's review decision; each Epic's live evidence text" (C6's staleness is recomputed from texts the snapshot already holds, so it adds no snapshot field). AD-30: add the AR31 field rules, "the coordinator check does not case-fold its own allow-list", the `symlink` class (item 18) and the `credential` class (C3, item 20). Tests: "long-running live cases also need `XARABOT_LIVE_LONG=1`". Stack: pi row "(v1; deferred from 0.x)". State diagram: `parked --> parked: re-park with a new graph delta (Q2)`. Deferred: add "**The pi adapter (v1)**: stock pi 1.4.0 gives `bmad-build-auto` no subagents (Story 3.2's escalation, 2026-10-25); its directory override (AR41) and the same-vendor pi reviewer go with it". Open items: the codex half is settled by the spike, except outcome mapping (Story 3.1). | A6–A8; items 13, 14, 18; C3; Q2; pi |

### 4e. Epics and Stories

File: `_bmad-output/planning-artifacts/epics.md`.

**Requirements inventory and Epic list.**

| # | Where | Change | Source |
|---|---|---|---|
| E1 | FR7 (line 38) | Same edit as S1 and S2; "(`claude-opus-5-5`, `gpt-6.1-sol`); a `pi` lane sets its model explicitly" → "(`claude-opus-5-5`, `gpt-6.1-sol`); `pi` moves to v1" | pi |
| E2 | NFR2, NFR14 | drop "and `pi` lanes name theirs"; "the `codex` and `pi` adapters" → "the `codex` adapter" | pi |
| E3 | NFR10 | add the S5 sentence | E7 |
| E4 | NFR20 | align with S6 (field rules, `reconcile`'s `done` writes) | A8 |
| E5 | AR4 | "sprint status: coordinator" → "sprint status: coordinator, with field rules (AR31); `reconcile`'s runner code alone sets a Story or an Epic `done`" | item 16 |
| E6 | AR6 | P5 and P6 (`readiness` for both kinds; `schema_version` 4; `park.text` from Story 4.2; `park.graph_posted` from item 24) | 2.7; A7; A3; Q2 |
| E7 | AR14 | "due only when the snapshot shows `reconcile` work or 10 minutes have passed…" → add "or a PR parked `awaiting-approval` that the Maintainer approved at the parked head (2026-10-25)"; status planning holds every Epic's context path; P17's planning hold, stale-context rule (C6) and evidence checks | 2.4 amendment; A7; item 14 |
| E8 | AR17, AR18, AR22, AR36 | drop pi (reviewer fallback, credential, `pi --thinking`, minimum version); AR18 codex credential "`auth.json` or `CODEX_API_KEY` (spike)"; AR22 "exceed `XARABOT_MAX_BUILDERS`" → "have more builder lanes installed than…" | pi; spike; A6 |
| E9 | AR21 | add `live_evidence_checks` | item 14 |
| E10 | AR31 | add after "does not case-fold its own allow-list": "Two further refusal classes come from retro items: `symlink` (a target outside the clone, item 18) and `credential` (a blob holding the seeded credential or a token-shaped string, item 20)." | items 18, 20 |
| E11 | AR35 | `planning:<slug>.<n>` → `planning:status.<n>`, `planning:graph.<n>` | 2.7 |
| E12 | AR41, AR42 | AR41 → "deferred with the pi adapter (v1)". AR42 → "the codex half is answered by the spike (`notes/codex-ar42-spike-2026-10-25.md`): subagents yes, resume by `codex exec resume <thread_id>`, usage from the session file; Story 3.1 confirms the outcome mapping. The pi half is deferred." | spike; pi |
| E13 | FR Coverage Map FR7; Epic list Epic 3 (lines 247–250); test strategy (line 234) | "Epic 3 - `codex` and `pi`, …" → "Epic 3 - `codex`, the common effort scale, unattended policy; `pi` v1". Epic 3 text and notes drop pi and AR41. "the sandbox re-runs in Stories 3.1 and 3.2" → "the sandbox re-run in Story 3.1" | pi |

**Epic 2 (done): record the accepted deviations.** Add after the Epic 2 intro paragraphs:

> **Accepted deviations (Epic 2 retro A6, A7; Maintainer, 2026-10-25).**
> - 2.1: a lane releases its unit about 2 minutes before the 30-minute lapse.
> - 2.4: the status planning unit holds every Epic's context file (`epic-*-context.md`), not one Epic's.
> - 2.5: `reconcile` adds every missing graph key while any merged graph record is not done.
> - 2.5b: the lane-stop count also covers config, policy and graph failures.
> - 2.5b: `xarabot rule` writes as the coordinator lane for non-Story units.
> - 2.6b: the first push leases against `branchHead` read at that push, not at the lease.
> - 2.7: the ledger `schema_version` reached 4 by the end of the Epic (2.8 and 2.9 each bumped it), not 2.
> - 2.9: the PR prefetch covers Story-branch PRs only.
> - 2.11: `XARABOT_MAX_BUILDERS` counts builder lanes installed in `host.yaml`, not running ones; a commit conflict's session runs at the CI step, after the PR opens.
> - 2.12: the 30-minute case also needs `XARABOT_LIVE_LONG=1`.
> - 2.8: the gate runs at the builder merge step, the graph planning step and `reconcile`'s take (P13).

**Story 2.4 (done): two stale clauses** (decision 31 of 2026-10-24 dropped the checkpoint unit).
- Old: "retro, retro items and checkpoint, or `idle` with a reason". New: "retro and retro items, or `idle` with a reason".
- Old: "a checkpoint unit holds the status files and the Epic context path, never the graph inputs;". New: delete the clause.

**Epic 3 intro.**
- Old: "`codex` and `pi` lanes run beside `claude` with the same `agent`, `model` and `effort` settings". New: "`codex` lanes run beside `claude` with the same `agent`, `model` and `effort` settings (the `pi` adapter is deferred to v1: stock pi 1.4.0 gives `bmad-build-auto` no subagents; Maintainer, 2026-10-25)".

**Story 3.1: the `codex` adapter** (spike routing). FRs line: drop nothing; add "spike: `notes/codex-ar42-spike-2026-10-25.md`".
- AC 1. Old: "it first establishes, with the real CLI, whether `codex exec` gives `bmad-build-auto` the subagents it requires, how … map onto the `build` result, and how a `codex exec` session is resumed". New: "it reads the AR42 spike note, which settled subagents (yes, `multi_agent` stable), resume (`codex exec resume <thread_id>`, the id from the first `--json` line, `thread.started`; never `--ephemeral`) and where usage lives, and it confirms with the real CLI only how `bmad-build-auto`'s outcomes map onto the `build` result; if that mapping cannot be made, the Story stops and raises it". The second clause ("if `codex exec` cannot run…") stays.
- AC 2. Old: "with the CLI's own sandbox turned off inside Xarabot's, its attribution-off setting". New: "with `--dangerously-bypass-approvals-and-sandbox` inside Xarabot's sandbox, `-c commit_attribution=\"\"`, `stdin` left unset so the sandbox gives the session a closed stdin (codex reads a piped stdin into the prompt), …". Add: "**And** a test asserts the codex `LaunchSpec` has no `stdin`".
- New AC (forced trailer). "**Given** codex's built-in prompt that forces `Co-authored-by: Codex <noreply@openai.com>` and a `Generated with [Codex](https://openai.com/codex/).` PR line **When** a codex result's `summary` or `body` carries either **Then** the sanitizer strips it before any forge text, and a test feeds both strings through it; commits are the runner's own (AR16), so a session's own commit never reaches the forge."
- AC 3 (credential). Old: "in the form this Story confirms `codex exec` accepts". New: "as `auth.json` (mode 600) in the lane's `CODEX_HOME`, or as `CODEX_API_KEY` for an API key (spike Q6) **And** a live case records whether a session rewrites `auth.json` (a token refresh); a rewrite is journaled, never copied back without the Maintainer's decision (C8)".
- AC 4 (effort). Add: "for `gpt-6.1-sol` the values are `low` … `max`; codex's `ultra`, `none` and `minimal` are not on Xarabot's scale".
- AC 5 (usage). Old: "**Given** the `--json` output **When** `parseUsage` runs **Then** it returns tokens, cost, the reported model and a usage-limit hit with its reset time". New: "**Given** the `--json` output and the session file `$CODEX_HOME/sessions/…/rollout-*-<thread_id>.jsonl` **When** `parseUsage` runs, before the vendor home is re-seeded **Then** it takes tokens from `turn.completed`, the model from `turn_context.model`, and a usage-limit hit and its reset from `token_count.rate_limits` (`resets_at`, Unix seconds; never from the message text); cost is an estimate from tokens (AR25); a failed turn (`turn.failed`, exit 1) that is not a usage limit fails the attempt **And** a live case records whether subagent tokens are in the parent's totals; if not, the child session files (`parent_thread_id`) are added".
- AC 7 (proxy). Old: "only OpenAI's API hosts, the Python package hosts and repo-added hosts are reachable". New: "only `chatgpt.com`, `ab.chatgpt.com`, `auth.openai.com` (and `api.openai.com` with an API key), the Python package hosts and repo-added hosts are reachable **And** the Maintainer's live run records every host a codex session asks the proxy for; the spike's unresolved address (`2606:4700:440b::ac40:9034`) is named from that log before the list is final, and a host not on the list is raised to the Maintainer, never added silently".

**Story 3.2: rewritten as the pi deferral** (C1). New heading: "### Story 3.2: The `pi` adapter, deferred to v1". The id and `sprint_key` (`3-2-the-pi-adapter`) stay.

> As the Maintainer,
> I want a lane or reviewer set to `pi` to refuse clearly in 0.x,
> So that nothing waits on an adapter that cannot run `bmad-build-auto` (FR7, Story 3.2's escalation of 2026-10-25).
>
> **Given** `agent: pi` on a lane, or a policy whose only reviewer would be `pi`
> **When** `xarabot lane install` or a lane start runs
> **Then** it refuses, naming the deferral ("the `pi` adapter is deferred to v1: stock pi 1.4.0 gives `bmad-build-auto` no subagents"), and counts as a failed start like any refusal (AR34).
>
> **Given** the policy schema's `AdapterName` (`claude`, `codex`, `pi`)
> **When** this Story is done
> **Then** `pi` still parses, so a policy that lists it is not invalid, but no code path launches a `pi` session, and `src/adapters/agent/pi/` does not exist.
>
> **Given** `docs/maintainer/self-host.md`
> **When** the Story is done
> **Then** it records the escalation's finding and what the v1 adapter needs first: subagents for `bmad-build-auto`, the agent-directory override (AR41), and the attribution and sandbox switches.

**Story 3.3: drop pi** (the same-vendor fallback).
- Old: "a `pi` session is the vendor named in its `<provider>/<id>` model; through OpenRouter, it is the vendor of the underlying model (`openrouter/anthropic/<id>` is Anthropic)". New: delete (v1, with the pi adapter).
- Old: "`pi` with an Anthropic model → `codex`, `pi` with any other vendor's model → `claude`". New: delete.
- Old: "the first allowed of (`claude`, `codex`), or with neither allowed a `pi` session on the builder's model **And** the case table has rows for a `claude`-only, a `codex`-only and a `pi`-only policy, and the unit never parks for lack of a reviewer **And** `pi` is never picked as a cross-vendor reviewer in 0.x…". New: "the first allowed of (`claude`, `codex`) **And** the case table has rows for a `claude`-only and a `codex`-only policy, and for a policy allowing neither, which refuses at lane start (Story 3.2), so a unit never parks for lack of a reviewer".

**Story 3.4: the follow-up review prompt** (E1). New AC:

> **Given** a Story whose spec file at `head_sha` (the single `done` match, AR11) has `followup_review_recommended: true`
> **When** `core/prompt` builds the review prompts
> **Then** it builds a second, follow-up prompt from the package review template that names the spec and tells the reviewer to check the unverified risks the spec's Auto Run Result names, ending with a `review` result
> **And** the prompt test covers it.

**Story 3.5: the follow-up pass in the gate** (E1, the Maintainer's rule).

> **Given** a unit whose spec recommends a follow-up review
> **When** a review round runs, before the PR parks for approval or is enqueued
> **Then** the runner runs the normal review and then the follow-up pass, each a separate session on the same fresh checkout under Story 3.4's rules, and sets `passed_sha` only when neither has blocking findings
> **And** blocking findings from either pass start one loopback (`loopbacks` + 1), and every later round runs both passes again (C7)
> **And** a unit with no spec (a retro item or a coordinator PR) or with the flag `false` gets the normal review only
> **And** the case tables gain rows for a flagged Story passing both, failing the follow-up only, and an unflagged Story.

**Story 3.6: drop pi; three switch items.**
- Old: "the same unit runs to a valid `build` result through `claude`, `codex` and `pi`". New: "through `claude` and `codex`".
- Old: "and the nested sandbox cases of Stories 3.1 and 3.2". New: "and the nested sandbox cases of Story 3.1, plus `bun test test/sandbox/` on the host as an evidence row until the macOS CI job runs (2.5c deferral; Epic 1 item 13)".
- Switch list. Old: "drop the every-path approval rule from this repo's `policy.yaml`, allow the adapters to be used unattended, raise `XARABOT_MAX_BUILDERS`, and run the 24-hour acceptance check". New: add before "raise": "confirm lane item 23 (lane-lock hardening) is done;". Add after the list: "Dropping the every-path rule makes status planning PRs ungated and so disposable, which settles spec-2-7's stale gated status PR. The 'Several builder lanes' runbook step waits for the lock's PID to be gone, not for 'no `lane.lock`' or an `outcome` (2.11 F3, F4)."

**Story 4.2: inbox findings** (A3). New AC:

> **Given** a unit parked `blocked` with text (a build result's `blocked.text`, or a status or graph planning unit's readiness findings in `summary`)
> **When** the runner parks it
> **Then** it stores the sanitized text, capped below the forge's limit, in `park.text` (AR6; ledger `schema_version` + 1), and the digest lists it under the item.

**Story 7.5: one owner per repo** (C5). New AC:

> **Given** a lane start
> **When** the ledger holds a `claimed`, `merging` or `parked` record whose `owner` is another human
> **Then** the lane refuses to start, naming that owner and unit; 0.x runs one owner per repo, and cross-owner takeover is v1 (AD-9).

### 4f. Manifests (graph inputs)

| File | Old | New | Graph change? |
|---|---|---|---|
| `stories/3.2.md` | `title: "The \`pi\` adapter"`; globs include `src/adapters/agent/pi/**`, `test/adapters/agent/pi/**`, `src/core/network/**`, `test/core/network/**`, `src/sandbox/**`, `test/sandbox/**` | `title: "The \`pi\` adapter, deferred to v1"`; drop those six globs | manifest edit only; Epic 3's Story set unchanged |
| `stories/3.3.md` | `depends_on: ["3.1", "3.2"]` | `depends_on: ["3.1"]` | Story edge only |
| `stories/7.3.md` | `depends_on: ["3.1", "3.2", "7.1"]` | `depends_on: ["3.1", "7.1"]` | Story edge only |

None of these changes an Epic edge, a checkpoint, the Epic set or an Epic's Story set. All three are graph inputs, so they go in the Maintainer's planning PR, checked with `bun src/cli/main.ts graph check`. **No graph PR needing the Maintainer's AD-11 approval** arises in the recommended option. **C1's alternative** (removing Story 3.2) would be one: it changes Epic 3's Story set and breaks "fixed once used".

### 4g. `retro-gates.yaml` (Epic 2 items, a Maintainer PR as for items 13–19)

- Item 7 → `status: done` once this proposal's edits merge.
- Item 12 → `route: lane` with the C6 hash rule and its globs (C6 approved 2026-10-25): `src/core/next/**`, `src/lane/planning-step.ts`, `src/core/prompt/**`, `test/core/next/**`, `test/lane/planning-step.test.ts`, `test/core/prompt/**`.
- New lane items, all `route: lane`, `blocking: false`, `status: open`:

| Id | Text (short) | Globs | Routes |
|---|---|---|---|
| `epic-2-retro-item-20-write-check-content-rules` | A `credential` refusal class for added or changed blobs (C3); the Story file's `status:` line accepts only BMAD status values (2.3 F1); a test pins the quoted `"status":` key as refused, fail-closed (2.3 F2, accepted) | `src/core/lane/write-check.ts`, `src/lane/commit.ts`, `src/core/sanitize.ts`, their tests | 2.5a medium; 2.3 F1, F2 |
| `epic-2-retro-item-21-reconcile-pr-hygiene` | End a `reconcile` run while any `closeBranchPrs` failed, so two `reconcile` PRs are never open (2.5 F1); add `Forge.deleteBranch` (contents: write; contract cases) and delete the branches of closed `reconcile` and disposable planning PRs; a test pins Q4's close | `src/ports/forge.ts`, `src/adapters/forge/**`, `src/lane/reconcile-step.ts`, `src/lane/planning-step.ts`, `test/contracts/forge.contract.ts`, their tests | 2.5a low; 2.5 F1; Q4 |
| `epic-2-retro-item-22-coordinator-claim-timing-and-fencing` | Seed the coordinator keeper's clock and `claimedMs` from the start snapshot's time (2.4 F1, C8b); end the unit keeper on the coordinator keeper's signal (2.4 F2); fence coordinator-unit edits on `coordinator.json` (Q5) | `src/cli/lane-run.ts`, `src/lane/coordinator-process.ts`, `src/lane/heartbeat.ts`, `src/core/ledger/**`, their tests | 2.4 F1, F2; C8; Q5 |
| `epic-2-retro-item-23-harden-the-lane-lock` | Re-check `lane.lock`'s PID and start time at each heartbeat and end the unit on a mismatch (2.11 F1); treat a failing `ps` as "held" (2.11 F2); remove `lane.lock.stale-*` and `.tmp-*` files left by a SIGKILL (2.11) | `src/lane/lane-lock.ts`, `src/lane/processes.ts`, `src/lane/wait.ts` (the draft's `waits.ts` does not exist), `src/lane/heartbeat.ts`, their tests | 2.11 F1, F2, clutter |
| `epic-2-retro-item-24-bind-graph-approval-to-the-posted-delta` | Q1–Q3: an approval counts only after the delta comment; `park.graph_posted` and a re-park with a new delta on a hash change; stamp the re-park with the time before the reviews read | `src/lane/reconcile-step.ts`, `src/lane/graph-gate.ts`, `src/core/reconcile/**`, `src/core/ledger/**`, `src/core/schemas/ledger.ts`, their tests | spec-2-8 deferral; Q1–Q3 |
| `epic-2-retro-item-25-planning-attempts-across-runs` | C4: a new planning record inherits the newest released record's `attempts` of its kind; 3 in a row parks `attempts-cap` | `src/core/next/coordinator.ts`, `src/core/reconcile/plan.ts`, `src/lane/planning-step.ts`, their tests | A4 |

Items 20–25 become retro-item units once merged. Untagged, they hold Epics at distance 2 or more from Epic 2 (Epic 4 onward) once Story 4.1's gate exists.

### 4h. Routing tables

**A9 deferrals (and A3–A5).**

| Deferral | Receiving home |
|---|---|
| 2.5a committed-content credential scan (medium) | item 20 (C3) |
| 2.5a branches left by closed `reconcile` PRs (low) | item 21 |
| 2.5c real-sandbox paths tested only on the host (medium) | Story 3.6 evidence row; Epic 1 item 13 (the macOS CI job, Maintainer) |
| 2.7 attempts cap never trips across runs (A4) | item 25 (C4) |
| 2.7 readiness findings only in the journal (A3) | Story 4.2 (`park.text`) |
| 2.7 gated status planning PR goes stale | accepted until Story 3.6's switch drops the every-path rule |
| 2.7 `lane run` planning wiring tested only for existence | closed by item 11 (done) |
| 2.8 `approved_graph` bound at the take (A5, timing) | item 17 (re-take voids) and item 24 (Q1–Q3) |
| 2.8 gate scope (A5) | accepted; recorded in the spine (P13) |
| 2.2 AR10 cross-owner close "until Epic 5" | Story 7.5 (C5); close-and-reopen stays v1 |
| 2.6a `message(e)` copies (low) | closed by item 10 (done) |
| 2.10 retro-item wiring tested only for existence (low) | closed by item 11 (done) |
| Body-only deferrals outside Story 4.2's digest | accepted: each correct course sweeps spec bodies (decision 32a). This one did, and found only AR10. |

**Follow-up review lows.**

| Low | Home |
|---|---|
| 2.3 F1 status line accepts any string | item 20 |
| 2.3 F2 quoted `"status":` key refused | accepted (fails closed); pinned by a test in item 20 |
| 2.4 F1 keeper lapse baseline is process start | item 22 |
| 2.4 F2 unit keeper outlives a lost coordinator claim | item 22 |
| 2.5 F1 orphan `reconcile` PR does not stop a new one | item 21 |
| 2.11 F1 two live lock holders | item 23 |
| 2.11 F2 a failing `ps` reads a live holder as gone | item 23 |
| 2.11 F3/F4 runbook drain signal | Story 3.6 |
| 2.11 stale `lane.lock.stale-*` and `.tmp-*` files | item 23 |

**Codex spike open points (into Story 3.1).** The forced attribution trailer goes to 3.1's new trailer AC and AC 2. Closed stdin goes to AC 2. The unidentified host goes to AC 7. `resets_at` as the reset source goes to AC 5. Token refresh (C8) and subagent token totals become live cases in 3.1.

**Retro open questions.** 1 is done (item 1). 2 is decided (AR31; item 14). 3 is decided (E1, Stories 3.4 and 3.5). 4 is decided (item 16). 5 is decided (#129, S5). 6 is still open (C9, Maintainer, 2026-10-25).

## 5. Implementation handoff

**Scope: moderate.** The backlog is reorganized inside Epic 3: one Story is rewritten and five change. SPEC changes 0.x scope by deferring pi. Six lane items are added. No fundamental replan is needed.

| Work | Who | How |
|---|---|---|
| Answers to Q1–Q5 and C1–C9 | Maintainer | done 2026-10-25 (Approval, above); C9 stays open |
| SPEC, `agent-adapters.md`, `releases.md`, glossary (S1–S18) | Maintainer | `bmad-spec`, one PR |
| Spine, epics, manifests, `retro-gates.yaml` (4d–4g) | Maintainer | one planning PR; `graph check` must exit 0 |
| Release Story 3.2 for its rebuild | Maintainer | `xarabot rule release story:3.2` |
| Stories 3.1–3.6, 4.2, 7.5 as amended | builder lane | from `next` |
| Items 12 and 20–25 | coordinator lane | retro-item units |

**Success criteria.**
- `bun src/cli/main.ts graph check` exits 0. Epic 3 still has 6 Stories; 3.3 depends only on 3.1, and 7.3 depends on 3.1 and 7.1.
- No 0.x artifact (SPEC, companions, spine, epics) still names `pi` as a 0.x adapter or reviewer.
- Every A7 deviation and A9 deferral, and every follow-up low, has exactly one home in section 4h.
- The spine and SPEC state AR31's field rules, `reconcile`'s `done` writes, the 2.4 approval round, the evidence checks and the 2.7 planning decisions.
- After Story 3.2 merges, `agent: pi` refuses at install and at start, naming the deferral.

## Appendix: checklist status

| Item | Status | Note |
|---|---|---|
| 1.1 Trigger | [x] | Epic 2 retro item 7; Story 3.2's escalation |
| 1.2 Core problem | [x] | Drift, unrouted deferrals and a vendor limit discovered in a spike |
| 1.3 Evidence | [x] | Retro, follow-up reviews, spike note, ledger `story:3.2` |
| 2.1 Current Epic | [x] | Epic 2 is done; the work is notes only |
| 2.2 Epic-level changes | [!] | Epic 3 loses pi (4e) |
| 2.3 Future Epics | [x] | Epics 4 and 7 take one AC each |
| 2.4 Obsolete or new Epics | [N/A] | none |
| 2.5 Epic order | [N/A] | unchanged |
| 3.1 PRD (SPEC) | [!] | S1–S18 through `bmad-spec` |
| 3.2 Architecture | [!] | P1–P22 |
| 3.3 UX | [N/A] | none exists |
| 3.4 Other artifacts | [!] | manifests, `retro-gates.yaml`; runbook edits go through Stories 3.2 and 3.6 |
| 4.1 Direct adjustment | [x] | chosen |
| 4.2 Rollback | [N/A] | not needed |
| 4.3 MVP review | [x] | only pi leaves 0.x |
| 4.4 Path | [x] | section 3 |
| 5.1–5.5 Proposal parts | [x] | sections 1–5 |
| 6.1–6.5 Review and handoff | [x] | approved by the Maintainer, 2026-10-25 (Approval, above) |
