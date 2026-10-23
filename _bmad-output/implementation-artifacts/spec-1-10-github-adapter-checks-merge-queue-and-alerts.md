---
title: 'Story 1.10: GitHub adapter: checks, merge queue and alerts'
type: 'feature'
created: '2026-10-23'
status: 'done'
baseline_revision: '9157c4e43219759f93a7f2bb7b8ad5a52cbf3ba8'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** In the GitHub forge adapter, `checks`, `enqueue`, `dequeue` and `alert` are still `forbidden` stubs. So the runner cannot read CI for a head SHA, cannot merge through the merge queue (the only merge path), and cannot tell the Maintainer that every lane has stopped (FR6, FR9, FR13, AR24, AR38).

**Approach:** Implement the four operations in `github-forge.ts`:
- `checks` reads REST check runs plus the combined commit status.
- `enqueue` and `dequeue` read the PR's queue state over GraphQL, then call `enqueuePullRequest` (with `expectedHeadOid`) or `dequeuePullRequest`.
- `alert` posts one deduplicated @mention comment on the Maintainer's `xarabot-inbox` issue, creating and assigning the issue if missing.

Extend the operation table with the new permissions. Add a manifest constant and `docs/maintainer/app-permissions.md`, and test that they match exactly. Teach the emulator the new endpoints, then run the contract suite on the emulator and live (`XARABOT_LIVE=1`), plus a live AR38 probe.

## Boundaries & Constraints

**Always:**
- **`http.ts`:**
  - `Permission` gains `issues: write` and `statuses: read`.
  - `Operation` gains an optional `notFoundOn` (a status that maps to `not-found`).
  - In `mapHttpError`, a 403 that is not a rate limit is `forbidden`, and its message ends with ` (needs <op.permission>)`. Every other mapping and message stays as it is.
  - New operations:
    - `listCheckRuns` gets `notFoundOn: 422`.
    - `getCombinedStatus` (`statuses: read`, `notFoundOn: 422`).
    - `pullQueueState` (POST `/graphql`, `pull_requests: write`).
    - `enqueuePullRequest` and `dequeuePullRequest` (POST `/graphql`, `contents: write`).
    - `listIssues`, `createIssue`, `listIssueComments` and `createIssueComment` (`issues: write`).
  - `APP_PERMISSIONS` is exactly `contents: write`, `pull_requests: write`, `issues: write`, `checks: read`, `statuses: read`, `actions: read` and `metadata: read`.
  - `mapGraphqlErrors(op, errors, fallback)` is pure and exported. It maps:
    - type `FORBIDDEN`, or a message matching "not accessible by integration", to `forbidden` naming `op.permission`;
    - `NOT_FOUND` to `not-found`;
    - `RATE_LIMITED`, or a message matching "rate limit", to `rate-limited` (60 s);
    - `INTERNAL`, `SERVICE_UNAVAILABLE` or `TIMEOUT` to `transient`;
    - an error with no `type` (a schema or parse error) to `forbidden`;
    - anything else to `fallback`.
- **`checks(sha)`:**
  - A non-hex `sha` is `not-found`.
  - It pages `GET /commits/{sha}/check-runs?filter=latest` and then `GET /commits/{sha}/status`, both 100 per page with the `paged` rule. It returns the check runs in API order, then the statuses.
  - A check run maps to `{name, status, conclusion}`. `status` is `completed` or `in_progress` as given, and any other value becomes `queued`. `conclusion` is `null` unless the run is completed.
  - A commit status maps to `{name: context, …}`: `success`, `failure` and `error` become `completed` with that conclusion, and `pending` becomes `in_progress` with `null`.
  - An empty result means pending.
- **`enqueue(pr, expectedHead)`:**
  - It sends the `pullQueueState` GraphQL query (`repository.pullRequest(number)` → `id state headRefOid mergeQueueEntry{id}`). A null PR is `not-found`. A state other than `OPEN` is `conflict`. A `headRefOid` other than `expectedHead` is `conflict`. An existing entry is `ok`.
  - Otherwise it sends `enqueuePullRequest(input:{pullRequestId, expectedHeadOid})`. Errors map with fallback `conflict`, except that a message matching "already" (queued, enqueued or in the queue) is `ok`.
