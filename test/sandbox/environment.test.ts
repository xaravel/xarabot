import { describe, expect, test } from "bun:test";
import { buildSessionEnv, configDir, deniedPaths, isReservedEnvName, type SessionEnvParts } from "../../src/sandbox/environment.ts";

const PARTS: SessionEnvParts = {
  tempDir: "/l/tmp",
  vendorHome: "/l/vendor",
  vendorHomeEnv: "CLAUDE_CONFIG_DIR",
  resultPath: "/l/tmp/result.json",
};

const LAUNCHING = {
  PATH: "/Users/u/.local/bin:/usr/bin",
  HOME: "/Users/u",
  GH_TOKEN: "ghs_x",
  GITHUB_TOKEN: "ghs_y",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  FOO: "bar",
  LANG: "en_US.UTF-8",
  LC_ALL: "C",
  LC_CTYPE: "UTF-8",
  TERM: "xterm",
  HTTPS_PROXY: "http://evil:1",
  http_proxy: "http://evil:2",
  XARABOT_SANDBOXED: "0",
};

function build(launching: Record<string, string | undefined> = LAUNCHING, parts: SessionEnvParts = PARTS): Record<string, string> {
  const r = buildSessionEnv(launching, parts);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("buildSessionEnv", () => {
  test("is exactly the allowlist", () => {
    expect(build()).toEqual({
      PATH: "/l/tmp/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: "/l/tmp/home",
      TMPDIR: "/l/tmp",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      LC_CTYPE: "UTF-8",
      TERM: "xterm",
      CLAUDE_CONFIG_DIR: "/l/vendor",
      XARABOT_RESULT: "/l/tmp/result.json",
      XARABOT_SANDBOXED: "1",
      UV_CACHE_DIR: "/l/tmp/uv-cache",
    });
  });

  test("LANG, LC_* and TERM are left out when the launching env lacks them", () => {
    const env = build({ HOME: "/Users/u" });
    expect(Object.keys(env).sort()).toEqual(
      ["PATH", "HOME", "TMPDIR", "CLAUDE_CONFIG_DIR", "XARABOT_RESULT", "XARABOT_SANDBOXED", "UV_CACHE_DIR"].sort(),
    );
  });

  test("the env-mode credential becomes its variable", () => {
    const env = build(LAUNCHING, { ...PARTS, credential: { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "tok" } });
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("tok");
  });

  test("proxy variables come only from proxyUrl", () => {
    const env = build(LAUNCHING, { ...PARTS, proxyUrl: "http://127.0.0.1:9" });
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) expect(env[name]).toBe("http://127.0.0.1:9");
    expect(Object.keys(build()).filter((k) => /proxy/i.test(k))).toEqual([]);
  });

  test("never carries GH_*, GITHUB_* or SSH_AUTH_SOCK", () => {
    const keys = Object.keys(build());
    expect(keys.filter((k) => k.startsWith("GH_") || k.startsWith("GITHUB_") || k === "SSH_AUTH_SOCK")).toEqual([]);
  });

  test.each([
    ["an invalid vendor home name", { ...PARTS, vendorHomeEnv: "claude-dir" }],
    ["a reserved vendor home name", { ...PARTS, vendorHomeEnv: "HOME" }],
    ["a GH_ credential name", { ...PARTS, credential: { name: "GH_TOKEN", value: "x" } }],
    ["a GITHUB_ credential name", { ...PARTS, credential: { name: "GITHUB_TOKEN", value: "x" } }],
    ["a credential named like the vendor home", { ...PARTS, credential: { name: "CLAUDE_CONFIG_DIR", value: "x" } }],
  ])("refuses %s", (_name, parts) => {
    expect(buildSessionEnv(LAUNCHING, parts).ok).toBe(false);
  });
});

describe("isReservedEnvName", () => {
  test.each(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "UV_CACHE_DIR", "XARABOT_RESULT", "GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "HTTPS_PROXY", "http_proxy"])(
    "%s is reserved",
    (name) => expect(isReservedEnvName(name)).toBe(true),
  );

  test.each(["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_HOME"])("%s is free", (name) => {
    expect(isReservedEnvName(name)).toBe(false);
  });
});

describe("configDir", () => {
  test("prefers a non-empty XDG_CONFIG_HOME", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/x", HOME: "/h" })).toBe("/x");
  });

  test.each([undefined, ""])("falls back to ~/.config when XDG_CONFIG_HOME is %p", (xdg) => {
    expect(configDir({ XDG_CONFIG_HOME: xdg, HOME: "/h" })).toBe("/h/.config");
  });

  test("is null with neither", () => {
    expect(configDir({})).toBeNull();
  });
});

describe("deniedPaths", () => {
  test("lists runner.git first, then the credential and vendor folders", () => {
    const r = deniedPaths({ HOME: "/h" }, "/h/.xarabot/l/runner.git");
    expect(r).toEqual({
      ok: true,
      value: {
        xarabotHome: "/h/.xarabot",
        always: [
          "/h/.xarabot/l/runner.git",
          "/h/.config/xarabot",
          "/h/.config/gh",
          "/h/.ssh",
          "/h/Library/Keychains",
          "/h/.git-credentials",
          "/h/.netrc",
          "/h/.claude",
          "/h/.codex",
          "/h/.pi",
        ],
      },
    });
  });

  test("uses XDG_CONFIG_HOME for xarabot and also denies its gh folder", () => {
    const r = deniedPaths({ HOME: "/h", XDG_CONFIG_HOME: "/x" }, "/r.git");
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.always).toContain("/x/xarabot");
    expect(r.value.always).toContain("/x/gh");
    expect(r.value.always).toContain("/h/.config/gh");
    expect(r.value.always).not.toContain("/h/.config/xarabot");
  });

  test("refuses without HOME", () => {
    expect(deniedPaths({}, "/r.git").ok).toBe(false);
  });
});
