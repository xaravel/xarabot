---
title: 'Story 1.19: `xarabot lane install` and the pinned runner'
type: 'feature'
created: '2026-10-23'
baseline_revision: 'dd939c96220c99376e4b6290f15e04b73fa480eb'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Nothing installs a lane or starts one. `runLaneProcess` has no production caller, there is no pinned runner, no launcher, no launchd job, and no start checks. So FR1, NFR15, AR22, AR26 and AR34 are not in code.

**Approach:**
- `xarabot lane install` writes the lane to `host.yaml` and installs the runner version that `main` pins. It then writes the fixed launcher and a launchd plist.
- The launcher runs `xarabot lane run <repo> <lane>` from the pinned runner.
- `lane run` checks STOP, then the runner version, then the refusal table. Only then does it compose the real adapters and run one `runLaneProcess`.

## Boundaries & Constraints

**Always:**
- **Paths.** The host paths move from `src/cli/lane-commands.ts` (`paths`, `laneDirFor`) into a shared `src/cli/host-paths.ts`:
  - `xarabot` is `~/.xarabot`.
  - `hostYaml` is `<config>/xarabot/host.yaml`.
  - `bin` is `~/.xarabot/bin`.
  - `runnerRoot` is `~/.xarabot/runner`.
  - `hostStop` is `~/.xarabot/STOP`.

  The lane folder also holds `runner` (the version and a newline) and `failed-starts` (a count and a newline).
- **Pure core (`src/core/lane/runner.ts`):**
  - `checkRunnerVersion(v)` accepts `^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$`, refusing `..` anywhere. The version is used as both the git tag and the folder name.
  - `parseRunnerFile(text)` returns the version from the first line, or an error.
  - `MAX_FAILED_STARTS = 3`. `afterFailedStart(count)` returns `{count: count + 1, stop: count + 1 >= 3}`.
  - `builderLimit(raw)`: unset or empty gives 1, a positive integer gives itself, and anything else is an error.
  - `builderRefusal(host, laneName, limit)` refuses a builder lane when `host.yaml` has more builder lanes than `limit`, counted across all repos. A coordinator is never refused here.
  - `unattendedRefusal(policy, agent)` refuses an agent that is not in `unattended_adapters`.
- **Pure core (`src/core/lane/launchd.ts`):**
  - `laneLabel(repo, lane)` is `com.xarabot.lane.<owner>__<name>.<lane>`.
  - `renderLauncher({bun})` returns the POSIX `sh` launcher text:
    1. It takes exactly `<owner>/<name> <lane>` and validates both.
    2. It reads the version from `<laneDir>/runner` and validates it with the same pattern as `checkRunnerVersion`.
    3. It needs `~/.xarabot/runner/<v>/src/cli/main.ts`. Each failure prints to stderr and exits non-zero.
    4. It runs `unset XARABOT_SANDBOXED`, then `exec <bun> <runner>/src/cli/main.ts lane run <repo> <lane>`.
  - `renderPlist({label, launcher, repo, lane, user, home, env, log})` returns a LaunchDaemon plist with:
    - `UserName`;
    - `ProgramArguments` set to `[launcher, repo, lane]`;
    - `EnvironmentVariables` from `env`, sorted;
    - `RunAtLoad` and `KeepAlive` both true;
    - `ThrottleInterval` 60;
    - stdout and stderr going to `log`.

    Every string is XML-escaped. `env` is the allowlist `HOME`, `PATH`, `LANG`, `XDG_CONFIG_HOME` and `XARABOT_MAX_BUILDERS`, each only when set at install time. It never includes `XARABOT_SANDBOXED`.
- **Runner install (`src/lane/runner-install.ts`).** `installRunner({runnerRoot, version, url, credential?, signal, installDeps?})`:
  1. It checks the version.
  2. If `<runnerRoot>/<version>` already exists, it returns `{installed: false}`.
  3. Otherwise it builds a staging folder `<runnerRoot>/.staging-<version>-<pid>-<random>`. Through `runGit`, it runs `init`, then `fetch --depth=1 --no-tags <url> refs/tags/<version>`, then checks out `FETCH_HEAD^{commit}` into the staging work tree.
  4. It writes `.xarabot-runner` (`<version>\n<sha>\n`) and removes `.git`.
  5. It runs `installDeps`, which by default is `<process.execPath> install --frozen-lockfile --production` in the staging folder.
  6. It renames the staging folder to `<runnerRoot>/<version>`.

  Any failure removes the staging folder and returns an error naming the step. It never throws. If the rename loses a race to a folder that now exists, that counts as success.
