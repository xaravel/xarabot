# Epic 2 Context: A coordinator lane and claims let builders run side by side

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Xarabot runs its own coordinator lane, held as a claim, that works `reconcile`, planning, retro and retro-item units, so the Maintainer stops running sprint planning and queueing approved PRs by hand. Heartbeat, fencing and stale takeover let builder lanes on one or several hosts share work without building a unit twice or colliding on globs. A write check keeps builders out of coordinator-owned files, manifests, agent config and policy, and keeps coordinator sessions inside their unit's paths. The graph-change gate makes every change to the Epic graph wait for the Maintainer's approval. The 2026-10-24 correct course inserted Stories 2.5a–2.5c, 2.6a and 2.6b.

## Stories

- Story 2.1: Heartbeat and fencing
- Story 2.2: Stale takeover
- Story 2.3: The 0.x write check
- Story 2.4: The coordinator lane and its claim
- Story 2.5: `reconcile` marks units done
- Story 2.5a: Resuming a blocked Story
- Story 2.5b: Host rulings and lane-stop exits
- Story 2.5c: Honest sandboxed sessions
- Story 2.6: `reconcile` enqueues approved PRs
- Story 2.6a: One session runner
- Story 2.6b: Epic 1 retro fixes
- Story 2.7: Planning units
- Story 2.8: The graph-change gate
- Story 2.9: Retro units
- Story 2.10: Retro-item units
- Story 2.11: Several builder lanes on one host
- Story 2.12: Claims race verification

## Requirements & Constraints

- **Claims:** only the runner claims, by compare-and-swap on the claims branch; overlapping globs are refused for every role; in a race exactly one lane wins. Time comes only from the forge's `now`.
- **One writer each:** only `reconcile`'s runner code writes status entries, retro verdicts, items and gos, and deletes ledger records. Agents never touch GitHub; data a session needs is prefetched into its temp folder.
- **Builder write check:** refuse a diff to status files, `epics.md`, manifests, `.xarabot/**`, the Standing Authority, `.github/**`, agent config at any depth (including `CLAUDE.local.md`, `AGENTS.override.md`), Protected Paths or live evidence files, comparing paths with full case folding. Allowed: the unit's own spec file, its Story file's `status:` line, and Protected Paths for an approved Infrastructure Story. The Epic context file change is reverted. A refusal parks `write-check`. Runner-written content is not checked.
- **Coordinator write check:** only paths the unit holds; only graph units touch graph inputs; under `.xarabot/**` only `epics.yaml`; never a graph input and a status file together; those files keep mode `100644`; no agent changes a retro verdict, item or go.
- **Limits in force until Epic 3 merges:** `XARABOT_MAX_BUILDERS=1` and approval on every path, except `reconcile` PRs. A `rejected` retro's go is recorded by hand until Story 4.6. `in-progress` is never written in 0.x.
- **Tests:** case tables, no mocks; concurrency on the fake forge. Live cases need `XARABOT_LIVE=1` and otherwise report skipped, never passed. A sandboxed `bun test` gives 0 fail.
- The 2026-10-24 Maintainer note on speed, tests and autonomy is input for a later correct course; do not implement it.

## Technical Decisions

- **Fencing and takeover:** heartbeat every 5 minutes; before any push, PR change, enqueue or merge, a swap must match own identity and `generation`, else kill the agent by PID and exit. Stale after 30 minutes: takeover at `generation` + 1, 3rd takeover parks. `parked` never expires. A re-claim with no open PR leases from `Forge.branchHead`.
- **Blocked resume:** a `done` result needs exactly one `done` spec match; `blocked` matches are superseded and dropped. Wip stays on the host (`refs/wip/<unit-file-id>`), never pushed; re-runs start from `main`.
- **Host rulings and exits:** `xarabot rule release|rebuild <unit-id>` is one fenced edit on a `parked` record. A lane-stop outcome counts as a failed start; the 3rd writes `STOP`. Unmapped 4xx is forge kind `rejected` and fails the attempt.
- **Coordinator:** claims `coordinator.json`; order is `reconcile`, open coordinator PR, planning (graph before status), retro, retro items, else `idle`. No checkpoint unit. Per-kind steps are injected. Idle wait is 10 minutes.
- **`reconcile` (no agent):** due on snapshot work or 10 minutes after the newest `merged` `reconcile:<n>` record. Its PRs hold only runner-written content: code-owner review, with the status files owner-less, means no owner approval; after CI passes it fences, writes `merging` and enqueues itself. While one is open, later runs do ledger work but open no PR. Disposable: an ejected, dequeued or conflicting one is closed and released with no attempt counted; the next run opens a fresh one from `main`. CI failure parks it, no agent fix.
- **Approved gated PRs (2.6):** on the owner's approval of the current head (`Forge.reviews`), re-check the Standing Authority from fresh `main`, take at `generation` + 1, fence, write `merging`, enqueue with the expected head. Ejected, dequeued or conflicting: re-park `awaiting-approval`, `approved_sha` cleared. A re-park (written by the coordinator lane) needs an approval submitted after it; a builder's first park accepts any owner approval on the current head. `park` fences on `generation` for any coordinator writer. A head that moved after the park is never auto-enqueued.
- **Planning (2.7):** a status unit runs `bmad-sprint-planning` headless and compiles due Epic contexts; `blocked` parks `readiness`, holding status units until released. A graph unit edits manifests, `epics.md`, `.xarabot/epics.yaml` and parks for approval. `bootstrapped_epics` get no planning or retro units.
- **Graph gate (2.8):** validate the merge result in `runner.git`; hold `xarabot:graph`; require a stored `approved_graph` hash matching current `main` at enqueue. New ledger fields and causes bump `schema_version`.
- **Retro (2.9):** due once every Story is `done` and the live evidence file is on `main`; validate items and verdict against stock BMAD output.
- **Several builders (2.11):** `builder-<n>` lanes, each with its own state and clone; `lane.lock` stops a second process.

## Cross-Story Dependencies

- Strictly serial: 2.1 → … → 2.5 → 2.5a → 2.5b → 2.5c → 2.6 → 2.6a → 2.6b → 2.7 → … → 2.12; one parked Story stops the chain.
- Merged code takes effect only after the Maintainer advances `runner_version`; the coordinator installs once 2.4 and 2.5 are in it.
- 2.6a's session runner serves 2.7, 2.9 and Epic 3's reviews. 2.7, 2.9 and 2.10 extend 2.4's case table; 2.6b drops its checkpoint rows. Until 2.8, graph PRs rely on the every-path approval rule.
- 2.12's live run, committed as `docs/maintainer/evidence/epic-2.md`, gates Epic 2's retro. Epic 4 reads retro verdicts and items.
