---
title: 'Story 1.10: GitHub adapter: checks, merge queue and alerts'
type: 'feature'
created: '2026-10-23'
status: 'blocked'
baseline_revision: '7a6f66c4a2e20d6c600d7d9de1833d2e8c30592e'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      If GitHub drops the Maintainer from `assignees` on `POST /issues`, every later alert misses the inbox and creates another issue, so the dedupe never matches.
    evidence: |-
      findInbox filters on assignee=<login>, and createInbox does not check the created issue's assignees. Whether GitHub drops an unassignable login silently or answers 422 is not known here. A live alert with a login that is not a collaborator settles it; if the login is dropped, check the created issue's assignees and return forbidden.
    location: >-
      src/adapters/forge/github/github-forge.ts:createInbox
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** `checks`, `enqueue`, `dequeue` and `alert` in the GitHub forge adapter are `forbidden` stubs. The runner cannot read CI, merge through the merge queue, or tell the Maintainer that every lane stopped (FR6, FR9, FR13, AR24, AR38). AR38 is open: GitHub's docs do not say which App permission `enqueuePullRequest` needs, and the Story says to verify it live first.

**Approach:** Implement the four operations: `checks` over REST (check runs plus commit statuses), `enqueue`/`dequeue` over GraphQL, and `alert` as one deduplicated comment on the Maintainer's `xarabot-inbox` issue. Extend the emulator and the contract suite, and add a live AR38 probe test and `docs/maintainer/app-permissions.md`. This session has no GitHub access by design (AGENTS.md, "Agents never touch GitHub"), so it cannot run the live verification. The adapter names a candidate permission, `merge_queues: write`, marked unverified. The run ends `blocked` on AR38 so the Maintainer runs the probe and records the finding.

## Boundaries & Constraints

**Always:**
- **`http.ts`:**
  - `Permission` gains `issues: write`, `statuses: read` and `merge_queues: write`.
  - `GITHUB_OPERATIONS` gains:
    - `listStatuses` (`GET`, `statuses: read`)
    - `readPullGraph` (`POST` `/graphql`, `pull_requests: write`)
    - `enqueuePullRequest` and `dequeuePullRequest` (`POST` `/graphql`, `ENQUEUE_PERMISSION`)
    - `listIssues`, `createIssue`, `listIssueComments` and `createIssueComment` (`issues: write`)
  - `ENQUEUE_PERMISSION = "merge_queues: write"` is exported, with a doc comment saying AR38 is unverified.
- **`checks(sha)`:**
  - A SHA that is not hex is `not-found`.
  - It reads check runs from `GET /commits/{sha}/check-runs?filter=latest` (paged), then statuses from `GET /commits/{sha}/status?per_page=100&page=N` (paged on `statuses`).
  - Check runs come first, in API order, as `{name, status, conclusion}`. `waiting`, `requested` and `pending` map to `queued`. Any other unknown status is malformed (`transient`).
  - A status maps to `{name: context, …}`: `pending` is `in_progress` with conclusion `null`; `success`, `failure` and `error` are `completed` with that conclusion.
  - A 422 from either endpoint ("No commit found") is `not-found`. Empty lists return `{checks: []}`, which means pending.
- **The PR lookup** (for `enqueue` and `dequeue`): a GraphQL query `query XarabotPull($owner,$name,$number)` reads `repository.pullRequest {id state headRefOid isInMergeQueue}`. A null PR or a `NOT_FOUND` error is `not-found`.
- **`enqueue(pr, expectedHead)`:**
  - A closed or merged PR, or a head other than `expectedHead`, is `conflict`.
  - A PR already in the queue at that head is `{queued: true}` with no mutation.
  - Otherwise it sends `mutation XarabotEnqueue` (`enqueuePullRequest(input: {pullRequestId, expectedHeadOid})`).
