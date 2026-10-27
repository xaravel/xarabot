---
title: 'Story 4.2: Owner inboxes and the daily digest'
type: 'feature'
created: '2026-10-26'
status: 'done'
baseline_revision: '60238eeea14e008f9f6a6d183ca673c51a614356'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Nothing tells an owner what waits on them. The forge has no inbox body, `reconcile` posts no digest, and the due rule leaves out the digest time. A blocked unit's text lives only in the journal, and a builder idling only for the Maintainer writes a plain `idle` span (FR9, AR24, AR25).

**Approach:**
- Add inbox operations to the forge port: list every inbox, find or create one, set its body, and comment on it.
- Add a pure `renderDigest` that builds one body per owner from the snapshot and `main`'s Story specs.
- At the end of each `reconcile` run, add a runner step that rewrites changed bodies, clears stale ones, and once a day stamps `digest_posted_at` and then mentions each non-empty inbox.
- Store the sanitized `park.text` (ledger v6).
- Prefix the builder's idle reason with `waiting-on-maintainer: ` when every reason it idles for is a Maintainer cause.

## Boundaries & Constraints

**Always:**

The inbox issue:
- An owner's inbox is the lowest-numbered open issue labelled `xarabot-inbox` and assigned to them. It is created, titled `🤖 Xarabot inbox`, only when an owner with items has none. This is the same issue the alerts use.

What each owner's inbox lists:
- Records parked `awaiting-approval` or `blocked` go to the owner in their `park.inbox_owner`.
- Every `needs-approval` record and every `blocked` `human-live-step` record goes to the Maintainer (`config.maintainer`).

What the Maintainer's inbox also lists:
- Waiting checkpoint gos: an Epic in `graph.checkpoints` whose retro is recorded, with no `checkpoint.go`.
- Open retro items with `route: maintainer`.
- Rejected retros with no go, each naming its open Maintainer-routed items as its course-correction items.
- `graph.unmanifested` headings outside `bootstrapped_epics`.
- Each unresolved deferred entry of a Story spec on `main`.

How items render:
- Each item shows a link, an age in whole days (`<1d` under a day), and its fixed verb only:
  - `/xarabot go checkpoint:<N>`
  - `/xarabot go retro:<N>`
  - `/xarabot done|defer retro-item:<id>`
  - `/xarabot approve <unit>` for `needs-approval`
  - none for the other kinds.
- A blocked item with `park.text` shows it under the item.
- Rendering is deterministic: sections in a fixed order, items sorted, no wall-clock text other than the day ages. The body is capped at `FORGE_TEXT_LIMITS.body` and never @-mentions anyone.

Deferred entries:
- The id of entry `n` (1-based) in spec S is its `id` key, or `<S's story id>-d<n>`.
- An entry is resolved when another Story spec on `main` lists that id in its frontmatter `resolves`.
- Spec files are the `main` paths matching `story_spec_path` with `<epic>` and `<story>` widened. The story id comes from the file name (`spec-4-1-…` gives `4.1`).
- A spec whose frontmatter does not parse is skipped, and the run logs it.

The inbox step:
- It runs in every `reconcile` run after the ledger work, from the run's snapshot.
- It enumerates every inbox and rewrites a body only when it differs, so an owner with no items is cleared to the empty text.
- When `digestDue(now, digest_time, digest_posted_at)`, it first makes a fenced `coordinator.json` edit setting `digest_posted_at` to the forge time. That edit refuses if the stamp is already at or after today's slot.
- Only after a successful stamp does it post one comment per non-empty inbox: `@<owner>`, the item count and the issue link. Empty inboxes get none.
- Forge errors in the step are logged and skipped. They never fail or stop the run, and a failed post is never retried that day.

Park text:
- A park from a build result's `blocked.text` (builder, retro-item and CI-fix sessions) or from a planning unit's readiness summary stores `park.text`. The text goes through `sanitizeAgentText`, using the lane's known secrets where it has them, and is capped at `PARK_TEXT_MAX` (4 000).
- This bumps `LEDGER_SCHEMA_VERSION` to 6. v1–v5 records still read.

