/**
 * The package layer of the prompt (AR21, AR30): one template per part, with
 * `{{placeholder}}` slots that `buildPrompt` and `buildPlanningPrompt` fill
 * in one pass. The Story parts carry no selection, CI, merge or status
 * instruction (the CI-fix part may say "CI log" only); the planning parts
 * (Story 2.7) carry no CI, merge, queue, PR, push, approval, claim, `next`,
 * ledger or selection word; the retro parts (Story 2.9) carry no CI, push,
 * queue, approval, claim, `next`, ledger, sprint-status or selection word;
 * the retro-item parts (Story 2.10) carry no word the Story parts may not
 * carry (the CI-fix part may say "CI log" only); the review parts (Story
 * 3.4) carry no word the Story parts may not carry, and no PR, push,
 * approval, status or ledger word. The runner does all of that.
 * The Story and retro-item prompts also carry `epic_context`, so a build
 * session skips the Epic context recompile that the runner always reverts;
 * the planning prompts, which compile those files, never carry it.
 *
 * Placeholders: `story_id`, `sprint_key`, `findings_path` (loopbacks only),
 * `log_path` (CI fix only), `steps`, `sections`, `result_path` and
 * `result_schema`; for planning `planning_unit`, `epics_path`, `epics_dir`,
 * `planning_contexts` and `planning_first_compiles` (status, the last in
 * `planning_questions` only), `planning_headings`, `manifests_dir`
 * and `manifest_paths` (graph); `coverage_rules` (`glob_coverage` only);
 * for a retro `retro_unit`, `retro_epic` and
 * `prs_path`; for a retro item `retro_item_unit`, `retro_item_id`,
 * `retro_item_epic`, `retro_item_text` and `retro_item_globs` (and
 * `log_path` in its CI fix, `findings_path` in its loopback); for a review `review_unit`, `review_sha`,
 * `review_main_sha`, `review_spec` (the sentence naming the spec, or saying
 * there is none) and `spec_path` (the follow-up pass only).
 */
export type PromptTemplate = {
  /** A `story` first build: names the Story and runs `bmad-build-auto`. */
  readonly first_build: string;
  /** A `story` loopback: applies prefetched review findings; no skill. */
  readonly loopback: string;
  /** A `story` CI fix: applies the prefetched CI log; no skill. */
  readonly ci_fix: string;
  /** Rules for every session. */
  readonly rules: string;
  /** The Epic context files are the runner's: Story and retro-item prompts only, never a planning prompt. */
  readonly epic_context: string;
  /** The Human Live Steps list; omitted when the list is empty. */
  readonly human_live_steps: string;
  /** The repo's `.xarabot/prompts/` sections; omitted when there are none. */
  readonly repo_sections: string;
  /** The result step after a first build: always the prompt's last part. */
  readonly result_build: string;
  /** The result step after a loopback or CI fix: always the prompt's last part. */
  readonly result_fix: string;
  /** A status planning unit: runs `bmad-sprint-planning` headless, then compiles the due Epic contexts. */
  readonly planning_status: string;
  /** A graph planning unit: writes the missing manifests; no skill. */
  readonly planning_graph: string;
  /**
   * After `planning_status`, only when it compiles an Epic's context for the
   * first time (Epic 3 retro item 15): lists that Epic's open design
   * questions, and ends `blocked` with them instead of compiling when there
   * are any.
   */
  readonly planning_questions: string;
  /**
   * After the graph planning or retro task, only when the repo's config sets
   * `glob_coverage` (Epic 3 retro item 14): the table of globs each glob
   * needs beside it, generated from that config.
   */
  readonly glob_coverage: string;
  /** The result step of a planning unit: always the prompt's last part. */
  readonly result_planning: string;
  /** A retro unit: runs `bmad-retrospective -H <N>` on the prefetched PR history. */
  readonly retro: string;
  /** The result step of a retro unit: always the prompt's last part. */
  readonly result_retro: string;
  /** A retro-item unit (Story 2.10): does one retro action item; no skill. */
  readonly retro_item: string;
  /** A retro-item CI fix: applies the prefetched CI log; no skill. */
  readonly retro_item_ci_fix: string;
  /** A retro-item loopback (Story 3.5): applies the prefetched review findings; no skill. */
  readonly retro_item_loopback: string;
  /** The result step of a retro-item unit, in any mode: always the prompt's last part. */
  readonly result_retro_item: string;
  /** A review pass (Story 3.4): reviews the unit's change `main...HEAD` at one SHA; no skill, no file changed. */
  readonly review: string;
  /** The follow-up pass's addition, after `review`: the spec's unverified risks to check. */
  readonly review_followup: string;
  /** Rules for a review session: `rules` without leaving changes for the runner, since a review changes nothing. */
  readonly review_rules: string;
  /** The result step of a review pass: always the prompt's last part. */
  readonly result_review: string;
};

