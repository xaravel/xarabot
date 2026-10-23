---
title: 'Story 1.9: GitHub adapter: pushes and PRs'
type: 'feature'
created: '2026-10-22'
status: 'done'
baseline_revision: '4e805f05f18785e3ab6db73f1891a1e4f1d918c5'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      An abort SIGKILLs only the top git process, so git-remote-https may finish a push after pushBranch returned deadlinePassed.
    evidence: |-
      runGit kills the child by its PID only, and the port promises an aborted call changes nothing. Settle it with a test that aborts during a push held by the git server's hold hook and then checks the remote refs; if the push lands, kill a process group, which needs a spec change (the intent says the child is killed by its PID).
    location: >-
      src/adapters/forge/github/runner-git.ts:runGit
    severity: medium (unverified)
  - summary: >-
      prefetch writes with writeFile, which follows a planted symlink, and leaves older files in dir.
    evidence: |-
      This matters only if an agent sandbox can write the prefetch folder. The Story that wires CI-fix sessions settles where dir lives; if the sandbox can write there, write with flag "wx" into a fresh folder.
    location: >-
      src/adapters/forge/github/github-forge.ts:prefetchCiLogs
    severity: medium (unverified)
  - summary: >-
      The ARCHITECTURE-SPINE AD-26 permission table maps checks: read only to checks, but prefetch's listCheckRuns needs it, and the none permission (downloadLog) is not listed.
    evidence: |-
      GitHub's check-runs API needs checks: read. The planned manifest test will disagree with the doc. Fixing the doc is the Maintainer's call.
    location: >-
      _bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md
    severity: low
---

<intent-contract>

## Intent

**Problem:** The GitHub forge adapter (Story 1.8) can read and swap the ledger, but `pushBranch`, the PR operations, `comment` and `prefetch` are stubs. Nothing creates the lane's private `runner.git` or runs git with AR19's hardening. So the runner cannot push a unit branch with a lease or manage PRs as the bot (NFR8, AR7, AR16, AR19).

**Approach:** Add a hardened runner-git module to the GitHub adapter. It creates `runner.git` in a lane state folder and is the one place the adapter spawns git. Its credential helper gets the installation token over a pipe, never through env, argv or a file. Then implement `pushBranch` (`git push --force-with-lease` from `runner.git`), `openPr`, `updatePr`, `closePr`, `listPrsByBranch`, `comment` and `prefetch` (CI logs) over REST. Run the contract suite against the emulator, which gains a real smart-HTTP git remote, and live under `XARABOT_LIVE=1`.

## Boundaries & Constraints

**Always:**
- **`runner-git.ts`** (`src/adapters/forge/github/`):
  - `openRunnerGit(laneDir, opts)` creates `laneDir` (mode 700) and a bare `<laneDir>/runner.git` (`--initial-branch=main`) when missing, and returns its path. Running it again is a no-op.
  - `runGit(gitDir, args, {signal, credential?, identity?})` is the adapter's only spawn. It runs `git --git-dir=<gitDir>` with an allowlisted env: `PATH`, `HOME=<gitDir>`, `LANG=C`, `LC_ALL=C`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_NO_REPLACE_OBJECTS=1`, `GIT_TERMINAL_PROMPT=0`, plus `GIT_AUTHOR_*`/`GIT_COMMITTER_*` only from `identity`.
  - It always passes these `-c` settings: `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `core.attributesFile=/dev/null`, `diff.external=`, `commit.gpgSign=false`, `tag.gpgSign=false`, `push.gpgSign=false`, `gpg.program=false`, `protocol.file.allow=never`, `submodule.recurse=false`, `fetch.recurseSubmodules=false`, `push.recurseSubmodules=no`, `core.askPass=`, `credential.helper=`.
  - With `credential: {url, token}`, it adds `credential.<url>.helper=<HELPER>` after the reset. `HELPER` is a fixed shell function that answers only `get`. It drains git's request, then `exec 0<&3` and prints `username=x-access-token` plus the token, read from its stdin. The runner writes the token to an extra pipe on fd 3 and closes it.
  - An abort kills the child by its PID and returns `deadlinePassed`. The result is `{code, stdout, stderr}`.
- **`pushBranch(lease)`:**
  - Needs the `runnerGit` option, else `forbidden`.
  - Refuses `main` and the ledger branch, and an invalid branch name (`git check-ref-format`), as `forbidden`.
  - `lease.sha` or `expected_sha` that is not hex is `not-found`. A `sha` that is not a commit in `runner.git` (`cat-file -e <sha>^{commit}`) is `not-found`.
  - It runs `push --porcelain --force-with-lease=refs/heads/<b>:<expected_sha or empty> <repoUrl> <sha>:refs/heads/<b>`, where `repoUrl = <gitUrl>/<owner>/<name>.git` and `gitUrl` defaults to `https://github.com`. The credential helper is scoped to `repoUrl`.
  - Porcelain mapping:
    - `*`, `+` or ` ` is `ok`.
    - `=` (up to date) is `ok` when `expected_sha === sha`, else `conflict`, because the remote is at `sha`.
    - `!` with `stale info`, `fetch first` or `non-fast-forward` is `conflict`. `!` with `remote rejected` is `transient` when it mentions a lock, else `forbidden`.
  - Stderr mapping with no porcelain line: `Authentication failed`, `Invalid username or password` or `error: 401` is `auth`. `error: 403` or `Permission to` is `forbidden`. `not found` or `error: 404` is `not-found`. `error: 429` is `rate-limited` (60 s). Anything else is `transient`.
  - Every message goes through `tokens.redact`.