The due rule:
- A passed digest slot with no digest posted counts as `reconcile` work.

The builder's idle reason:
- It takes the prefix only when the reasons are non-empty and every one is a Maintainer cause:
  - `retro-rejected`;
  - a `retro-item` hold by a `route: maintainer` item;
  - `record-state` for a record parked `awaiting-approval` or `needs-approval`, or a stale Infrastructure record without approval.

**Never:**
- No rulings, cursor or 🤖 replies (Stories 4.5/4.6); no routing of items to `waiting` (4.3); no checkpoint gating (4.4); no Escalations (7.6); no new verbs.
- No other per-item notice. The Story 1.10 alert stays unchanged as the only notice outside the digest.
- No agent session in any of this, no `.github/` change, no edit to `retro-gates.yaml` or any epic context file.
- No mocks in the core case tables, and no token-shaped literals in any file.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First need | alice has a parked PR; no inbox issue | issue created (label, assignee alice), body lists `#<pr>` with its age | create fails → logged, next run retries |
| Unchanged | rendered body equals the issue body | no body write | — |
| Stale inbox | bob's inbox lists items, bob holds none | body rewritten to the empty text; no mention | — |
| Digest due | 08:00 passed, `digest_posted_at` yesterday | stamp, then one mention per non-empty inbox | stamp refused/lost → no post |
| Digest posted | `digest_posted_at` today ≥ slot | no comment, even if the body changed | — |
| Post fails | comment errors after the stamp | no retry that day | logged |
| Deferred | 4.1-d1 deferred; spec 4.3 lists `resolves: ["4.1-d1"]` | 4.1-d1 not listed; an unnamed 4.1-d2 is listed | bad frontmatter → skipped |
| Waiting builder | idle only for a rejected retro and a parked approval | span reason starts `waiting-on-maintainer: ` | a `depends-on` among them → plain reason |

</intent-contract>

## Code Map

- `src/ports/forge.ts:174-239` -- `Forge` and `FORGE_OPERATIONS`. Add `InboxIssue = {number, owner: string|null, body, url}` and:
  - `inboxes(opts)`: every open issue with the label;
  - `openInbox(owner, opts)`: find or create;
  - `setInboxBody(issue, body, opts)`;
  - `inboxComment(issue, body, opts) → {id}`.
- `src/adapters/forge/github/github-forge.ts:88-106,998-1067` -- `DEFAULT_INBOX_LABEL`, `INBOX_TITLE`, `inboxIssue(ctx, login)` (find or create; reuse it for `openInbox`), `paged()` :689, `alert`. The new operations reuse the same listing. `http.ts:46-76` `GITHUB_OPERATIONS`: add an `updateIssue` PATCH (`issues: write`).
- `src/adapters/forge/fake/fake-forge.ts:54-94,163,418` -- model inbox issues (number, owner, body, comments). Add the controls `inboxes()` and `inboxComments(n)`, honouring `injectError`.
- `test/adapters/forge/github/fake-github.ts:85-155,718-761` -- the emulator's issues. Add `PATCH /issues/{n}`.
- `test/contracts/forge.contract.ts:105-135,675` -- `scenario(...)`. Add inbox and `renderDigest` cases. `forge.contract.test.ts:5-20` lists the control names. The live harness is in `forge.github.contract.test.ts:181`.
- `src/core/next/coordinator.ts:238-317` -- `digestDue` (move it to a leaf module so `edits.ts` can use it, and re-export it here) and `reconcileDue`. Add the digest condition before the 10-minute rule and update the doc :288.
- `src/core/schemas/ledger.ts:12-24,150-170` -- the version constant, union and `ParkSchema` (add `text` as optional, capped). `src/core/ledger/codec.ts:26,66,128` -- the readable message and `orderedPark` key order.
- `src/core/ledger/edits.ts:551-624,1086-1130` -- `ParkParams.text`, plus a new `stampDigest({by, now, generation, slot})` edit modelled on `keepCoordinator`.
- `src/core/sanitize.ts:19,113` -- `FORGE_TEXT_LIMITS`, `sanitizeAgentText` and `capText`.
- `src/lane/lane-process.ts:567-575`, `src/lane/session.ts:668,757`, `src/lane/retro-item-step.ts:548`, `src/lane/planning-step.ts:428` -- the blocked parks that carry text. `parkBlocked` gains an optional `text`.
- `src/lane/reconcile-step.ts:137-157,1019-1061` -- deps (`repo` slug, forge); `steps()` runs the inbox step right after `ledgerWork(plan)` (:1039), before the PR branches.
- `src/core/next/next.ts:155-216`, `src/core/next/epic-gates.ts:96-100`, `src/core/next/reasons.ts` -- the reasons. Add an optional `maintainer?: true` to `Reason` and set it on Maintainer causes. `nextBuilder`'s idle adds the prefix (`WAITING_ON_MAINTAINER` at coordinator.ts:432).
- `test/core/next/{fixtures,coordinator.test,next.test}.ts` -- the `World` fixtures and the due-rule table (rows :96-97 and :141-145 flip to due).
- Version-pinned tests (5 → 6, "unsupported" 6 → 7): `test/core/ledger/{fixtures,codec,schema,edits}.test.ts`, `test/core/next/snapshot.test.ts:212`, `test/lane/{lane-process,pr-step,heartbeat,coordinator-process,several-lanes}.test.ts`.
- `docs/maintainer/self-host.md:485` -- the v5 upgrade note; `docs/maintainer/app-permissions.md:13` -- the `issues: write` row.

