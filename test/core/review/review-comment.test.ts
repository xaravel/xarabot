import { describe, expect, test } from "bun:test";
import { isBlocking, reviewComment, type ReviewCommentInput } from "../../../src/core/review/review-comment.ts";
import { FORGE_TEXT_LIMITS, TRUNCATION_MARKER } from "../../../src/core/sanitize.ts";
import type { ReviewFinding } from "../../../src/core/schemas/session-result.ts";

const SHA = `0123${"4".repeat(32)}cdef`;
const HIGH: ReviewFinding = { severity: "high", blocking: true, file: "src/a.ts", text: "the loop never ends." };
const LOW: ReviewFinding = { severity: "low", blocking: false, file: "src/b.ts", text: "a name could be clearer." };

describe("isBlocking", () => {
  test.each([
    ["pass, no findings", "pass", [], false],
    ["pass, a non-blocking finding", "pass", [LOW], false],
    ["pass, a blocking finding", "pass", [HIGH], true],
    ["changes requested, no blocking finding", "changes-requested", [LOW], true],
    ["changes requested, no findings", "changes-requested", [], true],
    ["changes requested, a blocking finding", "changes-requested", [LOW, HIGH], true],
  ] as const)("%s: %p", (_what, verdict, findings, expected) => {
    expect(isBlocking({ verdict, findings: [...findings] })).toBe(expected);
  });
});

function input(over: Partial<ReviewCommentInput> = {}): ReviewCommentInput {
  return {
    subject: "Story 3.4",
    sha: SHA,
    crossVendor: true,
    adapter: "codex",
    model: "gpt-6.1-sol",
    pass: "normal",
    result: { verdict: "changes-requested", findings: [HIGH], denied_actions: [] },
    ...over,
  };
}

describe("reviewComment", () => {
  test("the golden body", () => {
    expect(reviewComment(input())).toBe(
      `🤖 Story 3.4: cross-vendor review by codex (gpt-6.1-sol) of ${SHA}.\n\nVerdict: changes requested.\nOutcome: blocking.\n\nFindings:\n- high, blocking, \`src/a.ts\`: the loop never ends.\n\nDenied actions: none.\n`,
    );
  });

  test("same-vendor, follow-up, pass, no findings", () => {
    const body = reviewComment(input({ crossVendor: false, adapter: "claude", model: "claude-opus-5-5", pass: "followup", result: { verdict: "pass", findings: [], denied_actions: [] } }));
    expect(body).toBe(`🤖 Story 3.4: same-vendor follow-up review by claude (claude-opus-5-5) of ${SHA}.\n\nVerdict: pass.\nOutcome: not blocking.\n\nFindings: none.\n\nDenied actions: none.\n`);
  });

  test("a coordinator unit's subject, and each finding in order with its blocking word", () => {
    const body = reviewComment(input({ subject: "Unit retro-item:epic-2-retro-item-1-x", result: { verdict: "pass", findings: [LOW, HIGH], denied_actions: [] } }));
    expect(body.startsWith("🤖 Unit retro-item:epic-2-retro-item-1-x: cross-vendor review by codex")).toBe(true);
    expect(body).toContain("Findings:\n- low, not blocking, `src/b.ts`: a name could be clearer.\n- high, blocking, `src/a.ts`: the loop never ends.\n");
  });

  test("agent text is sanitized, redacted and kept on one line; a backtick in a path cannot break out", () => {
    const finding: ReviewFinding = { severity: "medium", blocking: false, file: "src/`x`.ts", text: "ping @alice\nabout sekrit-token,\nfixes #12" };
    const body = reviewComment(input({ result: { verdict: "pass", findings: [finding], denied_actions: [] }, secrets: ["sekrit-token"] }));
    expect(body).toContain("- medium, not blocking, `src/'x'.ts`: ping alice about [REDACTED],");
    expect(body).not.toContain("@alice");
    expect(body).not.toContain("sekrit-token");
    expect(body).not.toContain("#12");
  });

  test.each([
    ["pass, no findings", "pass", [], "Verdict: pass.\nOutcome: not blocking."],
    ["pass, a non-blocking finding", "pass", [LOW], "Verdict: pass.\nOutcome: not blocking."],
    ["pass with a blocking finding: the runner blocks", "pass", [HIGH], "Verdict: pass.\nOutcome: blocking."],
    ["changes requested, no blocking finding", "changes-requested", [LOW], "Verdict: changes requested.\nOutcome: blocking."],
  ] as const)("the outcome line: %s", (_what, verdict, findings, lines) => {
    expect(reviewComment(input({ result: { verdict, findings: [...findings], denied_actions: [] } }))).toContain(`\n\n${lines}\n\n`);
  });

  test("denied actions: listed one per line, sanitized and redacted; none says so", () => {
    const body = reviewComment(input({ result: { verdict: "pass", findings: [], denied_actions: ["git push\n  origin", "read @alice's sekrit-token", "  "] }, secrets: ["sekrit-token"] }));
    expect(body.endsWith("\n\nDenied actions:\n- git push origin\n- read alice's [REDACTED]\n")).toBe(true);
    expect(reviewComment(input())).toEndWith("\n\nDenied actions: none.\n");
  });

  test("the full SHA is named, never a short one", () => {
    expect(reviewComment(input())).toContain(` of ${SHA}.`);
  });

  test("a body over the comment limit is capped", () => {
    const many: ReviewFinding[] = Array.from({ length: 2000 }, (_, i) => ({ severity: "low", blocking: false, file: `src/f${i}.ts`, text: "x".repeat(60) }));
    const body = reviewComment(input({ result: { verdict: "pass", findings: many, denied_actions: [] } }));
    expect(body.length).toBeLessThanOrEqual(FORGE_TEXT_LIMITS.comment);
    expect(body.endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});
