import { describe, expect, test } from "bun:test";
import {
  checkGraphChange,
  graphDeltaComment,
  graphReadPaths,
  graphRefusalComment,
  graphSettings,
  type GraphChange,
  type GraphDelta,
} from "../../../src/core/graph/graph-gate.ts";
import { FORGE_TEXT_LIMITS } from "../../../src/core/sanitize.ts";
import { GRAPH_CONFIG, GRAPH_EPICS, GRAPH_RETRO_GATES, GRAPH_STATUS, graphFiles, manifest, treeOf } from "../../lane/graph-stub.ts";

const YAML = ".xarabot/epics.yaml";
const CONFIG = ".xarabot/config.yaml";

type Files = Record<string, string>;

function check(main: Files, merged: Files, ledgerUnits: readonly string[] = []): GraphChange {
  return checkGraphChange({ main: treeOf(main), merged: treeOf(merged), ledgerUnits });
}

function checked(main: Files, merged: Files, ledgerUnits: readonly string[] = []) {
  const r = check(main, merged, ledgerUnits);
  if (r.kind !== "checked") throw new Error(`${r.kind}: ${r.message}`);
  return r;
}

/** `files` without `paths`. */
function without(files: Files, ...paths: string[]): Files {
  const out = { ...files };
  for (const p of paths) delete out[p];
  return out;
}

const status = (entries: Readonly<Record<string, string>>) =>
  `development_status:\n${Object.entries(entries).map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n`;

const RETRO_2 = 'schema_version: 1\nepics:\n  2:\n    retro:\n      verdict: accepted\n      unit: "retro:2"\n      recorded_at: "2026-10-01T00:00:00Z"\n';
const GO_2 = 'schema_version: 1\nepics:\n  2:\n    checkpoint:\n      go:\n        by: edanisko\n        at: "2026-10-01T00:00:00Z"\n        ruling: maintainer-pr\n';

const TWO = { 1: ["1.1"], 2: ["2.1", "2.7", "2.12"] } as const;
const SEVEN = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] } as const;

describe("graphSettings and graphReadPaths", () => {
  test("the config's graph fields, sprint_status_path and branches.story", () => {
    const s = graphSettings(`${GRAPH_CONFIG}bootstrapped_epics: [1]\nbranches:\n  story: feature/\n`);
    if (!s.ok) throw new Error(s.error.message);
    expect(s.value.graph).toMatchObject({ epics_path: GRAPH_EPICS, bootstrapped_epics: [1], manifests: { dir: "stories" } });
    expect(s.value.sprintStatusPath).toBe(GRAPH_STATUS);
    expect(s.value.storyBranch).toBe("feature/");
  });

  test.each([
    ["invalid YAML", "a: [", "invalid-yaml"],
    ["a missing maintainer", "schema_version: 1\nrunner_version: x\nstanding_authority_path: a.md\n", "invalid"],
    ["a newer version", "schema_version: 2\n", "unsupported-version"],
  ])("%s is %s", (_name, text, kind) => {
    const s = graphSettings(text);
    expect(s.ok ? "ok" : s.error.kind).toBe(kind);
  });

  test("the config, the graph inputs and the status file, sorted; nothing else", () => {
    const files = graphFiles({ 1: ["1.1"] }, { [GRAPH_STATUS]: "x", [YAML]: "x", "src/a.ts": "x", "stories/nested/x.md": "x" });
    const tree = Object.keys(files);
    expect(graphReadPaths(tree, files[CONFIG] as string)).toEqual([CONFIG, YAML, GRAPH_EPICS, GRAPH_STATUS, "stories/1.1.md"].sort());
  });

  test("with no config text, or one that does not parse, only the config", () => {
    const tree = Object.keys(graphFiles({ 1: ["1.1"] }));
    expect(graphReadPaths(tree, null)).toEqual([CONFIG]);
    expect(graphReadPaths(tree, "a: [")).toEqual([CONFIG]);
    expect(graphReadPaths(["x"], null)).toEqual([]);
  });

  test("epic_packages adds every package.json", () => {
    const files = { [CONFIG]: `${GRAPH_CONFIG}epic_packages:\n  "1": [a]\n`, "package.json": "{}", "packages/a/package.json": "{}", "x/y.json": "{}" };
    expect(graphReadPaths(Object.keys(files), files[CONFIG])).toEqual([CONFIG, "package.json", "packages/a/package.json"]);
  });
});

