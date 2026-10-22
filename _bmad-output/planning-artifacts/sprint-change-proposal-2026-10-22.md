---
title: Sprint Change Proposal, xarabot 0.x re-gate fixes
date: 2026-10-22
status: approved
trigger: _bmad-output/planning-artifacts/implementation-readiness.md (re-gate, reviewed at ff2708a)
mode: hybrid (new decisions one at a time; mechanical edits in batch)
scope: moderate
approved: 2026-10-22 (Maintainer; decisions D14-D19, all ten drafting choices, loopback cap kept)
edits: 110 (spine 27, spec 8, epics 75)
---

# Sprint Change Proposal: xarabot 0.x re-gate fixes

## 1. Issue summary

The readiness re-gate (`bmad-sprint-planning`, 2026-10-21, merged in #15) found that the first correct course fixed B1–B3 and nearly all of C1–C13, but left three new blockers. Each one stops the self-hosted runner from Epic 2 on. Epic 1, built by the bootstrap loop, is unaffected.

- **N1. Epic 2 deadlocks on `depends_on`.** Only Story 2.5's `reconcile` writes `done`, but `next` treats a `depends_on` Story as met only when it is `done`. A manifest saying `2.5 depends_on [2.4]` can never be chosen.
- **N2. The write check refuses every retro unit.** Retro units don't hold the stock `epic-<N>-retro-<date>.md` that `bmad-retrospective` writes and Story 2.9 validates, so Epic 2's retro never lands.
- **N3. The Story spec path isn't pinned.** `bmad-build-auto` derives its own slug, so `spec-<sprint_key>.md` may not exist. The spec cross-check then fails, and the write check refuses the real spec file.

The re-gate also lists two partly fixed items (C10, C11), eight concerns (C1–C8 of the re-gate) and ten minor inconsistencies. Evidence and line references are in the trigger file. Every blocker was re-read against the source, and the `--live` finding was reproduced on Bun 1.4.3.

## 2. Impact analysis

**Epics.** No Epic is added, removed or reordered, and `.xarabot/epics.yaml` is unchanged. Story 1.16 is split, adding **Story 1.16a: Opening the PR**, so `epics.md` now parses to 7 Epics and 63 Stories (`sprint_plan.py` dry run on the edited copy). Story 1.16 is retitled "…from claim to result", which changes its sprint key. No `sprint-status.yaml` exists yet, so nothing is renamed underneath a status.

| Epic | Stories changed | Main reasons |
|---|---|---|
| 1 | 1.1, 1.2, 1.3, 1.4, 1.6, 1.11, 1.13, 1.14, 1.16, new 1.16a, 1.17, 1.19, 1.20 | D14–D19; C1, C4, C7, C8, C10, C11 |
| 2 | 2.3, 2.4, 2.5, 2.7, 2.12 | N2, D14, D15, D19; C1 |
| 3 | 3.1–3.6 | D16, D18; C1 |
| 4 | 4.6, 4.7 | C1; ruling syntax |
| 5 | 5.3 | C1 |
| 6 | 6.5 | C1 |
| 7 | 7.3, 7.6, 7.7 | D18; C1; Escalation decision file |

**Requirements inventory** in `epics.md`: FR4, FR5, FR18, NFR20, and AR4, AR11–AR15, AR17, AR18, AR20, AR21, AR24, AR27, AR28, AR30, AR31, AR34 and AR37 change to match the spine. The test strategy in the Epic List changes for C1. The FR coverage map is unchanged.

**Artifact conflicts.**
- **Spec** (stands in for the PRD). CAP-5 says `done` instead of "merged". The Write authority line lists the Maintainer's bootstrap writes instead of "one exception" (D17). The Assumptions name the `depends_on` rule, the Epic context gate and the credential files. `glossary.md` and `agent-adapters.md` follow. Capabilities, releases and success signals are unchanged, so the MVP is unaffected.
- **Architecture spine.** Affected sections: AD-3, AD-10, AD-11, AD-12, AD-13, AD-14, AD-16, AD-17, AD-19, AD-20, AD-21, AD-27, AD-29, AD-30, AD-33, the Consistency Conventions and the Structural Seed.
- **UX.** None exists, so N/A.

**Technical impact.** None yet, since no code exists. `docs/maintainer/self-host.md` is an output of Story 1.20 and the verification Stories, so it changes through them.

## 3. Recommended approach

**Direct adjustment.** Edit the existing spine sections, Stories and spec lines; add one Story by splitting.

- **Effort:** low to medium. All 110 edits are drafted below.
- **Risk:** low. Nothing is built yet. Each OLD occurs exactly once and no two overlap (`check_edits.py`: 110 edits, 0 failures). Applied to a scratch copy, every edit lands, the epics parse, and a grep finds no stale wording (`--live`, `spec-<sprint_key>`, "counts as an attempt" for conflicts, "one exception", "all its Stories merged", the zod assumption).
- **Timeline:** implementation starts after this lands and the re-run gate passes.
- **Rejected:** rollback, since there is nothing to roll back; an MVP review, since 0.x scope and success signals stand.

### Maintainer decisions (2026-10-22)

| # | Decision |
|---|---|
| D14 | **N1.** A Story listed in `depends_on` is met when it is `done` in `sprint-status.yaml` on `main` **or** has a `merged` ledger record; either way it is on `main`. |
| D15 | **N3.** `story_spec_path` is a glob, default `_bmad-output/implementation-artifacts/spec-<epic>-<story>-*.md`. Exactly one match is the Story's spec file; zero or several make the result invalid. The prompt names the Story by id and `sprint_key`, so build-auto's slug leads with the id. |
| D16 | **C2.** Separate caps. Any later agent change re-runs the review. A review-driven fix session counts as a loopback (max 2). A CI-fix session, or an agent session resolving a merge conflict, counts as a CI fix (max 2), never as a loopback. Past either cap the unit parks (`review-cap`, `ci-fix-cap`). |
| D17 | **C6.** SPEC lists the Maintainer's bootstrap writes, each in a Maintainer PR, instead of "one exception": `sprint-status.yaml` with Epic 1 `done` at the switch; Epic 2's manifests and Epic context at the switch; a rejected retro's go until Story 4.6. |
| D18 | **C3.** Vendor credentials live in one mode-600 file per vendor under `$XDG_CONFIG_HOME/xarabot/vendors/<vendor>/`, next to the App key. The lane process seeds each session from it. A missing credential for the lane's agent or a reviewer it may launch means the lane refuses to start. |
| D19 | **C5.** Gate plus Maintainer step. An Epic's Stories are eligible only once its Epic context file on `main` is valid; `bootstrapped_epics` are exempt. A status unit compiles it with the stock `compile-epic-context.md`. The Maintainer compiles Epic 2's at the switch. |

The re-gate's N2, C1, C4, C7, C8, C10, C11 and Minor items needed no new decision; their edits follow the findings directly.

### Choices made while drafting, for review

These follow from the decisions but weren't asked about one by one. The edits that carry them are tagged `[NEW CHOICE]`.

1. **Status unit findings (N2; A-8, A-21, E-INV-22, E-2.7-2).** The status unit returns `bmad-sprint-planning`'s readiness findings in its `planning` result (`outcome: blocked`, findings in `summary`) and never saves a findings file, so it holds no extra path.
2. **`retro-gates.yaml` shape (C4; A-7, E-INV-9, E-1.4-1).** `schema_version: 1` and an `epics` map. Each entry has a `retro` record (`verdict`, `unit`, `recorded_at`, plus a `go` for `rejected`), `items[]` with a `status`, and a `checkpoint` record. Every `go` is {`by`, `at`, `ruling`}, where `ruling` is the ruling comment's id, or `maintainer-pr` for a hand-written go before Story 4.6.
3. **Checkpoint "awaiting" (A-7, A-26, E-1.4-2, E-INV-27).** `retro-gates.yaml` records only a checkpoint's go, written by `reconcile`. "Awaiting" means the graph marks the Epic and no go is recorded. AD-11's validation of an "awaiting" entry the graph doesn't mark is dropped: no AD named a writer for such an entry, and a go record legitimately outlives a retired checkpoint.
4. **Conflict sessions are not attempts (D16; A-16, E-INV-17, E-1.17-1).** A conflict-resolving session used to count as an attempt. It now counts only as a CI fix.
5. **Credential names and reach (D18; A-14, A-18, E-3.3-1).** `<vendor>` is the adapter name (`claude`, `codex`, `pi`), as for the vendor home. The lane-start refusal covers a reviewer adapter's credential too.
6. **Epic context inputs (D19; A-11, A-27, E-INV-21, E-2.7-1).** "The planning artifacts directory" is the folder of `epics_path`. The `Snapshot` carries each Epic's context validity, so pure `next` applies the gate. A status unit is due when an Epic's Stories wait only on a missing or invalid context file.
7. **`runner_version` during Epic 2 (D14; E-1.20-2, E-2.4-2).** After a Story whose code the lanes need has merged, the Maintainer tags that `main` commit and advances `runner_version` in a Maintainer PR. The coordinator lane is installed only once `runner_version` includes Stories 2.4 and 2.5. The tag is a git tag, not an npm release, because Story 1.19 installs from a tag until releases exist.
8. **Story 1.16 / 1.16a split (C8; E-1.16-1..3, E-1.16a-1).** 1.16 ends at a validated result ("claim to result") and hands a `done` result to 1.16a. 1.16a adds a "stop before the push" AC for a revoked Standing Authority, from AR21's re-check before every push.
9. **Spec-path test location (D15; E-1.2-2).** The `story_spec_path` expansion test (1.7, 1.17a) sits in Story 1.2.
10. **AD-33 (A-23).** The spine's prerequisite check also covers the merge-queue permission, matching Story 7.5 and AD-26's table.

### Left as is, on purpose

- **The loopback cap's meaning.** SPEC CAP-8 says "After 2 loopbacks, the unit does not merge", and Story 3.5 parks at `loopbacks` ≥ 2 "whatever the review's verdict". So a unit whose second loopback fixes everything still parks. The CI-fix cap parks only when CI still fails after 2 fixes. D16 separates the counters but not this difference. The Maintainer kept it as written (2026-10-22): 2 loopbacks is a hard budget.
- **Stale Epic context.** Stock build-auto also treats a context file older than a planning file as stale and may recompile it in-session. The runner reverts that change (AD-13), so it costs session time only.
- **`story_spec_path` in AD-20's config list.** It wasn't listed before and still isn't. Story 1.2's config schema carries it.

## 4. Detailed change proposals

Each edit replaces OLD with NEW, and each OLD occurs exactly once in its file. They were checked together with `check_edits.py`: 110 edits, 0 failures, and no two edits overlap. Applying them is mechanical and all-or-nothing per file. Within each artifact, edits are in file order.

### 4a. Architecture spine (27 edits)

#### A-1 · AD-3 · The Maintainer's bootstrap writes, listed
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D17, D19, C6
**OLD:**
`````text
- **Rule:** the only writers are the ones listed below. Any other write is a defect.
`````
**NEW:**
`````text
- **Rule:** the only writers are the ones listed below. Any other write is a defect.
  - **The Maintainer's bootstrap writes.** In Xarabot's own repo, the Maintainer also makes these writes, each in a Maintainer PR:
    1. at the self-host switch, running `bmad-sprint-planning`, which creates or updates `sprint-status.yaml` so that Epic 1's Stories are `done`;
    2. at the switch, Epic 2's Story manifests and Epic 2's Epic context file (AD-13);
    3. until the rulings Story (4.6) merges, a rejected retro's go in `retro-gates.yaml` (AD-12).
`````
**Why:** D17 lists the bootstrap writes explicitly instead of "the one exception"; item 2 includes Epic 2's context per D19.

#### A-2 · AD-3 · Epic 1 `done` row: creates or updates; bootstrap write 1
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D17, C7
**OLD:**
`````text
| Epic 1's Stories `done`, at Xarabot's self-host switch | `sprint-status.yaml` on `main` | the Maintainer, once, by running `bmad-sprint-planning`; the Maintainer also runs Epic 1's retro interactively. This one-time write is an exception to the coordinator rule above (AD-11, `bootstrapped_epics`). |
`````
**NEW:**
`````text
| Epic 1's Stories `done`, at Xarabot's self-host switch | `sprint-status.yaml` on `main` | the Maintainer, once, in a Maintainer PR, by running `bmad-sprint-planning`, which creates or updates the file so that Epic 1's Stories are `done`; the Maintainer also runs Epic 1's retro interactively. This is bootstrap write 1 above, an exception to the coordinator rule (AD-11, `bootstrapped_epics`). |
`````
**Why:** C7 makes the switch-time run work whether or not `sprint-status.yaml` already exists; D17 names it as one of the listed bootstrap writes.

#### A-3 · AD-3 · Rejected-retro hand go is bootstrap write 3
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D17, C4
**OLD:**
`````text
In Xarabot's own repo, until the rulings Story (4.6) merges, the Maintainer records a rejected retro's go by hand in a Maintainer PR. |
`````
**NEW:**
`````text
In Xarabot's own repo, until the rulings Story (4.6) merges, the Maintainer records a rejected retro's go by hand in a Maintainer PR, with `ruling: maintainer-pr` (bootstrap write 3 above, AD-12). |
`````
**Why:** D17 lists this write; C4 gives the hand-written go its format.

#### A-4 · AD-3 · Epic 2's manifests by the Maintainer; new Epic context row
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D17, D19
**OLD:**
`````text
| Story manifests and `epics.md` | `main` | coordinator (graph planning units, AD-13); a change to the effective Epic graph is Maintainer-gated (AD-11) |
`````
**NEW:**
`````text
| Story manifests and `epics.md` | `main` | coordinator (graph planning units, AD-13); a change to the effective Epic graph is Maintainer-gated (AD-11). In Xarabot's own repo, the Maintainer writes Epic 2's Story manifests once, at the self-host switch (bootstrap write 2 above). |
| Epic context file | `epic_context_path` on `main` | coordinator (a status planning unit, AD-13). In Xarabot's own repo, the Maintainer compiles Epic 2's once, at the self-host switch (bootstrap write 2 above). |
`````
**Why:** D17 makes Epic 2's manifests a listed Maintainer write; D19 adds an AD-3 row for Epic context.

#### A-5 · AD-10 · `depends_on` is satisfied by `done` or a `merged` record
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D14 (N1)
**OLD:**
`````text
    - `depends_on` is a list of Story ids. A Story is eligible only when each listed Story is `done` in `sprint-status.yaml` on `main` (AD-13).
`````
**NEW:**
`````text
    - `depends_on` is a list of Story ids. A Story is eligible only when each listed Story is `done` in `sprint-status.yaml` on `main` or has a `merged` ledger record (AD-13). Either way the listed Story is on `main`.
`````
**Why:** D14 removes the Epic 2 deadlock before `reconcile` exists.

#### A-6 · AD-10 · `story_spec_path` is a glob with exactly one match
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D15 (N3)
**OLD:**
`````text
    - The spec file's path comes from repo config (`story_spec_path`, by default BMAD's `implementation_artifacts/spec-<sprint_key>.md`).
`````
**NEW:**
`````text
    - Its path comes from repo config: `story_spec_path` is a glob pattern, by default `_bmad-output/implementation-artifacts/spec-<epic>-<story>-*.md` (Story 1.7: `spec-1-7-*.md`; Story 1.17a: `spec-1-17a-*.md`). The Story's spec file is its single match. Zero or several matches make the build result invalid (AD-14).
`````
**Why:** D15 pins the spec path to the slug `bmad-build-auto` actually writes.

#### A-26 · AD-11 · Drop the "awaiting a checkpoint go" validation
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** C4
**OLD:**
`````text
    - a manifest whose `depends_on` names a Story outside its own Epic and the Epics that Epic depends on, directly or through others (AD-10);
    - `retro-gates.yaml` marking an Epic as awaiting a checkpoint go that the graph doesn't mark.
`````
**NEW:**
`````text
    - a manifest whose `depends_on` names a Story outside its own Epic and the Epics that Epic depends on, directly or through others (AD-10).
`````
**Why:** `[NEW CHOICE]` With the A-7 schema, `retro-gates.yaml` records only a checkpoint's go, and "awaiting" means the graph marks the Epic with no go recorded. No writer for an "awaiting" entry exists, and a go record legitimately outlives a retired checkpoint (AD-11), so this check has nothing to test.

#### A-7 · AD-12 · `retro-gates.yaml` schema
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** C4
**OLD:**
`````text
    - The tag stands unless the Maintainer rules `block` or `unblock` (AD-28).
`````
**NEW:**
`````text
    - The tag stands unless the Maintainer rules `block` or `unblock` (AD-28).
  - **The `retro-gates.yaml` schema** (AD-27): `schema_version: 1`, and `epics`, a map from Epic number to entry. Keys follow the `.xarabot/epics.yaml` rule (AD-11). An entry may have:
    - `retro`: `verdict` (`accepted` | `accepted-with-open-items` | `rejected`), `unit` (`retro:<N>`) and `recorded_at`, written once by `reconcile`. A `rejected` verdict also gets a `go`, absent until the Maintainer's go is recorded.
    - `items[]`: `id` (`epic-<N>-retro-item-<seq>-<slug>`), `text`, `route` (`lane` | `maintainer`), `blocking`, `globs` (`[]` for none) and `status` (`open` | `in-progress` | `waiting` | `deferred` | `done`).
    - `checkpoint`: written by `reconcile` when the Maintainer's go for a checkpoint Epic is recorded (AD-28). It holds that `go`, and it stays when the checkpoint is retired (AD-11). A checkpoint Epic with no `checkpoint` entry is awaiting its go.
    - Every `go` is {`by`, `at`, `ruling`}: the Maintainer's login, an ISO 8601 time, and the id of the ruling comment (AD-28), or `maintainer-pr` for a go the Maintainer writes by hand before the rulings Story (4.6) merges (AD-3).
`````
**Why:** C4: Story 1.4 needs field names for the verdict, items, the checkpoint go and a rejected retro's go; shape from the brief, `ruling` as the ruling comment's id `[NEW CHOICE]`.

#### A-8 · AD-13 · The status unit writes no readiness findings file
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** N2
**OLD:**
`````text
      - A *status* planning unit runs `bmad-sprint-planning` and compiles Epic context. It holds `sprint-status.yaml`, `retro-gates.yaml` and the configured Epic context path (`epic-<N>-context.md`). It is not approval-gated.
`````
**NEW:**
`````text
      - A *status* planning unit runs `bmad-sprint-planning` and compiles Epic context. It holds `sprint-status.yaml`, `retro-gates.yaml` and the configured Epic context path (`epic-<N>-context.md`). It is not approval-gated. It returns readiness findings in its result and never saves a findings file (AD-29), so it holds no findings path.
`````
**Why:** N2: a headless readiness FAIL would otherwise write a file outside the unit's paths `[NEW CHOICE]` (from the brief).

#### A-9 · AD-13 · Retro units hold the retro document path
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** N2
**OLD:**
`````text
    - Retro and checkpoint units hold `sprint-status.yaml`, `retro-gates.yaml` and the Epic context path, never the graph inputs.
`````
**NEW:**
`````text
    - Retro and checkpoint units hold `sprint-status.yaml`, `retro-gates.yaml` and the Epic context path, never the graph inputs. A retro unit also holds the retro document path (`retro_doc_glob`, AD-20), so the stock `epic-<N>-retro-<date>.md` can land.
`````
**Why:** N2: without this the write check refuses every retro diff, and Epic 3 never starts.

#### A-10 · AD-13 · Builder eligibility: `depends_on` and the Epic context gate
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D14 (N1), D19 (C5)
**OLD:**
`````text
    - A Story is eligible only if it is not `done` in `sprint-status.yaml` on `main`, and each Story in its manifest's `depends_on` is `done` there (AD-10).
`````
**NEW:**
`````text
    - A Story is eligible only if it is not `done` in `sprint-status.yaml` on `main`, each Story in its manifest's `depends_on` is `done` there or has a `merged` ledger record (AD-10), and its Epic's context file is valid on `main` (Epic context, below).
`````
**Why:** D14 widens `depends_on` satisfaction; D19 adds the context gate to eligibility.

#### A-11 · AD-13 · Epic context: the gate, how it is compiled, the Maintainer's step
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D19 (C5)
**OLD:**
`````text
  - **Epic context.** The coordinator compiles each Epic's BMAD context file (`epic-<N>-context.md`) in a status planning unit, before the Epic's Stories become eligible. The runner reverts any change a builder session makes to it before squashing.
`````
**NEW:**
`````text
  - **Epic context.** An Epic's Stories are eligible only once its BMAD context file (`epic_context_path`, AD-20) exists on `main` and is valid: non-empty and starting with `# Epic <N> Context:`, the stock check in `bmad-build-auto` step-01. Epics in `bootstrapped_epics` are exempt. When only this holds a builder, `next` returns `idle` with a reason naming the Epic that waits for its context.
    - A status planning unit compiles the file by following the installed stock `bmad-build-auto` skill's `compile-epic-context.md`, given the Epic number, the epics path, the planning artifacts directory (the folder of `epics_path`) and the output path (AD-29).
    - In Xarabot's own repo, the Maintainer compiles Epic 2's context at the self-host switch (AD-3).
    - The runner reverts any change a builder session makes to it before squashing.
`````
**Why:** D19 makes context a gate with a stock compile step and a Maintainer step for Epic 2.

#### A-12 · AD-14 · Cross-check the single spec match; zero or several is invalid
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D15 (N3)
**OLD:**
`````text
For builds it also cross-checks the Story spec's `status` and `## Auto Run Result`.
  - **A result still missing, or invalid,** counts as a failed attempt.
`````
**NEW:**
`````text
For builds it also cross-checks the `status` and `## Auto Run Result` of the Story's spec file, the single `story_spec_path` match (AD-10).
  - **A result still missing, or invalid,** counts as a failed attempt. A build result is invalid when `story_spec_path` has zero or several matches.
`````
**Why:** D15: the cross-check reads the one glob match, and a missing or ambiguous match is an invalid result.

#### A-13 · AD-16 · Separate loopback and CI-fix caps
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D16 (C2)
**OLD:**
`````text
  - **Any later change by an agent re-runs the review.** That covers CI fixes and conflict resolution, and each re-run counts as a loopback, at most 2. Past the cap, the unit parks blocked.
`````
**NEW:**
`````text
  - **Any later change by an agent re-runs the review.** That covers loopbacks, CI fixes and conflict resolution. The two caps are separate:
    - a review-driven fix session counts as a loopback (`loopbacks`, at most 2);
    - a CI-fix session, or an agent session that resolves a merge conflict, counts as a CI fix (`ci_fixes`, at most 2, AD-19) and never as a loopback.
    - Past either cap, the unit parks blocked (`review-cap` or `ci-fix-cap`, AD-7).
`````
**Why:** D16: a CI fix no longer uses up the loopback cap, so `ci-fix-cap` can fire.

#### A-14 · AD-17 · Where vendor credentials come from
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D18 (C3)
**OLD:**
`````text
    - `[ASSUMPTION: pi's directory override is confirmed in the pi adapter Story]`
`````
**NEW:**
`````text
    - `[ASSUMPTION: pi's directory override is confirmed in the pi adapter Story]`
  - **Where credentials come from.** Each vendor's credential is in one mode-600 file under `$XDG_CONFIG_HOME/xarabot/vendors/<vendor>/` (falling back to `~/.config`), next to the App key (AD-26), where `<vendor>` is the adapter name (`claude`, `codex` or `pi`), as for the vendor home. The operator writes it once.
    - Each adapter Story confirms the exact form: for `claude`, the token from `claude setup-token`, passed as `CLAUDE_CODE_OAUTH_TOKEN`; for `codex`, its auth file or API key; for pi, the OpenRouter key.
    - The lane process reads the file and seeds the vendor home, or sets the credential variable, before each session, builder or reviewer. The sandbox can't read it (below).
    - If the credential for the lane's agent, or for a reviewer adapter the lane may launch, is missing or unreadable, the lane refuses to start (AD-21).
`````
**Why:** D18 records the credential source, who writes it, how a session gets it and the fail-closed rule.

#### A-15 · AD-19 · CI-fix cap parks; never a loopback
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D16 (C2)
**OLD:**
`````text
  - **A CI fix.** An unexpected failure starts a CI-fix builder session, at most **2** per unit. Each fix is journaled as `ci_fixes`, then reviewed again (AD-16).
`````
**NEW:**
`````text
  - **A CI fix.** An unexpected failure starts a CI-fix builder session, at most **2** per unit. Each fix is journaled as `ci_fixes`, then reviewed again (AD-16). It never counts as a loopback. Past the cap, the unit parks blocked (`ci-fix-cap`).
`````
**Why:** D16: CI fixes have their own cap and park reason.

#### A-16 · AD-19 · A conflict-resolving session counts as a CI fix
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D16 (C2)
**OLD:**
`````text
    - Hand any other conflict to a builder session, which counts as an attempt.
`````
**NEW:**
`````text
    - Hand any other conflict to a builder session, which counts as a CI fix (`ci_fixes`, AD-16), not as a loopback.
`````
**Why:** D16 counts an agent session resolving a merge conflict as a CI fix; the old text counted it as an attempt.

#### A-17 · AD-20 · Escalation decision file has its Escalation's file name
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** Minor
**OLD:**
`````text
    - Decision files are `<decisions-dir>/<id>.md`, with the same file name as the Escalation (Xaravel: `decisions/`), carrying `decision: approved | rejected` and `escalation_sha256`, the lowercase hex SHA-256 of the Escalation file's text with CRLF normalised to LF.
`````
**NEW:**
`````text
    - Decision files are in a configured directory (Xaravel: `decisions/`), each with the same file name as its Escalation file (for example `decisions/ESC-9.3-1.md`), carrying `decision: approved | rejected` and `escalation_sha256`, the lowercase hex SHA-256 of the Escalation file's text with CRLF normalised to LF.
`````
**Why:** Aligns the spine with AR21 and Story 7.6 on one decision file name.

#### A-18 · AD-21 · A missing vendor credential refuses lane start
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D18 (C3)
**OLD:**
`````text
    - the App installation doesn't cover the repo;
`````
**NEW:**
`````text
    - the App installation doesn't cover the repo;
    - the credential for its agent, or for a reviewer adapter it may launch, is missing or unreadable (AD-17);
`````
**Why:** D18's fail-closed rule, in the lane-start refusal list where the reviewer check already is.

#### A-19 · AD-27 · Drop the settled zod assumption
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** Minor
**OLD:**
`````text
  - **Schemas.** Every runtime-validated shape has one schema in `src/core/schemas/`, and its TS type is inferred from it. That covers config, policy, the Standing Authority, manifests, ledger records, results, `retro-gates.yaml`, rulings, prefetched GitHub data, the journal, status and the `Snapshot`. `[ASSUMPTION: zod 4]`
`````
**NEW:**
`````text
  - **Schemas.** Every runtime-validated shape has one schema in `src/core/schemas/`, and its TS type is inferred from it. That covers config, policy, the Standing Authority, manifests, ledger records, results, `retro-gates.yaml`, rulings, prefetched GitHub data, the journal, status and the `Snapshot`.
`````
**Why:** The Stack table already pins zod 4.6.7.

#### A-27 · AD-27 · The `Snapshot` carries Epic context validity
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D19
**OLD:**
`````text
    - the Escalation statuses, when config names an Escalation source (AD-20)
`````
**NEW:**
`````text
    - the Escalation statuses, when config names an Escalation source (AD-20)
    - for each Epic, whether its Epic context file on `main` is valid (AD-13)
`````
**Why:** D19: pure `next` applies the Epic context gate, so the snapshot must carry it; matches AR28 (E-INV-21).

#### A-20 · AD-29 · Prompt names the Story by id and `sprint_key`
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D15 (N3)
**OLD:**
`````text
  - **Contents.** The prompt names the unit ("Build Story 9.3"). A test asserts it contains no selection, CI, merge or status instruction.
`````
**NEW:**
`````text
  - **Contents.** The prompt names the unit. A `story` prompt names the Story by its id and `sprint_key` ("Build Story 1.7 (`1-7-forge-port-fake-forge-and-contract-suite`)"), so the slug `bmad-build-auto` gives its spec file leads with the id and matches `story_spec_path` (AD-10). A test asserts the prompt contains no selection, CI, merge or status instruction.
`````
**Why:** D15: the prompt steers build-auto's slug so the spec glob finds one file.

#### A-21 · AD-29 · Status unit row: findings in the result; Epic context compile
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** N2, D19 (C5)
**OLD:**
`````text
| `planning` (status) | `bmad-sprint-planning`, told to run headless; Epic context |
`````
**NEW:**
`````text
| `planning` (status) | `bmad-sprint-planning`, told to run headless and to return readiness findings in the `planning` result (`outcome: blocked`, findings in `summary`), never saving a findings file; Epic context, by following the installed stock `bmad-build-auto` skill's `compile-epic-context.md` with the Epic number, the epics path, the planning artifacts directory and the output path (AD-13) |
`````
**Why:** N2's status-unit choice `[NEW CHOICE]` (from the brief) and D19's compile step.

#### A-22 · AD-30 · The spec-file exception is the single glob match
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D15 (N3)
**OLD:**
`````text
      - the unit's own BMAD Story spec file;
`````
**NEW:**
`````text
      - the unit's own BMAD Story spec file, the single `story_spec_path` match (AD-10);
`````
**Why:** D15: the write check allows exactly the one matched spec file.

#### A-23 · AD-33 · Prerequisite check includes the merge-queue permission
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** Minor
**OLD:**
`````text
    - the App installed with `issues: write`.
`````
**NEW:**
`````text
    - the App installed with `issues: write` and the merge-queue permission (AD-26).
`````
**Why:** Aligns AD-33 with Story 7.5; AD-26's table already lists the merge-queue permission for `enqueue` and `dequeue`.

#### A-24 · Conventions · Live switch is `XARABOT_LIVE=1`
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** C1
**OLD:**
`````text
Live cases (`bun test --live <suite>`) are run by the Maintainer on the host, outside the sandbox, with the credentials they need, before the Epic's retro; inside a sandboxed session they report skipped, and so do nested sandbox cases (`XARABOT_SANDBOXED=1`, AD-17). |
`````
**NEW:**
`````text
Live cases run only when `XARABOT_LIVE=1` is set (`XARABOT_LIVE=1 bun test <suite>`) and otherwise report skipped. The Maintainer runs them on the host, outside the sandbox, with the credentials they need, before the Epic's retro. Inside a sandboxed session they report skipped, and so do nested sandbox cases (`XARABOT_SANDBOXED=1`, AD-17). |
`````
**Why:** C1: Bun 1.4.3 swallows `--live`, so a test can only see an environment variable.

#### A-25 · Structural Seed · Vendor credential files
**File:** `_bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md`
**Decision:** D18 (C3)
**OLD:**
`````text
  apps/<login>-xarabot/private-key.pem  app.json
`````
**NEW:**
`````text
  apps/<login>-xarabot/private-key.pem  app.json
  vendors/<vendor>/                   # one mode-600 credential file per vendor (AD-17)
`````
**Why:** D18 puts vendor credentials next to the App key in the host layout.

### 4b. Spec and companions (8 edits)

#### S-1 · CAP-5: an Epic starts when its dependencies' Stories are `done`
**File:** `_bmad-output/specs/spec-xarabot/SPEC.md`
**Decision:** D17 (Minor CAP-5)
**OLD:**
`````text
an Epic starts once every Epic it depends on has all its Stories merged and its retro done.
`````
**NEW:**
`````text
an Epic starts once every Epic it depends on has all its Stories `done` in sprint status and its retro done.
`````
**Why:** D17 / D1: `done` in `sprint-status.yaml`, not "merged".

#### S-2 · Write authority lists the Maintainer's bootstrap writes
**File:** `_bmad-output/specs/spec-xarabot/SPEC.md`
**Decision:** D17 (C6); C7; D19
**OLD:**
`````text
- **Write authority:** the coordinator lane is the only writer of `sprint-status.yaml` and `retro-gates.yaml`; the 0.x write check (CAP-18) enforces it on builder diffs. The one exception is the Maintainer's one-time write at Xarabot's self-host switch, which creates `sprint-status.yaml` with the bootstrapped Epic's Stories done.
`````
**NEW:**
`````text
- **Write authority:** the coordinator lane is the only writer of `sprint-status.yaml` and `retro-gates.yaml`; the 0.x write check (CAP-18) enforces it on builder diffs. Besides the coordinator, the Maintainer makes these bootstrap writes, all in Xarabot's own repo and each in a Maintainer PR:
  - at the self-host switch, running `bmad-sprint-planning` so that `sprint-status.yaml` has the bootstrapped Epic's Stories `done`, creating the file or updating it;
  - at the switch, Epic 2's Story manifests and Epic 2's Epic context file;
  - until the rulings Story merges, the go for a rejected retro, in `retro-gates.yaml`.
`````
**Why:** D17 replaces "the one exception" with the explicit list; C7 "creates or updates"; D19 adds Epic 2's context.

#### S-3 · Assumptions: when `depends_on` is met
**File:** `_bmad-output/specs/spec-xarabot/SPEC.md`
**Decision:** D14 (N1)
**OLD:**
`````text
  - the Story manifest and its `depends_on` (AD-10);
`````
**NEW:**
`````text
  - the Story manifest and its `depends_on`, met when each listed Story is `done` on `main` or has a `merged` ledger record (AD-10);
`````
**Why:** D14, so the spec's pointer to AD-10 carries the new rule.

#### S-4 · Assumptions: the Epic context gate
**File:** `_bmad-output/specs/spec-xarabot/SPEC.md`
**Decision:** D19 (C5)
**OLD:**
`````text
  - status and graph planning units, and the coordinator's order (AD-13);
`````
**NEW:**
`````text
  - status and graph planning units, the Epic context file an Epic's Stories wait for, and the coordinator's order (AD-13);
`````
**Why:** D19 adds a gate decided in AD-13.

#### S-5 · Assumptions: vendor credential files
**File:** `_bmad-output/specs/spec-xarabot/SPEC.md`
**Decision:** D18 (C3)
**OLD:**
`````text
  - one sandbox for every adapter (AD-17);
`````
**NEW:**
`````text
  - one sandbox for every adapter, and the vendor credential files it seeds sessions from (AD-17);
`````
**Why:** D18 is decided in AD-17.

#### S-7 · agent-adapters: pi's key is stored, not signed in per lane
**File:** `_bmad-output/specs/spec-xarabot/agent-adapters.md`
**Decision:** D18 (C3)
**OLD:**
`````text
| `pi` | `pi -p --mode json --model <provider/id> --thinking <effort>`. The operator signs in to OpenRouter through pi. | none: the lane must set `model`, or it refuses to start | 0.x |
`````
**NEW:**
`````text
| `pi` | `pi -p --mode json --model <provider/id> --thinking <effort>`. The operator stores an OpenRouter key once (Credentials, below). | none: the lane must set `model`, or it refuses to start | 0.x |
`````
**Why:** D18: pi's credential is the OpenRouter key in the operator's credential file.

#### S-8 · agent-adapters: where credentials come from
**File:** `_bmad-output/specs/spec-xarabot/agent-adapters.md`
**Decision:** D18 (C3)
**OLD:**
`````text
- **Unattended:** which adapters may run unattended is repo policy (CAP-7).
`````
**NEW:**
`````text
- **Credentials:** the operator writes each vendor's credential once, in one mode-600 file per vendor under `$XDG_CONFIG_HOME/xarabot/vendors/<vendor>/` (falling back to `~/.config`), next to the App key. Before each session the lane process reads it and seeds the lane's vendor home, or the credential variable: for `claude`, the token from `claude setup-token`, passed as `CLAUDE_CODE_OAUTH_TOKEN`; for `codex`, its auth file or API key; for `pi`, the OpenRouter key. Each adapter Story confirms the exact form. A lane whose adapter or reviewer has a missing or unreadable credential refuses to start (spine AD-17).
- **Unattended:** which adapters may run unattended is repo policy (CAP-7).
`````
**Why:** D18 recorded in the adapters companion, where each adapter's setup is described.

#### S-6 · Glossary: the coordinator is the only lane that writes the status files
**File:** `_bmad-output/specs/spec-xarabot/glossary.md`
**Decision:** D17 (C6)
**OLD:**
`````text
- **Coordinator lane (lane 0):** the only lane that runs retros, retro action items and planning, and the only writer of `sprint-status.yaml` and `retro-gates.yaml`.
`````
**NEW:**
`````text
- **Coordinator lane (lane 0):** the only lane that runs retros, retro action items and planning, and the only writer of `sprint-status.yaml` and `retro-gates.yaml`, apart from the Maintainer's bootstrap writes (SPEC § Operating limits).
`````
**Why:** D17: the glossary otherwise contradicts the listed Maintainer writes.

### 4c. Epics and Stories (75 edits)

#### E-INV-1 · FR4 says full clone, not worktree
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** Minor (FR4 wording)
**OLD:**
`````text
Each builder has its own worktree, state folder and scheduled job (launchd or systemd).
`````
**NEW:**
`````text
Each builder has its own full clone (never a linked worktree), state folder and scheduled job (launchd or systemd).
`````
**Why:** Matches SPEC:44.

#### E-INV-2 · FR5 says `done`, not merged
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D17
**OLD:**
`````text
An Epic starts once every Epic it depends on has all its Stories merged and its retro done.
`````
**NEW:**
`````text
An Epic starts once every Epic it depends on has all its Stories `done` and its retro done.
`````
**Why:** D17: CAP-5 and FR5 say `done` instead of "all its Stories merged".

#### E-INV-3 · FR18 sandbox says clone, not worktree
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** Minor (FR18 wording)
**OLD:**
`````text
- Sandbox (0.x): the coding agent runs with only its unit's worktree writable, with no GitHub credentials and no GitHub host.
`````
**NEW:**
`````text
- Sandbox (0.x): the coding agent runs with only its unit's clone writable, with no GitHub credentials and no GitHub host.
`````
**Why:** Matches SPEC:104.

#### E-INV-4 · FR18 write check names the single spec match
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D15
**OLD:**
`````text
There are only three exceptions: an approved Infrastructure Story's Protected Paths, the unit's own BMAD Story spec file, and the `status:` line of its own Story file.
`````
**NEW:**
`````text
There are only three exceptions: an approved Infrastructure Story's Protected Paths, the unit's own BMAD Story spec file (the single file matching `story_spec_path`), and the `status:` line of its own Story file.
`````
**Why:** D15: "its own BMAD Story spec file" means the single match of the glob.

#### E-INV-5 · NFR20 lists the Maintainer's bootstrap writes
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D17, C7, Minor (NFR20)
**OLD:**
`````text
NFR20 (Write authority): the coordinator lane is the only writer of `sprint-status.yaml` and `retro-gates.yaml`; the 0.x write check (FR18) enforces it on builder diffs.
`````
**NEW:**
`````text
NFR20 (Write authority): the coordinator lane is the only writer of `sprint-status.yaml` and `retro-gates.yaml`; the 0.x write check (FR18) enforces it on builder diffs. The only exceptions are the Maintainer's bootstrap writes in Xarabot's own repo, each in a Maintainer PR: at the self-host switch, a `bmad-sprint-planning` run that creates or updates `sprint-status.yaml` so Epic 1's Stories are `done`, plus Epic 2's Story manifests and Epic 2's context file; and, until the rulings Story (4.6) merges, a rejected retro's go in `retro-gates.yaml`.
`````
**Why:** D17 replaces "the one exception" with the explicit list; C7 "creates or updates".

#### E-INV-6 · AR4 rows for manifests, Epic context and the bootstrap writes
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D17, D19, C7
**OLD:**
`````text
- AR4 (AD-3): every piece of state has one home and one writer, per the spine's AD-3 table (sprint status: coordinator, with one exception: the Maintainer's one-time write at the self-host switch that creates `sprint-status.yaml` with Epic 1's Stories `done`; `retro-gates.yaml`: `reconcile` runner code only; ledger records by state; forge objects: the runner; the `status:` line of the unit's own Story file: the agent session; journal, PIDs, outcome: the lane process; `STOP`: the operator). Any other write is a defect.
`````
**NEW:**
`````text
- AR4 (AD-3): every piece of state has one home and one writer, per the spine's AD-3 table (sprint status: coordinator; `retro-gates.yaml`: `reconcile` runner code only; Story manifests and `epics.md`: graph planning units; Epic context at `epic_context_path` on `main`: the coordinator's status planning unit; ledger records by state; forge objects: the runner; the `status:` line of the unit's own Story file: the agent session; journal, PIDs, outcome: the lane process; `STOP`: the operator). The only other writes are the Maintainer's bootstrap writes in Xarabot's own repo, each in a Maintainer PR: at the self-host switch, a `bmad-sprint-planning` run that creates or updates `sprint-status.yaml` so Epic 1's Stories are `done`, Epic 2's Story manifests and Epic 2's context file; and, until the rulings Story (4.6) merges, a rejected retro's go in `retro-gates.yaml`. Any other write is a defect.
`````
**Why:** D17 list of bootstrap writes; D19 AD-3 row for Epic context; C7 either order works.

#### E-INV-7 · AR11 `depends_on` satisfied by `done` or `merged`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D14 (N1)
**OLD:**
`````text
the Story is eligible only once each listed Story is `done` in `sprint-status.yaml`;
`````
**NEW:**
`````text
the Story is eligible only once each listed Story is `done` in `sprint-status.yaml` on `main` or has a `merged` ledger record, either way on `main`;
`````
**Why:** D14.

#### E-INV-8 · AR11 `story_spec_path` is a glob with one match
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D15 (N3)
**OLD:**
`````text
Outside its globs a Story's diff may carry only its own BMAD Story spec file (`story_spec_path`, default `implementation_artifacts/spec-<sprint_key>.md`) and the `status:` line of its own Story file.
`````
**NEW:**
`````text
Outside its globs a Story's diff may carry only its own BMAD Story spec file and the `status:` line of its own Story file. `story_spec_path` is a glob pattern, default `_bmad-output/implementation-artifacts/spec-<epic>-<story>-*.md` (Story 1.7: `spec-1-7-*.md`; Story 1.17a: `spec-1-17a-*.md`); exactly one match is the Story's spec file, and zero or several matches make the result invalid.
`````
**Why:** D15.

#### E-INV-27 · AR12 · Drop the "checkpoint wait" validation from the summary
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C4
**OLD:**
`````text
a manifest `depends_on` naming a Story outside its own Epic and the Epics it depends on, a checkpoint wait the graph doesn't mark) stops every lane with an alert.
`````
**NEW:**
`````text
a manifest `depends_on` naming a Story outside its own Epic and the Epics it depends on) stops every lane with an alert.
`````
**Why:** Follows A-26.

#### E-INV-9 · AR13 gains the `retro-gates.yaml` schema
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C4
**OLD:**
`````text
stores the result in the ledger record, and `reconcile` writes `retro-gates.yaml` once. Graph changes take effect at the next claim.
`````
**NEW:**
`````text
stores the result in the ledger record, and `reconcile` writes `retro-gates.yaml` once. `retro-gates.yaml` has `schema_version: 1` and an `epics` map keyed by Epic number; each Epic has a `retro` record that `reconcile` writes once (`verdict`, `unit` `retro:<N>`, `recorded_at`, and for a `rejected` verdict a `go` {`by`, `at`, `ruling`}, absent until the go; a go the Maintainer writes by hand before Story 4.6 has `ruling: maintainer-pr`), `items` (`id` `epic-<N>-retro-item-<seq>-<slug>`, `text`, `route`, `blocking`, `globs`, `status` `open`/`in-progress`/`waiting`/`deferred`/`done`) and a `checkpoint` record holding the checkpoint's `go` {`by`, `at`, `ruling`}, which `reconcile` writes when the go is recorded and which stays when the checkpoint is retired; a checkpoint Epic with no `checkpoint` record is awaiting its go. Graph changes take effect at the next claim.
`````
**Why:** C4 shape, in step with the spine's new AD-12 bullet. [NEW CHOICE] (shape given in the brief)

#### E-INV-10 · AR14 retro unit holds the retro document path
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** N2
**OLD:**
`````text
retro and checkpoint: status files and Epic context, never graph inputs;
`````
**NEW:**
`````text
retro: status files, Epic context and the retro document path (`retro_doc_glob`, AR21), so the stock `epic-<N>-retro-<date>.md` can land; checkpoint: status files and Epic context; neither touches graph inputs;
`````
**Why:** N2: the write check otherwise refuses every retro unit.

#### E-INV-11 · AR14 `depends_on` satisfied by `done` or `merged`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D14 (N1)
**OLD:**
`````text
and whose manifest `depends_on` Stories are all `done` there, lowest Epic number first, then lowest Story number.
`````
**NEW:**
`````text
and whose manifest `depends_on` Stories are each `done` there or have a `merged` ledger record, lowest Epic number first, then lowest Story number.
`````
**Why:** D14.

#### E-INV-12 · AR14 Epic context gate and how it is compiled
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D19 (C5)
**OLD:**
`````text
The coordinator compiles each Epic's `epic-<N>-context.md` in a planning status unit before its Stories become eligible; the runner reverts builder changes to it.
`````
**NEW:**
`````text
An Epic's Stories are eligible only once its Epic context file (`epic_context_path`) exists on `main` and is valid: non-empty and starting with `# Epic <N> Context:`, the stock check in `bmad-build-auto` step-01; an Epic in `bootstrapped_epics` is exempt. A status planning unit compiles it by following the installed stock `bmad-build-auto` skill's `compile-epic-context.md` with the Epic number, the epics path, the planning artifacts directory and the output path; the Maintainer compiles Epic 2's at the self-host switch (AR4). The runner reverts builder changes to it.
`````
**Why:** D19.

#### E-INV-13 · AR15 cross-check uses the single spec match
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D15 (N3)
**OLD:**
`````text
builds also cross-check the Story spec's `status` and `## Auto Run Result`.
`````
**NEW:**
`````text
builds also cross-check the `status` and `## Auto Run Result` of the Story's spec file, the single match of `story_spec_path` (AR11).
`````
**Why:** D15.

#### E-INV-14 · AR17 separate loopback and CI-fix caps
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D16 (C2)
**OLD:**
`````text
Any later agent change re-runs the review, each re-run a loopback, at most 2.
`````
**NEW:**
`````text
Any later agent change re-runs the review. A review-driven fix session counts as a loopback (`loopbacks`, at most 2); a CI-fix session, or an agent session resolving a merge conflict, counts as a CI fix (`ci_fixes`, at most 2, AR20) and never as a loopback. Past either cap the unit parks blocked (`review-cap` or `ci-fix-cap`).
`````
**Why:** D16; park reasons are the existing AR6 strings.

#### E-INV-15 · AR18 vendor credential source and fail closed
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D18 (C3)
**OLD:**
`````text
A per-lane vendor home under the state folder is re-seeded before every session with only that vendor's credential (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, pi's agent directory; on macOS `claude` gets `CLAUDE_CODE_OAUTH_TOKEN`); the operator's `~/.claude`, `~/.codex`, `~/.pi` are inaccessible.
`````
**NEW:**
`````text
A per-lane vendor home under the state folder is re-seeded before every session with only that vendor's credential (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, pi's agent directory; on macOS `claude` gets `CLAUDE_CODE_OAUTH_TOKEN`); the operator's `~/.claude`, `~/.codex`, `~/.pi` are inaccessible. Vendor credentials live in one mode-600 file per vendor under `$XDG_CONFIG_HOME/xarabot/vendors/<vendor>/` (fallback `~/.config`), next to the App key, written once by the operator; each adapter Story confirms the exact form (`claude`: the token from `claude setup-token`, passed as `CLAUDE_CODE_OAUTH_TOKEN`; `codex`: its auth file or API key, Story 3.1; `pi`: the OpenRouter key, Story 3.2). The lane process reads the file and seeds the vendor home or the credential variable before each session, builder or reviewer. A missing or unreadable credential for the lane's adapter or its reviewer makes the lane refuse to start, and a session whose credential can't be read is refused.
`````
**Why:** D18.

#### E-INV-16 · AR18 env allowlist adds the vendor-home variable
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C11
**OLD:**
`````text
the vendor credential variable, `XARABOT_RESULT`, `XARABOT_SANDBOXED`, the proxy variables and `UV_CACHE_DIR` (in the temp folder); git credential helper reset;
`````
**NEW:**
`````text
the vendor credential variable, the variable that points the CLI at its vendor home, `XARABOT_RESULT`, `XARABOT_SANDBOXED`, the proxy variables and `UV_CACHE_DIR` (in the temp folder); git credential helper reset;
`````
**Why:** Matches spine AD-17 (S:417).

#### E-INV-17 · AR20 conflict sessions count as CI fixes
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D16 (C2)
**OLD:**
`````text
other conflicts go to a builder session, counted as an attempt.
`````
**NEW:**
`````text
other conflicts go to a builder session, counted as a CI fix (`ci_fixes`, sharing the cap of 2 with CI fixes), never as an attempt or a loopback, and re-reviewed (AR17); past the cap the unit parks blocked (`ci-fix-cap`).
`````
**Why:** D16, as the spine's A-16 words it (not an attempt, not a loopback).

#### E-INV-18 · AR21 decision file has the Escalation's file name
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** Minor (Escalation decision file name)
**OLD:**
`````text
and decision files `<decisions-dir>/ESC-<id>.md` carrying
`````
**NEW:**
`````text
and decision files in `<decisions-dir>` with the same file name as their Escalation file (e.g. `decisions/ESC-9.3-1.md`), carrying
`````
**Why:** Aligns AR21 with spine AD-20 and Story 7.6.

#### E-INV-19 · AR24 digest reads open Escalations
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** Minor (AR24)
**OLD:**
`````text
Each `reconcile` run rewrites an owner's issue body from `parked` records, PR states and `retro-gates.yaml` when its content changed,
`````
**NEW:**
`````text
Each `reconcile` run rewrites an owner's issue body from `parked` records, PR states, `retro-gates.yaml` and open Escalations (AR21) when its content changed,
`````
**Why:** Matches spine AD-23 (S:529).

#### E-INV-20 · AR27 vendor credentials sit next to the App key
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D18 (C3)
**OLD:**
`````text
mode 600, with `app.json` recording App ID and slug.
`````
**NEW:**
`````text
mode 600, with `app.json` recording App ID and slug; vendor credentials sit next to it under `vendors/<vendor>/` (AR18).
`````
**Why:** D18 names AD-26 as the credentials' neighbour.

#### E-INV-21 · AR28 Snapshot gains Escalation statuses and Epic context
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** Minor (AR28), D19
**OLD:**
`````text
`sprint-status.yaml` and `retro-gates.yaml`; PR state of every ledger unit; lane identity and role.
`````
**NEW:**
`````text
`sprint-status.yaml` and `retro-gates.yaml`; the Escalation statuses, when config names an Escalation source (AR21); each Epic's context file at `epic_context_path`, for the context gate (AR14); PR state of every ledger unit; lane identity and role.
`````
**Why:** Escalation statuses match S:599; the context-file field lets pure `next` apply the D19 gate. [NEW CHOICE] (context-file field; spine AD-27 needs the same field)

#### E-INV-22 · AR30 prompt: Story id and `sprint_key`, status unit findings, Epic context compile
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D15, N2, D19
**OLD:**
`````text
(`story` first build: `bmad-build-auto`; loopback or CI fix: none, apply prefetched findings or log; `retro`: `bmad-retrospective -H <epic>` then the item fields; `planning`: a status unit runs `bmad-sprint-planning` headless and compiles Epic context, and a graph unit makes the manifest, `epics.md` and `.xarabot/epics.yaml` edits;
`````
**NEW:**
`````text
(`story` first build: `bmad-build-auto`, the prompt naming the Story by its id and `sprint_key`, e.g. "Build Story 1.7 (`1-7-forge-port-fake-forge-and-contract-suite`)", so build-auto's spec slug leads with the id (AR11); loopback or CI fix: none, apply prefetched findings or log; `retro`: `bmad-retrospective -H <epic>` then the item fields; `planning`: a status unit runs `bmad-sprint-planning` headless, returns any readiness findings in its `planning` result (`outcome: blocked`, the findings in `summary`) and never saves a findings file, and compiles Epic context by following the installed stock `bmad-build-auto` skill's `compile-epic-context.md` with the Epic number, the epics path, the planning artifacts directory and the output path (AR14), and a graph unit makes the manifest, `epics.md` and `.xarabot/epics.yaml` edits;
`````
**Why:** D15 prompt wording; D19 compile step; N2 status-unit findings. [NEW CHOICE] (status unit returns findings in `summary`, per the brief's N2 choice)

#### E-INV-23 · AR31 write-check exception names the single spec match
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D15
**OLD:**
`````text
the unit's own BMAD Story spec file; the `status:` line of its own Story file).
`````
**NEW:**
`````text
the unit's own BMAD Story spec file, the single match of `story_spec_path` (AR11); the `status:` line of its own Story file).
`````
**Why:** D15.

#### E-INV-24 · AR34 checks the merge-queue permission
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** Minor (AD-33 vs Story 7.5)
**OLD:**
`````text
most-recent-push approval required; the App installed with `issues: write`.
`````
**NEW:**
`````text
most-recent-push approval required; the App installed with `issues: write` and the merge-queue permission (AR38).
`````
**Why:** Aligns with Story 7.5; AD-26's table lists the merge-queue permission for `enqueue` and `dequeue`.

#### E-INV-25 · AR37 host layout gains `vendors/`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D18
**OLD:**
`````text
`$XDG_CONFIG_HOME/xarabot/` with `host.yaml` and `apps/<login>-xarabot/`)
`````
**NEW:**
`````text
`$XDG_CONFIG_HOME/xarabot/` with `host.yaml`, `apps/<login>-xarabot/` and `vendors/<vendor>/`)
`````
**Why:** D18 adds the folder to the Structural Seed.

#### E-INV-26 · AR37 CLI list gains `graph`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** Minor (AR37)
**OLD:**
`````text
`tui`, `report`, `upgrade`; `test/contracts/`;
`````
**NEW:**
`````text
`tui`, `report`, `upgrade`, `graph`; `test/contracts/`;
`````
**Why:** Matches spine S:787.

#### E-LIST-1 · Story 1.1 sets up the live switch
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C1
**OLD:**
`````text
- Story 1.1 sets up `bun test`, `bun --bun oxlint` and `bun --bun tsc`,
`````
**NEW:**
`````text
- Story 1.1 sets up `bun test` with its live switch (`XARABOT_LIVE=1`), `bun --bun oxlint` and `bun --bun tsc`,
`````
**Why:** C1.

#### E-LIST-2 · Verification Stories use `XARABOT_LIVE=1`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C1
**OLD:**
`````text
The Story writes its live command (`bun test --live <suite>`) and expected result into `docs/maintainer/self-host.md`,
`````
**NEW:**
`````text
The Story writes its live command (`XARABOT_LIVE=1 bun test <suite>`) and expected result into `docs/maintainer/self-host.md`,
`````
**Why:** C1: Bun 1.4.3 never passes `--live` to `Bun.argv`.

#### E-LIST-3 · Live cases skipped without the switch
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C1
**OLD:**
`````text
Inside a sandboxed session, live cases report skipped.
`````
**NEW:**
`````text
Live cases run only when `XARABOT_LIVE=1` is set and otherwise report skipped, as they do inside a sandboxed session.
`````
**Why:** C1.

#### E-1.1-1 · Story 1.1 AC for the live switch
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C1
**OLD:**
`````text
**Given** a file under `src/adapters/agent/`
**When** it references `Bun.spawn`
**Then** the check fails (AR18).
`````
**NEW:**
`````text
**Given** a file under `src/adapters/agent/`
**When** it references `Bun.spawn`
**Then** the check fails (AR18).