- **`dequeue(pr)`:** a PR that is not queued is `{queued: false}` with no mutation. Otherwise it sends `mutation XarabotDequeue` (`dequeuePullRequest(input: {id})`).
- **GraphQL error mapping (pure, exported `mapGraphqlErrors(op, errors)`):**
  - `FORBIDDEN` or "Resource not accessible by integration" is `forbidden`. For the queue mutations, the message names `ENQUEUE_PERMISSION` and AR38.
  - `NOT_FOUND` is `not-found`, `RATE_LIMITED` is `rate-limited` (60 s), `UNPROCESSABLE` is `conflict`, and anything else is `transient`.
  - A non-200 HTTP reply goes through `mapHttpError`.
- **`alert(condition, mainSha)`:**
  - It needs the new option `maintainer` (a GitHub login), else `forbidden`. A `mainSha` that is not hex is `not-found`.
  - It reads nothing from `main`, the ledger, config or policy, so it works while the lane is failing closed.
  - Finding the inbox: `GET /issues?labels=xarabot-inbox&assignee=<login>&state=open&per_page=100&page=N`. It ignores entries with `pull_request` and takes the lowest number.
  - If there is none, it sends `POST /issues {title: "Xarabot inbox: <login>", body, labels: ["xarabot-inbox"], assignees: [login]}`.
  - The dedupe key is `sha256(condition + "\n" + mainSha)`. If a comment on the issue (paged) contains `<!-- xarabot-alert:<key> -->`, it returns `{posted: false}`.
  - Otherwise it posts one comment: `🤖 @<login> every lane has stopped: <condition> (main <sha>).` followed by the marker. In `<condition>`, newlines become spaces, and backticks and `@` are removed. It returns `{posted: true}`.
- Every message goes through `tokens.redact`. The deadline rule is unchanged: an aborted signal is `transient` before any request.
- **`docs/maintainer/app-permissions.md`:**
  - One table row per permission in `GITHUB_OPERATIONS`, naming its operations. A test keeps the doc and the table in sync.
  - An AR38 section saying the finding is unverified, with the probe command and the steps that settle it.

**Never:**
- No admin merge, auto-merge (`enablePullRequestAutoMerge`), `mergePullRequest`, REST merge endpoint or branch delete. A test greps the adapter source for these.
- No GitHub host call outside `XARABOT_LIVE=1`. This session never runs the live tests.
- No new dependency, no `gh`, and no `fetch` outside `http.ts:request`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected |
|---|---|---|
| Pending | no check runs and no statuses | `{checks: []}` |
| Mixed | 2 runs (one `waiting`) and 1 `pending` status | runs then status, with `waiting` mapped to `queued` and the status `in_progress`/`null` |
| Unknown SHA | check-runs answers 422 | `not-found` |
| Enqueue | open PR at the expected head, not queued | mutation sent with `expectedHeadOid`, `{queued: true}` |
| Re-enqueue | already queued at the head | `{queued: true}`, no mutation |
| Wrong head | head ≠ expected | `conflict`, no mutation |
| Closed PR | enqueue | `conflict` |
| No permission | mutation answers `FORBIDDEN` | `forbidden`, message names `merge_queues: write` and AR38 |
| Dequeue unqueued | not in the queue | `{queued: false}`, no mutation |
| First alert | no inbox issue | issue created, labelled and assigned; one comment with @login and the marker |
| Repeat alert | same condition and SHA | `{posted: false}`, no comment |
| Fail-closed alert | `main` ref reads fail | the alert still posts |
| No maintainer | option missing | `forbidden` |

</intent-contract>

## Code Map

- `src/adapters/forge/github/github-forge.ts`:
  - `createGitHubForge`: `api`, `apiReply`, `guarded`, `paged` (the `PER_PAGE`/`MAX_PAGES` rule), `getPr`, `toPr` and `asObj`/`str`.
  - `stub` with its 4 uses (lines 662–683): replace them all and remove `stub`.
  - Add the option `maintainer?: string`.
  - Update the header comment.
