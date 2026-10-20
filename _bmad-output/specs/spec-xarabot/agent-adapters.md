# Agent adapters

Every adapter runs one unit in a fresh session and returns the same JSON result. Each lane sets `agent`, `model` and `effort` in config.

| Adapter | How it runs | Status |
|---|---|---|
| `claude` | `claude -p --model <model> --effort <effort> --permission-mode auto`, as Xaravel's `run.sh` does today (model `claude-opus-5-5`). | 0.x |
| `codex` | `codex exec -m <model> --json`, with effort set through `-c` (the key is for architecture to verify), model `gpt-sol-6.1`, network turned on in its sandbox, and the skills exposed through `.agents/skills`. | 0.x |
| `pi` | `pi -p --mode json --model <provider/id> --thinking <effort>`. The operator signs in to OpenRouter through pi and picks the model there, with a flash-tier model where the repo allows it. Runs inside Xarabot's generic sandbox wrapper. | 0.x |
| `grok` | Only after lanes run as `<login>-xarabot` bot identities (CAP-13). | later |

Which adapters, and which models, may run unattended is the consuming repo's policy (CAP-7). The adapter decides only how the coding agent runs. Every adapter's agent runs with no GitHub credentials; the runner commits, pushes and opens PRs as the owner's bot (CAP-18).

## Model and effort

One lane config shape for every adapter:

```yaml
agent: claude        # claude | codex | pi
model: claude-opus-5-5
effort: high         # low | medium | high | xhigh | max
```

| `effort` | `claude` | `pi` | `codex` |
|---|---|---|---|
| `low` … `xhigh` | `--effort <same>` | `--thinking <same>` | its reasoning-effort value of the same name (to verify) |
| `max` | `--effort max` | `--thinking max` | to verify; refused if codex has no equivalent |

- An `effort` an adapter cannot honor stops the lane at start. It is never dropped or rounded silently.
- Flags checked on 2026-10-20: Claude Code (`--effort low|medium|high|xhigh|max`), pi 1.2.0 (`--thinking off|minimal|low|medium|high|xhigh|max`), codex-cli 0.163.0 (`-m`, `-c key=value`).

## Cross-vendor review (CAP-8)

- Codex reviews Claude-built diffs, and Claude reviews Codex-built ones.
- Xaravel's `bmad-build-auto` `customize.toml` already allows an external tool as a review layer; Xarabot uses that hook point instead of forking the skill.

## Result

The session does only the unit's work, then returns a JSON result that Xarabot validates; Xarabot then pushes, opens the PR, polls CI and merges (CAP-6). The schema is an architecture decision. Telemetry (CAP-11) needs at least the outcome and the review loopback count from it, plus the lane's agent, model and effort.