- **GitHub adapter additions:**
  - `fetch-shas.ts`: `createGitHubFetch({repo, credentials, gitDir, gitUrl?, apiUrl?, fetch?, now?})` returns a `FetchShas`-shaped function. It mints a token, runs `fetch --no-tags <repoUrl> <sha…>` through `runGit` with the credential, and checks that every SHA is now a commit. Errors are redacted.
  - `bot-user.ts`: `fetchBotUserId({slug, apiUrl?, fetch?, signal})` calls `GET /users/<slug>[bot]` through `request` with a new operation `getUser` (permission `none`, no token).
- **`xarabot lane install <lane> --repo <o/n> --role <r> --owner <login> --agent <a> [--model <m>] [--effort <e>]`** (`src/cli/lane-install.ts`):
  1. It validates the lane through `LaneSchema` and the lane-name pattern.
  2. It reads `host.yaml`. A missing file starts as `{schema_version: 1, lanes: {}}`; an invalid one exits 1.
  3. It loads the owner's App credentials, reads `.xarabot/config.yaml` from a forge snapshot of `main`, and checks `runner_version`.
  4. It installs the runner from `https://github.com/xaravel/xarabot.git`. The lane's installation token goes in the credential.
  5. Only then does it write `host.yaml` (mode 600). That write keeps an existing `host_id` or generates one UUID (`crypto.randomUUID`), and adds or replaces the lane.
  6. It creates the lane folder (mode 700) and `runner.git` (`openRunnerGit`).
  7. It writes `runner`, the launcher (mode 755) and `<laneDir>/<label>.plist`.
  8. It prints the two `sudo` commands that copy the plist to `/Library/LaunchDaemons/` and `launchctl bootstrap system` it.

  Any failure exits 1 with the reason, and nothing is written before step 5.
- **`xarabot lane run <repo> <lane>`** (`src/cli/lane-run.ts`), in this order:
  1. It finds the lane. A repo that differs from the lane's `repo`, or a missing `host_id`, is refused.
  2. A host or lane STOP marker exits 0 with no count.
  3. It loads the App credentials and takes a forge snapshot that reads `.xarabot/`. A snapshot error of kind `uninstalled` is the refusal "the App installation does not cover <repo>". It then parses `config.yaml`.
  4. If `runner_version` differs from the `runner` file, it installs that version, rewrites `runner` and exits 0 without claiming. The failure count is left as it is.
  5. It runs `loadRepoConfig`, then the refusals:
     - The role is `coordinator`: there is no coordinator process before Epic 2.
     - The agent is not allowed unattended.
     - There is no adapter for the agent. Only `claude` has one.
     - `startCheck(settings, cliVersion(...))` fails.
     - The credential file named by the adapter's launch spec (`credentialPath` and `readCredential`) is missing or unreadable.
     - The builder limit refuses the lane.
  6. When every check passes, it resets `failed-starts` to 0. It then composes the real dependencies:
     - the GitHub forge with `runnerGit` and `maintainer`;
     - `createClaudeAgent`, `createMacSandbox` and `createFsLaneStore`;
     - `createSleepWaiter`;
     - `createGitWorkspace`, the PR step, CI step and merge step, built on the git committer, merger and diff-paths from `createGitHubFetch`;
     - a bot identity from `botIdentity(owner, fetchBotUserId)`.

     With those it runs `runLaneProcess` and exits 0.

  Every refusal or failure from step 3 on, apart from the version switch, is a failed start:
  - It increments `failed-starts`, prints the reason, and exits 1.
  - At 3 in a row, it also writes the lane's `STOP` and posts `alert("lane-start-failed", mainSha ?? ZERO_SHA)`, provided a forge and maintainer are known. It reports on stderr when it can't.
