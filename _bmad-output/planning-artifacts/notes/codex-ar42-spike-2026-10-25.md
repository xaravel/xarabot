# Codex AR42 spike findings (Story 3.1)

- Date: 2026-10-25, 15:25 to 15:40 PDT
- Host: the Xarabot host (`m1`), user `edanisko-xarabot`
- Codex: `codex-cli 0.163.0`. It is the bun global `@openai/codex@0.163.0`. `~/.local/bin/codex` links to `~/.bun/install/global/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`, a Mach-O arm64 binary.
- Auth: ChatGPT login (`codex login status` prints `Logged in using ChatGPT`). The plan is `self_serve_business_prolite`, from the `rate_limits` data in the session file.
- Work folder: `/tmp/codex-spike/work`, a one-commit git repo. The folder was deleted at the end.
- Evidence labels: **observed** means seen on the host. **from docs** means OpenAI's published docs or `--help` text. **from binary** means strings found in the codex binary; such a string exists, but its behavior is not proven. **unverified** means it was not tested.

## Usage

There were 9 `codex exec` calls. Seven of them produced a model answer: A, B, C, D, xhigh, max and ultra. Two were refused by the server with HTTP 400 before any generation (`model_reasoning_effort=bogus`, run twice). That is more than the ~6 budget. The extra calls were the `ultra` probe and the second `bogus` call, which was needed to get the exit code of a failed turn. Each call was small: 14k to 78k input tokens, mostly cached, and at most 130 output tokens.

## Answers

