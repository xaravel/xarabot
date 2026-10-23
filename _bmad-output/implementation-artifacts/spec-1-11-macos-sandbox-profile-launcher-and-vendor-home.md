---
title: 'Story 1.11: macOS sandbox: profile, launcher and vendor home'
type: 'feature'
created: '2026-10-23'
status: 'done'
baseline_revision: '5261007fac1dca8487c011849d519e24d80fca9b'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      CI never runs the sandbox suite, because every sandboxTest skips off macOS and CI runs on ubuntu-latest.
    evidence: |-
      test/support/sandbox.ts skips sandbox cases off darwin; .github/workflows/ci.yml uses ubuntu-latest. A change in src/sandbox/macos.ts that drops a deny or skips checkRoots passes CI and fails only on a Mac. Fixing it needs a macOS CI job or a required local run record, and .github/ is Maintainer-only.
    location: >-
      test/support/sandbox.ts
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Nothing launches agents yet, and nothing keeps an agent away from GitHub credentials, other lanes' secrets or the runner's own `runner.git` (FR18, NFR8, AR18, AD-17). Without a sandbox the lane cannot self-host.

**Approach:**
- Add the `Sandbox` port with its `LaunchSpec`.
- Add a macOS implementation in `src/sandbox/`. Before each session it:
  - resolves the tool paths;
  - re-seeds the vendor home from the operator's credential file;
  - builds an allowlisted environment, with a fresh `HOME`;
  - renders a deny-by-default Seatbelt profile.
- It then runs the agent through `sandbox-exec -p <profile>`.
- Every check fails closed and refuses the session. There is never an unsandboxed fallback.

## Boundaries & Constraints

**Always:**
- **Port (`src/ports/sandbox.ts`).** `Sandbox.run(spec, profile, signal, hooks?)` returns `SandboxResult<SandboxRun>`.
  - The error kind is `refused`, and `run` never throws.
  - `SandboxRun` = `{pid, exitCode, signal, startedAt, endedAt, durationMs, stdout, stderr}`. Times are epoch ms from an injectable clock.
  - `hooks.onSpawn(pid)` fires as soon as the process starts.
  - When `signal` aborts, the process gets SIGTERM and then, 10 s later, SIGKILL, both by its exact PID.
- **`LaunchSpec`** = `{argv, stdin?, vendor, vendorHomeEnv, credential: {file, env} | {file, homeFile}}`.
  - `argv[0]` is a command name resolved on the launching `PATH`.
  - `vendor` is `claude`, `codex` or `pi`.
  - `credential.file` is a plain file name under `<config>/xarabot/vendors/<vendor>/`.
  - Env names match `^[A-Z_][A-Z0-9_]*$`.
- **`SandboxProfile`** = `{clone, vendorHome, tempDir, runnerGit, resultPath, proxyUrl?}`, all absolute paths. `resultPath` must lie inside `tempDir`.
- **Refusals.** Each check refuses with a message naming its cause:
  - a host that isn't macOS;
  - a launching env that already has `XARABOT_SANDBOXED=1`;
  - a missing `sandbox-exec` (its path is injectable, default `/usr/bin/sandbox-exec`);
  - a missing agent CLI;
  - a clone whose `.git` is missing or is not a directory (a linked worktree);
  - a writable root (clone, vendor home or temp folder) that equals, contains or lies inside `runnerGit` or any always-denied path other than `~/.xarabot`;
  - a missing, unreadable, empty or non-600 credential file (the message names the file);
  - a path the profile can't quote (one containing `"`, `\`, a newline or NUL), which means the profile fails to generate.
