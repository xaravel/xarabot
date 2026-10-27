import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeForge, gitBlobSha, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import type { AppCredentials } from "../../src/adapters/forge/github/credentials.ts";
import { createGitHubForge } from "../../src/adapters/forge/github/github-forge.ts";
import { isSuccess, mapHttpError, request, type Operation } from "../../src/adapters/forge/github/http.ts";
import { createTokenSource } from "../../src/adapters/forge/github/tokens.ts";
import { loadRepoConfig } from "../../src/core/config/load-repo-config.ts";
import { parseRetroGates } from "../../src/core/graph/retro-gates.ts";
import { EMPTY_INBOX_BODY } from "../../src/core/inbox/render-digest.ts";
import { COORDINATOR_PATH, parseLedger, serializeCoordinator, serializeUnitRecord } from "../../src/core/ledger/codec.ts";
import { claim, takeOverStale, type LedgerEdit } from "../../src/core/ledger/edits.ts";
import { reconcileDue } from "../../src/core/next/coordinator.ts";
import { next } from "../../src/core/next/next.ts";
import { assembleSnapshot, epicSourceLine } from "../../src/core/next/snapshot.ts";
import { editRetroGates, serializeRetroGates } from "../../src/core/reconcile/retro-gates-edit.ts";
import { err, ok } from "../../src/core/result.ts";
import { judgeRulings, rulingAdds, type JudgedRuling, type RulingInput } from "../../src/core/rulings/effects.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import { unitPath, type CoordinatorRecord, type LaneIdentity, type PendingRuling, type UnitRecord } from "../../src/core/schemas/ledger.ts";
import type { Go, RetroGates, RetroGatesEntry, RetroItem, RetroVerdict } from "../../src/core/schemas/retro-gates.ts";
import type { Snapshot } from "../../src/core/schemas/snapshot.ts";
import { runCoordinatorProcess } from "../../src/lane/coordinator-process.ts";
import { readsPath } from "../../src/lane/lane-process.ts";
import { createFsLaneStore } from "../../src/lane/lane-store.ts";
import { headPassedGate } from "../../src/lane/passed-gate.ts";
import type { ReconcileCommitRequest, ReconcileCommitter } from "../../src/lane/reconcile-commit.ts";
import { createReconcileStep } from "../../src/lane/reconcile-step.ts";
import type { LaneProcessResult } from "../../src/lane/session.ts";
import type { Agent } from "../../src/ports/agent.ts";
import { forgeErr, forgeOk, type CallOpts, type Forge, type ForgeResult, type ForgeSnapshot, type GitSha, type InboxComment, type InboxIssue } from "../../src/ports/forge.ts";
import { unchangedGraph } from "../lane/graph-stub.ts";
import { cleanupScratch, LIVE_LOGIN, liveCredentials, liveRepo, prefixed, type RawCall } from "../support/live-github.ts";
import { callSignal, must, step } from "./cross-vendor-harness.ts";
import { recordAlerts } from "./race-harness.ts";
import { scratchSeed } from "./scratch-seed.ts";

/**
 * The parallel Epics and gates verification harness (Story 4.7, FR5, FR10).
 *
 * A Xarabot-shaped copy of Xaravel's Phase 1 graph (`gatesWorld`) is laid
 * over an area's `main` (`gatesForge`): Epics 1 to 8 bootstrapped, 8 a
 * checkpoint after 7, then `runtime` (9), `contracts` (10), `macroable`,
 * `conditionable` and `json-schema` (11 to 13, each after 10) and `tooling`
 * (14, after 9). Builders claim through the real `next` and the lane's own
 * `claim`/`takeOverStale` edits (`builderRound`); the coordinator runs the
 * real coordinator process with the real `reconcile` step
 * (`coordinatorRound`).
 *
 * An area is the fake forge (`fakeGatesArea`, rehearsed in every `bun test`)
 * or the scratch repo (`liveGatesArea`). Nothing is ever merged into the
 * scratch `main`: the `reconcile` PR's enqueue is held, and its committed
 * `retro-gates.yaml` is laid over `main` by `setWorld` (the simulated merge).
 *
 * What the live cases must show is pure (`checkpointProblems`,
 * `digestProblems`); the live case and its rehearsal both assert `[]`.
 */

// ------------------------------------------------------------ paths

export const CONFIG_PATH = ".xarabot/config.yaml";
export const EPICS_YAML_PATH = ".xarabot/epics.yaml";
export const EPICS_PATH = "_bmad-output/planning-artifacts/epics.md";
export const STATUS_PATH = "_bmad-output/implementation-artifacts/sprint-status.yaml";
export const GATES_PATH = "_bmad-output/implementation-artifacts/retro-gates.yaml";
export const contextPath = (epic: number): string => `_bmad-output/implementation-artifacts/epic-${epic}-context.md`;
export const specPath = (epic: number, story: number, slug: string): string => `_bmad-output/implementation-artifacts/spec-${epic}-${story}-${slug}.md`;
export const manifestPath = (id: string): string => `stories/${id}.md`;

/** The ledger branch an inbox links a record with no PR into (`render-digest.ts`), whatever ledger branch the area uses. */
const INBOX_LEDGER_BRANCH = "xarabot/claims";
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60_000;

// ------------------------------------------------------------ the slug table

export type GatesEpic = { readonly epic: number; readonly slug: string; readonly title: string; readonly depends_on: readonly number[] };

/** Xaravel Phase 1, as the fixture shapes it: 14 is the Epic that does not depend on `contracts`. */
export const GATES_EPICS: readonly GatesEpic[] = [
  { epic: 9, slug: "runtime", title: "Runtime", depends_on: [8] },
  { epic: 10, slug: "contracts", title: "Contracts", depends_on: [9] },
  { epic: 11, slug: "macroable", title: "Macroable", depends_on: [10] },
  { epic: 12, slug: "conditionable", title: "Conditionable", depends_on: [10] },
  { epic: 13, slug: "json-schema", title: "Json Schema", depends_on: [10] },
  { epic: 14, slug: "tooling", title: "Tooling", depends_on: [9] },
];

export const BOOTSTRAPPED: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8];

export function gatesEpic(epic: number): GatesEpic {
  const e = GATES_EPICS.find((x) => x.epic === epic);
  if (e === undefined) throw new Error(`gates: no Epic ${epic} in the slug table`);
  return e;
}

/** Story `<E>.<s>`'s sprint key: `<E>-<s>-<slug>`. */
export const sprintKey = (epic: number, story: number): string => `${epic}-${story}-${gatesEpic(epic).slug}`;
export const storyUnit = (epic: number, story: number): string => `story:${epic}.${story}`;
export const globOf = (epic: number): string => `packages/${gatesEpic(epic).slug}/**`;

/** A retro item's id: `epic-<N>-retro-item-<seq>-<slug>`. */
export const itemId = (epic: number, seq: number, slug: string): string => `epic-${epic}-retro-item-${seq}-${slug}`;

// ------------------------------------------------------------ the world

export type WorldItem = {
  readonly epic: number;
  readonly seq: number;
  readonly slug: string;
  readonly text?: string;
  /** Default `lane`. */
  readonly route?: RetroItem["route"];
  readonly blocking: boolean;
  /** Default `open`. */
  readonly status?: RetroItem["status"];
};

/** A Story spec on `main` with `deferred` entries (entry `n` is `<E>.<s>-d<n>`). */
export type WorldSpec = {
  readonly epic: number;
  readonly story: number;
  readonly slug: string;
  readonly created: string;
  readonly deferred: readonly string[];
};

