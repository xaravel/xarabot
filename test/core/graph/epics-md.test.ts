import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseEpicsMd } from "../../../src/core/graph/epics-md.ts";

const PATH = "_bmad-output/planning-artifacts/epics.md";

function kindOf(r: { ok: boolean; error?: { kind: string } }): string {
  return r.ok ? "ok" : (r.error?.kind ?? "?");
}

describe("parseEpicsMd on this repo's epics.md", () => {
  test("Epics 1-7 and every Story", async () => {
    const text = await Bun.file(join(import.meta.dir, "../../fixtures/epics.md")).text();
    const r = parseEpicsMd(PATH, text);
    if (!r.ok) throw new Error(r.error.message);
    const epics = r.value.epics;
    expect(epics.map((e) => e.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(epics.map((e) => e.stories.length)).toEqual([22, 12, 6, 7, 4, 5, 7]);
    const ids = epics.flatMap((e) => e.stories.map((s) => s.id));
    expect(ids.length).toBe(63);
    for (const id of ["1.16a", "1.17a", "5.1a", "1.1", "7.7", "2.10"]) expect(ids).toContain(id);
    // Every `### Story` line in the file is accounted for.
    const expected = [...text.matchAll(/^### Story (\d+\.\d+[a-z]?):/gm)].map((m) => m[1] ?? "");
    expect(ids).toEqual(expected);
    expect(epics[0]).toMatchObject({ number: 1, title: "One sandboxed lane builds Stories unattended", line: 274 });
    expect(epics[0]?.stories[2]).toEqual({
      id: "1.3",
      epic: 1,
      title: "Story manifests and the `epics.md` grammar",
      line: 364,
    });
  });
});

describe("parseEpicsMd on the live planning epics.md", () => {
  test("parses and finds every ### Story line", async () => {
    const text = await Bun.file(join(import.meta.dir, "../../..", PATH)).text();
    const r = parseEpicsMd(PATH, text);
    if (!r.ok) throw new Error(r.error.message);
    const ids = r.value.epics.flatMap((e) => e.stories.map((s) => s.id));
    expect(ids).toEqual([...text.matchAll(/^### Story (\d+\.\d+[a-z]?):/gm)].map((m) => m[1] ?? ""));
  });
});

describe("parseEpicsMd grammar", () => {
  const okCases: readonly [string, string, Record<number, string[]>][] = [
    ["fenced Epic ignored", "## Epic 1: A\n```\n## Epic 9: X\n### Story 9.1: X\n```\n### Story 1.1: B\n", { 1: ["1.1"] }],
    ["tilde fence, longer close", "## Epic 1: A\n~~~~\n## Epic 9: X\n~~~\nstill in\n~~~~~\n### Story 1.1: B\n", { 1: ["1.1"] }],
    ["close must be same char", "## Epic 1: A\n```\n~~~\n## Epic 9: X\n```\n", { 1: [] }],
    ["close with info is not a close", "## Epic 1: A\n```\n``` js\n## Epic 9: X\n", { 1: [] }],
    ["indented fence", "## Epic 1: A\n   ```\n## Epic 9: X\n   ```\n", { 1: [] }],
    ["4-space indent is no fence", "## Epic 1: A\n    ```\n## Epic 2: B\n", { 1: [], 2: [] }],
    ["unclosed fence runs to end", "## Epic 1: A\n```\n## Epic 9: X\n", { 1: [] }],
    ["Epic List ignored", "## Epic List\n### Epic 1: A\n### Epic 2: B\n## Epic 1: A\n", { 1: [] }],
    ["CRLF", "## Epic 1: A\r\n### Story 1.1: B\r\n### Story 1.2a: C\r\n", { 1: ["1.1", "1.2a"] }],
    ["other headings ignored", "# Title\n## Epic 1: A\n#### Story 1.9: no\n### Notes\n### Story 1.1: B\n", { 1: ["1.1"] }],
  ];
  for (const [name, text, expected] of okCases) {
    test(name, () => {
      const r = parseEpicsMd(PATH, text);
      if (!r.ok) throw new Error(r.error.message);
      const got = Object.fromEntries(r.value.epics.map((e) => [e.number, e.stories.map((s) => s.id)]));
      expect(got).toEqual(expected);
    });
  }

  const bad: readonly [string, string, string][] = [
    ["Story under the wrong Epic", "## Epic 1: A\n### Story 2.1: B\n", "line 2"],
    ["Story before any Epic", "### Story 1.1: B\n## Epic 1: A\n", "line 1"],
    ["Story under Overview", "## Epic 1: A\n## Overview\n### Story 1.1: B\n", "line 3"],
    ["repeated Epic", "## Epic 1: A\n## Epic 1: B\n", "line 2"],
    ["repeated Story", "## Epic 1: A\n### Story 1.1: B\n### Story 1.1: C\n", "line 3"],
    ["repeated Story, leading zero", "## Epic 1: A\n### Story 1.1: B\n### Story 1.01: C\n", "line 3"],
    ["Story with upper-case suffix", "## Epic 1: A\n### Story 1.7A: X\n", "line 2"],
    ["Story with space before colon", "## Epic 1: A\n### Story 1.1 : X\n", "line 2"],
    ["Story with dash", "## Epic 1: A\n### Story 1.1 - X\n", "line 2"],
    ["Story with no colon", "## Epic 1: A\n### Story 1.1\n", "line 2"],
    ["Epic with dash", "## Epic 1 - A\n", "line 1"],
    ["Epic with no colon", "## Epic 1\n", "line 1"],
  ];
  for (const [name, text, needle] of bad) {
    test(name, () => {
      const r = parseEpicsMd(PATH, text);
      expect(kindOf(r)).toBe("invalid");
      if (!r.ok) {
        expect(r.error.message.startsWith(`${PATH}: `)).toBe(true);
        expect(r.error.message).toContain(needle);
      }
    });
  }
});
