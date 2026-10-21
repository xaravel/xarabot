---
review: adversary-6
target: ../ARCHITECTURE-SPINE.md (uncommitted fixes to AD-3, AD-7, AD-11, AD-12, AD-13, AD-16, AD-20, AD-27, AD-28, AD-30, Deferred), spine .memlog.md (last 12 entries), spec diff (SPEC.md Repo policy and CAP-2, glossary, brownfield-xaravel.md)
prior: review-adversary-5.md, review-rubric-5.md, review-currency-5.md
date: 2026-10-21
lens: confirm the round-5 fixes; then try again to build two units that obey every AD and still diverge, or let work escape a checkpoint, through the new rules. Not re-litigated (Maintainer decisions): the graph lives in .xarabot/epics.yaml; serial default; the Maintainer (not the bot owner) approves effective-graph changes; a Story heading with no manifest is unclaimable and keeps its Epic not done.
severity: S1 = an agent passes a checkpoint or another gate the Maintainer owns; S2 = two units diverge, or the success path deadlocks or stops every lane; S3 = minor or test-level.
---

# Adversarial review, round 6: confirming the Epic graph fixes

## Verdict

**The round-5 holes are closed as they were framed, but the new gate is keyed on the wrong thing.** The resolver, the strict schema, the grammar, the Maintainer gate and the runner-only go all hold. Two of the new rules open fresh paths past a pending checkpoint. First, the "append above the highest Epic with default edges" exemption is unsafe whenever the highest Epic sits on a parallel branch. Second, the approval binds to a PR head, while what the Maintainer approved is a graph delta computed against one `main`, and graph edits from different units are not serialized. Two S2 seams follow from "approval-gated PRs never touch the status files" and from the go being runner-written but riding a normal coordinator PR.

Tally of the round-5 S1, S2, high and medium findings: **11 closed, 5 partly closed, 1 open.**

## Round-5 findings

### review-adversary-5

| # | Sev | Status | Why |
|---|---|---|---|
| H1 effective graph changes through ungated files | S1 | **Closed** (as framed) | `resolveGraph` runs on the merge result before enqueue. Edges, checkpoints, Epic numbers and a manifest's `epic` are all Maintainer-gated. Keys match `^[1-9][0-9]*$`, and a manifest's `epic` must equal its `story_id` prefix and its heading. The exemption the fix allowed is itself a hole (N1 below). |
| H2 any coordinator session can write the go | S1 | **Closed** | AD-3 and AD-28 make the go runner-code-only. AD-30 refuses any agent diff that changes a go, and validation stops lanes on a go for an unmarked Epic. |
| H3 owner-gated planning PR parks holding every planning path | S2 | **Partly closed** | Reconcile now holds no globs (no deadlock), and gated PRs skip the status files (no approval churn). Two gaps remain. Retro and checkpoint units still hold the full planning paths, `epics.md` and `.xarabot/epics.yaml` included (AD-13), so a parked graph PR still blocks every retro and checkpoint for the whole approval wait. And nothing enforces "never touch `sprint-status.yaml` or `retro-gates.yaml`". Stock planning skills do write `sprint-status.yaml`, so one build refuses such a PR and another strips the files. |
| H4 two loaders compute different graphs | S2 | **Partly closed** | Items 1 to 5 (missing file, omitted `depends_on`, grammar, torn reads, package-edge union) are closed. Item 6 is open: an Epic heading with no Story headings is still vacuously "all merged", and nothing says whether it needs a retro. |
| H5 a merged PR makes the graph invalid | S2 | **Partly closed** | Closed for a runner-enqueued PR checked against `main` at enqueue. Two PRs that are each valid against that `main` can still combine in the merge queue into a cycle or an unapproved change (N2). Human PRs are deferred to v1 explicitly. |

### review-rubric-5

