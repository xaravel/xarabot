---
review: adversary-7
target: ../ARCHITECTURE-SPINE.md (uncommitted fixes to AD-3, AD-7, AD-11, AD-12, AD-13, AD-16, AD-20, AD-28, AD-30), spine .memlog.md (last 7 entries)
prior: review-adversary-6.md
date: 2026-10-21
lens: confirm the round-6 fixes; then one focused attempt at an S1 (work escaping a checkpoint, or an agent changing a gate unseen) or an S2 (two units obeying every AD yet diverging) in the graph and checkpoint rules only. Not re-litigated (Maintainer decisions): the graph lives in .xarabot/epics.yaml; serial default; the Maintainer approves every effective-graph change; a Story heading with no manifest is unclaimable and keeps its Epic not done.
severity: S1 = an agent passes a checkpoint or another gate the Maintainer owns; S2 = two units diverge, or the success path deadlocks or stops every lane.
---

# Adversarial review, round 7: confirming the graph-gate fixes

## Verdict

**The round-6 S1 holes are closed. Planning-side graph changes are now serialized and bound to what the Maintainer approved. Three narrower holes remain, and all of them sit at the edges of the "what counts as a graph change" definition.** First, it is unstated whether adding a Story to an existing Epic is a graph change, so one build lets a planning agent put work into a checkpoint Epic after its go. Second, "Fixed once used" is keyed on files that the coordinator does not update while a Story is in flight. Third, it is unstated whether the pre-enqueue check runs the retro-gates validation. The one residual from round 6 is builder package edges, which are not serialized.

Tally of round-6 holes and partly-closed items: **7 closed, 3 partly closed, 0 open.**

## Round-6 holes and partly-closed items

| # | Sev | Status | Why |
|---|---|---|---|
| N1 append exemption past a pending checkpoint | S1 | **Closed** | The exemption is removed. Every change to the effective graph, appends included, is Maintainer-gated. |
| N2 approval bound to the head; graph edits not serialized | S1 | **Partly closed** | `approved_graph` binds the approval to the resolved graph. Retro items can't touch graph inputs. Planning units are serialized by `xarabot:graph` and by the overlap of the planning paths. Still open: package edges are part of the effective graph, but a mapped `package.json` is not a graph input. Two PRs that change package edges, one of them possibly a builder PR, can therefore both pass enqueue against the same `main` and close a cycle in the queue, which stops every lane. |
| N3 status re-keyed after a renumber; checkpoint retired after its go | S2 | **Closed** (as framed) | "Fixed once used" and "Retiring a checkpoint" settle both cases. The gap in what "used" means is new hole R2. |
| N4 runner-written go on a PR that agents review | S2 | **Closed** | `reconcile` PRs get no agent review and no agent loopback, and are regenerated on conflict. The write check covers only the agent session's own change. |
| H3 / M-3 a parked graph PR blocks retro and checkpoint; status files unenforced | S2 | **Closed** | Retro and checkpoint units no longer hold graph inputs. AD-30 refuses a diff that touches both a graph input and a status file. |
| H4 item 6, an Epic with no Stories | S2 | **Closed** | Such an Epic is never done and holds its dependents. |
| H5 two valid PRs combine in the queue | S2 | **Partly closed** | Closed for planning PRs. Open for package-edge PRs (see N2). |
| M-5 coordinator write scope | medium | **Partly closed** | Coordinator diffs are limited to the paths their unit holds, and retro-item globs exclude graph inputs and status files. Retro-item globs can still name `.github/**`, agent config or the Standing Authority file, which then needs only the owner's approval. |
| M-7 how planning produces graph entries | medium | **Closed** | A planning session edits `epics.yaml` in its diff, and the prompt template states the schema (AD-29). |
| Residual on N2/H5: package edges | S2 | **Fix** | Any PR whose merge result changes the resolved graph writes `xarabot:graph` into its ledger record before enqueue. The compare-and-swap then refuses a second one while the first is `merging` or held-`parked`. Alternatively, make the mapped `package.json` files graph inputs. |

## New holes

### R1 (S1 under one reading, S2 between builds; AD-11, AD-12): adding a Story to an Epic that has its retro verdict or go is not defined as a graph change, so post-go work can land in a checkpoint Epic unseen

**Units:** an ordinary `planning` unit (a correct-course or "add a Story" run) and the gates (AD-12).
**ADs obeyed:** AD-11 lists the changes that need approval as "edges, checkpoints, the Epic set or numbers, a manifest's `epic`". A new manifest has no prior `epic` to change, and the Epic set is unchanged. "Fixed once used" covers only renumbering and removal, not additions.

