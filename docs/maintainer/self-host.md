# Self-host runbook: from the bootstrap loop to Xarabot's own runner

This runbook switches Xarabot's own repo, `xaravel/xarabot`, from the
bootstrap copy of Xaravel's loop (`bootstrap/loop/`) to Xarabot's pinned
runner (NFR13, NFR14), and lists what the Maintainer does while Epic 2 is
built. Lanes never write `.xarabot/**`, `.github/**` or `AGENTS.md`, and
never change live GitHub settings. Every step below is the Maintainer's.

Unless a step says otherwise:

- **Host commands** run on the Xarabot host as the lane's macOS user, `edanisko-xarabot` (ssh in). That user holds the App key in `~/.config/xarabot/apps/edanisko-xarabot/` and the Claude credential.
- **`gh` commands** run on your own machine, logged in as `edanisko`.
- **File changes** to this repo go in a Maintainer PR from a `planning/<topic>` branch. GitHub never lets you approve your own PR, and the merge queue refuses a PR without another person's approval, so you merge your own PR with the admin bypass (`gh pr merge <n> --merge --admin`), which skips the queue. Bot PRs always go through the queue.

## Before you start: the evidence

Run these on the Xarabot host, outside any sandbox (`XARABOT_SANDBOXED` must
be unset), from a checkout of the `main` commit you will tag in step 7:

```sh
git clone https://github.com/xaravel/xarabot.git ~/xarabot-switch
cd ~/xarabot-switch && bun install --frozen-lockfile
```

### The sandbox suites (Stories 1.11 and 1.12)

The nested cases run a real `sandbox-exec` session, so they report skipped
inside a sandboxed session. The live cases reach PyPI only, never GitHub.
The host rows below are the counts measured on the Xarabot host on 2026-10-23,
outside a sandbox, plus the cases Story 2.5c added (to be re-measured on the
host). The last row runs inside a sandboxed session instead.

