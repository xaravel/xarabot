import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { capText, FORGE_TEXT_LIMITS, holdsCredential, redactSecrets, REDACTED, sanitizeAgentText, TRUNCATION_MARKER } from "../../src/core/sanitize.ts";

/** One input per token shape; each literal is split so this file itself holds no token-shaped string. */
const redacted: readonly [string, string][] = [
  ["Anthropic API key", `key sk-ant-api03-${"a1B2_c3-".repeat(8)}AA here`],
  ["Claude OAuth token", `token sk-ant-oat01-${"Zz9".repeat(20)} here`],
  ["OpenAI key", `key sk-proj-${"x".repeat(48)} here`],
  ["OpenAI legacy key", `key sk-${"A1b2".repeat(12)} here`],
  ["GitHub personal token", `ghp_${"a".repeat(36)} here`],
  ["GitHub OAuth token", `gho_${"B".repeat(36)} here`],
  ["GitHub user-to-server token", `ghu_${"c".repeat(36)} here`],
  ["GitHub server-to-server token", `ghs_${"D".repeat(36)} here`],
  ["GitHub refresh token", `ghr_${"e".repeat(36)} here`],
  ["GitHub fine-grained token", `github_pat_11ABCDEFG0${"x".repeat(60)} here`],
  ["AWS access key id", `${"AKIA"}IOSFODNN7EXAMPLE here`],
  ["Slack bot token", `xoxb-${"1234567890"}-0987654321-AbCdEfGhIj here`],
  ["Slack user token", `xoxp-${"1234567890"}-AbCdEfGhIj here`],
  ["npm token", `npm_${"aB3".repeat(12)} here`],
  ["GitLab personal access token", `glpat-${"xY_9-".repeat(4)} here`],
  ["Google API key", `AIza${"Sy0_-".repeat(7)} here`],
  ["Stripe live secret key", `sk_live_${"51Hx".repeat(6)} here`],
  ["Stripe live restricted key", `rk_live_${"51Hx".repeat(6)} here`],
  ["JWT", `eyJhbGciOiJIUzI1NiJ9.${"eyJ"}zdWIiOiIxMjM0In0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk here`],
];

