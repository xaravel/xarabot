# Bootstrap loop

Builds Xarabot's Epic 1 unattended, one Story per iteration, until Xarabot's own sandboxed runner can take over at the self-host switch (SPEC "Bootstrap", spine AD-31, Story 1.20). It's a copy of Xaravel's `tools/orchestrator`, changed in these ways:

- **Identity.** It runs as a dedicated macOS user on the Xarabot host and acts only as `edanisko-xarabot[bot]`. `token.ts` mints that bot's installation tokens from the App key that `bootstrap/join.ts` wrote. Commits are authored by the bot.
- **Two layers.**
  - **The driver**, `run.sh`, is deterministic bash and the only part that holds a GitHub token. It pushes, opens PRs, polls CI and merges.
  - **The Claude session** it starts builds one Story with `bmad-build-auto` and commits locally. It gets no token, no push and no PR.
- **Merge gate.** A PR merges only after the Maintainer's approving review on its head commit, and never with `--admin`.
- **Scope.** It builds only Epic 1's Stories, in `sprint-status.yaml` order. There is no retro, planning, action item, checkpoint or Escalation handling: the Maintainer runs Epic 1's retro interactively at the switch.
- **Pinned copy.** It runs from the copy that `install.sh` put in `~/.xarabot-bootstrap/`, never from the clone it builds. A merged change to `bootstrap/loop/` takes effect only after reinstalling.

## One iteration

1. It checks for `STOP`, saves any uncommitted `story/*` work as a local `[bootstrap wip]` commit, and resets the clone to `origin/main`.
2. **If a bootstrap PR is open**, it handles that and nothing else, with no Claude session unless CI fails:
   - A **conflict with `main`** is merged in. If that needs a human, the loop holds and comments on the PR.
   - **Failing checks** start a CI-fix session, at most 2 per PR. After that it holds and comments.
   - **Pending checks** are polled every 5 minutes.
   - **Green** waits for `@edanisko`'s approval on the head commit. Once approved, it squash-merges.
   - A **draft** PR is a blocked Story and waits for the Maintainer.
3. **Otherwise** it takes the first Epic 1 Story in `sprint-status.yaml` that isn't `done`, and runs one session on `story/<id>` with `iteration.md`.
   - **Done:** the driver pushes and opens the PR with `@edanisko` as reviewer.
   - **Blocked:** it pushes and opens a **draft** PR that carries the reason, and writes `state/blocked/<id>`.
   - **Three sessions with no valid result** also block the Story. A usage-limit hit sleeps until the reset instead.
4. It sleeps, then re-executes the installed copy. The sleep is:
   - 1 minute after progress;
   - 5 minutes while checks are pending;
   - 10 minutes while waiting for approval;
   - 15 minutes after a failure;
   - 30 minutes while blocked.

When every Epic 1 Story is `done`, it writes `STOP` and exits.

## Setup

Done once by the Maintainer. Xaravel's own loop keeps running on the same Mac under your account, and nothing here touches it.

### On the Xarabot host, as your admin account

1. **Create a standard (not admin) user named `edanisko-xarabot`**, for example `sudo sysadminctl -addUser edanisko-xarabot -fullName "Xarabot bootstrap" -password -`. Allow it in System Settings → General → Sharing → Remote Login.
2. **Lock your home:** `chmod 700 /Users/<you>`. After that, the new user can run only shared tools: `/usr/bin/git` and `/usr/bin/jq`. Anything installed in your home, such as `~/.local/bin/gh`, `uv` or `claude`, is out of its reach, so step 4 gives it its own copies.
3. **Authorize your ssh key** in `/Users/edanisko-xarabot/.ssh/authorized_keys`. This key logs you *in*. The user itself gets no ssh private key, no `gh` login and no GitHub keychain item.

### As `edanisko-xarabot` (ssh in)

