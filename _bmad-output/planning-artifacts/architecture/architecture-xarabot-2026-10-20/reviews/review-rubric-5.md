---
review_of: ARCHITECTURE-SPINE.md (xarabot, final, updated 2026-10-21), the Epic graph file change only
lens: good-spine rubric, scoped to the change and its ripple
inputs: git diff of _bmad-output (spine AD-3, AD-11, AD-12, AD-13, AD-20, Deferred; SPEC CAP-2 and Planning shape; glossary; both memlogs), SPEC.md, glossary.md, brownfield-xaravel.md, stock bmad-create-epics-and-stories template
reviewed: 2026-10-21
---

# Rubric review 5: the Epic graph moves to `.xarabot/epics.yaml`

## Verdict

**Accept the direction; revise before the graph, gate and planning Stories are cut.** Moving the graph out of an override into a Xarabot-owned, schema'd, serial-by-default file fixes the real divergence the bullets had (every consumer carrying an override, prose parsing) and removes no protection. No other AD still assumes the old bullets: the diff left no `Depends on` wording behind, the Deferred item list was cleared and the remaining overrides (AD-12 `blocking`, AD-14 `on_complete`) are a recorded open item. But the change made a Protected Path writable by an agent lane for the first time, and the rules around that write are under-specified in ways that two independently built units would resolve differently, one of them against SPEC.

Severity counts: high 2, medium 5, low 3.

---

## 1. Does it fix the real divergence points, and miss none?

Fixed well:

- One location, one schema (AD-27), one key (the integer from `## Epic N:`), one default rule ("next lower Epic number present"), and an explicit "a checkpoint is never inferred". Two loaders now cannot infer different defaults.
- Validation is restated for the new file (invalid file, dangling entry or `depends_on`, cycle, Story heading/manifest mismatch). A missing entry is correctly no longer an error.
- The file joins the repo layer (AD-20), so it is read only from fetched `origin/main` and is a Protected Path through `.xarabot/**`; builders are refused by AD-30 with no Infrastructure exception (AD-30 excludes `.xarabot/**` from the exception). Good.
- AD-13 adds the file to the planning paths, so the overlap check covers it.

Missed or half-fixed:

- **H-1 (high). Who approves a graph change contradicts SPEC, and "owner" is not the Maintainer in team mode.** AD-11 and AD-3 let a coordinator planning PR change `.xarabot/epics.yaml`, "owner-gated (AD-16)". SPEC § Repo policy still says "Lanes change Protected Paths only through a Maintainer-approved Infrastructure Story", and the glossary's Protected Path entry says the same. A planning unit is not an Infrastructure Story, so the spine now conflicts with SPEC (the spec memlog records the user decision, but the Constraint line was not amended). Worse, AD-16's gate is "the owner's approval" (`approved_sha`), where owner means the PR's bot owner (CAP-13). With v1 team onboarding the coordinator's owner need not be the Maintainer, so a non-Maintainer could approve a PR that drops `checkpoint: true`, defeating AD-28's rule that only the Maintainer may record `go`. A GitHub-side CODEOWNERS rule on `.xarabot/**` would name the Maintainer, so the runner's `approved_sha` (from the bot owner) and the forge's required reviewer can also disagree, giving a PR the runner enqueues and the queue ejects. *Fix:* in AD-11 and AD-16 state that a diff touching `.xarabot/epics.yaml` is gated on the **Maintainer's** approval on the current head (record it as `approved_sha` only when the approver is the configured Maintainer); route a bmad-spec amendment to the Repo policy constraint and the glossary: "…only through a Maintainer-approved Infrastructure Story, except the Epic graph file, which a coordinator planning PR may change with the Maintainer's approval."

- **H-2 (high). Xaravel adoption does not write the graph file, and a missing checkpoint costs correctness, not speed.** The spec memlog's premise "a missing entry costs speed, never correctness" holds for edges but not for checkpoints, which are "never inferred". Xaravel's Epic 8 checkpoint go is pending (brownfield-xaravel.md). If the adoption Epic does not create `.xarabot/epics.yaml` with `8: { checkpoint: true }`, Xarabot runs serially and starts Epic 9 the moment Epic 8's retro is done, skipping the go. The adoption list in brownfield-xaravel.md names config, protected paths, Standing Authority and identity, but not the graph file; and CAP-5's success (Phase 1 runtime → contracts → macroable/conditionable/json-schema in parallel) is also unreachable without it. *Fix:* route to bmad-spec: add "write `.xarabot/epics.yaml` with Epic 8's checkpoint and the Phase 1 graph" to the brownfield adoption inputs. In the spine, add a fail-closed check to AD-11: if `retro-gates.yaml` holds a checkpoint record (pending or go) for an Epic the graph does not mark `checkpoint: true`, validation stops every lane.

## 2. Is every amended Rule enforceable, and does it prevent its divergence?

- **M-3 (medium, AD-7 / AD-13). An owner-gated planning PR parks with every planning path held.** AD-7: "Finished PR waiting for its owner's approval → `parked`, globs held". The planning unit holds all planning paths (AD-13), so while a graph change waits for approval (up to a day at a once-a-day inbox), no retro, checkpoint or other planning unit can claim (overlap check), and since an Epic starts only after its dependencies' retros, Epic starts stall too. Before this change no planning PR was owner-gated, so this is new. *Fix:* a graph change is its own planning unit (e.g. `planning:graph.<n>`) whose globs are only `.xarabot/epics.yaml`; any other planning unit may not touch the file. Add the ordering rule this forces: add Epic headings first (the serial default keeps them safe), then the graph PR; remove graph entries first, then headings.

