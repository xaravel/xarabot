import { AGENT_CONFIG_PATHS } from "../config/protected-paths.ts";
import { parseRetroGates } from "../graph/retro-gates.ts";
import { parseYaml } from "../schemas/common.ts";
import type { Config } from "../schemas/config.ts";
import type { Policy } from "../schemas/policy.ts";
import { unitKind } from "../schemas/ledger.ts";
import { graphInputGlobs, statusFiles } from "../next/coordinator.ts";

/**
 * The 0.x write check (FR18, NFR20, AR31, AD-30): which paths a builder
 * session's own change may not touch. Every refused-class comparison is
 * case-folded, because the clone lives on a case-insensitive filesystem;
 * the exceptions compare exact paths, so folding only ever widens a
 * refusal. A coordinator session's change has its own rules
 * (`coordinatorWriteRules`, Story 2.4): only the paths its unit holds,
 * matched exactly, so a case variant of one is refused; a retro item's
 * (Story 2.10) adds every builder refusal, with no exception; and in
 * `sprint_status_path` only the keys its session may change (AR31, Epic 2
 * retro C5). Pure.
 */

/** The refused path classes, in reporting order: a path in several is reported as the first. */
export const WRITE_CLASSES = ["coordinator-file", "live-evidence", "xarabot", "manifest", "standing-authority", "github", "agent-config", "protected-path"] as const;
export type WriteClass = (typeof WRITE_CLASSES)[number];

/** The classes an approved Infrastructure Story may write. */
const INFRASTRUCTURE_CLASSES: ReadonlySet<WriteClass> = new Set(["standing-authority", "github", "agent-config", "protected-path"]);

/** The paths behind the builder's refused classes (`WRITE_CLASSES`). */
export type RefusedPaths = {
  /** `sprint_status_path`, `retro_gates_path` and `epics_path`. */
  readonly coordinatorFiles: readonly string[];
  /** `manifests.dir`, or `null` when `manifests` is unset (no manifests). */
  readonly manifestsDir: string | null;
  readonly standingAuthorityPath: string;
  /** The policy's own `protected_paths`. */
  readonly protectedPaths: readonly string[];
  /** `live_evidence_glob` with `<N>` as `*` (Story 2.9): the Maintainer's live evidence files. */
  readonly liveEvidenceGlob: string;
};

/** What `refusedPaths` reads: the config's refused paths and the policy's own Protected Paths. */
export type RefusedPathsInput = {
  readonly config: Pick<Config, "sprint_status_path" | "retro_gates_path" | "epics_path" | "manifests" | "standing_authority_path" | "live_evidence_glob">;
  readonly policy: Pick<Policy, "protected_paths">;
};

/** The paths behind the builder's refused classes, from the config and the policy. */
export function refusedPaths(input: RefusedPathsInput): RefusedPaths {
  const { config, policy } = input;
  return {
    coordinatorFiles: [config.sprint_status_path, config.retro_gates_path, config.epics_path],
    manifestsDir: config.manifests?.dir ?? null,
    standingAuthorityPath: config.standing_authority_path,
    protectedPaths: [...policy.protected_paths],
    liveEvidenceGlob: config.live_evidence_glob.replaceAll("<N>", "*"),
  };
}

export type WriteRules = RefusedPaths & {
  readonly role: "builder";
  /** `epic_context_path`, with `<N>`. */
  readonly epicContextPath: string;
  /** The unit's spec file: excepted, exact path. */
  readonly specPath: string;
  /**
   * The Story's `blocked` spec files a re-run's `done` spec supersedes, exact
   * paths: the commit sets each back to the base's version, so the squash
   * never holds a change to one.
   */
  readonly superseded: readonly string[];
  /** The unit's own manifest: its frontmatter `status:` line is excepted, exact path. */
  readonly storyFile: string;
  /** An approved Infrastructure Story: its Protected Paths are excepted. */
  readonly infrastructureApproved: boolean;
};

export type WriteRulesInput = {
  readonly config: Pick<
    Config,
    "sprint_status_path" | "retro_gates_path" | "epics_path" | "manifests" | "standing_authority_path" | "epic_context_path" | "live_evidence_glob"
  >;
  readonly policy: Pick<Policy, "protected_paths">;
  readonly specPath: string;
  /** Default none. */
  readonly superseded?: readonly string[];
  readonly storyFile: string;
  readonly infrastructureApproved: boolean;
};

