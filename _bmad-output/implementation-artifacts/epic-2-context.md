# Epic 2 Context: A coordinator lane and claims let builders run side by side

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Xarabot runs its own coordinator lane, held as a claim, that works `reconcile`, planning, retro and retro-item units. Claims gain heartbeat, fencing and stale takeover, so builder lanes on one or several hosts never build a unit twice or collide on globs. A write check stops any builder from writing coordinator-owned files, manifests, agent config or policy, and keeps coordinator sessions inside the paths their unit holds. Graph planning units change the effective Epic graph, so the graph-change gate lands here too. The Maintainer stops running sprint planning and queueing approved merges by hand. The builder limit stays at 1 until Epic 3 merges.

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

- **Claims:** only the runner claims, by compare-and-swap on the claims branch; each swap re-checks state, owner, generation and glob overlap against the fetched tip. Overlapping globs are refused for every role. A claim is stale 30 minutes after its last heartbeat. In a race for one unit or for overlapping globs, exactly one lane wins.
- **One writer each:** only the coordinator writes `sprint-status.yaml`. Only `reconcile`'s runner code writes retro verdicts, items and gos to `retro-gates.yaml`, and deletes ledger records: `merged` records whose unit is done on `main`, and superseded `released` `reconcile:<n>` records. Any other write is a defect.
- **Builder write check:** before the squash, the runner refuses a builder diff (computed from git objects in `runner.git`) touching `sprint-status.yaml`, `retro-gates.yaml`, `epics.md`, manifests, `.xarabot/**`, the Standing Authority file, `.github/**`, agent config at any depth or Protected Paths. Exceptions: the unit's own spec file (the single `story_spec_path` match), the `status:` line of its own Story file, and Protected Paths for an approved Infrastructure Story (never coordinator files, manifests or `.xarabot/**`). The runner reverts a builder's change to the Epic context file. A refusal parks the unit blocked (`write-check`) and is logged. Runner-written content is never checked.
- **Coordinator write check:** a coordinator diff touches only paths its unit holds; only a graph planning unit touches graph inputs; under `.xarabot/**` only `epics.yaml`; never both a graph input and a status file. No agent diff may change a retro verdict, item or go (rows added in the retro units Story).
- **Graph approval:** a PR that changes the effective graph merges only with the Maintainer's approval on its current head, never the bot owner's alone.
- **Limits still in force:** every path needs the Maintainer's approval (except `reconcile` PRs) and `XARABOT_MAX_BUILDERS=1` until Epic 3 merges. Until Story 4.6, the Maintainer records a `rejected` retro's go by hand in a Maintainer PR.
- **Tests:** core code uses case tables with no mocks; time comes only from the snapshot's (forge's) `now`; concurrency runs against the fake forge. Live cases need `XARABOT_LIVE=1` and report skipped, never passed, without credentials or when `XARABOT_SANDBOXED=1`.

## Technical Decisions

