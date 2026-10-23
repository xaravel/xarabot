import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DEFAULT_GRAPH_CONFIG,
  graphInputPaths,
  resolveGraph,
  type GraphConfig,
  type GraphSnapshot,
} from "../../../src/core/graph/resolve-graph.ts";

const MD = DEFAULT_GRAPH_CONFIG.epics_path;
const YAML = ".xarabot/epics.yaml";
const RETRO = DEFAULT_GRAPH_CONFIG.retro_gates_path;
const MANIFESTS: GraphConfig = { ...DEFAULT_GRAPH_CONFIG, manifests: { dir: "stories" } };

/** An `epics.md` with the given Epics, each holding the given Story numbers. */
function epicsMd(epics: Record<number, readonly string[]>, title = "Title"): string {
  const parts = ["# Epics", "", "## Epic List", "", "- Epic 1: list entry", ""];
  for (const [n, stories] of Object.entries(epics)) {
    parts.push(`## Epic ${n}: ${title} ${n}`, "");
    for (const s of stories) parts.push(`### Story ${n}.${s}: Story ${n}.${s}`, "", "Body.", "");
  }
  return parts.join("\n");
}

function manifest(id: string, epic: number, dependsOn: readonly string[] = []): string {
  const deps = dependsOn.length === 0 ? "" : `depends_on: [${dependsOn.map((d) => `"${d}"`).join(", ")}]\n`;
  return `---\nstory_id: "${id}"\nepic: ${epic}\nsprint_key: k-${id}\ntitle: T\nglobs: [src/${id}/**]\n${deps}---\n`;
}

function snap(files: Record<string, string>, config: GraphConfig = DEFAULT_GRAPH_CONFIG): GraphSnapshot {
  return { tree: Object.keys(files), files, config };
}

function graph(s: GraphSnapshot) {
  const r = resolveGraph(s);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const depsOf = (s: GraphSnapshot) => Object.fromEntries(graph(s).epics.map((e) => [e.number, e.depends_on]));

const THREE = epicsMd({ 1: ["1"], 2: ["1"], 3: ["1"] });
const SEVEN = epicsMd({ 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] });

describe("resolveGraph: effective Epic dependencies", () => {
  test("no file: serial, no checkpoints", () => {
    const g = graph(snap({ [MD]: THREE }));
    expect(g.epics.map((e) => [e.number, e.depends_on])).toEqual([[1, []], [2, [1]], [3, [2]]]);
    expect(g.edges).toEqual([{ from: 2, to: 1 }, { from: 3, to: 2 }]);
    expect(g.checkpoints).toEqual([]);
    expect(g.epics[0]?.title).toBe("Title 1");
  });

  test("this repo's file", () => {
    const s = snap({ [MD]: SEVEN, [YAML]: "version: 1\nepics:\n  6:\n    depends_on: [4]\n  7:\n    depends_on: [5, 6]\n" });
    expect(depsOf(s)).toEqual({ 1: [], 2: [1], 3: [2], 4: [3], 5: [4], 6: [4], 7: [5, 6] });
  });

  test("listed without deps: default dependency and the checkpoint", () => {
    const g = graph(snap({ [MD]: THREE, [YAML]: "version: 1\nepics:\n  3: {checkpoint: true}\n" }));
    expect(g.epics[2]).toMatchObject({ number: 3, depends_on: [2], checkpoint: true });
    expect(g.checkpoints).toEqual([3]);
  });

  test("gap in numbers", () => {
    expect(depsOf(snap({ [MD]: epicsMd({ 1: [], 3: [], 7: [] }) }))).toEqual({ 1: [], 3: [1], 7: [3] });
  });

  test("this repo's real epics.md and .xarabot/epics.yaml", async () => {
    const root = join(import.meta.dir, "../../..");
    const md = await Bun.file(join(import.meta.dir, "../../fixtures/epics.md")).text();
    const yaml = await Bun.file(join(root, YAML)).text();
    expect(depsOf(snap({ [MD]: md, [YAML]: yaml }))).toEqual({ 1: [], 2: [1], 3: [2], 4: [3], 5: [4], 6: [4], 7: [5, 6] });
  });
});

describe("resolveGraph: package edges", () => {
  const files = {
    [MD]: THREE,
    [YAML]: "version: 1\nepics:\n  2: {depends_on: []}\n",
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    "packages/a/package.json": JSON.stringify({ name: "a" }),
    "packages/b/package.json": JSON.stringify({ name: "b", dependencies: { a: "*" } }),
  };

  test("map {1: [a], 2: [b]}, b depends on a: edge 2 → 1", () => {
    expect(depsOf(snap(files, { ...DEFAULT_GRAPH_CONFIG, epic_packages: { "1": ["a"], "2": ["b"] } }))[2]).toEqual([1]);
  });

  test("no map: no package edges", () => {
    expect(depsOf(snap(files))[2]).toEqual([]);
  });

  test("unknown name is invalid", () => {
    const r = resolveGraph(snap(files, { ...DEFAULT_GRAPH_CONFIG, epic_packages: { "1": ["zz"] } }));
    expect(r.ok ? "ok" : r.error.kind).toBe("invalid");
  });

  test("package edges join cycle detection", () => {
    const cyclic = { ...files, [YAML]: "version: 1\nepics:\n  1: {depends_on: [2]}\n  2: {depends_on: []}\n" };
    const r = resolveGraph(snap(cyclic, { ...DEFAULT_GRAPH_CONFIG, epic_packages: { "1": ["a"], "2": ["b"] } }));
    expect(r.ok ? "ok" : r.error.message).toBe("graph: cycle among Epics 1 → 2 → 1");
  });
});