| # | Sev | Status | Why |
|---|---|---|---|
| H-1 owner vs Maintainer approval, SPEC conflict | high | **Closed** | AD-16 adds a Maintainer-only rule for graph-changing PRs. SPEC Repo policy and the glossary entries for Protected Path and Epic graph file are amended. |
| H-2 Xaravel adoption never writes the graph file | high | **Closed** | brownfield-xaravel.md now lists `8: {depends_on: [7], checkpoint: true}`, and AD-11 validation catches a recorded go for an unmarked Epic. |
| M-3 gated planning PR blocks retro and checkpoint | medium | **Partly closed** | Same as adversary H3: retro and checkpoint units still hold `epics.md` and `epics.yaml`. |
| M-4 validation only after merge; `epics.md` edits loosen the graph | medium | **Closed** | The resolver runs pre-enqueue on the merge result, and renumbering or removing an Epic is gated. |
| M-5 any coordinator kind may write the graph | medium | **Partly closed** | `.xarabot/**` is limited to `epics.yaml`, and only from `planning`. Two gaps remain. Retro-item `globs` come from the retro agent unvalidated, so they can name `.github/**`, agent config or the Standing Authority file, which a coordinator diff may then touch. And a retro-item diff may write planning paths its unit does not hold (AD-30 "the planning paths and their unit's globs"). See N2. |
| M-6 raw vs resolved graph, absent vs failed, which SHA | medium | **Closed** | AD-11 defines one `resolveGraph`, AD-27 puts the resolved graph in the Snapshot, AD-20 makes absence the only exception, and everything is read from one `main` SHA. |
| M-7 how a planning session produces graph entries | medium | **Open** | No change. The `planning` result has no graph field, the prompt template has no planning section, and stock skills know nothing of `epics.yaml`. The prompt-template Story and the planning-unit Story can still pick different mechanisms. |

### review-currency-5

| # | Sev | Status | Why |
|---|---|---|---|
| F1 string keys vs integer `depends_on` and `epic` | high | **Closed** | Keys are canonical decimal and converted to numbers, `depends_on` holds integers, and `checkpoint` takes the literal `true` only. |
| F2 duplicate keys silently dropped | high | **Closed** | A raw-text scan finds duplicates, which make the file invalid. Multi-document files and a null `epics` are invalid. |
| F3 Epic List headings, `2.6a` Stories | medium | **Closed** | Level 2 or level 3 only, the `## Epic List` section is ignored, and the letter is kept in the id. One residual: the order of `2.6a` against `2.7` under "lowest Story number first" is not stated (S3). |
| F4 47 Xaravel headings with no manifest | medium | **Closed** | By Maintainer decision: unclaimable, listed in the inbox, the Epic is not done, and no lane stops. |
| F5 Xaravel ordering facts are prose | medium | **Closed** | The brownfield adoption inputs name the file, serial parity, and the two open adoption decisions. |

---

## New holes

### N1 (S1, AD-11): an appended Epic's default edge attaches to whatever Epic is highest, including a parallel branch past a pending checkpoint

**Units:** a `planning` unit that appends an Epic (ungated by the AD-11 exemption) and the gates (AD-12).
**ADs obeyed:** AD-11 ("Appending Epics above the current highest number, with default edges, needs no approval"; the default is "the next lower Epic number present").

On `main`, Epics 1 to 9 exist, and `epics.yaml` holds `5: {checkpoint: true}` and `9: {depends_on: [2]}`. The Maintainer approved Epic 9 as a side branch. Epics 6 to 8 depend on 5 and wait for its go. A planning PR appends `## Epic 10:` with Stories and no entry. Its default edge is 9, and 9 depends on 2, so Epic 10 runs at once, in parallel with the held 6 to 8 chain and past checkpoint 5. The PR changes no edge "for any Epic already on `main`", so the Maintainer never sees it. In the planner's (and stock BMAD's) reading, Epic 10 comes after Epic 8. The round-5 claim that appending "costs speed, never correctness" holds only when the highest Epic is downstream of every other Epic.