- `src/adapters/forge/github/http.ts`: `Permission`, `GITHUB_OPERATIONS` and `request`. A GraphQL call is `request({op, path: "/graphql", body: {query, variables}})`, outside `repoPath`.
- `src/ports/forge.ts`: `ForgeCheck`, `CheckStatus` and the semantics of `enqueue`, `dequeue` and `alert`. Unchanged.
- `src/adapters/forge/fake/fake-forge.ts` (lines 320–345): the reference semantics. Never import it.
- `test/adapters/forge/github/fake-github.ts`:
  - The emulator. Issues share the PR number space (`nextNumber`), and issue comments work on issues and PRs.
  - Add `/commits/{sha}/status`, `/issues` GET/POST and `POST /graphql`, which dispatches on the operation name `XarabotPull`, `XarabotEnqueue` or `XarabotDequeue`.
  - Add the controls `setStatuses`, `queue`, `mergeQueueHead` (marks the head PR merged and closed, and dequeues it), `denyMergeQueue(on)` (the mutations answer `FORBIDDEN` "Resource not accessible by integration"), `issues()` (number, title, labels, assignees) and `issueComments(n)`.
  - A push that moves an open queued PR's head removes it from the queue, as GitHub does.
- `test/contracts/forge.contract.ts`:
  - Add one case: "checks on a pushed commit with no CI are empty" (`pushBranch`, `checks`; `makeCommit`), so `checks` runs live.
  - Leave the other cases unchanged.
- `test/contracts/forge.github.contract.test.ts`:
  - `IMPLEMENTED` becomes every operation.
  - The emulator harness passes `maintainer` and adds the controls `queue` and `mergeQueueHead`.
  - The live harness passes `maintainer: XARABOT_LIVE_GITHUB_MAINTAINER` (the live suite needs it set).
  - The live harness adds a `queue` control: a raw GraphQL read of `mergeQueue(branch:"main").entries`, filtered to this fixture's PRs. Cleanup dequeues them.
  - Add `live: AR38 enqueue permission probe`. It opens a PR and calls `enqueue`, logs the installation's granted `permissions` (`GET /repos/{o}/{r}/installation` with the App JWT) and the result, and fails if the result is `forbidden`.
- `test/adapters/forge/github/github-forge.test.ts`: the test at lines 311–317 checks the stubs. Replace it.

## Tasks & Acceptance

**Execution:**
- `src/adapters/forge/github/http.ts`: add the permissions, the operations and `ENQUEUE_PERMISSION`.
- `src/adapters/forge/github/github-forge.ts`: add `checks`, `enqueue`, `dequeue`, `alert`, the exported `mapGraphqlErrors` and `alertMarker(condition, sha)`, and the `maintainer` option. Remove `stub`.
- `test/adapters/forge/github/fake-github.ts`: add the endpoints and controls above.
- `test/adapters/forge/github/checks-queue.test.ts`: new. The checks and queue rows of the matrix, request shapes (`expectedHeadOid`, operation names) and a table of `mapGraphqlErrors` cases.
- `test/adapters/forge/github/alert.test.ts`: new. The alert rows, condition sanitising and request shapes.
- `test/adapters/forge/github/github-forge.test.ts`: replace the stub test with a source grep. It checks that the adapter contains no `mergePullRequest`, `enablePullRequestAutoMerge`, `/merge"`, `delete_branch` or `--delete-branch`, and no `DELETE` operation in `GITHUB_OPERATIONS`.
- `test/adapters/forge/github/http.test.ts`: add a check that every operation's permission appears in `docs/maintainer/app-permissions.md`, and that every permission listed there is used.
- `test/contracts/forge.contract.ts` and `test/contracts/forge.github.contract.test.ts`: as in the Code Map.
- `docs/maintainer/app-permissions.md`: new, as above.