## Tasks & Acceptance

**Execution:**
- `src/core/schemas/ledger.ts`, `src/core/ledger/codec.ts`, `src/core/ledger/edits.ts`:
  - ledger v6 with optional `park.text` (≤ `PARK_TEXT_MAX`);
  - `ParkParams.text`;
  - the `stampDigest` edit, which refuses when not held at `generation` or when `digest_posted_at` ≥ `slot`.
- `src/core/inbox/digest-time.ts` (new) -- `digestDue` and `digestSlot(now, time)`, moved from coordinator.ts and re-exported there.
- `src/core/inbox/deferred.ts` (new) -- parse spec frontmatter (`deferred`, `resolves`) with the existing YAML reader and return the open entries `{id, spec, summary, created}`. Pure.
- `src/core/inbox/render-digest.ts` (new) -- `renderDigest({snapshot, files, repoUrl}) → Map<owner, {body, count}>` and `EMPTY_INBOX_BODY`, following the Boundaries above. Pure.
- `src/ports/forge.ts`, the fake forge, the GitHub adapter and `http.ts` -- the four inbox operations.
- `test/adapters/forge/github/fake-github.ts` -- the PATCH route.
- `src/lane/inbox-step.ts` (new) -- `syncInboxes({forge, digests, digestDue, stamp, log, signal})`: enumerate, open on need, rewrite when changed, clear stale, stamp then mention.
- `src/lane/reconcile-step.ts` -- call `syncInboxes` after the ledger work with the CAS stamp edit, and extend the module doc.
- `src/core/next/coordinator.ts` -- the digest condition in `reconcileDue`.
- `src/core/next/{reasons,epic-gates,next}.ts` -- the Maintainer flag and the builder prefix.
- `src/lane/{lane-process,session,retro-item-step,planning-step}.ts` -- pass `park.text`.
- Tests:
  - `test/core/inbox/*.test.ts`: case tables, no mocks;
  - due-rule rows;
  - `next` prefix rows;
  - edits and codec v6 plus `stampDigest`;
  - the contract inbox and `renderDigest` cases;
  - `test/lane/inbox-step.test.ts` and reconcile-step cases on the fake forge;
  - the version bumps.
- `docs/maintainer/self-host.md` -- the Human Live Step of pinning the Maintainer's inbox once by hand, and the ledger v6 note that every lane's runner pin advances together.

