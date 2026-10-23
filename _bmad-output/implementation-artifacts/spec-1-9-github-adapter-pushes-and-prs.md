---
title: 'Story 1.9: GitHub adapter: pushes and PRs'
type: 'feature'
created: '2026-10-22'
status: 'in-review'
baseline_revision: '4e805f05f18785e3ab6db73f1891a1e4f1d918c5'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred: []
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
