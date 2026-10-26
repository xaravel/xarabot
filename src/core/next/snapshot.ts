import { loadRepoConfig, type ConfigStopKind, type RepoSnapshot } from "../config/load-repo-config.ts";
import { parseEpicsMd } from "../graph/epics-md.ts";
import { parseLedger, type LedgerParseErrorKind } from "../ledger/codec.ts";
import { emptyRetroGates } from "../graph/retro-gates.ts";
import { resolveGraph } from "../graph/resolve-graph.ts";
import { loadManifests } from "../manifests/parse-manifest.ts";
import { err, ok, type Result } from "../result.ts";
import { describeIssues } from "../schemas/common.ts";
import type { LaneIdentity } from "../schemas/ledger.ts";
import {
  SnapshotSchema,
  type EpicContextState,
  type LaneRole,
  type PrState,
  type Snapshot,
} from "../schemas/snapshot.ts";
import { emptySprintStatus, parseSprintStatus } from "./sprint-status.ts";

/** One `main` snapshot and one ledger tip, as the forge returned them. */
export type AssembleInput = RepoSnapshot & {
  readonly main_sha: string;
  /** Repo path → git blob SHA on `main`; every manifest needs an entry. */
  readonly blob_shas: Readonly<Record<string, string>>;
  readonly ledger_tip: string;
  /** Ledger path → JSON text at `ledger_tip`. */
  readonly ledger_files: Readonly<Record<string, string>>;
  readonly prs: Readonly<Record<string, PrState>>;
  /** Open escalations, or `null` when no escalation source is configured. */
  readonly escalations: { readonly open: readonly string[] } | null;
  readonly lane: LaneIdentity;
  readonly role: LaneRole;
};

export type AssembleErrorKind = ConfigStopKind | LedgerParseErrorKind | "unreadable" | "invalid-snapshot";

/** An Epic's context path: `epic_context_path` with every `<N>` replaced. */
export function epicContextPath(pattern: string, epic: number): string {
  return pattern.replaceAll("<N>", String(epic));
}

/** An Epic's live evidence glob: `live_evidence_glob` with every `<N>` replaced. */
export function liveEvidenceGlob(pattern: string, epic: number): string {
  return pattern.replaceAll("<N>", String(epic));
}

/** The first path of `tree`, in path order, that matches Epic `epic`'s live evidence glob, or `null`. */
export function liveEvidencePath(pattern: string, epic: number, tree: readonly string[]): string | null {
  const glob = new Bun.Glob(liveEvidenceGlob(pattern, epic));
  return [...tree].sort().find((p) => glob.match(p)) ?? null;
}

