import { err, ok, type Result } from "../result.ts";
import { parseYaml } from "../schemas/common.ts";

/**
 * The status-YAML conflict rule (AR20, AD-19): when a PR and `main` both
 * changed a status file, keep `main`'s text, comments included, and re-apply
 * the PR's own entries. Pure. The text is split by lines into block-mapping
 * entries; anything it cannot split that way is an error, never a guess.
 */

/** The lockfile basenames the merge treats as regenerable. */
export const LOCKFILE_NAMES = ["bun.lock", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"] as const;

/** True when `path`'s basename is a known lockfile. */
export function isLockfile(path: string): boolean {
  const base = path.split("/").at(-1) ?? "";
  return (LOCKFILE_NAMES as readonly string[]).includes(base);
}

export type StatusMergeInput = {
  /** The merge base's text; `""` when the file is new on both sides. */
  readonly base: string;
  readonly pr: string;
  readonly main: string;
};

export type Entry = {
  readonly kind: "entry";
  readonly key: string;
  readonly indent: number;
  /** The entry's whole span: the key line and everything under it. */
  readonly lines: readonly string[];
  /** The nested mapping under the key, when its value is one. */
  readonly children: Level | null;
};
type Trivia = { readonly kind: "trivia"; readonly line: string };
type Item = Entry | Trivia;
type Level = { readonly indent: number | null; readonly items: readonly Item[] };

type Step<T> = Result<T, "invalid">;

const bad = (message: string) => err("invalid", message);

function leading(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === " ") i += 1;
  return i;
}

function isTrivia(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

function isSeqItem(line: string): boolean {
  const t = line.trimStart();
  return t === "-" || t.startsWith("- ");
}

const INDICATORS = "-?#{}[]|>%@`!&*,";

/** The key and the rest of a block-mapping key line, or `null` when `line` is not one. */
export function keyLine(line: string): { readonly key: string; readonly rest: string } | null {
  const s = line.slice(leading(line));
  if (s === "") return null;
  let key: string;
  let after: string;
  const q = s[0] as string;
  if (q === '"' || q === "'") {
    let i = 1;
    for (; i < s.length; i += 1) {
      const c = s[i];
      if (q === '"' && c === "\\") {
        i += 1;
        continue;
      }
      if (c === q) {
        if (q === "'" && s[i + 1] === "'") {
          i += 1;
          continue;
        }
        break;
      }
    }
    if (i >= s.length) return null;
    const raw = s.slice(0, i + 1);
    if (q === '"') {
      try {
        key = String(JSON.parse(raw));
      } catch {
        key = raw.slice(1, -1);
      }
    } else {
      key = raw.slice(1, -1).replaceAll("''", "'");
    }
    after = s.slice(i + 1).trimStart();
    if (!after.startsWith(":")) return null;
    after = after.slice(1);
    if (after !== "" && after[0] !== " ") return null;
  } else {
    if (INDICATORS.includes(q)) return null;
    let colon = -1;
    for (let i = 0; i < s.length; i += 1) {
      if (s[i] === "#" && i > 0 && s[i - 1] === " ") return null;
      if (s[i] === ":" && (i + 1 === s.length || s[i + 1] === " ")) {
        colon = i;
        break;
      }
    }
    if (colon === -1) return null;
    key = s.slice(0, colon).trimEnd();
    after = s.slice(colon + 1);
  }
  return { key, rest: after };
}

function emptyValue(rest: string): boolean {
  const t = rest.trim();
  return t === "" || t.startsWith("#");
}

/** Splits `lines` into one mapping level deeper than `parent` (`-1` for the top). */
function parseLevel(path: string, lines: readonly string[], parent: number): Step<Level> {
  const first = lines.find((l) => !isTrivia(l));
  if (first === undefined) return ok({ indent: null, items: lines.map((line) => ({ kind: "trivia", line })) });
  const indent = leading(first);
  if (indent <= parent) return bad(`${path}: a line is not indented under its key: ${JSON.stringify(first)}`);
  const items: Item[] = [];
  const keys = new Set<string>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (isTrivia(line)) {
      items.push({ kind: "trivia", line });
      i += 1;
      continue;
    }
    if (leading(line) !== indent) return bad(`${path}: a line does not start a mapping entry at indent ${indent}: ${JSON.stringify(line)}`);
    const k = keyLine(line);
    if (k === null) return bad(`${path}: not a block-mapping entry: ${JSON.stringify(line)}`);
    if (keys.has(k.key)) return bad(`${path}: the key ${JSON.stringify(k.key)} appears twice`);
    keys.add(k.key);
    const empty = emptyValue(k.rest);
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j] as string;
      if (isTrivia(l) || leading(l) > indent || (empty && leading(l) === indent && isSeqItem(l))) j += 1;
      else break;
    }
    while (j > i + 1 && isTrivia(lines[j - 1] as string)) j -= 1;
    const span = lines.slice(i, j);
    let children: Level | null = null;
    const body = span.slice(1);
    const child = body.find((l) => !isTrivia(l));
    if (empty && child !== undefined && leading(child) > indent && keyLine(child) !== null && !isSeqItem(child)) {
      const parsed = parseLevel(path, body, indent);
      if (!parsed.ok) return parsed;
      children = parsed.value;
    }
    items.push({ kind: "entry", key: k.key, indent, lines: span, children });
    i = j;
  }
  return ok({ indent, items });
}

