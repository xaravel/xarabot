import { err, ok, type Result } from "../result.ts";
import { parseYaml } from "../schemas/common.ts";
import { EPIC_KEY_PATTERN } from "../schemas/epics-yaml.ts";

/** The keys a raw-text scan found: the top level's, and those one level under `mapKey:`, quotes stripped. */
export type ScannedKeys = {
  readonly top: readonly string[];
  readonly map: readonly { readonly key: string; readonly line: number }[];
};

const KEY = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s"'#?\-{}[\]&*!|>%@`,][^#]*?|-[^\s#][^#]*?))[ \t]*:(?:[ \t]|$)(.*)$/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** A line holding nothing YAML reads: blank, or only a comment. */
function isBlank(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

/** A value with its trailing comment removed. */
function stripComment(value: string): string {
  return value.replace(/(?:^|[ \t])#.*$/, "").trim();
}

function parseKey(text: string): { key: string; rest: string } | undefined {
  const m = KEY.exec(text);
  if (m === null) return undefined;
  const key = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2].replaceAll("''", "'") : (m[3] as string).trim();
  return { key, rest: m[4] as string };
}

/**
 * Scans YAML text for duplicate keys, which `Bun.YAML` silently collapses:
 * duplicate top-level keys, and duplicate keys at the first indentation level
 * under the top-level `mapKey:` line. Quotes are stripped, so `6` and `"6"`
 * collide. Fails closed on what it cannot scan: a top level that is not a
 * block mapping starting in column 1, a key it cannot read at a scanned level,
 * and a `mapKey` value written inline other than `{}`. Pure.
 */
export function findDuplicateKeys(path: string, text: string, mapKey: string): Result<ScannedKeys, "invalid"> {
  const lines = (text.startsWith("﻿") ? text.slice(1) : text).split(/\r?\n/);
  const top: string[] = [];
  const topLines = new Map<string, number>();
  const map: { key: string; line: number }[] = [];
  const mapLines = new Map<string, number>();
  let inMap = false;
  let mapIndent: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const lineNo = i + 1;
    if (isBlank(line)) continue;
    const indent = indentOf(line);
    if (/^ *\t/.test(line)) {
      return err("invalid", `${path}: line ${lineNo}: tab indentation is not allowed`);
    }

    if (indent === 0) {
      inMap = false;
      const marker = /^(?:---|\.\.\.)(?:[ \t]|$)(.*)$/.exec(line);
      if (marker !== null) {
        if (stripComment(marker[1] ?? "") !== "") {
          return err("invalid", `${path}: line ${lineNo}: content after a document marker cannot be checked for duplicate keys`);
        }
        continue;
      }
      if (line.startsWith("%")) continue;
      const parsed = parseKey(line);
      if (parsed === undefined) {
        return err("invalid", `${path}: line ${lineNo}: expected a top-level "key:" (the top level must be a block mapping)`);
      }
      if (parsed.key === "<<") return err("invalid", `${path}: line ${lineNo}: merge keys (<<) cannot be checked for duplicate keys`);
      const prior = topLines.get(parsed.key);
      if (prior !== undefined) {
        return err("invalid", `${path}: line ${lineNo}: duplicate key "${parsed.key}" (first at line ${prior})`);
      }
      topLines.set(parsed.key, lineNo);
      top.push(parsed.key);
      if (parsed.key === mapKey) {
        const value = stripComment(parsed.rest);
        if (value === "") {
          inMap = true;
          mapIndent = undefined;
        } else if (/^\{\s*\}$/.test(value)) {
          // An empty flow mapping holds no keys to scan.
        } else if (/^[{&*!]/.test(value)) {
          return err(
            "invalid",
            `${path}: line ${lineNo}: ${mapKey} must be a block mapping or {} (flow style, anchors, aliases and tags cannot be checked for duplicate keys)`,
          );
        }
      }
      continue;
    }

    if (top.length === 0) {
      return err("invalid", `${path}: line ${lineNo}: expected a top-level "key:" in column 1 (the top level must be a block mapping)`);
    }
    if (!inMap) continue;
    if (mapIndent === undefined) mapIndent = indent;
    if (indent < mapIndent) {
      return err("invalid", `${path}: line ${lineNo}: inconsistent indentation under ${mapKey}`);
    }
    if (indent > mapIndent) continue;
    const parsed = parseKey(line.slice(indent));
    if (parsed === undefined) {
      return err("invalid", `${path}: line ${lineNo}: expected a "key:" under ${mapKey}`);
    }
    if (parsed.key === "<<") return err("invalid", `${path}: line ${lineNo}: merge keys (<<) cannot be checked for duplicate keys`);
    const prior = mapLines.get(parsed.key);
    if (prior !== undefined) {
      return err("invalid", `${path}: line ${lineNo}: duplicate ${mapKey} key "${parsed.key}" (first at line ${prior})`);
    }
    mapLines.set(parsed.key, lineNo);
    map.push({ key: parsed.key, line: lineNo });
  }
  return ok({ top, map });
}

/** Parses YAML text that must be one document holding a mapping. */
export function parseYamlMapping(path: string, text: string): Result<Record<string, unknown>, "invalid"> {
  const yaml = parseYaml(path, text);
  if (!yaml.ok) return err("invalid", yaml.error.message);
  const value = yaml.value;
  if (Array.isArray(value)) {
    return err("invalid", `${path}: top level must be one YAML document holding a mapping (found a list or several documents)`);
  }
  if (value === null || typeof value !== "object") return err("invalid", `${path}: top level must be a YAML mapping`);
  return ok(value as Record<string, unknown>);
}

/**
 * The duplicate-key scan plus the raw spelling of each key under `mapKey`:
 * each must match `^[1-9][0-9]*$` as written, since `Bun.YAML` reads `01`,
 * `0x1` and `1.0` all as `1`.
 */
export function checkEpicKeys(path: string, text: string, mapKey: string): Result<ScannedKeys, "invalid"> {
  const scan = findDuplicateKeys(path, text, mapKey);
  if (!scan.ok) return scan;
  for (const { key, line } of scan.value.map) {
    if (!EPIC_KEY_PATTERN.test(key)) {
      return err("invalid", `${path}: line ${line}: ${mapKey} key "${key}" must be an Epic number (^[1-9][0-9]*$)`);
    }
  }
  return scan;
}