- **M-4 (medium, AD-11). Validation runs only after merge, and an ungated `epics.md` edit can break or loosen the gated file.** Validation "stops every lane" on the state of `main`, so an invalid combination is caught only after it merges. `epics.md` is not a Protected Path, so a coordinator planning PR that removes or renumbers an Epic heading can (a) leave an `epics.yaml` entry dangling, stopping every lane, or (b) silently re-point an unlisted Epic's default edge to an older Epic, adding parallelism without approval, which is what the Protected Path status was meant to prevent. *Fix:* the runner runs the same pure graph resolver and validator on the PR's resulting tree before enqueue (any coordinator PR, and as a CI check for human PRs) and refuses to enqueue on failure; and a coordinator diff that removes or renumbers an existing `## Epic N:` heading is refused by AD-30 unless it is Maintainer-gated like a graph change.

- **M-5 (medium, AD-30 vs AD-3). Any coordinator unit kind may write the graph.** AD-3 names the writer as "coordinator (planning units)". AD-30 lets every coordinator diff touch "the planning paths and their unit's globs", and AD-13 gives retro and checkpoint units the planning paths, so a retro or checkpoint session may edit `.xarabot/epics.yaml` without AD-30 refusing it. A retro-item's `globs` come from the retro agent's result (AD-14), so they could also name `.xarabot/**`, opening `config.yaml` (`runner_version`) and `policy.yaml` to a coordinator diff. AD-25's "only the Maintainer advances `runner_version`, since `.xarabot/**` is protected" no longer follows from protection alone. *Fix:* AD-30: coordinator diffs may touch `.xarabot/**` only at `.xarabot/epics.yaml`, and only from a `planning` unit; retro-item globs that match `.xarabot/**`, the Standing Authority file, `.github/**` or agent config are rejected when the retro result is validated. Re-cite AD-25 to AD-30.

## 3. Could anything left unsaid let two independently built units diverge?

- **M-6 (medium, AD-27 / AD-20). Raw file vs resolved graph, absent vs failed, and which `main` SHA.** Three seams are open between the graph loader, gate code and config loader:
  - The `Snapshot` lists "the Epic graph" but not whether it is the raw file or the resolved graph (defaults applied, package edges merged, checkpoint flags). If gate code applies the default itself, the loader Story and the gate Story implement the default twice. It also omits the `epics.md` heading set the default and validation need.
  - AD-20 "Fail closed: if config … is missing … the lane stops" now covers `epics.yaml`, but AD-11 says a missing file means serial. A config-loader Story could reasonably stop every lane on a repo with no graph file. The loader must also tell "absent on `main`" (serial) from "fetch failed" (fail closed).
  - Config is "read from freshly fetched `origin/main`"; manifests and `epics.md` come from the snapshot's `main` SHA (AD-4). If the graph is fetched as config at a different SHA, a heading added in between triggers a false "dangling entry" stop.
  *Fix:* one core function `resolveGraph(epicHeadings, epicsYaml | absent, packageMap)` in `src/core/` produces the `Snapshot`'s `epicGraph` (every Epic with explicit edges and checkpoint flag); gates read only that. AD-20: "a missing `.xarabot/epics.yaml` is not a failure (AD-11); a failed fetch is". Read `epics.yaml`, `epics.md` and manifests from the single `main` SHA the snapshot records. Add "the Epic graph file" by name to AD-27's schema list.

- **M-7 (medium, AD-13 / AD-14 / AD-29). Nothing says how a planning session produces graph entries.** With "No BMAD override", stock `bmad-create-epics-and-stories` knows nothing of `.xarabot/epics.yaml`, and the `planning` result (`outcome`, `summary`) has no graph field. The prompt-template Story and the planning-unit Story could pick different mechanisms (agent edits the YAML from a package prompt section, versus the runner writes it from a result field), or neither, leaving every new consumer serial forever. *Fix:* state it: the package prompt template has a planning section telling the agent to edit `.xarabot/epics.yaml` directly in the clone for the Epics it adds, validated by the runner per M-4; or add `graph` to the `planning` result and have the runner write the file. Either is fine; pick one.

Lower:

- **L-8 (low, AD-11). Heading grammar is half-pinned.** Only `## Epic N:` is pinned; the Story heading used in the heading/manifest check is not. The stock template also writes `### Epic N:` lines in its "Epic List" section and `### Story N.M:` under each Epic. *Fix:* pin both regexes: Epic `^## Epic (\d+):` and Story `^### Story (\d+\.\d+[a-z]?):`, and say that only these count.
- **L-9 (low, AD-11). How package edges combine with file edges and the default.** Not stated whether an Epic in the package map counts as "listed". *Fix:* "Package edges are added to (unioned with) the file's or default edges; they never remove one."
- **L-10 (low, AD-12). Graph changes mid-flight.** `next` re-reads the graph per claim, so a newly added dependency holds new Stories of an in-flight Epic, as checkpoints already do. Say so once, so a gate Story does not cache "Epic started" state.

## 4. SPEC coverage (CAP-2, CAP-5, CAP-10 as now written)

- **CAP-2:** covered. File, serial default, package edges, "never from `epics.md` prose or a BMAD override" all match AD-11. The success test "a listed Epic runs in parallel exactly as its entry allows" is writable once M-6 pins the resolved graph.
- **CAP-5:** the rule is covered (AD-12 unchanged on the new edges). The Xaravel success criterion needs H-2.
- **CAP-10:** covered; distance along the graph's edges. The `blocking` tag still rides an override (open item, correctly recorded).
- **Repo policy constraint:** conflicts with AD-11/AD-3 (H-1).