- **`dequeue(pr)`:**
  - The same query: a null PR is `not-found`, and no entry is `ok`.
  - Otherwise it sends `dequeuePullRequest(input:{id})`. Errors map with fallback `conflict`, except that a message matching "not in (the) queue" or "not queued" is `ok`.
- The query uses fallback `transient`. Every GraphQL call goes through `request` at `<apiUrl>/graphql` with `{query, variables}`.
- **`alert(condition, mainSha)`:**
  - The new option `maintainer` must be a valid GitHub login, else `forbidden`. The option `inboxLabel` defaults to `xarabot-inbox`. A non-hex `mainSha` is `not-found`.
  - **Find the issue.** Page `GET /issues?labels=<label>&assignee=<maintainer>&state=open&sort=created&direction=asc`, drop entries with `pull_request`, and take the lowest number. If there is none, send `POST /issues {title: "🤖 Xarabot inbox", body, labels:[label], assignees:[maintainer]}`.
  - **Dedupe.** `since` is the committer date of `mainSha` (`GET /git/commits/{sha}`) minus 24 h, and is omitted on a 404 or 422. Page `GET /issues/{n}/comments?since=…`. If a comment by `<app slug>[bot]` contains the marker `<!-- xarabot-alert <encodeURIComponent(condition)> <mainSha> -->`, return `{posted:false}`.
  - **Post.** Otherwise post one comment: `🤖 @<maintainer> Xarabot alert: \`<condition>\` stops every lane (main \`<mainSha>\`).`, then a blank line and the marker. In the shown condition, backticks become `'` and newlines become spaces. Return `{posted:true}`.
  - It reads neither `main`'s files, config nor `runner.git`, so it works while the lane is failing closed.
- `docs/maintainer/app-permissions.md` holds one table row per `APP_PERMISSIONS` entry, with the operations that use it. Below the table it records the AR38 live result (2026-10-23): `enqueue` and `dequeue` need no permission of their own, so they are listed under `contents: write`. There is no merge-queue row.

**Never:**
- No admin merge, `mergePullRequest`, auto-merge, `--delete-branch`, branch delete or `DELETE` operation in the adapter. No approve operation.
- No new dependency. No `fetch` outside `http.ts:request`. No real GitHub host outside `XARABOT_LIVE=1`.
- No lane wiring (Stories 1.16 to 1.17a), no digest or rulings (Epic 2).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Pending | no runs, no statuses | `{checks: []}` | — |
| Mixed | 1 run `completed/success`, 1 status `pending` | both, runs first | — |
| Unknown commit | check-runs answers 422 | `not-found` | — |
| Missing check permission | check-runs answers 403 | `forbidden`, message has `checks: read` | — |
| Enqueue ok | open PR at the head, not queued | mutation with `expectedHeadOid`; `{queued:true}` | — |
| Wrong head | head ≠ expected | `conflict`, no mutation | — |
| Already queued | entry present | `{queued:true}`, no mutation | — |
| Permission missing | mutation answers 200 with `FORBIDDEN` errors | `forbidden`, message has `contents: write` | — |
| Dequeue not queued | no entry | `{queued:false}`, no mutation | — |
| Inbox missing | no labelled issue | issue created with the label and assigned; one comment | — |
| Repeat alert | same (condition, sha) | `{posted:false}`, no POST | — |
| Spoofed marker | marker in a comment by another user | still posts | — |
| Failing closed | `main` has an invalid `.xarabot/config.yaml`, no `runnerGit` | the alert posts | — |

</intent-contract>

## Code Map

- `src/adapters/forge/github/github-forge.ts`:
  - `createGitHubForge`, `api`/`apiReply` (repo-prefixed) and `paged`. Add an unprefixed call for `/graphql`.
  - `getPr`, `toPr`, `SHA_PATTERN` and `PASSING_CONCLUSIONS`.
  - `stub` and its four uses go away. Add the options `maintainer?` and `inboxLabel?`.
