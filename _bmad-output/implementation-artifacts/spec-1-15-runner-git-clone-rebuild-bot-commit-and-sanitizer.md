---
title: 'Story 1.15: `runner.git`: clone rebuild, bot commit and sanitizer'
type: 'feature'
created: '2026-10-23'
baseline_revision: '4044723a38923f2050e23ba763d6e7b2b24379dd'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      No test makes rebuildClone fail after saveWip (pack, copy or read-tree step) to prove the marker stays absent and the earlier wip survives.
    evidence: |-
      Every rebuild in test/lane/clone.test.ts either succeeds or fails before saveWip; moving writeMarker ahead of the pack or read-tree step passes every test. Injecting a mid-rebuild failure needs a failing git shim on PATH, like the argv-shim test; worth adding with the lane loop (Story 1.16) that retries rebuilds.
    location: >-
      src/lane/clone.ts:rebuildClone
    severity: medium
---

<intent-contract>

## Intent

**Problem:** The runner has a hardened private `runner.git` (Story 1.9) but nothing builds the agent's clone from it, saves interrupted work, turns a finished session's working tree into one bot-authored commit on `origin/main`, or cleans agent text before it reaches GitHub. Without these, git config an agent plants could run as the runner, and trailers, closing keywords or @mentions could reach the forge (FR13, NFR10, AR10, AR16, AR19).

**Approach:** Add a lane-side clone module that rebuilds the clone, `.git` included, purely from `runner.git` objects, saves the working tree as `wip/<unit>` before every reset, and commits a session's change as a three-way merge onto `origin/main` as the bot — every git call through the existing hardened `runGit`. Add a pure core sanitizer for agent `summary`/`body` text and a pure bot-identity helper.

## Boundaries & Constraints