**Given** the test harness
**When** `bun test` runs without `XARABOT_LIVE=1` in the environment
**Then** every live case reports skipped, never passed
**And** with `XARABOT_LIVE=1` set, the live cases run, proven by a test (Bun 1.4.3 accepts `bun test --live` silently and never passes it to `Bun.argv`, so the switch is the variable).
`````
**Why:** C1.

#### E-1.2-1 · Story 1.2 config: `story_spec_path` is a glob
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D15
**OLD:**
`````text
the manifest directory and path-key mapping, `story_spec_path`, both branch namespaces,
`````
**NEW:**
`````text
the manifest directory and path-key mapping, `story_spec_path` (a glob pattern, default `_bmad-output/implementation-artifacts/spec-<epic>-<story>-*.md`, AR11), both branch namespaces,
`````
**Why:** D15.

#### E-1.2-2 · Story 1.2 AC expanding `story_spec_path`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D15
**OLD:**
`````text
**Then** loading refuses it; repo policy comes only from `main`.
`````
**NEW:**
`````text
**Then** loading refuses it; repo policy comes only from `main`.

**Given** the default `story_spec_path`
**When** it is expanded for the Stories `1.7` and `1.17a`
**Then** it gives `_bmad-output/implementation-artifacts/spec-1-7-*.md` and `_bmad-output/implementation-artifacts/spec-1-17a-*.md`.
`````
**Why:** D15 examples as a test. [NEW CHOICE] (placing the expansion test in Story 1.2)

#### E-1.3-1 · Story 1.3 fixture includes `1.16a`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C8
**OLD:**
`````text
the lettered `1.17a` and `5.1a` included.
`````
**NEW:**
`````text
the lettered `1.16a`, `1.17a` and `5.1a` included.
`````
**Why:** C8 adds Story 1.16a.

#### E-1.4-1 · Story 1.4 `retro-gates.yaml` schema and the rejected-retro go
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C4
**OLD:**
`````text
**Given** a `retro-gates.yaml` schema for Epic verdicts, action items (stock BMAD ids, `blocking`, `route`, `globs`, status) and checkpoint go records
**When** `retro-gates.yaml` is read
**Then** it validates against that schema.
`````
**NEW:**
`````text
**Given** the `retro-gates.yaml` schema of AR13: `schema_version: 1`; per Epic, a `retro` record (`verdict`, `unit`, `recorded_at`, and for a `rejected` verdict a `go` {`by`, `at`, `ruling`} that is absent until the go), `items` (stock BMAD `id`, `text`, `route`, `blocking`, `globs`, and `status` `open`, `in-progress`, `waiting`, `deferred` or `done`) and a `checkpoint` record holding a checkpoint's `go` {`by`, `at`, `ruling`}, present only once the go is recorded
**When** `retro-gates.yaml` is read
**Then** it validates against that schema
**And** a case-table test reads a rejected retro's go, both from a ruling and as the Maintainer writes it by hand before Story 4.6 (`ruling: maintainer-pr`), since Story 1.6 reads it.
`````
**Why:** C4: Story 1.4 defines the fields and covers the go Story 1.6 reads.

#### E-1.4-2 · Story 1.4 · Drop the "awaiting a checkpoint go" validation case
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C4
**OLD:**
`````text
; `bootstrapped_epics` naming an Epic with no heading; `retro-gates.yaml` marking an Epic as awaiting a checkpoint go that the graph doesn't mark
`````
**NEW:**
`````text
; `bootstrapped_epics` naming an Epic with no heading
`````
**Why:** Follows A-26.

#### E-1.6-1 · Story 1.6 Epic context gate
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D19 (C5)
**OLD:**
`````text
**Then** that Epic counts as all Stories done and retro done, even with no Stories, and its Story headings are not listed as unclaimable.
`````
**NEW:**
`````text
**Then** that Epic counts as all Stories done and retro done, even with no Stories, and its Story headings are not listed as unclaimable.

