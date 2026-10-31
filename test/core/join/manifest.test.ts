import { describe, expect, test } from "bun:test";
import { APP_PERMISSIONS } from "../../../src/adapters/forge/github/http.ts";
import {
  appInstallUrl,
  appName,
  appPermissionsUrl,
  appSettingsUrl,
  buildManifest,
  comparePermissions,
  MANIFEST_PERMISSIONS,
  manifestPageUrl,
} from "../../../src/core/join/manifest.ts";

const EXACT: Record<string, string> = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  checks: "read",
  statuses: "read",
  actions: "read",
  metadata: "read",
};

describe("MANIFEST_PERMISSIONS", () => {
  test("is exactly the seven permissions Xarabot uses", () => {
    const actual: Record<string, string> = { ...MANIFEST_PERMISSIONS };
    expect(actual).toEqual(EXACT);
    expect(Object.keys(MANIFEST_PERMISSIONS)).toEqual(Object.keys(EXACT));
  });

  test("equals the adapter's APP_PERMISSIONS as a set", () => {
    const fromManifest = Object.entries(MANIFEST_PERMISSIONS).map(([name, level]) => `${name}: ${level}`);
    expect([...fromManifest].sort()).toEqual([...APP_PERMISSIONS].sort());
  });

  test("has no merge-queue, administration, workflows or bypass permission", () => {
    for (const name of Object.keys(MANIFEST_PERMISSIONS)) {
      expect(name).not.toMatch(/merge|queue|administration|workflow|bypass/i);
    }
  });
});

describe("buildManifest", () => {
  const m = buildManifest({ login: "alice", redirectUrl: "http://127.0.0.1:5555/callback" });

  test("names <login>-xarabot", () => {
    expect(appName("alice")).toBe("alice-xarabot");
    expect(m.name).toBe("alice-xarabot");
  });

  test("is public, with an inactive webhook and no OAuth on install", () => {
    expect(m.public).toBe(true);
    expect(m.hook_attributes.active).toBe(false);
    expect(m.request_oauth_on_install).toBe(false);
    expect(m.redirect_url).toBe("http://127.0.0.1:5555/callback");
  });

  test("asks for exactly the manifest permissions", () => {
    expect(m.default_permissions).toEqual(EXACT);
  });

  test("has exactly the manifest's keys", () => {
    expect(Object.keys(m).sort()).toEqual(
      ["default_permissions", "description", "hook_attributes", "name", "public", "redirect_url", "request_oauth_on_install", "url"].sort(),
    );
  });

  test("is pure: a fresh permissions object each time", () => {
    const a = buildManifest({ login: "bob", redirectUrl: "http://127.0.0.1:1/callback" });
    expect(a.default_permissions).not.toBe(MANIFEST_PERMISSIONS);
    expect(a).toEqual(buildManifest({ login: "bob", redirectUrl: "http://127.0.0.1:1/callback" }));
  });
});

describe("URLs", () => {
  test("manifest page, settings, permissions and install", () => {
    expect(manifestPageUrl("abc-123")).toBe("https://github.com/settings/apps/new?state=abc-123");
    expect(appSettingsUrl("alice-xarabot")).toBe("https://github.com/settings/apps/alice-xarabot");
    expect(appPermissionsUrl("alice-xarabot")).toBe("https://github.com/settings/apps/alice-xarabot/permissions");
    expect(appInstallUrl("alice-xarabot")).toBe("https://github.com/apps/alice-xarabot/installations/new");
  });
});

describe("comparePermissions", () => {
  test("exact: nothing to change", () => {
    expect(comparePermissions(EXACT)).toEqual([]);
  });

  test("missing: add", () => {
    const { issues: _issues, ...rest } = EXACT;
    expect(comparePermissions(rest)).toEqual(["add issues: write"]);
  });

  test("extra: remove", () => {
    expect(comparePermissions({ ...EXACT, administration: "read" })).toEqual(["remove administration: read"]);
    expect(comparePermissions({ ...EXACT, workflows: "write" })).toEqual(["remove workflows: write"]);
  });

  test("level: change", () => {
    expect(comparePermissions({ ...EXACT, checks: "write" })).toEqual(["change checks: write to checks: read"]);
  });

  test("orders adds, then removes by name, then changes", () => {
    const { issues: _i, contents: _c, ...rest } = EXACT;
    expect(comparePermissions({ ...rest, workflows: "write", administration: "read", checks: "write", pull_requests: "read" })).toEqual([
      "add contents: write",
      "add issues: write",
      "remove administration: read",
      "remove workflows: write",
      "change pull_requests: read to pull_requests: write",
      "change checks: write to checks: read",
    ]);
  });

  test("an empty App lacks all seven", () => {
    expect(comparePermissions({})).toEqual(Object.entries(EXACT).map(([n, l]) => `add ${n}: ${l}`));
  });
});