- Every forge and git call has an `AbortSignal` deadline.

**Never:**
- No GitHub token in an agent session, an argv, a file or the environment.
- No `XARABOT_SANDBOXED` in the launcher, the plist or the runner.
- No run of the runner from a lane clone or a branch. No `launchctl` or `sudo` call from code. No `pkill` and no `timeout`. No systemd (Epic 7).
- No change to `Forge`, `Agent`, `Sandbox` or `LaneStore`, or to the logic of `runLaneProcess`. No heartbeat. No coordinator process.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Install new host | no `host.yaml`, `main` pins `v0.2.0` | `host.yaml` has a UUID and the lane; runner at `runner/v0.2.0/`; `runner` = `v0.2.0`; launcher and plist match golden | none |
| Install again | `host.yaml` with `host_id` | same `host_id`; lane replaced | none |
| Install bad version | `runner_version: ../x` | nothing written | exit 1 |
| Tag missing | fetch fails | no `runner/<v>`, no staging left | exit 1, nothing written |
| Launcher | `runner` names `v1`; `XARABOT_SANDBOXED=1` in env | runs `runner/v1/src/cli/main.ts lane run <repo> <lane>` without `XARABOT_SANDBOXED` | missing runner: exit non-zero |
| Version switch | `runner` = `v1`, `main` pins `v2` | installs `v2`, `runner` = `v2`, no claim, no ledger write | install fails: failed start |
| Pin back | `runner` = `v2`, `main` pins `v1` (installed) | no fetch, `runner` = `v1` | none |
| Refusals | agent not allowed / no adapter / effort refused / CLI too old / no credential / uninstalled / builders over limit / coordinator | refused, reason named, `failed-starts` + 1 | exit 1 |
| 3 failed starts | `failed-starts` = 2, refusal | `STOP` written, alert posted once | exit 1 |
| Start passes | `failed-starts` = 2, checks pass | `failed-starts` = 0; `runLaneProcess` runs | none |
| STOP present | lane `STOP` | exit 0, no count, no snapshot | none |

</intent-contract>

## Code Map

- `src/cli/lane-commands.ts` -- `paths` (40), `laneDirFor` (49) and `findLane` (55), to move into `host-paths.ts` and reuse. `githubForge` (70) is the pattern for building a forge from `loadAppCredentials`.
- `src/cli/main.ts` -- routes by `args[0]`. Add `lane install` and `lane run`.
- `src/lane/lane-process.ts` -- the `LaneDeps` type (84). `runLaneProcess` (227) is untouched.
- `src/lane/pr-step.ts` (`createPrStep`, `PrStepDeps` 20), `ci-step.ts` (`createCiStep`, `CiStepDeps` 76), `merge-step.ts` (`createMergeStep`, 41) -- the steps to compose.
- `src/lane/committer.ts` (`createGitCommitter` {gitDir, clone, bot, fetch}), `merger.ts` (`createGitMerger`), `diff-paths.ts` (`createGitDiffPaths`), `workspace.ts` (`createGitWorkspace`, `FetchShas` 32) -- each needs a `FetchShas`. None exists in production yet.
- `src/lane/lane-store.ts` (`laneLayout`, `createFsLaneStore`), `wait.ts` (`createSleepWaiter`), `stop.ts` (`writeStop`).
- `src/adapters/forge/github/runner-git.ts` -- `runGit` (115) has the credential on fd 3 and the `workTree` option. `openRunnerGit` (174). `protocol.file.allow=never`, so the tests use the HTTP `test/adapters/forge/github/git-server.ts`, which needs `x-access-token` Basic auth.
- `src/adapters/forge/github/github-forge.ts` -- `pushBranch` (483) shows the token, credential and redaction pattern to copy for the fetch. `GitHubForgeOptions` (100) has `runnerGit`, `maintainer` and `gitUrl`.
- `src/adapters/forge/github/tokens.ts` -- `createTokenSource`. A missing installation is `uninstalled` (80, 90).
- `src/adapters/forge/github/http.ts` -- `GITHUB_OPERATIONS` (47+) and `request` (139). `downloadLog` is the precedent for an operation with permission `none` and no token. `test/adapters/forge/github/http.test.ts:270` skips `none` in the permission manifest check.
- `src/core/bot-identity.ts` -- `botIdentity(login, botUserId)`.
- `src/adapters/agent/claude/claude-agent.ts` -- `createClaudeAgent`. Its `launchSpec(...).credential` = `{file: "oauth-token", env}` gives the credential file.
- `src/sandbox/tools.ts` -- `cliVersion(cmd, launching)` (95). `src/sandbox/vendor-home.ts` -- `credentialPath` (22), `readCredential` (35).
- `src/core/config/load-repo-config.ts` -- `CONFIG_PATH`, `loadRepoConfig(snap)` (122). `parseVersionedYaml` in `src/core/schemas/common.ts` parses `config.yaml` alone.
- `src/core/schemas/host.ts` -- `HostConfigSchema` and `LaneSchema`. `src/core/config/load-host-config.ts` -- `loadHostConfig`.
- `src/adapters/forge/fake/fake-forge.ts` -- `createFakeForge({now, main})`, `control.setMain`, `control.alerts()` and `control.injectError` for the lane-run tests. `test/lane/lane-process.test.ts:43` `mainFiles` is a working repo fixture.
- `test/adapters/forge/github/runner-git.test.ts:251` -- the src/lane spawn guard. Add `runner-install.ts` to `NON_GIT`; its git still goes through `runGit`.
- `bootstrap/loop/com.xarabot.bootstrap.plist` (read-only) -- the LaunchDaemon and `UserName` precedent.

