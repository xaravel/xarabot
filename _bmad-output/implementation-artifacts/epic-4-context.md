# Epic 4 Context: Epics run in parallel behind retro and checkpoint gates, ruled from one inbox
<!-- source: sha256:bcfc1fa1c8f7f1fde52077921b54ae9c61aa7c7d89f325e32ed6c2aa66af69ce -->

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Epics start as soon as the dependency graph allows, not strictly in sequence. Retro items, rejected retros and checkpoints hold exactly the Epics they should and nothing more. Each owner sees everything waiting on them in one inbox issue, announced once a day, and rules on it by comment command, applied by runner code. The Epic ends with proof on a Xaravel-shaped graph that Epics run in parallel and that the gates hold, so a consuming repo can turn on parallel Epics with evidence.

## Stories

- Story 4.1: Retro-item distance gates
- Story 4.2: Owner inboxes and the daily digest
- Story 4.3: Batch routing of Maintainer-only retro items
- Story 4.4: Checkpoints
- Story 4.5: Rulings: grammar, authority and cursor
- Story 4.6: Rulings: what each verb does
- Story 4.7: Parallel Epics and gates verification

## Requirements & Constraints

- **Parallel Epics:** an Epic starts once every Epic it depends on has all its Stories `done` in `sprint-status.yaml` on `main` and its retro done (an Epic in `bootstrapped_epics` counts as both). Success case: after `runtime` and then `contracts`, the `macroable`, `conditionable` and `json-schema` Epics are in flight at once.
- **Distance gates:** distance is measured along dependency edges from Epic E. A `blocking` item holds every Epic at distance 1 or more, and any other open item holds distance 2 or more. `open`, `in-progress` and `waiting` count as open; `deferred` and `done` do not. A `rejected` retro verdict holds distance 1 or more until `go retro:<E>` is recorded. `accepted` and `accepted-with-open-items` hold nothing by themselves. The retro's `blocking` tag stands unless the Maintainer changes it with a ruling.
- **Checkpoints:** a checkpoint Epic whose retro is done holds all its transitive dependents until the Maintainer's go. Epics that don't depend on it keep running, and Epics in flight finish the Stories they hold but take no new ones. A checkpoint added late holds from the next claim. A checkpoint may be retired only once its go is recorded, and the go record stays.
- **Gate changes take effect at the next claim.** An already-claimed Story finishes. An idle reason names the item, the rejected retro or the checkpoint.
- **Inbox:** one inbox per owner, so a solo repo has one list. It shows the bot's PRs awaiting approval and blocked units, each with its link, its age and the ruling verbs that apply. The Maintainer's inbox also shows:
  - checkpoint gos and Infrastructure approvals;
  - Maintainer-routed retro items;
  - rejected retros, with their course-correction item and `go retro:<N>`;
  - graph-changing PRs;
  - unclaimable Story headings outside `bootstrapped_epics`;
  - Human Live Step waits;
  - open Escalations;
  - each `deferred` entry of a merged Story spec, until a later spec names it.
- **Notices:** there is one daily digest mention per inbox and no other per-item notice. The only exception is the immediate alert for a condition that newly stops every lane.
- **Journal:** a lane idle only because of something the Maintainer must do records the span as `waiting-on-maintainer`. That means a checkpoint go, a parked approval, a rejected retro, a Maintainer-routed item or an Epic's live evidence.
- **No agent session** routes items, renders the digest or applies a ruling. The write check still refuses any agent diff that changes a verdict, an item or a go.
- **Tests:** core logic uses case tables with no mocks, including the FR10 table, the due-rule table, ruling verbs × author classes × malformed forms, and the checkpoint shapes. Forge behaviour passes the contract suite on both the fake and the GitHub adapters. Live cases need `XARABOT_LIVE=1`, and inside a sandboxed session they report skipped, never passed.

## Technical Decisions

