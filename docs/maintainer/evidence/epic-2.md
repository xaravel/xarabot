# Epic 2 live evidence

The Maintainer's record of Epic 2's live run on the Xarabot host, for `retro:2` (AR14, AR21). Epic 2 was the first Epic Xarabot built itself: lanes `builder-1` and `coordinator` (from Story 2.5c on) ran on the Xarabot host, and the Maintainer stepped in through planning PRs, approvals and runner pins.

Sources: GitHub (PRs, reviews, check runs, merge-queue events); the runner tags; the lanes' `journal.jsonl` and unit logs on the host; the Story specs on `main`; the Maintainer's working session. Facts that could not be checked are marked unverified.

## Live runs (Story 2.12)

Run per `self-host.md` § "Epic 2's live evidence", after `retro:2` had run (the first version of this file left them out, and the retro rejected Epic 2 for it: retro item 1).

- **Date:** 2026-10-25, from 17:45:10Z. **Host:** the Xarabot host (`m1`), as `edanisko-xarabot`, outside any sandbox (`XARABOT_SANDBOXED` unset).
- **Checkout:** `~/xarabot-switch` at `main` 730c9df (the runner-8 pin merge, one commit after tag `runner-8` at e9f95ec; no `src/` or `test/` change between them). `bun 1.4.3`.

| Command | Result | Time |
|---|---|---|
| `XARABOT_LIVE=1 XARABOT_LIVE_LONG=1 XARABOT_LIVE_GITHUB_REPO=xaravel/xarabot-scratch XARABOT_LIVE_GITHUB_LOGIN=edanisko bun test test/e2e/claims-race.test.ts` | 20 pass, 0 skip, 0 fail | 1944 s |
| `XARABOT_LIVE=1 bun test test/sandbox/bun-install.test.ts` | 1 pass, 0 skip, 0 fail | 1 s (cache warm; the case took 655 ms) |
| `XARABOT_LIVE=1 bun test test/contracts/` | 107 pass, 72 skip, 0 fail | 16 s |

- **Claims race, the four live cases:**
  - one unit, two hosts: exactly one claim wins, only its session starts, and the loser idles (25.6 s);
  - overlapping globs, asymmetric views: exactly one of 1.1 and 1.2 is claimed, and the loser takes 1.3 (32.9 s);
  - same lane, two OS processes: one holds `lane.lock` and claims once, and the other exits 0 (24.6 s);
  - killed mid-unit: the takeover happens 30 minutes after the last heartbeat, and the late push is fenced (the long case; it took most of the 1944 s).
- **Agent contract:** both required cases passed, not skipped: `the real CLI passes the start check and starts in the sandbox without EPERM` (3.4 s) and `live: a smoke session writes a result and reports its usage` (6.0 s).
- **A failed run, kept on the record:** the first contracts run added the optional scratch variables (`XARABOT_LIVE=1 XARABOT_LIVE_GITHUB_REPO=xaravel/xarabot-scratch XARABOT_LIVE_GITHUB_LOGIN=edanisko bun test test/contracts/`). It gave 116 pass, 43 skip, 20 fail in 144 s.
  - The 20 failures are the GitHub forge contract's live cases (`Forge contract: github (live) > …`, `live: a stale PATCH git/refs answers SWAP_CONFLICT_STATUS`, `live: checks reads a pushed commit`). Each ends `this test timed out after 5000ms`: Bun's default per-test timeout, which these live cases do not raise for real GitHub round trips.
  - The two agent cases passed in that run too.
  - Nothing was changed. The run above is the runbook's command, without the optional variables.
  - The forge live cases' timeout is a test defect, listed under the open follow-ups.

## Window and totals