| Command | Expected result |
|---|---|
| `bun test test/sandbox/macos.test.ts` | `100 pass`, `1 skip`, `0 fail`. The skip is the live uv/PyPI case. |
| `XARABOT_LIVE=1 bun test test/sandbox/macos.test.ts` | `101 pass`, `0 skip`, `0 fail`. This needs a uv-managed Python on the host: run `uv python install 3.12` once. |
| `bun test test/sandbox/proxy.test.ts` | `50 pass`, `1 skip`, `0 fail`. The skip is the live `CONNECT pypi.org:443` case. |
| `XARABOT_LIVE=1 bun test test/sandbox/proxy.test.ts` | `51 pass`, `0 skip`, `0 fail` |
| `bun test test/sandbox/` | `283 pass`, `2 skip`, `0 fail` |
| `XARABOT_LIVE=1 bun test test/sandbox/` | `285 pass`, `0 skip`, `0 fail` |
| `bun test`, run from the clone inside a real sandboxed lane session (e.g. a Story session's own verification) | `0 fail`. The nested sandbox cases and the host cases (binding a socket, `ps`, signalling another process, resolving `/tmp`) report skipped. |

If a nested case passes inside a sandboxed session, or is skipped on the host
outside one, the switch is not safe. Stop and investigate before going on.

### The canary (Story 1.20)

The canary runs one real `laneRun` against a scratch GitHub repo. It uses a
stub `claude` CLI inside the real macOS sandbox. In one unit it covers a
usage-limit sleep, the claim, the bot commit, the PR, CI, the merge queue and
`merged`, then a STOP during the trailing wait.

**Set up the scratch repo once:**

1. Create the scratch repo `xaravel/xarabot-scratch`, with an initial commit on `main`.
2. Install the `edanisko-xarabot` App on it.
3. Seed it with the canary's files: the config, policy, Standing Authority, `epics.md` with Story 1.1, the manifest and the CI workflow. Run this **on your own machine**, from a checkout of this repo, because the push needs your git credentials. The lane's macOS user has none:

   ```sh
   seed=$(mktemp -d)/xarabot-scratch
   git clone https://github.com/xaravel/xarabot-scratch.git "$seed"
   bun test/e2e/scratch-seed.ts "$seed" xaravel/xarabot-scratch edanisko
   git -C "$seed" add -A
   git -C "$seed" commit -m "Seed the Xarabot canary"
   git -C "$seed" push origin main
   ```

4. Add a ruleset on the scratch repo's `main` that requires the status check `check` and a merge queue with merge method squash. It must not require a review: the canary's paths need no owner approval, so the lane enqueues at once. Use the scratch repo's Settings → Rules → Rulesets, or:

   ```sh
   gh api -X POST repos/xaravel/xarabot-scratch/rulesets --input - <<'EOF'
   {
     "name": "canary main",
     "target": "branch",
     "enforcement": "active",
     "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
     "rules": [
       { "type": "required_status_checks", "parameters": { "strict_required_status_checks_policy": false, "required_status_checks": [{ "context": "check" }] } },
       { "type": "merge_queue", "parameters": { "merge_method": "SQUASH", "grouping_strategy": "ALLGREEN", "max_entries_to_build": 5, "max_entries_to_merge": 5, "min_entries_to_merge": 1, "min_entries_to_merge_wait_minutes": 0, "check_response_timeout_minutes": 15 } }
     ]
   }
   EOF
   ```

5. Set the scratch repo's squash messages to the PR title and body, as step 4 of the switch does for this repo:

   ```sh
   gh api -X PATCH repos/xaravel/xarabot-scratch -F allow_squash_merge=true -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY
   ```

**Run it on the host:**

```sh
XARABOT_LIVE=1 XARABOT_LIVE_GITHUB_REPO=xaravel/xarabot-scratch XARABOT_LIVE_GITHUB_LOGIN=edanisko bun test test/e2e/canary.test.ts
```

**Expected result:** `22 pass`, `0 skip`, `0 fail`, in about 5 to 10
minutes. The live case asserts all of these:

- `laneRun` exits 0 with outcome `progress`, within 10 s of the STOP. That is 5 s plus the waiter's 5 s STOP poll.
- The ledger record `story:1.1` is `merged`, and it is the only record.
- The journal has one `usage-limit` span ending at or after the reset plus 2 minutes, followed by one unit record with `sessions` 2, `result: done` and `state: merged`.
- The PR's head commit is authored and committed by `edanisko-xarabot[bot]`, with no trailers, no `Co-Authored-By` and no "Generated with".
- A second `laneRun`, with STOP present, exits 0 and leaves the ledger unchanged.

A failed assertion starts `step "<name>":` and names the step that failed,
followed by the lane's output and its unit log. Cleanup still runs: it closes
the scratch PRs and deletes the `xarabot-test/<uuid>/…` branches and the
`xarabot/test-<uuid>` ledger branch. Each run uses fresh branches, so you can
run it again as often as you like. Each merged run adds `canary/<run>.md` to
the scratch `main`.

Without the three variables, or inside a sandbox (`XARABOT_SANDBOXED=1`), the
live case reports skipped: `bun test test/e2e/` gives `21 pass`, `1 skip`,
`0 fail` on the host, and `19 pass`, `3 skip`, `0 fail` inside a sandbox.

### `xarabot graph check` on this repo

```sh
bun src/cli/main.ts graph check
```

**Expected:** it exits 0, prints the Epic graph `1 → []` to `7 → [5, 6]`, and
warns once for each Story that has no manifest.
`test/cli/graph-check.test.ts` asserts the same on every `bun test`.

## The switch, in order

### 1. The CI workflow as a required check

`.github/workflows/ci.yml` must match `docs/maintainer/ci-workflow.yml`. Check
with `diff docs/maintainer/ci-workflow.yml .github/workflows/ci.yml`. If they
differ, copy the file over in a Maintainer PR.

Then make the `check` job a required status check in the `Protect main`
ruleset. Go to Settings → Rules → Rulesets → `Protect main` → "Require status
checks to pass", and add `check` (source: GitHub Actions). Leave "Require
branches to be up to date" off: the merge queue tests each PR against fresh
`main`. Verify:

```sh
gh api repos/xaravel/xarabot/rules/branches/main --jq '.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'
# expected: check
```

**The macOS job (Maintainer decision, 2026-10-24).** The sandbox and agent
suites need macOS, so add a second job in a Maintainer `.github/` PR: a
GitHub-hosted `macos-latest` job that runs
`bun test test/sandbox/ test/contracts/` on every PR. The repo is public, so
the job is free. Before you make it required, check in its first run that
`sandbox-exec` works on the runner. Then add the job's name, next to
`check`, to the required status checks in `Protect main`, and add it to
`docs/maintainer/ci-workflow.yml` in the same PR so the `diff` above stays
empty.

### 2. The `xarabot/claims` ruleset

The ledger branch must refuse force-pushes and deletion, and no other ruleset
may match it. In particular, nothing may require PRs or status checks on it,
because the runner fast-forwards it on every claim.

```sh
gh api -X POST repos/xaravel/xarabot/rulesets --input - <<'EOF'
{
  "name": "xarabot claims",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/xarabot/claims"], "exclude": [] } },
  "rules": [{ "type": "deletion" }, { "type": "non_fast_forward" }],
  "bypass_actors": []
}
EOF
```

Verify that only these two rules, from this one ruleset, apply to the branch:

```sh
gh api repos/xaravel/xarabot/rules/branches/xarabot/claims --jq '[.[] | {type, ruleset_id}]'
# expected: exactly [{deletion, <id>}, {non_fast_forward, <id>}], with the same <id>
```

### 3. The merge queue on `main`

In `Protect main`, turn on "Require merge queue" with merge method Squash.
Keep the defaults otherwise: build concurrency 5, group size 1 to 5, wait 0
minutes, status check timeout 60 minutes or more. Every merge goes through
the queue. Never use `--admin`, `--delete-branch` or auto-merge. Verify:

```sh
gh api repos/xaravel/xarabot/rules/branches/main --jq '.[] | select(.type=="merge_queue") | .parameters.merge_method'
# expected: SQUASH
```

### 4. Squash messages: PR title and body

```sh
gh api -X PATCH repos/xaravel/xarabot -F allow_squash_merge=true -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY
gh api repos/xaravel/xarabot --jq '{allow_squash_merge, squash_merge_commit_title, squash_merge_commit_message}'
# expected: {"allow_squash_merge":true,"squash_merge_commit_title":"PR_TITLE","squash_merge_commit_message":"PR_BODY"}
```

### 5. The App's permissions

The `edanisko-xarabot` App asks for exactly the permissions in
[`app-permissions.md`](app-permissions.md): `contents: write`,
`pull_requests: write`, `issues: write`, `checks: read`, `statuses: read`,
`actions: read` and `metadata: read`. It never asks for `workflows`,
`administration` or any bypass right.

- `issues: write` is Story 1.10's precondition, for the `xarabot-inbox` alerts.
- AR38 found that the merge queue needs no permission of its own.

Check the App's settings page,
`https://github.com/settings/apps/edanisko-xarabot/permissions`. If you
changed a permission, accept the new permissions on the installation for
`xaravel`.

### 6. The Claude credential

On the host, as `edanisko-xarabot`, store the token from `claude setup-token`
as the mode-600 file `$XDG_CONFIG_HOME/xarabot/vendors/claude/oauth-token`.
That is `~/.config/xarabot/vendors/claude/oauth-token` when `XDG_CONFIG_HOME`
is unset. Follow the exact steps in
[`claude-credential.md`](claude-credential.md). The bootstrap setup (step 5
of `bootstrap/loop/README.md`) may already have stored it. Verify:

```sh
stat -f '%Lp %HT' "${XDG_CONFIG_HOME:-$HOME/.config}/xarabot/vendors/claude/oauth-token"
# expected: 600 Regular File
claude --version   # at least 2.1.304
```

### 7. `.xarabot/config.yaml`, with `runner_version` and `bootstrapped_epics: [1]`

`runner_version` is a tag in `xaravel/xarabot`. A lane installs
`~/.xarabot/runner/<tag>/` from it, so first tag the `main` commit that holds
Story 1.20, the commit the canary passed on. Tag names may use
`[A-Za-z0-9._+-]`, up to 100 characters, with no `..`. Run this **on your own
machine**, from your checkout of this repo, because the push needs your git
credentials. The lane's macOS user has none:

```sh
git fetch origin
git tag -a <tag> <sha> -m "Xarabot runner <tag>"
git push origin <tag>
```

Then add `.xarabot/config.yaml` in a Maintainer PR:

```yaml
schema_version: 1
runner_version: "<tag>"
maintainer: edanisko
standing_authority_path: docs/maintainer/standing-authority.md
bootstrapped_epics: [1]
manifests:
  dir: stories
```

### 8. `.xarabot/policy.yaml` and `.xarabot/human-live-steps.yaml`

Until Epic 3 merges, every path needs the Maintainer's approval, and only
`claude` runs unattended. Put these in the same Maintainer PR:

```yaml
# .xarabot/policy.yaml
schema_version: 1
unattended_adapters: [claude]
expected_checks: []
owner_approval_paths: ["**"]
```

```yaml
# .xarabot/human-live-steps.yaml
schema_version: 1
steps:
  - id: github-settings
    text: Change GitHub repository settings, rulesets, secrets, or the App's permissions or installations.
  - id: ci-workflow
    text: Write or change anything under .github/, including the CI workflow.
  - id: npm-publish
    text: Publish to npm or handle publish credentials.
```

`steps: []` is the opt-out if you want no Human Live Steps in the prompt. With no steps configured, a `human-live-step` block is an invalid result and fails the attempt (Story 2.6b), as is a block whose `step_id` is not listed.

### 9. The Standing Authority

Add `docs/maintainer/standing-authority.md` in the same Maintainer PR. It is
a Protected Path, so changing it always needs your review.

```markdown
---
schema_version: 1
granted_by: edanisko
granted_at: <YYYY-MM-DD>
repo: xaravel/xarabot
---

I, edanisko, let Xarabot's lanes on the Xarabot host build the Stories that
`next` picks in xaravel/xarabot: claim them on `xarabot/claims`, push
`story/<id>` branches as `edanisko-xarabot[bot]`, open and update their PRs,
and poll CI. A lane adds a PR to the merge queue only when none of its paths
needs my approval. Until Epic 3 merges, every path needs it, so every PR parks
awaiting my approving review. Once I approve its current head, the coordinator
re-checks this file and adds it to the merge queue (Story 2.6); until a
coordinator runs a runner with Story 2.6, I add it to the merge queue by hand.

One exemption: a coordinator's `reconcile` PR, which holds only runner-written
status content and no agent change, skips that approval. Once its CI passes,
the runner re-checks this file, fences and adds it to the merge queue itself
(Story 2.5).
```

The runner re-checks this file from fresh `main` before every claim, push,
enqueue and merge. If it is missing, invalid or expired, or if `granted_by`
is not the `maintainer` login in `.xarabot/config.yaml` (compared
case-insensitively), the lane stops. You can add `expires: <YYYY-MM-DD>`.

### 10. The bootstrap writes (AR4), each in its own Maintainer PR

1. **Sprint status.** Run `bmad-sprint-planning` once, in an interactive Claude Code session on this repo ("run sprint planning"). The run may create `_bmad-output/implementation-artifacts/sprint-status.yaml` or update it. Either way, every Epic 1 Story must end up `done`. Check:

   ```sh
   grep -E '^  1-[0-9]+[a-z]?-' _bmad-output/implementation-artifacts/sprint-status.yaml | grep -v ': done$'
   # expected: no output
   ```

2. **Epic 2's Story manifests**, one file per Story in `stories/`: `2.1.md` to `2.12.md`, for Stories 2.1 Heartbeat and fencing through 2.12 Claims race verification. Each has `globs`, plus `depends_on` where it builds on an earlier Story. For example:

   ```markdown
   ---
   story_id: "2.2"
   epic: 2
   sprint_key: 2-2-stale-takeover
   title: Stale takeover
   globs: ["src/core/ledger/**", "src/lane/**", "test/core/ledger/**", "test/lane/**"]
   depends_on: ["2.1"]
   ---
   ```

   The `sprint_key` must equal the Story's key in `sprint-status.yaml`. Then `bun src/cli/main.ts graph check` must exit 0 with no warning for any Epic 2 Story.

3. **Epic 2's context file**, at `epic_context_path` (`_bmad-output/implementation-artifacts/epic-2-context.md`). Compile it by following the installed stock `bmad-build-auto` skill's `.claude/skills/bmad-build-auto/compile-epic-context.md`, with these inputs:
   - Epic number `2`;
   - epics path `_bmad-output/planning-artifacts/epics.md`;
   - planning artifacts directory `_bmad-output/planning-artifacts`;
   - output path `_bmad-output/implementation-artifacts/epic-2-context.md`.

   Check it:

   ```sh
   f=_bmad-output/implementation-artifacts/epic-2-context.md
   test -s "$f" && head -n 1 "$f" | grep -q '^# Epic 2 Context:' && echo ok
   # expected: ok
   ```

   A builder lane only picks an Epic's Stories once this file exists and starts with that heading.

### 11. Epic 1's retro, interactively

Once the evidence above has passed, run Epic 1's retro in an interactive
Claude Code session ("lets retro the epic 1", `bmad-retrospective`). Merge its
document (`_bmad-output/implementation-artifacts/epic-1-retro-<date>.md`) in a
Maintainer PR. Epic 1 is in `bootstrapped_epics`, so it already counts as
done for `next`. The retro decides whether the switch goes ahead.

### 12. `XARABOT_MAX_BUILDERS=1`

Until Epic 3 merges, the host runs one builder lane. Set the variable when you
run `lane install`, as in step 13, so it is written into the lane's
LaunchDaemon plist. With it unset, the default is also 1. Check after the
install:

```sh
/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:XARABOT_MAX_BUILDERS' \
  ~/.xarabot/repos/xaravel__xarabot/lanes/builder-1/com.xarabot.lane.xaravel__xarabot.builder-1.plist
# expected: 1
```

### 13. `xarabot lane install`

On the host, as `edanisko-xarabot`, from a checkout of the tag. Lane names
must be `builder-<n>` or `coordinator`, the names ledger records accept. Any
other name passes `lane install` but stops the lane at its first snapshot.

```sh
git clone --branch <tag> --depth 1 https://github.com/xaravel/xarabot.git ~/xarabot-<tag>
cd ~/xarabot-<tag> && bun install --frozen-lockfile
PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" XARABOT_MAX_BUILDERS=1 bun src/cli/main.ts lane install builder-1 --repo xaravel/xarabot --role builder --owner edanisko --agent claude
```

The `PATH` prefix matters: `lane install` writes its `PATH` into the plist,
and the lane needs `claude`, `bun`, `git` and `uv` on it. Until Story 2.11
makes `lane install` check them, check by hand that each resolves on that
`PATH`.

It installs `~/.xarabot/runner/<tag>/` and writes `host.yaml`, the lane folder
and its `runner` file, the launcher `~/.xarabot/bin/xarabot-lane` and the plist.
At the end it prints two `sudo` commands: `sudo cp <plist> /Library/LaunchDaemons/`
and `sudo launchctl bootstrap system <daemon>`. **Do not run them yet.** Step 15 starts the lane.

### 14. Stop the bootstrap loop

First, close or finish any open bootstrap PR. The lane adopts an open
`story/<id>` PR only for a Story that `next` picks. Check:

```sh
gh pr list --repo xaravel/xarabot --state open --search 'head:story/'
# expected: no bootstrap PR listed
```

Then, on the host, as `edanisko-xarabot`:

```sh
touch ~/.xarabot-bootstrap/state/STOP
```

Wait until the current iteration ends: `tail -n 1 ~/.xarabot-bootstrap/state/history`
shows the last iteration, and no `claude -p` from the loop remains. If one
does, stop it by its exact PID, never with `pkill -f`. Then unload the
daemon, as your admin account:

```sh
sudo launchctl bootout system/com.xarabot.bootstrap
sudo rm /Library/LaunchDaemons/com.xarabot.bootstrap.plist
```

### 15. Start the lane

As your admin account, run the two commands step 13 printed:

```sh
sudo cp <plist> /Library/LaunchDaemons/
sudo launchctl bootstrap system /Library/LaunchDaemons/<label>.plist
```

The lane's label is `com.xarabot.lane.xaravel__xarabot.builder-1`. Watch it,
as `edanisko-xarabot`:

```sh
tail -n 5 ~/.xarabot/repos/xaravel__xarabot/lanes/builder-1/journal.jsonl
cat ~/.xarabot/repos/xaravel__xarabot/lanes/builder-1/outcome
```

To stop it, use `bun ~/.xarabot/runner/<tag>/src/cli/main.ts stop builder-1`,
or `touch ~/.xarabot/STOP` for the whole host. Every PR it opens parks
awaiting your approval. With a `runner_version` that has Story 2.6 and the
coordinator lane running, approve the PR's current head (before or after the
lane parks it) and the coordinator adds it to the merge queue within about
10 min; you queue nothing by hand (see "The coordinator lane" below). On an
older runner, approve it, then add it to the merge queue by hand. Either way,
the lane records it `merged` at its next start.

