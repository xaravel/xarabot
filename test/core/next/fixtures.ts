import type { AssembleInput } from "../../../src/core/next/snapshot.ts";
import { assembleSnapshot } from "../../../src/core/next/snapshot.ts";
import type { LaneRole, Snapshot } from "../../../src/core/schemas/snapshot.ts";
import type { UnitRecord } from "../../../src/core/schemas/ledger.ts";
import { ALICE, NOW, rec, tip } from "../ledger/fixtures.ts";

export { ALICE, NOW, rec };

export const CONFIG_PATH = ".xarabot/config.yaml";
export const EPICS_MD = "_bmad-output/planning-artifacts/epics.md";
export const STATUS = "_bmad-output/implementation-artifacts/sprint-status.yaml";
export const RETRO = "_bmad-output/implementation-artifacts/retro-gates.yaml";
export const AUTHORITY = "docs/standing-authority.md";
export const contextPath = (n: number) => `_bmad-output/implementation-artifacts/epic-${n}-context.md`;

export const MAIN_SHA = "1".repeat(40);
export const LEDGER_SHA = "2".repeat(40);
/** The blob SHA the fixtures give a manifest at `path`. */
export const shaOf = (id: string) => (id.replaceAll(/[^0-9]/g, "") + "f".repeat(40)).slice(0, 40);

export type ManifestSpec = {
  readonly id: string;
  readonly deps?: readonly string[];
  readonly globs?: readonly string[];
  /** A `path_key` value instead of globs. */
  readonly area?: string;
  readonly infra?: boolean;
};

export type Verdict = "accepted" | "accepted-with-open-items" | "rejected" | "rejected-go";

export type World = {
  /** Epic number → Story numbers with headings in `epics.md`. */
  readonly epics: Record<number, readonly string[]>;
  /** Manifests; default one per heading with globs `src/<id>/**`. */
  readonly manifests?: readonly ManifestSpec[];
  readonly bootstrapped?: readonly number[];
  readonly epicsYaml?: string;
  /** Epic → retro verdict; default none. */
  readonly retro?: Record<number, Verdict>;
  /** Story id → status (sprint key `k-<id>`). */
  readonly status?: Record<string, string>;
  /** Epic → context text, `null` to leave it out. Default a valid file for every Epic. */
  readonly contexts?: Record<number, string | null>;
  readonly records?: readonly UnitRecord[];
  readonly escalations?: readonly string[] | null;
  readonly role?: LaneRole;
  readonly pathMap?: Record<string, readonly string[]>;
  /** Raw file overrides; `null` drops a file. */
  readonly files?: Record<string, string | null>;
  readonly ledgerFiles?: Record<string, string>;
  /** Manifest paths left out of `blob_shas`. */
  readonly noSha?: readonly string[];
};

export const manifestPath = (id: string) => `stories/${id}.md`;

function epicsMd(epics: Record<number, readonly string[]>): string {
  const parts = ["# Epics", "", "## Epic List", "", "- Epic 1: list entry", ""];
  for (const [n, stories] of Object.entries(epics)) {
    parts.push(`## Epic ${n}: Epic ${n}`, "");
    for (const s of stories) parts.push(`### Story ${n}.${s}: Story ${n}.${s}`, "", "Body.", "");
  }
  return parts.join("\n");
}

