---
title: 'Story 1.2: Config, policy and Standing Authority, failing closed'
type: 'feature'
created: '2026-10-22'
status: 'done'
baseline_revision: '45628a5e57187ac2ee9a2cc7a05d8970f791d8f2'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      Duplicate YAML keys in config, policy, Human Live Steps, the Standing Authority frontmatter and host.yaml are silently resolved to the last value.
    evidence: |-
      Bun.YAML.parse keeps the last of two equal keys without an error (probed with Bun 1.4.3), so `maintainer: a` followed by `maintainer: b` loads as `b`. Refusing it needs a raw key scan or another parser, as Story 1.4 does for `.xarabot/epics.yaml`. The files are Protected Paths that only the Maintainer changes, which limits the harm.
    location: >-
      src/core/schemas/common.ts:parseYaml
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Lanes have no typed config yet, so nothing stops a lane when `.xarabot/config.yaml`, `policy.yaml` or the Standing Authority on `main` is missing, broken or revoked (FR22, AR21, AR22). Later Stories (manifests, `resolveGraph`, `next`, lane install) need these fields and their defaults.

**Approach:** Add strict, versioned zod schemas in `src/core/schemas/` for config, policy, Human Live Steps, the Standing Authority frontmatter and `host.yaml`. Add a pure `loadRepoConfig(snapshot)` that turns a `main` snapshot (tree listing plus file contents, repo slug, server `now`) into the typed package and repo layers or a stop error, plus a pure `loadHostConfig` and a `storySpecGlob` expander.

## Boundaries & Constraints

**Always:**
- Everything is in `src/core/` and pure (AR2): no filesystem, clock, environment or `fetch`; return `Result` (`src/core/result.ts`) and never throw. `Bun.YAML.parse` is allowed (pure) but must be wrapped in `try`/`catch`.
- One zod schema per shape with `z.infer` types. Every object is strict (`z.strictObject`): an unknown key is invalid. Every file carries `schema_version: 1`; an integer other than `1` is error kind `unsupported-version`, checked before the full parse.
- Every stop error's `message` starts with the file's repo path, then `: ` and the reason (for example `.xarabot/policy.yaml: missing on main`).
- Config fields and defaults (field names are fixed by this spec):
  - required: `runner_version` (string), `maintainer` (GitHub login), `standing_authority_path` (repo-relative path);
  - `epics_path` `_bmad-output/planning-artifacts/epics.md`; `sprint_status_path` `_bmad-output/implementation-artifacts/sprint-status.yaml`; `retro_gates_path` `_bmad-output/implementation-artifacts/retro-gates.yaml`; `retro_doc_glob` `_bmad-output/implementation-artifacts/epic-<N>-retro-*.md`; `epic_context_path` `_bmad-output/implementation-artifacts/epic-<N>-context.md`;
  - `bootstrapped_epics` positive integers, default `[]`; `digest_time` `HH:MM` UTC, default `08:00`;
  - `manifests` optional `{dir, path_key?, path_map?}` (`path_key` and `path_map` both or neither; `path_map` maps a key value to a non-empty glob list);
  - `story_spec_path` default `_bmad-output/implementation-artifacts/spec-<epic>-<story>-*.md`, must contain `<epic>` and `<story>`;
  - `branches` `{story: "story/", xarabot: "xarabot/"}` defaults; `unit_budget_hours` default `6`; `ci_max_wait_minutes` default `60`; `proxy_hosts` default `[]`; `lockfile_command` optional non-empty argv list; `epic_packages` optional map from Epic number key (`^[1-9][0-9]*$`) to a non-empty package-name list.
- Policy: `unattended_adapters` (subset of `claude`, `codex`, `pi`, default `[]`), `expected_checks` (default `[]`), `protected_paths` (default `[]`), `owner_approval_paths` (default `[]`). Human Live Steps: `steps` list of `{id, text}` with unique ids, default `[]`.
- Standing Authority: YAML frontmatter between a leading `---` line and the next `---` line; body is free prose. `granted_at` and optional `expires` are ISO 8601 dates (`YYYY-MM-DD`) or date-times. A date-only `expires` is valid through the end of that UTC day.
- Effective Protected Paths = the mandatory list (`.xarabot/**`, the Standing Authority path, `.github/**`, `**/.agents/**`, `**/.claude/**`, `**/.codex/**`, `**/.pi/**`, `**/.mcp.json`, `**/AGENTS.md`, `**/CLAUDE.md`) followed by the policy's own entries, de-duplicated. A policy can add, never remove.
- Host layer: `host.yaml` with `schema_version: 1`, optional `host_id` (UUID), and `lanes` (map from lane name to `{repo "owner/name", role builder|coordinator, owner, agent claude|codex|pi, model?, effort low|medium|high|xhigh|max default high}`). A top-level or lane key that is a repo-layer key (any config, policy or Human Live Steps field) is refused with kind `repo-key-in-host`, naming the key.

