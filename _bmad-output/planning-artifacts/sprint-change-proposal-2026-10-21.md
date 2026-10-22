---
title: Sprint Change Proposal, xarabot 0.x readiness fixes
date: 2026-10-21
status: approved
trigger: _bmad-output/planning-artifacts/implementation-readiness.md
mode: hybrid (new decisions one at a time; mechanical edits in batch)
scope: moderate
approved: 2026-10-21 (Maintainer; all eight drafting choices accepted)
edits: 154 (spine 42, spec 6, epics 106)
---

# Sprint Change Proposal: xarabot 0.x readiness fixes

## 1. Issue summary

The readiness gate (`bmad-sprint-planning`, 2026-10-21) failed the 0.x plan before any code exists. Three blockers stop the plan running past Epic 1:

- **B1.** The self-hosted runner deadlocks at the Epic 1 → 2 gate. Epic 1 has no manifests, no `sprint-status.yaml` and no retro verdict at the switch, so it never counts as done.
- **B2.** `next` picks done Stories again once `reconcile` deletes their `merged` records. Nothing reads `done` from `sprint-status.yaml`.
- **B3.** Story 2.7 runs `bmad-sprint-planning` and graph edits in one unit, which its own write check refuses.

Thirteen concerns (C1–C13) add gaps where a developer would invent a decision: unowned live proofs, an undefined vocabulary, Story ACs that drift from the spine, an under-specified `claude` adapter, missing journal spans, late Maintainer steps, a stale AC, forward dependencies in Epics 1 and 2, and spine gaps. While this proposal was being prepared, one more gap came up: nothing said whether a `rejected` retro releases the Epics that depend on it (decided as D13).

Evidence and line references are in the trigger file. Every blocker was re-read against the source.

## 2. Impact analysis

