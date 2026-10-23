import { describe, expect, test } from "bun:test";
import { parseEpicsYaml } from "../../../src/core/graph/epics-yaml.ts";

const P = ".xarabot/epics.yaml";

describe("parseEpicsYaml", () => {
  test("this repo's shape", () => {
    const r = parseEpicsYaml(P, "version: 1\nepics:\n  6:\n    depends_on: [4]\n  7:\n    depends_on: [5, 6, 5]\n  3: {checkpoint: true}\n");
    if (!r.ok) throw new Error(r.error.message);
    expect([...r.value.epics]).toEqual([
      [3, { checkpoint: true }],
      [6, { depends_on: [4] }],
      [7, { depends_on: [5, 6] }],
    ]);
  });

  test("empty epics map", () => {
    const r = parseEpicsYaml(P, "version: 1\nepics: {}\n");
    expect(r.ok && r.value.epics.size).toBe(0);
  });

  const bad: readonly [string, string, string][] = [
    ["wrong version", "version: 2\nepics: {}\n", "unsupported-version"],
    ["string version", 'version: "1"\nepics: {}\n', "invalid"],
    ["missing version", "epics: {}\n", "invalid"],
    ["extra key", "version: 1\nepics: {}\nextra: 1\n", "invalid"],
    ["key 0", "version: 1\nepics:\n  0: {}\n", "invalid"],
    ["key 01", "version: 1\nepics:\n  01: {}\n", "invalid"],
    ["key x", "version: 1\nepics:\n  x: {}\n", "invalid"],
    ["depends_on [0]", "version: 1\nepics:\n  2: {depends_on: [0]}\n", "invalid"],
    ['depends_on ["2"]', 'version: 1\nepics:\n  3: {depends_on: ["2"]}\n', "invalid"],
    ["checkpoint false", "version: 1\nepics:\n  2: {checkpoint: false}\n", "invalid"],
    ["entry extra key", "version: 1\nepics:\n  2: {after: [1]}\n", "invalid"],
    ["null epics", "version: 1\nepics:\n", "invalid"],
    ["null entry", "version: 1\nepics:\n  2:\n", "invalid"],
    ["multi-doc", "version: 1\nepics: {}\n---\nversion: 1\nepics: {}\n", "invalid"],
    ["duplicate key", "version: 1\nepics:\n  2: {}\n  2: {checkpoint: true}\n", "invalid"],
    ["flow epics", "version: 1\nepics: {2: {}}\n", "invalid"],
    ["flow doc after ---", "--- {version: 1, epics: {6: {}, 6: {checkpoint: true}}}\n", "invalid"],
    ["merge key", "version: 1\nepics:\n  <<: {6: {}}\n  6: {checkpoint: true}\n", "invalid"],
  ];
  test.each(bad)("%s", (_name, text, kind) => {
    const r = parseEpicsYaml(P, text);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe(kind as "invalid");
      expect(r.error.message.startsWith(`${P}: `)).toBe(true);
    }
  });
});
