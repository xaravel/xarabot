---
title: 'Story 1.3: Story manifests and the `epics.md` grammar'
type: 'feature'
created: '2026-10-22'
status: 'done'
baseline_revision: '7eda0090356eddc65b59dd36cbb5a4930ca74fc6'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Claims, the guard and `resolveGraph` (Story 1.4) all need the same view of each Story: its manifest fields and globs, and the Epic and Story headings in `epics.md`. Nothing parses either yet, so each consumer would invent its own reading (AR11, AR12).

**Approach:** Add pure core functions: a zod manifest schema and parser (frontmatter of one Markdown file per Story), glob normalization and the case-folded literal-prefix overlap test, path-key resolution that reports a Story unclaimable, a manifest-directory loader, an `epics.md` heading parser and a Story-id comparator.

## Boundaries & Constraints

**Always:**
- Everything is in `src/core/` and pure (AR2): no filesystem, clock, environment or `fetch`; return `Result` from `src/core/result.ts` and never throw. Every error `message` starts with the file's repo path, then `: `.
- **Story id:** a manifest's `story_id` and each `depends_on` entry match `^\d+\.\d+[a-z]?$` exactly (the AC's pattern).
- **Manifest** = a Markdown file whose YAML frontmatter (split with Story 1.2's `splitFrontmatter`) holds: required `story_id`, `epic` (positive integer), `sprint_key` (non-empty string), `title` (non-empty string); exactly one of `globs` (list of strings) or the configured `manifests.path_key` (a non-empty string value); optional `depends_on` (list of ids, default `[]`) and `infrastructure` (boolean, default `false`). Other keys, `status` included, are accepted and dropped from the result. No `schema_version` (AD-10 defines none).
- `epic` must equal the numeric value of `story_id`'s part before the dot, or the manifest is invalid.
- **Glob normalization:** strip every leading `./`; then reject an empty glob, a leading `!`, a leading `/` or `~`, a backslash, and any empty, `.` or `..` path segment. A rejected glob makes the manifest (or, for a `path_map` glob, the config) invalid.
- **Literal prefix** = the normalized glob up to its first `*`, `?`, `[` or `{`. Two globs overlap when one case-folded (`toLowerCase`) literal prefix starts with the other.
- **Path key:** the key's value is looked up in `manifests.path_map`; an unmapped value, or a manifest whose `globs` is `[]`, gives error kind `unclaimable` with the reason in the message.
- **Manifest directory:** the manifests are the tree entries directly inside `manifests.dir` ending in `.md`, read in sorted path order. No `manifests` config → no manifests (`[]`). Two manifests with one `story_id` → error.
- **`epics.md` grammar:** lines split on `\r?\n`. A fence opens on a line starting (after up to 3 spaces) with 3+ backticks or tildes and closes on a line of the same character, at least as long, with nothing else; an unclosed fence runs to the end. Outside fences: `^## Epic (\d+):` starts an Epic; any other level-2 heading ends the current Epic; `^### Story (\d+)\.(\d+[a-z]?):` is a Story whose id is the text as written (`2.6a`). `### Epic` lines and every other heading are ignored.
- **Story id order:** numeric Epic part, then numeric Story part, then suffix (none before `a` before `b`).

**Never:**
- No graph building, Epic dependencies, `.xarabot/epics.yaml`, validation of `depends_on` targets, or bootstrapped-Epic handling (Story 1.4).
- No claim, ledger, inbox or write-check code; no reading `story_spec_path` matches; no CLI command.
- No new dependency; no change to Story 1.2's config schema beyond what the loader needs (none expected).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid manifest | `story_id: 2.6a`, `epic: 2`, `sprint_key`, `title`, `globs: [./src/a/**]`, `status: done`, `component_owner: x` | ok; globs `["src/a/**"]`, `depends_on: []`, `infrastructure: false`; no `status` in result | — |
| Path key | config `path_key: component`, `component: core` | ok; paths `{kind: "key", key: "component", value: "core"}` | — |
| Missing field | no `sprint_key` / no `title` / no `epic` | err `invalid`, names field | — |
| Bad id | `story_id: 1.7A`, `depends_on: [x]` | err `invalid` | — |
| Epic mismatch | `story_id: 1.3`, `epic: 2` | err `invalid` | — |
| Neither/both paths | no `globs` and no key; or both | err `invalid` | key ignored when config has no `path_key` |
| No frontmatter / bad YAML | — | err `invalid` / `invalid-yaml` | — |
| Bad glob | `!src/**`, `../x`, `/abs`, `src/../x` | err `invalid` naming the glob | — |
| Overlap | `src/a/**`~`src/A/b.ts`, `src/a*`~`src/ab/x.ts` | overlap true | `src/a/**` vs `src/ab/**` → false |
| Unmapped key | `component: nope`, not in `path_map` | err `unclaimable`, message names key and value | — |
| Empty globs | `globs: []` | parse ok; resolve → err `unclaimable` | — |
| Loader | dir with `1.1.md`, `1.2.md`, `README.txt`, `sub/x.md` | two manifests, sorted by path | listed but unread → `unreadable`; duplicate id → `duplicate-story` |
| epics.md | this repo's file (fixture copy) | Epics 1–7; 63 Stories incl. `1.16a`, `1.17a`, `5.1a` | — |
| Fenced heading | `## Epic 9:` inside ```` ``` ```` | ignored | — |
| Epic List | `### Epic 1:` under `## Epic List` | ignored | — |
| Story mismatch | `### Story 2.1:` under `## Epic 1:` | err `invalid`, names line | — |
| Orphan Story | `### Story 1.1:` before any Epic, or under `## Overview` | err `invalid` | — |
| Duplicates | Epic number or Story id repeated | err `invalid` | — |
| Sort | `2.10, 2.6a, 2.6` | `2.6, 2.6a, 2.10` | — |

</intent-contract>

## Code Map

- `src/core/result.ts` -- `Result`, `ok`, `err`; reuse.
- `src/core/schemas/common.ts` -- `parseYaml` (never throws), `describeIssues`, `NonEmpty`; reuse. Do not use `parseVersioned` (manifests have no `schema_version`).
- `src/core/config/load-repo-config.ts:splitFrontmatter` -- exported frontmatter splitter (handles BOM, CRLF); reuse for manifests. `RepoSnapshot` (`tree`, `files`) and `readFile` show the missing/unreadable convention (`Object.hasOwn`).
- `src/core/schemas/config.ts:ManifestsConfigSchema` -- `{dir, path_key?, path_map?}`; `ManifestsConfig` type. `path_map` values are non-empty lists but unnormalized.
- `src/core/config/story-spec-path.ts` -- existing stricter id regex for spec globs; leave unchanged.
- `test/support/boundaries.ts` -- purity/layer check run over all `src/` by `test/boundaries.test.ts`; core may import only `zod` and core.
- `test/core/config/story-spec-path.test.ts` -- test style (bun:test, case tables, fixtures built in code).
- `_bmad-output/planning-artifacts/epics.md` -- no fenced code; `## Epic List` at line 221 holds `### Epic N:` lines; Epic headings 1–7; Story counts per Epic 22, 12, 6, 7, 4, 5, 7.

## Tasks & Acceptance

**Execution:**
- `src/core/story-id.ts` -- `STORY_ID_PATTERN`, `StoryId` zod schema, `compareStoryIds(a, b)`.
- `src/core/manifests/globs.ts` -- `normalizeGlob(glob): Result<string, "invalid">`, `literalPrefix`, `globsOverlap(a, b)`.
- `src/core/schemas/manifest.ts` -- `ManifestFrontmatterSchema` (loose object), `Manifest` type with `paths: {kind: "globs", globs} | {kind: "key", key, value}`.
- `src/core/manifests/parse-manifest.ts` -- `parseManifest(path, text, manifestsConfig?)`, `resolveManifestGlobs(manifest, manifestsConfig?)` → `Result<string[], "unclaimable" | "invalid">`, `loadManifests({tree, files}, manifestsConfig?)`.
- `src/core/graph/epics-md.ts` -- `parseEpicsMd(path, text)` → `Result<{epics: {number, title, line, stories: {id, epic, title, line}[]}[]}, "invalid">`.
- `test/fixtures/epics.md` -- byte copy of `_bmad-output/planning-artifacts/epics.md`.
- `test/core/story-id.test.ts`, `test/core/manifests/globs.test.ts`, `test/core/manifests/parse-manifest.test.ts`, `test/core/graph/epics-md.test.ts` -- every matrix row as case tables.

**Acceptance Criteria:**
- Given the fixture copy of this repo's `epics.md`, when `parseEpicsMd` runs, then it returns Epics 1–7 in order with every Story id from the file, lettered ids included.
- Given `src/core/manifests/`, `src/core/graph/`, `src/core/story-id.ts`, when `bun test` runs the boundary check, then no violation is reported.
- Given the repo, when `bun install`, `bun test`, `bun --bun oxlint`, `bun --bun tsc` run, then each exits 0.

## Spec Change Log

## Review Triage Log

### 2026-10-22 — Review pass
- note: the staged diff left out `test/fixtures/epics.md`, a byte copy of the planning `epics.md` checked with `cmp`, to keep the review readable; every other change since the baseline was included.
- verdicts: 37 findings — high 0, medium 2, low 26, false 9, maybe-false 0
- findings:
  - `[low]` `[patch]` (verification-gap) `compareStoryIds`'s fallback for ids that don't match the pattern is untested — added a mixed valid/invalid case-table row, in both argument orders.
  - `[false]` `[reject]` (intent-alignment) claims, the guard and the graph don't consume the parsers yet — the Story's ACs ask only for the parsers; those consumers belong to Stories 1.4, 1.6 and the lane Stories.
  - `[low]` `[reject]` (intent-alignment) `loadManifests` isn't wired through `loadRepoConfig` — it takes `config.manifests` directly; Story 1.4's `resolveGraph` makes that call. Wiring it here would be a new surface the AC doesn't ask for.
  - `[false]` `[reject]` (intent-alignment) "reported unclaimable" should reach the inbox — the inbox is a later Epic; the AC's report is the `unclaimable` error and its reason, which is returned.
  - `[false]` `[reject]` (intent-alignment) "maps to no paths" may mean "the globs match no file in the tree" — the AC's case is the path key mapping to nothing, which is the `path_map` lookup; matching against the tree is the claim's work.
  - `[low]` `[reject]` (intent-alignment) extra glob rejections (`~`, empty segments, trailing `/`), and a `C:/x` drive path is accepted — repos are POSIX paths, and a Maintainer writes `src/**`, not `src/`; adding a drive rule is new complexity for a case nobody meets.
  - `[false]` `[reject]` (intent-alignment) the fixture isn't in the diff and the test hard-codes line numbers — the fixture was left out on purpose (byte copy, `cmp`-checked), and fixed line numbers are right for a frozen fixture; the real-file check is added by the blind row below.
  - `[false]` `[reject]` (intent-alignment) strictness beyond the AC (exactly one of globs or key, quoted ids, duplicate and orphan headings) — the spec chose each of these to fail closed (Design Notes); quoting is needed because YAML reads `1.10` as `1.1`.
  - `[medium]` `[patch]` (edge-case) a near-miss Story heading (`### Story 1.5 :`, no colon, `1.5A`) is skipped without an error — a line starting `### Story`, or `## Epic <digit>`, that doesn't match the grammar now returns `invalid` naming the line; tests added.
  - `[low]` `[reject]` (edge-case) headings indented 1–3 spaces aren't recognized — stock `bmad-create-epics-and-stories` output never indents headings; supporting it widens the grammar for no known writer.
  - `[low]` `[reject]` (edge-case) a level-1 heading doesn't close the current Epic — stock output has a single `#` title at the top; a Story after a later `#` either matches its Epic number or already fails as a mismatch.
  - `[low]` `[reject]` (edge-case) headings inside multi-line HTML comments are parsed — stock output has no such comments; tracking comment state is new machinery.
  - `[low]` `[reject]` (edge-case) `### Story 01.01:` keeps id `01.01`, which won't join a manifest `1.1` — no writer emits leading zeros; canonical ids would be new public surface, and Story 1.4 owns the heading–manifest join.
  - `[low]` `[reject]` (edge-case) empty titles after the colon are accepted — stock output always writes a title; the id is what consumers key on.
  - `[low]` `[reject]` (edge-case) an empty `epics.md` parses as no Epics — Story 1.4 then fails every manifest as "no heading"; a "no Epics" rule here would be a new rule.
  - `[low]` `[reject]` (edge-case) a backtick fence whose info string has a backtick opens a fence by mistake — a line-initial ```` ```x``` ```` is rare in planning prose; reject.
  - `[false]` `[reject]` (edge-case) `src/{..,a}/x` escapes the directory — diff paths are normalized repo paths with no `..`, so the `..` alternative matches nothing; the literal prefix `src/` stays sound.
  - `[low]` `[reject]` (edge-case) whitespace-only or padded globs pass — they match nothing, so the Story's claim covers nothing and the build fails loudly; rare.
  - `[false]` `[reject]` (edge-case) extglob `@(a|b)` makes the literal prefix too long — `Bun.Glob` has no extglob, so `@(` is literal and the prefix is correct.
  - `[low]` `[reject]` (edge-case) `path_key` naming a reserved field (`globs`, `title`) — confusing, but it still fails closed or is unclaimable; refusing it belongs in Story 1.2's config schema, a Maintainer-only file.
  - `[low]` `[reject]` (edge-case) `1.1` and `1.01` both pass the duplicate check — same root cause as the leading-zero row.
  - `[low]` `[reject]` (edge-case) a stray `README.md` in the manifest directory fails the whole load — the spec makes every `.md` there a manifest, and failing closed is intended.
  - `[false]` `[reject]` (edge-case) the same path listed twice in the tree collides with itself — a git tree listing never repeats a path.
  - `[low]` `[reject]` (edge-case) `depends_on` can list the Story itself or repeat an entry — validating `depends_on` targets is Story 1.4's graph validation (a self-edge is a cycle).
  - `[low]` `[reject]` (edge-case) whitespace-only `sprint_key` or `title` passes — rare in Maintainer-written files, and a blank `sprint_key` fails loudly at the sprint-status lookup.
  - `[low]` `[reject]` (blind) leading-zero ids are compared numerically by `parseEpicsMd` but as raw text by `loadManifests` — same root cause as the edge-case leading-zero row.
  - `[medium]` `[patch]` (blind) near-miss Story and Epic headings are dropped — same fix as the edge-case near-miss row.
  - `[low]` `[reject]` (blind) headings are matched more narrowly than CommonMark (indent, closing `##`, setext, comments) — same as the indented-heading and comment rows; stock output uses none of them.
  - `[low]` `[patch]` (blind) the real planning `epics.md` is never parsed, so a grammar break there won't fail CI — added a test that parses it and checks its ids against a `### Story` scan.
  - `[low]` `[patch]` (blind) `normalizeGlob` repeats `isRepoRelative`, so globs and `RepoPath` could drift — `normalizeGlob` now calls `isRepoRelative`.
  - `[low]` `[patch]` (blind) a bad `path_map` glob is reported only when a manifest uses that key — `loadManifests` now normalizes every `path_map` glob up front; test added.
  - `[low]` `[reject]` (blind) Epic 0 is accepted by the id pattern and `epics.md` but not by the manifest schema — the AC fixes the id pattern as `^\d+\.\d+[a-z]?$`; no repo uses Epic 0.
  - `[low]` `[reject]` (blind) empty titles accepted — same as the edge-case empty-title row.
  - `[low]` `[patch]` (blind) the fence-close regex is rebuilt on every fenced line — built once when the fence opens. The info-string half is the edge-case backtick row, rejected.
  - `[low]` `[patch]` (blind) test gaps: `globs: [1]`, unquoted `depends_on` hint, invalid ids in `compareStoryIds`, `.MD` skipped, globs-only under a path key — tests added for each.
  - `[low]` `[patch]` (blind) the BOM in a test is an invisible literal — now written as the `\uFEFF` escape.
  - `[false]` `[reject]` (blind) `ma[3] ?? ""` is dead — under `noUncheckedIndexedAccess` the index is typed `string | undefined`, so tsc needs the fallback.

## Design Notes

- **Exactly one of `globs` or the path key.** AD-10 says "either `globs`, or a key"; a manifest carrying both would leave claims guessing which wins, so both is invalid.
- **Orphan Story headings fail.** A Story heading outside an Epic cannot be "under its Epic"; failing closed keeps the graph and the claims from silently losing a Story.
- **Epic consistency compares numbers** (`Number("1") === 1`), since the AC's id pattern admits digits only.

## Verification

**Commands:**
- `bun install` -- expected: exit 0, `bun.lock` unchanged.
- `bun test` -- expected: exit 0, new tests pass, boundary test clean.
- `bun --bun oxlint` -- expected: exit 0.
- `bun --bun tsc` -- expected: exit 0.

## Auto Run Result

Status: done

**Summary.** Adds pure `src/core` parsers so claims, the guard and the graph all read Stories one way (AR11, AR12):
- the Story manifest schema and parser;
- glob normalization and the case-folded literal-prefix overlap test;
- path-key resolution that reports a Story `unclaimable`;
- a manifest-directory loader;
- the `epics.md` Epic and Story heading parser;
- Story-id ordering.

**Files changed.**
- `src/core/story-id.ts`: `STORY_ID_PATTERN`, the `StoryId` schema (an unquoted YAML number is refused with a quoting hint) and `compareStoryIds`.
- `src/core/manifests/globs.ts`: `normalizeGlob` (reuses `isRepoRelative`), `literalPrefix` and `globsOverlap`.
- `src/core/schemas/manifest.ts`: `ManifestFrontmatterSchema` (accepts extra keys) and the `Manifest` / `ManifestPaths` types.
- `src/core/manifests/parse-manifest.ts`: `parseManifest`, `resolveManifestGlobs` (`unclaimable` for an unmapped key or `globs: []`) and `loadManifests` (checks every `path_map` glob up front, finds duplicate ids).
- `src/core/graph/epics-md.ts`: `parseEpicsMd`. It skips fenced code and the Epic List, and fails on a Story under the wrong Epic, an orphan Story, repeats, and near-miss Epic or Story headings.
- `test/fixtures/epics.md`: byte copy of this repo's planning `epics.md`.
- `test/core/story-id.test.ts`, `test/core/manifests/globs.test.ts`, `test/core/manifests/parse-manifest.test.ts`, `test/core/graph/epics-md.test.ts`: case tables for every matrix row, the fixture (Epics 1–7, 63 Stories including `1.16a`, `1.17a`, `5.1a`) and a parse of the live planning file.

**Review findings.** 37 findings: 0 high, 2 medium, 26 low, 9 false.
- Patched:
  - the medium entry: near-miss headings were dropped silently (2 rows, one root cause);
  - low entries: a test for the `compareStoryIds` fallback, a live `epics.md` parse, `normalizeGlob` reusing `isRepoRelative`, an up-front `path_map` check, the fence regex built once, extra tests, and an escaped BOM.
- Deferred: none.
- Rejected, with reasons in the triage log:
  - consumer wiring and the inbox (later Stories);
  - the tree-match reading of "maps to no paths";
  - extra glob rules (drive paths, whitespace);
  - CommonMark heading variants (indent, setext, HTML comments, level-1 close);
  - leading-zero ids and Epic 0;
  - empty titles and an empty file;
  - backtick info strings;
  - `path_key` naming a reserved field;
  - a stray `README.md` in the manifest directory;
  - self `depends_on` (Story 1.4);
  - whitespace-only fields;
  - the `false` rows.

**Follow-up review recommended: false.** One medium entry was patched, and none was high.

**Verification.**
- `bun install`: exit 0, `bun.lock` unchanged.
- `bun test`: 362 pass, 0 fail. The boundary and purity check is clean.
- `bun --bun oxlint`: exit 0.
- `bun --bun tsc`: exit 0.

**Residual risks.**
- Manifest ids must be quoted in YAML.
- Leading-zero ids are compared numerically in `epics.md` but as text in manifests. No writer emits them.
- Story 1.4 must validate `depends_on` targets and join headings to manifests.
- The live-file test fails CI if planning writes a malformed heading. That is intended.
