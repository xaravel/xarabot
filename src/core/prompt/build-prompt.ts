import { z } from "zod";
import { err, ok, type Result } from "../result.ts";
import { describeIssues } from "../schemas/common.ts";
import { HumanLiveStepSchema, type HumanLiveStep } from "../schemas/human-live-steps.ts";
import { RETRO_ITEM_ID_PATTERN } from "../schemas/retro-gates.ts";
import { BuildResultSchema, PlanningResultSchema, RetroResultSchema } from "../schemas/session-result.ts";
import { STORY_ID_PATTERN } from "../story-id.ts";
import { PLACEHOLDERS, type Placeholder, type PromptTemplate } from "./template.ts";

/**
 * Prompt assembly (AR30, AD-29): one pure function builds a session's prompt
 * from the template, the repo's `.xarabot/prompts/` sections, the unit, the
 * Human Live Steps list and the result path. It reads nothing itself: the
 * lane passes everything in, from `origin/main`.
 */

export type PromptMode =
  | { readonly mode: "build" }
  | { readonly mode: "loopback"; readonly findings_path: string }
  | { readonly mode: "ci-fix"; readonly log_path: string };

/** One repo prompt section: its file name in `.xarabot/prompts/` and its text. */
export type PromptSection = { readonly name: string; readonly text: string };

export type PromptUnit = { readonly kind: "story"; readonly id: string; readonly sprint_key: string };

export type BuildPromptInput = {
  readonly template: PromptTemplate;
  readonly unit: PromptUnit;
  readonly mode: PromptMode;
  readonly sections: readonly PromptSection[];
  readonly human_live_steps: readonly HumanLiveStep[];
  readonly result_path: string;
};

export type BuildPromptError = "invalid-input" | "invalid-template";

/** The `build` result's JSON Schema, embedded in the result step. */
export const BUILD_RESULT_JSON_SCHEMA = JSON.stringify(z.toJSONSchema(BuildResultSchema), null, 2);

/** The `planning` result's JSON Schema, embedded in a planning prompt's result step. */
export const PLANNING_RESULT_JSON_SCHEMA = JSON.stringify(z.toJSONSchema(PlanningResultSchema), null, 2);

/** The `retro` result's JSON Schema, embedded in a retro prompt's result step (Story 2.9). */
export const RETRO_RESULT_JSON_SCHEMA = JSON.stringify(z.toJSONSchema(RetroResultSchema), null, 2);

const PATH_MESSAGE = "must be an absolute path with no control character or backtick";

/** A C0 or C1 control character, a line or paragraph separator, or a backtick. */
function isUnsafe(c: string): boolean {
  const code = c.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || c === "`";
}

/** An absolute path that can sit inside backticks on one line. */
const AbsolutePath = z
  .string()
  .refine((p) => p.startsWith("/") && ![...p].some(isUnsafe), PATH_MESSAGE);

const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";

const SectionsSchema = z.array(
  z.strictObject({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/, "must be a file name <name>.md"),
    text: z.string(),
  }),
);

const InputSchema = z.strictObject({
  unit: z.strictObject({
    kind: z.literal("story"),
    id: z.string().regex(STORY_ID_PATTERN, "must be a Story id like 1.7 or 1.17a"),
    sprint_key: z.string(),
  }),
  mode: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("build") }),
    z.strictObject({ mode: z.literal("loopback"), findings_path: AbsolutePath }),
    z.strictObject({ mode: z.literal("ci-fix"), log_path: AbsolutePath }),
  ]),
  sections: SectionsSchema,
  human_live_steps: z.array(
    HumanLiveStepSchema.extend({
      id: HumanLiveStepSchema.shape.id.refine(
        (id) => ![...id].some(isUnsafe),
        "must have no control character, line separator or backtick",
      ),
    }),
  ),
  result_path: AbsolutePath,
});

const TemplateSchema = z.strictObject({
  first_build: z.string(),
  loopback: z.string(),
  ci_fix: z.string(),
  rules: z.string(),
  human_live_steps: z.string(),
  repo_sections: z.string(),
  result_build: z.string(),
  result_fix: z.string(),
  planning_status: z.string(),
  planning_graph: z.string(),
  result_planning: z.string(),
  retro: z.string(),
  result_retro: z.string(),
  retro_item: z.string(),
  retro_item_ci_fix: z.string(),
  result_retro_item: z.string(),
});

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