4. **Install its own tools** in its `~/.local/bin` and `~/.bun/bin`, since it can't reach yours:
   - Bun 1.4.3: `curl -fsSL https://bun.sh/install | bash -s bun-v1.4.3`
   - Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`
   - uv: `curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh`
   - gh: unzip the latest `gh_<version>_macOS_arm64.zip` from https://github.com/cli/cli/releases and copy its `bin/gh` to `~/.local/bin/gh`. It stays logged out: the driver passes a bot token per command.
5. **Store the Claude credential** where Xarabot's runner will read it (spine AD-17):
   - `mkdir -p ~/.config/xarabot/vendors/claude && chmod 700 ~/.config/xarabot ~/.config/xarabot/vendors ~/.config/xarabot/vendors/claude`
   - Run `claude setup-token` and save the printed token as `~/.config/xarabot/vendors/claude/oauth-token`, mode 600.
   - If it's your own Claude subscription, this loop shares its usage limits with Xaravel's loop.
6. **Copy the App key** from the machine that ran `join.ts`:
   - `scp -r ~/.config/xarabot/apps/edanisko-xarabot edanisko-xarabot@<host>:.config/xarabot/apps/`
   - Then, on the host: `chmod 700 ~/.config/xarabot/apps ~/.config/xarabot/apps/edanisko-xarabot && chmod 600 ~/.config/xarabot/apps/edanisko-xarabot/private-key.pem`
   - Once the loop works, consider deleting the copy on the other machine. Alternatively, generate a fresh key in the App's settings and revoke the old one.
7. **Clone and install:**
   - `git clone https://github.com/xaravel/xarabot.git ~/repos/xarabot` (the repo is public, so no credential is needed to clone)
   - `bash ~/repos/xarabot/bootstrap/loop/install.sh`
   - Check the bot with `bun ~/.xarabot-bootstrap/token.ts identity`. It should print `edanisko-xarabot[bot]` and its noreply email.

### On GitHub, as the Maintainer

8. **Require your approval on `main`.** This is already set, on 2026-10-22, in the `Protect main` ruleset's pull-request rule: 1 approving review, stale approvals dismissed on push, and the most recent push must be approved.
   - GitHub never lets an author approve their own PR, so the ruleset also lets repository admins bypass the review, through the PR only. You merge your own PRs by ticking the bypass box.
   - The bot isn't an admin, so its PRs always wait for your approval.
   - The driver checks your approval on the head commit itself too.
9. **After Story 1.1 merges,** copy `docs/maintainer/ci-workflow.yml` into `.github/workflows/` in a Maintainer PR, and make it a required check on `main`. Lanes never write `.github/**`, and the App has no `workflows` permission.
10. **`issues: write` on the App** is Story 1.10's precondition. The App already has it (checked 2026-10-23). The loop still reports on each PR rather than on a status issue.

### Start it, as your admin account on the host

11. Install and load the LaunchDaemon. It isn't a LaunchAgent: the bootstrap user never logs in at the screen, so it has no `gui/` launchd domain. Its home is mode 700, so reading the plist from its clone needs `sudo` too.

```sh
sudo sed "s|__USER__|edanisko-xarabot|g" /Users/edanisko-xarabot/repos/xarabot/bootstrap/loop/com.xarabot.bootstrap.plist \
  | sudo tee /Library/LaunchDaemons/com.xarabot.bootstrap.plist >/dev/null
sudo launchctl bootstrap system /Library/LaunchDaemons/com.xarabot.bootstrap.plist
```

## Watching it

The commands below run as `edanisko-xarabot` on the host.

- **Your GitHub notifications:** every Story PR requests your review. Approve it to let it merge.
- **One line per iteration:** `cat ~/.xarabot-bootstrap/state/history`.
- **Live narration:** `tail -F ~/.xarabot-bootstrap/state/latest.log | jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text'`.

## Stopping and resuming

- **Stop after the current iteration:** `touch ~/.xarabot-bootstrap/state/STOP`. To resume, delete it and run `sudo launchctl kickstart system/com.xarabot.bootstrap`.
- **Stop now:** `sudo launchctl bootout system/com.xarabot.bootstrap`. Stop any other process by its exact PID, never with `pkill -f`: that matches the `claude -p` command line, which contains the whole prompt.
- **Retry a blocked Story:**
  1. Deal with the reason in the draft PR.
  2. Close that PR.
  3. Delete `~/.xarabot-bootstrap/state/blocked/<id>`.
  4. To start the Story over rather than resume it, also delete the `story/<id>` branch, locally and on GitHub.
- **Update the loop:** merge the change to `bootstrap/loop/`, then run `git -C ~/repos/xarabot fetch && bash ~/repos/xarabot/bootstrap/loop/install.sh`. The next iteration runs the new copy.