**Acceptance Criteria:**
- Given the emulator harness, when the forge contract suite runs, then every case passes, including checks, queue, alert and the merged-PR cases. No case is skipped for a missing operation.
- Given no `XARABOT_LIVE=1`, when `bun test` runs, then every live case is skipped and none passes.
- Given `src/adapters/forge/github/`, when it is searched, then `fetch(` appears only in `http.ts:request`.
- Given the repo, when `bun install`, `bun test`, `bun --bun oxlint` and `bun --bun tsc` run, then each exits 0.

## Spec Change Log

## Review Triage Log

### 2026-10-23 — Review pass
- verdicts: 37 findings — high 0, medium 6, low 23, false 5, maybe-false 3
- findings:
  - `[medium]` `[patch]` (verification-gap) No test shows GraphQL error messages are redacted — added a checks-queue test: a `FORBIDDEN` message quoting the token comes back `[redacted]`.
  - `[medium]` `[patch]` (verification-gap) The AR38 probe passes on any kind but `forbidden`, so a `transient` or `not-found` run would be read as "permission is enough" — the probe now accepts only `ok` or `conflict`.
  - `[maybe-false]` `[defer]` (verification-gap) GitHub may silently drop an unassignable assignee, so `findInbox` never finds the created inbox — not demonstrable without live GitHub; deferred as medium (unverified).
  - `[low]` `[reject]` (blind) The AR38 probe could merge a scratch PR into the live repo's `main` — the scratch commit has `main`'s own tree (an empty diff) on a scratch repo, and cleanup dequeues it; the harm is negligible.
  - `[medium]` `[patch]` (blind) The probe passes without settling anything — grouped with the verification-gap probe row; fixed.
  - `[maybe-false]` `[defer]` (blind) Inbox lookup can create a new inbox on every alert — grouped with the assignee row; deferred.
  - `[medium]` `[patch]` (blind) Any commenter can suppress alerts by posting the computable marker — dedupe now counts only comments whose `user.type` is `Bot`; the emulator marks token comments as the bot, and an alert test shows a `User` comment with the marker does not suppress.
  - `[low]` `[reject]` (blind) The `maintainer` login is not validated against GitHub's pattern — the config schema (`GitHubLogin`) validates `maintainer` before it reaches the adapter.
  - `[low]` `[patch]` (blind) `sanitizeCondition` leaves `<!--`/`-->`, so a condition can break or fake a marker — `<` and `>` are now removed, with a table row.
  - `[low]` `[reject]` (blind) No length cap on the condition (65,536-character comment limit) — conditions are runner-defined kinds, not error dumps; a cap adds a branch.
  - `[low]` `[reject]` (blind) An empty condition is accepted — runner conditions are never empty; a guard adds a branch.
  - `[low]` `[reject]` (blind) A PR leaving or joining the queue between the read and the mutation gives `conflict` instead of the idempotent answer — needs a race inside one call, unlikely at `XARABOT_MAX_BUILDERS=1`, and the caller re-snapshots on `conflict`; the fix adds a re-read branch.
  - `[low]` `[patch]` (blind) The `isInMergeQueue` read and the live `queue` read may need the merge-queue permission, and the docs don't say so — added an AR38 note in app-permissions.md: a `forbidden` naming `readPullGraph` means the read needs it too.
  - `[false]` `[reject]` (blind) GraphQL `NOT_FOUND` on the repository hides a permission problem — the installation token is minted scoped to this repo (`repositories: [name]`), so a token that cannot see the repo is never issued; a lost installation fails at minting as `uninstalled`.
  - `[low]` `[reject]` (blind) Several adapter tests are missing (422 short-circuit, non-list fields, `POST /issues` failure, comment 403, adapter-level `UNPROCESSABLE`, dequeue of a closed PR) — every path goes through the shared `paged`/`api`/`mapHttpError`/`mapGraphqlErrors`, which are tested; redaction is covered by the patched row.
  - `[low]` `[reject]` (blind) A check run and a status with the same name yield two `ForgeCheck`s — the port lists checks without a source, and consumers judge every entry; dedupe would hide a failing one.
  - `[false]` `[reject]` (blind) The spec says `in-review` but plans `blocked`, and the logs are empty — the status follows the workflow's steps and the logs are filled in by this pass; the `blocked` halt comes at the end.
  - `[low]` `[patch]` (blind) app-permissions.md does not say the Maintainer must be assignable or that `XARABOT_LIVE_GITHUB_MAINTAINER` gates every live case — both notes added.
  - `[low]` `[reject]` (blind) The doc-sync and no-merge greps are loose — test-only; tightening adds parsing for unlikely mistakes.
  - `[low]` `[reject]` (edge) Enqueue race on a concurrent enqueue — grouped with the blind race row.
  - `[low]` `[reject]` (edge) Dequeue race on a PR leaving the queue — grouped with the blind race row.
  - `[low]` `[reject]` (edge) An uppercase `expectedHead` is a conflict — git and the ports produce lowercase SHAs.
  - `[low]` `[reject]` (edge) A non-integer `pr` gives a typeless GraphQL error (`transient`) — callers pass PR numbers from the forge; a guard adds a branch.
  - `[low]` `[reject]` (edge) A `maintainer` with whitespace or `@` — `alert` already refuses a blank one, and the config schema validates the login.
  - `[maybe-false]` `[defer]` (edge) GitHub drops the assignee on `POST /issues` — grouped with the assignee row; deferred.
  - `[low]` `[reject]` (edge) Two lanes alerting with no inbox create two issues — accepted in Design Notes; later reads take the lowest, at the cost of one duplicate comment.
  - `[low]` `[reject]` (edge) An inbox past 5000 comments makes alerts `transient` — at one digest a day this takes over a decade.
  - `[low]` `[patch]` (edge) A condition with `-->` or a marker — grouped with the blind sanitize row; fixed.
  - `[medium]` `[patch]` (edge) A non-bot comment holding the marker dedupes a real alert — grouped with the blind commenter row; fixed.
  - `[low]` `[reject]` (edge) An empty condition gives an empty reason — same as the blind empty-condition row.
  - `[low]` `[reject]` (edge) Same-name check run and status — same as the blind collision row.
  - `[medium]` `[patch]` (edge) The probe passes on `transient`/`auth`/`not-found` — grouped with the probe row; fixed.
  - `[low]` `[reject]` (edge) The probe can merge scratch commits into live `main` — same as the blind probe-merge row.
  - `[low]` `[reject]` (edge) The live `queue` control throws a TypeError when `repository` is null — test-only, and it fails the test loudly either way.
  - `[false]` `[reject]` (edge) Messages built in `malformed()`/`forgeErr()` skip `redacted()` — they hold API-supplied check names, states and SHAs, never the token, which only `request` sees.
  - `[false]` `[reject]` (intent) The AR38 live verification and the live contract pass are not done — not a defect in the diff: this session is barred from GitHub, and the run HALTs `blocked` on exactly this for the Maintainer.
  - `[false]` `[reject]` (intent) The live "checks … empty" case assumes no CI starts on the scratch push — the live `makeCommit` puts `[skip ci]` in every commit message, which stops Actions runs.

