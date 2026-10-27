---
title: 'Story 4.5: Rulings: grammar, authority and cursor'
type: 'feature'
created: '2026-10-27'
status: 'done'
baseline_revision: '682dd47506ce027df167cfbfe0bcb5e9853f3a6c'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - id: "4.5-d1"
    summary: >-
      A runner pin with Story 4.5 and without Story 4.6 consumes every valid ruling: it advances the cursor past it and acknowledges it, but applies nothing, so the ruling is never read again.
    evidence: |-
      answerRulings advances rulings_cursor past each comment it reads and replies "Ruling acknowledged" to each valid one. The verb effects are Story 4.6's (epics.md Stories 4.5/4.6; the 4.6 manifest alone has src/core/inbox/**, src/core/graph/** and src/cli/**), and nothing in code holds rulings back until they exist. The harm needs the Maintainer to advance runner_version past this Story before Story 4.6 merges, and then to rule in that window; the ruling is lost but can be posted again. The fix is a deployment-order choice for the Maintainer (ship 4.5 and 4.6 in one runner tag), or a gate or a "recorded, not applied" reply that the spec does not settle.
    location: >-
      src/lane/rulings-step.ts
    severity: medium
---

<intent-contract>

## Intent

**Problem:** An owner cannot rule on anything in their inbox. Nothing reads the comments on inbox issues. `coordinator.json`'s `rulings_cursor` is never written, and no comment gets a reply (FR9, AR29, AD-28).

**Approach:**
- Add `Forge.readRulings(cursor)`. It returns the comments on the open inbox issues posted after the cursor, and a new cursor.
- Add a pure ruling core: a parser, an authority check and a target check against the run's snapshot, plus the 🤖 reply text.
- In every `reconcile` run, add a runner step that:
  1. reads the new comments;
  2. advances `rulings_cursor` in one fenced ledger swap (the swap Story 4.6 adds the verb effects to);
  3. then replies to each ruling.

## Boundaries & Constraints

**Always:**

Grammar (`parseRuling`):
- Trim the comment body. A body that does not start with `/xarabot` followed by whitespace or the end of the text is not a ruling. It is ignored and gets no reply. This covers 🤖 bot comments, quotes and plain text.
- A ruling is exactly `/xarabot <verb> <unit-id>` on one line, with whitespace between the words.
  - The verbs are `go`, `approve`, `block`, `unblock`, `done`, `defer`, `rebuild`, `release` and `dismiss`.
  - The unit id must pass `isUnitId` (AR35).
- Any other body starting with `/xarabot` is malformed, with a reason:
  - no verb;
  - an unknown verb;
  - no unit id;
  - not a unit id;
  - text after the unit id.

Authority (logins compared case-insensitively):
- `go`, `approve`, `block`, `unblock`, `done` and `defer` count only from `config.maintainer`. The authority check runs before the target check.
- `rebuild`, `release` and `dismiss` count from the item's owner or the Maintainer. The target check runs first, because it finds the owner.
- The item's owner is the owner whose inbox lists the unit, by `renderDigest`'s rules:
  - for a `parked` record: `needs-approval` and `blocked` `human-live-step` records belong to the Maintainer, and every other parked record to its `park.inbox_owner`;
  - every other inbox item belongs to the Maintainer.

