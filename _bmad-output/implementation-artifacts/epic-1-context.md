# Epic 1 Context: One sandboxed lane builds Stories unattended

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

The Maintainer installs a pinned Xarabot runner on the Xarabot host (macOS), and one `claude` lane builds Stories with no human watching. `next` picks the Story in code. The agent runs sandboxed with no GitHub credential or host access. The runner commits as `edanisko-xarabot[bot]`, opens the PR, polls CI, parks the PR until the Maintainer approves it, merges through the merge queue, sleeps through usage limits, keeps a journal and obeys STOP. This is the self-host threshold. Once this lane works inside its sandbox, Xarabot's own pinned runner replaces the bootstrap copy of Xaravel's loop and builds every later Epic.

## Stories

- Story 1.1: Package scaffold and test harness
- Story 1.2: Config, policy and Standing Authority, failing closed
- Story 1.3: Story manifests and the `epics.md` grammar
- Story 1.4: `resolveGraph` and `xarabot graph check`
- Story 1.5: Ledger records and pure ledger edits
- Story 1.6: `next` for a builder lane
- Story 1.7: `Forge` port, fake forge and contract suite
- Story 1.8: GitHub adapter: tokens, snapshot and ledger swap
- Story 1.9: GitHub adapter: pushes and PRs
- Story 1.10: GitHub adapter: checks, merge queue and alerts
- Story 1.11: macOS sandbox: profile, launcher and vendor home
- Story 1.12: Sandbox network proxy
- Story 1.13: Result schemas and prompt assembly
- Story 1.14: The `claude` adapter
- Story 1.15: `runner.git`: clone rebuild, bot commit and sanitizer
- Story 1.16: The lane process: one unit from claim to result
- Story 1.16a: Opening the PR
- Story 1.17: CI polling, CI fixes and conflicts
- Story 1.17a: Approval gate and merge queue
- Story 1.18: Waits, STOP, `wake`, `stop --now` and usage limits
- Story 1.19: `xarabot lane install` and the pinned runner
- Story 1.20: Canary and self-host runbook

## Requirements & Constraints

- **Toolchain:** Bun 1.4.3 only (runtime, tests, packages, `Bun.YAML`, `Bun.Glob`), TypeScript 7.0.2 with `--strict`, oxlint 1.89.0 and zod 4.6.7, all pinned exactly. Never use Node, npm, pnpm, Jest, Vitest, ESLint or Prettier. Run checks with `bun test`, `bun --bun oxlint` and `bun --bun tsc`.
- **Live tests:** live cases run only when `XARABOT_LIVE=1` is set and otherwise report skipped. Sandbox suites detect `XARABOT_SANDBOXED=1` and skip their nested cases. Each Story names its tests: core Stories use case tables with no mocks, adapters pass contract suites, sandbox Stories have a refusal test, and security Stories have negative tests.
- **No GitHub for agents:** a session never gets a GitHub token and never reaches a GitHub host. Only the runner holds the App key, mints 1-hour installation tokens (kept in memory only) and talks to GitHub. Anything a session needs from GitHub is prefetched into files.
- **Fail closed:** a missing or invalid config, policy or Standing Authority stops the lane. The Standing Authority is re-checked from fresh `main` before every claim, push, enqueue and merge. A guard error blocks rather than allows.
- **Identity:** every commit and PR is authored by the owner's bot. Never add `Co-Authored-By` or similar markers, and pass the CLI's attribution-off setting. Never use admin merges or GitHub auto-merge, and the bot has no approve operation.
- **Approval gate:** until Epic 3 merges, every path in Xarabot's own repo needs the Maintainer's approving review, and the host runs `XARABOT_MAX_BUILDERS=1`. Until Epic 2 adds `reconcile`, the Maintainer approves and enqueues parked PRs by hand, and the lane then records them `merged`.
- **Brownfield lessons:**
  - Poll CI by hand every 30 s, backing off to 5 min. Never use `gh pr checks --watch`. Stop at the first unexpected failure, and treat an empty reply as pending.
  - Squash through the merge queue, never with `--delete-branch`.
  - Merge `origin/main` into a conflicting PR before polling. For status YAML conflicts, keep `main`'s lines and re-apply the PR's own entries.
  - Kill processes by exact PID, never `pkill`, and never use a `timeout` binary.
  - A `claude -p` session can linger about 12 minutes after its result, so kill it 5 minutes after the result file appears.
  - Report denied auto-mode actions in `denied_actions[]`; never work around them.