function manifest(m: ManifestSpec): string {
  const lines = ["---", `story_id: "${m.id}"`, `epic: ${m.id.split(".")[0]}`, `sprint_key: k-${m.id}`, `title: Story ${m.id}`];
  if (m.area !== undefined) lines.push(`area: ${m.area}`);
  else lines.push(`globs: [${(m.globs ?? [`src/${m.id}/**`]).map((g) => JSON.stringify(g)).join(", ")}]`);
  if (m.deps !== undefined) lines.push(`depends_on: [${m.deps.map((d) => `"${d}"`).join(", ")}]`);
  if (m.infra === true) lines.push("infrastructure: true");
  lines.push("---", "");
  return lines.join("\n");
}

function config(w: World): string {
  const lines = [
    "schema_version: 1",
    'runner_version: "0.1.0"',
    "maintainer: edanisko",
    `standing_authority_path: ${AUTHORITY}`,
    `bootstrapped_epics: [${(w.bootstrapped ?? []).join(", ")}]`,
    "manifests:",
    "  dir: stories",
  ];
  if (w.pathMap !== undefined) {
    lines.push("  path_key: area", "  path_map:");
    for (const [k, v] of Object.entries(w.pathMap)) lines.push(`    ${k}: [${v.map((g) => JSON.stringify(g)).join(", ")}]`);
  }
  return `${lines.join("\n")}\n`;
}

function retroGates(retro: Record<number, Verdict>): string {
  const lines = ["schema_version: 1", "epics:"];
  for (const [n, v] of Object.entries(retro)) {
    const verdict = v === "rejected-go" ? "rejected" : v;
    lines.push(`  "${n}":`, "    retro:", `      verdict: ${verdict}`, `      unit: "retro:${n}"`, "      recorded_at: 2026-10-20T00:00:00Z");
    if (v === "rejected-go") lines.push("      go:", "        by: edanisko", "        at: 2026-10-21T00:00:00Z", "        ruling: maintainer-pr");
  }
  return `${lines.join("\n")}\n`;
}

function sprintStatus(status: Record<string, string>): string {
  const lines = ["# comment", "project: x", "development_status:", "  epic-1: backlog"];
  for (const [id, s] of Object.entries(status)) lines.push(`  k-${id}: ${s}`);
  lines.push("action_items: []");
  return `${lines.join("\n")}\n`;
}

/** The raw `assembleSnapshot` input for a world. */
export function input(w: World): AssembleInput {
  const specs =
    w.manifests ?? Object.entries(w.epics).flatMap(([n, stories]) => stories.map((s) => ({ id: `${n}.${s}` })));
  const files: Record<string, string | null> = {
    [CONFIG_PATH]: config(w),
    ".xarabot/policy.yaml": "schema_version: 1\n",
    ".xarabot/human-live-steps.yaml": "schema_version: 1\nsteps: []\n",
    [AUTHORITY]: "---\nschema_version: 1\ngranted_by: edanisko\ngranted_at: 2026-10-01\nrepo: xaravel/xarabot\n---\n\nGranted.\n",
    [EPICS_MD]: epicsMd(w.epics),
    [STATUS]: sprintStatus(w.status ?? {}),
  };
  if (w.epicsYaml !== undefined) files[".xarabot/epics.yaml"] = w.epicsYaml;
  if (w.retro !== undefined) files[RETRO] = retroGates(w.retro);
  for (const n of Object.keys(w.epics).map(Number)) files[contextPath(n)] = `# Epic ${n} Context: Epic ${n}\n\nGoal.\n`;
  for (const [n, text] of Object.entries(w.contexts ?? {})) files[contextPath(Number(n))] = text;
  for (const m of specs) files[manifestPath(m.id)] = manifest(m);
  Object.assign(files, w.files ?? {});
  const present = Object.entries(files).filter((e): e is [string, string] => e[1] !== null);
  const blob_shas: Record<string, string> = {};
  for (const m of specs) if (!(w.noSha ?? []).includes(manifestPath(m.id))) blob_shas[manifestPath(m.id)] = shaOf(m.id);
  return {
    repo: "xaravel/xarabot",
    now: NOW,
    tree: ["README.md", ...present.map(([p]) => p)],
    files: Object.fromEntries(present),
    main_sha: MAIN_SHA,
    blob_shas,
    ledger_tip: LEDGER_SHA,
    ledger_files: w.ledgerFiles ?? tip(w.records ?? []),
    prs: {},
    escalations: w.escalations === undefined ? null : w.escalations === null ? null : { open: [...w.escalations] },
    lane: ALICE,
    role: w.role ?? "builder",
  };
}

/** The assembled snapshot for a world; throws when the assembler fails. */
export function snapshotOf(w: World): Snapshot {
  const r = assembleSnapshot(input(w));
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.value;
}

/** A record for `story:<id>` in `state`, with overrides. */
export function storyRec(id: string, over: Partial<UnitRecord> = {}): UnitRecord {
  const state = over.state ?? "claimed";
  return rec({
    unit: `story:${id}`,
    globs: [`src/${id}/**`],
    park:
      state === "parked"
        ? { kind: "blocked", reason: "other", inbox_owner: "edanisko", globs_held: over.globs ?? [`src/${id}/**`] }
        : null,
    ...over,
  });
}
