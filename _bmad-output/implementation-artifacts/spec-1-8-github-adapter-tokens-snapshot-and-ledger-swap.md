---
title: 'Story 1.8: GitHub adapter: tokens, snapshot and ledger swap'
type: 'feature'
created: '2026-10-22'
status: 'done'
baseline_revision: '53d6f4e62110cfaf08f2e5d6f15dd4bb3e0032dc'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      When the deadline passes right after a ledger swap reported transient, swapLedger returns deadline (or exhausted on the last try) without saying the write may have landed.
    evidence: |-
      The most common lost ack is an abort while PATCH git/refs is in flight. The adapter maps it to transient "deadline passed", and the next loop pass returns deadline at its top-of-loop abort check before the lost-ack comparison runs. The caller cannot tell "nothing written" from "may be on the ledger".
      Settle it in Story 1.16 (lane process): either the deadline/exhausted outcome carries a "may have landed" flag when a transient swap is pending, or the lane treats its own claim found on the next snapshot as adopted.
    location: >-
      src/lane/ledger-cas.ts
    severity: medium
  - summary: >-
      Only the live test checks that real GitHub answers a non-fast-forward PATCH git/refs and a racing POST git/refs with 422; every test that CI runs gets 422 from the emulator.
    evidence: |-
      SWAP_CONFLICT_STATUS = 422 and both conflictOn overrides are checked against GitHub only by the github (live) harness and "live: a stale PATCH git/refs answers SWAP_CONFLICT_STATUS", which need XARABOT_LIVE=1, XARABOT_LIVE_GITHUB_REPO and XARABOT_LIVE_GITHUB_LOGIN. CI sets none of them.
      Settled when the Maintainer runs the live suite against the scratch repo (AR39). If GitHub answers otherwise, change SWAP_CONFLICT_STATUS.
    location: >-
      src/adapters/forge/github/http.ts
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** The runner has a `Forge` port and a fake, but nothing that talks to GitHub. The ledger cannot live on `xarabot/claims`, and no code mints the short-lived bot tokens the runner must use (FR13, FR24, AR27, AR39). Story 1.7 also deferred a lost-ack case: a swap that lands but reports `transient`.

**Approach:** Add the GitHub forge adapter under `src/adapters/forge/github/`. It loads the App key, mints installation tokens in memory, and sends every call through one request function with an operation table. It implements `snapshot` and `ledgerSwap` over the REST git data API. The other port operations stay stubs until Stories 1.9 and 1.10. The adapter runs the forge contract suite offline against an in-process GitHub emulator, and live against a scratch repo under `XARABOT_LIVE=1`. `swapLedger` gains an idempotency check for the lost-ack case.

## Boundaries & Constraints