- `src/adapters/forge/github/http.ts`: `Permission`, `Operation`, `GITHUB_OPERATIONS`, `mapHttpError` and `request`. Note that `createComment` (`pull_requests: write`) stays for PR comments.
- `src/adapters/forge/github/credentials.ts`: `AppCredentials.app.slug`, which gives the bot login `<slug>[bot]`.
- `src/ports/forge.ts`: `ForgeCheck`, and the `checks`/`enqueue`/`dequeue`/`alert` semantics. Unchanged.
- `src/adapters/forge/fake/fake-forge.ts`: the reference semantics. Unchanged.
- `test/contracts/forge.contract.ts`: the checks, queue and alert cases. Unchanged.
- `test/contracts/forge.github.contract.test.ts`:
  - The `IMPLEMENTED` list becomes all operations.
  - The emulator harness gains `queue` and `mergeQueueHead`.
  - The live harness: `prefixed` also prefixes `alert` conditions with a run id; `maintainer` is `LIVE_LOGIN`; and `liveScratch`.
- `test/adapters/forge/github/fake-github.ts`:
  - Add the GraphQL endpoint (the queue query and mutations, node ids `PR_<n>`).
  - Add the queue: a head move or a close drops the entry.
  - Add the controls `queue`, `mergeQueueHead`, `setStatuses` and `issues`.
  - Add `/commits/{sha}/status`, `/issues` list and create, and issue comments on any issue or PR (with `user.login` and `since`).
  - `getCommit` gains `committer.date`, and the option `appSlug` defaults to `alice-xarabot`.
- `test/adapters/forge/github/github-forge.test.ts`: the "Story 1.10 stubs" test (~l.311) is removed.
- `test/adapters/forge/github/http.test.ts`: the 403 row and the permission-list test.

## Tasks & Acceptance

**Execution:**
- `src/adapters/forge/github/http.ts`: the permissions, `notFoundOn`, the 403 suffix, the new operations, `APP_PERMISSIONS` and `mapGraphqlErrors`.
- `src/adapters/forge/github/github-forge.ts`: `checks`, `enqueue`, `dequeue`, `alert` and the options. Update the header comment.
- `docs/maintainer/app-permissions.md`: the permission table and the AR38 result.
- `test/adapters/forge/github/fake-github.ts`: the endpoints and controls in the Code Map.
- `test/adapters/forge/github/checks.test.ts`: the checks matrix rows, paging, mapping, and a non-hex SHA.
- `test/adapters/forge/github/queue.test.ts`: the queue matrix rows, the GraphQL request shapes, a `mapGraphqlErrors` table, and a source scan for banned merge paths.
- `test/adapters/forge/github/alert.test.ts`: the alert matrix rows, the body and marker, the `since` lower bound, and an invalid `maintainer`.
- `test/adapters/forge/github/http.test.ts`: `notFoundOn`, the 403 permission suffix, and a manifest test. Every operation permission other than `app-jwt` and `none` is in `APP_PERMISSIONS`. Every manifest entry except `metadata: read` is used. `enqueuePullRequest` and `dequeuePullRequest` name `contents: write`. The doc's table rows equal `APP_PERMISSIONS`, and no row mentions the merge queue.
- `test/adapters/forge/github/github-forge.test.ts`: drop the stubs test.
- `test/contracts/forge.github.contract.test.ts`:
  - The harness changes above.
  - A live AR38 probe with a 120 s test timeout. It pushes a commit and opens a PR, then enqueues at the head and expects `ok` or `conflict`. In `finally` it dequeues and runs the cleanup that closes the PR.
  - A live `checks` read of a pushed commit that expects `ok`.

**Acceptance Criteria:**
- Given the emulator harness, when the forge contract suite runs, then every case passes, including checks, queue and alert. None is skipped for a missing operation.
- Given no `XARABOT_LIVE=1`, when `bun test` runs, then every live case, including the AR38 probe, is skipped, none passed.
- Given `src/adapters/forge/github/`, when it is searched, then it contains no `mergePullRequest`, auto-merge, `--admin`, `delete-branch` or `DELETE` operation.
- Given the repo, when `bun install`, `bun test`, `bun --bun oxlint` and `bun --bun tsc` run, then each exits 0.