1. Epic 5 is a checkpoint. Its retro verdict and the Maintainer's go are recorded, and Epics 6 to 8 are running.
2. A planning PR adds `### Story 5.9:` and its manifest (`epic: 5`). Under the reading "the list above is exhaustive", this is not a graph change, so it needs no approval.
3. Epic 5 is "not done" again. Under AD-12, its dependents take no new claims until 5.9 merges. 5.9 is built and merged, and "retro done" is still true from the old verdict, so the dependents resume.

5.9 never had a retro and never reached the Maintainer at the checkpoint, and every dependent of the checkpoint now builds on it. A second build reads `approved_graph` as "the hash of the resolved graph", which includes each Epic's Stories (AD-11 defines them inside `resolveGraph`). That build treats the same PR as a graph change and parks it for the Maintainer. The two builds disagree on whether a Maintainer gate applies.

**Fix (AD-11, AD-12):** make an Epic's Story set part of the effective graph, so that adding or removing a manifest needs the Maintainer's approval. Make `approved_graph` hash exactly the fields that define a change. Also, an Epic with a retro verdict accepts no new Stories: such a PR parks blocked, and new work goes in a new Epic, which is a gated append. Alternatively, a Story added to such an Epic clears its retro verdict and its go.

### R2 (S2; AD-11, AD-3, AD-13): "Fixed once used" reads only `sprint-status.yaml` and `retro-gates.yaml`, and neither file records an in-flight Story

**Units:** a builder holding `story:7.2` (`claimed`, or `merging` with an open PR) and a Maintainer-approved `planning` PR that renumbers 7.2 to 7.3, or removes it.
**ADs obeyed:** AD-3 (the coordinator writes only "planned or done" to `sprint-status.yaml`, and builders never write it), AD-13 (builder eligibility does not read the `sprint-status.yaml` value), AD-11 ("Fixed once used" means a status beyond `backlog` or a `retro-gates.yaml` record).

The spine never says which value "planned" is. One build writes `backlog`, as stock `bmad-sprint-planning` does, and the Story counts as unused while its PR is open. The renumber merges. `next` then sees `story:7.3` with no record and gives it to a second builder, while `story:7.2`'s PR merges the same scope. Reconcile then has to mark done a `sprint_key` whose manifest is gone. A build that writes `ready-for-dev` freezes 7.2 instead and parks the planning PR. The same work is built twice under one build and blocked under the other.

**Fix (AD-11):** an Epic number or Story id is also fixed when the Story has a ledger record in any state, or a PR on its branch in any state. An Epic is fixed when any of its Stories is. State which `sprint-status.yaml` value "planned" writes.

### R3 (S2; AD-11): the pre-enqueue check and the stop-every-lane list may differ, so retiring a pending checkpoint parks under one build and stops every lane under another

**Units:** a Maintainer-approved `planning` PR that removes `checkpoint: true` from Epic 5 before its go, and the enqueue check (AD-11, AD-16).
**ADs obeyed:** AD-11 says only "an invalid graph parks the PR blocked" before enqueue. The `retro-gates.yaml` "awaiting a go the graph doesn't mark" item appears only in the stop-every-lane list. AD-13 and AD-30 forbid the gated PR from touching `retro-gates.yaml`.

Build A treats the retro-gates check as part of graph validity and parks the PR blocked. Build B checks only the graph and merges it, and then every lane stops. No agent may clear the awaiting mark. `reconcile` could clear it, but `reconcile` doesn't run while lanes are stopped. Only a human edit restarts the lanes. "Retiring a checkpoint" covers only a checkpoint whose go is recorded, so neither build is wrong.

**Fix (AD-11):** the pre-enqueue check runs every item of the stop-every-lane list on the merge result. A pending checkpoint can't be retired by a PR: the Maintainer records the go first, or `reconcile` clears the awaiting mark in the same runner-written step that applies the retirement.

## What holds

- One resolver, read from one SHA, with a strict schema and fail-closed reads.
- No agent writes, edits or removes a go. Only `reconcile`'s runner code applies it, from a ruling the Maintainer alone may issue. A missing go record means the dependents stay held.
- Planning-side graph changes run one at a time. Each one is bound by `approved_graph` to the graph the Maintainer approved, and its posted delta shows what each pending checkpoint holds.
- Package edges and default edges only ever add constraints, so on their own they can't release work past a checkpoint. Their only failure is the cycle in the residual above.
- Renumbering or removing an Epic or Story recorded in `sprint-status.yaml` or `retro-gates.yaml`, and the swap and retirement cases from round 6, are now settled.