export type GatesWorldOptions = {
  /** The repo and Maintainer the config names; default the fake area's `acme/scratch` and `alice`. */
  readonly repo?: string;
  readonly login?: string;
  readonly runnerVersion?: string;
  /** Epics (9 to 14) whose every Story is `done`. */
  readonly done?: readonly number[];
  /** Recorded retro verdicts, by Epic. */
  readonly retros?: Readonly<Record<number, RetroVerdict>>;
  /** Each retro's `recorded_at`, by Epic; default `DEFAULT_RECORDED_AT`. */
  readonly recordedAt?: Readonly<Record<number, string>>;
  /** Rejected retros with a recorded go. */
  readonly retroGo?: readonly number[];
  readonly items?: readonly WorldItem[];
  /** Checkpoint Epics besides 8. */
  readonly checkpoint?: readonly number[];
  /** Checkpoints (besides 8) with a recorded go. */
  readonly checkpointGo?: readonly number[];
  /** Epic 8's checkpoint go; default recorded. */
  readonly epic8Go?: boolean;
  readonly specs?: readonly WorldSpec[];
  /** More `main` files, path → text. */
  readonly extra?: Readonly<Record<string, string>>;
};

export const DEFAULT_RECORDED_AT = "2026-10-20T00:00:00Z";
const GO_AT = "2026-10-19T00:00:00Z";

/** `main`'s files in a world: path → text. */
export type World = Readonly<Record<string, string>>;

function storyFile(epic: number, story: number): string {
  const e = gatesEpic(epic);
  return [
    "---",
    `story_id: "${epic}.${story}"`,
    `epic: ${epic}`,
    `sprint_key: ${sprintKey(epic, story)}`,
    `title: ${e.title} ${story}`,
    `globs: ["${globOf(epic)}"]`,
    ...(story === 2 ? [`depends_on: ["${epic}.1"]`] : []),
    "---",
    "",
  ].join("\n");
}

function specFile(s: WorldSpec): string {
  return [
    "---",
    `title: 'Story ${s.epic}.${s.story}: ${s.slug}'`,
    "status: done",
    `created: '${s.created}'`,
    `deferred: [${s.deferred.map((d) => JSON.stringify(d)).join(", ")}]`,
    "---",
    "",
    `# Story ${s.epic}.${s.story}`,
    "",
  ].join("\n");
}

/** Epic `n`'s title: the slug table's for 9 to 14, `Phase 0 step <n>` for the bootstrapped ones. */
const titleOf = (n: number): string => (n <= 8 ? `Phase 0 step ${n}` : gatesEpic(n).title);

/**
 * The Xaravel-shaped world (pure): options → `main` path → text, valid
 * input to `assembleSnapshot`. Epics 1 to 8 are bootstrapped with headings
 * only; 8 is a checkpoint after 7 whose go is recorded unless `epic8Go` is
 * `false`. Epics 9 to 14 each have Stories `<E>.1` and `<E>.2` (both on
 * `packages/<slug>/**`, `<E>.2` after `<E>.1`), with every `epics.yaml`
 * entry explicit. Every Story of a done Epic is `done`, every other one
 * `backlog`; `epic-<N>` is `done` for Epics 1 to 8 and the done Epics, so
 * `reconcile` has no status edit to make.
 */
export function gatesWorld(o: GatesWorldOptions = {}): World {
  const repo = o.repo ?? FAKE_REPO;
  const login = o.login ?? FAKE_LOGIN;
  const done = new Set(o.done ?? []);
  const files: Record<string, string> = {};

  const seed = scratchSeed({ repo, login, ...(o.runnerVersion !== undefined ? { runnerVersion: o.runnerVersion } : {}) });
  files[CONFIG_PATH] = `${(seed[CONFIG_PATH] as string).trimEnd()}\nbootstrapped_epics: [${BOOTSTRAPPED.join(", ")}]\n`;

  const checkpoints = new Set([8, ...(o.checkpoint ?? [])]);
  const yaml = ["version: 1", "epics:", `  "8": {depends_on: [7], checkpoint: true}`];
  for (const e of GATES_EPICS) yaml.push(`  "${e.epic}": {depends_on: [${e.depends_on.join(", ")}]${checkpoints.has(e.epic) ? ", checkpoint: true" : ""}}`);
  files[EPICS_YAML_PATH] = `${yaml.join("\n")}\n`;

  const md = ["# Epics", ""];
  for (const n of BOOTSTRAPPED) md.push(`## Epic ${n}: ${titleOf(n)}`, "", `Phase 0, bootstrapped.`, "");
  for (const e of GATES_EPICS) {
    md.push(`## Epic ${e.epic}: ${e.title}`, "");
    for (const s of [1, 2]) {
      md.push(`### Story ${e.epic}.${s}: ${e.title} ${s}`, "", `Builds \`packages/${e.slug}\`.`, "");
      files[manifestPath(`${e.epic}.${s}`)] = storyFile(e.epic, s);
    }
  }
  const epicsText = md.join("\n");
  files[EPICS_PATH] = epicsText;

  for (const n of [...BOOTSTRAPPED, ...GATES_EPICS.map((e) => e.epic)]) {
    const source = epicSourceLine(epicsText, n);
    if (source === null) throw new Error(`gates world: epics.md has no Epic ${n} section`);
    files[contextPath(n)] = `# Epic ${n} Context: ${titleOf(n)}\n${source}\n\nThe ${titleOf(n)} Epic of the Xaravel-shaped fixture.\n`;
  }

  const status = ["development_status:"];
  for (const n of BOOTSTRAPPED) status.push(`  epic-${n}: done`);
  for (const e of GATES_EPICS) {
    const d = done.has(e.epic);
    status.push(`  epic-${e.epic}: ${d ? "done" : "backlog"}`);
    for (const s of [1, 2]) status.push(`  ${sprintKey(e.epic, s)}: ${d ? "done" : "backlog"}`);
  }
  files[STATUS_PATH] = `${status.join("\n")}\n`;

  const go = (): Go => ({ by: login, at: GO_AT, ruling: "maintainer-pr" });
  const epics: Record<string, RetroGatesEntry> = {};
  const entry = (n: number): RetroGatesEntry => epics[String(n)] ?? {};
  if (o.epic8Go !== false) epics["8"] = { checkpoint: { go: go() } };
  for (const [key, verdict] of Object.entries(o.retros ?? {})) {
    const n = Number(key);
    const recorded_at = o.recordedAt?.[n] ?? DEFAULT_RECORDED_AT;
    const withGo = (o.retroGo ?? []).includes(n);
    epics[key] = { ...entry(n), retro: { verdict, unit: `retro:${n}`, recorded_at, ...(withGo ? { go: go() } : {}) } };
  }
  for (const i of o.items ?? []) {
    const item: RetroItem = {
      id: itemId(i.epic, i.seq, i.slug),
      text: i.text ?? `Do ${i.slug}.`,
      route: i.route ?? "lane",
      blocking: i.blocking,
      globs: [],
      status: i.status ?? "open",
    };
    const e = entry(i.epic);
    epics[String(i.epic)] = { ...e, items: [...(e.items ?? []), item] };
  }
  for (const n of o.checkpointGo ?? []) epics[String(n)] = { ...entry(n), checkpoint: { go: go() } };
  const gates: RetroGates = { schema_version: 1, epics };
  files[GATES_PATH] = serializeRetroGates(gates);

  for (const s of o.specs ?? []) files[specPath(s.epic, s.story, s.slug)] = specFile(s);
  Object.assign(files, o.extra ?? {});
  return files;
}

/** Whether the overlay hides `path` of the real `main`: everything under `_bmad-output/` or `stories/`, and `.xarabot/epics.yaml`. */
function hidden(path: string): boolean {
  return path.startsWith("_bmad-output/") || path.startsWith("stories/") || path === EPICS_YAML_PATH;
}

