import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import {
  buildPlanningPrompt,
  buildPrompt,
  type BuildPlanningPromptInput,
  type BuildPromptInput,
  type GraphPlanningPromptUnit,
  type PromptMode,
  type StatusPlanningPromptUnit,
} from "../../../src/core/prompt/build-prompt.ts";
import { PACKAGE_TEMPLATE, type PromptTemplate } from "../../../src/core/prompt/template.ts";
import { BuildResultSchema, PlanningResultSchema } from "../../../src/core/schemas/session-result.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const KEY = "1-7-forge-port-fake-forge-and-contract-suite";
const RESULT = "/private/var/folders/xy/T/xarabot-lane/result.json";
const FINDINGS = "/private/var/folders/xy/T/xarabot-lane/findings.md";
const LOG = "/private/var/folders/xy/T/xarabot-lane/ci.log";

const MODES: readonly PromptMode[] = [
  { mode: "build" },
  { mode: "loopback", findings_path: FINDINGS },
  { mode: "ci-fix", log_path: LOG },
];

function input(patch: Partial<BuildPromptInput> = {}): BuildPromptInput {
  return {
    template: PACKAGE_TEMPLATE,
    unit: { kind: "story", id: "1.7", sprint_key: KEY },
    mode: { mode: "build" },
    sections: [],
    human_live_steps: [],
    result_path: RESULT,
    ...patch,
  };
}

function build(patch: Partial<BuildPromptInput> = {}): string {
  const r = buildPrompt(input(patch));
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.value;
}

function failure(patch: Partial<BuildPromptInput>): { kind: string; message: string } {
  const r = buildPrompt(input(patch));
  if (r.ok) throw new Error("expected an error");
  return r.error;
}

/** The text after the last `# Result` heading. */
const resultSection = (p: string) => p.slice(p.lastIndexOf("\n# Result\n") + 1);

describe("first build", () => {
  const p = build();
  test("names the unit exactly and runs bmad-build-auto", () => {
    expect(p).toContain("\nBuild Story 1.7 (`1-7-forge-port-fake-forge-and-contract-suite`)\n");
    expect(p).toContain("`bmad-build-auto`");
  });
  test("ends with the result section", () => {
    const r = resultSection(p);
    expect(r.startsWith("# Result\n")).toBe(true);
    expect(p.endsWith(r)).toBe(true);
    expect(r).toContain("`$XARABOT_RESULT`");
    expect(r).toContain(`\`${RESULT}\``);
  });
  test("result section embeds the build JSON Schema", () => {
    const m = /```json\n([\s\S]*?)\n```/.exec(resultSection(p));
    expect(m).not.toBeNull();
    expect(JSON.parse(m?.[1] ?? "null")).toEqual(z.toJSONSchema(BuildResultSchema));
  });
  test("result section maps build-auto's halt", () => {
    const r = resultSection(p);
    for (const kind of ["intent-gap", "verification", "human-live-step", "escalation", "other", "ready-for-dev", "blocked.step_id"]) {
      expect(r).toContain(`\`${kind}\``);
    }
  });
  test("result section forbids no-op (AR42: build-auto never yields it)", () => {
    expect(resultSection(p)).toContain("`bmad-build-auto` has no `no-op` outcome, so never report `no-op` after it.");
  });
  test("summary and body describe the change, never the session (every mode)", () => {
    for (const mode of MODES) {
      const r = resultSection(build({ mode }));
      expect(r).toContain("- `summary`: one line saying what the change does (it becomes the commit title).");
      expect(r).toContain("- `body`: a description of the change for a reviewer: never this session, the runner, the working tree or how the skill ran.");
      expect(r).not.toContain("what you did");
    }
  });
  test("a Story id with a suffix", () => {
    const q = build({ unit: { kind: "story", id: "1.17a", sprint_key: "1-17a-approval-gate" } });
    expect(q).toContain("Build Story 1.17a (`1-17a-approval-gate`)");
  });
});