export function writeRules(input: WriteRulesInput): WriteRules {
  const { config, policy } = input;
  return {
    role: "builder",
    ...refusedPaths({ config, policy }),
    epicContextPath: config.epic_context_path,
    specPath: input.specPath,
    superseded: [...(input.superseded ?? [])],
    storyFile: input.storyFile,
    infrastructureApproved: input.infrastructureApproved,
  };
}

/** One path the session changed. `storyFile` holds the own manifest's two texts, given only when it is a regular file on both sides. */
export type WriteChange = {
  readonly path: string;
  /**
   * The new side's git mode (`100644`, `100755`, `120000`, `160000`), or
   * `000000` when the path is deleted. The coordinator's rules refuse a
   * status file or graph input with any mode but `100644`, or none.
   */
  readonly mode?: string;
  readonly storyFile?: { readonly before: string; readonly after: string };
  /**
   * Under coordinator rules, for a change to `retro_gates_path`: its text
   * before and after (`null` when absent on that side). Missing for such a
   * change is `retro-gates-invalid`.
   */
  readonly retroGates?: { readonly before: string | null; readonly after: string | null };
  /**
   * Under coordinator rules, for a change to `sprint_status_path`: its text
   * before and after (`null` when absent on that side). Missing for such a
   * change is `status-invalid`.
   */
  readonly sprintStatus?: { readonly before: string | null; readonly after: string | null };
};

/**
 * One refused change. `path` is the changed path; for a refusal of one key
 * of `sprint_status_path` (`story-done`, `status-key`) it is
 * `<path>#<key>`, so every line that names the refusal names the key.
 */
export type WriteRefusal = { readonly path: string; readonly class: WriteClass | CoordinatorWriteClass };

/**
 * The coordinator's refused path classes (AD-13, AD-30), in reporting
 * order: under `.xarabot/**` but `.xarabot/epics.yaml`; a graph input in a
 * unit that is not graph planning; a path none of the unit's globs match;
 * when the diff touches both a graph input and a status file, every graph
 * input and status file the classes before left; and a status file or graph
 * input left whose new mode is not `100644` (a deleted one has none). A
 * change to `retro_gates_path` the classes before left is then compared by
 * Epic (Story 2.9): a change to a `retro` other than its `go` is
 * `retro-verdict`, to `items` `retro-item`, to `retro.go` `retro-go`, to
 * `checkpoint` `checkpoint-go` (one refusal per class hit), and a side that
 * does not parse, or texts not given, is `retro-gates-invalid`. Only
 * `reconcile`'s runner code writes those records. A change to
 * `sprint_status_path` the classes before left is then compared by key
 * (`sprintStatusRefusals`): a Story key set `done` is `story-done`, a key
 * the session may not change `status-key`, one refusal per key, and a side
 * that does not parse, or texts not given, is `status-invalid`. With `refused` set (a
 * retro item, Story 2.10), a path no coordinator class refuses is then
 * classified as a builder's would be, with no exception (`WRITE_CLASSES`).
 */
export const COORDINATOR_WRITE_CLASSES = [
  "xarabot",
  "graph-input",
  "outside-unit",
  "graph-and-status",
  "mode",
  "retro-verdict",
  "retro-item",
  "retro-go",
  "checkpoint-go",
  "retro-gates-invalid",
  "story-done",
  "status-key",
  "status-invalid",
] as const;
export type CoordinatorWriteClass = (typeof COORDINATOR_WRITE_CLASSES)[number];

export type CoordinatorWriteRules = {
  readonly role: "coordinator";
  /** The globs the unit holds (`coordinatorGlobs`). */
  readonly globs: readonly string[];
  /** A graph planning unit, the only kind that may touch a graph input. */
  readonly graphUnit: boolean;
  /** `epics_path`, `.xarabot/epics.yaml` and `<manifests.dir>/*.md`. */
  readonly graphInputs: readonly string[];
  /** `sprint_status_path` and `retro_gates_path`. */
  readonly statusFiles: readonly string[];
  /** `retro_gates_path`: its retro records are never an agent's to change (Story 2.9). */
  readonly retroGatesPath: string;
  /** `sprint_status_path`: only the keys the session may change (`statusSession`). */
  readonly sprintStatusPath: string;
  /**
   * The session's unit, which picks what it may change in
   * `sprint_status_path`: `commitSession` sets it from the clone session's
   * marker. `null` (any other session) changes no key there.
   */
  readonly unit: string | null;
  /**
   * The builder's refused paths, with no exception, checked after the
   * coordinator classes (a retro item, Story 2.10); `null` for every other
   * coordinator unit.
   */
  readonly refused: RefusedPaths | null;
};