**Always:**
- Every git process goes through `runGit` (`src/adapters/forge/github/runner-git.ts`) with `--git-dir=<runner.git>`; the clone is only ever a `--work-tree` or a file destination. No git process is given the clone's `.git` as its git dir, and nothing reads the clone's `.git` (config, HEAD, refs, hooks).
- `runGit` gains optional `stdin` (string written to the child's stdin), `workTree` (emits `--work-tree=<path>` right after `--git-dir`) and `indexFile` (sets `GIT_INDEX_FILE`); existing callers unchanged.
- **Rebuild** `rebuildClone({gitDir, clone, unit, branch, sha, generation, resumeWip, signal})`:
  1. validates: `unit` a unit id, `sha` hex and a commit in `runner.git`, `branch` passes `check-ref-format refs/heads/<branch>`, `clone` absolute and neither inside nor containing `gitDir`;
  2. saves wip (below) when a clone marker exists, then removes the clone (unlocking read-only dirs first);
  3. writes a fresh `clone/.git` by hand: `HEAD` (`ref: refs/heads/<branch>`), `config` (`[core]` non-bare; `repositoryformatversion = 1` + `extensions.objectformat` for sha256), `refs/heads/<branch>` = `sha`, `refs/tags/`, `objects/info/`, and a pack of everything reachable from `sha` (`pack-objects --revs` into `clone/.git/objects/pack/pack`);
  4. writes the working tree and `clone/.git/index` with `read-tree --reset -u` (work tree = clone, index file = `clone/.git/index`); when `resumeWip` and a wip exists for `unit` whose recorded generation equals `generation` and whose parent is `sha`, the working tree comes from the wip tree and the index is then reset to `sha` (so the wip shows as uncommitted changes);
  5. records the session in `runner.git`: ref `refs/xarabot/clone` → a private commit (tree of `sha`, parent `sha`, message naming `unit`, `generation`, `branch`).
  Returns `{sha, branch, resumed}`.
- `sessionStartSha(kind, record)`: `build` → `base_sha`; `loopback` and `ci-fix` → `head_sha`; a null SHA is `err("invalid")`. Pure.
- **Working-tree snapshot** (shared by wip and commit): temp index file inside `gitDir`, seeded with `read-tree <start sha>` from the marker, then `add -A` with work tree = clone, then `write-tree`. The clone's own top-level `.git` is never read (git skips it).
- **Wip** `saveWip({gitDir, clone, signal})`: with no marker, returns `{saved: false}` (a clone the runner did not finish building is not a session's work). Otherwise commits the snapshot (parent = marker's start sha, message `wip <unit>` + `generation: <n>`), points `refs/wip/<unit with ":" as "__">` at it, then deletes the marker. Wip refs live outside `refs/heads/` and the bot commit never has a wip commit as an ancestor, so nothing pushes wip.
- **Commit** `commitSession({gitDir, clone, baseSha, ontoSha, bot, message, signal})`: needs the marker (else `err("no-session")`); snapshots the working tree; refuses a tree that adds or changes a gitlink (mode 160000) against `baseSha` (`err("invalid")` naming the path); makes a temp commit of the snapshot on `baseSha`; runs `merge-tree --write-tree -z --name-only --no-messages --merge-base=<baseSha> <ontoSha> <temp>`; exit 1 → `ok({kind:"conflict", paths})` (sorted, unique; nothing committed); a merged tree equal to `ontoSha`'s tree → `ok({kind:"empty"})`; else one `commit-tree` with parent `ontoSha`, author and committer = `bot`, message = `sanitizeAgentText(message)` on stdin, ref `refs/xarabot/head/<unit file id>` set to it → `ok({kind:"committed", base_sha: ontoSha, head_sha})`.
- `botIdentity(login, botUserId)` (core, pure): name `<login>-xarabot[bot]`, email `<botUserId>+<login>-xarabot[bot]@users.noreply.github.com`; refuses a non-login or a non-positive-integer id. `commitSession` refuses a `bot` not of that shape.
- **Sanitizer** `sanitizeAgentText(text)` (core, pure, total), over the whole text:
  - removes any line that is an attribution trailer anywhere (`Co-Authored-By`, `Signed-off-by`, `Acked-by`, `Reviewed-by`, `Tested-by`, `Reported-by`, `Suggested-by`, `Helped-by`, `Assisted-by`, `Generated-by`, `Cc`; case-insensitive) and any `Generated with …` marker line (optional leading 🤖);
  - removes a final trailer block: the last paragraph, when it is not the first paragraph and every line is `Token: value` (token `[A-Za-z0-9][A-Za-z0-9-]*`) or a whitespace-led continuation;
  - removes each closing keyword with its reference (`close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved`, case-insensitive, optional `:`, then `#12`, `owner/repo#12`, `GH-12` or an `http(s)` URL ending `/issues/<n>` or `/pull/<n>`), plus one space before it; a line left blank by a removal is dropped;
  - neutralizes each @mention (`@` not preceded by a word character, followed by a GitHub login, optionally `/team`) by dropping the `@`, as AGENTS.md itself does ("drop the `@`");
  - text with none of these comes back byte-identical; trailing blank lines are trimmed only when something was removed.
- Error kinds for the clone module: `invalid`, `missing-object`, `no-session`, `git` (a git command failed; message carries its stderr), `transient` (deadline). Returns `Result`, never throws.

**Never:** No fetch, push, PR or forge call (Stories 1.16, 1.16a; this Story needs the SHAs already in `runner.git`). No conflict resolution (Story 1.17). No lane loop, claim or journal. No git run against the clone's `.git`, and no `git clone`/`fetch` from `runner.git` into the clone (`protocol.file.allow=never` stays). No `Co-Authored-By` or similar in any commit. No new runtime dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First build | no clone, `sha` = base | clone on `story/1.15` at `sha`, `git status` clean, full history | none |
| Loopback | existing clone with edits, `sha` = head | wip saved first, then clone at head | none |
| Resume | wip at generation 3, parent `sha`, `resumeWip`, generation 3 | working tree = wip, HEAD = `sha`, `resumed: true` | generation 4 or other parent → fresh, `resumed: false` |
| Missing object | `sha` not in `runner.git` | — | `err("missing-object")`, clone untouched |
| Planted git | clone `.git` hooks, fsmonitor, filters, `includeIf`, `.gitattributes` drivers | rebuild/wip/commit succeed, no planted program runs | none |
| Clean commit | change to `a`, main changed `b` | one commit on `ontoSha`, bot author/committer, tree has both | none |
| Conflict | same lines changed on both sides | `{kind:"conflict", paths:["b"]}`, no commit | none |
| No change | worktree equals base | `{kind:"empty"}` | none |
| Embedded repo | `sub/.git` planted in the worktree | — | commit `err("invalid")` naming `sub` |
| Sanitizer | `Done.\n\nCo-Authored-By: X <x@y>` / `fixes #12` / `@octocat` / `a@b.com` | `Done.` / removed / `octocat` / unchanged | none |

</intent-contract>

## Code Map

- `src/adapters/forge/github/runner-git.ts` -- `runGit`, `runnerGitArgs`, `runnerGitEnv`, `RUNNER_GIT_CONFIG`, `openRunnerGit`; add `stdin`/`workTree`/`indexFile` options. Only spawn point for git.
- `src/adapters/forge/github/github-forge.ts:476` -- existing `runGit` caller (`git()` helper, `pushBranch`); must keep working.
- `src/sandbox/vendor-home.ts:85` -- `removeTree` (unlock + rm), reuse for the clone (lane may import sandbox).
- `src/core/schemas/ledger.ts:28-52` -- `isUnitId`, `unitFileName` (`:` → `__`); reuse for ref names.
- `src/core/schemas/common.ts:12` -- `GitHubLogin` regex for `botIdentity`.
- `src/core/result.ts` -- `Result`, `ok`, `err`.
- `src/ports/forge.ts` -- `ForgeResult`, `GitSha` (map `runGit` failures to the module's kinds).
- `test/adapters/forge/github/runner-git.test.ts` -- style: temp dirs, `plainGit`, `IDENTITY`; extend for new options.
- `test/support/boundaries.ts` -- layer table: `lane` may import `adapters`, `sandbox`, `core`; core stays pure.

## Tasks & Acceptance

**Execution:**
- `src/adapters/forge/github/runner-git.ts` -- add `stdin`, `workTree`, `indexFile` to `RunGitOpts` -- clone plumbing needs them under the same hardening.
- `src/core/sanitize.ts` -- `sanitizeAgentText` -- AR16 pure sanitizer.
- `src/core/bot-identity.ts` -- `botIdentity`, `isBotIdentity` -- FR13 authorship.
- `src/lane/clone.ts` -- `rebuildClone`, `saveWip`, `readWip`, `sessionStartSha`, shared snapshot -- AR10/AR16 rebuild and wip.
- `src/lane/commit.ts` -- `commitSession` -- AR16 three-way bot commit.
- `test/core/sanitize.test.ts`, `test/core/bot-identity.test.ts` -- case tables, including unchanged-text rows.
- `test/lane/clone.test.ts`, `test/lane/commit.test.ts` -- matrix rows against real git in temp dirs; planted-config negative tests with sentinel files; an argv check that every spawn's `--git-dir` is `runner.git` (wrap via a recorded `runGit` run or inspect with a `PATH` shim `git` that logs argv then execs the real git).
- `test/adapters/forge/github/runner-git.test.ts` -- cases for the new options.

**Acceptance Criteria:**
- Given a clone whose `.git` has a hook, `core.fsmonitor`, a `filter`/`diff`/`merge` driver, `includeIf` config and a worktree `.gitattributes` naming those drivers, each pointing at a script that writes a sentinel file, when the runner rebuilds, snapshots wip and commits, then no sentinel file exists.
- Given a `git` shim on `PATH` that logs every invocation, when rebuild, wip and commit run, then every logged invocation's first argument is `--git-dir=<runner.git>` and none names the clone's `.git`.
- Given a committed session, when the commit is read in `runner.git`, then it has exactly one parent (`ontoSha`), author and committer are the bot, the message has no trailer, and the wip commit is not its ancestor.
- Given `bun test`, `bun --bun oxlint` and `bun --bun tsc`, when they run, then each exits 0 and the boundaries test passes.

## Spec Change Log

## Review Triage Log

### 2026-10-23 — Review pass
- verdicts: 35 findings — high 0, medium 8, low 19, false 6, maybe-false 2
- findings:
  - `[medium]` `[patch]` (verification-gap) no loopback-shaped commit test (clone at head, change against an earlier `baseSha`, onto newer main) — added; the committed tree carries the first change, the loopback edit and main's change.
  - `[medium]` `[defer]` (verification-gap) no test fails a rebuild after `saveWip` to prove the marker stays absent — needs a failing-git shim; deferred to Story 1.16's retrying lane loop.
  - `[low]` `[patch]` (verification-gap) the empty-after-sanitizing refusal is untested — test added, asserting no `refs/xarabot/head/` ref.
  - `[false]` `[reject]` (intent) start SHA chosen by a helper, not wired to a session — the lane process (Story 1.16) runs sessions; `sessionStartSha` plus `rebuildClone` supply the means, as the Story's "Given a session about to start" requires of this module.
  - `[false]` `[reject]` (intent) the claim is not consulted for wip resume — claims are Story 1.16's; `rebuildClone` enforces the same-generation rule from the generation the lane holds.
  - `[low]` `[reject]` (intent) no fetch resolves `origin/main` — the Story names no fetch; `ontoSha` must already be in `runner.git`; the fetch belongs with Story 1.16a's "freshly fetched main".
  - `[false]` `[reject]` (intent) `summary`/`body` are not wired through the sanitizer — Story 1.16a writes the PR text; this Story supplies the pure sanitizer, tested directly.
  - `[medium]` `[patch]` (edge) `@@alice` → `@alice` survives as a live mention — grouped as one root cause (single-pass sanitizing); removals now repeat until stable and mentions match `@+`.
  - `[medium]` `[patch]` (edge) `fixes fixes #1 #2` → `fixes #2` — same group; same fix.
  - `[medium]` `[patch]` (edge) `fixes @owner/repo#1` → live cross-repo keyword — same group; same fix.
  - `[low]` `[patch]` (edge) markdown-prefixed "Generated with" lines kept — the marker now allows a leading `[\s>*_#-]` run.
  - `[medium]` `[patch]` (edge) a clean clone's snapshot overwrites the real wip — `saveWip` skips the save when the tree equals `start`'s tree.
  - `[low]` `[reject]` (edge) a rebuild with a different clone path drops the marker unsaved — the lane has one fixed clone path per lane; guarding a caller bug adds state.
  - `[low]` `[reject]` (edge) a symlink can hide an overlap of clone and runner.git — paths come from the fixed lane layout; a realpath walk adds a branch for an input the runner never builds.
  - `[low]` `[reject]` (edge) `removeTree` deletes any absolute folder passed as clone — same: the caller passes the lane's own `clone/`.
  - `[medium]` `[patch]` (edge) a `baseSha` unrelated to the session's start folds foreign history into the change — `commitSession` now requires `merge-base --is-ancestor <baseSha> <start>`.
  - `[maybe-false]` `[reject]` (edge) `merge-tree` exit 1 with no names gives empty conflict paths — git lists every conflicted path with `--name-only`; settling it needs a case where it doesn't; if true, only low.
  - `[low]` `[patch]` (edge) exported `snapshotTree` uses relative paths unresolved — now resolves both.
  - `[low]` `[patch]` (edge) `readWip` accepts generation ≤ 0 — now requires ≥ 1 and a hex parent.
  - `[false]` `[reject]` (edge) trailer lines in the first paragraph survive — git itself never treats the first paragraph as trailers, so `%(trailers)` finds none; the attribution list still removes known ones anywhere.
  - `[medium]` `[patch]` (blind) an agent-left mode-000 file or folder makes every later rebuild fail — a private walk gives files u+r and folders u+rwx before each snapshot; tested.
  - `[low]` `[reject]` (blind) `saveWip` always overwrites — same root as the clean-snapshot row; covered by that patch.
  - `[false]` `[reject]` (blind) `commitSession` never checks `baseSha` against `start` — a loopback legitimately differs (`baseSha` is the head's parent); the new ancestor check covers the real defect.
  - `[low]` `[reject]` (blind) `@` stripped inside code spans and URLs — the spec strips everywhere on purpose: commit messages have no code spans, and closing keywords in commits act regardless; cosmetic.
  - `[low]` `[patch]` (blind) `Token:value` trailers missed — the final-block test now takes optional whitespace around `:` (a bare `https://` line is not one).
  - `[low]` `[patch]` (blind) a closing phrase at line start leaves a leading space — it now takes the space after it.
  - `[low]` `[patch]` (blind) the `Bun.spawn` scan omits `src/lane/` — a scan of `src/lane/` added.
  - `[low]` `[reject]` (blind) no minimum git version — the host's git is 2.54; a failure surfaces as `err("git")` with git's usage message.
  - `[low]` `[patch]` (blind) the hand-written clone config drops `core.ignorecase`/`core.precomposeunicode` — copied from `runner.git`, plus `filemode` and `logallrefupdates`.
  - `[low]` `[patch]` (blind) the invalid-inputs test starts with no clone — it now starts from a clone with edits, a marker and a wip and checks all are unchanged.
  - `[low]` `[reject]` (blind) filesystem failures reported as `git` — the message names the fs error; a new kind adds surface no caller distinguishes yet.
  - `[low]` `[reject]` (blind) `runGit`'s `Subprocess` cast hides the stdin type — Bun writes a `Uint8Array` stdin fully; the cast only names the pipes read.
  - `[false]` `[reject]` (blind) `commitSession` accepts another owner's bot — the lane passes its own owner's `botIdentity`; the shape check is the spec's guard.
  - `[maybe-false]` `[reject]` (blind) an unparseable marker silently loses work — only the runner writes the marker; settling it needs a path that writes a malformed one; if true, low.
  - `[low]` `[reject]` (blind) a long message over 64 KiB on stdin untested — Bun streams the buffer; a commit message that size is not met in use.

## Design Notes

The clone's `.git` is assembled from files the runner writes plus a pack made in `runner.git`, because AR16 forbids running git against the clone's `.git` and `protocol.file.allow=never` rules out a local clone. The marker ref `refs/xarabot/clone` is the runner's own memory of what the clone was built from (unit, generation, start SHA); it is deleted after the wip is saved and written only after a rebuild completes, so a half-built clone is never saved over a good wip.

Seeding the snapshot index from the start SHA keeps files that are tracked but match `.gitignore` tracked, as a normal commit would. A conflict is returned, never resolved; base_sha in the result is `ontoSha` — the commit's parent, which a later loopback diffs against.

## Verification

**Commands:**
- `bun test` -- expected: exit 0
- `bun --bun oxlint` -- expected: exit 0
- `bun --bun tsc` -- expected: exit 0

## Auto Run Result

Status: done

**Summary:** The runner now rebuilds the agent's clone, `.git` included, only from `runner.git`. It saves the clone's working tree as a wip before every reset, and turns a finished session into one bot-authored commit three-way merged onto `origin/main`. Every git process goes through the hardened `runGit` with `--git-dir=<runner.git>`. The clone's `.git` is written by hand plus a pack made in `runner.git`, so nothing an agent plants there runs. A pure sanitizer strips trailers, "Generated with" markers and closing keywords from agent text, and drops the `@` from mentions.

**Files changed:**
- `src/adapters/forge/github/runner-git.ts`: `runGit` takes `stdin`, `workTree` and `indexFile`.
- `src/lane/clone.ts`: `rebuildClone`, `saveWip`, `readWip`, `readMarker`, `sessionStartSha`, the working-tree snapshot, and the `refs/xarabot/clone` marker.
- `src/lane/commit.ts`: `commitSession` (the gitlink refusal, the base-ancestry check, `merge-tree` committed/conflict/empty, the bot commit with a sanitized message).
- `src/core/sanitize.ts`: `sanitizeAgentText`.
- `src/core/bot-identity.ts`: `botIdentity`, `isBotIdentity`.
- Tests: `test/lane/clone.test.ts`, `test/lane/commit.test.ts`, `test/lane/git-fixture.ts`, `test/core/sanitize.test.ts`, `test/core/bot-identity.test.ts` (all new), plus new cases in `test/adapters/forge/github/runner-git.test.ts`.

**Review findings:** 35 findings: 0 high, 8 medium, 19 low, 6 false, 2 maybe-false.
- **Patched (17 rows, 5 medium entries):**
  - The sanitizer runs to a fixpoint, which closes the `@@`, nested-keyword and keyword-before-mention bypasses.
  - A clean snapshot no longer overwrites a wip.
  - Unreadable files that a session left are unlocked before the snapshot.
  - `baseSha` must be an ancestor of the session's start.
  - A loopback-shaped commit test was added.
  - Low patches: "Generated with" lines with a markdown prefix; `Token:value` trailers; the space left at a line start; `readWip` checks; resolved paths; the clone config's `ignorecase`/`precomposeunicode`; stronger invalid-input and empty-message tests; a `Bun.spawn` scan of `src/lane/`.
- **Deferred (1):** no test makes a rebuild fail after `saveWip`.
- **Rejected:** 11 low, 6 false and 2 maybe-false. Each reason is in the Review Triage Log.

**Follow-up review recommended:** true. Five medium entries were patched. The named unverified risk: the patched sanitizer's fixpoint loop and its new regexes (line-start closing phrase, `@+`, the URL exclusion in `TRAILER`) and the unlock walk before snapshots were not reviewed again. A rebuild that fails after `saveWip` is also still untested.

**Verification:**
- `bun test`: 1937 pass, 61 skip, 0 fail.
- `bun --bun oxlint` and `bun --bun tsc` exit 0.
- The planted-config test and the `git` PATH-shim test pass.
- Every row in the I/O matrix has a test that runs.

**Residual risks:**
- No fetch exists yet. `baseSha`, `ontoSha` and the start SHA must already be in `runner.git`, and Story 1.16/1.16a must fetch them.
- A shallow `runner.git` would give a broken clone, because the `shallow` file is not copied.
- The sanitizer drops `@` inside code spans and URLs too, by design.
- The bot's email needs the bot account's numeric user id, which the caller supplies.