Targets (checked against the run's snapshot; anything else is "doesn't apply", with the reason):
- `go`:
  - on `checkpoint:<N>`: the graph resolves, N is in `graph.checkpoints`, and N's entry has no `checkpoint` record;
  - on `retro:<N>`: N's `retro.verdict` is `rejected`, with no `go`;
  - on any other kind: refused.
- `approve`: the unit's record is `parked` `needs-approval`.
- `block` and `unblock`: a `retro-item:<id>` that `retro-gates.yaml` lists (in the Epic its id names) whose `blocking` is not already the value the verb sets.
- `done`: a listed retro item that is not `done`. `defer`: a listed retro item whose status is `open`, `in-progress` or `waiting`.
- `rebuild` and `release`: the unit's record is `parked`.
- `dismiss`: some inbox lists the unit. The inbox items are:
  - the parked records;
  - the checkpoint gos waiting (retro recorded, no `checkpoint` record);
  - the rejected retros with no go;
  - the open Maintainer-routed retro items;
  - the unmanifested `story:` headings outside `bootstrapped_epics`.

Replies (`rulingReply`, pure):
- Each reply is one 🤖 comment on the ruling's own inbox issue, linking the ruling comment.
- A valid ruling: `🤖 Ruling acknowledged: \`/xarabot <verb> <unit>\` from <login> ([comment](<url>)).`
- A refused ruling: `🤖 Ruling not applied ([comment](<url>)): <reason>. Nothing changed.`
- Any echoed text is sanitized (`sanitizeAgentText`), has no backticks and is capped. A reply never @-mentions anyone, and it is capped at `FORGE_TEXT_LIMITS.comment`.

Cursor and order (the rulings step, `src/lane/rulings-step.ts`):
- It runs in every `reconcile` run, right after the ledger work and before the inbox step, from `snapshot.ledger.coordinator.rulings_cursor`. With no `coordinator.json`, it is skipped and logged.
- `readRulings(null)` reads every comment on the open inboxes. A cursor returns only the comments after it, oldest first. The returned cursor is past the last comment returned, or unchanged when none is returned.
- When the cursor moves:
  1. one swap writes `fenced(heartbeat(run record), advanceRulingsCursor({by, now, generation, from, to}))`. The new edit refuses unless the writer holds `coordinator.json` at `generation` and its cursor is still `from`.
  2. Only after that swap lands are the replies posted, at most once: a reply that fails is logged, and it is not retried.
- A read error, a refused swap or a failed reply is logged and skipped. None of them fails or stops the run.

Forge:
- The fake forge keeps comment records (id, author, body, time). Its cursor is the last comment id. It gains the control `addInboxComment(issue, author, body)`.
- The GitHub adapter:
  - lists the open inbox issues, then each one's `GET /issues/{n}/comments?since=<cursor time>`, paged;
  - keeps the comments after the cursor, by `(created_at, id)`;
  - writes its cursor as `<created_at>|<id>`;
  - refuses a cursor it cannot parse as `rejected`.

**Never:**
- No verb effects in this Story: no go recorded, no approval, no tag or status change, no release or rebuild, no dismissal (Story 4.6). A valid ruling changes only the cursor and gets its acknowledgement.
- No `xarabot rule` change (Story 4.6).
- No change to the due rule. No agent session. No @-mention in a reply. No `.github/` change.
- No hand edit of `retro-gates.yaml` or of any epic context file.
- No ledger schema change: `rulings_cursor` already exists.
- No mocks in the core case tables, and no token-shaped literals.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid Maintainer go | `/xarabot go checkpoint:4`; 4 is a checkpoint with no go | cursor advanced; ack naming `go checkpoint:4` | — |
| go, retro not rejected | `/xarabot go retro:3`, verdict `accepted` | refused: verdict is not rejected | — |
| Unauthorized | bob: `/xarabot go retro:2` | refused: only the Maintainer | — |
| Owner release | alice: `/xarabot release story:1.1`, parked in alice's inbox | ack | — |
| Other user release | carol, same | refused: only alice or the Maintainer | — |
| Malformed | `/xarabot frob story:1.1`, `/xarabot go`, `/xarabot go nope`, `/xarabot go retro:2 now` | refused with the matching reason | — |
| Not a ruling | `thanks`, `🤖 Ruling acknowledged…`, `> /xarabot go retro:2` | ignored, no reply; cursor still advances | — |
| No new comments | cursor at the last comment | no swap, no reply | — |
| Swap refused | cursor moved by another run | no reply | logged |
| Reply fails | `inboxComment` errors | cursor stays advanced; no retry | logged |
| Read fails | `readRulings` errors | nothing written | logged |

</intent-contract>

## Code Map

- `src/ports/forge.ts:175-262` -- `InboxIssue`, `Forge` and `FORGE_OPERATIONS`. Add `InboxComment = {id, issue, author, body, created_at, url}`, `RulingsRead = {comments, cursor}`, and `readRulings(cursor, opts)` after `inboxComment`.
- `src/adapters/forge/fake/fake-forge.ts:173,192-216,482-520,560-590` -- `InboxRecord.comments` becomes records `{id, author, body, created_at}`. `inboxComment` is by `botLogin`, and the `inboxComments(issue)` control still returns the bodies. Add `readRulings` (open inboxes, id above the cursor, a non-numeric cursor is `rejected`) and the `addInboxComment` control. `nextComment` is the shared id counter.
- `src/adapters/forge/github/github-forge.ts`:
  - `listInboxes` :1019, `paged` :692, `inboxComment` :1125;
  - add `readRulings` with the `listIssueComments` op (`http.ts:73`, already `issues: write`);
  - a comment's `url` is `html_url`, or else `<issue url>#issuecomment-<id>`.
- `test/adapters/forge/github/fake-github.ts:109,375,726-736` -- the emulator's `commentJson` gains `html_url`. `GET /issues/{n}/comments?since=` already exists, and so does `control.addComment(n, body, login)`.
- `test/contracts/forge.contract.ts:36-60,339-366,707-776` -- the `ForgeContractControls` control `addInboxComment`, `readRulings` in the aborted-signal case, and the new readRulings cases. `forge.contract.test.ts` `CONTROLS`, and `forge.github.contract.test.ts:150-163`, the emulator harness controls (map `addInboxComment` to `gh.control.addComment`).
- `test/ports/forge.test.ts:22-43` -- add `"readRulings"` to `Operations`. This file is outside the manifest globs, a compile-time necessity; Story 4.2 changed it the same way.
- `src/core/ledger/edits.ts:1104-1182` -- `makeCoordinatorEdit`, `coordinatorStamp`, `stampDigest`. Model `advanceRulingsCursor` on `stampDigest`.
- `src/core/rulings/rulings.ts` (new) -- the parser, the owner lookup, `judgeRuling(snapshot, comment)` and `rulingReply`. Reuse:
  - `isUnitId` and `unitKind` (`src/core/schemas/ledger.ts:56-66`);
  - `sanitizeAgentText`, `capText` and `FORGE_TEXT_LIMITS` (`src/core/sanitize.ts`);
  - `RETRO_ITEM_ID_PATTERN` (`src/core/schemas/retro-gates.ts:31`);
  - the snapshot fields `config.maintainer`, `config.bootstrapped_epics`, `graph` (`checkpoints`, `unmanifested`), `retro_gates.epics` and `ledger.units`.
- The owner rules are mirrored from `src/core/inbox/render-digest.ts:126-235`. That file is read-only here: it is outside the globs.
- `src/lane/rulings-step.ts` (new) -- `answerRulings({forge, cursor, judge, advance, log, signal, callTimeoutMs})`, modelled on `src/lane/inbox-step.ts`.
- `src/lane/reconcile-step.ts:140-151,905-944,1099-1100` -- a `rulings()` closure modelled on `inboxes()`: the swap through `swapLedger` with `fenced(heartbeat(...), advanceRulingsCursor(...))`. Call it after `ledgerWork(plan)` and before `inboxes()`, and extend the module doc.
- Tests:
  - `test/lane/reconcile-step.test.ts:83-110,2767+` -- `claimRec` (with `rulings_cursor`) and the `spied` `INBOX_CALLS` (add `readRulings`, so the other cases keep their event lists). Add a Story 4.5 describe next to Story 4.2's.
  - `test/core/next/fixtures.ts` -- `snapshotOf`, `storyRec` and the `World` options for the core tables.
  - `test/core/ledger/edits.test.ts` -- the coordinator-edit cases for `stampDigest`, to copy.

## Tasks & Acceptance

**Execution:**
- `src/ports/forge.ts`, `test/ports/forge.test.ts` -- the port types and operation -- AC 1.
- `src/adapters/forge/fake/fake-forge.ts`, `src/adapters/forge/github/github-forge.ts`, `test/adapters/forge/github/fake-github.ts` -- `readRulings` in each, and the fake's control.
- `test/contracts/forge.contract.ts` and both harness files -- the cases:
  - from no cursor: every comment, oldest first, and from the returned cursor none;
  - a comment added after the cursor is returned once, with its author;
  - a cursor the forge did not issue is `rejected`;
  - an aborted call is `transient`.
- `test/adapters/forge/github/inbox.test.ts`, `test/adapters/forge/fake-forge.test.ts` -- adapter cases:
  - a closed inbox's comments are skipped;
  - the `since` query is sent;
  - comments are paged;
  - a same-second tie is broken by id.
- `src/core/ledger/edits.ts`, `test/core/ledger/edits.test.ts` -- `advanceRulingsCursor`, with rows for:
  - advances `null` to a cursor;
  - a wrong `from` refuses;
  - a wrong generation refuses;
  - another holder refuses;
  - a missing record refuses;
  - the other fields are kept.
- `src/core/rulings/rulings.ts`, `test/core/rulings/rulings.test.ts` (new) -- the case tables, with no mocks:
  - each malformed form;
  - each verb × Maintainer, owner and other author;
  - each verb's mis-target;
  - `go` on a rejected retro, a non-rejected one and one already gone;
  - `go` on a checkpoint, a non-checkpoint and one already gone;
  - the ignored bodies;
  - the reply texts (no `@`, capped).
- `src/lane/rulings-step.ts`, `test/lane/rulings-step.test.ts` (new) -- the matrix rows from no new comments down, on the fake forge.
- `src/lane/reconcile-step.ts`, `test/lane/reconcile-step.test.ts` -- the wiring. A run with the Maintainer's ruling on an inbox advances `coordinator.json`'s cursor and posts one ack, and a second run posts nothing new.

**Acceptance Criteria:**
- Given inbox comments and a `reconcile` run on the fake forge, when it runs, then it reads them through `readRulings` from `coordinator.json`'s cursor. One fenced ledger swap advances the cursor, and only then is each ruling answered with one 🤖 reply.
- Given the same comments, when a second `reconcile` run happens, then it reads none of them again and posts no reply.
- Given the contract suite, when it runs, then the fake and the GitHub emulator pass the `readRulings` cases, and the live harness skips them unless `XARABOT_LIVE=1`.

## Spec Change Log

## Review Triage Log

### 2026-10-27 — Review pass
- verdicts: 33 findings — high 0, medium 4, low 24, false 5, maybe-false 0
- findings:
  - `[medium]` `[defer]` (blind) Rulings are consumed before any verb works: under a 4.5-only runner pin, a valid ruling is acknowledged, the cursor moves past it, and nothing applies it — real; recorded as deferred `4.5-d1`. It happens only if the Maintainer advances `runner_version` past this Story before Story 4.6 merges, and the fix is that deployment-order choice, or a gate the spec does not settle. Raised in the PR body for the Maintainer.
  - `[low]` `[patch]` (blind) The docs say Story 4.6 composes "the verb effects" into the cursor swap, but `go`/`block`/`unblock`/`done`/`defer` change `retro-gates.yaml` through the reconcile PR, not the ledger — reworded in `edits.ts` and `reconcile-step.ts` to say Story 4.6 composes its ledger effects there.
  - `[low]` `[patch]` (blind) The GitHub adapter can issue a cursor it rejects: `toInboxComment` takes any `Date.parse` time, `parseRulingsCursor` only `IsoDateTime`, so rulings would stall for good — `toInboxComment` now applies the same `IsoDateTime` check. The wider "recover from any rejected cursor" part is rejected: it needs a hand edit or another adapter's cursor to arise, and recovery adds a branch and a policy.
  - `[low]` `[reject]` (blind) A ruling posted with "Close with comment" is never read, because only open inboxes are read — the inbox is the runner's own issue, and an owner closing it is rare (Story 4.2 opens a new one). Reading closed issues adds a listing and its own edge cases.
  - `[low]` `[reject]` (blind) A lost `coordinator.json`, or the first run after deploy, reads every past comment from a `null` cursor and replies to old rulings again — the spec chose "`null` reads every comment", so rulings posted since Story 4.2's digest listed the verbs are answered. A missing `coordinator.json` is itself an alerted, rare state. A "start from now" rule would change that choice for a rare case.
  - `[low]` `[reject]` (blind) Rulings are judged against the run's snapshot after `ledgerWork` may have changed a target record — in this Story a valid ruling changes nothing, and Story 4.6's ledger edits refuse on their own preconditions (state, generation). Re-reading the ledger adds a read per run for a same-run race.
  - `[low]` `[reject]` (blind) There is no cap on replies per run, so a burst of `/xarabot` comments could hit GitHub's content rate limit — that needs a flood of comments on an inbox issue; a cap would also need a partial cursor and its own cases.
  - `[low]` `[patch]` (blind) An abort after the cursor swap drops the remaining replies with no log — the step now logs how many comments were left unanswered, and their ids; test added.
  - `[low]` `[reject]` (blind) The bot's own replies and digest mentions cost one more cursor swap on the next run — the matrix row "cursor still advances" pins this. Skipping the swap needs the bot login in core, or a second cursor rule, to save one small commit a day.
  - `[low]` `[reject]` (blind) An edited ruling is not read again, and the refused reply does not say so — the reply format is fixed in the Boundaries. Re-posting is the natural recovery, and the reply links the comment.
  - `[false]` `[reject]` (blind) `go checkpoint:N` is accepted before the retro while `dismiss checkpoint:N` is refused — the two verbs have different targets. `go` records the checkpoint's go, which may come before the retro, while `dismiss` removes an inbox item, and the inbox lists a checkpoint only after its retro. Neither reply is wrong.
  - `[low]` `[patch]` (blind) The owner rules are copied from `renderDigest` with no test tying them together — added a test that, for the test world, the units `inboxOwner` gives owners match the unit-id items `renderDigest` lists in each owner's body.
  - `[low]` `[patch]` (blind) The reconcile test says the cursor swap is fenced but checks only the commit message — it now asserts that the commit writes both `coordinator.json` and the run's own record. The missing integration case for "another run moved the cursor" is covered at the step level (`rulings-step.test.ts`), so that part is rejected.
  - `[false]` `[reject]` (blind) The spec's `created` date is in the future — the system date (UTC) is 2026-10-27.
  - `[low]` `[reject]` (edge) A comment posted on an inbox already read, while later inboxes are still being read, can fall behind a cursor set by a newer comment on a later inbox — real, but it needs two inboxes and a comment inside the read's window of about a second. A solo repo has one inbox. A race-free read (one repo-wide listing sorted by creation, or a time margin) changes the adapter's design; recorded under residual risks.
  - `[low]` `[reject]` (edge) A stored cursor `readRulings` rejects blocks rulings for good — same as the rejected part of the blind-layer cursor finding.
  - `[low]` `[patch]` (edge) `created_at` that `Date.parse` accepts but `IsoDateTime` rejects becomes the written cursor — same root cause as the blind-layer cursor entry; fixed by the same check.
  - `[low]` `[reject]` (edge) More than 5 000 comments after the cursor on one inbox make `readRulings` transient every run — that is years of daily mentions and replies, and stopping at the page limit with a partial cursor adds a branch.
  - `[low]` `[patch]` (edge) An abort mid-reply-loop leaves rulings unanswered with no log — same root cause as the blind-layer abort entry; fixed by the same log line.
  - `[low]` `[reject]` (edge) The snapshot is stale after `ledgerWork` — same as the blind-layer stale-snapshot entry.
  - `[low]` `[patch]` (edge) The fake forge accepts a numeric cursor above any id it issued, against the port's contract — the fake now rejects a cursor at or above its next comment id; test added.
  - `[low]` `[reject]` (edge) The claim that `readRulings(null)` reads every comment fails past `MAX_PAGES` — same as the 5 000-comment entry.
  - `[low]` `[patch]` (verification-gap) `defer` on an `open` item and `done` on a `deferred` item are never tested — both added as valid rows in the target table.
  - `[low]` `[patch]` (verification-gap) "Answers each ruling on its own inbox" is never observed with more than one inbox — added a two-inbox case that asserts where each reply lands.
  - `[medium]` `[patch]` (verification-gap) The live harness can never run the comment scenarios, so the AC "the live harness skips them unless `XARABOT_LIVE=1`" fails — the "from no cursor" scenario now posts bot-authored comments through `inboxComment` and needs no control, so it runs live. The author scenario still needs `addInboxComment`.
  - `[medium]` `[defer]` (intent) A valid ruling is acknowledged but not applied, though AC1/AC5 say "applies" — same root cause as the blind-layer consumption entry, deferred as `4.5-d1`.
  - `[low]` `[patch]` (intent) The "same ledger swap" covers only ledger-effect verbs — same root cause as the blind-layer doc entry; fixed by the same rewording.
  - `[false]` `[reject]` (intent) The kind rules live in `judgeRuling`, not the parser — the outcome is the same: refused with a reason, and nothing changes. Only which pure function holds the rule differs, and both are case-tabled.
  - `[false]` `[reject]` (intent) The state checks go beyond the AC's three kind rules — "names a unit the verb doesn't apply to" covers a unit in a state the verb cannot act on. Each check refuses only rulings that would do nothing, and no observed outcome is wrong.
  - `[medium]` `[patch]` (intent) The live harness skips the `readRulings` scenarios even with `XARABOT_LIVE=1` — same root cause as the verification-gap live entry; fixed by the same scenario change.
  - `[low]` `[reject]` (intent) Refused and owner rulings are not run through a full `reconcile` — the wiring does not depend on the verb: it passes `judgeRuling` and the forge through. Each judgement is case-tabled in core, and the replies are checked at step level.
  - `[low]` `[reject]` (intent) At-most-once replies are weaker than "every ruling gets a 🤖 reply" — a reply is lost only when its post fails after the swap landed, or the run dies between the two. The Design Notes choose this over duplicate replies, as the digest stamp does.
  - `[false]` `[reject]` (intent) The grammar is stricter than some readings: trailing text, an embedded command, an uppercase verb — the AC says the parser "accepts only `/xarabot <verb> <unit-id>`"; a command-shaped body that is not exactly that gets a malformed reply, which AC4 requires.

## Design Notes

**The split with Story 4.6.** This Story owns the path from a comment to a reply: reading, parsing, authority, the target check, the cursor and the reply. Story 4.6 owns each verb's effect. The rulings swap is already `fenced(heartbeat, advanceRulingsCursor)`, so Story 4.6 composes its ledger effects into that same swap (`fenced` nests). A ruling this Story acknowledges changes nothing yet. A runner pin that has this Story and not Story 4.6 would acknowledge rulings without applying them, so the two should ship to lanes together.

**At-most-once replies.** The cursor moves before any reply is posted, the same as the digest stamp. A crash between the two loses replies but never doubles them. The `from` check in `advanceRulingsCursor` stops two runs that read the same cursor from both replying.

Example replies:

```
🤖 Ruling acknowledged: `/xarabot go checkpoint:4` from edanisko ([comment](https://github.com/o/r/issues/7#issuecomment-9)).
🤖 Ruling not applied ([comment](https://github.com/o/r/issues/7#issuecomment-10)): only the Maintainer (edanisko) may rule `go`. Nothing changed.
```

## Verification

**Commands:**
- `bun test` -- expected: all pass
- `bun --bun oxlint` -- expected: no errors
- `bun --bun tsc` -- expected: no errors

## Auto Run Result

Status: done

**Summary:** An owner can now rule by commenting `/xarabot <verb> <unit-id>` on an inbox issue. Every `reconcile` run reads, judges and answers these comments with runner code only:
- **Forge:** `readRulings(cursor)` returns the comments on the open inbox issues posted after the cursor, oldest first, with a new cursor.
  - The fake forge's cursor is a comment id. It has the new control `addInboxComment`.
  - The GitHub adapter pages each open inbox's comments with `since`. It keeps the comments after the cursor by `(created_at, id)`, and its cursor is `<created_at>|<id>`.
  - Both refuse, as `rejected`, a cursor they cannot have issued.
- **Ruling core** (`src/core/rulings/rulings.ts`, pure):
  - `parseRuling` handles the grammar and the malformed forms.
  - `judgeRuling` checks authority: the Maintainer for `go`/`approve`/`block`/`unblock`/`done`/`defer`; the item's owner or the Maintainer for `rebuild`/`release`/`dismiss`. It also checks the target against the run's snapshot.
  - `rulingReply` words the 🤖 acknowledgement or refusal. Echoed text is sanitized, and a reply never @-mentions anyone.
- **Cursor:** the new edit `advanceRulingsCursor` moves `coordinator.json`'s `rulings_cursor` only while the writer holds it at its generation and the cursor is still the one read. It is swapped fenced on the run's own record.
- **Rulings step** (`answerRulings`): runs after the ledger work and before the inbox step. It reads the comments, advances the cursor, and only then posts one reply per ruling, at most once. Its errors are logged and never fail the run.
- **Not in this Story:** no verb effect yet (Story 4.6). A valid ruling moves only the cursor and is acknowledged.

**Files changed:**
- `src/ports/forge.ts` -- `InboxComment`, `RulingsRead`, `readRulings`.
- `src/adapters/forge/fake/fake-forge.ts` -- comment records, `readRulings`, the `addInboxComment` control.
- `src/adapters/forge/github/github-forge.ts` -- `readRulings`, `parseRulingsCursor`, `toInboxComment`.
- `src/core/ledger/edits.ts` -- `advanceRulingsCursor`.
- `src/core/rulings/rulings.ts` (new) -- the parser, owner lookup, judgement and reply text.
- `src/lane/rulings-step.ts` (new) -- `answerRulings`.
- `src/lane/reconcile-step.ts` -- the `rulings()` closure and the module doc.
- `test/core/rulings/rulings.test.ts`, `test/lane/rulings-step.test.ts` (new) -- the case tables and the step on the fake forge.
- `test/lane/reconcile-step.test.ts`, `test/core/ledger/edits.test.ts`, `test/contracts/forge.contract{,.test,.github.contract.test}.ts`, `test/adapters/forge/{fake-forge.test,github/inbox.test,github/github-forge.test,github/fake-github}.ts`, `test/ports/forge.test.ts` -- the wiring, the edit, the contract cases, the adapter cases, the emulator's `html_url` and the port's operation list. `test/ports/forge.test.ts` is outside the manifest globs and is a compile-time necessity, as in Story 4.2.

**Review:** 33 findings from 4 layers (high 0, medium 4, low 24, false 5).
- **Patched:** 9 entries, from 13 findings:
  - the docs now say Story 4.6 composes its *ledger* effects;
  - the GitHub `created_at` check matches the cursor's;
  - an abort after the swap is logged;
  - the fake rejects a cursor it never issued;
  - a test ties `inboxOwner` to `renderDigest`;
  - `defer`-on-open and `done`-on-deferred rows;
  - a two-inbox reply case;
  - the fenced-commit assertion;
  - the from-no-cursor contract case now runs live (medium).
- **Deferred:** 1 entry (`4.5-d1`, medium, 2 findings). A runner pin with this Story and not Story 4.6 acknowledges valid rulings and moves the cursor past them without applying them.
- **Rejected lows:**
  - Close-with-comment rulings are not read.
  - A null cursor replays history after `coordinator.json` is lost.
  - The snapshot is stale after the ledger work.
  - Replies have no per-run cap.
  - The bot's own comments cost a cursor swap.
  - Edited rulings are not re-read.
  - A rejected cursor has no recovery.
  - More than 5 000 comments make the read transient.
  - A race between two inbox reads.
  - Refused and owner rulings are not run through a full `reconcile`.
  - Replies are at most once.
  - Each needs a rare state or a design change the Boundaries already settle.
- **False:**
  - `go` vs `dismiss` on a checkpoint before its retro;
  - the `created` date;
  - kind rules in the judge rather than the parser;
  - state checks beyond the AC;
  - grammar strictness.

**Follow-up review recommended:** false. Patched entries by verdict: high 0, medium 1, low 8.

**Verification:**
- `bun test`: 5954 pass, 380 skip, 0 fail.
- `bun --bun oxlint`: exit 0.
- `bun --bun tsc`: exit 0.
- Every I/O matrix row is covered by a test that ran and passed.
- A diff scan finds no token-shaped literals.

**Residual risks:**
- **Ship Story 4.5 and Story 4.6 in one runner tag** (`4.5-d1`). Until 4.6, an acknowledged ruling has no effect, and it is not read again.
- The GitHub adapter assumes `since` is inclusive and that comment ids rise with `created_at`. Only the emulator checks this. The live from-no-cursor case runs only with `XARABOT_LIVE=1`, outside the sandbox, and it leaves three bot comments on the live inbox.
- With two or more inboxes, a comment posted during the read's window of about a second can fall behind the new cursor. A solo repo has one inbox.
- Not committed: the run's instructions leave the changes in the working tree for the runner.