function isPlaceholder(name: string): name is Placeholder {
  return (PLACEHOLDERS as readonly string[]).includes(name);
}

/** The duplicate in a list of names, if any. */
function firstDuplicate(names: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) return n;
    seen.add(n);
  }
  return undefined;
}

/** The strict template parse, then every part's placeholders checked against `PLACEHOLDERS`. */
function checkTemplate(template: PromptTemplate): Result<z.infer<typeof TemplateSchema>, BuildPromptError> {
  const parsed = TemplateSchema.safeParse(template);
  if (!parsed.success) return err("invalid-template", `template: ${describeIssues(parsed.error)}`);
  for (const [part, text] of Object.entries(parsed.data)) {
    for (const m of text.matchAll(PLACEHOLDER)) {
      const name = m[1] as string;
      if (!isPlaceholder(name)) return err("invalid-template", `template.${part}: unknown placeholder {{${name}}}`);
    }
  }
  return ok(parsed.data);
}

/** `parts` joined and filled from `values` in one pass; a placeholder with no value is an error naming `what`. */
function fill(parts: readonly string[], values: Partial<Record<Placeholder, string>>, what: string): Result<string, BuildPromptError> {
  const missing = new Set<string>();
  const prompt = parts.join("\n\n").replace(PLACEHOLDER, (whole, name: string) => {
    const value = isPlaceholder(name) ? values[name] : undefined;
    if (value === undefined) {
      missing.add(name);
      return whole;
    }
    return value;
  });
  if (missing.size > 0) {
    const names = [...missing].map((n) => `{{${n}}}`).join(", ");
    return err("invalid-template", `template: ${names} has no value in ${what}`);
  }
  return ok(prompt);
}

/** The repo sections' texts, ordered by file name. */
function sectionsText(sections: readonly PromptSection[]): string {
  return [...sections]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((s) => s.text)
    .join("\n\n");
}

/**
 * Builds a `story` prompt: task, rules, Human Live Steps, repo sections, and
 * the result step last. Placeholders are filled in one pass, so a value that
 * contains `{{x}}` is never re-expanded.
 */
export function buildPrompt(input: BuildPromptInput): Result<string, BuildPromptError> {
  const template = checkTemplate(input.template);
  if (!template.ok) return template;
  const t = template.value;

  const parsed = InputSchema.safeParse({
    unit: input.unit,
    mode: input.mode,
    sections: input.sections,
    human_live_steps: input.human_live_steps,
    result_path: input.result_path,
  });
  if (!parsed.success) return err("invalid-input", describeIssues(parsed.error));
  const { unit, mode, sections, human_live_steps: steps, result_path } = parsed.data;

  const keyPrefix = `${unit.id.replace(".", "-")}-`;
  if (!new RegExp(`^${keyPrefix}${SLUG}$`).test(unit.sprint_key)) {
    return err("invalid-input", `unit.sprint_key: must be "${keyPrefix}<slug>" in lowercase kebab case`);
  }
  const dupSection = firstDuplicate(sections.map((s) => s.name));
  if (dupSection !== undefined) return err("invalid-input", `sections: duplicate section "${dupSection}"`);
  const dupStep = firstDuplicate(steps.map((s) => s.id));
  if (dupStep !== undefined) return err("invalid-input", `human_live_steps: duplicate step id "${dupStep}"`);

  const values: Partial<Record<Placeholder, string>> = {
    story_id: unit.id,
    sprint_key: unit.sprint_key,
    result_path,
    result_schema: BUILD_RESULT_JSON_SCHEMA,
    steps: steps.map((s) => `- \`${s.id}\`: ${s.text.replace(/\s+/g, " ")}`).join("\n"),
    sections: sectionsText(sections),
  };
  if (mode.mode === "loopback") values.findings_path = mode.findings_path;
  if (mode.mode === "ci-fix") values.log_path = mode.log_path;

  const parts: string[] = [];
  parts.push(mode.mode === "build" ? t.first_build : mode.mode === "loopback" ? t.loopback : t.ci_fix);
  parts.push(t.rules);
  if (steps.length > 0) parts.push(t.human_live_steps);
  if (sections.length > 0) parts.push(t.repo_sections);
  parts.push(mode.mode === "build" ? t.result_build : t.result_fix);

  return fill(parts, values, `${mode.mode} mode`);
}

