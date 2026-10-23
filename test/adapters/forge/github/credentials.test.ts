import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appDir, loadAppCredentials } from "../../../../src/adapters/forge/github/credentials.ts";
import { testKeys } from "./fake-github.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "xarabot-creds-"));
  dirs.push(d);
  return d;
}

const PEM = (): string => testKeys().privateKey.export({ type: "pkcs8", format: "pem" }).toString();

/** Writes an App folder under `<config>/xarabot/apps/alice-xarabot`; returns it. */
function writeApp(config: string, opts: { pem?: string | null; mode?: number; app?: string | null } = {}): string {
  const dir = join(config, "xarabot", "apps", "alice-xarabot");
  mkdirSync(dir, { recursive: true });
  if (opts.pem !== null) {
    writeFileSync(join(dir, "private-key.pem"), opts.pem ?? PEM());
    chmodSync(join(dir, "private-key.pem"), opts.mode ?? 0o600);
  }
  if (opts.app !== null) writeFileSync(join(dir, "app.json"), opts.app ?? JSON.stringify({ id: 4242, slug: "alice-xarabot", owner: "alice" }));
  return dir;
}

describe("appDir", () => {
  test("uses a non-empty XDG_CONFIG_HOME", () => {
    expect(appDir({ login: "alice", env: { XDG_CONFIG_HOME: "/x", HOME: "/h" } })).toBe("/x/xarabot/apps/alice-xarabot");
  });

  test.each([undefined, ""])("falls back to $HOME/.config when XDG_CONFIG_HOME is %p", (xdg) => {
    expect(appDir({ login: "alice", env: { XDG_CONFIG_HOME: xdg, HOME: "/h" } })).toBe("/h/.config/xarabot/apps/alice-xarabot");
  });

  test("is null with neither set", () => {
    expect(appDir({ login: "alice", env: {} })).toBeNull();
  });
});

describe("loadAppCredentials", () => {
  test("loads the App record and key from XDG_CONFIG_HOME", async () => {
    const config = tempDir();
    writeApp(config);
    const r = await loadAppCredentials({ login: "alice", env: { XDG_CONFIG_HOME: config, HOME: "/nonexistent" } });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.app).toEqual({ id: 4242, slug: "alice-xarabot" });
    expect(r.value.key.type).toBe("private");
  });

  test("XDG fallback: XDG_CONFIG_HOME unset reads $HOME/.config/xarabot/apps/<login>-xarabot/", async () => {
    const home = tempDir();
    writeApp(join(home, ".config"));
    const r = await loadAppCredentials({ login: "alice", env: { HOME: home } });
    expect(r.ok).toBe(true);
  });

  test("key mode 644 is auth, naming the path and mode", async () => {
    const config = tempDir();
    const dir = writeApp(config, { mode: 0o644 });
    const r = await loadAppCredentials({ login: "alice", env: { XDG_CONFIG_HOME: config } });
    expect(r.ok ? "ok" : r.error.kind).toBe("auth");
    if (!r.ok) {
      expect(r.error.message).toContain(join(dir, "private-key.pem"));
      expect(r.error.message).toContain("644");
    }
  });

  test("no HOME or XDG_CONFIG_HOME is auth", async () => {
    const r = await loadAppCredentials({ login: "alice", env: {} });
    expect(r.ok ? "ok" : r.error.kind).toBe("auth");
  });

  const cases: readonly [string, (config: string) => string, string][] = [
    ["a missing key", (c) => writeApp(c, { pem: null }), "private-key.pem"],
    ["a missing app.json", (c) => writeApp(c, { app: null }), "app.json"],
    ["an unparsable key", (c) => writeApp(c, { pem: "-----BEGIN PRIVATE KEY-----\nU0VDUkVUIEtFWSBURVhU\n-----END PRIVATE KEY-----\n" }), "private-key.pem"],
    ["app.json that is not JSON", (c) => writeApp(c, { app: "{nope" }), "app.json"],
    ["app.json with id 0", (c) => writeApp(c, { app: JSON.stringify({ id: 0, slug: "s" }) }), "app.json"],
    ["app.json with an empty slug", (c) => writeApp(c, { app: JSON.stringify({ id: 1, slug: "" }) }), "app.json"],
    ["app.json with a string id", (c) => writeApp(c, { app: JSON.stringify({ id: "1", slug: "s" }) }), "app.json"],
  ];

  test.each(cases)("%s is auth naming the file, never the key", async (_label, setup, file) => {
    const config = tempDir();
    setup(config);
    const r = await loadAppCredentials({ login: "alice", env: { XDG_CONFIG_HOME: config } });
    expect(r.ok ? "ok" : r.error.kind).toBe("auth");
    if (!r.ok) {
      expect(r.error.message).toContain(join(config, "xarabot", "apps", "alice-xarabot", file));
      expect(r.error.message).not.toContain("BEGIN");
      expect(r.error.message).not.toContain("U0VDUkVUIEtFWSBURVhU");
      expect(r.error.message).not.toContain(PEM().split("\n")[1] as string);
    }
  });
});
