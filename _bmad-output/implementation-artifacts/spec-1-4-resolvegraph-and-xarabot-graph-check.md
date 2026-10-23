---
title: 'Story 1.4: `resolveGraph` and `xarabot graph check`'
type: 'feature'
created: '2026-10-22'
status: 'in-progress'
baseline_revision: '9b358fb11a916e4e23e9fbfd5e2bc9eea2797eb2'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Gates, `next` and graph-change checks need one effective Epic graph, but nothing builds it, and nothing rejects a broken `.xarabot/epics.yaml`, manifest set or `retro-gates.yaml` (FR2, AR12, AR13).

**Approach:** Add a pure `resolveGraph(snapshot)` in `src/core/graph/` that parses `.xarabot/epics.yaml` (strict, raw-text duplicate scan), `epics.md` headings, manifests, optional package edges and `retro-gates.yaml`, validates them, and returns the resolved graph with a stable hash; ship the same validator as `xarabot graph check` over the working tree.

## Boundaries & Constraints

**Always:**
- Core stays pure (AR2): `Result`, never throw; every error `message` starts with the file's repo path (or `graph:` for cross-file problems) then `: `. `Bun.YAML`, `Bun.Glob` (`match` only) and `Bun.CryptoHasher` are allowed in core.
- **Snapshot** = `{tree, files, config}` where `config` is a `GraphConfig` = `Pick<Config, "epics_path" | "retro_gates_path" | "bootstrapped_epics" | "manifests" | "epic_packages">`; `DEFAULT_GRAPH_CONFIG` comes from `CONFIG_DEFAULTS`. A path absent from `tree` is absent; listed but not in `files` is `unreadable`. `epics.md` absent → `missing`.
- **`.xarabot/epics.yaml`** (absent → `{version: 1, epics: {}}`): strict top level `{version, epics}`; `version` is literal `1` (another integer → `unsupported-version`); top level must be one YAML document holding a mapping (an array — what `Bun.YAML` returns for multi-document text — is invalid); `epics` must be a mapping (null invalid); keys match `^[1-9][0-9]*$` → numbers; each entry is a strict mapping `{depends_on?: positive ints, checkpoint?: literal true}` (a null entry is invalid); `depends_on` duplicates are de-duplicated.
- **Duplicate keys** are found from the raw text: duplicate top-level keys, and duplicate keys at the first indentation level under the top-level `epics:` line (quotes stripped, so `6` and `"6"` collide). A flow-style `epics:` value other than `{}` is invalid (its keys can't be scanned). The same scan applies to `retro-gates.yaml`.
- **Effective deps** per Epic in `epics.md`: its entry's `depends_on` if given, else the next lower Epic number present in `epics.md` (lowest → none); plus package edges. `checkpoint` only when the entry says `true`.
- **Package edges** only when `config.epic_packages` is set: read root `package.json` `workspaces` (array, or `{packages: [...]}`); workspace packages are tree entries matching `<pattern>/package.json` (leading `./` and trailing `/` stripped; `!` patterns exclude); each has a `name`. If package P (mapped to Epic A) lists workspace package Q (mapped to Epic B, B ≠ A) in `dependencies`, `devDependencies`, `peerDependencies` or `optionalDependencies`, A depends on B. A mapped name that is no workspace package, two workspace packages with one name, or bad JSON → failure.
- **Validation failures** (each names the problem): any invalid file; an `epics.yaml` key, an `epics.yaml` `depends_on`, an `epic_packages` key or a `bootstrapped_epics` entry naming an Epic with no heading (`unknown-epic`); a cycle among effective Epic edges, the message listing it (`cycle`); a manifest whose `story_id` has no Story heading or whose `epic` differs from its heading's Epic (`manifest-heading`); a manifest `depends_on` naming no Story heading, or a Story whose Epic is neither the manifest's own Epic nor one it depends on transitively, or forming a Story-level cycle, self included (`story-dependency`).
- Story ids are joined to headings by numeric value (`Number(epic).Number(story)suffix`).
- **Output** (`ResolvedGraph`): `epics` sorted by number, each `{number, title, depends_on (sorted, unique), checkpoint, stories (manifest ids naming it, sorted with compareStoryIds)}`; `edges` `{from, to}` sorted; `checkpoints` sorted; `unmanifested` `{id, epic, line}` for headings with no manifest outside `bootstrapped_epics`; `retroGates` (parsed, `{schema_version: 1, epics: {}}` when absent); `hash` = `sha256:<hex>` of canonical JSON of `[{number, depends_on, checkpoint, stories}]` (titles, unmanifested and retro gates excluded).
- **`retro-gates.yaml`** schema (AR13): `{schema_version: 1, epics: map}`, keys as in `epics.yaml`; entry strict `{retro?, items?, checkpoint?}`; `retro` = `{verdict: accepted | accepted-with-open-items | rejected, unit: "retro:<N>", recorded_at: ISO date-time, go?}` with `go` allowed only for `rejected`; `items[]` = `{id: epic-<N>-retro-item-<seq>-<slug>, text, route: lane | maintainer, blocking: boolean, globs: normalized globs, status: open | in-progress | waiting | deferred | done}`; `checkpoint` = `{go}`; `go` = `{by: GitHub login, at: ISO date-time, ruling: non-empty string}` (`maintainer-pr` for a hand-written go). `<N>` must equal the entry's key.
- **`xarabot graph check`**: from the git top-level of the cwd, tree = `git ls-files -z --cached --others --exclude-standard` minus files that no longer exist; config = `.xarabot/config.yaml` parsed with `ConfigSchema` when present (invalid → exit 1), else defaults; reads only `graphInputPaths(tree, config)`. Prints `graph <hash>`, one line per Epic `<n> → [<deps>]` (plus ` checkpoint`, plus ` stories: <ids>` when any), to stdout; one `warning: Story <id> (<epics_path>:<line>) has no manifest` per unmanifested heading to stderr; exits 0. Any failure → `xarabot graph check: <message>` on stderr, exit 1.

**Never:**
- No gates, eligibility, `next`, sprint-status reading, ledger, "fixed once used", graph-delta posting or `approved_graph` handling (Stories 1.6, 2.8).
- No change to Story 1.2's `ConfigSchema` or `loadRepoConfig`, or Story 1.3's parsers beyond exports; no new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| No file | Epics 1, 2, 3; no `epics.yaml` | 1→[], 2→[1], 3→[2]; no checkpoints | — |
| This repo's file | `6: [4]`, `7: [5, 6]` over Epics 1–7 | 2→[1] … 5→[4], 6→[4], 7→[5,6] | — |
| Listed w/o deps | `3: {checkpoint: true}` | 3→[2], checkpoint 3 | — |
| Gap in numbers | Epics 1, 3, 7 | 3→[1], 7→[3] | — |
| Bad file | wrong `version`, extra key, `0`/`01`/`x` key, `depends_on: [0]`/`["2"]`, `checkpoint: false`, null `epics`, null entry, multi-doc, dup key, flow `epics` | — | `invalid` / `unsupported-version` naming it |
| Unknown Epic | key 9, `depends_on: [9]`, `bootstrapped_epics: [9]`, `epic_packages` key 9 | — | `unknown-epic` |
| Cycle | `2: [3]`, `3: [2]`; or `1: [1]` | — | `cycle` listing Epics |
| Manifests | manifest 2.1 with no heading; `epic: 1` on `2.1` | — | `manifest-heading` / `invalid` |
| Story deps | `depends_on: ["2.9"]` unknown; 2.x → 3.1 where 2 doesn't depend on 3; 2.1↔2.2 | — | `story-dependency` |
| Story deps ok | 3.1 → 1.2 with 3→[2]→[1] | ok | — |
| Package edges | map `{1: [a], 2: [b]}`, `b` depends on `a` | edge 2→1 added | no map → none; unknown name → `invalid` |
| Story sets | manifests 2.6a, 2.10, 2.6 | Epic 2 stories `[2.6, 2.6a, 2.10]` | — |
| Unmanifested | headings 1.1, 2.1, `bootstrapped_epics: [1]` | only 2.1 reported | — |
| Hash | same graph, titles changed | same hash; edge change → new hash | — |
| retro-gates | rejected retro with go `ruling: "4512345"` / `maintainer-pr`; checkpoint go; items | parsed go readable | go on `accepted`, bad id/status/route, `unit: retro:3` under key 2 → `invalid` |

</intent-contract>

## Code Map

- `src/core/result.ts` -- `Result`, `ok`, `err`; reuse.
- `src/core/schemas/common.ts` -- `parseYaml`, `describeIssues`, `GitHubLogin`, `IsoDateTime`, `NonEmpty`; reuse. Its `checkVersioned` keys on `schema_version`: reuse for `retro-gates.yaml`; `epics.yaml` uses `version`, so check it locally.
- `src/core/schemas/config.ts` -- `CONFIG_DEFAULTS`, `ConfigSchema`, `Config`; `epic_packages` is `Record<"<N>", string[]>`; `bootstrapped_epics` positive ints. Read-only.
- `src/core/config/load-repo-config.ts` -- `EPICS_YAML_PATH`, `CONFIG_PATH`, `readFile` convention (`missing` / `unreadable`, `Object.hasOwn`). Read-only apart from imports.
- `src/core/graph/epics-md.ts:parseEpicsMd` -- headings → `{epics: [{number, title, line, stories: [{id, epic, title, line}]}]}`; reuse.
- `src/core/manifests/parse-manifest.ts:loadManifests` -- `(snap, manifestsConfig?)` → `Manifest[]` sorted by path; reuse.
- `src/core/manifests/globs.ts:normalizeGlob` -- for retro item globs.
- `src/core/story-id.ts:compareStoryIds` -- Story-set order.
- `src/cli/main.ts` -- argv dispatch; extend with `graph check`. `test/cli/main.test.ts` spawns it via `process.execPath`.
- `test/support/boundaries.ts` -- core may import only `zod` and core; CLI may spawn. Checked by `test/boundaries.test.ts`.
- `test/fixtures/epics.md` -- copy of planning `epics.md` (Epics 1–7); `.xarabot/epics.yaml` here has `6: [4]`, `7: [5, 6]`; repo has no `.xarabot/config.yaml` and no workspaces.

## Tasks & Acceptance

**Execution:**
- `src/core/graph/yaml-keys.ts` -- `findDuplicateKeys(path, text, mapKey)`: raw-text scan of top-level keys and first-level keys under `mapKey:`; flow value check.
- `src/core/schemas/epics-yaml.ts` -- `EpicsYamlSchema` and `EpicEntrySchema`, types inferred.
- `src/core/schemas/retro-gates.ts` -- `RetroGatesSchema`, `GoSchema`, types inferred.
- `src/core/graph/epics-yaml.ts` -- `parseEpicsYaml(path, text)`.
- `src/core/graph/retro-gates.ts` -- `parseRetroGates(path, text)`.
- `src/core/graph/package-edges.ts` -- `packageEdges(snap, epicPackages)` → `Result<{from, to}[]>`.
- `src/core/graph/resolve-graph.ts` -- `GraphConfig`, `DEFAULT_GRAPH_CONFIG`, `GraphSnapshot`, `ResolvedGraph`, `graphInputPaths(tree, config)`, `resolveGraph(snapshot)`.
- `src/cli/graph-check.ts` -- `graphCheck(cwd)`: builds the snapshot from the working tree, prints, returns the exit code.
- `src/cli/main.ts` -- dispatch `graph check`; usage names it.
- `test/core/graph/*.test.ts` -- case tables for every matrix row; `test/cli/graph-check.test.ts` -- fixture repos (temp dir + `git init`) and this repo.

**Acceptance Criteria:**
- Given a fixture repo with Epics 1–3 and no `.xarabot/epics.yaml`, when `xarabot graph check` runs there, then it prints `1 → []`, `2 → [1]`, `3 → [2]` and exits 0.
- Given this repo, when `xarabot graph check` runs, then it prints `6 → [4]`, `7 → [5, 6]`, `n → [n-1]` for n = 2…5, `1 → []`, a warning per Story heading, and exits 0.
- Given a fixture repo with a cycle or an invalid `.xarabot/config.yaml`, when it runs, then stderr names the problem and it exits 1.
- Given the repo, when `bun install`, `bun test`, `bun --bun oxlint`, `bun --bun tsc` run, then each exits 0 and the boundary check is clean.

## Spec Change Log

## Review Triage Log

## Design Notes

- **Fail closed on the unscannable.** Flow-style `epics:` maps and unknown mapped package names are refused rather than guessed at: `Bun.YAML` keeps the last duplicate silently, and an unmatched package map would drop an edge silently.
- **Story-level cycles** fail as `story-dependency`: a Story depending on itself, directly or around a loop, can never become eligible.
- **The hash** covers what AD-11 calls the effective graph (edges, checkpoints, Epic set, Story sets), so a retitled heading needs no re-approval.

## Verification

**Commands:**
- `bun install` -- expected: exit 0, `bun.lock` unchanged.
- `bun test` -- expected: exit 0.
- `bun --bun oxlint` -- expected: exit 0.
- `bun --bun tsc` -- expected: exit 0.
- `bun src/cli/main.ts graph check` -- expected: exit 0, `6 → [4]`, `7 → [5, 6]`.
