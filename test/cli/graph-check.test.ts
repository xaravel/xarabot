import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { graphCheck } from "../../src/cli/graph-check.ts";

const ROOT = join(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "src", "cli", "main.ts");
const MD = "_bmad-output/planning-artifacts/epics.md";
const dirs: string[] = [];

type RepoConfig = { readonly bootstrapped_epics?: readonly number[]; readonly manifests?: { readonly dir?: string } };

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function run(cwd: string): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([process.execPath, MAIN, "graph", "check"], { cwd, stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** A temp git repo holding `files` (untracked: graph check reads the working tree). */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "xarabot-graph-"));
  dirs.push(dir);
  const init = Bun.spawnSync(["git", "init", "-q", dir], { stdout: "pipe", stderr: "pipe" });
  if (init.exitCode !== 0) throw new Error(init.stderr.toString());
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function git(dir: string, args: readonly string[]): void {
  const proc = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
}

const CONFIG_HEAD = ["schema_version: 1", "runner_version: v0.1.0", "maintainer: edanisko", "standing_authority_path: docs/authority.md"];

const THREE = "# Epics\n\n## Epic 1: One\n\n### Story 1.1: A\n\n## Epic 2: Two\n\n### Story 2.1: B\n\n## Epic 3: Three\n";

describe("xarabot graph check", () => {
  test("fixture repo with no epics.yaml: serial, warnings, exit 0", () => {
    const dir = fixture({ [MD]: THREE });
    mkdirSync(join(dir, "sub"));
    const r = run(join(dir, "sub"));
    expect(r.code).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^graph sha256:[0-9a-f]{64}$/);
    expect(lines.slice(1)).toEqual(["1 → []", "2 → [1]", "3 → [2]"]);
    expect(r.stderr).toBe(
      `warning: Story 1.1 (${MD}:5) has no manifest\nwarning: Story 2.1 (${MD}:9) has no manifest\n`,
    );
  });

  test("config paths, checkpoints, Story sets and bootstrapped_epics", () => {
    const dir = fixture({
      "plan/epics.md": THREE,
      ".xarabot/config.yaml": [
        "schema_version: 1",
        "runner_version: v0.1.0",
        "maintainer: edanisko",
        "standing_authority_path: docs/authority.md",
        "epics_path: plan/epics.md",
        "bootstrapped_epics: [1]",
        "manifests: {dir: stories}",
      ].join("\n"),
      ".xarabot/epics.yaml": "version: 1\nepics:\n  3: {depends_on: [1], checkpoint: true}\n",
      "stories/2.1.md": '---\nstory_id: "2.1"\nepic: 2\nsprint_key: k\ntitle: T\nglobs: [src/**]\n---\n',
    });
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(r.stdout.trimEnd().split("\n").slice(1)).toEqual(["1 → []", "2 → [1] stories: 2.1", "3 → [1] checkpoint"]);
    expect(r.stderr).toBe("");
  });

  test.each([
    ["a cycle", { [MD]: THREE, ".xarabot/epics.yaml": "version: 1\nepics:\n  2: {depends_on: [3]}\n  3: {depends_on: [2]}\n" }, "cycle among Epics 2 → 3 → 2"],
    ["an invalid config", { [MD]: THREE, ".xarabot/config.yaml": "schema_version: 1\n" }, ".xarabot/config.yaml: "],
    ["no epics.md", { "README.md": "x" }, `${MD}: missing`],
  ])("%s: stderr names it, exit 1", (_name, files, fragment) => {
    const r = run(fixture(files));
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr.startsWith("xarabot graph check: ")).toBe(true);
    expect(r.stderr).toContain(fragment);
  });

  test("epic_packages adds the package edge", () => {
    const dir = fixture({
      [MD]: THREE,
      ".xarabot/config.yaml": [...CONFIG_HEAD, 'epic_packages: {"1": [a], "3": [b]}'].join("\n"),
      ".xarabot/epics.yaml": "version: 1\nepics:\n  3: {depends_on: []}\n",
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      "packages/a/package.json": JSON.stringify({ name: "a" }),
      "packages/b/package.json": JSON.stringify({ name: "b", dependencies: { a: "workspace:*" } }),
    });
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(r.stdout.trimEnd().split("\n").slice(1)).toEqual(["1 → []", "2 → [1]", "3 → [1]"]);
  });

  test("an invalid file at a custom retro_gates_path: exit 1 naming it", () => {
    const dir = fixture({
      [MD]: THREE,
      ".xarabot/config.yaml": [...CONFIG_HEAD, "retro_gates_path: gates/retro.yaml"].join("\n"),
      "gates/retro.yaml": "schema_version: 1\nepics: []\n",
    });
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toStartWith("xarabot graph check: gates/retro.yaml: ");
  });

  test("a tracked epics.yaml deleted from disk is absent: serial graph", () => {
    const dir = fixture({ [MD]: THREE, ".xarabot/epics.yaml": "version: 1\nepics:\n  3: {depends_on: [1]}\n" });
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "fixture"]);
    rmSync(join(dir, ".xarabot/epics.yaml"));
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(r.stdout.trimEnd().split("\n").slice(1)).toEqual(["1 → []", "2 → [1]", "3 → [2]"]);
  });

  test("outside a git repo: exit 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "xarabot-nogit-"));
    dirs.push(dir);
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toStartWith("xarabot graph check: git rev-parse");
  });

  test("this repo: its epics.yaml graph and a warning per unmanifested Story heading", async () => {
    const r = run(ROOT);
    expect(r.code).toBe(0);
    // The edges only: an Epic with manifests also lists its Stories after them.
    const edges = r.stdout.trimEnd().split("\n").slice(1).map((l) => l.replace(/ stories: .*$/, ""));
    expect(edges).toEqual([
      "1 → []",
      "2 → [1]",
      "3 → [2]",
      "4 → [3]",
      "5 → [4]",
      "6 → [4]",
      "7 → [5, 6]",
    ]);
    // Every Story heading warns unless its Epic is bootstrapped or it has a manifest.
    const md = await Bun.file(join(ROOT, MD)).text();
    const configPath = join(ROOT, ".xarabot/config.yaml");
    const config = existsSync(configPath) ? (Bun.YAML.parse(readFileSync(configPath, "utf8")) as RepoConfig) : {};
    const bootstrapped = new Set(config.bootstrapped_epics ?? []);
    const manifestDir = join(ROOT, config.manifests?.dir ?? "stories");
    const manifested = new Set(
      existsSync(manifestDir)
        ? readdirSync(manifestDir)
            .filter((f) => f.endsWith(".md"))
            .map((f) => /^story_id: "?([^"\n]+)"?$/m.exec(readFileSync(join(manifestDir, f), "utf8"))?.[1])
        : [],
    );
    const expected = [...md.matchAll(/^### Story ((\d+)\.\d+[a-z]?):/gm)].filter(
      (m) => !bootstrapped.has(Number(m[2])) && !manifested.has(m[1]),
    ).length;
    const warnings = r.stderr.trimEnd().split("\n").filter((l) => /^warning: Story \S+ \(.+:\d+\) has no manifest$/.test(l));
    expect(warnings.length).toBe(expected);
  });
});