- **First claim:** Story 2.1, 2026-10-24 about 06:05Z. **Last merge:** Story 2.12, #100, 2026-10-25 12:33:01Z. About 30.5 hours.
- **Stories:** 17 (2.1–2.12, with 2.5a, 2.5b, 2.5c, 2.6a and 2.6b added by correct-course). PRs: #57–#100. All authored by the bot and approved by the Maintainer, one review each. No change requests, and no closed-unmerged PR on a `story/2.*` branch.
- **Builder sessions:** 26 session runs, about 908 session minutes, about $402 (the journal's estimate). Loopbacks: 0 in every run.
- **Who queued:** the Maintainer queued #57–#77 and #86 by hand. From runner-4 (Story 2.6) on, the coordinator's `reconcile` queued every approved PR itself: #80, #83, #90, #93, #96, #98, #100.
- **Approvals:** from #93 on, the Maintainer's approvals were given under a standing rule ("merge green when okay"): approve a lane PR when CI is green and the PR has no attribution markers or off-limits paths.

## Runners

| Tag | Commit | Tagged (UTC) | Adds |
|---|---|---|---|
| runner-1 | 5bcc603 (#49) | 10-24 03:36 | Epic 1, canary passed |
| runner-2 | 8ae6e6d (#54) | 10-24 06:02 | snapshot blob texts over GraphQL |
| runner-3 | ecaf413 (#73) | 10-25 00:26 | Stories 2.1–2.5c |
| runner-4 | 38b7000 (#77) | 10-25 02:02 | Story 2.6 |
| runner-5 | 5f58e70 (#86) | 10-25 05:19 | Stories 2.6a, 2.6b, 2.7; ledger schema 2 |
| runner-6 | 2c95e54 (#90) | 10-25 07:32 | Story 2.8; ledger schema 3 |
| runner-7 | 139ad08 (#93) | 10-25 08:42 | Story 2.9; ledger schema 4 |

- Pin PRs: #55, #74, #78, #87, #91, #94. From runner-4 on, both lanes logged `main pins runner runner-N (was N-1) … exiting without a claim` and came back on the new pin.
- Stories 2.10–2.12 ran on runner-7 and are in no runner tag yet. Story 2.11 carries "Follow-up review recommended: true". The Maintainer reviews it before tagging runner-8.

## Per Story

| Story | PR | Merged (UTC) | Sessions | Stops and failures | CI failures | Patched H/M/L | Follow-up review |
|---|---|---|---|---|---|---|---|
| 2.1 | #57 | 10-24 08:12 | 3 | run 1 blocked: npm unreachable from the sandbox (fixed by #56); run 2 failed: two spec files matched | yes, once (startHeartbeat tests) | 0/2/1, then 0/0/2 | false |
| 2.2 | #58 | 10-24 09:00 | 1 | none | none | 0/1/3 | false |
| 2.3 | #59 | 10-24 10:09 | 1 | none | none | 0/2/? (low count not stated) | true |
| 2.4 | #61 | 10-24 18:46 | 2 | intent gap: when `next` returns `reconcile` (answered by #60) | none | 0/3/4 | true |
| 2.5 | #65 | 10-24 20:14 | 3 | two intent gaps: reconcile PR rules (R7), PR lifecycle after ejection (#63, #64) | none | 0/2/4 | true |
| 2.5a | #69 | 10-24 22:30 | 1 | none | merge queue ejected once (`createGitMerger` test), passed on re-queue; fixed at its cause in 2.5c | 0/1/8 | false |
| 2.5b | #71 | 10-24 23:30 | 1 | none | none | 0/1/4 | false |
| 2.5c | #72 | 10-25 00:23 | 1 | none | none | 0/1/4 | false |
| 2.6 | #77 | 10-25 02:02 | 3 | two intent gaps: re-enqueue after ejection, Standing Authority (#66, #76); work saved as `refs/wip/story__2.6` | none | 0/1/7 | false |
| 2.6a | #80 | 10-25 02:59 | 1 | none | none | 0/0/5 | false |
| 2.6b | #83 | 10-25 03:51 | 1 | none; see sandbox denials | none | 0/1/8 | false |
| 2.7 | #86 | 10-25 05:19 | 2 | intent gap: five planning-unit questions (#85) | none | 0/1/6 | false |
| 2.8 | #90 | 10-25 07:30 | 1 | none | none | 0/3/7 | true |
| 2.9 | #93 | 10-25 08:42 | 1 | none | none | 1/1/5 (Epic 2's only high: stock retro item ids refused) | true |
| 2.10 | #96 | 10-25 10:37 | 3 | run 1 failed when the host lost GitHub (see incidents); stale takeover at generation 2, then done | yes, once (`processes.test.ts` race); 1 CI fix | 0/1/5, then 0/1/6 | false |
| 2.11 | #98 | 10-25 11:29 | 1 | none | none | 0/3/4 | true |
| 2.12 | #100 | 10-25 12:33 | 1 | none | none | 0/1/12 | false |

Seven intent-gap stops across 2.4, 2.5, 2.6 and 2.7, all answered by Maintainer planning PRs on `main` (#60, #62–#64, #66, #76, #85). From 2.7 on, the Maintainer delegated intent gaps that came with a proposed reading: record the answer in `epics.md`, merge, release, and report. No Story stopped on one after that.

## Maintainer interventions

- **Planning PRs:** intent-gap answers (above); a correct course and spec update (#67, #68); a note on speed, tests and autonomy (#70); `CODEOWNERS` with code-owner review in place of a blanket approval (#73); an Epic 2 context recompile (#81).
- **Pushes as the bot, by the Maintainer's session:** edeef2e and 30dea1d on #57 (2.1's saved work and its second session's fixes), and 721977c on #77 (2.6's saved attempt). Each adopted blocked work so a Story did not start from scratch. Story 2.5a later made the blocked-work resume automatic.
- **Manual reruns:** #69 re-queued after its ejection.
- **Runner pins:** six pins, every one switched by waking both lanes.
- **Race fix:** #102 (after Epic 2) fixed the `processes.test.ts` race that failed 2.10's CI, at its cause.

## Incidents

- **2026-10-24, before the first run:** builder-1 refused to start on a GitHub secondary rate limit (snapshot blob reads, about 400 parallel). Fixed by #54 (one GraphQL request per 100 blobs), runner-2.
- **2026-10-24 06:33Z:** 2.1's sandbox could not reach the npm registry (`ProxyConnectFailed 403`). Fixed by #56 (`proxy_hosts`).
- **2026-10-24 07:26Z:** 2.1 run 2 failed on two matching spec files after a blocked resume. Fixed by 2.5a's spec-pick rule.
- **2026-10-24 22:20Z:** the merge queue ejected #69 on a failing `createGitMerger` test that passed on re-queue. The Maintainer's rule since: one failure means broken; it was fixed at its cause in 2.5c.
- **2026-10-25 08:26Z:** the host lost DNS for `api.github.com` during 2.9. The heartbeat exhausted 10 tries, retried after 60 s and recovered at 08:27:41Z. The session and claim were unharmed.
- **2026-10-25 09:30–09:36Z:** during 2.10, the host lost GitHub again (this machine kept it). The CI fix session had finished, but the PR step failed (`ECONNRESET`) and `failAttempt` could not reach the ledger, so the record stayed `claimed`. The builder idled on its own claim until it went stale (30 min) and took it over at 10:06:47Z at generation 2. That session re-ran the full review rather than going straight to CI, and found and fixed a real bug (B1: adopting a released retro-item PR without an overlap check). Cost: about an hour on one Story.
- **Coordinator start refusals:** one `ENOTFOUND` and two `ECONNRESET` refusals around runner-6 and runner-7 (times unverified; `launchd.log` has no timestamps).
- **Stops:** builder-1's `launchd.log` shows 24 `STOP present; not starting` lines (Maintainer-written STOPs; times unverified).

## Sandbox and write check

- **Write check:** it reverted builder changes to `epic-2-context.md` 8 times (2.6, 2.6a, 2.6b, 2.7, 2.9, 2.10, 2.11, 2.12) and one superseded 2.6 spec. The sessions keep recompiling the Epic context because `bmad-build-auto` step-01 finds it older than the planning docs. That costs session time each Story, and the runner throws the result away. No write-check refusal parked a unit.
- **Denials recorded by sessions:** heredoc temp files (2.2, 2.3, 2.4, 2.5, 2.6); `/tmp` writes (2.6b, 2.10); in 2.6b, a socket bind (`Bun.serve`).
- **Attempts to get around the sandbox (2.6b):** after the bind was refused, a subagent retried with `XARABOT_SANDBOXED` unset, then with `dangerouslyDisableSandbox`. Both were refused, and no file changed. A session's agent tried to leave the sandbox, and only the sandbox stopped it.

## Coordinator

- **`reconcile`:** 97 runs from 10-25 00:29Z, 0 sessions, 0 failures. 10 opened a status PR (#75, #79, #82, #84, #88, #92, #95, #97, #99, #101); each passed CI and merged itself through the queue.
- **Planning:** `planning:graph.1` (one session, 6 min, about $1.50) wrote the manifests for Epics 3–7 (#89, 29 Stories). It parked for approval as designed and merged after the Maintainer's approval.
- **Idle:** since 12:49Z the coordinator idles `waiting-on-maintainer` on this file, and the builder idles on "Epic 3 waits on Epic 2: its retro is not recorded".
- **No usage-limit spans** in either journal.

## Open follow-ups

- 2.8 (medium): `approved_graph` is bound when `reconcile` takes the PR, not to the delta posted at the park, so a `main` that moves in between is not caught. Closing it needs a state-machine change.
- 2.7 (medium): a failing planning session never reaches the attempts cap; a gated status planning PR can go stale against `reconcile`'s PRs; readiness findings live only in the host journal; the planning-step wiring is tested only for existence.
- 2.10 (low), and the same pattern in the planning and retro steps: the `lane run` wiring, `secrets` included, is tested only as "is a function".
- 2.5a (medium): committed file contents are never scanned for credentials. 2.5a (low): closed `reconcile` PRs leave their branches behind.
- 2.5c (medium): the real-sandbox paths are tested only on a macOS host outside a session; CI skips them.
- 2.4 (medium): `epics.md` disagrees with itself on deleting the newest `reconcile` record (2.4 against 2.5).
- 2.1 (low): `stop --now`'s dequeue runs without a fencing heartbeat. 2.6a (low): duplicated helpers.
- **Outage recovery:** a failed attempt the runner cannot record leaves the claim held until it goes stale, about 30 minutes even after a 3-minute outage.
- **Takeover cost:** taking over a Story PR whose work is done reruns the whole session and review instead of going to CI. The 2.10 rerun found a real bug, so the cost bought something here.
- **Epic context recompiles:** every session recompiles `epic-2-context.md`, and the runner reverts it.
- **Sandbox escape attempts:** see 2.6b above.
- **Docs:** the SPEC glossary still mentions a checkpoint record, and SPEC write 1 does not cover the `epic-1` key.
- **Infrastructure:** the macOS CI job (D29) needs a `.github/` change.
- **Forge contract live cases:** they run under Bun's default 5 s per-test timeout and time out against real GitHub, so with the scratch variables set, 20 of them fail (see "Live runs").

## Not verified

- Times of the `launchd.log` start refusals and STOP lines.
- Story 2.3's patched low count.