## Spec Change Log

## Review Triage Log

### 2026-10-23 — Review pass
- verdicts: 42 findings — high 0, medium 0, low 29, false 13, maybe-false 0
- findings:
  - `[low]` `[reject]` (intent) The live harness lacks `setChecks` and `queue`, so the shared checks and idempotent-queue cases skip live — the App has no `checks: write`, and per the AC the probe's `[skip ci]` commits never satisfy the required check, so a live enqueue cannot succeed by design. Live coverage comes from the AR38 probe, the live `checks` read, and the wrong-head and alert cases, which do run live.
  - `[low]` `[reject]` (intent) No live run in this session — the session has no live credentials, and the run is the precondition's Human Live Step. Recorded as a residual risk.
  - `[false]` `[reject]` (intent) "Failing closed" is tested at adapter level only — this is an adapter Story; the test proves `alert` reads no config, `main` files or `runner.git`, which is what makes failing-closed alerting possible.
  - `[false]` `[reject]` (intent) Nothing wires `maintainer` or decides "newly" — lane wiring belongs to Stories 1.16 to 1.17a; the port dedupes by (condition, SHA) as AD-23 says.
  - `[false]` `[reject]` (intent) "Merges never bypass required checks" is shown only by absence — the merge queue enforces required checks, and the adapter has no other merge path (source scan, operation table, contract case).
  - `[false]` `[reject]` (intent) `filter=latest` returns fewer than every check-run record — a superseded attempt is not that check's state, and returning it would make a re-run that passed look failed; each check name and status context is still reported.
  - `[false]` `[reject]` (intent) Which grant covers the mutation is not isolated — the AC and AD-26 settle the doc's wording, `contents: write`, and the doc says so.
  - `[low]` `[patch]` (verification-gap) `prefetch` on a 422 from check-runs became `not-found` and no test pins it — added a pulls test.
  - `[low]` `[reject]` (verification-gap) GitHub silently dropping the assignee would duplicate the inbox — the Maintainer owns or administers the repo, so can be assigned; a guard adds complexity for a case not met in everyday use.
  - `[low]` `[reject]` (edge) Two lanes creating the inbox at once — `XARABOT_MAX_BUILDERS=1` until Epic 3; the result is a second issue, and lookups take the lowest number; real serialisation needs ledger coordination.
  - `[low]` `[reject]` (edge) Concurrent same-pair alerts can both post — same reason; the harm is one extra notification; GitHub has no atomic comment primitive.
  - `[low]` `[reject]` (edge) Dropped assignee on create — same as the verification-gap assignee row.
  - `[low]` `[reject]` (edge) A very long condition overflows the comment limit — conditions are runner codes; not reachable with today's callers.
  - `[low]` `[reject]` (edge) A committer date more than 24 h in the future breaks dedupe — needs a crafted commit merged to `main` or extreme clock skew.
  - `[low]` `[reject]` (edge) An unknown `mainSha` on an inbox with more than 5000 comments returns `transient` — needs years of comments plus an unknown SHA.
  - `[low]` `[patch]` (edge) A mutation reply with an "already queued" error plus a FORBIDDEN error is `ok` — `mutationResult` now needs every error to match; added a queue test.
  - `[false]` `[reject]` (edge) A non-SHA or uppercase `expectedHead` is `conflict` — the port says a head other than `expectedHead` is `conflict`.
  - `[low]` `[reject]` (edge) A GHES `apiUrl` gives the wrong GraphQL URL — GHES is not supported, and the default is api.github.com.
  - `[low]` `[reject]` (edge) A completed run with a null conclusion passes through — `ForgeCheck` allows it, and GitHub always sets a conclusion on completion.
  - `[false]` `[reject]` (edge) A check run and a status can share a name — the AC asks for every check run and status; reporting both is faithful.
  - `[low]` `[reject]` (edge) `(needs none)` on a 403 from a signed URL — the URL is used right after it is issued; cosmetic only.
  - `[false]` `[reject]` (edge) The AR38 probe could merge into the live `main` — the precondition puts a required check on the scratch repo, which `[skip ci]` commits never satisfy.
  - `[low]` `[patch]` (edge) The alert lower-bound test title claims an exclusion it does not assert — added a case where an old bot marker does not dedupe, and retitled.
  - `[low]` `[reject]` (edge) The claim that the inbox is "assigned" is unchecked — same as the assignee row.
  - `[low]` `[reject]` (edge) The claim "deduplicated" is not atomic — same as the concurrent-alert row.
  - `[false]` `[reject]` (blind) The probe could merge into the live `main` — same refutation as the edge row.
  - `[low]` `[reject]` (blind) The probe counts any unrecognised error (`conflict`) as proof — the AC prescribes "ok or conflict"; a permission refusal is mapped to `forbidden`.
  - `[low]` `[reject]` (blind) A missing merge queue maps to `conflict` and could loop — the AD-33 lane-start check covers the merge queue prerequisite, and the unit budget caps loops.
  - `[low]` `[reject]` (blind) The inbox is duplicated when the assignee is dropped — same as the assignee row.
  - `[low]` `[reject]` (blind) Concurrent alerts — same as the concurrent-alert row.
  - `[low]` `[reject]` (blind) `maintainer` is validated only at alert time — the config schema already validates `maintainer` as a GitHub login; lane wiring passes it in.
  - `[false]` `[reject]` (blind) An unredacted condition could leak a token — every forge error message is already redacted before any caller sees it, and only the adapter holds the token.
  - `[low]` `[reject]` (blind) Live runs leave alert comments behind — the scratch repo only; noted in Design Notes.
  - `[low]` `[reject]` (blind) Dedupe-window edge cases and the emulator filtering `since` by `created_at` — same as the edge rows; the emulator never edits comments, so `created_at` equals `updated_at`.
  - `[low]` `[patch]` (blind) The alert test titles over-claim — grouped with the edge test-title row; fixed.
  - `[false]` `[reject]` (blind) `checks` duplicates a name — same refutation as the edge row.
  - `[false]` `[reject]` (blind) `dequeue` cannot tell "removed" from "merged" — the port returns `queued:false` either way; the PR state comes from `snapshot`.
  - `[low]` `[patch]` (blind) `some` hides a real failure — grouped with the edge `mutationResult` row; fixed.
  - `[low]` `[reject]` (blind) `notFoundOn: 422` is broader than "No commit found" — the adapter builds the query itself; the only reachable 422 is an unknown commit.
  - `[low]` `[reject]` (blind) The emulator's `mergeQueueHead` keeps `main`'s tree — test-only; no contract case reads `main` after a merge.
  - `[false]` `[reject]` (blind) The spec is missing from the review content — by design; the spec goes to the edge-case layer only.
  - `[low]` `[reject]` (blind) Untested paths: draft PR, repository not found, abort mid-alert, exact paging multiples — the draft PR goes through the tested fallback, the abort goes through `guarded`, and paging is shared with tested callers.

