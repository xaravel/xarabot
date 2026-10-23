---
title: 'Story 1.13: Result schemas and prompt assembly'
type: 'feature'
created: '2026-10-23'
status: 'done'
baseline_revision: 'b76bf47d6e1e4dbcc5fbc526f4a75c19cfc70ccc'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A lane has no schema for what a session returns and no single place that writes a session's prompt, so a session could return any shape and prompts could carry selection, CI, merge or status instructions (FR2, FR6, NFR4, AR15, AR30).

**Approach:** Add the AR15 result union to `src/core/schemas/` as one zod schema with inferred types and a non-throwing parser, and add a pure `src/core/prompt/` that builds a `story` prompt (first build, loopback, CI fix) from the package template, the repo's `.xarabot/prompts/` sections, the unit, the Human Live Steps list and the result path.

## Boundaries & Constraints

**Always:**
- Result union keyed by `kind`, every object strict, every kind carrying `denied_actions: string[]`:
  - `build`: `outcome` `done` | `blocked` | `no-op`; `blocked` present exactly when `outcome` is `blocked`, as {`kind` `escalation` | `human-live-step` | `intent-gap` | `verification` | `other`, `text`, `step_id`}, where `step_id` is required for `human-live-step` and absent for every other kind; `summary` (non-empty), `body` (string), `verification: string[]`.
  - `review`: `reviewed_sha` (40-hex, reuse `GitSha`), `verdict` `pass` | `changes-requested`, `findings[]` {`severity` `high` | `medium` | `low`, `blocking` boolean, `file` (repo path), `text`}.
  - `retro`: `verdict` `accepted` | `accepted-with-open-items` | `rejected`, `items[]` {`id` matching `epic-<N>-retro-item-<seq>-<slug>`, `text`, `route` `lane` | `maintainer`, `blocking` boolean, `globs: string[]`}.
  - `planning`: `outcome` `done` | `nothing-due` | `blocked`, `summary`.
- Express the build rules as nested discriminated unions (not refinements), so `z.toJSONSchema` of a kind's schema states them; the prompt embeds that JSON Schema.
- `buildPrompt` is pure (AR1): no I/O, no clock, no env; it returns `Result` and never throws. It takes the template as an input; the package template is a TS constant.
- First build names the unit exactly as `Build Story <id> (\`<sprint_key>\`)` and runs stock `bmad-build-auto` with that line. Loopback and CI fix run no skill and point at the prefetched findings file or CI log path.
- The result step is the prompt's last section and names `$XARABOT_RESULT` and the result path, the `build` JSON Schema, and the mapping from build-auto's halt to the `build` fields.
- Repo sections appear verbatim, ordered by file name; Human Live Steps appear as `id`: text with the instruction to report `human-live-step` with that `step_id`. An empty list or no sections omits that part.

**Never:** No selection, CI, merge or status instruction in package text (the CI-fix prompt may say "CI log" only). Nothing in `src/` names `_bmad/custom`. No `retro`, `retro-item` or `planning` prompts (later Epics). No reading of `.xarabot/prompts/` from disk (the lane does that in Story 1.16). No result cross-check against the spec file (Story 1.16). No Lessons (v1).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First build | `story` 1.7, `1-7-forge-port-fake-forge-and-contract-suite`, `mode: build` | Contains ``Build Story 1.7 (`1-7-forge-port-fake-forge-and-contract-suite`)`` and `bmad-build-auto`; ends with the result section | none |
| Loopback / CI fix | `mode: loopback` with findings path, `mode: ci-fix` with log path | Names the path, says run no skill, no `bmad-` skill named | none |
| Bad unit | id `1.x`, sprint key not led by `1-7-`, relative result or prefetch path, newline in a path | — | `err("invalid-input", …)` naming the field |
| Bad sections | name not `<name>.md`, duplicate name | — | `err("invalid-input", …)` |
| Unknown placeholder | template has `{{nope}}` | — | `err("invalid-template", …)` |
| Result JSON | non-JSON / schema miss / other kind than expected | — | `invalid-json` / `invalid` (fields named) / `wrong-kind` |

</intent-contract>

## Code Map

- `src/core/result.ts` -- `Result`, `ok`, `err`; core returns, never throws.
- `src/core/schemas/common.ts` -- `NonEmpty`, `RepoPath`, `describeIssues` to reuse.
- `src/core/schemas/ledger.ts` -- `GitSha` for `reviewed_sha`.
- `src/core/schemas/human-live-steps.ts` -- `HumanLiveStep` type for the prompt input.
- `src/core/story-id.ts` -- `StoryId` / `STORY_ID_PATTERN` for the unit id.
- `test/support/boundaries.ts` -- core may import only core and `zod`; the purity checker runs over new files.