export const PLACEHOLDERS = [
  "story_id",
  "sprint_key",
  "findings_path",
  "log_path",
  "steps",
  "sections",
  "result_path",
  "result_schema",
  "planning_unit",
  "epics_path",
  "epics_dir",
  "planning_contexts",
  "planning_first_compiles",
  "planning_headings",
  "manifests_dir",
  "manifest_paths",
  "coverage_rules",
  "retro_unit",
  "retro_epic",
  "prs_path",
  "retro_item_unit",
  "retro_item_id",
  "retro_item_epic",
  "retro_item_text",
  "retro_item_globs",
  "review_unit",
  "review_sha",
  "review_main_sha",
  "review_spec",
  "spec_path",
] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

const RESULT_FIELDS = `The other fields:

- \`summary\`: one line saying what the change does (it becomes the commit title).
- \`body\`: a description of the change for a reviewer: never this session, the runner, the working tree or how the skill ran.
- \`verification\`: each command or manual check you ran, with its outcome.
- \`denied_actions\`: each action your permission mode refused; \`[]\` when none.

Write this file last, and do nothing after it.`;

const resultHead = (kind: string): string => `# Result

Your last step: write your result as one JSON object to the file named by the environment variable \`$XARABOT_RESULT\`, which is \`{{result_path}}\`. The object must match this JSON Schema for a \`${kind}\` result:

\`\`\`json
{{result_schema}}
\`\`\``;

const RESULT_HEAD = resultHead("build");

