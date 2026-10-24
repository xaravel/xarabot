# Epic 2 Context: A coordinator lane and claims let builders run side by side

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Xarabot runs its own coordinator lane, held as a claim, that works `reconcile`, planning, retro and retro-item units. Claims gain heartbeat, fencing and stale takeover, so builder lanes on one or several hosts never build a unit twice or collide on globs. A write check stops any builder from writing coordinator-owned files, manifests, agent config or policy, and keeps coordinator sessions inside the paths their unit holds. Graph planning units change the Epic graph, so the graph-change gate lands here too. The Maintainer stops running sprint planning and queueing approved merges by hand.

## Stories

- Story 2.1: Heartbeat and fencing
- Story 2.2: Stale takeover
- Story 2.3: The 0.x write check
- Story 2.4: The coordinator lane and its claim
- Story 2.5: `reconcile` marks units done
- Story 2.6: `reconcile` enqueues approved PRs
- Story 2.7: Planning units
- Story 2.8: The graph-change gate
- Story 2.9: Retro units
- Story 2.10: Retro-item units
- Story 2.11: Several builder lanes on one host
- Story 2.12: Claims race verification

## Requirements & Constraints

- **Claims:** only the runner claims, by compare-and-swap on the claims branch. Overlapping globs are refused for every role, and a claim expires 30 minutes after its last heartbeat. In a race for one unit or for overlapping globs, exactly one lane wins.
- **One writer each:** the coordinator writes `sprint-status.yaml`. Only `reconcile` runner code writes `retro-gates.yaml` and deletes ledger records, and it deletes only `merged` records whose unit is done on `main`. Any other write is a defect.
- **Builder write check:** before the squash, the runner refuses a builder diff, computed from git objects in `runner.git`, that touches coordinator-owned files (`epics.md` included), manifests, `.xarabot/**`, the Standing Authority file, `.github/**`, agent config at any depth or Protected Paths. The only exceptions are the unit's own spec file (the single match of `story_spec_path`), the `status:` line of its own Story file, and an approved Infrastructure Story's Protected Paths, which never covers coordinator files, manifests or `.xarabot/**`. The runner reverts a builder's change to the Epic context file. A refusal parks the unit blocked (`write-check`) and is logged. Runner-written content is never checked.
- **Coordinator write check:** a coordinator diff may touch only paths its unit holds; only a graph planning unit may touch a graph input; under `.xarabot/**` only `epics.yaml`; never both a graph input and a status file. No agent diff may change a retro verdict, item or checkpoint go (enforced from the retro units Story, where sessions first touch retro records).
- **Graph approval:** a PR that changes the effective graph merges only with the Maintainer's approval, never with the bot owner's alone.
- **Limits still in force:** every path needs the Maintainer's approval and `XARABOT_MAX_BUILDERS=1` until Epic 3 merges. Until Story 4.6 lands, the Maintainer records a `rejected` retro's go by hand in a Maintainer PR.
- **Tests:** core code uses case tables with no mocks, time comes only from the snapshot's (forge's) `now`, and concurrency runs against the fake forge. Live cases need `XARABOT_LIVE=1`, and report skipped (never passed) without credentials or inside the sandbox.

## Technical Decisions

