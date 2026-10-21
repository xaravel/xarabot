---
review: adversary-8
target: ../ARCHITECTURE-SPINE.md (uncommitted changes to AD-12, AD-14, AD-28, AD-29), spine .memlog.md (last 5 entries), SPEC.md constraint "No BMAD overrides"
prior: review-adversary-7.md
date: 2026-10-21
lens: one focused attempt at an S1 (an agent loosens a gate unseen) or an S2 (two units obey every AD yet diverge) in the no-override retro path only. Not re-litigated (Maintainer decisions): no BMAD overrides; the retro agent's blocking call stands, changed only by block/unblock rulings.
severity: S1 = an agent loosens a gate the Maintainer owns without the Maintainer seeing it; S2 = two units diverge.
evidence: stock .claude/skills/bmad-retrospective (SKILL.md, references/retro-document.md, scripts/sprint_status.py)
---

# Adversarial review, round 8: retro items without a BMAD override

## Verdict

**Moving result writing into the prompt is sound: a skill that stops early leaves no result, and that is a failed attempt, so it fails closed. The retro-gates.yaml path is not sound yet.** There are two writers of retro items. Item identity is undefined between the retro document, the result and retro-gates.yaml. The stock skill already writes a second copy of the items, with its own ids and statuses, into `sprint-status.yaml`. One S1 and three S2.

## Holes

### A1 (S1): agent diffs can still write retro items, so `block` rulings can be undone unseen (AD-3, AD-13, AD-30, AD-12)

- **Attack.** AD-12 now says `reconcile`'s runner code writes `retro-gates.yaml` from the retro result. But AD-3 still lists "coordinator" as the writer of retro verdicts and items. AD-13 still gives planning, retro and checkpoint units `retro-gates.yaml` as a held path. AD-30 refuses only a change to a checkpoint go. So any later coordinator session can change items for *any* Epic in its own diff. For example, a `planning:<slug>.n` session or the retro for Epic 10 can:
  - set item 9.2 from `blocking: true` to `false`;
  - move it to `deferred` or `done`;
  - delete it.
- **Why it matters.** This reverses a Maintainer `block` ruling. It also takes an open item out of the distance-2 gate. Coordinator PRs that touch neither a Protected Path nor the graph merge without the Maintainer. A retro session can also write items in its diff that disagree with its own result, which gives two writers of one fact.
- **Fix.**
  - AD-30 refuses any agent diff that changes a retro verdict or a retro item in `retro-gates.yaml`, as it already does for the go.
  - AD-3: the writer of verdicts and items becomes "`reconcile`'s runner code, from retro results, unit completions and rulings; never an agent session".
  - AD-13 keeps `retro-gates.yaml` held only so that writes are serialized.

### A2 (S2): retro-item ids are not tied to anything the retro writes (AD-12, AD-14, AD-28)

- **Attack.** The result's `items[]` has no `id`. `retro-item:<epic>.<n>` does not say where `n` comes from. One implementation numbers items by their position in the result array. Another uses the `n` that stock `sprint_status.py` puts into `epic-<N>-retro-item-<n>-<slug>`, the id in `sprint-status.yaml` and the retro document.
- **Why it matters.** The Maintainer reads the document and rules `/xarabot block retro-item:9.3`, and the two implementations apply that ruling to different items. A result can also leave out an item that the document and the diff list. Nothing compares them, so that item gates nothing, at any distance, and nobody sees it.
- **Fix.**
  - Add `id` to the retro result's items: the BMAD action-item id that the stock script appended in this session's diff.
  - `retro-item:<epic>.<n>` takes `n` from that id.
  - Before the squash, the runner refuses the result as invalid (a failed attempt) unless its items match, one to one by id, the `action_items` that the diff appended to `sprint-status.yaml`.

### A3 (S2): "reconcile writes from the result" names no carrier and no write-once rule (AD-12, AD-14, AD-28)

- **Attack.** The result lives in the retro lane's sandbox temp folder. `reconcile` is a later unit and may run on another lane. The spine does not say how the validated result reaches `reconcile`. One implementation keeps it in the retro's ledger record. Another puts it in the PR body. A third writes `retro-gates.yaml` into the retro PR as runner content.
- **Why it matters.** The spine also does not say whether `reconcile` writes the items once or re-derives them on every pass. If it re-derives them, every pass overwrites `blocking` tags that the Maintainer set with `block` or `unblock`. That reverts a ruling, which is S1 in effect.
- **Fix.**
  - The retro lane's runner stores the validated result in the retro unit's ledger record.
  - `reconcile` writes the verdict and items once, when it marks the retro done (before it deletes the record).
  - After that, only rulings and item-status transitions change an item.

### A4 (S2): the stock skill writes a second home for retro items, with its own status vocabulary (AD-3, AD-12)

- **Attack.** Stock `bmad-retrospective` appends every action item to `sprint-status.yaml` `action_items`, with `status: open` and a stable id. In headless mode it never passes `--set-action-status`, so those entries stay `open` forever. Their vocabulary is `open`, `in-progress` and `done`, with no `waiting` or `deferred`.
- **Why it matters.** AD-12 does not name the file that item statuses are read from. A gate or digest built on BMAD's list would therefore disagree with one built on `retro-gates.yaml`, and `bmad-sprint-planning` would show every item open for good.
- **Fix.** AD-3 names `sprint-status.yaml` `action_items` as BMAD's copy. It is written only by the retro session and read only for the A2 match. Gates, `next` and the digest read item status only from `retro-gates.yaml`.

## Checked and not a hole

- **A skill that stops early.** Stock retro headless "stop and report" paths leave no result, or no valid one. That is a failed attempt (AD-14), so the path fails closed.
- **A re-run retro.** `retro` is one-shot and done once its verdict is in `retro-gates.yaml` (AD-9). With A3's write-once rule, a rebuilt attempt before the merge cannot touch tags that the Maintainer set later.
