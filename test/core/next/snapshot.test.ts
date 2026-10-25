import { describe, expect, test } from "bun:test";
import { assembleSnapshot, epicContextState } from "../../../src/core/next/snapshot.ts";
import { SnapshotSchema } from "../../../src/core/schemas/snapshot.ts";
import { tip } from "../ledger/fixtures.ts";
import {
  CONFIG_PATH,
  contextPath,
  input,
  LEDGER_SHA,
  MAIN_SHA,
  manifestPath,
  RETRO,
  shaOf,
  snapshotOf,
  STATUS,
  storyRec,
  type World,
} from "./fixtures.ts";

const BASE: World = { epics: { 1: [], 2: ["1", "2"] }, bootstrapped: [1] };

describe("epicContextState", () => {
  const cases: [string | null, string][] = [
    [null, "missing"],
    ["", "empty"],
    ["  \n\n", "empty"],
    ["# Epic 2 Context: Goal\n", "valid"],
    ["﻿# Epic 2 Context: Goal\n", "valid"],
    ["# Epic 2 Context:", "valid"],
    ["# Epic 2 context: Goal\n", "wrong-heading"],
    ["# Epic 20 Context: Goal\n", "wrong-heading"],
    ["\n# Epic 2 Context: Goal\n", "wrong-heading"],
    ["## Epic 2 Context: Goal\n", "wrong-heading"],
  ];
  for (const [text, state] of cases) {
    test(`${JSON.stringify(text)} → ${state}`, () => expect<string>(epicContextState(2, text)).toBe(state));
  }
});

describe("assembleSnapshot: fields", () => {
  test("a valid world carries every AR28 field", () => {
    const s = snapshotOf({
      ...BASE,
      records: [storyRec("2.2", { state: "claimed" }), storyRec("2.1", { state: "released" })],
      status: { "2.1": "in-progress" },
      retro: { 2: "accepted" },
      escalations: ["2.2"],
    });
    expect(Object.keys(s).sort()).toEqual(
      [
        "now", "main_sha", "ledger", "config", "policy", "standing_authority", "manifests", "graph",
        "sprint_status", "retro_gates", "escalations", "epic_context", "live_evidence", "prs", "lane", "role",
      ].sort(),
    );
    expect(s.main_sha).toBe(MAIN_SHA);
    expect(s.ledger.tip).toBe(LEDGER_SHA);
    expect(s.ledger.units.map((u) => u.unit)).toEqual(["story:2.1", "story:2.2"]);
    expect(s.ledger.coordinator).toBeNull();
    expect(s.policy.effective_protected_paths).toContain(".xarabot/**");
    expect(s.standing_authority.frontmatter.granted_by).toBe("edanisko");
    expect(s.manifests.map((m) => [m.path, m.sha])).toEqual([
      [manifestPath("2.1"), shaOf("2.1")],
      [manifestPath("2.2"), shaOf("2.2")],
    ]);
    expect(s.graph.ok).toBe(true);
    expect(s.sprint_status).toEqual({ development_status: { "epic-1": "backlog", "k-2.1": "in-progress" } });
    expect(s.retro_gates.epics["2"]?.retro?.verdict).toBe("accepted");
    expect(s.escalations).toEqual({ open: ["2.2"] });
    expect(s.epic_context).toEqual({ 1: "valid", 2: "valid" });
    expect(s.live_evidence).toEqual({ 1: false, 2: false });
    expect(s.role).toBe("builder");
    expect(SnapshotSchema.safeParse(s).success).toBe(true);
  });

  test.each([
    ["no evidence file", {}, { 1: false, 2: false, 3: false }],
    ["Epic 2's default evidence file", { evidence: [2] }, { 1: false, 2: true, 3: false }],
    ["another Epic's file is not Epic 2's", { files: { "docs/maintainer/evidence/epic-22.md": "x\n" } }, { 1: false, 2: false, 3: false }],
    ["a configured glob with a wildcard", { liveEvidenceGlob: "ev/epic-<N>-run-*.md", files: { "ev/epic-3-run-1.md": "x\n" } }, { 1: false, 2: false, 3: true }],
  ] as const)("live_evidence: %s", (_name, over, want) => {
    expect(snapshotOf({ epics: { 1: [], 2: [], 3: [] }, ...over }).live_evidence).toEqual(want);
  });

  test("absent sprint-status.yaml reads as empty", () => {
    expect(snapshotOf({ ...BASE, files: { [STATUS]: null } }).sprint_status).toEqual({ development_status: {} });
  });

  test("every Epic in the graph gets a context entry", () => {
    const s = snapshotOf({ epics: { 1: [], 2: [], 3: [] }, contexts: { 2: null, 3: "" } });
    expect(s.epic_context).toEqual({ 1: "valid", 2: "missing", 3: "empty" });
  });

  test("a graph failure is data: no manifests, no contexts, empty retro gates", () => {
    const s = snapshotOf({
      ...BASE,
      retro: { 2: "accepted" },
      epicsYaml: "version: 1\nepics:\n  1:\n    depends_on: [2]\n  2:\n    depends_on: [1]\n",
    });
    expect(s.graph).toEqual({ ok: false, error: { kind: "cycle", message: "graph: cycle among Epics 1 → 2 → 1" } });
    expect(s.manifests).toEqual([]);
    expect(s.epic_context).toEqual({});
    expect(s.retro_gates).toEqual({ schema_version: 1, epics: {} });
  });

  test("a bad retro-gates.yaml is a graph failure", () => {
    const s = snapshotOf({ ...BASE, files: { [RETRO]: "schema_version: 1\nepics: [\n" } });
    expect(s.graph.ok).toBe(false);
  });
});

