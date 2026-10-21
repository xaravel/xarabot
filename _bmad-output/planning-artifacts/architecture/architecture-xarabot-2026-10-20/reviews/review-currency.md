---
review: currency
target: ARCHITECTURE-SPINE.md (architecture-xarabot-2026-10-20)
reviewed: 2026-10-21
lens: Each committed decision was checked against the web or the local machine, not asserted from training data
host: macOS 27.0.1 (26A434), the Xarabot host laptop
---

# Currency review: Xarabot architecture spine

## Verdict

**Pass with corrections.** Most of the stack and most of the CLI and API facts the ADs depend on are current, and this review confirmed them against registries, GitHub docs and local `--help` output. The spine has one stale pin (pi). It also has two places where a fact is right but the decision does not fit it as written:

- **TS7 and oxlint launchers.** Both run through Node unless they are started with `--bun`.
- **AD-23 pinned issue.** There is no REST endpoint for pinning an issue, GitHub does not document whether an App can use the GraphQL pin mutation, and a repository can pin at most 3 issues.

Several facts were not recorded in `.memlog.md` as verified. This review has now checked them (see the table).

## Method

- Registries: `curl https://registry.npmjs.org/<pkg>` for dist-tags and publish times. GitHub releases API for Bun, bubblewrap and codex. Homebrew formula API for pi and bubblewrap.
- Local: `--version` and `--help` of `bun`, `claude`, `codex`, `pi`, `gh`, `sandbox-exec`. A throwaway `/tmp/ts7run` project installed with `bun add -E typescript@7.0.2 oxlint@1.89.0 zod@4.6.7` and run (no npm and no node used directly). A Seatbelt nesting test with `sandbox-exec`.
- Web: docs.github.com (git refs REST, the App permissions table, rulesets, installation tokens, the GraphQL Issues reference, issue pinning, merge queue), bun.com docs, and the pi changelog.
- No agent sessions were started.

## Stack table

| Row | Spine | Found | Status | Source |
| --- | --- | --- | --- | --- |
| Bun | 1.4.3 | 1.4.3 is the latest GitHub release (2026-10-10) and is installed | Confirmed | https://github.com/oven-sh/bun/releases/tag/bun-v1.4.3 |
| TypeScript | 7.0.2 | npm `latest` = 7.0.2 (2026-07-08); `beta` 7.1.0-beta. `bin` = `tsc`. `tsc --version` → `Version 7.0.2` under Bun | Confirmed, with a fit issue (F-1) | https://registry.npmjs.org/typescript |
| `--strict` | required | `tsc --help --all`: `--strict … default: true` in TS7 | Confirmed (the flag is redundant but harmless) | local `tsc --help --all` |
| oxlint | 1.89.0 | npm `latest` = 1.89.0 (2026-10-19); `oxlint --version` → 1.89.0 | Confirmed, with the same launcher issue (F-1) | https://registry.npmjs.org/oxlint |
| zod | 4.6.7 | npm `latest` = 4.6.7; `z.toJSONSchema` present; `safeParse` works under Bun | Confirmed | https://registry.npmjs.org/zod |
| claude CLI | 2.1.306 | `claude --version` → 2.1.306. npm `latest` = `next` = 2.1.306, published 2026-10-21T02:28Z. **`stable` = 2.1.304** | Confirmed; the channel is not decided (F-3) | https://registry.npmjs.org/@anthropic-ai/claude-code |
| codex-cli | 0.163.0 | npm `latest` = 0.163.0 (GitHub release 2026-10-15). **Installed: 0.162.1**, and the flags were read from 0.162.1 | Version confirmed; the flags are confirmed only on 0.162.1 (F-4) | https://github.com/openai/codex/releases/tag/rust-v0.163.0 |
| pi | 1.2.0 | Installed: Homebrew `pi-coding-agent` 1.2.0. **npm `@earendil-works/pi-coding-agent` `latest` = 1.3.0 (2026-10-15); Homebrew stable = 1.3.0** | **Stale** (F-2) | https://registry.npmjs.org/@earendil-works/pi-coding-agent, https://formulae.brew.sh/api/formula/pi-coding-agent.json, https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md |
| bubblewrap | 0.13.1 | GitHub latest v0.13.1 (2026-10-14); Homebrew 0.13.1. `.memlog.md` has no `version` entry for this (it records only "bwrap not installed") | Confirmed by this review | https://github.com/containers/bubblewrap/releases/tag/v0.13.1 |
| sandbox-exec | system | Present at `/usr/bin/sandbox-exec` on macOS 27.0.1 and works. The man page heading says **"(DEPRECATED)"** | Confirmed; a deprecation risk (F-7) | local `man sandbox-exec` |

