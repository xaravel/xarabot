import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppCredentials } from "../../src/adapters/forge/github/credentials.ts";
import { fetchBotUserId } from "../../src/adapters/forge/github/bot-user.ts";
import { createGitHubFetch } from "../../src/adapters/forge/github/fetch-shas.ts";
import { createGitHubForge } from "../../src/adapters/forge/github/github-forge.ts";
import { GITHUB_OPERATIONS, isSuccess, request, type Operation } from "../../src/adapters/forge/github/http.ts";
import { createTokenSource } from "../../src/adapters/forge/github/tokens.ts";
import { createFakeForge, gitBlobSha } from "../../src/adapters/forge/fake/fake-forge.ts";
import { laneDirFor } from "../../src/cli/host-paths.ts";
import type { Connect } from "../../src/cli/lane-connection.ts";
import { laneRun, type LaneRunDeps } from "../../src/cli/lane-run.ts";
import { loadRepoConfig } from "../../src/core/config/load-repo-config.ts";
import { runnerFileText } from "../../src/core/lane/runner.ts";
import { parseLedger } from "../../src/core/ledger/codec.ts";
import { isStale, STALE_AFTER_MS } from "../../src/core/ledger/edits.ts";
import { next, type NextStory } from "../../src/core/next/next.ts";
import { assembleSnapshot } from "../../src/core/next/snapshot.ts";
import { ok } from "../../src/core/result.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { LaneIdentity, UnitRecord } from "../../src/core/schemas/ledger.ts";
import type { BuildResult } from "../../src/core/schemas/session-result.ts";
import type { Committer } from "../../src/lane/committer.ts";
import { readsPath, runLaneProcess, type LaneDeps, type PrStepOutput } from "../../src/lane/lane-process.ts";
import { createPrStep } from "../../src/lane/pr-step.ts";
import type { Waiter } from "../../src/lane/wait.ts";
import type { Workspace } from "../../src/lane/workspace.ts";
import { forgeOk, type Forge, type ForgeResult, type ForgeSnapshot, type GitSha } from "../../src/ports/forge.ts";
import type { Sandbox } from "../../src/ports/sandbox.ts";
import { cleanupScratch, LIVE_LOGIN, liveCredentials, liveRepo, prefixed, type RawCall } from "../support/live-github.ts";
import { scratchSeed } from "./scratch-seed.ts";
import { STUB_VERSION } from "./stub-claude.ts";

/**
 * The claims race harness (Story 2.12, FR3). Real `laneRun` lanes, with only
 * their forge connection, the CLI version probe and the session swapped:
 * each lane's `start` is the real `runLaneProcess` (claim loop, heartbeat
 * keeper, fencing) with a holding stub sandbox and workspace and a waiter
 * that returns at once. The holding session writes `<control>/<tag>.session`
 * (its unit) when it starts, then waits for `<control>/<tag>.release` or its
 * signal, and ends with exit 1 and no result: a failed attempt.
 *
 * An area is where the lanes race: the fake forge (`fakeArea`, the
 * rehearsals every `bun test` runs) or a fresh ledger branch on the scratch
 * repo with prefixed unit branches (`liveArea`). Each lane reads the area's
 * real `main` with its own Story set overlaid (`withMain`), records its
 * alerts instead of posting them, and may hold its first ledger swap at a
 * barrier (`swapRace`) so two lanes swap from the same tip.
 */

export const RACE_LANE = "builder-1";

const MANIFESTS_DIR = "stories/";
const EPICS_PATH = "_bmad-output/planning-artifacts/epics.md";
const STATUS_PATH = "_bmad-output/implementation-artifacts/sprint-status.yaml";

// ------------------------------------------------------------ the Story sets

export type RaceStory = { readonly id: string; readonly key: string; readonly glob: string };