Xarabot requests no review and sends no notice for a parked PR. Until Story
4.2's daily digest, watch the repo with "All Activity" (the repo page →
Watch → All Activity) so GitHub notifies you of each new bot PR (Maintainer
decision, 2026-10-24).

## While Epic 2 is built

- **Advancing the runner.** A lane runs only the pinned `runner_version` (Story 1.19). When a Story merges whose code the lanes need:
  1. On your own machine, tag that `main` commit: `git tag -a <new-tag> <sha> -m "Xarabot runner <new-tag>" && git push origin <new-tag>`.
  2. In a Maintainer PR, set `runner_version: "<new-tag>"` in `.xarabot/config.yaml`.
  3. Merge the PR with the admin bypass (`gh pr merge <n> --merge --admin`); your own PR can't enter the merge queue.

  At its next start, each lane sees the new version on `main`, installs `~/.xarabot/runner/<new-tag>/`, and exits without a claim. The start after that runs the new runner. A lane never switches versions mid-unit.

  **When to advance (Maintainer decision, 2026-10-24).** In this order:
  1. Advance `runner_version` past Story 2.4 only together with the coordinator install (below), and only after the `Protect main` change in "`reconcile` PRs and `Protect main`" (below). A runner with Story 2.4 posts `coordinator-missing` on every `main` SHA until the coordinator runs.
  2. Then advance after each of these Stories merges: 2.5c (the blocked-Story fixes of 2.5a–2.5c), 2.6 (the coordinator enqueues approved PRs), 2.7 (planning units, which compile Epic 3's context and write its manifests), 2.8 (the graph-change gate) and 2.9 (Epic 2's retro).
  3. Story 2.8 writes ledger records at `schema_version` 3 (the new `approved_graph` field), and a runner without 2.8 stops on one (`ledger-schema-version`). Advance every lane's pin to a tag with 2.8 together, in one Maintainer PR, and never roll back past it once version-3 records are on the ledger. A runner with 2.8 still reads version 1 and 2 records.