/** `main` with `world` laid over it: every world path written over, the hidden paths dropped, blob SHAs from `gitBlobSha`. */
export function overlayWorld(main: ForgeSnapshot["main"], world: World, read: (path: string) => boolean): ForgeSnapshot["main"] {
  const keep = main.tree.filter((p) => !hidden(p) && !Object.hasOwn(world, p));
  const tree = [...keep, ...Object.keys(world)].sort();
  const texts: Record<string, string> = {};
  const blobShas: Record<string, string> = {};
  for (const p of keep) {
    const text = main.files[p];
    if (text !== undefined) texts[p] = text;
    const sha = main.blob_shas[p];
    if (sha !== undefined) blobShas[p] = sha;
  }
  for (const [p, text] of Object.entries(world)) {
    blobShas[p] = gitBlobSha(text);
    if (read(p)) texts[p] = text;
  }
  return { sha: main.sha, tree, files: texts, blob_shas: blobShas };
}

// ------------------------------------------------------------ the overlay forge

/** An enqueue the overlay held: never forwarded, so nothing merges. */
export type HeldEnqueue = { readonly pr: number; readonly head: GitSha };

/** A forge whose snapshots show `main` with `world` laid over it, and whose enqueues are held. */
export type GatesForge = Forge & {
  /** The world laid over `main`. */
  readonly world: World;
  /** Replaces the world: the simulated merge. */
  setWorld(world: World): void;
  /** Every held enqueue, in order. */
  readonly held: HeldEnqueue[];
};

/**
 * `forge` with `world` laid over `main` in every snapshot (`overlayWorld`)
 * and `enqueue` held: it returns `queued: true` unforwarded and records the
 * PR.
 */
export function gatesForge(forge: Forge, world: World): GatesForge {
  let current = world;
  const held: HeldEnqueue[] = [];
  return {
    ...forge,
    snapshot: async (opts) => {
      const r = await forge.snapshot(opts);
      if (!r.ok) return r;
      return forgeOk({ ...r.value, main: overlayWorld(r.value.main, current, opts.read ?? (() => false)) });
    },
    enqueue: async (pr, head) => {
      held.push({ pr, head });
      return forgeOk({ queued: true as const });
    },
    get world() {
      return current;
    },
    setWorld(w) {
      current = w;
    },
    held,
  };
}

// ------------------------------------------------------------ builders

export type BuilderOutcome = {
  readonly lane: string;
  readonly kind: "claimed" | "took-over" | "idle" | "park" | "stop";
  readonly unit?: string;
  readonly reason?: string;
};

/** The snapshot `next` reads, assembled as `identity` in `role`. */
export function assembleAs(repo: string, snap: ForgeSnapshot, identity: LaneIdentity, role: "builder" | "coordinator"): Snapshot {
  const assembled = assembleSnapshot({
    repo,
    now: snap.now,
    tree: [...snap.main.tree],
    files: { ...snap.main.files },
    main_sha: snap.main.sha,
    blob_shas: snap.main.blob_shas,
    ledger_tip: snap.ledger.tip,
    ledger_files: snap.ledger.files,
    prs: snap.prs,
    escalations: null,
    lane: identity,
    role,
  });
  if (!assembled.ok) throw new Error(`assembleSnapshot: ${assembled.error.kind}: ${assembled.error.message}`);
  return assembled.value;
}

/**
 * One round of builders, in turn: each takes a snapshot, assembles it as a
 * builder, calls `next`, and on a unit swaps the lane's own edit, mirroring
 * the claim edits `lane-process.ts` builds for a Story with no PR (the
 * fixture worlds have none, so no PR is listed or adopted):
 * `takeOverStale` for a stale `claimed` record, else `claim`. A refused
 * swap throws.
 */
export async function builderRound(forge: Forge, repo: string, identities: readonly LaneIdentity[]): Promise<BuilderOutcome[]> {
  const out: BuilderOutcome[] = [];
  for (const id of identities) {
    const snap = must(await forge.snapshot({ signal: callSignal(), read: readsPath }), `${id.lane}: snapshot`);
    const picked = next(assembleAs(repo, snap, id, "builder"), "builder");
    if (picked.kind === "idle" || picked.kind === "stop") {
      out.push({ lane: id.lane, kind: picked.kind, reason: picked.reason });
      continue;
    }
    if (picked.kind === "park") {
      out.push({ lane: id.lane, kind: "park", unit: picked.story.unit, reason: picked.park });
      continue;
    }
    const story = picked.story;
    let edit: LedgerEdit;
    if (story.take_over === "claimed") {
      if (story.expect_generation === null) throw new Error(`${id.lane}: a takeover of ${story.unit} with no generation`);
      edit = takeOverStale({ unit: story.unit, by: id, now: snap.now, generation: story.expect_generation, globs: story.globs, baseSha: snap.main.sha });
    } else if (story.take_over === "merging") {
      throw new Error(`${id.lane}: next gave a merging takeover of ${story.unit}, which no gates case expects`);
    } else {
      edit = claim({
        unit: story.unit,
        by: id,
        now: snap.now,
        globs: story.globs,
        expectGeneration: story.expect_generation,
        manifestSha: story.infrastructure ? story.manifest_sha : null,
        baseSha: snap.main.sha,
      });
    }
    const what = story.take_over === "claimed" ? "takeOverStale" : "claim";
    const commit = edit(snap.ledger.files);
    if (!commit.ok) throw new Error(`${id.lane}: ${what} ${story.unit} refused: ${commit.error.kind}: ${commit.error.message}`);
    if (commit.value === null) throw new Error(`${id.lane}: ${what} ${story.unit} wrote nothing`);
    must(await forge.ledgerSwap(snap.ledger.tip, commit.value, { signal: callSignal() }), `${id.lane}: ${what} ${story.unit} swap`);
    out.push({ lane: id.lane, kind: story.take_over === "claimed" ? "took-over" : "claimed", unit: story.unit });
  }
  return out;
}

/** The units a round claimed or took over, sorted. */
export function claimedUnits(outcomes: readonly BuilderOutcome[]): string[] {
  return outcomes
    .filter((o) => o.kind === "claimed" || o.kind === "took-over")
    .map((o) => o.unit as string)
    .sort();
}

// ------------------------------------------------------------ rulings onto main

/** A ruling comment, as `judgeRulings` reads one. */
export type RulingCommentInput = RulingInput;

const RULING_LANE: LaneIdentity = { owner: "xarabot-fixture", host: "99999999-9999-4999-8999-999999999999", lane: "builder-1" };

/** The snapshot of `world` laid over the scratch seed of `repo` for `login` (as `gatesForge` lays it over the scratch `main`): no ledger, no PRs. */
export function worldSnapshot(world: World, at: { readonly repo: string; readonly login: string }, now: string): Snapshot {
  const seed = scratchSeed({ repo: at.repo, login: at.login });
  const blob: Record<string, string> = {};
  for (const [p, t] of Object.entries(seed)) blob[p] = gitBlobSha(t);
  const main = overlayWorld({ sha: "0".repeat(40), tree: Object.keys(seed).sort(), files: seed, blob_shas: blob }, world, () => true);
  const assembled = assembleSnapshot({
    repo: at.repo,
    now,
    tree: [...main.tree],
    files: { ...main.files },
    main_sha: main.sha,
    blob_shas: main.blob_shas,
    ledger_tip: "1".repeat(40),
    ledger_files: {},
    prs: {},
    escalations: null,
    lane: RULING_LANE,
    role: "builder",
  });
  if (!assembled.ok) throw new Error(`worldSnapshot: ${assembled.error.kind}: ${assembled.error.message}`);
  return assembled.value;
}

/**
 * A ruling comment carried onto `main` as `reconcile` does it: judged
 * against the world (`judgeRulings`), its pending entries (`rulingAdds`)
 * written into `retro-gates.yaml` (`editRetroGates`). A refused ruling
 * leaves `main` as it was.
 */
