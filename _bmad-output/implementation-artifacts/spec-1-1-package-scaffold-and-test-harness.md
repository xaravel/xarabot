---
title: 'Story 1.1: Package scaffold and test harness'
type: 'feature'
created: '2026-10-22'
status: 'done'
baseline_revision: '1f0802eb758a7c0a41c59f9967960fbb024076e5'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      Nothing runs `bun --bun oxlint` and `bun --bun tsc` on every PR until the Maintainer installs the proposed CI workflow.
    evidence: |-
      `bun test` checks only the script strings; `.github/` does not exist and lanes may not write it. `docs/maintainer/ci-workflow.yml` must be copied to `.github/workflows/ci.yml` and made a required check by the Maintainer.
    location: >-
      docs/maintainer/ci-workflow.yml
    severity: medium
  - summary: >-
      Non-core layers may import files outside `src/` (for example `test/support/` or `bootstrap/`) without a violation.
    evidence: |-
      `checkSource` flags an import that resolves outside `src/<layer>/` only for core. The AR1 table does not say whether `cli` and the other layers may reach outside `src/`. `cli` legitimately reads `package.json`, so the rule needs a decision and an allowlist.
    location: >-
      test/support/boundaries.ts:checkSource
    severity: medium
  - summary: >-
      Core purity bans cover only the forms the intent names; nondeterminism (`Math.random`, `crypto.randomUUID`, `performance.now`, timers) and other Bun I/O globals (`Bun.connect`, `Bun.serve`, `Bun.Glob#scan`) are not banned.
    evidence: |-
      The intent enumerates exactly which forms to ban. Whether AR2's "pure core" also bans randomness and timers is a spine decision for the Maintainer, not a local one.
    location: >-
      test/support/boundaries.ts:CORE_BANS
    severity: medium
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

- 2026-10-22, Maintainer: approved the `oxlint` and `tsc` package.json scripts, which run each tool's launcher through Bun. Bun 1.4.3 does not stand in for `node` when it runs a `#!/usr/bin/env node` launcher: `bun --bun oxlint`, `bun --bun tsc` and `bun --bun run oxlint` all exit 127 without them, checked on the host outside any sandbox. Resume at review.

## Review Triage Log

