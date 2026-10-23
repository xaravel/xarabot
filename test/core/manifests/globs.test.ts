import { describe, expect, test } from "bun:test";
import { globsOverlap, literalPrefix, normalizeGlob } from "../../../src/core/manifests/globs.ts";

describe("normalizeGlob", () => {
  const okCases: readonly [string, string][] = [
    ["./src/a/**", "src/a/**"],
    ["././src/a.ts", "src/a.ts"],
    ["src/**/*.ts", "src/**/*.ts"],
    ["docs/{a,b}.md", "docs/{a,b}.md"],
  ];
  for (const [input, expected] of okCases) {
    test(`${input} -> ${expected}`, () => {
      expect(normalizeGlob(input)).toEqual({ ok: true, value: expected });
    });
  }
  const bad = ["", "./", "!src/**", "../x", "/abs", "~/x", "src/../x", "src/./x", "src//x", "src/", "src\\x", "./../x"];
  for (const input of bad) {
    test(`rejects ${JSON.stringify(input)}`, () => {
      const r = normalizeGlob(input);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe("invalid");
        expect(r.error.message).toContain(`"${input}"`);
      }
    });
  }
});

describe("literalPrefix", () => {
  const cases: readonly [string, string][] = [
    ["src/a/**", "src/a/"],
    ["src/a.ts", "src/a.ts"],
    ["src/a?.ts", "src/a"],
    ["src/[ab].ts", "src/"],
    ["src/{a,b}.ts", "src/"],
    ["**", ""],
  ];
  for (const [glob, prefix] of cases) {
    test(`${glob} -> ${JSON.stringify(prefix)}`, () => {
      expect(literalPrefix(glob)).toBe(prefix);
    });
  }
});

describe("globsOverlap", () => {
  const cases: readonly [string, string, boolean][] = [
    ["src/a/**", "src/A/b.ts", true],
    ["src/a*", "src/ab/x.ts", true],
    ["src/a/**", "src/ab/**", false],
    ["src/a/**", "src/a/**", true],
    ["**", "anything/x.ts", true],
    ["docs/x.md", "src/x.md", false],
  ];
  for (const [a, b, expected] of cases) {
    test(`${a} ~ ${b} -> ${expected}`, () => {
      expect(globsOverlap(a, b)).toBe(expected);
      expect(globsOverlap(b, a)).toBe(expected);
    });
  }
});