describe("checkGraphChange: changes", () => {
  test("unchanged: equal hashes, an empty delta, nothing refused", () => {
    const main = graphFiles(TWO);
    const r = checked(main, { ...main, "src/a.ts": "changed\n" });
    expect(r.changed).toBe(false);
    expect(r.mainHash).toBe(r.mergedHash);
    expect(r.refusals).toEqual([]);
    expect(r.branchChecks).toEqual([]);
    expect(r.delta).toMatchObject({ edgesAdded: [], edgesRemoved: [], epicsAdded: [], storiesAdded: [], storiesRemoved: [], hash: r.mergedHash });
  });

  test("a Story added: a new manifest 2.13 in Epic 2 (no retro)", () => {
    const main = graphFiles(TWO);
    const r = checked(main, graphFiles({ ...TWO, 2: [...TWO[2], "2.13"] }));
    expect(r.changed).toBe(true);
    expect(r.refusals).toEqual([]);
    expect(r.delta.storiesAdded).toEqual([{ epic: 2, ids: ["2.13"] }]);
    expect(graphDeltaComment("Story 2.13", { delta: r.delta, maintainer: "edanisko" })).toContain("+2.13");
  });

  test("an edge and a checkpoint: 3 → 2 removed, 3 → 1 added, checkpoint 3 added, holding Epics 4–7", () => {
    const main = graphFiles(SEVEN);
    const r = checked(main, { ...main, [YAML]: "version: 1\nepics:\n  3: {depends_on: [1], checkpoint: true}\n" });
    expect(r.changed).toBe(true);
    expect(r.refusals).toEqual([]);
    expect(r.delta.edgesAdded).toEqual([{ from: 3, to: 1 }]);
    expect(r.delta.edgesRemoved).toEqual([{ from: 3, to: 2 }]);
    expect(r.delta.checkpointsAdded).toEqual([3]);
    expect(r.delta.checkpointsRemoved).toEqual([]);
    expect(r.delta.holds).toEqual([{ checkpoint: 3, epics: [4, 5, 6, 7] }]);
    const text = graphDeltaComment("Unit planning:graph.1", { delta: r.delta, maintainer: "edanisko" });
    expect(text).toContain("- Edges added: 3 → 1");
    expect(text).toContain("- Edges removed: 3 → 2");
    expect(text).toContain("- Checkpoints added: 3");
    expect(text).toContain("- Checkpoint 3 (no go recorded) holds Epics 4, 5, 6, 7");
    expect(text).toContain(r.mergedHash);
  });

  test("a recorded checkpoint go holds nothing in the delta", () => {
    const main = graphFiles(SEVEN, { [GRAPH_RETRO_GATES]: GO_2.replaceAll("2:", "3:") });
    const r = checked(main, { ...main, [YAML]: "version: 1\nepics:\n  3: {checkpoint: true}\n" });
    expect(r.delta.checkpointsAdded).toEqual([3]);
    expect(r.delta.holds).toEqual([]);
  });

  test("a package edge: epic_packages set, a package.json dependency added", () => {
    const config = `${GRAPH_CONFIG}epic_packages:\n  "1": [a]\n  "2": [b]\n`;
    const main: Files = {
      ...graphFiles({ 1: [], 2: [] }),
      [CONFIG]: config,
      [YAML]: "version: 1\nepics:\n  2: {depends_on: []}\n",
      "package.json": '{"workspaces": ["packages/*"]}',
      "packages/a/package.json": '{"name": "a"}',
      "packages/b/package.json": '{"name": "b"}',
    };
    const r = checked(main, { ...main, "packages/b/package.json": '{"name": "b", "dependencies": {"a": "*"}}' });
    expect(r.changed).toBe(true);
    expect(r.delta.edgesAdded).toEqual([{ from: 2, to: 1 }]);
    expect(r.refusals).toEqual([]);
  });

  test("an unused Story removed (backlog, no record): changed, not refused, left for the branch PR check", () => {
    const main = graphFiles(TWO, { [GRAPH_STATUS]: status({ "epic-2": "in-progress", "2-12-s": "backlog" }) });
    const merged = { ...without(main, "stories/2.12.md"), [GRAPH_EPICS]: graphFiles({ 1: ["1.1"], 2: ["2.1", "2.7"] })[GRAPH_EPICS] as string };
    const r = checked(main, merged, ["story:1.1"]);
    expect(r.changed).toBe(true);
    expect(r.refusals).toEqual([]);
    expect(r.delta.storiesRemoved).toEqual([{ epic: 2, ids: ["2.12"] }]);
    expect(r.branchChecks).toEqual([{ id: "2.12", branch: "story/2.12" }]);
  });

  test("an Epic added", () => {
    const main = graphFiles({ 1: ["1.1"] });
    const r = checked(main, graphFiles({ 1: ["1.1"], 2: [] }));
    expect(r.delta.epicsAdded).toEqual([2]);
    expect(r.delta.edgesAdded).toEqual([{ from: 2, to: 1 }]);
  });
});