**Acceptance Criteria:**
- Given a `reconcile` run on the fake forge with parked records of two owners, when it runs, then each owner has one labelled, assigned inbox. The bodies list each PR or blocked unit with its link, age, verb and `park.text`. A second run with no change writes no body.
- Given an owner whose records have all cleared, when `reconcile` runs, then their inbox body becomes the empty text.
- Given the digest slot passed, when two `reconcile` runs happen that day, then the first stamps `digest_posted_at` before posting one mention per non-empty inbox, and the second posts nothing.
- Given the contract suite, when it runs, then the fake and the GitHub emulator pass the inbox and `renderDigest` cases, and the live harness skips them unless `XARABOT_LIVE=1`.
- Given a builder blocked result, when the lane parks it, then the record is v6 with sanitized, capped `park.text`.
- Given `reconcileDue`, when the slot passed with no post, then `reconcile` is due.

## Spec Change Log

## Review Triage Log

### 2026-10-26 — Review pass
- verdicts: 42 findings — high 0, medium 8, low 26, false 8, maybe-false 0
- findings:
  - `[low]` `[patch]` (verification-gap) No test checks that `lane run` passes the lane's secrets to the builder's `LaneDeps` and to `createCiStep` — `test/cli/lane-run.test.ts` now wraps `createCiStep` and asserts the credential in both `LaneDeps.secrets` and the CI step's `deps.secrets`.
  - `[low]` `[patch]` (verification-gap) No test checks that `park.text` is redacted with the lane's secrets through `stepOps.parkBlocked` — `test/lane/planning-step.test.ts` now parks a readiness summary holding the harness secret and an @mention and asserts `[REDACTED]` with no `@`.
  - `[medium]` `[patch]` (verification-gap) An inbox with several assignees is owned by its first assignee in `inboxes` but matched on any assignee by `openInbox`, so two owners overwrite one body every run — grouped with the GitHub ownership entry below; `inboxIssue` now takes the lowest issue whose first assignee equals the login (case-insensitive), else creates one; emulator test added.
  - `[medium]` `[patch]` (verification-gap) While the digest is due but no stamp lands, `reconcile` is due every coordinator round and starves the other units — grouped with the due-rule entry below; `reconcileDue` counts the digest only while no merged `reconcile` run is at or after today's slot, so after a failed stamp the 10-minute rule applies again; due-rule rows added.
  - `[medium]` `[patch]` (edge) Digest due with the stamp never landing makes reconcile due every pass — same root cause as the due-rule entry; fixed by the same `ranSinceSlot` guard.
  - `[medium]` `[patch]` (edge) A failing `inboxes` listing skips the stamp, so reconcile reschedules back to back — same root cause; fixed by the same guard (the run still never stamps without listing, keeping at-most-once).
  - `[medium]` `[patch]` (edge) `openInbox(B)` can return A's two-assignee issue — same root cause as the ownership entry; fixed by the owner match in `inboxIssue`.
  - `[medium]` `[patch]` (edge) `openInbox` returning an issue already mapped to another owner makes the bodies ping-pong — same root cause; fixed by the same owner match.
  - `[low]` `[patch]` (edge) A digest mention is posted even when that owner's body write failed — `rewrite` now reports success, and only an owner whose body is current joins the mention list; test added.
  - `[low]` `[reject]` (edge) An open labelled inbox with no assignee is skipped silently — intended (an inbox is an issue assigned to its owner, and an unassigned one belongs to nobody); a log line would add a branch for a case the runner never creates.
  - `[false]` `[reject]` (edge) A builder idling only on a blocked `human-live-step` park gets no prefix — AR25 and the Maintainer's decision 2 list the Maintainer causes (checkpoint go, parked approval, rejected retro, Maintainer-routed item), and a Human Live Step wait is not among them; the code follows that list.
  - `[low]` `[patch]` (edge) `specRegExp` turns `**/` into `.*/`, so with a `**/` pattern a top-level spec is logged as "gives no Story id" — `**/` now becomes `(?:.*/)?`; case-table rows added.
  - `[low]` `[reject]` (edge) `openDeferred` gets the read files' paths, not `main`'s tree, so a spec `readsPath` does not read vanishes silently — the default pattern and any `.md` spec pattern are read; it needs a non-`.md` spec pattern or one under `_bmad/`, and the fix plumbs the tree into the step.
  - `[low]` `[reject]` (edge) Two specs with the same explicit deferred id let one `resolves` close both — ids follow `<story-id>-d<n>`, so a collision needs a hand-written mistake; detection adds a cross-spec check.
  - `[low]` `[reject]` (edge) The inbox step runs after the ledger work, so a run that fails inside `ledgerWork` skips it — the Boundaries place it after the ledger work; a failed run is followed by another, which refreshes the inboxes.
  - `[low]` `[reject]` (edge) Bodies come from the run's snapshot, so units this run settled still show until the next run — the Boundaries render from the run's snapshot, and the lag is one run (at most 10 minutes); filtering by the settled set adds state.
  - `[medium]` `[patch]` (blind) The digest can make reconcile run back to back and starve other coordinator work — same root cause as the due-rule entry; fixed by the same guard.
  - `[medium]` `[patch]` (blind) `inboxes` and `openInbox` define an issue's owner differently — same root cause as the ownership entry; fixed by the same owner match.
  - `[false]` `[reject]` (blind) The prefix will almost never appear because other Epics' `epic-context`, `dependency-epic` or `unmanifested` reasons break `every` — that is the Maintainer's decision 2 as ruled ("idle only because of" means every reason is a Maintainer cause); a lane that also waits on an unfinished dependency is not waiting only on the Maintainer.
  - `[false]` `[reject]` (blind) The routing and the prefix disagree on `human-live-step` and `review-findings` parks — the prefix follows AR25's cause list, and inbox routing follows the Story's inbox list; they answer different questions, and neither list is the code's own choice.
  - `[low]` `[patch]` (blind) A mention is posted after the owner's body write failed — same root cause as the edge-layer mention entry; fixed by the same change.
  - `[low]` `[reject]` (blind) Bodies are rendered from the snapshot taken before the ledger work — same as the edge-layer snapshot entry; rejected for the same reason.
  - `[low]` `[reject]` (blind) The body cap can cut mid-item, and the counts don't reflect it — needs about 16 blocked items each with a 4,000-character text; dropping whole items and adding an "and K more" line adds logic for a body that size.
  - `[low]` `[patch]` (blind) The first run lists every old deferred entry, and the docs don't say how an entry leaves — `self-host.md` now says so: an entry leaves only when a later spec lists its id in `resolves`.
  - `[low]` `[patch]` (blind) `self-host.md` says blocked units show "the session's own words", but runner-caused parks store no text — the doc now says text shows only for a session's blocked result or a readiness summary, and a runner-caused park shows its reason only.
  - `[low]` `[reject]` (blind) Clearing rewrites any labelled assigned issue, and only the lowest-numbered one per owner — that is the spec's definition of an inbox; checking authorship adds a forge field for an issue someone labelled by hand.
  - `[low]` `[reject]` (blind) `openDeferred` runs twice per reconcile run — it is pure parsing of a few dozen specs once per run; returning `skipped` from `renderDigest` widens its surface.
  - `[low]` `[reject]` (blind) Inbox links hard-code `https://github.com/` — 0.x targets github.com; plumbing the adapter's `gitUrl` into the step adds a dependency for a host no repo uses.
  - `[low]` `[patch]` (blind) The Story-id regex and `Bun.Glob` disagree on `**` — same root cause as the edge-layer `**/` entry; fixed by the same change.
  - `[low]` `[patch]` (blind) Tests missing for the riskiest paths — added: due-rule rows for a run after the slot, the two-assignee emulator test, and a failed body write that posts no mention; the truncation and missing-context cases are covered by the rejected cap entry and the false prefix entry above.
  - `[low]` `[patch]` (intent) `waiting-on-maintainer` is tested on `next()`'s return, not on the journal span — `test/lane/lane-process.test.ts` now asserts that a builder idling only on a parked approval writes an `idle` span whose reason starts `waiting-on-maintainer: `.
  - `[false]` `[reject]` (intent) Only the builder side gets the prefix — the coordinator's idle always carries `reconcile-not-due` (not a Maintainer cause), and its own live-evidence prefix is unchanged, so no coordinator idle is "only" Maintainer causes.
  - `[low]` `[reject]` (intent) A stale Infrastructure record with no approval counts as a Maintainer cause, but the inbox lists no item for it — this rare state predates this Story; listing claimed records adds a new item kind outside the Story's list.
  - `[false]` `[reject]` (intent) `human-live-step` blocks are not a Maintainer cause for the prefix — same as the edge-layer entry: AR25's list does not include them.
  - `[low]` `[reject]` (intent) `renderDigest` never reads `snapshot.prs` — the park kind already says what waits, and the same run's ledger work settles a merged or closed PR's record; reading PR states would add a second source for the same fact.
  - `[low]` `[patch]` (intent) Graph-changing PRs are not shown as such — a park with `graph_posted` now renders `awaiting approval (graph change)`; case-table row added.
  - `[false]` `[reject]` (intent) The contract cases test storage, not rendering — rendering is pure and the same for every adapter; what an adapter must pass is storing and reading back a rendered body exactly, which the cases check on the fake and the emulator.
  - `[false]` `[reject]` (intent) Only `approve` on `needs-approval`, and no verb for the owner's kinds — that is the Maintainer's decision 4 (only `go`, `done`/`defer` and `approve`).
  - `[low]` `[reject]` (intent) Bodies come from the pre-ledger-work snapshot — same as the edge-layer snapshot entry.
  - `[low]` `[reject]` (intent) An item's age comes from `heartbeat_at`, so a re-park restarts it — the ledger has no park-time field, and adding one is another schema change for a re-park that already means a new wait.
  - `[low]` `[reject]` (intent) Links are hard-coded to `https://github.com/` — same as the blind-layer entry.
  - `[false]` `[reject]` (intent) The alert's issue is taken over by the digest, and existing PR comments remain — AD-23 makes the inbox the alert's issue by design, and the Story adds no per-item notice, which is its scope.