- **PRs** (`ForgePr` from the REST pull: `head.ref`, `base.ref`, `head.sha`, `body ?? ""`; a non-null `merged_at` or `merged: true` makes it `merged`):
  - `openPr` sends `POST /pulls {title, body, head: branch, base}`. A 422 whose `errors[].message` says "already exists" is `conflict`. A 422 whose `errors[]` has `field` `head` or `base` is `not-found`. Anything else goes through `mapHttpError`.
  - `updatePr` and `closePr` first `GET /pulls/{n}` (a 404 is `not-found`, a merged PR is `conflict`), then `PATCH /pulls/{n}` (`{title?, body?}` or `{state:"closed"}`). An empty update returns the PR unchanged. A PATCH 422 that mentions "merged" is `conflict`.
  - `listPrsByBranch` sends `GET /pulls?head=<owner>:<branch>&state=all&per_page=100&page=N` until a page has fewer than 100 entries, at most 50 pages (beyond that is `transient`). It keeps `head.ref === branch` and sorts by number ascending.
  - `comment` sends `GET /pulls/{n}` (404 is `not-found`), then `POST /issues/{n}/comments {body}`, and returns `{id: String(id)}`.
- **`prefetch({kind:"ci-log", sha, dir})`:**
  - `GET /commits/{sha}/check-runs?filter=latest&per_page=100&page=N` (same paging rule).
  - A failing run is `completed` with a conclusion other than `success`, `neutral` or `skipped`.
  - For an `app.slug === "github-actions"` run: `GET /actions/jobs/{id}/logs` with `redirect: "manual"`. A 302 `Location` is downloaded with no `Authorization` header. A 404 or 410 writes `logs unavailable (<status>)`.
  - Any other run writes `title`, `summary`, `text` and `details_url` from its `output`.
  - It creates `dir` and writes one file per failing check, named as the fake forge names them (`<safe-name>.log`, case-insensitive dedupe). It returns absolute paths.
- **`http.ts`:**
  - `Permission` gains `checks: read`, `actions: read` and `none`.
  - `GITHUB_OPERATIONS` gains `listPulls`, `createPull`, `updatePull`, `createComment` (`pull_requests: write`), `listCheckRuns` (`checks: read`), `getJobLogs` (`actions: read`) and `downloadLog` (`none`).
  - `request` accepts `token: string | null` (null sends no `Authorization`), an absolute `url` and `redirect`. `HttpReply` gains `text`.
- `checks`, `enqueue`, `dequeue` and `alert` stay `forbidden` stubs naming Story 1.10.