**Never:**
- No shell I/O: no fetching `main`, no reading `host.yaml` from disk, no `XARABOT_HOST`/`XARABOT_MAX_BUILDERS` parsing, no CLI command. The lane Stories wire those.
- Don't parse `.xarabot/epics.yaml` (Story 1.4) or manifests (Story 1.3); pass `epics.yaml` through as raw text or `null`.
- No Escalation source (Story 7.6) and no re-check scheduling (lane Stories).
- Don't add a `.xarabot/config.yaml` to this repo; that is the Maintainer's self-host switch.

## I/O & Edge-Case Matrix

Snapshot: `{repo: "xaravel/xarabot", now: "2026-10-22T12:00:00Z", tree: string[], files: Record<path, text>}`.

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid | minimal config, policy, human-live-steps, authority; no epics.yaml | ok; defaults filled; `epicsYaml: null` | — |
| epics.yaml present | in tree and files | ok; raw text passed through | in tree, not in files → `unreadable` |
| Config missing | `.xarabot/config.yaml` not in tree | err `missing` | message names config path |
| Invalid YAML | `a: [1` | err `invalid-yaml` | — |
| Version | `schema_version: 2` | err `unsupported-version` | — |
| Schema | unknown key, `runner_version: 1.10` (number) | err `invalid`, reason names the field | — |
| Policy missing | not in tree | err `missing` naming policy path | — |
| Human Live Steps missing | not in tree | err `missing` | fail closed |
| Authority absent | not at configured path | err `missing` naming that path | — |
| Authority frontmatter | no `---` block, or bad field | err `invalid` | — |
| granted_by | ≠ config `maintainer` (compare case-insensitively) | err `authority-granted-by` | — |
| repo | ≠ snapshot repo (case-insensitive) | err `authority-repo` | — |
| expires | `2026-10-21` with now `2026-10-22T12:00Z` | err `authority-expired` | `2026-10-22` → still valid |
| Bad snapshot | `now` not ISO date-time, or `repo` not `owner/name` | err `invalid-snapshot` | — |
| Protected Paths | policy lists `src/**`, `.github/**` | effective = mandatory + `src/**`, no duplicate | — |
| Host repo key | `host.yaml` sets `maintainer` or lane sets `expected_checks` | err `repo-key-in-host` | — |
| Spec glob | default pattern, `1.7` / `1.17a` | `…/spec-1-7-*.md` / `…/spec-1-17a-*.md` | bad id → err `invalid` |

</intent-contract>

## Code Map

- `src/core/result.ts` -- `Result`, `ok`, `err`. Reuse; error is `{kind, message}`.
- `src/core/schemas/.gitkeep` -- empty dir from Story 1.1; replace with real files (remove the `.gitkeep`).
- `test/support/boundaries.ts` -- the layer and purity checker that `test/boundaries.test.ts` runs over all of `src/`. Core may import only `zod` and core; `Date.now()`, no-arg `new Date()`, `process.env`, `Bun.file` are banned. `Date.parse(x)` and `new Date(x)` with an argument are allowed.
- `Bun.YAML.parse` (Bun 1.4.3, probed): returns strings for dates and `08:00`; `1.10` → number `1.1`; a multi-document file → array; empty text → `null`; duplicate keys → last wins silently; bad syntax throws.
- `.xarabot/epics.yaml` -- existing file; read-only, unrelated to this Story's schemas.
- `test/core/result.test.ts` -- test style to follow (bun:test, case tables, no mocks).

## Tasks & Acceptance