/** The race Stories: 1.1 and 1.2 overlap; 1.3 overlaps neither. */
export const RACE_STORIES: readonly RaceStory[] = [
  { id: "1.1", key: "1-1-race-shared", glob: "race/shared/**" },
  { id: "1.2", key: "1-2-race-shared-b", glob: "race/shared/b/**" },
  { id: "1.3", key: "1-3-race-other", glob: "race/other/**" },
];

/** A lane's Story set: the ids of the race Stories its `main` holds. */
export type RaceView = readonly string[];

function raceStory(id: string): RaceStory {
  const s = RACE_STORIES.find((x) => x.id === id);
  if (s === undefined) throw new Error(`race: no race Story ${id}`);
  return s;
}

/** The overlay for `view`: `epics.md`, `sprint-status.yaml` and one manifest per Story, every Story `backlog`. */
export function raceStories(view: RaceView): Record<string, string> {
  const stories = view.map(raceStory);
  const epics = ["# Epics", "", "## Epic 1: Race", ""];
  const status = ["development_status:", "  epic-1: in-progress"];
  const files: Record<string, string> = {};
  for (const s of stories) {
    epics.push(`### Story ${s.id}: Race ${s.id}`, "", `A race Story on \`${s.glob}\`.`, "");
    status.push(`  ${s.key}: backlog`);
    files[`${MANIFESTS_DIR}${s.id}.md`] = ["---", `story_id: "${s.id}"`, "epic: 1", `sprint_key: ${s.key}`, `title: Race ${s.id}`, `globs: ["${s.glob}"]`, "---", ""].join("\n");
  }
  files[EPICS_PATH] = `${epics.join("\n")}\n`;
  files[STATUS_PATH] = `${status.join("\n")}\n`;
  return files;
}

/** Whether the overlay replaces `path` of the real `main`. */
function overlaid(path: string): boolean {
  return path.startsWith(MANIFESTS_DIR) || path === EPICS_PATH || path === STATUS_PATH;
}

/** `main` with `stories/**`, `epics.md` and `sprint-status.yaml` replaced by `files`; blob SHAs from `gitBlobSha`. */
export function overlayMain(main: ForgeSnapshot["main"], files: Readonly<Record<string, string>>, read: (path: string) => boolean): ForgeSnapshot["main"] {
  const keep = main.tree.filter((p) => !overlaid(p) && !Object.hasOwn(files, p));
  const tree = [...keep, ...Object.keys(files)].sort();
  const texts: Record<string, string> = {};
  const blobShas: Record<string, string> = {};
  for (const p of keep) {
    const text = main.files[p];
    if (text !== undefined) texts[p] = text;
    const sha = main.blob_shas[p];
    if (sha !== undefined) blobShas[p] = sha;
  }
  for (const [p, text] of Object.entries(files)) {
    blobShas[p] = gitBlobSha(text);
    if (read(p)) texts[p] = text;
  }
  return { sha: main.sha, tree, files: texts, blob_shas: blobShas };
}

// ------------------------------------------------------------ forge wrappers

/** `forge`, whose snapshots show `main` with `view`'s Stories overlaid. */
export function withMain(forge: Forge, view: RaceView): Forge {
  const files = raceStories(view);
  return {
    ...forge,
    snapshot: async (opts) => {
      const r = await forge.snapshot(opts);
      if (!r.ok) return r;
      return forgeOk({ ...r.value, main: overlayMain(r.value.main, files, opts.read ?? (() => false)) });
    },
  };
}

/** `forge`, whose alerts go to `sink` (`<condition> @ <main sha>`) instead of the forge. */
export function recordAlerts(forge: Forge, sink: string[]): Forge {
  return {
    ...forge,
    alert: async (condition, mainSha) => {
      sink.push(`${condition} @ ${mainSha}`);
      return forgeOk({ posted: true });
    },
  };
}

/**
 * One racing lane's first ledger swap: its old tip, its result (`ok` or the
 * error kind), and what let it through: every lane reaching the barrier, or
 * the timeout.
 */