describe("checkGraphChange: invalid sides", () => {
  test("a merge result with a cycle is invalid", () => {
    const main = graphFiles(SEVEN);
    const r = check(main, { ...main, [YAML]: "version: 1\nepics:\n  1: {depends_on: [2]}\n" });
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") expect(r.message).toContain("cycle");
  });

  test.each([
    ["a missing config", (f: Files) => without(f, CONFIG)],
    ["an invalid config", (f: Files) => ({ ...f, [CONFIG]: "schema_version: 1\n" })],
    ["a manifest with no heading", (f: Files) => ({ ...f, "stories/9.9.md": manifest("9.9", 9) })],
    ["an unreadable input", (f: Files) => ({ ...f, "stories/1.2.md": undefined as unknown as string })],
  ])("a merge result with %s is invalid", (_name, change) => {
    const main = graphFiles(TWO);
    expect(check(main, change({ ...main })).kind).toBe("invalid");
  });

  test("main not resolving is main-invalid, whatever the merge result", () => {
    const main = graphFiles(TWO);
    expect(check(without(main, CONFIG), main).kind).toBe("main-invalid");
    expect(check({ ...main, [GRAPH_STATUS]: "development_status: [" }, main).kind).toBe("main-invalid");
  });
});

describe("checkGraphChange: refusals", () => {
  const dropped = (main: Files, epics: Readonly<Record<number, readonly string[]>>, ...gone: string[]): Files => ({
    ...without(main, ...gone),
    [GRAPH_EPICS]: graphFiles(epics)[GRAPH_EPICS] as string,
  });

  test.each([
    ["its sprint key is done", { [GRAPH_STATUS]: status({ "2-7-s": "done" }) }, []],
    ["its sprint key is ready-for-dev", { [GRAPH_STATUS]: status({ "2-7-s": "ready-for-dev" }) }, []],
    ["it has a story: ledger record", {}, ["story:2.7"]],
  ] as const)("a used Story removed (heading 2.7 dropped): %s", (_name, extra, units) => {
    const main = graphFiles(TWO, extra);
    const r = checked(main, dropped(main, { 1: ["1.1"], 2: ["2.1", "2.12"] }, "stories/2.7.md"), units);
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]).toContain("Story 2.7 is removed, but it is used");
    expect(r.branchChecks).toEqual([]);
  });

  test("a Story with no manifest is used through any <epic>-<n>-… key beyond backlog", () => {
    const main = { ...without(graphFiles(TWO), "stories/2.7.md"), [GRAPH_STATUS]: status({ "2-7-old-name": "in-progress" }) };
    const r = checked(main, dropped(main, { 1: ["1.1"], 2: ["2.1", "2.12"] }));
    expect(r.refusals).toEqual(["Story 2.7 is removed, but it is used: 2-7-old-name is in-progress"]);
  });

  test("a backlog key does not make a Story used", () => {
    const main = graphFiles(TWO, { [GRAPH_STATUS]: status({ "2-7-s": "backlog" }) });
    const r = checked(main, dropped(main, { 1: ["1.1"], 2: ["2.1", "2.12"] }, "stories/2.7.md"));
    expect(r.refusals).toEqual([]);
    expect(r.branchChecks).toEqual([{ id: "2.7", branch: "story/2.7" }]);
  });

  test.each([
    ["epic-3 is beyond backlog", { [GRAPH_STATUS]: status({ "epic-3": "in-progress" }) }, []],
    ["retro-gates.yaml has an entry", { [GRAPH_RETRO_GATES]: RETRO_2.replaceAll("2", "3") }, []],
    ["a retro:3 record", {}, ["retro:3"]],
    ["a checkpoint:3 record", {}, ["checkpoint:3"]],
    ["a retro-item record", {}, ["retro-item:epic-3-retro-item-1-fix"]],
  ] as const)("a used Epic removed: %s", (_name, extra, units) => {
    const main = graphFiles({ 1: ["1.1"], 2: [], 3: [] }, extra);
    const r = checked(main, dropped(main, { 1: ["1.1"], 2: [] }), units);
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]).toContain("Epic 3 is removed, but it is used");
  });

  test("an unused Epic removed is changed, not refused", () => {
    const main = graphFiles({ 1: ["1.1"], 2: [], 3: [] }, { [GRAPH_STATUS]: status({ "epic-3": "backlog" }) });
    const r = checked(main, dropped(main, { 1: ["1.1"], 2: [] }), ["retro:2"]);
    expect(r.refusals).toEqual([]);
    expect(r.delta.epicsRemoved).toEqual([3]);
  });

  test("a retro'd Epic grows: Epic 2's retro recorded, a Story added", () => {
    const main = graphFiles(TWO, { [GRAPH_RETRO_GATES]: RETRO_2 });
    const r = checked(main, { ...graphFiles({ ...TWO, 2: [...TWO[2], "2.13"] }), [GRAPH_RETRO_GATES]: RETRO_2 });
    expect(r.refusals).toEqual(["Story 2.13 is new to Epic 2, whose retro is recorded"]);
  });

  test("a bootstrapped Epic grows: a heading added to Epic 1", () => {
    const config = `${GRAPH_CONFIG}bootstrapped_epics: [1]\n`;
    const main = { ...graphFiles(TWO), [CONFIG]: config };
    const merged = { ...main, [GRAPH_EPICS]: graphFiles({ 1: ["1.1", "1.2"], 2: TWO[2] })[GRAPH_EPICS] as string };
    const r = checked(main, merged);
    expect(r.refusals).toEqual(["Story 1.2 is new to Epic 1, which is bootstrapped"]);
  });

  test("a checkpoint retired with no go is refused; with the go recorded it is only a change", () => {
    const main = graphFiles(SEVEN, { [YAML]: "version: 1\nepics:\n  2: {checkpoint: true}\n" });
    const retired = { ...main, [YAML]: "version: 1\nepics: {}\n" };
    const refused = checked(main, retired);
    expect(refused.refusals).toEqual(["Epic 2's checkpoint is removed, but its go is not recorded"]);
    const withGo = { ...main, [GRAPH_RETRO_GATES]: GO_2 };
    const ok = checked(withGo, { ...retired, [GRAPH_RETRO_GATES]: GO_2 });
    expect(ok.refusals).toEqual([]);
    expect(ok.changed).toBe(true);
    expect(ok.delta.checkpointsRemoved).toEqual([2]);
  });

  test("a refusal is reported whether or not the hash changed", () => {
    // Epic 3 removed and re-added under the same number cannot keep the hash; a retro'd Epic gaining an unmanifested heading does.
    const main = graphFiles(TWO, { [GRAPH_RETRO_GATES]: RETRO_2 });
    const merged = { ...main, [GRAPH_EPICS]: graphFiles({ 1: ["1.1"], 2: [...TWO[2], "2.13"] })[GRAPH_EPICS] as string };
    const r = checked(main, merged);
    expect(r.changed).toBe(false);
    expect(r.refusals).toEqual(["Story 2.13 is new to Epic 2, whose retro is recorded"]);
  });
});