- **Paths.** Every path enters the profile as `realpath`. Writable roots are created if missing.
- **Profile (`renderProfile`, pure).** The rules go in this order, because Seatbelt's last matching rule wins:
  1. `(deny default)`.
  2. Process exec and fork; `signal` to the same sandbox; `sysctl-read`; global `file-read-metadata`; and `mach-lookup` only for a fixed list of global names (no `securityd` or keychain services).
  3. Read access to the system paths: `/` (literal), `/usr`, `/bin`, `/sbin`, `/System`, `/private/etc`, `/private/var/db/timezone`, `/dev`, `/Library/Developer/CommandLineTools` and `/Applications/Xcode.app/Contents/Developer`.
  4. Read access to the resolved real files of the agent CLI, `bun`, `uv` and `git`, plus `git`'s `--exec-path` directory and its `share/git-core`, plus the uv Python directory (`UV_PYTHON_INSTALL_DIR`, else `XDG_DATA_HOME/uv/python`, else `~/.local/share/uv/python`) when it exists. `/usr/bin/git` (the xcrun shim) resolves through `xcrun --find git`. A missing `bun`, `uv`, `git` or uv Python directory is left out.
  5. A deny of reads and writes for `~/.xarabot`.
  6. Read and write access to the clone, the vendor home and the temp folder.
  7. A deny of reads and writes for `runnerGit`, `<config>/xarabot`, `~/.config/gh`, `~/.ssh`, `~/Library/Keychains`, `~/.git-credentials`, `~/.netrc`, `~/.claude`, `~/.codex` and `~/.pi`.
  8. A write allowance for `/dev/null`, `/dev/zero` and `/dev/tty*`.
  9. `(deny network*)`, which denies Unix sockets. Story 1.12 opens the proxy port.
  - `~` and `<config>` come from the launching env's `HOME` and `XDG_CONFIG_HOME`, else `~/.config`.
- **Environment.** The session gets exactly these variables:
  - `PATH` = `<tempDir>/bin:/usr/bin:/bin:/usr/sbin:/sbin`. `<tempDir>/bin` is rebuilt each session with symlinks named for the agent CLI, `bun`, `uv` and `git`, pointing to their real paths.
  - `HOME` = `<tempDir>/home`, recreated empty each session except for a `.gitconfig` that resets `credential.helper`.
  - `TMPDIR` = `tempDir`.
  - `LANG`, `LC_*` and `TERM`, from the launching env when present.
  - The credential variable (env mode only).
  - `<vendorHomeEnv>` = the vendor home.
  - `XARABOT_RESULT` = `resultPath`.
  - `XARABOT_SANDBOXED=1`.
  - When `proxyUrl` is set, the proxy variables `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy` and `http_proxy` = `proxyUrl`. Proxy variables are never taken from the launching env.
  - `UV_CACHE_DIR` = `<tempDir>/uv-cache`.
- **Vendor home.** Each session empties it. In `homeFile` mode the credential is written to `<vendorHome>/<homeFile>` with mode 600. In `env` mode the home stays empty, and the trimmed credential goes in the variable.
- **Process.** The process spawns with `cwd` = clone. The PID is the agent's own, because `sandbox-exec` execs it.

**Never:**
- No unsandboxed fallback, no profile file on disk, and no GitHub token or `GH_*`/`GITHUB_*`/`SSH_AUTH_SOCK` in the session env.
- No proxy (Story 1.12), no Linux `bwrap`, no `claude` adapter (Story 1.14) and no lane wiring (Story 1.16).
- No new dependency. No spawning of agents outside `src/sandbox/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Probe reads | `cat` of a system file, a clone file, a vendor home file or a temp file | succeeds | — |
| Denied read | `cat`/`ls` of each denied path in a fake home | fails, one test per path | — |
| Runner repo | `ls` of `runner.git` or a write into it | both fail | — |
| Writes | write into the clone, `.git`, the vendor home or the temp folder; also outside them | the first four succeed; outside fails | — |
| Unix socket | connect to a socket the host listens on in the temp folder | fails | — |
| Env | launching env has `GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, `FOO`, `LANG`, `LC_ALL` | `env` prints exactly the allowlist; `HOME` is under the temp folder; `XARABOT_SANDBOXED=1` | — |
| Credential env | an `oauth-token` file, mode 600 | the variable holds the token; the vendor home is empty | — |
| Credential file | `homeFile` mode | the vendor home holds only that file, mode 600 | — |
| No credential | file missing, mode 000 or mode 644 | `refused`, message has the path | — |
| Worktree | the clone's `.git` is a file | `refused` | — |
| No sandbox-exec | the injected path doesn't exist | `refused`, nothing spawned | — |
| Bad path | a clone path containing `"` | `refused` (profile fails to generate) | — |