## AD-level facts

| AD | Claim | Found | Status | Source |
| --- | --- | --- | --- | --- |
| AD-4 | `PATCH /repos/{o}/{r}/git/refs/{ref}` with `force: false` refuses a non-fast-forward | The `force` docs say "Leaving this out or setting it to false will make sure you're not overwriting work". Default `false`. Responses 200, 409, 422 | Confirmed (see F-10 on error handling) | https://docs.github.com/en/rest/git/refs#update-a-reference |
| AD-4 | Needed App permission | Listed under **Contents: write**, and also under **Workflows: write** | Confirmed; `join.ts` grants `contents: write` (see F-9) | https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps |
| AD-4 | A ruleset can protect `xarabot/claims` against force-push and deletion without requiring PRs | "Restrict deletions", "Block force pushes" and "Require a pull request before merging" are separate rules. The first two are on by default and do not depend on the PR rule. Rulesets target branches and tags only (memlog, 2026-10-21) | Confirmed (see F-11) | https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets |
| AD-4 | Fast-forward-only works as a CAS | It holds if every ledger commit has the fetched tip as its only parent. A second writer's commit from the same tip is then not a fast-forward of the first and is refused | Reasoning check, OK | n/a |
| AD-21 | `claude --effort` | `--effort <level>  Effort level for the current session (low, medium, high, xhigh, max)` | Confirmed (2.1.306) | local `claude --help` |
| AD-21 | `pi --thinking` | `--thinking <level>  Set thinking level: off, minimal, low, medium, high, xhigh, max`. Each model can offer fewer levels (pi 1.3.0 changelog: some Xiaomi MiMo models offer only off and high) | Confirmed. The AD-21 start check ("not offered by that adapter and model") is needed for pi | local `pi --help`; pi CHANGELOG |
| AD-21 | `codex -c model_reasoning_effort=` | `codex exec -c, --config <key=value>` exists. The user config uses `model_reasoning_effort = "xhigh"`. Model cache: gpt-6.1-sol low…max plus `ultra`; gpt-6-luna and gpt-5.6-luna low…max | Confirmed (0.162.1). The values low, medium, high, xhigh and max exist in all three CLIs | local `codex exec --help`, `~/.codex/models_cache.json` |
| AD-17 | `sandbox-exec` works on current macOS | Runs on 27.0.1 with a generated profile | Confirmed (also in memlog) | local |
| AD-17 | Seatbelt cannot nest, so the inner sandboxes of codex and claude must be off | **Tested by this review.** Inside an outer profile that has any restriction (`deny file-write*` on one path, or `deny default`), a nested `sandbox-exec` fails: `sandbox_apply: Operation not permitted`, rc 71. Under a bare `(allow default)` outer profile, nesting succeeds. In `.memlog.md` this was stated, not tested | Confirmed | local test |
| AD-17 | The agents' own sandboxes can be turned off | codex: `--sandbox danger-full-access` and `--dangerously-bypass-approvals-and-sandbox` exist. Claude's sandbox is opt-in through `--settings`. codex 0.163.0 notes say its Linux sandbox is bubblewrap, so on Linux it must be off inside our `bwrap` too | Confirmed | local `codex exec --help`; codex 0.163.0 release notes |
| AD-17 | `bwrap` on Linux | 0.13.1 is current. It is not installed on this host and was not run here. AppArmor and packaging are deferred in the spine | Version confirmed; behaviour not run | GitHub releases |
| AD-17 | Network goes only through "Xarabot's Bun proxy" with a hostname allowlist | Not verified. Bun has raw TCP (`Bun.listen` and `Bun.connect`), so a CONNECT tunnel is feasible, but no spike was run and `.memlog.md` records none | **Not confirmed** (F-6) | n/a |
| AD-23 | `issues: write` exists and lets the App edit the issue body | `PATCH /repos/{o}/{r}/issues/{n}` is listed under **Issues: write** | Confirmed | https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps |
| AD-23 | The App can pin the inbox issue | No REST endpoint pins an issue (only `PUT …/issues/comments/{id}/pin`). The GraphQL `pinIssue(input:{issueId})` mutation exists, but its docs do not say who may call it or whether App installation tokens may. The UI docs say people with write access can pin, up to **3 pinned issues per repository** | **Not confirmed** (F-5) | https://docs.github.com/en/graphql/reference/issues, https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues/pinning-an-issue-to-your-repository |
| AD-26 / join.ts | Installation token lifetime | "The installation access token will expire after 1 hour." | Confirmed. Long CI waits and usage-limit sleeps (up to 8 h) need a new token after each wait, which AD-26's "minted on demand" already covers | https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app |
| AD-27 | `Bun.YAML` and `Bun.Glob` in Bun 1.4 | Bun 1.4.3: `Bun.YAML.parse`, `Bun.YAML.stringify` and `Bun.Glob` are functions. `Bun.YAML.parse("a: 1\nb: [x, y]")` returns `{"a":1,"b":["x","y"]}`. `new Bun.Glob("src/**/*.ts").match(...)` behaves as expected | Confirmed | local |
| AD-19 | The merge queue is used for every merge | GitHub (GA changelog) says the merge queue is available on all public repositories owned by organizations, and on private repositories on Enterprise Cloud. `xaravel/xarabot` is public and owned by an organization, so it is eligible | Confirmed for Xarabot; a fit risk for other consumers (F-8) | https://github.blog/changelog/2023-07-12-pull-request-merge-queue-is-now-generally-available/ |