## Tasks & Acceptance

**Execution:**
- `src/core/lane/runner.ts`, `src/core/lane/launchd.ts` -- the pure functions above.
- `src/adapters/forge/github/http.ts` -- the `getUser` operation. `src/adapters/forge/github/bot-user.ts` and `fetch-shas.ts` -- new.
- `src/lane/runner-install.ts` -- `installRunner`.
- `src/cli/host-paths.ts` -- shared paths, `laneDirFor` and `findLane`. `src/cli/lane-commands.ts` imports them.
- `src/cli/lane-install.ts`, `src/cli/lane-run.ts` -- the commands. Every effect is injectable: the forge factory, the runner installer, the CLI probe, the bot id, and the start of the lane.
- `src/cli/main.ts` -- routing and usage.
- Tests:
  - `test/core/lane/runner.test.ts` -- case tables.
  - `test/core/lane/launchd.test.ts` -- golden files in `test/fixtures/launchd/` (launcher and plist).
  - `test/lane/runner-install.test.ts` -- real git over `git-server.ts`, with a tagged commit that has a no-dependency `package.json`. Cases: installed, already present, missing tag (no staging left).
  - `test/adapters/forge/github/fetch-shas.test.ts` and `bot-user.test.ts` -- the git server and `fake-github.ts`.
  - `test/cli/lane-install.test.ts` and `test/cli/lane-run.test.ts` -- a temp `HOME` and `XDG_CONFIG_HOME`, the fake forge and stub effects, one test per matrix row.
  - `test/cli/launcher.test.ts` -- runs the real rendered launcher against a stub `runner/<v>/src/cli/main.ts` that prints its argv and env.
  - Update the spawn guard.

**Acceptance Criteria:**
- Given an installed lane, when its rendered launcher runs with `XARABOT_SANDBOXED=1` in its environment, then the runner it names gets `lane run <repo> <lane>` and no `XARABOT_SANDBOXED`.
- Given a passing start against the fake forge with no eligible Story, when `lane run` composes the real dependencies, then `runLaneProcess` ends `idle` and journals an idle span.
- Given `bun test`, `bun --bun oxlint` and `bun --bun tsc`, when they run, then each exits 0.

## Spec Change Log

## Review Triage Log

