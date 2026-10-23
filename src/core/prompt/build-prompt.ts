import { z } from "zod";
import { err, ok, type Result } from "../result.ts";
import { describeIssues } from "../schemas/common.ts";
import { HumanLiveStepSchema, type HumanLiveStep } from "../schemas/human-live-steps.ts";
import { BuildResultSchema } from "../schemas/session-result.ts";
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
  sections: z.array(
    z.strictObject({
      name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/, "must be a file name <name>.md"),
      text: z.string(),
    }),
  ),
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

/**
 * Builds a `story` prompt: task, rules, Human Live Steps, repo sections, and
 * the result step last. Placeholders are filled in one pass, so a value that
 * contains `{{x}}` is never re-expanded.
 */
export function buildPrompt(input: BuildPromptInput): Result<string, BuildPromptError> {
  const template = TemplateSchema.safeParse(input.template);
  if (!template.success) return err("invalid-template", `template: ${describeIssues(template.error)}`);
  const t = template.data;

  for (const [part, text] of Object.entries(t)) {
    for (const m of text.matchAll(PLACEHOLDER)) {
      const name = m[1] as string;
      if (!isPlaceholder(name)) return err("invalid-template", `template.${part}: unknown placeholder {{${name}}}`);
    }
  }

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
    sections: [...sections]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((s) => s.text)
      .join("\n\n"),
  };
  if (mode.mode === "loopback") values.findings_path = mode.findings_path;
  if (mode.mode === "ci-fix") values.log_path = mode.log_path;

  const parts: string[] = [];
  parts.push(mode.mode === "build" ? t.first_build : mode.mode === "loopback" ? t.loopback : t.ci_fix);
  parts.push(t.rules);
  if (steps.length > 0) parts.push(t.human_live_steps);
  if (sections.length > 0) parts.push(t.repo_sections);
  parts.push(mode.mode === "build" ? t.result_build : t.result_fix);

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
    return err("invalid-template", `template: ${names} has no value in ${mode.mode} mode`);
  }
  return ok(prompt);
}
