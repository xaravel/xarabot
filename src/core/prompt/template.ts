/**
 * The package layer of the prompt (AR21, AR30): one template per part, with
 * `{{placeholder}}` slots that `buildPrompt` fills in one pass. This text
 * carries no selection, CI, merge or status instruction (the CI-fix part may
 * say "CI log" only); the runner does all of that.
 *
 * Placeholders: `story_id`, `sprint_key`, `findings_path` (loopback only),
 * `log_path` (CI fix only), `steps`, `sections`, `result_path` and
 * `result_schema`.
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
] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

const RESULT_FIELDS = `The other fields:

- \`summary\`: one line saying what you did.
- \`body\`: a description of the change for a reviewer.
- \`verification\`: each command or manual check you ran, with its outcome.
- \`denied_actions\`: each action your permission mode refused; \`[]\` when none.

Write this file last, and do nothing after it.`;

const RESULT_HEAD = `# Result

Your last step: write your result as one JSON object to the file named by the environment variable \`$XARABOT_RESULT\`, which is \`{{result_path}}\`. The object must match this JSON Schema for a \`build\` result:

\`\`\`json
{{result_schema}}
\`\`\``;

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
- It halted \`ready-for-dev\` (after planning, before building): \`outcome\` \`blocked\` with \`blocked.kind\` \`other\`, and its halt in \`blocked.text\`.
- It halted any other way: \`outcome\` \`blocked\` with \`blocked.kind\` \`other\`, and its halt in \`blocked.text\`.

${RESULT_FIELDS}`,

  result_fix: `${RESULT_HEAD}

Set \`outcome\` and \`blocked\`:

- You fixed everything and the verification commands pass: \`outcome\` \`done\`.
- You cannot finish: \`outcome\` \`blocked\`, with the reason in \`blocked.text\` and \`blocked.kind\`: \`intent-gap\` when the Story's intent does not settle what to do; \`verification\` when a verification command still fails; \`human-live-step\`, with \`blocked.step_id\` set to the id of a step listed under Human Live Steps, never one you make up, when the work needs one of those steps; \`escalation\` when it needs a decision from the Maintainer; \`other\` for anything else.
- There was nothing to change: \`outcome\` \`no-op\`.

${RESULT_FIELDS}`,
};
