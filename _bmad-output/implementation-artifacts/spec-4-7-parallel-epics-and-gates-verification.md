---
title: 'Story 4.7: Parallel Epics and gates verification'
type: 'feature'
baseline_revision: '7a9f1bc1b7435884be23b9df25d4d2407deb6770'
created: '2026-10-27'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Stories 4.1 to 4.6 each test their own piece: the distance gates, the checkpoints, the inbox, the rulings. Nothing yet proves, on a graph shaped like Xaravel Phase 1, that builders take Stories from several Epics at once exactly as the graph allows, and that every hold (dependency, checkpoint, rejected retro, retro item) holds exactly the right Epics through `next`. Nothing proves the checkpoint go and the digest on a real GitHub repo. Without that proof a consuming repo cannot turn on parallel Epics with evidence (FR5, FR10).

**Approach:** Add one suite, `test/e2e/parallel-epics.test.ts`, with a harness, `test/e2e/parallel-epics-harness.ts`. It has two parts:
- **Fixture cases:** pure and fast, on the fake forge. The Xaravel-shaped graph is written as `main` files, and builders claim through the real `next` and the lane's own claim edits.
- **Scratch cases:** live on the scratch repo, each also rehearsed on the fake forge in every `bun test`. They run the real coordinator process with the real `reconcile` step (rulings, inbox, its PR). The checkpoint case waits for the Maintainer's real `/xarabot go checkpoint:10` comment.

Record the live command and each case's expected result in `docs/maintainer/self-host.md`.

## Boundaries & Constraints

