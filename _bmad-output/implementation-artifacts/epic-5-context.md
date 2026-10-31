# Epic 5 Context: Each human runs lanes as their own bot
<!-- source: sha256:4cc260c0207938aa24c91f8729cfd6d588da35d66ab71513341ac76a7fd50fa7 -->

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Any human can run Xarabot lanes as their own bot. `xarabot join` creates that person's `<login>-xarabot` GitHub App from a manifest with one confirm click, stores its key for the runner, installs the App on the repo's org or requests the install, and checks that the installation reaches the repo. It replaces `bootstrap/join.ts`. The GitHub adapter names the App permission behind every call it makes, so each App asks for exactly what Xarabot uses. The Epic ends with live proof that the bot can neither approve nor force a merge, and that its owner's approval alone clears its Protected Path PRs.

## Stories

- Story 5.1: `xarabot join` creates the owner's App
- Story 5.1a: The GitHub adapter's permission table
- Story 5.2: Installing the App and checking its reach
- Story 5.3: Owner approvals and bot rights verification

## Requirements & Constraints

- **One bot per human.** The App is owned by the person's own account, is named `<login>-xarabot` and acts as `<login>-xarabot[bot]`. Lanes never act as a shared bot, an org-owned App, a bot user account or a human. Every lane-made commit, push and PR is authored by the owner's bot, with no co-author or "generated with" markers.
- **No long-lived tokens.** The runner mints 1-hour installation tokens from the App key on demand and keeps them in memory only. `xarabot join` never prints the key.
- **Key storage.** `private-key.pem` (mode 600, in a folder of mode 700) and `app.json` (App ID, slug, owner) live at `$XDG_CONFIG_HOME/xarabot/apps/<login>-xarabot/`, falling back to `~/.config`.
- **Exact permissions.** The App asks for exactly `contents: write`, `pull_requests: write`, `issues: write`, `checks: read`, `statuses: read`, `actions: read` and `metadata: read`. It has no merge-queue permission (none is needed), no `administration`, no `workflows` and no bypass or approve right. An existing App whose permissions differ from this set in either direction, missing or extra, stops `join`, which names each permission to add or remove in the App's settings (a Human Live Step), because the API cannot change an App's permissions.
- **Installation.** "All repositories" is the default, so later repos adopt Xarabot with no GitHub step. A caller who is not an org owner gets an install request that an owner approves, and a re-run picks it up. A selected-repositories installation that does not cover the repo stops `join` with the repo to add and where, and a lane start for that repo is refused. Permissions the installation has not yet accepted also stop `join`, naming each one and the org owner who must accept it.
- **Merge authority.** A PR touching no Protected Path merges on its required checks and the cross-vendor review. A Protected Path PR needs its owner's approving review, and that approval clears it at once. The bot's own approval never counts, and Xarabot never issues an admin merge or bypasses required checks.
- **Waits.** Every wait in `join` is a killable sleep with a deadline. No `timeout` binary is ever called.
- **Tests.** CLI tests run against a fake GitHub and cover the create, re-run, missing-permission, extra-permission, install, install-request, uncovered-repo and pending-acceptance paths. A test pins the manifest's permission set. Live cases need `XARABOT_LIVE=1` and report skipped, never passed, inside a sandboxed session.

## Technical Decisions

- **Manifest flow.** `join` serves the manifest on `127.0.0.1`, opens GitHub's manifest page, checks the callback's `state`, and converts the code into the App. The manifest is public, so other orgs can install the App, and it has no webhook.
- **One implementation.** JWT minting and installation tokens reuse the GitHub adapter's existing code. There is no second copy in `join`.
- **One request function and one operation table.** Every REST and GraphQL call in the GitHub adapter goes through a single request function that takes an entry from one table in the adapter, naming the operation and the App permission it needs. No other adapter code calls `fetch`. The table lists:
  - `metadata: read`;
  - git pushes under `contents: write`, even though they go through the credential helper;
  - `join`'s manifest conversion and App-JWT calls as needing no installation permission;
  - two public no-credential calls, the bot user lookup and the CI log download from GitHub's signed URL. The signed download must never carry the token.
- **The permission test** fails if an operation needs a permission the manifest lacks, or a higher level than it asks for, and also if the manifest asks for a permission no operation needs.
- **Only calls made today.** The table lists only the calls the adapter makes now. The `administration: read` branch-protection reads, which the App never has, arrive later with the consumer prerequisite checks, together with the test's exemption for them. The adapter's table must match the architecture's permission table. Raise any difference to the Maintainer; never settle it in a Story.
- **The bot cannot approve.** The `Forge` port has no approve operation, and no source path submits an approving review, does an admin merge or bypasses checks. Tests assert this against the port and the GitHub adapter.

## Cross-Story Dependencies

- 5.1 builds on the GitHub adapter's tokens (Story 1.8). 5.1a and 5.2 need 5.1. 5.3 comes last and needs 5.1a and 5.2.
- Epic 5 depends on Epic 4 and runs in parallel with Epic 6. Stories 5.1, 5.1a and 5.2, and Epic 6's status and report Stories, all touch `src/adapters/forge/github/**`, so claims serialize them, while the graph keeps the two Epics parallel.
- Story 5.3's precondition is a Human Live Step. App names are global and `edanisko-xarabot` already exists, so a second GitHub account runs `xarabot join` through the browser confirm click, creates `<that-login>-xarabot` and installs it on a test org's repo whose Protected Path requires the owner's review. That account is the owner whose review clears the PR. 5.3 records its live command and expected results in `docs/maintainer/self-host.md`, and the Maintainer runs them on the host, outside the sandbox, before Epic 5's retro.
- When 5.1 is done, `bootstrap/join.ts` is removed and `docs/maintainer/self-host.md` points to `xarabot join`.
- Every path in Xarabot's own repo still needs the Maintainer's approving review. Merged code takes effect only after the Maintainer advances `runner_version`.