## Design Notes

- **Why a state query before the mutation.** The port promises "already queued is `ok`" and "`ok` when not queued", and GitHub's replies to those cases are not documented. Reading `mergeQueueEntry` first makes both cases need no mutation. `expectedHeadOid` still guards the race between the read and the mutation.
- **Fallback `conflict` for the mutations.** GitHub refuses an enqueue for PR state (head moved, not mergeable, checks unmet) with `UNPROCESSABLE`-like errors. The lane treats `conflict` as "re-read and decide". That is why the AR38 probe counts `conflict` as proof that the permission suffices.
- **Dedupe marker by the bot only.** Only the bot's own comments count, so a human cannot silence an alert by pasting a marker. The `since` bound keeps the comment scan short on an old inbox. A comment for `mainSha` cannot be older than that commit.
- **Live alerts** go to the scratch repo's inbox for `LIVE_LOGIN` (the App owner, who is the Maintainer for the per-person bot). Each run's conditions carry a uuid, so dedupe never crosses runs.

## Verification

**Commands:**
- `bun install` -- expected: exit 0, `bun.lock` unchanged.
- `bun test` -- expected: exit 0, with the live cases skipped.
- `bun --bun oxlint` -- expected: exit 0.
- `bun --bun tsc` -- expected: exit 0.

