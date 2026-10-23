import { describe, expect, test } from "bun:test";
import { sanitizeAgentText } from "../../src/core/sanitize.ts";

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

  test("total: odd input never throws", () => {
    for (const s of ["\n", "\n\n", "@", "#", "fixes", "Cc:", "\u{1F916}", "a\0b", "x: y\n\nz: w"]) {
      expect(typeof sanitizeAgentText(s)).toBe("string");
    }
  });
});