export type SwapRecord = { readonly tag: string; readonly oldTip: GitSha; readonly result: string; readonly released: "barrier" | "timeout" };

export type SwapRace = {
  /** The first swaps, in the order they returned. */
  readonly swaps: SwapRecord[];
  /** `forge` for lane `tag`: its first `ledgerSwap` waits at the barrier. */
  wrap(forge: Forge, tag: string): Forge;
};

/**
 * A swap barrier: each lane in `tags` holds its first `ledgerSwap` until
 * every lane has reached its own, or `waitMs` pass. Later swaps go straight
 * through.
 */
export function swapRace(tags: readonly string[], waitMs = 60_000): SwapRace {
  const arrived = new Set<string>();
  const swaps: SwapRecord[] = [];
  let open: () => void = () => {};
  const all = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    swaps,
    wrap: (forge, tag) => ({
      ...forge,
      ledgerSwap: async (oldSha, commit, opts) => {
        if (arrived.has(tag)) return forge.ledgerSwap(oldSha, commit, opts);
        arrived.add(tag);
        if (tags.every((t) => arrived.has(t))) open();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const released = await Promise.race([
          all.then(() => "barrier" as const),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), waitMs);
          }),
        ]);
        clearTimeout(timer);
        const r = await forge.ledgerSwap(oldSha, commit, opts);
        swaps.push({ tag, oldTip: oldSha, result: r.ok ? "ok" : r.error.kind, released });
        return r;
      },
    }),
  };
}

// ------------------------------------------------------------ hosts and lanes

/** One host: its own `HOME` and `XDG_CONFIG_HOME`, `host.yaml` with one lane, a dummy credential and the `runner` file. */
export type RaceHost = {
  readonly root: string;
  readonly home: string;
  readonly xdg: string;
  readonly env: Record<string, string>;
  readonly hostId: string;
  readonly repo: string;
  readonly owner: string;
  readonly laneDir: string;
};

export type HostParams = { readonly repo: string; readonly owner: string; readonly runnerVersion: string };

