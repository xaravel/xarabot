/**
 * The package layer of the prompt (AR21, AR30): one template per part, with
 * `{{placeholder}}` slots that `buildPrompt` and `buildPlanningPrompt` fill
 * in one pass. The Story parts carry no selection, CI, merge or status
 * instruction (the CI-fix part may say "CI log" only); the planning parts
 * (Story 2.7) carry no CI, merge, queue, PR, push, approval, claim, `next`,
 * ledger or selection word; the retro parts (Story 2.9) carry no CI, push,
 * queue, approval, claim, `next`, ledger, sprint-status or selection word;
 * the retro-item parts (Story 2.10) carry no word the Story parts may not
 * carry (the CI-fix part may say "CI log" only). The runner does all of that.
 *
 * Placeholders: `story_id`, `sprint_key`, `findings_path` (loopback only),
 * `log_path` (CI fix only), `steps`, `sections`, `result_path` and
 * `result_schema`; for planning `planning_unit`, `epics_path`, `epics_dir`
 * and `planning_contexts` (status), `planning_headings`, `manifests_dir`
 * and `manifest_paths` (graph); for a retro `retro_unit`, `retro_epic` and
 * `prs_path`; for a retro item `retro_item_unit`, `retro_item_id`,
 * `retro_item_epic`, `retro_item_text` and `retro_item_globs` (and
 * `log_path` in its CI fix).
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
  /** The result step of a retro-item unit, in either mode: always the prompt's last part. */
  readonly result_retro_item: string;
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
  "planning_headings",
  "manifests_dir",
  "manifest_paths",
  "retro_unit",
  "retro_epic",
  "prs_path",
  "retro_item_unit",
  "retro_item_id",
  "retro_item_epic",
  "retro_item_text",
  "retro_item_globs",
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
- When your permission mode refuses an action, never work around it: do not retry it another way. Record it in \`denied_actions\` in your result.`,

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

{{planning_contexts}}`,

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

  result_retro_item: `${RESULT_HEAD}

Set \`outcome\` and \`blocked\`:

- You did the work and the verification commands pass: \`outcome\` \`done\`.
- You cannot finish: \`outcome\` \`blocked\`, with the reason in \`blocked.text\` and \`blocked.kind\`: \`intent-gap\` when the action item does not settle what to do; \`verification\` when a verification command still fails; \`human-live-step\`, with \`blocked.step_id\` set to the id of a step listed under Human Live Steps, never one you make up, when the work needs one of those steps; \`escalation\` when it needs a decision from the Maintainer; \`other\` for anything else.
- There was nothing to change: \`outcome\` \`no-op\`.

${RESULT_FIELDS}`,
};
