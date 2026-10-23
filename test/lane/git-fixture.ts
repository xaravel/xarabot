import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openRunnerGit, runGit } from "../../src/adapters/forge/github/runner-git.ts";

/** Temp `runner.git`s and clones for the lane git tests, against real git. */

export const IDENTITY = { name: "t", email: "t@xarabot.invalid" };
export const BOT = { name: "edanisko-xarabot[bot]", email: "123+edanisko-xarabot[bot]@users.noreply.github.com" };
export const UNIT = "story:1.15";
export const BRANCH = "story/1.15";

export const live = (): { signal: AbortSignal } => ({ signal: AbortSignal.timeout(30_000) });

const dirs: string[] = [];
/** Removes every temp folder made so far; call from `afterEach`. */
export function cleanup(): void {
  for (const d of dirs.splice(0)) {
    Bun.spawnSync(["chmod", "-R", "u+rwx", d]);
    rmSync(d, { recursive: true, force: true });
  }
}

export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "xarabot-clone-"));
  dirs.push(d);
  return d;
}

export function value<T>(r: { ok: true; value: T } | { ok: false; error: { kind: string; message: string } }): T {
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.value;
}

/** Hardened git in `runner.git` that must exit 0; its trimmed stdout. */
export async function rg(gitDir: string, args: readonly string[], opts: { stdin?: string; identity?: typeof IDENTITY } = {}): Promise<string> {
  const r = value(await runGit(gitDir, args, { ...live(), ...opts }));
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} exited ${r.code}: ${r.stderr}`);
  return r.stdout.trim();
}

export type Repo = { readonly root: string; readonly gitDir: string; readonly clone: string };

export async function setup(): Promise<Repo> {
  const root = tempDir();
  const gitDir = value(await openRunnerGit(join(root, "lane"), live()));
  return { root, gitDir, clone: join(root, "work", "clone") };
}

/** A commit in `runner.git` whose tree is exactly `files`. */
export async function commit(gitDir: string, files: Record<string, string>, parents: readonly string[] = [], message = "c"): Promise<string> {
  const work = tempDir();
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  }
  const indexFile = join(tempDir(), "index");
  value(await runGit(gitDir, ["add", "-A", "-f"], { ...live(), workTree: work, indexFile }));
  const tree = value(await runGit(gitDir, ["write-tree"], { ...live(), indexFile })).stdout.trim();
  return rg(gitDir, ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p])], { identity: IDENTITY, stdin: `${message}\n` });
}

/** `path -> content` of a commit's tree. */
export async function files(gitDir: string, rev: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const names = (await rg(gitDir, ["ls-tree", "-r", "--name-only", "-z", rev])).split("\0").filter((n) => n !== "");
  for (const n of names) out[n] = await rg(gitDir, ["cat-file", "blob", `${rev}:${n}`]);
  return out;
}

/** Plain, unhardened git against the clone (test checks only; never the runner's way). */
export function plainClone(clone: string, args: readonly string[]): { code: number; stdout: string } {
  const p = Bun.spawnSync(["git", `--git-dir=${join(clone, ".git")}`, `--work-tree=${clone}`, ...args], {
    cwd: clone,
    env: { PATH: process.env.PATH ?? "", HOME: clone, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  return { code: p.exitCode, stdout: p.stdout.toString() };
}