## Findings: not confirmed, stale or wrong

**F-1. TS7 `tsc` and `oxlint` start through Node by default under Bun (medium).**

- The `tsc` binary name is correct for TS7 (`"bin": {"tsc": "./bin/tsc"}`). But `bin/tsc` and `lib/tsc.js` begin with `#!/usr/bin/env node`. The launcher then execs the native Go binary from `@typescript/typescript-<platform>`.
- `oxlint`'s `bin/oxlint` also begins with `#!/usr/bin/env node`.
- Bun docs: "Bun respects this shebang and executes the script with `node`", and `--bun` forces Bun.
- The Xarabot host has Node (`~/.nvm/.../v22.21.1`) on PATH. So `bun run tsc` or `bunx tsc` runs the launchers under Node, which goes against the Node-free toolchain rule.
- `bun --bun ./node_modules/.bin/tsc --version` and `bun --bun x tsc --version` both work (`Version 7.0.2`).
- Correction: in Consistency Conventions, "Lint and types", state that both are run as `bun --bun tsc` and `bun --bun oxlint`, or in `package.json` scripts with `bun --bun run`.
- Also: in TS7 `--strict` defaults to `true`. Keep the flag only as documentation.
- Source: https://bun.com/docs/cli/run

**F-2. pi 1.2.0 is stale; 1.3.0 is current (low to medium).**

- npm `@earendil-works/pi-coding-agent` `latest` = 1.3.0 (2026-10-15), and Homebrew stable is also 1.3.0. Only the host's Homebrew install is 1.2.0. `.memlog.md` recorded the installed version, not the latest.
- 1.3.0 fixes "`--model` choosing a provider by catalog order when several providers offer the match", which matters to an adapter that passes `--model`.
- Correction: pin 1.3.0, and re-check `pi --help` (`--thinking`, `--mode json`, `-p`) on 1.3.0.
- Sources: https://registry.npmjs.org/@earendil-works/pi-coding-agent, https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md

**F-3. The claude 2.1.306 pin is the `latest`/`next` build from 2026-10-21; `stable` is 2.1.304 (low).**

- The pin is current, but npm publishes a separate `stable` channel.
- Correction: decide which channel a pinned adapter target follows, and record it in `.memlog.md`.
- Source: https://registry.npmjs.org/@anthropic-ai/claude-code

**F-4. codex 0.163.0 is pinned, but every flag fact was read from the installed 0.162.1 (low).**

- The 0.163.0 release notes show no change to `-c`, `model_reasoning_effort`, `--sandbox`, `--json` or `--output-schema`. They do say the Linux sandbox is bubblewrap plus seccomp, and that codex no longer bundles a patched zsh.
- Correction: upgrade the host to 0.163.0 and re-run `codex exec --help` before the codex adapter Story.
- Source: https://github.com/openai/codex/releases/tag/rust-v0.163.0