## Design Notes

**Why `resolves` by any other spec means "merged after".** A spec can name `4.1-d2` only once that entry exists on `main`, because ids come from merged specs, and a spec that names it merges later. So "another spec on `main` names it" equals the merge-order rule without reading git history. The Story-id order the Maintainer ruled out is never used.

**Stable bodies.** Ages are whole days, so a body changes at most once a day from ageing alone, and the "only when changed" write stays meaningful. Links are `<repoUrl>/pull/<n>` for PRs and `<repoUrl>/blob/main/<path>` for files. A unit with no PR links its ledger record at `<repoUrl>/blob/xarabot/claims/units/<unitFileId>.json`.

Example item:

```
- [story:4.2](https://github.com/o/r/pull/12) · blocked `intent-gap` · 2d
  > Which inbox owns graph PRs?
```

## Verification

**Commands:**
- `bun test` -- expected: all pass
- `bun --bun oxlint` -- expected: no errors
- `bun --bun tsc` -- expected: no errors

## Auto Run Result

Status: done

**Summary:** Each owner now has one `xarabot-inbox` issue, kept current by `reconcile`'s runner code and announced once a day:
- **Forge port:** four inbox operations (`inboxes`, `openInbox`, `setInboxBody`, `inboxComment`) on the fake forge, the GitHub adapter (a new `updateIssue` PATCH) and the emulator.
- **`renderDigest`:** a pure function that builds each owner's body from parked records, `retro-gates.yaml`, the graph and the deferred entries of `main`'s Story specs, with links, day ages, the fixed verbs and `park.text`.
- **`syncInboxes`:** runs after the ledger work in every `reconcile` run. It rewrites only changed bodies and clears stale ones. Once the daily slot passes, it stamps `digest_posted_at` with a fenced `stampDigest` edit, and only after that posts one mention per non-empty inbox.
- **Park text:** `park.text` holds the sanitized, capped text of a session's blocked result or a readiness summary (ledger v6).
- **Due rule:** an unposted digest slot is `reconcile` work until a run finishes past the slot.
- **Builder idle reason:** it starts `waiting-on-maintainer: ` when every reason it idles for is a Maintainer cause.

