import { describe, expect, test } from "bun:test";
import { packageEdges, workspacePackagePaths } from "../../../src/core/graph/package-edges.ts";

type Files = Record<string, string>;

function snap(files: Files, extraTree: readonly string[] = []) {
  return { tree: [...Object.keys(files), ...extraTree], files };
}

const pkg = (name: string, deps: Record<string, Record<string, string>> = {}) => JSON.stringify({ name, ...deps });

const BASE: Files = {
  "package.json": JSON.stringify({ name: "root", workspaces: ["./packages/*/"] }),
  "packages/a/package.json": pkg("a"),
  "packages/b/package.json": pkg("b", { dependencies: { a: "workspace:*" } }),
  "packages/c/package.json": pkg("c", { devDependencies: { b: "1" }, peerDependencies: { a: "1" } }),
};

describe("workspacePackagePaths", () => {
  test("patterns and exclusions", () => {
    const tree = ["package.json", "packages/a/package.json", "packages/b/package.json", "packages/a/deep/package.json"];
    expect(workspacePackagePaths(tree, ["packages/*", "!packages/b"])).toEqual(["packages/a/package.json"]);
  });
});

describe("packageEdges", () => {
  test("b depends on a: edge 2 → 1", () => {
    expect(packageEdges(snap(BASE), { "1": ["a"], "2": ["b"] })).toEqual({ ok: true, value: [{ from: 2, to: 1 }] });
  });

  test("every dependency field; same-Epic and unmapped packages add none", () => {
    expect(packageEdges(snap(BASE), { "1": ["a"], "3": ["b", "c"] })).toEqual({ ok: true, value: [{ from: 3, to: 1 }] });
  });

  test.each(["devDependencies", "optionalDependencies"])("an edge from %s alone", (field) => {
    const files = { ...BASE, "packages/b/package.json": pkg("b", { [field]: { a: "1" } }) };
    expect(packageEdges(snap(files), { "1": ["a"], "2": ["b"] })).toEqual({ ok: true, value: [{ from: 2, to: 1 }] });
  });

  test("workspaces as {packages}", () => {
    const files = { ...BASE, "package.json": JSON.stringify({ workspaces: { packages: ["packages/*"] } }) };
    expect(packageEdges(snap(files), { "1": ["a"], "2": ["c"] })).toEqual({ ok: true, value: [{ from: 2, to: 1 }] });
  });

  const bad: readonly [string, ReturnType<typeof snap>, Record<string, string[]>, string, string][] = [
    ["unknown name", snap(BASE), { "1": ["zz"] }, "invalid", '"zz" is not a workspace package'],
    ["name mapped twice", snap(BASE), { "1": ["a"], "2": ["a"] }, "invalid", "mapped to Epics 1 and 2"],
    ["duplicate name", snap({ ...BASE, "packages/d/package.json": pkg("a") }), { "1": ["a"] }, "invalid", "also used by"],
    ["bad JSON", snap({ ...BASE, "packages/a/package.json": "{" }), { "1": ["a"] }, "invalid", "invalid JSON"],
    ["no name", snap({ ...BASE, "packages/a/package.json": "{}" }), { "1": ["a"] }, "invalid", "name must be"],
    ["bad workspaces", snap({ ...BASE, "package.json": '{"workspaces": "x"}' }), { "1": ["a"] }, "invalid", "workspaces"],
    ["no root", snap({ "packages/a/package.json": pkg("a") }), { "1": ["a"] }, "missing", "package.json: missing"],
    ["unread", snap(BASE, ["packages/e/package.json"]), { "1": ["a"] }, "unreadable", "packages/e/package.json: listed"],
  ];
  test.each(bad)("%s", (_name, s, map, kind, fragment) => {
    const r = packageEdges(s, map);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe(kind as "invalid");
      expect(r.error.message).toContain(fragment);
    }
  });
});