**Fix (AD-11):** the exemption applies only when the current highest Epic on `main` transitively depends on every other Epic on `main` (it is the unique sink), or, as a weaker form, on every checkpoint with no go recorded. Otherwise appending is Maintainer-gated like any other graph change.

### N2 (S1, AD-11, AD-16, AD-30): the approval binds to a head, not to the graph delta the Maintainer saw, and graph edits are not serialized

**Units:** a Maintainer-approved `planning` PR (parked, holding only its changed paths, AD-7), a `retro-item` coordinator PR, the enqueue check (AD-11, AD-16) and the merge queue.
**ADs obeyed:** AD-13 (a retro item holds only its own `globs`), AD-30 (a coordinator diff may touch the planning paths and its unit's globs, so a retro-item diff may edit `epics.md` and manifests it does not hold), AD-7 (the parked graph PR holds only `.xarabot/epics.yaml`), AD-16 (enqueue while the Maintainer's approval is on the current head).

1. On `main`, Epics 1 to 9 run serially, with `5: {checkpoint: true}` and no go yet.
2. Planning PR P sets `9: {depends_on: [2]}`. The runner posts the delta "Epic 9: 8 → 2", and the Maintainer approves Epic 9 as a side branch. P parks, holding only `epics.yaml`.
3. In the meantime a `retro-item` unit (no overlap with P) appends `## Epic 10:` with Stories. Checked against `main` without P, Epic 9 is the sink, so this is exempt even under N1's fix. It merges.
4. `reconcile` enqueues P. The approval is on P's head, which is unchanged. The recomputed delta against the new `main` still lists only Epic 9's direct edge. Epic 10's direct edge (→ 9) never changed.
5. After P merges, Epic 10 runs past checkpoint 5. Nobody saw Epic 10 in any graph diff.

The same race in the merge queue lets two PRs that are each valid against `main`, both approved, close a cycle together (for example a builder's package edge 3 → 7 and a planning PR's `7: {depends_on: [4]}`). That stops every lane after the merge, which is the round-5 H5 effect returning.

**Fix (AD-11, AD-16, AD-30, AD-4):**
- The posted delta includes, for each checkpoint with no go, the set of Epics it holds (transitively), as well as the direct edges. The runner records the delta's hash with `approved_sha`. Enqueue requires the delta recomputed against the current `main` to equal it. Otherwise the runner re-posts the delta and the PR waits for a fresh approval.
- A unit whose diff touches a graph input (`epics.md`, a manifest, `epics.yaml`, or a mapped `package.json`) also holds a pseudo-glob `xarabot:graph` while it is `claimed`, `merging` or held-`parked`. The ledger overlap check then serializes graph changes, and only one can be in the queue at a time.
- AD-30: a coordinator diff may touch a planning path only if its unit holds that path, so a retro item edits `epics.md` or manifests only through globs that say so.

### N3 (S2, AD-13, AD-11, AD-9): a gated renumber or removal can't touch the status files, so status keyed by Epic number re-attaches to other Epics

**Units:** a Maintainer-approved planning PR that renumbers or removes an Epic, or moves a Story (allowed by AD-11 with approval), `reconcile` (AD-13 "writes their status entries after the merge"), and the gates (AD-9, AD-12).
**ADs obeyed:** AD-13 (approval-gated coordinator PRs never touch `sprint-status.yaml` or `retro-gates.yaml`), AD-30 (no agent diff changes a go).