## Auto Run Result

Status: done

**Summary.** The GitHub forge adapter now implements the last four `Forge` operations, so no stubs are left:
- `checks` reads the REST check runs (`filter=latest`) plus the combined commit status. An empty list means pending.
- `enqueue` and `dequeue` read the PR's merge-queue state over GraphQL, then call `enqueuePullRequest` (with `expectedHeadOid`) or `dequeuePullRequest`.
- `alert` posts one @mention comment on the Maintainer's `xarabot-inbox` issue, creating and assigning the issue if it is missing. It dedupes by a hidden (condition, `main` SHA) marker in the bot's own comments. It reads no config, `main` files or `runner.git`, so it works while the lane is failing closed.

A missing permission maps to `forbidden`, with a message naming the permission, for both REST 403 replies and GraphQL `FORBIDDEN` errors. The App's exact permission manifest (`APP_PERMISSIONS`) and `docs/maintainer/app-permissions.md` are tested against the operation table. The doc lists the merge-queue mutations under `contents: write` and has no merge-queue row.

**Files changed:**
- `src/adapters/forge/github/http.ts`:
  - the `issues: write` and `statuses: read` permissions;
  - `notFoundOn`;
  - the 403 permission suffix;
  - 9 new operations;
  - `APP_PERMISSIONS` and `mapGraphqlErrors`.
- `src/adapters/forge/github/github-forge.ts`: `checks`, `enqueue`, `dequeue` and `alert`, the `maintainer` and `inboxLabel` options, and the `alertMarker` and `alertBody` helpers. The stubs are removed.
- `docs/maintainer/app-permissions.md`: new. The permission table and the AR38 live result.
- `test/adapters/forge/github/fake-github.ts`: the emulator gained a GraphQL merge queue, the commit status endpoint, inbox issues and comments (with `user.login` and `since`), and committer dates.
- `test/adapters/forge/github/{checks,queue,alert}.test.ts`: new. They cover the matrix rows, the request shapes, a `mapGraphqlErrors` table and a source scan for banned merge paths.
- `test/adapters/forge/github/http.test.ts`: tests for `notFoundOn`, the 403 suffix, and the manifest and doc checks.
- `test/adapters/forge/github/pulls.test.ts`: prefetch on a 422 from check-runs is `not-found`.
- `test/adapters/forge/github/github-forge.test.ts`: the stubs test is removed.
- `test/contracts/forge.github.contract.test.ts`:
  - The emulator harness offers every operation plus `queue` and `mergeQueueHead`.
  - The live harness prefixes alert conditions with the run id.
  - Added a live AR38 probe (120 s, cleans up in `finally`) and a live `checks` read.

**Review findings:** 42 findings: 0 high, 0 medium, 29 low, 13 false.
- **Patched (3 entries, all low):**
  - `mutationResult` now needs every error to match "already queued" or "not queued".
  - A prefetch 422 test.
  - An alert test where a bot marker older than the lower bound does not dedupe, with the over-claiming titles corrected.
- **Deferred:** none.
- **Rejected:** every other finding, with its reason in the triage log.
- **Accepted risks among the rejections:** concurrent lanes can post a duplicate alert or create a second inbox (only one lane runs until Epic 3). A dropped assignee would duplicate the inbox (unlikely while the Maintainer owns the repo).

**Follow-up review:** not recommended. No high or medium entry was patched (patched: high 0, medium 0, low 3).

**Verification:** `bun install` (no changes) and `bun test` (1267 pass, 58 skip, 0 fail; the skips are live cases and the two emulator cases that need `injectError`). `bun --bun oxlint` and `bun --bun tsc` both exited 0.

**Residual risks:**
- The live contract suite, the AR38 probe and the live `checks` read have not run: this session has no live credentials. The Maintainer should run `XARABOT_LIVE=1 bun test test/contracts/forge.github.contract.test.ts` against the scratch repo.
- GitHub's exact wording for "already queued" and "not in the queue" errors is matched by regex and not checked live. The state query runs first, so those paths are rare.
- Live alert cases @mention `LIVE_LOGIN` on the scratch repo's inbox and are not cleaned up.