## Design Notes

- **Why the run blocks.** The AC asks for a live check first. This session is barred from GitHub, and the epic says the Maintainer handles Human Live Steps. So the code and probe ship, and the finding is left for the Maintainer: run `XARABOT_LIVE=1 bun test test/contracts/forge.github.contract.test.ts -t AR38` with the candidate permission granted, then without it. `FORBIDDEN` against `UNPROCESSABLE` tells a missing permission from a PR the queue refuses.
- **Dedupe on the forge, not in memory.** The marker lives in the inbox comments. Separate lane processes, and a lane that restarts, all see the same alerts. Two lanes racing can both post; the cost is one duplicate comment.
- **Pre-check in GraphQL.** One query gives `isInMergeQueue` and `headRefOid`, so idempotency does not depend on GitHub's wording for "already queued".

## Verification

**Commands:**
- `bun install` -- expected: exit 0, `bun.lock` unchanged.
- `bun test` -- expected: exit 0, live cases skipped.
- `bun --bun oxlint` -- expected: exit 0.
- `bun --bun tsc` -- expected: exit 0.

## Auto Run Result

Status: blocked

Blocking condition: AR38 is unverified. The Story's AC says to verify live, on the scratch repo, which App permission `enqueuePullRequest` needs, before anything else, and to record that finding. This session has no GitHub access by design (AGENTS.md; SPEC § Constraints, "Agents never touch GitHub"), so it could not run the live check. The adapter assumes `merge_queues: write` (`ENQUEUE_PERMISSION`, marked unverified). The Maintainer needs to:
- grant the App `issues: write` and the candidate permission, and set up the scratch repo's merge queue (the Story's Human Live Step);
- run `XARABOT_LIVE=1 bun test test/contracts/forge.github.contract.test.ts -t AR38`, with the permission and then without it, as `docs/maintainer/app-permissions.md` describes;
- record the finding in `ENQUEUE_PERMISSION` and the doc;
- run the live contract suite.