export type CoordinatorWriteRulesInput = {
  readonly config: Pick<Config, "sprint_status_path" | "retro_gates_path" | "epics_path" | "manifests">;
  readonly globs: readonly string[];
  readonly graphUnit: boolean;
  /** Refuse every path a builder is refused too (a retro item); default none. */
  readonly builderRefusals?: RefusedPathsInput;
};

export function coordinatorWriteRules(input: CoordinatorWriteRulesInput): CoordinatorWriteRules {
  return {
    role: "coordinator",
    globs: [...input.globs],
    graphUnit: input.graphUnit,
    graphInputs: graphInputGlobs(input.config),
    statusFiles: statusFiles(input.config),
    retroGatesPath: input.config.retro_gates_path,
    sprintStatusPath: input.config.sprint_status_path,
    unit: null,
    refused: input.builderRefusals === undefined ? null : refusedPaths(input.builderRefusals),
  };
}

/** Full case folding, as APFS folds names: `ſ` and `K` (Kelvin) fold with `s` and `k`. */
const fold = (s: string): string => s.toUpperCase().toLowerCase();

/** The agent config folder names, folded: a path ending in one is agent config whatever it is. */
const AGENT_CONFIG_DIRS: ReadonlySet<string> = new Set([".agents", ".claude", ".codex", ".pi"]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** True when `path` is `pattern` with every `<N>` replaced by one positive integer; case-folded. */
export function epicContextMatch(pattern: string, path: string): boolean {
  const parts = fold(pattern).split("<n>");
  if (parts.length < 2) return false;
  const source = parts.map(escapeRegExp).reduce((acc, part, i) => (i === 0 ? part : `${acc}${i === 1 ? "([1-9][0-9]*)" : "\\1"}${part}`), "");
  return new RegExp(`^${source}$`).test(fold(path));
}

type StatusSplit = {
  /** The text's lines with the frontmatter `status:` line removed. */
  readonly rest: readonly string[];
  /** The frontmatter parsed as a mapping, or `null` when there is none or it is not one. */
  readonly frontmatter: Record<string, unknown> | null;
};

/**
 * `text` split around its top-level frontmatter `status:` line, or `null`
 * when it has more than one, or one holding a `\r` other than a trailing one.
 */
function splitStatus(text: string): StatusSplit | null {
  const lines = text.split("\n");
  const opener = (lines[0] ?? "").replace(/^\ufeff/, "").trimEnd();
  if (opener !== "---") return { rest: lines, frontmatter: null };
  const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (close === -1) return { rest: lines, frontmatter: null };
  const status = lines.flatMap((l, i) => (i > 0 && i < close && /^status:(?:\s|$)/.test(l) ? [i] : []));
  if (status.length > 1) return null;
  if (status.some((i) => (lines[i] as string).replace(/\r$/, "").includes("\r"))) return null;
  const yaml = parseYaml("manifest", lines.slice(1, close).join("\n"));
  const fm = yaml.ok && yaml.value !== null && typeof yaml.value === "object" && !Array.isArray(yaml.value) ? (yaml.value as Record<string, unknown>) : null;
  return { rest: lines.filter((_, i) => !status.includes(i)), frontmatter: fm };
}

function withoutStatusKey(fm: Record<string, unknown>): Record<string, unknown> {
  const { status: _status, ...rest } = fm;
  return rest;
}

/**
 * True when `after` differs from `before` at most in one top-level `status:`
 * line inside the leading `---` frontmatter: each side has at most one (with
 * no `\r` but a trailing one), and with those lines removed both texts are
 * identical. Both frontmatters must also parse as YAML mappings that are
 * equal without their `status` key, and `after`'s `status`, if any, must be
 * a string.
 */
export function statusLineOnly(before: string, after: string): boolean {
  const b = splitStatus(before);
  const a = splitStatus(after);
  if (b === null || a === null) return false;
  if (b.rest.join("\n") !== a.rest.join("\n")) return false;
  if (b.frontmatter === null || a.frontmatter === null) return false;
  if (Object.hasOwn(a.frontmatter, "status") && typeof a.frontmatter["status"] !== "string") return false;
  return Bun.deepEquals(withoutStatusKey(b.frontmatter), withoutStatusKey(a.frontmatter), true);
}

function matchesAny(globs: readonly string[], folded: string): boolean {
  return globs.some((g) => new Bun.Glob(fold(g)).match(folded));
}

/** The first refused class `path` is in, or `null`; case-folded. */
function classify(rules: RefusedPaths, path: string): WriteClass | null {
  const p = fold(path);
  if (rules.coordinatorFiles.some((f) => fold(f) === p)) return "coordinator-file";
  if (new Bun.Glob(fold(rules.liveEvidenceGlob)).match(p)) return "live-evidence";
  if (p === ".xarabot" || p.startsWith(".xarabot/")) return "xarabot";
  if (rules.manifestsDir !== null) {
    const prefix = `${fold(rules.manifestsDir)}/`;
    if (p.startsWith(prefix) && p.endsWith(".md") && !p.slice(prefix.length).includes("/")) return "manifest";
  }
  if (fold(rules.standingAuthorityPath) === p) return "standing-authority";
  if (p === ".github" || p.startsWith(".github/")) return "github";
  // A bare agent config folder name (a file or symlink there) counts too.
  if (matchesAny(AGENT_CONFIG_PATHS, p) || AGENT_CONFIG_DIRS.has(p.slice(p.lastIndexOf("/") + 1))) return "agent-config";
  if (matchesAny(rules.protectedPaths, p)) return "protected-path";
  return null;
}

const byPath = (a: WriteRefusal, b: WriteRefusal): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** The changes the rules refuse, in path order: a builder's or the coordinator's, by `role`. */
export function checkWrite(rules: WriteRules | CoordinatorWriteRules, changes: readonly WriteChange[]): WriteRefusal[] {
  return rules.role === "coordinator" ? checkCoordinatorWrite(rules, changes) : checkBuilderWrite(rules, changes);
}

/**
 * The first class in 1-3 of `COORDINATOR_WRITE_CLASSES` `path` (folded `p`)
 * is in, or `null`. The refusals are case-folded; the allowances, the unit's
 * globs and `.xarabot/epics.yaml`, match `path` exactly.
 */
function classifyCoordinator(rules: CoordinatorWriteRules, path: string, p: string): CoordinatorWriteClass | null {
  if ((p === ".xarabot" || p.startsWith(".xarabot/")) && path !== ".xarabot/epics.yaml") return "xarabot";
  if (!rules.graphUnit && matchesAny(rules.graphInputs, p)) return "graph-input";
  if (!rules.globs.some((g) => new Bun.Glob(g).match(path))) return "outside-unit";
  return null;
}

/** The only git mode a status file or graph input may have under coordinator rules. */
const REGULAR_MODE = "100644";

/** The retro record classes, in reporting order, a change to `retro-gates.yaml` hits; `[]` when it changes none. */
type RetroRecordClass = "retro-verdict" | "retro-item" | "retro-go" | "checkpoint-go" | "retro-gates-invalid";

/** Whether `retro_gates_path`'s change touches a retro record (Story 2.9): each class it hits, by comparing both parsed sides per Epic. */
export function retroGatesClasses(path: string, texts: WriteChange["retroGates"]): RetroRecordClass[] {
  if (texts === undefined) return ["retro-gates-invalid"];
  const parse = (text: string | null) => (text === null ? { ok: true as const, value: { schema_version: 1 as const, epics: {} } } : parseRetroGates(path, text));
  const before = parse(texts.before);
  const after = parse(texts.after);
  if (!before.ok || !after.ok) return ["retro-gates-invalid"];
  const hit = new Set<RetroRecordClass>();
  const same = (a: unknown, b: unknown) => Bun.deepEquals(a, b, true);
  const epics = new Set([...Object.keys(before.value.epics), ...Object.keys(after.value.epics)]);
  for (const n of epics) {
    const b = before.value.epics[n];
    const a = after.value.epics[n];
    const withoutGo = (r: typeof b) => (r?.retro === undefined ? undefined : { ...r.retro, go: undefined });
    if (!same(withoutGo(b), withoutGo(a))) hit.add("retro-verdict");
    if (!same(b?.items, a?.items)) hit.add("retro-item");
    if (!same(b?.retro?.go, a?.retro?.go)) hit.add("retro-go");
    if (!same(b?.checkpoint, a?.checkpoint)) hit.add("checkpoint-go");
  }
  const order: readonly RetroRecordClass[] = ["retro-verdict", "retro-item", "retro-go", "checkpoint-go"];
  return order.filter((c) => hit.has(c));
}

/** What a coordinator session may change in `sprint_status_path` (AR31, Epic 2 retro C5). */
export type StatusSession = { readonly kind: "status-planning" } | { readonly kind: "retro"; readonly epic: number } | { readonly kind: "other" };

/** The session `unit` runs: status planning (a planning unit but graph), a retro of its Epic, or any other. */
export function statusSession(unit: string | null, graphUnit: boolean): StatusSession {
  const kind = unit === null ? undefined : unitKind(unit);
  if (kind === "retro") return { kind: "retro", epic: Number((unit as string).slice("retro:".length)) };
  if (kind === "planning" && !graphUnit) return { kind: "status-planning" };
  return { kind: "other" };
}

/** `sprint_status_path`'s key classes, a refusal each. */
type StatusKeyClass = "story-done" | "status-key" | "status-invalid";

/** One refused key of `sprint_status_path`, or `key: null` for the whole file. */
export type StatusKeyRefusal = { readonly key: string | null; readonly class: StatusKeyClass };

type Mapping = Record<string, unknown>;
const isMapping = (v: unknown): v is Mapping => v !== null && typeof v === "object" && !Array.isArray(v);
const get = (m: unknown, k: string): unknown => (isMapping(m) && Object.hasOwn(m, k) ? m[k] : undefined);
const same = (a: unknown, b: unknown): boolean => Bun.deepEquals(a, b, true);

/** A `development_status` key that is an Epic's or its retrospective's, so not a Story's. */
const EPIC_KEY = /^epic-[0-9]+(?:-retrospective)?$/;

/** The key `last_updated`: BMAD's skills set it on every write, so the sessions that write the file may. */
const LAST_UPDATED = "last_updated";

/** One side parsed: an absent file, or an empty one, is `{}`; `null` when it does not parse as a mapping. */
function statusSide(path: string, text: string | null): Mapping | null {
  if (text === null) return {};
  const yaml = parseYaml(path, text);
  if (!yaml.ok) return null;
  if (yaml.value === null) return {};
  return isMapping(yaml.value) ? yaml.value : null;
}

/** A key whose value differs; a side that lacks the key is `undefined`. */
type KeyChange = { readonly key: string; readonly before: unknown; readonly after: unknown };

/** Each key whose value differs, descending only into mappings on both sides. */
function changedKeys(before: unknown, after: unknown, key: string, out: KeyChange[]): void {
  if (isMapping(before) && isMapping(after)) {
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      changedKeys(get(before, k), get(after, k), key === "" ? k : `${key}.${k}`, out);
    }
  } else if (!same(before, after)) {
    out.push({ key, before, after });
  }
}

