import { describe, expect, test } from "bun:test";
import { assembleSnapshot, epicContextState, epicSection, epicSourceLine, liveEvidenceGaps, liveEvidencePath } from "../../../src/core/next/snapshot.ts";
import { SnapshotSchema } from "../../../src/core/schemas/snapshot.ts";
import { tip } from "../ledger/fixtures.ts";
import {
  CONFIG_PATH,
  contextPath,
  evidencePath,
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

describe("epicContextState: the source line (retro item 12)", () => {
  const SOURCE = `<!-- source: sha256:${"a".repeat(64)} -->`;
  const cases: [string | null, string][] = [
    [`# Epic 2 Context: Goal\n${SOURCE}\n\nBody.\n`, "valid"],
    [`# Epic 2 Context: Goal\r\n${SOURCE}\r\n`, "valid"],
    [`\uFEFF# Epic 2 Context: Goal\n${SOURCE}  \n`, "valid"],
    [`# Epic 2 Context: Goal\n${SOURCE.replace("aaaa", "bbbb")}\n`, "stale"],
    ["# Epic 2 Context: Goal\n\nBody.\n", "stale"],
    ["# Epic 2 Context: Goal", "stale"],
    [`# Epic 2 Context: Goal\n\n${SOURCE}\n`, "stale"],
    [`${SOURCE}\n# Epic 2 Context: Goal\n`, "wrong-heading"],
    [null, "missing"],
    ["", "empty"],
  ];
  for (const [text, state] of cases) {
    test(`${JSON.stringify(text)} → ${state}`, () => expect<string>(epicContextState(2, text, SOURCE)).toBe(state));
  }
});

describe("epicSection and epicSourceLine (retro item 12)", () => {
  const TEXT = [
    "# Epics",
    "",
    "## Epic 1: One",
    "",
    "### Story 1.1: First",
    "",
    "## Notes",
    "",
    "```",
    "## Epic 9: in a fence",
    "```",
    "## Epic 2: Two",
    "",
    "### Story 2.1: Second",
    "",
  ].join("\n");

  test("runs from the Epic's heading up to the next Epic heading, keeping other level-2 headings and fenced text", () => {
    expect(epicSection(TEXT, 1)).toBe("## Epic 1: One\n\n### Story 1.1: First\n\n## Notes\n\n```\n## Epic 9: in a fence\n```\n");
  });
  test("the last Epic runs to the end of the file", () => {
    expect(epicSection(TEXT, 2)).toBe("## Epic 2: Two\n\n### Story 2.1: Second\n");
  });
  test("keeps the text byte for byte, CRLF included", () => {
    expect(epicSection(TEXT.replaceAll("\n", "\r\n"), 2)).toBe("## Epic 2: Two\r\n\r\n### Story 2.1: Second\r\n");
  });
  test("no such Epic, or text that does not parse: null", () => {
    expect(epicSection(TEXT, 3)).toBeNull();
    expect(epicSection("## Epic 1: A\n## Epic 1: B\n", 1)).toBeNull();
    expect(epicSourceLine(TEXT, 3)).toBeNull();
  });
  test("the source line is the SHA-256 of the section", () => {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(epicSection(TEXT, 2) as string);
    expect(epicSourceLine(TEXT, 2)).toBe(`<!-- source: sha256:${hasher.digest("hex")} -->`);
    expect(epicSourceLine(TEXT, 1)).not.toBe(epicSourceLine(TEXT, 2));
  });
  test("a change outside the Epic's section leaves its line as it was", () => {
    expect(epicSourceLine(TEXT.replace("### Story 1.1: First", "### Story 1.1: First, renamed"), 2)).toBe(epicSourceLine(TEXT, 2));
    expect(epicSourceLine(TEXT.replace("### Story 2.1: Second", "### Story 2.1: Second, renamed"), 2)).not.toBe(epicSourceLine(TEXT, 2));
  });
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
        "sprint_status", "retro_gates", "escalations", "epic_context", "live_evidence", "live_evidence_file", "prs", "lane", "role",
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
    expect(s.live_evidence_file).toEqual({});
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

  test("live_evidence_file: the read text of each Epic's first matching path", () => {
    const s = snapshotOf({
      epics: { 1: [], 2: [], 3: [] },
      liveEvidenceGlob: "ev/epic-<N>*.md",
      files: { "ev/epic-2-b.md": "b\n", "ev/epic-2-a.md": "a\n", "ev/epic-3.md": "three\n" },
    });
    expect(s.live_evidence_file).toEqual({ 2: { path: "ev/epic-2-a.md", text: "a\n" }, 3: { path: "ev/epic-3.md", text: "three\n" } });
    expect(liveEvidencePath("ev/epic-<N>*.md", 2, ["ev/epic-2-b.md", "ev/epic-2-a.md"])).toBe("ev/epic-2-a.md");
    expect(liveEvidencePath("ev/epic-<N>*.md", 4, ["ev/epic-2-b.md"])).toBeNull();
  });

  test("live_evidence_file: an evidence file listed but not read is left out when its Epic has no checks", () => {
    const i = input({ epics: { 1: [], 2: [] }, evidence: [2], liveEvidenceChecks: { 1: ["bun test"] } });
    const r = assembleSnapshot({ ...i, files: Object.fromEntries(Object.entries(i.files).filter(([p]) => p !== evidencePath(2))) });
    if (!r.ok) throw new Error(r.error.message);
    expect([r.value.live_evidence, r.value.live_evidence_file]).toEqual([{ 1: false, 2: true }, {}]);
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

const PR = { number: 7, state: "open", head_sha: MAIN_SHA } as const;
const APPROVAL = { author: "edanisko", state: "approved", commit_sha: MAIN_SHA, submitted_at: "2026-10-22T10:00:00Z" } as const;

describe("assembleSnapshot: PR reviews (retro item 13)", () => {
  test("each PR's reviews are carried as the forge read them; absent stays absent", () => {
    const reviews = [APPROVAL, { author: null, state: "dismissed", commit_sha: null, submitted_at: "2026-10-22T10:05:00.000Z" }] as const;
    const r = assembleSnapshot({ ...input(BASE), prs: { "story:2.1": { ...PR, reviews: [...reviews] }, "story:2.2": { ...PR, number: 8 } } });
    expect(r.ok && r.value.prs).toEqual({ "story:2.1": { ...PR, reviews: [...reviews] }, "story:2.2": { ...PR, number: 8 } });
  });
});

describe("assembleSnapshot: errors", () => {
  const cases: { name: string; world: World; kind: string; tweak?: (i: ReturnType<typeof input>) => ReturnType<typeof input> }[] = [
    { name: "bad config", world: { ...BASE, files: { [CONFIG_PATH]: "schema_version: 1\n" } }, kind: "invalid" },
    { name: "missing config", world: { ...BASE, files: { [CONFIG_PATH]: null } }, kind: "missing" },
    { name: "config schema_version 2", world: { ...BASE, files: { [CONFIG_PATH]: "schema_version: 2\n" } }, kind: "unsupported-version" },
    {
      name: "ledger schema_version 7",
      world: { ...BASE, ledgerFiles: { "units/story__2.1.json": '{"schema_version": 7}' } },
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
    {
      name: "evidence listed but not read, its Epic with checks",
      world: { ...BASE, evidence: [2], liveEvidenceChecks: { 2: ["bun test"] } },
      kind: "unreadable",
      tweak: (i) => ({ ...i, files: Object.fromEntries(Object.entries(i.files).filter(([p]) => p !== evidencePath(2))) }),
    },
    { name: "bad main SHA", world: BASE, kind: "invalid-snapshot", tweak: (i) => ({ ...i, main_sha: "abc" }) },
    { name: "bad PR entry", world: BASE, kind: "invalid-snapshot", tweak: (i) => ({ ...i, prs: { "story:2.1": { number: 0, state: "open", head_sha: MAIN_SHA } } }) },
    {
      name: "a PR review that decides nothing (commented)",
      world: BASE,
      kind: "invalid-snapshot",
      tweak: (i) => ({ ...i, prs: { "story:2.1": { ...PR, reviews: [{ ...APPROVAL, state: "commented" as "approved" }] } } }),
    },
    {
      name: "a PR review with no submitted time",
      world: BASE,
      kind: "invalid-snapshot",
      tweak: (i) => ({ ...i, prs: { "story:2.1": { ...PR, reviews: [{ ...APPROVAL, submitted_at: null as unknown as string }] } } }),
    },
    { name: "a PR review on a commit that is not a SHA", world: BASE, kind: "invalid-snapshot", tweak: (i) => ({ ...i, prs: { "story:2.1": { ...PR, reviews: [{ ...APPROVAL, commit_sha: "HEAD" }] } } }) },
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

describe("liveEvidenceGaps (retro item 14)", () => {
  const A = "XARABOT_LIVE=1 bun test test/e2e/claims-race.test.ts";
  const B = "XARABOT_LIVE=1 bun test test/contracts/";
  const row = (cmd: string, result: string) => `| \`${cmd}\` | ${result} | 12 s |`;
  const table = (...rows: string[]) => ["| Command | Result | Time |", "|---|---|---|", ...rows, ""].join("\n");

  test.each([
    ["each command in a table row with 0 fail", table(row(A, "20 pass, 0 skip, 0 fail"), row(B, "107 pass, 72 skip, 0 fail")), [], []],
    ["one command missing", table(row(A, "20 pass, 0 skip, 0 fail")), [B], []],
    ["one command with failures", table(row(A, "20 pass, 0 skip, 0 fail"), row(B, "116 pass, 43 skip, 20 fail")), [], [B]],
    ["no file text", "", [A, B], []],
    ["a transcript: prompt, output, then bun's summary lines", `$ ${A}\n\n 20 pass\n 0 skip\n 0 fail\nRan 20 tests across 1 file.\n\n\`${B}\`:\n 3 pass\n 0 fail\n`, [], []],
    ["CRLF line ends", `${A}\r\n 20 pass\r\n 0 fail\r\n${B}\r\n 1 pass\r\n 0 fail\r\n`, [], []],
    ["a failed run kept on the record, then the re-run that passed", table(row(B, "116 pass, 20 fail"), row(A, "20 pass, 0 fail"), row(B, "107 pass, 0 fail")), [], []],
    ["a command with no summary does not borrow the next command's", table(row(B, "not run"), row(A, "20 pass, 0 fail")), [], [B]],
    ["no summary at all", table(row(A, "pending"), row(B, "pending")), [], [A, B]],
    ["inside a longer command (another variable) is not the command", table(row(B.replace("XARABOT_LIVE=1 ", "XARABOT_LIVE=1 X=y "), "1 pass, 0 fail"), row(A, "0 fail")), [B], []],
    ["with extra arguments is not the command", table(row(`${B}agent.test.ts`, "1 pass, 0 fail"), row(A, "0 fail")), [B], []],
    ["a word-bounded count: 10 fail is not 0 fail", table(row(A, "10 fail"), row(B, "0 failed, 2 fail")), [], [A, B]],
  ] as const)("%s", (_name, text, missing, failing) => {
    expect(liveEvidenceGaps(text, [A, B])).toEqual({ missing: [...missing], failing: [...failing] });
  });

  test("no commands: no gaps", () => {
    expect(liveEvidenceGaps("anything", [])).toEqual({ missing: [], failing: [] });
  });
});