/** Writes a host under `root` (created): a fresh `host_id`, lane `builder-1`, the dummy Claude credential, `runner` = `runnerVersion`. */
export function raceHost(root: string, p: HostParams): RaceHost {
  const home = join(root, "home");
  const xdg = join(root, "config");
  mkdirSync(home, { recursive: true });
  const hostId = crypto.randomUUID();
  const hostYaml = join(xdg, "xarabot", "host.yaml");
  mkdirSync(dirname(hostYaml), { recursive: true });
  writeFileSync(
    hostYaml,
    ["schema_version: 1", `host_id: ${hostId}`, "lanes:", `  ${RACE_LANE}:`, `    repo: ${p.repo}`, "    role: builder", `    owner: ${p.owner}`, "    agent: claude", ""].join("\n"),
  );
  const cred = join(xdg, "xarabot", "vendors", "claude", "oauth-token");
  mkdirSync(dirname(cred), { recursive: true });
  writeFileSync(cred, "sk-ant-oat-race-dummy\n");
  chmodSync(cred, 0o600);
  const lane: Lane = { repo: p.repo, role: "builder", owner: p.owner, agent: "claude", effort: "high" };
  const laneDir = laneDirFor(join(home, ".xarabot"), lane, RACE_LANE);
  mkdirSync(laneDir, { recursive: true });
  writeFileSync(join(laneDir, "runner"), runnerFileText(p.runnerVersion));
  const env = { HOME: home, XDG_CONFIG_HOME: xdg, PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8" };
  return { root, home, xdg, env, hostId, repo: p.repo, owner: p.owner, laneDir };
}

/** The identity a host's lane writes ledger records as. */
export function identityOf(host: RaceHost): LaneIdentity {
  return { owner: host.owner, host: host.hostId, lane: RACE_LANE };
}

export const sessionFile = (control: string, tag: string): string => join(control, `${tag}.session`);
export const releaseFile = (control: string, tag: string): string => join(control, `${tag}.release`);

/** The tags whose holding session has started, sorted. */
export function sessionTags(control: string): string[] {
  if (!existsSync(control)) return [];
  return readdirSync(control)
    .filter((f) => f.endsWith(".session"))
    .map((f) => f.slice(0, -".session".length))
    .sort();
}

/** The unit tag `tag`'s session was started on. */
export function sessionUnit(control: string, tag: string): string {
  return readFileSync(sessionFile(control, tag), "utf8").trim();
}

/** Lets tag `tag`'s holding session end. */
export function release(control: string, tag: string): void {
  mkdirSync(control, { recursive: true });
  writeFileSync(releaseFile(control, tag), "release\n");
}

const HOLD_POLL_MS = 100;

/**
 * The holding session for lane `tag`: a workspace that only makes the clone
 * folder, and a sandbox that writes `<control>/<tag>.session` (the unit),
 * waits for `<control>/<tag>.release` or its signal, and ends with exit 1
 * and no result.
 */
export function holdingSession(control: string, tag: string): { readonly sandbox: Sandbox; readonly workspace: Workspace } {
  let unit = "none";
  const workspace: Workspace = {
    async prepare(p) {
      unit = p.unit;
      return ok({ sha: p.start, resumed: false });
    },
  };
  const sandbox: Sandbox = {
    async run(_spec, profile, signal) {
      mkdirSync(profile.clone, { recursive: true });
      mkdirSync(control, { recursive: true });
      writeFileSync(sessionFile(control, tag), `${unit}\n`);
      const startedAt = Date.now();
      while (!signal.aborted && !existsSync(releaseFile(control, tag))) await Bun.sleep(HOLD_POLL_MS);
      const endedAt = Date.now();
      return ok({ pid: process.pid, exitCode: 1, signal: null, startedAt, endedAt, durationMs: endedAt - startedAt, stdout: "", stderr: "" });
    },
  };
  return { sandbox, workspace };
}

const AT_ONCE: Waiter = { wait: async () => ({ end: "elapsed" as const }) };

export type RaceLaneParams = {
  readonly host: RaceHost;
  readonly connect: Connect;
  readonly control: string;
  readonly tag: string;
  /** The heartbeat keeper's interval; default the lane's 5 min. */
  readonly heartbeatEveryMs?: number;
  /** `laneRun`'s lock owner and process table; default this process and `ps`. */
  readonly lock?: LaneRunDeps["lock"];
  readonly out?: (line: string) => void;
  readonly errOut?: (line: string) => void;
};

export type RaceLaneRun = { readonly code: number; readonly out: readonly string[]; readonly errOut: readonly string[] };

/** One real `laneRun` of the host's `builder-1`, its session the holding one. */
export async function runRaceLane(p: RaceLaneParams): Promise<RaceLaneRun> {
  const out: string[] = [];
  const errOut: string[] = [];
  const held = holdingSession(p.control, p.tag);
  const code = await laneRun([p.host.repo, RACE_LANE], {
    env: p.host.env,
    connect: p.connect,
    cliVersion: async () => ok(STUB_VERSION),
    start: (deps: LaneDeps) =>
      runLaneProcess({
        ...deps,
        sandbox: held.sandbox,
        workspace: held.workspace,
        waiter: AT_ONCE,
        ...(p.heartbeatEveryMs !== undefined ? { heartbeat: { everyMs: p.heartbeatEveryMs } } : {}),
      }),
    ...(p.lock !== undefined ? { lock: p.lock } : {}),
    out: (l) => {
      out.push(l);
      p.out?.(l);
    },
    errOut: (l) => {
      errOut.push(l);
      p.errOut?.(l);
    },
  });
  return { code, out, errOut };
}

/** Polls `cond` every 100 ms until it holds; throws naming `what` after `ms`. */
export async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await Bun.sleep(100);
  }
}

// ------------------------------------------------------------ the next Story of a view