| # | Question | Answer |
|---|---|---|
| 1 | Subagents in `codex exec` | **Yes, observed.** Feature `multi_agent` is `stable true`. The default model has `multi_agent_version: v2`. In one exec run the parent called `spawn_agent` twice (`/root/a`, `/root/b`). Both child threads ran at the same time, the parent called `wait_agent` for each, and then gave the combined answer `alpha beta`. **Caveat:** the `--json` stream shows only `collab_tool_call` items with `tool: "wait"` and an empty `receiver_thread_ids`. The `spawn_agent` calls and the child threads appear only in the session files under `$CODEX_HOME/sessions/` (`thread_source: "subagent"`, `parent_thread_id`). Whether the children's tokens are included in the parent's `turn.completed` usage is **unverified**. |
| 2 | Writing to a file named by an env var | **Yes, observed.** With `XARABOT_RESULT=/tmp/codex-spike/result.json` exported, the agent ran `printf '%s' '{"outcome":"done"}' > "$XARABOT_RESULT"`. The file then held exactly `{"outcome":"done"}` (18 bytes). The parent environment reaches the shell tool. |
| 3 | Resume command and session id | **Observed:** `codex exec resume <thread_id> "<prompt>"` works. The thread id is in the **first** `--json` line: `{"type":"thread.started","thread_id":"<uuid>"}`. The resumed run printed the same `thread_id` and remembered the earlier turn. `--last` picks the newest session in the current folder (`--all` turns off the folder filter). Runs made with `--ephemeral` save no session file and so cannot be resumed (from `--help`). Resuming an *interrupted* session was **unverified** (not tested). |
| 4 | `--json` tokens, cost, model, usage limits | **Observed:** only the final `turn.completed` line has usage: `input_tokens`, `cached_input_tokens` (a subset of input), `cache_write_input_tokens`, `output_tokens` and `reasoning_output_tokens`. The values are totals for the whole turn. The stream has **no cost and no model field.** The model and effort are in the session file (`turn_context.model`, `.effort`). Rate-limit state is also only in the session file: `token_count.rate_limits.primary.{used_percent, window_minutes, resets_at}`, with `resets_at` as Unix seconds, plus `rate_limit_reached_type`. A failed turn produces `{"type":"error","message":...}` and then `{"type":"turn.failed","error":{"message":...}}`, and exit code **1** (observed with a 400 error). **Usage limit (from binary, unverified):** error kind `usage_limit_reached`, message text "You've hit your usage limit… Try again at <time>". The runner should take the reset time from `resets_at` in the session file, not from the message text. |
| 5 | Turning off sandbox, approvals and attribution | **Observed:** `--dangerously-bypass-approvals-and-sandbox` gives `approval_policy: "never"` and `sandbox_policy: danger-full-access`. Alternatives (from `--help`): `-s danger-full-access` (or `-c sandbox_mode=...`) together with `-c approval_policy=never`. **Attribution:** in 0.163.0 the session's instruction config had `"git_attribution":false`, and no `Co-authored-by` or "Generated with" text appeared in any session or rendered prompt, even with `--enable codex_git_commit` (observed). The feature `codex_git_commit` is listed as `removed`. The binary still holds a prompt that forces the `Co-authored-by: Codex <noreply@openai.com>` trailer and a PR line "Generated with [Codex](https://openai.com/codex/)." (from binary). It may be switched by a server field, `commit_attribution_enabled` (from binary, unverified). The docs' setting is `commit_attribution = ""`, which turns the trailer off (from docs; not confirmed for 0.163.0). Commit signatures: no setting was found. |
| 6 | Credentials for a fresh `CODEX_HOME` | **Observed:** a copied `auth.json` (mode 600) in a new, empty `CODEX_HOME` works. `codex login status` printed `Logged in using ChatGPT`, and an exec run completed. No token refresh happened during the run (the copy stayed byte-identical to the original). The copy was deleted right after. **Risk (unverified):** if two homes refresh the same ChatGPT refresh token, one of them may stop working. **API key (from docs and binary):** `CODEX_API_KEY` is supported for `codex exec` only. Other routes are `OPENAI_API_KEY`, `printenv OPENAI_API_KEY \| codex login --with-api-key`, `CODEX_ACCESS_TOKEN` with `codex login --with-access-token`, and `forced_login_method = "chatgpt" \| "api"`. No key was set. |
| 7 | Reasoning effort values; default model | **Default model: `gpt-6.1-sol`** (observed in `turn_context`; it is also priority 0 in `codex debug models`; its default effort is `medium`). **Accepted (observed):** `low`, `medium` (with `exec resume`), `high` (in the fresh home), `xhigh`, `max`, and also `ultra`. **Refused (observed):** `bogus`, with HTTP 400 "Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'." The catalog lists `ultra` for gpt-6.1-sol as "Maximum reasoning with automatic task delegation". The server's list leaves `ultra` out, but the run accepted it, so the client probably maps it to something else (unverified). Every run reported `reasoning_output_tokens: 0`, so effort cannot be confirmed from usage. |
| 8 | Hosts contacted | **Observed (`lsof -i -n -P` sampled every 0.3 s during runs A and C):** only TCP 443 to Cloudflare IPv6 addresses. `2606:4700:4408::ac40:9bd1` resolves to `chatgpt.com` / `ab.chatgpt.com`. `2606:4700:440b::ac40:9034` did not resolve to any candidate tried. Hosts in the binary (from binary): `chatgpt.com`, `ab.chatgpt.com`, `auth.openai.com` (login and token refresh), `api.openai.com` (API-key mode); the rest are help or docs links. Plugin caches name `files.openai.com`. Suggested allowlist: `chatgpt.com`, `ab.chatgpt.com`, `auth.openai.com`, plus `api.openai.com` if an API key is used. `files.openai.com` is unverified. The unresolved address must be found before the allowlist is enforced. |
| 9 | `codex --version` format | **Observed:** `codex-cli 0.163.0` (one line, the literal prefix `codex-cli`, a space, then the semver). The package.json version is the same. |

## Side effects the adapter must plan for (observed)

