# Epic 2 Context: A coordinator lane and claims let builders run side by side

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Xarabot runs its own coordinator lane, held as a claim, that works `reconcile`, planning, retro and retro-item units. Claims gain heartbeat, fencing and stale takeover, so builder lanes on one or several hosts never build a unit twice or collide on globs. A write check stops any builder from writing coordinator-owned files, manifests, agent config or policy. Graph planning units change the Epic graph, so the graph-change gate lands here too. The Maintainer stops running sprint planning and queueing merges by hand.

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

- **Claims:** only the runner claims, by compare-and-swap on `xarabot/claims`. Overlapping globs are refused, and a claim expires 30 minutes after its last heartbeat. In a race for one unit or for overlapping globs, exactly one lane wins.
- **One writer each:** the coordinator writes `sprint-status.yaml`. Only `reconcile` runner code writes `retro-gates.yaml` and deletes ledger records, and it deletes only `merged` records whose unit is done on `main`.
- **Write check:** before the squash, the runner refuses a builder diff that touches coordinator-owned files (`epics.md` included), manifests, `.xarabot/**`, the Standing Authority file, `.github/**`, agent config at any depth or Protected Paths. The only exceptions are the unit's own spec file (the single match of `story_spec_path`), the `status:` line of its own Story file, and an approved Infrastructure Story's Protected Paths. That last exception never covers coordinator files, manifests or `.xarabot/**`. A refusal parks the unit blocked (`write-check`) and is logged.
- **Graph approval:** a PR that changes the effective graph merges only with the Maintainer's approval, never with the bot owner's alone.
- **Limits still in force:** every path needs the Maintainer's approval and `XARABOT_MAX_BUILDERS=1` until Epic 3 merges. Until Story 4.6 lands, the Maintainer records a `rejected` retro's go by hand in a Maintainer PR.
- **Tests:** core code uses case tables with no mocks, and concurrency runs against the fake forge. Live cases need `XARABOT_LIVE=1` and otherwise report skipped.

## Technical Decisions

- **Heartbeat and fencing:** the lane swaps `heartbeat_at` every 5 minutes, through the session and the trailing wait. Before each push, PR change, enqueue or merge, it runs a fencing swap that must match its own `owner/host/lane` and `generation`. If the fence fails, the lane kills its agent by PID, pushes nothing and exits. If back-off would let the heartbeat lapse, the lane releases the unit.
- **Takeover:** a lane may take over a stale `claimed` record at `generation` + 1 and `attempts` + 1. The 3rd takeover parks the unit instead. A stale builder-held `merging` record becomes `merged` if its PR merged, can be taken over if the PR is still queued, and is otherwise `released` with `attempts` + 1. `parked` records never expire. Time comes only from the forge's `now`. The new holder adopts the open PR and fetches its head into `runner.git`.
- **Coordinator claim:** the claim lives in `coordinator.json` as `<owner>/<host>/coordinator`. While the claim is live, a coordinator with a different identity refuses to start. If the claim is missing or expired, builders keep building and post an alert.
- **Coordinator `next` order:** `reconcile`, an open coordinator PR, planning (a graph unit before a status unit), retro, retro items, then checkpoint. It never returns a Story.
- **Coordinator globs:** a graph planning unit holds the graph inputs and `xarabot:graph`. Status planning and retro units hold the status files and the Epic context path, plus `retro_doc_glob` for retro. A retro item holds its own `globs`, and `reconcile` holds none. A coordinator diff may touch only what its unit holds, never both a graph input and a status file, and never a retro verdict, item or go.
- **`reconcile`:** runs no agent session. It writes `merged` records and marks units done, including a graph unit's status entries and each retro verdict and its items. Its runner-only PR gets no agent review and is regenerated on fresh `main` after a conflict. When the owner approves the current head, it re-checks the Standing Authority, takes the record at `generation` + 1, fences, writes `merging` and enqueues.
- **Planning units:** a status unit runs `bmad-sprint-planning` headless, compiles due Epic context files, and returns readiness findings in its result. A graph unit edits manifests, `epics.md` and `.xarabot/epics.yaml`, and its PR needs the Maintainer's approval.
- **Graph-change gate:** the runner validates `resolveGraph` on the merge result in `runner.git`. A graph-changing PR holds `xarabot:graph`, gets its delta posted, and needs an approval whose `approved_graph` hash still matches at enqueue. It parks blocked on a validation failure, on renumbering or removing a used id, or on adding a Story to an Epic with a retro verdict.
- **Retro units:** run `bmad-retrospective -H <epic>`. The runner then validates the result: each item must match an action item the diff appends, one to one, and the verdict must match the retro document. A failed validation counts as a failed attempt. Epics in `bootstrapped_epics` get no retro unit.
- **Builder lanes:** each lane has its own state folder, `runner.git`, clone, vendor home and launchd job. `XARABOT_MAX_BUILDERS` caps the builder count across all repos on the host. The host-wide STOP stops every lane, the coordinator included.

## Cross-Story Dependencies

- Epic 1 is in `bootstrapped_epics`. The Maintainer wrote Epic 2's manifests and this context file at the self-host switch.
- Later Stories add cases to Story 2.4's coordinator case table: 2.7, 2.9, 2.10 and 4.4. In Epic 3, each adapter adds rows to Story 2.3's write-check table.
- Until Story 2.8 lands, graph planning PRs rely on the rule that every path needs the Maintainer's approval.
- `docs/maintainer/self-host.md` records the Maintainer's steps. Once Stories 2.4 and 2.5 merge, advance `runner_version` to a tag with both and install the coordinator lane. After Story 2.6, stop queueing approved PRs by hand. Run Story 2.12's live race suite before Epic 2's retro.
- Epic 4's gates and inbox read retro verdicts and items.
