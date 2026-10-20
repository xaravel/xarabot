# Brownfield: Xaravel's loop today, and the cutover

## What exists (`xaravel/framework`, `tools/orchestrator/`)

- `run.sh`: a launchd driver on the M1 (`com.xaravel.orchestrator.plist`). Each iteration resets a dedicated clone to `origin/main`, runs one fresh `claude -p` session on `iteration.md`, and re-execs itself from `origin/main`. It waits 1 minute after `progress`, 30 after `idle` and 15 after a failure. On a usage-limit hit it sleeps until 2 minutes after the reset (at most 8 h).
- **State:** `~/.xaravel-orchestrator/` holds `history`, `logs/`, `latest.log`, `outcome` (`progress`, `idle` or `stop`) and `STOP`.
- `iteration.md`: the whole policy, in prose. It picks one unit in priority order: open PR, sprint planning, retro, retro action items, checkpoint, next Story, Escalation ruling, pause, idle. It also carries the CI-poll and merge procedure.
- `status.sh` and `progress.sh`: host status, and the "Stories done, loose ETA" line. Status issue #10; every loop comment starts with 🤖.
- **Quick wins in PR #216 (pending the Maintainer's merge):** retro items are tagged `blocking` / `waiting` / `deferred` in `retro-gates.yaml`, and the `Maintainer inbox` issue gets a daily digest.

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
  - The agent identity was deferred to the Epic 8 checkpoint, planned as a separate user account to match `docs/ops/identities.md` and `ruleset:identity`. Xarabot's per-person `<login>-xarabot` bot user is that plan, with a fixed name.
  - The `Agent pushes` ruleset redesign must not block the merge queue or `gh-pages`.
- **Live settings:** GitHub settings, rulesets and secrets are written by the Maintainer, never by a lane.
- **Process control:** kill by exact PID. `pkill -f` can match the `claude -p` command line, which contains the whole prompt.
- **Exit lag:** a `claude -p` session can linger about 12 minutes after its final result before exiting.

## Cutover (Xaravel side, at the Epic 8 checkpoint)

`bmad-correct-course` in Xaravel adds the Infrastructure Story "Adopt the external runner". It:
- replaces `tools/orchestrator/` with the pinned Xarabot package and its config;
- adds the Xarabot config and `.agents/skills` to `conformance/protected-paths`;
- lands a new Maintainer decision that replaces `decisions/MAINT-2026-10-16-unattended-orchestrator.md` and covers Codex's review mode, lanes and parallel Epics;
- creates the `edanisko-xarabot` bot user, registers it under edanisko, and moves `docs/ops/identities.md`, `ruleset:identity` and the `Agent pushes` ruleset redesign to it. The Maintainer does the live GitHub steps.
- ends the MAINT amendments that allow `--admin` merges.
