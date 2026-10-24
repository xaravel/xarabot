---
title: 'Story 2.3: The 0.x write check'
type: 'feature'
created: '2026-10-24'
baseline_revision: '767a31f475c89d01c593214bbd56bad50d16ebd3'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The runner squashes whatever a builder session wrote onto `main`. So an agent can change `sprint-status.yaml`, `retro-gates.yaml`, `epics.md`, manifests, `.xarabot/**`, the Standing Authority file, `.github/**` or agent config, and widen its own authority, before v1's diff check exists (FR18, NFR20, AR31, AD-30).

**Approach:** A pure write check in `src/core` classifies each path the session changed. The git committer computes the session's own change from `runner.git` objects (AR19): the snapshot tree against `baseSha`. It reverts any Epic context file change, then runs the check before the squash. A refusal is a new commit outcome. The PR step logs it with each path and reason, and parks the unit `blocked` `write-check`.

## Boundaries & Constraints

**Always:**
- **Refused path classes.** Every comparison is case-folded, because the clone is on a case-insensitive macOS filesystem.
  - `coordinator-file`: `sprint_status_path`, `retro_gates_path` and `epics_path`.
  - `xarabot`: `.xarabot/**`.
  - `manifest`: a `.md` file directly inside `manifests.dir`, the rule `loadManifests` uses. There are no manifests when `manifests` is unset.
  - `standing-authority`: `standing_authority_path`.
  - `github`: `.github/**`.
  - `agent-config`: the mandatory agent config globs (`**/.agents/**`, `**/.claude/**`, `**/.codex/**`, `**/.pi/**`, `**/.mcp.json`, `**/AGENTS.md`, `**/CLAUDE.md`).
  - `protected-path`: the policy's `protected_paths`.
- **What counts as a change.** Added, modified, deleted and type-changed paths all count. A rename counts as a delete plus an add (`--no-renames`). When a path is in several classes, the first class in the order above is reported.
- **Exceptions.** Each one is checked exactly as stated, and no other path is excepted:
  - The unit's spec file: the single `story_spec_path` match, `PrStepInput.specPath`, exact path.
  - The `status:` line of the unit's own manifest (`NextStory.manifest_path`, exact path). The file must exist on both sides with mode `100644`. Each side may have at most one top-level `status:` line inside its leading `---` frontmatter. With those lines removed, both texts must be identical.
  - An approved Infrastructure Story. It covers `standing-authority`, `github`, `agent-config` and `protected-path` only, never `coordinator-file`, `xarabot` or `manifest`. Approval needs all three of these on the PR step's fresh snapshot: `story.infrastructure`, `record.approval.manifest_sha` = `story.manifest_sha`, and the manifest's blob SHA on fresh `main` = `story.manifest_sha`.
- **Epic context.** A changed path that matches `epic_context_path` with `<N>` as a positive integer is reverted to `baseSha`'s version before the check: restored if it existed there, removed if it was added. The reverted paths are reported and logged.
- **Where it runs.** The check runs on every agent session commit, build and CI fix alike. It runs before the merge-tree and before any push or ledger edit. It sees only the session's change, `merge-base(start, onto)` → snapshot, so `main`'s own changes never trip it.
- **Logging a refusal.** One unit-log note per refused path, as `write-check: refused <path> (<class>)`. The journal reason lists every refused path. The unit parks `blocked` `write-check`, the run ends `progress`, and nothing is pushed.

