import { err, ok, type Result } from "../result.ts";

export type EpicsMdStory = { readonly id: string; readonly epic: number; readonly title: string; readonly line: number };
export type EpicsMdEpic = {
  readonly number: number;
  readonly title: string;
  readonly line: number;
  readonly stories: EpicsMdStory[];
};
export type EpicsMd = { readonly epics: EpicsMdEpic[] };

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const EPIC = /^## Epic (\d+):(.*)$/;
const LEVEL_2 = /^##(?:[ \t]|$)/;
const STORY = /^### Story (\d+)\.(\d+)([a-z]?):(.*)$/;
const NEAR_STORY = /^### Story\b/;
const NEAR_EPIC = /^## Epic\s+\d/;

/**
 * Reads the Epic and Story headings of `epics.md`: `## Epic <n>:` starts an
 * Epic, any other level-2 heading ends it, and `### Story <n>.<n>[a-z]?:` is a
 * Story of the current Epic. Fenced code is skipped. Pure.
 */
export function parseEpicsMd(path: string, text: string): Result<EpicsMd, "invalid"> {
  const lines = text.split(/\r?\n/);
  const epics: EpicsMdEpic[] = [];
  const epicLines = new Map<number, number>();
  const storyLines = new Map<string, number>();
  let current: EpicsMdEpic | undefined;
  let fence: RegExp | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const lineNo = i + 1;
    if (fence !== undefined) {
      if (fence.test(line)) fence = undefined;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open !== null) {
      const run = open[1] as string;
      fence = new RegExp(`^ {0,3}\\${run[0] as string}{${run.length},}[ \\t]*$`);
      continue;
    }

    const epic = EPIC.exec(line);
    if (epic !== null) {
      const number = Number(epic[1]);
      const prior = epicLines.get(number);
      if (prior !== undefined) return err("invalid", `${path}: line ${lineNo}: Epic ${number} repeats line ${prior}`);
      epicLines.set(number, lineNo);
      current = { number, title: (epic[2] as string).trim(), line: lineNo, stories: [] };
      epics.push(current);
      continue;
    }
    if (NEAR_EPIC.test(line)) {
      return err("invalid", `${path}: line ${lineNo}: malformed Epic heading (expected "## Epic <n>: <title>")`);
    }
    if (LEVEL_2.test(line)) {
      current = undefined;
      continue;
    }

    const story = STORY.exec(line);
    if (story !== null) {
      const [, epicPart, storyPart, suffix, title] = story as unknown as [string, string, string, string, string];
      const id = `${epicPart}.${storyPart}${suffix}`;
      if (current === undefined) {
        return err("invalid", `${path}: line ${lineNo}: Story ${id} is not under an "## Epic <n>:" heading`);
      }
      if (Number(epicPart) !== current.number) {
        return err("invalid", `${path}: line ${lineNo}: Story ${id} is under Epic ${current.number} (line ${current.line})`);
      }
      const key = `${Number(epicPart)}.${Number(storyPart)}${suffix}`;
      const prior = storyLines.get(key);
      if (prior !== undefined) return err("invalid", `${path}: line ${lineNo}: Story ${id} repeats line ${prior}`);
      storyLines.set(key, lineNo);
      current.stories.push({ id, epic: current.number, title: title.trim(), line: lineNo });
      continue;
    }
    if (NEAR_STORY.test(line)) {
      return err("invalid", `${path}: line ${lineNo}: malformed Story heading (expected "### Story <n>.<n>[a-z]: <title>")`);
    }
  }
  return ok({ epics });
}
