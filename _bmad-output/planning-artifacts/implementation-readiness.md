---
title: Implementation readiness, xarabot 0.x
date: 2026-10-21
gate: FAIL
reviewed_at: 4024723
inputs:
  - _bmad-output/specs/spec-xarabot/SPEC.md (and companions)
  - _bmad-output/planning-artifacts/architecture/architecture-xarabot-2026-10-20/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/epics.md
  - .xarabot/epics.yaml
next: bmad-correct-course
---

# Implementation readiness: xarabot 0.x

**Verdict: FAIL.** The plan cannot run past Epic 1 as recorded. The self-hosted runner deadlocks at the Epic 1 → 2 gate, done Stories become eligible again, and Story 2.7 contradicts the write check. `sprint-status.yaml` was not generated.

The plan is otherwise strong: every 0.x FR and NFR lands in a Story's acceptance criteria; the numbers (heartbeat, expiry, caps, waits, budgets, retention), model ids, effort mapping and release assignments agree across spec, spine and epics; `.xarabot/epics.yaml` matches the stated Epic dependencies and is valid under AD-11; every open spine item is spiked before the code that needs it. A dry run of `sprint_plan.py generate` parses `epics.md` cleanly (7 Epics, 60 Stories, 7 optional retros), so generation is one command once the gate passes.

Line references are to the files at commit `4024723`.

## Maintainer decisions (2026-10-21)

The Maintainer accepted these; `bmad-correct-course` applies them.

- **D1. Done-ness comes from `sprint-status.yaml`.** A Story is eligible only when its ledger record is absent or `released` (or stale, AD-6) **and** it is not `done` in `sprint-status.yaml` on `main`. AD-12's "all its Stories merged" means every Story of the Epic is `done` there. Fixes B2; matches AD-9's "done on `main`" for `story` and CAP-2's inputs.
- **D2. The self-host switch marks Epic 1 done explicitly.** A Maintainer-approved field in `.xarabot/config.yaml` (working name `bootstrapped_epics: [1]`) makes the gates read those Epics as all Stories done and retro done, and exempts them from "an Epic with no Stories is never done". Epic 1 needs no manifests. The Story 1.20 runbook adds: the Maintainer runs `bmad-sprint-planning` once to create `sprint-status.yaml` with Epic 1 `done` (a one-time Maintainer write, recorded as an exception in AD-3), and runs Epic 1's retro interactively. Fixes B1. Rejected: `2: {depends_on: []}`, which hides a real edge and leaves Epic 1's 20 headings unclaimable in the inbox for good.
- **D3. The Maintainer runs each Epic's live proof.** Each verification Story writes its live command (`bun test --live …`) and expected result into `docs/maintainer/self-host.md`; the Maintainer runs it on the host, outside the sandbox, before that Epic's retro. Fixes C1. Rejected: a runner-run verification unit, which breaks "the runner never runs repo code" (spine:410).
- **D4. The same-vendor reviewer assumption is confirmed; `pi` stays out of reviewer selection in 0.x.** SPEC:199's rule stands (first allowed of `claude`, `codex`; with neither, `pi` on the builder's model). AD-16 keeps choosing cross-vendor reviewers from `claude` and `codex` only, so a pi-only repo gets a same-vendor review even when pi could run another vendor's model; revisit for v1. *This one was the reviewer's recommendation, not stated before the Maintainer's go; overrule it here if wanted.*

## Blockers

### B1. The self-host switch deadlocks at the Epic 1 → 2 gate

- Story 1.6 holds Epic D while "a dependency Epic has a Story not merged, or no retro verdict in `retro-gates.yaml`" (epics.md:471).
- An Epic's Stories are exactly its manifests; "An Epic with no Stories is never done and holds its dependents" (spine:254).
- The Story 1.20 runbook supplies only "Epic 2's Story manifests" (epics.md:998): no Epic 1 manifests, no `sprint-status.yaml`, no Epic 1 retro verdict. Retro units arrive only in Story 2.9.
- Hand-writing the verdict breaks AD-3: `retro-gates.yaml` is written by "`reconcile`'s runner code only" (spine:97).
- **Fix:** D2.