/** The `action_items` keys a retro of Epic `epic` may not change: every entry kept as it was, each appended one an entry of its Epic. */
function actionItemRefusals(epic: number, before: unknown, after: unknown): string[] {
  const b = before ?? [];
  const a = after ?? [];
  if (!Array.isArray(b) || !Array.isArray(a)) return ["action_items"];
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const kept = i < b.length ? same(b[i], a[i]) : get(a[i], "epic") === epic;
    if (!kept) out.push(`action_items[${i}]`);
  }
  return out;
}

/**
 * What `sprint_status_path`'s change refuses, by key (AR31; Maintainer
 * decision 2026-10-25, Epic 2 retro C5). No coordinator session sets a
 * Story key of `development_status` (any but `epic-<N>` and
 * `epic-<N>-retrospective`) to `done`: `story-done`, since only
 * `reconcile`'s runner code does. Then each other changed key the session
 * may not change is `status-key`: status planning may only add a missing
 * key, never change or remove one; a retro of Epic N may only append Epic
 * N's `action_items` entries and set `development_status.epic-N-retrospective`;
 * either may set `last_updated`; any other session changes no key. A side
 * that does not parse as a mapping, or texts not given, is `status-invalid`.
 * Values are compared parsed, so comments and layout are free.
 */
export function sprintStatusRefusals(session: StatusSession, path: string, texts: WriteChange["sprintStatus"]): StatusKeyRefusal[] {
  if (texts === undefined) return [{ key: null, class: "status-invalid" }];
  const before = statusSide(path, texts.before);
  const after = statusSide(path, texts.after);
  if (before === null || after === null) return [{ key: null, class: "status-invalid" }];

  const out: StatusKeyRefusal[] = [];
  const done = new Set<string>();
  const statusAfter = get(after, "development_status");
  if (isMapping(statusAfter)) {
    for (const k of Object.keys(statusAfter)) {
      if (EPIC_KEY.test(k) || statusAfter[k] !== "done" || get(get(before, "development_status"), k) === "done") continue;
      done.add(`development_status.${k}`);
      out.push({ key: `development_status.${k}`, class: "story-done" });
    }
  }

  const changed: KeyChange[] = [];
  changedKeys(before, after, "", changed);
  const allowed = (c: KeyChange): boolean => {
    if (session.kind === "other") return false;
    if (c.key === LAST_UPDATED) return true;
    if (session.kind === "status-planning") return c.before === undefined;
    if (c.key === "action_items" || c.key.startsWith("action_items.")) return true;
    return c.key === `development_status.epic-${session.epic}-retrospective` && c.after !== undefined;
  };
  const refused = changed.filter((c) => !done.has(c.key) && !allowed(c)).map((c) => c.key);
  if (session.kind === "retro" && !same(get(before, "action_items"), get(after, "action_items"))) {
    refused.push(...actionItemRefusals(session.epic, get(before, "action_items"), get(after, "action_items")));
  }
  for (const key of refused) out.push({ key, class: "status-key" });
  return out;
}