- **Out of scope:** Linux and `bwrap`, the write check (Epic 2), claim heartbeat and takeover (Epic 2), the `codex` and `pi` adapters, cross-vendor review, the inbox digest, the TUI, and the local-only forge.

## Technical Decisions

- **Layers (functional core, imperative shell):**
  - `src/core/` is pure. It never calls `fetch`, `Bun.spawn`, the filesystem, `Date.now()` or `process.env`. It returns `{ok:true,value}|{ok:false,error:{kind,message}}` and never throws.
  - `src/ports/` holds one port per file.
  - `src/adapters/forge/github/` and `src/adapters/agent/claude/` never import each other.
  - `src/sandbox/` is the only place that spawns agents. `Bun.spawn` is banned under `src/adapters/agent/`.
  - `src/lane/` and `src/cli/` sit on top. Lint or a test enforces the import boundaries.
- **Ports:**
  - `Forge`: `snapshot()` (ledger tip, `main` SHA, PR states, server `now`), `ledgerSwap(oldSha, edit)` returning ok or conflict, `pushBranch(lease)`, PR operations, `comment`, `checks`, `enqueue(expectedHead)`, `dequeue`, `alert`, `prefetch`.
  - `Agent`: `launchSpec`, `parseUsage`, `effortValues`.
  - `Sandbox`: `run`.
  - `LaneStore`: PIDs, journal, outcome, STOP.
  - Adapters make one attempt per call. Compare-and-swap retry loops live in `src/lane/` and stop after 10 tries or at the deadline.
  - Forge error kinds are `conflict`, `not-fast-forward`, `auth`, `forbidden`, `rate-limited`, `not-found`, `uninstalled` and `transient`. `auth`, `forbidden` and `uninstalled` stop the lane with an alert.
  - Every port has one contract suite in `test/contracts/`. The in-memory fake forge passes the same suite as GitHub.
- **Schemas:** every runtime-validated shape (config, policy, Standing Authority, manifests, ledger records, results, journal, `Snapshot`) has one zod schema in `src/core/schemas/` with its TypeScript type inferred from it.
- **Ledger:**
  - The ledger is the branch `xarabot/claims`, with `units/<unit-file-id>.json` and `coordinator.json`. Swaps are fast-forward only and commits carry `[skip ci]`.
  - A pure edit re-checks every precondition against the tip.
  - Records are versioned (`schema_version`) with states `claimed`, `merging`, `parked`, `released` and `merged`. `generation` only rises, and `attempts` survives a release. An unknown `schema_version` stops the lane.
  - Time comes from the forge's server `now`.
- **Graph and `next`:**
  - `resolveGraph` is pure. It reads `.xarabot/epics.yaml` (strict, versioned schema), the `## Epic <n>:` and `### Story <n>.<n>[a-z]?:` headings in `epics.md` (ignoring fenced code and the Epic List) and the manifests, all from one `main` SHA.
  - With no graph file, Epics run serially. Checkpoints are never inferred.
  - An Epic in `bootstrapped_epics` counts as fully done.
  - A builder's `next` takes the lowest eligible Epic, then the lowest Story. A Story is eligible only once its Epic's context file exists and starts with `# Epic <N> Context:`.
- **Manifests:**
  - One file per Story, with frontmatter `story_id`, `epic`, `sprint_key` and `title`, plus `globs` or a mapped key, optional `depends_on`, and optional `infrastructure: true`.
  - Globs are normalized: strip `./`, reject `!`, `..` and absolute paths, and compare by case-folded prefix.
  - The spec file is the single match of `story_spec_path`. The default is `_bmad-output/implementation-artifacts/spec-<epic>-<story>-*.md`.
- **Unit ids and branches:** unit ids look like `story:1.7`, and ledger file names replace `:` with `__`. A Story's branch is `story/<id>`, with one branch and one PR per unit. A claim inspects the existing branch and PRs and adopts an open PR.
- **Process model:**
  - Each launchd job runs one process per unit: it runs at most one unit, waits, then exits.
  - Each process records `lane.pid`, `agent.pid` and `wait.pid`.
  - Waits are child `sleep`s: 1 min after progress, 30 min after idle, 15 min after a failure.
  - The unit budget is 6 h, and an agent session gets 3 h.
  - Every forge, git or HTTP call has an `AbortSignal` deadline.