### B2. Nothing stops a done Story from being chosen again

- AD-13 and Story 1.6 make a Story eligible when its record is absent or `released` (spine:306, epics.md:476).
- Story 2.5 deletes `merged` records once the unit is done on `main` (epics.md:1143-1145).
- After deletion every done Story is eligible again, lowest Epic first: builders churn claim → inspect branch → write `merged` → repeat. AD-12's "all its Stories merged" (spine:281) has no defined source once records are gone. SPEC CAP-2 lists sprint status as an input to `next` (SPEC:32); no rule uses it.
- **Fix:** D1, then Story 1.6's eligibility AC and gate AC.

### B3. Story 2.7 contradicts the write check

- Its prompt runs stock `bmad-sprint-planning` (writes `sprint-status.yaml`) "plus the due manifests, Epic context and graph edits" in one unit (epics.md:1197).
- Its own AC refuses a diff touching "both a graph input and a status file" (epics.md:1202; spine:588).
- The spine's remedy, "`reconcile` writes their status entries after the merge" (spine:305), is in no Story; Story 2.5 only marks units done (epics.md:1140).
- **Fix:** split planning into a *status* unit (`bmad-sprint-planning` and Epic context only; not approval-gated) and a *graph* unit (manifests, `epics.md`, `.xarabot/epics.yaml`; approval-gated; never status files). Story 2.5 gains: after a graph unit merges, `reconcile` writes its status entries. Story 2.4's coordinator order runs a graph unit before a status unit when both are due.

## Concerns

- **C1. Live Epic-end proofs have no one to run them.** From Epic 2 on, sessions have no GitHub host or token, so the live cases of 2.12, 3.6, 4.7, 5.3, 6.5 and 7.7 "are reported as skipped" (epics.md:1353 and peers). Only over-budget runs go to the Maintainer (epics.md:234). Story 3.6, the proof that lifts the every-path approval rule, also needs every vendor's credential at once, while a vendor home holds one (epics.md:655). **Fix:** D3; update the test strategy (epics.md:229-234) and each verification Story.
- **C2. Story 1.2 would invent decisions.** The Standing Authority frontmatter has no fields (spine:447 is an assumption; epics.md:326). Enum values are undefined: `route`, retro and review `verdict`, `severity`, `planning.outcome`, the literal `blocked.kind` and `park.kind` strings (spine:174-176, 329-332); Story 4.3 keys on "`route` naming the Maintainer" (epics.md:1635), and Story 2.9 compares the verdict to an unnamed retro-document field (epics.md:1268). The configured paths for `epics.md`, `sprint-status.yaml`, `retro-gates.yaml`, the retro document and the Epic context (spine:299) are missing from Story 1.2's config schema. **Fix:** a vocabulary section in the spine; suggested Standing Authority fields `schema_version`, `granted_by`, `granted_at`, `repo`, optional `expires`.
- **C3. Story ACs drift from the spine.**
  - The Standing Authority re-check "before every claim, push, enqueue and merge" (spine:450) covers claim and push in Story 1.16 (818, 831) but not enqueue in Story 1.17 (883-886) or Story 2.6 (1169).
  - Story 3.5 parks only "once `loopbacks` ≥ 2 and blocking findings remain" (epics.md:1523); AD-16 parks past the cap regardless (spine:382).
  - Story 2.3's write check (epics.md:1067) omits `epics.md`, which AD-3 makes coordinator-owned (spine:100) and AD-30 refuses (spine:583). A builder could edit its own Story's acceptance criteria; only heading changes reach the graph gate.