- **The coordinator lane.** Never install it while `runner_version` lacks Stories 2.4 (the coordinator lane and its claim) and 2.5 (`reconcile` marks units done). A runner with 2.4 alone claims `coordinator.json` and then idles ("no reconcile step (Story 2.5)"). In this order:
  1. Make the `Protect main` change in "`reconcile` PRs and `Protect main`" (below).
  2. Once Stories 2.4 and 2.5 have both merged, tag a `main` commit that holds both, as in "Advancing the runner" step 1.
  3. Advance `runner_version` to that tag in a Maintainer PR (Story 1.19), as in steps 2 and 3.
  4. Install the lane at once. Its name must be `coordinator`: `lane install` refuses any other name for role `coordinator`, and refuses the name `coordinator` for a builder.

     ```sh
     PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" XARABOT_MAX_BUILDERS=1 bun ~/.xarabot/runner/<tag>/src/cli/main.ts lane install coordinator --repo xaravel/xarabot --role coordinator --owner edanisko --agent claude
     ```

     Then run the two printed `sudo` commands. Epic 2's retro, and so Epic 3, waits on this lane.

  With Story 2.5, the lane runs a `reconcile:<n>` unit whenever the ledger shows a record whose PR merged, or a `merged` record whose unit is done on `main`, and at least every 10 min otherwise; after an idle round it waits 10 min. `reconcile` starts no agent session. It records merged PRs as `merged`, deletes `merged` records once their unit is done on `main` (a Story is done once its `sprint-status.yaml` key is `done`), and cleans up earlier `reconcile` runs. When `sprint-status.yaml` needs a change (a merged Story's key to `done`, a merged graph unit's new keys as `backlog`), it opens one runner-written PR from `xarabot/reconcile-<n>` that changes only that file. Once the PR's checks pass, the runner queues it itself: the Standing Authority exempts `reconcile` PRs from owner approval, so you do not approve or queue them. A Protected Path still gates one, and a failing or timed-out check parks it for you (`verification`, `ci-timeout`). An ejected or conflicting `reconcile` PR is closed, and a later run opens a fresh one; no new one opens while another is open.

  With Story 2.6, a runner needs no hand queueing. Each `reconcile` run (at least every 10 min) reads the reviews of every PR parked awaiting approval whose head is still the one the lane parked. Only your latest approving, changes-requested or dismissed review counts, and it must be an approval of the PR's current head. When you dismiss a review, GitHub turns that review's own state to `DISMISSED`, so a dismissed approval no longer counts. Comments and pending reviews never count. When a builder parked the PR, any such approval counts, including one you gave while its checks still ran. Once it stands, the run re-checks the Standing Authority on fresh `main`, takes the unit (`merging`, held by the coordinator) and adds the PR to the merge queue at that head. Expect it within about 10 min of your approval; no agent session runs.

  If the queue later ejects or dequeues the PR, or it is closed, the next run parks it awaiting approval again, held by the coordinator, and posts a 🤖 comment saying why. If its enqueue conflicts, the same run parks it again. After such a re-park, only an approval you submit after the re-park counts, so a failing PR never loops and a dequeue you made by hand sticks. Approve its current head again once it can merge. A closed PR must be reopened first. A `reconcile` PR gated by a Protected Path is parked by the coordinator itself, so only an approval you submit after its gate comment counts. It is then taken the same way, but on an ejection, dequeue or conflict it is closed and its record released, never parked again; a later run opens a fresh one.

  A push to the PR's branch after the park stops the auto-queue: the lane's checks never ran on the new head, so the coordinator never takes it, whatever you approve. A push while the PR is queued also takes it out of the queue; the next run parks it again, with a 🤖 comment saying its head moved. Either way, add it to the merge queue by hand (the PR is still recorded `merged` once it merges), or run `bun ~/.xarabot/runner/<tag>/src/cli/main.ts rule rebuild <unit-id>`, which closes the PR and lets a builder start the unit fresh.

  With Story 2.7, the coordinator also runs planning units, after `reconcile` and any open coordinator PR, so you no longer run `bmad-sprint-planning` or write manifests by hand. A graph unit, `planning:graph.<n>`, runs when a Story heading in an Epic outside `bootstrapped_epics` has no manifest; its session writes the missing manifests (and may edit `epics.md` and `.xarabot/epics.yaml`). Graph planning needs `manifests` in `.xarabot/config.yaml`. A status unit, `planning:status.<n>`, runs when an Epic's or a Story's key, in an Epic outside `bootstrapped_epics`, is missing from `sprint-status.yaml`, or when an Epic's context file is missing or invalid while it has Stories still to build; its session runs `bmad-sprint-planning` headless and compiles the due Epic contexts. A graph unit goes first. A graph PR always parks awaiting your approval; a status PR parks only when policy gates a path it changes (with `owner_approval_paths: ["**"]`, every one does), else the runner queues it itself. A readiness finding parks the unit `blocked` `readiness`; the findings are in the coordinator lane's journal, `~/.xarabot/repos/<owner>__<name>/lanes/coordinator/journal.jsonl`. Fix the planning artifacts yourself (lanes never run `bmad-correct-course`), then release the unit with `bun ~/.xarabot/runner/<tag>/src/cli/main.ts rule release <unit-id>`. Any parked, merging or running planning unit stops a new one of its kind; once it is released, the next due run is numbered one higher. Story 2.7 also writes ledger records at `schema_version` 2, and a runner without 2.7 stops on one (`ledger-schema-version`). Once version-2 records are on the ledger, pinning `runner_version` back to a tag before 2.7 stops every lane: advance every lane's pin together, and never roll back past it.

  **`reconcile` PRs and `Protect main`.** While `Protect main` requires an approving review on every PR, GitHub refuses the runner's enqueue of a `reconcile` PR. The Maintainer decided (2026-10-24) to use code-owner review instead of a blanket approval, with no bypass actor. Do this before you install the coordinator lane:
  1. In a Maintainer PR, add `.github/CODEOWNERS`:

     ```text
     * @edanisko
     /_bmad-output/implementation-artifacts/sprint-status.yaml
     /_bmad-output/implementation-artifacts/retro-gates.yaml
     ```

     The last matching line wins, and a line with no owner leaves its file with no code owner. A `reconcile` PR touches only those two files, so it needs no review. Every other PR, the bot's included, still needs edanisko's.
  2. In `Protect main` → "Require a pull request before merging", set "Required approvals" to 0 and turn on "Require review from Code Owners". Keep "Dismiss stale pull request approvals when new commits are pushed" and "Require approval of the most recent reviewable push" on.
  3. Verify:

     ```sh
     gh api repos/xaravel/xarabot/rules/branches/main --jq '.[] | select(.type=="pull_request") | .parameters | {required_approving_review_count, require_code_owner_review, dismiss_stale_reviews_on_push, require_last_push_approval}'
     # expected: {"required_approving_review_count":0,"require_code_owner_review":true,"dismiss_stale_reviews_on_push":true,"require_last_push_approval":true}
     gh api repos/xaravel/xarabot/codeowners/errors --jq '.errors | length'
     # expected: 0
     ```

  On the first `reconcile` PR, check that GitHub shows no review required before the runner enqueues it. Before the change, a refused enqueue stops the lane with an alert, and a later run closes that PR.

  **Parked reconcile PR.** A parked `reconcile` PR (`verification`, `ci-timeout`, or a Protected Path) blocks new `reconcile` PRs. Closing it lets a later run open a fresh one; the parked record stays until its inbox item is resolved.

  **Hand edits.** Once the coordinator lane runs, stop marking Stories `done` in `sprint-status.yaml` by hand. A hand edit while a `reconcile` PR is open can get that PR ejected, and a later run closes it and opens a fresh one.

  At each start the lane claims `coordinator.json` as `edanisko/<host_id>/coordinator`. While another identity's claim is live (heartbeat under 30 min old), the start is refused and counted, and the third refusal in a row writes the lane's `STOP` and posts `lane-start-failed`. While the claim is missing or expired, builders keep building and post a `coordinator-missing` or `coordinator-expired` alert, once per `main` SHA. Expect `coordinator-missing` on every new `main` SHA from the first builder start on a runner with Story 2.4 until you install the coordinator lane. To move the coordinator to another host, or to recover it there, stop the old lane, then wait until its claim is 30 min stale: until then, each start of the new lane is refused and counted. Until `runner_version` has Story 2.6, keep adding approved PRs to the merge queue by hand; a runner with 2.6 does it for you (above). A moved coordinator leaves nothing stuck: when the new coordinator lane finds a PR the old one queued ejected, dequeued or closed, it parks that unit again itself, holding only the paths of the PR's diff.