**Never:**
- No token in `process.env`, argv, a file, a log, a returned value or an error message. No `gh`, no `GIT_ASKPASS`, no `.git-credentials` and no new dependency.
- No git against any repo but `runner.git`. No fetch, merge or commit features beyond what the tests need (Stories 1.15 and later). No `checks`, queue or alert logic (Story 1.10).
- Never call a real GitHub host outside `XARABOT_LIVE=1`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected |
|---|---|---|
| First run | empty lane folder | `runner.git` is created bare; a second call keeps it |
| Hooks planted | `runner.git/hooks/pre-push` and `config` `core.hooksPath` | the hook never runs |
| file protocol | `runGit(["fetch", "file:///…"])` | fails (protocol not allowed) |
| Token leak | a push held mid-request at the emulator | `ps -axwwE` lines, the env given to git, files under the lane dir, console output, results and messages never contain the token, yet the server saw it via Basic auth |
| New branch | `expected_sha: null` | created; a second null lease to another sha is `conflict` |
| Stale lease | remote at A, lease expects C | `conflict`, remote unchanged |
| Up to date | remote at A, push A, lease expects null | `conflict`; lease expects A is `ok` |
| Unknown sha | sha not in `runner.git` | `not-found` |
| Reserved | branch `main` or `xarabot/claims` | `forbidden` |
| Second PR | open PR on the branch | `conflict` |
| Merged PR | update or close | `conflict` |
| CI log | Actions run failing | log downloaded via the redirect, without `Authorization` |

</intent-contract>

## Code Map

- `src/adapters/forge/github/github-forge.ts` -- `createGitHubForge`, `api()`, `guarded()`, `asObj`/`str`, `encodeBranch` and the `stub` list `STORY_1_9`. Add the options `runnerGit?: string` and `gitUrl?: string`, plus the new operations. The stubs left (`checks`, `enqueue`, `dequeue`, `alert`) name 1.10.
- `src/adapters/forge/github/http.ts` -- `request` (the only `fetch`), `GITHUB_OPERATIONS`, `Permission` and `mapHttpError`. Extend them as above.
- `src/adapters/forge/github/tokens.ts:createTokenSource` -- `get(signal)` and `redact`. The push takes its token from here.
- `src/adapters/forge/fake/fake-forge.ts:logFileName`, `PASSING_CONCLUSIONS` -- the reference naming and failure rule (copy them; adapters never import each other).
- `src/ports/forge.ts` -- `PushLease`, `ForgePr`, `PrefetchRequest`. Unchanged.
- `test/contracts/forge.contract.ts` -- the push, PR, comment and prefetch scenarios. Unchanged.
- `test/contracts/forge.github.contract.test.ts` -- `IMPLEMENTED`, the emulator and live harnesses, and `liveScratch` (raw API calls and cleanup).
- `test/adapters/forge/github/fake-github.ts` -- the emulator. Add pulls (full object, open head follows the branch ref), the pulls list and create endpoints, PATCH, issue comments, check runs, job logs (302 to `https://logs.github.test/…`, which the emulator also serves and logs the auth for), and the controls `setBranch`, `tokenValid`, `comments`, `setChecks`, `setCiLog`. Keep `setPull`'s existing fields working.
- `test/support/boundaries.ts` -- the spawn ban covers only `src/adapters/agent/`, so the forge adapter may use `Bun.spawn`.
- `bootstrap/loop/bin/bot-credential` -- prior art for a `get`-only helper (read-only).

## Tasks & Acceptance