/** The lines of `text`, refusing what the line splitter cannot handle. */
function splitText(path: string, text: string): Step<{ readonly lines: string[]; readonly crlf: boolean }> {
  const crlf = text.includes("\r\n");
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  for (const l of lines) {
    if (/^[ ]*\t/.test(l)) return bad(`${path}: a line is indented with a tab`);
    if (/^(?:---|\.\.\.)(?:\s|$)/.test(l)) return bad(`${path}: a document marker (multiple documents) is not supported`);
    if (l.startsWith("%")) return bad(`${path}: a YAML directive is not supported`);
  }
  return ok({ lines, crlf });
}

/**
 * A status YAML text split by lines into block-mapping levels: the items of
 * each level cover its lines in order, so line positions can be counted.
 * Whether the text used CRLF line ends. Shared with the `reconcile` status
 * editor.
 */
export function parseStatusText(path: string, text: string): Step<{ readonly level: Level; readonly crlf: boolean }> {
  const split = splitText(path, text);
  if (!split.ok) return split;
  const level = parseLevel(path, split.value.lines, -1);
  if (!level.ok) return level;
  return ok({ level: level.value, crlf: split.value.crlf });
}

/** An entry's text relative to its own indent, for comparison. */
function textOf(e: Entry): string {
  return e.lines.map((l) => l.slice(Math.min(e.indent, leading(l)))).join("\n");
}

/** `e` moved to `indent`. */
function reindent(e: Entry, indent: number): Entry {
  const shift = indent - e.indent;
  if (shift === 0) return e;
  const lines = e.lines.map((l) => {
    if (l.trim() === "") return l;
    if (shift > 0) return " ".repeat(shift) + l;
    return l.slice(Math.min(-shift, leading(l)));
  });
  return { kind: "entry", key: e.key, indent, lines, children: null };
}

function entries(level: Level): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const it of level.items) if (it.kind === "entry") out.set(it.key, it);
  return out;
}

function render(items: readonly Item[]): string[] {
  return items.flatMap((it) => (it.kind === "trivia" ? [it.line] : [...it.lines]));
}

const EMPTY: Level = { indent: null, items: [] };

/** Re-applies the PR's changes against `base` onto `main`'s level. */
function mergeLevel(base: Level, pr: Level, main: Level): Step<Item[]> {
  const b = entries(base);
  const p = entries(pr);
  const m = entries(main);
  const indent = main.indent ?? pr.indent ?? 0;
  const out: Item[] = [...main.items];
  const at = (key: string): number => out.findIndex((it) => it.kind === "entry" && it.key === key);
  const replace = (key: string, e: Entry): void => {
    out[at(key)] = e;
  };
  const additions = new Set<string>();

  /** Both sides touched `key`: nested mappings merge recursively, anything else takes the PR's. */
  const both = (key: string, be: Entry | undefined, pe: Entry, me: Entry): Step<void> => {
    if (pe.children !== null && me.children !== null && (be === undefined || be.children !== null)) {
      const merged = mergeLevel(be?.children ?? EMPTY, pe.children, me.children);
      if (!merged.ok) return merged;
      replace(key, { kind: "entry", key, indent: me.indent, lines: [me.lines[0] as string, ...render(merged.value)], children: null });
      return ok(undefined);
    }
    replace(key, reindent(pe, indent));
    return ok(undefined);
  };

  for (const [key, pe] of p) {
    const be = b.get(key);
    const me = m.get(key);
    if (be !== undefined && textOf(pe) === textOf(be)) continue;
    if (me === undefined) {
      additions.add(key);
      continue;
    }
    if (textOf(me) === textOf(pe)) continue;
    if (be !== undefined && textOf(me) === textOf(be)) {
      replace(key, reindent(pe, indent));
      continue;
    }
    const r = both(key, be, pe, me);
    if (!r.ok) return r;
  }
  for (const key of b.keys()) {
    if (p.has(key)) continue;
    const i = at(key);
    if (i !== -1) out.splice(i, 1);
  }
  let prev: string | null = null;
  for (const it of pr.items) {
    if (it.kind !== "entry") continue;
    if (additions.has(it.key)) {
      const e = reindent(it, indent);
      const after = prev === null ? -1 : at(prev);
      if (after !== -1) {
        out.splice(after + 1, 0, e);
      } else {
        let last = -1;
        out.forEach((x, i) => {
          if (x.kind === "entry") last = i;
        });
        if (last === -1) {
          // No entry to follow: before any trailing blank lines.
          let end = out.length;
          while (end > 0 && (out[end - 1] as Item).kind === "trivia" && (out[end - 1] as Trivia).line.trim() === "") end -= 1;
          out.splice(end, 0, e);
        } else {
          out.splice(last + 1, 0, e);
        }
      }
    }
    prev = it.key;
  }
  return ok(out);
}

/**
 * Starts from `main`'s text and re-applies each mapping entry the PR changed
 * against `base`: a changed value is taken whole, an added entry goes after
 * its PR predecessor (else after the last entry), a deleted one is deleted.
 * Nested mappings both sides changed merge recursively; any other entry both
 * sides changed takes the PR's version. An unsplittable text, or a result
 * that does not parse as YAML, is `invalid`.
 */
export function mergeStatusYaml(input: StatusMergeInput, path = "status file"): Result<string, "invalid"> {
  const base = parseStatusText(`${path} (base)`, input.base);
  if (!base.ok) return base;
  const pr = parseStatusText(`${path} (PR)`, input.pr);
  if (!pr.ok) return pr;
  const main = parseStatusText(`${path} (main)`, input.main);
  if (!main.ok) return main;
  const merged = mergeLevel(base.value.level, pr.value.level, main.value.level);
  if (!merged.ok) return merged;
  const text = render(merged.value).join(main.value.crlf ? "\r\n" : "\n");
  const parsed = parseYaml(path, text);
  if (!parsed.ok) return bad(`${path}: the merged text does not parse: ${parsed.error.message}`);
  return ok(text);
}
