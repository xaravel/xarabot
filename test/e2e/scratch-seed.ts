import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The canary's scratch repo `main` (Story 1.20): the files a real lane needs
 * to pick Story 1.1 and take it to `merged`, plus the stand-in
 * `bmad-build-auto` skill and an `AGENTS.md` for the cross-vendor
 * verification's real sessions (Story 3.6). Run as a script, it writes them
 * into a folder for the Maintainer to commit and push to the scratch repo:
 *
 *     bun test/e2e/scratch-seed.ts <dir> <owner/name> <login>
 */

export type SeedParams = {
  /** The scratch repo, `owner/name`. */
  readonly repo: string;
  /** The Maintainer's login, whose `<login>-xarabot` App is installed on the scratch repo. */
  readonly login: string;
  /** `runner_version`; default `canary`. The live case writes the lane's `runner` file to match, so nothing is installed. */
  readonly runnerVersion?: string;
};

export const SEED_AUTHORITY_PATH = "docs/maintainer/standing-authority.md";
export const SEED_SPRINT_KEY = "1-1-canary";

/** Where the stand-in build skill sits: Claude Code reads `.claude/skills`, codex `.agents/skills`. */
export const SEED_SKILL_PATHS = [".claude/skills/bmad-build-auto/SKILL.md", ".agents/skills/bmad-build-auto/SKILL.md"] as const;
export const SEED_AGENTS_PATH = "AGENTS.md";

/** The cross-vendor verification's Story (Story 3.6): overlaid on `main` by the suite, never in the seed's own Story set. */
export const XV_STORY = { id: "1.6", epic: 1, title: "Cross-vendor verification", glob: "verify/**" } as const;

/** The file the stand-in skill writes for sprint key `key`. */
export function xvVerifyPath(key: string): string {
  return `verify/${key}.md`;
}

/** The spec file the stand-in skill writes for Story `<epic>.<story>`; it matches the default `story_spec_path`. */
export function xvSpecPath(epic: string, story: string): string {
  return `_bmad-output/implementation-artifacts/spec-${epic}-${story}-verify.md`;
}

/** The verify file's one line for sprint key `key`. */
export function xvVerifyText(key: string): string {
  return `Built for ${key}.\n`;
}

/** The spec the stand-in skill writes: `done`, no follow-up review, and an `## Auto Run Result` with `Status: done`. */
export function xvSpecText(epic: string, story: string, key: string): string {
  return [
    "---",
    `title: 'Story ${epic}.${story}: a scratch build'`,
    "status: done",
    "followup_review_recommended: false",
    "---",
    "",
    `# Story ${epic}.${story}: a scratch build`,
    "",
    `Built ${key}: wrote ${xvVerifyPath(key)}.`,
    "",
    "## Auto Run Result",
    "",
    "Status: done",
    "",
  ].join("\n");
}

const XV_KEY = /^([1-9][0-9]*)-([1-9][0-9]*)-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** What the stand-in skill writes for sprint key `key` (`<e>-<s>-<slug>`), path → text: the files a session leaves. */
export function xvSkillFiles(key: string): Record<string, string> {
  const m = XV_KEY.exec(key);
  if (m === null) throw new Error(`stand-in skill: ${JSON.stringify(key)} is not a sprint key <e>-<s>-<slug>`);
  const [, epic, story] = m as unknown as [string, string, string];
  return { [xvVerifyPath(key)]: xvVerifyText(key), [xvSpecPath(epic, story)]: xvSpecText(epic, story, key) };
}

/**
 * The stand-in `bmad-build-auto` skill (Story 3.6): the scratch repo has no
 * BMAD install, so a real `claude` or `codex` session builds a Story with
 * this in about a minute. For `Build Story <e>.<s> (`<key>`)` it writes the
 * verify file and the spec, changes nothing else and halts `done`.
 */
export const SEED_SKILL: string = [
  "---",
  "name: bmad-build-auto",
  'description: "Stand-in for the stock bmad-build-auto in the Xarabot scratch repo. Builds one Story by writing two files, then halts done. Use when told to run bmad-build-auto with a line like: Build Story 1.6 (`1-6-some-key`)."',
  "---",
  "",
  "# bmad-build-auto (scratch stand-in)",
  "",
  "This scratch repo has no BMAD install. This skill stands in for the stock `bmad-build-auto`, so a real session builds a Story here in about a minute.",
  "",
  "## Input",
  "",
  "One line, of this form:",
  "",
  "```text",
  "Build Story <e>.<s> (`<key>`)",
  "```",
  "",
  "`<e>` is the Epic number, `<s>` the Story number and `<key>` the Story's sprint key, which starts with `<e>-<s>-`. If the input has another form, halt `blocked`: the input names no Story.",
  "",
  "## Steps",
  "",
  "1. Write the file `verify/<key>.md` holding this line:",
  "",
  "   ```text",
  `   ${xvVerifyText("<key>").trimEnd()}`,
  "   ```",
  "",
  "2. Write the file `_bmad-output/implementation-artifacts/spec-<e>-<s>-verify.md` holding exactly this text, with `<e>`, `<s>` and `<key>` filled in:",
  "",
  "   ```markdown",
  ...xvSpecText("<e>", "<s>", "<key>")
    .trimEnd()
    .split("\n")
    .map((l) => (l === "" ? "" : `   ${l}`)),
  "   ```",
  "",
  "3. Change nothing else: no other file, no commit, no branch, no other skill. There are no verification commands to run.",
  "4. Halt `done`.",
  "",
].join("\n");

