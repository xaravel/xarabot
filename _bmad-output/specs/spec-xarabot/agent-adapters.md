# Agent adapters

Every adapter runs one unit in a fresh session and returns the same JSON result. Each lane sets `agent`, `model` and `effort` in config; an unset `model` uses the adapter's default below, and an unset `effort` is `high`.

| Adapter | How it runs | Default model | Status |
|---|---|---|---|
| `claude` | `claude -p --model <model> --effort <effort> --permission-mode auto`, as Xaravel's `run.sh` does today. | `claude-opus-5-5` | 0.x |
| `codex` | `codex exec -m <model> --json -c model_reasoning_effort=<effort>`, with the skills exposed through `.agents/skills`. | `gpt-6.1-sol` | 0.x |
| `pi` | `pi -p --mode json --model <provider/id> --thinking <effort>`. The operator signs in to OpenRouter through pi. | none: the lane must set `model`, or it refuses to start | 0.x |
| `grok` | Only after lanes run as `<login>-xarabot` bot identities (CAP-13). | — | later |

- **One sandbox:** every adapter's agent runs inside Xarabot's own sandbox, with the agent's own sandbox turned off inside it, no GitHub credentials and no GitHub host (SPEC § Constraints; spine AD-17).
- **Unattended:** which adapters may run unattended is repo policy (CAP-7).
- **CLI versions:** each adapter has a minimum tested CLI version, not a pin: claude 2.1.304, codex-cli 0.163.0, pi 1.3.0.

## Model and effort

One lane config shape for every adapter:

```yaml
agent: claude        # claude | codex | pi
model: claude-opus-5-5
effort: high         # low | medium | high | xhigh | max
```

| `effort` | `claude` | `pi` | `codex` |
|---|---|---|---|
| `low` … `max` | `--effort <same>` | `--thinking <same>` | `-c model_reasoning_effort=<same>` |

- An `effort` the adapter does not offer for the lane's model stops the lane at start. It is never dropped or rounded silently.
- Flag ranges: Claude Code `--effort low|medium|high|xhigh|max`; pi `--thinking off|minimal|low|medium|high|xhigh|max`; codex `-m`, `-c key=value`.

## Cross-vendor review (CAP-8)

The runner picks the reviewer: the first allowed adapter of `claude`, `codex` whose model's vendor is not among the vendors of the models that built the unit. A session's vendor is its model's, never the adapter's: `claude` is Anthropic, `codex` is OpenAI, and a `pi` session is the vendor in its `<provider>/<id>` model (through OpenRouter, the underlying model's vendor).

| Builder | Reviewer |
|---|---|
| `claude` | `codex` |
| `codex` | `claude` |
| `pi` with an Anthropic model | `codex` |
| `pi` with any other vendor's model | `claude` |

- If no allowed reviewer from another vendor is left, the unit parks blocked. A session whose reported model differs from its config fails the attempt.
- Xaravel's `bmad-build-auto` Fidelity Review (Codex reviewing Claude-built Stories) may still run for earlier feedback; it never counts as the gate (spine AD-16).

## Result

The schema is spine AD-14: one shape per unit kind (`build`, `review`, `retro`, `planning`), written to the path in `XARABOT_RESULT`. Telemetry (CAP-11) takes agent, model, effort, tokens and cost from the lane config and the CLI's own output, never from the result.
