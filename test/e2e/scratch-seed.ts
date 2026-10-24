import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The canary's scratch repo `main` (Story 1.20): the files a real lane needs
 * to pick Story 1.1 and take it to `merged`. Run as a script, it writes them
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
