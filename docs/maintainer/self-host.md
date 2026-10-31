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
The host rows below are the case counts on `main` on 2026-10-26, outside a
sandbox. Run 2 of Epic 3's live evidence (`evidence/epic-3.md`) measured 185
pass, 2 skip for `macos.test.ts` and `proxy.test.ts` together and 334 pass,
3 skip for `test/sandbox/`. The sandbox cases added since bring the counts to
the ones below. A later sandbox case raises them again, so a higher pass
count with `0 fail` and the same skips is fine. The last row runs inside a
sandboxed session instead.

| Command | Expected result |
|---|---|
| `bun test test/sandbox/macos.test.ts` | `119 pass`, `1 skip`, `0 fail`. The skip is the live uv/PyPI case. |
| `XARABOT_LIVE=1 bun test test/sandbox/macos.test.ts` | `120 pass`, `0 skip`, `0 fail`. This needs a uv-managed Python on the host: run `uv python install 3.12` once. |
| `bun test test/sandbox/proxy.test.ts` | `69 pass`, `1 skip`, `0 fail`. The skip is the live `CONNECT pypi.org:443` case. |
| `XARABOT_LIVE=1 bun test test/sandbox/proxy.test.ts` | `70 pass`, `0 skip`, `0 fail` |
| `bun test test/sandbox/` | `338 pass`, `3 skip`, `0 fail`. The third skip is the live `bun install` case (Story 2.12). |
| `XARABOT_LIVE=1 bun test test/sandbox/` | `341 pass`, `0 skip`, `0 fail` |
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
3. Seed it with the canary's files: the config, policy, Standing Authority, `epics.md` with Story 1.1, the manifest and the CI workflow, plus the stand-in `bmad-build-auto` skill and the `AGENTS.md` that the cross-vendor suite (Story 3.6) uses. Run this **on your own machine**, from a checkout of this repo, because the push needs your git credentials. The lane's macOS user has none:

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
live case reports skipped. With the claims race suite (Story 2.12, below) and
the cross-vendor suite (Story 3.6, in "Epic 3's live evidence" below),
`bun test test/e2e/` gives `122 pass`, `9 skip`, `0 fail` on the host, and
`119 pass`, `12 skip`, `0 fail` inside a sandbox.

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

- `issues: write` is Story 1.10's precondition, for the `xarabot-inbox` alerts; Stories 4.2 to 4.6 use it for the inbox bodies, the daily digest, reading rulings and the 🤖 ruling replies.
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
must be `builder-<n>` (n >= 1) or `coordinator`, the names ledger records
accept: `lane install` refuses any other name for a builder, and refuses a
name `host.yaml` already holds for another repo.

```sh
git clone --branch <tag> --depth 1 https://github.com/xaravel/xarabot.git ~/xarabot-<tag>
cd ~/xarabot-<tag> && bun install --frozen-lockfile
PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" XARABOT_MAX_BUILDERS=1 bun src/cli/main.ts lane install builder-1 --repo xaravel/xarabot --role builder --owner edanisko --agent claude
```

The `PATH` prefix matters: `lane install` writes its `PATH` into the plist,
and the lane needs `claude`, `bun`, `git` and `uv` on it. `lane install`
refuses, and writes nothing, when any of them does not resolve on that
`PATH`; it names each missing tool and the `PATH`. It also refuses `--agent
pi`, and a `main` policy that does not parse or allows neither `claude` nor
`codex` (see "The `pi` adapter, deferred to v1"). It refuses, before it
installs the runner or writes anything, a lane whose agent is not in `main`'s
`.xarabot/policy.yaml` `unattended_adapters`, with the message lane start
gives (`agent codex is not in .xarabot/policy.yaml unattended_adapters
(allowed: claude)`); an absent policy is still left to lane start.

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
a minute; you queue nothing by hand (see "The coordinator lane" below). On an
older runner, approve it, then add it to the merge queue by hand. Either way,
the lane records it `merged` at its next start. An idle lane waits 1 min
before its next start, so it claims the next Story within about a minute of
the one it waits on merging.

Xarabot requests no review and sends no notice for a parked PR. Until Story
4.2's daily digest, watch the repo with "All Activity" (the repo page →
Watch → All Activity) so GitHub notifies you of each new bot PR (Maintainer
decision, 2026-10-24).

### Your inbox and the daily digest (Story 4.2)

With a `runner_version` that has Story 4.2 and the coordinator lane running,
each owner has one inbox: the lowest-numbered open issue labelled
`xarabot-inbox` and assigned to them, titled `🤖 Xarabot inbox`. It is the
issue the alerts already post on; `reconcile` creates one only for an owner
with items who has none. Every `reconcile` run rewrites each inbox's body
from the ledger and `main`, and only when it changed: your parked PRs and
blocked units, and, in your inbox as the Maintainer, every `needs-approval`
unit, every `human-live-step` block, every graph change awaiting your
approval, the waiting checkpoint gos, the rejected retros with no go, the
open retro items routed to you, the Story headings with no manifest, and
each deferred entry of a Story spec on `main` that no later spec
`resolves`. Each item shows its link, its age in whole days and its
`/xarabot` verb where it has one. An inbox with nothing in it reads
`🤖 Xarabot inbox: nothing waits on you.` The body never @-mentions anyone,
so a rewrite notifies no one.

A blocked unit shows text under its item only when a session wrote it: a
build, CI-fix or retro-item session's blocked result, or a planning unit's
readiness summary. A park the runner caused (`write-check`, `review-cap`,
`ci-fix-cap`, `ci-timeout`, `attempts-cap`, `graph-invalid` and the like)
shows its reason only; its unit log says more.