/** The Story `next` gives a builder on `snap` (an overlaid snapshot), with `ledger` as the ledger files (default `snap`'s). */
export function storyFor(p: { readonly repo: string; readonly snap: ForgeSnapshot; readonly identity: LaneIdentity; readonly ledger?: Readonly<Record<string, string>> }): NextStory {
  const { snap } = p;
  const assembled = assembleSnapshot({
    repo: p.repo,
    now: snap.now,
    tree: [...snap.main.tree],
    files: { ...snap.main.files },
    main_sha: snap.main.sha,
    blob_shas: snap.main.blob_shas,
    ledger_tip: snap.ledger.tip,
    ledger_files: p.ledger ?? snap.ledger.files,
    prs: p.ledger === undefined ? snap.prs : {},
    escalations: null,
    lane: p.identity,
    role: "builder",
  });
  if (!assembled.ok) throw new Error(`storyFor: ${assembled.error.kind}: ${assembled.error.message}`);
  const picked = next(assembled.value, "builder");
  if (picked.kind !== "unit") throw new Error(`storyFor: next gave ${picked.kind}: ${"reason" in picked ? picked.reason : ""}`);
  return picked.story;
}

// ------------------------------------------------------------ areas

/** Where a lane's connection comes from, for a child lane process. */
export type AreaRef = { readonly kind: "fake" } | { readonly kind: "live"; readonly ledgerBranch: string; readonly prefix: string };

export type LaneConnectParams = {
  readonly view: RaceView;
  readonly alerts: string[];
  /** The swap barrier this lane races at, as `tag`. */
  readonly race?: SwapRace;
  readonly tag: string;
};

export type ReplayParams = {
  /** The killed lane's identity and its last record (generation g). */
  readonly identity: LaneIdentity;
  readonly record: UnitRecord;
  readonly view: RaceView;
};

export type Replayed = {
  readonly out: PrStepOutput;
  /** The Story branch's head after the replay; `null` when it does not exist. */
  readonly head: GitSha | null;
  readonly notes: readonly string[];
};

export type RaceArea = {
  readonly kind: "fake" | "live";
  readonly ref: AreaRef;
  readonly repo: string;
  readonly owner: string;
  readonly runnerVersion: string;
  /** A lane's connection: the area's forge, `view` overlaid, alerts recorded, the first swap at `race`'s barrier. */
  connect(p: LaneConnectParams): Connect;
  /** The area's forge with `view` overlaid and alerts recorded into `alerts`. */
  forge(view: RaceView, alerts: string[]): Forge;
  /** The ledger's unit records, by unit id. */
  records(): Promise<ReadonlyMap<string, UnitRecord>>;
  /** The ledger's commit messages, root first. */
  history(): Promise<readonly string[]>;
  /** The forge's time. */
  now(): Promise<string>;
  /** Returns once `record` is stale by the forge's time (the fake forge's clock is moved there). */
  waitStale(record: UnitRecord): Promise<void>;
  /** The real `createPrStep` as `identity` from `record`, with a real commit: the killed lane's late push. */
  replay(p: ReplayParams): Promise<Replayed>;
  /** The live area's branches; nothing on the fake forge. */
  cleanup(): Promise<void>;
};

const FAKE_REPO = "acme/scratch";
const FAKE_LOGIN = "alice";
const FAKE_NOW = "2026-10-25T10:00:00Z";
const FAKE_BOT_USER_ID = 4242;
/** The seed's default `runner_version`. */
const SEED_RUNNER = "canary";

const callSignal = (): AbortSignal => AbortSignal.timeout(60_000);

function must<T>(r: ForgeResult<T>, what: string): T {
  if (!r.ok) throw new Error(`${what}: ${r.error.kind}: ${r.error.message}`);
  return r.value;
}

/** The lane forge over `base`: `view` overlaid, alerts recorded, and the barrier when racing. */
function laneForge(base: Forge, p: LaneConnectParams): Forge {
  const f = recordAlerts(withMain(base, p.view), p.alerts);
  return p.race === undefined ? f : p.race.wrap(f, p.tag);
}

