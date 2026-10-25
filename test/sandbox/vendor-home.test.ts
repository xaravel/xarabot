import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialPath, readCredential, seedVendorHome } from "../../src/sandbox/vendor-home.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(join(d, "config", "xarabot", "vendors", "claude", "oauth-token"), 0o600);
    } catch {
      // Not there.
    }
    rmSync(d, { recursive: true, force: true });
  }
});

function setup(content: string | null = "tok-123\n", mode = 0o600): { root: string; launching: Record<string, string>; file: string; vendorHome: string } {
  const root = mkdtempSync(join(tmpdir(), "xarabot-vendor-"));
  dirs.push(root);
  const folder = join(root, "config", "xarabot", "vendors", "claude");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "oauth-token");
  if (content !== null) {
    writeFileSync(file, content);
    chmodSync(file, mode);
  }
  return { root, launching: { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config") }, file, vendorHome: join(root, "vendor") };
}

describe("credentialPath", () => {
  test("is <config>/xarabot/vendors/<vendor>/<file>", () => {
    expect(credentialPath({ HOME: "/h" }, "codex", "auth.json")).toEqual({ ok: true, value: "/h/.config/xarabot/vendors/codex/auth.json" });
    expect(credentialPath({ HOME: "/h", XDG_CONFIG_HOME: "/x" }, "pi", "key")).toEqual({ ok: true, value: "/x/xarabot/vendors/pi/key" });
  });

  test.each(["", ".", "..", "a/b", "../x"])("refuses the file name %j", (file) => {
    expect(credentialPath({ HOME: "/h" }, "claude", file).ok).toBe(false);
  });

  test("refuses without HOME or XDG_CONFIG_HOME", () => {
    expect(credentialPath({}, "claude", "x").ok).toBe(false);
  });
});

describe("readCredential", () => {
  test("reads a mode-600 file", () => {
    const s = setup();
    expect(readCredential(s.file)).toEqual({ ok: true, value: "tok-123\n" });
  });

  test.each<[string, string | null, number]>([
    ["missing", null, 0o600],
    ["mode 000", "s3cret", 0o000],
    ["mode 644", "s3cret", 0o644],
    ["mode 640", "s3cret", 0o640],
    ["mode 400", "s3cret", 0o400],
    ["empty", "", 0o600],
    ["whitespace only", " \n", 0o600],
  ])("refuses a %s file, naming it", (_name, content, mode) => {
    const s = setup(content, mode);
    const r = readCredential(s.file);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("refused");
      expect(r.error.message).toContain(s.file);
      expect(r.error.message).not.toContain("s3cret");
    }
  });

  test("refuses a symlink and a directory", () => {
    const s = setup();
    const link = join(s.root, "link");
    symlinkSync(s.file, link);
    expect(readCredential(link).ok).toBe(false);
    expect(readCredential(s.root).ok).toBe(false);
  });
});