**Never:**
- No check on runner-written content: the merger's merges, regenerated lockfiles, and ledger and forge writes.
- No coordinator diff rules (Story 2.4), no retro-record parsing (a builder may not touch `retro-gates.yaml` at all), and no v1 glob-scope check.
- No ledger schema change and no new forge operation. Do not change `.github/`, `AGENTS.md`, `_bmad/`, the specs folder or the skills.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ordinary change | session edits `src/a.ts` | committed | none |
| Agent config, nested | session adds `pkg/.claude/settings.json` and edits `CLAUDE.md` | `refused`: both paths `agent-config`; nothing committed | PR step parks `write-check` |
| Retro verdict | session changes a verdict in `retro-gates.yaml` | `refused` `coordinator-file` | park |
| Case-folded | session adds `.GitHub/workflows/x.yml` | `refused` `github` | park |
| Own spec | session edits `spec-2-3-x.md` (the `specPath`) | committed | none |
| Own manifest status | only the frontmatter `status:` line of `stories/2.3.md` changes | committed | none |
| Own manifest, other edit | the `globs` line changes, or another Story's manifest changes | `refused` `manifest` | park |
| Infrastructure approved | `.github/workflows/ci.yml` changes; approval matches | committed | none |
| Infrastructure, `.xarabot` | `.xarabot/policy.yaml` changes; approval matches | `refused` `xarabot` | park |
| Infrastructure, stale approval | the manifest changed on `main` since the approval | `.github/**` change `refused` | park |
| Epic context | session edits `epic-2-context.md` and `src/a.ts` | committed without the context change; `reverted: [path]` noted in the log | none |
| Only Epic context | session only edits `epic-2-context.md` | `empty`; parks `no-op` as today | none |
| Main moved | `main` changed `.github/**` and `sprint-status.yaml` after the session started | committed; the merged tree carries `main`'s changes | none |

</intent-contract>

## Code Map

- `src/lane/commit.ts` -- `commitSession`: `snapshotTree` → `gitlinks` (parses `diff-tree -r -z --no-renames --raw base tree`; meta `[":oldmode", newmode, oldsha, newsha, status]`) → `commit-tree` temp → `merge-tree` → `empty`/`conflict`/`committed`. The write check and the revert go between the gitlink check and the temp commit. Reuse one raw-diff parse for both.
- `src/lane/clone.ts` -- `git`/`gitRun` (`GitOpts` has `indexFile`, `stdin`, `workTree`), `snapshotTree` (temp index under `mkdtempSync(join(gitDir, "xarabot-snapshot-"))`, removed in `finally`) is the model for the revert's temp index (`read-tree`, `update-index -z --index-info`, `write-tree`).
- `src/lane/committer.ts` -- `CommitRequest`/`createGitCommitter`: passes the request through to `commitSession`; gets the rules field.
- `src/lane/pr-step.ts` -- `steps()`: 1 snapshot, 2 commit, 3 `loadRepoConfig` (Standing Authority). Move the config load before the commit (same `stop` handling) so the rules come from the same fresh `main`. Handle `refused` like the `empty` → `park` branch (~line 222).
- `src/core/config/protected-paths.ts` -- `MANDATORY_PROTECTED_PATHS`; split out the agent config globs as an exported list, keeping the mandatory list's order.
- `src/core/lane/build-check.ts` -- `specMatches` (`Bun.Glob`) is the matching precedent. `src/core/manifests/parse-manifest.ts` `loadManifests` (~line 113) is the manifest rule. `src/core/next/snapshot.ts` `epicContextPath`.
- `src/core/next/next.ts` -- `NextStory` has `manifest_path`, `manifest_sha` and `infrastructure`. The claim-time approval check is at ~line 270.
- `src/core/schemas/ledger.ts` -- `write-check` is already a `ParkReason`; `approval.manifest_sha`.
- Tests: `test/lane/commit.test.ts` and `test/lane/committer.test.ts` (with `git-fixture.ts`: `setup`, `commit(gitDir, files, parents)` with nested paths, `files`, `rebuildClone`), and `test/lane/pr-step.test.ts` (`world({commit})` stub committer, `endToEnd` lane + PR step with journal). Core tables live in `test/core/lane/*.test.ts`.
- Baseline sandbox: about 73 tests fail in a sandboxed session (loopback listen, `ps`/`kill`). Compare failures by name with the baseline.