describe("sanitizeAgentText", () => {
  const changed: readonly [string, string, string][] = [
    ["final Co-Authored-By trailer", "Done.\n\nCo-Authored-By: X <x@y>", "Done."],
    ["trailer with a trailing newline", "Done.\n\nCo-Authored-By: X <x@y>\n", "Done."],
    ["attribution trailer mid-text, any case", "a\nsigned-off-by: Me <m@x>\nb", "a\nb"],
    ["every attribution token", ["x", ...["Acked-by", "Reviewed-by", "Tested-by", "Reported-by", "Suggested-by", "Helped-by", "Assisted-by", "Generated-by", "Cc"].map((t) => `${t}: v`), "y"].join("\n"), "x\ny"],
    ["Generated with marker with robot", "Body.\n\n\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)", "Body."],
    ["Generated with marker without robot", "Body.\nGenerated with Codex\nMore.", "Body.\nMore."],
    ["final trailer block of other tokens", "Title\n\nBody text.\n\nChange-Id: I123\nRefs: abc\n  continued", "Title\n\nBody text."],
    ["closing keyword with #n", "fixes #12", ""],
    ["closing keyword in a sentence", "This change fixes #12 for good.", "This change for good."],
    ["closing keyword with colon", "Done. Closes: #7", "Done."],
    ["owner/repo ref", "Resolved acme/widgets#99 today", "today"],
    ["GH- ref", "See FIXED GH-3 now", "See now"],
    ["issue URL", "see: resolves https://github.com/a/b/issues/5", "see:"],
    ["pull URL", "closed https://github.com/a/b/pull/6.", "."],
    ["line left blank by removal is dropped", "a\nCloses #1\nb", "a\nb"],
    ["@mention", "thanks @octocat", "thanks octocat"],
    ["@team mention", "ping @acme/core please", "ping acme/core please"],
    ["mention at start", "@octo-cat did it", "octo-cat did it"],
    ["doubled @ mention", "hi @@alice", "hi alice"],
    ["repeated keyword", "fixes fixes #1 #2", ""],
    ["keyword before an @-prefixed ref", "fixes @owner/repo#1", ""],
    ["closing phrase at line start keeps no leading space", "Fixes #3 and more", "and more"],
    ["quoted Generated with marker", "Body.\n> Generated with Claude", "Body."],
    ["emphasised Generated with marker", "Body.\n*Generated with Claude*", "Body."],
    ["listed Generated with marker", "Body.\n- \u{1F916} Generated with Claude", "Body."],
    ["trailer without space after colon", "Title\n\nBody.\n\nChange-Id:I123", "Title\n\nBody."],
    ["trailer with space before colon", "Title\n\nBody.\n\nChange-Id : I123", "Title\n\nBody."],
  ];
  for (const [name, input, want] of changed) {
    test(name, () => expect(sanitizeAgentText(input)).toBe(want));
  }

  const unchanged: readonly [string, string][] = [
    ["plain text", "Done."],
    ["email address", "mail a@b.com"],
    ["trailing newline and blanks kept", "Done.\n\n\n"],
    ["empty", ""],
    ["single-paragraph Token: value is the first paragraph", "Note: this is it"],
    ["prefix word is not a keyword", "prefix #12 and suffixes #3"],
    ["keyword without reference", "fixes the bug in #parser"],
    ["mixed block is not a trailer block", "Title\n\nNote: a\nplain line"],
    ["URL line is not a trailer", "Title\n\nhttps://example.com/x"],
    ["CRLF text", "a\r\nb\r\n"],
    ["issue URL alone", "see https://github.com/a/b/issues/5"],
  ];
  for (const [name, input] of unchanged) {
    test(`unchanged: ${name}`, () => expect(sanitizeAgentText(input)).toBe(input));
  }

  for (const [name, input] of redacted) {
    test(`redacts: ${name}`, () => {
      const out = sanitizeAgentText(input);
      expect(out).toContain("[REDACTED]");
      expect(out.endsWith(" here")).toBe(true);
      expect(out).toBe(`${input.startsWith("key ") ? "key " : input.startsWith("token ") ? "token " : ""}[REDACTED] here`);
    });
  }

  test("redacts a PEM private-key block, ended or not", () => {
    const pem = `-----BEGIN OPENSSH ${"PRIVATE"} KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAABG5vbmUAAAAEbm9uZQ==\n-----END OPENSSH PRIVATE KEY-----`;
    expect(sanitizeAgentText(`before\n${pem}\nafter`)).toBe(`before\n${REDACTED}\nafter`);
    expect(sanitizeAgentText(`x\n-----BEGIN RSA ${"PRIVATE"} KEY-----\nMIIEow\nrest`)).toBe(`x\n${REDACTED}`);
    expect(sanitizeAgentText("-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----")).toBe("-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----");
  });

  test("redacts every seeded secret, trimmed, longest first; empty secrets are ignored", () => {
    expect(sanitizeAgentText("use hunter2-xyz or hunter2", { secrets: ["  hunter2 ", "hunter2-xyz", "", "   "] })).toBe("use [REDACTED] or [REDACTED]");
    expect(sanitizeAgentText("a credential of any shape: {\"t\":1}", { secrets: ['{"t":1}'] })).toBe("a credential of any shape: [REDACTED]");
    expect(sanitizeAgentText("nothing secret", { secrets: [] })).toBe("nothing secret");
  });

  test("redaction runs before the other rules, on the whole text", () => {
    // The secret spans a line break and holds an @mention and a closing keyword the later rules would change.
    const secret = "@octo fixes #1\nCo-Authored-By: x";
    expect(sanitizeAgentText(`a ${secret} b`, { secrets: [secret] })).toBe("a [REDACTED] b");
  });

  test("words that only look like token prefixes stay", () => {
    for (const s of ["task-runner", "sk-short", "a ghp_short token", "AKIA too short", "eyJ.only", "mask-0123456789abcdefghijklmnop"]) {
      expect(sanitizeAgentText(s)).toBe(s);
    }
  });

  test("max caps the length: cut, ended with the marker, at most max long", () => {
    const text = "x".repeat(70_000);
    const out = sanitizeAgentText(text, { max: FORGE_TEXT_LIMITS.body });
    expect(out.length).toBe(65_536);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(out.startsWith("x".repeat(65_536 - TRUNCATION_MARKER.length))).toBe(true);
    expect(sanitizeAgentText("short", { max: 256 })).toBe("short");
    expect(sanitizeAgentText("x".repeat(256), { max: 256 })).toBe("x".repeat(256));
    expect(sanitizeAgentText("x".repeat(257), { max: 256 }).length).toBe(256);
  });

  test("the cap never splits a surrogate pair", () => {
    const keep = 100 - TRUNCATION_MARKER.length;
    // A pair straddling the cut point is dropped whole.
    const text = `${"a".repeat(keep - 1)}\u{1F600}${"b".repeat(50)}`;
    const out = capText(text, 100);
    expect(out).toBe(`${"a".repeat(keep - 1)}${TRUNCATION_MARKER}`);
    expect(out.length).toBeLessThanOrEqual(100);
    // A pair ending right at the cut point is kept.
    const fits = `${"a".repeat(keep - 2)}\u{1F600}${"b".repeat(50)}`;
    expect(capText(fits, 100)).toBe(`${"a".repeat(keep - 2)}\u{1F600}${TRUNCATION_MARKER}`);
  });

  test("a cap below the marker's length still holds", () => {
    expect(capText("abcdefghij", 5).length).toBe(5);
    expect(capText("abc", 0)).toBe("");
  });

  test("the forge limits", () => {
    expect(FORGE_TEXT_LIMITS).toEqual({ title: 256, body: 65_536, comment: 65_536 });
  });

  test("total: odd input never throws", () => {
    for (const s of ["\n", "\n\n", "@", "#", "fixes", "Cc:", "\u{1F916}", "a\0b", "x: y\n\nz: w"]) {
      expect(typeof sanitizeAgentText(s)).toBe("string");
    }
  });
});

