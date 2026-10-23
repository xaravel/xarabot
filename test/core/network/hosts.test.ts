import { describe, expect, test } from "bun:test";
import { buildAllowlist, GITHUB_DOMAINS, isGitHubHost, isIpLiteral, normalizeHost, PACKAGE_HOSTS } from "../../../src/core/network/hosts.ts";

describe("normalizeHost", () => {
  test.each([
    ["PyPI.Org", "pypi.org"],
    ["pypi.org.", "pypi.org"],
    ["pypi.org..", "pypi.org."],
    ["api.vendor.test", "api.vendor.test"],
  ])("%j -> %j", (input, out) => {
    expect(normalizeHost(input)).toBe(out);
  });
});

describe("isGitHubHost", () => {
  test.each([
    ...GITHUB_DOMAINS.map((d) => [d] as const),
    ...GITHUB_DOMAINS.map((d) => [`sub.${d}`] as const),
    ["api.github.com"],
    ["raw.githubusercontent.com"],
    ["objects.githubusercontent.com"],
    ["GitHub.COM."],
    ["ghcr.io"],
    ["pkg.ghcr.io"],
    ["acme.ghe.com"],
    ["gh.io"],
    ["git.io"],
    ["short.git.io"],
    ["mygithubmirror.example"],
    ["github-cloud.s3.amazonaws.com"],
    ["x.github.example.org"],
  ])("%j is a GitHub host", (host) => {
    expect(isGitHubHost(host)).toBe(true);
  });

  test.each([["pypi.org"], ["files.pythonhosted.org"], ["api.anthropic.com"], ["notghcr.io"], ["ghe.community"], ["agh.io"], ["digit.io"], ["gitlab.com"], ["hub.docker.com"]])("%j is not", (host) => {
    expect(isGitHubHost(host)).toBe(false);
  });
});

describe("isIpLiteral", () => {
  test.each([["140.82.112.3"], ["127.0.0.1"], ["::1"], ["[::1]"], ["fe80::1%en0"], ["2606:50c0::153"], ["10.1"], ["host.123"], ["0x7f000001"], ["a.0x7f"], ["1.2.3.4."]])("%j is an IP literal", (host) => {
    expect(isIpLiteral(host)).toBe(true);
  });

  test.each([["pypi.org"], ["1password.com"], ["api.v1.example"], ["123.example"], ["localhost"]])("%j is not", (host) => {
    expect(isIpLiteral(host)).toBe(false);
  });
});

describe("PACKAGE_HOSTS", () => {
  test("is pypi.org and files.pythonhosted.org", () => {
    expect(PACKAGE_HOSTS).toEqual(["pypi.org", "files.pythonhosted.org"]);
  });
});

describe("buildAllowlist", () => {
  test("vendor hosts, package hosts and repo hosts, normalized and deduplicated", () => {
    expect(buildAllowlist(["API.vendor.test.", "api.vendor.test"], ["mirror.example", "PyPI.org"])).toEqual({
      ok: true,
      value: ["api.vendor.test", "pypi.org", "files.pythonhosted.org", "mirror.example"],
    });
  });

  test("with no vendor or repo hosts, just the package hosts", () => {
    expect(buildAllowlist([], [])).toEqual({ ok: true, value: ["pypi.org", "files.pythonhosted.org"] });
  });

  test.each([
    ["a GitHub host", "github.com", "GitHub host"],
    ["a GitHub subdomain", "api.github.com", "GitHub host"],
    ["a githubusercontent host", "objects.githubusercontent.com", "GitHub host"],
    ["ghcr.io", "ghcr.io", "GitHub host"],
    ["a label containing github", "mygithubmirror.example", "GitHub host"],
    ["an IPv4 literal", "140.82.112.3", "IP literal"],
    ["an IPv6 literal", "::1", "IP literal"],
    ["a bracketed IPv6 literal", "[::1]", "IP literal"],
    ["a numeric last label", "host.123", "IP literal"],
    ["localhost", "localhost", "localhost"],
    ["a .localhost host", "app.localhost", "localhost"],
    ["a wildcard", "*.example.com", "not a hostname"],
    ["a URL", "https://pypi.org", "not a hostname"],
    ["a host with a port", "pypi.org:443", "not a hostname"],
    ["an empty string", "", "not a hostname"],
    ["a label with an underscore", "a_b.example", "not a hostname"],
    ["a leading hyphen", "-a.example", "not a hostname"],
    ["an over-long label", `${"a".repeat(64)}.example`, "not a hostname"],
  ])("refuses %s in either list, naming it", (_name, host, why) => {
    for (const r of [buildAllowlist([host], []), buildAllowlist([], [host])]) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe("invalid");
        expect(r.error.message).toContain(JSON.stringify(host));
        expect(r.error.message).toContain(why);
      }
    }
  });

  test("a GitHub refusal says a GitHub host is never allowed", () => {
    const r = buildAllowlist(["api.github.com"], []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("a GitHub host is never allowed");
  });
});
