import { describe, expect, test } from "bun:test";
import { followupRecommended } from "../../../src/core/review/review-spec.ts";

const spec = (frontmatter: string): string => `---\ntitle: 'Story 3.4'\nstatus: 'done'\n${frontmatter}---\n\n## Auto Run Result\n\nStatus: done\n`;

describe("followupRecommended", () => {
  test.each([
    ["true", spec("followup_review_recommended: true\n"), true],
    ["false", spec("followup_review_recommended: false\n"), false],
    ["absent", spec(""), false],
    ["the string 'true'", spec("followup_review_recommended: 'true'\n"), false],
    ["yes", spec("followup_review_recommended: yes\n"), false],
    ["1", spec("followup_review_recommended: 1\n"), false],
    ["null", spec("followup_review_recommended: null\n"), false],
    ["a list", spec("followup_review_recommended: [true]\n"), false],
    ["CRLF line ends", spec("followup_review_recommended: true\n").replaceAll("\n", "\r\n"), true],
    ["a BOM", `﻿${spec("followup_review_recommended: true\n")}`, true],
    ["no frontmatter", "# Spec\n\nfollowup_review_recommended: true\n", false],
    ["an unclosed frontmatter", "---\nfollowup_review_recommended: true\n", false],
    ["invalid YAML", "---\nfollowup_review_recommended: [true\n---\n", false],
    ["a non-mapping frontmatter", "---\n- followup_review_recommended\n---\n", false],
    ["only in the body", `${spec("")}\nfollowup_review_recommended: true\n`, false],
    ["empty", "", false],
  ])("%s", (_what, text, expected) => {
    expect(followupRecommended(text)).toBe(expected);
  });
});
