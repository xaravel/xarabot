import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };

const ROOT = new URL("..", import.meta.url).pathname;

type Manifest = {
  name: string;
  version: string;
  type: string;
  license: string;
  bin: Record<string, string>;
  scripts: Record<string, string>;
  packageManager: string;
  engines: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const manifest: Manifest = pkg;

describe("package identity (AR36)", () => {
  test("name, version, module type and license", () => {
    expect(manifest.name).toBe("@xaravel/xarabot");
    expect(manifest.version).toBe("0.0.0");
    expect(manifest.type).toBe("module");
    expect(manifest.license).toBe("MIT");
    expect(manifest.bin).toEqual({ xarabot: "src/cli/main.ts" });
  });

  test("Bun is pinned as package manager and engine", () => {
    expect(manifest.packageManager).toBe("bun@1.4.3");
    expect(manifest.engines).toEqual({ bun: "1.4.3" });
  });

  test("dependencies are pinned exactly", () => {
    expect(manifest.dependencies).toEqual({ zod: "4.6.7" });
    expect(manifest.devDependencies).toEqual({
      "@types/bun": "1.4.3",
      oxlint: "1.89.0",
      typescript: "7.0.2",
    });
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  test("oxlint and tsc run under Bun, so `bun --bun oxlint` and `bun --bun tsc` need no node", () => {
    expect(manifest.scripts).toEqual({
      oxlint: "bun ./node_modules/oxlint/bin/oxlint",
      tsc: "bun ./node_modules/typescript/bin/tsc",
    });
  });

  test("the running Bun is 1.4.3", () => {
    expect(Bun.version).toBe("1.4.3");
  });
});

const FORBIDDEN_DEPS = [
  /^node$/,
  /^npm$/,
  /^pnpm$/,
  /^jest$/,
  /^@jest\//,
  /^ts-jest$/,
  /^vitest$/,
  /^@vitest\//,
  /^eslint$/,
  /^eslint-/,
  /^@eslint\//,
  /^@typescript-eslint\//,
  /^prettier$/,
  /^prettier-/,
];

const FORBIDDEN_FILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lockb",
  ".npmrc",
  ".nvmrc",
  ".node-version",
  "jest.config.js",
  "jest.config.ts",
  "jest.config.mjs",
  "jest.config.cjs",
  "jest.config.json",
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.config.mts",
  "vitest.config.mjs",
  "vitest.workspace.ts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  ".eslintignore",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  ".prettierrc",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierignore",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
];

describe("no forbidden tooling", () => {
  test("no forbidden dependency", () => {
    const names = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ];
    const bad = names.filter((n) => FORBIDDEN_DEPS.some((re) => re.test(n)));
    expect(bad).toEqual([]);
  });

  test("no jest, eslint or prettier key in package.json", () => {
    const keys = Object.keys(pkg);
    expect(keys.filter((k) => ["jest", "eslintConfig", "prettier", "vitest"].includes(k))).toEqual([]);
  });

  test("bun.lock is the only lockfile and no forbidden config exists", () => {
    expect(existsSync(`${ROOT}bun.lock`)).toBe(true);
    const present = readdirSync(ROOT).filter((f) => FORBIDDEN_FILES.includes(f));
    expect(present).toEqual([]);
  });
});
