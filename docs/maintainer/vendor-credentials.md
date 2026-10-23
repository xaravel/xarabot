# Vendor credentials

Each agent CLI's credential is a file the Maintainer puts on the Xarabot
host, under `$XDG_CONFIG_HOME/xarabot/vendors/<vendor>/` (or
`~/.config/xarabot/vendors/<vendor>/` when `XDG_CONFIG_HOME` is unset). The
sandbox reads it before every session and refuses the session when it is
missing, empty, not a regular file or not mode `600`. A session never reads
the operator's own CLI login (`~/.claude`, `~/.codex`, `~/.pi`): the sandbox
denies those paths.

## `claude`

| | |
|---|---|
| File | `~/.config/xarabot/vendors/claude/oauth-token` |
| Contents | The long-lived OAuth token that `claude setup-token` prints, on one line |
| Mode | `600`, owned by the lane's macOS user |
| Reaches the session as | `CLAUDE_CODE_OAUTH_TOKEN`, trimmed |
| Vendor home | an empty, re-seeded folder named by `CLAUDE_CONFIG_DIR` |
| API host | `api.anthropic.com` |

To write it, as the lane's user:

```sh
mkdir -p ~/.config/xarabot/vendors/claude
claude setup-token   # copy the token it prints
umask 077 && printf '%s\n' '<token>' > ~/.config/xarabot/vendors/claude/oauth-token
chmod 600 ~/.config/xarabot/vendors/claude/oauth-token
```

The `claude` adapter needs Claude Code `2.1.304` or newer; the lane refuses
to start an older CLI. The session's cost is reported as an estimate, since
an OAuth subscription is not billed per session.

To check the credential end to end, run the live smoke test:
`XARABOT_LIVE=1 bun test test/contracts/agent.contract.test.ts`. It runs a
short sandboxed `claude-haiku-5-5` session and reports skipped without the
file or without `XARABOT_LIVE=1`.