**Always:**
- **Credentials.** `loadAppCredentials({login, env})` reads `<config>/xarabot/apps/<login>-xarabot/`. `<config>` is `env.XDG_CONFIG_HOME` when it is non-empty, else `<env.HOME>/.config`. The folder holds `private-key.pem` and `app.json` (`id` positive int, `slug` non-empty, other keys allowed; a zod schema in `src/core/schemas/github-app.ts`). Each of these fails as `auth`, naming the path but never the key's contents: a missing file, a key whose mode (`& 0o777`) is not `0o600`, a key `node:crypto` cannot parse, or an invalid `app.json`.
- **Tokens.** The App JWT is RS256 with `iat = now−60 s`, `exp = now+540 s` and `iss = id`. The installation comes from `GET /repos/{o}/{r}/installation`. The token comes from `POST /app/installations/{id}/access_tokens` with body `{repositories:[name]}`. A 404 or 422 on either call returns `uninstalled`. The token lives only in a closure. It is reused until 10 min before its `expires_at`, and concurrent callers share one in-flight mint. A 401 on an API call drops the cached token. Error messages replace the token's text with `[redacted]`.
- **One request function.** It is the only `fetch` call in the adapter. It takes an operation-table entry (`name`, `method`, `permission`, where `permission` is `"app-jwt"` or `contents: write`, `pull_requests: write` or `metadata: read`). It takes an injectable `fetch`, adds `Authorization`, `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`, and passes the call's `signal`. It returns the status, the JSON body and the `Date` header.
- **Error mapping** (pure, exported):

  | Status or failure | Kind |
  |---|---|
  | 401 | `auth` |
  | 403 or 429 with `x-ratelimit-remaining: 0` | `rate-limited`, `retry_after = x-ratelimit-reset − Date` |
  | 403 or 429 with a `retry-after` header, or a body that says "secondary rate limit" | `rate-limited`, with `retry-after` or else 60 |
  | any other 403 | `forbidden` |
  | 404 | `not-found` |
  | 5xx, a network error, or an abort | `transient` (an abort's message says the deadline passed) |
  | any other status | `forbidden`, with the status and GitHub's `message` |

  Overrides: `PATCH git/refs` maps `SWAP_CONFLICT_STATUS = 422` to `conflict`, and `POST git/refs` maps 422 to `conflict`.
- **`snapshot`** follows the port's order: ledger, then `main`, then PRs.
  - Ledger: `GET git/ref/heads/<ledger>`, the commit, its tree (`?recursive=1`), and then every blob, decoded as UTF-8.
  - If the ledger ref is 404, it creates the branch: `POST git/commits` (tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`, no parents, message `xarabot ledger root [skip ci]`), then `POST git/refs`. A 422 from `POST git/refs` returns `conflict`.
  - `main`: the ref, the commit and the recursive tree give `tree` (blob paths) and `blob_shas`. Only paths that `read` accepts are fetched as blobs. A `truncated` tree is `transient`.
  - PRs: `parseLedger`, then `GET pulls/{n}` for each record with `pr`. A merged PR maps to `merged`. An unparsable ledger gives `prs: {}`.
  - `now` is the latest `Date` header seen during the snapshot, formatted `YYYY-MM-DDTHH:MM:SSZ`.
  - An optional `onRead(part)` hook fires at the start of each part.
- **`ledgerSwap(oldSha, commit)`.** It reads the ref first, and a tip other than `oldSha` returns `conflict`. Then it reads the old commit's tree, posts a blob for each write (`encoding: utf-8`), and posts a tree on `base_tree` with the writes plus the deletes of existing paths (`sha: null`). It posts a commit with `parents: [oldSha]` and the message verbatim, then `PATCH git/refs/heads/<ledger>` with `{sha, force: false}`.
- **Options.** Options are `{repo: {owner, name}, credentials, fetch?, now?: () => number, apiUrl?, ledgerBranch? = "xarabot/claims", mainBranch? = "main", onRead?}`. Every operation returns `transient` for a signal that is already aborted, before any request. `pushBranch`, the PR operations, `comment`, `checks`, `enqueue`, `dequeue`, `alert` and `prefetch` return `forbidden` ("not implemented until Story 1.9/1.10").
- **Contract suite.** `ForgeHarness` gains `enabled?: boolean` (false skips every case) and `operations?: readonly ForgeOperation[]` (default all). Each scenario declares the operations it calls. A case that needs an operation the harness lacks is skipped, never passed.
- **CAS lost-ack.** After `ledgerSwap` returns `transient`, the next try compares tips. If the re-fetched tip differs from the old one and its files equal the old files with the attempted commit applied, `swapLedger` returns `ok` with that tip and commit.

**Never:**
- No pushes, PR, comment, check, queue, alert or prefetch logic over HTTP (Stories 1.9 and 1.10), and no App-manifest permission test (Story 5.1a).
- No token in `process.env`, argv, a file, a log, a returned value or an error message. No `gh`, no `git` subprocess and no new dependency.
- Never call a real GitHub host outside `XARABOT_LIVE=1`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected |
|---|---|---|
| Key mode | `private-key.pem` mode 644 | `auth`, message names the path and mode |
| XDG fallback | `XDG_CONFIG_HOME` unset | reads `$HOME/.config/xarabot/apps/<login>-xarabot/` |
| Token reuse | two calls 30 min apart, then one at 51 min | one mint for the first two, a second mint at 51 min |
| Uninstalled | installation lookup 404 | `uninstalled`, no API call made |
| Token leak | full snapshot and swap | the token is absent from env, argv, files under the temp home, console output, results and messages |
| Missing ledger | no `xarabot/claims` | branch created at an empty root commit; a racing creator yields `conflict` |
| Snapshot order | one PR record | HTTP order: ledger reads, then `main` reads, then `pulls/{n}` |
| Swap | writes and deletes | blobs, tree, commit, then `PATCH` with `force: false` |
| Non-fast-forward | `PATCH` answers 422 | `conflict`; a 409 is not `conflict` |
| Rate limit | 403, remaining 0, reset at Date+30 | `rate-limited`, `retry_after` 30 |
| Lost ack | swap lands, then `transient` | the next CAS try returns `ok` without a second write |

</intent-contract>

## Code Map

- `src/ports/forge.ts` -- `Forge`, `ForgeResult`, `forgeErr`, `rateLimited`, `deadlinePassed`, `FORGE_OPERATIONS`. The adapter imports these and does not change the port.
- `src/adapters/forge/fake/fake-forge.ts` -- reference behaviour: the snapshot shape, `gitBlobSha`, and the `trace` order (`ledger`, `main`, `prs`, always all three).
- `src/core/ledger/codec.ts:parseLedger` -- finds the `pr` of each record. `src/core/ledger/edits.ts:LedgerCommit` -- `{message, writes, deletes}`.
- `src/core/schemas/common.ts` -- `NonEmpty`, `describeIssues`, and the schema style for the new `github-app.ts`.
- `src/lane/ledger-cas.ts:swapLedger` -- add the lost-ack check. Its `RETRIED` and error shapes stay the same.
- `test/contracts/forge.contract.ts` -- `scenario(name, controls, body)` and `ForgeHarness`. Add `enabled` and `operations`, and give each scenario its `uses`. `test/contracts/forge.contract.test.ts` -- the fake harnesses, which run unchanged.
- `test/support/live.ts:isLive` -- the live switch.
- `test/support/boundaries.ts` -- an adapter may import only `ports` and `core`, never `adapters/forge/fake`. Only `src/core/` is checked for purity.
- `bootstrap/loop/token.ts` -- prior art for the JWT and token mint (read-only, never imported).
- `src/adapters/forge/github/.gitkeep` -- delete.

## Tasks & Acceptance

**Execution:**
- `src/core/schemas/github-app.ts` -- `AppRecordSchema` and `AppRecord`.
- `src/adapters/forge/github/http.ts` -- `GITHUB_OPERATIONS` table, `request()`, `mapHttpError()`, `SWAP_CONFLICT_STATUS`, `formatDate()`.
- `src/adapters/forge/github/credentials.ts` -- `appDir`, `loadAppCredentials`.
- `src/adapters/forge/github/tokens.ts` -- `createAppJwt`, `createTokenSource`.
- `src/adapters/forge/github/github-forge.ts` -- `createGitHubForge`, `snapshot`, `ledgerSwap` and the stubs.
- `src/lane/ledger-cas.ts` -- the lost-ack check.
- `test/contracts/forge.contract.ts` -- `enabled`, `operations` and per-scenario `uses`.
- `test/adapters/forge/github/fake-github.ts` -- an in-process GitHub emulator (a `fetch` function) for the endpoints above. It holds git objects, refs, PRs, a clock that sets `Date`, token checks, a request log and a one-shot response injection. Fetch honours `signal`: it yields a macrotask and checks the signal before any change.
- `test/adapters/forge/github/{credentials,tokens,http,github-forge}.test.ts` -- every matrix row.
- `test/contracts/forge.github.contract.test.ts` -- two harnesses. The emulator harness offers `snapshot` and `ledgerSwap` with controls `setMain`, `setNow`, `writeForeignLedger` and `trace`. The live harness is enabled only when `XARABOT_LIVE=1`, `XARABOT_LIVE_GITHUB_REPO` and `XARABOT_LIVE_GITHUB_LOGIN` are all set. It gives each case its own ledger branch `xarabot/test-<uuid>`, deletes it in cleanup, and offers `writeForeignLedger` and `trace`. A live test also records the status of a stale `PATCH` and expects `SWAP_CONFLICT_STATUS`.
- `test/lane/ledger-cas.test.ts` -- the lost-ack row.
- Delete `src/adapters/forge/github/.gitkeep`.

**Acceptance Criteria:**
- Given the emulator harness, when the forge contract suite runs, then every snapshot and ledger case passes, and cases that need unimplemented operations or absent controls are skipped.
- Given no `XARABOT_LIVE=1`, when `bun test` runs, then every live GitHub case is reported as skipped and none as passed.
- Given `src/adapters/forge/github/`, when its files are searched, then `fetch(` appears only in `http.ts:request`.
- Given the repo, when `bun install`, `bun test`, `bun --bun oxlint` and `bun --bun tsc` run, then each exits 0.

## Spec Change Log

## Review Triage Log

### 2026-10-22 — Review pass
- verdicts: 31 findings — high 0, medium 2, low 22, false 6, maybe-false 1
- findings:
  - `[low]` `[reject]` (blind) Lost-ack check: a foreign commit leaving the same files as our attempted commit is taken for our swap. The resulting ledger state is exactly the one the edit wanted, and records carry the lane's identity, so another lane cannot produce identical files. A parent check would need the port to expose commit parents.
  - `[low]` `[reject]` (blind) A swap that landed and then had a foreign commit land on top is applied again. Pure edits re-check every precondition against the tip (AR7), so a re-applied claim fails `precondition` instead of writing twice, and a heartbeat re-applies harmlessly. The window is milliseconds, and a fix needs an ancestry walk through the port.
  - `[medium]` `[defer]` (blind) A deadline right after a transient swap returns `deadline` without saying the write may have landed. This is the pre-existing deadline path, so it is deferred to Story 1.16, which owns what the lane does with its own claim (see `deferred`).
  - `[low]` `[reject]` (blind) `conflictOn: 422` also catches other 422s on `createRef` and `updateRef`. The objects referenced were created moments earlier in the same call, so other 422s are not expected, and `swapLedger` stops after 10 tries anyway. Matching on messages adds branches for a case nobody has shown.
  - `[false]` `[reject]` (blind) `snapshot` returns `conflict` when it loses the ledger-creation race. That is what the Story's AC requires ("returning `conflict` if another lane created it first").
  - `[low]` `[reject]` (blind) The shared in-flight mint is tied to the first caller's signal. Within one lane process, concurrent forge calls share one deadline (for example the parallel reads inside one snapshot). A mismatch costs one `transient` and a retry, and a fix adds per-caller racing.
  - `[low]` `[reject]` (blind) A 401 is not retried with a fresh token. The spec maps 401 to `auth` and drops the cached token. With the 10-minute refresh margin, an early expiry needs more than 50 minutes of clock skew.
  - `[low]` `[reject]` (blind) A truncated `main` tree is `transient` on every snapshot. This needs a repo past GitHub's limit of about 100k entries, which no consumer is near. The spec chose `transient`, and `swapLedger` caps retries at 10.
  - `[low]` `[reject]` (blind) Blob and PR reads fan out without a limit, and blobs could go inline. The ledger holds a few units, and `main` reads are filtered by `read`. The AC says "writes blobs, tree and commit".
  - `[false]` `[reject]` (blind) The token is not scoped to the operations' permissions, and `permission` is unused or wrong. AD-26's table puts the reads of files and trees under `contents: write`. The permission check against the App manifest is Story 5.1a by design, and scoping the token is not required.
  - `[low]` `[patch]` (blind) A non-ENOENT read failure on the key was reported as a parse failure. Fixed: the read and the parse are separate, and a read failure now reports `cannot read (<code>)`. The other credentials points: requiring exactly 600 is what the AC says ("refuses if the key's mode is not 600"). A slug mismatch and the `login` path shape (callers pass a schema-validated `GitHubLogin`) were rejected as low.
  - `[low]` `[reject]` (blind) The emulator cannot apply a write and then drop its reply. The lost-ack path is tested in the lane with a lossy forge wrapper, and the adapter only returns `transient` on an abort.
  - `[false]` `[reject]` (blind) `stub` reads its options outside a guard. `CallOpts` is a required parameter in the port's types, so a call without options does not type-check, and every in-repo caller passes it.
  - `[low]` `[patch]` (edge) A missing `x-ratelimit-reset` header made the wait 0. Fixed: a null or blank value counts as NaN, so the 60 s fallback applies. A test was added.
  - `[low]` `[patch]` (edge) An empty `retry-after` header made the wait 0. Same root cause and fix as the row above, with a test.
  - `[low]` `[reject]` (edge) The shared mint signal: same as the blind row.
  - `[low]` `[reject]` (edge) A minted `expires_at` already inside the 10-minute margin re-mints on every call. This needs more than 50 minutes of clock skew between the host and GitHub.
  - `[low]` `[reject]` (edge) A ledger ref reset to an ancestor between `readRef` and `PATCH` lets the swap fast-forward. Nothing resets `xarabot/claims` backwards: lanes only fast-forward it, and the Maintainer has no such step.
  - `[low]` `[reject]` (edge) Unbounded fan-out: same as the blind row.
  - `[false]` `[reject]` (edge) A snapshot that loses the creation race returns `conflict`: the AC requires it, as in the blind row.
  - `[low]` `[reject]` (edge) A landed swap followed by a foreign commit: same as the blind row (edits re-check preconditions).
  - `[medium]` `[defer]` (edge) A transient swap on the final try or after an abort reports `exhausted` or `deadline` even though it landed: same root cause and deferral as the blind deadline row.
  - `[low]` `[reject]` (edge) A foreign commit with equal files: same as the blind row.
  - `[low]` `[reject]` (edge) A `login` with `/` or `..`, or a relative `XDG_CONFIG_HOME`, reads from an unintended folder. The login comes from validated config, and the environment belongs to the operator.
  - `[low]` `[patch]` (verification-gap) No lost-ack test covered a commit with deletes. Fixed: a delete-only `deleteMerged` lost-ack test was added.
  - `[maybe-false]` `[defer]` (verification-gap) GitHub's real 422 answers are checked only by the live test. Settled when the Maintainer runs the live suite (AR39), see `deferred`.
  - `[low]` `[reject]` (intent-alignment) Nothing in the runner builds the adapter yet. Wiring the lane is Stories 1.16 and later, and this Story delivers the adapter.
  - `[low]` `[reject]` (intent-alignment) `createGitHubForge` takes loaded credentials, so starting the adapter does not check the mode itself. `loadAppCredentials` is the start-up step that refuses, and the lane will call it before building the forge.
  - `[low]` `[reject]` (intent-alignment) Even a live run skips some snapshot cases (`setNow`, `setMain`, the PR states). A scratch repo's server clock cannot be set. `main` is merge-queue protected, so a harness cannot write to it. PR states need Story 1.9's operations. The ledger cases and the snapshot shape, order and `now` cases do run live.
  - `[false]` `[reject]` (intent-alignment) 422 is hard-coded instead of recorded. The live test asserts the observed status against `SWAP_CONFLICT_STATUS`, so a different answer fails with the received status in the message, and that is the record AR39 asks for.
  - `[false]` `[reject]` (intent-alignment) The leak test does not check the journal. No journal exists yet (Story 1.18). The test covers every surface that does exist: env, argv, files, console output, results and messages.

## Design Notes

- **422 for a non-fast-forward swap.** GitHub answers a non-fast-forward `PATCH git/refs` with 422 "Update is not a fast forward". The live test checks that status against the scratch repo (AR39). If it fails, change `SWAP_CONFLICT_STATUS`. Until then, a 409 maps to `forbidden`, which stops the lane visibly instead of retrying forever.
- **Stubs return `forbidden`.** Nothing calls them before Stories 1.9 and 1.10. If one is called, the lane stops with an alert and does not silently retry.
- **Lost ack in the lane, not the adapter.** The adapter cannot check anything after its deadline. A file comparison on the next try is independent of the port, and it also covers the fake.

## Verification

**Commands:**
- `bun install` -- expected: exit 0, `bun.lock` unchanged.
- `bun test` -- expected: exit 0, and the live GitHub cases are skipped.
- `bun --bun oxlint` -- expected: exit 0.
- `bun --bun tsc` -- expected: exit 0.

## Auto Run Result

Status: done

**Summary:** Added the GitHub forge adapter for tokens, `snapshot` and `ledgerSwap`, plus a lost-ack check in the ledger CAS loop.
- **Credentials.** The adapter loads the owner's App key and `app.json` from the XDG folder, falling back to `~/.config`. It refuses a key whose mode is not 600.
- **Tokens.** It mints an RS256 App JWT and exchanges it for a 1-hour installation token scoped to the repo. The token stays in memory only and is refreshed 10 min before expiry. An installation that does not cover the repo is `uninstalled`.
- **`snapshot`.** It reads the `xarabot/claims` tip and records, then `main`, then each ledger unit's PR state. `now` comes from the latest `Date` header. A missing ledger branch is created at an empty root commit, and a lane that loses that race gets `conflict`.
- **`ledgerSwap`.** It writes blobs, tree and commit through the git data API, then `PATCH git/refs` with `force: false`. A 422 maps to `conflict`.
- **One request path.** Every HTTP call goes through one request function and an operation table. HTTP errors map to forge kinds as the Story specifies.
- **Stubs.** The other port operations return `forbidden` until Stories 1.9 and 1.10.
- **Contract suite.** The suite runs offline against an in-process GitHub emulator, and live against a scratch repo only under `XARABOT_LIVE=1`.

**Files changed:**
- `src/core/schemas/github-app.ts`: the `app.json` schema.
- `src/adapters/forge/github/http.ts`: the operation table, `request` (the adapter's only `fetch`), `mapHttpError`, `SWAP_CONFLICT_STATUS` and `formatDate`.
- `src/adapters/forge/github/credentials.ts`: `appDir` and `loadAppCredentials`.
- `src/adapters/forge/github/tokens.ts`: `createAppJwt` and `createTokenSource`, which caches in memory, shares one in-flight mint, invalidates on a 401 and redacts the token.
- `src/adapters/forge/github/github-forge.ts`: `createGitHubForge`, with `snapshot`, `ledgerSwap` and the stubs.
- `src/lane/ledger-cas.ts`: the lost-ack check. A transient swap that actually landed is recognised on the next try. This settles Story 1.7's deferral for every case except the deadline one, which is deferred below.
- `test/contracts/forge.contract.ts`: harness `enabled` and `operations`, and per-scenario operation lists.
- `test/contracts/forge.github.contract.test.ts`: the emulator and live harnesses, plus the live stale-`PATCH` status test.
- `test/adapters/forge/github/`: the GitHub emulator, plus credentials, tokens, http and adapter tests, including the token-leak test.
- `test/lane/ledger-cas.test.ts`: four lost-ack tests.
- `src/adapters/forge/github/.gitkeep`: removed.

**Review findings:** 31 findings: medium 2, low 22, false 6, maybe-false 1. Every finding has a row in the Review Triage Log.
- **Patched (4 rows, 3 fixes, all low):**
  - a missing `x-ratelimit-reset` or blank `retry-after` falls back to the 60 s wait;
  - a key read failure reports its error code;
  - a delete-only lost-ack test was added.
- **Deferred (2):**
  - a deadline after a transient swap does not say the write may have landed (medium, Story 1.16);
  - real GitHub's 422 is checked only by the live test (medium, unverified; the Maintainer's live run settles it).
- **Rejected, with reasons in the log:**
  - lost-ack corner cases where a foreign commit leaves identical files or lands on top;
  - other 422s;
  - the creation race returning `conflict` (the AC requires it);
  - the shared mint signal;
  - no retry on a 401;
  - truncated trees;
  - request fan-out;
  - token permission scoping (Story 5.1a);
  - credential path and slug checks;
  - the emulator's lost-ack injection;
  - stub options;
  - clock skew;
  - ancestor resets;
  - runner wiring (Story 1.16 and later);
  - snapshot cases that can't run live;
  - recording 422;
  - the journal (none exists yet).

**Follow-up review recommended:** false. Only low entries were patched (3), with no high and no medium.

**Verification:**
- `bun install`: exit 0, `bun.lock` unchanged.
- `bun test`: 1119 pass, 74 skip, 0 fail. The skips are all live GitHub cases plus contract cases that need operations or controls a harness lacks. None of them reports as passed.
- `bun --bun oxlint`: exit 0.
- `bun --bun tsc`: exit 0.

**Residual risks:**
- The live suite has not run: this session has no GitHub access. These behaviours are therefore unconfirmed against real GitHub:
  - the 422 status for a non-fast-forward swap;
  - a root commit on the empty tree `4b825dc…`;
  - posting a tree without `base_tree`.
- The live run needs a Human Live Step: the scratch repo, plus `XARABOT_LIVE=1`, `XARABOT_LIVE_GITHUB_REPO` and `XARABOT_LIVE_GITHUB_LOGIN`.
- Concurrent token callers share the first caller's abort signal.