- **Swap.** The PR swaps Epics 4 and 5, which the Maintainer approves as "Epic numbers changed". `retro-gates.yaml` still holds Epic 4's retro verdict, and `sprint-status.yaml` still holds `epic-4` and `4-x` done entries. Both now attach to the Epic that used to be 5. Its dependents see "all Stories merged and retro done" for an Epic whose retro never ran. Reconcile is only told to write entries, not to re-key them, so one reconcile implementation re-keys and another doesn't. The gates then diverge for as long as the stale keys remain.
- **Checkpoint retired after its go.** An approved PR drops `checkpoint: true` from Epic 4 after its go was recorded. Pre-enqueue validation sees "a go for an Epic the graph doesn't mark" and parks the PR blocked. Agents may not change the go, and reconcile writes one only from a ruling, so no writer can clear it. Only a human PR that edits both files works, and if that lands, every lane stops until it does.

**Fix (AD-11, AD-13):** Epic numbers and Story ids are immutable once they have any status entry past backlog, or any record in `retro-gates.yaml`. Pre-enqueue validation parks a PR that renumbers, removes or moves such an Epic or Story, so renumbering is allowed only for Epics that have not started. Say how a checkpoint is retired after its go. For example, a go on an Epic whose mark was removed in a Maintainer-approved PR is valid and ignored, or reconcile retires the go when that PR merges.

### N4 (S2, AD-16, AD-19, AD-28, AD-30): the runner-written go rides an ordinary coordinator PR, and any agent session on that PR is refused

**Units:** `reconcile`, whose runner code writes the go into `retro-gates.yaml` in its own PR (AD-9: done when the PR merges), the review loop (AD-16 "Coordinator PRs follow the same rule"), conflict handling (AD-19) and the write check (AD-30).
**ADs obeyed:** AD-16 (every PR gets the cross-vendor review; a blocking finding starts an agent loopback), AD-19 (a non-status conflict is handed to an agent session), AD-30 (any agent diff that changes a go is refused).

If the reviewer posts a blocking finding on reconcile's PR, or a conflict falls outside the status-YAML rule, an agent session runs on the PR. AD-30 doesn't say whether "the diff" is that session's own change or the whole PR against `main`. Under the second reading it contains the go, so it is refused and the unit parks blocked. The Maintainer's go then never lands, and every dependent Epic waits until the Maintainer edits by hand. Under the first reading the session runs, and an agent has changed a PR that carries a go. Either way the two builds behave differently. The odds are low, but the seam is on the one gate the Maintainer owns.

**Fix (AD-16, AD-19, AD-30):** a `reconcile` PR carries only runner-generated edits. It gets no agent review and no agent loopback, because there is nothing agent-made to review. On a conflict or an ejection, reconcile closes the PR and regenerates its edits on fresh `main`. AD-30 defines its diff as the session's own change (clone start to working tree).

## Lower (S3, recorded only)

- **New Stories in an existing Epic.** AD-11 gates a change to "a manifest's `epic`". It doesn't say whether adding or removing a manifest in an Epic already on `main` is gated. One build gates almost every planning PR, and another lets Stories join a checkpoint Epic freely. Say which.
- **Duplicate Epic or Story headings.** Two `## Epic 10:` headings, for example from concurrent appends (N2), aren't in the validation list. One resolver merges them and another keeps the first. Add them to the stop-every-lane list or to the pre-enqueue park.
- **Two writers of `sprint-status.yaml` keys.** An ungated planning PR writes stock BMAD keys (title slugs), while reconcile writes entries for gated PRs from the manifests' `sprint_key`. Nothing checks that they agree. Validate that every manifest's `sprint_key` is a key in `sprint-status.yaml`.
- **Story order with a letter suffix.** Say whether `2.6a` comes before or after `2.7` under "lowest Story number first".

## What holds

- One resolver, read from one SHA. Absent is decided by the tree listing, and any read error fails closed.
- The strict schema: canonical keys, integer `depends_on`, the literal `true`, duplicate detection on the raw text.
- Maintainer-only approval for graph changes, with SPEC and the glossary amended to match.
- The go is never written by an agent, and a recorded go for an unmarked Epic stops lanes.
- Reconcile holds no globs, so the round-5 deadlock is gone.