- **Gates are pure:** gates and `next` read only `resolveGraph(snapshot)`'s output and `retro-gates.yaml` from the same `main` SHA. `checkpoint: true` comes only from `.xarabot/epics.yaml`, and checkpoints are never inferred. No `checkpoint` unit ever runs: `checkpoint:<epic>` is only the target of a `go`.
- **`retro-gates.yaml`:** `schema_version: 1` and an `epics` map keyed by Epic number. Each Epic holds:
  - a `retro` record: `verdict`, `unit`, `recorded_at`, and for a rejected verdict a `go` {`by`, `at`, `ruling`}. A go written by hand before Story 4.6 carries `ruling: maintainer-pr`.
  - `items`: `id`, `text`, `route`, `blocking`, `globs`, `status`. `in-progress` is never written in 0.x.
  - a `checkpoint` record holding its `go`. A checkpoint Epic with no record is awaiting its go.

  Only `reconcile`'s runner code writes the file, and it is the authoritative tracker for retro items. The `action_items` in `sprint-status.yaml` are the retro skill's copy and are not reconciled.
- **Inbox issue:** one `xarabot-inbox`-labelled issue per owner, assigned to them, found or created on first need. Only the Maintainer's is pinned, by hand, as a Human Live Step. `renderDigest` builds the body from `parked` records, PR states, `retro-gates.yaml` and open Escalations, and rewrites it only when the content changed, because a body edit sends no notification. The daily mention comment goes out on the first `reconcile` at or after config `digest_time` (default `08:00` UTC). Its time is recorded in `coordinator.json`, and a passed digest time with no digest posted counts as `reconcile` work in the due rule.
- **Park text:** a unit parked `blocked` with text stores it sanitized and capped below the forge's limit in `park.text`. That bumps the ledger `schema_version` by one, and every lane's runner pin advances together.
- **Maintainer-routed retro items:** `reconcile` sets them to `waiting` in the same runner-written PR that writes the retro. `next` never returns them as `retro-item` units.
- **Rulings:** `/xarabot <verb> <unit-id>` on an inbox issue with a well-formed unit id. Other text is ignored.
  - Verbs and authority: `go`, `approve`, `block`, `unblock`, `done` and `defer` count only from the Maintainer named in config. `rebuild`, `release` and `dismiss` count from the item's owner or the Maintainer.
  - `go` applies to a `checkpoint:<epic>`, or to a `retro:<epic>` whose verdict is `rejected`. `done` and `defer` apply only to a `retro-item:<id>`.
  - `reconcile` reads new comments through `Forge.readRulings(cursor)`. The cursor lives in `coordinator.json` and advances in the same ledger swap that applies the rulings.
  - Every ruling gets a 🤖 reply. A valid one is acknowledged. A malformed, unauthorized or mis-targeted one changes nothing, and the reply gives the reason.
- **Verb effects:**
  - `go` records the go in `retro-gates.yaml`.
  - `approve` records `approval` {Maintainer login, current `manifest_sha`} and releases the record. A later manifest change voids it.
  - `block` and `unblock` flip the item's `blocking` tag.
  - `release` resets `attempts`, `loopbacks` and `ci_fixes` and keeps `builder_providers[]`.
  - `rebuild` also closes the open PR and clears `reviewed_sha`, `passed_sha` and `builder_providers[]`.
  - `dismiss` removes only the inbox item.
  - `done` and `defer` set the item's status to `done` or `deferred`.
  - `xarabot rule <verb> <unit-id>` on the host applies every verb with the same edit.

## Cross-Story Dependencies

- 4.1 and 4.2 build on the retro-item units (Story 2.10). 4.3 and 4.4 need both. 4.5 needs 4.2. 4.6 needs 4.3, 4.4 and 4.5. 4.7 comes last.
- Story 4.7 records its live command and the expected scratch-repo results in `docs/maintainer/self-host.md`. The Maintainer runs them on the host before Epic 4's retro. From Epic 4 on, `live_evidence_checks` in `.xarabot/config.yaml` lists those commands, so a failed live row holds the retro.
- Epic 3's retro was rejected and the Maintainer's go is recorded, so Epic 4 may start. Its items 1 (reap session processes, isolate review passes) and 2 (codex live re-run, Maintainer-routed) are still open and `blocking`. Once Story 4.1's gates take effect, they hold Epic 3's dependents, Epic 4 included, until they close.
- Until the switch after Epic 3, there is one builder, and every path needs the Maintainer's approving review except `reconcile` PRs.
- Open retro items touch nearby code: `reconcile` PR hygiene, coordinator claim fencing, planning attempts, reviewer CLI checks, the passed gate across repeated `main` merges, the review cap and the review plumbing. Check `retro-gates.yaml` for their globs.
- Merged code takes effect only after the Maintainer advances `runner_version`.