### 2026-10-23 — Review pass
- verdicts: 28 findings — high 0, medium 1, low 26, false 1, maybe-false 0 (plus 3 intent-alignment divergences, recorded last)
- findings:
  - `[low]` `[patch]` (verification-gap) no test routes a `lane run` / `lane install` argv through the real `main.ts` — a `main.test.ts` case now spawns both with `HOME` unset and checks that stderr comes from the subcommand.
  - `[low]` `[patch]` (verification-gap) the rejected-token fetch test never shows `invalidate` takes effect — the test now fetches again after the rejection and checks for a second mint and a success.
  - `[low]` `[patch]` (verification-gap) the start-failure alert's `main_sha` was checked only against a hex regex that `ZERO_SHA` also matches — it is now compared with the fake's `main` SHA.
  - `[low]` `[reject]` (verification-gap other) the runner-install token is scoped to the lane's repo, so the fetch from `xaravel/xarabot` fails for another repo's lane when the runner repo is private — in Epic 1 the only lane is on `xaravel/xarabot`, and git sends a credential to a public repo only when challenged. The spec chose this credential. Scoping a second token source to the runner repo adds surface for a case npm releases replace (Epic 7). Kept as a residual risk.
  - `[low]` `[reject]` (verification-gap other) `fetchBotUserId` looks up `<slug>[bot]` while the committer name is `<owner>-xarabot[bot]` — `bootstrap/join.ts` always creates the App as `<login>-xarabot`, so the two agree on every App this project makes, and a guard adds a branch for an App nobody creates.
  - `[low]` `[reject]` (blind) the runner fetch sends a token scoped to the wrong repo — same root as the verification-gap row on token scope.
  - `[low]` `[reject]` (blind) the unauthenticated `/users` lookup on every start could hit the 60/hour IP limit — STOP and refused starts return before the lookup, and each started process runs a unit plus a trailing wait of at least 1 minute (30 minutes when idle), so a lane makes a few lookups an hour. Caching the id adds state.
  - `[medium]` `[patch]` (blind) `lane install` never checks the builder limit, so adding a builder over `XARABOT_MAX_BUILDERS` makes every builder, the working one included, refuse and write STOP — install now runs `builderLimit` and `builderRefusal` on the new host config and refuses before writing anything; a test was added.
  - `[low]` `[reject]` (blind) a failure after the `host.yaml` write (`openRunnerGit`, the file writes) leaves the lane in `host.yaml` — these are local disk failures, and running `lane install` again repairs the lane. The spec fixes the write order.
  - `[low]` `[reject]` (blind) a lost update when two `lane install` runs race on `host.yaml` — only the Maintainer runs install, by hand. A lock adds machinery for a case that does not come up.
  - `[low]` `[patch]` (blind) `failed-starts` stays at 3 after STOP is removed, so one more failure writes STOP and alerts again — writing STOP at the threshold now resets the count to 0; a test was added.
  - `[low]` `[reject]` (blind) a throw from `runLaneProcess` is not caught — `runLaneProcess` catches every error in its body, and its store calls return results. An unexpected throw still exits non-zero through the unhandled rejection.
  - `[low]` `[patch]` (blind) the printed `sudo` commands do not quote their paths — they are now quoted with `shQuote`. The re-bootstrap error on a job that is already loaded is `launchctl`'s own message to the Maintainer; rejected.
  - `[low]` `[reject]` (blind) a staging folder is left behind when the installer is SIGKILLed — the staging folder is harmless, and a sweep adds code for a rare kill.
  - `[low]` `[reject]` (blind) an existing folder alone counts as installed — only the installer's rename creates `runner/<version>/`. A stray folder needs a manual `mkdir`.
  - `[false]` `[reject]` (blind) the CLI probe has no deadline — `cliVersion` runs under its own `PROBE_TIMEOUT_MS` spawn timeout in `src/sandbox/tools.ts`.
  - `[low]` `[reject]` (blind) several installation tokens are minted per start — that is two or three mints against a 5000/hour limit, with no harm named.
  - `[low]` `[reject]` (blind) duplication: `LANE_NAME`, `SHA_PATTERN`, `message`, `findLane`'s read, and the `laneDirFor` re-export — cosmetic, and no copy diverges today.
  - `[low]` `[reject]` (blind) test gaps: the real `githubConnect` wiring, a failure after the `host.yaml` write, STOP kept on reinstall, the `bunInstallDeps` abort, and the token argv check — `githubConnect` needs live GitHub (the canary, Story 1.20). The post-write failure is rejected above. Install never touches STOP. The fd-3 credential is covered by `runner-git.test.ts`. The abort path mirrors `runGit`.
  - `[low]` `[reject]` (edge) runner token scope — same root as the verification-gap row.
  - `[low]` `[reject]` (edge) App slug vs owner — same root as the verification-gap row.
  - `[low]` `[reject]` (edge) a removed `runner/<v>` folder makes the launcher exit 1 every 60 s with no STOP — only a manual deletion causes it. The spec has the launcher fail loudly, and the log names the missing path.
  - `[low]` `[reject]` (edge) reinstalling a lane name for another repo orphans the old daemon — the old label differs, so the Maintainer boots it out. This is rare, and a refusal adds a branch.
  - `[low]` `[reject]` (edge) a `bun install` grandchild that holds the pipes could hang past the deadline — the runner's only dependency is zod, which has no lifecycle scripts, and bun runs untrusted lifecycle scripts only when trusted.
  - `[low]` `[reject]` (edge) unauthenticated bot-id rate limit — same root as the blind row.
  - `[low]` `[patch]` (edge) `parseInstallArgs` takes a flag as a flag's value — a value starting with `--` is now a usage error; a test case was added.
  - `[low]` `[reject]` (edge) staging leftovers — same root as the blind row.
  - `[low]` `[reject]` (edge) `host.yaml` race — same root as the blind row.
  - intent alignment (descriptive):
    - The diff implements the "complete, tested pieces" reading. `lane run` composes the real dependencies and one test runs the real `runLaneProcess` to idle. Nothing exercises a real launchd job or live GitHub; those belong to Story 1.20's canary and runbook.
    - Failed starts are counted only inside `lane run`. A launcher failure (a missing runner folder or `runner` file) or a crash before `lane run` exits non-zero without counting, and launchd retries it every 60 s.
    - `runner_version` is read through a forge API snapshot of `main`, not a git fetch of `origin/main`. Install prints the `sudo` and `launchctl` steps instead of running them, and a coordinator lane installs but is refused at start until Epic 2.