**Execution:**
- `src/core/schemas/config.ts` -- `ConfigSchema`, `Config`, `CONFIG_DEFAULTS`, plus shared helpers (GitHub login, repo slug, ISO date, versioned-file pre-check) in `src/core/schemas/common.ts`.
- `src/core/schemas/policy.ts`, `src/core/schemas/human-live-steps.ts`, `src/core/schemas/standing-authority.ts`, `src/core/schemas/host.ts` -- the remaining schemas and inferred types.
- `src/core/config/protected-paths.ts` -- `MANDATORY_PROTECTED_PATHS` and `effectiveProtectedPaths(policyPaths, authorityPath)`.
- `src/core/config/story-spec-path.ts` -- `storySpecGlob(pattern, storyId): Result<string>`; id must match `^\d+\.\d+[a-z]?$`.
- `src/core/config/load-repo-config.ts` -- `RepoSnapshot` type, `loadRepoConfig(snapshot): Result<{package, repo}, ConfigStopKind>`, the YAML/frontmatter readers, the authority checks.
- `src/core/config/load-host-config.ts` -- `loadHostConfig(text): Result<HostConfig, …>` with the repo-key refusal.
- `src/core/schemas/.gitkeep` -- delete.
- `test/core/config/load-repo-config.test.ts` -- every matrix row as a case table, plus the AC rows below; fixtures built in code.
- `test/core/config/host-config.test.ts`, `test/core/config/story-spec-path.test.ts`, `test/core/config/protected-paths.test.ts` -- matrix rows for each.

**Acceptance Criteria:**
- Given the stop case table of the Story (config missing, invalid YAML, unknown/newer version, policy missing, authority absent, authority frontmatter invalid, wrong `granted_by`, wrong `repo`, expired), when each loads, then each returns `ok: false` with a stop kind and a message starting with the offending file's path.
- Given a snapshot with no `.xarabot/epics.yaml`, when it loads, then it succeeds.
- Given `src/core/config/` and `src/core/schemas/`, when `bun test` runs the boundary check, then no violation is reported (purity holds).
- Given the repo, when `bun install`, `bun test`, `bun --bun oxlint`, `bun --bun tsc` run, then each exits 0.

## Spec Change Log

## Review Triage Log