- **Codex wrote `~/.codex/config.toml`.** The file did not exist before the spike. Run A created it with `[projects."/private/tmp/codex-spike/work"] trust_level = "trusted"`, so codex adds a trust entry for each new working folder. The same thing happened in the fresh `CODEX_HOME`. I left the real file in place because the rule was not to change `~/.codex`. It is harmless (it points to a deleted `/tmp` path), but the Maintainer may want to delete it.
- Other files codex wrote to `$CODEX_HOME`: `sessions/2026/10/25/rollout-*.jsonl` (5 files from this spike remain in `~/.codex`), `plugins/cache/openai-curated-remote/*` (remote plugins: gmail, google-drive, google-calendar and others), `cache/codex_apps_*`, `installation_id`, `logs_2.sqlite`, `queue_1.sqlite`, `state_5.sqlite`, `models_cache.json`, `shell_snapshots/`.
- Every run printed `Reading additional input from stdin...` to stderr, even with `< /dev/null`. The runner must always give `exec` a closed stdin, or a piped stdin can be added to the prompt.
- Turns that fail exit with code 1, and turns that succeed exit with 0. `--json` events go to stdout. The stdin notice goes to stderr.
- `--json` gives no `spawn_agent` events, no model, no cost and no rate-limit data. For those, the adapter must read the session file (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl`), or run with a private `CODEX_HOME` for each lane.
- No codex daemon or app-server process stayed running after the runs. The `daemon_auto_start` feature is `stable true`; `--no-daemon` exists only on the top-level TUI command.

## Evidence

All commands ran as `ssh -o BatchMode=yes edanisko-xarabot@m1 'export PATH=$HOME/.local/bin:$HOME/.bun/bin:$PATH; ...'`.

### Help and features

`codex --help` lists the subcommands `exec`, `resume`, `fork`, `features`, `debug`, `login`, `doctor`, `app-server` and others, and these options:
```
-s, --sandbox <SANDBOX_MODE>  [possible values: read-only, workspace-write, danger-full-access]
--dangerously-bypass-approvals-and-sandbox  Skip all confirmation prompts and execute commands without sandboxing.
-a, --ask-for-approval <APPROVAL_POLICY>  on-request | never
```
`codex exec --help` adds: `resume`, `fork`, `review`, `--json`, `-o/--output-last-message`, `--output-schema`, `--ephemeral`, `--ignore-user-config` ("auth still uses `CODEX_HOME`"), `--skip-git-repo-check`, `-C/--cd`, `--add-dir`.
`codex exec resume --help`: `Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`, with `--last` and `--all`.

`codex features list` (trimmed):
```
multi_agent                              stable             true
multi_agent_v2                           stable             false
codex_git_commit                         removed            false
network_proxy                            experimental       false
daemon_auto_start                        stable             true
plugins / apps / remote_plugin           stable             true
```

`codex debug models` (summary of slug, visibility, priority, default effort, efforts, multi-agent version):
```
gpt-6.1-sol list 0 medium ['low','medium','high','xhigh','max','ultra'] v2 500000
gpt-6-astra list 3 medium [... 'ultra'] v2
gpt-6-luna  list 5 medium ['low','medium','high','xhigh','max'] v2
gpt-5.6-sol list 6 ...
```

### Run A: env-var file write, `--json`, `lsof` (Q2, Q4, Q8)

```
export XARABOT_RESULT=/tmp/codex-spike/result.json
codex exec --json --dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort=low -C /tmp/codex-spike/work \
  "Write the exact text {\"outcome\":\"done\"} to the file whose path is in the environment variable XARABOT_RESULT. Use one shell command. Then reply with just: ok"
```
```
{"type":"thread.started","thread_id":"01a1752b-acea-7ed3-883a-77eb2ba61eae"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I'll write the exact text to the specified file.\n"}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \"printf '%s' '{\\\"outcome\\\":\\\"done\\\"}' > \\\"\"'$XARABOT_RESULT\"'",...,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution",...,"exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"ok"}}
{"type":"turn.completed","usage":{"input_tokens":28344,"cached_input_tokens":24576,"cache_write_input_tokens":0,"output_tokens":68,"reasoning_output_tokens":0}}
rc=0
-rw-r--r--  1 edanisko-xarabot  wheel  18 Oct 25 15:26 /tmp/codex-spike/result.json
{"outcome":"done"}
```
Session file `turn_context`: `"approval_policy":"never","sandbox_policy":{"type":"danger-full-access"},"model":"gpt-6.1-sol",...,"effort":"low"`.
Session file `token_count`: `"rate_limits":{"limit_id":"codex","primary":{"used_percent":0.0,"window_minutes":10080,"resets_at":1793571963},"secondary":null,"credits":{"has_credits":false,...},"plan_type":"self_serve_business_prolite","rate_limit_reached_type":null}` (`resets_at` = 2026-11-01 14:26 PST, a 7-day window).
`lsof` (unique remote addresses):
```
codex 67339 TCP [...]:63457->[2606:4700:4408::ac40:9bd1]:443 (ESTABLISHED)   (x10 sockets)
codex 67339 TCP [...]:63468->[2606:4700:440b::ac40:9034]:443 (ESTABLISHED)   (x4 sockets)
```
`dig +short AAAA chatgpt.com` → `2606:4700:4408::ac40:9bd1 ...`. `ab.chatgpt.com` gives the same address. `api.openai.com`, `auth.openai.com`, `chat.openai.com`, `ws.chatgpt.com` and `files.openai.com` do not match `...440b::ac40:9034`.

### Run B: subagents (Q1)

```
codex exec --json --dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort=low -C /tmp/codex-spike/work \
  "Spawn two subagents in parallel in a single tool-call message. Subagent A replies with the word alpha; subagent B replies with the word beta. Do no other work. Wait for both to finish, then reply with their two answers on one line." < /dev/null
```
`--json` (complete):
```
{"type":"thread.started","thread_id":"01a1752c-71b3-7072-9f95-df9cf17d6444"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_0","type":"collab_tool_call","tool":"wait","sender_thread_id":"01a1752c-71b3-...","receiver_thread_ids":[],"prompt":null,"agents_states":{},"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_0","type":"collab_tool_call","tool":"wait",...,"status":"completed"}}
{"type":"item.started" / "item.completed" ... second "wait" ...}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"alpha beta"}}
{"type":"turn.completed","usage":{"input_tokens":78219,"cached_input_tokens":71040,"cache_write_input_tokens":0,"output_tokens":130,"reasoning_output_tokens":0}}
```
Parent session file:
```
function_call spawn_agent {"task_name":"a","fork_turns":"none","message":"<encrypted>"}  -> {"task_name":"/root/a"}
function_call spawn_agent {"task_name":"b","fork_turns":"none","message":"<encrypted>"}  -> {"task_name":"/root/b"}
function_call wait_agent {"timeout_ms":60000} -> {"message":"Wait completed.","timed_out":false}   (x2)
```
Child session files: `source: {subagent: {thread_spawn: {parent_thread_id: 01a1752c-71b3-..., depth: 1, agent_path: /root/a, agent_nickname: Feynman}}}`. Child a ran 15:26:53 to 15:26:56 and child b ran 15:26:55 to 15:26:58; the two runs overlap. Their answers were `alpha` and `beta`.

### Run C: resume (Q3, effort medium)

```
codex exec resume --json --dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort=medium \
  01a1752b-acea-7ed3-883a-77eb2ba61eae "What exact text did you write to the file earlier? Reply with only that text." < /dev/null