const DONE_RESULT: BuildResult = { kind: "build", outcome: "done", summary: "Late push", body: "", verification: ["bun test"], denied_actions: [] };

/** The late push: the real PR step as `identity` from its old `record`, its commit `commitSha`. */
async function replayOn(forge: Forge, repo: string, p: ReplayParams, commitSha: GitSha): Promise<{ readonly out: PrStepOutput; readonly notes: string[] }> {
  const snap = must(await forge.snapshot({ signal: callSignal(), read: readsPath }), "replay snapshot");
  const story = storyFor({ repo, snap, identity: p.identity, ledger: {} });
  if (story.unit !== p.record.unit) throw new Error(`replay: the view's next Story is ${story.unit}, not ${p.record.unit}`);
  const committer: Committer = {
    commit: async (r) => ok({ kind: "committed", base_sha: r.ontoSha, head_sha: commitSha }),
  };
  const notes: string[] = [];
  const step = createPrStep({ forge, committer, identity: p.identity, repo, provider: "anthropic" });
  const out = await step({
    unit: story,
    record: p.record,
    result: DONE_RESULT,
    specPath: `_bmad-output/implementation-artifacts/spec-${story.sprint_key}.md`,
    superseded: [],
    clone: "/nonexistent/race-replay",
    signal: AbortSignal.timeout(5 * 60_000),
    log: (t) => notes.push(t),
  });
  return { out, notes };
}

async function recordsOf(forge: Forge): Promise<ReadonlyMap<string, UnitRecord>> {
  const snap = must(await forge.snapshot({ signal: callSignal() }), "snapshot");
  const ledger = parseLedger(snap.ledger.files);
  if (!ledger.ok) throw new Error(`ledger: ${ledger.error.message}`);
  return ledger.value.units;
}

/** A rehearsal area: one fake forge, its `main` the scratch seed. */
export function fakeArea(o: { readonly repo?: string; readonly owner?: string } = {}): RaceArea {
  const repo = o.repo ?? FAKE_REPO;
  const owner = o.owner ?? FAKE_LOGIN;
  const fake = createFakeForge({ now: FAKE_NOW, main: scratchSeed({ repo, login: owner }) });
  const forge = (view: RaceView, alerts: string[]): Forge => recordAlerts(withMain(fake.forge, view), alerts);
  return {
    kind: "fake",
    ref: { kind: "fake" },
    repo,
    owner,
    runnerVersion: SEED_RUNNER,
    connect: (p) => async () => ({
      ok: true,
      connection: {
        forge: () => laneForge(fake.forge, p),
        token: async () => forgeOk("ghs_fake_race_token"),
        fetchShas: () => async () => ok(undefined),
        botUserId: async () => forgeOk(FAKE_BOT_USER_ID),
      },
    }),
    forge,
    records: () => recordsOf(fake.forge),
    history: async () => fake.control.ledgerLog().map((c) => c.message),
    now: async () => must(await fake.forge.snapshot({ signal: callSignal() }), "snapshot").now,
    waitStale: async (record) => {
      fake.control.setNow(new Date(Date.parse(record.heartbeat_at) + STALE_AFTER_MS + 1000).toISOString());
    },
    replay: async (p) => {
      const f = forge(p.view, []);
      const { out, notes } = await replayOn(f, repo, p, fake.control.makeCommit());
      const head = must(await f.branchHead(`story/${p.record.unit.slice("story:".length)}`, { signal: callSignal() }), "branchHead");
      return { out, head, notes };
    },
    cleanup: async () => {},
  };
}

/** How often `waitStale` reads the forge's time on the live area. */
const STALE_POLL_MS = 30_000;

