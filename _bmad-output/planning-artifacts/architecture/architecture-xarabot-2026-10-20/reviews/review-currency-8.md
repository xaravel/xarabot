---
review: currency (pass 8)
target: ARCHITECTURE-SPINE.md (architecture-xarabot-2026-10-20), uncommitted change "no BMAD overrides" (AD-12, AD-14, AD-28, AD-29) and the matching SPEC.md change
reviewed: 2026-10-21
lens: Each claim was checked against the installed stock skills (BMAD 6.12.4) in `.claude/skills/` and `.agents/skills/` (the two trees are byte-identical, `diff -rq` clean) and `_bmad/scripts/`. Nothing here is from training data. Claims about CLI behavior that the files cannot show are marked UNCONFIRMED.
---

# Currency review 8: stock skills plus a trailing result step

## Verdict

**The decision holds for three of the five skills, with corrections. It fails for two.**

- `bmad-build-auto`, `bmad-retrospective` (with `-H <epic>`) and `bmad-sprint-planning` (headless) can run unattended.
- `bmad-correct-course` and `bmad-create-epics-and-stories` have no headless mode. They stop at hard-wired menus and approvals.
- The retro path has a gap the change does not cover. The stock skill already writes action items to `sprint-status.yaml`, with its own ids, owners and statuses. The retro result's `items[]` has no field that joins to those items. Both files also track item status.

## Method

- Read in full: `bmad-build-auto/` (`SKILL.md`, `workflow.md`, steps 01 to 04, `customize.toml`), `bmad-retrospective/` (`SKILL.md`, all `references/`, `customize.toml`, `scripts/sprint_status.py` lines 25 to 40 and 528 to 645), `bmad-sprint-planning/` (`SKILL.md`, all `references/`), and `bmad-correct-course/SKILL.md`.
- Read `bmad-create-epics-and-stories/SKILL.md` and searched its steps 01 to 04 for menus, halts and approvals.
- Read `bmad-review/SKILL.md`, because the retro calls it. Read `_bmad/scripts/render_skill.py` and checked `_bmad/render/.gitignore` and `_bmad/custom/`.
- Checked AD-9, AD-12 to AD-17 and AD-28 to AD-30 in the spine. Checked SPEC.md line 197 (BMAD scope).

## Question 1: termination, interactivity and headless modes

### `bmad-build-auto`: unattended by design, but its ending tells the agent to stop

- **No interaction.** Steps 02 to 04 each say "No human interaction". Every exit goes through HALT with a status. No flag is needed.
- **How it ends.** `workflow.md` HALT step 3 says "Follow **On Complete** below, then stop the workflow." On Complete says "follow it as the final terminal instruction before exiting; otherwise exit normally". `on_complete` is `""` by default, so the rendered text ends at "otherwise exit normally". The Subagents section also says: "The only sanctioned way to end a turn is the HALT protocol above with an explicit terminal `status`."
  - Nothing kills the process. But the skill tells the agent, in plain words, that HALT ends the turn. That is the cue a trailing prompt step must win against.
  - The skill provides exactly one place for a final instruction, and that place is `on_complete`. The change rules out using it.
- **It writes its own result.** HALT writes `status` into the spec's frontmatter and fills `## Auto Run Result` (`done`, `blocked` or `ready-for-dev`, plus a blocking condition). An early halt instead writes `{implementation_artifacts}/bmad-build-auto-result-<slug>.md`. Both end up in the clone's working tree.
- **Mandatory subagents.** "If you cannot, HALT with status `blocked` and blocking condition `no subagents`." UNCONFIRMED: whether `codex exec` and `pi -p` give the agent a subagent tool. If either does not, build-auto blocks on every run in that lane.
- **Branch check.** Step 01, item 3, needs a clean tree and "a branch that fits the intent". It HALTs "on a dirty tree or obvious branch mismatch". The clone is rebuilt from `runner.git` (AD-15), so the checked-out branch name has to fit the Story. The spine does not say what branch the clone is on.
- **Re-runs.** If the spec file is already `done`, build-auto starts its own follow-up review (step 01). It does not apply review findings that someone else supplies. The spine does not say how a loopback or CI-fix session's prompt runs "the stock skill for the unit". UNCONFIRMED.

