import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED, checkSource, checkTree, type Layer, type Violation } from "./support/boundaries.ts";

const ROOT = join(import.meta.dir, "..");

const LAYERS: readonly Layer[] = ["core", "ports", "adapters", "sandbox", "lane", "cli"];

/** A representative file in each layer, all at depth 4 below the repo root's `src`. */
const FILE: Readonly<Record<Layer, string>> = {
  core: "src/core/a.ts",
  ports: "src/ports/a.ts",
  adapters: "src/adapters/forge/github/a.ts",
  sandbox: "src/sandbox/a.ts",
  lane: "src/lane/a.ts",
  cli: "src/cli/a.ts",
};

/** Relative specifier from `FILE[from]` to a module in layer `to`. */
function specifier(from: Layer, to: Layer): string {
  const up = from === "adapters" ? "../../../" : "../";
  const target = to === "adapters" ? "adapters/forge/github/b" : `${to}/b`;
  return `${up}${target}`;
}

/** The AR1 table written out independently of `ALLOWED`, so a drift in either shows. */
const AR1_TABLE: Readonly<Record<Layer, readonly Layer[]>> = {
  core: ["core"],
  ports: ["ports", "core"],
  adapters: ["adapters", "ports", "core"],
  sandbox: ["sandbox", "ports", "core"],
  lane: ["lane", "sandbox", "adapters", "ports", "core"],
  cli: ["cli", "lane", "sandbox", "adapters", "ports", "core"],
};