// ------------------------------------------------------------ planning prompts

/** A planning heading: a Story heading in `epics_path` with no manifest. */
export type PlanningPromptHeading = { readonly id: string; readonly epic: number; readonly line: number };

/** A status planning unit: the Epics whose context file it compiles, each with its output path. */
export type StatusPlanningPromptUnit = {
  readonly kind: "status";
  readonly id: string;
  readonly epics_path: string;
  readonly contexts: readonly { readonly epic: number; readonly output_path: string }[];
};

/** A graph planning unit: the headings it writes manifests for, and where. */
export type GraphPlanningPromptUnit = {
  readonly kind: "graph";
  readonly id: string;
  readonly epics_path: string;
  readonly manifests_dir: string;
  /** `manifests.path_key` and the `path_map` keys, or `null` when manifests carry `globs`. */
  readonly path_key: { readonly key: string; readonly values: readonly string[] } | null;
  readonly headings: readonly PlanningPromptHeading[];
};

export type PlanningPromptUnit = StatusPlanningPromptUnit | GraphPlanningPromptUnit;

export type BuildPlanningPromptInput = {
  readonly template: PromptTemplate;
  readonly unit: PlanningPromptUnit;
  readonly sections: readonly PromptSection[];
  readonly result_path: string;
};

const SAFE_MESSAGE = "must be non-empty with no control character, line separator or backtick";

/** Text that can sit inside backticks on one line. */
const SafeText = z
  .string()
  .min(1, SAFE_MESSAGE)
  .refine((p) => ![...p].some(isUnsafe), SAFE_MESSAGE);

const planningId = (kind: "status" | "graph") =>
  z.string().regex(new RegExp(`^planning:${kind}\\.[1-9][0-9]*$`), `must be planning:${kind}.<n>`);

const PlanningInputSchema = z.strictObject({
  unit: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("status"),
      id: planningId("status"),
      epics_path: SafeText,
      contexts: z.array(z.strictObject({ epic: z.int().positive(), output_path: SafeText })),
    }),
    z.strictObject({
      kind: z.literal("graph"),
      id: planningId("graph"),
      epics_path: SafeText,
      manifests_dir: SafeText,
      path_key: z.strictObject({ key: SafeText, values: z.array(SafeText).min(1) }).nullable(),
      headings: z
        .array(
          z.strictObject({
            id: z.string().regex(STORY_ID_PATTERN, "must be a Story id like 1.7 or 1.17a"),
            epic: z.int().positive(),
            line: z.int().min(1),
          }),
        )
        .min(1, "a graph unit needs at least one heading"),
    }),
  ]),
  sections: SectionsSchema,
  result_path: AbsolutePath,
});

/** The folder of a repo path: everything before its last `/`, or `.` at the top level. */
function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "." : path.slice(0, i);
}

/**
 * Builds a planning prompt (Story 2.7): the unit's task (`planning_status`
 * or `planning_graph`), the rules, the repo sections, and the `planning`
 * result step with its JSON Schema last. Pure; placeholders are filled in
 * one pass, as for a Story.
 */