/**
 * A live area on the scratch repo (`XARABOT_LIVE_GITHUB_REPO`): a fresh
 * ledger branch `xarabot/test-<uuid>` (made at once, so racing lanes never
 * race to create it), unit branches prefixed `xarabot-test/<uuid>/`, and the
 * owner's App credentials. A child lane process passes the parent's branch
 * and prefix, and never cleans up.
 */
export async function liveArea(o: { readonly ledgerBranch?: string; readonly prefix?: string } = {}): Promise<RaceArea> {
  const repo = liveRepo();
  const slug = `${repo.owner}/${repo.name}`;
  const credentials: AppCredentials = await liveCredentials();
  const ledgerBranch = o.ledgerBranch ?? `xarabot/test-${crypto.randomUUID()}`;
  const prefix = o.prefix ?? `xarabot-test/${crypto.randomUUID()}/`;
  const touched = new Set<string>();
  for (const s of RACE_STORIES) touched.add(`${prefix}story/${s.id}`);
  const tokens = createTokenSource({ credentials, repo });
  const raw: RawCall = async (op: Operation, path: string, body?: unknown) => {
    const s = callSignal();
    const token = must(await tokens.get(s), "installation token");
    const r = must(await request({ op, path: `/repos/${repo.owner}/${repo.name}${path}`, token, signal: s, body }), op.name);
    return { status: r.status, body: r.body };
  };
  /** The unprefixed forge on the area's ledger branch: reads and cleanup. */
  const inner = createGitHubForge({ repo, credentials, ledgerBranch });
  const cleanup = (): Promise<void> => cleanupScratch({ forge: inner, raw, touched, ledgerBranch, signal: callSignal });

  let runnerVersion: string;
  try {
    const snap = must(await inner.snapshot({ signal: callSignal(), read: readsPath }), "scratch snapshot");
    const loaded = loadRepoConfig({ repo: slug, now: snap.now, tree: [...snap.main.tree], files: { ...snap.main.files } });
    if (!loaded.ok) throw new Error(`scratch main: ${loaded.error.kind}: ${loaded.error.message} (seed the scratch repo with bun test/e2e/scratch-seed.ts)`);
    runnerVersion = loaded.value.repo.config.runner_version;
  } catch (e) {
    if (o.ledgerBranch === undefined) await cleanup().catch(() => {});
    throw e;
  }

  const prefixedForge = (opts: { readonly runnerGit?: string; readonly maintainer?: string }): Forge =>
    prefixed(
      createGitHubForge({
        repo,
        credentials,
        ledgerBranch,
        ...(opts.runnerGit !== undefined ? { runnerGit: opts.runnerGit } : {}),
        ...(opts.maintainer !== undefined ? { maintainer: opts.maintainer } : {}),
      }),
      prefix,
      touched,
    );
  const forge = (view: RaceView, alerts: string[]): Forge => recordAlerts(withMain(prefixedForge({}), view), alerts);

  /** A real commit not on any branch: `main`'s tree with `main` as its parent. */
  const freshCommit = async (): Promise<GitSha> => {
    const snap = must(await inner.snapshot({ signal: callSignal() }), "snapshot");
    const main = await raw(GITHUB_OPERATIONS.getCommit, `/git/commits/${snap.main.sha}`);
    if (!isSuccess(main.status)) throw new Error(`GET git/commits/${snap.main.sha}: ${main.status}`);
    const tree = (main.body as { tree?: { sha?: unknown } }).tree?.sha;
    if (typeof tree !== "string") throw new Error(`main ${snap.main.sha} has no tree`);
    const made = await raw(GITHUB_OPERATIONS.createCommit, "/git/commits", { message: "xarabot race: the late push replay", tree, parents: [snap.main.sha] });
    if (!isSuccess(made.status)) throw new Error(`POST git/commits: ${made.status}`);
    const sha = (made.body as { sha?: unknown }).sha;
    if (typeof sha !== "string") throw new Error("POST git/commits: no sha");
    return sha;
  };

  return {
    kind: "live",
    ref: { kind: "live", ledgerBranch, prefix },
    repo: slug,
    owner: LIVE_LOGIN,
    runnerVersion,
    connect: (p) => async (lane) => {
      if (lane.repo !== slug) return { ok: false, message: `race connect: lane repo ${lane.repo} is not ${slug}` };
      return {
        ok: true,
        connection: {
          forge: (opts) => laneForge(prefixedForge(opts), p),
          token: (signal) => tokens.get(signal),
          fetchShas: (gitDir) => createGitHubFetch({ repo, credentials, gitDir }),
          botUserId: (signal) => fetchBotUserId({ slug: credentials.app.slug, signal }),
        },
      };
    },
    forge,
    records: () => recordsOf(inner),
    history: async () => {
      const snap = must(await inner.snapshot({ signal: callSignal() }), "snapshot");
      const messages: string[] = [];
      let sha: string | undefined = snap.ledger.tip;
      const CAP = 500;
      for (let i = 0; sha !== undefined && i < CAP; i += 1) {
        const r = await raw(GITHUB_OPERATIONS.getCommit, `/git/commits/${sha}`);
        if (!isSuccess(r.status)) throw new Error(`GET git/commits/${sha}: ${r.status}`);
        const body = r.body as { message?: unknown; parents?: { sha?: unknown }[] };
        messages.push(typeof body.message === "string" ? body.message.trim() : "");
        const parent = body.parents?.[0]?.sha;
        sha = typeof parent === "string" ? parent : undefined;
      }
      if (sha !== undefined) throw new Error(`ledger history: more than ${CAP} commits; ${sha} is still to read`);
      return messages.reverse();
    },
    now: async () => must(await inner.snapshot({ signal: callSignal() }), "snapshot").now,
    waitStale: async (record) => {
      const deadline = Date.now() + STALE_AFTER_MS + 15 * 60_000;
      for (;;) {
        const now = must(await inner.snapshot({ signal: callSignal() }), "snapshot").now;
        if (isStale(record, now)) return;
        if (Date.now() > deadline) throw new Error(`${record.unit} is still not stale at forge time ${now}`);
        await Bun.sleep(STALE_POLL_MS);
      }
    },
    replay: async (p) => {
      const f = forge(p.view, []);
      const { out, notes } = await replayOn(f, slug, p, await freshCommit());
      const head = must(await f.branchHead(`story/${p.record.unit.slice("story:".length)}`, { signal: callSignal() }), "branchHead");
      return { out, head, notes };
    },
    cleanup,
  };
}

