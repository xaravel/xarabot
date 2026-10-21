---
review: adversary-5
target: ../ARCHITECTURE-SPINE.md (status final, updated 2026-10-21, uncommitted Epic-graph edits to AD-3, AD-11, AD-12, AD-13, AD-20, Deferred)
prior: review-adversary.md (1) .. review-adversary-4.md (4), review-rubric.md, review-reconcile-spec.md, review-reconcile-findings.md, review-currency.md
spec: _bmad-output/specs/spec-xarabot/SPEC.md (CAP-2, CAP-5, CAP-10, Constraints "Planning shape"), glossary.md ("Epic graph file")
date: 2026-10-21
lens: the move of the Epic graph from epics.md bullets into .xarabot/epics.yaml (versioned schema; map keyed by Epic number; depends_on; optional checkpoint; serial default; repo-layer config read from origin/main; Protected Path, coordinator PR owner-gated, builders refused). Looks for two units one level down that each obey every AD and still build incompatibly, compute the default differently, race, or let an agent pass a checkpoint. Not re-litigated (Maintainer decisions): the file's location, the serial default, its Protected Path status.
severity: S1 = an agent passes a checkpoint or another gate the Maintainer owns; S2 = two units diverge, or the success path deadlocks or stops every lane; S3 = minor or a test-level gap.
---

# Adversarial review, round 5: the Epic graph file

## Verdict

**The file is protected, but the graph is not.** The effective graph that `next` and the gates evaluate is a function of three inputs: `.xarabot/epics.yaml`, the `## Epic N:` headings in `epics.md`, and each manifest's `epic` field. Only the first is a Protected Path. The serial default and the number-keyed map turn the other two into graph inputs: renumbering, removing or inserting an Epic heading, or moving a Story's manifest to another Epic, rewires default edges and moves `checkpoint: true` to a different Epic. All of that is an ordinary, ungated coordinator PR. Stock `bmad-correct-course` does exactly these edits ("add new epic", "remove", "renumbered: update epic IDs", "resequence" in its checklist §2.2, 2.5 and 6.4). So the Maintainer's stated aim, "no agent can remove a checkpoint or add parallelism unseen", does not hold. This is hole 1 (S1).

A second S1 is older, but this change makes it the remaining gap: the checkpoint `go` lives in `retro-gates.yaml`, which is a planning path that any coordinator agent session may write (AD-30).

The rest are S2. The first owner-gated planning PR deadlocks or churns the coordinator, because it parks while it holds every planning path. Missing-file, read-error and omitted-`depends_on` semantics let two loaders compute different graphs. And a builder's `package.json` edit can close a cycle with the serial chain and stop every lane.

## Convergence judgement

**Design-level, narrow.** Every fix below is a few lines in AD-11, AD-16, AD-30 or AD-13, plus one pure function (`effectiveGraph`) that the graph loader Story already has to write. None overturns a Maintainer decision. Make holes 1 to 3 before the graph-loader, gates and planning-unit Stories are bound. Holes 4 to 6 can be closed with the same edit pass.

---

## Hole 1 (S1): the effective graph changes through ungated files, and checkpoints re-attach by number