**Execution:**
- `src/adapters/forge/github/runner-git.ts` -- `RUNNER_GIT_CONFIG`, `CREDENTIAL_HELPER`, `runnerGitEnv`, `runGit` and `openRunnerGit`.
- `src/adapters/forge/github/http.ts` -- the permissions, operations and `request` extensions.
- `src/adapters/forge/github/github-forge.ts` -- `pushBranch`, the PR operations, `comment`, `prefetch`, `mapPushResult` (pure, exported) and the options.
- `test/adapters/forge/github/git-server.ts` -- `startGitServer({root, owner, name, tokenValid, onPush, hold?})`. A `Bun.serve` on 127.0.0.1 runs `git http-backend` as CGI. It answers 401 with `WWW-Authenticate` unless Basic auth is `x-access-token:<valid token>`. After each receive-pack it calls `onPush` with the remote's branch refs (`for-each-ref`). `hold` is an optional async hook that runs before a request is served.
- `test/adapters/forge/github/fake-github.ts` -- the endpoints and controls listed in the Code Map.
- `test/adapters/forge/github/runner-git.test.ts` -- the first-run, hooks, file-protocol and env-allowlist rows.
- `test/adapters/forge/github/push.test.ts` -- the push rows, the token-leak row, and `mapPushResult` cases (a table).
- `test/adapters/forge/github/pulls.test.ts` -- PR, comment, list paging and prefetch rows, plus the request shapes.
- `test/adapters/forge/github/github-forge.test.ts` -- the stubs test now covers only the Story 1.10 stubs.
- `test/contracts/forge.github.contract.test.ts`:
  - The emulator harness offers the 9 implemented operations and the controls `makeCommit` (`commit-tree` on the empty tree in `runner.git`, unique message), `comments`, `setChecks`, `setCiLog`, `setMain`, `setNow`, `writeForeignLedger` and `trace`. It cleans up its temp folder and server.
  - The live harness wraps the forge so each case's branches get the prefix `xarabot-test/<uuid>/`, and maps them back. `makeCommit` fetches `main` into `runner.git` (with `runGit` and the credential) and makes an empty-diff commit on it. `comments` reads the issue comments. Cleanup closes open PRs and deletes the branches.

**Acceptance Criteria:**
- Given the emulator harness, when the forge contract suite runs, then every push, PR, comment and prefetch case passes. Cases that need `alert`, `enqueue`, `checks` or `mergeQueueHead` are skipped.
- Given no `XARABOT_LIVE=1`, when `bun test` runs, then every live case is skipped, none passed.
- Given `src/adapters/forge/github/`, when it is searched, then `fetch(` appears only in `http.ts:request` and `Bun.spawn` only in `runner-git.ts:runGit`.
- Given the repo, when `bun install`, `bun test`, `bun --bun oxlint` and `bun --bun tsc` run, then each exits 0.

## Spec Change Log

## Review Triage Log

