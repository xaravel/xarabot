import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { laneLabel, PLIST_ENV, plistEnv, renderLauncher, renderPlist, shQuote, THROTTLE_INTERVAL_S, xmlEscape } from "../../../src/core/lane/launchd.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures", "launchd");
const golden = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const PLIST = {
  label: "com.xarabot.lane.xaravel__xarabot.builder-1",
  launcher: "/Users/edanisko-xarabot/.xarabot/bin/xarabot-lane",
  repo: "xaravel/xarabot",
  lane: "builder-1",
  user: "edanisko-xarabot",
  home: "/Users/edanisko-xarabot",
  env: {
    PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    HOME: "/Users/edanisko-xarabot",
    LANG: "en_US.UTF-8",
    XDG_CONFIG_HOME: "/Users/edanisko-xarabot/.config",
    XARABOT_MAX_BUILDERS: "1",
    XARABOT_SANDBOXED: "1",
    GITHUB_TOKEN: "ghs_secret",
    TERM: "xterm",
  },
  log: "/Users/edanisko-xarabot/.xarabot/repos/xaravel__xarabot/lanes/builder-1/launchd.log",
};

describe("laneLabel", () => {
  test.each([
    ["xaravel/xarabot", "builder-1", "com.xarabot.lane.xaravel__xarabot.builder-1"],
    ["acme/widgets.js", "b", "com.xarabot.lane.acme__widgets.js.b"],
  ])("%s %s", (repo, lane, want) => {
    expect(laneLabel(repo, lane)).toBe(want);
  });
});

describe("renderLauncher", () => {
  test("matches the golden file", () => {
    expect(renderLauncher({ bun: "/opt/homebrew/bin/bun" })).toBe(golden("xarabot-lane"));
  });

  test("quotes the bun path for sh", () => {
    expect(renderLauncher({ bun: "/odd path/it's/bun" })).toContain(`exec '/odd path/it'\\''s/bun' "$main" lane run "$repo" "$lane"\n`);
    expect(shQuote("a'b")).toBe(`'a'\\''b'`);
  });

  test("unsets XARABOT_SANDBOXED before the exec and never sets it", () => {
    const text = renderLauncher({ bun: "/b" });
    expect(text.indexOf("unset XARABOT_SANDBOXED")).toBeLessThan(text.indexOf("exec "));
    expect(text).not.toMatch(/XARABOT_SANDBOXED=/);
  });
});

describe("renderPlist", () => {
  test("matches the golden file", () => {
    expect(renderPlist(PLIST)).toBe(golden("com.xarabot.lane.xaravel__xarabot.builder-1.plist"));
  });

  test("carries only the allowlist, never XARABOT_SANDBOXED", () => {
    const text = renderPlist(PLIST);
    expect(text).not.toContain("XARABOT_SANDBOXED");
    expect(text).not.toContain("GITHUB_TOKEN");
    expect(text).not.toContain("TERM");
    expect(PLIST_ENV).not.toContain("XARABOT_SANDBOXED");
  });

  test("an unset or empty variable is left out", () => {
    expect(plistEnv({ HOME: "/h", PATH: "", LANG: undefined })).toEqual({ HOME: "/h" });
  });

  test("XML-escapes every string", () => {
    const text = renderPlist({ ...PLIST, user: "a&b", home: "/h<1>", env: { HOME: `"q'` }, log: "/l&" });
    expect(text).toContain("<string>a&amp;b</string>");
    expect(text).toContain("<string>/h&lt;1&gt;</string>");
    expect(text).toContain("<string>&quot;q&apos;</string>");
    expect(text).toContain("<string>/l&amp;</string>");
    expect(xmlEscape(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
  });

  test("throttles restarts by 60 s", () => {
    expect(THROTTLE_INTERVAL_S).toBe(60);
  });
});