## Tasks & Acceptance

**Execution:**
- `src/core/config/protected-paths.ts` -- export `AGENT_CONFIG_PATHS`; build `MANDATORY_PROTECTED_PATHS` from it in the same order.
- `src/core/lane/write-check.ts` (new) -- pure. Export:
  - `WriteRules` and `writeRules({ config, policy, specPath, storyFile, infrastructureApproved })`;
  - `epicContextMatch(pattern, path)`;
  - `statusLineOnly(before, after)`;
  - `checkWrite(rules, changes)`, which returns the refusals `{ path, class }`, in path order. Each change is `{ path, storyFile?: { before, after } }`, and the texts are given only for the own manifest when it is a regular file on both sides.
- `src/lane/commit.ts` -- `CommitParams.rules` is required. After the gitlink check, revert Epic context changes into a new tree. Diff that tree against `baseSha`, and read the own manifest's two blobs when needed. Run `checkWrite`, and return `{ kind: "refused", refusals, reverted }` before any temp commit. Squash the reverted tree. `committed` and `empty` gain an optional `reverted` list.
- `src/lane/committer.ts` -- `CommitRequest.rules`, passed through.
- `src/lane/pr-step.ts` -- load the config before the commit. Build the rules from it, with `input.specPath`, `story.manifest_path` and the fresh-snapshot approval check. On `refused`: note each path, add the reason, park `blocked` `write-check`, and end `progress`. Note the `reverted` paths. Update the header comment.
- `test/core/lane/write-check.test.ts` (new) -- a case table keyed by adapter, `Partial<Record<AdapterName, Case[]>>`, filled for `claude`. It holds every refused class, with nested and case-folded paths, `retro-gates.yaml` verdict/item/go rows, and adds, deletes and modifies. It holds every exception and each one's limits: another Story's manifest, a non-status edit, two status lines, Infrastructure on `xarabot`/`manifest`/`coordinator-file`. Add a coverage test: each listed adapter has a case for every class and every exception. Unit-test `statusLineOnly` and `epicContextMatch`.
- `test/lane/commit.test.ts`, `test/lane/committer.test.ts` -- real git cases: refused (nested agent config plus `.github`, nothing written to `headRef`), the own spec and the own manifest status line committed, the Epic context revert (with the revert alone → `empty`), Infrastructure approved, and `main` moved with protected changes → committed. Existing calls pass permissive rules.
- `test/lane/pr-step.test.ts` -- with a `refused` stub outcome: the record is `parked` `blocked` `write-check`, there is no push and no PR, and the log and reason name each path. The commit request carries the rules: Infrastructure approval true/false from the fresh snapshot, `specPath` and `storyFile`. An `endToEnd` journal case.

**Acceptance Criteria:**
- Given a builder session that edits `src/a.ts`, adds `.claude/settings.json` and changes `sprint-status.yaml`, when the lane's PR step commits, then nothing is committed or pushed, the record is `parked` `blocked` with `park.reason: write-check`, and the unit log and journal reason name `.claude/settings.json` (`agent-config`) and the sprint status path (`coordinator-file`).
- Given a session that edits its own spec file, the `status:` line of its own manifest and `src/a.ts`, when the git committer squashes, then the commit holds all three changes.
- Given a session that edits `epic-2-context.md` and `src/a.ts`, when the git committer squashes, then the commit's `epic-2-context.md` equals `main`'s, and `reverted` lists the path.
- Given `main` changed `.github/workflows/ci.yml` and `retro-gates.yaml` after the session's start, when the git committer squashes a session that edited only `src/a.ts`, then it commits, and the commit carries `main`'s versions of both files.
- Given `bun test`, when it runs, then it shows no failure outside the baseline's sandbox-only set.

## Spec Change Log

## Review Triage Log

