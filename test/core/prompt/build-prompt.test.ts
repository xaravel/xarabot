import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { buildPrompt, type BuildPromptInput, type PromptMode } from "../../../src/core/prompt/build-prompt.ts";
import { PACKAGE_TEMPLATE, type PromptTemplate } from "../../../src/core/prompt/template.ts";
import { BuildResultSchema } from "../../../src/core/schemas/session-result.ts";

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
    for (const kind of ["intent-gap", "verification", "human-live-step", "escalation", "other", "no-op", "blocked.step_id"]) {
      expect(r).toContain(`\`${kind}\``);
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
  test("every part of the package template", () => {
    for (const [part, text] of Object.entries(PACKAGE_TEMPLATE)) {
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