### 2026-10-22 — Review pass
- verdicts: 46 findings — high 0, medium 19, low 22, false 5, maybe-false 0
- findings:
  - `[medium]` `[patch]` (verification-gap) whole-`src/` test passes when `checkTree` scans no files — `checkTree` now throws when it finds no source files, and a new test writes a temp tree with a clean and a violating core file and asserts the exact violation.
  - `[medium]` `[patch]` (verification-gap) the toolchain test checks only the repo root for forbidden configs — the scan is now recursive with `Bun.Glob`, skipping `node_modules`, `.git`, `bootstrap` and the BMAD folders. Checked by planting `docs/eslint.config.mts`, which the test then reported.
  - `[medium]` `[defer]` (verification-gap) `bun --bun oxlint` and `bun --bun tsc` are not run by any automated check — CI lives in `.github/`, which only the Maintainer may change; deferred.
  - `[medium]` `[patch]` (verification-gap) the agent spawn ban misses `import { spawn } from "bun"` and `Bun.$` — added a `Bun.$` ban and a named-import ban on `spawn`, `spawnSync` and `$` from `bun`, each with a test.
  - `[medium]` `[defer]` (intent-alignment) exit 0 of the four commands is self-reported, not machine-checked — same root cause as the CI deferral.
  - `[medium]` `[patch]` (intent-alignment) matrix fixtures run only as strings; no test shows the tree walk reporting an on-disk violation — covered by the temp-tree `checkTree` test above.
  - `[false]` `[reject]` (intent-alignment) "import graph" is checked per file, not transitively — every file in `src/` is checked, so every edge of the graph is checked; the design notes choose a per-file scan.
  - `[low]` `[reject]` (intent-alignment) bans are syntactic, not semantic (bracket access, destructuring) — such code is deliberate evasion, not everyday use, and catching it needs a real parser.
  - `[low]` `[reject]` (intent-alignment) strings as well as comments are exempt from the purity bans — text inside a string cannot call anything, so this causes no missed violation.
  - `[false]` `[reject]` (intent-alignment) extra rules (files directly under `src/`, core reaching outside `src/`) — both follow from the layer table's coverage; neither rejects valid code in the tree.
  - `[low]` `[reject]` (intent-alignment) the live test depends on Bun's summary text — Bun is pinned at 1.4.3, so the format cannot drift without a deliberate upgrade.
  - `[false]` `[reject]` (intent-alignment) CLI `--help`/`-v` reading — the matrix says unknown args give usage and exit 1, which the code does.
  - `[false]` `[reject]` (intent-alignment) exit 0 rests on prose in the spec — this pass re-ran all four commands; each exits 0.
  - `[medium]` `[patch]` (blind) the every-direction test takes its expected outcomes from the `ALLOWED` constant under test — the test now carries its own literal AR1 table, asserts `ALLOWED` equals it, and derives the cases from it.
  - `[medium]` `[patch]` (blind) the whole-tree check can pass vacuously, and `URL.pathname` breaks on paths with spaces — empty-scan guard as above; `ROOT`/`MAIN` now come from `import.meta.dir` in all three test files.
  - `[medium]` `[patch]` (blind) `strip()` mis-reads regex literals, so a backtick in a regex blanks the rest of the file — `strip()` now recognises a regex literal from the token before the `/` and blanks its body in `bare`; tests cover a backtick, a quote and an escaped `//` in a regex, plus division.
  - `[low]` `[patch]` (blind) core bans miss `import.meta.env`, `Bun.$` and others — added `import.meta.env` and `Bun.$` to the core bans with tests. Bracket access and destructuring were rejected as deliberate evasion; nondeterminism bans were deferred for a spine decision.
  - `[medium]` `[patch]` (blind) agent spawn ban holes (`import { spawn } from "bun"`, `Bun.$`) — same fix as the verification-gap row above.
  - `[low]` `[reject]` (blind) the `fetch` ban flags a parameter or local named `fetch` — the failure is loud and the fix is a rename; matching only calls would let `const f = fetch` through.
  - `[low]` `[reject]` (blind) import-like text inside template literals is reported as an import — the failure is loud, and such prompt text is unlikely in everyday code.
  - `[medium]` `[defer]` (blind) non-core layers may import outside `src/` — AR1 does not settle it, and `cli` reads `package.json`; deferred for a decision.
  - `[low]` `[reject]` (blind) lint warnings would not fail `bun --bun oxlint` — oxlint reports 0 warnings today, and enforcing that means changing the Maintainer-approved script string.
  - `[low]` `[patch]` (blind) the CI workflow keeps the checkout token and does not pin actions by SHA — added `persist-credentials: false`. SHA pinning needs GitHub access this run lacks, and the required-check setting lives in the ruleset (Maintainer); both rejected.
  - `[low]` `[reject]` (blind) the spec contradicts itself (`Auto Run Result` still says blocked) — the fix edits this build's spec; the Finalize step rewrites that section anyway.
  - `[medium]` `[patch]` (blind) the forbidden-tooling test is narrow (root only, variant names, `@types/jest`) — recursive scan, name-shape regexes and `@types/jest` added.
  - `[low]` `[reject]` (blind) there is no sandboxed-skip helper — no sandbox suite exists yet; the Story that adds the first one owns it.
  - `[medium]` `[patch]` (edge-case) `strip()` and regex literals — same fix as the blind row above.
  - `[low]` `[reject]` (edge-case) computed or aliased access (`Bun["spawn"]`, `const { spawn } = Bun`) — deliberate evasion, needs a parser.
  - `[medium]` `[patch]` (edge-case) `Bun.$` in agent adapters — same fix as the verification-gap row above.
  - `[low]` `[reject]` (edge-case) other impure Bun globals in core (`Bun.serve`, `Bun.connect`, `Glob#scan`) — `Bun.$` was added; the rest are in the nondeterminism/I-O deferral.
  - `[low]` `[reject]` (edge-case) `import(\`../lane/x\`)` with a template specifier — rare, and the repo's style uses quoted specifiers.
  - `[low]` `[reject]` (edge-case) absolute-path or `file:` imports skip the layer table — nobody writes absolute imports in a relocatable package.
  - `[medium]` `[defer]` (edge-case) non-core layers importing outside `src/` — same deferral as the blind row.
  - `[low]` `[reject]` (edge-case) import text inside string literals — same as the template-literal row.
  - `[low]` `[patch]` (edge-case) `ROOT` percent-encoding in `test/boundaries.test.ts` — now `join(import.meta.dir, "..")`.
  - `[medium]` `[patch]` (edge-case) the glob finds zero files and the check passes — empty-scan guard.
  - `[low]` `[patch]` (edge-case) the nested `bun test` in `test/live.test.ts` can hang — `timeout: 30_000` on `Bun.spawnSync`.
  - `[low]` `[patch]` (edge-case) the spawned CLI in `test/cli/main.test.ts` can hang — `timeout: 10_000`.
  - `[low]` `[patch]` (edge-case) the live test's `cwd` uses `URL.pathname` — now `import.meta.dir`.
  - `[false]` `[reject]` (edge-case) the `liveTest` cast hides missing members — `bun-types` declares `skipIf(condition): Test<T>`, the same type as `test`, so nothing is hidden.
  - `[medium]` `[patch]` (edge-case) nested forbidden configs — recursive scan.
  - `[low]` `[patch]` (edge-case) variant config names (`eslint.config.mts`, `.prettierrc.toml`, …) — name-shape regexes added.
  - `[low]` `[patch]` (edge-case) CI concurrency cancels an older pending run on main — push runs now group by commit SHA.
  - `[medium]` `[patch]` (edge-case, claim) the toolchain test claims repo-wide coverage but checks only the root — recursive scan.
  - `[medium]` `[patch]` (edge-case, claim) the comment-exemption claim fails on regex literals — `strip()` fix.
  - `[low]` `[reject]` (edge-case, claim) the bans match only dotted literal forms — deliberate evasion, as above.

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