```
```
{"type":"thread.started","thread_id":"01a1752b-acea-7ed3-883a-77eb2ba61eae"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\"outcome\":\"done\"}"}}
{"type":"turn.completed","usage":{"input_tokens":44566,"cached_input_tokens":36864,...,"output_tokens":78,...}}
rc=0
```
`lsof -i -P -a -p $PID` during the run showed only `[2606:4700:4408::ac40:9bd1]:443` (64 samples). The session file now holds `"effort":"low"` and `"effort":"medium"`.

### Run D: fresh `CODEX_HOME` with a copied auth.json (Q6, effort high)

```
umask 077; mkdir -p /tmp/codex-spike/home; cp ~/.codex/auth.json /tmp/codex-spike/home/auth.json; chmod 600 ...
CODEX_HOME=/tmp/codex-spike/home codex login status          -> Logged in using ChatGPT
CODEX_HOME=/tmp/codex-spike/home codex exec --json --ephemeral --dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort=high "Reply with only: ok" < /dev/null
  -> {"type":"thread.started","thread_id":"01a1752d-dbd5-..."} ... "text":"ok" ... turn.completed   rc=0
cmp -s ~/.codex/auth.json /tmp/codex-spike/home/auth.json   -> unchanged (no refresh)
rm -f /tmp/codex-spike/home/auth.json                        -> deleted
```
Codex filled the fresh home with `config.toml` (a trust entry for the working folder), `models_cache.json`, `plugins/`, `cache/`, sqlite databases and `installation_id`.

### Effort probes (Q7)

```
codex exec --json --ephemeral -s read-only -c model_reasoning_effort=<e> "Reply with only: ok" < /dev/null
xhigh -> "ok", turn.completed, rc=0
max   -> "ok", turn.completed, rc=0
ultra -> "ok", turn.completed, rc=0
bogus -> {"type":"error","message":"{\"type\":\"error\",\"error\":{\"message\":\"Invalid response.create payload: Invalid value: 'bogus'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'.\",\"type\":\"invalid_request_error\",...},\"status\":400}"}
         {"type":"turn.failed","error":{"message":"...same..."}}   rc=1
