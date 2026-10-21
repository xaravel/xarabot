# Brownfield: Xaravel's loop today

## What exists (`xaravel/framework`, `tools/orchestrator/`)

- `run.sh`: a launchd driver on the M1 (`com.xaravel.orchestrator.plist`). Each iteration resets a dedicated clone to `origin/main`, runs one fresh `claude -p` session on `iteration.md`, and re-execs itself from `origin/main`. It waits 1 minute after `progress`, 30 after `idle` and 15 after a failure. On a usage-limit hit it sleeps until 2 minutes after the reset (at most 8 h).
- **State:** `~/.xaravel-orchestrator/` holds `history`, `logs/`, `latest.log`, `outcome` (`progress`, `idle` or `stop`) and `STOP`.
- `iteration.md`: the whole policy, in prose. It picks one unit in priority order: open PR, sprint planning, retro, retro action items, checkpoint, next Story, Escalation ruling, pause, idle. It also carries the CI-poll and merge procedure.
- `status.sh` and `progress.sh`: host status, and the "Stories done, loose ETA" line. Status issue #10; every loop comment starts with 🤖.
- **State (2026-10-20):** paused after Phase 0. Epic 8 and its retrospective are done, its checkpoint go is pending, and Epic 9 (the first Phase 1 Epic) is in backlog. The loop is stopped until Xaravel adopts Xarabot.
- **PR #216 (merged):** the `Maintainer inbox` issue with a daily digest, and batch routing of Maintainer-only retro items. CAP-9 and that batch routing port it. Its `blocking` tag was trimmed out, because it pays off only with parallel lanes; CAP-10 is first built in Xarabot.

## Lessons the Xarabot must keep (each cost real time)

- **Interrupted work:** an iteration that dies mid-unit leaves work behind. Commit it as a local `[orchestrator wip]` commit before any reset, and resume from that branch.
- **CI polling:**
  - Don't use `gh pr checks --watch`: it waits for every check after a real failure has shown, and `--fail-fast` stops on expected failures.
  - macOS has no `timeout`.
  - Stop on the first unexpected failure. An empty `gh` reply means pending.
- **Conflicts:** while a PR conflicts with `main`, GitHub runs only its `pull_request_target` checks, so merge `origin/main` into it before polling. For the status YAML files, keep `main`'s lines and re-apply the PR's own entries.
- **Merges:** a squash merge goes through the merge queue. `--delete-branch` is rejected while the queue is on. Under Claude auto mode, `gh pr merge` must be a standalone command to match the allow rule.
- **Auto-mode limits:** the permission classifier refuses replacing a tracked file wholesale (`cp`, `mv`, `>`), so edit in place. A denied action must be reported, never worked around.
- **Why there are admin merges today:**
  - The `protected-paths` check needs `@edanisko`'s approving review, and GitHub won't let the loop, running as `edanisko`, approve its own PR. The loop therefore merges expected failures with `--admin` under MAINT amendments.
  - CAP-13 ends this. Lanes act as `edanisko-xarabot`, so edanisko's approval is a real one, and the bot has no admin rights.
- **Identities:**
  - The `xaravel-oracle` App signs Oracle fixtures.
  - The `xaravel-bot` App (ID 5386144) runs the promotion and quarantine bots.
  - The agent identity was planned as a separate user account to match `docs/ops/identities.md` and `ruleset:identity`. Xarabot's per-person bot replaces that plan with a GitHub App owned by each person; `edanisko-xarabot` exists before Xarabot's bootstrap. Xaravel's existing App pattern carries over: its ownership check already recognizes `xaravel-bot[bot]` (type `Bot`) as an author.
  - The `Agent pushes` ruleset redesign must not block the merge queue or `gh-pages`.
- **Live settings:** GitHub settings, rulesets and secrets are written by the Maintainer, never by a lane.
- **Process control:** kill by exact PID. `pkill -f` can match the `claude -p` command line, which contains the whole prompt.
- **Exit lag:** a `claude -p` session can linger about 12 minutes after its final result before exiting.

## Adoption (planned and run in Xaravel)

A Xaravel course correction adds an Epic before Epic 9 that adopts Xarabot. Inputs it needs from here:
- replace `tools/orchestrator/` with the pinned Xarabot package and its config;
- add the Xarabot config and `.agents/skills` to `conformance/protected-paths`;
- make `decisions/MAINT-2026-10-16-unattended-orchestrator.md` its Standing Authority file, covering Codex's review mode, lanes and parallel Epics;
- add `xaravel/framework` to `edanisko-xarabot`'s `xaravel` installation, register it under edanisko, and move `docs/ops/identities.md`, `ruleset:identity` and the `Agent pushes` ruleset redesign from a separate user account to the App. The Maintainer does the live GitHub steps;
- end the MAINT amendments that allow `--admin` merges.
