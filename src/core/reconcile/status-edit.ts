import { keyLine, parseStatusText, type Entry } from "../ci/status-merge.ts";
import { parseSprintStatus } from "../next/sprint-status.ts";
import { err, ok, type Result } from "../result.ts";

/**
 * The `reconcile` editor of `sprint-status.yaml` (FR2, AR10): sets existing
 * `development_status` keys and adds missing ones in place, keeping every
 * other line, comments included, and the file's line ends. Pure. It reuses
 * the status-merge line splitter, so whatever that cannot split by lines
 * (a flow-style `development_status`, tabs, several documents) is refused,
 * never guessed; so is any result that does not re-parse to exactly the old
 * map with the changes applied.
 */

/** One `development_status` key and the status it gets. */
export type StatusChange = { readonly key: string; readonly status: string };

/** New keys of one Epic, Epic key first. */
export type StatusAddition = {
  /**
   * The keys that belong to the Epic: the new keys go after the last of
   * these already in the file, else as a new block at the end of
   * `development_status`.
   */
  readonly after: readonly string[];
  readonly entries: readonly StatusChange[];
};

export type StatusChanges = {
  /** Keys already in `development_status`, and their new status. */
  readonly set: readonly StatusChange[];
  /** Keys not yet in `development_status`, by Epic. */
  readonly add: readonly StatusAddition[];
};

const bad = (message: string) => err("invalid", message);

const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** A key or value as YAML: plain when that is safe, else double-quoted. */
function scalar(text: string): string {
  return PLAIN.test(text) && !/^(?:true|false|null|yes|no|on|off|~)$/i.test(text) ? text : JSON.stringify(text);
}

/** `old` with `changes` applied. */
function expected(old: Readonly<Record<string, string>>, changes: StatusChanges): Record<string, string> {
  const out: Record<string, string> = { ...old };
  for (const c of changes.set) out[c.key] = c.status;
  for (const a of changes.add) for (const e of a.entries) out[e.key] = e.status;
  return out;
}

function sameMap(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

/** The number of lines an item covers. */
const size = (it: { readonly kind: "trivia" } | Entry): number => (it.kind === "trivia" ? 1 : it.lines.length);

/**
 * `text` (the file at `path`) with `changes` applied to its
 * `development_status` block, or `invalid` naming why it cannot be.
 * A set key must exist and be a one-line scalar entry; an added key must not
 * exist. A changed line keeps its key text and any trailing comment.
 */
export function editDevelopmentStatus(path: string, text: string, changes: StatusChanges): Result<string, "invalid"> {
  const before = parseSprintStatus(path, text);
  if (!before.ok) return before;
  const parsed = parseStatusText(path, text);
  if (!parsed.ok) return parsed;
  const { level, crlf } = parsed.value;
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));

  // The top-level `development_status` entry and its first line.
  let at = 0;
  let block: Entry | null = null;
  let blockAt = -1;
  for (const it of level.items) {
    if (it.kind === "entry" && it.key === "development_status") {
      block = it;
      blockAt = at;
    }
    at += size(it);
  }
  if (block === null) return bad(`${path}: no top-level development_status block to edit`);
  if (block.children === null || block.children.indent === null) {
    return bad(`${path}: development_status is not a block mapping, one key per line, so it cannot be edited in place`);
  }
  const indent = block.children.indent;

  // Each child entry: its first line and its last line.
  const entries = new Map<string, { readonly first: number; readonly last: number; readonly entry: Entry }>();
  let line = blockAt + 1;
  let end = blockAt;
  for (const it of block.children.items) {
    if (it.kind === "entry") {
      entries.set(it.key, { first: line, last: line + it.lines.length - 1, entry: it });
      end = line + it.lines.length - 1;
    }
    line += size(it);
  }

  const replaced = new Map<number, string>();
  for (const c of changes.set) {
    const e = entries.get(c.key);
    if (e === undefined) return bad(`${path}: ${JSON.stringify(c.key)} is not in development_status`);
    if (e.first !== e.last) return bad(`${path}: ${JSON.stringify(c.key)} spans several lines`);
    const k = keyLine(e.entry.lines[0] as string);
    if (k === null) return bad(`${path}: cannot read the line of ${JSON.stringify(c.key)}`);
    const own = e.entry.lines[0] as string;
    const prefix = own.slice(0, own.length - k.rest.length);
    const comment = /\s+#.*$/.exec(k.rest)?.[0] ?? "";
    replaced.set(e.first, `${prefix} ${scalar(c.status)}${comment}`);
  }

  const inserted = new Map<number, string[]>();
  const added = new Set<string>();
  for (const a of changes.add) {
    let after = -1;
    for (const key of a.after) {
      const e = entries.get(key);
      if (e !== undefined && e.last > after) after = e.last;
    }
    if (after === -1) after = end;
    const list = inserted.get(after) ?? [];
    for (const e of a.entries) {
      if (entries.has(e.key) || added.has(e.key)) return bad(`${path}: ${JSON.stringify(e.key)} is already in development_status`);
      added.add(e.key);
      list.push(`${" ".repeat(indent)}${scalar(e.key)}: ${scalar(e.status)}`);
    }
    inserted.set(after, list);
  }

  const out: string[] = [];
  lines.forEach((l, i) => {
    out.push(replaced.get(i) ?? l);
    for (const n of inserted.get(i) ?? []) out.push(n);
  });
  const result = out.join(crlf ? "\r\n" : "\n");

  const reparsed = parseSprintStatus(path, result);
  if (!reparsed.ok) return bad(`${path}: the edited text does not parse: ${reparsed.error.message}`);
  if (!sameMap(reparsed.value.development_status, expected(before.value.development_status, changes))) {
    return bad(`${path}: the edited text does not re-parse to the old development_status with the changes applied`);
  }
  return ok(result);
}