### `bmad-retrospective`: headless with `-H <epic>`

- `SKILL.md` § Modes: "`-H <epic>` — an explicit epic in headless mode — is the stable orchestrator-facing interface." Headless mode skips every confirmation and never opens the team discussion. It renders the verdict on the evidence alone and records each assumption in the document.
- **Headless stops.** It stops and reports in these cases:
  - `story_count: 0` (an epic number that is probably mistyped);
  - an unreadable `sprint-status.yaml`;
  - a stories-mode folder without an explicit folder argument.
  These are clean stops, but each ends the turn.
- **How it ends.** Finish (`references/retro-document.md`): "Report where the document was saved, the verdict, and the action-item count. Then, if `{workflow.on_complete}` is non-empty, follow it as the final terminal instruction before exiting." This is the same "before exiting" cue as build-auto.
- **The prompt must pass `-H <N>`.** Without it, the skill greets the user, asks about concerns and confirms the epic. On `claude -p` that ends the turn at the first question.

### `bmad-sprint-planning`: headless exists, but has no named flag

- `SKILL.md` § Headless Mode: "When invoked headless, do not ask." Any ambiguity "halts with a `blocked` status". The run must "End with a JSON response" (`status`, `intent`, `gate`, `status_file`, `findings`, `warnings`).
- **No flag.** The description names no `-H` flag, unlike the retro. The prompt has to say "headless" and give the intent (`sprint-planning` or `readiness`) in words.
- **The JSON is a chat reply, not a file.** That reply is the skill's designed last act, and the trailing result step comes after it. The two do not clash, but the prompt should tell the agent to copy that JSON into the `planning` result.
- `fix-sprint-status.md` step 4 says: "Headless: halt with `blocked` instead of confirming." So the fix intent can never complete unattended.

### `bmad-correct-course`: no headless mode, so it cannot run unattended as it stands

- The skill never mentions headless. Step 1 asks "What specific issue or change has been identified…" and asks the user to choose Incremental or Batch mode.
- In Incremental mode, step 3 says "HALT and give the user a choice: **Approve** / **Edit** / **Skip**" for each proposal.
- Step 4 says "HALT and give the user a choice: **Continue** / **Edit**".
- Step 5 has `<ask>Do you approve this Sprint Change Proposal for implementation? (yes/no/revise)</ask>`.
- **What happens under `-p`.** The agent ends its turn at the first question, and no result is written. Or it answers its own approvals, which goes against "never decide it locally".
- The skill only writes a proposal. It applies no edits.

### `bmad-create-epics-and-stories`: no headless mode, so it cannot run unattended

- **Hard-wired waits.** `SKILL.md` § Step Processing Rules: "**WAIT FOR INPUT**: If a menu is presented, halt and wait for user selection." Also: "⏸️ **ALWAYS** halt at menus and wait for user input."
- **Step 01.** It asks for extra documents ("Wait for user confirmation") and ends with a `[C] continue` menu.
- **Step 02.** "Must get explicit user approval … Repeat until approval is received", then `[A] [P] [C]`.
- **Step 03.** It asks per Story ("Does this story capture the requirement correctly?") and ends with `[A] [P] [C]`.
- **Step 04.** "[C] Complete Workflow … HALT — wait for user input". After `C`, it invokes `bmad-help`.

## Question 2: where the retro records action items

- **In the retro document.** It is at `{implementation_artifacts}/epic-<N>-retro-<date>.md`. Its frontmatter is `epic`, `date`, `verdict` (`accepted` | `accepted-with-open-items` | `rejected`), `criteria` and `headless`. The doc says this frontmatter is the thing "an epic gate or orchestrator keys off". The § Action items prose says each item has an owner, but the prose has no fixed shape.
- **In `sprint-status.yaml` `action_items`.** The bundled script writes them (`sprint_status.py update --add-action '[{"action","owner"}]' --ref <doc>`). Each entry is `{id, epic, action, owner, status: open, ref}`.
  - **The id.** It is `epic-<N>-retro-item-<seq>-<slug>`, where `seq = len(action_items) + 1` (lines 539 to 543). The sequence runs across **all** epics' items. It is not per epic.
  - **Stability.** The id is stable once written. Its number is not `n` in Xarabot's `retro-item:<epic>.<n>`. The script's JSON reply gives only `action_items_added`, a count with no ids.
  - **Owner.** It is free text (the stock example is "Charlie (Senior Dev)"). It is not a Xarabot routing target.
  - **Status.** It can only be `open`, `in-progress` or `done` (`ACTION_STATUSES`). A headless retro never passes `--set-action-status`.
