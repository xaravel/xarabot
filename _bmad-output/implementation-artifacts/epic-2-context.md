# Epic 2 Context: A coordinator lane and claims let builders run side by side

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Xarabot runs its own coordinator lane, held as a claim, that works `reconcile`, planning, retro and retro-item units. Claims gain heartbeat, fencing and stale takeover, so builder lanes on one or several hosts never build a unit twice or collide on globs. A write check stops any builder from writing coordinator-owned files, manifests, agent config or policy, and keeps coordinator sessions inside the paths their unit holds. Graph planning units change the effective Epic graph, so the graph-change gate lands here too. The Maintainer stops running sprint planning and queueing approved merges by hand. The 2026-10-24 course correction inserted five Stories: a blocked Story resumes cleanly, the Maintainer can release a parked unit with one host command, sandboxed sessions stop reporting false failures, the session machinery becomes one shared runner, and Epic 1's open retro items are fixed before coordinator sessions start. The builder limit stays at 1 until Epic 3 merges.

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

- **Claims:** only the runner claims, by compare-and-swap on the claims branch; each swap re-checks state, owner, generation and glob overlap against the fetched tip. Overlapping globs are refused for every role. A claim is stale 30 minutes after its last heartbeat. In a race for one unit or for overlapping globs, exactly one lane wins.
- **One writer each:** only the coordinator writes `sprint-status.yaml`. Only `reconcile`'s runner code writes retro verdicts, items and gos to `retro-gates.yaml` (it creates the file with `schema_version: 1` on first write; an absent file reads as empty) and deletes ledger records. Agents never touch GitHub; data a session needs (such as a retro's PRs) is prefetched into its temp folder.
- **Builder write check:** before the squash, the runner refuses a builder diff (read from git objects in `runner.git`) touching status files, `epics.md`, manifests, `.xarabot/**`, the Standing Authority file, `.github/**`, agent config at any depth (including `CLAUDE.local.md` and `AGENTS.override.md`), Protected Paths, or an Epic's live evidence file. Paths compare with full case folding, as APFS folds them. Exceptions: the Story's spec file, the `status:` line of its Story file, and Protected Paths for an approved Infrastructure Story (never coordinator files, manifests or `.xarabot/**`). The runner reverts a builder's change to the Epic context file. A refusal parks blocked (`write-check`). Runner-written content is never checked.
- **Spec file by status:** a `done` result needs exactly one `done` `story_spec_path` match; other matches must be `blocked`, are superseded and dropped from the squash; anything else is an invalid result (failed attempt). A `blocked` result parks whatever the matches.
- **Coordinator write check:** a coordinator diff touches only paths its unit holds; only a graph planning unit touches graph inputs; under `.xarabot/**` only `epics.yaml`; never both a graph input and a status file; status files and graph inputs keep mode `100644`. No agent diff may change a retro verdict, item or go.
- **Forge text:** the sanitizer redacts the vendor credential and token-shaped strings from agent `summary`/`body` and caps text below forge limits.
- **Graph approval:** a PR that changes the effective graph merges only with the Maintainer's approval on its current head, never the bot owner's alone.
- **Limits still in force:** every path needs the Maintainer's approval (except runner-written `reconcile` PRs) and `XARABOT_MAX_BUILDERS=1` until Epic 3 merges. Until Story 4.6, the Maintainer records a `rejected` retro's go by hand in a Maintainer PR. `in-progress` is never written in 0.x.
- **Tests:** core code uses case tables with no mocks; time comes only from the snapshot's (forge's) `now`; concurrency runs against the fake forge; a boundary test enforces module boundaries (no import cycles in `src/lane`). Live cases need `XARABOT_LIVE=1` and report skipped, never passed, without credentials or under `XARABOT_SANDBOXED=1`. A sandboxed `bun test` gives 0 fail, skipping cases that bind sockets or need access the profile denies. An intermittent failure is a bug to fix at its cause without weakening the assertion; the known one (`createGitMerger > fetches only the SHA runner.git lacks`, which ejected a PR from the merge queue) must pass 10 full-suite runs in a row after its fix.
- **Not yet a rule:** a 2026-10-24 Maintainer note (time over tokens, a deterministic definition of "flaky", deterministic guards for agent mistakes, provisional autonomy while offline) is raw input for a later course correction and changes nothing lanes do today. Do not implement it.

## Technical Decisions