describe("assembleSnapshot: errors", () => {
  const cases: { name: string; world: World; kind: string; tweak?: (i: ReturnType<typeof input>) => ReturnType<typeof input> }[] = [
    { name: "bad config", world: { ...BASE, files: { [CONFIG_PATH]: "schema_version: 1\n" } }, kind: "invalid" },
    { name: "missing config", world: { ...BASE, files: { [CONFIG_PATH]: null } }, kind: "missing" },
    { name: "config schema_version 2", world: { ...BASE, files: { [CONFIG_PATH]: "schema_version: 2\n" } }, kind: "unsupported-version" },
    {
      name: "ledger schema_version 5",
      world: { ...BASE, ledgerFiles: { "units/story__2.1.json": '{"schema_version": 5}' } },
      kind: "stop",
    },
    {
      name: "ledger schema_version 0",
      world: { ...BASE, ledgerFiles: { "units/story__2.1.json": '{"schema_version": 0}' } },
      kind: "stop",
    },
    {
      name: "malformed ledger record",
      world: { ...BASE, ledgerFiles: { "units/story__2.1.json": "{" } },
      kind: "invalid",
    },
    { name: "bad status YAML", world: { ...BASE, files: { [STATUS]: "development_status: [\n" } }, kind: "invalid" },
    { name: "status a list", world: { ...BASE, files: { [STATUS]: "- a\n" } }, kind: "invalid" },
    { name: "manifest with no SHA", world: { ...BASE, noSha: [manifestPath("2.2")] }, kind: "invalid-snapshot" },
    {
      name: "status listed but not read",
      world: BASE,
      kind: "unreadable",
      tweak: (i) => ({ ...i, files: Object.fromEntries(Object.entries(i.files).filter(([p]) => p !== STATUS)) }),
    },
    {
      name: "context listed but not read",
      world: BASE,
      kind: "unreadable",
      tweak: (i) => ({ ...i, files: Object.fromEntries(Object.entries(i.files).filter(([p]) => p !== contextPath(2))) }),
    },
    { name: "bad main SHA", world: BASE, kind: "invalid-snapshot", tweak: (i) => ({ ...i, main_sha: "abc" }) },
    { name: "bad PR entry", world: BASE, kind: "invalid-snapshot", tweak: (i) => ({ ...i, prs: { "story:2.1": { number: 0, state: "open", head_sha: MAIN_SHA } } }) },
    { name: "bad escalation id", world: { ...BASE, escalations: ["two"] }, kind: "invalid-snapshot" },
    { name: "bad role", world: BASE, kind: "invalid-snapshot", tweak: (i) => ({ ...i, role: "reviewer" as "builder" }) },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const raw = input(c.world);
      const r = assembleSnapshot(c.tweak === undefined ? raw : c.tweak(raw));
      expect(r.ok).toBe(false);
      if (!r.ok) expect<string>(r.error.kind).toBe(c.kind);
    });
  }

  test("a valid ledger with records parses", () => {
    const r = assembleSnapshot({ ...input(BASE), ledger_files: tip([storyRec("2.1")]) });
    expect(r.ok).toBe(true);
  });
});