export function ruledOnto(
  main: World,
  comment: RulingCommentInput,
  at: { readonly repo: string; readonly login: string } = { repo: FAKE_REPO, login: FAKE_LOGIN },
): { readonly main: World; readonly judged: readonly JudgedRuling[] } {
  const { judged } = judgeRulings(worldSnapshot(main, at, comment.created_at), [comment]);
  const adds = rulingAdds(judged);
  if (adds.pending.length === 0) return { main, judged };
  const edited = editRetroGates(GATES_PATH, main[GATES_PATH] ?? null, [], [], [], adds.pending);
  if (!edited.ok) throw new Error(`ruledOnto: ${edited.error.message}`);
  return { main: { ...main, [GATES_PATH]: edited.value.text }, judged };
}

// ------------------------------------------------------------ areas

export type GatesArea = {
  readonly kind: "fake" | "live";
  readonly repo: string;
  /** The Maintainer, the config's `maintainer` and every identity's owner. */
  readonly login: string;
  readonly runnerVersion: string;
  /** `https://github.com/<repo>`. */
  readonly repoUrl: string;
  /** The area's forge: the world overlaid, enqueues held, alerts recorded. */
  readonly forge: GatesForge;
  readonly coordinator: LaneIdentity;
  /** Lanes `builder-1` … `builder-<n>`, each on its own host. */
  builders(n?: number): LaneIdentity[];
  /** Every commit request `reconcile` made, in order. */
  readonly commits: ReconcileCommitRequest[];
  readonly committer: ReconcileCommitter;
  /** Recorded alerts, `<condition> @ <main sha>`. */
  readonly alerts: string[];
  /** The forge's time. */
  now(): Promise<string>;
  /** The Maintainer's `body` on inbox issue `issue`: the fake posts it; live, the Maintainer does, by hand. Returns the comment once read. */
  maintainerComment(issue: InboxIssue, body: string, after: string | null): Promise<InboxComment>;
  /** Returns once `reconcile` is due again. */
  untilReconcileDue(): Promise<void>;
  /** The coordinator's host clock and sleeps: the fake's own; live, the real ones. */
  readonly clock: { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> } | null;
  /** The coordinator lane's folder, inside the area's own temp root. */
  readonly laneDir: string;
  /** The host `STOP` marker path: `<root>/STOP`, never shared with another area. */
  readonly hostStop: string;
  /** Live: closes the PRs, deletes the branches and the ledger branch. Both: removes the temp folder. */
  cleanup(): Promise<void>;
};

const FAKE_REPO = "acme/scratch";
const FAKE_LOGIN = "alice";
export const FAKE_NOW = "2026-10-25T10:00:00Z";
const FAKE_RUNNER = "canary";
const CHECK = "check";

function identities(login: string, coordinatorHost: string): { coordinator: LaneIdentity; builders: (n?: number) => LaneIdentity[] } {
  const hosts: string[] = [];
  return {
    coordinator: { owner: login, host: coordinatorHost, lane: "coordinator" },
    builders: (n = 4) => {
      while (hosts.length < n) hosts.push(crypto.randomUUID());
      return hosts.slice(0, n).map((host, i) => ({ owner: login, host, lane: `builder-${i + 1}` }));
    },
  };
}

/** Polls `readRulings` from `after` for a comment on inbox issue `issue` by `login` (case-insensitively) whose trimmed body is exactly `body`. */
async function findComment(forge: Forge, issue: number, after: string | null, login: string, body: string, deadlineMs: number, everyMs: number): Promise<InboxComment> {
  let cursor = after;
  for (;;) {
    const read = must(await forge.readRulings(cursor, { signal: callSignal() }), "readRulings");
    const found = read.comments.find((c) => c.issue === issue && c.author !== null && c.author.toLowerCase() === login.toLowerCase() && c.body.trim() === body);
    if (found !== undefined) return found;
    cursor = read.cursor;
    if (Date.now() > deadlineMs) throw new Error(`no comment ${JSON.stringify(body)} by ${login} on #${issue} was read in time`);
    await Bun.sleep(everyMs);
  }
}

export type FakeGatesArea = GatesArea & { readonly kind: "fake"; readonly fake: FakeForge };