// ------------------------------------------------------------ child lane processes

/** A child lane process's config: `bun test/e2e/race-lane.ts <config.json>`. */
export type RaceLaneConfig = {
  readonly host: RaceHost;
  readonly control: string;
  readonly tag: string;
  readonly view: RaceView;
  /** `fake`: the child's own fake forge; `live`: the area's ledger branch and prefix. */
  readonly area: AreaRef;
};

export type ChildLane = {
  readonly pid: number;
  /** Resolves when the child exits: its code (`null` after a signal), its signal and its output. */
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null; readonly stdout: string; readonly stderr: string }>;
  /** Set once the child has exited. */
  readonly done: () => boolean;
};

const ROOT = join(import.meta.dir, "..", "..");

/** Starts one child lane process from `config`, written to `configPath`. */
export function spawnRaceLane(config: RaceLaneConfig, configPath: string): ChildLane {
  writeFileSync(configPath, JSON.stringify(config));
  const proc = Bun.spawn([process.execPath, "test/e2e/race-lane.ts", configPath], { cwd: ROOT, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let finished = false;
  const exited = (async () => {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    finished = true;
    return { code: proc.exitCode, signal: proc.signalCode === null ? null : String(proc.signalCode), stdout, stderr };
  })();
  return { pid: proc.pid, exited, done: () => finished };
}

/** Kills a child lane by its exact PID, if it is still running. */
export function killChild(child: ChildLane): void {
  if (child.done()) return;
  try {
    process.kill(child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}