**Given** an Epic whose context file at `epic_context_path` is missing on `main`, empty, or does not start with `# Epic <N> Context:`
**When** `next` runs
**Then** none of its Stories is returned, and the idle reason names the Epic waiting on its context
**And** an Epic listed in `bootstrapped_epics` is exempt (AR14).
`````
**Why:** D19.

#### E-1.6-2 · Story 1.6 `depends_on` satisfied by `done` or `merged`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D14 (N1)
**OLD:**
`````text
**Given** a Story whose manifest `depends_on` lists a Story not `done` in `sprint-status.yaml` on `main`
**When** `next` runs
**Then** it is not returned, and its reason names the Story it waits on.
`````
**NEW:**
`````text
**Given** a Story whose manifest `depends_on` lists a Story that is neither `done` in `sprint-status.yaml` on `main` nor has a `merged` ledger record
**When** `next` runs
**Then** it is not returned, and its reason names the Story it waits on
**And** a listed Story with a `merged` record satisfies `depends_on` before `reconcile` marks it `done`, since either way it is on `main` (AR11).
`````
**Why:** D14.

#### E-1.11-1 · Story 1.11 env allowlist adds the vendor-home variable
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C11
**OLD:**
`````text
**Then** only `PATH` (rebuilt from allowed directories), `HOME`, `TMPDIR`, `LANG`, `LC_*`, `TERM`, the vendor credential variable, `XARABOT_RESULT`,
`````
**NEW:**
`````text
**Then** only `PATH` (rebuilt from allowed directories), `HOME`, `TMPDIR`, `LANG`, `LC_*`, `TERM`, the vendor credential variable, the variable that points the CLI at its vendor home, `XARABOT_RESULT`,
`````
**Why:** Matches spine AD-17 (S:417).

#### E-1.11-2 · Story 1.11 vendor credential file
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D18 (C3)
**OLD:**
`````text
**Given** a lane vendor home
**When** a session starts
**Then** it is re-seeded to hold only that vendor's credential.
`````
**NEW:**
`````text
**Given** a lane vendor home and the operator's mode-600 credential file for that vendor under `$XDG_CONFIG_HOME/xarabot/vendors/<vendor>/` (falling back to `~/.config`)
**When** a session starts
**Then** the lane process reads that file and re-seeds the vendor home, or sets the credential variable, to hold only that vendor's credential
**And** the session itself cannot read the file (the `$XDG_CONFIG_HOME/xarabot` read test covers it)
**And** a missing or unreadable credential file refuses the session, with an error naming the file.
`````
**Why:** D18; session refusal matches this Story's fail-closed wording.

#### E-1.13-1 · Story 1.13 prompt names the Story id and `sprint_key`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D15 (N3)
**OLD:**
`````text
**Then** the prompt names the unit ("Build Story 1.7") and runs stock `bmad-build-auto` for it
`````
**NEW:**
`````text
**Then** the prompt names the unit by its Story id and `sprint_key` ("Build Story 1.7 (`1-7-forge-port-fake-forge-and-contract-suite`)"), so build-auto's spec slug leads with the id and its spec file matches `story_spec_path` (AR11), and runs stock `bmad-build-auto` for it
`````
**Why:** D15.

#### E-1.14-1 · Story 1.14 claude credential source
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D18 (C3)
**OLD:**
`````text
`CLAUDE_CODE_OAUTH_TOKEN` on macOS, `XARABOT_RESULT`, and the clone as working directory
`````
**NEW:**
`````text
`CLAUDE_CODE_OAUTH_TOKEN` on macOS (the token from `claude setup-token`, read from the operator's credential file under `$XDG_CONFIG_HOME/xarabot/vendors/claude/`, AR18), `XARABOT_RESULT`, and the clone as working directory
`````
**Why:** D18.

#### E-1.14-2 · Story 1.14 confirms the claude credential form
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D18 (C3)
**OLD:**
`````text
**And** the adapter supplies `claude`'s vendor API hosts to the proxy (Story 1.12).
`````
**NEW:**
`````text
**And** the adapter supplies `claude`'s vendor API hosts to the proxy (Story 1.12)
**And** the Story confirms the name and form of `claude`'s credential file under `$XDG_CONFIG_HOME/xarabot/vendors/claude/` and records it for Story 1.20's runbook.
`````
**Why:** D18: the exact form per vendor is confirmed in each adapter Story.

#### E-1.16-1 · Story 1.16 retitled and scoped to claim through result
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C8
**OLD:**
`````text
### Story 1.16: The lane process: one unit from claim to PR

As an operator,
I want one lane process to take one unit from claim to an open PR,
So that a Story is built unattended in the sandbox and leaves a bot-authored PR, a journal record and a ledger state that says what happened (FR3, FR6, FR11, FR22, AR3, AR8, AR10, AR25).
`````
**NEW:**
`````text
### Story 1.16: The lane process: one unit from claim to result

As an operator,
I want one lane process to take one unit from claim to a validated result,
So that a Story is built unattended in the sandbox and leaves a journal record and a ledger state that says what happened (FR3, FR6, FR11, FR22, AR3, AR8, AR10, AR15, AR25).
`````
**Why:** C8 split; the PR moves to Story 1.16a. [NEW CHOICE] (new title, which changes the sprint key)

#### E-1.16-2 · Story 1.16 cross-check uses the single spec match
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D15 (N3)
**OLD:**
`````text
**Then** it cross-checks the result's `outcome` against the Story spec's `status` and `## Auto Run Result` (AR15), and a mismatch counts as an invalid result.
`````
**NEW:**
`````text
**Then** it finds the Story's spec file as the single file in the clone's working tree matching `story_spec_path` (AR11), and cross-checks the result's `outcome` against that file's `status` and `## Auto Run Result` (AR15)
**And** zero or several matches, or a mismatch, count as an invalid result.
`````
**Why:** D15.

#### E-1.16-3 · Story 1.16 hands a `done` result to Story 1.16a
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C8
**OLD:**
`````text
**Given** a `done` build result
**When** the runner handles it
**Then** it commits (Story 1.15), re-checks the Standing Authority, pushes with a lease, opens the PR with the sanitized summary and body, records `pr` and `head_sha`, and posts a status comment starting with 🤖 through `Forge.comment` (Story 1.9).

**Given** a result whose `denied_actions[]` is not empty
**When** the runner handles it
**Then** each action is recorded in the unit's journal record and listed in the PR's 🤖 status comment (AR44).
`````
**NEW:**
`````text
**Given** a valid `done` build result
**When** the runner handles it
**Then** it passes the unit to the PR step (Story 1.16a).
`````
**Why:** C8: the `done` path and `denied_actions[]` move to Story 1.16a. [NEW CHOICE] (hand-off wording)

#### E-1.16a-1 · New Story 1.16a: Opening the PR
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C8
**OLD:**
`````text
**Then** each outcome above has a case.

### Story 1.17: CI polling, CI fixes and conflicts
`````
**NEW:**
`````text
**Then** each outcome above has a case.

### Story 1.16a: Opening the PR

As an operator,
I want the lane to turn a `done` build result into a bot-authored PR in code,
So that only the runner commits, pushes and writes forge text, and a revoked Standing Authority stops the push (FR6, FR13, FR22, NFR10, AR7, AR16, AR21, AR44).

**Acceptance Criteria:**

**Given** a `done` build result that passed validation (Story 1.16)
**When** the runner handles it
**Then** it commits (Story 1.15), re-checks the Standing Authority from freshly fetched `main`, pushes with a lease, opens the PR with the sanitized summary and body, records `pr` and `head_sha`, and posts a status comment starting with 🤖 through `Forge.comment` (Story 1.9).

**Given** a Standing Authority that is absent or invalid on fresh `main`
**When** the lane is about to push
**Then** it stops before the push, with no push and no PR (AR21).

**Given** a result whose `denied_actions[]` is not empty
**When** the runner handles it
**Then** each action is recorded in the unit's journal record and listed in the PR's 🤖 status comment (AR44).

**Given** the lane tests
**When** they run against the fake forge and a stub agent
**Then** the commit, the push with its lease, the PR, the status comment, the Standing Authority re-check and the denied-actions listing each have a case.

### Story 1.17: CI polling, CI fixes and conflicts
`````
**Why:** C8, written like Story 1.17a. [NEW CHOICE] (the Standing Authority stop AC, derived from AR21's re-check before every push)

#### E-1.17-1 · Story 1.17 conflict session counts as a CI fix
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D16 (C2)
**OLD:**
`````text
**And** any other conflict goes to a builder session that counts as an attempt.
`````
**NEW:**
`````text
**And** any other conflict goes to a builder session that counts as a CI fix (`ci_fixes` + 1), never as an attempt or a loopback.
`````
**Why:** D16, as the spine's A-16 words it.

#### E-1.17-2 · Story 1.17 CI-fix cap covers conflict sessions
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D16 (C2)
**OLD:**
`````text
**And** once `ci_fixes` ≥ 2 and CI still fails, the unit parks blocked.
`````
**NEW:**
`````text
**And** once `ci_fixes` ≥ 2 and CI still fails, or another conflict needs a session, the unit parks blocked (`ci-fix-cap`).
`````
**Why:** D16: one shared cap, existing park reason.

#### E-1.19-1 · Story 1.19 lane refuses without its vendor credential
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D18 (C3)
**OLD:**
`````text
**Then** it refuses if its agent is not allowed unattended by policy, its adapter's start check fails (an effort not in `effortValues` for its model, or a CLI below the minimum tested version), the App installation does not cover the repo, or the host would run more builders than `XARABOT_MAX_BUILDERS` across all repos.
`````
**NEW:**
`````text
**Then** it refuses if its agent is not allowed unattended by policy, its adapter's start check fails (an effort not in `effortValues` for its model, or a CLI below the minimum tested version), its vendor's credential file under `$XDG_CONFIG_HOME/xarabot/vendors/<vendor>/` is missing or unreadable (AR18), the App installation does not cover the repo, or the host would run more builders than `XARABOT_MAX_BUILDERS` across all repos.
`````
**Why:** D18 lane-start refusal.

#### E-1.20-1 · Story 1.20 canary live command
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C1
**OLD:**
`````text
**And** `docs/maintainer/self-host.md` holds the canary's live command (`bun test --live <suite>`) and expected result,
`````
**NEW:**
`````text
**And** `docs/maintainer/self-host.md` holds the canary's live command (`XARABOT_LIVE=1 bun test <suite>`) and expected result,
`````
**Why:** C1.

#### E-1.20-2 · Story 1.20 runbook: credential, bootstrap writes, Epic 2 context, Epic 2 steps
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D14, D17, D18, D19, C7, C10
**OLD:**
`````text
**Then** it lists every Maintainer step for the switch, each with the command or file content to apply: the CI workflow as a required check; the `xarabot/claims` ruleset; the merge queue on `main`; squash messages set to PR title + body; the App permissions, including AR38's finding (`issues: write` is a Story 1.10 precondition); this repo's `.xarabot/config.yaml` with `runner_version` and `bootstrapped_epics: [1]`; a `policy.yaml` that makes every path need the Maintainer's approval and allows only `claude` unattended; the Standing Authority file; running `bmad-sprint-planning` once to create `sprint-status.yaml` with Epic 1's Stories `done` (a one-time Maintainer write, the exception AR4 records); running Epic 1's retro interactively; Epic 2's Story manifests, with `depends_on` where a Story builds on an earlier one; `XARABOT_MAX_BUILDERS=1`; `xarabot lane install`; and stopping the bootstrap loop
`````
**NEW:**
`````text
**Then** it lists every Maintainer step for the switch, each with the command or file content to apply: the CI workflow as a required check; the `xarabot/claims` ruleset; the merge queue on `main`; squash messages set to PR title + body; the App permissions, including AR38's finding (`issues: write` is a Story 1.10 precondition); storing the Claude credential, the token from `claude setup-token`, in its mode-600 file under `$XDG_CONFIG_HOME/xarabot/vendors/claude/` on the Xarabot host, in the form Story 1.14 recorded (AR18); this repo's `.xarabot/config.yaml` with `runner_version` and `bootstrapped_epics: [1]`; a `policy.yaml` that makes every path need the Maintainer's approval and allows only `claude` unattended; the Standing Authority file; the Maintainer's bootstrap writes, each in a Maintainer PR (AR4): running `bmad-sprint-planning` once so that `sprint-status.yaml` has Epic 1's Stories `done`, whether the run creates the file or updates it, Epic 2's Story manifests, with `depends_on` where a Story builds on an earlier one, and Epic 2's context file at `epic_context_path`, compiled by following the installed stock `bmad-build-auto` skill's `compile-epic-context.md` with the Epic number, the epics path, the planning artifacts directory and the output path, and checked to be non-empty and to start with `# Epic 2 Context:`; running Epic 1's retro interactively; `XARABOT_MAX_BUILDERS=1`; `xarabot lane install`; and stopping the bootstrap loop
**And** it lists the Maintainer's steps while Epic 2 is built: a lane runs only the pinned `runner_version` (Story 1.19), so after a Story whose code the lanes need has merged, the Maintainer tags that `main` commit in `xaravel/xarabot` and advances `runner_version` to the tag in a Maintainer PR, added to the merge queue by hand, and each lane installs it at its next start; the coordinator lane is installed only once `runner_version` includes Stories 2.4 and 2.5; until Story 2.8 merges, the Maintainer runs `xarabot graph check` on each graph PR before approving it; and until Story 4.6 merges, the Maintainer records a rejected retro's go by hand in `retro-gates.yaml` (`ruling: maintainer-pr`, AR13), in a Maintainer PR
`````
**Why:** D14 `runner_version` steps; D17 bootstrap writes; D18 claude credential; D19 Epic 2 context; C7 creates or updates; C10 graph check. [NEW CHOICE] (listing the hand-written rejected-retro go in the runbook)

#### E-2.3-1 · Write check: the spec file is the single `story_spec_path` match
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D15 (N3)
**OLD:**
`````text
**When** a builder diff touches the unit's own BMAD Story spec file, the `status:` line of its own Story file, or the repo's Protected Paths for an Infrastructure Story with a matching approval
`````
**NEW:**
`````text
**When** a builder diff touches the unit's own BMAD Story spec file (the single file matching `story_spec_path`, by default `_bmad-output/implementation-artifacts/spec-<epic>-<story>-*.md`), the `status:` line of its own Story file, or the repo's Protected Paths for an Infrastructure Story with a matching approval
`````
**Why:** D15 makes "its own BMAD Story spec file" mean the single glob match.

#### E-2.4-1 · Retro units hold the retro document path
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** N2
**OLD:**
`````text
**Then** a graph planning unit holds the graph inputs and the pseudo-glob `xarabot:graph`; a status planning unit holds both status files and the Epic context path, never the graph inputs; retro and checkpoint hold the status files and the Epic context path, never the graph inputs; `reconcile` holds none; and the overlap check applies to the coordinator as to builders.
`````
**NEW:**
`````text
**Then** a graph planning unit holds the graph inputs and the pseudo-glob `xarabot:graph`; a status planning unit holds both status files and the Epic context path, never the graph inputs; a retro unit holds the status files, the Epic context path and the retro document path (`retro_doc_glob`), never the graph inputs; a checkpoint unit holds the status files and the Epic context path, never the graph inputs; `reconcile` holds none; and the overlap check applies to the coordinator as to builders.
`````
**Why:** N2: stock `bmad-retrospective` writes `epic-<N>-retro-<date>.md`, which the write check otherwise refuses.

#### E-2.4-2 · Coordinator install waits for `runner_version` with Stories 2.4 and 2.5
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D14 (N1, `runner_version` steps)
**OLD:**
`````text
**Then** it adds the Maintainer step of installing the coordinator lane with `xarabot lane install --role coordinator`, which Epic 2's retro, and so Epic 3, waits on.
`````
**NEW:**
`````text
**Then** it adds the Maintainer steps, in order: once Stories 2.4 and 2.5 have merged, tag a `main` commit that includes both and advance `runner_version` to that tag in a Maintainer PR (Story 1.19); then install the coordinator lane with `xarabot lane install --role coordinator`, which Epic 2's retro, and so Epic 3, waits on
**And** it says the coordinator lane is never installed while `runner_version` lacks Stories 2.4 and 2.5.
`````
**Why:** D14: record when the Maintainer advances `runner_version` in Epic 2, using the tag mechanics of Story 1.19. [NEW CHOICE] "tag a `main` commit" rather than "release", since Story 1.19 installs from a git tag until npm releases exist.

#### E-2.5-1 · A `merged` record already meets `depends_on`
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D14 (N1)
**OLD:**
`````text
**Then** it writes their `merged` records, and marks each unit done on `main` per AR10's rule for its kind (a Story becomes `done` in `sprint-status.yaml`, which is where `next` and the gates read that it is done, since its record is later deleted)
`````
**NEW:**
`````text
**Then** it writes their `merged` records, and marks each unit done on `main` per AR10's rule for its kind (a Story becomes `done` in `sprint-status.yaml`, which is where `next` and the gates read that it is done, since its record is later deleted; until then its `merged` record already meets a `depends_on` that names it, Story 1.6)
`````
**Why:** D14: `depends_on` is met by `done` or a `merged` record; this AC said `next` reads only `done`.

#### E-2.7-1 · Status unit is due for an Epic waiting on its context file
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D19 (C5)
**OLD:**
`````text
**Given** a snapshot where `epics.md` has Epics or Stories missing from `sprint-status.yaml`, or an Epic about to become eligible with no current Epic context file
`````
**NEW:**
`````text
**Given** a snapshot where `epics.md` has Epics or Stories missing from `sprint-status.yaml`, or an Epic not listed in `bootstrapped_epics` whose Stories wait only on its Epic context file (`epic_context_path`), missing or invalid on `main` (Story 1.6)
`````
**Why:** D19: the Epic context gate holds an Epic's Stories until the file is valid on `main`; bootstrapped Epics are exempt. [NEW CHOICE] "wait only on its Epic context file" replaces the vague "about to become eligible".

#### E-2.7-2 · Status unit prompt: compile Epic context through stock `compile-epic-context.md`; findings go in the result
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D19 (C5); N2
**OLD:**
`````text
**Then** it runs stock `bmad-sprint-planning` told to run headless, plus the due Epic context, and never touches a graph input.
`````
**NEW:**
`````text
**Then** it runs stock `bmad-sprint-planning` told to run headless, and never touches a graph input
**And** for each due Epic context it follows the installed stock `bmad-build-auto` skill's `compile-epic-context.md` with the Epic number, the epics path, the planning artifacts directory and the output path (`epic_context_path`)
**And** it tells the session to return any readiness findings in the `planning` result (`outcome: blocked`, the findings in `summary`) and never to save a findings file, so the unit holds no findings path.
`````
**Why:** D19 names how the context is compiled. [NEW CHOICE] (from the brief, N2) readiness findings go in the `planning` result, never a findings file.

#### E-2.7-3 · Planning case table gains the context cases
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D19 (C5)
**OLD:**
`````text
**Then** it gains the planning position's cases: a status unit due, a graph unit due, both due with the graph unit first, and a Story heading with no manifest in an Epic listed in `bootstrapped_epics`, which makes nothing due.
`````
**NEW:**
`````text
**Then** it gains the planning position's cases: a status unit due, a status unit due only for an Epic waiting on its context file, a graph unit due, both due with the graph unit first, and a Story heading with no manifest, or no Epic context file, in an Epic listed in `bootstrapped_epics`, which makes nothing due.
`````
**Why:** D19: test the new due trigger and the bootstrapped exemption.

#### E-2.12-1 · Live switch
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C1
**OLD:**
`````text
**Then** it records this suite's live command (`bun test --live <suite>`, the 30-minute case included) and its expected result, which the Maintainer runs on the host, outside the sandbox, before Epic 2's retro
`````
**NEW:**
`````text
**Then** it records this suite's live command (`XARABOT_LIVE=1 bun test <suite>`, the 30-minute case included) and its expected result, which the Maintainer runs on the host, outside the sandbox, before Epic 2's retro
`````
**Why:** C1: Bun 1.4.3 never passes `--live` to `Bun.argv`.

#### E-3.1-1 · `codex` credential file and seeding
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D18 (C3)
**OLD:**
`````text
**And** an unset `model` is `gpt-6.1-sol` and an unset `effort` is `high`.
`````
**NEW:**
`````text
**And** an unset `model` is `gpt-6.1-sol` and an unset `effort` is `high`.

**Given** the operator's `codex` credential, its auth file or API key, written once to a mode-600 file under `$XDG_CONFIG_HOME/xarabot/vendors/` (falling back to `~/.config`)
**When** a `codex` session, builder or reviewer, is about to launch
**Then** the lane process reads that file and seeds the lane's vendor home with it, in the form this Story confirms `codex exec` accepts
**And** a lane whose adapter or reviewer is `codex` refuses to start while that file is missing or unreadable (AR18).
`````
**Why:** D18: the credential source and the fail-closed rule for `codex`; the form is confirmed in Story 3.1.

#### E-3.2-1 · `pi` credential file and seeding
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D18 (C3)
**OLD:**
`````text
**Then** it returns `pi -p --mode json --model <provider/id> --thinking <effort>` with pi's own sandbox turned off inside Xarabot's, its attribution-off setting, and pi's agent directory pointed at the lane's vendor home, which holds the operator's OpenRouter sign-in, plus `XARABOT_RESULT` and the clone as working directory
**And** an unset `effort` is `high`.
`````
**NEW:**
`````text
**Then** it returns `pi -p --mode json --model <provider/id> --thinking <effort>` with pi's own sandbox turned off inside Xarabot's, its attribution-off setting, and pi's agent directory pointed at the lane's vendor home, plus `XARABOT_RESULT` and the clone as working directory
**And** an unset `effort` is `high`.

**Given** the operator's OpenRouter key, written once to a mode-600 file under `$XDG_CONFIG_HOME/xarabot/vendors/` (falling back to `~/.config`)
**When** a `pi` session, builder or reviewer, is about to launch
**Then** the lane process reads that file and seeds the lane's vendor home with it, in the form this Story confirms pi reads
**And** a lane whose adapter or reviewer is `pi` refuses to start while that file is missing or unreadable (AR18).
`````
**Why:** D18: the vendor home is seeded from the operator's stored key, not an interactive sign-in.

#### E-3.3-1 · Lane start refuses without the reviewer's credential
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D18 (C3)
**OLD:**
`````text
**Then** it refuses to start if its reviewer adapter is not allowed by the repo's policy (AR17, AR22).
`````
**NEW:**
`````text
**Then** it refuses to start if its reviewer adapter is not allowed by the repo's policy, or if the reviewer's credential file under `$XDG_CONFIG_HOME/xarabot/vendors/` is missing or unreadable (AR17, AR18, AR22).
`````
**Why:** D18: a missing credential for an allowed reviewer fails closed at lane start.

#### E-3.4-1 · Reviewer vendor home seeded from its credential file
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D18 (C3)
**OLD:**
`````text
**Then** it makes a fresh checkout of `head_sha` from `runner.git`, never the builder's clone, restores the agent config paths from `main`, turns hooks off, seeds a fresh vendor home for the reviewer, and launches it through the sandbox.
`````
**NEW:**
`````text
**Then** it makes a fresh checkout of `head_sha` from `runner.git`, never the builder's clone, restores the agent config paths from `main`, turns hooks off, seeds a fresh vendor home for the reviewer from that vendor's credential file (AR18), and launches it through the sandbox.
`````
**Why:** D18 covers the reviewer of another vendor, which C3 called out.

#### E-3.5-1 · Loopbacks and CI fixes are separate caps
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D16 (C2)
**OLD:**
`````text
**Then** the review re-runs and `loopbacks` + 1
**And** once `loopbacks` ≥ 2, the unit becomes `parked`, blocked (`park.reason: review-cap`), whatever the review's verdict, with `park.inbox_owner` set to its owner.
`````
**NEW:**
`````text
**Then** the review re-runs
**And** a review-driven fix session counts as a loopback (`loopbacks` + 1); a CI-fix session, or an agent session resolving a merge conflict, counts as a CI fix (`ci_fixes` + 1, Story 1.17) and never as a loopback
**And** once `loopbacks` ≥ 2, the unit becomes `parked`, blocked (`park.reason: review-cap`), whatever the review's verdict, with `park.inbox_owner` set to its owner; past the `ci_fixes` cap it becomes `parked`, blocked (`park.reason: ci-fix-cap`), as Story 1.17 says.
`````
**Why:** D16: CI fixes and conflict sessions re-run the review but count only toward `ci_fixes`, so `ci-fix-cap` can fire.

#### E-3.5-2 · Case table covers the separate caps
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D16 (C2)
**OLD:**
`````text
**Then** head equal to `passed_sha`, head with only a clean `main` merge on top, head with a later agent change, the loopback cap and a revoked allowance each have a case.
`````
**NEW:**
`````text
**Then** head equal to `passed_sha`, head with only a clean `main` merge on top, head with a later agent change, the loopback cap, a CI fix and a conflict resolution that each re-run the review and count toward `ci_fixes`, not `loopbacks`, and a revoked allowance each have a case.
`````
**Why:** D16: prove a CI fix never trips `review-cap`.

#### E-3.6-1 · Live switch
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C1
**OLD:**
`````text
**Then** it records this suite's live command (`bun test --live <suite>`) and the expected result of each case above, and the nested sandbox cases of Stories 3.1 and 3.2; the Maintainer runs them on the host, outside the sandbox, with every vendor's credential at once (a lane's vendor home holds only one), before Epic 3's retro
`````
**NEW:**
`````text
**Then** it records this suite's live command (`XARABOT_LIVE=1 bun test <suite>`) and the expected result of each case above, and the nested sandbox cases of Stories 3.1 and 3.2; the Maintainer runs them on the host, outside the sandbox, with every vendor's credential at once (a lane's vendor home holds only one), before Epic 3's retro
`````
**Why:** C1.

#### E-4.6-1 · Checkpoint go uses the AR35 unit id
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** Minor (ruling syntax)
**OLD:**
`````text
**Given** `/xarabot go <checkpoint-epic>`
`````
**NEW:**
`````text
**Given** `/xarabot go checkpoint:<epic>`
`````
**Why:** Story 4.5's grammar takes AR35 unit ids only.

#### E-4.7-1 · Checkpoint go uses the AR35 unit id
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** Minor (ruling syntax)
**OLD:**
`````text
**When** the Maintainer comments `/xarabot go <epic>` on the inbox issue
`````
**NEW:**
`````text
**When** the Maintainer comments `/xarabot go checkpoint:<epic>` on the inbox issue
`````
**Why:** Story 4.5's grammar takes AR35 unit ids only.

#### E-4.7-2 · Live switch
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C1
**OLD:**
`````text
**Then** it records this suite's live command (`bun test --live <suite>`) and the expected result of each scratch-repo case above, which the Maintainer runs on the host, outside the sandbox, before Epic 4's retro
`````
**NEW:**
`````text
**Then** it records this suite's live command (`XARABOT_LIVE=1 bun test <suite>`) and the expected result of each scratch-repo case above, which the Maintainer runs on the host, outside the sandbox, before Epic 4's retro
`````
**Why:** C1.

#### E-5.3-1 · Live switch
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C1
**OLD:**
`````text
**Then** it records this suite's live command (`bun test --live <suite>`) and the expected result of each case above, which the Maintainer runs on the host, outside the sandbox, against the test org, before Epic 5's retro
`````
**NEW:**
`````text
**Then** it records this suite's live command (`XARABOT_LIVE=1 bun test <suite>`) and the expected result of each case above, which the Maintainer runs on the host, outside the sandbox, against the test org, before Epic 5's retro
`````
**Why:** C1.

#### E-6.5-1 · Live switch
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C1
**OLD:**
`````text
**Then** it records the live checks, each with its command (`bun test --live <suite>`, and `xarabot tui` on a laptop with `XARABOT_HOST` set) and expected result, which the Maintainer runs on the host and the laptop, outside the sandbox, before Epic 6's retro
`````
**NEW:**
`````text
**Then** it records the live checks, each with its command (`XARABOT_LIVE=1 bun test <suite>`, and `xarabot tui` on a laptop with `XARABOT_HOST` set) and expected result, which the Maintainer runs on the host and the laptop, outside the sandbox, before Epic 6's retro
`````
**Why:** C1.

#### E-7.3-1 · Linux `claude` credential comes from the operator's file
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** D18 (C3)
**OLD:**
`````text
**Then** it holds only the Claude credential, by the means the adapter documents for Linux.
`````
**NEW:**
`````text
**Then** it holds only the Claude credential, which the lane process reads from the operator's `claude` credential file under `$XDG_CONFIG_HOME/xarabot/vendors/` and passes by the means the adapter documents for Linux (AR18).
`````
**Why:** D18: one credential source on every platform.

#### E-7.6-1 · Escalation decision file name
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** Minor (decision file name)
**OLD:**
`````text
**Then** it reads Escalation files named `ESC-<story-id>-<n>.md` or `ESC-bot-<n>.md` from the Escalation directory, and for each the decision file `<decisions-dir>/<id>.md` with the same file name, carrying `decision: approved | rejected` and `escalation_sha256`
`````
**NEW:**
`````text
**Then** it reads Escalation files named `ESC-<story-id>-<n>.md` or `ESC-bot-<n>.md` from the Escalation directory, and for each the decision file in the decisions directory with the same file name as its Escalation file (e.g. `decisions/ESC-9.3-1.md`), carrying `decision: approved | rejected` and `escalation_sha256`
`````
**Why:** Same wording as the spine and AR21 fixes: the decision file has the Escalation's file name.

#### E-7.7-1 · Live switch
**File:** `_bmad-output/planning-artifacts/epics.md`
**Decision:** C1
**OLD:**
`````text
**Then** it records this suite's live command (`bun test --live <suite>`) and the expected result of each case above, and the nested Linux sandbox cases of Story 7.3; the Maintainer runs them on the macOS host and on the Linux host, outside the sandbox, with the credentials they need, before Epic 7's retro
`````
**NEW:**
`````text
**Then** it records this suite's live command (`XARABOT_LIVE=1 bun test <suite>`) and the expected result of each case above, and the nested Linux sandbox cases of Story 7.3; the Maintainer runs them on the macOS host and on the Linux host, outside the sandbox, with the credentials they need, before Epic 7's retro
`````
**Why:** C1.


## 5. Implementation handoff

**Scope: moderate.** The changes are cross-cutting planning edits, with no replan and no code.

| Artifact | Who applies it | How |
|---|---|---|
| Spine (27 edits) and epics (75 edits) | the Maintainer's session, through `bmad-correct-course` once approved | apply 4a and 4c mechanically with `check_edits.py --apply`; commit on `planning/regate-fixes` |
| Spec and companions (8 edits) | `bmad-spec` ("update the spec"), per AGENTS.md | apply 4b; the spec memlog records them |
| `docs/maintainer/self-host.md` | Stories 1.20 and 2.4 when built | no change now |

**Success criteria.**
- All 110 edits are applied, and `check_edits.py` finds no OLD left in the files.
- `sprint_plan.py generate --dry-run` parses 7 Epics and 63 Stories.
- A re-run of `bmad-sprint-planning` passes the gate (PASS, or CONCERNS the Maintainer accepts) and writes `sprint-status.yaml`.