**Files changed:**
- `src/core/inbox/{digest-time,deferred,render-digest}.ts` -- new: the digest clock, the deferred-entry scan, `renderDigest`.
- `src/lane/inbox-step.ts` -- new: `syncInboxes`.
- `src/lane/reconcile-step.ts` -- runs the inbox step after the ledger work; the stamp edit.
- `src/ports/forge.ts`, `src/adapters/forge/fake/fake-forge.ts`, `src/adapters/forge/github/{github-forge,http}.ts` -- the inbox operations.
- `src/core/schemas/ledger.ts`, `src/core/ledger/{codec,edits}.ts` -- ledger v6, `park.text`, `parkText`, `stampDigest`.
- `src/core/next/{coordinator,next,epic-gates,reasons}.ts` -- the digest due condition; the Maintainer flag and the builder prefix.
- `src/lane/{lane-process,session,ci-step,review-gate,retro-item-step,planning-step}.ts`, `src/cli/lane-run.ts` -- park text with the lane's secrets.
- `docs/maintainer/self-host.md` -- the inbox and digest section (pinning Human Live Step, deferred entries, park text) and the ledger v6 upgrade step.
- `docs/maintainer/app-permissions.md` -- `updateIssue` under `issues: write`.
- Tests:
  - new `test/core/inbox/*`, `test/lane/inbox-step.test.ts`, `test/adapters/forge/github/inbox.test.ts`;
  - contract inbox and `renderDigest` cases;
  - due-rule, `next`, ledger, reconcile-step, lane-process, planning, CI and retro-item cases;
  - the v5→v6 version pins.