- **A crashed lane.** A crashed lane's unit is taken over 30 min after its last heartbeat; `stop --now <lane>` releases it at once.
- **Releasing a parked unit.** Once `runner_version` has Story 2.5b, release a `parked` unit with one host command instead of a hand-written ledger commit. Run it on the host as `edanisko-xarabot`:

  ```sh
  bun ~/.xarabot/runner/<tag>/src/cli/main.ts rule release story:<id>
  bun ~/.xarabot/runner/<tag>/src/cli/main.ts rule rebuild story:<id>
  ```

  - `release` makes the record `released` with `attempts`, `loopbacks` and `ci_fixes` at 0. It keeps the PR, the SHAs and `builder_providers`, so the next claim adopts the open PR.
  - `rebuild` first closes the record's PR if it is open (`closed PR #<n>`), then releases it with the counters at 0 and `builder_providers`, `reviewed_sha`, `passed_sha` and `approved_sha` cleared. If the close lands but the edit fails, it exits 1 with `(PR #<n> was closed)`: run the same command again; the re-run finds the PR closed, skips the close and makes only the edit.
  - Until `runner_version` has Story 2.6b, after a `rebuild` delete the Story's branch before the lane claims it again (`git push origin --delete story/<id>`). Otherwise the next claim pushes as if the branch did not exist, conflicts on every attempt and parks again at `attempts-cap`. From Story 2.6b on, a claim with no open PR leases its push from the branch's real head, so the branch can stay. That push replaces whatever commits are on the Story branch, so keep no work on a Story branch with no open PR.
  - Either prints `released <unit> (<park kind>[ <reason>])` and exits 0. It refuses, exit 1 and the ledger unchanged, when the unit has no record, is not `parked` (`story:<id> is claimed, not parked`), or its record moved on before the edit. Any other verb (`approve`, `go`, …) prints `<verb>: not before Story 4.6`.
  - The edit is written as the repo's `coordinator` lane, or the lowest-numbered `builder-<n>` when the host has no coordinator lane; a non-Story unit (`planning:`, `retro:`, …) needs the coordinator lane. With lanes for several repos in `host.yaml`, add `--repo <owner>/<name>`.