- **Heartbeat and fencing:** swap `heartbeat_at` every 5 minutes for `claimed` and builder-held `merging` records, through the session and trailing wait. Before each push, PR change, enqueue or merge, a fencing swap must match its own `owner/host/lane` and `generation`; on failure the lane kills its agent by PID, pushes nothing and exits. If `rate-limited`/`transient` back-off would let the heartbeat lapse past 30 minutes, release the unit.
- **Takeover:** a stale `claimed` record is taken at `generation` + 1, `attempts` + 1; the 3rd takeover parks it. A stale builder-held `merging` record becomes `merged` if its PR merged, may be taken over if still queued, else `released` with `attempts` + 1 and `pr` kept. `parked` never expires. A new holder adopts the open PR, fetching its head into `runner.git` first. Coordinator-held `merging` records have no heartbeat and are checked only by later `reconcile` runs.
- **Coordinator claim:** `coordinator.json` as `<owner>/<host>/coordinator`, heartbeated through units and waits. A different identity refuses to start while it is live; the same identity re-claims without a takeover. Missing or expired: builders keep building and post a deduplicated alert.
- **Coordinator `next` order:** `reconcile`, an open coordinator PR, planning (graph unit before status unit), retro, retro items, checkpoint, else `idle` with a reason. Never a Story; builders never get coordinator units. No new planning unit while a coordinator PR is open.
- **`reconcile` due rule:** due when the snapshot shows work (a non-`merged` record whose PR merged, or a `merged` record whose unit is done on `main`) or 10 minutes have passed by the forge's `now` since the last run; otherwise later positions are considered. A passed digest time is not work until Story 4.2 adds it back. The last run time is the `heartbeat_at` of the newest `merged` `reconcile:<n>` record (stamped by `finishRecurring`); no such record means due. No ledger schema change.
- **Coordinator idle wait:** 10 minutes, matching the due rule; builders keep 30 minutes.
- **Coordinator process steps:** an injected step per unit kind (like Epic 1's `ciStep`/`mergeStep`). With no step for a kind, it does not claim the unit and ends `idle` naming the missing step.
- **Coordinator globs:** graph planning: graph inputs plus pseudo-glob `xarabot:graph`. Status planning: both status files and the Epic context path. Retro: those plus `retro_doc_glob`. Checkpoint: status files and Epic context. Retro item: its own `globs`. `reconcile`: none.
- **`reconcile` (no agent session):** writes `merged` records; marks units done on `main` per kind (Story `done` in `sprint-status.yaml`, retro verdict, item `done`, checkpoint go; planning/`reconcile` when the PR merged); writes a merged graph unit's status entries and each retro's verdict and items once; deletes `merged` records whose unit is done. Its PR holds only runner-written content: no agent review, no loopback, no agent CI fix, and it is exempt from `owner_approval_paths` (the Standing Authority names this). After CI passes the runner re-checks the Standing Authority, fences, writes `merging` and enqueues it. It polls CI like a builder; an unexpected failure parks it `blocked` (`verification`), the CI max wait parks it `ci-timeout`.
- **Disposable `reconcile` PRs:** ejected, dequeued or conflicting: dequeue if needed, close, release the record with no attempt. The next due run deletes that `released` record and opens a fresh PR from fresh `main` on its own record and branch (one record, one PR). While an earlier `reconcile` PR is still open, a run does the ledger work but opens no new PR. Later runs delete superseded `released` `reconcile:<n>` records; `parked` ones stay until their inbox item is resolved. Nothing to commit: the record becomes `merged` with no PR, no inbox item, and is kept as the newest; the one it replaces is deleted, so at most one `merged` `reconcile:<n>` remains.
- **Approved held PRs (Story 2.6):** on the owner's approval of the current head, record `approved_sha`, re-check the Standing Authority from fresh `main` (missing or invalid: stop, stay `parked`), take at `generation` + 1, fence, write `merging`, enqueue with the expected head. An approval on an older head does nothing. An ejected or dequeued gated PR returns to `parked` with `approved_sha` cleared, holding only its diff's paths.
- **Planning units:** a status unit runs `bmad-sprint-planning` headless, compiles due Epic context files via stock `compile-epic-context.md`, and returns readiness findings in its `planning` result, never in a file. A graph unit edits manifests, `epics.md` and `.xarabot/epics.yaml` (asking for `depends_on`) and parks for the Maintainer's approval; `reconcile` writes its status entries after merge. Epics in `bootstrapped_epics` get neither planning nor retro units. A recurring planning unit with nothing to commit becomes `merged` with no PR and is deleted at once.
- **Graph-change gate:** run `resolveGraph` and full validation on the merge result in `runner.git`; failure parks blocked (`graph-invalid`). A graph-changing PR holds `xarabot:graph` (one at a time), gets its delta posted, and needs an `approved_graph` hash that still matches against current `main` at enqueue. Renumbering or removing a used id, or adding a Story to an Epic with a retro verdict, parks blocked.
- **Retro units:** `bmad-retrospective -H <epic>`, then ask for each item's `id`, `blocking`, `route`, `globs`. Validate items one to one against the `action_items` the diff appends and the verdict against the retro document's frontmatter; item globs may not include graph inputs, status files or write-check paths. Failed validation is a failed attempt.
- **Retro-item units:** open items with globs and `route: lane` only, on branch `<xarabot-namespace>retro-item-<id>`; no skill runs; `reconcile` marks a merged item `done`.
- **Builder lanes:** each has its own state folder, `runner.git`, clone, vendor home and launchd job; names unique per host and repo. `XARABOT_MAX_BUILDERS` counts builders across all repos on the host. The host-wide STOP stops every lane, coordinator included.

## Cross-Story Dependencies

- Epic 1 is in `bootstrapped_epics`; the Maintainer wrote Epic 2's manifests and first context file at the self-host switch.
- Stories 2.1-2.3 underpin the coordinator and `reconcile`. Story 2.4 stubs the `reconcile` step until 2.5 wires it. Stories 2.7, 2.9, 2.10 and 4.4 add cases to 2.4's coordinator case table; coordinator write-check rules add rows to 2.3's table, and each Epic 3 adapter adds rows.
- Story 2.5 relies on Epic 1's CI polling (1.17) and merge-queue plumbing; Story 4.2 restores the digest condition in the due rule.
- Until Story 2.8 lands, graph planning PRs rely on the every-path approval rule.
- `docs/maintainer/self-host.md` steps: once 2.4 and 2.5 merge, tag a `main` commit with both and advance `runner_version`, then install the coordinator lane (never before); after 2.6, stop queueing approved PRs by hand; run 2.12's live race suite before Epic 2's retro.
- Epic 4's gates and inbox read retro verdicts and items.