describe("loopback and CI fix", () => {
  const cases = [
    { mode: { mode: "loopback", findings_path: FINDINGS } as const, path: FINDINGS },
    { mode: { mode: "ci-fix", log_path: LOG } as const, path: LOG },
  ];
  for (const c of cases) {
    test(c.mode.mode, () => {
      const p = build({ mode: c.mode });
      expect(p).toContain(`\`${c.path}\``);
      expect(p).toContain("Run no skill.");
      expect(p).not.toMatch(/bmad-/);
      expect(p).toContain("Story 1.7 (`1-7-forge-port-fake-forge-and-contract-suite`)");
      expect(p).not.toContain("Build Story");
      const r = resultSection(p);
      expect(p.endsWith(r)).toBe(true);
      expect(r).toContain("`$XARABOT_RESULT`");
      expect(r).toContain(`\`${RESULT}\``);
      expect(r).toContain("`no-op`");
    });
  }
});

describe("repo sections and Human Live Steps", () => {
  const sections = [
    { name: "20-style.md", text: "Style: tabs {{story_id}} stay.\n\n  indented\n" },
    { name: "10-intro.md", text: "Intro first." },
  ];
  const steps = [
    { id: "dns", text: "Point the DNS record at the host." },
    { id: "app-install", text: "Install the App." },
  ];
  test("sections appear verbatim, ordered by file name, never re-expanded", () => {
    const p = build({ sections });
    expect(p).toContain("Intro first.\n\nStyle: tabs {{story_id}} stay.\n\n  indented\n");
  });
  test("Human Live Steps as `id`: text with the step_id instruction", () => {
    const p = build({ human_live_steps: steps });
    expect(p).toContain("- `dns`: Point the DNS record at the host.\n- `app-install`: Install the App.");
    expect(p).toMatch(/`human-live-step` and that step's id as `blocked\.step_id`/);
  });
  test("whitespace runs in step text collapse to one space", () => {
    const p = build({ human_live_steps: [{ id: "dns", text: "Point the\n\n  DNS\trecord\u2028here." }] });
    expect(p).toContain("- `dns`: Point the DNS record here.\n");
  });
  test("result step asks for a listed step id", () => {
    for (const mode of MODES) {
      expect(resultSection(build({ mode }))).toContain("the id of a step listed under Human Live Steps");
    }
  });
  test("order: task, rules, steps, sections, result", () => {
    const p = build({ sections, human_live_steps: steps });
    const at = ["# Task", "# Rules", "# Human Live Steps", "# Repository instructions", "# Result"].map((h) => p.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
  test("empty list and no sections omit those parts", () => {
    const p = build();
    expect(p).not.toContain("# Human Live Steps");
    expect(p).not.toContain("# Repository instructions");
  });
  test("a path holding a placeholder is not re-expanded", () => {
    const p = build({ result_path: "/t/{{story_id}}.json" });
    expect(p).toContain("`/t/{{story_id}}.json`");
  });
});

describe("invalid input", () => {
  const cases: { name: string; patch: Partial<BuildPromptInput>; field: RegExp }[] = [
    { name: "bad id", patch: { unit: { kind: "story", id: "1.x", sprint_key: KEY } }, field: /unit\.id/ },
    { name: "key of another Story", patch: { unit: { kind: "story", id: "1.7", sprint_key: "1-8-other" } }, field: /unit\.sprint_key.*1-7-/ },
    { name: "key with no slug", patch: { unit: { kind: "story", id: "1.7", sprint_key: "1-7-" } }, field: /unit\.sprint_key/ },
    { name: "key 1-70 for 1.7", patch: { unit: { kind: "story", id: "1.7", sprint_key: "1-70-x" } }, field: /unit\.sprint_key/ },
    { name: "key with a backtick", patch: { unit: { kind: "story", id: "1.7", sprint_key: "1-7-a`b" } }, field: /unit\.sprint_key/ },
    { name: "relative result path", patch: { result_path: "result.json" }, field: /result_path/ },
    { name: "newline in result path", patch: { result_path: "/t/a\nb.json" }, field: /result_path/ },
    { name: "relative findings path", patch: { mode: { mode: "loopback", findings_path: "f.md" } }, field: /mode\.findings_path/ },
    { name: "newline in log path", patch: { mode: { mode: "ci-fix", log_path: "/t/ci\n.log" } }, field: /mode\.log_path/ },
    { name: "missing log path", patch: { mode: { mode: "ci-fix" } as unknown as PromptMode }, field: /mode\.log_path/ },
    { name: "unknown mode", patch: { mode: { mode: "merge" } as unknown as PromptMode }, field: /mode/ },
    { name: "section not .md", patch: { sections: [{ name: "intro.txt", text: "x" }] }, field: /sections\.0\.name/ },
    { name: "section with a dir", patch: { sections: [{ name: "a/intro.md", text: "x" }] }, field: /sections\.0\.name/ },
    { name: "bare .md", patch: { sections: [{ name: ".md", text: "x" }] }, field: /sections\.0\.name/ },
    {
      name: "duplicate section",
      patch: { sections: [{ name: "a.md", text: "x" }, { name: "a.md", text: "y" }] },
      field: /sections: duplicate section "a\.md"/,
    },
    {
      name: "duplicate step",
      patch: { human_live_steps: [{ id: "a", text: "x" }, { id: "a", text: "y" }] },
      field: /human_live_steps: duplicate/,
    },
    { name: "empty step text", patch: { human_live_steps: [{ id: "a", text: "" }] }, field: /human_live_steps\.0\.text/ },
    { name: "backtick in a step id", patch: { human_live_steps: [{ id: "a`b", text: "x" }] }, field: /human_live_steps\.0\.id/ },
    { name: "newline in a step id", patch: { human_live_steps: [{ id: "a\nb", text: "x" }] }, field: /human_live_steps\.0\.id/ },
    { name: "backtick in result path", patch: { result_path: "/t/a`b.json" }, field: /result_path/ },
    {
      name: "DEL in findings path",
      patch: { mode: { mode: "loopback", findings_path: "/t/f\x7f.md" } },
      field: /mode\.findings_path/,
    },
    { name: "C1 control in result path", patch: { result_path: "/t/a\x85b.json" }, field: /result_path/ },
    { name: "U+2028 in log path", patch: { mode: { mode: "ci-fix", log_path: "/t/ci\u2028.log" } }, field: /mode\.log_path/ },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const e = failure(c.patch);
      expect(e.kind).toBe("invalid-input");
      expect(e.message).toMatch(c.field);
    });
  }
});

describe("invalid template", () => {
  const tpl = (patch: Partial<PromptTemplate>): PromptTemplate => ({ ...PACKAGE_TEMPLATE, ...patch });
  const cases: { name: string; template: PromptTemplate; mode?: PromptMode; message: RegExp }[] = [
    { name: "unknown placeholder", template: tpl({ rules: "{{nope}}" }), message: /template\.rules: unknown placeholder \{\{nope\}\}/ },
    {
      name: "unknown placeholder in an unused part",
      template: tpl({ ci_fix: "x {{ story_id }}" }),
      message: /template\.ci_fix: unknown placeholder/,
    },
    {
      name: "a placeholder with no value in this mode",
      template: tpl({ first_build: "Build {{log_path}}" }),
      message: /\{\{log_path\}\} has no value in build mode/,
    },
    {
      name: "findings_path in ci-fix mode",
      template: tpl({ ci_fix: "Repair {{findings_path}}" }),
      mode: { mode: "ci-fix", log_path: LOG },
      message: /\{\{findings_path\}\} has no value in ci-fix mode/,
    },
    {
      name: "log_path in loopback mode",
      template: tpl({ loopback: "Revise {{log_path}}" }),
      mode: { mode: "loopback", findings_path: FINDINGS },
      message: /\{\{log_path\}\} has no value in loopback mode/,
    },
    {
      name: "a missing part",
      template: { ...PACKAGE_TEMPLATE, rules: undefined } as unknown as PromptTemplate,
      message: /template: rules/,
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const e = failure({ template: c.template, ...(c.mode === undefined ? {} : { mode: c.mode }) });
      expect(e.kind).toBe("invalid-template");
      expect(e.message).toMatch(c.message);
    });
  }
});

/** Selection, CI (other than "CI log"), merge and status instructions. */
const BANNED: readonly { readonly what: string; readonly pattern: RegExp }[] = [
  { what: "selection: next", pattern: /\bnext\b/i },
  { what: "selection: pick", pattern: /\b(?:select|pick|choose)\b/i },
  { what: "selection: claim", pattern: /\bclaim/i },
  { what: "selection: sprint status", pattern: /sprint[-_ ]?status/i },
  { what: "selection: epics", pattern: /epics\.(?:md|yaml)/i },
  { what: "CI", pattern: /\bCI\b(?! log\b)/ },
  { what: "CI: continuous integration", pattern: /continuous integration/i },
  { what: "CI: GitHub Actions", pattern: /github actions|workflow run/i },
  { what: "CI: poll", pattern: /\bpoll/i },
  { what: "merge", pattern: /\bmerg/i },
  { what: "merge: queue", pattern: /\bqueue\b/i },
  { what: "merge: pull request", pattern: /pull request|\bPRs?\b/ },
  { what: "merge: push", pattern: /\bpush/i },
  { what: "merge: gh", pattern: /\bgh\b/ },
  { what: "merge: approve", pattern: /\bapprov/i },
  { what: "status", pattern: /\bstatus\b/i },
  { what: "status: mark done", pattern: /\bmark\b[^.\n]*\b(?:done|complete)/i },
  { what: "status: ledger", pattern: /\bledger\b/i },
];

describe("banned instructions", () => {
  const steps = [{ id: "dns", text: "Point the DNS record at the host." }];
  const sections = [{ name: "style.md", text: "Prefer small functions." }];
  for (const mode of MODES) {
    for (const extra of [{}, { human_live_steps: steps, sections }]) {
      const label = `${mode.mode}${"sections" in extra ? " with steps and sections" : ""}`;
      test(label, () => {
        const p = build({ mode, ...extra });
        expect(BANNED.filter((b) => b.pattern.test(p)).map((b) => b.what)).toEqual([]);
      });
    }
  }
  test("every Story part of the package template", () => {
    for (const [part, text] of Object.entries(PACKAGE_TEMPLATE)) {
      if (PLANNING_PARTS.includes(part)) continue;
      expect({ part, hits: BANNED.filter((b) => b.pattern.test(text)).map((b) => b.what) }).toEqual({ part, hits: [] });
    }
  });
  test("the CI-fix prompt says CI log", () => {
    expect(build({ mode: { mode: "ci-fix", log_path: LOG } })).toContain("CI log");
  });
  test("the banned table catches each kind", () => {
    const hits = (s: string) => BANNED.some((b) => b.pattern.test(s));
    for (const s of ["Pick the next Story.", "Wait for CI to pass.", "Merge the PR.", "Set the status to done."]) {
      expect({ s, hit: hits(s) }).toEqual({ s, hit: true });
    }
  });
});

describe("_bmad/custom", () => {
  const NEEDLE = ["_bmad", "custom"].join("/");
  test("no prompt names it", () => {
    for (const mode of MODES) expect(build({ mode })).not.toContain(NEEDLE);
  });
  test("no src/ file names it", async () => {
    const offenders: string[] = [];
    let count = 0;
    for await (const rel of new Bun.Glob("src/**/*").scan({ cwd: ROOT, dot: true })) {
      count += 1;
      if ((await Bun.file(join(ROOT, rel)).text()).includes(NEEDLE)) offenders.push(rel);
    }
    expect(count).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});

// ------------------------------------------------------------ planning prompts

/** The template parts only planning prompts use (Story 2.7). */
const PLANNING_PARTS: readonly string[] = ["planning_status", "planning_graph", "result_planning"];

/** No CI, merge, queue, PR, push, approval, claim, `next`, ledger or selection word in a planning prompt. */
const PLANNING_BANNED: readonly { readonly what: string; readonly pattern: RegExp }[] = [
  { what: "CI", pattern: /\bCI\b/ },
  { what: "CI: continuous integration", pattern: /continuous integration/i },
  { what: "CI: GitHub Actions", pattern: /github actions|workflow run/i },
  { what: "merge", pattern: /\bmerg/i },
  { what: "queue", pattern: /\bqueue/i },
  { what: "PR", pattern: /pull request|\bPRs?\b/ },
  { what: "push", pattern: /\bpush/i },
  { what: "approval", pattern: /\bapprov/i },
  { what: "claim", pattern: /\bclaim/i },
  { what: "next", pattern: /\bnext\b/i },
  { what: "ledger", pattern: /\bledger\b/i },
  { what: "selection", pattern: /\b(?:select|pick|choose)/i },
  { what: "gh", pattern: /\bgh\b/ },
];

const STATUS_UNIT: StatusPlanningPromptUnit = {
  kind: "status",
  id: "planning:status.3",
  epics_path: "_bmad-output/planning-artifacts/epics.md",
  contexts: [
    { epic: 4, output_path: "_bmad-output/implementation-artifacts/epic-4-context.md" },
    { epic: 2, output_path: "_bmad-output/implementation-artifacts/epic-2-context.md" },
  ],
};

const GRAPH_UNIT: GraphPlanningPromptUnit = {
  kind: "graph",
  id: "planning:graph.1",
  epics_path: "_bmad-output/planning-artifacts/epics.md",
  manifests_dir: "stories",
  path_key: null,
  headings: [
    { id: "3.1", epic: 3, line: 120 },
    { id: "3.2", epic: 3, line: 140 },
  ],
};

function planningInput(patch: Partial<BuildPlanningPromptInput> = {}): BuildPlanningPromptInput {
  return { template: PACKAGE_TEMPLATE, unit: STATUS_UNIT, sections: [], result_path: RESULT, ...patch };
}

function planning(patch: Partial<BuildPlanningPromptInput> = {}): string {
  const r = buildPlanningPrompt(planningInput(patch));
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.value;
}

function planningFailure(patch: Partial<BuildPlanningPromptInput>): { kind: string; message: string } {
  const r = buildPlanningPrompt(planningInput(patch));
  if (r.ok) throw new Error("expected an error");
  return r.error;
}

describe("planning prompt: status", () => {
  const p = planning();
  test("runs stock bmad-sprint-planning headless, then compiles each due Epic context", () => {
    expect(p).toContain("(`planning:status.3`)");
    expect(p).toContain("Run the stock `bmad-sprint-planning` skill headless");
    expect(p).toContain("Never save a findings file.");
    expect(p).toContain("follow `.claude/skills/bmad-build-auto/compile-epic-context.md`");
    expect(p).toContain("the epics file `_bmad-output/planning-artifacts/epics.md`, the planning artifacts folder `_bmad-output/planning-artifacts`");
    expect(p).toContain("- Epic 2: output path `_bmad-output/implementation-artifacts/epic-2-context.md`\n- Epic 4: output path `_bmad-output/implementation-artifacts/epic-4-context.md`");
  });
  test("no due context: says so", () => {
    expect(planning({ unit: { ...STATUS_UNIT, contexts: [] } })).toContain("- None: no Epic context file is due.");
  });
  test("an epics file at the top level: its folder is .", () => {
    expect(planning({ unit: { ...STATUS_UNIT, epics_path: "epics.md" } })).toContain("the planning artifacts folder `.`");
  });
  test("readiness findings go in the result, as blocked with the findings in summary", () => {
    const r = resultSection(p);
    expect(r).toContain("`blocked`, with every finding or the reason in `summary`");
    expect(r).toContain("a failed readiness gate");
  });
});

describe("planning prompt: graph", () => {
  const p = planning({ unit: GRAPH_UNIT });
  test("runs no skill and never bmad-sprint-planning", () => {
    expect(p).toContain("Run no skill, and never run `bmad-sprint-planning`.");
    expect(p).not.toContain("compile-epic-context");
  });
  test("names each heading with no manifest: id, Epic and line", () => {
    expect(p).toContain("- Story 3.1 (Epic 3), line 120\n- Story 3.2 (Epic 3), line 140");
  });
  test("asks for a manifest per heading with its frontmatter and depends_on", () => {
    expect(p).toContain("write `stories/<id>.md`");
    for (const key of ["story_id", "epic", "sprint_key", "title", "globs", "depends_on"]) expect(p).toContain(`- \`${key}\`:`);
    expect(p).toContain("an earlier Story in the same Epic, or a Story in an Epic this Epic depends on");
  });
  test("a path_key config asks for the key, naming its values", () => {
    const q = planning({ unit: { ...GRAPH_UNIT, path_key: { key: "area", values: ["core", "lane"] } } });
    expect(q).toContain("- `area`: the area the Story's work changes, one of `core`, `lane`.");
    expect(q).not.toContain("- `globs`:");
  });
  test("allows edits to epics_path and .xarabot/epics.yaml only, and states that file's schema", () => {
    expect(p).toContain("you may edit only `_bmad-output/planning-artifacts/epics.md` and `.xarabot/epics.yaml`");
    expect(p).toContain("Change no other file.");
    expect(p).toContain("version: 1\nepics:\n");
    expect(p).toContain("depends_on: [2, 3]");
  });
});

describe("planning prompt: shape", () => {
  const sections = [{ name: "10-intro.md", text: "Intro {{planning_unit}} stays." }];
  for (const unit of [STATUS_UNIT, GRAPH_UNIT]) {
    test(`${unit.kind}: task, rules, sections, then the planning result step with its JSON Schema, last`, () => {
      const p = planning({ unit, sections });
      const at = ["# Task", "# Rules", "# Repository instructions", "# Result"].map((h) => p.indexOf(h));
      expect(at.every((i) => i >= 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      expect(p).toContain("Intro {{planning_unit}} stays.");
      expect(p).not.toContain("# Human Live Steps");
      const r = resultSection(p);
      expect(p.endsWith(r)).toBe(true);
      expect(r).toContain(`\`${RESULT}\``);
      expect(r).toContain("for a `planning` result");
      const m = /```json\n([\s\S]*?)\n```/.exec(r);
      expect(JSON.parse(m?.[1] ?? "null")).toEqual(z.toJSONSchema(PlanningResultSchema));
      for (const o of ["done", "nothing-due", "blocked"]) expect(r).toContain(`\`${o}\``);
    });
  }
  test("no sections: no repository part", () => {
    expect(planning()).not.toContain("# Repository instructions");
  });
});

describe("planning prompt: banned words", () => {
  const sections = [{ name: "style.md", text: "Prefer small functions." }];
  for (const unit of [STATUS_UNIT, GRAPH_UNIT, { ...GRAPH_UNIT, path_key: { key: "area", values: ["core"] } }, { ...STATUS_UNIT, contexts: [] }]) {
    for (const extra of [{}, { sections }]) {
      test(`${unit.kind}${"sections" in extra ? " with sections" : ""}${unit.kind === "graph" && unit.path_key !== null ? " with a path key" : ""}${unit.kind === "status" && unit.contexts.length === 0 ? " with no context" : ""}`, () => {
        const p = planning({ unit, ...extra });
        expect(PLANNING_BANNED.filter((b) => b.pattern.test(p)).map((b) => b.what)).toEqual([]);
      });
    }
  }
  test("every planning part of the package template, and the rules", () => {
    for (const part of [...PLANNING_PARTS, "rules", "repo_sections"]) {
      const text = PACKAGE_TEMPLATE[part as keyof PromptTemplate];
      expect({ part, hits: PLANNING_BANNED.filter((b) => b.pattern.test(text)).map((b) => b.what) }).toEqual({ part, hits: [] });
    }
  });
  test("the table catches each kind", () => {
    const hits = (s: string) => PLANNING_BANNED.some((b) => b.pattern.test(s));
    for (const s of ["Wait for CI.", "Merge it.", "Queue it.", "Open a PR.", "Push the branch.", "Get approval.", "Claim the unit.", "Then the next one.", "Write the ledger.", "Choose an Epic."]) {
      expect({ s, hit: hits(s) }).toEqual({ s, hit: true });
    }
  });
});

describe("planning prompt: invalid input and template", () => {
  const cases: { name: string; patch: Partial<BuildPlanningPromptInput>; field: RegExp }[] = [
    { name: "a status id on a graph unit", patch: { unit: { ...GRAPH_UNIT, id: "planning:status.1" } }, field: /unit\.id: must be planning:graph/ },
    { name: "a graph id on a status unit", patch: { unit: { ...STATUS_UNIT, id: "planning:graph.1" } }, field: /unit\.id: must be planning:status/ },
    { name: "n of 0", patch: { unit: { ...STATUS_UNIT, id: "planning:status.0" } }, field: /unit\.id/ },
    { name: "a graph unit with no heading", patch: { unit: { ...GRAPH_UNIT, headings: [] } }, field: /unit\.headings/ },
    { name: "a bad heading id", patch: { unit: { ...GRAPH_UNIT, headings: [{ id: "3.x", epic: 3, line: 1 }] } }, field: /unit\.headings\.0\.id/ },
    { name: "a duplicate heading", patch: { unit: { ...GRAPH_UNIT, headings: [{ id: "3.1", epic: 3, line: 1 }, { id: "3.1", epic: 3, line: 2 }] } }, field: /duplicate Story 3\.1/ },
    { name: "a duplicate context Epic", patch: { unit: { ...STATUS_UNIT, contexts: [{ epic: 2, output_path: "a.md" }, { epic: 2, output_path: "b.md" }] } }, field: /duplicate Epic 2/ },
    { name: "a backtick in epics_path", patch: { unit: { ...STATUS_UNIT, epics_path: "a`b.md" } }, field: /unit\.epics_path/ },
    { name: "a newline in an output path", patch: { unit: { ...STATUS_UNIT, contexts: [{ epic: 2, output_path: "a\nb.md" }] } }, field: /unit\.contexts\.0\.output_path/ },
    { name: "an empty manifests dir", patch: { unit: { ...GRAPH_UNIT, manifests_dir: "" } }, field: /unit\.manifests_dir/ },
    { name: "a relative result path", patch: { result_path: "result.json" }, field: /result_path/ },
    { name: "a duplicate section", patch: { sections: [{ name: "a.md", text: "x" }, { name: "a.md", text: "y" }] }, field: /duplicate section/ },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const e = planningFailure(c.patch);
      expect(e.kind).toBe("invalid-input");
      expect(e.message).toMatch(c.field);
    });
  }
  test("a graph placeholder in the status part has no value", () => {
    const e = planningFailure({ template: { ...PACKAGE_TEMPLATE, planning_status: "x {{manifests_dir}}" } });
    expect(e.kind).toBe("invalid-template");
    expect(e.message).toMatch(/\{\{manifests_dir\}\} has no value in a status planning prompt/);
  });
  test("a Story placeholder in a planning part has no value", () => {
    const e = planningFailure({ unit: GRAPH_UNIT, template: { ...PACKAGE_TEMPLATE, planning_graph: "x {{story_id}}" } });
    expect(e.message).toMatch(/\{\{story_id\}\} has no value in a graph planning prompt/);
  });
  test("a missing planning part", () => {
    const e = planningFailure({ template: { ...PACKAGE_TEMPLATE, result_planning: undefined } as unknown as PromptTemplate });
    expect(e.kind).toBe("invalid-template");
    expect(e.message).toMatch(/template: result_planning/);
  });
});
