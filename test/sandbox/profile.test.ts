import { describe, expect, test } from "bun:test";
import { MACH_SERVICES, quote, renderProfile, SYSTEM_READ_LITERALS, SYSTEM_READ_PATHS, type ProfileInput } from "../../src/sandbox/profile.ts";

const INPUT: ProfileInput = {
  toolFiles: ["/opt/claude/versions/2.1", "/opt/bun/bin/bun"],
  toolDirs: ["/Library/Developer/CommandLineTools/usr/libexec/git-core"],
  xarabotHome: "/Users/u/.xarabot",
  writable: ["/Users/u/.xarabot/lanes/l/clone", "/Users/u/.xarabot/lanes/l/vendor", "/Users/u/.xarabot/lanes/l/tmp"],
  denied: ["/Users/u/.xarabot/lanes/l/runner.git", "/Users/u/.config/xarabot", "/Users/u/.ssh"],
};

function render(input: ProfileInput = INPUT): string {
  const r = renderProfile(input);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** The index of the first line containing every fragment; -1 when none does. */
function lineOf(profile: string, ...fragments: string[]): number {
  return profile.split("\n").findIndex((l) => fragments.every((f) => l.includes(f)));
}

describe("quote", () => {
  test("wraps an absolute path in double quotes", () => {
    expect(quote("/a b/c'd")).toEqual({ ok: true, value: '"/a b/c\'d"' });
  });

  test.each([['/a"b'], ["/a\\b"], ["/a\nb"], ["/a\0b"], ["relative/path"], [""]])("refuses %j", (path) => {
    const r = quote(path);
    expect(r.ok).toBe(false);
  });
});

describe("renderProfile", () => {
  test("starts with deny default and ends with deny network*", () => {
    const lines = render().trimEnd().split("\n");
    expect(lines[0]).toBe("(version 1)");
    expect(lines[1]).toBe("(deny default)");
    expect(lines[lines.length - 1]).toBe("(deny network*)");
  });

  test("the sections come in the contract's order", () => {
    const p = render();
    const order = [
      lineOf(p, "(deny default)"),
      lineOf(p, "(allow process-fork)"),
      lineOf(p, "(allow signal (target same-sandbox))"),
      lineOf(p, "(allow sysctl-read)"),
      lineOf(p, "(allow file-read-metadata)"),
      lineOf(p, "(allow mach-lookup"),
      lineOf(p, '(allow file-read* process-exec (literal "/")', '(subpath "/usr")'),
      lineOf(p, '(literal "/opt/claude/versions/2.1")'),
      lineOf(p, '(deny file-read* file-write* process-exec (subpath "/Users/u/.xarabot"))'),
      lineOf(p, '(allow file-read* file-write* process-exec (subpath "/Users/u/.xarabot/lanes/l/clone")'),
      lineOf(p, '(deny file-read* file-write* process-exec (subpath "/Users/u/.xarabot/lanes/l/runner.git")'),
      lineOf(p, '(allow file-write* (literal "/dev/null")'),
      lineOf(p, "(deny network*)"),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("the ~/.xarabot deny comes before the writable roots, and the always-denied paths after them", () => {
    const p = render();
    const xarabot = lineOf(p, '(deny file-read* file-write* process-exec (subpath "/Users/u/.xarabot"))');
    const writable = lineOf(p, "(allow file-read* file-write* process-exec");
    const denied = lineOf(p, '(subpath "/Users/u/.ssh")');
    expect(xarabot).toBeLessThan(writable);
    expect(writable).toBeLessThan(denied);
    for (const w of INPUT.writable) expect(p.split("\n")[writable]).toContain(`(subpath "${w}")`);
    for (const d of INPUT.denied) expect(p.split("\n")[denied]).toContain(`(subpath "${d}")`);
  });

  test("reads every system path; / and the devices only as literals", () => {
    const line = render().split("\n")[lineOf(render(), '(allow file-read* process-exec (literal "/")')] as string;
    for (const s of SYSTEM_READ_PATHS) expect(line).toContain(`(subpath "${s}")`);
    for (const s of SYSTEM_READ_LITERALS) expect(line).toContain(`(literal "${s}")`);
    expect(line).not.toContain('(subpath "/")');
    expect(line).not.toContain('(subpath "/dev")');
    expect(render()).not.toContain("ttys");
    expect(render()).not.toContain("regex");
  });

  test("exec is allowed only with reads or the writable roots, never unscoped", () => {
    const p = render();
    expect(p).not.toMatch(/\(allow[^\n]*process-exec\)/);
    const execLines = p.split("\n").filter((l) => l.startsWith("(allow") && l.includes("process-exec"));
    expect(execLines.every((l) => l.startsWith("(allow file-read* "))).toBe(true);
    expect(execLines).toHaveLength(3);
  });

  test("tool files are literals and tool directories subpaths", () => {
    const p = render();
    expect(p).toContain('(allow file-read* process-exec (literal "/opt/claude/versions/2.1") (literal "/opt/bun/bin/bun") (subpath "/Library/Developer/CommandLineTools/usr/libexec/git-core"))');
  });

  test("no tool rule when there are no tools", () => {
    const p = render({ ...INPUT, toolFiles: [], toolDirs: [] });
    expect(p).not.toContain("(allow file-read* process-exec (literal \"/opt");
  });

  test("looks up only the fixed Mach services; no securityd or keychain service", () => {
    const line = render().split("\n").find((l) => l.startsWith("(allow mach-lookup")) as string;
    expect(line).toBe(`(allow mach-lookup ${MACH_SERVICES.map((n) => `(global-name "${n}")`).join(" ")})`);
    expect(line).not.toMatch(/securityd|keychain|SecurityServer/i);
    expect(render().match(/mach-lookup/g)).toHaveLength(1);
  });

  test("looks up configd for the system's proxy settings; the keychain services stay absent", () => {
    expect(MACH_SERVICES).toContain("com.apple.SystemConfiguration.configd");
    const line = render().split("\n").find((l) => l.startsWith("(allow mach-lookup")) as string;
    expect(line).toContain('(global-name "com.apple.SystemConfiguration.configd")');
    for (const name of MACH_SERVICES) expect(name).not.toMatch(/securityd|keychain|SecurityServer|secd|trustd/i);
  });

  test("writes only to /dev/null, /dev/zero and /dev/tty* outside the writable roots", () => {
    const writes = render()
      .split("\n")
      .filter((l) => l.startsWith("(allow") && l.includes("file-write"));
    expect(writes).toEqual([
      `(allow file-read* file-write* process-exec ${INPUT.writable.map((w) => `(subpath "${w}")`).join(" ")})`,
      '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty"))',
    ]);
  });

  test("never allows network or a default allow", () => {
    const p = render();
    expect(p).not.toContain("(allow network");
    expect(p).not.toContain("(allow default");
  });

  test.each<[string, Partial<ProfileInput>]>([
    ["a writable root with a quote", { writable: ['/a"b'] }],
    ["a denied path with a backslash", { denied: ["/a\\b"] }],
    ["a tool with a newline", { toolFiles: ["/a\nb"] }],
    ["a tool dir with NUL", { toolDirs: ["/a\0b"] }],
    ["~/.xarabot relative", { xarabotHome: "u/.xarabot" }],
    ["no writable roots", { writable: [] }],
  ])("fails to generate: %s", (_name, patch) => {
    expect(renderProfile({ ...INPUT, ...patch }).ok).toBe(false);
  });
});

describe("renderProfile: proxyPort", () => {
  test("opens exactly the proxy port, right after deny network*, as the last rule", () => {
    const lines = render({ ...INPUT, proxyPort: 51234 }).trimEnd().split("\n");
    expect(lines.slice(-2)).toEqual(["(deny network*)", '(allow network-outbound (remote tcp "localhost:51234"))']);
    expect(lines.filter((l) => l.includes("network"))).toHaveLength(2);
  });

  test("allows no UDP, no DNS and no other Mach service", () => {
    const p = render({ ...INPUT, proxyPort: 51234 });
    expect(p).not.toContain("udp");
    expect(p).not.toContain("mDNSResponder");
    expect(p.match(/mach-lookup/g)).toHaveLength(1);
  });

  test("without a proxy port the profile is unchanged", () => {
    expect(render({ ...INPUT })).toBe(render());
  });

  test("the port's bounds are accepted", () => {
    for (const port of [1, 65535]) expect(renderProfile({ ...INPUT, proxyPort: port }).ok).toBe(true);
  });

  test.each([[0], [65536], [-1], [1.5], [Number.NaN]])("refuses port %p", (port) => {
    const r = renderProfile({ ...INPUT, proxyPort: port });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("invalid");
  });
});