```

### Attribution (Q5)

- The session file's instruction config: `..."environments_instructions":false,"git_attribution":false,...` (observed in run A).
- `grep -c 'Co-authored-by'` over all spike session files gave 0 for each. `codex debug prompt-input --enable codex_git_commit -c commit_attribution='"Bot <b@x.invalid>"' hi` rendered 14 KB of prompt with 0 matches for `Generated with|Co-authored|trailer|b@x.invalid`.
- Binary strings (from binary): `git_attribution` → "When you write or edit a git commit message, ensure the message ends with this trailer exactly once:"; "Commit messages must end with `Co-authored-by: Codex <noreply@openai.com>`"; "Pull request bodies must include the exact line `Generated with [Codex](https://openai.com/codex/).`"; `commit_attribution_enabled` (a server refresh-response field).
- From docs (web search summary of OpenAI's config docs): the trailer comes from `commit_attribution` when `[features].codex_git_commit` is on, and `commit_attribution = ""` turns it off.

### Usage limit and API key (Q4, Q6, from binary or docs)

- Binary strings: `usage_limit_reached`, `rate_limit_reached`, `workspace_owner_usage_limit_reached`, `quota_exceeded`; "You've hit your usage limit. …", " Try again at "; `(?i)try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)`.
- Binary strings: `auth.json OPENAI_API_KEY CODEX_API_KEY CODEX_ACCESS_TOKEN`, "no Codex credentials were found. Run codex login or provide an API key through a supported auth env var.", "auth is provided by environment".
- `codex login --help`: `--with-api-key` ("printenv OPENAI_API_KEY | codex login --with-api-key"), `--with-access-token` ("printenv CODEX_ACCESS_TOKEN | ..."), `--device-auth`.
- Docs (learn.chatgpt.com config reference): `forced_login_method = chatgpt | api`; `model` example `gpt-6.1-sol`; `model_reasoning_effort` "such as low, medium, high, xhigh, max, or ultra"; `analytics.enabled`, `otel.metrics_exporter` (default `statsig`); `features.network_proxy.domains` (default: nothing allowed); "App and connector traffic is not controlled by the sandboxed-command network proxy".

### Hosts (Q8, from binary)

`strings | grep -oE '(https?|wss?)://[a-z0-9.-]*(openai\.com|chatgpt\.com|...)' | sort -u` gave: `ab.chatgpt.com`, `api.openai.com`, `auth.api.openai.org`, `auth.openai.com`, `chat.openai.com`, `chatgpt.com`, `gov.chatgpt.com`, `platform.api.openai.org`, plus help and docs links (`help.`, `developers.`, `community.`, `platform.openai.com`, `learn.chatgpt.com`, `openai.com`).

### Version (Q9)

```
$ codex --version
codex-cli 0.163.0
```

### Cleanup

`find /tmp/codex-spike -name auth.json` returned nothing (the copy was already deleted after run D). Then `rm -rf /tmp/codex-spike` ran, and `ls -d /tmp/codex-spike` gave "No such file or directory". No codex processes were left running. Left in `~/.codex` (written by codex, not by me): `config.toml` (a trust entry for the deleted spike folder), 5 spike session files, and caches.
