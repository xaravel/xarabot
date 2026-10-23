---
title: 'Story 1.6: `next` for a builder lane'
type: 'feature'
created: '2026-10-22'
status: 'done'
baseline_revision: '8e43f44f008c33ea76ecd57ac10e5ebf752e0f28'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A builder lane needs to pick its next Story in code, from one `main` snapshot, with a test for each input. Without that, selection lives in prompt prose, and gates (Epic dependencies, retro verdicts, Epic context, ledger states, `depends_on`, glob overlap, Infrastructure approval) can't be tested (FR2, AR14, AR28).

**Approach:** Add a zod `Snapshot` schema with AR28's named fields, a pure `assembleSnapshot` that builds it from raw `main` and ledger files with the existing loaders, and a pure `next(snapshot, laneRole)`. For a builder, `next` returns one Story unit, an Infrastructure Story to park as `needs-approval`, `idle` with a reason, or `stop` with a reason. Every non-`stop` outcome lists why each Story or Epic was passed over.

## Boundaries & Constraints

**Always:**
- Core stays pure (AR2): `src/core/` imports only `zod` and core. It reads no clock, env, fs or network, and never throws. `next` never fails: a bad input is a `stop` outcome.
- **Snapshot fields (AR28):** `now`; `main_sha`; `ledger` (`tip`, `units` = unit records sorted by unit, `coordinator`); `config`; `policy` (with `effective_protected_paths`); `standing_authority` (`frontmatter`, `body`); `manifests` (each parsed manifest plus `sha`, its git blob SHA on `main`); `graph` (the `resolveGraph` result, `{ok:true,value}` or `{ok:false,error:{kind,message}}`); `sprint_status` (`development_status`, a map from key to status); `retro_gates`; `escalations` (`{open: StoryId[]}` or `null` when no source is configured); `epic_context` (Epic number → `valid | missing | empty | wrong-heading`); `prs` (unit id → `{number, state: open|closed|merged, head_sha}`); `lane` (`LaneIdentity`); `role` (`builder | coordinator`).
- **`assembleSnapshot(input)`** takes `{repo, now, tree, files}` (a `RepoSnapshot`), `main_sha`, `blob_shas` (path → SHA), `ledger_tip`, `ledger_files`, `prs`, `escalations`, `lane`, `role`. Each error is a lane stop, returned as `err`: config errors from `loadRepoConfig` with their kind; ledger errors from `parseLedger` (`stop`/`invalid`); a bad `sprint-status.yaml` (`invalid`); a listed context or status file whose content is missing (`unreadable`); a manifest with no `blob_shas` entry, or a result that fails `SnapshotSchema` (`invalid-snapshot`). A graph failure is not an assembler error: it goes into `graph`. When it fails, `manifests` is `[]`, `epic_context` is `{}` and `retro_gates` is empty. An absent `sprint-status.yaml` reads as `{development_status: {}}`.
- **Epic context:** the path is `epic_context_path` with every `<N>` replaced. It is `missing` when not in the tree, `empty` when its text is empty or whitespace only, `wrong-heading` unless it starts with `# Epic <N> Context:`, and otherwise `valid`. Every Epic in the graph gets an entry.
- **Done:** a Story is done when `sprint_status.development_status[sprint_key] === "done"`. An Epic in `bootstrapped_epics` counts as all Stories done and retro done.
- **Epic gate for Epic D** (not bootstrapped). D is held when any of these holds:
  - Dependencies: for each Epic X in D's `depends_on` that isn't bootstrapped, X has no Story headings, X has an unmanifested heading, a Story of X is not done, or `retro_gates.epics[X].retro` is absent. The reason names X and the cause.
  - A rejected retro: any Epic E with `retro.verdict === "rejected"` and no `go` holds every Epic that reaches E through `depends_on` (distance ≥ 1). The reason names E's rejected retro. `accepted` and `accepted-with-open-items` hold nothing.
  - Epic context: `epic_context[D] !== "valid"`. The reason names D and its context path.
  - A held Epic's Stories are never returned. A bootstrapped Epic's Stories are never candidates.
