import { describe, expect, test } from "bun:test";
import { findingsText } from "../../../src/core/review/findings.ts";

const SHA = `0123${"a".repeat(32)}cdef`;

describe("findingsText (Story 3.5)", () => {
  test("the golden: a heading naming the subject and the SHA, then one line per finding", () => {
    const text = findingsText({
      subject: "Story 3.5",
      sha: SHA,
      blocking: true,
      findings: [
        { severity: "high", blocking: true, file: "src/a.ts", text: "the loop never ends." },
        { severity: "low", blocking: false, file: "src/b.ts", text: "a name could be clearer." },
      ],
    });
    expect(text).toBe(
      [
        `# Review findings for Story 3.5 at ${SHA}`,
        "",
        "- high, blocking, `src/a.ts`: the loop never ends.",
        "- low, not blocking, `src/b.ts`: a name could be clearer.",
        "",
      ].join("\n"),
    );
  });
  test("no findings", () => {
    expect(findingsText({ subject: "Unit retro-item:epic-2-retro-item-1-x", sha: SHA, blocking: false, findings: [] })).toBe(
      `# Review findings for Unit retro-item:epic-2-retro-item-1-x at ${SHA}\n\nNo findings.\n`,
    );
  });
  test("a round blocked by its verdict alone says so, and that every finding listed must be fixed", () => {
    const text = findingsText({ subject: "Story 3.5", sha: SHA, blocking: true, findings: [{ severity: "low", blocking: false, file: "src/b.ts", text: "a name could be clearer." }] });
    expect(text).toBe(
      [
        `# Review findings for Story 3.5 at ${SHA}`,
        "",
        "No finding is marked blocking, but the review's verdict requested changes: fix every finding listed.",
        "",
        "- low, not blocking, `src/b.ts`: a name could be clearer.",
        "",
      ].join("\n"),
    );
    expect(findingsText({ subject: "Story 3.5", sha: SHA, blocking: true, findings: [] })).toContain("verdict requested changes");
    // A blocking finding, or a round that did not block, gets no such line.
    expect(findingsText({ subject: "Story 3.5", sha: SHA, blocking: false, findings: [{ severity: "low", blocking: false, file: "src/b.ts", text: "x" }] })).not.toContain("verdict");
  });

  test("agent text is sanitized and redacted, on one line, and a backtick in a path cannot close the code span", () => {
    const secret = "sk-live-0123456789abcdef";
    const text = findingsText({
      subject: "Story 3.5",
      sha: SHA,
      blocking: true,
      findings: [{ severity: "medium", blocking: true, file: "src/`x`.ts", text: `leaks ${secret}\nand pings @alice.\nCo-Authored-By: x <x@y>` }],
      secrets: [secret],
    });
    expect(text).not.toContain(secret);
    expect(text).not.toContain("@alice");
    expect(text).toContain("- medium, blocking, `src/'x'.ts`: leaks ");
    expect(text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
  });
});