## Tasks & Acceptance

**Execution:**
- `src/core/schemas/session-result.ts` -- the four kind schemas, `SessionResultSchema` (discriminated on `kind`), `RESULT_KINDS`, inferred types, and `parseSessionResult(path, text, expected)` -- AR15's one shape per kind.
- `src/core/prompt/template.ts` -- `PromptTemplate` type and `PACKAGE_TEMPLATE` with `{{placeholder}}` sections: first build, loopback, CI fix, rules (work in the clone, leave changes in the working tree, report denied actions), Human Live Steps, repo sections, result -- the package layer of AR21.
- `src/core/prompt/build-prompt.ts` -- `buildPrompt(input)`: validate, fill placeholders in one pass, assemble task, rules, steps, sections, result last -- AR30.
- `test/core/schemas/session-result.test.ts` -- case tables: each kind's valid shape, every enum's accepted and refused values, `blocked`/`step_id` rules, strictness, `denied_actions` required, the parser's error kinds.
- `test/core/prompt/build-prompt.test.ts` -- the matrix rows, the exact naming line, result section last with the embedded JSON Schema equal to `z.toJSONSchema` of the build schema, verbatim ordered sections, Human Live Steps, a banned-instruction table run over every mode, and a scan that no `src/` file and no prompt names `_bmad/custom`.

**Acceptance Criteria:**
- Given every mode `buildPrompt` builds, when the banned-instruction test runs, then no prompt matches a selection, CI (other than "CI log"), merge or status pattern.
- Given the package, when any prompt is built, then neither the prompt nor any `src/` file names `_bmad/custom`.

## Spec Change Log

## Review Triage Log

### 2026-10-23 — Review pass
- verdicts: 26 findings — high 0, medium 2, low 17, false 7, maybe-false 0
- findings:
  - `[low]` `[patch]` (edge) Human Live Step id with a backtick/newline, or multi-line text, garbles the steps list — step ids with a control character or backtick are refused; step text whitespace runs collapse to one space.
  - `[low]` `[patch]` (edge) `isUnsafe` misses C1 controls and U+2028/U+2029 — added to the unsafe set.
  - `[low]` `[patch]` (edge) a result file with a leading UTF-8 BOM is refused as `invalid-json` — one leading U+FEFF is stripped before parsing.
  - `[low]` `[patch]` (edge) whitespace-only `summary`, `blocked.text`, `step_id` pass — blank strings refused for the free-text fields.
  - `[medium]` `[patch]` (edge) `blocked.step_id` may name a step not in the list — grouped with the blind finding below; the result parts now say the id must be one listed under Human Live Steps. The schema cannot see the list; the lane holding it checks it when it consumes the result (Story 1.16).
  - `[low]` `[patch]` (verification-gap) `AbsolutePath`'s backtick/DEL refusal is untested — rows added for backtick, DEL and U+2028 in each path field.
  - `[low]` `[patch]` (verification-gap other) Human Live Steps rendered unescaped — same root cause as the first edge row; same fix.
  - `[low]` `[reject]` (intent) repo sections pass through verbatim and could carry banned instructions — they are the Maintainer's own `.xarabot/prompts/` text on `main`; the AC binds the package text, and filtering prose is more than a direct correction.
  - `[false]` `[reject]` (intent) NFR4 is about runtime reads/writes, not strings — `core/prompt` does no I/O at all (the purity checker enforces it), so it can neither read nor write `_bmad/custom/`; the string scan additionally pins that nothing names it.
  - `[false]` `[reject]` (intent) inputs are not loaded from a `main` snapshot here — the AC gives them as the Given; loading them is the lane's work (Story 1.16), and core may not do I/O.
  - `[false]` `[reject]` (intent) `build.outcome: blocked` is accepted only with a `blocked` object — the AC's enumerated values all parse; `blocked` with its object is accepted, as AR15 pairs them.
  - `[false]` `[reject]` (intent) the mapping ignores a `ready-for-dev` halt — "halted any other way" maps it to `blocked`/`other`; Story 1.14 owns the final outcome mapping.
  - `[false]` `[reject]` (intent) the parser is tested at unit level only — the lane surface that reads result files is Story 1.16 by the epics text.
  - `[low]` `[reject]` (blind) templates are not checked for required placeholders — the template is the package constant; a hostile custom template is not a path anyone reaches, and the fix adds a per-part table.
  - `[low]` `[patch]` (blind) Human Live Step ids/text unchecked — same root cause as the first edge row; same fix.
  - `[low]` `[reject]` (blind) a repo section containing `# Result` makes a later `# Result` heading — Maintainer-written text; escaping headings adds complexity for an unlikely case.
  - `[medium]` `[patch]` (blind) `human-live-step` offered without saying the id must come from the list — grouped with the edge `step_id` row; wording fixed.
  - `[low]` `[patch]` (blind) `verification`/`denied_actions` accept `""` items — items must be non-blank. Requiring a non-empty `verification` on `done` is not in AR15; not added.
  - `[low]` `[reject]` (blind) a `review` verdict may contradict its findings — AR15 states no consistency rule; review units arrive in a later Epic, whose lane code decides.
  - `[low]` `[reject]` (blind) retro globs loose and item ids may repeat — AD-12 has the runner match items one to one against the diff's `action_items` before the squash (a later Epic), which refuses both.
  - `[false]` `[reject]` (blind) a blocked `planning` result has no reason field — AR15 defines `planning` as `outcome` and `summary`, and AR30 puts readiness findings in `summary`.
  - `[low]` `[reject]` (blind) a bad `sprint_key` is reported only after other field errors — cosmetic; both errors still surface.
  - `[low]` `[reject]` (blind) `{{{x}}}` and `{{ x }}` placeholder edge cases — the package template uses neither; cosmetic.
  - `[low]` `[patch]` (blind) "no value in this mode" tested only in build mode — rows added for `{{findings_path}}` in ci-fix and `{{log_path}}` in loopback.
  - `[false]` `[reject]` (blind) the rules never forbid committing — AD-15: the runner reads the clone's working tree, which holds committed and uncommitted changes alike, so a local commit loses nothing.
  - `[low]` `[patch]` (blind) the valid review parse asserts one field — now `toEqual` on the whole value.