**Review:** 42 findings from 4 layers (high 0, medium 8, low 26, false 8).
- 11 entries patched: 2 medium and 9 low, by root cause.
  - Medium: the digest due rule throttled after a failed stamp; inbox ownership by first assignee in `openInbox`.
  - Low:
    - no mention after a failed body write;
    - `**/` in the spec regex;
    - lane-run secrets assertions;
    - a `park.text` redaction test;
    - the graph-change label;
    - a journal-span test;
    - two doc fixes;
    - the missing-tests entry.
- 0 deferred.
- Rejected lows, as unlikely in everyday use with a fix that adds complexity:
  - unassigned inbox skipped silently;
  - unread spec paths;
  - duplicate explicit ids;
  - inbox step skipped when the ledger work fails;
  - the pre-ledger-work snapshot;
  - body cap mid-item;
  - labelled human issues;
  - double spec parse;
  - hard-coded github.com links;
  - stale Infrastructure record not listed;
  - `snapshot.prs` unread;
  - age from `heartbeat_at`.
- False: the prefix rules for `human-live-step`, other Epics' reasons and the coordinator (all per AR25 and decision 2); contract cases test storage; verb narrowing (decision 4); the alert sharing the inbox issue (AD-23).

**Follow-up review recommended:** true. Two medium entries were patched. Neither the patched GitHub owner match nor the digest due rule's interplay with the coordinator's round timing has run against live GitHub or a live coordinator. The emulator and the case tables cover them only.

**Verification:**
- `bun test`: 5747 pass, 373 skip, 0 fail.
- `bun --bun oxlint`: exit 0.
- `bun --bun tsc`: exit 0.
- Every I/O matrix row is covered by a passing test that ran with no skips (77 targeted tests pass).
- A diff scan finds no token-shaped literals.

**Residual risks:**
- Files outside Story 4.2's manifest globs changed: `src/core/ledger/*`, `test/core/ledger/*`, `src/cli/lane-run.ts`, `test/cli/lane-run.test.ts`, `test/ports/forge.test.ts`, `docs/maintainer/app-permissions.md`. The builder write check does not refuse them, but their overlap with other units' globs is not reserved.
- Ledger v6 needs every lane's runner pin to advance together.
- The first run lists all 48 existing deferred entries in the Maintainer's inbox until later specs resolve them.
- The live GitHub inbox cases run only with `XARABOT_LIVE=1`.