</intent-contract>

## Code Map

- `src/ports/forge.ts`: the port style to copy (doc comment, result helpers). `src/core/result.ts` has `ok`, `err` and `Result`.
- `src/adapters/forge/github/credentials.ts:37` `appDir`: the XDG resolution and mode-600 check to mirror. The sandbox may not import adapters (`test/support/boundaries.ts` `ALLOWED`), so it reimplements those few lines.
- `src/adapters/forge/github/runner-git.ts`: the `Bun.spawn` deadline and kill pattern, and the hardened git config (AR19).
- `test/support/boundaries.ts` `checkSource`: the agent spawn ban already exists. Add a rule that the literal `sandbox-exec` appears only under `src/sandbox/`.
- `test/support/live.ts`: the skip-helper style for a new `test/support/sandbox.ts`.
- Host facts (macOS 27, verified by a prototype):
  - `sandbox-exec -p` works.
  - `claude` is a symlink to `~/.local/share/claude/versions/<ver>`, a file whose name isn't `claude`, hence the bin symlinks.
  - `~/.local/bin` also holds `gh`, so it must never be on `PATH` or readable.
  - `/usr/bin/git` is an xcrun shim that writes a cache in `/var/folders`.
  - With unrestricted `mach-lookup`, `security` can query the keychain. With only `opendirectoryd.libinfo`, `notification_center`, `logd`, `system.logger` and `diagnosticd`, `claude --version`, `bun` and `git` work and `security` fails.
  - `cwd` must be inside a readable root (getcwd).

## Tasks & Acceptance

**Execution:**
- `src/ports/sandbox.ts`: `LaunchSpec`, `SandboxProfile`, `SandboxRun`, `SandboxResult`, `Sandbox` and `VENDORS`.
- `src/sandbox/profile.ts`: pure `renderProfile(input)` → `Result<string>`, plus the `SYSTEM_READ_PATHS` and `MACH_SERVICES` constants and `quote`.
- `src/sandbox/environment.ts`: pure `buildSessionEnv(launching, parts)` and `deniedPaths(launching, runnerGit)`.
- `src/sandbox/tools.ts`: `resolveTools(launching, agentCommand)`, which finds the real paths, the git exec-path and the uv Python directory.
- `src/sandbox/vendor-home.ts`: `credentialPath` and `seedVendorHome`, which reads, checks the mode and re-seeds.
- `src/sandbox/macos.ts`: `createMacSandbox(opts?)`, implementing `Sandbox`. `opts` are `sandboxExec`, `launchingEnv`, `platform` and `now`.
- `test/support/sandbox.ts`: `sandboxTest`, skipped when not on darwin or when `XARABOT_SANDBOXED=1`.
- `test/sandbox/profile.test.ts`, `environment.test.ts` and `vendor-home.test.ts`: pure and filesystem case tables that run on any host.
- `test/sandbox/macos.test.ts`: the matrix rows run through `sandboxTest`, in a fake home laid out like the Structural Seed (`<home>/.xarabot/repos/o__r/lanes/l/{clone,runner.git,vendor,tmp}`). It also checks that `security list-keychains` fails and that `claude`/`bun`/`git` start when present.
- `test/boundaries.test.ts` and `test/support/boundaries.ts`: the `sandbox-exec` rule and its cases.