### 2026-10-24 — Review pass
- verdicts: 28 findings — high 0, medium 4, low 20, false 4, maybe-false 0
- findings:
  - `[low]` `[reject]` (intent-alignment a) AC 4 read literally as a field-level retro verdict/item/go rule for every agent diff; the diff refuses `retro-gates.yaml` by path only, and Story 2.4's ACs don't pick up the field-level rule. — Every agent diff today is a builder diff, which can't touch the file at all, so no session can change a verdict. The field-level rule is only observable once coordinator sessions write `retro-gates.yaml`, and it needs a decision on what counts as an item change. Recorded as a residual risk for Story 2.4.
  - `[false]` `[reject]` (intent-alignment b) The case table is keyed by adapter, but the adapter never reaches `checkWrite`. — CAP-18 makes the guard "the same for every adapter", and the AC asks only that the table be keyed so Epic 3 adds rows per adapter. No wrong outcome follows.
  - `[low]` `[reject]` (intent-alignment c) No single test goes from a real git session edit, through the real committer, to a parked record. — Each half is tested at its own surface, joined by the typed `CommitOutcome` contract. The fake forge's SHAs aren't git objects, so joining them needs a new harness.
  - `[low]` `[reject]` (intent-alignment d) The Infrastructure approval decision and the real-git Infrastructure commit are tested separately. — The same contract split as c; `rules.infrastructureApproved` is the whole interface between them.
  - `[low]` `[patch]` (intent-alignment e) No refusal is tested on a CI-fix (`kind: "fix"`) PR step. — Same root as blind 7; fixed there.
  - `[false]` `[reject]` (intent-alignment f) Additions beyond the Story text (case-folding, ordering, mode rule, rename split, `reverted`, log quoting, config load moved). — Each one is a stated spec rule and narrows behaviour toward fail-closed; no defect is named.
  - `[false]` `[reject]` (intent-alignment g) The "own Story file" reading. — The diff implements the manifest reading, the only one that adds anything (Design Notes); the rival readings are already excepted or forbidden by NFR20.
  - `[false]` `[reject]` (intent-alignment h) No claim-glob scope check. — FR18 puts it in v1's diff check; nothing is missing for 0.x.
  - `[low]` `[patch]` (verification-gap) The PR step's `reverted` note on a `committed` outcome is untested. — Pre-verified gap. Added a PR-step test: a committed stub with `reverted`, then the note is logged and the push and PR still happen.
  - `[low]` `[patch]` (verification-gap) The `refused` branch's lost-park handling is untested. — Pre-verified gap. Added a PR-step test: the generation is bumped before the park, then the step ends `failed`, `state: null`, with no write and no push.
  - `[medium]` `[patch]` (blind 1) A bare `.claude`/`.agents`/`.codex`/`.pi` entry at any depth, or `.github`/`.xarabot`, is not refused, so a symlink can bring in agent config. — Confirmed: `checkWrite` returned [] for `.claude`, `pkg/.agents` and `.github`. `classify` now refuses those bare names, with core rows and a real-git `.claude` symlink case.
  - `[medium]` `[patch]` (blind 2) The own-manifest status exception accepts any status value, including an unclosed quote that breaks the manifest YAML. — `statusLineOnly` now also requires both frontmatters to parse and be deep-equal without `status`, and a string `status`; table rows added.
  - `[low]` `[reject]` (blind 3) The spec-file exception covers every class, so a config whose `story_spec_path` matches the manifest would except the whole manifest. — Not reachable with any current config: `.xarabot/config.yaml` puts spec files under `implementation-artifacts` and manifests in `stories/`, the config is Maintainer-owned, and every PR needs the Maintainer's approval. Narrowing the exception changes the intent contract. Recorded as a residual risk for consumer adoption.
  - `[low]` `[patch]` (blind 4) The check runs on the original diff filtered by name, not on the reverted tree that is squashed; a context file replaced by a directory loses that directory's files from the squash unchecked. — The check now re-diffs the squashed tree against `baseSha`; a real-git case was added.
  - `[low]` `[reject]` (blind 5) A directory named like an Epic context file (`epic-3-context.md/notes`) is neither reverted nor refused. — Nothing protected leaks; it needs a session to create a directory with a `.md` name. The fix adds a new prefix rule.
  - `[low]` `[patch]` (blind 6) The three `retro-gates.yaml` verdict/item/go core rows pass identical input. — Collapsed into one core row; added a real-git table changing a verdict, an item and a go, each refused `coordinator-file`.
  - `[low]` `[patch]` (blind 7) A CI-fix refusal is untested, and it leaves the open PR without a comment. — Added a `kind: "fix"` refusal test. The comment is a spec question no AC asks for, and the park is visible to `next` and the ledger. Not patched.
  - `[low]` `[reject]` (blind 8) The log doesn't say why an Infrastructure approval failed. — Cosmetic, and the fix needs a new return shape. The record's `approval` and the manifest SHA are both visible to the Maintainer.
  - `[low]` `[patch]` (blind 9) `shown()` misses U+0085, U+2028/U+2029 and bidi controls. — The character class is widened, with tests.
  - `[low]` `[reject]` (blind 10) `infrastructureApproved` repeats `next.ts`'s approval comparison. — A one-line comparison, and the PR step's version is deliberately stricter (fresh `main` blob SHA). A shared helper is new surface for no named divergence.
  - `[low]` `[reject]` (blind 11) `.xarabot/` and `.github/` are hard-coded instead of read from `MANDATORY_PROTECTED_PATHS`. — Agent config is read from the shared `AGENT_CONFIG_PATHS`, and a test pins the mandatory list's order. A new mandatory directory is unlikely before v1.
  - `[low]` `[reject]` (blind 12) Real-git tests miss case-folded paths, type changes and symlinks, and WIP recoverability after a refusal. — Case-folding and type changes are covered in the core table and the own-manifest mode case; the symlink case was added with blind 1. WIP handling is unchanged by this Story.
  - `[medium]` `[patch]` (edge) A lone CR in the status line (`status: done\rinfrastructure: true`) passes as status-only, yet YAML reads it as an added key. — Confirmed with Bun.YAML. Same root as blind 2; fixed there, and the status line may now hold no CR except a trailing one.
  - `[medium]` `[patch]` (edge) A `.claude` symlink, or a bare `.github`/`.xarabot`, passes the check. — Same root as blind 1; fixed there.
  - `[low]` `[patch]` (edge) Replacing a context file with a same-named directory drops files silently. — Same root as blind 4; fixed there.
  - `[low]` `[reject]` (edge) Own-manifest bytes that aren't valid UTF-8, or a BOM added or removed, compare equal after lossy decoding. — It needs junk bytes in a manifest and changes no parsed field. Comparing raw bytes means a new blob-reading path.
  - `[low]` `[reject]` (edge) Reverted paths aren't logged when the merge-tree conflicts or a later git step fails. — Nothing is committed in either case, and the attempt fails with its own reason. Adding `reverted` to `conflict` widens the outcome type.
  - `[low]` `[patch]` (edge, claim) The spec says to diff the reverted tree, but the code filters the original diff. — Same root as blind 4; fixed there.

