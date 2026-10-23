# The `claude` credential

A `claude` lane's sessions sign in with a long-lived OAuth token, never with
the Maintainer's own `~/.claude` login, which the sandbox denies. The runner
reads the token before every session and passes it to the session as
`CLAUDE_CODE_OAUTH_TOKEN`; the session's vendor home (`CLAUDE_CONFIG_DIR`)
holds no copy of it.

| | |
|---|---|
| File | `$XDG_CONFIG_HOME/xarabot/vendors/claude/oauth-token`, or `~/.config/xarabot/vendors/claude/oauth-token` when `XDG_CONFIG_HOME` is unset or empty |
| Contents | the one-line token printed by `claude setup-token` (a trailing newline is fine) |
| Mode | `600`, a regular file (not a symlink), owned by the lane's macOS user |

Set it up as the lane's macOS user. The token is read silently, so it never
lands in shell history:

```sh
claude setup-token
umask 077
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/xarabot/vendors/claude"
read -rs token   # paste the token it printed, then press Return
printf '%s\n' "$token" > "${XDG_CONFIG_HOME:-$HOME/.config}/xarabot/vendors/claude/oauth-token"
unset token
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/xarabot/vendors/claude/oauth-token"
```

The CLI must be at least 2.1.304; when the token expires, replace it by
running the same steps again.

A missing, empty or wrongly-moded file refuses the session, and the refusal
names the file, never its contents. Sessions cannot read the
`xarabot/vendors` folder. The live `Agent` contract cases
(`XARABOT_LIVE=1 bun test test/contracts/agent.claude.contract.test.ts`) need
this file.
