<!-- bmad:context -->
<!-- Verified 2026-10-20 against 1a052d8. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## Xarabot

Runs BMAD projects unattended: lanes, `next` unit selection, claims, CI and merge plumbing, and `claude`, `codex` and `pi` adapters, shipped as the npm package `@xaravel/xarabot`. Xaravel is its first consumer. Status: spec only, no code yet. The contract is `_bmad-output/specs/spec-xarabot/SPEC.md` and its companions.

## Policy

- Never push to `main`; open a PR. Branch as `story/<story-id>` for Story work and `planning/<topic>` for planning and docs work. The `Protect main` ruleset refuses direct pushes, force-pushes and deletion, requires the `check` status and the merge queue, and requires a Code Owner review: `.github/CODEOWNERS` makes the Maintainer the owner of every path except the two status files. Repository admins may bypass only that review, through the PR, so the Maintainer can merge their own PRs; the bot's PRs always need the Maintainer's approval, except runner-written `reconcile` PRs, which touch only the status files (Standing Authority).
- Never add `Co-Authored-By` trailers, "Generated with" lines or similar markers to commits or PRs; the bot account is the only marker of lane-made work. The `Co-authored-by: edanisko-xarabot[bot]` trailer that GitHub's squash merge adds itself is that marker, and is allowed.
- Never create a `CLAUDE.md` anywhere in this repo — Claude Code stops reading `AGENTS.md` when one exists. Put instructions here.
- Change these only when the Maintainer asks for that change: `AGENTS.md`; `_bmad-output/specs/` (through `bmad-spec`); `_bmad/`, `.claude/skills/` and `.agents/skills/` (re-run the installer, or `bmad-customize` into `_bmad/custom/`); `.github/`.
- When a task conflicts with `SPEC.md`, or needs a decision it does not settle, stop that part and ask the Maintainer — never decide it locally.
- Never write code that gives an adapter's agent session a GitHub token; only the runner talks to GitHub (SPEC § Constraints, "Agents never touch GitHub").
- Never publish to npm or handle publish credentials; only the Maintainer releases, from CI.

## Where things are

- Before writing runner, CI-polling or merge code, read `brownfield-xaravel.md` § Lessons in the spec folder — each lesson cost Xaravel's loop real time.

## Running and verifying

- TODO, no code yet: use only the toolchain decided in SPEC § Constraints — Bun 1.4.3, TypeScript 7 with `--strict`, oxlint. Never substitute Node, npm, pnpm, Jest, Vitest, ESLint or Prettier. Commands are added on the first refresh after code exists.
- Re-run the BMAD install as `bunx bmad-method@6.12.4 install --modules bmm --tools claude-code,codex`, never with `npx`, and keep both tools: Claude Code reads only `.claude/skills`, and Codex and pi read `.agents/skills`.

## Known pitfalls

- Stop processes by exact PID, never `pkill -f`: it matches the `claude -p` command line, which contains the whole prompt.
- Never call `timeout` from runner code: stock macOS has none (this laptop's comes from Homebrew coreutils).
- When Claude auto mode denies an action (history rewrites, replacing a tracked file wholesale), report it to the Maintainer; never work around it.

<!-- /bmad:context -->
