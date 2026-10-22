---
title: 'Story 1.1: Package scaffold and test harness'
type: 'feature'
created: '2026-10-22'
status: 'blocked'
baseline_revision: '1f0802eb758a7c0a41c59f9967960fbb024076e5'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The repo has no code yet, so later Stories have no package, layer layout, lint rules or test harness to land in. Without enforced layer boundaries and a live-test switch, every later Story could drift from the spine (AR1, AR2, AR18, AR35–AR37).

**Approach:** Add the Bun package `@xaravel/xarabot` with pinned tooling, the AR37 source tree, a `Result` type in `src/core/`, a `bun test` boundary checker over the import graph and core purity, a live-test switch on `XARABOT_LIVE=1`, a contract-suite helper, and a proposed CI workflow under `docs/maintainer/`.

## Boundaries & Constraints

**Always:**
- Use the exact pins Bun 1.4.3, TypeScript 7.0.2, oxlint 1.89.0, zod 4.6.7 and `@types/bun` 1.4.3, with no `^` or `~`. Use `bun.lock` as the only lockfile.
- Run `bun install`, `bun test`, `bun --bun oxlint` and `bun --bun tsc` from a fresh clone, and require each to exit 0. `tsc` runs `--strict` with `noEmit`.
- Enforce the AR1 layer table (an importer may use the layers listed):

  | Importer | May import |
  |---|---|
  | core | core |
  | ports | ports, core |
  | adapters/<kind>/<name> | its own dir, ports, core |
  | sandbox | sandbox, ports, core |
  | lane | lane, sandbox, adapters, ports, core |
  | cli | cli, lane, sandbox, adapters, ports, core |

- In `src/core/`, allow bare imports of only `zod`. Ban `fetch`, any `Bun.spawn`/`Bun.spawnSync`/`Bun.file`/`Bun.write`, `Date.now()`, a no-argument `new Date()`, and `process.env`/`Bun.env`.
- Under `src/adapters/agent/`, ban `Bun.spawn`, `Bun.spawnSync` and `child_process`.
- Don't let text inside comments trip the purity checks.
- Use kebab-case file names.

**Never:**
- No Node, npm, pnpm, Jest, Vitest, ESLint or Prettier dependency, lockfile or config.
- Don't change `.github/`, `bootstrap/`, `_bmad/`, `.claude/`, `.agents/` or `AGENTS.md`. Exclude `bootstrap/` and the BMAD folders from lint and tsc.
- No port, adapter, config or CLI command logic beyond the version print. Those belong to later Stories.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Version | `bun src/cli/main.ts --version` (or no args) | prints `package.json` version, exit 0 | unknown arg → usage on stderr, exit 1 |
| Core imports ports | fixture `src/core/x.ts` with `import type {F} from "../ports/forge"` | boundary violation reported | — |
| Adapter cross-import | `src/adapters/forge/github/a.ts` imports `../../agent/claude/b` | violation | — |
| Core impurity | core fixture calls `Date.now()` / `fetch(` / `Bun.spawn` / reads `process.env` / imports `node:fs` | violation for each | — |
| Comment mention | core fixture `// never call Date.now()` | no violation | — |
| Agent spawn | `src/adapters/agent/claude/x.ts` references `Bun.spawn` | violation | — |
| Live off | `bun test` on live fixture, `XARABOT_LIVE` unset | live case reported skipped, 0 passed | — |
| Live on | same with `XARABOT_LIVE=1` | live case passes | — |

</intent-contract>

## Code Map

- `bootstrap/join.ts`, `bootstrap/loop/token.ts` -- the only existing TS. It's read-only bootstrap tooling, so exclude it from lint and tsc.
- `.xarabot/epics.yaml` -- an existing repo config. Leave it untouched.
- `LICENSE` -- MIT already. `package.json` must say `"license": "MIT"`.
- `.gitignore` -- add `node_modules/`.
- Bun 1.4.3 is at `~/.bun/bin/bun`. The registry has all the pinned versions. `@types/bun@1.4.3` pulls in `bun-types` and, transitively, `@types/node` as type declarations only. That isn't a Node tool (NFR1 bans Node *as a tool*).

## Tasks & Acceptance