**Epics.** No Epic is added, removed or reordered, and `.xarabot/epics.yaml` is unchanged. Every Epic changes some Stories. Two Stories are split with letter ids (AD-11's grammar and the parser accept them), so there are 62 Stories, not 60:

| Epic | Stories changed | Main reasons |
|---|---|---|
| 1 | 1.2–1.20, new 1.17a; intro | D1, D2, D5, D6, D9, D11, D12, D13; C3–C7 |
| 2 | 2.3–2.7, 2.9, 2.10, 2.12; intro | B3, D3, D5, D11, D13; C3, C6 |
| 3 | 3.1–3.3, 3.5, 3.6 | D3, D4; C3 |
| 4 | 4.1–4.7 | D3, D7, D11, D13; C5 |
| 5 | 5.1–5.3, new 5.1a | D3, D12; C6, C8 |
| 6 | 6.4, 6.5 | D3; C5 |
| 7 | 7.2, 7.3, 7.5–7.7 | D3, D8, D10; C8 |

**Requirements inventory** in `epics.md`: about 20 AR entries change to match the spine, along with the Epic List's test strategy and notes. The FR coverage map is unchanged.

**Artifact conflicts.**
- **Spec** (stands in for the PRD): the same-vendor reviewer assumption is confirmed (D4); the "decided" and "still open" lists match the spine again; "worktree" becomes "clone" in CAP-4 and CAP-18; the Write authority line records D2's exception; `releases.md`'s CAP-20 note records D10. The capabilities, releases and success signals don't change, so the MVP is unaffected.
- **Architecture spine:** AD-3, 5, 7, 10–14, 16, 17, 20, 23–30, the Ports table, the Consistency Conventions, the Structural Seed, the capability map and Deferred.
- **UX:** none exists; N/A.

**Technical impact.** None yet: no code exists. `docs/maintainer/self-host.md` is an output of Story 1.20 and later verification Stories, so it changes through them.

## 3. Recommended approach

**Direct adjustment.** Edit the existing spine sections and Stories; add no Epic.

- **Effort:** medium, about a day of planning edits, nearly all of it drafted below.
- **Risk:** low. Nothing is built, and each edit is exact text checked to occur once.
- **Timeline:** implementation starts after this lands and the readiness gate passes.
- **Rejected:** rollback, since there is nothing to roll back; an MVP review, since 0.x scope and success signals stand.

### Maintainer decisions (2026-10-21)

| # | Decision |
|---|---|
| D1 | `next` reads done-ness from `sprint-status.yaml`. A Story is eligible only when its record is absent, `released` or stale **and** it is not `done`. "All Stories merged" means all `done`. |
| D2 | `bootstrapped_epics: [1]` in `.xarabot/config.yaml` marks Epic 1 as all Stories done and retro done at the self-host switch. The Maintainer creates `sprint-status.yaml` once with `bmad-sprint-planning` and runs Epic 1's retro interactively. |
| D3 | The Maintainer runs each Epic's live proof (`bun test --live …`) on the host, outside the sandbox, before its retro. Inside the sandbox, live and nested-sandbox cases report skipped. |
| D4 | The same-vendor reviewer rule is confirmed; `pi` stays out of reviewer selection in 0.x. |
| D5 | Vocabulary: the Standing Authority frontmatter (`schema_version`, `granted_by`, `granted_at`, `repo`, optional `expires`), every result and `park` enum, the retro `verdict` values from stock BMAD, and the planning config paths with BMAD defaults. |
| D6 | Manifest `depends_on` lists Story ids, gated on `done`, each in the same Epic or an ancestor Epic. |
| D7 | Digest: a live issue body rewritten by each `reconcile`, plus one daily @mention comment at `digest_time`. |
| D8 | Upgrade PRs have no ledger unit; the Maintainer approves and enqueues them by hand. |
| D9 | A lane switches `runner_version` at process exit, through a fixed launcher and the lane's `runner` file. |
| D10 | 0.x reads Escalations with Xaravel's rule (hash-bound decisions) and holds a Story with an open one: it is not claimed and not enqueued. |
| D11 | Epic 1's forward dependencies are fixed by moving pieces between Stories, keeping numbers. The `Forge` port gains `comment`. Coordinator position tests arrive with each position. |
| D12 | Splits: 1.17 / 1.17a (approval gate and queue); 5.1 / 5.1a (permission table). |
| D13 | A `rejected` retro holds its dependents until `/xarabot go retro:<N>`, and puts a course-correction item in the Maintainer's inbox. |

### Choices made while drafting, for review

These follow from the decisions but weren't asked about one by one. The edits that carry them are tagged `[NEW CHOICE]`.

1. **Sandbox reads, `HOME` and env (C11; A-21, A-22, E-INV AR18, E-1.11).** Reads allow the real paths of the agent CLI, `bun`, `uv`, `git` and uv's Python. The session gets a fresh `HOME` in its temp folder. The env allowlist is named, including the vendor-home variable.
2. **Planning globs (A-16, E-2.4-b).** A status unit holds the status files and the Epic context; a graph unit holds the graph inputs and `xarabot:graph`.
3. **A rejected retro before Story 4.6 (A-2, E-EPIC2-a).** Until the rulings Story merges in Xarabot's own repo, the Maintainer records the go by hand in a Maintainer PR. This is a second AD-3 exception. Without it, a rejected Epic 2 or 3 retro would hold Epic 4, the Epic that ships the release ruling.
4. **`bootstrapped_epics` validation (E-1.4).** Naming an Epic with no heading fails validation, and `graph check` reads `config.yaml` only when it exists.
5. **Story-spec cross-check (E-1.16).** A mismatch between the result and the Story spec's `status` or `## Auto Run Result` counts as an invalid result, failing closed.
6. **`unclaimable` (A-4).** It only labels an inbox item; such a Story gets no ledger record.
7. **Releasing an Escalation hold (A-5, E-7.6).** Once every Escalation on the Story has a valid decision, approved or rejected, the next `reconcile` releases the record without counting an attempt.
8. **The Escalation decision file name (A-24, E-7.6).** A decision file has the same name as its Escalation (`decisions/ESC-<story-id>-<n>.md`), as in Xaravel's `escalations.ts:337`.

Left as they are, on purpose: AR23 has no digest text to change; D10's config field stays in Story 7.6; Story 2.8 doesn't add `graph-invalid` (A-10 and A-11 cover it in the spine); Story 3.4's review enums come from Story 1.13's schema.

## 4. Detailed change proposals

Each edit replaces OLD with NEW, and each OLD occurs exactly once in its file. They were checked together with `check_edits.py`: 154 edits, 0 failures, and no two edits overlap. Applying them is mechanical and all-or-nothing per file.

### 4a. Architecture spine (A-1 – A-42)

#### A-1 · Ports table · `Forge` gains `comment(pr, body)`
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D11, C10
**OLD:**
`````text
| `Forge` | `snapshot()` returns the ledger tip, `main` SHA, PR states and the server's `now`. Also `ledgerSwap(oldSha, edit)`, which returns `ok` or `conflict`; `pushBranch(lease)`; PR open, update and close; `postReview`; `checks`; `enqueue(expectedHead)`; `dequeue`; inbox `renderDigest`, `alert` and `readRulings(cursor)`; `prefetch(kind)`. There is no approve operation. |
`````
**NEW:**
`````text
| `Forge` | `snapshot()` returns the ledger tip, `main` SHA, PR states and the server's `now`. Also `ledgerSwap(oldSha, edit)`, which returns `ok` or `conflict`; `pushBranch(lease)`; PR open, update and close; `postReview`; `comment(pr, body)` for 🤖 status comments; `checks`; `enqueue(expectedHead)`; `dequeue`; inbox `renderDigest`, `alert` and `readRulings(cursor)`; `prefetch(kind)`. There is no approve operation. |
`````
**Why:** Story 1.16's 🤖 status comment needs a `Forge` operation, which D11 adds to the port.

#### A-2 · AD-3 · Status writers after the planning split; the one-time Maintainer write; bootstrapped Epics; rejected-retro go
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D2, D13, B3
**OLD:**
`````text
| Epic and Story planned or done | `sprint-status.yaml` on `main` | coordinator (its own PRs) |
| Retro verdicts and items | `retro-gates.yaml` on `main` | `reconcile`'s runner code only, once, from the retro unit's validated result (AD-12); then only rulings and status changes |
| BMAD's copy of retro action items | `sprint-status.yaml` `action_items` | stock `bmad-retrospective`; used only to validate the retro result, never read by gates, `next` or the digest |
| Checkpoint go | `retro-gates.yaml` on `main` | `reconcile`'s runner code, applying a Maintainer ruling (AD-28); never an agent session |
| Story manifests and `epics.md` | `main` | coordinator (planning units); a change to the effective Epic graph is Maintainer-gated (AD-11) |
| Epic graph | `.xarabot/epics.yaml` on `main` | coordinator (planning units, Maintainer-gated, AD-11) or the Maintainer |
`````
**NEW:**
`````text
| Epic and Story planned or done | `sprint-status.yaml` on `main` | coordinator (its own PRs): a status planning unit, or `reconcile` marking units done and writing a merged graph planning unit's status entries (AD-13) |
| Epic 1's Stories `done`, at Xarabot's self-host switch | `sprint-status.yaml` on `main` | the Maintainer, once, by running `bmad-sprint-planning`; the Maintainer also runs Epic 1's retro interactively. This one-time write is an exception to the coordinator rule above (AD-11, `bootstrapped_epics`). |
| Retro verdicts and items | `retro-gates.yaml` on `main` | `reconcile`'s runner code only, once, from the retro unit's validated result (AD-12); then only rulings and status changes |
| BMAD's copy of retro action items | `sprint-status.yaml` `action_items` | stock `bmad-retrospective`; used only to validate the retro result, never read by gates, `next` or the digest |
| Checkpoint go, and the go that releases a rejected retro | `retro-gates.yaml` on `main` | `reconcile`'s runner code, applying a Maintainer ruling (AD-12, AD-28); never an agent session. In Xarabot's own repo, until the rulings Story (4.6) merges, the Maintainer records a rejected retro's go by hand in a Maintainer PR. |
| Story manifests and `epics.md` | `main` | coordinator (graph planning units, AD-13); a change to the effective Epic graph is Maintainer-gated (AD-11) |
| Epic graph | `.xarabot/epics.yaml` on `main` | coordinator (graph planning units, Maintainer-gated, AD-11) or the Maintainer |
| Bootstrapped Epics | `bootstrapped_epics` in `.xarabot/config.yaml` on `main` | the Maintainer (a Protected Path, AD-20) |
`````
**Why:** D2 records the one-time Maintainer write as an AD-3 exception and makes `bootstrapped_epics` Maintainer-owned; B3 splits planning into status and graph units; D13's retro go is written like the checkpoint go, with a hand go until Story 4.6 so a rejected Epic 2 or 3 retro cannot hold Epic 4's own rulings Story `[NEW CHOICE]`.

#### A-3 · AD-3 · Digest comment and its last post time
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D7
**OLD:**
`````text
| Inbox digest body | forge issue | coordinator |
`````
**NEW:**
`````text
| Inbox digest body, the daily digest comment and its last post time | forge issue; `coordinator.json` | coordinator (`reconcile`, AD-23) |
`````
**Why:** D7 keeps the last digest post time in `coordinator.json` and has `reconcile` post the daily comment.

#### A-4 · AD-5 · `park.kind` and `park.reason` values
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D5, C2
**OLD:**
`````text
    - `park` (`kind`, `reason`, `inbox_owner`, `globs_held`)
`````
**NEW:**
`````text
    - `park` (`kind`, `reason`, `inbox_owner`, `globs_held`). `kind` is `awaiting-approval`, `needs-approval` or `blocked`. `reason` is a `build.blocked.kind` (AD-14) or a runner cause: `review-cap`, `ci-fix-cap`, `ci-timeout`, `write-check`, `no-op`, `attempts-cap`, `unclaimable` or `graph-invalid`. `unclaimable` only labels an inbox item: a Story whose globs resolve to nothing, or a heading with no manifest, gets no ledger record.
`````
**Why:** D5 fixes the literal `park` values so Story 1.2's schema invents none.

#### A-5 · AD-7 · Outcome rows name their `park` values; open Escalations park
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D5, D10
**OLD:**
`````text
| Finished PR waiting for its owner's approval, or the Maintainer's for a graph change (AD-11) | `parked`, holding **only the paths its diff changes** |
| Blocked: Escalation, Human Live Step, `intent-gap`, `verification`, `other`, review disagreement past the cap, CI-fix cap reached, write-check refusal, or the result `no-op` | `parked`, globs **released**, inbox item |
| Session crash, a missing or invalid result, a timeout, or a budget overrun | `released` with `attempts` + 1. Once `attempts` ≥ 3 it becomes `parked` (blocked) instead. |
| A stale claim taken over by another lane | stays `claimed` under the new holder, with `attempts` + 1. Once `attempts` ≥ 3 it becomes `parked` (blocked) instead. |
| A recurring unit (`planning`, `reconcile`) with nothing to commit | `merged` with no PR. The coordinator deletes it at once, and no inbox item is raised. |
| An approval-gated PR (owner or Maintainer) ejected or dequeued from the queue | `parked`, holding only the paths its diff changes, `approved_sha` cleared. It never returns to `claimed`. |
| Infrastructure Story with no matching approval | `parked` (`needs-approval`), globs released, item in the Maintainer's inbox |
`````
**NEW:**
`````text
| Finished PR waiting for its owner's approval, or the Maintainer's for a graph change (AD-11) | `parked` (`awaiting-approval`), holding **only the paths its diff changes** |
| Blocked, with `park.reason`: the build result's `blocked.kind` (`escalation`, `human-live-step`, `intent-gap`, `verification`, `other`), review disagreement past the cap (`review-cap`), CI-fix cap reached (`ci-fix-cap`), CI max wait passed (`ci-timeout`), write-check refusal (`write-check`), or the result `no-op` (`no-op`) | `parked` (`blocked`), globs **released**, inbox item |
| Session crash, a missing or invalid result, a timeout, or a budget overrun | `released` with `attempts` + 1. Once `attempts` ≥ 3 it becomes `parked` (`blocked`, `attempts-cap`) instead. |
| A stale claim taken over by another lane | stays `claimed` under the new holder, with `attempts` + 1. Once `attempts` ≥ 3 it becomes `parked` (`blocked`, `attempts-cap`) instead. |
| A recurring unit (`planning`, `reconcile`) with nothing to commit (a `planning` result `nothing-due`) | `merged` with no PR. The coordinator deletes it at once, and no inbox item is raised. |
| An approval-gated PR (owner or Maintainer) ejected or dequeued from the queue | `parked` (`awaiting-approval`), holding only the paths its diff changes, `approved_sha` cleared. It never returns to `claimed`. |
| Infrastructure Story with no matching approval | `parked` (`needs-approval`), globs released, item in the Maintainer's inbox |
| Story with an open Escalation (AD-20) | `parked` (`blocked`, `escalation`), globs released, listed in the Maintainer's digest. It is never claimed or enqueued while the Escalation is open. Once every Escalation on the Story has a valid decision, approved or rejected, the next `reconcile` releases the record without counting an attempt. |
`````
**Why:** D5 names the literal `park.kind` and `park.reason` values per row, and D10 holds a Story with an open Escalation as a blocked park.

#### A-6 · AD-10 · Manifest `depends_on`
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D6, C11
**OLD:**
`````text
  - **Optional:** `depends_on`, `infrastructure: true`.
`````
**NEW:**
`````text
  - **Optional:** `depends_on`, `infrastructure: true`.
    - `depends_on` is a list of Story ids. A Story is eligible only when each listed Story is `done` in `sprint-status.yaml` on `main` (AD-13).
    - Each listed Story must be in the same Epic, or in an Epic that Epic depends on, directly or through others; otherwise graph validation fails (AD-11).
    - Graph planning units write `depends_on` where a Story builds on an earlier one.
`````
**Why:** D6 gives `depends_on` its meaning, so a dependent Story is not built on a `main` that lacks its predecessor.

#### A-7 · AD-11 · Bootstrapped Epics are exempt from the no-Stories rules
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D2, B1
**OLD:**
`````text
  - **A Story heading with no manifest** can't be claimed, is listed in the Maintainer's inbox, and keeps its Epic from counting as done. An Epic with no Stories is never done and holds its dependents.
`````
**NEW:**
`````text
  - **A Story heading with no manifest** can't be claimed, is listed in the Maintainer's inbox, and keeps its Epic from counting as done. An Epic with no Stories is never done and holds its dependents.
  - **Bootstrapped Epics.** Config `bootstrapped_epics` (AD-20) is a list of Epic numbers, default `[]`, that only the Maintainer sets, since `.xarabot/**` is a Protected Path.
    - The gates read a listed Epic as all Stories done and retro done (AD-12).
    - A listed Epic is exempt from the two rules above: it may have no Stories, and its Story headings are not reported as unclaimable.
    - Xarabot's own repo sets `bootstrapped_epics: [1]` at the self-host switch.
`````
**Why:** D2 removes the Epic 1 → 2 deadlock at the self-host switch (B1).

#### A-8 · AD-11 · Validation covers `depends_on`
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D6
**OLD:**
`````text
    - a manifest with no heading, or whose `epic` doesn't match;
`````
**NEW:**
`````text
    - a manifest with no heading, or whose `epic` doesn't match;
    - a manifest whose `depends_on` names a Story outside its own Epic and the Epics that Epic depends on, directly or through others (AD-10);
`````
**Why:** D6 adds the `depends_on` check to AD-11's validation list.

#### A-9 · AD-11 · Only graph planning units change graph inputs
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** B3
**OLD:**
`````text
    - Only `planning` units may change them (AD-30). A planning unit that does holds the pseudo-glob `xarabot:graph`, so graph changes go one at a time (AD-13).
    - A planning session edits `.xarabot/epics.yaml` in its diff like any planning file; the package prompt template states its schema (AD-29).
`````
**NEW:**
`````text
    - Only graph planning units may change them (AD-13, AD-30). A graph planning unit holds the pseudo-glob `xarabot:graph`, so graph changes go one at a time.
    - A graph planning session edits `.xarabot/epics.yaml` in its diff like any planning file; the package prompt template states its schema (AD-29).
`````
**Why:** B3 splits planning; only the approval-gated graph unit touches graph inputs.

#### A-10 · AD-11 · Graph-validation parks name `graph-invalid`
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D5
**OLD:**
`````text
    - Before enqueue, the runner runs `resolveGraph` and the whole validation list above on the PR's merge result (the merge it recomputes for AD-16). A failure parks the PR blocked.
`````
**NEW:**
`````text
    - Before enqueue, the runner runs `resolveGraph` and the whole validation list above on the PR's merge result (the merge it recomputes for AD-16). A failure parks the PR blocked (`graph-invalid`).
`````
**Why:** D5's `park.reason` list includes `graph-invalid`; this names where it is used.

#### A-11 · AD-11 · Renumbering parks name `graph-invalid`
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D5
**OLD:**
`````text
  - **Fixed once used.** An Epic number or Story id can't be renumbered or removed once it has a status beyond `backlog` in `sprint-status.yaml`, a `retro-gates.yaml` record, a ledger record in any state, or a PR on its branch; such a PR parks blocked.
`````
**NEW:**
`````text
  - **Fixed once used.** An Epic number or Story id can't be renumbered or removed once it has a status beyond `backlog` in `sprint-status.yaml`, a `retro-gates.yaml` record, a ledger record in any state, or a PR on its branch; such a PR parks blocked (`graph-invalid`).
`````
**Why:** Same `park.reason` as A-10 for the other graph refusal.

#### A-12 · AD-12 · Done-ness from `sprint-status.yaml`; bootstrapped Epics count
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D1, D2, B2
**OLD:**
`````text
  - **Starting an Epic.** Epic D starts only when every Epic it depends on has all its Stories merged **and its retro done**.
`````
**NEW:**
`````text
  - **Starting an Epic.** Epic D starts only when every Epic it depends on has all its Stories `done` in `sprint-status.yaml` on `main` (AD-9) **and its retro done**. An Epic listed in `bootstrapped_epics` counts as both (AD-11).
`````
**Why:** D1 gives "all its Stories merged" a source that survives the deletion of `merged` records (B2).

#### A-13 · AD-12 · A rejected retro holds until the Maintainer's go
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D13
**OLD:**
`````text
  - **Checkpoints.** A checkpoint Epic C holds every Epic that depends on it, directly or through others, until the Maintainer's go is recorded. Epics already in flight finish the Stories they hold and take no new ones.
`````
**NEW:**
`````text
  - **Checkpoints.** A checkpoint Epic C holds every Epic that depends on it, directly or through others, until the Maintainer's go is recorded. Epics already in flight finish the Stories they hold and take no new ones.
  - **A rejected retro.** A retro verdict `rejected` holds every Epic at distance 1 or more, like a `blocking` item, and puts a course-correction item in the Maintainer's inbox. It holds until the Maintainer's go is recorded (`/xarabot go retro:<N>`, AD-28). `accepted` and `accepted-with-open-items` hold nothing beyond their items.
`````
**Why:** D13 makes a rejected retro hold its dependents and gives the Maintainer the `go` to release it.

#### A-14 · AD-12 · The retro document's `verdict` field and path
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D5, C2
**OLD:**
`````text
    - **Validation.** Before the squash, the runner rejects a result whose items don't match the `action_items` the diff appends one to one, or whose `verdict` differs from the retro document's frontmatter.
`````
**NEW:**
`````text
    - **Validation.** Before the squash, the runner rejects a result whose items don't match the `action_items` the diff appends one to one, or whose `verdict` differs from the `verdict` field in the retro document's frontmatter. The retro document is at the stock path `{implementation_artifacts}/epic-<N>-retro-<date>.md`, found through config `retro_doc_glob` (AD-20).
`````
**Why:** D5 names the stock frontmatter field and the retro document's path, which Story 2.9 compares against.

#### A-15 · AD-13 · Binds CAP-20
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D10
**OLD:**
`````text
- **Binds:** CAP-2, CAP-4, CAP-9.
`````
**NEW:**
`````text
- **Binds:** CAP-2, CAP-4, CAP-9, CAP-20.
`````
**Why:** Under D10, `next` never claims a Story with an open Escalation, so AD-13 now governs part of CAP-20.

#### A-16 · AD-13 · Status and graph planning units hold different paths
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** B3
**OLD:**
`````text
    - Planning units hold the planning paths: the graph inputs (`epics.md`, `.xarabot/epics.yaml`, the manifest directory), `sprint-status.yaml`, `retro-gates.yaml` and the configured Epic context path (`epic-<N>-context.md`). A planning unit that changes a graph input also holds the pseudo-glob `xarabot:graph` (AD-11).
`````
**NEW:**
`````text
    - Planning comes in two kinds of unit:
      - A *status* planning unit runs `bmad-sprint-planning` and compiles Epic context. It holds `sprint-status.yaml`, `retro-gates.yaml` and the configured Epic context path (`epic-<N>-context.md`). It is not approval-gated.
      - A *graph* planning unit writes manifests, `epics.md` and `.xarabot/epics.yaml`. It holds the graph inputs (`epics.md`, `.xarabot/epics.yaml`, the manifest directory) and the pseudo-glob `xarabot:graph` (AD-11). It is approval-gated and never touches status files.
`````
**Why:** B3: one planning unit could not both run `bmad-sprint-planning` and edit graph inputs without failing its own write check.

#### A-17 · AD-13 · Builder eligibility: done, `depends_on`, open Escalations
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D1, D6, D10, B2
**OLD:**
`````text
  - **Builders** take only eligible Stories (AD-12) whose record is absent, `released`, or a stale `claimed` or `merging` record (AD-6), and whose globs don't overlap. They pick the lowest Epic number first, then the lowest Story number.
`````
**NEW:**
`````text
  - **Builders** take only eligible Stories (AD-12) whose record is absent, `released`, or a stale `claimed` or `merging` record (AD-6), and whose globs don't overlap. They pick the lowest Epic number first, then the lowest Story number.
    - A Story is eligible only if it is not `done` in `sprint-status.yaml` on `main`, and each Story in its manifest's `depends_on` is `done` there (AD-10).
    - A Story with an open Escalation (AD-20) is never taken.
`````
**Why:** D1 stops done Stories from being chosen again (B2); D6 and D10 add their eligibility conditions.

#### A-18 · AD-13 · Epic context in status units; coordinator order with the digest slot and graph-before-status
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** B3, D7
**OLD:**
`````text
  - **Epic context.** The coordinator compiles each Epic's BMAD context file (`epic-<N>-context.md`) in planning, before the Epic's Stories become eligible. The runner reverts any change a builder session makes to it before squashing.
  - **The coordinator** works in this order:
    1. `reconcile`:
       - apply rulings;
       - take approved held PRs at `generation` + 1, fence, and enqueue them;
       - write `merged` records;
       - mark units done;
       - route Maintainer-only retro items in batch.
    2. Open coordinator PR.
    3. Planning.
`````
**NEW:**
`````text
  - **Epic context.** The coordinator compiles each Epic's BMAD context file (`epic-<N>-context.md`) in a status planning unit, before the Epic's Stories become eligible. The runner reverts any change a builder session makes to it before squashing.
  - **The coordinator** works in this order:
    1. `reconcile`:
       - apply rulings;
       - take approved held PRs at `generation` + 1, fence, and enqueue them;
       - write `merged` records;
       - mark units done, and write the status entries of a merged graph planning unit;
       - route Maintainer-only retro items (`route: maintainer`) in batch;
       - rewrite each inbox body whose content changed, and post the daily digest comment once `digest_time` has passed (AD-23).
    2. Open coordinator PR.
    3. Planning: a due graph unit before a due status unit.
`````
**Why:** B3 puts Epic context in the status unit, has `reconcile` write a graph unit's status entries and runs a due graph unit first; D7 gives the digest its slot inside `reconcile`.

#### A-19 · AD-14 · Result values
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D5, C2
**OLD:**
`````text
    - `build`: `outcome` (`done` | `blocked` | `no-op`), `blocked` {`kind`, `text`, `step_id`}, `summary`, `body`, `verification[]`.
    - `review`: `reviewed_sha`, `verdict`, `findings[]` {`severity`, `blocking`, `file`, `text`}.
    - `retro`: `verdict`, `items[]` {`id`, `text`, `route`, `blocking`, `globs`}.
    - `planning`: `outcome`, `summary`.
`````
**NEW:**
`````text
    - `build`: `outcome` (`done` | `blocked` | `no-op`), `blocked` {`kind` (`escalation` | `human-live-step` | `intent-gap` | `verification` | `other`), `text`, `step_id`}, `summary`, `body`, `verification[]`.
    - `review`: `reviewed_sha`, `verdict` (`pass` | `changes-requested`), `findings[]` {`severity` (`high` | `medium` | `low`), `blocking` (a separate boolean), `file`, `text`}.
    - `retro`: `verdict` (`accepted` | `accepted-with-open-items` | `rejected`, the stock retro document's frontmatter `verdict`, AD-12), `items[]` {`id`, `text`, `route` (`lane` | `maintainer`), `blocking`, `globs`}.
    - `planning`: `outcome` (`done` | `nothing-due` | `blocked`), `summary`.
`````
**Why:** D5 fixes every result value Story 1.2's schemas need.

#### A-20 · AD-16 · Same-vendor reviewer decided
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D4
**OLD:**
`````text
    - **Single vendor.** If the repo's policy allows no adapter whose provider is outside the set, a separate same-vendor session reviews instead, under every rule below. The reviewer is the first allowed of (`claude`, `codex`); with neither allowed, a `pi` session on the builder's model `[ASSUMPTION: spec § Assumptions, same-vendor reviewer]`.
`````
**NEW:**
`````text
    - **Single vendor.** If the repo's policy allows no adapter whose provider is outside the set, a separate same-vendor session reviews instead, under every rule below. The reviewer is the first allowed of (`claude`, `codex`); with neither allowed, a `pi` session on the builder's model. Decided by the Maintainer (2026-10-21); pi as a reviewer is revisited for v1.
`````
**Why:** D4 confirms the rule and removes the assumption tag.

#### A-21 · AD-17 · Sandbox reads cover the tool binaries
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** C11
**OLD:**
`````text
  - **Reads** are denied by default. Allowed: system paths, the lane's clone, the lane's vendor home and its temp folder. `~/.xarabot/**`, `$XDG_CONFIG_HOME/xarabot` (or `~/.config/xarabot`), `~/.config/gh`, `~/.ssh`, `~/Library/Keychains`, `~/.git-credentials` and `~/.netrc` are always denied.
`````
**NEW:**
`````text
  - **Reads** are denied by default. Allowed: system paths, the lane's clone, the lane's vendor home and its temp folder, and the resolved real paths of the agent CLI, `bun`, `uv`, `git` and the uv-managed Python install, computed at session start. `~/.xarabot/**`, `$XDG_CONFIG_HOME/xarabot` (or `~/.config/xarabot`), `~/.config/gh`, `~/.ssh`, `~/Library/Keychains`, `~/.git-credentials` and `~/.netrc` are always denied.
`````
**Why:** [NEW CHOICE] C11: "system paths" did not cover binaries installed under `~`; the brief supplies this list.

#### A-22 · AD-17 · Environment allowlist, session `HOME`, `XARABOT_SANDBOXED`
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** C11, D3, D9
**OLD:**
`````text
  - **Environment.** Only an allowlist of variables passes through. The git credential helper is reset and Unix sockets are denied.
`````
**NEW:**
`````text
  - **Environment.** Only these variables pass through: `PATH` (rebuilt from allowed directories), `HOME`, `TMPDIR`, `LANG`, `LC_*`, `TERM`, the vendor credential variable, the variable that points the CLI at its vendor home (above), `XARABOT_RESULT`, `XARABOT_SANDBOXED`, the proxy variables and `UV_CACHE_DIR` (in the temp folder). The git credential helper is reset and Unix sockets are denied.
    - The session's `HOME` is a fresh directory inside its temp folder.
    - `XARABOT_SANDBOXED=1` is set for every agent session, never for the lane process. A test suite that sees it skips the cases that would start a nested sandbox and reports them skipped; the Maintainer runs those cases live on the host.
`````
**Why:** [NEW CHOICE] C11's variable list and session `HOME` come from the brief, and I added the vendor-home variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, pi's), which the per-session vendor home above needs. `XARABOT_SANDBOXED` is D3 and D9.

#### A-23 · AD-20 · Binds CAP-20
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D10
**OLD:**
`````text
- **Binds:** CAP-1, CAP-7, CAP-22.
`````
**NEW:**
`````text
- **Binds:** CAP-1, CAP-7, CAP-20, CAP-22.
`````
**Why:** D10's Escalation source is repo-layer config.

#### A-24 · AD-20 · Config fields, Standing Authority frontmatter, 0.x Escalation source
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D2, D5, D7, D10, C2
**OLD:**
`````text
  - **Repo layer:** `.xarabot/` (`config.yaml`, `policy.yaml`, `human-live-steps.yaml`, `epics.yaml`, `prompts/`) plus the Standing Authority file at the path config names. This layer is read **only from freshly fetched `origin/main`**.
  - **Host layer:** `host.yaml`, `XARABOT_HOST` and `XARABOT_MAX_BUILDERS`.
  - **Format.** All config is YAML with a versioned schema.
  - **Standing Authority.** It is valid when it exists on `main` and its YAML frontmatter validates against the Standing Authority schema. `[ASSUMPTION: Xaravel's MAINT file gains that frontmatter in its adoption Epic]`
`````
**NEW:**
`````text
  - **Repo layer:** `.xarabot/` (`config.yaml`, `policy.yaml`, `human-live-steps.yaml`, `epics.yaml`, `prompts/`) plus the Standing Authority file at the path config names. This layer is read **only from freshly fetched `origin/main`**.
  - **`config.yaml` paths and fields**, with defaults:
    - `epics_path` (`_bmad-output/planning-artifacts/epics.md`);
    - `sprint_status_path` (`_bmad-output/implementation-artifacts/sprint-status.yaml`);
    - `retro_gates_path` (`_bmad-output/implementation-artifacts/retro-gates.yaml`);
    - `retro_doc_glob` (`_bmad-output/implementation-artifacts/epic-<N>-retro-*.md`);
    - `epic_context_path` (`_bmad-output/implementation-artifacts/epic-<N>-context.md`);
    - `bootstrapped_epics` (`[]`, AD-11);
    - `digest_time` (`08:00` UTC, AD-23);
    - the optional Escalation source (below).
  - **Host layer:** `host.yaml`, `XARABOT_HOST` and `XARABOT_MAX_BUILDERS`.
  - **Format.** All config is YAML with a versioned schema.
  - **Standing Authority.** It is valid when it exists on `main` and its YAML frontmatter validates against the Standing Authority schema. `[ASSUMPTION: Xaravel's MAINT file gains that frontmatter in its adoption Epic]`
    - `schema_version: 1`.
    - `granted_by`: a GitHub login, equal to config's Maintainer login.
    - `granted_at`: an ISO 8601 date.
    - `repo`: `owner/name`, equal to this repo.
    - `expires` (optional): an ISO 8601 date. A past date makes the file invalid.
    - The body is free prose.
  - **Escalations (0.x).** Config may name an Escalation source, read with Xaravel's rule (Xaravel `tools/escalations/escalations.ts`):
    - Escalation files are `ESC-<story-id>-<n>.md` (or `ESC-bot-<n>.md`) in a configured directory (Xaravel: `conformance/escalations/`).
    - Decision files are `<decisions-dir>/<id>.md`, with the same file name as the Escalation (Xaravel: `decisions/`), carrying `decision: approved | rejected` and `escalation_sha256`, the lowercase hex SHA-256 of the Escalation file's text with CRLF normalised to LF.
    - An Escalation is open when its decision is missing, invalid or stale.
    - A Story with an open Escalation is not claimed and not enqueued: it parks blocked (`park.reason: escalation`, AD-7) and appears in the Maintainer's digest. The snapshot carries the Escalation statuses (AD-27).
`````
**Why:** D5 names the Standing Authority fields and the config paths, D2 and D7 add their fields, and D10 records the 0.x Escalation source that Story 7.6 builds.

#### A-25 · AD-23 · The digest trigger
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D7, C11
**OLD:**
`````text
  - **The digest.** The coordinator rewrites the body daily from the ledger's `parked` records, PR states and `retro-gates.yaml`. Maintainer-only retro items are routed in batch.
`````
**NEW:**
`````text
  - **The digest.** Each `reconcile` run rewrites an owner's issue body from the ledger's `parked` records, PR states, `retro-gates.yaml` and open Escalations (AD-20), when its content changed. GitHub sends no notification for a body edit. Maintainer-only retro items are routed in batch.
    - Once a day, at config `digest_time` (default `08:00` UTC), `reconcile` posts one @mention comment per inbox, linking the body. The last post time is kept in `coordinator.json`.
    - That comment is CAP-9's one daily digest. Urgent alerts (below) are unchanged.
`````
**Why:** D7 gives the daily digest a trigger and stored state.

#### A-26 · AD-24 · When a lane waits on the Maintainer
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** C5
**OLD:**
`````text
  - **The journal.** Each lane appends to `journal.jsonl` one record per unit (the facts from AD-14 plus `outcome`, `loopbacks`, `ci_fixes`) and one record per idle or waiting span, with its reason (`waiting-on-maintainer`, `usage-limit`, `idle`). Subscription cost is labelled an estimate.
`````
**NEW:**
`````text
  - **The journal.** Each lane appends to `journal.jsonl` one record per unit (the facts from AD-14 plus `outcome`, `loopbacks`, `ci_fixes`) and one record per idle or waiting span, with its reason (`waiting-on-maintainer`, `usage-limit`, `idle`). Subscription cost is labelled an estimate.
    - A lane is `waiting-on-maintainer` when `next` returns idle only because of a checkpoint go, a parked approval, a rejected retro, or a Maintainer-routed item.
    - A usage-limit sleep (AD-22) is a `usage-limit` span. Any other idle span is `idle`.
`````
**Why:** C5: no rule said when a span is `waiting-on-maintainer`, and the Stories-per-hour figure leaves those hours out.

#### A-27 · AD-25 · Upgrade PRs, the fixed launcher, switching at process exit
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D8, D9, C11
**OLD:**
`````text
  - **Who changes it.** Only the Maintainer advances `runner_version`, since `.xarabot/**` is protected. Recovery means pinning back.
  - **Install.** `xarabot lane install` installs that version and writes the launchd plist or systemd unit, with a restart throttle (AD-33).
`````
**NEW:**
`````text
  - **Who changes it.** Only the Maintainer advances `runner_version`, since `.xarabot/**` is protected. Recovery means pinning back.
    - `xarabot upgrade <version>`, run by the Maintainer on the Xarabot host, opens the PR as the Maintainer's bot. It has no ledger unit: the Maintainer approves the PR and adds it to the merge queue by hand.
  - **Install.** `xarabot lane install` installs that version and writes the launchd plist or systemd unit, with a restart throttle (AD-33).
    - The job runs a fixed launcher, `~/.xarabot/bin/xarabot-lane <repo> <lane>`. The launcher runs the version named in the lane's `runner` file, in the lane state folder.
    - The launcher never sets `XARABOT_SANDBOXED` for itself; only agent sessions get it (AD-17).
  - **Switching versions at process exit.** A lane that sees a different `runner_version` on `main` installs that version at `~/.xarabot/runner/<version>/`, rewrites `runner`, and exits without claiming; the next start runs it. Pinning back works the same way. Nothing re-execs mid-unit.
`````
**Why:** D9 defines what launchd or systemd runs and how the version switches; D8 places the upgrade PR outside the ledger.

#### A-28 · AD-26 · The App permission table
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** C8, D11, D12
**OLD:**
`````text
  - **`workflows: write`** is deliberately absent. A diff that touches `.github/workflows/**` is a write-check refusal (AD-30).
`````
**NEW:**
`````text
  - **`workflows: write`** is deliberately absent. A diff that touches `.github/workflows/**` is a write-check refusal (AD-30).
  - **One request function.** Every REST and GraphQL call in the GitHub forge adapter goes through one request function. The function takes an entry from a single operation table in the adapter, which names the operation and the App permission it needs. No other code in the adapter calls `fetch`.
  - **Exactly what is used.** A test fails if an operation needs a permission the App manifest does not ask for, or a higher level than it asks for. It also fails if the manifest asks for a permission no operation needs.
  - **The table:**

| Permission | Operations |
| --- | --- |
| `metadata: read` | GitHub grants it to every App; the table lists it so the manifest matches exactly. Repository lookups. |
| `contents: write` | Reading files and trees from `main` for the snapshot and `prefetch`; `ledgerSwap` (`PATCH git/refs` and the commits it writes). Git fetches and pushes (`pushBranch`) also need it; they go through the credential helper (AD-18), not the request function. |
| `pull_requests: write` | PR open, update, close and state reads; `postReview`; `comment` |
| `issues: write` | The inbox issue: its body (`renderDigest`), the daily digest comment, `alert`, `readRulings` and ruling acknowledgements |
| `checks: read`, `statuses: read` | `checks` |
| `actions: read` | `prefetch` of CI logs for a CI-fix session |
| The merge-queue permission (an open item, Deferred) | `enqueue`, `dequeue` |
| None: no installation token | `xarabot join`'s manifest conversion, and the App-JWT calls: reading the App, finding the installation and minting installation tokens |
| `administration: read`, which the App never has | Branch-protection reads for the consumer prerequisite checks (AD-33). They report "unverified", and the lane continues with a warning. |
`````
**Why:** C8 copies Story 5.1's table (now Story 5.1a, D12) into AD-26, with its nits: `metadata: read`, git pushes, `join`'s calls and the `administration: read` reads. I mapped each operation to its permission from the Ports table, because Story 5.1 lists only the permission set.

#### A-29 · AD-27 · The snapshot carries Escalation statuses
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D10
**OLD:**
`````text
    - `sprint-status.yaml` and `retro-gates.yaml`
`````
**NEW:**
`````text
    - `sprint-status.yaml` and `retro-gates.yaml`
    - the Escalation statuses, when config names an Escalation source (AD-20)
`````
**Why:** D10: the snapshot gains the Escalation statuses.

#### A-30 · AD-28 · `go` releases a rejected retro
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D13
**OLD:**
`````text
  - **Grammar:** `/xarabot <verb> <unit-id>`, where the verb is `go` (a checkpoint), `approve` (an Infrastructure Story), `block` or `unblock` (a retro item's `blocking` tag), `rebuild`, `release` or `dismiss`.
`````
**NEW:**
`````text
  - **Grammar:** `/xarabot <verb> <unit-id>`, where the verb is `go` (a checkpoint, or a rejected retro as `go retro:<N>`, AD-12), `approve` (an Infrastructure Story), `block` or `unblock` (a retro item's `blocking` tag), `rebuild`, `release` or `dismiss`.
`````
**Why:** D13 extends `go` from checkpoints to rejected retros, and it stays Maintainer-only.

#### A-31 · AD-29 · Planning splits into status and graph units
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** B3
**OLD:**
`````text
| `planning` | `bmad-sprint-planning`, told to run headless; manifests, Epic context and graph edits (AD-11) |
`````
**NEW:**
`````text
| `planning` (status) | `bmad-sprint-planning`, told to run headless; Epic context |
| `planning` (graph) | none: the prompt names the due manifests (with `depends_on`, AD-10), `epics.md` and `.xarabot/epics.yaml` edits (AD-11) |
`````
**Why:** B3 splits the planning unit so that `bmad-sprint-planning`'s status write and the graph edits never share a diff.

#### A-32 · AD-30 · `epics.md` named among coordinator-owned files
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** C3
**OLD:**
`````text
  - **Builder diffs are refused** if they touch any of: coordinator-owned files (AD-3), manifests, `.xarabot/**`, the Standing Authority file, `.github/**`, agent config at any depth (AD-20), or the repo's Protected Paths.
`````
**NEW:**
`````text
  - **Builder diffs are refused** if they touch any of: coordinator-owned files (AD-3: `sprint-status.yaml`, `retro-gates.yaml`, `epics.md`), manifests, `.xarabot/**`, the Standing Authority file, `.github/**`, agent config at any depth (AD-20), or the repo's Protected Paths.
`````
**Why:** C3: Story 2.3's write check left out `epics.md`, so naming the files here closes the gap.

#### A-33 · AD-30 · Graph planning units; the retro go is runner-only
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** B3, D13
**OLD:**
`````text
  - **Coordinator diffs** may touch only the paths their unit holds (AD-13). Only a `planning` unit may touch a graph input, and under `.xarabot/**` only `.xarabot/epics.yaml`. A diff touching both a graph input and `sprint-status.yaml` or `retro-gates.yaml` is refused.
  - **Retro records.** Any agent diff, builder or coordinator, that changes a retro verdict, a retro item or a checkpoint go in `retro-gates.yaml` is refused (AD-12, AD-28).
`````
**NEW:**
`````text
  - **Coordinator diffs** may touch only the paths their unit holds (AD-13). Only a graph planning unit may touch a graph input, and under `.xarabot/**` only `.xarabot/epics.yaml`. A diff touching both a graph input and `sprint-status.yaml` or `retro-gates.yaml` is refused.
  - **Retro records.** Any agent diff, builder or coordinator, that changes a retro verdict, a retro item, a checkpoint go or a rejected retro's go in `retro-gates.yaml` is refused (AD-12, AD-28).
`````
**Why:** B3 limits graph inputs to graph units; D13's go is written only by `reconcile`'s runner code, like the checkpoint go.

#### A-34 · Consistency Conventions · Tests: live cases are the Maintainer's
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D3
**OLD:**
`````text
| Tests | `bun test`. Core tests are case tables with no mocks. Each gate and each input of `next` has its own test. Adapters are tested through the contract suites. |
`````
**NEW:**
`````text
| Tests | `bun test`. Core tests are case tables with no mocks. Each gate and each input of `next` has its own test. Adapters are tested through the contract suites. Live cases (`bun test --live <suite>`) are run by the Maintainer on the host, outside the sandbox, with the credentials they need, before the Epic's retro; inside a sandboxed session they report skipped, and so do nested sandbox cases (`XARABOT_SANDBOXED=1`, AD-17). |
`````
**Why:** D3 makes the Maintainer the runner of every live proof, which no rule in the spine stated.

#### A-35 · Structural Seed · State diagram: open Escalation parks
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D10
**OLD:**
`````text
  [*] --> parked: Infrastructure Story without approval (needs-approval)
`````
**NEW:**
`````text
  [*] --> parked: Infrastructure Story without approval (needs-approval) / open Escalation (blocked)
`````
**Why:** The diagram is normative (AD-5), and D10 adds a park from no record.

#### A-36 · Structural Seed · Host layout: launcher and `runner` file
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D9
**OLD:**
`````text
~/.xarabot/
  STOP                                # host-wide stop
  runner/<version>/                   # pinned runner (AD-25)
`````
**NEW:**
`````text
~/.xarabot/
  STOP                                # host-wide stop
  bin/xarabot-lane                    # fixed launcher that launchd or systemd runs (AD-25)
  runner/<version>/                   # pinned runner (AD-25)
`````
**Why:** D9's launcher path.

#### A-37 · Structural Seed · Lane folder holds the `runner` file
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D9
**OLD:**
`````text
    journal.jsonl  lane.pid  agent.pid  wait.pid  outcome  STOP
`````
**NEW:**
`````text
    journal.jsonl  lane.pid  agent.pid  wait.pid  outcome  STOP
    runner                            # the runner version the launcher runs (AD-25)
`````
**Why:** D9's lane `runner` file lives in the lane state folder.

#### A-38 · Structural Seed · CLI list gains `upgrade` and `graph`
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D8, C11
**OLD:**
`````text
  cli/         # join, lane install, wake, stop, rule, status, tui, report
`````
**NEW:**
`````text
  cli/         # join, lane install, wake, stop, rule, status, tui, report, upgrade, graph
`````
**Why:** D8 adds `upgrade`; `graph check` (AD-11) was missing from the list.

#### A-39 · Capability map · CAP-9 also governed by AD-13
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D7
**OLD:**
`````text
| CAP-9 Inboxes | `src/adapters/forge`, coordinator | AD-7, AD-23, AD-28 |
`````
**NEW:**
`````text
| CAP-9 Inboxes | `src/adapters/forge`, coordinator | AD-7, AD-13, AD-23, AD-28 |
`````
**Why:** D7 puts the digest's slot in AD-13's `reconcile`.

#### A-40 · Capability map · CAP-20 in 0.x
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D10
**OLD:**
`````text
| CAP-20 Escalations | `src/core` | AD-7, AD-14, AD-28; mechanism Deferred |
`````
**NEW:**
`````text
| CAP-20 Escalations | `src/core` | AD-7, AD-13, AD-14, AD-20, AD-28; 0.x reads the Escalation source in config; the Xarabot-owned mechanism Deferred |
`````
**Why:** D10 makes AD-13 and AD-20 govern 0.x Escalations.

#### A-41 · Deferred · Xarabot-owned Escalations
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D10
**OLD:**
`````text
- **Xarabot-owned Escalations (v1, CAP-20).** In 0.x, Xaravel's `tools/escalations/` is read through config.
`````
**NEW:**
`````text
- **Xarabot-owned Escalations (v1, CAP-20).** In 0.x, the Escalation source in config is read with Xaravel's rule (AD-20), and a Story with an open Escalation is held: it is never claimed or enqueued, and it parks blocked.
`````
**Why:** D10: 0.x holds units with open Escalations.

#### A-42 · Deferred · Open items gain `claude`'s spike
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** C4
**OLD:**
`````text
  - **Adapter Story spikes:** whether `codex exec` and pi give `bmad-build-auto` the subagents it requires; how its outcomes (a `ready-for-dev` halt; it never yields `no-op`) map onto the `build` result; session resume per CLI (AD-14).
`````
**NEW:**
`````text
  - **Adapter Story spikes**, `claude`'s in its first adapter Story, before the code that needs it:
    - for each adapter, how `bmad-build-auto`'s outcomes (a `ready-for-dev` halt; it never yields `no-op`) map onto the `build` result, and session resume (AD-14);
    - for `claude`, the `--output-format` that yields the session id, tokens, model and reset time for `parseUsage`;
    - for `codex exec` and pi, whether they give `bmad-build-auto` the subagents it requires.
`````
**Why:** C4 moves `claude`'s half of the adapter spikes into Story 1.14.


### 4b. Spec (S-1 – S-6), applied through `bmad-spec`

#### S-1 · SPEC Assumptions · Same-vendor reviewer confirmed
**File:** `_bmad-output/specs/spec-xarabot/SPEC.md`
**Decision:** D4, C12
**OLD:**
`````text
- **Same-vendor reviewer:** when the repo allows no adapter from another vendor, the reviewer is the first allowed adapter of `claude`, `codex`; with neither allowed (a pi-only repo), a `pi` session on the builder's model. Not yet confirmed by the Maintainer.
`````
**NEW:**
`````text
- **Same-vendor reviewer:** when the repo allows no adapter from another vendor, the reviewer is the first allowed adapter of `claude`, `codex`; with neither allowed (a pi-only repo), a `pi` session on the builder's model. Confirmed by the Maintainer (2026-10-21); pi as a reviewer is revisited for v1.
`````
**Why:** D4 confirms the rule.

#### S-2 · SPEC Assumptions · Decided and open lists match the spine
**File:** `_bmad-output/specs/spec-xarabot/SPEC.md`
**Decision:** C12, D1, D2, D4, D5, D6, D7, D8, D9, D10, D13, B3, C4, C8
**OLD:**
`````text
- **Decided in the architecture spine** (`../../planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`), including the mechanics the 2026-10-20 spec review raised: the claims ledger on the `xarabot/claims` branch, heartbeat, fencing and takeover (AD-4 to AD-8), the Story manifest (AD-10), the Epic graph and gates (AD-11, AD-12), the result schema (AD-14), one sandbox for every adapter (AD-17), effort mapping (AD-21), keys and App rights (AD-26), the forge port's contract suite and error kinds (AD-27, AD-32) and the write check (AD-30).
- **Still open in the spine:** the App permission the merge queue needs (verified live before the merge-plumbing Story), which `PATCH git/refs` response means "retry the swap", and the local-only adapter (v1).
`````
**NEW:**
`````text
- **Decided in the architecture spine** (`../../planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`), including the mechanics the 2026-10-20 spec review raised and the Maintainer's decisions of 2026-10-21:
  - the claims ledger on the `xarabot/claims` branch, heartbeat, fencing and takeover (AD-4 to AD-8), with the ledger's `park` values (AD-5, AD-7);
  - the Story manifest and its `depends_on` (AD-10);
  - the Epic graph and gates: a Story is done when `sprint-status.yaml` on `main` says so, bootstrapped Epics count as done, and a rejected retro holds its dependents until the Maintainer's go (AD-11, AD-12, AD-28);
  - status and graph planning units, and the coordinator's order (AD-13);
  - the result schema and its values (AD-14);
  - the same-vendor reviewer (AD-16);
  - one sandbox for every adapter (AD-17);
  - the Standing Authority frontmatter, the config paths and the 0.x Escalation source (AD-20);
  - effort mapping (AD-21);
  - the daily digest (AD-23);
  - the pinned runner's launcher, its version switch and upgrade PRs (AD-25);
  - keys, App rights and the App permission table (AD-26);
  - the forge port's contract suite and error kinds (AD-27, AD-32);
  - the write check (AD-30).
- **Still open in the spine:**
  - the App permission the merge queue needs (verified live before the merge-plumbing Story);
  - which `PATCH git/refs` response means "retry the swap" (409 or 422);
  - the adapter spikes: for `claude`, `codex` and `pi`, how `bmad-build-auto`'s outcomes map onto the `build` result and how session resume works; for `claude`, the output format that yields usage; for `codex` and `pi`, whether `bmad-build-auto` gets its subagents;
  - AD-17's two assumptions, spiked in their Stories: pi's vendor-home override and the proxy's hostname allowlist.
  The local-only adapter (v1) is Deferred in the spine, not open.
`````
**Why:** C12: the lists left out the adapter spikes and AD-17's assumptions, listed the Deferred local-only adapter as open, and predate the 2026-10-21 decisions.

#### S-3 · SPEC CAP-4 · A full clone, not a worktree
**File:** `_bmad-output/specs/spec-xarabot/SPEC.md`
**Decision:** Minor (CAP-4 wording)
**OLD:**
`````text
  - **intent:** One Xarabot host, a macOS or Linux computer set in config (`XARABOT_HOST`), runs a coordinator lane (retros, retro action items, planning) and N builder lanes (Stories only), each builder with its own worktree, state folder and scheduled job (launchd or systemd). The host's builder limit is config (`XARABOT_MAX_BUILDERS`).
`````
**NEW:**
`````text
  - **intent:** One Xarabot host, a macOS or Linux computer set in config (`XARABOT_HOST`), runs a coordinator lane (retros, retro action items, planning) and N builder lanes (Stories only), each builder with its own full clone (never a linked worktree), state folder and scheduled job (launchd or systemd). The host's builder limit is config (`XARABOT_MAX_BUILDERS`).
`````
**Why:** AD-17 gives each lane a full clone, never a linked worktree; the spec wording follows it.

#### S-4 · SPEC CAP-18 · Sandbox wording: the unit's clone
**File:** `_bmad-output/specs/spec-xarabot/SPEC.md`
**Decision:** Minor (CAP-4 wording)
**OLD:**
`````text
    - **Sandbox (0.x):** the coding agent runs with only its unit's worktree writable, and with no GitHub credentials and no GitHub host (§ Constraints, "Agents never touch GitHub").
`````
**NEW:**
`````text
    - **Sandbox (0.x):** the coding agent runs with only its unit's clone writable, and with no GitHub credentials and no GitHub host (§ Constraints, "Agents never touch GitHub").
`````
**Why:** This is the same worktree-versus-clone wording as S-3, and the caller can drop it to keep the spec change to CAP-4 only.

#### S-5 · SPEC Operating limits · The one-time Maintainer write
**File:** `_bmad-output/specs/spec-xarabot/SPEC.md`
**Decision:** D2
**OLD:**
`````text
- **Write authority:** the coordinator lane is the only writer of `sprint-status.yaml` and `retro-gates.yaml`; the 0.x write check (CAP-18) enforces it on builder diffs.
`````
**NEW:**
`````text
- **Write authority:** the coordinator lane is the only writer of `sprint-status.yaml` and `retro-gates.yaml`; the 0.x write check (CAP-18) enforces it on builder diffs. The one exception is the Maintainer's one-time write at Xarabot's self-host switch, which creates `sprint-status.yaml` with the bootstrapped Epic's Stories done.
`````
**Why:** D2's one-time Maintainer write would otherwise contradict this constraint, which AGENTS.md says to keep consistent with SPEC.md.

#### S-6 · releases.md · CAP-20 placement note
**File:** `_bmad-output/specs/spec-xarabot/releases.md`
**Decision:** D10
**OLD:**
`````text
- **CAP-20 in Xaravel:** Xaravel already has hash-bound escalations (`tools/escalations/`). Under 0.x Xarabot reads them through config; v1 makes the mechanism Xarabot-owned.
`````
**NEW:**
`````text
- **CAP-20 in Xaravel:** Xaravel already has hash-bound escalations (`tools/escalations/`). Under 0.x Xarabot reads them through config with Xaravel's rule, and a Story with an open Escalation is neither claimed nor enqueued (2026-10-21); v1 makes the mechanism Xarabot-owned.
`````
**Why:** D10: 0.x now holds units with open Escalations, not only lists them.

### 4c. Requirements inventory, Epic List and Epic 1

#### E-INV-a · AR1 · `Forge` gains `comment`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D11
**OLD:**
`````text
- AR1 (Paradigm, layers): functional core, imperative shell, ports and adapters. Layers and allowed imports: `src/core/` (core only); `src/ports/` (core); `src/adapters/forge/*` and `src/adapters/agent/*` (ports, core); `src/sandbox/` (ports, core); `src/lane/` (everything above); `src/cli/` (lane and everything it may import). Ports: `Forge` (`snapshot()` with ledger tip, `main` SHA, PR states and server `now`; `ledgerSwap(oldSha, edit)` returning `ok` or `conflict`; `pushBranch(lease)`; PR open/update/close; `postReview`; `checks`; `enqueue(expectedHead)`; `dequeue`; inbox `renderDigest`, `alert`, `readRulings(cursor)`; `prefetch(kind)`; no approve operation), `Agent` (`launchSpec`, `parseUsage`, `effortValues`), `Sandbox` (`run(LaunchSpec, profile)`, the only agent spawner), `LaneStore` (PIDs, journal, outcome, STOP). The compare-and-swap retry loop lives in `src/lane/`; adapters do one attempt per call.
`````
**NEW:**
`````text
- AR1 (Paradigm, layers): functional core, imperative shell, ports and adapters. Layers and allowed imports: `src/core/` (core only); `src/ports/` (core); `src/adapters/forge/*` and `src/adapters/agent/*` (ports, core); `src/sandbox/` (ports, core); `src/lane/` (everything above); `src/cli/` (lane and everything it may import). Ports: `Forge` (`snapshot()` with ledger tip, `main` SHA, PR states and server `now`; `ledgerSwap(oldSha, edit)` returning `ok` or `conflict`; `pushBranch(lease)`; PR open/update/close; `comment(pr, body)` for 🤖 status comments; `postReview`; `checks`; `enqueue(expectedHead)`; `dequeue`; inbox `renderDigest`, `alert`, `readRulings(cursor)`; `prefetch(kind)`; no approve operation), `Agent` (`launchSpec`, `parseUsage`, `effortValues`), `Sandbox` (`run(LaunchSpec, profile)`, the only agent spawner), `LaneStore` (PIDs, journal, outcome, STOP). The compare-and-swap retry loop lives in `src/lane/`; adapters do one attempt per call.
`````
**Why:** The spine's Ports table gains `comment(pr, body)` for the 🤖 status comments that Story 1.16 posts.

#### E-INV-b · AR4 · One-time Maintainer write of sprint status
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D2
**OLD:**
`````text
- AR4 (AD-3): every piece of state has one home and one writer, per the spine's AD-3 table (sprint status: coordinator; `retro-gates.yaml`: `reconcile` runner code only; ledger records by state; forge objects: the runner; the `status:` line of the unit's own Story file: the agent session; journal, PIDs, outcome: the lane process; `STOP`: the operator). Any other write is a defect.
`````
**NEW:**
`````text
- AR4 (AD-3): every piece of state has one home and one writer, per the spine's AD-3 table (sprint status: coordinator, with one exception: the Maintainer's one-time write at the self-host switch that creates `sprint-status.yaml` with Epic 1's Stories `done`; `retro-gates.yaml`: `reconcile` runner code only; ledger records by state; forge objects: the runner; the `status:` line of the unit's own Story file: the agent session; journal, PIDs, outcome: the lane process; `STOP`: the operator). Any other write is a defect.
`````
**Why:** AD-3's table records the Maintainer's one-time creation of `sprint-status.yaml` at the self-host switch as an exception.

#### E-INV-c · AR6 · `park` enums
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D5
**OLD:**
`````text
- AR6 (AD-5): ledger records are a versioned state machine with the fields `schema_version`, `unit`, `state`, `owner`, `host`, `lane`, `generation`, `globs`, `heartbeat_at`, `pr`, `pr_owner`, `base_sha`, `head_sha`, `reviewed_sha`, `passed_sha`, `approved_sha`, `builder_providers[]`, `park` {`kind`, `reason`, `inbox_owner`, `globs_held`}, `attempts`, `loopbacks`, `ci_fixes`, `approval` {`by`, `manifest_sha`}. States `claimed`, `merging`, `parked`, `released`, `merged`; the Structural Seed state diagram is normative. Only `merged` records are deleted (by the coordinator); `generation` only goes up; `attempts` survives release. `now` is the forge server's time from `Forge.snapshot()` (host clock only in local-only mode and for sleep lengths). An unknown or newer `schema_version` stops the lane before `next`, with an alert. `host` is a UUID written to `host.yaml` by `xarabot lane install`.
`````
**NEW:**
`````text
- AR6 (AD-5): ledger records are a versioned state machine with the fields `schema_version`, `unit`, `state`, `owner`, `host`, `lane`, `generation`, `globs`, `heartbeat_at`, `pr`, `pr_owner`, `base_sha`, `head_sha`, `reviewed_sha`, `passed_sha`, `approved_sha`, `builder_providers[]`, `park` {`kind` (`awaiting-approval` | `needs-approval` | `blocked`), `reason` (a `blocked.kind`, or a runner cause: `review-cap` | `ci-fix-cap` | `ci-timeout` | `write-check` | `no-op` | `attempts-cap` | `unclaimable` | `graph-invalid`), `inbox_owner`, `globs_held`}, `attempts`, `loopbacks`, `ci_fixes`, `approval` {`by`, `manifest_sha`}. States `claimed`, `merging`, `parked`, `released`, `merged`; the Structural Seed state diagram is normative. Only `merged` records are deleted (by the coordinator); `generation` only goes up; `attempts` survives release. `now` is the forge server's time from `Forge.snapshot()` (host clock only in local-only mode and for sleep lengths). An unknown or newer `schema_version` stops the lane before `next`, with an alert. `host` is a UUID written to `host.yaml` by `xarabot lane install`.
`````
**Why:** Story 1.5 builds the record schema from AR6, so the `park.kind` and `park.reason` values must be listed here.

#### E-INV-d · AR11 · Meaning of manifest `depends_on`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D6
**OLD:**
`````text
- AR11 (AD-10): the Story manifest is one file per Story in a repo-configured directory (Xaravel: `stories/<id>.md`); config says whether it doubles as the BMAD Story file. Required frontmatter `story_id`, `epic`, `sprint_key`, `title`; paths as `globs` or a repo-mapped key (Xaravel: `component`); optional `depends_on`, `infrastructure: true`; repo-only fields and `status` ignored. Glob normalization: strip `./`; reject `!`, `..` and absolute paths; compare by case-folded character prefix; globs overlap unless their literal prefixes are disjoint. Resolved globs are stored at claim time. A Story whose globs resolve to nothing is unclaimable and goes to the inbox. Outside its globs a Story's diff may carry only its own BMAD Story spec file (`story_spec_path`, default `implementation_artifacts/spec-<sprint_key>.md`) and the `status:` line of its own Story file. Infrastructure Stories are claimable only with a ledger approval whose `manifest_sha` matches.
`````
**NEW:**
`````text
- AR11 (AD-10): the Story manifest is one file per Story in a repo-configured directory (Xaravel: `stories/<id>.md`); config says whether it doubles as the BMAD Story file. Required frontmatter `story_id`, `epic`, `sprint_key`, `title`; paths as `globs` or a repo-mapped key (Xaravel: `component`); optional `depends_on` (a list of Story ids, each in the same Epic or an Epic it depends on, transitively; the Story is eligible only once each listed Story is `done` in `sprint-status.yaml`; planning units write it where a Story builds on an earlier one), `infrastructure: true`; repo-only fields and `status` ignored. Glob normalization: strip `./`; reject `!`, `..` and absolute paths; compare by case-folded character prefix; globs overlap unless their literal prefixes are disjoint. Resolved globs are stored at claim time. A Story whose globs resolve to nothing is unclaimable and goes to the inbox. Outside its globs a Story's diff may carry only its own BMAD Story spec file (`story_spec_path`, default `implementation_artifacts/spec-<sprint_key>.md`) and the `status:` line of its own Story file. Infrastructure Stories are claimable only with a ledger approval whose `manifest_sha` matches.
`````
**Why:** D6 gives `depends_on` its meaning, its scope rule and its writer.

#### E-INV-e · AR12 · Bootstrapped Epics and `depends_on` validation
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D2, D6
**OLD:**
`````text
- AR12 (AD-11): one pure `resolveGraph(snapshot)` in `src/core` builds the effective graph from `.xarabot/epics.yaml`, the Epic and Story headings in `epics.md`, each manifest's `epic` and the package edges, from one `main` SHA; gates and `next` read only its output. Strict versioned schema (`version`; `epics` map; keys `^[1-9][0-9]*$` converted to numbers; `depends_on` a list of positive integers; `checkpoint` only literal `true`; duplicate keys detected from the raw text; multi-document or null `epics` invalid). Default: an unlisted Epic, or one without `depends_on`, depends on the next lower Epic number in `epics.md`; no file means serial; checkpoints never inferred. The `epics.md` grammar is stock output: Epic = level-2 `## Epic <int>:` outside fenced code (lines under `## Epic List` ignored); Story = level-3 `### Story <int>.<int>[a-z]?:` under its Epic. An Epic's Stories are exactly the manifests naming it; a heading with no manifest is unclaimable, listed in the Maintainer's inbox, and keeps its Epic from being done. Absence of the file is decided only from the tree listing; other read errors fail closed. Validation (invalid file, unknown Epic, cycle, manifest mismatch, a checkpoint wait the graph doesn't mark) stops every lane with an alert. Graph-changing PRs: validated on the merge result before enqueue, hold the pseudo-glob `xarabot:graph`, need the Maintainer's approval with `approved_graph` hash re-checked at enqueue, and get the delta posted on the PR. Epic numbers and Story ids are fixed once used; only a checkpoint with a recorded go may be retired. The same validator ships as `xarabot graph check`.
`````
**NEW:**
`````text
- AR12 (AD-11): one pure `resolveGraph(snapshot)` in `src/core` builds the effective graph from `.xarabot/epics.yaml`, the Epic and Story headings in `epics.md`, each manifest's `epic` and the package edges, from one `main` SHA; gates and `next` read only its output. Strict versioned schema (`version`; `epics` map; keys `^[1-9][0-9]*$` converted to numbers; `depends_on` a list of positive integers; `checkpoint` only literal `true`; duplicate keys detected from the raw text; multi-document or null `epics` invalid). Default: an unlisted Epic, or one without `depends_on`, depends on the next lower Epic number in `epics.md`; no file means serial; checkpoints never inferred. The `epics.md` grammar is stock output: Epic = level-2 `## Epic <int>:` outside fenced code (lines under `## Epic List` ignored); Story = level-3 `### Story <int>.<int>[a-z]?:` under its Epic. An Epic's Stories are exactly the manifests naming it; a heading with no manifest is unclaimable, listed in the Maintainer's inbox, and keeps its Epic from being done; an Epic with no Stories is never done. An Epic listed in config's `bootstrapped_epics` (a Maintainer-approved list of Epic numbers, default `[]`; Xarabot's own repo sets `[1]` at the self-host switch) reads as all Stories done and retro done, is exempt from that rule, and its Story headings are not reported as unclaimable. Absence of the file is decided only from the tree listing; other read errors fail closed. Validation (invalid file, unknown Epic, cycle, manifest mismatch, a manifest `depends_on` naming a Story outside its own Epic and the Epics it depends on, a checkpoint wait the graph doesn't mark) stops every lane with an alert. Graph-changing PRs: validated on the merge result before enqueue, hold the pseudo-glob `xarabot:graph`, need the Maintainer's approval with `approved_graph` hash re-checked at enqueue, and get the delta posted on the PR. Epic numbers and Story ids are fixed once used; only a checkpoint with a recorded go may be retired. The same validator ships as `xarabot graph check`.
`````
**Why:** D2 adds the `bootstrapped_epics` exemption and D6 adds a `depends_on` row to AD-11's validation list.

#### E-INV-f · AR13 · Done-ness from sprint status; a rejected retro holds
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D1, D2, D5, D13
**OLD:**
`````text
- AR13 (AD-12): gates on the graph, measuring distance along dependency edges from Epic E: Epic D starts only when every Epic it depends on has all Stories merged and its retro done; a `blocking` item holds every Epic at distance ≥ 1, any other open item (`open`, `in-progress`, `waiting`) holds distance ≥ 2; a checkpoint holds all transitive dependents until the go, while in-flight Epics finish held Stories. Retro results carry each item's stock BMAD action-item id (`epic-<N>-retro-item-<seq>-<slug>`), `blocking`, `route` and `globs`; the runner validates them one to one against the `action_items` the diff appends and the verdict against the retro document's frontmatter, stores the result in the ledger record, and `reconcile` writes `retro-gates.yaml` once. Graph changes take effect at the next claim.
`````
**NEW:**
`````text
- AR13 (AD-12): gates on the graph, measuring distance along dependency edges from Epic E: Epic D starts only when every Epic it depends on has all its Stories `done` in `sprint-status.yaml` on `main` and its retro done (an Epic in `bootstrapped_epics` counts as both); a `blocking` item holds every Epic at distance ≥ 1, any other open item (`open`, `in-progress`, `waiting`) holds distance ≥ 2; a retro verdict `rejected` holds every Epic at distance ≥ 1, like a `blocking` item, and puts a course-correction item in the Maintainer's inbox until the Maintainer's `/xarabot go retro:<N>` (`accepted` and `accepted-with-open-items` release as before); a checkpoint holds all transitive dependents until the go, while in-flight Epics finish held Stories. Retro results carry each item's stock BMAD action-item id (`epic-<N>-retro-item-<seq>-<slug>`), `blocking`, `route` and `globs`; the runner validates them one to one against the `action_items` the diff appends and the verdict against the `verdict` field of the stock retro document's frontmatter (`{implementation_artifacts}/epic-<N>-retro-<date>.md`), stores the result in the ledger record, and `reconcile` writes `retro-gates.yaml` once. Graph changes take effect at the next claim.
`````
**Why:** D1 defines "all Stories merged" through `sprint-status.yaml`, D13 makes a rejected retro hold its dependents, and D5 names the retro document's field and path.

#### E-INV-g · AR14 · Eligibility, planning split, digest in `reconcile`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D1, D6, D7, B3
**OLD:**
`````text
- AR14 (AD-13): `next(snapshot, laneRole)` returns a unit or `idle` with a reason. Every unit kind holds globs (planning: graph inputs, status files and the Epic context path, plus `xarabot:graph` when it changes a graph input; retro and checkpoint: status files and Epic context, never graph inputs; retro items: their `globs` from `retro-gates.yaml`, never graph inputs, status files or write-check paths, unclaimable without globs; `reconcile`: none; a parked approval-gated PR: only its diff's paths); the overlap check applies to every role. Builders take only eligible Stories whose record is absent, `released` or stale, lowest Epic number first, then lowest Story number. The coordinator compiles each Epic's `epic-<N>-context.md` in planning before its Stories become eligible; the runner reverts builder changes to it. Coordinator order: `reconcile` (apply rulings; enqueue approved held PRs; write `merged`; mark done; batch-route Maintainer-only retro items), open coordinator PR, planning, retro, retro items, checkpoint. Approval-gated coordinator PRs never touch the status files.
`````
**NEW:**
`````text
- AR14 (AD-13): `next(snapshot, laneRole)` returns a unit or `idle` with a reason. Every unit kind holds globs (planning comes in two kinds: a status unit, which runs `bmad-sprint-planning` and compiles Epic context, holds the status files and the Epic context path and is not approval-gated; a graph unit holds the graph inputs and `xarabot:graph`, is approval-gated and never touches the status files; retro and checkpoint: status files and Epic context, never graph inputs; retro items: their `globs` from `retro-gates.yaml`, never graph inputs, status files or write-check paths, unclaimable without globs; `reconcile`: none; a parked approval-gated PR: only its diff's paths); the overlap check applies to every role. Builders take only eligible Stories that are not `done` in `sprint-status.yaml` on `main`, whose record is absent, `released` or stale, and whose manifest `depends_on` Stories are all `done` there, lowest Epic number first, then lowest Story number. The coordinator compiles each Epic's `epic-<N>-context.md` in a planning status unit before its Stories become eligible; the runner reverts builder changes to it. Coordinator order: `reconcile` (apply rulings; enqueue approved held PRs; write `merged`; mark done; batch-route Maintainer-only retro items; rewrite each changed inbox digest and post the daily digest mention, AR24), open coordinator PR, planning (a due graph unit before a status unit), retro, retro items, checkpoint. Approval-gated coordinator PRs never touch the status files; after a graph unit merges, `reconcile` writes its status entries.
`````
**Why:** D1 and D6 add the `sprint-status.yaml` and `depends_on` conditions to builder eligibility, B3 splits planning into a status unit and a graph unit, and D7 puts the digest in `reconcile`.

#### E-INV-h · AR15 · Result enums
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D5, C4
**OLD:**
`````text
- AR15 (AD-14): every session writes JSON to `XARABOT_RESULT` (in the sandbox temp folder, outside the clone) as the prompt's last step, never from a skill hook. Union keyed by `kind`: `build` (`outcome` `done`/`blocked`/`no-op`, `blocked` {`kind`, `text`, `step_id`}, `summary`, `body`, `verification[]`); `review` (`reviewed_sha`, `verdict`, `findings[]` {`severity`, `blocking`, `file`, `text`}); `retro` (`verdict`, `items[]` {`id`, `text`, `route`, `blocking`, `globs`}); `planning` (`outcome`, `summary`); all carry `denied_actions[]`. A missing result gets one resume asking only for the result (`claude -p --resume`; codex and pi confirmed in their adapter Stories); builds also cross-check the Story spec's `status` and `## Auto Run Result`. Still missing or invalid → failed attempt. Agent, model, effort, tokens, cost, timings, diff, files touched and authorship are never taken from the agent.
`````
**NEW:**
`````text
- AR15 (AD-14): every session writes JSON to `XARABOT_RESULT` (in the sandbox temp folder, outside the clone) as the prompt's last step, never from a skill hook. Union keyed by `kind`: `build` (`outcome` `done`/`blocked`/`no-op`, `blocked` {`kind` `escalation`/`human-live-step`/`intent-gap`/`verification`/`other`, `text`, `step_id`}, `summary`, `body`, `verification[]`); `review` (`reviewed_sha`, `verdict` `pass`/`changes-requested`, `findings[]` {`severity` `high`/`medium`/`low`, `blocking` a separate boolean, `file`, `text`}); `retro` (`verdict` `accepted`/`accepted-with-open-items`/`rejected`, `items[]` {`id`, `text`, `route` `lane`/`maintainer`, `blocking`, `globs`}); `planning` (`outcome` `done`/`nothing-due`/`blocked`, `summary`); all carry `denied_actions[]`. A missing result gets one resume asking only for the result (`claude -p --resume`, confirmed in Story 1.14; codex and pi confirmed in their adapter Stories); builds also cross-check the Story spec's `status` and `## Auto Run Result`. Still missing or invalid → failed attempt. Agent, model, effort, tokens, cost, timings, diff, files touched and authorship are never taken from the agent.
`````
**Why:** D5 fixes every enumerated result value, and C4 moves the `claude` resume check into Story 1.14.

#### E-INV-i · AR17 · Same-vendor reviewer decided
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D4
**OLD:**
`````text
- AR17 (AD-16): the reviewer must come from a provider not in `builder_providers[]`: the first allowed adapter of (`claude`, `codex`) whose provider is outside the set (provider = the model's vendor; pi's from its `<provider>/<id>`); if the policy allows none, a separate same-vendor session reviews under the same rules (the first allowed of `claude`, `codex`, else `pi` on the builder's model, a spec assumption); a session whose reported model differs from config fails. The review runs on a fresh `runner.git` checkout of `head_sha` with agent config paths restored from `main`, hooks off and a freshly seeded vendor home; the runner records `reviewed_sha` and posts the review naming it. No blocking findings → `passed_sha`. Enqueue only if the head equals `passed_sha` or its tree equals the merge of `passed_sha` with the head's `main` parent, recomputed by the enqueuing lane. Owner-gated PRs need `approved_sha` = head; graph-changing PRs need the Maintainer's approval on the head and a matching `approved_graph`. `reconcile` PRs get no agent review. Any later agent change re-runs the review, each re-run a loopback, at most 2. A lane refuses to start if its reviewer adapter isn't allowed.
`````
**NEW:**
`````text
- AR17 (AD-16): the reviewer must come from a provider not in `builder_providers[]`: the first allowed adapter of (`claude`, `codex`) whose provider is outside the set (provider = the model's vendor; pi's from its `<provider>/<id>`); if the policy allows none, a separate same-vendor session reviews under the same rules (the first allowed of `claude`, `codex`, else `pi` on the builder's model; decided by the Maintainer 2026-10-21, with pi as a reviewer revisited for v1); a session whose reported model differs from config fails. The review runs on a fresh `runner.git` checkout of `head_sha` with agent config paths restored from `main`, hooks off and a freshly seeded vendor home; the runner records `reviewed_sha` and posts the review naming it. No blocking findings → `passed_sha`. Enqueue only if the head equals `passed_sha` or its tree equals the merge of `passed_sha` with the head's `main` parent, recomputed by the enqueuing lane. Owner-gated PRs need `approved_sha` = head; graph-changing PRs need the Maintainer's approval on the head and a matching `approved_graph`. `reconcile` PRs get no agent review. Any later agent change re-runs the review, each re-run a loopback, at most 2. A lane refuses to start if its reviewer adapter isn't allowed.
`````
**Why:** D4 confirms the same-vendor reviewer rule, so it is no longer an assumption.

#### E-INV-j · AR18 · Sandbox reads, `HOME` and env allowlist
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C11
**OLD:**
`````text
- AR18 (AD-17): only `src/sandbox/` spawns agent and reviewer processes; a lint rule bans `Bun.spawn` under `src/adapters/agent/`. macOS: `sandbox-exec` with a generated profile, re-tested on each macOS major; Linux: `bwrap` with `--unshare-pid`; each agent's own sandbox off inside it. A per-lane vendor home under the state folder is re-seeded before every session with only that vendor's credential (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, pi's agent directory; on macOS `claude` gets `CLAUDE_CODE_OAUTH_TOKEN`); the operator's `~/.claude`, `~/.codex`, `~/.pi` are inaccessible. Reads denied by default except system paths, the lane clone, vendor home and temp folder; `~/.xarabot/**`, `$XDG_CONFIG_HOME/xarabot`, `~/.config/gh`, `~/.ssh`, `~/Library/Keychains`, `~/.git-credentials`, `~/.netrc` always denied. Writes allowed to the full clone (never a linked worktree), vendor home and temp folder; `runner.git` never accessible. Env allowlist only; git credential helper reset; Unix sockets denied. Network only through Xarabot's Bun proxy to vendor API hosts, `pypi.org`, `files.pythonhosted.org` and repo-added hosts; a GitHub host is never allowed. Fail closed if the sandbox can't be set up.
`````
**NEW:**
`````text
- AR18 (AD-17): only `src/sandbox/` spawns agent and reviewer processes; a lint rule bans `Bun.spawn` under `src/adapters/agent/`. macOS: `sandbox-exec` with a generated profile, re-tested on each macOS major; Linux: `bwrap` with `--unshare-pid`; each agent's own sandbox off inside it. A per-lane vendor home under the state folder is re-seeded before every session with only that vendor's credential (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, pi's agent directory; on macOS `claude` gets `CLAUDE_CODE_OAUTH_TOKEN`); the operator's `~/.claude`, `~/.codex`, `~/.pi` are inaccessible. Reads denied by default except system paths, the resolved real paths of the agent CLI, `bun`, `uv`, `git` and the uv-managed Python install (computed at session start), the lane clone, vendor home and temp folder; the session's `HOME` is a fresh directory inside the temp folder; `~/.xarabot/**`, `$XDG_CONFIG_HOME/xarabot`, `~/.config/gh`, `~/.ssh`, `~/Library/Keychains`, `~/.git-credentials`, `~/.netrc` always denied. Writes allowed to the full clone (never a linked worktree), vendor home and temp folder; `runner.git` never accessible. Env allowlist only: `PATH` (rebuilt from allowed directories), `HOME`, `TMPDIR`, `LANG`, `LC_*`, `TERM`, the vendor credential variable, `XARABOT_RESULT`, `XARABOT_SANDBOXED`, the proxy variables and `UV_CACHE_DIR` (in the temp folder); git credential helper reset; Unix sockets denied. Network only through Xarabot's Bun proxy to vendor API hosts, `pypi.org`, `files.pythonhosted.org` and repo-added hosts; a GitHub host is never allowed. Fail closed if the sandbox can't be set up.
`````
**Why:** [NEW CHOICE] The brief's C11 choice: binaries under `~` stay readable, the session gets its own `HOME`, and the env allowlist is named.

#### E-INV-k · AR21 · Standing Authority fields and new config fields
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D2, D5, D7, D10
**OLD:**
`````text
- AR21 (AD-20): config in three layers: package (defaults, schemas, prompt template); repo (`.xarabot/config.yaml`, `policy.yaml`, `human-live-steps.yaml`, `epics.yaml`, `prompts/`, plus the Standing Authority file at the configured path), read only from freshly fetched `origin/main`; host (`host.yaml`, `XARABOT_HOST`, `XARABOT_MAX_BUILDERS`). All YAML with versioned schemas. The Standing Authority is valid when it exists on `main` and its YAML frontmatter validates. Missing, invalid or unfetchable config, policy or Standing Authority stops the lane (an absent `epics.yaml` alone means serial). Re-checked from fresh `main`: the Standing Authority before every claim, push, enqueue and merge; adapter and reviewer allowances before every session launch and enqueue. Consumer Protected Paths: `.xarabot/**`, the Standing Authority file, `.github/**`, and agent config at any depth (`**/.agents/**`, `**/.claude/**`, `**/.codex/**`, `**/.pi/**`, `**/.mcp.json`, `**/AGENTS.md`, `**/CLAUDE.md`).
`````
**NEW:**
`````text
- AR21 (AD-20): config in three layers: package (defaults, schemas, prompt template); repo (`.xarabot/config.yaml`, `policy.yaml`, `human-live-steps.yaml`, `epics.yaml`, `prompts/`, plus the Standing Authority file at the configured path), read only from freshly fetched `origin/main`; host (`host.yaml`, `XARABOT_HOST`, `XARABOT_MAX_BUILDERS`). All YAML with versioned schemas. The Standing Authority is valid when it exists on `main` and its YAML frontmatter validates: `schema_version: 1`; `granted_by` (a GitHub login equal to config's Maintainer login); `granted_at` (ISO 8601 date); `repo` (`owner/name`, equal to this repo); optional `expires` (ISO 8601 date; a past date makes it invalid); the body is free prose. `.xarabot/config.yaml` also holds the planning paths, with defaults: `epics_path` (`_bmad-output/planning-artifacts/epics.md`), `sprint_status_path` (`_bmad-output/implementation-artifacts/sprint-status.yaml`), `retro_gates_path` (`_bmad-output/implementation-artifacts/retro-gates.yaml`), `retro_doc_glob` (`_bmad-output/implementation-artifacts/epic-<N>-retro-*.md`) and `epic_context_path` (`_bmad-output/implementation-artifacts/epic-<N>-context.md`); `bootstrapped_epics` (default `[]`, AR12); `digest_time` (default `08:00` UTC, AR24); and an optional Escalation source read with Xaravel's rule (source: Xaravel `tools/escalations/escalations.ts`): Escalation files `ESC-<story-id>-<n>.md` or `ESC-bot-<n>.md` in a configured directory, and decision files `<decisions-dir>/ESC-<id>.md` carrying `decision: approved | rejected` and `escalation_sha256`, the lowercase hex SHA-256 of the Escalation file's text with CRLF normalised to LF. An Escalation is open when its decision is missing, invalid or stale; a Story with an open Escalation is not claimed or enqueued, parks blocked (`park.reason: escalation`) and appears in the Maintainer's digest (Story 7.6). Missing, invalid or unfetchable config, policy or Standing Authority stops the lane (an absent `epics.yaml` alone means serial). Re-checked from fresh `main`: the Standing Authority before every claim, push, enqueue and merge; adapter and reviewer allowances before every session launch and enqueue. Consumer Protected Paths: `.xarabot/**`, the Standing Authority file, `.github/**`, and agent config at any depth (`**/.agents/**`, `**/.claude/**`, `**/.codex/**`, `**/.pi/**`, `**/.mcp.json`, `**/AGENTS.md`, `**/CLAUDE.md`).
`````
**Why:** D5 names the Standing Authority frontmatter and the planning paths, D2 and D7 add `bootstrapped_epics` and `digest_time`, and D10 adds the optional Escalation source.

#### E-INV-l · AR24 · Digest trigger
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D7
**OLD:**
`````text
- AR24 (AD-23): one `xarabot-inbox`-labelled issue per owner, assigned to them; only the Maintainer's is pinned, by hand. The coordinator rewrites the digest daily from `parked` records, PR states and `retro-gates.yaml`, routing Maintainer-only retro items in batch. Any lane may post a single @mention alert for a condition that newly stops every lane, deduplicated by (condition, `main` SHA), allowed even while failing closed. The App gains `issues: write`.
`````
**NEW:**
`````text
- AR24 (AD-23): one `xarabot-inbox`-labelled issue per owner, assigned to them; only the Maintainer's is pinned, by hand. Each `reconcile` run rewrites an owner's issue body from `parked` records, PR states and `retro-gates.yaml` when its content changed, routing Maintainer-only retro items in batch. GitHub sends no notification for a body edit, so once a day, at config `digest_time` (default `08:00` UTC), `reconcile` posts one @mention comment per inbox linking the body, keeping the last post time in `coordinator.json`; that is FR9's one daily digest. Any lane may post a single @mention alert for a condition that newly stops every lane, deduplicated by (condition, `main` SHA), allowed even while failing closed. The App gains `issues: write`.
`````
**Why:** D7 gives the daily digest a trigger, a schedule and stored state.

#### E-INV-m · AR26 · Fixed launcher and runner switch at exit
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D9
**OLD:**
`````text
- AR26 (AD-25): a lane runs `~/.xarabot/runner/<version>/`, the version from `runner_version` in `.xarabot/config.yaml` on `origin/main`. A consumer's exact `@xaravel/xarabot` pin must equal `runner_version` or the lane refuses to start; Xarabot's own repo uses `runner_version` alone. Only the Maintainer advances it. `xarabot lane install` installs that version and writes the launchd plist or systemd unit with a restart throttle.
`````
**NEW:**
`````text
- AR26 (AD-25): a lane runs `~/.xarabot/runner/<version>/`, the version from `runner_version` in `.xarabot/config.yaml` on `origin/main`. A consumer's exact `@xaravel/xarabot` pin must equal `runner_version` or the lane refuses to start; Xarabot's own repo uses `runner_version` alone. Only the Maintainer advances it. `xarabot lane install` installs that version and writes the launchd plist or systemd unit, with a restart throttle, to run a fixed launcher, `~/.xarabot/bin/xarabot-lane <repo> <lane>`, which runs the version named in the lane's `runner` file (in the lane state folder) and sets `XARABOT_SANDBOXED` only for agent sessions, never for itself. A lane that sees a different `runner_version` on `main` installs that version at `~/.xarabot/runner/<version>/`, rewrites `runner` and exits without claiming; the next start runs it. Pinning back works the same way, and nothing re-execs mid-unit.
`````
**Why:** D9 records what launchd runs and how a lane switches runner versions.

#### E-INV-n · AR27 · App permission set
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C8, D12
**OLD:**
`````text
- AR27 (AD-26, adopted from `bootstrap/join.ts`): the App key lives at `$XDG_CONFIG_HOME/xarabot/apps/<login>-xarabot/private-key.pem` (fallback `~/.config`), mode 600, with `app.json` recording App ID and slug. Installation tokens are minted on demand, last 1 hour, memory only. The App has no admin, bypass or approve rights and no `workflows: write`; a diff touching `.github/workflows/**` is a write-check refusal.
`````
**NEW:**
`````text
- AR27 (AD-26, adopted from `bootstrap/join.ts`): the App key lives at `$XDG_CONFIG_HOME/xarabot/apps/<login>-xarabot/private-key.pem` (fallback `~/.config`), mode 600, with `app.json` recording App ID and slug. Installation tokens are minted on demand, last 1 hour, memory only. The App has no admin, bypass or approve rights and no `workflows: write`; a diff touching `.github/workflows/**` is a write-check refusal. The App asks for exactly `contents: write`, `pull_requests: write`, `issues: write`, `checks: read`, `statuses: read`, `actions: read`, `metadata: read` (granted to every App) and the merge-queue permission AR38 records. One table maps each GitHub operation to the permission it needs (Story 5.1a): git pushes go through the credential helper and are covered by `contents: write`; `join`'s manifest-conversion and App-JWT calls need no installation permission; branch-protection reads need `administration: read`, which the App never has, so those checks report "unverified" and the lane continues with a warning.
`````
**Why:** C8 copies the permission table's rules into AD-26, with the `metadata`, push, `join` and branch-protection entries.

#### E-INV-o · AR29 · `go` releases a rejected retro
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D13
**OLD:**
`````text
- AR29 (AD-28): rulings are comment commands on the inbox issue: `/xarabot <verb> <unit-id>` with `go`, `approve`, `block`, `unblock` (Maintainer only) and `rebuild`, `release`, `dismiss` (item owner or Maintainer). `release` and `rebuild` reset `attempts`, `loopbacks`, `ci_fixes`; `rebuild` also closes the PR and clears `builder_providers[]`; `release` keeps them; `dismiss` removes only the inbox item. `reconcile`'s runner code applies rulings (the checkpoint go included), never an agent, reading new comments from a cursor in `coordinator.json` and replying with a 🤖 acknowledgement. Local-only mode (v1) uses `xarabot rule <verb> <unit-id>`.
`````
**NEW:**
`````text
- AR29 (AD-28): rulings are comment commands on the inbox issue: `/xarabot <verb> <unit-id>` with `go` (a checkpoint, or a rejected retro as `go retro:<N>`), `approve`, `block`, `unblock` (Maintainer only) and `rebuild`, `release`, `dismiss` (item owner or Maintainer). `release` and `rebuild` reset `attempts`, `loopbacks`, `ci_fixes`; `rebuild` also closes the PR and clears `builder_providers[]`; `release` keeps them; `dismiss` removes only the inbox item. `reconcile`'s runner code applies rulings (the checkpoint go included), never an agent, reading new comments from a cursor in `coordinator.json` and replying with a 🤖 acknowledgement. Local-only mode (v1) uses `xarabot rule <verb> <unit-id>`.
`````
**Why:** D13 extends the Maintainer-only `go` verb from checkpoints to rejected retros.

#### E-INV-p · AR30 · Planning prompt per unit kind
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** B3
**OLD:**
`````text
- AR30 (AD-29): `core/prompt` builds every prompt purely from the package template, the repo's `prompts/` sections, the unit id, the Human Live Steps list, the result path and (v1) Lessons, all from fetched `origin/main`. The prompt names the unit; a test asserts it has no selection, CI, merge or status instruction. It runs the stock skill for the unit (`story` first build: `bmad-build-auto`; loopback or CI fix: none, apply prefetched findings or log; `retro`: `bmad-retrospective -H <epic>` then the item fields; `planning`: `bmad-sprint-planning` headless, plus manifests, Epic context and graph edits; `retro-item`: none, the prompt names it), then writes the result as its last step. Never run by a lane: `bmad-create-epics-and-stories`, `bmad-correct-course`. The clone is on the unit's branch before the session. Adapters pass their CLI's attribution-off setting (e.g. `claude --settings {"attribution": false}`).
`````
**NEW:**
`````text
- AR30 (AD-29): `core/prompt` builds every prompt purely from the package template, the repo's `prompts/` sections, the unit id, the Human Live Steps list, the result path and (v1) Lessons, all from fetched `origin/main`. The prompt names the unit; a test asserts it has no selection, CI, merge or status instruction. It runs the stock skill for the unit (`story` first build: `bmad-build-auto`; loopback or CI fix: none, apply prefetched findings or log; `retro`: `bmad-retrospective -H <epic>` then the item fields; `planning`: a status unit runs `bmad-sprint-planning` headless and compiles Epic context, and a graph unit makes the manifest, `epics.md` and `.xarabot/epics.yaml` edits; `retro-item`: none, the prompt names it), then writes the result as its last step. Never run by a lane: `bmad-create-epics-and-stories`, `bmad-correct-course`. The clone is on the unit's branch before the session. Adapters pass their CLI's attribution-off setting (e.g. `claude --settings {"attribution": false}`).
`````
**Why:** B3 splits the planning prompt between the status unit and the graph unit.

#### E-INV-q · AR31 · Write check names `epics.md`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C3, B3
**OLD:**
`````text
- AR31 (AD-30): the 0.x write check refuses builder diffs touching coordinator-owned files, manifests, `.xarabot/**`, the Standing Authority file, `.github/**`, agent config at any depth or the repo's Protected Paths, with only three exceptions (an approved Infrastructure Story's Protected Paths, never coordinator files, manifests or `.xarabot/**`; the unit's own BMAD Story spec file; the `status:` line of its own Story file). Coordinator diffs may touch only the paths their unit holds; only `planning` may touch a graph input, and under `.xarabot/**` only `epics.yaml`; a diff touching both a graph input and a status file is refused. Any agent diff changing a retro verdict, item or checkpoint go is refused. Only the session's own change is checked, never runner-written content. A refusal parks blocked and is logged.
`````
**NEW:**
`````text
- AR31 (AD-30): the 0.x write check refuses builder diffs touching coordinator-owned files (`epics.md` included), manifests, `.xarabot/**`, the Standing Authority file, `.github/**`, agent config at any depth or the repo's Protected Paths, with only three exceptions (an approved Infrastructure Story's Protected Paths, never coordinator files, manifests or `.xarabot/**`; the unit's own BMAD Story spec file; the `status:` line of its own Story file). Coordinator diffs may touch only the paths their unit holds; only a planning graph unit may touch a graph input, and under `.xarabot/**` only `epics.yaml`; a diff touching both a graph input and a status file is refused. Any agent diff changing a retro verdict, item or checkpoint go is refused. Only the session's own change is checked, never runner-written content. A refusal parks blocked and is logged.
`````
**Why:** C3: `epics.md` is coordinator-owned (AD-3), so the builder refusal names it; B3: only a graph unit touches a graph input.

#### E-INV-r · AR37 · Launcher, `runner` file and `upgrade`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D8, D9
**OLD:**
`````text
- AR37 (Structural Seed): the host layout (`~/.xarabot/STOP`, `runner/<version>/`, `repos/<owner>__<name>/lanes/<lane>/` with `clone/`, `runner.git/`, `vendor/`, `journal.jsonl`, `lane.pid`, `agent.pid`, `wait.pid`, `outcome`, `STOP`, `logs/`; `$XDG_CONFIG_HOME/xarabot/` with `host.yaml` and `apps/<login>-xarabot/`) and the source tree (`src/core/` with `schemas/`, `src/ports/`, `src/adapters/forge/github/`, `src/adapters/agent/{claude,codex,pi}/`, `src/sandbox/`, `src/lane/`, `src/cli/` with `join`, `lane install`, `wake`, `stop`, `rule`, `status`, `tui`, `report`; `test/contracts/`; `bootstrap/`).
`````
**NEW:**
`````text
- AR37 (Structural Seed): the host layout (`~/.xarabot/STOP`, `bin/xarabot-lane` (the fixed launcher, AR26), `runner/<version>/`, `repos/<owner>__<name>/lanes/<lane>/` with `clone/`, `runner.git/`, `vendor/`, `runner` (the version the launcher runs), `journal.jsonl`, `lane.pid`, `agent.pid`, `wait.pid`, `outcome`, `STOP`, `logs/`; `$XDG_CONFIG_HOME/xarabot/` with `host.yaml` and `apps/<login>-xarabot/`) and the source tree (`src/core/` with `schemas/`, `src/ports/`, `src/adapters/forge/github/`, `src/adapters/agent/{claude,codex,pi}/`, `src/sandbox/`, `src/lane/`, `src/cli/` with `join`, `lane install`, `wake`, `stop`, `rule`, `status`, `tui`, `report`, `upgrade`; `test/contracts/`; `bootstrap/`).
`````
**Why:** D9 adds the fixed launcher and the lane's `runner` file to the host layout, and D8 adds `upgrade` to the CLI list.

#### E-INV-s · AR42 · `claude` half of the adapter spike
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C4
**OLD:**
`````text
- AR42: the codex and pi adapter Stories settle whether `codex exec` and pi give `bmad-build-auto` the subagents it requires, how its outcomes (a `ready-for-dev` halt; it never yields `no-op`) map onto the `build` result, and session resume per CLI.
`````
**NEW:**
`````text
- AR42: the adapter Stories settle, per CLI, how `bmad-build-auto`'s outcomes (a `ready-for-dev` halt; it never yields `no-op`) map onto the `build` result and how session resume works; the codex and pi adapter Stories also settle whether `codex exec` and pi give `bmad-build-auto` the subagents it requires. The `claude` half is a spike in Story 1.14, which also settles the `--output-format` that yields session id, tokens, model and reset time for `parseUsage`.
`````
**Why:** C4 moves the `claude` half of AR42 into Story 1.14, ahead of Stories 1.13 and 1.16 that need it.

#### E-INV-t · Deferred in the spine · 0.x reads Escalations through config
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D10
**OLD:**
`````text
Deferred in the spine (no 0.x Story builds these): the spec-folder planning shape; the local-only forge adapter (v1); the v1 guard diff check and CI re-check; a CI `resolveGraph` check on human-authored PRs (v1, CAP-19); removing a queued PR when authority is revoked (v1); Xarabot-owned Escalations (v1); injecting Lessons (v1); the Actor registry and generated CODEOWNERS and rulesets (v1); detecting Human Live Steps beyond `blocked.kind` (v1); pipelining; cross-host telemetry and journal backup (v1); App key rotation; Linux sandbox packaging (AppArmor profile on Ubuntu 24.04+, `bwrap` source).
`````
**NEW:**
`````text
Deferred in the spine (no 0.x Story builds these): the spec-folder planning shape; the local-only forge adapter (v1); the v1 guard diff check and CI re-check; a CI `resolveGraph` check on human-authored PRs (v1, CAP-19); removing a queued PR when authority is revoked (v1); Xarabot-owned Escalations (v1; 0.x reads Xaravel's Escalation files through an optional config source and holds a Story with an open one, Story 7.6); injecting Lessons (v1); the Actor registry and generated CODEOWNERS and rulesets (v1); detecting Human Live Steps beyond `blocked.kind` (v1); pipelining; cross-host telemetry and journal backup (v1); App key rotation; Linux sandbox packaging (AppArmor profile on Ubuntu 24.04+, `bwrap` source).
`````
**Why:** D10 builds an optional Escalation source in 0.x (Story 7.6); only the Xarabot-owned mechanism stays deferred.

#### E-LIST-a · Test strategy · The Maintainer runs each live proof
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D3
**OLD:**
`````text
- Every Epic ends with a verification Story that proves its success criteria end to end on the real repo.
`````
**NEW:**
`````text
- Every Epic ends with a verification Story that proves its success criteria end to end on the real repo. The Story writes its live command (`bun test --live <suite>`) and expected result into `docs/maintainer/self-host.md`, and the Maintainer runs it on the Xarabot host, outside the sandbox, with the credentials it needs (Story 3.6: every vendor's), before that Epic's retro. Inside a sandboxed session, live cases report skipped.
- Sandbox suites (Stories 1.11 and 1.12, the sandbox re-runs in Stories 3.1 and 3.2, and Story 7.3) detect that they already run inside the Xarabot sandbox (`XARABOT_SANDBOXED=1`, set by the launcher) and skip their nested cases, reporting them skipped; the Maintainer runs those live too.
`````
**Why:** D3: sessions have no GitHub host or token and cannot nest the sandbox, so the Maintainer runs live proofs and nested sandbox cases on the host.

#### E-LIST-b · Epic 1 notes · Bootstrapped Epic 1, `claude` spike, bootstrap user
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D2, C4, C6
**OLD:**
`````text
**Notes:** the scaffold and test harness come first. macOS only (`sandbox-exec`, launchd). Spikes AR38 (merge-queue App permission), AR39 (409 or 422) and AR40 (proxy allowlist). Ends with a canary Story run from `next` to merge on the real repo, with a STOP mid-wait and a usage-limit sleep exercised.
`````
**NEW:**
`````text
**Notes:** the scaffold and test harness come first. macOS only (`sandbox-exec`, launchd). Spikes AR38 (merge-queue App permission), AR39 (409 or 422), AR40 (proxy allowlist) and AR42's `claude` half (outcome mapping, resume, `--output-format`; Story 1.14). Precondition (Human Live Step, AR32): the bootstrap copy runs as a dedicated macOS user on the Xarabot host. Epic 1 has no Story manifests; at the self-host switch, `bootstrapped_epics: [1]` in `.xarabot/config.yaml` makes the gates read it as all Stories done and retro done (Story 1.20). Ends with a canary Story run from `next` to merge on the real repo, with a STOP mid-wait and a usage-limit sleep exercised.
`````
**Why:** D2 marks Epic 1 done at the switch, C4 adds the `claude` spike, and C6 makes AR32's bootstrap user a precondition.

#### E-LIST-c · Epic 2 notes · Planning status and graph units
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** B3
**OLD:**
`````text
**Notes:** planning units change the effective graph, so the AD-11 graph-change gate (`xarabot:graph`, validation on the merge result, Maintainer approval bound to `approved_graph`) lands here. The builder limit stays at 1 until Epic 3 merges. Ends with two lanes racing against the real `xarabot/claims` for one unit and for overlapping globs, exactly one winning, and a killed lane's unit becoming claimable 30 minutes after its last heartbeat.
`````
**NEW:**
`````text
**Notes:** planning splits into a status unit (stock sprint planning and Epic context; not approval-gated) and a graph unit (manifests, `epics.md`, `.xarabot/epics.yaml`; approval-gated; never status files), and `reconcile` writes a graph unit's status entries after it merges. Graph units change the effective graph, so the AD-11 graph-change gate (`xarabot:graph`, validation on the merge result, Maintainer approval bound to `approved_graph`) lands here. The builder limit stays at 1 until Epic 3 merges. Ends with two lanes racing against the real `xarabot/claims` for one unit and for overlapping globs, exactly one winning, and a killed lane's unit becoming claimable 30 minutes after its last heartbeat.
`````
**Why:** B3 splits planning so that no single diff touches both a graph input and a status file.

#### E-LIST-d · Epic 3 notes · AR42 here covers `codex` and `pi`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C4
**OLD:**
`````text
**Notes:** spikes AR41 (pi's directory override) and AR42 (subagents, outcome mapping, resume per CLI). After it merges, the Maintainer lifts the every-path approval rule and the 1-builder limit. Ends with the same unit run to a valid result through each adapter, and a review re-run after a later agent change.
`````
**NEW:**
`````text
**Notes:** spikes AR41 (pi's directory override) and AR42 for `codex` and `pi` (subagents, outcome mapping, resume per CLI; `claude`'s half is in Story 1.14). After it merges, the Maintainer lifts the every-path approval rule and the 1-builder limit. Ends with the same unit run to a valid result through each adapter, and a review re-run after a later agent change.
`````
**Why:** The `claude` half of AR42 moved to Story 1.14.

#### E-LIST-e · Epic 4 notes · `go` for a rejected retro
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D13
**OLD:**
`````text
**Notes:** includes the checkpoint unit and the rulings grammar (AR29). Ends with a graph fixture proving the distance and `blocking` gates, and a checkpoint holding only its dependents until `/xarabot go`.
`````
**NEW:**
`````text
**Notes:** includes the checkpoint unit and the rulings grammar (AR29), with `go` also releasing a rejected retro (`/xarabot go retro:<N>`). Ends with a graph fixture proving the distance and `blocking` gates, and a checkpoint holding only its dependents until `/xarabot go`.
`````
**Why:** D13 extends the `go` ruling to rejected retros.

#### E-LIST-f · Epic 5 notes · Shared GitHub adapter with Epic 6
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C9, D12
**OLD:**
`````text
**Notes:** ends with `xarabot join` against a test org, and proof that the bot can neither approve nor admin-merge while its owner can approve and merge a Protected Path PR.
`````
**NEW:**
`````text
**Notes:** Story 5.1a maps every GitHub operation to its App permission. Epics 5 and 6 both touch `src/adapters/forge/github/**` (Story 5.1a, and the forge reads of Stories 6.1 and 6.2), so claims serialize those Stories; the graph keeps the two Epics parallel. Ends with `xarabot join` against a test org, and proof that the bot can neither approve nor admin-merge while its owner can approve and merge a Protected Path PR.
`````
**Why:** C9: claims will serialize Epic 5 and Epic 6 Stories that touch the GitHub adapter; the graph stays parallel.

#### E-LIST-g · Epic 6 notes · Shared GitHub adapter with Epic 5
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C9
**OLD:**
`````text
**Notes:** ends with `xarabot report` reproducing a hand-computed Stories-per-hour figure from a fixture journal.
`````
**NEW:**
`````text
**Notes:** Stories 6.1 and 6.2 add forge reads under `src/adapters/forge/github/**`, which Epic 5 also changes, so claims serialize them (Epic 5 notes). Ends with `xarabot report` reproducing a hand-computed Stories-per-hour figure from a fixture journal.
`````
**Why:** C9: the same note, seen from Epic 6.

#### E-1.0-a · Epic 1 intro · Bootstrap user precondition; Epic 1 bootstrapped
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C6, D2
**OLD:**
`````text
The Maintainer installs a pinned Xarabot runner on the Xarabot host, and one `claude` lane builds Stories with no human watching: `next` picks the Story in code, the agent runs in the sandbox with no GitHub credential or host, and the runner commits as `edanisko-xarabot[bot]`, opens the PR, polls CI, parks a PR for the Maintainer's approval, merges through the queue, sleeps through usage limits, keeps a journal and obeys STOP. This is the self-host threshold (NFR13, NFR14). The bootstrap copy of Xaravel's loop builds these Stories in order; each depends only on earlier ones.
`````
**NEW:**
`````text
The Maintainer installs a pinned Xarabot runner on the Xarabot host, and one `claude` lane builds Stories with no human watching: `next` picks the Story in code, the agent runs in the sandbox with no GitHub credential or host, and the runner commits as `edanisko-xarabot[bot]`, opens the PR, polls CI, parks a PR for the Maintainer's approval, merges through the queue, sleeps through usage limits, keeps a journal and obeys STOP. This is the self-host threshold (NFR13, NFR14). The bootstrap copy of Xaravel's loop builds these Stories in order; each depends only on earlier ones.

Precondition (Human Live Step, AR32): the bootstrap copy runs under a dedicated macOS user on the Xarabot host that holds only the bot's private key, the Claude credential and its own clone, with no `gh` login, ssh key or GitHub keychain item, and the Maintainer's home is mode 700.

Epic 1 has no Story manifests. At the self-host switch the Maintainer sets `bootstrapped_epics: [1]`, so the gates read Epic 1 as all Stories done and retro done (Story 1.20).
`````
**Why:** C6 lists AR32's dedicated bootstrap user as a precondition, and D2 says how Epic 1 counts as done without manifests.

#### E-1.2-a · Story 1.2 · Config fields and Standing Authority schema
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D2, D5, D7
**OLD:**
`````text
**Then** it holds versioned zod schemas, with inferred types, for `.xarabot/config.yaml` (including `runner_version`, the Maintainer's login, the Standing Authority path, the manifest directory and path-key mapping, `story_spec_path`, both branch namespaces, the unit budget defaulting to 6 hours, the CI max wait defaulting to 60 minutes, repo-added proxy hosts, the lockfile regeneration command and the optional map from Epics to workspace packages), `.xarabot/policy.yaml` (adapters allowed unattended, the expected-checks list, the repo's Protected Paths and the paths that need the owner's approval), `.xarabot/human-live-steps.yaml`, the Standing Authority frontmatter and `host.yaml` (AR21, AR22).
`````
**NEW:**
`````text
**Then** it holds versioned zod schemas, with inferred types, for `.xarabot/config.yaml` (including `runner_version`, the Maintainer's login, the Standing Authority path, the planning paths with their defaults (`epics_path`, `sprint_status_path`, `retro_gates_path`, `retro_doc_glob`, `epic_context_path`, AR21), `bootstrapped_epics` (a list of Epic numbers, default `[]`), `digest_time` (default `08:00` UTC), the manifest directory and path-key mapping, `story_spec_path`, both branch namespaces, the unit budget defaulting to 6 hours, the CI max wait defaulting to 60 minutes, repo-added proxy hosts, the lockfile regeneration command and the optional map from Epics to workspace packages), `.xarabot/policy.yaml` (adapters allowed unattended, the expected-checks list, the repo's Protected Paths and the paths that need the owner's approval), `.xarabot/human-live-steps.yaml`, the Standing Authority frontmatter (`schema_version: 1`, `granted_by`, `granted_at`, `repo`, optional `expires`; the body is free prose) and `host.yaml` (AR21, AR22).
`````
**Why:** D5 names the planning paths and the Standing Authority fields, and D2 and D7 add their config fields; D10's Escalation source stays in Story 7.6.

#### E-1.2-b · Story 1.2 · Standing Authority case table
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D5
**OLD:**
`````text
**Given** the case table: config missing, config with invalid YAML, config with an unknown or newer version, policy missing, the Standing Authority file absent at its configured path, Standing Authority frontmatter invalid
**When** each case is loaded
**Then** each returns a stop error naming the file and the reason.
`````
**NEW:**
`````text
**Given** the case table: config missing, config with invalid YAML, config with an unknown or newer version, policy missing, the Standing Authority file absent at its configured path, Standing Authority frontmatter invalid, `granted_by` not the configured Maintainer login, `repo` not this repo, `expires` before the snapshot's `now`
**When** each case is loaded
**Then** each returns a stop error naming the file and the reason.
`````
**Why:** D5's Standing Authority fields carry rules that make the file invalid, and each needs a case.

#### E-1.3-a · Story 1.3 · Parse `depends_on` as Story ids
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D6
**OLD:**
`````text
**And** it accepts optional `depends_on` and `infrastructure: true`, and ignores repo-only fields and `status`
`````
**NEW:**
`````text
**And** it accepts optional `depends_on`, a list of Story ids each matching that pattern, and `infrastructure: true`, and ignores repo-only fields and `status`
`````
**Why:** D6 makes `depends_on` a list of Story ids.

#### E-1.3-b · Story 1.3 · Fixture includes lettered Stories
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D12
**OLD:**
`````text
**And** a fixture copy of this repo's own `epics.md` parses to Epics 1–7 and their Stories.
`````
**NEW:**
`````text
**And** a fixture copy of this repo's own `epics.md` parses to Epics 1–7 and their Stories, the lettered `1.17a` and `5.1a` included.
`````
**Why:** D12 adds Stories 1.17a and 5.1a to this repo's `epics.md`, so the fixture proves lettered ids parse.

#### E-1.4-a · Story 1.4 · `depends_on` validation, bootstrapped headings, real graph
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D6, D2, C7
**OLD:**
`````text
**Given** the validation case table: an invalid file; an entry or `depends_on` naming an Epic with no heading; a cycle; a manifest with no heading or a mismatched `epic`; `retro-gates.yaml` marking an Epic as awaiting a checkpoint go that the graph doesn't mark
**When** the pure `resolveGraph(snapshot)` runs on each
**Then** each returns a validation failure naming the problem.

**Given** a valid snapshot
**When** `resolveGraph` runs
**Then** it returns the edges, checkpoints, Epic set, each Epic's Story set (exactly the manifests naming it), the Story headings with no manifest (reported, not failures) and a stable hash of the resolved graph.

**Given** a local checkout
**When** `xarabot graph check` runs
**Then** it reads the working tree's `epics.md`, `.xarabot/epics.yaml`, manifests and `retro-gates.yaml`, prints the resolved graph, prints headings with no manifest as warnings, and exits non-zero on any validation failure
**And** on this repo with no `.xarabot/epics.yaml` it reports Epics 1–7 in serial order and exits 0.
`````
**NEW:**
`````text
**Given** the validation case table: an invalid file; an entry or `depends_on` naming an Epic with no heading; a cycle; a manifest with no heading or a mismatched `epic`; a manifest `depends_on` naming an unknown Story, or a Story outside its own Epic and the Epics that Epic depends on, transitively; `bootstrapped_epics` naming an Epic with no heading; `retro-gates.yaml` marking an Epic as awaiting a checkpoint go that the graph doesn't mark
**When** the pure `resolveGraph(snapshot)` runs on each
**Then** each returns a validation failure naming the problem.

**Given** a valid snapshot
**When** `resolveGraph` runs
**Then** it returns the edges, checkpoints, Epic set, each Epic's Story set (exactly the manifests naming it), the Story headings with no manifest outside the Epics in config's `bootstrapped_epics` (reported, not failures) and a stable hash of the resolved graph.

**Given** a local checkout
**When** `xarabot graph check` runs
**Then** it reads the working tree's `epics.md`, `.xarabot/epics.yaml`, `.xarabot/config.yaml` when present (for `bootstrapped_epics` and the configured paths), manifests and `retro-gates.yaml`, prints the resolved graph, prints headings with no manifest as warnings, and exits non-zero on any validation failure
**And** on a fixture repo with no `.xarabot/epics.yaml` it reports the fixture's Epics in serial order and exits 0
**And** on this repo it reports the graph of its `.xarabot/epics.yaml`: 6 → [4], 7 → [5, 6], and every other Epic depending on the next lower one, and exits 0.
`````
**Why:** D6 adds a validation row, D2 keeps bootstrapped headings out of the unclaimable list, and C7 replaces the stale serial assertion; [NEW CHOICE] `bootstrapped_epics` naming an Epic with no heading fails validation, and `graph check` reads config only when present.

#### E-1.5-a · Story 1.5 · `park` enums in the record schema
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D5
**OLD:**
`````text
**And** unit ids follow AR35 (`story:<id>`, `retro:<epic>`, `retro-item:<id>`, `checkpoint:<epic>`, `planning:<slug>.<n>`, `reconcile:<n>`), with `:` replaced by `__` in file names.
`````
**NEW:**
`````text
**And** unit ids follow AR35 (`story:<id>`, `retro:<epic>`, `retro-item:<id>`, `checkpoint:<epic>`, `planning:<slug>.<n>`, `reconcile:<n>`), with `:` replaced by `__` in file names.
**And** `park.kind` is `awaiting-approval`, `needs-approval` or `blocked`, and `park.reason` is a `blocked.kind` (`escalation`, `human-live-step`, `intent-gap`, `verification`, `other`) or a runner cause (`review-cap`, `ci-fix-cap`, `ci-timeout`, `write-check`, `no-op`, `attempts-cap`, `unclaimable`, `graph-invalid`); any other value fails validation.
`````
**Why:** D5 fixes the `park.kind` and `park.reason` values the schema accepts.

#### E-1.6-a · Story 1.6 · Done-ness, bootstrapped Epics, rejected retros, `depends_on`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D1, D2, D13, D6
**OLD:**
`````text
**Given** Epic D, whose dependencies come from `resolveGraph`
**When** a dependency Epic has a Story not merged, or no retro verdict in `retro-gates.yaml`
**Then** no Story of D is returned, and the idle reason names the Epic that holds it.

**Given** Story records in each state
**When** `next` runs
**Then** a Story whose record is absent or `released` is eligible, and `claimed`, `merging`, `parked` and `merged` are not (stale takeover is Epic 2).
`````
**NEW:**
`````text
**Given** Epic D, whose dependencies come from `resolveGraph`
**When** a dependency Epic has a Story not `done` in `sprint-status.yaml` on `main`, has no Stories, or has no retro verdict in `retro-gates.yaml`
**Then** no Story of D is returned, and the idle reason names the Epic that holds it.

**Given** a dependency Epic listed in config's `bootstrapped_epics`
**When** `next` runs
**Then** that Epic counts as all Stories done and retro done, even with no Stories, and its Story headings are not listed as unclaimable.

**Given** an Epic E whose retro verdict in `retro-gates.yaml` is `rejected`
**When** `next` runs before the Maintainer's `/xarabot go retro:<N>` for E is recorded
**Then** no Story of any Epic at distance ≥ 1 from E is returned, and the idle reason names E's rejected retro
**And** a verdict of `accepted` or `accepted-with-open-items` holds none of them.

**Given** Story records in each state
**When** `next` runs
**Then** a Story whose record is absent or `released` is eligible unless it is `done` in `sprint-status.yaml` on `main`, and `claimed`, `merging`, `parked` and `merged` are not (stale takeover is Epic 2)
**And** a `done` Story whose `merged` record was deleted is never returned again.

**Given** a Story whose manifest `depends_on` lists a Story not `done` in `sprint-status.yaml` on `main`
**When** `next` runs
**Then** it is not returned, and its reason names the Story it waits on.
`````
**Why:** D1 keeps done Stories from being chosen again and defines the gate through `sprint-status.yaml`; D2, D13 and D6 add their gate cases.

#### E-1.6-b · Story 1.6 · Bootstrapped headings are not unclaimable
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D2
**OLD:**
`````text
**Given** Story headings with no manifest, or manifests whose globs resolve to nothing
`````
**NEW:**
`````text
**Given** Story headings with no manifest outside a `bootstrapped_epics` Epic, or manifests whose globs resolve to nothing
`````
**Why:** D2: Story headings of a bootstrapped Epic are not reported as unclaimable.

#### E-1.7-a · Story 1.7 · Port declares `comment`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D11
**OLD:**
`````text
**Then** it declares `snapshot`, `ledgerSwap`, `pushBranch`, PR open, update, close and list-by-branch, `checks`, `enqueue(expectedHead)`, `dequeue`, `alert` and `prefetch`, with no approve operation
`````
**NEW:**
`````text
**Then** it declares `snapshot`, `ledgerSwap`, `pushBranch`, PR open, update, close and list-by-branch, `comment(pr, body)` for 🤖 status comments, `checks`, `enqueue(expectedHead)`, `dequeue`, `alert` and `prefetch`, with no approve operation
`````
**Why:** D11 adds `comment(pr, body)` to the `Forge` port, so Story 1.16's 🤖 status comment has an operation.

#### E-1.7-b · Story 1.7 · Fake forge passes a `comment` case
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D11
**OLD:**
`````text
**Then** it passes: a swap from a stale tip returns `conflict`; N concurrent swaps from one tip yield exactly one `ok`; `snapshot()` reads the ledger, then `main`, then PR states, and returns the forge's `now`; `enqueue` with a wrong expected head fails; each error kind is observable.
`````
**NEW:**
`````text
**Then** it passes: a swap from a stale tip returns `conflict`; N concurrent swaps from one tip yield exactly one `ok`; `snapshot()` reads the ledger, then `main`, then PR states, and returns the forge's `now`; `enqueue` with a wrong expected head fails; `comment` posts its body on the named PR; each error kind is observable.
`````
**Why:** The contract suite covers the new operation on the fake.

#### E-1.8-a · Story 1.8 · Scratch repo precondition
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C6
**OLD:**
`````text
Precondition (Human Live Step): the Maintainer has created a scratch repo with the owner's App installed, for live contract tests.
`````
**NEW:**
`````text
Precondition (Human Live Step): the Maintainer has created an org-owned scratch repo with a merge queue on `main` and the owner's App installed, for live contract tests.
`````
**Why:** C6: Stories 1.10 and 1.20 need an org-owned scratch repo with a merge queue.

#### E-1.9-a · Story 1.9 · `runner.git` and its git settings move here
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D11
**OLD:**
`````text
I want to push unit branches and manage PRs as the bot without the token leaving memory,
So that only the runner talks to GitHub, and a lane that lost its claim cannot push over another (NFR8, AR7, AR19).

**Acceptance Criteria:**

**Given** the runner's git
**When** it pushes
**Then** the token reaches git only through a credential helper over stdin, scoped to the forge URL, after `credential.helper=` is reset
**And** a test proves the token is absent from the environment, argv (as `ps` sees it), files and logs.
`````
**NEW:**
`````text
I want to push unit branches from the runner's own repository and manage PRs as the bot without the token leaving memory,
So that only the runner talks to GitHub, and a lane that lost its claim cannot push over another (NFR8, AR7, AR16, AR19).

**Acceptance Criteria:**

**Given** a lane state folder
**When** the lane first runs
**Then** it creates `runner.git` there, and every runner git command runs against it with AR19's settings (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `core.hooksPath=/dev/null`, no fsmonitor, filters, external diff, textconv or signing program, `GIT_NO_REPLACE_OBJECTS=1`, `protocol.file.allow=never`, no submodule recursion).

**Given** the runner's git
**When** it pushes from `runner.git`
**Then** the token reaches git only through a credential helper over stdin, scoped to the forge URL, after `credential.helper=` is reset
**And** a test proves the token is absent from the environment, argv (as `ps` sees it), files and logs.
`````
**Why:** D11: the push needs `runner.git` and AR19's hardened git settings, so they move here from Story 1.15.

#### E-1.9-b · Story 1.9 · GitHub `comment`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D11
**OLD:**
`````text
**Given** the forge contract suite
**When** it runs on the fake and live
**Then** the push and PR cases pass.
`````
**NEW:**
`````text
**Given** `comment(pr, body)`
**When** it runs
**Then** it posts the body as one comment on the PR, as the bot.

**Given** the forge contract suite
**When** it runs on the fake and live
**Then** the push, PR and comment cases pass.
`````
**Why:** D11: the GitHub adapter implements `comment(pr, body)`.

#### E-1.10-a · Story 1.10 · Preconditions: `issues: write`, queue, required check
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C6
**OLD:**
`````text
So that merges never bypass required checks, and a condition that stops every lane reaches the Maintainer at once (FR6, FR9, FR13, AR24, AR38).
`````
**NEW:**
`````text
So that merges never bypass required checks, and a condition that stops every lane reaches the Maintainer at once (FR6, FR9, FR13, AR24, AR38).

Precondition (Human Live Step): the owner's App has `issues: write`, and the scratch repo has a merge queue on `main` with a required check, for the live checks, queue and alert tests.
`````
**Why:** C6: the live alert and queue tests need these settings before this Story, not at Story 1.20.

#### E-1.11-a · Story 1.11 · Reads, `runner.git` path, env allowlist and `HOME`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C11, D11
**OLD:**
`````text
**Then** reads succeed only in system paths, the lane clone, the lane's vendor home, its temp folder and the uv-managed Python install
**And** reads of `~/.xarabot/**`, `$XDG_CONFIG_HOME/xarabot`, `~/.config/gh`, `~/.ssh`, `~/Library/Keychains`, `~/.git-credentials`, `~/.netrc`, `~/.claude`, `~/.codex` and `~/.pi` fail, with one test per path
**And** writes succeed only in the clone (`.git` included), the vendor home and the temp folder; `runner.git` can be neither read nor written; Unix sockets are denied.

**Given** a launching environment that holds `GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK` and other variables
**When** the session starts
**Then** only allowlisted variables pass through, and the git credential helper is reset.
`````
**NEW:**
`````text
**Then** reads succeed only in system paths, the resolved real paths of the agent CLI, `bun`, `uv`, `git` and the uv-managed Python install (computed at session start), the lane clone, the lane's vendor home and its temp folder
**And** reads of `~/.xarabot/**`, `$XDG_CONFIG_HOME/xarabot`, `~/.config/gh`, `~/.ssh`, `~/Library/Keychains`, `~/.git-credentials`, `~/.netrc`, `~/.claude`, `~/.codex` and `~/.pi` fail, with one test per path
**And** writes succeed only in the clone (`.git` included), the vendor home and the temp folder; the `runner.git` path from the Structural Seed layout (an empty directory at that path in the test) can be neither read nor written; Unix sockets are denied.

**Given** a launching environment that holds `GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK` and other variables
**When** the session starts
**Then** only `PATH` (rebuilt from allowed directories), `HOME`, `TMPDIR`, `LANG`, `LC_*`, `TERM`, the vendor credential variable, `XARABOT_RESULT`, `XARABOT_SANDBOXED`, the proxy variables and `UV_CACHE_DIR` (in the temp folder) pass through, and the git credential helper is reset
**And** `HOME` is a fresh directory inside the temp folder, and `XARABOT_SANDBOXED` is `1`.
`````
**Why:** [NEW CHOICE] The brief's C11 choice for reads, `HOME` and the env allowlist; D11 tests the `runner.git` path from the Structural Seed layout, not a real `runner.git`.

#### E-1.11-b · Story 1.11 · Nested sandbox cases skip
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D3
**OLD:**
`````text
**Given** a host that is not macOS
**When** the sandbox suite runs
**Then** its cases are reported as skipped, never as passed.
`````
**NEW:**
`````text
**Given** a host that is not macOS
**When** the sandbox suite runs
**Then** its cases are reported as skipped, never as passed.

**Given** the sandbox suite running inside the Xarabot sandbox (`XARABOT_SANDBOXED=1`)
**When** it reaches a case that needs a nested sandbox
**Then** the case is reported as skipped, never as passed, and the Maintainer runs it live on the host (Story 1.20's runbook).
`````
**Why:** D3: `sandbox-exec` cannot nest, so a re-run inside a session skips those cases and the Maintainer runs them live.

#### E-1.12-a · Story 1.12 · Vendor hosts are an input
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D11
**OLD:**
`````text
**Then** it allows only the adapter's vendor API hosts, `pypi.org`, `files.pythonhosted.org` and the hosts repo config adds, and denies everything else.
`````
**NEW:**
`````text
**Then** it allows only the vendor API hosts it takes as input (Story 1.14 supplies `claude`'s; the tests pass a fixture list), `pypi.org`, `files.pythonhosted.org` and the hosts repo config adds, and denies everything else.
`````
**Why:** D11: the `Agent` port arrives in Story 1.14, so the proxy takes the vendor hosts as an input.

#### E-1.12-b · Story 1.12 · Nested sandbox cases skip
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D3
**OLD:**
`````text
**Given** the proxy tests
**When** they run
**Then** an allowed host connects, and each denied class (GitHub by name, GitHub by IP, an unlisted host) fails.
`````
**NEW:**
`````text
**Given** the proxy tests
**When** they run
**Then** an allowed host connects, and each denied class (GitHub by name, GitHub by IP, an unlisted host) fails.

**Given** the proxy tests running inside the Xarabot sandbox (`XARABOT_SANDBOXED=1`)
**When** a case needs a nested sandbox
**Then** it is reported as skipped, never as passed, and the Maintainer runs it live on the host (Story 1.20's runbook).
`````
**Why:** D3: the same nested-sandbox rule as Story 1.11.

#### E-1.13-a · Story 1.13 · Result enums
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D5
**OLD:**
`````text
**Then** it holds the result union keyed by `kind`: `build`, `review`, `retro` and `planning`, with AR15's fields, each also carrying `denied_actions[]`.
`````
**NEW:**
`````text
**Then** it holds the result union keyed by `kind`: `build`, `review`, `retro` and `planning`, with AR15's fields, each also carrying `denied_actions[]`.
**And** the enumerated fields accept only these values: `build.outcome` `done`, `blocked`, `no-op`; `blocked.kind` `escalation`, `human-live-step`, `intent-gap`, `verification`, `other`; `review.verdict` `pass`, `changes-requested`; `findings[].severity` `high`, `medium`, `low`, with `blocking` a separate boolean; `retro.verdict` `accepted`, `accepted-with-open-items`, `rejected`; item `route` `lane`, `maintainer`; `planning.outcome` `done`, `nothing-due`, `blocked`.
`````
**Why:** D5 fixes the enumerated result values, so the schema accepts no others.

#### E-1.14-a · Story 1.14 · `claude` spike, output format, own sandbox off, vendor hosts
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C4, D11
**OLD:**
`````text
**Given** `src/ports/agent.ts`
**When** the Story is done
**Then** it declares `launchSpec(unit, settings, resultPath)`, `parseUsage(output)` and `effortValues(model)`.

**Given** lane settings
**When** `launchSpec` runs
**Then** it returns `claude -p --model <model> --effort <effort> --permission-mode auto` with the attribution-off setting (`--settings {"attribution": false}`), `CLAUDE_CONFIG_DIR` set to the lane's vendor home, `CLAUDE_CODE_OAUTH_TOKEN` on macOS, `XARABOT_RESULT`, and the clone as working directory
**And** an unset `model` is `claude-opus-5-5` and an unset `effort` is `high`.
`````
**NEW:**
`````text
**Given** `src/ports/agent.ts`
**When** the Story is done
**Then** it declares `launchSpec(unit, settings, resultPath)`, `parseUsage(output)` and `effortValues(model)`.

**Given** AR42's `claude` half
**When** the Story starts
**Then** it first records, in the adapter and its tests, how `bmad-build-auto`'s outcomes map onto the `build` result (a `ready-for-dev` halt; it never yields `no-op`), how a session is resumed, and which `--output-format` yields the session id, tokens, model and reset time that `parseUsage` needs
**And** the `story` prompt's result step (Story 1.13) follows that outcome mapping, with a test.

**Given** lane settings
**When** `launchSpec` runs
**Then** it returns `claude -p --model <model> --effort <effort> --permission-mode auto` with the `--output-format` the spike chose, the attribution-off setting (`--settings {"attribution": false}`), claude's own sandbox turned off (AR18), `CLAUDE_CONFIG_DIR` set to the lane's vendor home, `CLAUDE_CODE_OAUTH_TOKEN` on macOS, `XARABOT_RESULT`, and the clone as working directory
**And** an unset `model` is `claude-opus-5-5` and an unset `effort` is `high`
**And** the adapter supplies `claude`'s vendor API hosts to the proxy (Story 1.12).
`````
**Why:** C4 moves AR42's `claude` half here as a spike and turns claude's own sandbox off (AR18); D11 makes this Story supply `claude`'s hosts to the proxy.

#### E-1.14-b · Story 1.14 · `parseUsage` session id; resume per the spike
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C4
**OLD:**
`````text
**Then** it returns tokens, cost (labelled an estimate on a subscription), the reported model, and a usage-limit hit with its reset time when present
**And** a reported model that differs from the configured one fails the attempt.

**Given** a session that ends with no result file
**When** the adapter handles it
**Then** it resumes once with `claude -p --resume <session>` and a prompt that asks only for the result.
`````
**NEW:**
`````text
**Then** it returns the session id, tokens, cost (labelled an estimate on a subscription), the reported model, and a usage-limit hit with its reset time when present
**And** a reported model that differs from the configured one fails the attempt.

**Given** a session that ends with no result file
**When** the adapter handles it
**Then** it resumes once, as the spike recorded (`claude -p --resume <session>`), with a prompt that asks only for the result.
`````
**Why:** C4: `parseUsage` returns the session id that resume needs, and resume follows the spike.

#### E-1.15-a · Story 1.15 · `runner.git` creation moved to Story 1.9
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D11
**OLD:**
`````text
I want the runner to keep its own repository, rebuild the agent's clone from it and make every commit itself as the bot,
So that nothing an agent plants in git runs as the runner, and no co-author trailer, closing keyword or @mention reaches GitHub (FR13, NFR10, AR10, AR16, AR19).

**Acceptance Criteria:**

**Given** a lane state folder
**When** the lane first runs
**Then** it creates `runner.git` there, and every runner git command runs against it with AR19's settings (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `core.hooksPath=/dev/null`, no fsmonitor, filters, external diff, textconv or signing program, `GIT_NO_REPLACE_OBJECTS=1`, `protocol.file.allow=never`, no submodule recursion).
`````
**NEW:**
`````text
I want the runner to rebuild the agent's clone from its own `runner.git` (Story 1.9) and make every commit itself as the bot,
So that nothing an agent plants in git runs as the runner, and no co-author trailer, closing keyword or @mention reaches GitHub (FR13, NFR10, AR10, AR16, AR19).

**Acceptance Criteria:**

**Given** the lane's `runner.git` with AR19's settings (Story 1.9)
**When** the runner rebuilds the clone, diffs and commits
**Then** every git command runs against `runner.git` with those settings, never against the clone's `.git`.
`````
**Why:** D11: Story 1.15 keeps the clone rebuild, the bot commit and the sanitizer, building on Story 1.9's `runner.git`.

#### E-1.16-a · Story 1.16 · AR15 cross-check, `Forge.comment`, `denied_actions[]`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D11, Minor
**OLD:**
`````text
**Given** a session run through the `Agent` and `Sandbox` ports
**When** its result is missing after the one resume, or invalid
**Then** the record becomes `released` with `attempts` + 1, or `parked` (blocked) once `attempts` ≥ 3.

**Given** a `done` build result
**When** the runner handles it
**Then** it commits (Story 1.15), re-checks the Standing Authority, pushes with a lease, opens the PR with the sanitized summary and body, records `pr` and `head_sha`, and posts a status comment starting with 🤖.
`````
**NEW:**
`````text
**Given** a session run through the `Agent` and `Sandbox` ports
**When** its result is missing after the one resume, or invalid
**Then** the record becomes `released` with `attempts` + 1, or `parked` (blocked) once `attempts` ≥ 3.

**Given** a `build` result
**When** the runner validates it
**Then** it cross-checks the result's `outcome` against the Story spec's `status` and `## Auto Run Result` (AR15), and a mismatch counts as an invalid result.

**Given** a `done` build result
**When** the runner handles it
**Then** it commits (Story 1.15), re-checks the Standing Authority, pushes with a lease, opens the PR with the sanitized summary and body, records `pr` and `head_sha`, and posts a status comment starting with 🤖 through `Forge.comment` (Story 1.9).

**Given** a result whose `denied_actions[]` is not empty
**When** the runner handles it
**Then** each action is recorded in the unit's journal record and listed in the PR's 🤖 status comment (AR44).
`````
**Why:** Minor items: AR15's Story-spec cross-check and the `denied_actions[]` report land here; D11 gives the 🤖 comment its operation; [NEW CHOICE] a cross-check mismatch counts as an invalid result (fail closed).

#### E-1.16-b · Story 1.16 · `failed` outcome
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** Minor
**OLD:**
`````text
**Then** `journal.jsonl` gets one record with the AR25 facts (agent, model, effort, tokens and cost from the adapter, timings, `outcome`, `loopbacks`, `ci_fixes`), the log is at `logs/<unit-file-id>-<start>.log`, and `outcome` holds `progress`, `idle` or `stop`.
`````
**NEW:**
`````text
**Then** `journal.jsonl` gets one record with the AR25 facts (agent, model, effort, tokens and cost from the adapter, timings, `outcome`, `loopbacks`, `ci_fixes`), the log is at `logs/<unit-file-id>-<start>.log`, and `outcome`, in the journal record and the `outcome` file, holds `progress`, `idle`, `failed` (a crashed session, a missing or invalid result, or a budget overrun) or `stop`.
`````
**Why:** Minor item: a crashed or failed session needs an `outcome` value, so Story 1.18's 15-minute failure wait has one to key on.

#### E-1.17-a · Story 1.17 · Keep CI, CI fixes and conflicts
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D12, C13
**OLD:**
`````text
### Story 1.17: CI, conflicts, approval gate and merge queue

As an operator,
I want the lane to take its open PR through CI, conflicts, the approval gate and the merge queue in code,
So that the agent never polls CI or merges, and Xaravel's CI and merge lessons hold (FR6, FR13, AR8, AR20, AR44).
`````
**NEW:**
`````text
### Story 1.17: CI polling, CI fixes and conflicts

As an operator,
I want the lane to take its open PR through CI, CI fixes and conflicts in code,
So that the agent never polls CI, and Xaravel's CI and conflict lessons hold (FR6, AR8, AR20, AR44).
`````
**Why:** D12 splits Story 1.17: it keeps CI polling, CI fixes and conflicts; Story 1.17a takes the approval gate and the merge queue.

#### E-1.17-b · Story 1.17 · Move the gate and queue ACs out
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D12
**OLD:**
`````text
**Given** a PR whose diff touches a path the policy says needs its owner's approval
**When** its checks pass
**Then** the record becomes `parked`, holding only the paths its diff changes, and the lane moves on
**And** while Epic 2's `reconcile` does not exist, the Maintainer approves and queues the PR by hand, and a lane that later sees it merged writes `merged`.

**Given** a PR that needs no approval and whose checks pass
**When** the lane enqueues it
**Then** it first writes `merging` with a swap that requires its own `owner`/`host`/`lane` and `generation`, then calls `enqueue` with the expected head
**And** a failed swap abandons the unit.

**Given** a queued PR
**When** the queue ejects it
**Then** the lane merges `main`, polls again and re-enqueues, counting toward `attempts`
**And** every move out of `merging` other than to `merged` dequeues first.

**Given** a merged PR
**When** the lane sees it
**Then** the record becomes `merged`, and the journal records the unit.

**Given** the suite
**When** it runs
**Then** each poll reply, conflict kind and outcome has a case against the fake forge.
`````
**NEW:**
`````text
**Given** the suite
**When** it runs
**Then** each poll reply, conflict kind and CI-fix outcome has a case against the fake forge.
`````
**Why:** D12: the approval gate, enqueue, ejection and merged ACs move to Story 1.17a unchanged apart from the Standing Authority re-check.

#### E-1.17a-a · Story 1.17a (new) · Approval gate and merge queue
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D12, C3
**OLD:**
`````text
### Story 1.18: Waits, STOP, `wake`, `stop --now` and usage limits
`````
**NEW:**
`````text
### Story 1.17a: Approval gate and merge queue

As an operator,
I want the lane to park a PR that needs approval and take every other passing PR through the merge queue in code,
So that the agent never merges, nothing merges past the approval gate or required checks, and a revoked Standing Authority stops every enqueue and merge (FR6, FR13, FR22, AR7, AR8, AR20, AR21).

**Acceptance Criteria:**

**Given** a PR whose diff touches a path the policy says needs its owner's approval
**When** its checks pass
**Then** the record becomes `parked`, holding only the paths its diff changes, and the lane moves on
**And** while Epic 2's `reconcile` does not exist, the Maintainer approves and queues the PR by hand, and a lane that later sees it merged writes `merged`.

**Given** a PR that needs no approval and whose checks pass
**When** the lane enqueues it
**Then** it first re-checks the Standing Authority from fresh `main`, then writes `merging` with a swap that requires its own `owner`/`host`/`lane` and `generation`, then calls `enqueue` with the expected head
**And** a failed swap abandons the unit.

**Given** a Standing Authority that is absent or invalid on fresh `main`
**When** the lane is about to enqueue or merge
**Then** it stops before the call, with no enqueue or merge (AR21).

**Given** a queued PR
**When** the queue ejects it
**Then** the lane merges `main`, polls again, re-checks the Standing Authority and re-enqueues, counting toward `attempts`
**And** every move out of `merging` other than to `merged` dequeues first.

**Given** a merged PR
**When** the lane sees it
**Then** the record becomes `merged`, and the journal records the unit.

**Given** the suite
**When** it runs
**Then** the approval gate, each queue outcome, the ejection and the Standing Authority re-check have a case against the fake forge.

### Story 1.18: Waits, STOP, `wake`, `stop --now` and usage limits
`````
**Why:** D12 creates Story 1.17a from Story 1.17's gate and queue ACs; C3 adds the Standing Authority re-check before enqueue and merge (AR21).

#### E-1.18-a · Story 1.18 · Failure wait keys on `failed`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** Minor
**OLD:**
`````text
**Then** it runs a child `sleep` with its PID in `wait.pid`, for 1 minute after progress, 30 after idle or 15 after a failure, then exits.
`````
**NEW:**
`````text
**Then** it runs a child `sleep` with its PID in `wait.pid`, for 1 minute after progress, 30 after idle or 15 after a failure (`outcome` `failed`, Story 1.16), then exits.
`````
**Why:** Minor item: the 15-minute wait keys on Story 1.16's `failed` outcome.

#### E-1.18-b · Story 1.18 · `usage-limit` spans
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C5
**OLD:**
`````text
**And** the sleep can be woken, a `STOP` ends it and releases the unit without an attempt, and the unit budget still applies.
`````
**NEW:**
`````text
**And** the sleep can be woken, a `STOP` ends it and releases the unit without an attempt, and the unit budget still applies.
**And** `journal.jsonl` gets one `usage-limit` span from the start of the sleep to its end (AR25).
`````
**Why:** C5: no Story wrote `usage-limit` spans, which Story 6.4's Stories-per-hour needs.

#### E-1.19-a · Story 1.19 · Fixed launcher and `runner` file
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D9
**OLD:**
`````text
**Given** `runner_version` in `.xarabot/config.yaml` on the repo's freshly fetched `origin/main`
**When** the lane is installed or started
**Then** that version is installed at `~/.xarabot/runner/<version>/` (from the `xaravel/xarabot` git tag until npm releases exist)
**And** the lane runs only from that path, never from a lane clone or the branch it builds.

**Given** a lane
**When** it is installed
**Then** a launchd plist with a restart throttle is written, checked against a golden file
**And** a lane that fails to start 3 times in a row writes its own `STOP` and posts an alert.
`````
**NEW:**
`````text
**Given** `runner_version` in `.xarabot/config.yaml` on the repo's freshly fetched `origin/main`
**When** the lane is installed
**Then** that version is installed at `~/.xarabot/runner/<version>/` (from the `xaravel/xarabot` git tag until npm releases exist) and named in the lane's `runner` file in its state folder
**And** the lane runs only from that path, never from a lane clone or the branch it builds.

**Given** a lane
**When** it is installed
**Then** `xarabot lane install` writes the fixed launcher `~/.xarabot/bin/xarabot-lane <repo> <lane>` and a launchd plist, with a restart throttle, that runs it, checked against a golden file
**And** the launcher runs the version named in the lane's `runner` file, and `XARABOT_SANDBOXED` is set only in agent sessions, never in the launcher or the runner
**And** a lane that fails to start 3 times in a row writes its own `STOP` and posts an alert.
`````
**Why:** D9: launchd runs a fixed launcher that reads the lane's `runner` file, and `XARABOT_SANDBOXED` reaches only agent sessions.

#### E-1.19-b · Story 1.19 · Switch at process exit
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D9
**OLD:**
`````text
**Given** `runner_version` changed on `main`
**When** the lane next starts
**Then** it installs and runs the new version
**And** pinning back to the previous version restores the previous runner.
`````
**NEW:**
`````text
**Given** a lane that sees a different `runner_version` on `main`
**When** it starts
**Then** it installs that version at `~/.xarabot/runner/<version>/`, rewrites its `runner` file and exits without claiming, and the next start runs that version; nothing re-execs mid-unit
**And** pinning back to the previous version restores the previous runner the same way.
`````
**Why:** D9: a lane switches versions by exiting, so nothing re-execs mid-unit.

#### E-1.20-a · Story 1.20 · Canary live command
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D3
**OLD:**
`````text
**And** the commit is authored by `<login>-xarabot[bot]` with no trailers.
`````
**NEW:**
`````text
**And** the commit is authored by `<login>-xarabot[bot]` with no trailers.
**And** `docs/maintainer/self-host.md` holds the canary's live command (`bun test --live <suite>`) and expected result, which the Maintainer runs on the Xarabot host, outside the sandbox, before Epic 1's retro; inside a sandboxed session the live cases report skipped.
`````
**Why:** D3: the Maintainer runs the canary live on the host before Epic 1's retro.

#### E-1.20-b · Story 1.20 · Runbook: bootstrapped Epic 1, sprint status, retro, live commands
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D2, D3, D6, C6
**OLD:**
`````text
**Then** it lists every Maintainer step for the switch, each with the command or file content to apply: the CI workflow as a required check; the `xarabot/claims` ruleset; the merge queue on `main`; squash messages set to PR title + body; the App permissions, including AR38's finding and `issues: write`; this repo's `.xarabot/config.yaml` with `runner_version`; a `policy.yaml` that makes every path need the Maintainer's approval and allows only `claude` unattended; the Standing Authority file; Epic 2's Story manifests; `XARABOT_MAX_BUILDERS=1`; `xarabot lane install`; and stopping the bootstrap loop.
`````
**NEW:**
`````text
**Then** it lists every Maintainer step for the switch, each with the command or file content to apply: the CI workflow as a required check; the `xarabot/claims` ruleset; the merge queue on `main`; squash messages set to PR title + body; the App permissions, including AR38's finding (`issues: write` is a Story 1.10 precondition); this repo's `.xarabot/config.yaml` with `runner_version` and `bootstrapped_epics: [1]`; a `policy.yaml` that makes every path need the Maintainer's approval and allows only `claude` unattended; the Standing Authority file; running `bmad-sprint-planning` once to create `sprint-status.yaml` with Epic 1's Stories `done` (a one-time Maintainer write, the exception AR4 records); running Epic 1's retro interactively; Epic 2's Story manifests, with `depends_on` where a Story builds on an earlier one; `XARABOT_MAX_BUILDERS=1`; `xarabot lane install`; and stopping the bootstrap loop
**And** it lists the live commands and expected results of the sandbox suites' nested cases (Stories 1.11 and 1.12), for the Maintainer to run on the host.
`````
**Why:** D2 adds `bootstrapped_epics: [1]`, the one-time sprint-status write and Epic 1's interactive retro; D6 adds `depends_on` to Epic 2's manifests; D3 adds the sandbox suites' live commands; C6 moved `issues: write` to Story 1.10's precondition.

### 4d. Epics 2 – 7

#### E-EPIC2-a · Epic 2 intro · Graph planning units and the Maintainer-run race proof
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** B3, D3
**OLD:**
`````text
Xarabot runs its own coordinator, under a coordinator claim: `reconcile`, planning, retro and retro-item units. Builder lanes share a host, or several hosts, without building a unit twice or colliding on globs, and no builder can write coordinator-owned files, manifests, agent config or policy. Planning units change the effective graph, so the graph-change gate lands here too. The builder limit stays at 1 until Epic 3 merges; Story 2.12 proves the race on the scratch repo.
`````
**NEW:**
`````text
Xarabot runs its own coordinator, under a coordinator claim: `reconcile`, planning, retro and retro-item units. Builder lanes share a host, or several hosts, without building a unit twice or colliding on globs, and no builder can write coordinator-owned files, manifests, agent config or policy. Graph planning units change the effective graph, so the graph-change gate lands here too. The builder limit stays at 1 until Epic 3 merges; Story 2.12 writes the race proof that the Maintainer runs on the scratch repo before Epic 2's retro.

Until Story 4.6 adds `/xarabot go retro:<N>`, a `rejected` retro of Epic 2 or Epic 3 holds its dependents until the Maintainer records the go by hand in `retro-gates.yaml`, in a Maintainer PR (AD-3).
`````
**Why:** Planning splits into status and graph units (B3), and the Maintainer, not a lane, runs each Epic's live proof (D3); a rejected retro before Story 4.6 needs a release that does not wait on the Epic it holds (D13) `[NEW CHOICE]`.

#### E-2.3-a · Story 2.3 · The write check names `epics.md`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C3, D5
**OLD:**
`````text
**When** it touches `sprint-status.yaml`, `retro-gates.yaml`, a manifest, `.xarabot/**`, the Standing Authority file, `.github/**`, agent config at any depth or the repo's Protected Paths
**Then** the squash is refused, the unit becomes `parked`, blocked, and the refusal is logged with the path and reason.
`````
**NEW:**
`````text
**When** it touches `sprint-status.yaml`, `retro-gates.yaml`, `epics.md`, a manifest, `.xarabot/**`, the Standing Authority file, `.github/**`, agent config at any depth or the repo's Protected Paths
**Then** the squash is refused, the unit becomes `parked`, blocked (`park.reason: write-check`), and the refusal is logged with the path and reason.
`````
**Why:** AD-3 makes `epics.md` coordinator-owned and AD-30 refuses it to builders, so a builder cannot edit its own Story's acceptance criteria; the park reason uses D5's vocabulary.

#### E-2.4-a · Story 2.4 · Coordinator order and the positions tested here
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** B3, D11
**OLD:**
`````text
**Then** it returns units in AR14's order: `reconcile`, then an open coordinator PR, then planning, retro, retro items and checkpoint, or `idle` with a reason
**And** it never returns a Story, and a builder never receives a coordinator unit
**And** each position in the order has a case-table test.
`````
**NEW:**
`````text
**Then** it returns units in AR14's order: `reconcile`, then an open coordinator PR, then planning (a due graph unit before a due status unit), retro, retro items and checkpoint, or `idle` with a reason
**And** it never returns a Story, and a builder never receives a coordinator unit
**And** the case table tests the positions that exist in this Story, `reconcile` and an open coordinator PR; Stories 2.7, 2.9, 2.10 and 4.4 each add their position's cases.
`````
**Why:** A due graph unit runs before a status unit (B3), and Story 2.4 tests only the positions whose rules exist so far (D11).

#### E-2.4-b · Story 2.4 · Globs for the two planning units
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** B3
**OLD:**
`````text
**Then** planning holds the graph inputs, both status files and the Epic context path; retro and checkpoint hold the status files and the Epic context path, never the graph inputs; `reconcile` holds none; and the overlap check applies to the coordinator as to builders.
`````
**NEW:**
`````text
**Then** a graph planning unit holds the graph inputs and the pseudo-glob `xarabot:graph`; a status planning unit holds both status files and the Epic context path, never the graph inputs; retro and checkpoint hold the status files and the Epic context path, never the graph inputs; `reconcile` holds none; and the overlap check applies to the coordinator as to builders.
`````
**Why:** [NEW CHOICE] B3 splits planning so that no unit writes both a graph input and a status file, so each half holds only its own paths; this narrows AD-13's single planning-glob rule, which the spine edit must match.

#### E-2.4-c · Story 2.4 · Write check per planning unit, and installing the coordinator lane
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** B3, C6
**OLD:**
`````text
**When** it touches a path its unit does not hold, a graph input from a unit that is not `planning`, anything under `.xarabot/**` other than `epics.yaml`, or both a graph input and a status file
**Then** the write check (Story 2.3) refuses it, and the case table gains a row per rule (AR31).
`````
**NEW:**
`````text
**When** it touches a path its unit does not hold, a graph input from a unit that is not a graph planning unit, anything under `.xarabot/**` other than `epics.yaml`, or both a graph input and a status file
**Then** the write check (Story 2.3) refuses it, and the case table gains a row per rule (AR31).

**Given** `docs/maintainer/self-host.md`
**When** the Story is done
**Then** it adds the Maintainer step of installing the coordinator lane with `xarabot lane install --role coordinator`, which Epic 2's retro, and so Epic 3, waits on.
`````
**Why:** Only graph planning units may touch graph inputs (B3), and no Story told the Maintainer to install the coordinator lane that Epic 2's retro needs (C6).

#### E-2.5-a · Story 2.5 · Done comes from sprint status; status entries after a graph unit merges
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D1, B3
**OLD:**
`````text
**Then** it writes their `merged` records, and marks each unit done on `main` per AR10's rule for its kind (a Story becomes `done` in `sprint-status.yaml`)
**And** it opens a `reconcile` PR holding only runner-written content, which gets no agent review and no agent loopback.
`````
**NEW:**
`````text
**Then** it writes their `merged` records, and marks each unit done on `main` per AR10's rule for its kind (a Story becomes `done` in `sprint-status.yaml`, which is where `next` and the gates read that it is done, since its record is later deleted)
**And** for a merged graph planning unit, it writes that unit's status entries to `sprint-status.yaml` (the Epics and Stories it added), so a graph unit never writes a status file itself
**And** it opens a `reconcile` PR holding only runner-written content, which gets no agent review and no agent loopback.
`````
**Why:** D1 makes `sprint-status.yaml` the source of done-ness after records are deleted, and B3 gives the graph unit's status entries to `reconcile`, as AD-13 already states.

#### E-2.6-a · Story 2.6 · Standing Authority re-check before enqueue
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C3
**OLD:**
`````text
**Then** it records `approved_sha`, takes the record at `generation` + 1, fences, writes `merging` and enqueues with the expected head.
`````
**NEW:**
`````text
**Then** it records `approved_sha`, re-checks the Standing Authority from freshly fetched `main`, takes the record at `generation` + 1, fences, writes `merging` and enqueues with the expected head
**And** a missing or invalid Standing Authority stops the lane before it enqueues, and the record stays `parked` (AR21).
`````
**Why:** AD-20 re-checks the Standing Authority before every enqueue, and this Story's enqueue skipped it.

#### E-2.7-a · Story 2.7 · Status and graph planning units
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** B3, D2, D5, D6, D11
**OLD:**
`````text
I want the coordinator to keep sprint status, manifests and Epic context current through stock BMAD planning,
So that Stories become eligible without me running sprint planning by hand (FR2, NFR5, AR14, AR30).

**Acceptance Criteria:**

**Given** a snapshot where `epics.md` has Epics or Stories missing from `sprint-status.yaml`, Story headings with no manifest, or an Epic about to become eligible with no current Epic context file
**When** `next(snapshot, 'coordinator')` reaches planning
**Then** it returns a `planning:<slug>.<n>` unit naming what is due.

**Given** a planning unit
**When** its prompt is built
**Then** it runs stock `bmad-sprint-planning` told to run headless, plus the due manifests, Epic context and graph edits, with the `.xarabot/epics.yaml` schema stated in the package template (AR12)
**And** its result is the `planning` kind.

**Given** a planning diff
**When** it is squashed
**Then** the write check (Story 2.3) applies, so it touches only the planning paths, and never both a graph input and a status file.

**Given** a recurring planning unit with nothing to commit
**When** it ends
**Then** its record becomes `merged` with no PR and is deleted at once.

**Given** the coordinator
**When** it has an open coordinator PR
**Then** it takes no new planning unit until that PR merges or parks (AR14 order).
`````
**NEW:**
`````text
I want the coordinator to keep sprint status and Epic context current through stock BMAD planning, and manifests and the Epic graph current through planning PRs I approve,
So that Stories become eligible without me running sprint planning by hand (FR2, NFR5, AR14, AR30).

**Acceptance Criteria:**

**Given** a snapshot where `epics.md` has Epics or Stories missing from `sprint-status.yaml`, or an Epic about to become eligible with no current Epic context file
**When** `next(snapshot, 'coordinator')` reaches planning
**Then** it returns a status planning unit, `planning:<slug>.<n>`, naming what is due.

**Given** a snapshot where `epics.md` has Story headings with no manifest, outside the Epics listed in `bootstrapped_epics`
**When** `next(snapshot, 'coordinator')` reaches planning
**Then** it returns a graph planning unit, `planning:<slug>.<n>`, naming what is due
**And** when a graph unit and a status unit are both due, it returns the graph unit first.

**Given** a status planning unit
**When** its prompt is built
**Then** it runs stock `bmad-sprint-planning` told to run headless, plus the due Epic context, and never touches a graph input.

**Given** a graph planning unit
**When** its prompt is built
**Then** it names the due manifests and graph edits to `epics.md` and `.xarabot/epics.yaml`, with the `.xarabot/epics.yaml` schema stated in the package template (AR12), does not run `bmad-sprint-planning`, and never touches a status file
**And** it asks for `depends_on` in each manifest whose Story builds on an earlier Story, listing those Story ids, each in the same Epic or an Epic it depends on.

**Given** either planning unit
**When** its result is read
**Then** it is the `planning` kind, with `outcome` `done`, `nothing-due` or `blocked`.

**Given** a planning diff
**When** it is squashed
**Then** the write check (Story 2.3) applies: a status unit's diff touches only the status files and the Epic context path, a graph unit's diff touches only the graph inputs, and no diff touches both a graph input and a status file.

**Given** a graph planning unit's PR
**When** its checks pass
**Then** it parks for the Maintainer's approval (under the every-path approval rule until Story 2.8's graph-change gate exists), and the next `reconcile` after it merges writes its status entries (Story 2.5)
**And** a status planning unit's PR is not approval-gated, except where repo policy makes every path need approval.

**Given** a recurring planning unit with nothing to commit
**When** it ends
**Then** its record becomes `merged` with no PR and is deleted at once.

**Given** the coordinator
**When** it has an open coordinator PR
**Then** it takes no new planning unit until that PR merges or parks (AR14 order).

**Given** the coordinator case table from Story 2.4
**When** it runs
**Then** it gains the planning position's cases: a status unit due, a graph unit due, both due with the graph unit first, and a Story heading with no manifest in an Epic listed in `bootstrapped_epics`, which makes nothing due.
`````
**Why:** B3 splits planning so that no unit writes both a graph input and a status file; D6 has graph units write `depends_on`; D5 names the `planning.outcome` values; D2 keeps bootstrapped Epics' headings from making planning due; D11 adds the planning position's cases.

#### E-2.9-a · Story 2.9 · Done from sprint status, verdict vocabulary, rejected retros and the retro position
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D1, D2, D5, D11, D13
**OLD:**
`````text
**Given** an Epic whose Stories are all merged and done, with no retro verdict
**When** `next(snapshot, 'coordinator')` reaches retro
**Then** it returns `retro:<epic>`.

**Given** a retro unit
**When** its prompt is built
**Then** it runs `bmad-retrospective -H <epic>`, then asks for each action item's `id`, `blocking`, `route` and `globs`, and the result is the `retro` kind.

**Given** a retro result
**When** the runner validates it before the squash
**Then** it rejects a result whose items do not match one to one the `action_items` the diff appends to `sprint-status.yaml` (by stock BMAD id), or whose `verdict` differs from the retro document's frontmatter
**And** a rejected result counts as a failed attempt.

**Given** a valid retro result
**When** the PR merges
**Then** the runner stores the result in the unit's ledger record, and the next `reconcile` writes the verdict and items to `retro-gates.yaml` once, marking the retro done.

**Given** an item's globs
**When** they include graph inputs, status files or anything the write check refuses a builder
**Then** the result is rejected.
`````
**NEW:**
`````text
**Given** an Epic whose Stories are all `done` in `sprint-status.yaml`, with no retro verdict
**When** `next(snapshot, 'coordinator')` reaches retro
**Then** it returns `retro:<epic>`
**And** an Epic listed in `bootstrapped_epics` never gets a retro unit; the gates read its retro as done.

**Given** a retro unit
**When** its prompt is built
**Then** it runs `bmad-retrospective -H <epic>`, then asks for each action item's `id`, `blocking`, `route` (`lane` or `maintainer`) and `globs`, and the result is the `retro` kind, with `verdict` `accepted`, `accepted-with-open-items` or `rejected`.

**Given** a retro result
**When** the runner validates it before the squash
**Then** it fails a result whose items do not match one to one the `action_items` the diff appends to `sprint-status.yaml` (by stock BMAD id), or whose `verdict` differs from the `verdict` field in the frontmatter of the retro document, stock BMAD's `epic-<N>-retro-<date>.md`, found by the configured `retro_doc_glob`
**And** a result that fails validation counts as a failed attempt.

**Given** a valid retro result
**When** the PR merges
**Then** the runner stores the result in the unit's ledger record, and the next `reconcile` writes the verdict and items to `retro-gates.yaml` once, marking the retro done.

**Given** a valid retro result with verdict `rejected`
**When** `reconcile` writes it
**Then** it is written like any other verdict; Epic 4 holds the Epics that depend on this one until the Maintainer's `/xarabot go retro:<N>`, and lists the course-correction item in the Maintainer's inbox.

**Given** an item's globs
**When** they include graph inputs, status files or anything the write check refuses a builder
**Then** the result fails validation.

**Given** the coordinator case table from Story 2.4
**When** it runs
**Then** it gains the retro position's cases: an Epic with every Story `done` and no verdict, an Epic with a Story not yet `done`, and an Epic listed in `bootstrapped_epics`.
`````
**Why:** D1 reads done-ness from `sprint-status.yaml`; D5 names the verdict and route values and the retro document's `verdict` field and path; D13 makes `rejected` hold dependents (built in Epic 4); D2 gives bootstrapped Epics no retro unit; D11 adds the retro position's cases; "rejected" for a failed validation is renamed so it is not read as the verdict.

#### E-2.10-a · Story 2.10 · Lane-routed items use `route: lane`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D5
**OLD:**
`````text
**Given** an open item in `retro-gates.yaml` with globs, not routed to the Maintainer
`````
**NEW:**
`````text
**Given** an open item in `retro-gates.yaml` with globs and `route: lane`
`````
**Why:** D5 names the route values `lane` and `maintainer`.

#### E-2.10-b · Story 2.10 · `route: maintainer` and the retro-items position
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D5, D11
**OLD:**
`````text
**Given** an item routed to the Maintainer
**When** `next` runs
**Then** it is skipped; Epic 4 lists it in the inbox.
`````
**NEW:**
`````text
**Given** an item with `route: maintainer`
**When** `next` runs
**Then** it is skipped; Epic 4 lists it in the inbox.

**Given** the coordinator case table from Story 2.4
**When** it runs
**Then** it gains the retro-items position's cases: an open item with globs and `route: lane`, an item with no globs, an item with `route: maintainer`, and an item already `done`.
`````
**Why:** D5 names the route value, and D11 has this Story add its position's cases.

#### E-2.12-a · Story 2.12 · The Maintainer runs the live race proof
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D3
**OLD:**
`````text
**Given** the suite
**When** it runs without live credentials
**Then** the live cases are reported as skipped; the 30-minute case is marked long-running and runs only when asked.

**Given** `docs/maintainer/self-host.md`
**When** the Story is done
**Then** it adds the Maintainer-run acceptance check for after Epic 3: a coordinator and 2 builders for 24 hours with no unit built twice and no builder write to the status files (FR4).
`````
**NEW:**
`````text
**Given** the suite
**When** it runs without live credentials, or inside a sandboxed session (`XARABOT_SANDBOXED=1`)
**Then** the live cases are reported as skipped, never as passed; the 30-minute case is marked long-running and runs only when asked.

**Given** `docs/maintainer/self-host.md`
**When** the Story is done
**Then** it records this suite's live command (`bun test --live <suite>`, the 30-minute case included) and its expected result, which the Maintainer runs on the host, outside the sandbox, before Epic 2's retro
**And** it adds the Maintainer-run acceptance check for after Epic 3: a coordinator and 2 builders for 24 hours with no unit built twice and no builder write to the status files (FR4).
`````
**Why:** Sessions have no GitHub host or token, so the Maintainer runs each Epic's live proof from the recorded command (D3).

#### E-3.1-a · Story 3.1 · Nested sandbox cases skip inside a sandboxed session
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D3
**OLD:**
`````text
**Given** the `Agent` contract suite, the sandbox refusal suite and the write-check case table
**When** they run for `codex`
**Then** each passes, with live cases skipped without credentials.
`````
**NEW:**
`````text
**Given** the `Agent` contract suite, the sandbox refusal suite and the write-check case table
**When** they run for `codex`
**Then** each passes, with live cases skipped without credentials
**And** inside a sandboxed session (`XARABOT_SANDBOXED=1`) the sandbox refusal suite skips its nested cases and reports them as skipped; the Maintainer runs them live on the host with Story 3.6's proof.
`````
**Why:** `sandbox-exec` likely cannot nest, so the re-run inside a session skips and the Maintainer runs those cases live (D3).

#### E-3.2-a · Story 3.2 · The spike confirms pi's attribution-off and sandbox settings
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** Minor (Story 3.2)
**OLD:**
`````text
**Then** it first confirms pi's agent-directory override, whether pi gives `bmad-build-auto` the subagents it requires, how its outcomes map onto the `build` result, and how a pi session is resumed
`````
**NEW:**
`````text
**Then** it first confirms pi's agent-directory override, whether pi gives `bmad-build-auto` the subagents it requires, how its outcomes map onto the `build` result, how a pi session is resumed, pi's attribution-off setting, and how pi's own sandbox is turned off
`````
**Why:** Story 3.2 omitted pi's attribution-off setting (AD-29) and turning off pi's own sandbox (AD-17).

#### E-3.2-b · Story 3.2 · `launchSpec` turns pi's sandbox and attribution off
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** Minor (Story 3.2)
**OLD:**
`````text
**Then** it returns `pi -p --mode json --model <provider/id> --thinking <effort>` with pi's agent directory pointed at the lane's vendor home, which holds the operator's OpenRouter sign-in, plus `XARABOT_RESULT` and the clone as working directory
`````
**NEW:**
`````text
**Then** it returns `pi -p --mode json --model <provider/id> --thinking <effort>` with pi's own sandbox turned off inside Xarabot's, its attribution-off setting, and pi's agent directory pointed at the lane's vendor home, which holds the operator's OpenRouter sign-in, plus `XARABOT_RESULT` and the clone as working directory
`````
**Why:** Matches the `codex` launch in Story 3.1 and AD-17 and AD-29.

#### E-3.2-c · Story 3.2 · Nested sandbox cases skip inside a sandboxed session
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D3
**OLD:**
`````text
**Given** the `Agent` contract suite, the sandbox refusal suite and the write-check case table
**When** they run for `pi`
**Then** each passes, with live cases skipped without credentials.
`````
**NEW:**
`````text
**Given** the `Agent` contract suite, the sandbox refusal suite and the write-check case table
**When** they run for `pi`
**Then** each passes, with live cases skipped without credentials
**And** inside a sandboxed session (`XARABOT_SANDBOXED=1`) the sandbox refusal suite skips its nested cases and reports them as skipped; the Maintainer runs them live on the host with Story 3.6's proof.
`````
**Why:** Same as Story 3.1 (D3).

#### E-3.3-a · Story 3.3 · Same-vendor reviewer rule is decided
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D4
**OLD:**
`````text
**And** the case table has rows for a `claude`-only, a `codex`-only and a `pi`-only policy, and the unit never parks for lack of a reviewer.
`````
**NEW:**
`````text
**And** the case table has rows for a `claude`-only, a `codex`-only and a `pi`-only policy, and the unit never parks for lack of a reviewer
**And** `pi` is never picked as a cross-vendor reviewer in 0.x, so a `pi`-only policy gets a same-vendor review even when pi could run another vendor's model (Maintainer decision, 2026-10-21; revisited for v1).
`````
**Why:** D4 confirms the same-vendor rule and keeps cross-vendor reviewers to `claude` and `codex`.

#### E-3.5-a · Story 3.5 · Park at the loopback cap whatever the verdict
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C3, D5
**OLD:**
`````text
**And** once `loopbacks` ≥ 2 and blocking findings remain, the unit becomes `parked`, blocked, with `park.inbox_owner` set to its owner.
`````
**NEW:**
`````text
**And** once `loopbacks` ≥ 2, the unit becomes `parked`, blocked (`park.reason: review-cap`), whatever the review's verdict, with `park.inbox_owner` set to its owner.
`````
**Why:** AD-16 parks past the loopback cap regardless of verdict; the park reason uses D5's vocabulary.

#### E-3.6-a · Story 3.6 · The Maintainer runs the cross-vendor proof with every vendor's credential
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D3
**OLD:**
`````text
**Given** `docs/maintainer/self-host.md`
**When** the Story is done
**Then** it lists the switch after this Epic: drop the every-path approval rule from this repo's `policy.yaml`, allow the adapters to be used unattended, raise `XARABOT_MAX_BUILDERS`, and run the 24-hour acceptance check.
`````
**NEW:**
`````text
**Given** `docs/maintainer/self-host.md`
**When** the Story is done
**Then** it records this suite's live command (`bun test --live <suite>`) and the expected result of each case above, and the nested sandbox cases of Stories 3.1 and 3.2; the Maintainer runs them on the host, outside the sandbox, with every vendor's credential at once (a lane's vendor home holds only one), before Epic 3's retro
**And** inside a sandboxed session the live cases are reported as skipped, never as passed
**And** it lists the switch after this Epic: drop the every-path approval rule from this repo's `policy.yaml`, allow the adapters to be used unattended, raise `XARABOT_MAX_BUILDERS`, and run the 24-hour acceptance check.
`````
**Why:** D3: the Maintainer runs the live proof, and Story 3.6 needs every vendor's credential at once, which no vendor home holds.

#### E-4.1-a · Story 4.1 · A rejected retro holds every dependent
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D13
**OLD:**
`````text
**Then** a `blocking` item holds every Epic at distance 1 or more, and any other open item holds every Epic at distance 2 or more
**And** items with status `open`, `in-progress` or `waiting` count as open, and `deferred` and `done` do not.

**Given** `next` for a builder
**When** an Epic is held by a retro item
**Then** it takes no new Stories from that Epic, and the idle reason names the item.
`````
**NEW:**
`````text
**Then** a `blocking` item holds every Epic at distance 1 or more, and any other open item holds every Epic at distance 2 or more
**And** items with status `open`, `in-progress` or `waiting` count as open, and `deferred` and `done` do not.

**Given** E's retro verdict `rejected` and no `go retro:<E>` recorded in `retro-gates.yaml`
**When** the pure gate runs
**Then** it holds every Epic at distance 1 or more, as a `blocking` item does
**And** a verdict of `accepted` or `accepted-with-open-items` holds nothing by itself, and a recorded `go retro:<E>` releases a rejected one.

**Given** `next` for a builder
**When** an Epic is held by a retro item or a rejected retro
**Then** it takes no new Stories from that Epic, and the idle reason names the item or the rejected retro.
`````
**Why:** D13: a rejected retro holds its dependents like a `blocking` item until the Maintainer's go.

#### E-4.1-b · Story 4.1 · Rejected-retro case in the FR10 table
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D13
**OLD:**
`````text
**Then** an untagged open item from E does not gate an Epic one step from E but does gate one two steps away, and a `blocking` item gates every Epic depending on E, directly or through others.
`````
**NEW:**
`````text
**Then** an untagged open item from E does not gate an Epic one step from E but does gate one two steps away, and a `blocking` item gates every Epic depending on E, directly or through others
**And** a `rejected` verdict on E gates every Epic depending on E until `go retro:<E>` is recorded, and no longer after it.
`````
**Why:** D13's gate needs its own case.

#### E-4.2-a · Story 4.2 · The inbox is kept current and announced once a day
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D7
**OLD:**
`````text
I want one inbox listing everything waiting on me, rewritten once a day,
`````
**NEW:**
`````text
I want one inbox listing everything waiting on me, kept current and announced once a day,
`````
**Why:** D7: each `reconcile` rewrites the body when it changes, and one daily comment announces it.

#### E-4.2-b · Story 4.2 · Digest trigger, Maintainer items and waiting spans
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D7, D13, D2, D5, C5
**OLD:**
`````text
**Given** the coordinator's daily run
**When** `renderDigest` rewrites an owner's issue body from the ledger's `parked` records, PR states and `retro-gates.yaml`
**Then** it lists their bot's PRs awaiting approval and their blocked units, each with its link, its age and the ruling verbs that apply.

**Given** the Maintainer's inbox
**When** the digest is rendered
**Then** it also lists checkpoint gos waiting, Infrastructure Stories needing approval, Maintainer-routed retro items, graph-changing PRs awaiting approval, Story headings with no manifest, and units waiting on a Human Live Step (`blocked.kind`).

**Given** the digest
**When** nothing has changed since the last rewrite
**Then** the body is not rewritten, and no other comment is posted.
`````
**NEW:**
`````text
**Given** a `reconcile` run
**When** `renderDigest` renders an owner's issue body from the ledger's `parked` records, PR states and `retro-gates.yaml`
**Then** it lists their bot's PRs awaiting approval and their blocked units, each with its link, its age and the ruling verbs that apply
**And** it rewrites the body only when its content changed; GitHub sends no notification for a body edit.

**Given** the Maintainer's inbox
**When** the digest is rendered
**Then** it also lists checkpoint gos waiting, Infrastructure Stories needing approval, Maintainer-routed retro items, rejected retros with their course-correction item and the `go retro:<N>` ruling, graph-changing PRs awaiting approval, Story headings with no manifest outside the Epics listed in `bootstrapped_epics`, and units waiting on a Human Live Step (`blocked.kind: human-live-step`).

**Given** config `digest_time` (default `08:00` UTC), added to the config schema
**When** the first `reconcile` run at or after that time each day runs
**Then** it posts one @mention comment per inbox, linking the body, and records the post time in `coordinator.json`
**And** no other digest comment is posted that day, whether or not the body changed.

**Given** a lane whose `next` returns `idle` only because of a checkpoint go, a parked approval, a rejected retro or a Maintainer-routed item
**When** it records the span in `journal.jsonl`
**Then** the span's reason is `waiting-on-maintainer`, not `idle` (AR25).
`````
**Why:** D7 gives the digest its trigger and stored state; D13 puts the course-correction item in the inbox; D2 keeps bootstrapped Epics' headings out; D5 names the `blocked.kind` value; C5 defines and writes `waiting-on-maintainer` spans.

#### E-4.3-a · Story 4.3 · Batch routing keys on `route: maintainer`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D5
**OLD:**
`````text
**Given** a retro whose items include ones with `route` naming the Maintainer
`````
**NEW:**
`````text
**Given** a retro whose items include ones with `route: maintainer`
`````
**Why:** D5 names the route value.

#### E-4.4-a · Story 4.4 · The checkpoint position's coordinator cases
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D11
**OLD:**
`````text
**Then** dependents at distance 1 and 2, a sibling not depending on C, an in-flight Epic and a late-added checkpoint each have a case.
`````
**NEW:**
`````text
**Then** dependents at distance 1 and 2, a sibling not depending on C, an in-flight Epic and a late-added checkpoint each have a case
**And** the coordinator case table from Story 2.4 gains the checkpoint position's cases: C's retro done with no go and no `checkpoint` unit yet, and C with its go recorded.
`````
**Why:** D11 has this Story add its coordinator position's cases.

#### E-4.5-a · Story 4.5 · `go` also names a rejected retro
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D13
**OLD:**
`````text
**Then** it accepts only `/xarabot <verb> <unit-id>` with a verb of `go`, `approve`, `block`, `unblock`, `rebuild`, `release` or `dismiss` and a unit id in AR35 form, and ignores any other text.
`````
**NEW:**
`````text
**Then** it accepts only `/xarabot <verb> <unit-id>` with a verb of `go`, `approve`, `block`, `unblock`, `rebuild`, `release` or `dismiss` and a unit id in AR35 form, and ignores any other text
**And** `go` applies to a `checkpoint:<epic>` unit, or to a `retro:<epic>` unit whose verdict is `rejected`.
`````
**Why:** D13 extends `go` from checkpoints to rejected retros, still Maintainer only.

#### E-4.5-b · Story 4.5 · Case for `go` on a retro
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D13
**OLD:**
`````text
**Then** each verb, each author class and each malformed form has a case.
`````
**NEW:**
`````text
**Then** each verb, each author class and each malformed form has a case, and `go` has a case on a rejected retro and on a retro that is not rejected.
`````
**Why:** The new `go` target needs its accept and refuse cases.

#### E-4.6-a · Story 4.6 · What `go retro:<N>` does
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D13
**OLD:**
`````text
**Given** `/xarabot go <checkpoint-epic>`
**When** `reconcile` applies it
**Then** the go is recorded in `retro-gates.yaml` by runner code, and the Epic's dependents become eligible at the next claim.
`````
**NEW:**
`````text
**Given** `/xarabot go <checkpoint-epic>`
**When** `reconcile` applies it
**Then** the go is recorded in `retro-gates.yaml` by runner code, and the Epic's dependents become eligible at the next claim.

**Given** `/xarabot go retro:<N>` for an Epic whose retro verdict is `rejected`
**When** `reconcile` applies it
**Then** the go is recorded in `retro-gates.yaml` by runner code, the course-correction item leaves the Maintainer's inbox, and the rejected verdict no longer holds Epic N's dependents from the next claim.
`````
**Why:** D13: the Maintainer releases a rejected retro with `go retro:<N>`.

#### E-4.7-a · Story 4.7 · A rejected retro on the fixture
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D13
**OLD:**
`````text
**Given** the same fixture with `contracts` as a checkpoint and its go pending
**When** builders run
**Then** the dependent Epics take no new Stories, and an Epic not depending on `contracts` keeps running.
`````
**NEW:**
`````text
**Given** the same fixture with `contracts` as a checkpoint and its go pending
**When** builders run
**Then** the dependent Epics take no new Stories, and an Epic not depending on `contracts` keeps running.

**Given** the same fixture with `contracts`' retro verdict `rejected`
**When** builders run
**Then** the Epics depending on `contracts` take no new Stories until `/xarabot go retro:<N>` for `contracts` is recorded, and take Stories after it.
`````
**Why:** D13's hold and release need an end-to-end case.

#### E-4.7-b · Story 4.7 · The Maintainer runs the live gates proof
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D3
**OLD:**
`````text
**Given** the scratch repo's inbox
**When** the digest is rendered
**Then** every waiting item appears once, with its link and age.
`````
**NEW:**
`````text
**Given** the scratch repo's inbox
**When** the digest is rendered
**Then** every waiting item appears once, with its link and age.

**Given** `docs/maintainer/self-host.md`
**When** the Story is done
**Then** it records this suite's live command (`bun test --live <suite>`) and the expected result of each scratch-repo case above, which the Maintainer runs on the host, outside the sandbox, before Epic 4's retro
**And** inside a sandboxed session the live cases are reported as skipped, never as passed.
`````
**Why:** D3: the Maintainer runs each Epic's live proof.

#### E-5.1-a · Story 5.1 · Move the permission table to Story 5.1a
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D12
**OLD:**
`````text
**Given** the GitHub adapter
**When** it calls GitHub
**Then** every REST and GraphQL operation goes through one request function that takes an entry from a single table in the adapter, naming the operation and the App permission it needs, and no other code in the adapter calls `fetch`.

**Given** that table and the manifest
**When** the permission test runs
**Then** it fails if any operation needs a permission the manifest does not ask for, or at a lower level than the operation needs
**And** it fails if the manifest asks for a permission no operation needs, so the set stays exactly what Xarabot uses.

**Given** an App record already present
`````
**NEW:**
`````text
**Given** an App record already present
`````
**Why:** D12 splits Story 5.1: it keeps `xarabot join`'s App creation, and Story 5.1a takes the table across the GitHub adapter.

#### E-5.1a-a · Story 5.1a (new) · The GitHub adapter's permission table
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D12, C8
**OLD:**
`````text
**Given** `xarabot join` working
**When** the Story is done
**Then** `bootstrap/join.ts` is removed, and `docs/maintainer/self-host.md` points to `xarabot join` instead.
`````
**NEW:**
`````text
**Given** `xarabot join` working
**When** the Story is done
**Then** `bootstrap/join.ts` is removed, and `docs/maintainer/self-host.md` points to `xarabot join` instead.

### Story 5.1a: The GitHub adapter's permission table

As the Maintainer,
I want every GitHub call the adapter makes to name the App permission it needs, in one table checked against the App manifest,
So that each owner's App asks for exactly the rights Xarabot uses, and no call needs a right the App lacks (FR13, NFR9, AR27).

**Acceptance Criteria:**

**Given** the GitHub adapter
**When** it calls GitHub
**Then** every REST and GraphQL operation goes through one request function that takes an entry from a single table in the adapter, naming the operation and the App permission it needs, and no other code in the adapter calls `fetch`.

**Given** that table
**When** it is checked
**Then** it has an entry for `metadata: read`, which GitHub grants every App
**And** git pushes, which go through the credential helper and not `fetch`, are listed under `contents: write`
**And** `xarabot join`'s manifest-conversion and App-JWT calls are listed as needing no installation permission.

**Given** that table and the manifest from Story 5.1
**When** the permission test runs
**Then** it fails if any operation needs a permission the manifest does not ask for, or at a lower level than the operation needs
**And** it fails if the manifest asks for a permission no operation needs, so the set stays exactly what Xarabot uses.

**Given** the permission table in the architecture spine's AD-26 (AR27)
**When** the Story is done
**Then** the adapter's table matches it, and any difference is raised to the Maintainer instead of decided in the Story.
`````
**Why:** D12's split, with C8's table nits (`metadata: read`, pushes under `contents: write`, `join`'s calls with no installation permission) and the copy of the table in AD-26.

#### E-5.2-a · Story 5.2 · Point to Story 1.19's uncovered-repo refusal
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** Minor (Story 5.2)
**OLD:**
`````text
**Given** a selected-repositories installation that does not cover the repo
**When** `xarabot join` runs, or a lane starts for that repo
**Then** it stops, naming the repo to add and where to add it.
`````
**NEW:**
`````text
**Given** a selected-repositories installation that does not cover the repo
**When** `xarabot join` runs
**Then** it stops, naming the repo to add and where to add it; a lane start for that repo is refused by Story 1.19's check.
`````
**Why:** Story 1.19 already refuses a lane start when the installation does not cover the repo.

#### E-5.3-a · Story 5.3 · Precondition: a test org and a browser-made App
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C6
**OLD:**
`````text
So that the bot is never more than its owner's hands (FR13, AR17, AR27).
`````
**NEW:**
`````text
So that the bot is never more than its owner's hands (FR13, AR17, AR27).

Precondition (Human Live Step): the Maintainer provides a test org with an App created there by `xarabot join` through the browser confirm click, installed on a test repo whose Protected Path requires the owner's review.
`````
**Why:** Story 5.3 needed a test org and a browser-made App with no precondition (C6).

#### E-5.3-b · Story 5.3 · The Maintainer runs the live bot-rights proof
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D3
**OLD:**
`````text
**Given** every lane-made commit and PR in the suite
**When** it is inspected
**Then** it is authored by `<login>-xarabot[bot]`.
`````
**NEW:**
`````text
**Given** every lane-made commit and PR in the suite
**When** it is inspected
**Then** it is authored by `<login>-xarabot[bot]`.

**Given** `docs/maintainer/self-host.md`
**When** the Story is done
**Then** it records this suite's live command (`bun test --live <suite>`) and the expected result of each case above, which the Maintainer runs on the host, outside the sandbox, against the test org, before Epic 5's retro
**And** inside a sandboxed session the live cases are reported as skipped, never as passed.
`````
**Why:** D3: the Maintainer runs each Epic's live proof.

#### E-6.4-a · Story 6.4 · A `usage-limit` span case
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C5
**OLD:**
`````text
**Then** each figure, an all-lanes-waiting span and a span where only some lanes wait each have a case.
`````
**NEW:**
`````text
**Then** each figure, an all-lanes-waiting span, a span where only some lanes wait, and an all-lanes `usage-limit` span, whose hours are not left out, each have a case.
`````
**Why:** Story 1.18 now writes `usage-limit` spans, and AD-24 leaves out only `waiting-on-maintainer` hours.

#### E-6.5-a · Story 6.5 · The fixture holds both waiting span kinds
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C5
**OLD:**
`````text
**Given** a fixture journal for a stated 7-day window with a hand-computed Stories-per-hour figure
`````
**NEW:**
`````text
**Given** a fixture journal for a stated 7-day window, with `waiting-on-maintainer` spans (Story 4.2) and `usage-limit` spans (Story 1.18), and a hand-computed Stories-per-hour figure
`````
**Why:** C5: the fixture must not hide whether waiting spans are written and left out correctly.

#### E-6.5-b · Story 6.5 · The Maintainer runs the live status proof
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D3
**OLD:**
`````text
**Given** the status and report commands
**When** they run during a lane's unit
**Then** the lane's ledger record, journal and outcome are unchanged by them.
`````
**NEW:**
`````text
**Given** the status and report commands
**When** they run during a lane's unit
**Then** the lane's ledger record, journal and outcome are unchanged by them.

**Given** `docs/maintainer/self-host.md`
**When** the Story is done
**Then** it records the live checks, each with its command (`bun test --live <suite>`, and `xarabot tui` on a laptop with `XARABOT_HOST` set) and expected result, which the Maintainer runs on the host and the laptop, outside the sandbox, before Epic 6's retro
**And** inside a sandboxed session the live cases are reported as skipped, never as passed.
`````
**Why:** D3: the Maintainer runs each Epic's live proof.

#### E-7.2-a · Story 7.2 · Upgrade PRs have no ledger unit
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D8
**OLD:**
`````text
**Given** `xarabot upgrade <version>` run by the Maintainer in a consuming repo
**When** it runs
**Then** the runner, as the Maintainer's bot, opens a PR that changes the exact pin and `runner_version` together, and the PR parks for the Maintainer's approval because `.xarabot/**` is a Protected Path
**And** the PR body carries that version's changelog entry.
`````
**NEW:**
`````text
**Given** `xarabot upgrade <version>` run by the Maintainer on the Xarabot host for a consuming repo
**When** it runs
**Then** it opens, as the Maintainer's bot, a PR that changes the exact pin and `runner_version` together, with no ledger unit
**And** the PR body carries that version's changelog entry
**And** the Maintainer approves the PR and adds it to the merge queue by hand; no lane and no `reconcile` run enqueues it.
`````
**Why:** D8: the upgrade PR is outside the ledger, so nothing would enqueue it after approval.

#### E-7.3-a · Story 7.3 · Nested Linux sandbox cases skip inside a sandboxed session
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D3
**OLD:**
`````text
**Given** the sandbox refusal suite and the proxy suite
**When** they run on Linux for each adapter
**Then** each case passes; on macOS the Linux cases are reported as skipped.
`````
**NEW:**
`````text
**Given** the sandbox refusal suite and the proxy suite
**When** they run on Linux for each adapter
**Then** each case passes; on macOS the Linux cases are reported as skipped
**And** inside a sandboxed session (`XARABOT_SANDBOXED=1`) their nested cases are reported as skipped, and the Maintainer runs them live on the Linux host with Story 7.7's proof.
`````
**Why:** D3: a sandbox cannot be assumed to nest, so the Maintainer runs these cases live.

#### E-7.4-a · Story 7.4 · systemd runs the fixed launcher
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D9
**OLD:**
`````text
**Then** it writes a systemd user unit per lane with a restart throttle, checked against a golden file, that starts one process per unit from the pinned runner path.
`````
**NEW:**
`````text
**Then** it writes a systemd user unit per lane with a restart throttle, checked against a golden file, that starts one process per unit through the fixed launcher `~/.xarabot/bin/xarabot-lane <repo> <lane>`, which runs the version named in the lane's `runner` file, as on macOS (Story 1.19).
`````
**Why:** D9: launchd and systemd run one fixed launcher that switches runner versions only at process exit.

#### E-7.5-a · Story 7.5 · Branch-protection reads report unverified with a warning
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C8
**OLD:**
`````text
**Given** a prerequisite the App's permissions cannot read
**When** the lane starts
**Then** it starts, and the Maintainer's digest lists that prerequisite once as unverified.
`````
**NEW:**
`````text
**Given** a prerequisite the App's permissions cannot read, such as the branch-protection reads, which need `administration: read`, a permission the App never has
**When** the lane starts
**Then** it starts with a warning in its log naming that prerequisite as unverified, and the Maintainer's digest lists that prerequisite once as unverified.
`````
**Why:** C8: the App never gets `administration: read`, so those checks stay unverified and the lane continues with a warning.

#### E-7.6-a · Story 7.6 · Escalations in 0.x
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D10, D5
**OLD:**
`````text
**Given** an optional Escalation source field added to the repo config schema, naming a directory (Xaravel's `tools/escalations/`) and its format
**When** config is loaded
**Then** the field validates, and its absence changes nothing.

**Given** a repo config that names an Escalation source
**When** the coordinator renders the Maintainer's digest
**Then** open Escalations from that source are listed with their links and ages
**And** a unit whose build result is `blocked` with kind Escalation parks with its globs released, per AR8.
`````
**NEW:**
`````text
**Given** an optional Escalation source added to the repo config schema, naming the Escalation directory (Xaravel: `conformance/escalations/`) and the decisions directory (Xaravel: `decisions/`)
**When** config is loaded
**Then** the source validates, and its absence changes nothing.

**Given** a configured Escalation source
**When** the pure Escalation reader runs, with Xaravel's rule from `tools/escalations/escalations.ts`
**Then** it reads Escalation files named `ESC-<story-id>-<n>.md` or `ESC-bot-<n>.md` from the Escalation directory, and for each the decision file `<decisions-dir>/<id>.md` with the same file name, carrying `decision: approved | rejected` and `escalation_sha256`
**And** an Escalation is open when its decision file is missing, invalid, or stale: its `escalation_sha256` is not the lowercase hex SHA-256 of the Escalation file's text with CRLF normalised to LF
**And** the case table has a case for each of these, for a valid decision, and for an Escalation file with CRLF line endings.

**Given** a snapshot of a repo whose config names an Escalation source
**When** it is taken
**Then** it carries each Escalation's id, Story id and status, open or decided, read from the snapshot's one `main` SHA.

**Given** a Story with an open Escalation
**When** `next` runs for a builder, or a lane or `reconcile` is about to enqueue its PR
**Then** the Story is not claimed and its PR is not enqueued: its record becomes `parked`, blocked, with `park.reason: escalation` and its globs released (AR8).
**And** once every Escalation on that Story has a valid decision, approved or rejected, the next `reconcile` releases the record without counting an attempt.

**Given** a repo config that names an Escalation source
**When** the coordinator renders the Maintainer's digest
**Then** open Escalations from that source are listed with their links and ages, each with the Story parked on it
**And** a unit whose build result is `blocked` with `blocked.kind: escalation` parks with its globs released, per AR8.
`````
**Why:** D10 records Xaravel's Escalation rule, the snapshot field and the claim and enqueue hold, replacing the unrecorded "format"; D5 names the `blocked.kind` value.

#### E-7.6-b · Story 7.6 · Standing Authority frontmatter fields
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D5
**OLD:**
`````text
**Then** `docs/adoption/xaravel.md` gives the frontmatter Xaravel's MAINT file must gain, validated by a test against the schema.
`````
**NEW:**
`````text
**Then** `docs/adoption/xaravel.md` gives the frontmatter Xaravel's MAINT file must gain (`schema_version`, `granted_by`, `granted_at`, `repo` and optional `expires`), validated by a test against the schema.
`````
**Why:** D5 names the Standing Authority frontmatter fields.

#### E-7.7-a · Story 7.7 · Upgrade PR without a ledger record, and the Maintainer-run live proof
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D8, D3
**OLD:**
`````text
**Given** `xarabot upgrade`
**When** it runs on the consumer repo for a newer local build
**Then** it opens one PR changing the pin and `runner_version` together, parked for the Maintainer's approval.
`````
**NEW:**
`````text
**Given** `xarabot upgrade`
**When** it runs on the consumer repo for a newer local build
**Then** it opens one PR changing the pin and `runner_version` together, with no ledger record, for the Maintainer to approve and queue by hand.

**Given** `docs/maintainer/self-host.md`
**When** the Story is done
**Then** it records this suite's live command (`bun test --live <suite>`) and the expected result of each case above, and the nested Linux sandbox cases of Story 7.3; the Maintainer runs them on the macOS host and on the Linux host, outside the sandbox, with the credentials they need, before Epic 7's retro
**And** inside a sandboxed session the live cases are reported as skipped, never as passed.
`````
**Why:** D8: an upgrade PR has no ledger record, so it is not "parked"; D3: the Maintainer runs each Epic's live proof.

## 5. Implementation handoff

**Scope: moderate.** There is no replan and no scope change, but architecture decisions change, so the spine edits are the Architect's to own. Everything is planning text; no code exists.

| Step | Who | What |
|---|---|---|
| 1 | Maintainer | Approve this proposal, with any changes to the choices in section 3. |
| 2 | Developer agent (this branch, `planning/readiness-fixes`) | Apply the spine (A-1 – A-42) and epics (E-…) edits with `check_edits.py --apply` and commit. |
| 3 | `bmad-spec` (update), at the Maintainer's request | Apply S-1 – S-6 to `SPEC.md` and `releases.md`. AGENTS.md routes `_bmad-output/specs/` changes only through `bmad-spec`. |
| 4 | Maintainer | Review and merge the PR (#13). The epics changes alter the effective graph's Story sets, so they need the Maintainer's approval in any case. |
| 5 | `bmad-sprint-planning` | Re-run the readiness gate, then generate `sprint-status.yaml`. |

**Success criteria.**
- All 154 edits apply with 0 failures, and `epics.md` parses to 7 Epics and 62 Stories (60 + 1.17a + 5.1a).
- No remaining text in the spine or epics contradicts D1–D13: the gate re-run checks B1–B3 and C1–C13 again.
- The readiness gate returns PASS, or CONCERNS that the Maintainer accepts, and `sprint-status.yaml` is generated.

Checklist 6.4 (update `sprint-status.yaml`) is N/A: the file doesn't exist yet, and step 5 creates it.