export const PACKAGE_TEMPLATE: PromptTemplate = {
  first_build: `# Task

Build Story {{story_id}} (\`{{sprint_key}}\`)

Run the stock \`bmad-build-auto\` skill with the line above as its input, and follow it until it halts.`,

  loopback: `# Task

Revise Story {{story_id}} (\`{{sprint_key}}\`).

Run no skill. The review findings for this Story are prefetched in \`{{findings_path}}\`, in your temp folder. Read them, fix every blocking finding in this clone, and fix the others where they are correct. Then run the Story's verification commands.`,

  ci_fix: `# Task

Repair Story {{story_id}} (\`{{sprint_key}}\`).

Run no skill. The CI log for this Story's latest change is prefetched in \`{{log_path}}\`, in your temp folder. Read it, find the cause of each failure it reports, fix it in this clone, and re-run the failing commands here.`,

  rules: `# Rules

- Work only inside this clone, your current working directory, and your temp folder.
- Leave your changes in the clone's working tree; the runner reads them from there.
- When your permission mode or the sandbox refuses an action, never work around it: do not retry it another way, such as with a changed environment variable, a disabled sandbox, another tool or another command. Record it in \`denied_actions\` in your result.
- Give each subagent you start the rule above, and record each action refused to a subagent in \`denied_actions\` too.`,

  epic_context: `# Epic context

The runner owns each Epic context file, \`epic-<N>-context.md\` among the implementation artifacts, and reverts any change to it, so a compiled one is always thrown away. Never compile, recompile or edit one, even when a planning artifact is newer than it: load it as it is.`,

  human_live_steps: `# Human Live Steps

These steps need a person and cannot be done in this session. If the work needs one of them, stop and report a \`blocked\` result with \`blocked.kind\` \`human-live-step\` and that step's id as \`blocked.step_id\`.

{{steps}}`,

  repo_sections: `# Repository instructions

{{sections}}`,

  result_build: `${RESULT_HEAD}

Map how \`bmad-build-auto\` halted to \`outcome\` and \`blocked\`:

- It halted \`done\`: \`outcome\` \`done\`.
- It halted \`blocked\`: \`outcome\` \`blocked\`, with its blocking condition in \`blocked.text\` and \`blocked.kind\` from that condition: \`intent gap\` is \`intent-gap\`; a failed verification is \`verification\`; a Human Live Step is \`human-live-step\`, with \`blocked.step_id\` set to the id of a step listed under Human Live Steps, never one you make up; a decision for the Maintainer is \`escalation\`; anything else is \`other\`.
- It halted \`ready-for-dev\` (it stopped after planning) or any other way: \`outcome\` \`blocked\` with \`blocked.kind\` \`other\`.

\`bmad-build-auto\` has no \`no-op\` outcome, so never report \`no-op\` after it.

${RESULT_FIELDS}`,

  result_fix: `${RESULT_HEAD}

Set \`outcome\` and \`blocked\`:

- You fixed everything and the verification commands pass: \`outcome\` \`done\`.
- You cannot finish: \`outcome\` \`blocked\`, with the reason in \`blocked.text\` and \`blocked.kind\`: \`intent-gap\` when the Story's intent does not settle what to do; \`verification\` when a verification command still fails; \`human-live-step\`, with \`blocked.step_id\` set to the id of a step listed under Human Live Steps, never one you make up, when the work needs one of those steps; \`escalation\` when it needs a decision from the Maintainer; \`other\` for anything else.
- There was nothing to change: \`outcome\` \`no-op\`.

${RESULT_FIELDS}`,

  planning_status: `# Task

Plan the sprint for this repository (\`{{planning_unit}}\`).

1. Run the stock \`bmad-sprint-planning\` skill headless, asking no questions, for its full sprint-planning flow: its readiness gate, then the tracking file. Never save a findings file. If its readiness gate fails, or the skill halts \`blocked\`, stop there: report its findings in your result, as the Result section says, and change nothing else.
2. Then, for each Epic below, follow \`.claude/skills/bmad-build-auto/compile-epic-context.md\` with that Epic's number, the epics file \`{{epics_path}}\`, the planning artifacts folder \`{{epics_dir}}\` and the output path given:

{{planning_contexts}}

3. In each file you compiled, write the source line given for its Epic, exactly as given, as the file's second line, directly below its \`# Epic <N> Context:\` heading. Keep the heading the first line, and leave no other source line in the file.`,

  planning_questions: `# Open design questions

Do this after step 1 and before step 2. These Epics have no context file on \`main\` yet, so this run compiles theirs for the first time:

{{planning_first_compiles}}

For each of these Epics, read every Story of it in \`{{epics_path}}\`, and the Maintainer decisions recorded there, and list each design question that the Stories' acceptance criteria and those decisions leave open: the kind a build session would stop on as an \`intent-gap\`, because the texts allow two or more readings that would behave differently. List no question those texts already settle, and none about how to write the code.

- If any of these Epics has an open question, skip steps 2 and 3: write no context file, for any Epic. End \`blocked\`, with every open question in \`summary\`, in one batch, grouped by Epic and then by Story: an \`Epic <N>\` line, then one line for each of its questions, as \`- Story <id>: <question> Readings: <each reading, and how it would behave>.\` Keep each line short: the Maintainer answers them all from one inbox item.
- If none has an open question, go on with step 2 for every Epic it lists.`,

  planning_graph: `# Task

Write the missing Story manifests for this repository (\`{{planning_unit}}\`).

Run no skill, and never run \`bmad-sprint-planning\`. These Story headings in \`{{epics_path}}\` have no manifest:

{{planning_headings}}

For each one, write \`{{manifests_dir}}/<id>.md\`, where \`<id>\` is the Story id, holding only YAML frontmatter between two \`---\` lines, with these keys:

- \`story_id\`: the Story id, quoted (\`"3.1"\`).
- \`epic\`: the Epic number.
- \`sprint_key\`: the Story id with its \`.\` as \`-\`, a \`-\`, then the heading's title in lowercase kebab case (\`3-1-some-title\`).
- \`title\`: the heading's title, quoted.
- {{manifest_paths}}
- \`depends_on\`: the quoted ids of the Stories this one builds on: an earlier Story in the same Epic, or a Story in an Epic this Epic depends on. Set it on every Story that builds on an earlier one; \`[]\` when it builds on none.

Besides those manifests you may edit only \`{{epics_path}}\` and \`.xarabot/epics.yaml\`, and only where the manifests need it. Change no other file.

\`.xarabot/epics.yaml\` holds the Epic dependencies. Its schema, with no other key at either level:

\`\`\`yaml
version: 1
epics:
  "4":                 # an Epic number, as a quoted key
    depends_on: [2, 3] # optional: the Epic numbers this Epic depends on
    checkpoint: true   # optional: only ever the value true
\`\`\`

An Epic not listed there, or listed with no \`depends_on\`, depends on the nearest lower Epic number in \`{{epics_path}}\`.`,

  glob_coverage: `# Globs cover tests and wiring

This repository's coverage table says which globs each glob needs beside it in the same list: its tests, and the wiring files a known kind of change needs. In every list of globs you write, add each glob the table needs for a glob in the list, including the globs you add. A needed glob counts as listed when the list holds it, or a glob that covers it: \`test/**\` covers \`test/a.test.ts\`. In the table, \`<name>\` stands for any text, the same text everywhere in its row; every other character must be written exactly as shown, so a \`*\` matches only a \`*\`.

{{coverage_rules}}`,

  result_planning: `${resultHead("planning")}

Set \`outcome\`:

- You finished the task and changed files: \`done\`.
- Every file was already in place, so you changed nothing: \`nothing-due\`.
- You cannot finish (a failed readiness gate, a halted skill, or anything else): \`blocked\`, with every finding or the reason in \`summary\`.

The other fields:

- \`summary\`: for \`done\`, one line saying what the change does (it becomes the commit title); for \`blocked\`, the findings; for \`nothing-due\`, one line saying why.
- \`denied_actions\`: each action your permission mode refused; \`[]\` when none.

Write this file last, and do nothing after it.`,

  retro: `# Task

Run the retrospective of Epic {{retro_epic}} (\`{{retro_unit}}\`).

Run the stock \`bmad-retrospective\` skill headless, as \`bmad-retrospective -H {{retro_epic}}\`, asking no questions, and follow it until it halts. It writes the Epic's retrospective document and appends the Epic's action items.

The Epic's pull requests are prefetched in \`{{prs_path}}\`, in your temp folder: read them from there, never from GitHub. It holds one JSON object whose \`prs\` lists each pull request on one of the Epic's Story branches, with its Story, number, title, body, state, head commit and merge commit, and its reviews (author, state, time and reviewed commit). The Epic's git history is in this clone.`,

  result_retro: `${resultHead("retro")}

Set the fields:

- \`verdict\`: the \`verdict\` in the frontmatter of the retrospective document the skill wrote, exactly as written there.
- \`items\`: one entry for each action item the skill appended in this run, in its order, and no other:
  - \`id\`: the item's id as appended, of the form \`epic-{{retro_epic}}-retro-item-<seq>-<slug>\`.
  - \`text\`: the item's action text, on one line.
  - \`blocking\`: \`true\` when the item must be done before work on the Epics that depend on this one starts; else \`false\`.
  - \`route\`: \`lane\` when a build session can do the item by changing files in this repository; \`maintainer\` when it needs a person.
  - \`globs\`: quoted repo-relative globs covering every file the item's work changes; \`[]\` when it changes no file. Never list the planning artifacts, the tracking files, \`.xarabot/\`, \`.github/\`, agent configuration, the Standing Authority file, the repository's Protected Paths or the Maintainer's evidence files.
- \`denied_actions\`: each action your permission mode refused; \`[]\` when none.

Write this file last, and do nothing after it.`,

  retro_item: `# Task

Do the action item \`{{retro_item_id}}\` from Epic {{retro_item_epic}}'s retrospective (\`{{retro_item_unit}}\`).

Run no skill. The action item says:

{{retro_item_text}}

Do it in this clone, changing only files these globs cover: {{retro_item_globs}}. Never change agent configuration (such as a \`CLAUDE.md\` or \`AGENTS.md\` file), the tracking files, the planning artifacts, \`.xarabot/\`, \`.github/\`, the Standing Authority file, the Maintainer's evidence files or the repository's Protected Paths, even inside those globs. Then run the verification commands that cover your change.`,

  retro_item_ci_fix: `# Task

Repair the action item \`{{retro_item_id}}\` from Epic {{retro_item_epic}}'s retrospective (\`{{retro_item_unit}}\`).

Run no skill. The action item says:

{{retro_item_text}}

The CI log for this item's latest change is prefetched in \`{{log_path}}\`, in your temp folder. Read it, find the cause of each failure it reports, fix it in this clone, changing only files these globs cover: {{retro_item_globs}}, and re-run the failing commands here. Never change agent configuration (such as a \`CLAUDE.md\` or \`AGENTS.md\` file), the tracking files, the planning artifacts, \`.xarabot/\`, \`.github/\`, the Standing Authority file, the Maintainer's evidence files or the repository's Protected Paths, even inside those globs.`,

  retro_item_loopback: `# Task

Revise the action item \`{{retro_item_id}}\` from Epic {{retro_item_epic}}'s retrospective (\`{{retro_item_unit}}\`).

Run no skill. The action item says:

{{retro_item_text}}

The review findings for this item's change are prefetched in \`{{findings_path}}\`, in your temp folder. Read them, fix every blocking finding in this clone, and fix the others where they are correct, changing only files these globs cover: {{retro_item_globs}}. Never change agent configuration (such as a \`CLAUDE.md\` or \`AGENTS.md\` file), the tracking files, the planning artifacts, \`.xarabot/\`, \`.github/\`, the Standing Authority file, the Maintainer's evidence files or the repository's Protected Paths, even inside those globs. Then run the verification commands that cover your change.`,

  result_retro_item: `${RESULT_HEAD}

Set \`outcome\` and \`blocked\`:

- You did the work and the verification commands pass: \`outcome\` \`done\`.
- You cannot finish: \`outcome\` \`blocked\`, with the reason in \`blocked.text\` and \`blocked.kind\`: \`intent-gap\` when the action item does not settle what to do; \`verification\` when a verification command still fails; \`human-live-step\`, with \`blocked.step_id\` set to the id of a step listed under Human Live Steps, never one you make up, when the work needs one of those steps; \`escalation\` when it needs a decision from the Maintainer; \`other\` for anything else.
- There was nothing to change: \`outcome\` \`no-op\`.

${RESULT_FIELDS}`,

  review: `# Task

Review the change of \`{{review_unit}}\` at commit \`{{review_sha}}\`.

Run no skill, and change no tracked file in this checkout: your findings go only in your result. Files the verification commands write are thrown away with the checkout. This checkout's \`HEAD\` is the change's last commit, \`{{review_sha}}\`, and \`main\` is at \`{{review_main_sha}}\`. The change under review is \`git diff main...HEAD\`, and \`git log main..HEAD\` lists its commits. The agent configuration files here (such as \`AGENTS.md\`, \`CLAUDE.md\` and the \`.claude/\` and \`.agents/\` folders) are \`main\`'s, put back by the runner, so they show as uncommitted changes: they are not part of the change.

{{review_spec}}

Read the whole change and the code around it. Look for wrong behaviour, unhandled edge cases and errors, broken contracts between modules, security problems, and tests that are missing or do not check what they should. Run the verification commands that cover the change where you can. Report each problem you find; report nothing you have not checked.`,

  review_followup: `# Follow-up review

The spec \`{{spec_path}}\` asks for this follow-up review. Its \`## Auto Run Result\` section names the risks its build left unverified. Check each of them against the change: verify it where you can, and report each risk that holds, or that you cannot rule out, as a finding.`,

  review_rules: `# Rules

- Work only inside this checkout, your current working directory, and your temp folder.
- When your permission mode or the sandbox refuses an action, never work around it: do not retry it another way, such as with a changed environment variable, a disabled sandbox, another tool or another command. Record it in \`denied_actions\` in your result.
- Give each subagent you start the rule above, and record each action refused to a subagent in \`denied_actions\` too.`,

  result_review: `${resultHead("review")}

Set the fields:

- \`reviewed_sha\`: \`{{review_sha}}\`, the commit you reviewed.
- \`verdict\`: \`pass\` when the change is ready as it is; \`changes-requested\` when any finding must be fixed first.
- \`findings\`: one entry for each problem you found; \`[]\` when none:
  - \`severity\`: \`high\`, \`medium\` or \`low\`.
  - \`blocking\`: \`true\` when the change must not go in until it is fixed; else \`false\`.
  - \`file\`: the repo-relative path of the file the finding is about.
  - \`text\`: what is wrong and why, and what would fix it, on one line.
- \`denied_actions\`: each action your permission mode refused; \`[]\` when none.

Write this file last, and do nothing after it.`,
};
