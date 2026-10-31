# Epic 6 Context: Operators can see and measure every lane
<!-- source: sha256:040283187240510a162d8bd1ac3717715668845b421a6aa2a7d5cc39be926467 -->

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Operators see what every lane is doing and can measure how well the lanes work. `xarabot status --json --watch` reports each lane's unit, claim, CI and merge state and the inbox. A read-only TUI draws that stream on the host or from a laptop over ssh. `xarabot report` compares agents and models and computes the Stories-per-hour figure that is Xarabot 0.x's success signal. All of it reads, and none of it decides. The Epic ends with the report reproducing a hand-computed Stories-per-hour figure from a fixture journal, and the live view working locally and over ssh.

## Stories

- Story 6.1: `xarabot status --json`
- Story 6.2: Watching status, locally and over ssh
- Story 6.3: The TUI
- Story 6.4: `xarabot report` and log retention
- Story 6.5: Status and report verification

## Requirements & Constraints

- **Read-only.** Status, watch, TUI and report never swap the ledger, push, change a PR, enqueue, comment or write a file, and a lane's ledger record, journal and outcome are unchanged by them. Tests assert this. The TUI has no key or command that acts on lanes, claims or PRs. It quits on `q` or Ctrl-C.
- **Status content.** One schema-valid document per host covers every lane of every repo:
  - each lane's identity, role, agent, model and effort;
  - its state: running a unit, waiting with its reason, idle, or stopped by STOP;
  - its unit and claim (`generation`, heartbeat age), and its PR, CI and merge-queue state;
  - per repo, each owner's inbox summary (item count, oldest age);
  - per repo, a progress line: Stories done of Stories planned, with a loose ETA.

  An unreachable forge still yields the local lane state, with the forge fields marked unavailable and the error kind given.
- **ETA.** The merge rate comes from the host's builder journals: unit records for Stories that ended `merged`, over the last 7 days, or since the first such record if that is newer. It is a loose estimate, and it adds no forge read.
- **Watch.** `--watch` prints one JSON line whenever lane state changes, and at least every 30 seconds otherwise, with forge reads rate-limited to stay within API limits. It exits at once, leaving no child process, when ssh ends or on SIGINT or SIGTERM.
- **Remote.** `--host` is a bare switch on `status --watch` and on `tui`, and `XARABOT_HOST` supplies the host's name. `XARABOT_HOST` alone never switches a command to ssh: it is host-layer config and may be set on the host itself. Over ssh the output lines are relayed unchanged.
- **Report figures, per agent and model, over `--from`/`--to`:**
  - units done: unit records whose result is `done`, of every unit kind, including one that then parks awaiting approval;
  - median unit time, over the same records;
  - first-pass review rate: units whose first review passed, over units that carry the first-review verdict field, so units that never reached review and older records are left out;
  - CI-fix count;
  - cost, with subscription cost labelled an estimate. A builder row's cost includes its review passes, whoever reviewed, and the report says so.

  `--json` prints the same figures as a schema-valid document a consumer's dashboard can read.
- **Stories per hour,** one figure per repo: the repo's Stories whose PR merged in the period (read from the forge, by merge time), divided by wall-clock hours, minus the time when every one of that repo's builder lanes is in a `waiting-on-maintainer` span. Each builder's span lasts until that lane's next journal record. The coordinator is not counted. `usage-limit` time is never left out. All lanes and adapters count, with no Story-size normalization.
- **Retention.** A lane process deletes logs older than 30 days. Journals are never deleted.
- **Tests.** Case tables on fixture journals cover each report figure, an all-builders-waiting span, a span where only some wait, and an all-lanes `usage-limit` span. The TUI renders with plain ANSI and no new runtime dependency, tested against golden frames from fixture status lines. Live cases need `XARABOT_LIVE=1` and report skipped, never passed, inside a sandboxed session.

## Technical Decisions

- **One status interface.** `xarabot status --json --watch` is the only status source. The TUI draws its stream and nothing else, and every status shape has a zod schema in `src/core/schemas/`.
- **Status inputs.** Status reads the lane state folders (PID files, STOP, the live state file) and one `Forge.snapshot()` per repo. Stories planned and done come from `sprint-status.yaml` on `main`, the one home of that fact.
- **Live state file.** Lane and coordinator processes write a new state file in the lane state folder as they go: the current unit, the state (running a unit, waiting, idle) and the wait reason (for example `usage-limit`, a CI wait, `waiting-on-maintainer`). The `LaneStore` port gains its write and read, and status reads it to show the exact reason a lane waits.
- **Host launcher.** `xarabot lane install` also writes a fixed launcher, `~/.xarabot/bin/xarabot`, beside `xarabot-lane`. It runs the runner version named in the most recently written lane `runner` file. Version names are free-form, so they are never ordered, and after a pin-back the launcher follows the pin-back. The ssh command runs this launcher.
- **Journal changes for the report:**
  - The coordinator fills the unit record's existing `result` field from its session: a finished planning or retro-item unit, and a retro whose document validates, report `done`. `reconcile` runs no session and never counts. Older records with `result: null` do not count.
  - One optional field records the first review's verdict on a unit record. It is the only journal field added.
- **Forge read for merged Stories.** A read of the PRs merged in a period is added to the `Forge` port, the GitHub and fake forges, and the forge contract suite. Every GitHub call goes through the adapter's single request function and its permission table.

## Cross-Story Dependencies

- 6.1 and 6.4 build on the owner inboxes and journal reasons (Story 4.2). 6.2 needs 6.1, and 6.3 needs 6.2. 6.5 comes last and needs 6.3 and 6.4.
- Epic 6 depends on Epic 4 and runs in parallel with Epic 5. Stories 6.1, 6.2 and 6.4 touch `src/adapters/forge/github/**`, as Epic 5's Stories do, so claims serialize them. 6.1 and 6.4 also touch `src/lane/**`.
- 6.5's fixture covers a stated 7-day window with `waiting-on-maintainer` and `usage-limit` spans and a hand-computed figure. Its live checks run `xarabot tui --host` on a laptop with `XARABOT_HOST` set and `xarabot tui` with no flag on the host. 6.5 records them with their expected results in `docs/maintainer/self-host.md`, and the Maintainer runs them outside the sandbox before Epic 6's retro.
- While every path in Xarabot's own repo still needs the Maintainer's approving review, `reconcile` merges most Stories, which makes the ETA run long. Merged code takes effect only after the Maintainer advances `runner_version`.
