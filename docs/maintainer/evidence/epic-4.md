# Epic 4 live evidence

The Maintainer's record of Epic 4's live run on the Xarabot host, for `retro:4`. It follows `self-host.md` § "Epic 4's live evidence (Story 4.7)".

There were three runs, and all three are kept:
- **Runs 1 and 2** (2026-10-29) passed every case except the checkpoint go. In both, no `/xarabot go checkpoint:10` comment came within the 15 minutes the case waits.
- **Run 3** (2026-10-30) passed every case, with 0 skip.

Sources: the command outputs in `~/epic4-live-1/`, `~/epic4-live-2/` and `~/epic4-live-3/` on the host, as `edanisko-xarabot`, and the scratch repo's inbox issue #7.

## Setup

- **Host:** the Xarabot host (`m1`), as `edanisko-xarabot`, outside any sandbox (`XARABOT_SANDBOXED` unset), from its `~/xarabot-switch` checkout, fast-forwarded to `main` before each run.
- **Tools:** `bun 1.4.3`.
- **Scratch repo:** `xaravel/xarabot-scratch`, inbox issue [#7](https://github.com/xaravel/xarabot-scratch/issues/7).

## Runs

| Run | Started (UTC) | `main` (no tag) | Command | Result | Time |
|---|---|---|---|---|---|
| 1 | 2026-10-29 23:19:10Z | 0b4b622 | `XARABOT_LIVE=1 XARABOT_LIVE_GITHUB_REPO=xaravel/xarabot-scratch XARABOT_LIVE_GITHUB_LOGIN=edanisko bun test test/e2e/parallel-epics.test.ts` | 66 pass, 0 skip, 1 fail | 960 s |
| 2 | 2026-10-29 23:35:32Z | 7c3f9cc | `XARABOT_LIVE=1 XARABOT_LIVE_GITHUB_REPO=xaravel/xarabot-scratch XARABOT_LIVE_GITHUB_LOGIN=edanisko bun test test/e2e/parallel-epics.test.ts` | 66 pass, 0 skip, 1 fail | 961 s |
| 3 | 2026-10-30 02:10:24Z | e3117f2 | `XARABOT_LIVE=1 XARABOT_LIVE_GITHUB_REPO=xaravel/xarabot-scratch XARABOT_LIVE_GITHUB_LOGIN=edanisko bun test test/e2e/parallel-epics.test.ts` | 67 pass, 0 skip, 0 fail | 767 s |

## Run 3, the passing run

The two `live gates:` lines:
```
live gates: digest: inbox #7, PR none, comment none; 8 items
live gates: checkpoint go: inbox #7, PR #26, comment 6513325056
```

- **The Maintainer's comment:** <https://github.com/xaravel/xarabot-scratch/issues/7#issuecomment-6513325056>, posted 02:17:28Z, inside the window. Reconcile ruled it and acknowledged it (comment 6513379589), and carried it in scratch PR #26.
- **A second, duplicate comment:** the Maintainer also posted the same go at 02:17:43Z (comment 6513328393). Reconcile answered it "Ruling not applied" (comment 6513379726), as a go already applied should be.
- Both cases passed: `live gates: the digest lists every waiting item once, …` (28.6 s) and `live gates: the checkpoint go from the Maintainer's comment is ruled by reconcile, and then 11.1, 12.1 and 13.1 are claimed` (736.7 s).

## The failed runs

Both failed only in `live gates: the checkpoint go from the Maintainer's comment …`, at:
```
step "the Maintainer's comment": no comment "/xarabot go checkpoint:10" by edanisko on #7 was read in time
```
Every other case passed, including the digest case, which printed `live gates: digest: inbox #7, PR none, comment none; 8 items` both times.

- **Cause:** no comment was posted within the 15 minutes. In run 1, the Maintainer's session watched the output through a stream that delivered the prompt only when the stream ended, so the issue link reached the Maintainer too late. In run 2, the link was sent, but the Maintainer was away.
- **Changed:** nothing in the code. For run 3, the session started the run only once the Maintainer said they could watch, then waited for the prompt and sent the issue link right away.
