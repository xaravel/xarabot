import { describe, expect, test } from "bun:test";
import { checkEpicKeys, findDuplicateKeys, parseYamlMapping } from "../../../src/core/graph/yaml-keys.ts";

const P = ".xarabot/epics.yaml";

describe("findDuplicateKeys", () => {
  test("collects top-level and first-level keys, ignoring comments and deeper levels", () => {
    const text = "# head\nversion: 1\nepics:\n  # c\n  6:\n    depends_on: [4]\n  \"7\": {depends_on: [5]}\n";
    const r = findDuplicateKeys(P, text, "epics");
    expect(r).toEqual({ ok: true, value: { top: ["version", "epics"], map: [{ key: "6", line: 5 }, { key: "7", line: 7 }] } });
  });

  test("bare document markers and comments after them are fine", () => {
    expect(findDuplicateKeys(P, "--- # doc\nversion: 1\nepics: {}\n...\n", "epics").ok).toBe(true);
  });

  test("empty flow map is scannable", () => {
    expect(findDuplicateKeys(P, "version: 1\nepics: {} # none\n", "epics").ok).toBe(true);
  });

  const bad: readonly [string, string, string][] = [
    ["duplicate top-level key", "version: 1\nversion: 1\nepics: {}\n", 'duplicate key "version"'],
    ["duplicate epic key", "version: 1\nepics:\n  6: {}\n  6: {}\n", 'duplicate epics key "6"'],
    ["quoted and plain collide", "version: 1\nepics:\n  6: {}\n  \"6\": {}\n", 'duplicate epics key "6"'],
    ["single-quoted collide", "version: 1\nepics:\n  '6': {}\n  6: {}\n", 'duplicate epics key "6"'],
    ["flow epics", "version: 1\nepics: {6: {}, 6: {}}\n", "must be a block mapping or {}"],
    ["alias epics", "version: 1\nepics: *x\n", "must be a block mapping or {}"],
    ["top-level flow", "{version: 1, epics: {}}\n", "top-level"],
    ["indented top level", "  version: 1\n", "top-level"],
    ["complex key", "version: 1\nepics:\n  ? 6\n  : {}\n", 'expected a "key:" under epics'],
    ["tab indent", "version: 1\nepics:\n\t6: {}\n", "tab indentation"],
    ["content after ---", "--- {version: 1, epics: {6: {}, 6: {checkpoint: true}}}\n", "document marker"],
    ["content after ...", "version: 1\nepics: {}\n... x\n", "document marker"],
    ["top-level merge key", "<<: {version: 1}\nepics: {}\n", "merge keys"],
    ["merge key under epics", "version: 1\nepics:\n  <<: {6: {}}\n  6: {}\n", "merge keys"],
  ];
  test.each(bad)("%s", (_name, text, fragment) => {
    const r = findDuplicateKeys(P, text, "epics");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("invalid");
      expect(r.error.message.startsWith(`${P}: `)).toBe(true);
      expect(r.error.message).toContain(fragment);
    }
  });
});

describe("checkEpicKeys", () => {
  test.each(["01", "0x1", "1.0", "x", "0"])("raw key %s is refused", (key) => {
    const r = checkEpicKeys(P, `version: 1\nepics:\n  ${key}: {}\n`, "epics");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain(`"${key}" must be an Epic number`);
  });
});

describe("parseYamlMapping", () => {
  test.each([
    ["multi-document", "a: 1\n---\nb: 2\n", "several documents"],
    ["list", "- 1\n", "list"],
    ["scalar", "3\n", "mapping"],
    ["empty", "", "mapping"],
    ["bad yaml", "a: [\n", "invalid YAML"],
  ])("%s is invalid", (_name, text, fragment) => {
    const r = parseYamlMapping(P, text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain(fragment);
  });
});