- **Story eligibility,** for an unheld Epic, in its sorted manifest order. A Story is passed over when any of these holds:
  - It is done (silently, with no reason).
  - Its record is `claimed`, `merging`, `parked` or `merged`. Only an absent or `released` record is eligible.
  - It is unclaimable (`resolveManifestGlobs` gives `unclaimable`).
  - A `depends_on` Story is not satisfied. A dependency is satisfied when its Epic is bootstrapped, its manifest's `sprint_key` is done, or the ledger holds `story:<id>` as `merged`. The reason names the Story it waits on.
  - The Story is in `escalations.open`.
  - One of its globs overlaps (`globsOverlap`) a `heldGlobs` entry of another unit's record.
- **Choice:** the lowest Epic number first, then the lowest Story id (`compareStoryIds`). The first surviving Story is chosen. If it is Infrastructure and its record's `approval?.manifest_sha` differs from its manifest's `sha`, the outcome is `park` (`needs-approval`); otherwise it is `unit`.
- **Always listed in `reasons`,** whatever the gates say: unmanifested headings (`graph.unmanifested`) and unclaimable manifests, outside bootstrapped Epics.
- **`stop`** when `SnapshotSchema` rejects the snapshot, `graph.ok` is false (the reason is the graph error's message), `laneRole` differs from `snapshot.role`, `resolveManifestGlobs` returns `invalid`, or `laneRole` is `coordinator` (its selection is Epic 2).

**Never:**
- No stale takeover (Epic 2), retro-item or checkpoint gates (Epic 4), coordinator units, ledger writes, forge calls or lane process.
- No new dependency, and no change to existing exports' behaviour.

## I/O & Edge-Case Matrix

Outcome shapes:
- `{kind: "unit", story, reasons}` and `{kind: "park", park: "needs-approval", story, reasons}`. Here `story` is `{unit, story_id, epic, sprint_key, title, manifest_path, manifest_sha, globs, infrastructure, expect_generation}`, and `expect_generation` is the released record's `generation`, or `null` when there is no record.
- `{kind: "idle", reason, reasons}`.
- `{kind: "stop", reason}`.
- Each entry of `reasons` is `{subject, code, message}`. `code` is one of `unmanifested | unclaimable | dependency-epic | retro-rejected | epic-context | record-state | depends-on | escalation | overlap`. `subject` is `epic:<N>` or a unit id.
- `idle.reason` joins the Epic-level and Story-level messages with `; `, or says `no Story left to build` when there are none.

| Scenario | Input / State | Expected |
|---|---|---|
| Happy | Epic 1 bootstrapped, Epic 2 context valid, Stories 2.1 and 2.2 with no records | `unit` 2.1, `expect_generation: null` |
| Dependency Story not done | Epic 2 depends on 1, Story 1.2 `review` | `idle`, reason names Epic 1 |
| Dependency has no Stories, or has no retro | Epic 1 has no headings, or has no `retro` entry | `idle`, reason names Epic 1 |
| Dependency bootstrapped | Epic 1 bootstrapped with no Stories and no retro | Epic 2 eligible, no `unmanifested` reason for 1.x |
| Context | context missing, empty, or wrong heading; or bootstrapped | `idle` naming the Epic and its context; bootstrapped is exempt |
| Rejected retro | Epic 1 rejected without `go`; Epic 3 depends on 2, which depends on 1 | Epics 2 and 3 held, reason names Epic 1's rejected retro; with `go`, or `accepted*`, not held |
| Record states | absent, released (gen 4), claimed, merging, parked, merged | first two eligible (`expect_generation` null and 4), others give `record-state` |
| Done, record deleted | `done`, no record | never returned |
| `depends_on` | 2.2 depends on 2.1, which is not done and not merged; then done; then merged | `depends-on` naming 2.1; eligible; eligible |
| Overlap | 2.1 `claimed` holding `src/a/**`; 2.2 globs `src/a/b/**` | 2.2 skipped with `overlap` |
| Infrastructure | no record; released with matching approval; released with a stale approval | `park`; `unit`; `park` |
| Unmanifested and unclaimable | heading 2.3 with no manifest; 2.4 with a `path_key` value missing from the map | both listed, never returned |
| Order | eligible 3.1, 2.10, 2.9, 2.9a | 2.9 |
| Stop | graph cycle; malformed snapshot; role mismatch; coordinator | `stop` with the reason |

</intent-contract>

## Code Map

- `src/core/config/load-repo-config.ts:loadRepoConfig`, `RepoSnapshot`, `RepoLayer` -- config, policy and Standing Authority for the assembler. Reuse.
- `src/core/graph/resolve-graph.ts:resolveGraph` -- takes `{tree, files, config}`; `Config` is a superset of `GraphConfig`. `ResolvedGraph`: `epics[{number,title,depends_on,checkpoint,stories}]`, `edges`, `checkpoints`, `unmanifested[{id,epic,line}]` (bootstrapped Epics already excluded), `retroGates`, `hash`. `ResolvedEpic.stories` holds manifested ids only.
- `src/core/manifests/parse-manifest.ts:loadManifests`, `resolveManifestGlobs` -- manifests for the snapshot, and globs or `unclaimable`. `Manifest` type in `src/core/schemas/manifest.ts`.
- `src/core/manifests/globs.ts:globsOverlap`; `src/core/ledger/edits.ts:heldGlobs`; `src/core/ledger/codec.ts:parseLedger`.
- `src/core/schemas/ledger.ts` -- `UnitRecordSchema`, `CoordinatorRecordSchema`, `LaneIdentity`, `GitSha`, `UnitId`. `src/core/schemas/{config,policy,standing-authority,retro-gates,epics-yaml,common}.ts` -- `ConfigSchema`, `PolicySchema`, `StandingAuthorityFrontmatterSchema`, `RetroGatesSchema`, `EpicKey`, `IsoDateTime`, `parseYaml`, `describeIssues`.
- `src/core/graph/retro-gates.ts:emptyRetroGates`; `src/core/story-id.ts:compareStoryIds`, `StoryId`.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` -- the stock shape: a `development_status` map of key → status, plus other top-level keys (comments, `action_items`) that are ignored.
- `test/core/graph/resolve-graph.test.ts` -- the `epicsMd` and `manifest` fixture-builder style. `test/support/boundaries.ts` -- the core purity check.

## Tasks & Acceptance

**Execution:**
- `src/core/schemas/sprint-status.ts` -- `SprintStatusSchema` (loose object; `development_status` record of string → string, default `{}`).
- `src/core/schemas/snapshot.ts` -- `SnapshotManifestSchema`, `ResolvedGraphSchema`, `GraphResultSchema`, `EpicContextState`, `PrStateSchema`, `LaneRole`, `SnapshotSchema`, inferred types.
- `src/core/next/sprint-status.ts` -- `parseSprintStatus(path, text)`, which returns `Result`.
- `src/core/next/snapshot.ts` -- `epicContextState`, `assembleSnapshot`.
- `src/core/next/next.ts` -- `next(snapshot, laneRole)` and its outcome types.
- `test/core/next/{fixtures.ts,snapshot.test.ts,next.test.ts,sprint-status.test.ts}` -- case tables for each matrix row and each gate, with no mocks. Snapshots are built through `assembleSnapshot` from file fixtures.

**Acceptance Criteria:**
- Given each matrix row, when `next(assembleSnapshot(...), "builder")` runs, then it returns the expected outcome kind, Story and reason codes.
- Given each assembler error case (bad config, ledger `schema_version: 2`, bad status YAML, a manifest with no SHA), when `assembleSnapshot` runs, then it returns `err` with that kind.
- Given the repo, when `bun install`, `bun test`, `bun --bun oxlint` and `bun --bun tsc` run, then each exits 0 and the boundary check is clean.

## Spec Change Log

## Review Triage Log

### 2026-10-22 — Review pass
- verdicts: 24 findings — high 0, medium 0, low 16, false 8, maybe-false 0
- findings:
  - `[false]` `[reject]` (intent-alignment) the context-heading check runs in the assembler, not in `next`. The spec puts a classified `epic_context` state in the Snapshot (AR28: "whether its Epic context file on `main` is valid"), and `next` gates on it.
  - `[false]` `[reject]` (intent-alignment) a rejected retro on a bootstrapped Epic still holds its dependents. AD-12's rejected-retro rule applies to any Epic E. Bootstrapped means "retro done", and a rejected retro is a done retro that still holds until the go. Failing closed is the intended reading.
  - `[false]` `[reject]` (intent-alignment) gate tests go through `assembleSnapshot`. Every case still calls `next` on a validated `Snapshot`, with no mocks, as the AC asks.
  - `[false]` `[reject]` (intent-alignment) `next` never reads some Snapshot fields (`now`, `policy`, `prs` and others). AR28 names them for every core function; builder selection needs none of them before stale takeover (Epic 2).
  - `[low]` `[reject]` (intent-alignment) `blob_shas` is a new assumption about what the Forge `snapshot()` will supply. A forge tree listing carries blob SHAs, so Story 1.7/1.8 can supply it. Nothing calls the assembler yet.
  - `[low]` `[patch]` (verification-gap) the released-record overlap test asserted only the chosen Story. It now asserts there is no `overlap` reason, and new cases (2.1 done with a `released` or `merged` record holding `src/a/**`) expect `unit 2.2`.
  - `[low]` `[patch]` (verification-gap) no test covered an unclaimable manifest in a bootstrapped Epic. Added a case that expects `unit 2.1` with no reasons.
  - `[low]` `[patch]` (edge-case) a non-canonical `depends_on` id ("2.01" for manifest "2.1") was never satisfied. Manifests are now looked up by the numeric key, and the dependency's ledger record by its manifest's `story_id`. Tests added.
  - `[low]` `[patch]` (edge-case) a non-canonical id in `escalations.open` was ignored. It is now matched by the same key. Test added.
  - `[low]` `[patch]` (edge-case) a `sprint_key` that names an `Object.prototype` member printed a function in the reason. Statuses are now read with `Object.hasOwn`. Test added.
  - `[false]` `[reject]` (edge-case) a hand-built snapshot whose `epic.stories` has an id with no manifest is skipped silently. The assembler always builds both from the same manifests, and a `next` on such a snapshot was not shown to be reachable.
  - `[low]` `[patch]` (blind) the non-canonical `depends_on` lookup. Same root cause and fix as the edge-case row.
  - `[low]` `[reject]` (blind) assembler error kinds collide (`invalid` from config, ledger or status). Every one stops the lane, and the message names the file. Separate kinds would add public surface for no caller.
  - `[false]` `[reject]` (blind) a `loadManifests` failure becomes `invalid-snapshot`, untested. That branch runs only after `resolveGraph`, which calls `loadManifests` on the same input and succeeded, so it cannot be reached. It is a fail-closed guard.
  - `[low]` `[patch]` (blind) the hand-copied `ResolvedGraphSchema` and `SnapshotManifestSchema` could drift from their TS types and fail at runtime. Added a type-only check (assignable both ways, plus exact keys) in `src/core/schemas/snapshot.ts`. A deliberate drift was confirmed to fail `tsc`.
  - `[low]` `[reject]` (blind) `next.ts` imports `epicContextPath` from the assembler module. Both are pure core, and no harm was named beyond the shape of the import graph.
  - `[false]` `[reject]` (blind) `merged` counts for `depends_on` but not for the Epic gate. The AC states exactly this: the Epic gate reads `sprint-status.yaml`, and `depends_on` also accepts a `merged` record (AR11, AR13).
  - `[low]` `[reject]` (blind) the `depends-on` message gives no cause. Cosmetic, and the dependency's own reason or status shows the cause.
  - `[low]` `[patch]` (blind) the weak overlap test. Same root cause and fix as the verification-gap row.
  - `[low]` `[reject]` (blind) a test reads the live `sprint-status.yaml`. The key it checks (Story 1.1 `done`) stays fixed under sprint planning, so a break is unlikely.
  - `[low]` `[reject]` (blind) a graph `stop` drops `error.kind`. Adding a structured code is new public surface, and no caller routes on it yet.
  - `[low]` `[reject]` (blind) one Story can get several `overlap` reasons. Cosmetic noise in `reasons`, and merging them adds code.
  - `[low]` `[reject]` (blind) `unit` outcomes carry reasons from later Epics. Harmless: `reasons` is diagnostic, and the always-listed reasons need the full walk anyway.
  - `[low]` `[reject]` (blind) the spec's task list omits `epicContextPath`. The fix edits this build's spec.

## Design Notes

- **Graph failure is data, not an assembler error.** The AC wants `next` to stop with the validation reason, so the snapshot carries the `resolveGraph` result. Config and ledger failures stop the lane before `next`, as AD-20 requires.
- **An Epic's Stories are its headings.** A dependency Epic with an unmanifested heading can never be all done, since that Story is never built. This keeps the gate closed until a planning unit adds the manifest.
- **The manifest SHA is the forge's blob SHA.** Core doesn't hash files. The repo may use SHA-1 or SHA-256 objects, and `approval.manifest_sha` is a `GitSha`.
- **The park outcome only describes the Story.** `parkNew` needs no record. A released Story with a stale approval also comes back as `park`, and the lane (Story 1.16) chooses the edit.

## Verification

**Commands:**
- `bun install` -- expected: exit 0, `bun.lock` unchanged.
- `bun test` -- expected: exit 0.
- `bun --bun oxlint` -- expected: exit 0.
- `bun --bun tsc` -- expected: exit 0.

## Auto Run Result

Status: done

**Summary:** Added builder-lane unit selection as pure core code:
- a zod `Snapshot` schema with AR28's named fields;
- a pure `assembleSnapshot` that builds it from raw `main` and ledger files with the existing loaders, carrying a graph failure as data;
- a pure `next(snapshot, laneRole)`. It returns a Story `unit`, an unapproved Infrastructure Story as `park` (`needs-approval`), `idle` with a reason, or `stop`. Every non-`stop` outcome lists coded reasons.

**Files changed:**
- `src/core/schemas/sprint-status.ts`: `SprintStatusSchema`, a `development_status` map.
- `src/core/schemas/snapshot.ts`: `SnapshotSchema` and its parts (manifests with blob SHA, resolved graph result, Epic context state, PR state, lane role), plus a type-level drift check against `ResolvedGraph` and `Manifest`.
- `src/core/next/sprint-status.ts`: `parseSprintStatus` and `emptySprintStatus`.
- `src/core/next/snapshot.ts`: `assembleSnapshot`, `epicContextState` and `epicContextPath`.
- `src/core/next/next.ts`: `next` and its outcome and reason types. The gates are the dependency Epic, rejected retro, Epic context, record state, unclaimable, `depends_on`, escalation and overlap. The choice is the lowest Epic, then the lowest Story id.
- `test/core/next/{fixtures,next.test,snapshot.test,sprint-status.test}.ts`: case tables with no mocks, covering every matrix row, each gate and each assembler error kind.

**Review findings:** 24 findings: low 16, false 8. Every finding has a row in the Review Triage Log.
- Patched (6 entries, all low):
  - canonical Story-id lookup for `depends_on` and escalations;
  - `Object.hasOwn` status reads;
  - the schema/type drift check;
  - a stronger released-record overlap test;
  - a test for an unclaimable manifest in a bootstrapped Epic.
- Deferred: none.
- Rejected, with reasons in the log:
  - the context check living in the assembler;
  - a rejected retro on a bootstrapped Epic still holding;
  - tests going through the assembler, and unread Snapshot fields;
  - the `blob_shas` interface;
  - colliding assembler error kinds;
  - the unreachable `loadManifests` branch;
  - the module import direction;
  - `merged` versus `done` (settled by the AC);
  - message wording, duplicate overlap reasons, and reasons from later Epics;
  - the live status-file test;
  - `stop` with no error code;
  - spec drift.

**Follow-up review recommended:** false. Six low entries were patched, with no high and no medium.

**Verification:**
- `bun install`: exit 0, `bun.lock` unchanged.
- `bun test`: 932 pass, 0 fail.
- `bun --bun oxlint`: exit 0.
- `bun --bun tsc`: exit 0.

**Residual risks:**
- `assembleSnapshot` needs a valid `ledger_tip` SHA and a `blob_shas` entry per manifest, which the Forge snapshot (Stories 1.7 and 1.8) must supply.
- A released Infrastructure Story with a stale approval comes back as `park`, but `parkNew` needs no record, so the lane (Story 1.16) must choose a legal edit.
- A rejected retro on a bootstrapped Epic holds its dependents until the go is recorded.
- Stale takeover, retro-item and checkpoint gates, and coordinator selection are not built yet (Epics 2 and 4).