**Acceptance Criteria:**
- Given a host that isn't macOS, or `XARABOT_SANDBOXED=1`, when `bun test` runs, then every case that needs a sandbox is reported skipped, never passed.
- Given `src/`, when the boundary check runs, then only `src/sandbox/` names `sandbox-exec`, and agent adapters spawn nothing.
- Given the repo, when `bun install`, `bun test`, `bun --bun oxlint` and `bun --bun tsc` run, then each exits 0.

## Spec Change Log

## Review Triage Log

### 2026-10-23 — Review pass
- verdicts: 41 findings — high 1, medium 7, low 30, false 2, maybe-false 1
- findings:
  - `[medium]` `[patch]` (blind) Writable roots aren't confined to the lane. Another lane's folder, or `~/Documents`, is accepted as a root. — `checkRoots` now refuses a root that equals or contains `~/.xarabot`, or that lies outside `dirname(runnerGit)`. Refusal tests added.
  - `[medium]` `[patch]` (blind) A stale or planted `resultPath` survives into the next session. — The result file is removed before spawning, and a symlink there is removed without being followed. Tests added.
  - `[medium]` `[patch]` (blind) The `/dev/tty*` regex lets a session write every `/dev/ttys*` terminal. — Writes are now `(literal "/dev/tty")`. The `/dev` read subpath was replaced by device literals and `/dev/fd`. A test checks that `ttys000` and `ttys001` can't be read or written.
  - `[high]` `[patch]` (blind) `process-exec` was unscoped. Verified: a session ran `~/.local/bin/gh` by absolute path. — `process-exec` is now allowed only on the read and writable paths and denied with them. A test shows that a binary copied outside the roots fails to exec.
  - `[low]` `[reject]` (blind) Script-based CLIs such as npm `codex` and `pi` can't start. — Those adapters belong to later Epics, which will extend the tool paths. Nothing launches them today.
  - `[low]` `[patch]` (blind) Descendants and stream readers outlive `run`. — The readers are now cancelled after the drain grace, and a test covers it. Killing descendants belongs to Story 1.18 (`stop --now`).
  - `[low]` `[reject]` (blind) stdout and stderr are buffered without a limit. — Unlikely in everyday use, and a fix would add a cap or a streaming surface to the port.
  - `[low]` `[patch]` (blind) `tools.ts`, `within` and `realpathLoose` have no tests. — Added `test/sandbox/tools.test.ts`.
  - `[false]` `[reject]` (blind) A writable `.git` lets agent-written hooks or config run outside the sandbox. — By AD-15 the runner never runs git against the clone's `.git`. It rebuilds the clone from `runner.git` and reads only the working tree.
  - `[low]` `[patch]` (blind) `readCredential` checks the file and then reads it, so the two can race. — It now opens once with `O_NOFOLLOW` (and `O_NONBLOCK`), runs `fstat` and reads from the same fd.
  - `[low]` `[reject]` (blind) Validation is repeated across three modules. — No caller diverges today. Merging them is a refactor with no named harm.
  - `[low]` `[reject]` (blind) The single `refused` kind hides why a run failed. — The spec mandates one kind, so the fix is a spec edit.
  - `[low]` `[patch]` (blind) A test depends on the first `PATH` entry. — It now uses `join(os.homedir(), ".local", "bin")`.
  - `[medium]` `[patch]` (edge) A mode-000 folder or a file at `uv-cache` in the temp folder wedges the lane. — A new `removeTree` helper chmods folders before removing them, and a `uv-cache` that isn't a folder is replaced. Tests added.
  - `[medium]` `[patch]` (edge) A mode-000 folder in the vendor home wedges re-seeding. — `emptyDir` now uses `removeTree`. Test added.
  - `[medium]` `[patch]` (edge) A writable root can be another lane's folder. — Same root cause and fix as the first blind finding.
  - `[low]` `[reject]` (edge) A refusal can leave newly created folders on disk. — They're harmless, empty lane folders.
  - `[low]` `[patch]` (edge) `<tempDir>/..result.json` is wrongly refused. — The check is now `rel === ".." || rel.startsWith("../")`.
  - `[low]` `[patch]` (edge) A `resultPath` inside the session folders gets deleted. — A `resultPath` inside `bin`, `home` or `uv-cache` is now refused.
  - `[low]` `[patch]` (edge) The readers leak after the grace. — Same fix as the blind finding: the readers are cancelled.
  - `[maybe-false]` `[reject]` (edge) The overlap check is case-sensitive on case-insensitive APFS. — Settling it would need a caller that passes differently cased paths. The lane passes its own paths, and the finding would only be low.
  - `[low]` `[reject]` (edge) A relative `HOME` or `XDG_CONFIG_HOME` resolves against the cwd. — Unlikely in practice, and the fix adds a guard.
  - `[low]` `[reject]` (edge) An agent CLI under a denied path fails at exec instead of being refused. — It still fails closed. Unlikely.
  - `[low]` `[reject]` (edge) A Homebrew git may need dylibs outside the system paths. — It fails loudly inside the sandbox. Story 1.14 can extend the tool paths.
  - `[low]` `[patch]` (edge) `readCredential` checks the file and then reads it, so a symlink swap can race. — Same fix as the blind finding: `O_NOFOLLOW` and `fstat` on one fd.
  - `[low]` `[patch]` (edge) A test relies on the `PATH` layout. — Same fix as the blind finding.
  - `[low]` `[patch]` (edge) The "starts when present" cases pass when a tool is missing. — They now use `toolTest(tool)`, which reports skipped.
  - `[low]` `[patch]` (edge) A leftover `/tmp` file breaks the write-outside test. — Each target is removed before the attempt.
  - `[low]` `[reject]` (edge) `git` as the agent command gets the xcrun shim. — No adapter launches git as the agent.
  - `[low]` `[reject]` (edge) A symlinked `Xcode.app` defeats the system subpath. — It's rare and fails loudly. The CommandLineTools path covers stock hosts.
  - `[low]` `[patch]` (verification-gap) Nothing tests git's exec-path, `share/git-core` or the uv Python folder. — `tools.test.ts` covers `uvPythonDir` precedence and the git exec-path in `dirs`.
  - `[low]` `[patch]` (verification-gap) The "starts when present" cases pass silently. — Same fix: `toolTest`.
  - `[low]` `[patch]` (verification-gap) The 5 s drain grace is untested. — Added a background `sleep` case that returns `hi` within 7.5 s, then kills the sleep by its exact PID.
  - `[low]` `[patch]` (verification-gap) A throwing `onSpawn` is untested. — Test added.
  - `[medium]` `[defer]` (verification-gap) CI never runs the sandbox suite (ubuntu). — `.github/` is Maintainer-only. Recorded in `deferred`.
  - `[low]` `[patch]` (verification-gap) `..result.json` is refused. — Same fix as the edge finding.
  - `[low]` `[reject]` (intent) "Only spawner" is enforced only by the lexical `sandbox-exec` rule and the agent-adapter spawn ban. — It's true today. Lane wiring (Story 1.16) is where the lane must call only `Sandbox.run`.
  - `[low]` `[reject]` (intent) The probes use shell commands as the "agent CLI", and uv isn't run. — A probe process is exactly what the AC names. The `claude`, `bun` and `git` start cases and the tools tests cover the real tools.
  - `[low]` `[patch]` (intent) The `$XDG_CONFIG_HOME/xarabot` denial was tested only through the `~/.config` fallback. — Added a sandbox case with `XDG_CONFIG_HOME` set.
  - `[false]` `[reject]` (intent) The `runner.git` fixture isn't empty. — A secret inside it is a stronger test of "neither read nor written" than an empty folder.
  - `[low]` `[reject]` (intent) It takes stricter readings (proxy only from the profile, exact mode 600). — Recorded in the Design Notes. Both are fail-closed choices.

