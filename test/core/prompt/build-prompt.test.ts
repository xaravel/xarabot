import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import {
  buildPlanningPrompt,
  buildPrompt,
  buildRetroItemPrompt,
  buildRetroPrompt,
  buildReviewPrompt,
  BUILD_RESULT_JSON_SCHEMA,
  RETRO_RESULT_JSON_SCHEMA,
  REVIEW_RESULT_JSON_SCHEMA,
  type BuildReviewPromptInput,
  type BuildRetroItemPromptInput,
  type BuildRetroPromptInput,
  type BuildPlanningPromptInput,
  type BuildPromptInput,
  type GraphPlanningPromptUnit,
  type PromptMode,
  type StatusPlanningPromptUnit,
} from "../../../src/core/prompt/build-prompt.ts";
import { PACKAGE_TEMPLATE, type PromptTemplate } from "../../../src/core/prompt/template.ts";
import { BuildResultSchema, PlanningResultSchema, RetroResultSchema, ReviewResultSchema } from "../../../src/core/schemas/session-result.ts";

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
  test("order: task, rules, Epic context, steps, sections, result", () => {
    const p = build({ sections, human_live_steps: steps });
    const at = ["# Task", "# Rules", "# Epic context", "# Human Live Steps", "# Repository instructions", "# Result"].map((h) => p.indexOf(h));
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
      if (PLANNING_PARTS.includes(part) || RETRO_PARTS.includes(part)) continue;
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
const PLANNING_PARTS: readonly string[] = ["planning_status", "planning_graph", "planning_questions", "result_planning"];

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

const SOURCE_2 = `<!-- source: sha256:${"2".repeat(64)} -->`;

const STATUS_UNIT: StatusPlanningPromptUnit = {
  kind: "status",
  id: "planning:status.3",
  epics_path: "_bmad-output/planning-artifacts/epics.md",
  contexts: [
    { epic: 4, output_path: "_bmad-output/implementation-artifacts/epic-4-context.md", source_line: `<!-- source: sha256:${"4".repeat(64)} -->`, first_compile: false },
    { epic: 2, output_path: "_bmad-output/implementation-artifacts/epic-2-context.md", source_line: `<!-- source: sha256:${"2".repeat(64)} -->`, first_compile: false },
  ],
};

/** `STATUS_UNIT` with Epic 5 and Epic 3, in that order, compiled for the first time (Epic 3 retro item 15). */
const FIRST_UNIT: StatusPlanningPromptUnit = {
  ...STATUS_UNIT,
  contexts: [
    ...STATUS_UNIT.contexts,
    { epic: 5, output_path: "_bmad-output/implementation-artifacts/epic-5-context.md", source_line: `<!-- source: sha256:${"5".repeat(64)} -->`, first_compile: true },
    { epic: 3, output_path: "_bmad-output/implementation-artifacts/epic-3-context.md", source_line: `<!-- source: sha256:${"3".repeat(64)} -->`, first_compile: true },
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
    expect(p).toContain(
      `- Epic 2: output path \`_bmad-output/implementation-artifacts/epic-2-context.md\`, source line \`${SOURCE_2}\`\n- Epic 4: output path \`_bmad-output/implementation-artifacts/epic-4-context.md\`, source line \`<!-- source: sha256:${"4".repeat(64)} -->\``,
    );
  });
  test("writes each Epic's source line directly below its context heading (retro item 12)", () => {
    expect(p).toContain("write the source line given for its Epic, exactly as given, as the file's second line, directly below its `# Epic <N> Context:` heading");
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

describe("planning prompt: open design questions before a first compile (Epic 3 retro item 15)", () => {
  const p = planning({ unit: FIRST_UNIT });
  const questions = p.slice(p.indexOf("# Open design questions"), p.indexOf("# Rules"));
  test("the step appears only when an Epic's context is a first compile", () => {
    expect(planning()).not.toContain("# Open design questions");
    expect(planning({ unit: { ...STATUS_UNIT, contexts: [] } })).not.toContain("# Open design questions");
    expect(planning({ unit: GRAPH_UNIT })).not.toContain("# Open design questions");
    expect(p).toContain("# Open design questions");
  });
  test("it names each first-compile Epic, in order, and no recompiled one", () => {
    expect(questions).toContain("so this run compiles theirs for the first time:\n\n- Epic 3\n- Epic 5\n\n");
    expect(questions).not.toContain("- Epic 2");
    expect(questions).not.toContain("- Epic 4");
    // Every due Epic is still listed for step 2.
    for (const n of [2, 3, 4, 5]) expect(p).toContain(`- Epic ${n}: output path \`_bmad-output/implementation-artifacts/epic-${n}-context.md\``);
  });
  test("a single first compile names that Epic alone", () => {
    const q = planning({ unit: { ...STATUS_UNIT, contexts: [{ ...STATUS_UNIT.contexts[1]!, first_compile: true }, STATUS_UNIT.contexts[0]!] } });
    expect(q).toContain("for the first time:\n\n- Epic 2\n\n");
    expect(q).not.toContain("- Epic 4\n\n");
  });
  test("it comes after the task, between steps 1 and 2, and before the rules", () => {
    const at = ["# Task", "# Open design questions", "# Rules", "# Result"].map((h) => p.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(questions).toContain("Do this after step 1 and before step 2.");
  });
  test("it reads every Story of the Epic and the recorded Maintainer decisions, for questions a build would stop on as intent-gap", () => {
    expect(questions).toContain("read every Story of it in `_bmad-output/planning-artifacts/epics.md`, and the Maintainer decisions recorded there");
    expect(questions).toContain("the kind a build session would stop on as an `intent-gap`");
    expect(questions).toContain("readings that would behave differently");
  });
  test("any open question: no context file, blocked, every question in summary in one batch by Epic and Story, with its readings", () => {
    expect(questions).toContain("If any of these Epics has an open question, skip steps 2 and 3: write no context file, for any Epic.");
    expect(questions).toContain("End `blocked`, with every open question in `summary`, in one batch, grouped by Epic and then by Story");
    expect(questions).toContain("`- Story <id>: <question> Readings: <each reading, and how it would behave>.`");
  });
  test("no open question: compiles as now", () => {
    expect(questions).toContain("If none has an open question, go on with step 2 for every Epic it lists.");
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
  for (const unit of [STATUS_UNIT, GRAPH_UNIT, { ...GRAPH_UNIT, path_key: { key: "area", values: ["core"] } }, { ...STATUS_UNIT, contexts: [] }, FIRST_UNIT]) {
    for (const extra of [{}, { sections }]) {
      test(`${unit.kind}${"sections" in extra ? " with sections" : ""}${unit.kind === "graph" && unit.path_key !== null ? " with a path key" : ""}${unit.kind === "status" && unit.contexts.length === 0 ? " with no context" : ""}${unit === FIRST_UNIT ? " with a first compile" : ""}`, () => {
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
    { name: "a duplicate context Epic", patch: { unit: { ...STATUS_UNIT, contexts: [{ epic: 2, output_path: "a.md", source_line: SOURCE_2, first_compile: false }, { epic: 2, output_path: "b.md", source_line: SOURCE_2, first_compile: false }] } }, field: /duplicate Epic 2/ },
    { name: "a backtick in epics_path", patch: { unit: { ...STATUS_UNIT, epics_path: "a`b.md" } }, field: /unit\.epics_path/ },
    { name: "a newline in an output path", patch: { unit: { ...STATUS_UNIT, contexts: [{ epic: 2, output_path: "a\nb.md", source_line: SOURCE_2, first_compile: false }] } }, field: /unit\.contexts\.0\.output_path/ },
    { name: "a source line with no hash", patch: { unit: { ...STATUS_UNIT, contexts: [{ epic: 2, output_path: "a.md", source_line: "<!-- source: sha256: -->", first_compile: false }] } }, field: /unit\.contexts\.0\.source_line/ },
    { name: "a source line with a backtick", patch: { unit: { ...STATUS_UNIT, contexts: [{ epic: 2, output_path: "a.md", source_line: `${SOURCE_2}\``, first_compile: false }] } }, field: /unit\.contexts\.0\.source_line/ },
    { name: "a context with no first_compile", patch: { unit: { ...STATUS_UNIT, contexts: [{ epic: 2, output_path: "a.md", source_line: SOURCE_2 } as unknown as StatusPlanningPromptUnit["contexts"][number]] } }, field: /unit\.contexts\.0\.first_compile/ },
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

// ------------------------------------------------------------ retro prompts (Story 2.9)

/** The template parts only retro prompts use. */
const RETRO_PARTS: readonly string[] = ["retro", "result_retro"];

/** No CI, push, queue, approval, claim, `next`, ledger, sprint-status or selection word in a retro prompt. */
const RETRO_BANNED: readonly { readonly what: string; readonly pattern: RegExp }[] = [
  { what: "CI", pattern: /\bCI\b/ },
  { what: "CI: continuous integration", pattern: /continuous integration/i },
  { what: "CI: GitHub Actions", pattern: /github actions|workflow run/i },
  { what: "push", pattern: /\bpush/i },
  { what: "queue", pattern: /\bqueue/i },
  { what: "approval", pattern: /\bapprov/i },
  { what: "claim", pattern: /\bclaim/i },
  { what: "next", pattern: /\bnext\b/i },
  { what: "ledger", pattern: /\bledger\b/i },
  { what: "sprint-status", pattern: /sprint[-_ ]?status/i },
  { what: "selection", pattern: /\b(?:select|pick|choose)/i },
  { what: "gh", pattern: /\bgh\b/ },
];

const PRS = "/private/var/folders/xy/T/xarabot-lane/epic-2-prs.json";

function retroInput(patch: Partial<BuildRetroPromptInput> = {}): BuildRetroPromptInput {
  return { template: PACKAGE_TEMPLATE, unit: { kind: "retro", id: "retro:2", epic: 2, prs_path: PRS }, sections: [], result_path: RESULT, ...patch };
}

function retro(patch: Partial<BuildRetroPromptInput> = {}): string {
  const r = buildRetroPrompt(retroInput(patch));
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.value;
}

function retroFailure(patch: Partial<BuildRetroPromptInput>): { kind: string; message: string } {
  const r = buildRetroPrompt(retroInput(patch));
  if (r.ok) throw new Error("expected an error");
  return r.error;
}

describe("retro prompt", () => {
  test("names the unit, bmad-retrospective -H <N> and the prefetched file's absolute path", () => {
    const p = retro();
    expect(p).toContain("`retro:2`");
    expect(p).toContain("`bmad-retrospective -H 2`");
    expect(p).toContain(`\`${PRS}\``);
    expect(p).toContain("never from GitHub");
  });
  test("asks for each appended item's id, text, blocking, route and globs, and the verdict", () => {
    const p = retro();
    for (const field of ["`verdict`", "`items`", "`id`", "`text`", "`blocking`", "`route`", "`globs`", "`denied_actions`"]) expect(p).toContain(field);
    expect(p).toContain("`epic-2-retro-item-<seq>-<slug>`");
    expect(p).toContain("the Standing Authority file, the repository's Protected Paths");
  });
  test("task, rules, sections, then the result step with RetroResultSchema's JSON Schema last", () => {
    const p = retro({ sections: [{ name: "b.md", text: "B section." }, { name: "a.md", text: "A section." }] });
    const order = ["# Task", "# Rules", "A section.", "B section.", "# Result"].map((x) => p.indexOf(x));
    expect(order.every((x) => x >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(p).toContain(RETRO_RESULT_JSON_SCHEMA);
    expect(JSON.parse(RETRO_RESULT_JSON_SCHEMA)).toEqual(z.toJSONSchema(RetroResultSchema));
    expect(p).toContain(RESULT);
    expect(p.trimEnd().endsWith("Write this file last, and do nothing after it.")).toBe(true);
    expect(p).not.toMatch(/\{\{[^{}]*\}\}/);
  });
  test("every retro part of the package template, and the rules, carry no banned word", () => {
    for (const part of [...RETRO_PARTS, "rules", "repo_sections"]) {
      const text = PACKAGE_TEMPLATE[part as keyof PromptTemplate];
      expect({ part, hits: RETRO_BANNED.filter((b) => b.pattern.test(text)).map((b) => b.what) }).toEqual({ part, hits: [] });
    }
    expect(RETRO_BANNED.filter((b) => b.pattern.test(retro())).map((b) => b.what)).toEqual([]);
  });
  test("the table catches each kind", () => {
    const hits = (s: string) => RETRO_BANNED.some((b) => b.pattern.test(s));
    for (const s of ["Wait for CI.", "Push it.", "Queue it.", "Get approval.", "Claim it.", "Then the next one.", "The ledger.", "Edit sprint-status.yaml.", "Pick one."]) {
      expect({ s, hit: hits(s) }).toEqual({ s, hit: true });
    }
  });
  const cases: { name: string; patch: Partial<BuildRetroPromptInput>; field: RegExp }[] = [
    { name: "an id of another Epic", patch: { unit: { kind: "retro", id: "retro:3", epic: 2, prs_path: PRS } }, field: /unit\.id: must be retro:<epic>/ },
    { name: "a non-retro id", patch: { unit: { kind: "retro", id: "planning:status.1", epic: 2, prs_path: PRS } }, field: /unit\.id/ },
    { name: "a relative prs path", patch: { unit: { kind: "retro", id: "retro:2", epic: 2, prs_path: "epic-2-prs.json" } }, field: /unit\.prs_path/ },
    { name: "a backtick in the prs path", patch: { unit: { kind: "retro", id: "retro:2", epic: 2, prs_path: "/tmp/a`b.json" } }, field: /unit\.prs_path/ },
    { name: "a relative result path", patch: { result_path: "result.json" }, field: /result_path/ },
    { name: "a duplicate section", patch: { sections: [{ name: "a.md", text: "x" }, { name: "a.md", text: "y" }] }, field: /duplicate section/ },
  ];
  for (const c of cases) {
    test(`invalid input: ${c.name}`, () => {
      const e = retroFailure(c.patch);
      expect(e.kind).toBe("invalid-input");
      expect(e.message).toMatch(c.field);
    });
  }
  test("a Story placeholder in a retro part has no value", () => {
    const e = retroFailure({ template: { ...PACKAGE_TEMPLATE, retro: "x {{story_id}}" } });
    expect(e.kind).toBe("invalid-template");
    expect(e.message).toMatch(/\{\{story_id\}\} has no value in a retro prompt/);
  });
  test("a missing retro part", () => {
    const e = retroFailure({ template: { ...PACKAGE_TEMPLATE, result_retro: undefined } as unknown as PromptTemplate });
    expect(e.kind).toBe("invalid-template");
    expect(e.message).toMatch(/template: result_retro/);
  });
});

// ------------------------------------------------------------ retro-item prompts

const ITEM_ID = "epic-2-retro-item-1-fix-x";
const ITEM_UNIT = { kind: "retro-item", id: `retro-item:${ITEM_ID}`, item: { id: ITEM_ID, epic: 2, text: "Fix the  x\nhelper.", globs: ["src/x/**", "docs/x.md"] } } as const;

function itemInput(patch: Partial<BuildRetroItemPromptInput> = {}): BuildRetroItemPromptInput {
  return { template: PACKAGE_TEMPLATE, unit: ITEM_UNIT, mode: { mode: "build" }, sections: [], human_live_steps: [], result_path: RESULT, ...patch };
}

function item(patch: Partial<BuildRetroItemPromptInput> = {}): string {
  const r = buildRetroItemPrompt(itemInput(patch));
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.value;
}

function itemFailure(patch: Partial<BuildRetroItemPromptInput>): { kind: string; message: string } {
  const r = buildRetroItemPrompt(itemInput(patch));
  if (r.ok) throw new Error("expected an error");
  return r.error;
}

const ITEM_PARTS: readonly string[] = ["retro_item", "retro_item_ci_fix", "retro_item_loopback", "result_retro_item"];

describe("retro-item prompt (Story 2.10)", () => {
  const steps = [{ id: "dns", text: "Point the DNS record at the host." }];
  const sections = [{ name: "b.md", text: "B section." }, { name: "a.md", text: "A section." }];

  test("runs no skill and names the unit and the item: id, Epic, action text on one line and globs", () => {
    const p = item();
    expect(p).toContain("Run no skill.");
    expect(p).not.toMatch(/bmad-/);
    expect(p).toContain(`\`${ITEM_ID}\``);
    expect(p).toContain(`\`retro-item:${ITEM_ID}\``);
    expect(p).toContain("Epic 2's retrospective");
    expect(p).toContain("\n\nFix the x helper.\n\n");
    expect(p).toContain("`src/x/**`, `docs/x.md`");
  });
  test("task, rules, Human Live Steps, sections, then the build result step with its JSON Schema last", () => {
    const p = item({ human_live_steps: steps, sections });
    const order = ["# Task", "# Rules", "# Epic context", "# Human Live Steps", "`dns`: Point the DNS", "# Repository instructions", "A section.", "B section.", "# Result"].map((x) => p.indexOf(x));
    expect(order.every((x) => x >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(p).toContain(BUILD_RESULT_JSON_SCHEMA);
    expect(p).toContain("a `build` result");
    expect(p).toContain(RESULT);
    expect(p.trimEnd().endsWith("Write this file last, and do nothing after it.")).toBe(true);
    expect(p).not.toMatch(/\{\{[^{}]*\}\}/);
  });
  test("no steps and no sections omit those parts", () => {
    const p = item();
    expect(p).not.toContain("# Human Live Steps");
    expect(p).not.toContain("# Repository instructions");
  });
  test("the result step maps done, blocked (with a listed step id) and no-op", () => {
    const p = resultSection(item({ human_live_steps: steps }));
    for (const s of ["`outcome` `done`", "`outcome` `blocked`", "`outcome` `no-op`", "`intent-gap`", "`human-live-step`", "never one you make up"]) expect(p).toContain(s);
  });
  test("ci-fix mode: the CI log's absolute path, the item and its globs", () => {
    const p = item({ mode: { mode: "ci-fix", log_path: LOG } });
    expect(p).toContain("Repair the action item");
    expect(p).toContain(`\`${LOG}\``);
    expect(p).toContain("CI log");
    expect(p).toContain("Fix the x helper.");
    expect(p).toContain("`src/x/**`, `docs/x.md`");
    expect(p).toContain(BUILD_RESULT_JSON_SCHEMA);
  });
  test("loopback mode (Story 3.5): the findings' absolute path, the item, its globs and the Never-change list", () => {
    const p = item({ mode: { mode: "loopback", findings_path: FINDINGS } });
    expect(p).toContain("Revise the action item");
    expect(p).toContain(`\`${ITEM_ID}\``);
    expect(p).toContain(`\`retro-item:${ITEM_ID}\``);
    expect(p).toContain(`\`${FINDINGS}\``);
    expect(p).toContain("review findings");
    expect(p).toContain("Fix the x helper.");
    expect(p).toContain("`src/x/**`, `docs/x.md`");
    expect(p).toContain("Never change agent configuration (such as a `CLAUDE.md` or `AGENTS.md` file), the tracking files, the planning artifacts, `.xarabot/`, `.github/`");
    expect(p).not.toContain(LOG);
    expect(p).toContain(BUILD_RESULT_JSON_SCHEMA);
    expect(p).not.toMatch(/\{\{[^{}]*\}\}/);
  });
  test("an item text holding a placeholder is not re-expanded", () => {
    expect(item({ unit: { ...ITEM_UNIT, item: { ...ITEM_UNIT.item, text: "Keep {{log_path}} as it is." } } })).toContain("Keep {{log_path}} as it is.");
  });
  test("every retro-item part carries no banned instruction (CI log only)", () => {
    for (const part of ITEM_PARTS) {
      const text = PACKAGE_TEMPLATE[part as keyof PromptTemplate];
      expect({ part, hits: BANNED.filter((b) => b.pattern.test(text)).map((b) => b.what) }).toEqual({ part, hits: [] });
    }
    for (const mode of [{ mode: "build" }, { mode: "ci-fix", log_path: LOG }, { mode: "loopback", findings_path: FINDINGS }] as const) {
      for (const extra of [{}, { human_live_steps: steps, sections }]) {
        expect(BANNED.filter((b) => b.pattern.test(item({ mode, ...extra }))).map((b) => b.what)).toEqual([]);
      }
    }
  });
  const cases: { name: string; patch: Partial<BuildRetroItemPromptInput>; field: RegExp }[] = [
    { name: "a unit id not of the item", patch: { unit: { ...ITEM_UNIT, id: "retro-item:epic-2-retro-item-2-y" } }, field: /unit\.id: must be retro-item:<item id>/ },
    { name: "an item id of the wrong shape", patch: { unit: { ...ITEM_UNIT, id: "retro-item:x", item: { ...ITEM_UNIT.item, id: "x" } } }, field: /unit\.item\.id/ },
    { name: "an Epic not the item's", patch: { unit: { ...ITEM_UNIT, item: { ...ITEM_UNIT.item, epic: 3 } } }, field: /unit\.item\.epic: must be an item of its Epic/ },
    { name: "a blank text", patch: { unit: { ...ITEM_UNIT, item: { ...ITEM_UNIT.item, text: " \n" } } }, field: /unit\.item\.text/ },
    { name: "no globs", patch: { unit: { ...ITEM_UNIT, item: { ...ITEM_UNIT.item, globs: [] } } }, field: /unit\.item\.globs/ },
    { name: "a backtick in a glob", patch: { unit: { ...ITEM_UNIT, item: { ...ITEM_UNIT.item, globs: ["src/`x`"] } } }, field: /unit\.item\.globs/ },
    { name: "a relative log path", patch: { mode: { mode: "ci-fix", log_path: "ci.log" } }, field: /mode\.log_path/ },
    { name: "a relative findings path", patch: { mode: { mode: "loopback", findings_path: "findings.md" } }, field: /mode\.findings_path/ },
    { name: "a relative result path", patch: { result_path: "result.json" }, field: /result_path/ },
    { name: "a duplicate section", patch: { sections: [{ name: "a.md", text: "x" }, { name: "a.md", text: "y" }] }, field: /duplicate section/ },
    { name: "a duplicate step", patch: { human_live_steps: [...steps, ...steps] }, field: /duplicate step id/ },
  ];
  for (const c of cases) {
    test(`invalid input: ${c.name}`, () => {
      const e = itemFailure(c.patch);
      expect(e.kind).toBe("invalid-input");
      expect(e.message).toMatch(c.field);
    });
  }
  test("a Story placeholder in a retro-item part has no value", () => {
    const e = itemFailure({ template: { ...PACKAGE_TEMPLATE, retro_item: "x {{story_id}}" } });
    expect(e.kind).toBe("invalid-template");
    expect(e.message).toMatch(/\{\{story_id\}\} has no value in a retro-item build prompt/);
  });
  test("log_path in build mode has no value", () => {
    const e = itemFailure({ template: { ...PACKAGE_TEMPLATE, retro_item: "x {{log_path}}" } });
    expect(e.message).toMatch(/\{\{log_path\}\} has no value in a retro-item build prompt/);
  });
  test("a missing retro-item part", () => {
    const e = itemFailure({ template: { ...PACKAGE_TEMPLATE, result_retro_item: undefined } as unknown as PromptTemplate });
    expect(e.kind).toBe("invalid-template");
    expect(e.message).toMatch(/template: result_retro_item/);
  });
});

// ------------------------------------------------------------ Epic context and denials (Epic 2 retro item 8)

describe("Epic context and denials (Epic 2 retro item 8)", () => {
  const OWNS = "The runner owns each Epic context file, `epic-<N>-context.md` among the implementation artifacts, and reverts any change to it";
  const SKIP = "Never compile, recompile or edit one, even when a planning artifact is newer than it: load it as it is.";
  const DENIAL = "When your permission mode or the sandbox refuses an action, never work around it: do not retry it another way, such as with a changed environment variable, a disabled sandbox, another tool or another command. Record it in `denied_actions` in your result.";
  const SUBAGENT = "Give each subagent you start the rule above, and record each action refused to a subagent in `denied_actions` too.";
  const story = MODES.map((mode) => ({ name: `story ${mode.mode}`, p: build({ mode }) }));
  const items = [{ mode: "build" }, { mode: "ci-fix", log_path: LOG }, { mode: "loopback", findings_path: FINDINGS }].map((mode) => ({
    name: `retro-item ${mode.mode}`,
    p: item({ mode: mode as BuildRetroItemPromptInput["mode"] }),
  }));
  const others = [
    { name: "status planning", p: planning({ unit: STATUS_UNIT }) },
    { name: "graph planning", p: planning({ unit: GRAPH_UNIT }) },
    { name: "retro", p: retro() },
    { name: "normal review", p: review() },
    { name: "follow-up review", p: review({ pass: "followup" }) },
  ];

  for (const c of [...story, ...items]) {
    test(`${c.name}: says the runner owns and reverts the Epic context, so skip the recompile`, () => {
      expect(c.p).toContain(OWNS);
      expect(c.p).toContain(SKIP);
      const at = ["# Rules", "# Epic context", "# Result"].map((h) => c.p.indexOf(h));
      expect(at.every((i) => i >= 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    });
  }
  for (const c of others) {
    test(`${c.name}: carries no Epic context part`, () => {
      expect(c.p).not.toContain("# Epic context");
      expect(c.p).not.toContain(OWNS);
    });
  }
  for (const c of [...story, ...items, ...others]) {
    test(`${c.name}: a denial is recorded in denied_actions, never retried another way, by subagents too`, () => {
      const rules = c.p.slice(c.p.indexOf("# Rules\n"));
      expect(rules).toContain(DENIAL);
      expect(rules).toContain(SUBAGENT);
    });
  }
  test("the Epic context part carries no banned word of any prompt kind", () => {
    const text = PACKAGE_TEMPLATE.epic_context;
    for (const table of [BANNED, PLANNING_BANNED, RETRO_BANNED]) expect(table.filter((b) => b.pattern.test(text)).map((b) => b.what)).toEqual([]);
  });
  test("a missing epic_context part", () => {
    const e = failure({ template: { ...PACKAGE_TEMPLATE, epic_context: undefined } as unknown as PromptTemplate });
    expect(e.kind).toBe("invalid-template");
    expect(e.message).toMatch(/template: epic_context/);
  });
});

// ------------------------------------------------------------ review prompts (Story 3.4)

const HEAD = "a".repeat(40);
const MAIN = "b".repeat(40);
const SPEC = "_bmad-output/implementation-artifacts/spec-3-4-review-sessions.md";
const REVIEW_PARTS: readonly string[] = ["review", "review_followup", "review_rules", "result_review"];

function reviewInput(patch: Partial<BuildReviewPromptInput> = {}): BuildReviewPromptInput {
  return { template: PACKAGE_TEMPLATE, unit: { id: "story:3.4", head_sha: HEAD, main_sha: MAIN, spec_path: SPEC }, pass: "normal", result_path: RESULT, ...patch };
}

function review(patch: Partial<BuildReviewPromptInput> = {}): string {
  const r = buildReviewPrompt(reviewInput(patch));
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.value;
}

function reviewFailure(patch: Partial<BuildReviewPromptInput>): { kind: string; message: string } {
  const r = buildReviewPrompt(reviewInput(patch));
  if (r.ok) throw new Error("expected an error");
  return r.error;
}

describe("review prompt (Story 3.4)", () => {
  const noSpec = { id: "retro-item:epic-2-retro-item-1-fix-x", head_sha: HEAD, main_sha: MAIN, spec_path: null };

  test("names the unit, the reviewed SHA, main's SHA, the main...HEAD diff and the spec; runs no skill", () => {
    const p = review();
    expect(p).toContain("Review the change of `story:3.4` at commit `" + HEAD + "`.");
    expect(p).toContain(`\`main\` is at \`${MAIN}\``);
    expect(p).toContain("`git diff main...HEAD`");
    expect(p).toContain(`The spec for this change is \`${SPEC}\``);
    expect(p).toContain("Run no skill");
    expect(p).not.toMatch(/\bbmad-/);
    expect(p).toContain("show as uncommitted changes");
    expect(p).toContain("change no tracked file in this checkout");
    expect(p).toContain("Files the verification commands write are thrown away with the checkout.");
  });
  test("the review rules: work only here, denials and subagents, but no changes left for the runner and no clone", () => {
    for (const pass of ["normal", "followup"] as const) {
      const p = review({ pass });
      const rules = p.slice(p.indexOf("# Rules\n"), p.indexOf("# Result"));
      expect(rules).toContain("- Work only inside this checkout, your current working directory, and your temp folder.");
      expect(rules).toContain("Record it in `denied_actions` in your result.");
      expect(rules).toContain("Give each subagent you start the rule above");
      expect(p).not.toContain("Leave your changes");
      expect(p).not.toContain("the runner reads them from there");
      expect(p).not.toMatch(/\bclone\b/);
      expect(p).not.toContain(PACKAGE_TEMPLATE.rules);
    }
  });
  test("a unit with no spec says so and names no spec", () => {
    const p = review({ unit: noSpec });
    expect(p).toContain("Review the change of `retro-item:epic-2-retro-item-1-fix-x`");
    expect(p).toContain("This unit has no spec file");
    expect(p).not.toContain("spec-");
    expect(p).not.toContain("# Follow-up review");
  });
  test("task, rules, then the review result step with ReviewResultSchema's JSON Schema, last", () => {
    for (const pass of ["normal", "followup"] as const) {
      const p = review({ pass });
      const order = ["# Task", ...(pass === "followup" ? ["# Follow-up review"] : []), "# Rules", "# Result"].map((x) => p.indexOf(x));
      expect(order.every((x) => x >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      const r = resultSection(p);
      expect(p.endsWith(r)).toBe(true);
      expect(r).toContain("`$XARABOT_RESULT`");
      expect(r).toContain(`\`${RESULT}\``);
      expect(r).toContain("for a `review` result");
      expect(r).toContain(`- \`reviewed_sha\`: \`${HEAD}\``);
      for (const f of ["`verdict`", "`pass`", "`changes-requested`", "`findings`", "`severity`", "`blocking`", "`file`", "`text`", "`denied_actions`"]) expect(r).toContain(f);
      const m = /```json\n([\s\S]*?)\n```/.exec(r);
      expect(JSON.parse(m?.[1] ?? "null")).toEqual(z.toJSONSchema(ReviewResultSchema));
      expect(p).toContain(REVIEW_RESULT_JSON_SCHEMA);
      expect(p.trimEnd().endsWith("Write this file last, and do nothing after it.")).toBe(true);
      expect(p).not.toMatch(/\{\{[^{}]*\}\}/);
    }
  });
  test("the follow-up names the spec and its Auto Run Result risks", () => {
    const p = review({ pass: "followup" });
    const f = p.slice(p.indexOf("# Follow-up review"), p.indexOf("# Rules"));
    expect(f).toContain(`The spec \`${SPEC}\` asks for this follow-up review.`);
    expect(f).toContain("`## Auto Run Result`");
    expect(f).toContain("risks its build left unverified");
    expect(review()).not.toContain("# Follow-up review");
  });
  test("BANNED finds nothing in either pass, with or without a spec, nor in any review part", () => {
    for (const p of [review(), review({ pass: "followup" }), review({ unit: noSpec })]) {
      expect(BANNED.filter((b) => b.pattern.test(p)).map((b) => b.what)).toEqual([]);
    }
    for (const part of REVIEW_PARTS) {
      const text = PACKAGE_TEMPLATE[part as keyof PromptTemplate];
      expect({ part, hits: BANNED.filter((b) => b.pattern.test(text)).map((b) => b.what) }).toEqual({ part, hits: [] });
    }
  });
  test("carries no Epic context part", () => {
    expect(review()).not.toContain("# Epic context");
  });
  const cases: { name: string; patch: Partial<BuildReviewPromptInput>; field: RegExp }[] = [
    { name: "a follow-up with no spec", patch: { unit: noSpec, pass: "followup" }, field: /follow-up review needs a spec_path/ },
    { name: "a short head SHA", patch: { unit: { id: "story:3.4", head_sha: "abc123", main_sha: MAIN, spec_path: SPEC } }, field: /unit\.head_sha/ },
    { name: "an uppercase main SHA", patch: { unit: { id: "story:3.4", head_sha: HEAD, main_sha: MAIN.toUpperCase(), spec_path: SPEC } }, field: /unit\.main_sha/ },
    { name: "an empty unit id", patch: { unit: { id: "", head_sha: HEAD, main_sha: MAIN, spec_path: SPEC } }, field: /unit\.id/ },
    { name: "a backtick in the spec path", patch: { unit: { id: "story:3.4", head_sha: HEAD, main_sha: MAIN, spec_path: "a`b.md" } }, field: /unit\.spec_path/ },
    { name: "a newline in the unit id", patch: { unit: { id: "story:3.4\nx", head_sha: HEAD, main_sha: MAIN, spec_path: SPEC } }, field: /unit\.id/ },
    { name: "an unknown pass", patch: { pass: "third" as unknown as BuildReviewPromptInput["pass"] }, field: /pass/ },
    { name: "a relative result path", patch: { result_path: "result.json" }, field: /result_path/ },
  ];
  for (const c of cases) {
    test(`invalid input: ${c.name}`, () => {
      const e = reviewFailure(c.patch);
      expect(e.kind).toBe("invalid-input");
      expect(e.message).toMatch(c.field);
    });
  }
  test("a spec placeholder with no spec has no value", () => {
    const e = reviewFailure({ unit: noSpec, template: { ...PACKAGE_TEMPLATE, review: "x {{spec_path}}" } });
    expect(e.kind).toBe("invalid-template");
    expect(e.message).toMatch(/\{\{spec_path\}\} has no value in a normal review prompt/);
  });
  test("a Story placeholder in a review part has no value", () => {
    const e = reviewFailure({ template: { ...PACKAGE_TEMPLATE, review_followup: "x {{story_id}}" }, pass: "followup" });
    expect(e.message).toMatch(/\{\{story_id\}\} has no value in a follow-up review prompt/);
  });
  test("a missing review part", () => {
    const e = reviewFailure({ template: { ...PACKAGE_TEMPLATE, result_review: undefined } as unknown as PromptTemplate });
    expect(e.kind).toBe("invalid-template");
    expect(e.message).toMatch(/template: result_review/);
  });
});