- **Lane stops.** Once `runner_version` has Story 2.5b, a run that ends `stop` for any reason but a STOP marker (a forge `auth`, `forbidden` or `uninstalled` error, an unknown ledger `schema_version`, or bad config, policy or graph on `main`) exits 1 and counts as a failed start, like a refused start. The third in a row writes the lane's `STOP` and posts `lane-start-failed`. A run that ends without a lane stop resets the count. A STOP marker never counts. Once you have fixed the cause, remove the lane's `STOP` (`rm ~/.xarabot/repos/xaravel__xarabot/lanes/<lane>/STOP`).
- **Recovering a blocked Story's work.** A Story that parks `blocked` keeps its work on the host only, as the wip ref `refs/wip/story__<id>` in the lane's `runner.git`; it is never pushed, and the run after a release starts fresh from `main`. The unit's journal line names the ref in `wip_ref`, and its log says the same. If the session changed any file, its work is saved under that ref when the lane next rebuilds its clone, at the start of its next session; until then, the work is in the lane's `clone/` folder. A session that changed nothing saves nothing, so the ref may be missing or hold an older wip. To see the work, run this on the host as `edanisko-xarabot`, before the unit's next session overwrites it:

  ```sh
  git --git-dir ~/.xarabot/repos/xaravel__xarabot/lanes/builder-1/runner.git show refs/wip/story__<id>
  ```