**Summary.** The GitHub forge adapter now implements the last four `Forge` operations:
- `checks` reads check runs plus commit statuses, and an empty list means pending.
- `enqueue` and `dequeue` use GraphQL, with a pre-read of `isInMergeQueue`/`headRefOid`. `enqueuePullRequest` carries `expectedHeadOid`.
- `alert` posts one comment with an @mention on the Maintainer's `xarabot-inbox` issue, creating and assigning the issue if it is missing. Repeats are deduplicated by a sha256 marker that counts only in bot comments, and the alert reads nothing from `main`, so it works while the lane fails closed.

There is still no merge, auto-merge or branch-delete path, and a test checks the source for one.

**Files changed:**
- `src/adapters/forge/github/github-forge.ts`: `checks`, `enqueue`, `dequeue`, `alert`, `mapGraphqlErrors`, `alertMarker`/`alertBody`/`sanitizeCondition`, and the `maintainer` option. The stubs are gone.
- `src/adapters/forge/github/http.ts`: new permissions, 8 operations and `ENQUEUE_PERMISSION`.
- `docs/maintainer/app-permissions.md`: new. The permission table, kept in sync by a test, and the AR38 procedure.
- `test/adapters/forge/github/fake-github.ts`: statuses, issues, GraphQL pull/enqueue/dequeue, the queue, and bot or user comment authors.
- `test/adapters/forge/github/{checks-queue,alert}.test.ts`: new unit tests. `github-forge.test.ts` (the no-merge grep) and `http.test.ts` (the doc sync) were updated.
- `test/contracts/forge.contract.ts`: a live-runnable case for empty checks. `forge.github.contract.test.ts` now offers every operation, plus the live `queue` control and the AR38 probe.

**Review findings:** 37 in total: 0 high, 6 medium, 23 low, 5 false, 3 maybe-false.
- **Patched:**
  - medium: the GraphQL redaction test, the probe assertion (`ok`/`conflict` only), and bot-only dedupe;
  - low: `<`/`>` removed from the condition, and three doc notes.
- **Deferred:** the assignee being silently dropped (medium, unverified).
- **Rejected:** everything else, with the reasons in the triage log.

**Follow-up review:** not recommended. The patched entries were 3 grouped medium entries: two are tests or test assertions, and the third (bot-only dedupe) is a one-line filter with a test. No unverified risk remains in them.

**Verification:** `bun install` (no changes), `bun test` (1276 pass, 59 skip, 0 fail; every live case skipped), `bun --bun oxlint` (exit 0) and `bun --bun tsc` (exit 0).

**Residual risks:**
- AR38 itself.
- None of the live code (harness, queue read, probe) has run.
- GitHub's GraphQL error types and its 422 for unknown SHAs are modelled, not observed.
- The deferred assignee behaviour.