- **Can a trailing step list them reliably?** Yes, but only by reading `sprint-status.yaml` back after the script has run. It would take the entries whose `epic` is N and whose `ref` is this retro's document, and those carry stable `id`, `owner` and `action`. Restating them from memory risks text drift. The AD-14 `retro` schema (`items[] {text, owner, blocking, globs}`) has no `id`, so `reconcile` cannot join a result item to the stock entry. AD-28's `block`/`unblock <retro-item-id>` also has no defined id to name.

## Question 3: existing structured output and `on_complete`

- **`on_complete`.** All five skills have an `on_complete` scalar, empty by default. None writes a result file of its own, so nothing collides with `$XARABOT_RESULT`.
- **Sources that duplicate the result.** These are not conflicts, but each can drift from what the agent reports:
  - **build-auto.** The spec's frontmatter `status` and `## Auto Run Result`. Its vocabulary is `done` | `blocked` | `ready-for-dev`, with a free-text blocking condition and no step ids. AD-14 `build` wants `done` | `blocked` | `no-op` and `blocked.step_id`. Build-auto never produces `no-op`, has nothing that maps to `step_id`, and its `ready-for-dev` has no AD-14 equivalent.
  - **retro.** The document's frontmatter `verdict` and the `sprint-status.yaml` `action_items`, both above. The skill writes these for orchestrators to read. Per SPEC's "artifacts the runner reads", the runner can read them itself instead of trusting the agent's restatement.
  - **sprint-planning.** The headless JSON reply.
  - **bmad-review** (the retro calls it). Its findings carry no severity ("No severity, priority, or ranking anywhere"). This matters only if the `review` kind also runs a stock skill. The spine does not name one.

## Other currency points

- **The stock skills need `uv`, Python and PyPI. AD-17's sandbox does not allow them.**
  - build-auto's `SKILL.md` first runs `uv run --no-cache _bmad/scripts/render_skill.py`, which needs Python 3.11 or later. "On failure (including `uv` being unavailable) … HALT."
  - The retro's `sprint_status.py` and sprint-planning's `sprint_plan.py` declare `dependencies = ["ruamel.yaml>=0.18"]`. The retro forbids hand-editing `sprint-status.yaml`. Without the script, no action items are written.
  - `--no-cache` forces a fresh resolve on every run. UNCONFIRMED: whether it can work offline at all.
  - AD-17 allows reads only of system paths, the clone, the vendor home and the temp folder. It allows network only to vendor API hosts plus repo-added hosts. A uv-managed Python under `~/.local/share/uv` and the fetches from `pypi.org` and `files.pythonhosted.org` would be refused. On this host, `uv` is `/opt/homebrew/bin/uv`.
- **Render output.** `render_skill.py` writes snapshots under `_bmad/render/`, which a `*` ignore rule covers. They do not leak into the squashed diff. Confirmed.
- **The `_bmad/custom/` wording.** The stock installer itself creates `_bmad/custom/config.toml` and `.gitignore`. "Never writes or requires `_bmad/custom/`" is still true for Xarabot, but the folder will exist in every consuming repo.
- **Which skill each unit runs.** AD-29 says "the stock BMAD skill for the unit", but no AD maps unit kinds (`story`, `retro`, `retro-item`, `planning`, review) to a skill and its unattended invocation. SPEC.md line 197 lists `bmad-correct-course` among the skills Xarabot drives.
- UNCONFIRMED: how `codex exec` and `pi -p` start a named skill from `.agents/skills`, and whether pi discovers skills there at all. AGENTS.md says so, but this review found no file that shows it.