## Design Notes

**Why a LaunchDaemon written to the lane folder.** The lanes run as the dedicated Xarabot user, which never logs in at the screen and so has no `gui/<uid>` domain. The bootstrap loop solved the same problem with a LaunchDaemon carrying `UserName` (`bootstrap/loop/com.xarabot.bootstrap.plist`). Installing a LaunchDaemon needs `sudo`, which the runner never uses. So `lane install` writes the plist into the lane folder and prints the two commands for the Maintainer, for example:

```text
sudo cp ~/.xarabot/repos/xaravel__xarabot/lanes/builder-1/com.xarabot.lane.xaravel__xarabot.builder-1.plist /Library/LaunchDaemons/
sudo launchctl bootstrap system /Library/LaunchDaemons/com.xarabot.lane.xaravel__xarabot.builder-1.plist
```

**Restart throttle.** Each process runs one unit, waits its trailing wait in-process, then exits. `KeepAlive` true restarts it, and `ThrottleInterval` 60 bounds a crash loop. A refused start exits 1. The third refusal in a row writes `STOP`, so the next starts exit 0 at once until the Maintainer removes it.

**Version switch.** The launcher ran the version that the `runner` file names. So when `main`'s `runner_version` equals that file, the running code is the pinned code. A mismatch is handled before any claim: install, rewrite `runner`, exit. Pinning back is the same path, and an existing folder needs no fetch.

**`XARABOT_MAX_BUILDERS` unset means 1.** That is Epic 1's required setting. An invalid value refuses the lane, so the check fails closed.

## Verification

**Commands:**
- `bun test` -- expected: exit 0
- `bun --bun oxlint` -- expected: exit 0
- `bun --bun tsc` -- expected: exit 0

## Auto Run Result

Status: done