**Always:**
- Only `test/e2e/**`, `test/fixtures/**` and `docs/maintainer/self-host.md` change (the manifest's globs). The suite composes existing `src/` code and never changes it. It may import, never edit, helpers under `test/core/**`, `test/lane/**` and `test/support/**`.
- **The world** (`gatesWorld(opts)`, pure: options → `main` path → text). It is valid input to `assembleSnapshot`:
  - **Epics 1 to 8:** Phase 0. They are in `bootstrapped_epics`, with headings only and no Stories. `.xarabot/epics.yaml` has `8: {depends_on: [7], checkpoint: true}`, and its go is recorded (`ruling: maintainer-pr`) unless the option `epic8Go: false` is set.
  - **Epics 9 to 14:**
    - 9 `runtime` depends on [8];
    - 10 `contracts` depends on [9];
    - 11 `macroable`, 12 `conditionable` and 13 `json-schema` each depend on [10];
    - 14 `tooling` depends on [9], so it is the Epic that does not depend on `contracts`.
    - Every entry is explicit in `epics.yaml`, because a missing entry would default to the next lower Epic.
  - **Stories:** each of Epics 9 to 14 has Stories `<E>.1` and `<E>.2`.
    - Both have globs `["packages/<slug>/**"]`, so they overlap. `<E>.2` also has `depends_on: ["<E>.1"]`.
    - Sprint key `<E>-<s>-<slug>`.
  - **`sprint-status.yaml`:**
    - Every Story of an Epic in `done` is `done`, and every other Story is `backlog`.
    - `epic-<N>` is `done` for Epics 1 to 8 and for every Epic in `done`, and `backlog` otherwise. So `reconcile` has no status edit to make.
  - **`retro-gates.yaml`** is built with `serializeRetroGates`:
    - `retro` {verdict, `unit: retro:<N>`, `recorded_at`}, with `go` for each Epic in `retroGo`;
    - the items, as `epic-<N>-retro-item-<seq>-<slug>` with `globs: []`;
    - a `checkpoint.go` for each Epic in `checkpointGo`.
  - **The rest:**
    - extra `checkpoint` Epics in `epics.yaml`;
    - a valid context for every Epic (its heading, then the `epicSourceLine` of `epics.md`);
    - `.xarabot/config.yaml` = `scratchSeed({repo, login, runnerVersion}).config` plus `bootstrapped_epics: [1, 2, 3, 4, 5, 6, 7, 8]`;
    - optional extra files, such as a Story spec with `deferred` entries.
- **The overlay** (`gatesForge(forge, world)`). Snapshots show `main` with the world laid over it:
  - every world path is written over;
  - every other `main` path under `_bmad-output/` or `stories/`, and `.xarabot/epics.yaml`, is hidden;
  - blob SHAs come from `gitBlobSha`.
  - `world` is a getter, so `setWorld` can replace it mid-case. That is the simulated merge.
  - `enqueue` is held: it returns `queued: true` unforwarded and records the PR. Nothing is ever merged into the scratch `main`.
- **Builders** (`builderRound(forge, repo, identities)`). For each identity in turn:
  1. Take a snapshot (`read: readsPath`) and assemble it as a builder, with `escalations: null`.
  2. Call `next(…, "builder")`.
  3. On a `unit`, swap the lane's own edit: `takeOverStale({…, generation, globs, baseSha: main})` for a `take_over`, else `claim({…, globs, expectGeneration, manifestSha, baseSha: main})`.
  4. Return one outcome per identity: `{lane, kind: "claimed" | "took-over" | "idle" | "park" | "stop", unit?, reason?}`.
  - A refused swap fails the case.
  - Identities: owner = the area's login, lanes `builder-1` … `builder-4`, each on its own host UUID.
- **Coordinator round** (`coordinatorRound(area)`) runs the real `runCoordinatorProcess`:
  - `steps: {reconcile: createReconcileStep(...)}`;
  - an agent whose `launchSpec` refuses and counts calls (none expected);
  - `unchangedGraph()` and `headPassedGate`;
  - a waiter that returns at once;
  - the claim seeded in `coordinator.json`.
  - The committer records each `ReconcileCommitRequest`:
    - fake: `makeCommit`, with checks `[{name: "check", completed, success}]`;
    - live: a REST commit made with `createTree` (base `ontoSha`'s tree, files inline) and `createCommit` (parent `ontoSha`), through test-only `Operation`s as `DELETE_REF` does.
- **Ledger seed** (one `ledgerSwap` from the tip, at the start of each scratch case):
  - `coordinator.json` (`schema_version: 2`) claimed by the area's coordinator identity at generation 1;
  - `digest_posted_at` = the forge's `now`, so no mention is posted;
  - `rulings_cursor` = the cursor `readRulings(null)` returns, so older comments are never judged;
  - plus the case's unit records.
- **Areas:**
  - `fakeGatesArea()`: `createFakeForge`, `main` = `scratchSeed({repo: "acme/scratch", login: "alice"})`, a fake clock.
  - `liveGatesArea()`: the scratch repo from `XARABOT_LIVE_GITHUB_REPO`, `liveCredentials()`, a fresh ledger branch `xarabot/test-<uuid>`, unit branches prefixed `xarabot-test/<uuid>/` (`prefixed`), and `runner_version` read from the scratch `main`.
    - `cleanup` (`cleanupScratch`: close the PRs, delete the branches and the ledger branch) runs whether the case passes or fails.
  - Each area also provides the Maintainer's comment:
    - fake: `addInboxComment`;
    - live: print to stderr `live gates: comment "/xarabot go checkpoint:10" on <issue url> within 15 minutes`, then poll `readRulings` every 15 s for a comment by the login, compared case-insensitively, whose trimmed body is exactly that.
  - Each area also provides `untilReconcileDue`:
    - fake: the clock moves 11 min;
    - live: poll every 30 s until `reconcileDue` holds, at most 12 min.
- **Checks are pure** and return problem lists. The live case and its rehearsal both assert `[]`:
  - `checkpointProblems(observed)`;
  - `digestProblems(body, expected)`: the header count equals the number of expected items; each expected item has exactly one line starting `- [<label>](<url>) · ` that holds ` · <age>`; there is no other `- [` line. Ages are computed independently: whole days, `<1d` under one.
- **Live switch:** `liveGates = test.skipIf(!liveGithubEnabled || isSandboxed)`. Both live cases' names start `live gates:`.
  - Two nested runs prove the switch, as the canary's "live switch" block does: with `XARABOT_LIVE` unset, and with `XARABOT_LIVE=1 XARABOT_SANDBOXED=1`. Each reports `2 skip`, `0 pass`, `0 fail`.
  - With the switch on, a missing credential fails a named step (`step`/`must`, as in `cross-vendor-harness.ts`). It never skips.

**Never:**
- No change under `src/`, `.github/`, `.xarabot/` or `AGENTS.md`, and no edit of `race-harness.ts`, `cross-vendor-harness.ts` or the existing e2e tests.
- No agent session, no GitHub setting change, and no push to the scratch `main`.
- No GitHub token handled by the suite beyond the existing App credentials. The Maintainer's comment is posted by the Maintainer, by hand.
- No mocks of `next`, the gates, the rulings or `renderDigest`. No expected digest text built by calling `renderDigest`.
- No token-shaped literal.
- If a fixture case shows a gate bug, stop and report it. Never adjust the expectation to the code.

## I/O & Edge-Case Matrix

The world states below: **P1** = Epic 9 done with an `accepted` retro. **P2** = P1 plus Epic 10 done with an `accepted` retro. Four builders run unless a row says otherwise.

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| serial start | nothing done | claims `story:9.1` only; the others idle with `depends-on` (9.2) and `dependency-epic` (Epics 10–14) | — |
| Epic 8's go pending | `epic8Go: false` | no claim; each idle reason starts `waiting-on-maintainer:` and names `checkpoint:8` | — |
| dependency retro missing | Epic 9 done, no retro | no claim from 10 or 14 (`its retro is not recorded`) | — |
| after runtime | P1 | claims `10.1` and `14.1` | — |
| parallel (AC1) | P2 | `11.1`, `12.1`, `13.1` and `14.1` are claimed, and all four records are `claimed` on the ledger at once; a fifth builder idles | — |
| checkpoint pending (AC2) | P2, `checkpoint: [10]`, no go | claims `14.1` only; Epics 11–13 have the `checkpoint` reason naming `checkpoint:10` | — |
| checkpoint, only Maintainer causes | same, with Epic 14 done (and retro) | every builder idles with `waiting-on-maintainer:` | — |
| checkpoint, retro not done | P1 plus Epic 10 done, no retro, checkpoint 10 | 11–13 held, the reason `whose retro is not done`, no `waiting-on-maintainer:` | — |
| late checkpoint, in flight | P2: `11.1` claimed and stale, `12.1` claimed and fresh; then checkpoint 10 is added | `11.1` is taken over; `12.1` stays its holder's; no new claim from 11–13 | — |
| checkpoint go | the pending case plus `checkpointGo: [10]` | `11.1`, `12.1` and `13.1` are claimed | — |
| rejected retro (AC3) | P2 with Epic 10's retro `rejected` | claims `14.1` only; 11–13 have `retro-rejected` naming `retro:10` | — |
| go retro ruled | then `/xarabot go retro:10` from the login → `judgeRulings` → `rulingAdds` → `editRetroGates` → `main` | `11.1`, `12.1` and `13.1` are claimed | the same comment from another login: refused, still held |
| FR10 untagged (AC5) | an untagged open item on Epic 9; P1, then P2 | P1: `10.1` and `14.1` (distance 1, not held). P2: no claim from 11–13 (distance 2, held), `14.1` claimed | — |
| FR10 blocking | a blocking item on 9; P1, then P2 | P1: no claim from 10 or 14. P2: no claim from 11–14 | — |
| FR10 on contracts | P2, an item on Epic 10: untagged / blocking | untagged: 11–13 claimed (distance 1); blocking: 11–13 held, `14.1` claimed (14 does not reach 10) | — |
| FR10 statuses | P2, a blocking item on 10 with status `in-progress`, `waiting`, `deferred` or `done` | the first two hold; the last two hold nothing | — |
| FR10 verdicts | P2, Epic 10's verdict `accepted-with-open-items` with no items; `rejected` with a go | nothing held | — |
| FR10 Maintainer item | P2 plus Epic 14 done, a blocking `route: maintainer` item on 10 | every builder idles with `waiting-on-maintainer:` naming the item | — |
| FR10 block ruling | P2, an untagged item on 10, then `/xarabot block retro-item:<id>` ruled onto `main` | before: 11–13 claimed; after (fresh ledger): 11–13 held | — |
| digest (live + rehearsal) | P2 with Epic 9 `rejected`, no go, plus a `waiting` Maintainer item; Epic 10 `accepted-with-open-items` and a checkpoint with no go, plus an `open` blocking Maintainer item; parked: `story:14.1` blocked `intent-gap` with text, `story:11.1` `needs-approval`, `story:12.1` blocked `human-live-step`; a spec `spec-9-1-runtime.md` with one deferred entry | after one coordinator round the Maintainer's inbox issue body passes `digestProblems` for exactly 8 items: `checkpoint:10`, `retro:9`, both items, the three units and `9.1-d1`, each with its link and age | named step fails |
| checkpoint go (live + rehearsal) | P2 plus checkpoint 10, no go | see AC 4 below | named step fails |
| switch off | `XARABOT_LIVE` unset, or `XARABOT_SANDBOXED=1` | both live cases are skipped: `2 skip`, `0 pass`, `0 fail` | — |
| check tables | observations or bodies that break each rule | `checkpointProblems` / `digestProblems` name the broken rule | — |

</intent-contract>

## Code Map

- `src/core/next/next.ts` (`next`, `NextStory`), `src/core/next/epic-gates.ts` (hold messages: `checkpoint:<E>`, `retro:<E>`, `retro-item:<id> (…, distance d)`, `its retro is not recorded`, `whose retro is not done`), `src/core/next/coordinator.ts` (`WAITING_ON_MAINTAINER`, `reconcileDue`) -- the surfaces under test. Read-only.
- `src/core/next/snapshot.ts` -- `assembleSnapshot`, `epicSourceLine`. `src/core/graph/resolve-graph.ts:241-249` -- an Epic with no `epics.yaml` entry depends on the next lower Epic, so every entry is explicit. `src/core/schemas/epics-yaml.ts` -- `{depends_on, checkpoint: true}`.
- `src/core/reconcile/retro-gates-edit.ts` -- `serializeRetroGates`, `editRetroGates(path, text, [], [], [], rulings)`. `src/core/rulings/effects.ts` -- `judgeRulings(snapshot, [{author, body, id, created_at}])` and `rulingAdds`. `src/core/schemas/retro-gates.ts` -- `RETRO_ITEM_ID_PATTERN`, `GoSchema`.
- `src/core/ledger/edits.ts` -- `claim` (:274), `takeOverStale` (:485), `STALE_AFTER_MS`. The lane builds them at `src/lane/lane-process.ts:886-907`; mirror it. `src/core/ledger/codec.ts` -- `parseLedger`, `serializeCoordinator`, `serializeUnitRecord`, `COORDINATOR_PATH`.
- `src/lane/coordinator-process.ts` -- `runCoordinatorProcess`. The model call is `test/lane/reconcile-step.test.ts:2311-2345` (`round`): `createFsLaneStore`, the abort-waiting heartbeat sleep, a waiter that returns `elapsed`.
- `src/lane/reconcile-step.ts:1159-1290` -- the own-PR path: commit → push → open → CI poll on `expected_checks` (scratch: `[check]`) → fresh `main` → `startMerging` → enqueue, after which the step ends `merging` without watching the queue. A run with nothing to write ends `merged` with no PR. Rulings, then the inbox, run before the PR (`:1251-1253`).
- `test/lane/reconcile-step.test.ts:3110-3175` -- Story 4.6's `go checkpoint` case: the pending entry shape, `gatesOf`, the ack text `🤖 Ruling acknowledged: \`/xarabot go checkpoint:1\``, and the inbox no longer listing the item.
- `src/core/rulings/rulings.ts:281` -- `rulingReply`. `src/core/inbox/render-digest.ts` -- the item shapes the digest check expects:
  - a parked record with no PR links `…/blob/xarabot/claims/units/<unitFileName>`;
  - a gates item links `…/blob/main/<retro_gates_path>`;
  - a deferred entry links `…/blob/main/<spec>`, aged from the spec's `created`;
  - the line is `- [label](url) · what · age · \`verb\``;
  - the header is `🤖 Xarabot inbox: <n> items wait on you.`;
  - `EMPTY_INBOX_BODY`.
- `src/lane/inbox-step.ts` -- the Maintainer's inbox is the lowest-numbered open inbox issue assigned to them. `src/ports/forge.ts:177-277` -- `InboxIssue`, `InboxComment`, `readRulings`.
- `src/adapters/forge/fake/fake-forge.ts` -- `control.setMain`, `setNow`, `makeCommit`, `setChecks`, `addInboxComment`, `inboxes`, `ledgerLog`; `gitBlobSha`.
- `test/e2e/race-harness.ts:99-117` -- `overlayMain` (the model for `gatesForge`, which also hides paths); `:350-372` `storyFor` (assembling a builder snapshot); `:523-638` `liveArea` (credentials, tokens, `raw`, `inner`, `prefixed`, `cleanup`, `runner_version`). Import from it, don't edit it.
- `test/e2e/cross-vendor-harness.ts` -- `step`, `must`, `callSignal`; `HELD_ENQUEUE` and `observe` (:137-165) for the held enqueue. `test/e2e/scratch-seed.ts` -- `scratchSeed`.
- `test/support/live-github.ts` -- `liveGithubEnabled`, `liveRepo`, `LIVE_LOGIN`, `liveCredentials`, `prefixed`, `cleanupScratch`, `RawCall`. `test/support/sandbox.ts` -- `isSandboxed`. `src/adapters/forge/github/http.ts` -- `request`, `isSuccess`, `GITHUB_OPERATIONS.getCommit`.
- `test/core/ledger/fixtures.ts` -- `rec` (a full `UnitRecord`, `schema_version: 6`). `test/lane/graph-stub.ts` -- `unchangedGraph`. `src/lane/passed-gate.ts` -- `headPassedGate`.
- `test/e2e/canary.test.ts:290-327` -- the nested "live switch" tests to mirror.
- `docs/maintainer/self-host.md:928-1077` -- "Epic 3's live evidence (Story 3.6)", the section to mirror; `:471-514` the inbox section.

## Tasks & Acceptance

**Execution:**
- `test/e2e/parallel-epics-harness.ts` (new) -- `gatesWorld`, the slug table, `gatesForge`, `builderRound`, `coordinatorRound`, `seedLedger`, `fakeGatesArea`, `liveGatesArea` (with the REST committer, the Maintainer-comment poll and `untilReconcileDue`), `ruledOnto(main, comment)` (the go/block ruling chain onto the world's `retro-gates.yaml`), `runDigestCase(area)`, `runCheckpointCase(area)`, and the pure `checkpointProblems`, `digestProblems` and `expectedDigest(world, records, now, repoUrl)`. Rationale: one code path, run on the fake forge and on the scratch repo.
- `test/e2e/parallel-epics.test.ts` (new):
  - the world loads (`assembleSnapshot` ok; every non-bootstrapped context `valid`; `missingStatusEntries` empty);
  - every fixture row of the matrix, through `builderRound` on the fake forge;
  - the `checkpointProblems` and `digestProblems` case tables;
  - the two rehearsals (`runDigestCase` and `runCheckpointCase` on `fakeGatesArea`);
  - the two nested live-switch tests;
  - the two live cases: `live gates: the digest …` with a 10 min timeout, and `live gates: the checkpoint go …` with a 45 min timeout. Each prints one summary line: issue number, PR number, comment id.
- `docs/maintainer/self-host.md` -- a new section, "Epic 4's live evidence (Story 4.7)", after Epic 3's:
  - the checkout, as Story 3.6's section has it;
  - no re-seed is needed beyond the canary's;
  - the command `XARABOT_LIVE=1 XARABOT_LIVE_GITHUB_REPO=xaravel/xarabot-scratch XARABOT_LIVE_GITHUB_LOGIN=edanisko bun test test/e2e/parallel-epics.test.ts`;
  - the Maintainer's step during the checkpoint case: post the comment on the printed issue within 15 min, from your own account, exactly `/xarabot go checkpoint:10`;
  - each scratch case's expected result, as a table;
  - the expected counts, measured: in the sandbox and with the switch on;
  - the skip rule;
  - what Epic 4's evidence file (`docs/maintainer/evidence/epic-4.md`) holds;
  - adding `"4": ["<the command>"]` to `live_evidence_checks` in a Maintainer PR, so a failed live row holds `retro:4`.

**Acceptance Criteria:**
- Given the Xaravel-shaped fixture, when `runtime` and then `contracts` are done with their retros, then four builders through `next` hold Stories of `macroable`, `conditionable` and `json-schema` at once.
- Given `contracts` as a checkpoint with its go pending, when builders run, then Epics 11–13 take no new Story and Epic 14 keeps running; once a go is recorded they take Stories.
- Given `contracts`' retro `rejected`, when builders run, then Epics 11–13 take no new Story until the Maintainer's `/xarabot go retro:10` is ruled onto `main`, and take Stories after it.
- Given the scratch repo with checkpoint 10 pending, when the Maintainer comments `/xarabot go checkpoint:10` on the inbox issue, then the next `reconcile`:
  - stores the pending go `{go, checkpoint:10, by, at = the comment's created_at, ruling = its id}`;
  - posts the `🤖 Ruling acknowledged: \`/xarabot go checkpoint:10\` from <login>` reply;
  - opens its PR, whose committed `retro-gates.yaml` sets `epics.10.checkpoint.go`;
  - leaves the inbox as `EMPTY_INBOX_BODY`.
  
  After the simulated merge, builders claim `11.1`, `12.1` and `13.1`. Before the go, round 1's inbox lists `checkpoint:10`, and only `14.1` was claimed.
- Given the scratch repo's inbox, when the digest is rendered, then every waiting item appears once, with its link and age.
- Given `docs/maintainer/self-host.md`, when the Story is done, then it records the live command and each scratch case's expected result, and the live cases are skipped, never passed, inside a sandboxed session.

## Spec Change Log

## Review Triage Log

### 2026-10-27 — Review pass
- verdicts: 36 findings — high 0, medium 5, low 24, false 7, maybe-false 0
- findings:
  - `[medium]` `[patch]` (blind) The live digest case never checks that no PR was opened, and its summary line hard-codes `PR none`. `runDigestCase` now adds a problem for any commit or held enqueue. The line prints the held PR.
  - `[low]` `[patch]` (blind) Round 2's "only `retro-gates.yaml` committed" and "one enqueue held" were asserted only in the rehearsal. Both are now in `runCheckpointCase`'s shared problems.
  - `[low]` `[patch]` (blind) Recorded alerts were never checked in the live cases. Both cases now add a problem that lists any alert recorded.
  - `[low]` `[patch]` (blind) Several fixture rows loop over the idle reasons without asserting a count, so an empty list checks nothing. Each row now asserts its idle count first.
  - `[low]` `[patch]` (blind) "The world loads" leaked a fake area's temp folder on every run. It now uses `fresh()`.
  - `[medium]` `[patch]` (blind) A skipped run (`0 fail`) satisfies the `live_evidence_checks` gate. The doc now says to record only a run with `0 skip`, because the gate cannot tell the two apart. It also adds the Story 2.9 rule: set the key only once every lane's pin has the check.
  - `[low]` `[patch]` (blind) The leftover-cleanup advice did not cover an open `reconcile` PR left by a timed-out run. The doc now gives a `gh pr list` filter for `xarabot-test/` heads, and drops "the branches were already deleted" for a timed-out run.
  - `[low]` `[patch]` (blind) The doc did not say to run the suite alone, or that the fixture digest stays in the inbox afterwards. Both are now in the doc.
  - `[low]` `[patch]` (blind) The parked units' links point at `xarabot/claims` (fixed in `render-digest.ts`) while the records live on the test ledger branch. On a real repo the ledger is `xarabot/claims`, so the product is right. The doc now says those three links are checked as text and do not resolve during the run.
  - `[low]` `[patch]` (blind) `63 pass` and the duration were stated as measured. The doc now calls them expected, not yet measured.
  - `[low]` `[patch]` (blind) `findComment` accepted a matching comment on any inbox issue. It now also requires the printed issue's number.
  - `[low]` `[patch]` (blind) The check tables left some branches untested. Added rows: a pending verb other than `go`, a committed go by another login, an ack from another login, and an expected item with no age.
  - `[low]` `[patch]` (blind) The coordinator's `hostStop` resolved to the shared `$TMPDIR/STOP`. Each area now has its own temp root, holding the lane folder and `STOP`.
  - `[low]` `[patch]` (blind) Wording: "Run the command below" (it is commands, run from `~/xarabot-switch`), and `PR #none` in the checkpoint line. Both corrected.
  - `[false]` `[reject]` (blind) The spec is missing from the diff, and its `created` date is in the future. The spec was left out of the review diff on purpose and went to the edge-case layer as its claims file. The system date in UTC is 2026-10-27.
  - `[low]` `[patch]` (edge) The temp folder leak in "the world loads". Same fix as the blind row.
  - `[low]` `[patch]` (edge) The shared `$TMPDIR/STOP`. Same fix as the blind row.
  - `[medium]` `[patch]` (edge) The live digest case does not check commits or held enqueues. Same fix as the first blind row.
  - `[low]` `[patch]` (edge) Alerts are not asserted in the live cases. Same fix as the blind row.
  - `[low]` `[reject]` (edge) `expectedDigest` would expect `checkpoint:8` twice if a world listed 8 in `checkpoint`. No caller does; Epic 8 is set only through `epic8Go`. Unreachable in the suite, and the fix adds branches.
  - `[low]` `[reject]` (edge) The live REST committer makes an empty commit for unchanged files, and maps 4xx to `transient`. `reconcile` commits only when its plan has an edit, so unchanged files never reach the committer. A permanent 4xx still fails the round, with its message in the named step.
  - `[low]` `[reject]` (edge) A `createRef` whose reply is lost and is then retried gets a 422. This needs a lost reply on one call in a test run; the case fails loudly, and a re-run recovers. The guard adds a branch.
  - `[medium]` `[patch]` (edge) The digest summary line prints a literal `PR none`. Same fix as the first blind row.
  - `[low]` `[patch]` (edge) The live count was stated as measured. Same fix as the blind row.
  - `[low]` `[patch]` (edge) `builderRound`'s docblock claimed lane parity, but it never lists or adopts a Story PR. The docblock now says it mirrors the claim edits for a Story with no PR, which is every fixture world.
  - `[medium]` `[patch]` (verification-gap) The live digest case does not check "no PR opened". Same fix as the first blind row.
  - `[low]` `[patch]` (verification-gap) Idle-reason loops have no count. Same fix as the blind row.
  - `[low]` `[patch]` (verification-gap) The temp folder leak. Same fix as the blind row.
  - `[false]` `[reject]` (intent) AC1's "at once" is one synchronous round of claims, not concurrent lanes. AC1 is a `next` property ("`next` hands builders Stories from all three later Epics"). Four records `claimed` together on the ledger is that property. Concurrent claiming was proven by Story 2.12 (Design Notes).
  - `[false]` `[reject]` (intent) P1 and P2 are separate worlds, not one sequence. Each state is a `main` snapshot, and `next` reads only the snapshot. The serial-start, P1 and P2 rows together cover the sequence the AC describes.
  - `[false]` `[reject]` (intent) AC3's go is carried by the pure ruling chain, not by `reconcile`. AC3 is a fixture case. The chain is exactly the core functions `reconcile` calls (`judgeRulings`, `rulingAdds`, `editRetroGates`). The `reconcile` path for a go is exercised end to end by the checkpoint case.
  - `[false]` `[reject]` (intent) AC4 uses stand-ins (a test-started round, a REST commit and push, a held enqueue, a simulated merge, harness claims). These are the spec's recorded design (Design Notes): only the merge is simulated, to keep the fixture out of the scratch `main`. The REST push exists because the GitHub adapter's push needs a local `runner.git` for a commit made over REST. Opening the PR, its CI run, the rulings, the ack and the ledger all go through the real adapter.
  - `[false]` `[reject]` (intent) FR10's "worked alongside later Stories" half is untested. FR10's success criterion (epics.md) is only about gating ("`next` tests … show that an untagged open item does not gate … and that a `blocking` item gates …"). Working retro-item units is Story 2.10, covered by its own tests.
  - `[low]` `[patch]` (intent) The digest's items are synthetic, and its unit links do not resolve on the test ledger. The synthetic items are by design. The links are noted in the doc (same fix as the blind links row).
  - `[low]` `[patch]` (intent) `63 pass` was never measured. Same fix as the blind row.
  - `[false]` `[reject]` (intent) The fixture adds Epic 14, which is not in the named Phase 1 shape. AC2 needs "an Epic not depending on `contracts`", and none exists in the literal shape once `runtime` is done. The spec adds it for that reason and says so.

## Design Notes

**What is simulated, and why.**
- **The merge:** only the merge of the `reconcile` PR. Merging a `retro-gates.yaml` for Epics 9–14 into the scratch `main` would leak into the canary and cross-vendor runs, which do not overlay it. So the enqueue is held, and `setWorld` lays the PR's committed `retro-gates.yaml` over `main`. The comment, the rulings read, the ack, the ledger swap, the inbox issue and the PR itself are real.
- **The claims:** builders claim with the lane's own `claim`/`takeOverStale` edits through a real ledger swap. The claim loop itself is proven by Story 2.12.

**Why the Maintainer comments by hand.** `go` counts only from `config.maintainer`, and only the Maintainer's own account can author such a comment. Posting it from the suite would need the Maintainer's personal token in test code. The AC also says "the Maintainer comments".

**Golden fragments:**

```text
P2 + checkpoint 10 (builders):  claimed story:14.1; idle "… Epic 11 is held by checkpoint Epic 10 (checkpoint:10), which has no go …"
digest line:  - [story:14.1](https://github.com/acme/scratch/blob/xarabot/claims/units/story__14.1.json) · blocked `intent-gap` · 2d
pending:      {"verb":"go","unit":"checkpoint:10","by":"alice","at":"<comment created_at>","ruling":"<comment id>"}
```

Ages: date each item N days plus 6 hours before the forge's `now` at seeding, so the whole-day count stays the same for 6 hours of wall time.

## Verification

**Commands:**
- `bun test test/e2e/parallel-epics.test.ts` -- expected: `0 fail`; the two live cases skipped in the session.
- `bun test` -- expected: `0 fail`.
- `bun --bun tsc` -- expected: exit 0.
- `bun --bun oxlint` -- expected: exit 0.

## Auto Run Result

Status: done

**Summary:** Story 4.7 adds the parallel Epics and gates verification suite. It runs a graph shaped like Xaravel Phase 1, with Epics 1–8 bootstrapped (8 a checkpoint), 9 `runtime`, 10 `contracts`, 11–13 `macroable`/`conditionable`/`json-schema` and 14 `tooling`.
- **Fixture cases:** builders claim through the real `next` and the lane's own claim edits on the fake forge. They show:
  - Stories of 11, 12 and 13 held at once after `runtime` and `contracts`;
  - the checkpoint, rejected-retro (with the ruled `go retro:10`), dependency and FR10 distance holds, each holding exactly the right Epics;
  - takeovers in a held Epic;
  - `waiting-on-maintainer:`.
- **Scratch cases:** the digest and the checkpoint go run the real coordinator process with the real `reconcile` step. The checkpoint go waits for the Maintainer's hand-posted `/xarabot go checkpoint:10`. Both are live (`XARABOT_LIVE=1`, outside the sandbox) and rehearsed on the fake forge in every `bun test`.
- **Docs:** `docs/maintainer/self-host.md` records the live command, the Maintainer's step, each case's expected result and how to commit the evidence.
- No `src/` change.

**Files changed:**
- `test/e2e/parallel-epics-harness.ts` (new) -- the world, the overlay forge (enqueue held, simulated merge), `builderRound`, `coordinatorRound`, the ledger seed, the fake and live areas (REST commit and branch, the Maintainer-comment poll, `untilReconcileDue`), `ruledOnto`, both scratch cases, and the pure checks `checkpointProblems`, `digestProblems` and `expectedDigest`.
- `test/e2e/parallel-epics.test.ts` (new) -- the world-loads checks, every fixture row of the matrix, the check tables, both rehearsals, the two nested live-switch tests and the two `live gates:` cases.
- `docs/maintainer/self-host.md` -- the new "Epic 4's live evidence (Story 4.7)" section.

**Review:** 36 findings from 4 layers (high 0, medium 5, low 24, false 7).
- **Patched** (14 entries: 2 medium, 12 low):
  - the live digest case now checks that no PR was opened, and prints the observed PR (medium);
  - the docs say a skipped run must not be recorded as evidence, since the `live_evidence_checks` gate sees only `0 fail`, and add the pin caveat (medium);
  - alerts are checked in both live cases;
  - round 2's single gates-only commit and single held enqueue are checked live too;
  - idle counts are asserted before the reason loops;
  - the temp folder leak is fixed;
  - each area has its own `STOP` file;
  - the Maintainer's comment must be on the printed issue;
  - extra check-table rows;
  - the `builderRound` docblock;
  - docs: counts marked not yet measured, leftover PR cleanup, run the suite alone, the unit links' ledger branch, wording.
- **Also fixed before review:** the live checkpoint case passed a comment id as a `readRulings` cursor, which the GitHub adapter refuses. It now reads from the saved cursor.
- **Rejected:**
  - a double `checkpoint:8` expectation (no caller reaches it);
  - the REST committer's empty commit and 4xx mapping (`reconcile` commits only real edits);
  - a lost `createRef` reply (rare, fails loudly).
- **False** (the spec's design, see Design Notes): the synchronous claim round, separate world states, the pure go-retro chain, the AC 4 stand-ins, FR10's "worked alongside" half, Epic 14, and the spec left out of the review diff.
- **Deferred:** none.

**Follow-up review recommended:** true. Two medium entries were patched. The risk not yet verified is that neither live case has run against GitHub; the REST commit and branch, the `readRulings` cursor round trip, the CI wait and the inbox rewrite on the scratch repo are proven only by the fake-forge rehearsals.

**Verification:**
- `bun test test/e2e/parallel-epics.test.ts`: 65 pass, 2 skip (the live cases), 0 fail.
- `bun test`: 6256 pass, 392 skip, 0 fail.
- `bun --bun tsc`: exit 0.
- `bun --bun oxlint`: exit 0.
- Every I/O matrix row is covered by a test that ran and passed. The two live rows are covered by their rehearsals, and the switch-off row by the nested runs.
- A diff scan found no token-shaped literals. No temp folder is left behind.

**Residual risks:**
- The live cases are unrun. The switch-on count (`67 pass`) and the duration in the docs are expectations.
- The checkpoint case needs the Maintainer at the keyboard within 15 minutes of the prompt.
- If a live run crosses 08:00 UTC, a real digest mention may be posted.
- Not committed: this run's instructions leave the changes in the working tree for the runner.