- **Heartbeat and fencing:** `heartbeat_at` swaps every 5 minutes for `claimed` and builder-held `merging` records, through the session and trailing wait. Before each push, PR change, enqueue or merge, a fencing swap must match its own `owner/host/lane` and `generation`; on failure the lane kills its agent by PID, pushes nothing and exits. If forge back-off would let the heartbeat lapse past 30 minutes, release the unit.
- **Takeover:** a stale `claimed` record is taken at `generation` + 1, `attempts` + 1; the 3rd takeover parks it. A stale builder-held `merging` record becomes `merged` if its PR merged, may be taken over if still queued, else `released`. `parked` never expires. A new holder adopts the open PR (fetching its head into `runner.git` first); with no open PR it leases from the branch's real head (`Forge.branchHead`, Story 2.6b).
- **Blocked Story resume:** wip stays on the host (`refs/wip/<unit-file-id>`, journaled at park), never pushed; a re-run after release starts fresh from `main`.
- **Host rulings:** `xarabot rule release|rebuild <unit-id>`, run on the host as the lane user, is one fenced ledger edit on a `parked` record (`rebuild` also closes the PR and clears SHAs and providers). Other verbs wait for Story 4.6, which reuses the same pure edit.
- **Lane exits:** a lane-stop outcome exits non-zero and counts as a failed start; the 3rd in a row writes the lane's `STOP` and posts `lane-start-failed`. An unmapped 4xx or rule-refused push is forge error kind `rejected`, failing the unit's attempt. A host-local `lane.lock` stops a second process of one lane (it exits 0 without claiming). A `Halt` inside the usage-limit sleep ends the sleep.
- **Sessions:** `TMPPREFIX` (inside the session temp folder) is on the env allowlist. The lockfile regeneration launch carries no credential. Story 2.6a moves the session runner (prepare, sandboxed run, one resume, usage-limit sleep, kill 5 minutes after the result file appears, result parse) and step helpers into one `src/lane` module shared by the lane and coordinator processes, later by Epic 3's reviews; existing lane-process tests pass unchanged. `src/lane/` may read the clock and filesystem. A session whose reported model differs from the configured one fails its attempt.
- **Coordinator claim:** `coordinator.json` as `<owner>/<host>/coordinator`, heartbeated through units and waits. A different identity refuses to start while it is live; the same identity re-claims without a takeover. Missing or expired: builders keep building and post a deduplicated alert.
- **Coordinator `next` order:** `reconcile`, an open coordinator PR, planning (graph unit before status unit), retro, retro items, else `idle` with a reason. No checkpoint unit runs (`checkpoint:<epic>` is only a `go` target). Never a Story; builders never get coordinator units. No new planning unit while a coordinator PR is open. Unit kinds run through injected per-kind steps; a kind with no step is not claimed and `next` idles naming it. Idle wait is 10 minutes (builders: 30).
- **`reconcile` (no agent session):** due when the snapshot shows work or 10 minutes have passed (forge `now`) since the newest `merged` `reconcile:<n>` record. It writes `merged` records, marks units done on `main` per kind, writes a merged graph unit's status entries and each retro's verdict and items once, sets merged retro items `done`, and deletes finished and superseded records. Its PR holds only runner-written content, gets no review, loopback or CI fix, and needs no owner approval (code-owner review, with the status files owner-less). After CI passes it re-checks the Standing Authority, fences, writes `merging` and enqueues. Ejected, dequeued or conflicting `reconcile` PRs are closed and the record released (no attempt). It closes orphan PRs before releasing or deleting a record.
- **Approved held PRs (2.6):** on the owner's approving review (via `Forge.reviews`) on the current head, submitted after the park (versus the parked record's `heartbeat_at`), record `approved_sha`, re-check the Standing Authority from fresh `main` (missing or invalid: stay `parked`), take at `generation` + 1, fence, write `merging`, enqueue with the expected head. An ejected, dequeued or conflicting gated PR returns to `parked` with `approved_sha` cleared, holding only its diff's paths.
- **Planning units (2.7):** a status unit runs `bmad-sprint-planning` headless, compiles due Epic context files with stock `compile-epic-context.md`, and returns readiness findings in its `planning` result; `blocked` parks with cause `readiness` and holds further status units until released. A graph unit edits manifests, `epics.md` and `.xarabot/epics.yaml` and parks for approval. `bootstrapped_epics` get neither planning nor retro units. Nothing to commit: `merged` with no PR, deleted at once.
- **Graph-change gate (2.8):** run `resolveGraph` and full validation on the merge result in `runner.git`; failure parks blocked. A graph-changing PR holds `xarabot:graph` (one at a time), gets its delta posted, and needs a stored `approved_graph` hash that still matches current `main` at enqueue. Renumbering or removing a used id, or adding a Story to an Epic with a retro verdict, parks blocked.
- **Retro units (2.9):** due only once all Stories are `done` and the Epic's live evidence file (`live_evidence_glob`) is on `main`, else idle `waiting-on-maintainer`. Run `bmad-retrospective -H <epic>`, validate items one to one against `action_items` and the verdict against the retro's frontmatter; item globs exclude graph inputs, status files and write-check paths. Stored in `retro_result`.
- **Ledger schema:** the `readiness` cause, `approved_graph` and `retro_result` each bump the ledger `schema_version`.
- **Builder lanes (2.11):** names `builder-<n>`, each with its own state folder, `runner.git`, clone, vendor home and launchd job; install refuses if `claude`, `bun`, `git` or `uv` is missing on the plist `PATH`. `XARABOT_MAX_BUILDERS` counts builders across all repos on the host. The host-wide STOP stops every lane. A conflict applying the session onto `origin/main` is a CI-fix conflict session, not a failed attempt.

## Cross-Story Dependencies

- Epic 2 is strictly serial: 2.1 → … → 2.5 → 2.5a → 2.5b → 2.5c → 2.6 → 2.6a → 2.6b → 2.7 → … → 2.12. One parked Story stops the chain.
- The lane runs a pinned runner, so merged code takes effect only after the Maintainer advances `runner_version`. 2.6 stays parked until 2.5a–2.5c are in the runner; advances follow 2.6, 2.7, 2.8 and 2.9.
- 2.5a changed 2.3's write check and 2.5's `reconcile` step; 2.6b removes 2.4's checkpoint position and globs. 2.7, 2.9 and 2.10 add cases to 2.4's coordinator case table; coordinator rules add rows to 2.3's write-check table, and each Epic 3 adapter adds rows.
- 2.6a's session runner is reused by 2.7, 2.9 and Epic 3's review sessions. 2.7's `readiness` release uses 2.5b's `xarabot rule release`; Story 4.6 reuses its edit.
- Until 2.8 lands, graph planning PRs rely on the every-path approval rule.
- 2.12 writes the live race suite and evidence rows; the Maintainer commits the run as `docs/maintainer/evidence/epic-2.md`, which 2.9's retro gate waits for.
- Epic 4's gates and inbox read retro verdicts and items.