**Summary:** A lane can now be installed and started from the runner version pinned on `main`.
1. **`xarabot lane install`**
   - It checks the lane and the builder limit, reads `runner_version` from `main`, and installs that tag at `~/.xarabot/runner/<version>/`.
   - Only then does it write the lane to `host.yaml` (generating `host_id` once) and create the lane folder with `runner.git`.
   - It writes the `runner` file, the fixed launcher `~/.xarabot/bin/xarabot-lane`, and a LaunchDaemon plist. It prints the two `sudo` commands that load the plist.
2. **The launcher** runs `xarabot lane run <repo> <lane>` from the runner the `runner` file names, after `unset XARABOT_SANDBOXED`.
3. **`xarabot lane run`**, in order:
   1. It exits on STOP.
   2. When `main` pins another version, it installs that version, rewrites `runner` and exits without a claim. Pinning back works the same way.
   3. It runs the refusal table.
   4. It composes the real GitHub forge, `claude` agent, macOS sandbox, git workspace and PR, CI and merge steps, and runs one `runLaneProcess`.

   Three failed starts in a row write the lane's `STOP` and post a `lane-start-failed` alert.

**Files changed:**
- `src/core/lane/runner.ts`: version, `runner`-file and failed-start rules, plus the builder-limit and unattended refusals.
- `src/core/lane/launchd.ts`: the launcher and plist renderers and the label.
- `src/lane/runner-install.ts`: `installRunner`, a shallow tag fetch through `runGit` into a staging folder, then `bun install` and an atomic rename.
- `src/adapters/forge/github/fetch-shas.ts`: `createGitHubFetch`, the production `FetchShas`.
- `src/adapters/forge/github/bot-user.ts` and `http.ts`: `fetchBotUserId` through the new `getUser` operation.
- `src/cli/host-paths.ts`: the shared host paths and lane lookup.
- `src/cli/lane-connection.ts`: the injectable GitHub connection.
- `src/cli/lane-install.ts`, `src/cli/lane-run.ts`: the commands.
- `src/cli/main.ts`: routing. `src/cli/lane-commands.ts`: uses the shared paths.
- Tests:
  - New: `test/core/lane/{runner,launchd}.test.ts` (golden files in `test/fixtures/launchd/`), `test/lane/runner-install.test.ts`, `test/adapters/forge/github/{fetch-shas,bot-user}.test.ts`, `test/cli/{lane-install,lane-run,launcher}.test.ts` and `test/cli/lane-fixture.ts`.
  - Changed: `main.test.ts`, `fake-github.ts` and the spawn guard in `runner-git.test.ts`.

**Review findings:** 28 findings: 1 medium, 26 low, 1 false, plus 3 descriptive intent rows.
- **Patched (1 medium, 6 low):**
  - The builder limit is checked at install.
  - `failed-starts` resets when STOP is written.
  - The `sudo` paths are quoted.
  - A flag is refused as a flag's value.
  - New tests: `main.ts` routing, token invalidation on a rejected fetch, and the alert's real `main` SHA.
- **Fixed during verification:** `failed-starts` was reset before the `runner.git` and bot-id steps. A start that kept failing there would never reach STOP. The reset now comes after them, with a regression test.
- **Deferred:** none.
- **Rejected:** the rest, each with its reason in the Review Triage Log.

**Follow-up review recommended:** false. Patched: 0 high, 1 medium, 6 low.

**Verification:**
- `bun install`: no changes.
- `bun test`: 2524 pass, 63 skip, 0 fail.
- `bun --bun oxlint` and `bun --bun tsc`: both exit 0.
- Every matrix row has a test that ran and passed.

**Residual risks:**
- Nothing has run against live GitHub or a real launchd yet. That is the canary in Story 1.20.
- The runner-install token is scoped to the lane's repo. A lane for another repo can fetch the runner only while `xaravel/xarabot` is public.
- The bot id is looked up without a token on each start, under GitHub's 60/hour IP limit.
- Launcher failures (a missing runner folder) are not counted as failed starts.
- During implementation, auto mode denied one shell rewrite of `src/adapters/forge/github/http.ts`. That edit was made in place with the Edit tool instead, as the rules require.
