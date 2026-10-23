---
title: 'Story 1.4: `resolveGraph` and `xarabot graph check`'
type: 'feature'
created: '2026-10-22'
status: 'done'
baseline_revision: '9b358fb11a916e4e23e9fbfd5e2bc9eea2797eb2'
review_loop_iteration: 0
followup_review_recommended: true
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

### 2026-10-22 — Review pass
- verdicts: 37 findings — high 4, medium 6, low 19, false 8, maybe-false 0
- findings:
  - `[low]` `[patch]` (verification-gap) `devDependencies`/`optionalDependencies` edges untested — added one `packageEdges` case per field, each expecting the edge.
  - `[low]` `[patch]` (verification-gap) numeric Story-id join (`storyKey`) never run with a non-canonical id — added a `resolveGraph` case: manifest `02.1` with leading-zero `depends_on` joins heading `2.1`.
  - `[medium]` `[patch]` (verification-gap) `graph check` could drop `epic_packages`/`retro_gates_path` from config unnoticed — added CLI fixtures for a package edge from `epic_packages` and an invalid file at a custom `retro_gates_path`.
  - `[low]` `[patch]` (verification-gap) the deleted-tracked-file filter is untested — added a CLI fixture that commits `epics.yaml`, deletes it and expects the serial graph.
  - `[false]` `[reject]` (verification-gap, other) `manifest-heading` epic-mismatch branch unreachable — the matrix row says `manifest-heading / invalid`, and Story 1.3's `loadManifests` returning `invalid` first is inside that contract; the branch is harmless defence.
  - `[low]` `[patch]` (intent-alignment A) CLI tests spot-check only a few failure kinds — same root as the config-coverage gap; covered by the new CLI fixtures.
  - `[false]` `[reject]` (intent-alignment B) manifest Epic mismatch gives `invalid` — as above, the matrix allows `invalid`.
  - `[false]` `[reject]` (intent-alignment C) `GraphSnapshot` documented as a `main` SHA but the CLI uses the working tree — the intent defines the CLI's tree as the working tree; SHA producers are Stories 1.6/2.8.
  - `[low]` `[patch]` (intent-alignment D) hash is insertion-order `JSON.stringify` and no digest is pinned — the order is fixed by one object literal, so it is deterministic; added a pinned-digest test so a refactor cannot change it silently.
  - `[medium]` `[patch]` (intent-alignment E) `2.6` and `02.06` manifests both join heading 2.6 and both appear in Epic 2's stories — `resolveGraph` now fails `invalid` on a numerically duplicate `story_id`.
  - `[low]` `[patch]` (intent-alignment F) a multi-manifest Story cycle is prefixed with one manifest's path, not `graph:` — now `graph:` for a cycle over several Stories, manifest path for a self-dependency; both pinned.
  - `[false]` `[reject]` (intent-alignment G) refusals beyond the literal text — they follow the spec's fail-closed design note; no bad outcome.
  - `[low]` `[reject]` (intent-alignment H) the repo test reads live repo state — the AC is stated against this repo; the test is expected to change when manifests land.
  - `[high]` `[patch]` (blind) `--- {flow doc}` skips the duplicate scan — `findDuplicateKeys` now refuses content after a `---`/`...` marker.
  - `[low]` `[reject]` (blind) `version: 1.0` accepted — `Bun.YAML` reads it as the number 1; nobody writes it, and a raw-value check adds a new scan path.
  - `[false]` `[reject]` (blind) `manifest-heading` mismatch branch can never run — duplicate of the verification-gap note; the matrix allows `invalid`.
  - `[medium]` `[patch]` (blind) duplicate retro item ids accepted — the `RetroGatesSchema` superRefine now flags a repeated item id within an entry.
  - `[low]` `[reject]` (blind) `retro-gates.yaml` keys not checked against headings — the intent lists the `unknown-epic` sources and leaves this out; an orphan entry never applies, and adding the check is a new rule.
  - `[low]` `[patch]` (blind) hash not canonical and not pinned — same root as intent-alignment D; pinned-digest test added.
  - `[low]` `[reject]` (blind) config read via `existsSync` and not the tree, and no duplicate scan — the intent says the config is parsed with `ConfigSchema` when present; a gitignored config is an unlikely edge case.
  - `[low]` `[reject]` (blind) repo test depends on the working tree — same as intent-alignment H.
  - `[low]` `[patch]` (blind) missing CLI coverage for package edges and deleted files — same root as the verification-gap CLI gaps; covered by the new fixtures.
  - `[low]` `[reject]` (blind) `graphInputPaths` reads every `package.json` — the signature sees only the tree, so it cannot read `workspaces`; the cost is extra I/O, and fixing it would change the public surface.
  - `[false]` `[reject]` (blind) block-scalar or quoted `epics:` passes the scan — `EpicsYamlSchema` rejects a non-mapping `epics`, so nothing collapses.
  - `[false]` `[reject]` (blind) `version: 2` with a duplicate key gives `unsupported-version` — intended: an unknown version may have another shape.
  - `[low]` `[reject]` (blind) spec metadata inconsistent mid-review — the fix would edit this build's spec.
  - `[high]` `[patch]` (edge-case) inline content after `---` bypasses the scan — same root as blind's `---` finding; refused now.
  - `[high]` `[patch]` (edge-case) a top-level `<<` merge key merges an unscanned map — `findDuplicateKeys` now refuses a `<<` key.
  - `[medium]` `[reject]` (edge-case) duplicate keys inside an entry (`depends_on` twice) collapse — the intent-contract fixes the scan at the top level and the first level under `epics:`, so deeper scanning is outside this Story.
  - `[medium]` `[patch]` (edge-case) numerically equal Story ids — same root as intent-alignment E; fixed.
  - `[low]` `[reject]` (edge-case) `version: 1.0`/`0x1` accepted — same as blind's version finding.
  - `[low]` `[reject]` (edge-case) retro-gates keys for missing Epics accepted — same as blind's retro-gates finding.
  - `[medium]` `[patch]` (edge-case) duplicate retro item ids — same root as blind's; fixed.
  - `[false]` `[reject]` (edge-case) transitive package edges via an unmapped package dropped — the intent defines an edge only when P lists Q directly.
  - `[low]` `[reject]` (edge-case) recursive DFS could overflow on huge chains — real graphs have tens of nodes; an iterative rewrite is not a direct correction.
  - `[low]` `[reject]` (edge-case) a symlinked input outside the repo is read — a local CLI over the user's own checkout; guarding it is a new rule.
  - `[high]` `[patch]` (edge-case claim) "strict, raw-text duplicate scan" is skipped for inline documents and merge keys — same root as the `---` and `<<` fixes.

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