describe("holdsCredential (the write check's credential class, Epic 2 retro item 20)", () => {
  test.each(redacted)("holds: %s", (_name, input) => {
    expect(holdsCredential(input)).toBe(true);
  });

  test("a PEM private-key block, ended or not; a public key is not one", () => {
    expect(holdsCredential(`a\n-----BEGIN EC ${"PRIVATE"} KEY-----\nMHc\n-----END EC PRIVATE KEY-----\n`)).toBe(true);
    expect(holdsCredential(`-----BEGIN ${"PRIVATE"} KEY-----\nMIIE`)).toBe(true);
    expect(holdsCredential("-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----")).toBe(false);
  });

  test("the seeded credential, of any shape, trimmed; empty secrets are ignored", () => {
    expect(holdsCredential("config: hunter2-xyz\n", ["  hunter2-xyz \n"])).toBe(true);
    expect(holdsCredential('{"t":1}', ['{"t":1}'])).toBe(true);
    expect(holdsCredential("nothing secret", ["hunter2", "", "  "])).toBe(false);
    expect(holdsCredential("", [""])).toBe(false);
  });

  test("words that only look like token prefixes are not credentials", () => {
    for (const s of ["task-runner", "sk-short", "a ghp_short token", "AKIA too short", "eyJ.only", "mask-0123456789abcdefghijklmnop", REDACTED]) {
      expect(holdsCredential(s)).toBe(false);
    }
  });

  test("agrees with redactSecrets: true exactly when redacting changes the text", () => {
    const secrets = ["hunter2-xyz"];
    for (const [, input] of redacted) expect(holdsCredential(input, secrets)).toBe(redactSecrets(input, secrets) !== input);
    for (const input of ["plain", "use hunter2-xyz", "sk-short", `a ${"gh"}p_${"x".repeat(36)}`]) {
      expect(holdsCredential(input, secrets)).toBe(redactSecrets(input, secrets) !== input);
    }
  });

  test("repeated calls give the same answer: the shared global patterns keep no state", () => {
    const input = `ghp_${"a".repeat(36)}`;
    for (let i = 0; i < 3; i++) expect(holdsCredential(input)).toBe(true);
    expect(redactSecrets(input)).toBe(REDACTED);
    expect(holdsCredential(input)).toBe(true);
  });

  test("this test file holds no token-shaped string, so a change to it is not refused", () => {
    expect(holdsCredential(readFileSync(import.meta.path, "utf8"))).toBe(false);
  });
});