describe("resolveGraph: Story sets and unmanifested headings", () => {
  test("Story set order and unmanifested report", () => {
    const md = epicsMd({ 1: ["1"], 2: ["6", "6a", "10", "1"] });
    const s = snap(
      { [MD]: md, "stories/a.md": manifest("2.6a", 2), "stories/b.md": manifest("2.10", 2), "stories/c.md": manifest("2.6", 2) },
      { ...MANIFESTS, bootstrapped_epics: [1] },
    );
    const g = graph(s);
    expect(g.epics[1]?.stories).toEqual(["2.6", "2.6a", "2.10"]);
    expect(g.epics[0]?.stories).toEqual([]);
    expect(g.unmanifested).toEqual([{ id: "2.1", epic: 2, line: expect.any(Number) }]);
  });

  test("without bootstrapped_epics every heading with no manifest is reported", () => {
    expect(graph(snap({ [MD]: THREE })).unmanifested.map((u) => u.id)).toEqual(["1.1", "2.1", "3.1"]);
  });

  test("Story deps across Epics along transitive edges are fine", () => {
    const md = epicsMd({ 1: ["2"], 2: ["1"], 3: ["1"] });
    const s = snap({ [MD]: md, "stories/a.md": manifest("3.1", 3, ["1.2", "2.1"]) }, MANIFESTS);
    expect(resolveGraph(s).ok).toBe(true);
  });
});

describe("resolveGraph: id join by numeric value", () => {
  test('manifest "02.1" with zero-padded depends_on joins heading 2.1', () => {
    const md = epicsMd({ 1: ["2"], 2: ["1"] });
    const g = graph(snap({ [MD]: md, "stories/a.md": manifest("02.1", 2, ["01.02"]) }, MANIFESTS));
    expect(g.epics[1]?.stories).toEqual(["02.1"]);
    expect(g.unmanifested.map((u) => u.id)).toEqual(["1.2"]);
  });
});

describe("resolveGraph: hash", () => {
  test("exact digest for a fixed graph", () => {
    expect(graph(snap({ [MD]: THREE })).hash).toBe("sha256:c73eb4eb18ce4077dda44cc433c894c7d53f48bc8e482e3872bfdb559d10948b");
  });

  test("titles do not change it; edges, checkpoints and Story sets do", () => {
    const base = graph(snap({ [MD]: THREE })).hash;
    expect(base).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(graph(snap({ [MD]: epicsMd({ 1: ["1"], 2: ["1"], 3: ["1"] }, "Renamed") })).hash).toBe(base);
    expect(graph(snap({ [MD]: THREE, [YAML]: "version: 1\nepics:\n  3: {depends_on: [1]}\n" })).hash).not.toBe(base);
    expect(graph(snap({ [MD]: THREE, [YAML]: "version: 1\nepics:\n  3: {checkpoint: true}\n" })).hash).not.toBe(base);
    expect(graph(snap({ [MD]: THREE, "stories/a.md": manifest("1.1", 1) }, MANIFESTS)).hash).not.toBe(base);
    expect(graph(snap({ [MD]: THREE }, { ...DEFAULT_GRAPH_CONFIG, bootstrapped_epics: [1] })).hash).toBe(base);
  });
});

describe("resolveGraph: retro gates", () => {
  test("absent: empty; present: parsed", () => {
    expect(graph(snap({ [MD]: THREE })).retroGates).toEqual({ schema_version: 1, epics: {} });
    const text = "schema_version: 1\nepics:\n  1:\n    checkpoint:\n      go: {by: edanisko, at: 2026-11-03T09:00:00Z, ruling: maintainer-pr}\n";
    expect(graph(snap({ [MD]: THREE, [RETRO]: text })).retroGates.epics["1"]?.checkpoint?.go.ruling).toBe("maintainer-pr");
  });
});