/** A rehearsal area: the fake forge, `main` the scratch seed of `acme/scratch` for `alice`, and a fake clock. */
export function fakeGatesArea(): FakeGatesArea {
  const repo = FAKE_REPO;
  const login = FAKE_LOGIN;
  const repoUrl = `https://github.com/${repo}`;
  const fake = createFakeForge({ now: FAKE_NOW, main: scratchSeed({ repo, login }), repoUrl });
  const alerts: string[] = [];
  const forge = gatesForge(recordAlerts(fake.forge, alerts), {});
  const ids = identities(login, crypto.randomUUID());
  const commits: ReconcileCommitRequest[] = [];
  let forgeNow = FAKE_NOW;
  let hostMs = Date.parse(FAKE_NOW);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xarabot-gates-")));
  const laneDir = join(root, "coordinator");
  return {
    kind: "fake",
    fake,
    repo,
    login,
    runnerVersion: FAKE_RUNNER,
    repoUrl,
    forge,
    coordinator: ids.coordinator,
    builders: ids.builders,
    commits,
    committer: {
      async commit(r) {
        commits.push(r);
        const head = fake.control.makeCommit();
        fake.control.setChecks(head, [{ name: CHECK, status: "completed", conclusion: "success" }]);
        return ok({ head_sha: head, base_sha: r.ontoSha });
      },
    },
    alerts,
    now: async () => forgeNow,
    maintainerComment: async (issue, body, after) => {
      fake.control.addInboxComment(issue.number, login, body);
      return findComment(fake.forge, issue.number, after, login, body, Date.now(), 0);
    },
    untilReconcileDue: async () => {
      forgeNow = new Date(Date.parse(forgeNow) + 11 * MIN_MS).toISOString();
      fake.control.setNow(forgeNow);
      hostMs = Date.parse(forgeNow);
    },
    clock: {
      now: () => (hostMs += 1),
      sleep: async (ms) => {
        hostMs += ms;
      },
    },
    laneDir,
    hostStop: join(root, "STOP"),
    cleanup: async () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Test-only REST operations of the live committer and push, as `DELETE_REF` is the cleanup's. Not part of the adapter. */
export const LIVE_GET_COMMIT: Operation = { name: "getCommit (live gates commit)", method: "GET", permission: "contents: write" };
export const LIVE_CREATE_TREE: Operation = { name: "createTree (live gates commit)", method: "POST", permission: "contents: write" };
export const LIVE_CREATE_COMMIT: Operation = { name: "createCommit (live gates commit)", method: "POST", permission: "contents: write" };
export const LIVE_CREATE_REF: Operation = { name: "createRef (live gates push)", method: "POST", permission: "contents: write", conflictOn: 422 };

const COMMENT_WAIT_MS = 15 * MIN_MS;
const COMMENT_POLL_MS = 15_000;
const DUE_WAIT_MS = 12 * MIN_MS;
const DUE_POLL_MS = 30_000;

/**
 * A live area on the scratch repo (`XARABOT_LIVE_GITHUB_REPO`) as
 * `LIVE_LOGIN`'s App: a fresh ledger branch `xarabot/test-<uuid>`, unit
 * branches prefixed `xarabot-test/<uuid>/`, alerts recorded, and
 * `runner_version` read from the scratch `main`. The `reconcile` commit is a
 * REST commit (`createTree` on `ontoSha`'s tree, `createCommit` with parent
 * `ontoSha`), and its branch is created by a REST `createRef`, so no
 * `runner.git` is needed. `cleanup` closes the PRs and deletes the branches
 * and the ledger branch.
 */
export async function liveGatesArea(): Promise<GatesArea> {
  const repo = liveRepo();
  const slug = `${repo.owner}/${repo.name}`;
  const credentials: AppCredentials = await liveCredentials();
  const ledgerBranch = `xarabot/test-${crypto.randomUUID()}`;
  const prefix = `xarabot-test/${crypto.randomUUID()}/`;
  const touched = new Set<string>();
  const tokens = createTokenSource({ credentials, repo });
  /** One REST call on the scratch repo; a non-2xx reply is its forge error. */
  const api = async (op: Operation, path: string, body: unknown, signal: AbortSignal): Promise<ForgeResult<{ readonly status: number; readonly body: unknown }>> => {
    const token = await tokens.get(signal);
    if (!token.ok) return token;
    const r = await request({ op, path: `/repos/${repo.owner}/${repo.name}${path}`, token: token.value, signal, body });
    if (!r.ok) return r;
    if (!isSuccess(r.value.status)) return mapHttpError(op, r.value);
    return forgeOk({ status: r.value.status, body: r.value.body });
  };
  const raw: RawCall = async (op, path, body) => {
    const s = callSignal();
    const token = must(await tokens.get(s), "installation token");
    const r = must(await request({ op, path: `/repos/${repo.owner}/${repo.name}${path}`, token, signal: s, body }), op.name);
    return { status: r.status, body: r.body };
  };
  const inner = createGitHubForge({ repo, credentials, ledgerBranch, maintainer: LIVE_LOGIN });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xarabot-gates-live-")));
  const laneDir = join(root, "coordinator");
  const cleanup = async (): Promise<void> => {
    try {
      await cleanupScratch({ forge: inner, raw, touched, ledgerBranch, signal: callSignal });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  let runnerVersion: string;
  try {
    const snap = must(await inner.snapshot({ signal: callSignal(), read: readsPath }), "scratch snapshot");
    const loaded = loadRepoConfig({ repo: slug, now: snap.now, tree: [...snap.main.tree], files: { ...snap.main.files } });
    if (!loaded.ok) throw new Error(`scratch main: ${loaded.error.kind}: ${loaded.error.message} (seed the scratch repo with bun test/e2e/scratch-seed.ts)`);
    runnerVersion = loaded.value.repo.config.runner_version;
  } catch (e) {
    await cleanup().catch(() => {});
    throw e;
  }

  /** A new branch through a REST `createRef`: the `reconcile` step only ever pushes a new branch. */
  const pushed: Forge = {
    ...inner,
    pushBranch: async (lease, opts: CallOpts) => {
      if (lease.expected_sha !== null) return forgeErr("rejected", `live gates push: ${lease.branch} must be a new branch`);
      const r = await api(LIVE_CREATE_REF, "/git/refs", { ref: `refs/heads/${lease.branch}`, sha: lease.sha }, opts.signal);
      return r.ok ? forgeOk({ sha: lease.sha }) : r;
    },
  };
  const alerts: string[] = [];
  const forge = gatesForge(recordAlerts(prefixed(pushed, prefix, touched), alerts), {});
  const ids = identities(LIVE_LOGIN, crypto.randomUUID());
  const commits: ReconcileCommitRequest[] = [];
  const shaOf = (body: unknown, what: string): string => {
    const sha = (body as { sha?: unknown } | null)?.sha;
    if (typeof sha !== "string") throw new Error(`${what}: no sha`);
    return sha;
  };
  const committer: ReconcileCommitter = {
    async commit(r) {
      commits.push(r);
      try {
        const base = await api(LIVE_GET_COMMIT, `/git/commits/${r.ontoSha}`, undefined, r.signal);
        if (!base.ok) return err("transient", `${LIVE_GET_COMMIT.name}: ${base.error.kind}: ${base.error.message}`);
        const baseTree = (base.value.body as { tree?: { sha?: unknown } } | null)?.tree?.sha;
        if (typeof baseTree !== "string") return err("transient", `${r.ontoSha} has no tree`);
        const entries = Object.entries(r.files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content }));
        const tree = await api(LIVE_CREATE_TREE, "/git/trees", { base_tree: baseTree, tree: entries }, r.signal);
        if (!tree.ok) return err("transient", `${LIVE_CREATE_TREE.name}: ${tree.error.kind}: ${tree.error.message}`);
        const made = await api(LIVE_CREATE_COMMIT, "/git/commits", { message: r.message, tree: shaOf(tree.value.body, "createTree"), parents: [r.ontoSha] }, r.signal);
        if (!made.ok) return err("transient", `${LIVE_CREATE_COMMIT.name}: ${made.error.kind}: ${made.error.message}`);
        return ok({ head_sha: shaOf(made.value.body, "createCommit"), base_sha: r.ontoSha });
      } catch (e) {
        return err("transient", `live gates commit: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };

  return {
    kind: "live",
    repo: slug,
    login: LIVE_LOGIN,
    runnerVersion,
    repoUrl: `https://github.com/${slug}`,
    forge,
    coordinator: ids.coordinator,
    builders: ids.builders,
    commits,
    committer,
    alerts,
    now: async () => must(await inner.snapshot({ signal: callSignal() }), "snapshot").now,
    maintainerComment: async (issue, body, after) => {
      console.error(`live gates: comment ${JSON.stringify(body)} on ${issue.url} within 15 minutes`);
      return findComment(forge, issue.number, after, LIVE_LOGIN, body, Date.now() + COMMENT_WAIT_MS, COMMENT_POLL_MS);
    },
    untilReconcileDue: async () => {
      const deadline = Date.now() + DUE_WAIT_MS;
      for (;;) {
        const snap = must(await forge.snapshot({ signal: callSignal(), read: readsPath }), "snapshot");
        const due = reconcileDue(assembleAs(slug, snap, ids.coordinator, "coordinator"));
        if (due.due) return;
        if (Date.now() > deadline) throw new Error(`reconcile is still not due after ${DUE_WAIT_MS / MIN_MS} min: ${due.why}`);
        await Bun.sleep(DUE_POLL_MS);
      }
    },
    clock: null,
    laneDir,
    hostStop: join(root, "STOP"),
    cleanup,
  };
}

// ------------------------------------------------------------ the ledger seed and the coordinator round

/** The ledger's records and `coordinator.json` at its tip. */
export async function ledgerOf(forge: Forge): Promise<{ readonly units: ReadonlyMap<string, UnitRecord>; readonly coordinator: CoordinatorRecord | null }> {
  const snap = must(await forge.snapshot({ signal: callSignal() }), "snapshot");
  const parsed = parseLedger(snap.ledger.files);
  if (!parsed.ok) throw new Error(`ledger: ${parsed.error.message}`);
  return { units: parsed.value.units, coordinator: parsed.value.coordinator };
}

/**
 * One ledger swap from the tip: `coordinator.json` (`schema_version: 2`)
 * claimed by the area's coordinator at generation 1, `digest_posted_at` the
 * forge's `now` (so no mention is posted) and `rulings_cursor` the cursor
 * `readRulings(null)` returns (so older comments are never judged), plus
 * `records`.
 */
export async function seedLedger(area: GatesArea, records: readonly UnitRecord[] = []): Promise<CoordinatorRecord> {
  const snap = must(await area.forge.snapshot({ signal: callSignal() }), "seed snapshot");
  const read = must(await area.forge.readRulings(null, { signal: callSignal() }), "seed readRulings");
  const c = area.coordinator;
  const record: CoordinatorRecord = {
    schema_version: 2,
    owner: c.owner,
    host: c.host,
    lane: "coordinator",
    generation: 1,
    heartbeat_at: snap.now,
    digest_posted_at: snap.now,
    rulings_cursor: read.cursor,
  };
  const writes: Record<string, string> = { [COORDINATOR_PATH]: serializeCoordinator(record) };
  for (const r of records) writes[unitPath(r.unit)] = serializeUnitRecord(r);
  must(await area.forge.ledgerSwap(snap.ledger.tip, { message: "ledger: seed parallel-epics [skip ci]", writes, deletes: [] }, { signal: callSignal() }), "seed swap");
  return record;
}

export type CoordinatorRound = {
  readonly result: LaneProcessResult;
  /** How often the agent's `launchSpec` was called: no session is expected. */
  readonly launches: number;
  /** The commit requests this round made. */
  readonly commits: readonly ReconcileCommitRequest[];
  /** The enqueues this round held. */
  readonly held: readonly HeldEnqueue[];
};

const AGENT_BASE = { vendor: "claude", defaultModel: "claude-opus-5-5", minVersion: "0.0.0" };

/**
 * One run of the real coordinator process with the real `reconcile` step,
 * claimed as `coordinator.json` holds it: an agent that refuses every
 * session, an unchanged graph, the head passed gate, keepers that never beat
 * within the round, and a waiter that returns at once.
 */
export async function coordinatorRound(area: GatesArea): Promise<CoordinatorRound> {
  const { coordinator: claimRecord } = await ledgerOf(area.forge);
  if (claimRecord === null) throw new Error("coordinatorRound: no coordinator.json on the ledger (seedLedger first)");
  let launches = 0;
  const agent = {
    ...AGENT_BASE,
    launchSpec: () => {
      launches += 1;
      return err("invalid", "no sessions in the gates verification");
    },
    parseUsage: () => ({}),
  } as unknown as Agent;
  const commitsBefore = area.commits.length;
  const heldBefore = area.forge.held.length;
  const lane: Lane = { repo: area.repo, role: "coordinator", owner: area.login, agent: "claude", effort: "high" };
  const clock = area.clock;
  const result = await runCoordinatorProcess({
    forge: area.forge,
    agent,
    store: createFsLaneStore({ laneDir: area.laneDir, hostStop: area.hostStop }),
    laneDir: area.laneDir,
    identity: area.coordinator,
    lane,
    claim: claimRecord,
    steps: {
      reconcile: createReconcileStep({
        forge: area.forge,
        committer: area.committer,
        graphTrees: unchangedGraph(),
        identity: area.coordinator,
        repo: area.repo,
        agent: "claude",
        passed: headPassedGate,
        ...(clock !== null ? { now: clock.now, sleep: async (ms: number) => clock.sleep(ms), random: () => 0 } : {}),
      }),
    },
    pid: process.pid,
    ...(clock !== null ? { now: clock.now, sleep: async () => {}, random: () => 0 } : {}),
    heartbeat: {
      sleep: async (_ms, signal) => new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true }))),
    },
    waiter: { wait: async () => ({ end: "elapsed" as const }) },
  });
  return { result, launches, commits: area.commits.slice(commitsBefore), held: area.forge.held.slice(heldBefore) };
}

/** The Maintainer's inbox: the lowest-numbered open inbox issue assigned to them (logins compared case-insensitively). */
export async function maintainerInbox(area: GatesArea): Promise<InboxIssue | null> {
  const listed = must(await area.forge.inboxes({ signal: callSignal() }), "inboxes");
  return [...listed].sort((a, b) => a.number - b.number).find((i) => i.owner !== null && i.owner.toLowerCase() === area.login.toLowerCase()) ?? null;
}

// ------------------------------------------------------------ the digest

/** One item the Maintainer's digest must list: its label, link and age (`null` when nothing dates it). */
export type ExpectedItem = { readonly label: string; readonly url: string; readonly age: string | null };

/** Whole days from `since` to `now`, `<1d` under one: computed here, not by `render-digest.ts`. */
export function wholeDays(now: string, since: string): string {
  const days = Math.floor((Date.parse(now) - Date.parse(since)) / DAY_MS);
  return days >= 1 ? `${days}d` : "<1d";
}

const OPEN_STATUSES: readonly string[] = ["open", "in-progress", "waiting"];

/**
 * The items the Maintainer's digest must list for `world` and the ledger's
 * `records` at `now`, computed independently of `renderDigest`: the
 * checkpoints whose retro is done with no go (a bootstrapped one undated),
 * the rejected retros with no go, the open Maintainer-routed items (aged
 * from their Epic's retro), the parked records in the Maintainer's inbox
 * (linked to their ledger file, aged from their heartbeat), and each spec's
 * deferred entries (aged from its `created`).
 */
export function expectedDigest(world: GatesWorldOptions, records: readonly UnitRecord[], now: string, repoUrl: string): ExpectedItem[] {
  const login = (world.login ?? FAKE_LOGIN).toLowerCase();
  const gatesUrl = `${repoUrl}/blob/main/${GATES_PATH}`;
  const retros = world.retros ?? {};
  const recorded = (n: number): string | null => (retros[n] === undefined ? null : (world.recordedAt?.[n] ?? DEFAULT_RECORDED_AT));
  const items: ExpectedItem[] = [];
  const checkpoints = [...(world.epic8Go === false ? [8] : []), ...(world.checkpoint ?? []).filter((n) => !(world.checkpointGo ?? []).includes(n))];
  for (const n of checkpoints) {
    const at = recorded(n);
    if (at === null && !BOOTSTRAPPED.includes(n)) continue;
    items.push({ label: `checkpoint:${n}`, url: gatesUrl, age: at === null ? null : wholeDays(now, at) });
  }
  for (const [key, verdict] of Object.entries(retros)) {
    const n = Number(key);
    if (verdict !== "rejected" || (world.retroGo ?? []).includes(n)) continue;
    items.push({ label: `retro:${n}`, url: gatesUrl, age: wholeDays(now, recorded(n) as string) });
  }
  for (const i of world.items ?? []) {
    if ((i.route ?? "lane") !== "maintainer" || !OPEN_STATUSES.includes(i.status ?? "open")) continue;
    const at = recorded(i.epic);
    items.push({ label: `retro-item:${itemId(i.epic, i.seq, i.slug)}`, url: gatesUrl, age: at === null ? null : wholeDays(now, at) });
  }
  for (const r of records) {
    const p = r.park;
    if (r.state !== "parked" || p === null) continue;
    const mine = p.kind === "needs-approval" || (p.kind === "blocked" && p.reason === "human-live-step") || p.inbox_owner.toLowerCase() === login;
    if (!mine) continue;
    const url = r.pr !== null ? `${repoUrl}/pull/${r.pr}` : `${repoUrl}/blob/${INBOX_LEDGER_BRANCH}/units/${r.unit.replace(":", "__")}.json`;
    items.push({ label: r.unit, url, age: wholeDays(now, r.heartbeat_at) });
  }
  for (const s of world.specs ?? []) {
    s.deferred.forEach((_d, i) => {
      items.push({ label: `${s.epic}.${s.story}-d${i + 1}`, url: `${repoUrl}/blob/main/${specPath(s.epic, s.story, s.slug)}`, age: wholeDays(now, s.created) });
    });
  }
  return items;
}

const DIGEST_HEADER = /^🤖 Xarabot inbox: (\d+) items? waits? on you\.$/;

/**
 * Every way `body` breaks the digest of `expected` (pure); `[]` when it
 * holds: the header's count is the number of expected items; each expected
 * item has exactly one line starting `- [<label>](<url>) · `, holding
 * ` · <age>` when it has an age; and no other line starts `- [`.
 */
export function digestProblems(body: string, expected: readonly ExpectedItem[]): string[] {
  const problems: string[] = [];
  const lines = body.split("\n");
  const head = DIGEST_HEADER.exec(lines[0] ?? "");
  if (head === null) problems.push(`the first line is not the digest header: ${JSON.stringify(lines[0] ?? "")}`);
  else if (Number(head[1]) !== expected.length) problems.push(`the header counts ${head[1]} items, not ${expected.length}`);
  const claimed = new Set<number>();
  for (const e of expected) {
    const start = `- [${e.label}](${e.url}) · `;
    const at = lines.flatMap((l, i) => (l.startsWith(start) ? [i] : []));
    if (at.length !== 1) {
      problems.push(`${e.label}: ${at.length} lines start ${JSON.stringify(start)}, not 1`);
      continue;
    }
    const i = at[0] as number;
    claimed.add(i);
    const parts = (lines[i] as string).split(" · ");
    if (e.age !== null && !parts.slice(1).includes(e.age)) problems.push(`${e.label}: its line does not hold the age ${e.age}: ${JSON.stringify(lines[i])}`);
  }
  lines.forEach((l, i) => {
    if (l.startsWith("- [") && !claimed.has(i)) problems.push(`an unexpected item line: ${JSON.stringify(l)}`);
  });
  return problems;
}

/** `<n>` days and 6 hours before `now`: whole-day ages stay the same for 6 hours of wall time. */
export function daysBefore(now: string, n: number): string {
  return new Date(Date.parse(now) - n * DAY_MS - 6 * 60 * MIN_MS).toISOString();
}

/** The digest case's text for `story:14.1`'s block. */
export const INTENT_GAP_TEXT = "The manifest names packages/tooling, but the Epic context says tooling ships later.";

/**
 * The digest case at `now`: P2 with Epic 9 `rejected` (no go) and a
 * `waiting` Maintainer item; Epic 10 `accepted-with-open-items`, a
 * checkpoint with no go, and an `open` blocking Maintainer item; parked
 * `story:14.1` (blocked `intent-gap`, with text), `story:11.1`
 * (`needs-approval`) and `story:12.1` (blocked `human-live-step`); and
 * `spec-9-1-runtime.md` with one deferred entry. Each item is dated a whole
 * number of days and 6 hours before `now`.
 */
export function digestCase(area: Pick<GatesArea, "repo" | "login" | "runnerVersion" | "builders">, now: string): { readonly world: GatesWorldOptions; readonly records: UnitRecord[] } {
  const world: GatesWorldOptions = {
    repo: area.repo,
    login: area.login,
    runnerVersion: area.runnerVersion,
    done: [9, 10],
    retros: { 9: "rejected", 10: "accepted-with-open-items" },
    recordedAt: { 9: daysBefore(now, 5), 10: daysBefore(now, 3) },
    checkpoint: [10],
    items: [
      { epic: 9, seq: 1, slug: "pin-the-runtime-api", route: "maintainer", blocking: false, status: "waiting" },
      { epic: 10, seq: 1, slug: "freeze-the-contracts", route: "maintainer", blocking: true, status: "open" },
    ],
    specs: [{ epic: 9, story: 1, slug: "runtime", created: daysBefore(now, 6), deferred: ["Benchmark the runtime boot path."] }],
  };
  const b = area.builders(4);
  const holder = b[0] as LaneIdentity;
  const parked = (epic: number, at: string, park: NonNullable<UnitRecord["park"]>): UnitRecord => ({
    schema_version: 6,
    unit: storyUnit(epic, 1),
    state: "parked",
    owner: holder.owner,
    host: holder.host,
    lane: holder.lane,
    generation: 1,
    globs: [globOf(epic)],
    heartbeat_at: at,
    pr: null,
    pr_owner: null,
    base_sha: null,
    head_sha: null,
    reviewed_sha: null,
    passed_sha: null,
    enqueued_sha: null,
    approved_sha: null,
    approved_graph: null,
    retro_result: null,
    builder_providers: [],
    park,
    attempts: 0,
    loopbacks: 0,
    ci_fixes: 0,
    approval: null,
  });
  const records = [
    parked(14, daysBefore(now, 2), { kind: "blocked", reason: "intent-gap", inbox_owner: area.login, globs_held: [], text: INTENT_GAP_TEXT }),
    parked(11, daysBefore(now, 0), { kind: "needs-approval", reason: null, inbox_owner: area.login, globs_held: [] }),
    parked(12, daysBefore(now, 4), { kind: "blocked", reason: "human-live-step", inbox_owner: area.login, globs_held: [] }),
  ];
  return { world, records };
}

export type DigestRun = {
  readonly problems: string[];
  readonly body: string;
  readonly issue: number | null;
  readonly expected: readonly ExpectedItem[];
  readonly round: CoordinatorRound;
};

/** A problem naming the alerts recorded since `from`, or none. */
function alertProblems(area: GatesArea, from: number): string[] {
  const recorded = area.alerts.slice(from);
  return recorded.length === 0 ? [] : [`${recorded.length} alert(s) were recorded during the case: ${recorded.join("; ")}`];
}

/** The digest case on `area`: the world and the records seeded, one coordinator round, then the Maintainer's inbox body checked. */
export async function runDigestCase(area: GatesArea): Promise<DigestRun> {
  const alertsFrom = area.alerts.length;
  const now = await step("the forge's time", () => area.now());
  const { world, records } = digestCase(area, now);
  area.forge.setWorld(gatesWorld(world));
  await step("the ledger seed", () => seedLedger(area, records));
  const round = await step("the coordinator round", () => coordinatorRound(area));
  const issue = await step("the Maintainer's inbox", () => maintainerInbox(area));
  const body = issue?.body ?? "";
  const expected = expectedDigest(world, records, now, area.repoUrl);
  const problems = issue === null ? [`no open inbox issue is assigned to ${area.login}`] : digestProblems(body, expected);
  if (round.result.outcome !== "progress") problems.push(`the coordinator round ended ${round.result.outcome}, not progress`);
  if (round.launches !== 0) problems.push(`the agent was asked for ${round.launches} session(s), not 0`);
  if (round.commits.length !== 0) problems.push(`the coordinator round committed ${round.commits.length} time(s): it had nothing to write, so no PR`);
  if (round.held.length !== 0) problems.push(`the coordinator round enqueued ${round.held.length} PR(s): it had nothing to write, so no PR`);
  problems.push(...alertProblems(area, alertsFrom));
  return { problems, body, issue: issue?.number ?? null, expected, round };
}

// ------------------------------------------------------------ the checkpoint go

export const GO_CHECKPOINT_10 = "/xarabot go checkpoint:10";

/** What the checkpoint case observed, for `checkpointProblems`. */
export type CheckpointObserved = {
  readonly login: string;
  /** The units builders claimed before the go. */
  readonly claimedBefore: readonly string[];
  /** The Maintainer's inbox body after round 1. */
  readonly inboxBefore: string;
  /** The Maintainer's comment as `readRulings` read it. */
  readonly comment: { readonly id: string; readonly created_at: string };
  /** `coordinator.json`'s pending rulings after round 2. */
  readonly pending: readonly PendingRuling[];
  /** The inbox comments posted after the Maintainer's. */
  readonly replies: readonly string[];
  /** The PR of round 2's held enqueue, or `null`. */
  readonly pr: number | null;
  /** The `retro-gates.yaml` text round 2 committed, or `null`. */
  readonly committedGates: string | null;
  /** The Maintainer's inbox body after round 2. */
  readonly inboxAfter: string;
  /** The units builders claimed after the simulated merge. */
  readonly claimedAfter: readonly string[];
};

const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Every way the checkpoint case breaks AC 4 (pure); `[]` when it holds.
 * Before the go only `story:14.1` was claimed and round 1's inbox lists
 * `checkpoint:10`. After the Maintainer's comment, `coordinator.json` holds
 * exactly the pending go `{go, checkpoint:10, by: login, at: the comment's
 * created_at, ruling: its id}`; one `🤖 Ruling acknowledged:` reply from the
 * login is posted; the PR is opened and its committed `retro-gates.yaml`
 * sets `epics.10.checkpoint.go` to that go; the inbox is `EMPTY_INBOX_BODY`;
 * and after the simulated merge builders claim 11.1, 12.1 and 13.1.
 */
export function checkpointProblems(o: CheckpointObserved): string[] {
  const problems: string[] = [];
  if (o.claimedBefore.length !== 1 || o.claimedBefore[0] !== "story:14.1") problems.push(`before the go, builders claimed ${JSON.stringify(o.claimedBefore)}, not only story:14.1`);
  if (!o.inboxBefore.split("\n").some((l) => l.startsWith("- [checkpoint:10]("))) problems.push("round 1's inbox does not list checkpoint:10");

  const goes = o.pending.filter((p) => p.unit === "checkpoint:10");
  const p = goes[0];
  if (o.pending.length !== 1 || p === undefined) problems.push(`coordinator.json holds ${o.pending.length} pending ruling(s), not exactly the go of checkpoint:10`);
  if (p !== undefined) {
    if (p.verb !== "go") problems.push(`the pending ruling's verb is ${p.verb}, not go`);
    if (!sameLogin(p.by, o.login)) problems.push(`the pending go is by ${p.by}, not ${o.login}`);
    if (p.at !== o.comment.created_at) problems.push(`the pending go is at ${p.at}, not the comment's created_at ${o.comment.created_at}`);
    if (p.ruling !== o.comment.id) problems.push(`the pending go's ruling is ${p.ruling}, not the comment's id ${o.comment.id}`);
  }

  const ack = `🤖 Ruling acknowledged: \`${GO_CHECKPOINT_10}\` from ${o.login}`.toLowerCase();
  const acks = o.replies.filter((r) => r.toLowerCase().startsWith(ack));
  if (acks.length !== 1) problems.push(`${acks.length} replies start ${JSON.stringify(ack)}, not 1`);

  if (o.pr === null) problems.push("round 2 opened and enqueued no PR");
  if (o.committedGates === null) problems.push("round 2 committed no retro-gates.yaml");
  else {
    const parsed = parseRetroGates(GATES_PATH, o.committedGates);
    if (!parsed.ok) problems.push(`the committed retro-gates.yaml does not parse: ${parsed.error.message}`);
    else {
      const go = parsed.value.epics["10"]?.checkpoint?.go;
      if (go === undefined) problems.push("the committed retro-gates.yaml sets no epics.10.checkpoint.go");
      else if (!sameLogin(go.by, o.login) || go.at !== o.comment.created_at || go.ruling !== o.comment.id) {
        problems.push(`the committed epics.10.checkpoint.go is ${JSON.stringify(go)}, not by ${o.login} at ${o.comment.created_at} with ruling ${o.comment.id}`);
      }
    }
  }
  if (o.inboxAfter !== EMPTY_INBOX_BODY) problems.push(`the inbox after the go is not empty: ${JSON.stringify(o.inboxAfter.slice(0, 300))}`);
  for (const u of ["story:11.1", "story:12.1", "story:13.1"]) if (!o.claimedAfter.includes(u)) problems.push(`after the simulated merge, ${u} was not claimed`);
  return problems;
}

export type CheckpointRun = {
  readonly problems: string[];
  readonly observed: CheckpointObserved;
  readonly issue: number | null;
  readonly before: readonly BuilderOutcome[];
  readonly after: readonly BuilderOutcome[];
  readonly rounds: readonly CoordinatorRound[];
};

/** The checkpoint case's world: P2 plus checkpoint 10 with no go. */
export function checkpointWorld(area: Pick<GatesArea, "repo" | "login" | "runnerVersion">): GatesWorldOptions {
  return { repo: area.repo, login: area.login, runnerVersion: area.runnerVersion, done: [9, 10], retros: { 9: "accepted", 10: "accepted" }, checkpoint: [10] };
}

/**
 * The checkpoint go (AC 4) on `area`: builders claim, then coordinator round
 * 1 lists `checkpoint:10`; the Maintainer comments `/xarabot go
 * checkpoint:10` on the inbox issue; once `reconcile` is due again, round 2
 * rules it, acknowledges it, empties the inbox and opens its PR (enqueue
 * held); its committed `retro-gates.yaml` is laid over `main`, and builders
 * claim again.
 */
export async function runCheckpointCase(area: GatesArea): Promise<CheckpointRun> {
  const alertsFrom = area.alerts.length;
  const world = checkpointWorld(area);
  area.forge.setWorld(gatesWorld(world));
  await step("the ledger seed", () => seedLedger(area));
  const builders = area.builders(4);
  const before = await step("builders before the go", () => builderRound(area.forge, area.repo, builders));
  const r1 = await step("coordinator round 1", () => coordinatorRound(area));
  const issue1 = await step("round 1's inbox", async () => {
    const i = await maintainerInbox(area);
    if (i === null) throw new Error(`round 1 left no open inbox issue assigned to ${area.login}`);
    return i;
  });
  const cursor = (await ledgerOf(area.forge)).coordinator?.rulings_cursor ?? null;
  const comment = await step("the Maintainer's comment", () => area.maintainerComment(issue1, GO_CHECKPOINT_10, cursor));
  await step("reconcile due again", () => area.untilReconcileDue());
  const r2 = await step("coordinator round 2", () => coordinatorRound(area));
  const { replies, pending, inboxAfter } = await step("what round 2 left", async () => {
    // A cursor is opaque (the GitHub adapter's is `<created_at>|<id>`), so read from the one before the comment and keep what follows it.
    const read = must(await area.forge.readRulings(cursor, { signal: callSignal() }), "readRulings after round 2");
    const at = read.comments.findIndex((c) => c.id === comment.id);
    if (at === -1) throw new Error(`the Maintainer's comment ${comment.id} is no longer read after the cursor`);
    const ledger = await ledgerOf(area.forge);
    const inbox = await maintainerInbox(area);
    return { replies: read.comments.slice(at + 1).map((c) => c.body), pending: ledger.coordinator?.pending_rulings ?? [], inboxAfter: inbox?.body ?? "" };
  });
  const committedGates = r2.commits.map((c) => c.files[GATES_PATH]).find((t) => t !== undefined) ?? null;
  if (committedGates !== null) area.forge.setWorld({ ...area.forge.world, [GATES_PATH]: committedGates });
  const after = await step("builders after the simulated merge", () => builderRound(area.forge, area.repo, builders));
  const observed: CheckpointObserved = {
    login: area.login,
    claimedBefore: claimedUnits(before),
    inboxBefore: issue1.body,
    comment: { id: comment.id, created_at: comment.created_at },
    pending,
    replies,
    pr: r2.held[0]?.pr ?? null,
    committedGates,
    inboxAfter,
    claimedAfter: claimedUnits(after),
  };
  const problems = checkpointProblems(observed);
  for (const [i, r] of [r1, r2].entries()) {
    if (r.result.outcome !== "progress") problems.push(`coordinator round ${i + 1} ended ${r.result.outcome}, not progress`);
    if (r.launches !== 0) problems.push(`coordinator round ${i + 1} asked the agent for ${r.launches} session(s), not 0`);
  }
  if (r1.commits.length !== 0) problems.push(`coordinator round 1 committed ${r1.commits.length} time(s): it had nothing to write`);
  const r2Files = r2.commits.map((c) => Object.keys(c.files));
  if (r2Files.length !== 1 || JSON.stringify(r2Files[0]) !== JSON.stringify([GATES_PATH])) {
    problems.push(`coordinator round 2 committed ${JSON.stringify(r2Files)}, not exactly one commit of only ${GATES_PATH}`);
  }
  if (r2.held.length !== 1) problems.push(`coordinator round 2 held ${r2.held.length} enqueue(s), not 1`);
  problems.push(...alertProblems(area, alertsFrom));
  return { problems, observed, issue: issue1.number, before, after, rounds: [r1, r2] };
}
