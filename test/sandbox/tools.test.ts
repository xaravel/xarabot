import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathLoose, within } from "../../src/sandbox/macos.ts";
import { resolveTools, uvPythonDir, which } from "../../src/sandbox/tools.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "xarabot-tools-")));
  dirs.push(d);
  return d;
}

function executable(path: string): string {
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

describe("uvPythonDir", () => {
  test.each<[string, Record<string, string | undefined>, string | null]>([
    ["UV_PYTHON_INSTALL_DIR wins", { UV_PYTHON_INSTALL_DIR: "/u", XDG_DATA_HOME: "/d", HOME: "/h" }, "/u"],
    ["then XDG_DATA_HOME", { XDG_DATA_HOME: "/d", HOME: "/h" }, "/d/uv/python"],
    ["then ~/.local/share", { HOME: "/h" }, "/h/.local/share/uv/python"],
    ["an empty UV_PYTHON_INSTALL_DIR falls through", { UV_PYTHON_INSTALL_DIR: "", XDG_DATA_HOME: "/d", HOME: "/h" }, "/d/uv/python"],
    ["an empty XDG_DATA_HOME falls through", { XDG_DATA_HOME: "", HOME: "/h" }, "/h/.local/share/uv/python"],
    ["an empty HOME gives none", { HOME: "" }, null],
    ["nothing set gives none", {}, null],
  ])("%s", (_name, env, expected) => {
    expect(uvPythonDir(env)).toBe(expected);
  });
});

describe("which", () => {
  test("finds an executable and resolves its symlink", () => {
    const d = tempDir();
    mkdirSync(join(d, "real"));
    mkdirSync(join(d, "bin"));
    const target = executable(join(d, "real", "2.1.0"));
    symlinkSync(target, join(d, "bin", "tool"));
    expect(which("tool", `/nonexistent:${join(d, "bin")}`)).toBe(target);
  });

  test("skips relative PATH entries", () => {
    const d = tempDir();
    executable(join(d, "tool"));
    expect(which("tool", "relative/dir:.")).toBeNull();
  });

  test("skips non-executable files and directories", () => {
    const d = tempDir();
    writeFileSync(join(d, "plain"), "x");
    mkdirSync(join(d, "dir"));
    expect(which("plain", d)).toBeNull();
    expect(which("dir", d)).toBeNull();
  });

  test.each(["", "a/b", "/bin/sh"])("refuses the name %j", (name) => {
    expect(which(name, "/bin:/usr/bin")).toBeNull();
  });

  test("takes the first match on PATH", () => {
    const a = tempDir();
    const b = tempDir();
    const first = executable(join(a, "tool"));
    executable(join(b, "tool"));
    expect(which("tool", `${a}:${b}`)).toBe(first);
  });
});

describe("resolveTools", () => {
  test("refuses a missing agent CLI", async () => {
    const r = await resolveTools({ PATH: "/nonexistent", HOME: "/h" }, "xarabot-no-cli");
    expect(r.ok).toBe(false);
  });

  test.skipIf(which("git", process.env.PATH) === null)("puts git's real --exec-path in dirs", async () => {
    const r = await resolveTools({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, "sh");
    if (!r.ok) throw new Error(r.error.message);
    const git = r.value.helpers.find((t) => t.name === "git");
    expect(git).toBeDefined();
    const run = Bun.spawnSync([git?.path ?? "git", "--exec-path"]);
    const execPath = realpathSync(run.stdout.toString().trim());
    expect(r.value.dirs).toContain(execPath);
    // /usr/bin/git is the xcrun shim on macOS only; elsewhere it is the real git.
    if (process.platform === "darwin") expect(git?.path).not.toBe("/usr/bin/git");
  });
});

describe("within", () => {
  test.each<[string, string, boolean]>([
    ["/a/b", "/a/b", true],
    ["/a/b/c", "/a/b", true],
    ["/a/bc", "/a/b", false],
    ["/a", "/a/b", false],
    ["/anything", "/", true],
  ])("within(%j, %j) is %p", (inner, outer, expected) => {
    expect(within(inner, outer)).toBe(expected);
  });
});

describe("realpathLoose", () => {
  // /tmp is a symlink to /private/tmp on macOS only.
  test.skipIf(process.platform !== "darwin")("resolves the existing prefix and keeps a missing tail", () => {
    expect(realpathLoose("/tmp/xarabot-no-such/dir/file")).toBe("/private/tmp/xarabot-no-such/dir/file");
  });

  test.skipIf(process.platform !== "darwin")("resolves an existing path fully", () => {
    expect(realpathLoose("/tmp")).toBe("/private/tmp");
  });
});