describe("resolveGraph: failures", () => {
  const cases: readonly [string, GraphSnapshot, string, string][] = [
    ["no epics.md", snap({}), "missing", MD],
    ["unread epics.md", { tree: [MD], files: {}, config: DEFAULT_GRAPH_CONFIG }, "unreadable", MD],
    ["unread epics.yaml", { tree: [MD, YAML], files: { [MD]: THREE }, config: DEFAULT_GRAPH_CONFIG }, "unreadable", YAML],
    ["bad epics.md", snap({ [MD]: "## Epic 1: a\n### Story 2.1: b\n" }), "invalid", MD],
    ["bad epics.yaml", snap({ [MD]: THREE, [YAML]: "version: 1\nepics:\n" }), "invalid", YAML],
    ["version 2", snap({ [MD]: THREE, [YAML]: "version: 2\nepics: {}\n" }), "unsupported-version", YAML],
    ["bad retro-gates", snap({ [MD]: THREE, [RETRO]: "schema_version: 1\nepics: []\n" }), "invalid", RETRO],
    ["unknown key", snap({ [MD]: THREE, [YAML]: "version: 1\nepics:\n  9: {}\n" }), "unknown-epic", "Epic 9"],
    ["unknown dep", snap({ [MD]: THREE, [YAML]: "version: 1\nepics:\n  2: {depends_on: [9]}\n" }), "unknown-epic", "Epic 9"],
    ["unknown bootstrapped", snap({ [MD]: THREE }, { ...DEFAULT_GRAPH_CONFIG, bootstrapped_epics: [9] }), "unknown-epic", "bootstrapped_epics"],
    ["unknown package key", snap({ [MD]: THREE }, { ...DEFAULT_GRAPH_CONFIG, epic_packages: { "9": ["a"] } }), "unknown-epic", "epic_packages"],
    ["two-cycle", snap({ [MD]: THREE, [YAML]: "version: 1\nepics:\n  2: {depends_on: [3]}\n  3: {depends_on: [2]}\n" }), "cycle", "2 → 3 → 2"],
    ["self-cycle", snap({ [MD]: THREE, [YAML]: "version: 1\nepics:\n  1: {depends_on: [1]}\n" }), "cycle", "1 → 1"],
    ["manifest with no heading", snap({ [MD]: THREE, "stories/a.md": manifest("2.9", 2) }, MANIFESTS), "manifest-heading", "stories/a.md: "],
    ["manifest epic mismatch", snap({ [MD]: THREE, "stories/a.md": manifest("2.1", 1) }, MANIFESTS), "invalid", "stories/a.md: "],
    ["manifest bad yaml", snap({ [MD]: THREE, "stories/a.md": "---\na: [\n---\n" }, MANIFESTS), "invalid", "stories/a.md: "],
    ["duplicate manifests", snap({ [MD]: THREE, "stories/a.md": manifest("2.1", 2), "stories/b.md": manifest("2.1", 2) }, MANIFESTS), "invalid", "stories/b.md: "],
    ["unknown Story dep", snap({ [MD]: THREE, "stories/a.md": manifest("2.1", 2, ["2.9"]) }, MANIFESTS), "story-dependency", "2.9"],
    ["Story dep outside the Epic's deps", snap({ [MD]: THREE, "stories/a.md": manifest("2.1", 2, ["3.1"]) }, MANIFESTS), "story-dependency", "Epic 3"],
    [
      "Story cycle",
      snap({ [MD]: epicsMd({ 2: ["1", "2"] }), "stories/a.md": manifest("2.1", 2, ["2.2"]), "stories/b.md": manifest("2.2", 2, ["2.1"]) }, MANIFESTS),
      "story-dependency",
      "graph: Story dependency cycle 2.1 → 2.2 → 2.1",
    ],
    [
      "Story self-dependency",
      snap({ [MD]: THREE, "stories/a.md": manifest("2.1", 2, ["2.1"]) }, MANIFESTS),
      "story-dependency",
      "stories/a.md: Story dependency cycle 2.1 → 2.1",
    ],
    [
      "numerically equal story ids",
      snap({ [MD]: epicsMd({ 2: ["6"] }), "stories/a.md": manifest("2.6", 2), "stories/b.md": manifest("02.06", 2) }, MANIFESTS),
      "invalid",
      'stories/b.md: story_id "02.06" duplicates stories/a.md',
    ],
  ];
  test.each(cases)("%s", (_name, s, kind, fragment) => {
    const r = resolveGraph(s);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe(kind as "invalid");
      expect(r.error.message).toContain(fragment);
      expect(r.error.message).toMatch(/^(?:graph|[^\s:]+): /);
    }
  });
});

describe("graphInputPaths", () => {
  test("reads only graph inputs that are in the tree", () => {
    const tree = [MD, YAML, "stories/a.md", "stories/sub/b.md", "stories/c.txt", "src/x.ts", "package.json", "packages/a/package.json"];
    expect(graphInputPaths(tree, MANIFESTS)).toEqual([YAML, MD, "stories/a.md"]);
    expect(graphInputPaths(tree, { ...DEFAULT_GRAPH_CONFIG, epic_packages: { "1": ["a"] } })).toEqual([
      YAML,
      MD,
      "package.json",
      "packages/a/package.json",
    ]);
  });
});