- **C4. The `claude` adapter is under-specified.** How `bmad-build-auto`'s outcomes map onto the `build` result (a `ready-for-dev` halt; it never yields `no-op`) and how resume works are spiked only for `codex` and `pi` (epics.md:1373, 1415), but Stories 1.13 and 1.16 need them first. `parseUsage` needs session id, tokens, model and reset time, but the recorded command has no `--output-format` (agent-adapters.md:7; epics.md:745). The launch also doesn't turn off claude's own sandbox (AD-17). **Fix:** move AR42's `claude` half into Story 1.14 as a spike.
- **C5. The journal's waiting spans are never written.** No Story writes `waiting-on-maintainer` or `usage-limit` spans or defines when a lane waits on the Maintainer; Story 1.16 writes only idle spans (epics.md:819). Story 6.4's Stories-per-hour excludes those hours (epics.md:1965); Story 6.5's fixture hides the gap. **Fix:** Story 1.18 writes `usage-limit` spans; Story 4.2 defines and writes `waiting-on-maintainer`.
- **C6. Maintainer steps arrive late or not at all.**
  - Story 1.10's live alerts need `issues: write`, which `bootstrap/join.ts` doesn't request and the runbook adds only in Story 1.20; until then the live tests get `forbidden`, which stops the lane (AD-32). Make it a Story 1.10 precondition.
  - Stories 1.10 and 1.20 need the scratch repo's merge queue and a required check; Story 1.8's precondition covers only the App install (epics.md:534).
  - Story 5.3 needs a test org and a browser-made App, with no precondition (epics.md:1858).
  - AR32's dedicated bootstrap macOS user is not listed as a precondition anywhere.
  - No Story adds "install the coordinator lane" to `self-host.md`, though Epic 3 needs the coordinator's Epic 2 retro. Add it to Story 2.4.
- **C7. Story 1.4 has a stale AC.** It expects "this repo with no `.xarabot/epics.yaml`" to report Epics 1–7 serially (epics.md:421); the file exists with 6 → [4] and 7 → [5, 6]. **Fix:** test the serial default on a fixture; assert this repo's real graph.
- **C8. Story 5.1's permission table is recorded only in the epics.** SPEC:201 says App rights are decided in AD-26, but the full set (`checks`, `statuses`, `actions`, `metadata`, …) and the one-request-function rule live only in Story 5.1. **Fix:** copy the table into AD-26. Also: `metadata: read` is granted to every App and needs an entry or the exactness test fails; git pushes bypass `fetch`; `join`'s manifest-conversion and App-JWT calls need a "no installation permission" entry; Story 7.5's branch-protection reads likely need `administration: read`, which the rule forbids, so they fall to "unverified" for good.
- **C9. Epics 5 and 6 contend for `src/adapters/forge/github/**`.** Story 5.1 rewrites every GitHub call (epics.md:1801) while Stories 6.1 and 6.2 add forge reads, in parallel per `.xarabot/epics.yaml`. Claims will serialize them, and 0.x has no diff check. **Fix:** say so in the plan; keep the parallel graph.
- **C10. Forward dependencies.**
  - Epic 2: Story 2.4 needs a case test for each coordinator position (epics.md:1114-1116), whose rules arrive in 2.7, 2.9, 2.10 and Epic 4's 4.4. Story 2.7 merges graph-changing planning PRs before 2.8's gate exists (the every-path approval rule covers this only in part).
  - Epic 1, claimed strictly serial: 1.9's push needs `runner.git`'s hardened git settings from 1.15 (epics.md:580 vs 780); 1.11 tests access to `runner.git`, created in 1.15; 1.12's allowlist uses the adapter's vendor hosts before the Agent port in 1.14; 1.16's 🤖 status comment has no Forge operation in 1.7 or 1.9.
  - **Fix:** reorder or move the named pieces earlier; Story 2.4 tests only the positions that exist so far, and later Stories add theirs.
