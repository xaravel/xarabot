# Agent adapters

Every adapter runs one unit in a fresh session and returns the same JSON result. Each lane sets `agent`, `model` and `effort` in config; an unset `model` uses the adapter's default below.

| Adapter | How it runs | Default model | Status |
|---|---|---|---|
| `claude` | `claude -p --model <model> --effort <effort> --permission-mode auto`, as Xaravel's `run.sh` does today. | `claude-opus-5-5` | 0.x |
| `codex` | `codex exec -m <model> --json`, with effort set through `-c` (the key is for architecture to verify), network turned on in its sandbox, and the skills exposed through `.agents/skills`. | `gpt-sol-6.1` | 0.x |
| `pi` | `pi -p --mode json --model <provider/id> --thinking <effort>`. The operator signs in to OpenRouter through pi. Runs inside Xarabot's generic sandbox wrapper. | the model picked at OpenRouter sign-in | 0.x |
| `grok` | Only after lanes run as `<login>-xarabot` bot identities (CAP-13). | — | later |

Which adapters may run unattended is repo policy (CAP-7); every adapter's agent runs with no GitHub credentials (SPEC § Constraints).

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

| Builder | Reviewer |
|---|---|
| `claude` | `codex` |
| `codex` | `claude` |
| `pi` | `claude` |

- Xaravel's `bmad-build-auto` `customize.toml` already runs an external tool as a review layer (its Fidelity Review: Codex reviewing Claude-built Stories); Xarabot uses that hook point instead of forking the skill.

## Result

The schema is an architecture decision. Telemetry (CAP-11) needs at least the outcome and the review loopback count from it, plus the lane's agent, model and effort.