The first run lists every `deferred` entry of every Story spec already on
`main`, however old. An entry leaves your inbox only when a later spec lists
its id (`<story id>-d<n>`, or the entry's own `id`) in its frontmatter
`resolves`.

Once a day, at `digest_time` (UTC, default `08:00`, in
`.xarabot/config.yaml`), the first `reconcile` run past the slot stamps
`digest_posted_at` in `coordinator.json` and then posts one comment on each
non-empty inbox, `@<owner>` with the item count and the issue link: that
comment is the notice. A run that fails to post one does not retry it that
day.

**Human Live Step: pin your inbox, once.** After the first `reconcile` run
with Story 4.2 has created or rewritten your inbox, open the repo's Issues
tab, find the open `🤖 Xarabot inbox` issue assigned to you (filter
`label:xarabot-inbox assignee:@me`), and choose **Pin issue** in its right
sidebar. Xarabot never pins it: the runner has no pin operation. Keep that
issue open; if you close it, the next run opens a new one, which you pin
again. Once the inbox is pinned and the daily digest arrives, you can drop
the "All Activity" watch above.

### Rulings in your inbox (Stories 4.5 and 4.6)

With a `runner_version` that has Story 4.6 and the coordinator lane
running, you and the other owners rule on inbox items with a comment on an
open `xarabot-inbox` issue. Every `reconcile` run reads the comments posted
on the open inbox issues since its last read, oldest first, so a ruling
takes effect within one coordinator round.

**Grammar.** A ruling is a comment that reads exactly
`/xarabot <verb> <unit-id>`, on one line, with nothing before or after it
but whitespace: for example `/xarabot go checkpoint:4` or
`/xarabot release story:2.1`. The unit id is one the inbox shows
(`story:<id>`, `checkpoint:<N>`, `retro:<N>`, `retro-item:<id>`,
`planning:…`). A comment that does not start with `/xarabot` (a quote, a
note, a 🤖 comment) is not a ruling: it gets no reply and changes nothing.
One that starts with `/xarabot` but names no verb, an unknown verb, no unit
id or a malformed one, or has text after the unit id, is refused. A comment
is judged once: editing or deleting it after its reply changes nothing, so
post a new one instead.

**Verbs and authority.** Logins compare case-insensitively.

| Verb | Applies to | Who may rule it | What it does |
|---|---|---|---|
| `go` | `checkpoint:<N>` of a checkpoint Epic with no go; `retro:<N>` of a `rejected` retro with no go | the Maintainer | a pending go (below) |
| `approve` | a unit parked `needs-approval` whose Story manifest is on `main` | the Maintainer | releases it, recording your approval with that manifest's SHA |
| `block`, `unblock` | a `retro-item:<id>` that `retro-gates.yaml` lists, not already in that state | the Maintainer | a pending change of the item's `blocking` |
| `done` | a listed retro item not yet `done` | the Maintainer | a pending `status: done` |
| `defer` | a listed retro item that is `open`, `in-progress` or `waiting` | the Maintainer | a pending `status: deferred` |
| `release` | a `parked` unit | the item's owner or the Maintainer | as `rule release`: `released`, counters at 0, the PR kept |
| `rebuild` | a `parked` unit | the item's owner or the Maintainer | as `rule rebuild`: closes the open PR first, then releases it with the counters at 0 and the SHAs and providers cleared |
| `dismiss` | any item an inbox lists | the item's owner or the Maintainer | a dismissal (below) |

The item's owner is the one whose inbox lists it: a unit parked
`needs-approval` or blocked `human-live-step` is yours as the Maintainer,
any other parked unit its `park.inbox_owner`'s, and every other item
yours. A run judges its comments in order, each against the state the
earlier ones left, so a second `release` of the same unit is refused (it is
released already), a second `go` is refused (there is a go), and `unblock`
while a `block` is pending replaces it. All of a run's rulings land in one
ledger write with the read cursor, or none do: a write another run beat
leaves the cursor, posts no reply, and the next run judges the same
comments again. A `rebuild` whose PR fails to close is refused, with the
reason.

**Replies.** Once that write lands, each ruling gets one 🤖 reply on its own
inbox issue, linking the comment: `🤖 Ruling acknowledged: /xarabot <verb>
<unit-id> from <login> (comment).` when it counts, or `🤖 Ruling not
applied (comment): <reason>. Nothing changed.` when it is refused, the
reason naming why (who may rule the verb, or why it does not apply). A
reply never @-mentions anyone. A reply that fails to post is logged and
never retried; what the ruling did stands, and the inbox shows it.

**The pending list.** `go`, `block`, `unblock`, `done` and `defer` change
`retro-gates.yaml`, which only a PR to `main` can. So each one is kept as a
pending ruling in `coordinator.json` (`pending_rulings`), and that same
run's `reconcile` PR writes it into `retro-gates.yaml`, one summary line per
change. The go it writes has `by` the comment's author, `at` its time and
`ruling` the comment's id. Every `reconcile` run writes the pending rulings
again until `main` shows them, so a closed or failed PR, or a run that died,
loses none; an entry leaves the list once applying it to `main`'s
`retro-gates.yaml` changes nothing (that covers an item no longer listed).
Your inbox renders with the pending rulings applied, so an item ruled
`go`, `done` or `defer` leaves it before the PR merges; the gates read only
`main`, so the units a go or an item status frees are claimed after the
`reconcile` PR merges. A later ruling is judged against the state with the
pending rulings applied, so on a unit with a pending ruling:

- `unblock` replaces a pending `block`, and `block` a pending `unblock`:
  rule `unblock` to undo a pending `block`.
- `done` replaces a pending `defer`.
- A second `go` is refused (there is a go), and so is a repeat of the
  pending verb (`block`, `unblock`, `done` or `defer` again: the item is
  already in that state).
- `defer` while a `done` is pending is refused: the item reads as `done`,
  not `open`, `in-progress` or `waiting`.

So a pending `go` or `done` cannot be replaced by a ruling. A hand edit of
`retro-gates.yaml` does not undo a pending ruling: the next `reconcile` PR
writes it again.

**Dismissals.** `dismiss <unit-id>` hides that item from its inbox and
changes nothing else: the unit, its PR, the ledger record and
`retro-gates.yaml` stay as they are, and a gate it holds stays shut. The
dismissal, kept in `coordinator.json` (`dismissals`), names the item as the
inbox showed it: its text and start time. When the item comes back with
another text or start time (the unit parked again, say), the dismissal is
dropped and the item shows again. While no inbox lists the item, its
dismissal stays. A deferred spec entry has no unit id, so it cannot be
dismissed.

**`xarabot rule` on the host.** The same nine verbs work from the host, as
`edanisko-xarabot`, with no comment:

```sh
bun ~/.xarabot/runner/<tag>/src/cli/main.ts rule <verb> <unit-id> [--repo <owner>/<name>]
```

- Every verb but `release` and `rebuild` is judged as you, the
  Maintainer, by the rules above, against one snapshot. A refusal exits 1
  with the reason, and the ledger is unchanged. An unknown verb or a
  malformed unit id is refused before any file or forge access.
- It makes the same edit a comment ruling would, but moves no read cursor
  and posts no reply. A pending ruling it records has `by` the Maintainer,
  `at` the forge's time and `ruling: xarabot-rule`, in place of a comment
  id; a go written by hand has `ruling: maintainer-pr`.
- `approve` prints `approved <unit> (manifest <sha>): released`; `go`,
  `block`, `unblock`, `done` and `defer` print `recorded <verb> <unit> as
  pending: the next reconcile PR writes it to retro-gates.yaml`; `dismiss`
  prints `dismissed <unit> from the inbox`. `release` and `rebuild` keep
  their own path and output ([Releasing a parked unit](#while-epic-2-is-built)
  below).
- `go`, `block`, `unblock`, `done`, `defer` and `dismiss` write
  `coordinator.json`, so they need the repo's coordinator lane in the
  host's `host.yaml`, as does any ruling on a unit other than a Story.

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
  4. Story 2.9 writes ledger records at `schema_version` 4 (the new `retro_result` field), and a runner without 2.9 stops on one (`ledger-schema-version`). Advance every lane's pin to a tag with 2.9 together, in one Maintainer PR, and never roll back past it once version-4 records are on the ledger. A runner with 2.9 still reads version 1 to 3 records. Set `live_evidence_glob` in `.xarabot/config.yaml` only once every lane's pin has 2.9: a runner without 2.9 refuses the unknown key and stops on bad config. Until then, the default path applies.
  5. Story 3.5 writes ledger records at `schema_version` 5 (the new `enqueued_sha` field), and a runner without 3.5 stops on one (`ledger-schema-version`). Advance every lane's pin to a tag with 3.5 together, as in step 3. A runner with 3.5 reads a record below version 5 that has no `enqueued_sha` with its `passed_sha` moved to `enqueued_sha`, so the record reads as unreviewed. A unit parked `awaiting-approval` before the advance is therefore never taken: `reconcile` leaves it parked whatever you approve (its note says `is unreviewed at <sha>`, `not taken, left parked`), and nothing else tells you. After the advance, release each such unit with `bun ~/.xarabot/runner/<tag>/src/cli/main.ts rule release <unit-id>` ("Releasing a parked unit", below): the next claim adopts its open PR, which goes through CI and a review before it is queued. `rule rebuild <unit-id>` closes the PR and starts the unit fresh instead.
  6. Story 4.2 writes ledger records at `schema_version` 6 (the new `park.text` field, the blocked session's own words), and a runner without 4.2 stops on one (`ledger-schema-version`). Advance every lane's pin, builders and the coordinator alike, to a tag with 4.2 together, in one Maintainer PR, as in step 3, and never roll back past it once version-6 records are on the ledger. A runner with 4.2 still reads version 1 to 5 records; a unit parked before the advance has no text, so its inbox item shows none.
- **The coordinator lane.** Never install it while `runner_version` lacks Stories 2.4 (the coordinator lane and its claim) and 2.5 (`reconcile` marks units done). A runner with 2.4 alone claims `coordinator.json` and then idles ("no reconcile step (Story 2.5)"). In this order:
  1. Make the `Protect main` change in "`reconcile` PRs and `Protect main`" (below).
  2. Once Stories 2.4 and 2.5 have both merged, tag a `main` commit that holds both, as in "Advancing the runner" step 1.
  3. Advance `runner_version` to that tag in a Maintainer PR (Story 1.19), as in steps 2 and 3.
  4. Install the lane at once. Its name must be `coordinator`: `lane install` refuses any other name for role `coordinator`, and refuses the name `coordinator` for a builder.

     ```sh
     PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" XARABOT_MAX_BUILDERS=1 bun ~/.xarabot/runner/<tag>/src/cli/main.ts lane install coordinator --repo xaravel/xarabot --role coordinator --owner edanisko --agent claude
     ```

     Then run the two printed `sudo` commands. Epic 2's retro, and so Epic 3, waits on this lane.

  With Story 2.5, the lane runs a `reconcile:<n>` unit whenever the ledger shows a record whose PR merged, or a `merged` record whose unit is done on `main`, and at least every 10 min otherwise; after an idle round it waits 1 min, so its next round picks up new `reconcile` work within about a minute. `reconcile` starts no agent session. It records merged PRs as `merged`, deletes `merged` records once their unit is done on `main` (a Story is done once its `sprint-status.yaml` key is `done`), and cleans up earlier `reconcile` runs. When `sprint-status.yaml` needs a change (a merged Story's key to `done`, a merged graph unit's new keys as `backlog`), it opens one runner-written PR from `xarabot/reconcile-<n>` that changes only that file. Once the PR's checks pass, the runner queues it itself: the Standing Authority exempts `reconcile` PRs from owner approval, so you do not approve or queue them. A Protected Path still gates one, and a failing or timed-out check parks it for you (`verification`, `ci-timeout`). An ejected or conflicting `reconcile` PR is closed, and a later run opens a fresh one; no new one opens while another is open.

  With Story 2.6, a runner needs no hand queueing. Each `reconcile` run (at least every 10 min) reads the reviews of every PR parked awaiting approval whose head is still the one the lane parked. Only your latest approving, changes-requested or dismissed review counts, and it must be an approval of the PR's current head. When you dismiss a review, GitHub turns that review's own state to `DISMISSED`, so a dismissed approval no longer counts. Comments and pending reviews never count. When a builder parked the PR, any such approval counts, including one you gave while its checks still ran. Once it stands, the run re-checks the Standing Authority on fresh `main`, takes the unit (`merging`, held by the coordinator) and adds the PR to the merge queue at that head. Expect it within about a minute of your approval, since an approval is `reconcile` work in the next round; no agent session runs.

  If the queue later ejects or dequeues the PR, or it is closed, the next run parks it awaiting approval again, held by the coordinator, and posts a 🤖 comment saying why. If its enqueue conflicts, the same run parks it again. After such a re-park, only an approval you submit after the re-park counts, so a failing PR never loops and a dequeue you made by hand sticks. Approve its current head again once it can merge. A closed PR must be reopened first. A `reconcile` PR gated by a Protected Path is parked by the coordinator itself, so only an approval you submit after its gate comment counts. It is then taken the same way, but on an ejection, dequeue or conflict it is closed and its record released, never parked again; a later run opens a fresh one.

  A push to the PR's branch after the park stops the auto-queue: the lane's checks never ran on the new head, so the coordinator never takes it, whatever you approve. A push while the PR is queued also takes it out of the queue; the next run parks it again, with a 🤖 comment saying its head moved. Either way, add it to the merge queue by hand (the PR is still recorded `merged` once it merges), or run `bun ~/.xarabot/runner/<tag>/src/cli/main.ts rule rebuild <unit-id>`, which closes the PR and lets a builder start the unit fresh.

  With Story 2.7, the coordinator also runs planning units, after `reconcile` and any open coordinator PR, so you no longer run `bmad-sprint-planning` or write manifests by hand. A graph unit, `planning:graph.<n>`, runs when a Story heading in an Epic outside `bootstrapped_epics` has no manifest; its session writes the missing manifests (and may edit `epics.md` and `.xarabot/epics.yaml`). Graph planning needs `manifests` in `.xarabot/config.yaml`. A status unit, `planning:status.<n>`, runs when an Epic's or a Story's key, in an Epic outside `bootstrapped_epics`, is missing from `sprint-status.yaml`, or when an Epic's context file is missing or invalid while it has Stories still to build; its session runs `bmad-sprint-planning` headless and compiles the due Epic contexts. A graph unit goes first. A graph PR always parks awaiting your approval; a status PR parks only when policy gates a path it changes (with `owner_approval_paths: ["**"]`, every one does), else the runner queues it itself. A readiness finding parks the unit `blocked` `readiness`; the findings are in the coordinator lane's journal, `~/.xarabot/repos/<owner>__<name>/lanes/coordinator/journal.jsonl`, and, with a runner that has Epic 3 retro item 15, under the unit's item in your inbox. Fix the planning artifacts yourself (lanes never run `bmad-correct-course`), then release the unit with `bun ~/.xarabot/runner/<tag>/src/cli/main.ts rule release <unit-id>`. Any parked, merging or running planning unit stops a new one of its kind; once it is released, the next due run is numbered one higher. Story 2.7 also writes ledger records at `schema_version` 2, and a runner without 2.7 stops on one (`ledger-schema-version`). Once version-2 records are on the ledger, pinning `runner_version` back to a tag before 2.7 stops every lane: advance every lane's pin together, and never roll back past it.

  **An Epic's open questions (Epic 3 retro item 15).** When a status unit compiles an Epic's context for the first time (no context file for it on `main`), its session first reads every Story of that Epic in `epics.md`, and the Maintainer decisions recorded there, and lists each design question they leave open: the kind a build session would stop on as an `intent-gap`. If any Epic it compiles has one, it writes no context file and parks `blocked` `readiness` for you, the questions under its item in your inbox in one batch, grouped by Epic and Story, each with the readings that would behave differently. Until then that Epic has no context file, so none of its Stories is claimed. Answer them in a Maintainer PR to `epics.md`, recorded as Maintainer decisions under the Epic, and once it merges run `bun ~/.xarabot/runner/<tag>/src/cli/main.ts rule release planning:status.<n>`; the next status unit, numbered one higher, checks the Epic again, then compiles its context. An Epic whose context file is already on `main`, or that has no open question, compiles as before.

  With Story 2.9, the coordinator also runs an Epic's retrospective, `retro:<N>`, after planning, so you no longer run `bmad-retrospective` by hand. It is due once every Story of an Epic outside `bootstrapped_epics` is `done` in `sprint-status.yaml`, `retro-gates.yaml` records no verdict for it, and its live evidence file is on `main`: `live_evidence_glob` in `.xarabot/config.yaml`, default `docs/maintainer/evidence/epic-<N>.md`. Commit that file yourself, in a Maintainer PR; builders are refused any change to it (`live-evidence`). Until it is on `main`, the coordinator lane idles with a journal reason starting `waiting-on-maintainer:` that names the file. To make the retro wait for the live results too, not just the file, list each Epic's runbook commands under `live_evidence_checks` in `.xarabot/config.yaml`, keyed by Epic number (for example `"2": ["XARABOT_LIVE=1 bun test test/contracts/"]`). The retro is then due only when the file holds each listed command exactly as written (in backticks, a table cell or on its own line, never inside a longer command) followed by a `bun test` summary whose count is `0 fail`, before the next listed command; until then the lane idles `waiting-on-maintainer:`, naming each command that is missing or has no `0 fail` summary after it. A failed run kept on the record does no harm once a re-run of the same command after it shows `0 fail`. An Epic with no entry needs only the file. Set `live_evidence_checks` only once every lane's pin has this check: an older runner refuses the unknown key and stops on bad config. Before the session, the runner reads the PRs on the Epic's Story branches and their reviews and writes them to the session's temp folder as `epic-<N>-prs.json`; the session never touches GitHub. It runs `bmad-retrospective -H <N>`, which writes the retro document (`retro_doc_glob`) and appends the Epic's action items to `sprint-status.yaml`, and reports the verdict and each item's id, text, blocking flag, route and globs. The runner checks that result before it pushes anything: the item ids are the Epic's and appear once, no item glob covers a planning artifact, a status file, `.xarabot/`, `.github/`, agent config, a live evidence file or a Protected Path, the items are exactly the action items the commit appends, and the commit adds or changes exactly one retro document whose frontmatter `verdict` is the result's. A failed check is a failed attempt, so the unit runs again, and the third failure parks it `blocked` `attempts-cap`. A session that edits a verdict, item or go in `retro-gates.yaml` parks `write-check`. The retro PR, from `xarabot/retro-<N>`, follows a status planning PR: it parks awaiting your approval when policy gates a path it changes (with `owner_approval_paths: ["**"]`, every one does), else the runner queues it after CI. A retro runs once, so a conflicting enqueue parks it awaiting your approval instead of closing it. Approving the same head after such a park only conflicts again: update the PR's branch (then queue it by hand) or merge it by hand, or run `bun ~/.xarabot/runner/<tag>/src/cli/main.ts rule rebuild retro:<N>` to close it and run the retro again. Once it merges, the next `reconcile` run writes the verdict and items to `retro-gates.yaml` (creating the file at `schema_version: 1` if it is absent; items are written `open`) in its own PR. The file is rewritten whole, so comments in it are lost, but its data, including a `go` you recorded, is kept. A `rejected` verdict is written like any other: record its go by hand, as below.

  With Story 2.10, the coordinator also works the open retro action items, after any due retro, so you no longer route lane follow-ups by hand. An item is due when `retro-gates.yaml` lists it with `status: open` and `route: lane`; Epics go in ascending order, then items in file order. An item with `globs: []` is never worked: the coordinator lane's journal names it `unclaimable`, so fix its globs in a Maintainer PR or do it yourself. A `route: maintainer` item is never worked either; it is yours (Epic 4 lists such items in your inbox). Each item is one unit, `retro-item:<id>`, held on the item's own globs, so an item whose globs overlap a running unit's waits. Its session runs no skill: the prompt names the item's id, Epic, action text and globs. Its PR, from `xarabot/retro-item-<id>`, follows a Story's path: the commit is refused every path a builder is (status files, `epics.md`, manifests, `.xarabot/`, the Standing Authority, `.github/`, agent config such as a `CLAUDE.md` inside the item's globs, live evidence files and Protected Paths) and any path outside the item's globs, each parking it `write-check`; CI failures and conflicts get up to two fix sessions; a change to the Epic graph parks it for your approval, and so does any path policy gates (with `owner_approval_paths: ["**"]`, every one does). Approve it as you would a Story's PR, and `reconcile` queues it. An ungated PR is queued by the runner itself, and `reconcile` watches the queue. The item stays `open` in `retro-gates.yaml` while its unit runs; once its PR merges, the next `reconcile` run sets it `done` in its own PR, and the run after that deletes the unit's record. If the queue later ejects or dequeues an ungated retro-item PR, the next `reconcile` run parks it awaiting your approval again (Story 2.6), and only an approval you submit after that park counts. While a retro-item PR is open and its record is `claimed` or `merging`, the coordinator starts no new planning, retro or retro-item unit (`reconcile` still runs) until the PR merges or parks. A parked retro-item unit (`write-check`, `no-op`, `intent-gap`, `ci-fix-cap`, `attempts-cap` and the like) waits for you: fix the cause, then run `bun ~/.xarabot/runner/<tag>/src/cli/main.ts rule release retro-item:<id>` to resume it (a unit with an open PR keeps it, and the PR goes back through CI with no new session; a unit parked before its first push, such as `no-op`, `intent-gap` or a first `write-check`, gets a new session from `main`) or `rule rebuild retro-item:<id>` to close its PR and start the item fresh from `main`. Both are written as the coordinator lane, so run them on a host whose `host.yaml` has the coordinator lane for the repo.

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
- **Several builder lanes.** Once `runner_version` has Story 2.11, one host can run several builder lanes. Keep the limit at 1 until Epic 3 merges: Story 2.12's live race proof comes first, and the acceptance check after Epic 3 (a coordinator and 2 builders for 24 hours) is the check for lifting it. Both are in [Epic 2's live evidence (Story 2.12)](#epic-2s-live-evidence-story-212) below. Then:
  1. Reinstall every existing builder lane on the host (here `builder-1`) with `XARABOT_MAX_BUILDERS=2` first, so its plist carries the new limit; a reinstall keeps the lane's folder and `host.yaml` entry. A builder whose plist still says 1 refuses every start once two builders are in `host.yaml` (a failed start; the third writes its `STOP` and alerts). The coordinator ignores the limit, so it needs no reinstall. The limit counts the builder lanes in `host.yaml` across all repos.

     ```sh
     PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" XARABOT_MAX_BUILDERS=2 bun ~/.xarabot/runner/<tag>/src/cli/main.ts lane install builder-1 --repo xaravel/xarabot --role builder --owner edanisko --agent claude
     ```

  2. Reload each reinstalled lane without cutting a unit short. `sudo launchctl bootout` on a running lane sends it SIGTERM mid-session or mid-PR-step, so drain it first:
     1. `bun ~/.xarabot/runner/<tag>/src/cli/main.ts stop <lane>` writes the lane's `STOP`.
     2. Wait until the process named in the lane's `lane.lock` is gone. Its first line is the lane run's PID, its second the runtime's command name (`bun`). Neither a written `outcome` nor a missing `lane.lock` shows that: a run writes `outcome` before its trailing wait, and a lane stopped by SIGTERM leaves its `lane.lock` behind. A lock whose PID is already gone is fine. The loop also compares the running process's command name with the lock's second line, because once the lane has exited its PID can be reused by an unrelated process, and waiting on the PID alone would then wait forever:

        ```sh
        lock=~/.xarabot/repos/xaravel__xarabot/lanes/<lane>/lane.lock
        pid=$(sed -n 1p "$lock" 2>/dev/null); cmd=$(sed -n 2p "$lock" 2>/dev/null)
        while [ -n "$pid" ] && [ "$(basename "$(ps -p "$pid" -o comm= 2>/dev/null)" 2>/dev/null)" = "$cmd" ]; do sleep 10; done; echo drained
        ```
     3. As your admin account, `sudo launchctl bootout system/<label>`, then run the two `sudo` commands the reinstall printed to bootstrap the new plist.
     4. Remove the lane's `STOP` (`rm ~/.xarabot/repos/xaravel__xarabot/lanes/<lane>/STOP`).
  3. Then install the new lane with `XARABOT_MAX_BUILDERS=2`, and run the two `sudo` commands it prints:

     ```sh
     PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" XARABOT_MAX_BUILDERS=2 bun ~/.xarabot/runner/<tag>/src/cli/main.ts lane install builder-2 --repo xaravel/xarabot --role builder --owner edanisko --agent claude
     ```

  Each lane has its own folder under `~/.xarabot/repos/xaravel__xarabot/lanes/<lane>/`, with its own `runner.git`, clone, vendor home, journal and launchd job (`com.xarabot.lane.xaravel__xarabot.<lane>`). Each lane run holds `lane.lock` in its folder (its PID, runtime and start time) until it exits. A second start of the same lane while one runs prints `lane <lane> is already running (pid <pid>, lane.lock); exiting without a claim`, exits 0 and is not a failed start. A lock whose process is gone (or whose PID now belongs to a later or other process) is taken over, and the run says which PID was stale and why. A lane stopped by SIGTERM (`launchctl bootout`, `stop --now`) leaves its `lane.lock` behind, so the next start takes it over as stale and prints that message; that is expected then. `touch ~/.xarabot/STOP` stops every lane on the host after its current unit: a unit in progress finishes through its PR step, and the next start of each lane claims nothing. When a builder's change conflicts with a fresh `main` at commit time (common with several builders), the PR still opens, from the session's start; the CI step then merges `main` into it, and a conflict no rule resolves runs a conflict session, counted in `ci_fixes` (2 at most, shared with CI fixes), never as an attempt.
- **Releasing a parked unit.** Once `runner_version` has Story 2.5b, release a `parked` unit with one host command instead of a hand-written ledger commit. Run it on the host as `edanisko-xarabot`:

  ```sh
  bun ~/.xarabot/runner/<tag>/src/cli/main.ts rule release story:<id>
  bun ~/.xarabot/runner/<tag>/src/cli/main.ts rule rebuild story:<id>
  ```

  - `release` makes the record `released` with `attempts`, `loopbacks` and `ci_fixes` at 0. It keeps the PR, the SHAs and `builder_providers`, so the next claim adopts the open PR.
  - `rebuild` first closes the record's PR if it is open (`closed PR #<n>`), then releases it with the counters at 0 and `builder_providers`, `reviewed_sha`, `passed_sha` and `approved_sha` cleared. If the close lands but the edit fails, it exits 1 with `(PR #<n> was closed)`: run the same command again; the re-run finds the PR closed, skips the close and makes only the edit.
  - Until `runner_version` has Story 2.6b, after a `rebuild` delete the Story's branch before the lane claims it again (`git push origin --delete story/<id>`). Otherwise the next claim pushes as if the branch did not exist, conflicts on every attempt and parks again at `attempts-cap`. From Story 2.6b on, a claim with no open PR leases its push from the branch's real head, so the branch can stay. That push replaces whatever commits are on the Story branch, so keep no work on a Story branch with no open PR.
  - Either prints `released <unit> (<park kind>[ <reason>])` and exits 0. It refuses, exit 1 and the ledger unchanged, when the unit has no record, is not `parked` (`story:<id> is claimed, not parked`), or its record moved on before the edit. From Story 4.6 on, `rule` takes every ruling verb, not only these two: see [Rulings in your inbox](#rulings-in-your-inbox-stories-45-and-46) above.
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

- **A rejected retro's go.** A `rejected` retro holds its dependents until it has a go. Once `runner_version` has Story 4.6, rule the go: comment `/xarabot go retro:<N>` on your inbox, where the rejected retro's item shows that verb, or run `bun ~/.xarabot/runner/<tag>/src/cli/main.ts rule go retro:<N>` on the host. The next `reconcile` PR writes it into `retro-gates.yaml`, so you no longer write it by hand ([Rulings in your inbox](#rulings-in-your-inbox-stories-45-and-46) above). With a runner before Story 4.6, record the go by hand in `_bmad-output/implementation-artifacts/retro-gates.yaml` (`retro_gates_path`), in a Maintainer PR. Add a `go` with `ruling: maintainer-pr` to the Epic's existing `retro` entry (AR13):

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

## Epic 2's live evidence (Story 2.12)

Epic 2's retro (`retro:2`) waits until `docs/maintainer/evidence/epic-2.md`
is on `main` (Story 2.9). Run the three evidence commands below on the
Xarabot host as `edanisko-xarabot`, outside any sandbox (`XARABOT_SANDBOXED`
must be unset), from a checkout of a `main` commit that has Story 2.12.

**Setup** (not one of the three commands): update the checkout and note the
commit it is at. The evidence file records that commit.

```sh
git -C ~/xarabot-switch pull --ff-only && cd ~/xarabot-switch && bun install --frozen-lockfile
git rev-parse HEAD
```

Then commit the results, as described at the end of this section, before
Epic 2's retro runs.

### The claims race suite

The suite runs real `laneRun` lanes against the scratch repo the canary uses
(`xaravel/xarabot-scratch`, set up as in "The canary" above). Each lane runs
the real STOP check, `lane.lock`, the version check, the start checks and the
claim loop with its heartbeat keeper and fencing. The sessions are stubs that
hold the unit until the test releases them, so no agent runs. The lanes read
the scratch `main` with their own Story set overlaid, and nothing is pushed
to `main`. No PR is opened and nothing is merged. The one push the suite
tries is the replayed late push, which the fence must refuse. Alerts are
recorded by the test, not posted. Each case uses a fresh ledger branch
`xarabot/test-<uuid>` and unit branches under `xarabot-test/<uuid>/`, and
deletes both when it ends, whether it passes or fails. Only a test timeout or
Ctrl-C can leave them behind (see below).

```sh
XARABOT_LIVE=1 XARABOT_LIVE_LONG=1 XARABOT_LIVE_GITHUB_REPO=xaravel/xarabot-scratch XARABOT_LIVE_GITHUB_LOGIN=edanisko bun test test/e2e/claims-race.test.ts
```

**Expected result:** `20 pass`, `0 skip`, `0 fail`, in about 35 to 45
minutes. Most of that is the takeover case waiting 30 minutes for the stale
age. The four live cases assert:

- **One unit** (`live race: one unit, …`): two hosts with different `host_id`s race for Story 1.1. Both first ledger swaps start from the same tip; one is `ok` and one `conflict`. The ledger has exactly one `ledger: claim story:1.1 [skip ci]`, held by the winner at generation 1. Only the winner's session starts. The loser's `laneRun` exits 0 with `lane builder-1: idle`.
- **Overlapping globs** (`live race: overlapping globs, …`): one host sees Stories 1.1 (`race/shared/**`) and 1.3, the other 1.2 (`race/shared/b/**`) and 1.3, so each lane picks a different Story and the two overlap. Both swaps start from the same tip; one is `ok` and one `conflict`. Exactly one of 1.1 and 1.2 is claimed; the other has no record. The losing lane claims 1.3 and its session runs on it.
- **Same lane, two processes** (`live race: same lane, …`): two OS processes of `builder-1` with one `HOME` start at once. One holds `lane.lock` and claims; the ledger has exactly one claim commit. The other exits 0 printing `is already running` and `exiting without a claim`. Once released, the holder exits 0 and `lane.lock` is gone.
- **Killed mid-unit** (`live long: …`): host A's lane, in its own process, holds Story 1.1 and is killed by PID; it ends by SIGKILL. A run on host B before the stale age exits 0 `idle`, and the record is unchanged. Once the forge's time is 30 minutes past A's last heartbeat, B's next run takes the unit over at `generation` + 1 with `attempts` + 1, and its session starts. A's late push, replayed with the real PR step from A's old record and a real commit, ends `failed` with `fence: unit lost`. No `story/1.1` branch is pushed, and the record is still B's.

Without `XARABOT_LIVE_LONG=1`, the long case reports skipped: `19 pass`,
`1 skip`, `0 fail`. That is not enough for the evidence file; run it with the
long case. Without the variables, every live case reports skipped: `16 pass`,
`4 skip`, `0 fail` on the host. Inside a sandbox you get `15 pass`, `5 skip`,
`0 fail`, because the two-process rehearsal needs `ps`. The rehearsals that
pass there run the same cases on the fake forge in every `bun test`.

A failed assertion starts `step "<name>":`, names the step that failed, and
is followed by each lane's output, the alerts the lanes recorded and the
tail of their unit logs. The branches are deleted even then. A run cut short
by Bun's per-test timeout or by Ctrl-C can leave its `xarabot/test-<uuid>`
and `xarabot-test/<uuid>/…` branches on the scratch repo. They do no harm,
and you can delete them by hand. To list any that are left:

```sh
gh api --paginate repos/xaravel/xarabot-scratch/git/matching-refs/heads/xarabot --jq '.[].ref | select(startswith("refs/heads/xarabot/test-") or startswith("refs/heads/xarabot-test/"))'
```

### `bun install` in a sandboxed session

```sh
XARABOT_LIVE=1 bun test test/sandbox/bun-install.test.ts
```

**Expected result:** `1 pass`, `0 skip`, `0 fail`, in about a minute. It
clones the checkout's committed `HEAD` (uncommitted changes are not
included) into a lane-layout folder and runs
`bun install --frozen-lockfile` there in the real macOS sandbox. The command
runs with no credential, through the proxy, which allows the clone's
`proxy_hosts` (`registry.npmjs.org`). On failure, the test prints the
install's output.

### The agent contract's live smoke

```sh
XARABOT_LIVE=1 bun test test/contracts/
```

This needs the Claude credential (`docs/maintainer/claude-credential.md`) and
`claude` on `PATH`. It runs one short real session at effort `low`, which uses
a little of the subscription.

**Expected result:** `0 fail`. These two agent contract cases must pass, not
skip: `the real CLI passes the start check and starts in the sandbox without
EPERM` and `live: a smoke session writes a result and reports its usage`.
Without the scratch variables, the GitHub forge contract's live cases report
skipped. Add `XARABOT_LIVE_GITHUB_REPO=xaravel/xarabot-scratch
XARABOT_LIVE_GITHUB_LOGIN=edanisko` to run them too.

### Committing the evidence

Commit the results as `docs/maintainer/evidence/epic-2.md` in a Maintainer
PR from a `planning/<topic>` branch, and merge it before Epic 2's retro.
Builders are refused any change to this file (`live-evidence`), so only you
write it. Until it is on `main`, the coordinator lane idles with a
`waiting-on-maintainer:` reason that names the file. Once Epic 2 is listed in
`live_evidence_checks` (see "While Epic 2 is built"), the retro also waits
until the file holds each of the three commands, exactly as run above, with a
`0 fail` summary after it. The file holds:

- the date, the host, the `main` commit (and its tag, if any) the checkout was at, and `bun --version`;
- each of the three commands above, exactly as run, with its summary lines (`pass`, `skip` and `fail` counts) and how long it took;
- for any run that failed: the failing `step "<name>":` line, what you changed, and the re-run that passed. Never replace a failed result silently.

### After Epic 3: lifting the builder limit

Before you raise `XARABOT_MAX_BUILDERS` above 1 for good, run a coordinator
and 2 builders on the host for 24 hours. This is the last step of "The switch
after Epic 3", in "Epic 3's live evidence (Story 3.6)" below. Set them up as "Several builder
lanes" (in "While Epic 2 is built") describes, with `XARABOT_MAX_BUILDERS=2`.
Note the start time, then check both of these:

- **No unit was built twice.** No two builders ran a session on one unit at the same time, and no Story merged twice. For each unit, the time spans these rows list must not overlap:

  ```sh
  cat ~/.xarabot/repos/xaravel__xarabot/lanes/builder-*/journal.jsonl | jq -r --arg start "<start>" 'select(.type == "unit" and .sessions > 0 and .started_at >= $start) | [.unit, .lane, .started_at, .ended_at] | @tsv' | sort
  gh pr list --repo xaravel/xarabot --state merged --search "merged:>=<start, e.g. 2026-11-10T09:00:00Z>" --limit 200 --json headRefName --jq '[.[].headRefName | select(startswith("story/"))] | group_by(.) | map(select(length > 1))'
  # expected: []
  ```

- **No builder wrote a status file.** No builder PR opened in the window, whether open, closed or merged, changes `sprint-status.yaml` or `retro-gates.yaml`:

  ```sh
  for n in $(gh pr list --repo xaravel/xarabot --state all --search "created:>=<start>" --limit 200 --json number,headRefName --jq '.[] | select(.headRefName | startswith("story/")) | .number'); do
    gh pr diff "$n" --repo xaravel/xarabot --name-only | grep -E '(^|/)(sprint-status|retro-gates)\.yaml$' && echo "PR #$n"
  done
  # expected: no output
  ```

If either check fails, keep the limit at 1 and investigate.

## The `codex` adapter (Story 3.1)

A lane with `agent: codex` runs `codex exec` inside Xarabot's sandbox, with
codex's own sandbox and approvals off and a private `CODEX_HOME` (the lane's
vendor home), re-seeded before every session. Its default model is
`gpt-6.1-sol` at effort `high`; `gpt-6.1-sol` and `gpt-6-luna` offer `low`
to `max`, and any other model refuses at start. The CLI must be at least
`codex-cli 0.163.0`. Before the lane can run unattended, `codex` must be in
`.xarabot/policy.yaml`'s `unattended_adapters`, and `xarabot lane install`
checks that `codex` resolves on the plist's `PATH`.

### The codex credential

On the host, as `edanisko-xarabot`, keep **exactly one** of these two
mode-600 files in `$XDG_CONFIG_HOME/xarabot/vendors/codex/` (that is
`~/.config/xarabot/vendors/codex/` when `XDG_CONFIG_HOME` is unset). Both
files, or neither, make every `lane run` a failed start.

| File | What it is | How sessions get it | Hosts the session may reach |
|---|---|---|---|
| `auth.json` | a ChatGPT login, as `codex login` writes it | copied to `$CODEX_HOME/auth.json`, mode 600, before every session | `chatgpt.com`, `ab.chatgpt.com`, `auth.openai.com` |
| `api-key` | an OpenAI API key, one line | the variable `CODEX_API_KEY` | the three above, plus `api.openai.com` |

For a ChatGPT login, log in once with a throwaway `CODEX_HOME`, then move its
`auth.json` into place (never copy `~/.codex/auth.json` while another codex
uses it: two homes refreshing one refresh token may log one of them out):

```sh
umask 077
dir="${XDG_CONFIG_HOME:-$HOME/.config}/xarabot/vendors/codex"
mkdir -p "$dir"
login=$(mktemp -d)
CODEX_HOME="$login" codex login          # follow the browser prompt
mv "$login/auth.json" "$dir/auth.json" && rm -rf "$login"
chmod 600 "$dir/auth.json"
stat -f '%Lp %HT' "$dir/auth.json"       # expected: 600 Regular File
codex --version                          # expected: codex-cli 0.163.0 or later
```

For an API key instead, write it the way the Claude token is written
(`read -rs key; printf '%s\n' "$key" > "$dir/api-key"; unset key; chmod 600
"$dir/api-key"`), and make sure `auth.json` is not also there.

If codex refreshes its login during a session, it rewrites the copy in
`CODEX_HOME`. The runner never copies it back: it journals a
`credential-rewrite` span for that run instead (`jq 'select(.span ==
"credential-rewrite")' journal.jsonl`). If those spans appear and sessions
later fail to sign in, log in again as above.

Every request a session's proxy decides on is written to the unit log, after
the run's stdout and stderr, under `--- proxy ---`, as `allow <host>:<port>`
or `deny <host>:<port> (<reason>)`. The codex host list is final (Maintainer
decision 2026-10-26, `docs/maintainer/evidence/epic-3.md` § "Story 3.1's host
list"). The address `2606:4700:440b::ac40:9034` that the spike saw is one of
the AAAA records of the four
`sdmntpr{central,northcentral,southcentral,westcentral}us.oaiusercontent.com`
hosts. Those hosts stay denied: every codex run logs a `deny` line for each,
and codex passes every live check without them. `files.openai.com` stays off
the allowlist because no run reached it.

### The codex live evidence

Run these on the Xarabot host as `edanisko-xarabot`, outside any sandbox
(`XARABOT_SANDBOXED` must be unset), from a checkout of a `main` commit that
has Story 3.1, with the codex credential above and `codex` on `PATH`. The
live cases use a little of the subscription (each is one short session at
effort `low`).

```sh
bun test test/sandbox/macos.test.ts test/sandbox/proxy.test.ts
XARABOT_LIVE=1 bun test test/contracts/agent.codex.contract.test.ts
XARABOT_LIVE=1 bun test test/adapters/agent/codex/codex-live.test.ts
```

**Expected results:** `0 fail` for each. Without `XARABOT_LIVE=1`, or inside
a sandboxed session, the live and sandbox cases report skipped, never
passed; that is not evidence.

- **The sandbox suites:** the `a codex spec` block passes: `CODEX_HOME` holds only `auth.json` (mode 600) in ChatGPT mode and nothing in API-key mode, where `CODEX_API_KEY` is set; a session that rewrites or removes `auth.json` is reported as a rewrite while the operator's file stays byte-identical; the prompt arrives as the last argument with stdin closed; the proxy reports the allowed vendor host and the refused GitHub host; a missing, mode-644 or empty `auth.json` refuses, naming the file. `codex starts when present` passes too.
- **The codex contract** (`Agent contract: codex`): `the real CLI passes the start check and starts in the sandbox without EPERM` (with a dummy API key) and `live: a smoke session writes a result and reports its usage` (with your credential) must pass, not skip.
- **`codex-live.test.ts`**, five cases; record what each prints:
  - `outcome mapping`: the shared build prompt, with `bmad-build-auto` taken as halted `ready-for-dev`, yields a `build` result `blocked`/`other` (never `no-op`), and the session file reports `gpt-6.1-sol`.
  - `resume`: a run that wrote no result is resumed with `codex exec … resume <thread_id> -- <prompt>` (the options before `resume`), reports the same thread id, and writes the result.
  - `subagent tokens`: prints `turnCompleted`, `parentRollout`, `children` and `parsed`. It asserts that `turn.completed` equals the parent's own session-file total (so children are not in it) and that the parsed total is larger. If it fails on the first assertion, codex counts children in `turn.completed` and the adapter double-counts them: report it to the Maintainer.
  - `auth.json` (ChatGPT mode only; skipped in API-key mode): prints `credentialRewritten: true|false`, and asserts your `auth.json` is unchanged.
  - `proxy hosts`: prints every `allow`/`deny` target the session's proxy saw. Record the list. Any `deny` line for a host codex needs (for example `files.openai.com`) is a decision for the Maintainer before that host is added; it is never added silently.

Record the date, the host, the `main` commit, `bun --version`,
`codex --version`, each command as run with its `pass`/`skip`/`fail` counts,
and the printed lines above, in the Epic 3 live evidence file
(`docs/maintainer/evidence/epic-3.md`), as for Epic 2.

## The `pi` adapter, deferred to v1 (Story 3.2)

0.x has no `pi` adapter. Story 3.2's escalation found (Maintainer,
2026-10-25) that stock pi 1.4.0 gives `bmad-build-auto` no subagents, so a pi
session cannot run the build skill the way `claude` and `codex` sessions do.
The adapter moves to v1.

What 0.x does instead, in both `xarabot lane install` and `xarabot lane run`:

- **A `pi` lane is refused.** `lane install --agent pi` exits 1 before it checks the tools (a `pi` on the plist's `PATH` changes nothing) and before it connects, installs a runner or writes anything. A lane already in `host.yaml` with `agent: pi` is refused at the start checks, a failed start, in every `lane run` that reaches them (a run that only switches the runner version, or fails before those checks, exits first).
- **A policy with no reviewer but `pi` is refused.** When `.xarabot/policy.yaml`'s `unattended_adapters` allows neither `claude` nor `codex` (for example `[pi]`, or `[]`), the only reviewer would be `pi`. `lane install` reads the policy from `main` with `config.yaml` and refuses before the runner install; a policy that does not parse is refused too, naming `.xarabot/policy.yaml`, and an absent one is left to lane start. At `lane run` it is a failed start, checked after the `pi`-lane check and before the agent's own `unattended_adapters` check.

Each refusal names the deferral:

```text
the `pi` adapter is deferred to v1: stock pi 1.4.0 gives `bmad-build-auto` no subagents
```

A failed start counts in the lane's `failed-starts`, and the third in a row
writes `STOP` and posts the lane-start alert, as for any refused start. To
recover, set the lane to `claude` or `codex` (`xarabot lane install` again)
and make sure the policy allows one of them. The re-install rewrites the
lane's plist and prints the `sudo cp` and `sudo launchctl bootstrap`
commands for it; run them as in step 15. After three failed starts, also
remove the lane's `STOP` file
(`~/.xarabot/repos/<owner>__<name>/lanes/<lane>/STOP`), or the lane stays
stopped. A policy may keep listing `pi`:
it still parses, and only `claude` and `codex` lanes run.

What the v1 adapter needs first, before anything else:

1. **Subagents for `bmad-build-auto`** in the pi version it pins.
2. **pi's agent-directory override (AR41)**, so a session reads its skills and config from the lane's vendor home, not `~/.pi`, which Xarabot's sandbox always denies, by design.
3. **Its attribution-off and own-sandbox-off switches**, so pi adds no attribution of its own and runs inside Xarabot's sandbox with its own sandbox off, as `claude` and `codex` do.

Then: its credential (an OpenRouter key), its minimum tested version, and
its `--thinking` mapping for `effort`, with the pi rows of the cross-vendor
review table in the spec's `agent-adapters.md`.

## Epic 3's live evidence (Story 3.6)

Epic 3's retro (`retro:3`) waits until `docs/maintainer/evidence/epic-3.md`
is on `main`. Run the commands below on the Xarabot host as
`edanisko-xarabot`, outside any sandbox (`XARABOT_SANDBOXED` must be unset),
from a checkout of a `main` commit that has Story 3.6. Update it and note its
commit first, as for Epic 2:

```sh
git -C ~/xarabot-switch pull --ff-only && cd ~/xarabot-switch && bun install --frozen-lockfile
git rev-parse HEAD
```

### Before the first run

**Re-seed the scratch repo** (`xaravel/xarabot-scratch`, set up as in "The
canary" above). The cross-vendor suite needs the stand-in `bmad-build-auto`
skill (`.claude/skills/bmad-build-auto/SKILL.md`, and the same text at
`.agents/skills/bmad-build-auto/SKILL.md` for codex) and an `AGENTS.md` on its
`main`. The scratch repo has no BMAD install: for `Build Story 1.6
(`<key>`)` the stand-in writes `verify/<key>.md` and the Story's spec, then
halts `done`, so a real session builds the Story in about a minute. The
scratch `main` only takes changes through its merge queue, so open a PR. Run
this **on your own machine**, as for the first seed:

```sh
seed=$(mktemp -d)/xarabot-scratch
git clone https://github.com/xaravel/xarabot-scratch.git "$seed"
bun test/e2e/scratch-seed.ts "$seed" xaravel/xarabot-scratch edanisko
git -C "$seed" status --short   # expected: only the two SKILL.md files and AGENTS.md, all new; restore any other change (git -C "$seed" checkout -- <path>)
git -C "$seed" switch -c seed/stand-in-skill
git -C "$seed" add -A
git -C "$seed" commit -m "Seed the stand-in build skill and AGENTS.md"
git -C "$seed" push origin seed/stand-in-skill
cd "$seed" && gh pr create --fill --base main && gh pr merge --squash   # adds it to the merge queue
```

Wait until the PR has merged. Until then, every live case fails at the step
`scratch main loads`, naming the missing skill file.

**Both vendors' credentials at once.** A lane's vendor home holds one vendor's
credential, but the suite needs both: each case copies (mode 600) every file
in `~/.config/xarabot/vendors/claude/` and `~/.config/xarabot/vendors/codex/`
(under `$XDG_CONFIG_HOME` when it is set) into the case's own temp config. So
keep the Claude token (`docs/maintainer/claude-credential.md`) and exactly one
codex credential ("The codex credential" above) in place, with `claude` and
`codex` both on `PATH`. A missing CLI or credential fails a case; it never
skips. A missing CLI or vendor folder fails at the first step, `the CLIs and
the vendor credentials`; a vendor folder that holds no credential file fails
at `host setup`. The `edanisko-xarabot`
App credentials are the canary's.

### The cross-vendor suite

Each case runs one real `laneRun` against the scratch repo, with the real
`claude` and `codex` CLIs in the real macOS sandbox. The lane builds Story
1.6, "Cross-vendor verification" (glob `verify/**`), at effort `low`, then
takes it through the PR, CI, the review gate and the merge queue. A reviewer
of the other adapter runs its default model at effort `high`; a reviewer of
the lane's own adapter (the claude-only case) runs at the lane's model and
effort, `low`. The lane reads
the scratch `main` with Story 1.6 and the case's `.xarabot/policy.yaml`
overlaid (`expected_checks: []`), and the test records every push, posted
review and enqueue. Each case uses a fresh sprint key `1-6-xv-<case>-<8 hex>`,
ledger branch `xarabot/test-<uuid>` and unit branches under
`xarabot-test/<uuid>/`. The branches are deleted when the case ends, whether
it passes or fails, as for the claims race suite (the same command lists any a
timeout or Ctrl-C leaves behind). Nothing is pushed to the scratch `main`;
only the merge queue merges, so each case adds its `verify/<key>.md` there.
Alerts are recorded by the test, not posted. The sessions use a little of
both subscriptions: about ten short sessions in all.

```sh
XARABOT_LIVE=1 XARABOT_LIVE_GITHUB_REPO=xaravel/xarabot-scratch XARABOT_LIVE_GITHUB_LOGIN=edanisko bun test test/e2e/cross-vendor.test.ts
```

**Expected result:** `89 pass`, `0 skip`, `0 fail`, in about 30 to 60
minutes. Each live case runs to the lane's trailing wait, then writes the
lane's `STOP`, as the canary does. The lane gets 40 minutes, inside the
test's 50-minute timeout (the rest is for cleanup); past them the case fails
`laneRun did not exit within 40 min`. Every case checks all of these:

- `laneRun` exits 0 with outcome `progress`. The ledger holds only `story:1.6`, `merged`.
- The record's `builder_providers` names the builder's vendor. Its `passed_sha` and `enqueued_sha` both equal its `head_sha`, and GitHub shows the PR merged with that head.
- Every review the lane posted starts `🤖 Story 1.6: <cross-vendor|same-vendor> review by <adapter> (` and ends with the full SHA it was posted on. One of them passed at the merged head, and GitHub lists a `commented` review on that SHA.
- The review gate held: every enqueue's head had a review posted at exactly that SHA, saying `Verdict: pass.` and `Outcome: not blocking.`, with no push of another SHA between that review and the enqueue. Every enqueue that reached the queue was at the merged head.
- The journal's line for `story:1.6` is `result: done`, `state: merged`.
- The lane's clone holds what this run's build wrote: `verify/<key>.md` starting with `Built for <key>.`, and `spec-1-6-verify.md` naming the key (the spec path is shared across runs, so one an earlier run left never counts).

The cases:

| Case | Lane, policy | Expected |
|---|---|---|
| `live cross-vendor: claude builds Story 1.6, codex reviews it, …` | `claude`; `[claude, codex]` | `builder_providers` holds `anthropic`; a cross-vendor review by `codex` at the merged head; merged. |
| `live cross-vendor: codex builds Story 1.6, claude reviews it, …` | `codex`; `[claude, codex]` | `builder_providers` holds `openai`; a cross-vendor review by `claude` at the merged head; merged. |
| `live cross-vendor: a later agent change after a passed review …` | `claude`; `[claude, codex]` | The first enqueue, at H1 after a passing review at H1, is held by the test, so the queue read sees the PR ejected (`attempts` ≥ 1). A failing `xarabot-verify` check on H1 and its log, asking for one more line in `verify/<key>.md`, make a real CI-fix session (`ci_fixes` ≥ 1). Its push of H2 is reviewed again, passing, before the enqueue at H2, and H2 ≠ H1 merges. |
| `live cross-vendor: a claude-only policy …` | `claude`; `[claude]` | A same-vendor review by `claude`, at the lane's model and effort `low`, at the merged head, and the PR merges on its required check. The lane's `review` folder is a checkout of its own, separate from `clone`, whose `HEAD` is that SHA and whose `core.hooksPath` is `/dev/null`. |

A real reviewer may block and send the unit through a loopback session; that
is allowed, as long as the gate holds and the unit merges. After each case
the test prints one line, `cross-vendor <case>: <key> PR #<n> merged at
<sha>; …`, followed by the first line of each review the lane posted. Record
those lines.

A failed assertion starts `step "<name>":` and names the step, followed by
the lane's output, the recorded events and alerts, and the tail of each unit
log. Fix the cause and run the suite again; the scratch branches were already
deleted.

**The skip rule.** Without the three variables, or inside a sandbox
(`XARABOT_SANDBOXED=1`), the four live cases report skipped, never passed:
`85 pass`, `4 skip`, `0 fail`. That is not evidence. The four cases are also
rehearsed against the fake forge in every `bun test`, through the real lane
process and the real PR, CI, review-gate and merge steps; only the GitHub,
CLI and sandbox wiring is live-only. Two more rehearsals run there and have no
live case (Epic 3 retro item 9). In `flagged-spec`, a spec that recommends a
follow-up review gets a review and then a follow-up review at the merged
head. In `loopback`, a blocking review's findings reach a loopback session,
and its fix is pushed and reviewed again before the enqueue.

### Story 3.1's sandbox cases and the codex live commands

Run the three commands of "The codex live evidence" above, with the same
expected results, and record what they print. Then, until the macOS CI job
runs the sandbox suites (the Story 2.5c deferral, Epic 1 item 13), run the
whole sandbox suite on the host as its own evidence row:

```sh
bun test test/sandbox/
```

**Expected result:** the counts of the `bun test test/sandbox/` rows of "The
sandbox suites" table above, with `0 fail`. On the host, outside a sandbox,
every nested `sandbox-exec` case runs and passes; the only skips are that
table's live cases (its `XARABOT_LIVE=1` row runs them too). Record the
counts. If a
nested case is skipped on the host, stop and investigate, as in "The sandbox
suites".

### Committing the evidence

Commit the results as `docs/maintainer/evidence/epic-3.md` in a Maintainer PR
from a `planning/<topic>` branch, and merge it before Epic 3's retro.
Builders are refused any change to this file (`live-evidence`), so only you
write it. The file holds:

- the date, the host, the `main` commit (and its tag, if any) the checkout was at, `bun --version`, `claude --version` and `codex --version`;
- each command of this section, exactly as run, with its summary lines (`pass`, `skip` and `fail` counts) and how long it took: the cross-vendor suite, the three codex commands and `bun test test/sandbox/`;
- the lines the cross-vendor cases and `codex-live.test.ts` printed;
- for any run that failed: the failing `step "<name>":` line, what you changed, and the re-run that passed. Never replace a failed result silently.

### The switch after Epic 3

Once Epic 3 has merged and its evidence file is on `main`, in this order:

1. **Drop the every-path approval rule.** In a Maintainer PR, remove `owner_approval_paths: ["**"]` from `.xarabot/policy.yaml`. The Protected Paths stay gated.
2. **Allow the adapters unattended.** In the same PR, set `unattended_adapters: [claude, codex]`. Codex may then review unattended, but install no `agent: codex` builder lane until you have recorded one real Story or retro item built by a codex lane with the real `bmad-build-auto` (Epic 3 retro item 18).
3. **Confirm lane item 23 is done.** `epic-2-retro-item-23-harden-the-lane-lock` (the lane-lock hardening) must be `status: done` in `_bmad-output/implementation-artifacts/retro-gates.yaml` on `main`. Until it is, keep the limit at 1:

   ```sh
   grep -A6 'id: "epic-2-retro-item-23-harden-the-lane-lock"' _bmad-output/implementation-artifacts/retro-gates.yaml | grep status
   # expected: status: done
   ```

4. **Raise `XARABOT_MAX_BUILDERS`**, as "Several builder lanes" (in "While Epic 2 is built") describes.
5. **Run the 24-hour check**: a coordinator and 2 builders for 24 hours, as "After Epic 3: lifting the builder limit" describes. If it fails, set the limit back to 1.

Dropping the every-path rule makes status planning PRs ungated, and so
disposable, like `reconcile`'s own PRs: one that goes stale or is ejected is
closed and replaced instead of parking for your approval. That settles the
stale gated status planning PR that Story 2.7's spec (`spec-2-7`) accepted
until this switch. The "Several builder lanes" drain step waits for the PID
in the lane's `lane.lock` to be gone, not for a missing `lane.lock` or a
written `outcome`.

## Globs cover tests and wiring: `glob_coverage` (Epic 3 retro item 14)

Most units that parked for you on 2026-10-26 to 27 parked over globs: a
manifest or a lane retro item named a `src/` path but not its tests, or not
the wiring files its kind of change needs. The optional `glob_coverage` table
in `.xarabot/config.yaml` states which globs each glob needs beside it in the
same list. Nothing of any repo's layout is built in: with no `glob_coverage`
key the rule is off everywhere. With it:

- `xarabot graph check` prints, after its other warnings, one
  `warning: Story <id> (<manifest>) globs miss ...` line for each manifest
  whose globs miss a glob the table needs, naming each missing glob and the
  glob that needs it. It only warns: the exit code stays 0, so manifests
  already on `main` keep CI green.
- A retro's result check refuses each `lane` item whose globs miss a glob the
  table needs (on fresh `main`'s tree), as a failed attempt naming the item
  and each missing glob, before anything is committed. The retro runs again,
  and its prompt states the table, so the session can fix the globs. A
  `maintainer` item is never refused for coverage.
- The graph planning prompt (when manifests carry `globs`, not a
  `manifests.path_key`) and the retro prompt state the table, generated from
  your config, for the globs they write.

The shape, with Xarabot's own table as the example:

```yaml
glob_coverage:
  tests:              # each glob's tests
    - path: "src/<p>.ts"
      test: "test/<p>.test.ts"
    - path: "src/<dir>/**"
      test: "test/<dir>/**"
  wiring:             # the wiring files a known kind of change needs
    - path: "src/ports/forge.ts"
      needs: ["test/ports/forge.test.ts", "test/contracts/forge.contract.ts", "src/adapters/forge/**"]
    - path: "src/ports/<x>.ts"
      needs: ["test/ports/<x>.test.ts"]
      needs_if_present: ["test/contracts/<x>.contract.ts"]
    - path: "src/lane/<x>-step.ts"
      only_new: true
      needs: ["src/cli/lane-run.ts", "test/cli/lane-run.test.ts"]
```

- Set `tests`, `wiring` or both; each, when set, lists at least one row. No
  other key is allowed, at either level.
- A row's `path` is matched against each glob of the list as text. A
  `<name>` placeholder (a letter, then letters, digits or `_`) stands for one
  or more characters of any kind, `/` included; every other character matches
  only itself, so `src/<p>.ts` matches `src/core/a.ts` and `src/core/*.ts`,
  but a `*` in a row's `path` matches only a `*` in the glob. The needed
  globs get the same text for each placeholder: `src/core/*.ts` needs
  `test/core/*.test.ts`. Every placeholder a needed glob uses must be in its
  row's `path`, at most once, and no two placeholders may sit side by side.
- A `tests` row has exactly `path` and `test`. A `wiring` row has `path`,
  then `needs` (needed always), `needs_if_present` (needed only when the
  tree, the working tree for `graph check` and `main` for a retro, has a file
  the glob matches) or both, and `only_new: true` to apply the row only when
  the matched glob is a literal path the tree does not have yet (a new file).
- Every pattern is a repo-relative glob: no leading `/`, `./`, `!` or `~`,
  no `.` or `..` segment, no backslash, backtick or control character, and
  no `<` or `>` outside a placeholder.
- A needed glob counts as listed when the list holds it or a glob that
  matches it: `test/**` covers `test/a.test.ts` and `test/a/**`. A missing
  glob's own needs are needed too: the Forge row's `src/adapters/forge/**`
  also needs `test/adapters/forge/**`.

Add the key in a Maintainer PR, and only once every lane's `runner_version`
knows it: an older runner refuses the unknown key and stops on bad config.

## Epic 4's live evidence (Story 4.7)

Epic 4's retro (`retro:4`) waits until `docs/maintainer/evidence/epic-4.md`
is on `main`. Run the commands below on the Xarabot host as
`edanisko-xarabot`, outside any sandbox (`XARABOT_SANDBOXED` must be unset),
from `~/xarabot-switch`, a checkout of a `main` commit that has Story 4.7.
Update it and note its commit first, as for Epic 3:

```sh
git -C ~/xarabot-switch pull --ff-only && cd ~/xarabot-switch && bun install --frozen-lockfile
git rev-parse HEAD
```

### Before the run

**No re-seed is needed** beyond the canary's ("The canary" above). The suite
lays its own Xaravel-shaped graph over the scratch `main`: Epics 1 to 8
bootstrapped (8 a checkpoint after 7), then `runtime` (9), `contracts` (10),
`macroable`, `conditionable` and `json-schema` (11 to 13, each after 10) and
`tooling` (14, after 9), each with two Stories on `packages/<slug>/**`. It
hides every scratch path under `_bmad-output/` and `stories/` and
`.xarabot/epics.yaml`, and takes the rest from the scratch `main`: the
policy (`expected_checks: [check]`), the Standing Authority and the CI
workflow. The `edanisko-xarabot` App credentials are the canary's, with the
issue permissions the inbox already needs (Story 4.2).

Both cases use your inbox on the scratch repo: the lowest-numbered open
`xarabot-inbox` issue assigned to you (`reconcile` opens one if there is
none). Its body is rewritten by each case; that is expected. Run this suite
alone on the scratch repo, never alongside the canary, the claims race or
the cross-vendor suite: they share that inbox. Afterwards your scratch inbox
body keeps the fixture digest until the next real `reconcile` run rewrites
it.

### The parallel Epics suite

Each live case runs the real coordinator process with the real `reconcile`
step (no agent session) against a fresh ledger branch `xarabot/test-<uuid>`,
with its branches under `xarabot-test/<uuid>/`, and builders claim through
the real `next` and the lane's own claim edits on that ledger. The rulings
read, the 🤖 ack, the inbox issue, the ledger swaps and the `reconcile` PR
with its CI run are real. Only the merge is simulated: the PR's enqueue is
held, and the `retro-gates.yaml` it committed is laid over `main` in the
test, so nothing reaches the scratch `main` and the canary and cross-vendor
runs never see the fixture. The PR is closed and the branches deleted when
the case ends, whether it passes or fails. Alerts are recorded by the test,
not posted; a recorded alert fails the case.

A run cut short by Bun's per-test timeout or by Ctrl-C skips that cleanup
and can leave the `xarabot/test-<uuid>` and `xarabot-test/<uuid>/…`
branches and an open `reconcile` PR behind. The claims race suite's command
lists the branches; delete them by hand. To find and close a leftover PR:

```sh
gh pr list --repo xaravel/xarabot-scratch --state open --json number,headRefName --jq '.[] | select(.headRefName | startswith("xarabot-test/")) | .number'
gh pr close --repo xaravel/xarabot-scratch <number>
```

```sh
XARABOT_LIVE=1 XARABOT_LIVE_GITHUB_REPO=xaravel/xarabot-scratch XARABOT_LIVE_GITHUB_LOGIN=edanisko bun test test/e2e/parallel-epics.test.ts
```

**Your step during the checkpoint case.** After its first coordinator round
the test prints

```text
live gates: comment "/xarabot go checkpoint:10" on <issue url> within 15 minutes
```

Open that issue and post this comment from your own account, exactly, with
nothing else in it:

```text
/xarabot go checkpoint:10
```

Only a comment from the Maintainer's own account counts, so the test never
posts it for you. Past 15 minutes the case fails at the step `the
Maintainer's comment`. The test then waits until `reconcile` is due again
(10 minutes after the first run, polled every 30 s, at most 12 minutes)
before its second round.

**Expected result** (expected counts, not yet measured on the host):
`67 pass`, `0 skip`, `0 fail`, in an estimated 15 to 35 minutes, most of it
the wait for your comment and for `reconcile` to be due again. The digest case has a 10-minute timeout and the checkpoint case 45
minutes. The scratch cases:

| Case | World | Expected |
|---|---|---|
| `live gates: the digest …` | Epics 9 and 10 done; Epic 9's retro `rejected` with no go and a `waiting` item routed to you; Epic 10's retro `accepted-with-open-items`, a checkpoint with no go, and an `open` blocking item routed to you; `story:14.1` parked blocked `intent-gap` with text, `story:11.1` `needs-approval`, `story:12.1` blocked `human-live-step`; `spec-9-1-runtime.md` with one deferred entry. Each item dated whole days and 6 hours back. | After one coordinator round your inbox reads `🤖 Xarabot inbox: 8 items wait on you.` and lists exactly `checkpoint:10`, `retro:9`, the two retro items, the three units and `9.1-d1`, each once, with its link and its age in whole days (`<1d` for `story:11.1`). No PR is opened. The three units' links point at `xarabot/claims`, the digest's fixed ledger branch, while the case's records live on its test ledger branch: those links are checked as text and do not resolve during the run. |
| `live gates: the checkpoint go …` | Epics 9 and 10 done with `accepted` retros; Epic 10 a checkpoint with no go. | Before the go, only `story:14.1` is claimed, and round 1's inbox lists `checkpoint:10`. After your comment, round 2 stores the pending go `{go, checkpoint:10, by: you, at: the comment's time, ruling: its id}` in `coordinator.json`, replies ``🤖 Ruling acknowledged: `/xarabot go checkpoint:10` from edanisko``, opens its PR whose `retro-gates.yaml` sets `epics.10.checkpoint.go` (CI `check` passes; the enqueue is held), and leaves your inbox `🤖 Xarabot inbox: nothing waits on you.` Once that file is laid over `main`, builders claim `story:11.1`, `story:12.1` and `story:13.1`. |

After each case the test prints one line: `live gates: digest: inbox #<n>,
PR none, comment none; 8 items`, or `live gates: checkpoint go: inbox #<n>,
PR #<n>, comment <id>`. Record those lines. A failed assertion starts
`step "<name>":` and names the step, or lists every way the case broke its
check. Fix the cause and run the suite again; a case that ended normally,
passed or failed, already closed its PR and deleted its branches.

**The skip rule.** Without the three variables, or inside a sandbox
(`XARABOT_SANDBOXED=1`), the two live cases report skipped, never passed:
`65 pass`, `2 skip`, `0 fail`, measured in a sandboxed session. That is not
evidence. A missing App credential with the switch on fails the step `the
live area`; it never skips. Every `bun test` runs the rest: every fixture row
of the Story's gates matrix on the fake forge (parallel Epics, dependency,
checkpoint, rejected retro and retro item holds, the go and block rulings),
the two checks' case tables, and both cases rehearsed on the fake forge
through the same coordinator process, `reconcile` step and builder claims.

### Committing the evidence

Commit the results as `docs/maintainer/evidence/epic-4.md` in a Maintainer
PR from a `planning/<topic>` branch, and merge it before Epic 4's retro.
Builders are refused any change to this file (`live-evidence`), so only you
write it. The file holds:

- the date, the host, the `main` commit (and its tag, if any) the checkout was at, and `bun --version`;
- the command above, exactly as run, with its summary lines (`pass`, `skip` and `fail` counts) and how long it took. Record only a run that shows `0 skip`: a skipped run also ends `0 fail`, and the `live_evidence_checks` gate below cannot tell the two apart;
- the two `live gates:` lines the cases printed, and the URL of your `/xarabot go checkpoint:10` comment;
- for any run that failed: the failing `step "<name>":` line or the listed problems, what you changed, and the re-run that passed. Never replace a failed result silently.

To make Epic 4's retro wait for the live result too, not just the file, add
the command to `live_evidence_checks` in `.xarabot/config.yaml`, in a
Maintainer PR:

```yaml
live_evidence_checks:
  "4": ["XARABOT_LIVE=1 XARABOT_LIVE_GITHUB_REPO=xaravel/xarabot-scratch XARABOT_LIVE_GITHUB_LOGIN=edanisko bun test test/e2e/parallel-epics.test.ts"]
```

Keep any other Epic's entries. The retro is then due only once the evidence
file holds that command with a `0 fail` summary after it, so a failed live
row holds `retro:4`. The gate looks only for `0 fail`, so it is your record
of a `0 skip` run that makes the row evidence. As for Story 2.9, set
`live_evidence_checks` only once every lane's pin has this check: an older
runner refuses the unknown key and stops on bad config.
