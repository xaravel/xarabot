# Xarabot GitHub App permissions

Each owner's bot App (`<login>-xarabot`) asks for exactly these repository
permissions, and nothing else: never `workflows`, `administration` or any
bypass right. The table is checked against `APP_PERMISSIONS` and the
operation table in `src/adapters/forge/github/http.ts` by
`test/adapters/forge/github/http.test.ts`.

| Permission | Operations that use it |
|---|---|
| `contents: write` | `getRef`, `getCommit`, `getTree`, `getBlob`, `createBlob`, `createTree`, `createCommit`, `createRef`, `updateRef`, `git push` of unit branches, `enqueuePullRequest`, `dequeuePullRequest` |
| `pull_requests: write` | `getPull`, `listPulls`, `createPull`, `updatePull`, `createComment`, `pullQueueState` |
| `issues: write` | `listIssues`, `createIssue`, `listIssueComments`, `createIssueComment` (the Maintainer's `xarabot-inbox` alerts) |
| `checks: read` | `listCheckRuns` |
| `statuses: read` | `getCombinedStatus` |
| `actions: read` | `getJobLogs` |
| `metadata: read` | none directly; GitHub grants it to every App |

## AR38: merge-queue permission (verified live, 2026-10-23)

`enqueue` and `dequeue` need no permission of their own. The GraphQL
`enqueuePullRequest` and `dequeuePullRequest` mutations run with the
permissions above, so they are listed under `contents: write`. The App never
needs a bypass right or an admin merge to land a PR through the merge queue.