### 2026-10-22 — Review pass
- verdicts: 35 findings — high 0, medium 7, low 18, false 10, maybe-false 0
- findings:
  - `[false]` `[reject]` (intent-alignment) FR22's lane stop is not exercised; only a pure function over a snapshot — the Story's ACs ask for exactly the pure `loadRepoConfig`; fetching `main` and stopping the lane belong to the lane Stories (1.16 onward).
  - `[low]` `[reject]` (intent-alignment) host refusal lives in a separate `loadHostConfig`, and `XARABOT_HOST`/`XARABOT_MAX_BUILDERS` are not modelled — the AC's host case is met by the refusal; the env values are counted by Story 1.19, which owns them.
  - `[false]` `[reject]` (intent-alignment) the package layer has no prompt template — the template is Story 1.13's; the AC asks for typed package and repo layers, which are returned.
  - `[false]` `[reject]` (intent-alignment) extra stops beyond the case table (Human Live Steps, `unreadable`, `invalid-snapshot`) — AR21 says an absent `epics.yaml` *alone* is not an error; every other stop is fail-closed per AR21.
  - `[false]` `[reject]` (intent-alignment) purity is not asserted by a test in this diff — Story 1.1's boundary test scans every file in `src/`, including the new ones, and passed.
  - `[medium]` `[patch]` (verification-gap) `RepoPath` rejection of `..`, `.`, backslash and empty segments is untested — added stop rows for each.
  - `[low]` `[patch]` (verification-gap) `proxy_hosts` hostname validation has no negative test — added `*` and URL rows and asserted the accepted value.
  - `[low]` `[patch]` (verification-gap, other) positivity and non-empty rules (`unit_budget_hours`, `ci_max_wait_minutes`, `branches`, policy list entries) untested — added a row for each.
  - `[low]` `[reject]` (edge-case) an all-digit login parses as a YAML number and is refused — the failure is loud and the fix is quoting the value; rare.
  - `[low]` `[patch]` (edge-case) a leading UTF-8 BOM hides the authority frontmatter — `splitFrontmatter` strips a leading BOM; ok-case test added.
  - `[low]` `[reject]` (edge-case) `granted_at` in the future, or `expires` before `granted_at`, is accepted — AR21 sets no such rule, and a future grant can't extend authority past `expires`; adding a rule is a spine decision.
  - `[medium]` `[patch]` (edge-case) a `!`-prefixed `protected_paths` entry could act as a negation that removes a mandatory path — `!` entries are refused in `protected_paths` and `owner_approval_paths`; test added.
  - `[medium]` `[patch]` (edge-case) `retro_doc_glob`, `epic_context_path` and `story_spec_path` accept absolute and `..` paths — the repo-relative rule now applies to them; tests added.
  - `[low]` `[patch]` (edge-case) `retro_doc_glob`/`epic_context_path` need not contain `<N>` — now required, like `story_spec_path`'s placeholders.
  - `[low]` `[reject]` (edge-case) the two branch namespaces may be equal or prefix each other — a Maintainer would have to set this deliberately; the check is a new rule, not a correction.
  - `[low]` `[patch]` (edge-case) story ids with Epic `0` or leading zeros expand to globs that never match — the id regex now requires positive parts with no leading zero.
  - `[false]` `[reject]` (edge-case) `lanes: {}` loads — a host with no lanes is valid; there is simply nothing to run.
  - `[low]` `[patch]` (edge-case) lane names accept `../x`, `a/b`, spaces — lane names now match `^[A-Za-z0-9][A-Za-z0-9_-]*$`; test added.
  - `[low]` `[reject]` (edge-case) a Standing Authority path with glob metacharacters widens the protected list — rare, and widening protection fails safe.
  - `[medium]` `[patch]` (blind) `readFile` can return an inherited prototype member (`constructor`) and then throw — lookups use `Object.hasOwn`; test added.
  - `[medium]` `[patch]` (blind) the repo-relative rule covers only some path fields — same fix as the edge-case path row; `manifests.path_map` globs are normalized by Story 1.3.
  - `[medium]` `[patch]` (blind) a policy can likely remove a mandatory path by negation — same fix as the edge-case negation row.
  - `[low]` `[reject]` (blind) the authority time window checks only `expires` — same as the edge-case `granted_at` row.
  - `[false]` `[reject]` (blind) errors carry the file only in the message — AR35 fixes the error shape at `{kind, message}`, and the AC asks that the error name the file, which the message does.
  - `[medium]` `[defer]` (blind) duplicate YAML keys silently resolve to the last value — Bun.YAML behaviour that predates this Story; a raw key scan is new machinery; deferred (frontmatter `deferred`).
  - `[low]` `[patch]` (blind) untested: `unreadable` for the authority, and no guard that host/lane keys never overlap `REPO_LAYER_KEYS` — both tests added. The remaining listed cases (newer Human Live Steps version, empty body) exercise shared code already covered for other files; rejected.
  - `[low]` `[patch]` (blind) BOM breaks frontmatter detection — same fix as the edge-case BOM row.
  - `[false]` `[reject]` (blind) invalid authority frontmatter YAML is `invalid`, not `invalid-yaml` — the matrix specifies `invalid` for bad frontmatter.
  - `[low]` `[patch]` (blind) `RepoSlug`'s owner rule disagrees with `GitHubLogin`, and story ids accept leading zeros — the owner part now reuses the login rule; the id fix is the edge-case row's.
  - `[low]` `[patch]` (blind) lane names are only non-empty — same fix as the edge-case lane-name row.
  - `[low]` `[reject]` (blind) exported constants are mutable — they are typed `readonly`; changing them needs a deliberate cast.
  - `[low]` `[reject]` (blind) lists accept duplicates, and numbers have no ceiling — harmless duplicates; ceilings are a policy choice no AR sets.
  - `[false]` `[reject]` (intent-alignment) `story_spec_path` expansion is not wired to the loaded config — the AC asks only for the expansion of the default pattern; callers pass `config.story_spec_path`.
  - `[false]` `[reject]` (intent-alignment) Protected Paths are tested only as a list — no consumer exists yet; the AC is about the effective list's contents.
  - `[false]` `[reject]` (intent-alignment) field names are the spec's own choices — the AC names fields by meaning, not key; the spec fixed the names.

## Design Notes

- **Human Live Steps fail closed.** AR21 says "an absent `epics.yaml` *alone* means serial", so every other repo-layer file, `human-live-steps.yaml` included, is required. An empty `steps: []` file is the opt-out.
- **Login and repo comparisons are case-insensitive**, as GitHub logins and slugs are.
- **Version pre-check.** Read `schema_version` from the parsed object before the strict parse, so `schema_version: 2` reports `unsupported-version`, not a pile of field errors.
- Result shape:

```ts
loadRepoConfig(snap) // →
ok({ package: { defaults: CONFIG_DEFAULTS, mandatoryProtectedPaths },
     repo: { config, policy: { ...policy, effective_protected_paths }, humanLiveSteps,
             standingAuthority: { frontmatter, body }, epicsYaml: null } })
```

## Verification

**Commands:**
- `bun install` -- expected: exit 0, `bun.lock` unchanged.
- `bun test` -- expected: exit 0, new config tests pass, boundary test clean.
- `bun --bun oxlint` -- expected: exit 0, no warnings.
- `bun --bun tsc` -- expected: exit 0.

## Auto Run Result

Status: done

**Summary.** Adds strict, versioned zod schemas for `.xarabot/config.yaml`, `policy.yaml`, `human-live-steps.yaml`, the Standing Authority frontmatter and `host.yaml`, and the pure `loadRepoConfig`. It takes a `main` snapshot (tree, file contents, repo slug, server `now`) and returns the typed package and repo layers, or a stop error whose message starts with the offending file's path. Also adds `loadHostConfig`, which refuses repo-layer keys, `effectiveProtectedPaths`, which always includes the mandatory list, and `storySpecGlob`.

**Files changed.**
- `src/core/schemas/common.ts`:
  - shared validators for GitHub logins, repo slugs, ISO dates and repo-relative paths;
  - the `schema_version` pre-check;
  - YAML parsing that never throws;
  - issue formatting.
- `src/core/schemas/config.ts`: `ConfigSchema` and `CONFIG_DEFAULTS`, with every AC field and default.
- `src/core/schemas/policy.ts`, `human-live-steps.ts`, `standing-authority.ts`, `host.ts`: the remaining schemas, plus `REPO_LAYER_KEYS`.
- `src/core/config/load-repo-config.ts`: `loadRepoConfig`, `RepoSnapshot`, `ConfigStopKind` and the frontmatter splitter.
- `src/core/config/load-host-config.ts`: `loadHostConfig`, which refuses repo keys.
- `src/core/config/protected-paths.ts`: `MANDATORY_PROTECTED_PATHS` and `effectiveProtectedPaths`.
- `src/core/config/story-spec-path.ts`: `storySpecGlob`.
- `src/core/schemas/.gitkeep`: removed.
- `test/core/config/*.test.ts`: case tables covering every matrix row and AC stop case.

**Review findings.** 35 findings: 0 high, 7 medium, 18 low, 10 false.
- Patches applied:
  - 4 medium entries:
    - prototype-key lookup that could throw;
    - `!` negation in policy path lists;
    - repo-relative rule for the pattern fields;
    - untested `RepoPath` rejections.
  - Low entries:
    - BOM before frontmatter;
    - `<N>` placeholder required;
    - story ids with leading zeros;
    - `RepoSlug` owner uses the login rule;
    - lane-name pattern;
    - extra negative tests, an authority `unreadable` test and a host/repo key-overlap test.
- Deferred: duplicate YAML keys are resolved silently by Bun.YAML (frontmatter `deferred`).
- Rejected, with reasons in the triage log:
  - lane-boundary wiring and env-var host values (later Stories);
  - prompt template (Story 1.13);
  - all-digit logins;
  - `granted_at` time-window rules;
  - branch namespaces that are equal;
  - `lanes: {}`;
  - glob metacharacters in the authority path;
  - structured error path (AR35 shape);
  - mutable constants;
  - list duplicates and numeric ceilings;
  - the remaining `false` findings.

**Follow-up review recommended: true.** This first pass patched 4 medium entries. The risk not yet verified is the new path-pattern and negation rules, which no reviewer has read. In particular, the `patternWith` repo-relative check on glob fields could refuse a legitimate pattern that a consumer writes.

**Verification.**
- `bun install`: exit 0, `bun.lock` unchanged.
- `bun test`: 239 pass, 0 fail. The boundary and purity test is clean over the new `src/core` files.
- `bun --bun oxlint`: exit 0.
- `bun --bun tsc`: exit 0.

**Residual risks.**
- Duplicate YAML keys (deferred).
- Field names are this spec's choices, and later Stories must use them.
- A missing `human-live-steps.yaml` stops the lane, a fail-closed reading of AR21.
- Nothing fetches `main` yet; the lane Stories wire the loader in.