- **C11. Spine gaps.**
  - Manifest `depends_on` has no recorded meaning (spine:228), and Story 1.6 never applies it. With every path approval-gated, "the lane moves on" (epics.md:880), so a dependent Story is built on a `main` that lacks its parked predecessor.
  - The daily digest has no trigger: no slot in the coordinator order (spine:308-319), no schedule or stored state (epics.md:1606).
  - `xarabot upgrade`'s PR is outside the ledger (epics.md:2036-2038): no unit kind or branch (spine:203-204), so nothing enqueues it after approval; the command and its `--downgrade` flag are missing from the CLI list (spine:721).
  - Story 7.6 reads Xaravel's Escalation "format" (epics.md:2126), which neither spec nor spine records. No 0.x Story blocks a merge on an open Escalation; releases.md:17 says 0.x reads them through config.
  - The pinned runner: nothing records what launchd runs that reads `runner_version` from `main` and switches versions (epics.md:952-968; spine:509-512). A version-independent shim is implied but undefined.
  - Sandbox reads: "system paths" doesn't say where the agent, `uv` and `bun` binaries live (often under `~`); the env allowlist and the session's `HOME` are undecided (epics.md:645; spine:398).
  - Story 3.1, 3.2 and 7.3 re-run the sandbox suite inside a sandboxed session (epics.md:1401, 1443); `sandbox-exec` likely can't nest. Check before Epic 3.
- **C12. Spec drift.** SPEC:202's "Still open in the spine" omits the adapter spikes (spine:770-773) and lists the local-only adapter, which the spine files under Deferred. SPEC:201 calls AD-17 decided while it carries two `[ASSUMPTION]` tags (spine:397, 401). SPEC:199 still says "Not yet confirmed" (D4 confirms it).
- **C13. Story size.** Most likely to overrun one 6-hour unit: 1.17 (CI polling, conflicts, lockfile regeneration, CI-fix sessions, approval gate, queue), 1.15, 1.16, and 5.1 (join plus every forge call into the table). Consider splitting 1.17 and 5.1.

## Minor

- AR15's cross-check against the Story spec's `status` and `## Auto Run Result` (spine:334) is in no Story.
- AR44's `denied_actions[]` exists only as a schema field; nothing reports it to the Maintainer.
- Outcome values have no `failure` entry, yet a 15-minute wait follows "a failure" (epics.md:847 vs 911).
- Story 3.2 omits pi's attribution-off setting (AD-29) and turning off pi's own sandbox (AD-17).
- Story 5.2's uncovered-repo refusal repeats Story 1.19's (epics.md:964 vs 1838).
- SPEC CAP-4 says "its own worktree" (SPEC:44); AD-17 says "never a linked worktree" (spine:399). The plan follows the spine; align the spec wording.

## Changes by artifact

For `bmad-correct-course`; each artifact changes through its own skill, per AGENTS.md.

| Artifact | Changes |
|---|---|
| Spine (`bmad-architecture`) | AD-12 and AD-13 per D1; D2's bootstrapped-Epics field in AD-11/AD-20 and the one-time exception in AD-3; vocabulary section (C2); AD-26 permission table (C8); manifest `depends_on` meaning, digest trigger, `upgrade` unit and CLI entry, pinned-runner shim, sandbox read paths and `HOME` (C11) |
| Spec (`bmad-spec`) | SPEC:199 confirmed per D4; SPEC:201-202 open and decided lists (C12); CAP-4 worktree wording |
| Epics (`bmad-create-epics-and-stories`) | Stories 1.6 (D1), 1.20 (D2), 2.4/2.5/2.7 (B3), the test strategy and every verification Story (D3), 1.2 (C2), 1.16/1.17/2.6/3.5/2.3 (C3), 1.14 (C4), 1.18/4.2 (C5), preconditions in 1.8/1.10/2.4/5.3 (C6), 1.4 (C7), 5.1 (C8), the Epic 5/6 note (C9), the reorders in C10, splits in C13 |
| `.xarabot/` | `config.yaml` gains the bootstrapped-Epics field at the self-host switch (D2); `epics.yaml` unchanged |

After those land, re-run `bmad-sprint-planning`: the gate, then generation.