export function buildPlanningPrompt(input: BuildPlanningPromptInput): Result<string, BuildPromptError> {
  const template = checkTemplate(input.template);
  if (!template.ok) return template;
  const t = template.value;

  const parsed = PlanningInputSchema.safeParse({ unit: input.unit, sections: input.sections, result_path: input.result_path });
  if (!parsed.success) return err("invalid-input", describeIssues(parsed.error));
  const { unit, sections, result_path } = parsed.data;
  const dupSection = firstDuplicate(sections.map((s) => s.name));
  if (dupSection !== undefined) return err("invalid-input", `sections: duplicate section "${dupSection}"`);

  const values: Partial<Record<Placeholder, string>> = {
    planning_unit: unit.id,
    epics_path: unit.epics_path,
    result_path,
    result_schema: PLANNING_RESULT_JSON_SCHEMA,
    sections: sectionsText(sections),
  };
  if (unit.kind === "status") {
    const dup = firstDuplicate(unit.contexts.map((c) => String(c.epic)));
    if (dup !== undefined) return err("invalid-input", `unit.contexts: duplicate Epic ${dup}`);
    values.epics_dir = folderOf(unit.epics_path);
    values.planning_contexts =
      unit.contexts.length === 0
        ? "- None: no Epic context file is due."
        : [...unit.contexts]
            .sort((a, b) => a.epic - b.epic)
            .map((c) => `- Epic ${c.epic}: output path \`${c.output_path}\``)
            .join("\n");
  } else {
    const dup = firstDuplicate(unit.headings.map((h) => h.id));
    if (dup !== undefined) return err("invalid-input", `unit.headings: duplicate Story ${dup}`);
    values.manifests_dir = unit.manifests_dir;
    values.planning_headings = unit.headings.map((h) => `- Story ${h.id} (Epic ${h.epic}), line ${h.line}`).join("\n");
    values.manifest_paths =
      unit.path_key === null
        ? "`globs`: a list of quoted repo-relative globs covering every file the Story's work changes."
        : `\`${unit.path_key.key}\`: the area the Story's work changes, one of ${unit.path_key.values.map((v) => `\`${v}\``).join(", ")}.`;
  }

  const parts: string[] = [unit.kind === "status" ? t.planning_status : t.planning_graph, t.rules];
  if (sections.length > 0) parts.push(t.repo_sections);
  parts.push(t.result_planning);
  return fill(parts, values, `a ${unit.kind} planning prompt`);
}

// ------------------------------------------------------------ retro prompts

/** A retro unit (Story 2.9): its id, its Epic and the prefetched PR file's absolute path. */
export type RetroPromptUnit = {
  readonly kind: "retro";
  readonly id: string;
  readonly epic: number;
  readonly prs_path: string;
};

export type BuildRetroPromptInput = {
  readonly template: PromptTemplate;
  readonly unit: RetroPromptUnit;
  readonly sections: readonly PromptSection[];
  readonly result_path: string;
};

const RetroInputSchema = z.strictObject({
  unit: z
    .strictObject({
      kind: z.literal("retro"),
      id: z.string().regex(/^retro:[1-9][0-9]*$/, "must be retro:<N>"),
      epic: z.int().positive(),
      prs_path: AbsolutePath,
    })
    .refine((u) => u.id === `retro:${u.epic}`, { message: "must be retro:<epic>", path: ["id"] }),
  sections: SectionsSchema,
  result_path: AbsolutePath,
});

/**
 * Builds a retro prompt (Story 2.9): the `retro` task (`bmad-retrospective
 * -H <N>` on the prefetched PR file), the rules, the repo sections, and the
 * `retro` result step with its JSON Schema last. Pure; placeholders are
 * filled in one pass.
 */
export function buildRetroPrompt(input: BuildRetroPromptInput): Result<string, BuildPromptError> {
  const template = checkTemplate(input.template);
  if (!template.ok) return template;
  const t = template.value;

  const parsed = RetroInputSchema.safeParse({ unit: input.unit, sections: input.sections, result_path: input.result_path });
  if (!parsed.success) return err("invalid-input", describeIssues(parsed.error));
  const { unit, sections, result_path } = parsed.data;
  const dupSection = firstDuplicate(sections.map((s) => s.name));
  if (dupSection !== undefined) return err("invalid-input", `sections: duplicate section "${dupSection}"`);

  const values: Partial<Record<Placeholder, string>> = {
    retro_unit: unit.id,
    retro_epic: String(unit.epic),
    prs_path: unit.prs_path,
    result_path,
    result_schema: RETRO_RESULT_JSON_SCHEMA,
    sections: sectionsText(sections),
  };
  const parts: string[] = [t.retro, t.rules];
  if (sections.length > 0) parts.push(t.repo_sections);
  parts.push(t.result_retro);
  return fill(parts, values, "a retro prompt");
}

// ------------------------------------------------------------ retro-item prompts

/** A retro-item unit (Story 2.10): its id, and the item's id, Epic, action text and globs. */
export type RetroItemPromptUnit = {
  readonly kind: "retro-item";
  /** `retro-item:<item id>`. */
  readonly id: string;
  readonly item: {
    readonly id: string;
    readonly epic: number;
    readonly text: string;
    readonly globs: readonly string[];
  };
};

/** A retro-item session's mode: its first build, or a CI fix with the prefetched log's absolute path. */
export type RetroItemPromptMode = { readonly mode: "build" } | { readonly mode: "ci-fix"; readonly log_path: string };

export type BuildRetroItemPromptInput = {
  readonly template: PromptTemplate;
  readonly unit: RetroItemPromptUnit;
  readonly mode: RetroItemPromptMode;
  readonly sections: readonly PromptSection[];
  readonly human_live_steps: readonly HumanLiveStep[];
  readonly result_path: string;
};

const RetroItemInputSchema = z.strictObject({
  unit: z
    .strictObject({
      kind: z.literal("retro-item"),
      id: z.string(),
      item: z.strictObject({
        id: z.string().regex(RETRO_ITEM_ID_PATTERN, "must be epic-<N>-retro-item-<seq>-<slug>"),
        epic: z.int().positive(),
        text: z.string().regex(/\S/, "must not be blank"),
        globs: z.array(SafeText).min(1, "a retro item unit needs at least one glob"),
      }),
    })
    .refine((u) => u.id === `retro-item:${u.item.id}`, { message: "must be retro-item:<item id>", path: ["id"] })
    .refine((u) => RETRO_ITEM_ID_PATTERN.exec(u.item.id)?.[1] === String(u.item.epic), { message: "must be an item of its Epic", path: ["item", "epic"] }),
  mode: z.discriminatedUnion("mode", [z.strictObject({ mode: z.literal("build") }), z.strictObject({ mode: z.literal("ci-fix"), log_path: AbsolutePath })]),
  sections: SectionsSchema,
  human_live_steps: InputSchema.shape.human_live_steps,
  result_path: AbsolutePath,
});

/**
 * Builds a retro-item prompt (Story 2.10): the `retro_item` task (or
 * `retro_item_ci_fix` with the CI log), which runs no skill and names the
 * unit and the item (its id, Epic, action text on one line and globs), the
 * rules, the Human Live Steps, the repo sections, and the `build` result
 * step with its JSON Schema last. Pure; placeholders are filled in one pass,
 * so an item text holding `{{x}}` is never re-expanded.
 */
export function buildRetroItemPrompt(input: BuildRetroItemPromptInput): Result<string, BuildPromptError> {
  const template = checkTemplate(input.template);
  if (!template.ok) return template;
  const t = template.value;

  const parsed = RetroItemInputSchema.safeParse({
    unit: input.unit,
    mode: input.mode,
    sections: input.sections,
    human_live_steps: input.human_live_steps,
    result_path: input.result_path,
  });
  if (!parsed.success) return err("invalid-input", describeIssues(parsed.error));
  const { unit, mode, sections, human_live_steps: steps, result_path } = parsed.data;
  const dupSection = firstDuplicate(sections.map((s) => s.name));
  if (dupSection !== undefined) return err("invalid-input", `sections: duplicate section "${dupSection}"`);
  const dupStep = firstDuplicate(steps.map((s) => s.id));
  if (dupStep !== undefined) return err("invalid-input", `human_live_steps: duplicate step id "${dupStep}"`);

  const values: Partial<Record<Placeholder, string>> = {
    retro_item_unit: unit.id,
    retro_item_id: unit.item.id,
    retro_item_epic: String(unit.item.epic),
    retro_item_text: unit.item.text.replace(/\s+/g, " ").trim(),
    retro_item_globs: unit.item.globs.map((g) => `\`${g}\``).join(", "),
    result_path,
    result_schema: BUILD_RESULT_JSON_SCHEMA,
    steps: steps.map((s) => `- \`${s.id}\`: ${s.text.replace(/\s+/g, " ")}`).join("\n"),
    sections: sectionsText(sections),
  };
  if (mode.mode === "ci-fix") values.log_path = mode.log_path;

  const parts: string[] = [mode.mode === "build" ? t.retro_item : t.retro_item_ci_fix, t.rules];
  if (steps.length > 0) parts.push(t.human_live_steps);
  if (sections.length > 0) parts.push(t.repo_sections);
  parts.push(t.result_retro_item);
  return fill(parts, values, `a retro-item ${mode.mode} prompt`);
}