## Design Notes

- **Stricter readings.** Where the AC could be read more than one way, the spec takes the stricter one:
  - Proxy variables come only from the profile (the Xarabot proxy), never from the launching env.
  - A credential file with group or other permission bits is refused, like ssh does.
  - `~/.xarabot` is denied except for the lane's three writable roots. The deny comes before their allow, so it must stay in that order.
- **Accepted leak.** `file-read-metadata` is allowed globally, so `getcwd`, `realpath` and `stat` work under the denied `~/.xarabot` parents. `stat` can reveal that a path exists, but never its contents.
- **Later Stories.** The mach list and the system paths are constants that Stories 1.12 and 1.14 may extend.

## Verification

**Commands:**
- `bun test test/sandbox test/boundaries.test.ts`: expected to pass, with the sandbox cases running on this macOS host.
- `bun install && bun test && bun --bun oxlint && bun --bun tsc`: expected to exit 0.

## Auto Run Result

Status: done

**Summary.** This adds the `Sandbox` port and its macOS implementation. Before each session it:
- resolves the tool paths;
- empties and re-seeds the vendor home from the operator's mode-600 credential;
- builds an allowlisted environment with a fresh `HOME` and a `.gitconfig` that resets the credential helper.

It then runs the agent through `sandbox-exec -p` with a deny-by-default Seatbelt profile. Every check fails closed.