- **Graph PRs.** Until `runner_version` has Story 2.8 (the graph-change gate), check every PR that changes `.xarabot/epics.yaml`, `epics.md` or `stories/` before approving it:

  ```sh
  gh pr checkout <n> && bun src/cli/main.ts graph check
  # expected: exit 0
  ```

  From Story 2.8 on, the runner does that check itself for the PRs a lane opens, so you stop running it on those. It never gates a PR a lane did not open (yours included): keep running `graph check` on such a PR before you merge it. Before it queues a bot PR, it recomputes the PR's merge with fresh `main` in the lane's `runner.git` and compares the Epic graph of the merge result with `main`'s. It runs at the builder merge step, after a graph planning unit's CI, and when `reconcile` takes an approved PR; the ungated status planning PRs and `reconcile`'s own PRs skip it, since their diffs hold no graph input.
  - **Unchanged graph.** The PR goes on as before: the owner's approval rule applies.
  - **Changed graph.** The PR parks awaiting approval in your inbox, with one 🤖 comment giving the merge result's hash and listing the change against `main`: edges, checkpoints, Epics and Stories added and removed, and the Epics each unrecorded checkpoint holds. Only your approval of the PR's current head queues it; another owner's approval never does. A PR parked under the owner rule whose merge result now changes the graph is parked again in your inbox, with that comment, once its owner approves it; only an approval you submit after that re-park counts. When `reconcile` takes it, the record holds `xarabot:graph` (one graph change at a time: a second approved graph PR waits until the first has merged or parked again, and also while a graph planning unit is running, since that unit holds `xarabot:graph` too; such a wait posts no comment, only a reason in the coordinator lane's journal) and stores the approved hash as `approved_graph`. If `main` moves before the enqueue and the hash changes, the approval is void: the PR parks again for you with the new delta, and only a new approval of its head queues it.
  - **Refused.** The PR parks `blocked` `graph-invalid`, with a 🤖 comment naming why: the merge result fails `graph check` (a missing or invalid config included); it drops an Epic number or Story id already used (a status beyond `backlog`, a ledger record, a retro-gates entry, or for a Story a PR on `story/<id>`); it adds a Story to an Epic whose retro is recorded or that is in `bootstrapped_epics`; or it removes `checkpoint: true` from an Epic whose checkpoint go is not recorded. Fix the PR, then release the unit with `bun ~/.xarabot/runner/<tag>/src/cli/main.ts rule release <unit-id>` or rebuild it.
  - A merge that conflicts, or a `main` whose own graph does not resolve, is a failed attempt (in `reconcile`, the take is skipped; a conflict there parks the PR again with the conflict comment).

- **A rejected retro's go.** Until Story 4.6 adds `/xarabot go retro:<N>`, a `rejected` retro of Epic 2 or Epic 3 holds its dependents. Record the go by hand in `_bmad-output/implementation-artifacts/retro-gates.yaml` (`retro_gates_path`), in a Maintainer PR. Add a `go` with `ruling: maintainer-pr` to the Epic's existing `retro` entry (AR13):

  ```yaml
  schema_version: 1
  epics:
    "2":
      retro:
        verdict: rejected
        unit: "retro:2"
        recorded_at: "<the retro's recorded_at, unchanged>"
        go:
          by: edanisko
          at: "<now, e.g. 2026-11-02T09:00:00Z>"
          ruling: maintainer-pr
  ```

  Keep every other entry and item as it is. `go` is allowed only on a `rejected` verdict.