**Execution:**
- `package.json` -- add name `@xaravel/xarabot`, version `0.0.0`, `"type": "module"`, license MIT, `bin.xarabot` → `src/cli/main.ts`, `packageManager: bun@1.4.3`, `engines.bun: 1.4.3`, pinned devDeps `typescript`, `oxlint`, `@types/bun`, and dep `zod`. This is the package identity (AR36).
- `tsconfig.json` -- strict, noEmit, ESNext and bundler resolution, `types: ["bun"]`, `resolveJsonModule`, and include `src`, `test`. Configures `bun --bun tsc`.
- `.oxlintrc.json` -- turn on the correctness rules, ignore `bootstrap/**`, `_bmad/**`, `_bmad-output/**`, `.claude/**`, `.agents/**` and `node_modules/**`. Configures `bun --bun oxlint`.
- `bun.lock`, `.gitignore` -- generate the lockfile and ignore `node_modules/`.
- `src/core/result.ts` -- add `Result<T, K extends string = string>`, `ok()` and `err()` (AR35).
- `src/core/schemas/.gitkeep`, `src/ports/.gitkeep`, `src/adapters/forge/github/.gitkeep`, `src/adapters/agent/claude/.gitkeep`, `src/sandbox/.gitkeep`, `src/lane/.gitkeep` -- add the AR37 dirs so they survive a clone.
- `src/cli/main.ts` -- add the version print (see the matrix).
- `test/support/boundaries.ts` -- add a pure `checkSource(path, source): Violation[]` that applies the layer table and the purity and spawn bans, and `checkTree(root)` to walk `src/`.
- `test/support/live.ts` -- add `liveTest` (`test.skipIf` unless `process.env.XARABOT_LIVE === "1"`).
- `test/contracts/run-contract.ts` -- add `runContract(name, impls: {name, make}[], suite)`, which runs one `describe` per implementation.
- `test/fixtures/live-sample.fixture.ts` -- add one `liveTest` that passes. It's not named `*.test.ts`, so plain `bun test` skips the file.
- Tests -- `test/core/result.test.ts`, `test/cli/main.test.ts` (spawns the bin), `test/boundaries.test.ts` (the whole `src/` is clean, plus a case table of every forbidden direction and the matrix rows), `test/live.test.ts` (spawns `bun test ./test/fixtures/live-sample.fixture.ts` with and without the variable and asserts skip versus pass), `test/contracts/example.contract.test.ts` (an example port with two implementations through `runContract`), and `test/toolchain.test.ts` (exact pins, no forbidden deps, lockfiles or configs).
- `docs/maintainer/ci-workflow.yml` -- propose a workflow: `oven-sh/setup-bun` with `bun-version: 1.4.3`, `bun install --frozen-lockfile`, `bun test`, `bun --bun oxlint` and `bun --bun tsc` on push and PR to `main` and on `merge_group`.

**Acceptance Criteria:**
- Given a fresh clone, when `bun install && bun test && bun --bun oxlint && bun --bun tsc` runs, then each exits 0.
- Given the layer table, when the boundary test's fixtures hit each forbidden direction (each lower layer importing each higher one, and adapter to adapter), then each fixture yields a violation and every allowed direction yields none.
- Given the repo, when the toolchain test runs, then `package.json` pins match AR36 exactly and no forbidden dependency, lockfile or config exists.

## Spec Change Log

## Review Triage Log

## Design Notes

The boundary check runs as a `bun test` rather than an oxlint rule because oxlint 1.89 can't express per-layer import tables portably. Keep `checkSource` pure so the fixtures are just strings. A sample violation:

```ts
checkSource("src/core/a.ts", 'import { x } from "../lane/y";')
// → [{ path: "src/core/a.ts", rule: "layer", detail: "core may not import lane" }]
```

The live switch is the environment variable because Bun 1.4.3 swallows `--live`.

## Verification

**Commands:**
- `bun install` -- expected: exit 0, `bun.lock` unchanged after the first commit.
- `bun test` -- expected: exit 0. The live fixture isn't run directly.
- `bun --bun oxlint` -- expected: exit 0, no warnings in `src/` or `test/`.
- `bun --bun tsc` -- expected: exit 0.

## Auto Run Result

Status: blocked
Blocking condition: permission denied: during implementation, the implementation subagent ran one diagnostic command with the Bash sandbox disabled, and auto mode then denied its next command (a read-only listing of binary strings and temp folders). The action was not retried or worked around, and the run rule makes any denial end the run as `blocked`.

State at halt: all the spec's tasks are implemented and committed on this branch, and step-04 review has not run. `bun install`, `bun test` (108 pass, 0 fail), `bun --bun oxlint` and `bun --bun tsc` each exit 0.

One deviation needs the Maintainer's decision: `oxlint` and `tsc` ship `#!/usr/bin/env node` shebangs, there is no `node` on the host, and `bun --bun` did not supply one. So `package.json` adds the scripts `"oxlint": "bun ./node_modules/oxlint/bin/oxlint"` and `"tsc": "bun ./node_modules/typescript/bin/tsc"`, which `bun --bun <name>` runs first. The spec does not list these scripts.

To resume: once the Maintainer has reviewed the denial, set `status: in-review` and re-dispatch for step-04 review.