**F-5. AD-23: it is not confirmed that the App can pin the inbox issue, and "one pinned issue per owner" conflicts with GitHub's limit of 3 pinned issues (medium).**

- `issues: write` covers creating issues, editing the body (`PATCH /issues/{n}`) and comments. That part is confirmed.
- No REST endpoint pins an issue; REST pins only issue comments. The GraphQL `pinIssue` mutation exists, but its docs do not say whether an App installation token may call it.
- A repository can pin at most 3 issues. With more than 3 owners (CAP-14 team onboarding), or if the repository already pins issues, "one pinned issue per owner" cannot be met.
- Correction, choose one:
  - Run a live test of `pinIssue` with an installation token before the inbox Story.
  - Or make pinning a one-time Human Live Step.
  - Or drop "pinned" for "one labelled issue per owner".
  - In every case, state what happens past 3 owners.
- Sources: https://docs.github.com/en/graphql/reference/issues, https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues/pinning-an-issue-to-your-repository, https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps

**F-6. AD-17: the "Bun proxy" hostname allowlist has not been tested (low to medium).**

- `.memlog.md` rejects srt partly because Seatbelt filters network traffic only by address and port. That makes the proxy the only hostname boundary, and nobody has tested that a Bun CONNECT proxy works with each agent's HTTP client (`HTTPS_PROXY` handling in claude, codex and pi).
- The primitives (`Bun.listen`, `Bun.connect`) exist. This review did not run a spike.
- Correction: add a `[ASSUMPTION]` tag, or a spike in the sandbox Story that runs each CLI through the proxy and confirms that a denied host fails.

**F-7. `sandbox-exec` is marked DEPRECATED in its man page (low; watch).**

- It still works on macOS 27.0.1, and Claude Code and codex both still depend on Seatbelt. It is still a platform risk that AD-17 does not mention.
- Correction: add a note under Deferred or AD-17 to re-test on each macOS major release.
- Source: local `man sandbox-exec`.

**F-8. AD-19: the merge queue is not available to every consumer (low for 0.x; fit).**

- The merge queue works only on public repositories owned by organizations, and on Enterprise Cloud private repositories. Personal-account repositories, and private repositories on Free or Team plans, cannot use it.
- Correction: state that the merge queue is a consumer prerequisite. Otherwise SPEC § Constraints ("no platform assumptions") is broken quietly.
- Source: https://github.blog/changelog/2023-07-12-pull-request-merge-queue-is-now-generally-available/

**F-9. The App lacks `workflows: write` (low; informational).**

- `PATCH git/refs`, and any push of a commit that changes `.github/workflows/*`, needs **Workflows: write**. The manifest in `bootstrap/join.ts` does not grant it, so a unit whose diff touches workflows fails at push.
- This may be intended (`.github/` is Maintainer-only). If so, record it, so the failure is reported as a guard refusal and not as a failed attempt.
- Source: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps

**F-10. AD-4: distinguish CAS rejection from other errors (low).**

- The docs list 409 and 422 ("Validation failed, or the endpoint has been spammed") and do not give the exact non-fast-forward error.
- Correction: the GitHub forge contract suite should pin which status and message mean "retry the CAS" (normally 422 "Update is not a fast forward"), so that secondary rate limits ("spammed") and other validation errors are not retried in a loop.
- Source: https://docs.github.com/en/rest/git/refs#update-a-reference

**F-11. AD-4 ruleset Human Live Step: check rulesets that already exist (low).**

- A consumer ruleset that targets `~ALL` branches with "Restrict updates" or "Require a pull request" would block the App's ledger writes, because the App has no bypass (AD-26).
- Correction: the Human Live Step should also confirm that no other ruleset matches `xarabot/claims`.
- Source: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets

## Facts this review confirmed that `.memlog.md` did not record as verified

- bubblewrap 0.13.1 (memlog: "bwrap not installed", no version source).
- Seatbelt cannot nest (stated in a memlog decision, never tested). Tested here.
- `claude --effort` values and `pi --thinking` values. Memlog has `version` entries only for codex effort.
- The 1-hour installation token lifetime (AD-26 adopted it from `join.ts`).
- That ruleset rules are independent of "Require a pull request".
- `Bun.YAML` and `Bun.Glob` behaviour, beyond being present.
- The TS7 binary name `tsc` and its Node-shebang launcher.