/** The commands of `live_evidence_checks` an evidence file lacks (retro item 14). */
export type LiveEvidenceGaps = {
  /** Commands the file does not hold. */
  readonly missing: readonly string[];
  /** Commands the file holds, but never followed by a `bun test` summary with `0 fail`. */
  readonly failing: readonly string[];
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Where `command` stands whole in `text`, as `[start, end)` spans: at a line
 * start, after a backtick or after a table bar (then an optional `$ `
 * prompt), and before a backtick, a table bar or the line end. So it matches
 * in an inline code span, a table cell or a transcript line, but never inside
 * a longer command.
 */
function commandSpans(text: string, command: string): [number, number][] {
  const re = new RegExp(`(?:^|[\`|])[ \\t]*(?:\\$[ \\t]+)?${escapeRegExp(command)}[ \\t]*(?=[\`|]|\\r?$)`, "gm");
  return [...text.matchAll(re)].map((m) => [m.index, m.index + m[0].length]);
}

/** A `bun test` summary's fail count: `<n> fail`, `<n>` a whole number. */
const FAIL_COUNT = /(?<![\w.])(\d+) fail\b/g;

/**
 * Which of `commands` evidence `text` lacks (retro item 14). A command counts
 * once some place holds it whole (`commandSpans`) and the first fail count
 * after it, before the next place any of `commands` stands, is `0 fail`.
 * Pure.
 */
export function liveEvidenceGaps(text: string, commands: readonly string[]): LiveEvidenceGaps {
  const spans = new Map(commands.map((c) => [c, commandSpans(text, c)]));
  const starts = [...spans.values()].flat().map(([start]) => start);
  const missing: string[] = [];
  const failing: string[] = [];
  for (const command of commands) {
    const own = spans.get(command) ?? [];
    if (own.length === 0) {
      missing.push(command);
      continue;
    }
    const passes = own.some(([, end]) => {
      const limit = Math.min(text.length, ...starts.filter((s) => s >= end));
      const fail = [...text.slice(end, limit).matchAll(FAIL_COUNT)][0];
      return fail !== undefined && Number(fail[1]) === 0;
    });
    if (!passes) failing.push(command);
  }
  return { missing, failing };
}

/**
 * Epic `epic`'s own section of `epics.md` text (retro item 12, C6): from its
 * `## Epic <N>:` heading up to the next Epic heading, or the end of the text
 * for the last Epic, byte for byte. `null` when `text` does not parse or has
 * no such Epic. Pure.
 */
export function epicSection(text: string, epic: number): string | null {
  const parsed = parseEpicsMd("epics.md", text);
  if (!parsed.ok) return null;
  const at = parsed.value.epics.findIndex((e) => e.number === epic);
  if (at === -1) return null;
  const lines = text.split(/(?<=\n)/);
  const start = (parsed.value.epics[at] as { line: number }).line - 1;
  const next = parsed.value.epics[at + 1];
  return lines.slice(start, next === undefined ? lines.length : next.line - 1).join("");
}

/**
 * The source line a status planning unit writes directly below Epic
 * `epic`'s context heading: `<!-- source: sha256:<hex> -->`, the hex the
 * SHA-256 of `epicSection(epicsText, epic)`. `null` when there is no
 * section. Pure.
 */
export function epicSourceLine(epicsText: string, epic: number): string | null {
  const section = epicSection(epicsText, epic);
  if (section === null) return null;
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(section);
  return `<!-- source: sha256:${hasher.digest("hex")} -->`;
}

/**
 * The state of Epic `epic`'s context file from its text (`null` when the
 * file is not in the tree): `missing`, `empty` (blank text), `wrong-heading`
 * (does not start with `# Epic <N> Context:`), `stale` when `source` is
 * given and the line directly below the heading is not that source line
 * (retro item 12), or `valid`.
 */
export function epicContextState(epic: number, text: string | null, source?: string): EpicContextState {
  if (text === null) return "missing";
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  if (body.trim() === "") return "empty";
  if (!body.startsWith(`# Epic ${epic} Context:`)) return "wrong-heading";
  if (source === undefined) return "valid";
  const below = body.split("\n")[1];
  return below !== undefined && below.replace(/[ \t\r]+$/, "") === source ? "valid" : "stale";
}

function readListed(snap: RepoSnapshot, path: string): Result<string | null, "unreadable"> {
  if (!snap.tree.includes(path)) return ok(null);
  const text = Object.hasOwn(snap.files, path) ? snap.files[path] : undefined;
  if (typeof text !== "string") return err("unreadable", `${path}: listed in the tree but its content was not read`);
  return ok(text);
}

/**
 * Builds the `Snapshot` `next` reads from raw `main` and ledger files (AR28),
 * or returns the error that stops the lane. A graph failure is not an error
 * here: it is carried in `graph`. Pure.
 */
export function assembleSnapshot(input: AssembleInput): Result<Snapshot, AssembleErrorKind> {
  const repoSnap: RepoSnapshot = { repo: input.repo, now: input.now, tree: input.tree, files: input.files };
  const loaded = loadRepoConfig(repoSnap);
  if (!loaded.ok) return loaded;
  const { config, policy, standingAuthority } = loaded.value.repo;

  const ledger = parseLedger(input.ledger_files);
  if (!ledger.ok) return ledger;

  const statusText = readListed(repoSnap, config.sprint_status_path);
  if (!statusText.ok) return statusText;
  let sprintStatus = emptySprintStatus();
  if (statusText.value !== null) {
    const parsed = parseSprintStatus(config.sprint_status_path, statusText.value);
    if (!parsed.ok) return parsed;
    sprintStatus = parsed.value;
  }

  const resolved = resolveGraph({ tree: repoSnap.tree, files: repoSnap.files, config });
  let graph: unknown;
  const manifests: unknown[] = [];
  const epicContext: Record<string, EpicContextState> = {};
  const liveEvidence: Record<string, boolean> = {};
  const liveEvidenceFile: Record<string, { path: string; text: string }> = {};
  let retroGates = emptyRetroGates();
  if (!resolved.ok) {
    graph = { ok: false, error: { kind: resolved.error.kind, message: resolved.error.message } };
  } else {
    graph = { ok: true, value: resolved.value };
    retroGates = resolved.value.retroGates;
    const loadedManifests = loadManifests(repoSnap, config.manifests);
    if (!loadedManifests.ok) return err("invalid-snapshot", loadedManifests.error.message);
    for (const m of loadedManifests.value) {
      const sha = Object.hasOwn(input.blob_shas, m.path) ? input.blob_shas[m.path] : undefined;
      if (sha === undefined) return err("invalid-snapshot", `${m.path}: no blob SHA on main for this manifest`);
      manifests.push({ ...m, sha });
    }
    // The graph resolved, so `epics_path` was read.
    const epicsText = readListed(repoSnap, config.epics_path);
    if (!epicsText.ok) return epicsText;
    for (const e of resolved.value.epics) {
      const path = epicContextPath(config.epic_context_path, e.number);
      const text = readListed(repoSnap, path);
      if (!text.ok) return text;
      const source = epicsText.value === null ? null : epicSourceLine(epicsText.value, e.number);
      epicContext[String(e.number)] = epicContextState(e.number, text.value, source ?? "");
      const evidencePath = liveEvidencePath(config.live_evidence_glob, e.number, repoSnap.tree);
      liveEvidence[String(e.number)] = evidencePath !== null;
      if (evidencePath !== null) {
        const read = readListed(repoSnap, evidencePath);
        // Only an Epic with live evidence checks needs the text; another reads it when the forge did.
        if (!read.ok && config.live_evidence_checks?.[String(e.number)] !== undefined) return read;
        if (read.ok && read.value !== null) liveEvidenceFile[String(e.number)] = { path: evidencePath, text: read.value };
      }
    }
  }

  const raw = {
    now: input.now,
    main_sha: input.main_sha,
    ledger: {
      tip: input.ledger_tip,
      units: [...ledger.value.units.values()].sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0)),
      coordinator: ledger.value.coordinator,
    },
    config,
    policy,
    standing_authority: standingAuthority,
    manifests,
    graph,
    sprint_status: sprintStatus,
    retro_gates: retroGates,
    escalations: input.escalations,
    epic_context: epicContext,
    live_evidence: liveEvidence,
    live_evidence_file: liveEvidenceFile,
    prs: input.prs,
    lane: input.lane,
    role: input.role,
  };
  const parsed = SnapshotSchema.safeParse(raw);
  if (!parsed.success) return err("invalid-snapshot", `snapshot: ${describeIssues(parsed.error)}`);
  return ok(parsed.data);
}