## Findings

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | S1 | `bmad-correct-course` and `bmad-create-epics-and-stories` have no headless mode. They halt at Approve/Edit/Skip, yes/no and `[C]` menus. Under `-p`, the turn ends without a result, or the agent approves its own proposals. SPEC line 197 still lists correct-course as driven. | AD-29 gets a table mapping each unit kind to its stock skill and exact unattended invocation. Keep these two skills Maintainer-run and interactive: Xarabot only reads their outputs. Or record a Maintainer ruling that the prompt pre-answers their menus, and note that this is an override in all but name. |
| 2 | S2 | The retro result's `items[]` has no `id`. The stock script has already written `action_items` with ids `epic-<N>-retro-item-<seq>-<slug>` (`seq` is global, not per epic) and free-text owners. `reconcile` cannot join result items to them. `retro-item:<epic>.<n>` and `block`/`unblock <retro-item-id>` have no defined mapping. | Add `id` to the AD-14 `retro` items, copied verbatim from `sprint-status.yaml` after the script runs. `reconcile` refuses a result whose ids, texts or verdict don't match `action_items` (filtered by `epic` and `ref`) and the document's frontmatter `verdict`. Either define the retro-item unit id as the stock id, or state the mapping. Rename Xarabot's `owner` (for example `route: lane` or `route: maintainer`) so it doesn't shadow the stock free-text owner. |
| 3 | S2 | There are two stores for item status. The stock `sprint-status.yaml` uses `open`, `in-progress` and `done`; the next retro's follow-through and sprint-planning's status view read it, and a headless retro never moves it. `retro-gates.yaml` uses `open`, `in-progress`, `waiting`, `deferred` and `done`. AD-9's "retro-item: item status `done`" doesn't name a file. | AD-12 names `retro-gates.yaml` as the gate's single source of truth. It also says whether `reconcile`'s runner code mirrors `done` back into `sprint-status.yaml` by stock id, or accepts that the stock views go stale. |
| 4 | S2 | Each skill's ending cues the agent to stop. Build-auto says "stop the workflow", "otherwise exit normally" and "the only sanctioned way to end a turn is the HALT protocol". The retro, correct-course and create-epics say "final terminal instruction before exiting". Sprint-planning says "End with a JSON response". Whether a trailing prompt step still runs is UNCONFIRMED for all three CLIs. | Add a spike to the adapter Stories that measures how often the result file is written, per skill and CLI. Before counting a failed attempt, the runner resumes the same session once with a prompt that only asks for the result (`claude -p --resume`; `codex exec resume`; pi is UNCONFIRMED). For builds, it cross-checks the spec's `status` and `## Auto Run Result`. |
| 5 | S2 | Every stock skill runs `uv run --no-cache` (Python 3.11 or later; `ruamel.yaml` from PyPI). Build-auto HALTs without it, and the retro cannot write action items without it. AD-17's read and network allowlists refuse both. | AD-17 allows the `uv` binary and its Python install paths, and either PyPI hosts or a uv cache prepared in the temp folder (`--no-cache` defeats a cache, so check that). Add `uv` and Python to the Xarabot host's prerequisites. Prove it in the sandbox spike. |
| 6 | S3 | Build-auto requires subagents ("HALT … `no subagents`"). That is UNCONFIRMED for `codex exec` and pi. | Verify in each adapter Story. If a lane cannot spawn subagents, it cannot run build-auto. |
| 7 | S3 | AD-14 `build` doesn't match build-auto's output. Build-auto never yields `no-op`, has no source for `step_id`, can halt `ready-for-dev`, and gives blocking conditions as free text (`intent gap`, `implementation verification failed`, …). | The prompt template carries a mapping table to the spine's blocked kinds (state table, spine line 174: `intent-gap`, `verification`, `other`). Drop `step_id`, or define it as the step file the run halted in. |
| 8 | S3 | Build-auto HALTs on "obvious branch mismatch". The spine doesn't name the branch checked out in the rebuilt clone. Loopback and CI-fix sessions on a `done` spec start build-auto's own follow-up review, not Xarabot's findings. | AD-15 checks out `story/<id>` (or the unit's branch) in the clone. AD-29 says how a loopback prompt hands over the prefetched findings. |