- **Results:**
  - The session writes JSON to `XARABOT_RESULT` as the prompt's last step. The result is a union by `kind`: build, review, retro or planning. Every kind carries `denied_actions[]`.
  - A missing result gets one resume (`claude -p --resume`). A result still missing or invalid counts as a failed attempt, and the unit parks at 3 attempts or more.
  - Tokens, model and timings are never taken from the agent.
- **Prompt:** `core/prompt` builds the prompt purely from the package template and repo sections. It names the unit, for example "Build Story 1.7 (`1-7-...`)", and contains no selection, CI, merge or status instructions.
- **Git:**
  - The runner's private `runner.git` is invisible to the sandbox. The runner rebuilds the agent clone from it before every session and reads only the working tree.
  - The runner makes one bot-authored commit, three-way merged onto `origin/main`.
  - The runner's git runs hardened: no system or global config, hooks off, the token passed only through a stdin credential helper, and `GIT_TERMINAL_PROMPT=0`.
  - A pure sanitizer strips trailers, closing keywords and @mentions from forge text. Status comments start with 🤖.
- **Sandbox (macOS):**
  - `sandbox-exec` with a generated profile.
  - Reads are denied by default. The only writes allowed are to the clone, the vendor home and the temp folder.
  - The environment is an allowlist, and `HOME` is a fresh directory.
  - The vendor home is re-seeded before every session. `claude` gets `CLAUDE_CODE_OAUTH_TOKEN` from a mode-600 file under `$XDG_CONFIG_HOME/xarabot/vendors/claude/`.
  - Network goes only through Xarabot's Bun proxy, allowing vendor API hosts and PyPI. A GitHub host is never allowed.
  - Setup fails closed.
- **STOP and usage limits:**
  - `~/.xarabot/STOP` stops the host and a lane's `STOP` stops that lane. Both are checked at process start, before `next` and before each claim.
  - `stop --now` kills by recorded PID after checking each process's start time and command.
  - On a usage limit, sleep until the reset plus 2 min, or 15 min if the reset can't be parsed, capped at 8 h. The sleep can be woken.
  - Three failed starts in a row write the lane's own `STOP` and post an alert.
- **Pinned runner:** the lane runs `~/.xarabot/runner/<version>/`, with the version from `runner_version` in `.xarabot/config.yaml`. The fixed launcher is `~/.xarabot/bin/xarabot-lane`. When `main` names a new version, the lane installs it and exits, and it never re-execs mid-unit.
- **Journal and config:**
  - The journal is `journal.jsonl`: one record per unit, plus idle and waiting spans. Subscription cost is labelled an estimate.
  - Config comes in three layers: package defaults, repo `.xarabot/*` read from `origin/main`, and host `host.yaml`.
  - The Standing Authority frontmatter has `schema_version: 1`, `granted_by` (the Maintainer's login), `granted_at`, `repo` and an optional `expires`.
- **Spikes:**
  - The merge-queue App permission (Story 1.10, before merge plumbing).
  - Whether `PATCH git/refs` signals a retry with 409 or 422 (forge contract suite).
  - The proxy hostname allowlist (Story 1.12).
  - The `claude` outcome mapping, resume and `--output-format` (Story 1.14).

## Cross-Story Dependencies

- The bootstrap copy of Xaravel's loop builds these Stories strictly in order from `epics.md` prose. Each depends only on earlier ones and must stand alone. Epic 1 has no Story manifests.
- Precondition (a Human Live Step): the bootstrap copy runs as a dedicated macOS user that holds only the bot key, the Claude credential and its clone.
- Story 1.20 sets up the self-host switch. There, the Maintainer sets `bootstrapped_epics: [1]`, runs sprint planning so Epic 1's Stories are marked `done`, and writes Epic 2's manifests and context file.
- The CI workflow is a Maintainer step, because lanes never write `.github/**`. Story 1.1 proposes it in `docs/maintainer/ci-workflow.yml`.