function checkCoordinatorWrite(rules: CoordinatorWriteRules, changes: readonly WriteChange[]): WriteRefusal[] {
  const out: WriteRefusal[] = [];
  const session = statusSession(rules.unit, rules.graphUnit);
  const folded = changes.map((c) => ({ path: c.path, p: fold(c.path), mode: c.mode, retroGates: c.retroGates, sprintStatus: c.sprintStatus }));
  const isGraph = (p: string) => matchesAny(rules.graphInputs, p);
  const isStatus = (p: string) => rules.statusFiles.some((f) => fold(f) === p);
  const both = folded.some((c) => isGraph(c.p)) && folded.some((c) => isStatus(c.p));
  for (const { path, p, mode, retroGates, sprintStatus } of folded) {
    const kept = isGraph(p) || isStatus(p);
    const cls = classifyCoordinator(rules, path, p) ?? (both && kept ? "graph-and-status" : kept && mode !== REGULAR_MODE ? "mode" : null);
    if (cls !== null) {
      out.push({ path, class: cls });
      continue;
    }
    const records = fold(rules.retroGatesPath) === p ? retroGatesClasses(rules.retroGatesPath, retroGates) : [];
    for (const c of records) out.push({ path, class: c });
    const keys = fold(rules.sprintStatusPath) === p ? sprintStatusRefusals(session, rules.sprintStatusPath, sprintStatus) : [];
    for (const k of keys) out.push({ path: k.key === null ? path : `${path}#${k.key}`, class: k.class });
    if (records.length > 0 || keys.length > 0 || rules.refused === null) continue;
    // A retro item: then a builder's refusal, with no exception.
    const builder = classify(rules.refused, path);
    if (builder !== null) out.push({ path, class: builder });
  }
  return out.sort(byPath);
}

function checkBuilderWrite(rules: WriteRules, changes: readonly WriteChange[]): WriteRefusal[] {
  const out: WriteRefusal[] = [];
  for (const change of changes) {
    const { path } = change;
    const cls = classify(rules, path);
    if (cls === null) continue;
    if (path === rules.specPath) continue;
    if (path === rules.storyFile && change.storyFile !== undefined && statusLineOnly(change.storyFile.before, change.storyFile.after)) continue;
    if (rules.infrastructureApproved && INFRASTRUCTURE_CLASSES.has(cls)) continue;
    out.push({ path, class: cls });
  }
  return out.sort(byPath);
}