- **Heartbeat and fencing:** the lane swaps `heartbeat_at` every 5 minutes for `claimed` and builder-held `merging` records, through the session and the trailing wait. Before each push, PR change, enqueue or merge, a fencing swap must match its own `owner/host/lane` and `generation`; if it fails, the lane kills its agent by PID, pushes nothing and exits. If `rate-limited`/`transient` back-off would let the heartbeat lapse past 30 minutes, it releases the unit.
- **Takeover:** a stale `claimed` record is taken at `generation` + 1 and `attempts` + 1; the 3rd takeover parks it. A stale builder-held `merging` record becomes `merged` if its PR merged, can be taken over if still queued, else `released` with `attempts` + 1 and `pr` kept. `parked` never expires. The new holder adopts the open PR and fetches its head into `runner.git`. Coordinator-held `merging` records are checked by later `reconcile` runs, never by heartbeat.
- **Coordinator claim:** `coordinator.json`, identity `<owner>/<host>/coordinator`, heartbeated through units and waits. A different identity refuses to start while it is live; the same identity re-claims without a takeover. Missing or expired: builders keep building and post a deduplicated alert.
- **Coordinator `next` order:** `reconcile`, an open coordinator PR, planning (a graph unit before a status unit), retro, retro items, checkpoint, else `idle` with a reason. It never returns a Story, and builders never get coordinator units. No new planning unit while a coordinator PR is open.
- **When `reconcile` is due:** when the snapshot shows `reconcile` work (a non-`merged` record whose PR merged, a `merged` record whose unit is done on `main`, or the daily digest time passed), or 10 minutes have passed by the forge's `now` since the last run; otherwise later positions are considered. The last run time is the `heartbeat_at` of the highest-numbered `reconcile:<n>` record, stamped by `finishRecurring`; `reconcile` never deletes its newest record, so no ledger schema change. No such record means due.
- **Coordinator process steps:** the process takes an injected step per unit kind (as `ciStep`/`mergeStep` were in Epic 1). With no step for a kind, it does not claim the unit and ends `idle` with a reason naming the missing step.
- **Coordinator globs:** graph planning: graph inputs plus pseudo-glob `xarabot:graph`. Status planning: status files and the Epic context path. Retro: those plus `retro_doc_glob`. Checkpoint: status files and Epic context. Retro item: its own `globs`. `reconcile`: none. Only graph units hold graph inputs.
- **`reconcile`:** runs no agent session. It writes `merged` records and marks units done on `main` per kind, writes a merged graph unit's status entries and each retro verdict and its items once, and opens a runner-only PR with no agent review, regenerated on fresh `main` after a conflict or ejection. Nothing to commit: record `merged` with no PR, deleted at once, no inbox item. On the owner's approval of the current head it records `approved_sha`, re-checks the Standing Authority from fresh `main`, takes the record at `generation` + 1, fences, writes `merging` and enqueues with the expected head. An ejected gated PR parks with `approved_sha` cleared.
- **Planning units:** a status unit runs `bmad-sprint-planning` headless, compiles due Epic context files via stock `compile-epic-context.md`, and returns readiness findings in its `planning` result, never in a file. A graph unit edits manifests, `epics.md` and `.xarabot/epics.yaml` (asking for `depends_on`), and its PR needs the Maintainer's approval. Epics in `bootstrapped_epics` get neither.
- **Graph-change gate:** the runner runs `resolveGraph` and full validation on the merge result in `runner.git`. A graph-changing PR holds `xarabot:graph` (one at a time), gets its delta posted, and needs an approval whose `approved_graph` hash still matches against current `main` at enqueue. It parks blocked on validation failure, on renumbering or removing a used id, or on adding a Story to an Epic with a retro verdict.
- **Retro units:** run `bmad-retrospective -H <epic>` and ask for each item's `id`, `blocking`, `route` and `globs`. The runner validates items one to one against the `action_items` the diff appends and the verdict against the retro document's frontmatter; item globs may not include graph inputs, status files or write-check paths. A failed validation is a failed attempt.
- **Retro-item units:** only open items with globs and `route: lane`, on branch `<xarabot-namespace>retro-item-<id>`; no skill runs. `reconcile` marks a merged item `done`.
- **Builder lanes:** each has its own state folder, `runner.git`, clone, vendor home and launchd job; lane names unique per host and repo. `XARABOT_MAX_BUILDERS` caps builders across all repos on the host. The host-wide STOP stops every lane, coordinator included.

## Cross-Story Dependencies

- Epic 1 is in `bootstrapped_epics`. The Maintainer wrote Epic 2's manifests and its first context file at the self-host switch.
- Stories 2.1-2.3 (fencing, takeover, write check) underpin the coordinator and `reconcile` work. Story 2.4 stubs the `reconcile` step until 2.5 wires it.
- Later Stories add cases to Story 2.4's coordinator case table: 2.7, 2.9, 2.10 and 4.4. Coordinator write-check rules add rows to Story 2.3's table, and in Epic 3 each adapter adds rows.
- Until Story 2.8 lands, graph planning PRs rely on the every-path approval rule.
- `docs/maintainer/self-host.md` records the Maintainer's steps: once Stories 2.4 and 2.5 merge, advance `runner_version` to a tag with both, then install the coordinator lane (never before); after Story 2.6, stop queueing approved PRs by hand; run Story 2.12's live race suite before Epic 2's retro.
- Epic 4's gates and inbox read retro verdicts and items.