describe("seedVendorHome", () => {
  test("env mode: empties the home and returns the trimmed credential", () => {
    const s = setup();
    mkdirSync(join(s.vendorHome, "old", "deep"), { recursive: true });
    writeFileSync(join(s.vendorHome, "left-over.json"), "{}");
    writeFileSync(join(s.vendorHome, ".hidden"), "x");
    const r = seedVendorHome({ launching: s.launching, vendor: "claude", credential: { file: "oauth-token", env: "CLAUDE_CODE_OAUTH_TOKEN" }, vendorHome: s.vendorHome });
    expect(r).toEqual({ ok: true, value: { env: { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "tok-123" } } });
    expect(readdirSync(s.vendorHome)).toEqual([]);
  });

  test("homeFile mode: the home holds only that file, mode 600, with the credential", () => {
    const s = setup();
    mkdirSync(s.vendorHome);
    writeFileSync(join(s.vendorHome, "stale"), "x");
    const r = seedVendorHome({ launching: s.launching, vendor: "claude", credential: { file: "oauth-token", homeFile: ".credentials.json" }, vendorHome: s.vendorHome });
    expect(r).toEqual({ ok: true, value: {} });
    expect(readdirSync(s.vendorHome)).toEqual([".credentials.json"]);
    const target = join(s.vendorHome, ".credentials.json");
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, "utf8")).toBe("tok-123\n");
  });

  test("creates a missing vendor home", () => {
    const s = setup();
    const r = seedVendorHome({ launching: s.launching, vendor: "claude", credential: { file: "oauth-token", env: "T" }, vendorHome: s.vendorHome });
    expect(r.ok).toBe(true);
    expect(existsSync(s.vendorHome)).toBe(true);
  });

  test("a bad credential refuses and leaves the vendor home untouched", () => {
    const s = setup("tok", 0o644);
    mkdirSync(s.vendorHome);
    writeFileSync(join(s.vendorHome, "keep"), "x");
    const r = seedVendorHome({ launching: s.launching, vendor: "claude", credential: { file: "oauth-token", env: "T" }, vendorHome: s.vendorHome });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain(s.file);
    expect(readdirSync(s.vendorHome)).toEqual(["keep"]);
  });

  test("keep (a resume): env mode leaves the home's contents and still returns the credential", () => {
    const s = setup();
    mkdirSync(join(s.vendorHome, "projects"), { recursive: true });
    writeFileSync(join(s.vendorHome, "projects", "session.jsonl"), "{}");
    const r = seedVendorHome({ launching: s.launching, vendor: "claude", credential: { file: "oauth-token", env: "T" }, vendorHome: s.vendorHome, keep: true });
    expect(r).toEqual({ ok: true, value: { env: { name: "T", value: "tok-123" } } });
    expect(readdirSync(s.vendorHome)).toEqual(["projects"]);
  });

  test("keep (a resume): homeFile mode rewrites the credential file and keeps the rest", () => {
    const s = setup();
    mkdirSync(s.vendorHome);
    writeFileSync(join(s.vendorHome, "transcript"), "t");
    writeFileSync(join(s.vendorHome, ".credentials.json"), "tampered", { mode: 0o644 });
    const r = seedVendorHome({ launching: s.launching, vendor: "claude", credential: { file: "oauth-token", homeFile: ".credentials.json" }, vendorHome: s.vendorHome, keep: true });
    expect(r).toEqual({ ok: true, value: {} });
    expect(readdirSync(s.vendorHome).sort()).toEqual([".credentials.json", "transcript"]);
    const target = join(s.vendorHome, ".credentials.json");
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, "utf8")).toBe("tok-123\n");
  });

  test("keep (a resume): a bad credential still refuses", () => {
    const s = setup("tok", 0o644);
    expect(seedVendorHome({ launching: s.launching, vendor: "claude", credential: { file: "oauth-token", env: "T" }, vendorHome: s.vendorHome, keep: true }).ok).toBe(false);
  });

  test("no credential: empties the home, writes nothing and returns {}", () => {
    const s = setup();
    mkdirSync(join(s.vendorHome, "old", "deep"), { recursive: true });
    writeFileSync(join(s.vendorHome, ".credentials.json"), "stale");
    const r = seedVendorHome({ launching: s.launching, vendor: "claude", vendorHome: s.vendorHome });
    expect(r).toEqual({ ok: true, value: {} });
    expect(readdirSync(s.vendorHome)).toEqual([]);
  });

  test.each<[string, string | null, number]>([
    ["missing", null, 0o600],
    ["mode 644", "tok", 0o644],
    ["empty", "", 0o600],
  ])("no credential: a %s credential file is never read, so no error", (_name, content, mode) => {
    const s = setup(content, mode);
    expect(seedVendorHome({ launching: s.launching, vendor: "claude", vendorHome: s.vendorHome })).toEqual({ ok: true, value: {} });
    expect(readdirSync(s.vendorHome)).toEqual([]);
  });

  test("no credential: needs no config folder, and creates a missing vendor home", () => {
    const s = setup(null);
    expect(seedVendorHome({ launching: {}, vendor: "claude", vendorHome: s.vendorHome })).toEqual({ ok: true, value: {} });
    expect(readdirSync(s.vendorHome)).toEqual([]);
  });

  test("no credential, keep (a resume): the home's contents stay and nothing is written", () => {
    const s = setup(null);
    mkdirSync(join(s.vendorHome, "projects"), { recursive: true });
    writeFileSync(join(s.vendorHome, "projects", "session.jsonl"), "{}");
    const r = seedVendorHome({ launching: s.launching, vendor: "claude", vendorHome: s.vendorHome, keep: true });
    expect(r).toEqual({ ok: true, value: {} });
    expect(readdirSync(s.vendorHome)).toEqual(["projects"]);
    expect(readFileSync(join(s.vendorHome, "projects", "session.jsonl"), "utf8")).toBe("{}");
  });

  test.each(["", "..", "a/b"])("refuses the home file name %j", (homeFile) => {
    const s = setup();
    expect(seedVendorHome({ launching: s.launching, vendor: "claude", credential: { file: "oauth-token", homeFile }, vendorHome: s.vendorHome }).ok).toBe(false);
  });
});