### 2026-10-23 — Review pass
- verdicts: 40 findings — high 0, medium 3, low 24, false 10, maybe-false 3
- findings:
  - `[medium]` `[patch]` (verification-gap) `listPrsByBranch` merged detection is only tested with an emulator that sends `merged: true`, which GitHub's list shape lacks — added a pulls test that injects list entries with `merged_at` and no `merged`, and asserts `merged` and `closed`.
  - `[medium]` `[patch]` (verification-gap) The 404/410 and error handling for the log-host download in `jobLog` never ran — added tests where the log host answers 404 or 410 (placeholder written) and 403 (`forbidden`).
  - `[low]` `[reject]` (verification-gap) `JSON.stringify(runnerGitEnv(gitDir))` in the token-leak haystack can never hold the token — redundant, not wrong; the `ps -axwwE` dumps check the real env.
  - `[false]` `[reject]` (intent) The runner and lane never wire `openRunnerGit` or `runnerGit` — the intent's Approach scopes this Story to the adapter module; lane wiring is not asked for.
  - `[low]` `[reject]` (intent) The token-leak env check uses a fresh `runnerGitEnv` call — same as the redundant-haystack row; the process env is covered by `ps -axwwE`.
  - `[false]` `[reject]` (intent) Live coverage lacks reserved branches, second PR, merged PR and the CI log — the intent asks only that the contract suite run live, and the suite is unchanged by design.
  - `[false]` `[reject]` (intent) The live `makeCommit` fetches `main` — that is test-only and within "what the tests need".
  - `[false]` `[reject]` (intent) The `runGit` doc says an abort is `transient` but the code returns `deadlinePassed` — `deadlinePassed` is `forgeErr("transient", …)` (`src/ports/forge.ts:61`).
  - `[maybe-false]` `[defer]` (blind) An abort SIGKILLs only `git`, so `git-remote-https` may finish the push after `deadlinePassed` — not demonstrated; deferred as medium (unverified).
  - `[false]` `[reject]` (blind) `runner.git/config` keys (`http.proxy`, `insteadOf`, `include.path`) could send the token elsewhere — AD-17 makes `runner.git` neither readable nor writable by the sandbox, and only the runner writes its config.
  - `[false]` `[reject]` (blind) A failed fd-3 hand-off is silent — Bun returns a numeric fd for a `"pipe"` at index 3 (the push tests authenticate through it); a `writeSync` failure means the child exited, and its result reports why.
  - `[low]` `[reject]` (blind) `could not read Username` maps to `transient`, and `/not found/` matches `command not found` — the helper is always scoped to the push URL, so neither case comes up in normal use, and the mapping list is fixed by the intent.
  - `[medium]` `[patch]` (blind) The helper's URL scoping is claimed but untested — added a runner-git test with two git servers: B never sees the token or gets a ref, and A authenticates.
  - `[low]` `[reject]` (blind) Paged lists are not deduped — needs a PR created between page reads; the fix adds a guard.
  - `[low]` `[reject]` (blind) CI logs and git output are buffered whole — this needs logs of hundreds of MB; streaming is new machinery.
  - `[maybe-false]` `[defer]` (blind) `prefetch` follows symlinks and leaves old files in `dir` — depends on whether a sandbox can write the prefetch folder, which a later Story decides; deferred as medium (unverified).
  - `[false]` `[reject]` (blind) One 403 or 5xx job log fails the whole prefetch — the intent says this: only 404/410 are placeholders, anything else goes through `mapHttpError`.
  - `[low]` `[defer]` (blind) The ARCHITECTURE-SPINE permission table gives `checks: read` only to `checks`, but `listCheckRuns` (`prefetch`) needs it, and `none` is not listed — the doc fix is the Maintainer's to make.
  - `[low]` `[reject]` (blind) `openRunnerGit` does not re-check the mode or bareness of an existing lane folder — only the runner creates it; the fix adds guards.
  - `[low]` `[patch]` (blind) The contract fixture leaks the git server when setup fails, plus the `mustOk` alias and a double blank line — the `catch` now stops the server; removed the alias and the blank line.
  - `[low]` `[reject]` (blind) `what` uses `args[0]`, which gives `git -c` — adapter callers always pass the subcommand first; only one test starts with `-c`.
  - `[low]` `[reject]` (blind) The emulator's check-runs route takes only 40-hex SHAs — test-only; GitHub repos use SHA-1.
  - `[false]` `[reject]` (edge) Planted `http.proxy`/`sslVerify`/`insteadOf`/`include.path` config — same refutation as the blind config row (AD-17).
  - `[false]` `[reject]` (edge) `child.stdio[3]` not a number — same refutation as the blind fd-3 row.
  - `[low]` `[reject]` (edge) A second `get` in one run reads EOF — git asks the helper once per push; this is not reachable in normal use.
  - `[maybe-false]` `[defer]` (edge) Abort leaves grandchildren running — grouped with the blind abort row.
  - `[low]` `[patch]` (edge) A git run that finished, followed by an abort before the check, is reported `deadlinePassed` — removed `|| opts.signal.aborted`, so a finished run returns its result.
  - `[low]` `[reject]` (edge) An existing lane folder with looser permissions is accepted — same as the blind `openRunnerGit` row.
  - `[low]` `[reject]` (edge) A `runner.git` that is corrupt, non-bare or a symlink — only the runner creates it; the fix adds guards.
  - `[low]` `[reject]` (edge) Exactly 5000 list items gives `transient` — this edge is very unlikely, and the fix adds an extra request.
  - `[low]` `[reject]` (edge) Paged lists are not deduped — same as the blind dedupe row.
  - `[low]` `[reject]` (edge) Uppercase hex SHAs are refused — git and the ports produce lowercase SHAs.
  - `[low]` `[reject]` (edge) A relative `Location` header — GitHub sends absolute signed URLs; not demonstrated.
  - `[low]` `[reject]` (edge) A check name over 255 bytes gives `ENAMETOOLONG` — very unlikely, and the naming must match the fake forge.
  - `[low]` `[reject]` (edge) `could not read Username` maps to `transient` — same as the blind stderr row.
  - `[low]` `[reject]` (edge) A 401 or 403 on the signed download maps to auth or forbidden — the intent routes it through `mapHttpError`; the URL is used right after it is issued.
  - `[low]` `[patch]` (edge) The contract fixture does not stop the server when setup fails — grouped with the blind fixture row; fixed.
  - `[low]` `[patch]` (edge) Claim: the emulator harness "cleans up its temp folder and server" — grouped with the fixture row; now true.
  - `[false]` `[reject]` (edge) Claim: the pre-push errors are not redacted — they contain only the branch and SHA, never a token.
  - `[low]` `[reject]` (edge) Claim: "not hex" also rejects uppercase hex — same as the uppercase row.