## Design Notes

- **Why the check lives in the committer.** Only the git committer has the session's real change in git objects (AR19). The PR step owns the policy inputs (fresh config, spec path, approval) and the ledger reaction. So the rules travel in `CommitRequest`, and the stub committer lets PR-step tests drive the `refused` path against the fake forge.
- **Case-folding.** The clone lives on APFS, which is case-insensitive. So `Claude.md` or `.GitHub/` is read as the protected file. Folding only ever widens a refusal. The exceptions compare exact paths, so folding never widens an exception.
- **"Its own Story file" is its manifest.** AD-10 says the one file per Story (`stories/<id>.md`) may double as the BMAD Story file, and that a manifest's `status` field is ignored. AD-3 makes that `status:` line the agent session's to write. The spec file is already wholly excepted, so the only reading that adds anything is the manifest.
- **Retro records.** AC 4 says "any agent diff". Today every agent diff is a builder diff, and a builder may not touch `retro-gates.yaml` at all. Coordinator sessions get their own rules in Story 2.4, so no field-level retro parser is built here.
- **Example status-only change:** `status: ready` → `status: done` inside `---` passes. Adding `title:` next to it is refused as `manifest`.

## Verification

**Commands:**
- `bun test` -- expected: no failure outside the baseline's sandbox-only set (compare with the same run at `767a31f475c89d01c593214bbd56bad50d16ebd3`)
- `bun test test/core/lane test/lane/commit.test.ts test/lane/committer.test.ts test/lane/pr-step.test.ts` -- expected: all pass apart from baseline sandbox-only failures
- `bun --bun oxlint` -- expected: exit 0
- `bun --bun tsc` -- expected: exit 0