describe("the whole src/ tree", () => {
  test("has no violations", async () => {
    expect(await checkTree(ROOT)).toEqual([]);
  });

  test("checkTree reads files on disk and reports their violations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xarabot-tree-"));
    try {
      mkdirSync(join(dir, "src", "core"), { recursive: true });
      writeFileSync(join(dir, "src", "core", "clean.ts"), "export const a = 1;\n");
      writeFileSync(join(dir, "src", "core", "bad.ts"), "export const t = Date.now();\n");
      expect(await checkTree(dir)).toEqual([
        { path: "src/core/bad.ts", rule: "purity", detail: "core may not use Date.now()" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("checkTree refuses a root with no source files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xarabot-empty-"));
    try {
      await expect(checkTree(dir)).rejects.toThrow("no source files");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("layer table: every direction", () => {
  test("ALLOWED matches the AR1 table", () => {
    expect(ALLOWED).toEqual(AR1_TABLE);
  });

  const cases = LAYERS.flatMap((from) => LAYERS.map((to) => ({ from, to, allowed: AR1_TABLE[from].includes(to) })));

  test("the table has 16 forbidden directions and 20 allowed ones", () => {
    expect(cases.filter((c) => !c.allowed)).toHaveLength(16);
    expect(cases.filter((c) => c.allowed)).toHaveLength(20);
  });

  for (const { from, to, allowed } of cases) {
    test(`${from} -> ${to} is ${allowed ? "allowed" : "forbidden"}`, () => {
      for (const form of [
        `import { x } from "${specifier(from, to)}";`,
        `import type { X } from '${specifier(from, to)}';`,
        `export * from "${specifier(from, to)}";`,
        `const m = await import("${specifier(from, to)}");`,
      ]) {
        const expected: Violation[] = allowed
          ? []
          : [{ path: FILE[from], rule: "layer", detail: `${from} may not import ${to}` }];
        expect(checkSource(FILE[from], form)).toEqual(expected);
      }
    });
  }
});

describe("adapters", () => {
  test.each([
    ["src/adapters/forge/github/a.ts", 'import { b } from "../../agent/claude/b";', "adapters/forge/github", "adapters/agent/claude"],
    ["src/adapters/agent/claude/a.ts", 'import { b } from "../../forge/github/b";', "adapters/agent/claude", "adapters/forge/github"],
    ["src/adapters/forge/github/a.ts", 'import { b } from "../fake/b";', "adapters/forge/github", "adapters/forge/fake"],
  ])("%s importing another adapter is a violation", (path, source, from, to) => {
    expect(checkSource(path, source)).toEqual([{ path, rule: "layer", detail: `${from} may not import ${to}` }]);
  });

  test("an adapter may import within its own directory", () => {
    expect(checkSource("src/adapters/forge/github/a.ts", 'import { b } from "./sub/b";')).toEqual([]);
  });
});

describe("design-note sample", () => {
  test("core importing lane", () => {
    expect(checkSource("src/core/a.ts", 'import { x } from "../lane/y";')).toEqual([
      { path: "src/core/a.ts", rule: "layer", detail: "core may not import lane" },
    ]);
  });
});

describe("I/O matrix", () => {
  test("core imports ports (type-only)", () => {
    expect(checkSource("src/core/x.ts", 'import type {F} from "../ports/forge"')).toEqual([
      { path: "src/core/x.ts", rule: "layer", detail: "core may not import ports" },
    ]);
  });

  test("adapter cross-import", () => {
    expect(checkSource("src/adapters/forge/github/a.ts", 'import { b } from "../../agent/claude/b";')).toHaveLength(1);
  });

  test.each([
    ["const t = Date.now();", "core may not use Date.now()"],
    ["const r = await fetch(url);", "core may not use fetch"],
    ["const r = await globalThis.fetch(url);", "core may not use fetch"],
    ['Bun.spawn(["ls"]);', "core may not use Bun.spawn"],
    ['Bun.spawnSync(["ls"]);', "core may not use Bun.spawnSync"],
    ['const f = Bun.file("x");', "core may not use Bun.file"],
    ['await Bun.write("x", "y");', "core may not use Bun.write"],
    ["const home = process.env.HOME;", "core may not use process.env"],
    ["const home = Bun.env.HOME;", "core may not use Bun.env"],
    ["const home = import.meta.env.HOME;", "core may not use import.meta.env"],
    ["await Bun.$`ls`;", "core may not use Bun.$"],
    ["const re = /`/; const t = Date.now();", "core may not use Date.now()"],
    ['const re = /"/; const t = Date.now();', "core may not use Date.now()"],
    ["const re = /a\\/\\//; const t = Date.now();", "core may not use Date.now()"],
    ["const d = new Date();", "core may not use new Date()"],
    ["const d = new Date;", "core may not use new Date()"],
    ['import { readFileSync } from "node:fs";', "core may not import node:fs"],
    ['import { $ } from "bun";', "core may not import bun"],
    ['import { spawn } from "child_process";', "core may not import child_process"],
    ['const fs = require("fs");', "core may not import fs"],
  ])("core impurity: %s", (source, detail) => {
    expect(checkSource("src/core/x.ts", source)).toEqual([{ path: "src/core/x.ts", rule: "purity", detail }]);
  });

  test("core reports each impurity in one file", () => {
    const source = "const a = Date.now();\nconst b = fetch(u);\nBun.spawn([]);\nconst c = process.env.X;\nimport x from 'node:fs';";
    expect(checkSource("src/core/x.ts", source).map((v) => v.detail).sort()).toEqual(
      [
        "core may not import node:fs",
        "core may not use Bun.spawn",
        "core may not use Date.now()",
        "core may not use fetch",
        "core may not use process.env",
      ].sort(),
    );
  });

  test.each([
    "// never call Date.now()",
    "/* fetch( and Bun.spawn and process.env */",
    "/**\n * new Date() is banned; so is Bun.write\n */",
    "const x = 1; // import fs from 'node:fs'",
    'const msg = "do not call Date.now() or fetch(";',
    "const msg = `process.env is ${\"off\"} limits`;",
  ])("comment or string mention is not a violation: %j", (source) => {
    expect(checkSource("src/core/x.ts", source)).toEqual([]);
  });

  test.each([
    'import { z } from "zod";',
    'import * as z from "zod/v4";',
    'import { ok } from "./result";',
    'import { s } from "./schemas/config";',
    "const d = new Date(record.at);",
    "const t = date.now; const f = client.fetch; const g = { fetchAll: 1 };",
    "const label = `a ${`b ${c}`} d`;",
    "const re = /Date.now|fetch\\(/;",
    "const half = total / 2; const r = (a) / b / c;",
  ])("pure core is clean: %j", (source) => {
    expect(checkSource("src/core/x.ts", source)).toEqual([]);
  });

  test.each([
    ['Bun.spawn(["claude"]);', "agent adapters may not use Bun.spawn"],
    ['Bun.spawnSync(["claude"]);', "agent adapters may not use Bun.spawnSync"],
    ['import { spawn } from "node:child_process";', "agent adapters may not use child_process"],
    ['const cp = require("child_process");', "agent adapters may not use child_process"],
    ["await Bun.$`claude -p`;", "agent adapters may not use Bun.$"],
    ['import { spawn } from "bun";', 'agent adapters may not import spawn or $ from "bun"'],
    ['import { $ } from "bun";', 'agent adapters may not import spawn or $ from "bun"'],
  ])("agent spawn: %s", (source, detail) => {
    expect(checkSource("src/adapters/agent/claude/x.ts", source)).toEqual([
      { path: "src/adapters/agent/claude/x.ts", rule: "spawn", detail },
    ]);
  });

  test("agent adapter mentioning Bun.spawn in a comment is clean", () => {
    expect(checkSource("src/adapters/agent/claude/x.ts", "// the sandbox calls Bun.spawn, not us")).toEqual([]);
  });

  test("the sandbox and forge adapters may spawn", () => {
    expect(checkSource("src/sandbox/x.ts", 'Bun.spawn(["claude"]);')).toEqual([]);
    expect(checkSource("src/adapters/forge/github/x.ts", 'Bun.spawn(["git"]);')).toEqual([]);
  });
});

describe("sandbox-exec", () => {
  test.each([
    ["src/adapters/agent/claude/x.ts", 'const argv = ["sandbox-exec", "-p", profile];'],
    ["src/adapters/forge/github/x.ts", "const bin = `/usr/bin/sandbox-exec`;"],
    ["src/lane/x.ts", "const bin = '/usr/bin/sandbox-exec';"],
    ["src/cli/x.ts", 'const tool = "sandbox-exec";'],
    ["src/ports/x.ts", 'export const LAUNCHER = "sandbox-exec";'],
    ["src/core/x.ts", 'const s = "sandbox-exec";'],
  ])("%s may not name it", (path, source) => {
    expect(checkSource(path, source)).toEqual([{ path, rule: "spawn", detail: "only src/sandbox/ may name sandbox-exec" }]);
  });

  test("a file outside every layer may not name it either", () => {
    expect(checkSource("src/stray.ts", 'const s = "sandbox-exec";').map((v) => v.detail)).toEqual([
      "only src/sandbox/ may name sandbox-exec",
      "file is outside every layer",
    ]);
  });

  test("src/sandbox/ may name it", () => {
    expect(checkSource("src/sandbox/macos.ts", 'const DEFAULT = "/usr/bin/sandbox-exec";')).toEqual([]);
  });

  test("a comment elsewhere may mention it", () => {
    expect(checkSource("src/lane/x.ts", "// the sandbox runs sandbox-exec for us")).toEqual([]);
  });

  test("files outside src/ are not checked", () => {
    expect(checkSource("test/sandbox/x.ts", 'const s = "sandbox-exec";')).toEqual([]);
  });
});

describe("outside the layers", () => {
  test("a file directly under src/ is a violation", () => {
    expect(checkSource("src/stray.ts", "")).toEqual([
      { path: "src/stray.ts", rule: "layer", detail: "file is outside every layer" },
    ]);
  });

  test("core may not reach outside src/", () => {
    expect(checkSource("src/core/x.ts", 'import pkg from "../../package.json";')).toEqual([
      { path: "src/core/x.ts", rule: "layer", detail: "core may not import package.json" },
    ]);
  });

  test("cli may read package.json", () => {
    expect(checkSource("src/cli/main.ts", 'import pkg from "../../package.json" with { type: "json" };')).toEqual([]);
  });
});