describe("graph check's git calls (decision 33)", () => {
  const realGit = Bun.which("git") ?? "/usr/bin/git";

  /** A dir holding a `git` stub with `body`, for the front of `PATH`. */
  function stubGit(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "xarabot-gitstub-"));
    dirs.push(dir);
    const path = join(dir, "git");
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return dir;
  }

  /** `graphCheck` in process, with console output captured. */
  function inProcess(cwd: string, opts: Parameters<typeof graphCheck>[1]): { code: number; stdout: string; stderr: string } {
    const out: string[] = [];
    const err: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    const error = spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
    try {
      return { code: graphCheck(cwd, opts), stdout: out.join("\n"), stderr: err.join("\n") };
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  }

  test("a git call that runs past its deadline fails with exit 1, naming the call and the deadline", () => {
    const bin = stubGit("sleep 5");
    const dir = fixture({ [MD]: THREE });
    const started = Date.now();
    const r = inProcess(dir, { gitTimeoutMs: 200, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` } });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("xarabot graph check: git rev-parse: ran past 200 ms");
  });

  test("every git call runs with GIT_TERMINAL_PROMPT=0", () => {
    const bin = stubGit(`[ "$GIT_TERMINAL_PROMPT" = 0 ] || exit 3\nexec ${JSON.stringify(realGit)} "$@"`);
    const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` };
    delete env["GIT_TERMINAL_PROMPT"];
    const r = inProcess(fixture({ [MD]: THREE }), { env });
    expect(r.stderr).not.toContain("xarabot graph check:");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^graph sha256:[0-9a-f]{64}\n/);
  });

  test("the stub refuses a call without GIT_TERMINAL_PROMPT=0, so the check above is real", () => {
    const bin = stubGit(`[ "$GIT_TERMINAL_PROMPT" = 0 ] || exit 3\nexec ${JSON.stringify(realGit)} "$@"`);
    const p = Bun.spawnSync(["git", "--version"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, GIT_TERMINAL_PROMPT: "1" } });
    expect(p.exitCode).toBe(3);
  });
});