## Design Notes

- **Why fd 3.** Git starts the helper from `git-remote-https`, whose stdin is git's own protocol pipe, so the runner cannot reach the helper's stdin directly. An extra pipe that every descendant inherits carries the token once. The helper moves it to its stdin with `exec 0<&3`, and nothing ever holds it in env, argv or a file. The helper is scoped to `repoUrl`, so a push or fetch to any other URL gets no credential. A prototype confirmed that `credential.<url-with-path>.helper` is selected and that the helper's output authenticates.
- **Up to date.** Git does not check the lease when the remote already has `sha`. The result `=` therefore proves that remote = `sha`, and the lease held only if `expected_sha === sha`.
- **runner-git in the adapter.** Only the forge adapter holds the token, and the lane may import adapters. Story 1.15 builds commits and clone rebuilds on `runGit`.

## Verification

**Commands:**
- `bun install` -- expected: exit 0, `bun.lock` unchanged.
- `bun test` -- expected: exit 0, and the live cases are skipped.
- `bun --bun oxlint` -- expected: exit 0.
- `bun --bun tsc` -- expected: exit 0.

## Auto Run Result

Status: done

**Summary.** The GitHub forge adapter now pushes and manages PRs. `runner-git.ts` creates the lane's bare `runner.git` and is the adapter's only spawn. It runs git with an allowlisted env and the AR19 `-c` hardening, and passes the token to a `get`-only credential helper over fd 3. On top of it are `pushBranch` (`--force-with-lease`, porcelain and stderr mapping), `openPr`, `updatePr`, `closePr`, `listPrsByBranch`, `comment` and `prefetch` (CI logs). The emulator gained a smart-HTTP git server and the REST endpoints these need. The contract suite runs against the emulator, and live under `XARABOT_LIVE=1`.

**Files changed:**
- `src/adapters/forge/github/runner-git.ts`: new. The hardened git runner and `openRunnerGit`.
- `src/adapters/forge/github/github-forge.ts`: the push, PR, comment and prefetch operations, and `mapPushResult`.
- `src/adapters/forge/github/http.ts`: new permissions and operations; `token: null`, absolute `url`, `redirect` and `text`.
- `test/adapters/forge/github/git-server.ts`: new. A `git http-backend` CGI server with Basic auth.
- `test/adapters/forge/github/fake-github.ts`: pulls, comments, check runs and job logs (with a log host), and the new controls.
- `test/adapters/forge/github/{runner-git,push,pulls}.test.ts`: new unit tests. `github-forge.test.ts` and `http.test.ts` were updated.
- `test/contracts/forge.github.contract.test.ts`: the emulator and live harnesses for the 9 operations.

**Review findings:** 40 findings: 0 high, 3 medium, 24 low, 10 false, 3 maybe-false.
- **Patched:**
  - 3 medium, all test gaps: the list `merged_at` shape, the log-host 404/410/403 paths, and the helper's URL scoping.
  - 2 low: a run that finished before an abort now returns its result; the contract fixture stops its server when setup fails.
- **Deferred (3):** the abort leaving `git-remote-https` running (medium, unverified), `prefetch` symlinks (medium, unverified), and the architecture permission table (low).
- **Rejected:** every other finding, with its reason in the triage log above.

**Follow-up review:** not recommended. The 3 patched medium entries add tests for code that was already correct, and they pass, so no unverified risk remains.

**Verification:** `bun install` (no changes), `bun test` (1196 pass, 64 skip, 0 fail), `bun --bun oxlint` (exit 0) and `bun --bun tsc` (exit 0).

**Residual risks:**
- The deferred abort and grandchild behaviour.
- The live suite has not run in this session (no `XARABOT_LIVE`).
- The emulator's 422 messages model GitHub's wording but were not checked against real replies.
