# GitHub App permissions

The GitHub forge adapter (`src/adapters/forge/github/`) names one credential for every call it makes, in `GITHUB_OPERATIONS` (`http.ts`). Grant the owner's bot App exactly the repository permissions below. A test (`test/adapters/forge/github/http.test.ts`) keeps this table and `GITHUB_OPERATIONS` in sync: every permission an operation uses has a row naming its operations, and every row is used.

| Permission | Operations | Why |
|---|---|---|
| `app-jwt` | `getInstallation`, `createAccessToken` | Not a repository permission: the App's own JWT finds the installation and mints 1-hour installation tokens. |
| `contents: write` | `getRef`, `getCommit`, `getTree`, `getBlob`, `createBlob`, `createTree`, `createCommit`, `createRef`, `updateRef` | Reads `main` and reads and fast-forwards the ledger branch `xarabot/claims`; `pushBranch` pushes unit branches with the same permission. |
| `pull_requests: write` | `getPull`, `listPulls`, `createPull`, `updatePull`, `createComment`, `readPullGraph` | Opens, updates, closes, lists and comments on the unit's PR; reads a PR's node id, head and merge-queue state over GraphQL. |
| `checks: read` | `listCheckRuns` | Reads CI check runs for `checks` and the CI-log prefetch. |
| `statuses: read` | `listStatuses` | Reads commit statuses for `checks`. |
| `actions: read` | `getJobLogs` | Fetches a failing Actions job's log for the prefetch. |
| `merge_queues: write` | `enqueuePullRequest`, `dequeuePullRequest` | Adds a PR to, and removes it from, the merge queue. **Unverified, see AR38 below.** |
| `issues: write` | `listIssues`, `createIssue`, `listIssueComments`, `createIssueComment` | Finds or creates the Maintainer's `xarabot-inbox` issue and posts one deduplicated alert comment on it. |
| `none` | `downloadLog` | No credential: a signed log download URL. |

GitHub also grants every App `metadata: read`; no operation names it. The adapter has no merge, admin-merge, auto-merge or branch-delete operation, so the App needs no permission for any of them.

## AR38: the merge-queue permission

**Status: unverified.** GitHub's docs do not say which App permission the GraphQL mutations `enqueuePullRequest` and `dequeuePullRequest` need. The adapter assumes `merge_queues: write` (`ENQUEUE_PERMISSION` in `http.ts`). The Story 1.10 session had no GitHub access, so no live run has confirmed it. A missing permission makes `enqueue` return `forbidden`, and its message names `merge_queues: write` and AR38.

The probe is a live test. It opens a scratch PR in the live test repo, calls `enqueue`, logs the installation's granted `permissions` and the result, and fails if the result is `forbidden`:

```sh
export XARABOT_LIVE_GITHUB_REPO=<owner>/<repo>
export XARABOT_LIVE_GITHUB_LOGIN=<owner>
export XARABOT_LIVE_GITHUB_MAINTAINER=<maintainer-login>
XARABOT_LIVE=1 bun test test/contracts/forge.github.contract.test.ts -t AR38
```

The live test repo needs a merge queue on `main` (a ruleset with "Require merge queue"). `XARABOT_LIVE_GITHUB_MAINTAINER` must be set for any live forge case to run, not only the probe; and the Maintainer login must be assignable in the repo, or `alert` cannot create the inbox issue.

The `readPullGraph` read of `isInMergeQueue` (and the live `queue` control's `mergeQueue` read) is assumed to need only `pull_requests: write`. If the probe's `forbidden` names `readPullGraph` rather than `enqueuePullRequest`, that read needs the merge-queue permission too.

Steps that settle it:

1. Grant the App `merge_queues: write` (plus the rows above), accept the new permissions on the installation, and run the probe. It should pass: the result is `ok`, or `conflict` when the queue refuses the PR (`UNPROCESSABLE`, for example a failing required check). Either means the permission is enough.
2. Remove `merge_queues: write`, accept the change, and run the probe again. It should fail with `forbidden` (`FORBIDDEN` / "Resource not accessible by integration"). If it still passes, another permission (likely `contents: write` or `pull_requests: write`) already covers the mutation; record which one.
3. Record the finding: update `ENQUEUE_PERMISSION` and this section (drop "unverified"), and restore the permission the App needs.