**Units:** the coordinator planning unit (writes `epics.md` and manifests; AD-3, AD-13, AD-30) and the graph loader with gates (AD-11, AD-12).
**ADs obeyed:** AD-3 (planning units are the writers of `epics.md` and manifests), AD-30 (a coordinator diff may touch the planning paths), AD-16 (only Protected Path PRs are owner-gated), AD-11 (default edge = next lower Epic number present in `epics.md`; the map is keyed by number; an Epic's Stories are the manifests whose `epic` names it).

Sequences. None of them touches `.xarabot/epics.yaml`, so none is owner-gated:

1. **Renumber swap.** `epics.yaml` has `4: {depends_on: [3], checkpoint: true}` and `6: {depends_on: [2]}`. Epic 5 is unlisted, so it depends on 4 and is held. A correct-course planning PR renumbers `## Epic 5` to `## Epic 7`, updating manifests and `sprint-status.yaml` to match. Epic 7 is unlisted, so it now depends on 6, which depends on 2. It escapes checkpoint 4. Validation passes.
2. **Checkpoint moves.** The PR swaps the numbers 4 and 5 in `epics.md` and the manifests. `checkpoint: true` is keyed `4`, so it now gates the other Epic. Retro verdicts and the go in `retro-gates.yaml` are keyed by number too, so a done verdict can also move onto a different Epic.
3. **Remove or insert.** Removing an unlisted Epic heading, or inserting one into a numbering gap, changes the default edge of the unlisted Epic above it. In both cases that edge can land on a listed parallel Epic, which escapes a checkpoint.
4. **Epic 0.** The convention says only "the Epic key is an integer", so `## Epic 0:` is valid. As the lowest Epic it depends on none and is eligible at once, and Epic 1 now depends on it.
5. **Story move.** Rewrite one manifest from `epic: 5` to `epic: 6`, where 6 is a listed parallel Epic, and move its heading. The Story leaves the held Epic. Nothing ties a manifest's `epic` to its `story_id` prefix or to the `## Epic N:` heading it sits under.

**Fix (AD-11, AD-30, AD-16, Consistency Conventions):**
- Add a pure `effectiveGraph(tree)` in `src/core/` over (`epics.yaml`, the `epics.md` headings, the manifests' `epic` fields, the package edges). It returns the Epic set, the edges, the checkpoint set and the Story-to-Epic membership.
- A coordinator PR is owner-gated (AD-16) if `effectiveGraph` of the PR's merge result differs from `effectiveGraph` of `main` for any Epic present on `main`. That covers a changed edge, a changed checkpoint, a removed or renumbered Epic, and a changed Story membership. The only change allowed without the gate is appending Epics numbered above the current highest, with default edges. That is exactly the "costs speed, never correctness" case.
- The runner computes this itself at enqueue, on the same merge it recomputes for AD-16, never on the PR's original base.
- Epic keys match `^[1-9]\d*$`.
- Validation also fails when a manifest's `epic` differs from its `story_id`'s Epic part, or from the `## Epic N:` heading its Story heading sits under.

## Hole 2 (S1): any coordinator agent session can write the checkpoint go

**Units:** the reconcile ruling writer (AD-28, runner code) and any planning, retro or checkpoint agent session (AD-13, AD-30).
**ADs obeyed:** AD-3 (`retro-gates.yaml`, which holds "checkpoint go", is written by "coordinator", with no split between runner code and the agent session), AD-13 (`retro-gates.yaml` is a planning path), AD-30 ("coordinator diffs may touch only the planning paths"), AD-16 (a coordinator PR passes on the cross-vendor review, which is another agent).

A retro or planning session adds `go` for `checkpoint:4` to `retro-gates.yaml`. The diff is inside the planning paths and touches no Protected Path. It passes agent review and merges. AD-9 then counts the checkpoint unit as done, and AD-12 releases every dependent Epic. AD-28 restricts `go` to the Maintainer's comment, but nothing restricts the file write that records it. The graph file is now owner-gated, so this is the cheapest way left for an agent to pass a checkpoint. The same applies, less sharply, to retro verdicts (the "retro done" half of AD-12's start rule) and to `done` in `sprint-status.yaml`.

**Fix (AD-30, AD-28, AD-3):**
- The go is written only by reconcile's runner code, from a ruling whose author it has checked against the Maintainer in config.
- AD-30 parses `retro-gates.yaml` before and after every agent-session diff and refuses any change to a go field.
- Better: record the go in the ledger, in the `checkpoint:<epic>` record or in `coordinator.json`, which no agent can write.
- Key the go by Epic and by `effectiveGraph`'s checkpoint entry, so a renumber (hole 1) can't move it.

## Hole 3 (S2): an owner-gated planning PR parks while it holds every planning path, so the coordinator deadlocks or loses the approval

**Units:** the planning unit whose PR changes `epics.yaml` (AD-7 "awaits owner approval: parked, globs held"), reconcile (AD-13 step 1, which enqueues approved held PRs and marks units done in `sprint-status.yaml`), and the retro and checkpoint units.
**ADs obeyed:** AD-13 (planning, retro and checkpoint units all hold the full planning paths, `.xarabot/epics.yaml` included; the overlap check applies to every role), AD-4 (a claim fails on overlap with a held `parked` record), AD-19 (merge `origin/main` into a conflicting PR; for status YAML keep `main`'s lines), AD-33 (stale approvals are dismissed on push).

This is new with this change. Before it, no coordinator PR was ever owner-gated. Now the first graph-changing planning PR parks held over `epics.md`, the manifests, `sprint-status.yaml`, `retro-gates.yaml` and `epics.yaml`, and two readings follow:

- **Reconcile holds the status files.** That is the natural reading, since it writes them, and AD-13 never gives reconcile's globs. Then `reconcile:<n>` can't be claimed while the PR is held, and only reconcile enqueues approved held PRs. The PR can never merge: a deadlock.
- **Reconcile holds no globs.** Then reconcile keeps marking Stories done in `sprint-status.yaml`. The planning PR also changes that file (it adds the new Epic's entries), so the two edits conflict, often on adjacent lines. AD-19 makes the runner merge `main` into the PR, which pushes a new head. AD-33 dismisses the approval, and AD-7 re-parks the PR. With the Maintainer approving once a day and reconcile running hourly, the PR may never land.

In both readings, retro and checkpoint units can't be claimed while the PR waits, so Epics can't close their gates and builders go idle. A retro session may also legally change `epics.yaml`, because it is in the retro unit's planning paths, and that parks the retro itself.

**Fix (AD-13, AD-7, AD-30):**
- An owner-gated coordinator PR never touches `sprint-status.yaml` or `retro-gates.yaml`. Reconcile adds the status entries for new Epics after the PR merges, as runner code.
- A parked held coordinator PR holds only the paths its diff changes.
- Give reconcile's globs explicitly: none, because its edits are runner-generated and its status edit is the AD-19 YAML rule.
- Only planning units may change `.xarabot/epics.yaml` (AD-30). Retro and checkpoint units hold `retro-gates.yaml` and the Epic context path, not `epics.md`, manifests or `epics.yaml`.
- A planning unit that changes both the Epic set and the graph does so in one PR. Two PRs land in either order: a graph PR first fails validation on a dangling entry, and an `epics.md` PR first runs the new Epic serially, without a checkpoint intended for it, until the graph PR lands. If that Epic finishes its retro in the gap, its intended checkpoint is lost.

## Hole 4 (S2): two loaders compute different graphs from the same repo

**Units:** the graph loader Story (AD-11), the config loader (AD-20) and the snapshot builder (AD-27).

1. **Missing file.** AD-11 says "no file = serial". AD-20 says "if config … is missing … the lane stops". The file is in the repo-layer list, so one loader stops every lane and the other runs serially. Worse: a loader that maps any `git show origin/main:.xarabot/epics.yaml` error to "absent" turns a read failure into "no checkpoints at all". That fails open on the one gate the Maintainer owns.
   *Fix:* AD-20 names `epics.yaml` as the single repo-layer file whose absence is defined (serial). Absence is decided only from the tree listing of the Snapshot's `main` SHA, and any other read error fails closed.
2. **Omitted `depends_on`.** An entry with no `depends_on`, such as `5: {checkpoint: true}` written only to mark a checkpoint, reads as `[]` in a schema with an optional array. That makes Epic 5 run in parallel at once. Another loader applies the serial default.
   *Fix:* say it in AD-11. Omitting `depends_on` means the serial default, and only an explicit `[]` means none. Or make `depends_on` required, so the schema rejects the omission.
3. **"Present in `epics.md`".** Stock BMAD's `epics.md` has `### Epic N:` lines under `## Epic List` as well as the `## Epic N:` sections (epics-template.md; step-02 §D). They can disagree after a correct-course edit, and a heading can also sit inside a fenced block. A loader matching `^#+ Epic` and one matching `^## Epic` find different Epic sets, and so different default edges.
   *Fix:* AD-11 gives the exact patterns, `^## Epic ([1-9]\d*):` and `^### Story (\d+)\.(\d+[a-z]?):`, outside fenced code. The `## Epic List` section is ignored.
4. **Torn reads.** AD-20 says repo-layer config is read from "freshly fetched `origin/main`", while `epics.md` and the manifests arrive through the snapshot's `main` read. If those are two fetches across a merge, validation sees an entry with no heading (a spurious stop-every-lane alert) or computes the default against another commit's heading set.
   *Fix:* AD-27 and AD-11 read `epics.yaml`, `epics.md` and the manifests from the one `main` SHA in the Snapshot.
5. **Package edges with the default.** For an unlisted Epic, the effective dependencies could be the default edge alone or the default edge plus package edges. The text doesn't say.
   *Fix:* the effective dependencies are (the entry's `depends_on`, or the default) ∪ the package edges.
6. **Empty Epic.** An Epic heading with no Story headings (a planning placeholder) is vacuously "all Stories merged". One gates reader then waits forever for a retro that never gets scheduled, and another treats the retro as done.
   *Fix:* AD-11 validation rejects an Epic with no Stories, or AD-12 defines it as done with no retro. Choose one.

## Hole 5 (S2): a merged PR can make the graph invalid and stop every lane, coordinator included

**Units:** a builder Story that edits `package.json` (inside its globs) and the graph loader with package edges (AD-11).
**ADs obeyed:** AD-11 (package edges are added through the Epic-to-package map; a cycle stops every lane), AD-30 (`package.json` is not refused).

Under the serial default, Epic 5 depends on 4, which depends on 3. If Epic 3's package gains a workspace dependency on Epic 5's package, which is ordinary refactoring, the package edge 3 → 5 closes a cycle. The builder PR merges, and every lane stops, the coordinator included. The coordinator therefore can't plan the fix, and the Maintainer must hand-edit `main`. The same happens when an ungated coordinator PR removes an `## Epic N:` heading that `epics.yaml` still names. The serial default turns every lower-to-higher package import into a cycle, so this is far more likely than with explicit bullets.

**Fix (AD-11, AD-16):** before enqueue, the runner runs graph validation on the merge result of every PR that touches a graph input (`epics.md`, manifests, `epics.yaml`, or a `package.json` that the map covers). A PR that would make the graph invalid parks blocked with the reason, so it never lands. A builder PR that changes the effective graph through package edges is handled the same way (hole 1).

## Hole 6 (S3, five small items)

- **YAML keys.** `5:`, `"5":` and `05:` all become the JS key `"5"`, and a duplicate key is silently overwritten. *Fix:* the AD-27 schema takes canonical decimal keys, rejects duplicates, and takes `depends_on` items as integers only.
- **Graph tightening while a Story is in flight.** AD-12's "finish the Stories they hold and take no new ones" covers only a checkpoint. When an approved graph PR adds an edge, one `next` implementation keeps a held claim and another abandons it. Stale-claim takeover in a now-ineligible Epic is also unspecified (AD-13 makes takeover eligibility-gated). *Fix:* the in-flight rule applies to any tightening, and a stale claim in an ineligible Epic is still taken over (or released, but say which).
- **A checkpoint added after the fact.** `checkpoint: true` added to an Epic whose retro is already done: say whether a `checkpoint:<epic>` unit is created then, so its dependents hold from the merge on.
- **Reviewer's view of the graph.** The AD-16 review of a graph-changing PR sees a YAML diff, not its effect. *Fix:* the runner posts the `effectiveGraph` delta on the head it asks approval for: edges added and removed, checkpoints added and removed, Stories moved. This is the Maintainer's only reliable view of a change buried in a large planning PR.
- **Who approves.** "Owner-gated" means the PR owner's approval (AD-16, CAP-13). On a team repo the coordinator's owner may not be the Maintainer (AD-8 lets any identity take the coordinator claim). Yet removing a checkpoint has the same effect as a `go`, which AD-28 accepts only from the Maintainer. *Fix:* a PR that changes the effective checkpoint set needs the Maintainer's approval on its head. Raise this to S1 once v1 team onboarding lands.

## What holds

- Builders can't write the file (AD-30 `.xarabot/**`, with no Infrastructure exception for it).
- A coordinator PR that touches the file can't merge unapproved (AD-16 `approved_sha`, AD-33 stale dismissal).
- The default can't add parallelism by itself, since it only ever adds an edge downward.
- A lane can't read a branch's edited graph, because the file is read only from `main`.

Every hole above enters through an input other than the file.