## Auto Run Result

Status: done

**Summary.** Story 2.3 is complete:
- **Before the squash:** the git committer computes the session's own change in `runner.git` (snapshot tree vs `merge-base(start, onto)`) and reverts any Epic context file change to `baseSha`'s version. It then runs the pure write check on the tree that will be squashed.
- **Refused paths:** a session's change is refused if it touches any of these, all compared case-folded:
  - `sprint-status.yaml`, `retro-gates.yaml` or `epics.md`;
  - `.xarabot/**`, or a manifest;
  - the Standing Authority file or `.github/**`;
  - agent config at any depth, bare folder names and symlinks included;
  - the policy's Protected Paths.
- **Exceptions:**
  - the unit's own spec file;
  - a status-only change to its own manifest, checked both textually and on the parsed YAML;
  - an approved Infrastructure Story's Protected Paths, never coordinator files, manifests or `.xarabot/**`. Approval is re-checked on fresh `main`.
- **A refusal:** the PR step logs each refused path with its class, adds them all to the journal reason, parks the unit `blocked` `write-check` and pushes nothing. This applies to build and CI-fix sessions alike.
- **Runner-written content** (the merger, regenerated lockfiles, ledger writes) never passes through the check.

**Files changed (baseline `767a31f475c89d01c593214bbd56bad50d16ebd3` → working tree):**
- `src/core/lane/write-check.ts` (new) -- the pure check:
  - `WriteRules` and `writeRules`;
  - `checkWrite`, with seven classes and three exceptions;
  - `epicContextMatch`;
  - `statusLineOnly`, textual plus parsed-YAML.
- `src/core/config/protected-paths.ts` -- `AGENT_CONFIG_PATHS` split out; `MANDATORY_PROTECTED_PATHS` is built from it, in the same order.
- `src/lane/commit.ts` -- one raw diff parse; the Epic context revert through a temp index; a re-diff of the reverted tree; the check before any temp commit. Adds the `refused` outcome, and an optional `reverted` on `committed` and `empty`.
- `src/lane/committer.ts` -- `CommitRequest.rules`, passed through.
- `src/lane/pr-step.ts` -- several changes:
  - the config load (Standing Authority re-check) moved before the commit;
  - the rules are built from fresh `main`;
  - `infrastructureApproved` is checked on the fresh snapshot;
  - the `refused` branch parks `write-check`;
  - reverts are noted in the log;
  - `shown()` quotes agent-chosen paths that hold control, line-separator or bidi characters.
- `test/core/lane/write-check.test.ts` (new) -- the case table keyed by adapter (`claude` filled), with a coverage test over every class and exception, plus `statusLineOnly`, `epicContextMatch`, `writeRules` and order tables.
- `test/lane/commit.test.ts`, `test/lane/committer.test.ts`, `test/lane/git-fixture.ts` -- real-git cases:
  - refusals: nested agent config, `.github`, deletes and renames, a `.claude` symlink, and retro verdict/item/go content changes;
  - the own spec and the own manifest status line;
  - the Epic context edit, add and delete reverts, including a context file replaced by a directory;
  - Infrastructure approval;
  - `main` moving protected files after the start.