describe("graph comments", () => {
  const delta = (over: Partial<GraphDelta> = {}): GraphDelta => ({
    edgesAdded: [],
    edgesRemoved: [],
    checkpointsAdded: [],
    checkpointsRemoved: [],
    epicsAdded: [],
    epicsRemoved: [],
    storiesAdded: [],
    storiesRemoved: [],
    holds: [],
    hash: `sha256:${"a".repeat(64)}`,
    ...over,
  });

  test("the delta comment: 🤖, the Maintainer in backticks with no @, the delta, then the gated paths", () => {
    const text = graphDeltaComment("Story 2.13", {
      delta: delta({ storiesAdded: [{ epic: 2, ids: ["2.13"] }], storiesRemoved: [{ epic: 3, ids: ["3.1"] }], epicsAdded: [4], epicsRemoved: [5], checkpointsRemoved: [6] }),
      maintainer: "@edanisko",
      gatedPaths: ["stories/2.13.md", "@someone/x"],
    });
    expect(text.startsWith("🤖 Story 2.13:")).toBe(true);
    expect(text).toContain("(`edanisko`)");
    expect(text).not.toContain("@");
    expect(text).toContain("- Stories added: Epic 2: +2.13");
    expect(text).toContain("- Stories removed: Epic 3: -3.1");
    expect(text).toContain("- Epics added: 4");
    expect(text).toContain("- Epics removed: 5");
    expect(text).toContain("- Checkpoints removed: 6");
    expect(text).toContain(`The merge result's graph hash is \`sha256:${"a".repeat(64)}\`.`);
    // The hash is in the lead paragraph, ahead of the delta and the gated paths.
    expect(text.indexOf("graph hash is")).toBeLessThan(text.indexOf("The Epic graph against"));
    expect(text.indexOf("graph hash is")).toBeLessThan(text.indexOf("stories/2.13.md"));
    expect(text).toContain("another owner's approval does not");
  });

  test("the voided comment asks for a new approval and carries the new delta", () => {
    const text = graphDeltaComment("Unit planning:graph.2", { delta: delta({ edgesAdded: [{ from: 3, to: 1 }] }), maintainer: "edanisko", voided: true });
    expect(text).toContain("no longer counts");
    expect(text).toContain("A new approval of its current head from the Maintainer (`edanisko`)");
    expect(text).toContain("- Edges added: 3 → 1");
  });

  test("the refusal comment names each refusal, sanitized", () => {
    const text = graphRefusalComment("Unit planning:graph.2", ["Story 2.7 is removed, but it is used: 2-7-s is done", "ping @someone\nnext"]);
    expect(text.startsWith("🤖 Unit planning:graph.2:")).toBe(true);
    expect(text).toContain("blocked (graph-invalid)");
    expect(text).toContain("- Story 2.7 is removed, but it is used: 2-7-s is done");
    expect(text).toContain("- ping someone next");
  });

  test("both are capped at the comment limit", () => {
    const many = Array.from({ length: 5000 }, (_, i) => `Story 9.${i + 1} is removed, but it is used: a long reason to fill the comment`);
    expect(graphRefusalComment("Unit x", many).length).toBeLessThanOrEqual(FORGE_TEXT_LIMITS.comment);
    const big = delta({ storiesAdded: [{ epic: 9, ids: Array.from({ length: 20000 }, (_, i) => `9.${i + 1}`) }] });
    const capped = graphDeltaComment("Unit x", { delta: big, maintainer: "m", gatedPaths: ["stories/9.1.md"] });
    expect(capped.length).toBeLessThanOrEqual(FORGE_TEXT_LIMITS.comment);
    expect(capped).toContain("[truncated by xarabot]");
    // The cap cuts the delta's tail, never the hash the Maintainer approves.
    expect(capped).toContain(`graph hash is \`${big.hash}\``);
  });
});