## Auto Run Result

Status: done

**Summary:** Added the pure `resolveGraph(snapshot)` in `src/core/graph/`. It parses `.xarabot/epics.yaml` strictly, with a raw-text duplicate-key scan, and also reads the `epics.md` headings, the manifests, optional package edges and `retro-gates.yaml`. It validates them and returns the resolved Epic graph with a stable `sha256:` hash. The same validator ships as `xarabot graph check` over the working tree.

**Files changed:**
- `src/core/graph/yaml-keys.ts`: the raw-text duplicate-key scan; fails closed on flow style, anchors, tags, tabs, content after a document marker and `<<` merge keys. Also holds the one-mapping YAML parse and the raw Epic-key spelling check.
- `src/core/schemas/epics-yaml.ts`, `src/core/schemas/retro-gates.ts`: zod schemas for `epics.yaml` and `retro-gates.yaml` (AR13), including key/`<N>` consistency and unique item ids.
- `src/core/graph/epics-yaml.ts`, `src/core/graph/retro-gates.ts`: the strict parsers.
- `src/core/graph/package-edges.ts`: Epic edges from workspace package dependencies.
- `src/core/graph/resolve-graph.ts`: `GraphConfig`, `DEFAULT_GRAPH_CONFIG`, `GraphSnapshot`, `ResolvedGraph`, `graphInputPaths` and `resolveGraph`, with every validation failure kind and the hash.
- `src/cli/graph-check.ts`, `src/cli/main.ts`: the `xarabot graph check` command and its dispatch and usage line.
- `test/core/graph/*.test.ts`, `test/cli/graph-check.test.ts`, `test/cli/main.test.ts`: case tables for every matrix row, plus CLI fixture repos and this repo.

**Review findings:** 37 findings, one row each in the Review Triage Log. Eight entries were patched, grouped by root cause:
- high 1: the duplicate-key scan failed open on `--- {…}` and `<<`.
- medium 3: numerically duplicate Story ids; duplicate retro item ids; CLI coverage of `epic_packages`, a custom `retro_gates_path` and deleted tracked files.
- low 4: `devDependencies`/`optionalDependencies` tests; the non-canonical Story-id join test; the pinned hash digest; the `graph:` prefix for a Story cycle across several Stories.

Nothing was deferred. The rejected findings and their reasons are in the triage log: version spellings like `1.0`, retro-gates keys for unknown Epics, duplicate keys nested below the first `epics:` level (the intent-contract fixes the scan's scope), transitive package edges, recursion depth, symlinks, how the config is read, `graphInputPaths` reading every `package.json`, the live-repo test, and spec metadata.

**Follow-up review recommended:** true. The first pass patched a high entry. The unverified risk is that the raw-text duplicate-key scanner may have more YAML forms that `Bun.YAML` accepts but the scanner does not refuse. `---` and `<<` were found only at review. Patched counts by verdict: high 1, medium 3, low 4.

**Verification:**
- `bun install`: exit 0, `bun.lock` unchanged.
- `bun test`: 492 pass, 0 fail.
- `bun --bun oxlint` and `bun --bun tsc`: both exit 0.
- `bun src/cli/main.ts graph check`: exit 0, printing `1 → []` … `5 → [4]`, `6 → [4]`, `7 → [5, 6]`, with one warning per Story heading.

**Residual risks:**
- The duplicate-key scan covers only the top level and the first level under `epics:`, so a duplicate nested key (e.g. `depends_on` twice in one entry) still collapses silently.
- `graph check` needs a full `ConfigSchema`-valid config when `.xarabot/config.yaml` exists.
- A package mapped to two Epics fails as `invalid`, a choice the spec does not settle.