## Design Notes

Placeholders are filled in one `replace` pass, so a value containing `{{x}}` (a repo section, a path) is never re-expanded. The build-auto mapping in the result section: halts `done` → `done`; halts `blocked` → `blocked` with `intent gap` → `intent-gap`, a failed verification → `verification`, a Human Live Step → `human-live-step` plus its id, a decision for the Maintainer → `escalation`, anything else → `other`; any other halt → `blocked`/`other`; nothing to change → `no-op`.

## Verification

**Commands:**
- `bun test` -- expected: exit 0
- `bun --bun oxlint` -- expected: exit 0
- `bun --bun tsc` -- expected: exit 0

## Auto Run Result

Status: done

**Summary:** Added the AR15 session result union (`build`, `review`, `retro`, `planning`, each with `denied_actions[]`) as one zod schema with a non-throwing parser, and a pure `core/prompt` that builds `story` prompts (first build, loopback, CI fix). The prompts name the unit, run stock `bmad-build-auto` only on a first build, and end with the result step, which embeds the `build` JSON Schema.

**Files changed:**
- `src/core/schemas/session-result.ts`: the four kind schemas, `SessionResultSchema`, `RESULT_KINDS`, inferred types and `parseSessionResult` (`invalid-json` / `wrong-kind` / `invalid`).
- `src/core/prompt/template.ts`: `PromptTemplate`, `PLACEHOLDERS` and `PACKAGE_TEMPLATE` (the package layer).
- `src/core/prompt/build-prompt.ts`: the pure `buildPrompt`, which validates its input and fills the template in one pass, with the result step last.
- `test/core/schemas/session-result.test.ts` and `test/core/prompt/build-prompt.test.ts`: case tables for every matrix row, plus a banned-instruction table and a `_bmad/custom` scan.

**Review findings:** 26 findings, triaged as 0 high, 2 medium, 17 low and 7 false.
- **Patched:** 11 rows, grouped into 8 fixes.
  - Human Live Step ids are now checked and step text is flattened to one line.
  - Paths are refused when they contain C1 controls or U+2028/U+2029.
  - A leading BOM is stripped before parsing.
  - Blank text fields and blank list items are refused.
  - `step_id` must be one of the listed steps.
  - Missing tests were added for path refusals and for placeholders that have no value in a mode.
  - The review parse test now checks the whole parsed value.
- **Rejected:** 8 low findings and the 7 false ones. Each rejection's reason is in the Review Triage Log.
- **Deferred:** none.

**Follow-up review recommended:** false. One medium entry was patched (the two medium rows share one root cause) and no high one.

**Verification:**
- `bun install` passes.
- `bun test`: 1751 pass, 60 skip (live and sandbox cases), 0 fail.
- `bun --bun oxlint` exits 0.
- `bun --bun tsc` exits 0.

**Residual risks:**
- The schema cannot check that `blocked.step_id` names a configured step, because it never sees the list. The lane, which holds the list, has to check it when it consumes the result (Story 1.16).
- Repo `.xarabot/prompts/` sections are inserted verbatim and are not filtered.
- The halt-to-outcome mapping in the build result step is provisional. Story 1.14 owns the final `claude` outcome mapping.