- `test/lane/pr-step.test.ts` -- refusal tests:
  - park, log, reason and journal (`endToEnd`);
  - a CI-fix refusal;
  - a lost claim before the park;
  - quoted unsafe paths.

  It also covers a committed outcome with reverts, the rules' contents, the four Infrastructure approval arms, and a config stop before the commit.

**Review findings.** 28 findings: high 0, medium 4, low 20, false 4, maybe-false 0.
- Patches applied, in 8 entries:
  - bare agent-config, `.github` and `.xarabot` names and symlinks (medium: 2 findings);
  - the status-line exception, checked on the parsed YAML, with no lone CR (medium: 2 findings);
  - the check run on the reverted tree (low: 3 findings);
  - the retro verdict/item/go rows (low);
  - a CI-fix refusal test (low: 2 findings);
  - `shown()` widened (low);
  - a committed-with-revert log test (low);
  - a lost-park test (low).
- Deferred: none.
- Rejected: 15 findings (11 low, 4 false). Each one's reason is in the Review Triage Log. The most notable:
  - AC 4's field-level retro verdict/item/go rule for coordinator diffs is not built. A builder can't touch `retro-gates.yaml` at all, and there are no coordinator sessions yet.
  - The spec-file exception covers every class. It would except a whole manifest only if `story_spec_path` matched a manifest, which no current config does.
  - A directory named like an Epic context file is not reverted.
  - BOM or invalid-UTF-8 byte changes in the own manifest are not detected.

**Follow-up review recommended: true.** This was a first pass that patched 2 medium entries. Both patches add new security-relevant logic that no fresh review pass has seen:
- the bare-name and symlink rule in `classify`;
- the parsed-YAML equality in `statusLineOnly`.

The specific unverified risk: another YAML construct, other than a lone CR, a continuation line, a moved line or an unclosed quote, may still let a "status-only" edit change a parsed manifest field. A symlink at an unprotected path may also still reach agent config.

**Verification:**
- `bun install --frozen-lockfile`: installed the lockfile's 10 packages.
- `bun test` at the baseline (before any change): 2510 pass, 73 fail, 162 skip. All 73 failures are sandbox-only (loopback listen, `ps`/`kill`).
- `bun test` after the patches: 2629 pass, 73 fail, 162 skip. The 73 failures match the baseline's by name, so nothing new fails.
- `bun test test/core/lane test/lane/commit.test.ts test/lane/committer.test.ts test/lane/pr-step.test.ts`: 313 pass, 0 fail.
- The matrix-covering git and PR-step tests filtered by name: 17 pass, 0 fail (before the patches).
- `bun --bun oxlint`: exit 0. `bun --bun tsc`: exit 0.
- A manual probe confirmed both medium findings before patching:
  - `statusLineOnly` passed a lone-CR edit that Bun.YAML reads as an added `infrastructure: true`;
  - `checkWrite` returned no refusal for `.claude`, `pkg/.agents` and `.github`.

**Residual risks:**
- **Coordinator diffs.** The field-level retro-record rule (AC 4, "any agent diff") and the coordinator diff rules are not built. Story 2.4 must refuse coordinator changes to retro verdicts, items and gos inside `retro-gates.yaml`, not only by path.
- **Spec file as manifest.** If a consuming repo's `story_spec_path` ever matches its own manifest, the spec-file exception would except the whole manifest.
- **CI-fix refusals.** A refusal on a CI fix leaves the open PR without a comment, though the park is in the ledger.
- **Uncommitted changes.** The changes are left uncommitted in the working tree, as the lane runner's rules require, and the runner makes the commit. This deliberately departs from this workflow's commit step.