**Files changed:**
- `src/ports/sandbox.ts`: the `Sandbox` port, `LaunchSpec`, `SandboxProfile` and `SandboxRun`.
- `src/sandbox/profile.ts`: the pure profile renderer. Read and exec are scoped, there's a fixed Mach service list, and the network is denied.
- `src/sandbox/environment.ts`: the session's env allowlist and the denied host paths.
- `src/sandbox/tools.ts`: resolves the real paths of the agent CLI, `bun`, `uv` and `git` (through xcrun), git's exec-path and the uv Python folder.
- `src/sandbox/vendor-home.ts`: reads the credential (`O_NOFOLLOW`, mode 600), re-seeds the vendor home, and adds `removeTree`.
- `src/sandbox/macos.ts`: `createMacSandbox`. It holds the refusals, the root confinement to the lane folder, the session folders, the spawn, abort (SIGTERM, then SIGKILL after 10 s, by PID) and the output drain.
- `test/support/sandbox.ts`, and `test/sandbox/{profile,environment,vendor-home,tools,macos}.test.ts`: the case tables and the live Seatbelt probes in a fake home laid out like the Structural Seed.
- `test/support/boundaries.ts` and `test/boundaries.test.ts`: only `src/sandbox/` may name `sandbox-exec`.

**Review.** 41 findings:
- 24 patches: 1 high, 6 medium, 17 low. The high was an unscoped `process-exec`; the mediums were lane-root confinement, a stale result file, `/dev/ttys*` access and lane wedging through mode-000 folders.
- 1 deferred: CI on ubuntu skips the sandbox suite. That needs a Maintainer change in `.github/`.
- 16 rejected (13 low, 2 false, 1 maybe-false), each with its reason in the triage log.

**Verification.** `bun install`, `bun test`, `bun --bun oxlint` and `bun --bun tsc` all exit 0: 1460 pass, 58 skip (the live cases), 0 fail. The sandbox cases ran for real on this macOS 27 host. With `XARABOT_SANDBOXED=1`, `bun test test/sandbox` reports the nested cases as skipped.

**Follow-up review recommended: true.** This pass patched a high-severity finding, and the scoped-exec and device changes were checked only with `claude --version`, `bun`, `git` and `sh`. A full `claude -p` session under the profile (Story 1.14) may need more exec paths or Mach services.

**Residual risks:**
- `file-read-metadata` is allowed globally, so `stat` can reveal that a path exists.
- Descendants the agent starts are not killed by `run`; Story 1.18 handles that.
- The sandbox suite never runs in CI.
