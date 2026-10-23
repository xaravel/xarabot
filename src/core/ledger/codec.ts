import type { z } from "zod";
import { err, ok, type Result } from "../result.ts";
import { describeIssues, SCHEMA_VERSION } from "../schemas/common.ts";
import {
  CoordinatorRecordSchema,
  unitFromPath,
  UnitRecordSchema,
  type CoordinatorRecord,
  type Park,
  type UnitRecord,
} from "../schemas/ledger.ts";

/** The coordinator's ledger file. */
export const COORDINATOR_PATH = "coordinator.json";

/** A parsed ledger tip. */
export type Ledger = {
  readonly units: ReadonlyMap<string, UnitRecord>;
  readonly coordinator: CoordinatorRecord | null;
};

export type LedgerParseErrorKind = "stop" | "invalid";

type Parsed<T> = Result<T, LedgerParseErrorKind>;

function parseRecord<S extends z.ZodType>(path: string, text: string, schema: S): Parsed<z.infer<S>> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return err("invalid", `${path}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return err("invalid", `${path}: top level must be a JSON object`);
  }
  const version = (value as Record<string, unknown>)["schema_version"];
  if (typeof version === "number" && Number.isInteger(version) && version !== SCHEMA_VERSION) {
    return err("stop", `${path}: unsupported schema_version ${version} (this runner reads ${SCHEMA_VERSION})`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return err("invalid", `${path}: ${describeIssues(parsed.error)}`);
  return ok(parsed.data);
}

/**
 * Parses the ledger files of one tip (`path → JSON text`). Paths outside
 * `units/` other than `coordinator.json` are ignored. An unsupported
 * `schema_version` in any record is `stop`, reported ahead of any other
 * malformation, which is `invalid`.
 */
export function parseLedger(files: Readonly<Record<string, string>>): Result<Ledger, LedgerParseErrorKind> {
  const units = new Map<string, UnitRecord>();
  let coordinator: CoordinatorRecord | null = null;
  let invalid: string | undefined;
  for (const path of Object.keys(files).sort()) {
    const raw = files[path] as string;
    if (path === COORDINATOR_PATH) {
      const r = parseRecord(path, raw, CoordinatorRecordSchema);
      if (!r.ok) {
        if (r.error.kind === "stop") return r;
        invalid ??= r.error.message;
        continue;
      }
      coordinator = r.value;
      continue;
    }
    if (!path.startsWith("units/")) continue;
    const r = parseRecord(path, raw, UnitRecordSchema);
    if (!r.ok && r.error.kind === "stop") return r;
    const id = unitFromPath(path);
    if (id === undefined) {
      invalid ??= `${path}: not a unit file name (units/<unit id with ":" as "__">.json)`;
      continue;
    }
    if (!r.ok) {
      invalid ??= r.error.message;
      continue;
    }
    if (r.value.unit !== id) {
      invalid ??= `${path}: unit "${r.value.unit}" does not match its file name (${id})`;
      continue;
    }
    units.set(id, r.value);
  }
  if (invalid !== undefined) return err("invalid", invalid);
  return ok({ units, coordinator });
}

/** Sorted, de-duplicated copy. */
function sortedSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function text(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function orderedPark(p: Park): Park {
  return { kind: p.kind, reason: p.reason, inbox_owner: p.inbox_owner, globs_held: sortedSet(p.globs_held) };
}

/** A unit record as ledger file text: fixed key order, sorted sets, 2-space indent, trailing newline. */
export function serializeUnitRecord(r: UnitRecord): string {
  const ordered: UnitRecord = {
    schema_version: r.schema_version,
    unit: r.unit,
    state: r.state,
    owner: r.owner,
    host: r.host,
    lane: r.lane,
    generation: r.generation,
    globs: sortedSet(r.globs),
    heartbeat_at: r.heartbeat_at,
    pr: r.pr,
    pr_owner: r.pr_owner,
    base_sha: r.base_sha,
    head_sha: r.head_sha,
    reviewed_sha: r.reviewed_sha,
    passed_sha: r.passed_sha,
    approved_sha: r.approved_sha,
    builder_providers: sortedSet(r.builder_providers),
    park: r.park === null ? null : orderedPark(r.park),
    attempts: r.attempts,
    loopbacks: r.loopbacks,
    ci_fixes: r.ci_fixes,
    approval: r.approval === null ? null : { by: r.approval.by, manifest_sha: r.approval.manifest_sha },
  };
  return text(ordered);
}

/** `coordinator.json` as file text, in the same style. */
export function serializeCoordinator(c: CoordinatorRecord): string {
  const ordered: CoordinatorRecord = {
    schema_version: c.schema_version,
    owner: c.owner,
    host: c.host,
    lane: c.lane,
    generation: c.generation,
    heartbeat_at: c.heartbeat_at,
    digest_posted_at: c.digest_posted_at,
    rulings_cursor: c.rulings_cursor,
  };
  return text(ordered);
}