/** The scratch repo's `AGENTS.md`: what the repo is for, for a session building or reviewing in it. */
export const SEED_AGENTS: string = [
  "# Xarabot scratch repo",
  "",
  "This repository is the scratch repo for Xarabot's live tests: the canary (Story 1.20), the claims race (Story 2.12) and the cross-vendor verification (Story 3.6). Its Stories are test fixtures, not product work.",
  "",
  "- To build a Story, run the `bmad-build-auto` skill (`.claude/skills/` for Claude Code, `.agents/skills/` for codex). It is a stand-in that writes `verify/<key>.md` and the Story's spec, then halts `done`.",
  "- To review a change, read it as you would any change: the files it adds under `verify/` and `_bmad-output/implementation-artifacts/` are the whole product here.",
  "- There are no verification commands: the CI check `check` only prints `ok`.",
  "- A CI check may ask for one more line in a `verify/<key>.md` file. That line belongs there: a verify file may hold it after its first line.",
  "",
].join("\n");

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** The scratch repo's files, path → text. */
export function scratchSeed(p: SeedParams): Record<string, string> {
  if (!REPO.test(p.repo)) throw new Error(`scratch seed: ${JSON.stringify(p.repo)} is not owner/name`);
  if (!LOGIN.test(p.login)) throw new Error(`scratch seed: ${JSON.stringify(p.login)} is not a GitHub login`);
  const version = p.runnerVersion ?? "canary";
  return {
    ".xarabot/config.yaml": [
      "schema_version: 1",
      `runner_version: ${JSON.stringify(version)}`,
      `maintainer: ${JSON.stringify(p.login)}`,
      `standing_authority_path: ${SEED_AUTHORITY_PATH}`,
      "manifests:",
      "  dir: stories",
      "",
    ].join("\n"),
    ".xarabot/policy.yaml": ["schema_version: 1", "unattended_adapters: [claude]", "expected_checks: [check]", ""].join("\n"),
    ".xarabot/human-live-steps.yaml": "schema_version: 1\nsteps: []\n",
    [SEED_AUTHORITY_PATH]: [
      "---",
      "schema_version: 1",
      `granted_by: ${JSON.stringify(p.login)}`,
      "granted_at: 2026-10-23",
      `repo: ${JSON.stringify(p.repo)}`,
      "---",
      "",
      "Standing Authority for the Xarabot canary: a lane may build, push and enqueue Story 1.1 in this scratch repo.",
      "",
    ].join("\n"),
    "_bmad-output/planning-artifacts/epics.md": [
      "# Epics",
      "",
      "## Epic 1: Canary",
      "",
      "### Story 1.1: Canary",
      "",
      "A stub agent writes `canary/<run>.md`.",
      "",
    ].join("\n"),
    "_bmad-output/implementation-artifacts/epic-1-context.md": "# Epic 1 Context: Canary\n\nThe Xarabot canary's one Epic.\n",
    "_bmad-output/implementation-artifacts/sprint-status.yaml": ["development_status:", "  epic-1: in-progress", `  ${SEED_SPRINT_KEY}: backlog`, ""].join("\n"),
    "stories/1.1.md": ["---", 'story_id: "1.1"', "epic: 1", `sprint_key: ${SEED_SPRINT_KEY}`, "title: Canary", 'globs: ["canary/**"]', "---", ""].join("\n"),
    [SEED_SKILL_PATHS[0]]: SEED_SKILL,
    [SEED_SKILL_PATHS[1]]: SEED_SKILL,
    [SEED_AGENTS_PATH]: SEED_AGENTS,
    ".github/workflows/ci.yml": [
      "name: CI",
      "",
      "on:",
      "  pull_request:",
      "  merge_group:",
      "",
      "permissions:",
      "  contents: read",
      "",
      "jobs:",
      "  check:",
      "    runs-on: ubuntu-latest",
      "    timeout-minutes: 5",
      "    steps:",
      "      - run: echo ok",
      "",
    ].join("\n"),
  };
}

/** Writes `files` under `dir`. */
export function writeSeed(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
}

if (import.meta.main) {
  const [dir, repo, login, ...rest] = Bun.argv.slice(2);
  if (dir === undefined || repo === undefined || login === undefined || rest.length > 0) {
    console.error("usage: bun test/e2e/scratch-seed.ts <dir> <owner/name> <login>");
    process.exit(1);
  }
  const files = scratchSeed({ repo, login });
  writeSeed(dir, files);
  for (const path of Object.keys(files).sort()) console.log(`wrote ${join(dir, path)}`);
}