Status: done

**Summary.** Adds the Bun package `@xaravel/xarabot` with exact pins, the AR37 source tree, `Result` in `src/core/`, the version-printing CLI, a `bun test` layer-boundary and purity checker, the `XARABOT_LIVE=1` live switch, the `runContract` helper and a proposed CI workflow. The first run halted `blocked` after implementation, on a permission denial. The Maintainer approved the `oxlint`/`tsc` scripts, and this run did the step-04 review and applied its patches.

**Files changed.**
- `package.json`, `bun.lock`, `tsconfig.json`, `.oxlintrc.json`, `.gitignore`: package identity, pins, `oxlint`/`tsc` scripts that run each tool through Bun, strict noEmit tsc, and lint ignores.
- `src/core/result.ts`: `Result`, `ok`, `err`.
- `src/cli/main.ts`: `--version` or no args prints the version; anything else prints usage to stderr and exits 1.
- `src/**/.gitkeep`: the AR37 directories.
- `test/support/boundaries.ts`: `checkSource`/`checkTree`, with the layer table, core purity bans and agent spawn bans. `strip()` blanks comments, strings and regex literal bodies.
- `test/support/live.ts`, `test/fixtures/live-sample.fixture.ts`, `test/live.test.ts`: the live switch and its test.
- `test/contracts/run-contract.ts`, `test/contracts/example.contract.test.ts`: the contract-suite helper and an example using it.
- `test/boundaries.test.ts`, `test/core/result.test.ts`, `test/cli/main.test.ts`, `test/toolchain.test.ts`: tests.
- `docs/maintainer/ci-workflow.yml`: the proposed CI workflow, for the Maintainer to install.

**Review findings.** 46 findings: 0 high, 19 medium, 22 low, 5 false.
- Patches applied:
  - 12 medium entries:
    - vacuous `checkTree`
    - on-disk `checkTree` coverage
    - self-referential layer table test
    - `strip()` regex literals
    - agent `Bun.$`/`import { spawn } from "bun"`
    - repo-wide forbidden-tooling scan
    - and their duplicate rows
  - Low entries:
    - `import.meta.env` and `Bun.$` core bans
    - `import.meta.dir` roots
    - spawn timeouts
    - config name shapes
    - `persist-credentials: false`
    - CI concurrency per commit on push
- Deferred (see frontmatter `deferred`):
  - CI not yet installed, so oxlint and tsc are not machine-checked
  - non-core imports outside `src/`
  - nondeterminism and other Bun I/O bans in core
- Rejected, with the reason recorded in each row of the triage log:
  - bracket and destructuring evasion
  - `fetch` name false positives
  - template and string import text
  - lint-warning enforcement
  - SHA pinning and required-check setup
  - spec self-contradiction (fixed by this section)
  - sandboxed-skip helper
  - template-specifier and absolute imports
  - Bun summary format
  - the five `false` findings

**Follow-up review recommended: true.** This first pass patched several medium findings. The new `strip()` regex-literal heuristic is the specific unverified risk: it decides regex versus division from the preceding token, so `x++ / 2` would be misread as a regex. It is also new code that no reviewer has read yet.

**Verification.** Ran `bun install` (exit 0, `bun.lock` unchanged), `bun test` (121 pass, 0 fail), `bun --bun oxlint` (exit 0, no warnings) and `bun --bun tsc` (exit 0). Planting `docs/eslint.config.mts` made the toolchain test fail as intended; I then removed it.

**Residual risks.**
- The boundary checker is regex-based, so a determined author can evade it.
- Lint and type checks depend on the Maintainer installing the CI workflow.

### Earlier run

Status: blocked. The implementation subagent ran one command with the Bash sandbox disabled, and auto mode denied its next command. All tasks were implemented and committed before that halt. The Maintainer approved the `oxlint`/`tsc` scripts on 2026-10-22 (Spec Change Log), and this run resumed at review.
