import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { RULE_USAGE, ruleCommand } from "../../src/cli/rule.ts";
import { COORDINATOR_PATH, parseLedger, serializeCoordinator } from "../../src/core/ledger/codec.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { CoordinatorRecord, Park, UnitRecord } from "../../src/core/schemas/ledger.ts";
import { rec, tip } from "../core/ledger/fixtures.ts";
import { input as worldInput, itemId, type World } from "../core/next/fixtures.ts";
import { cleanup, HOST_ID, world } from "./lane-fixture.ts";

const dirs: string[] = [];
afterEach(() => cleanup(dirs));

const REPO = "xaravel/xarabot";
const U = "story:2.6";
const opts = () => ({ signal: AbortSignal.timeout(5000) });
const blocked: Park = { kind: "blocked", reason: "attempts-cap", inbox_owner: "alice", globs_held: [] };
const awaiting: Park = { kind: "awaiting-approval", reason: null, inbox_owner: "alice", globs_held: [] };

type LaneYaml = { readonly name: string; readonly repo?: string; readonly role?: string; readonly owner?: string };

function hostYaml(lanes: readonly LaneYaml[], hostId = true): string {
  const lines = ["schema_version: 1", ...(hostId ? [`host_id: ${HOST_ID}`] : []), lanes.length === 0 ? "lanes: {}" : "lanes:"];
  for (const l of lanes) {
    lines.push(`  ${l.name}:`, `    repo: ${l.repo ?? REPO}`, `    role: ${l.role ?? "builder"}`, `    owner: ${l.owner ?? "alice"}`, "    agent: claude");
  }
  return `${lines.join("\n")}\n`;
}

type Ran = {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly fake: FakeForge;
  /** The lanes the forge was made for. */
  readonly forLanes: Lane[];
  record(unit?: string): Promise<UnitRecord | undefined>;
};

async function ruleWith(
  args: readonly string[],
  o: {
    readonly host?: string | null;
    readonly records?: readonly UnitRecord[];
    readonly openPr?: boolean;
    readonly forgeFails?: string;
    readonly noHome?: boolean;
    readonly closeFails?: boolean;
    /** `main`'s files (Story 4.6's verbs assemble a snapshot). */
    readonly main?: Readonly<Record<string, string>>;
    /** `coordinator.json`, seeded with the records. */
    readonly coordinator?: CoordinatorRecord;
  } = {},
): Promise<Ran> {
  const w = world(dirs);
  if (o.host !== null) {
    mkdirSync(dirname(w.hostYaml), { recursive: true });
    writeFileSync(w.hostYaml, o.host ?? hostYaml([{ name: "builder-1" }]));
  }
  const fake = createFakeForge({ now: "2026-10-24T12:00:00Z", firstPrNumber: 7, ...(o.main !== undefined ? { main: o.main } : {}) });
  if (o.openPr === true) {
    const sha = fake.control.makeCommit();
    const pushed = await fake.forge.pushBranch({ branch: "story/2.6", expected_sha: null, sha }, opts());
    if (!pushed.ok) throw new Error(pushed.error.message);
    const pr = await fake.forge.openPr({ branch: "story/2.6", base: "main", title: "t", body: "b" }, opts());
    if (!pr.ok) throw new Error(pr.error.message);
  }
  if (o.records !== undefined || o.coordinator !== undefined) {
    const extra: Record<string, string> = o.coordinator === undefined ? {} : { [COORDINATOR_PATH]: serializeCoordinator(o.coordinator) };
    fake.control.writeForeignLedger({ message: "seed [skip ci]", writes: tip(o.records ?? [], extra), deletes: [] });
  }
  if (o.closeFails === true) fake.control.injectError("closePr", { kind: "transient", message: "502" });
  const out: string[] = [];
  const err: string[] = [];
  const forLanes: Lane[] = [];
  const env: Record<string, string> = o.noHome === true ? { PATH: "/usr/bin:/bin" } : w.env;
  const code = await ruleCommand(args, {
    env,
    forge: async (lane) => {
      forLanes.push(lane);
      return o.forgeFails !== undefined ? { ok: false, message: o.forgeFails } : { ok: true, forge: fake.forge };
    },
    out: (l) => out.push(l),
    errOut: (l) => err.push(l),
  });
  return {
    code,
    out,
    err,
    fake,
    forLanes,
    async record(unit = U) {
      const s = await fake.forge.snapshot(opts());
      if (!s.ok) throw new Error(s.error.message);
      const l = parseLedger(s.value.ledger.files);
      if (!l.ok) throw new Error(l.error.message);
      return l.value.units.get(unit);
    },
  };
}

describe("xarabot rule: arguments", () => {
  test.each([[["reject", "nonsense"], "reject"], [["GO", "checkpoint:2"], "GO"]])("%j: an unknown verb, exit 1 before any file or forge access", async (args, verb) => {
    // No HOME and no host.yaml: the refusal comes first.
    const r = await ruleWith(args, { noHome: true, host: null });
    expect(r.code).toBe(1);
    expect(r.err).toEqual([`xarabot rule: ${verb} is not a verb; usage: ${RULE_USAGE}`]);
    expect(r.forLanes).toEqual([]);
    expect(r.out).toEqual([]);
  });

  test("the usage lists all nine verbs", () => {
    expect(RULE_USAGE).toBe("xarabot rule go|approve|block|unblock|done|defer|rebuild|release|dismiss <unit-id> [--repo <owner>/<name>]");
  });

  test.each([[[]], [["release"]], [["release", "story:x"]], [["release", "2.6"]], [["release", U, "--repo"]], [["release", U, "extra"]], [["--repo", REPO]]])(
    "%j is a usage error, exit 1",
    async (args) => {
      const r = await ruleWith(args);
      expect(r.code).toBe(1);
      expect(r.err.join("\n")).toContain("usage: xarabot rule");
      expect(r.forLanes).toEqual([]);
    },
  );

  test("no HOME: exit 1", async () => {
    const r = await ruleWith(["release", U], { noHome: true });
    expect(r.err).toEqual(["xarabot rule: HOME is not set"]);
    expect(r.code).toBe(1);
  });

  test("no host.yaml: exit 1", async () => {
    const r = await ruleWith(["release", U], { host: null });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("does not exist");
  });

  test("a host.yaml with no host_id: exit 1, no forge", async () => {
    const r = await ruleWith(["release", U], { host: hostYaml([{ name: "builder-1" }], false) });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("has no host_id");
    expect(r.forLanes).toEqual([]);
  });
});

describe("xarabot rule: the repo and the writer", () => {
  const parked = rec({ unit: U, state: "parked", park: blocked, attempts: 3 });

  test("one repo, builders only: written as the lowest-numbered builder", async () => {
    const host = hostYaml([{ name: "builder-3", owner: "carol" }, { name: "builder-2", owner: "bob" }, { name: "builder-10" }]);
    const r = await ruleWith(["release", U], { host, records: [parked] });
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.forLanes.map((l) => l.owner)).toEqual(["bob"]);
    expect(await r.record()).toMatchObject({ state: "released", owner: "bob", host: HOST_ID, lane: "builder-2", attempts: 0 });
  });

  test("a coordinator lane on the host: written as the coordinator", async () => {
    const host = hostYaml([{ name: "builder-1" }, { name: "coordinator", role: "coordinator", owner: "carol" }]);
    const r = await ruleWith(["release", U], { host, records: [parked] });
    expect(r.code).toBe(0);
    expect(await r.record()).toMatchObject({ state: "released", owner: "carol", lane: "coordinator" });
  });

  test("several repos and no --repo: refused, no forge", async () => {
    const host = hostYaml([{ name: "builder-1" }, { name: "builder-2", repo: "acme/widgets" }]);
    const r = await ruleWith(["release", U], { host, records: [parked] });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("several repos (acme/widgets, xaravel/xarabot): name one with --repo");
    expect(r.forLanes).toEqual([]);
  });

  test("several repos and --repo: that repo's lanes write", async () => {
    const host = hostYaml([{ name: "builder-1" }, { name: "builder-2", repo: "acme/widgets", owner: "dave" }]);
    const r = await ruleWith(["release", U, "--repo", "acme/widgets"], { host, records: [parked] });
    expect(r.code).toBe(0);
    expect(r.forLanes.map((l) => l.repo)).toEqual(["acme/widgets"]);
    expect(await r.record()).toMatchObject({ owner: "dave", lane: "builder-2" });
  });

  test("a --repo no lane has: refused, no forge", async () => {
    const r = await ruleWith(["release", U, "--repo", "acme/widgets"], { records: [parked] });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("no lane in");
    expect(r.err.join("\n")).toContain("acme/widgets");
    expect(r.forLanes).toEqual([]);
  });

  test("a non-story unit with no coordinator lane on the host: refused, the ledger unchanged", async () => {
    const plan = rec({ unit: "planning:sprint.2", state: "parked", park: blocked, lane: "coordinator" });
    const r = await ruleWith(["release", "planning:sprint.2"], { records: [plan] });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("planning:sprint.2 is a planning unit");
    expect(r.forLanes).toEqual([]);
    expect(await r.record("planning:sprint.2")).toEqual(plan);
  });

  test("a non-story unit with a coordinator lane: released as the coordinator", async () => {
    const plan = rec({ unit: "planning:sprint.2", state: "parked", park: blocked, lane: "coordinator" });
    const host = hostYaml([{ name: "coordinator", role: "coordinator" }]);
    const r = await ruleWith(["release", "planning:sprint.2"], { host, records: [plan] });
    expect(r.code).toBe(0);
    expect(await r.record("planning:sprint.2")).toMatchObject({ state: "released", lane: "coordinator" });
  });

  test("the forge cannot be made: exit 1 with its message", async () => {
    const r = await ruleWith(["release", U], { records: [parked], forgeFails: "credentials auth: missing" });
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["xarabot rule: credentials auth: missing"]);
  });
});

describe("xarabot rule: the matrix", () => {
  test("release: a parked blocked record is released, counters 0, providers kept", async () => {
    const parked = rec({ unit: U, state: "parked", park: blocked, attempts: 2, loopbacks: 1, ci_fixes: 1, builder_providers: ["anthropic"], generation: 2 });
    const r = await ruleWith(["release", U], { records: [parked] });
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([`released ${U} (blocked attempts-cap)`]);
    expect(await r.record()).toMatchObject({ state: "released", park: null, attempts: 0, loopbacks: 0, ci_fixes: 0, builder_providers: ["anthropic"], generation: 2 });
    expect(r.fake.control.ledgerLog().map((c) => c.message).slice(-1)).toEqual([`ledger: applyRuling ${U} [skip ci]`]);
  });

  test("rebuild: the open PR is closed, then released with SHAs and providers cleared", async () => {
    const parked = rec({
      unit: U,
      state: "parked",
      park: awaiting,
      pr: 7,
      reviewed_sha: "a".repeat(40),
      passed_sha: "b".repeat(40),
      builder_providers: ["anthropic"],
      attempts: 1,
      loopbacks: 1,
    });
    const r = await ruleWith(["rebuild", U], { records: [parked], openPr: true });
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["closed PR #7", `released ${U} (awaiting-approval)`]);
    expect(await r.record()).toMatchObject({ state: "released", reviewed_sha: null, passed_sha: null, builder_providers: [], attempts: 0, loopbacks: 0, pr: 7 });
    const prs = await r.fake.forge.listPrsByBranch("story/2.6", opts());
    expect(prs.ok && prs.value.map((p) => p.state)).toEqual(["closed"]);
  });

  test("rebuild whose close fails: exit 1, the ledger unchanged", async () => {
    const parked = rec({ unit: U, state: "parked", park: awaiting, pr: 7 });
    const fails = await ruleWith(["rebuild", U], { records: [parked], openPr: true, closeFails: true });
    expect(fails.code).toBe(1);
    expect(fails.err.join("\n")).toContain("closePr #7 transient");
    expect(await fails.record()).toEqual(parked);
  });

  test.each(["claimed", "merging", "released", "merged"] as const)("a %s record: exit 1 naming the state, the ledger unchanged", async (state) => {
    const r0 = rec({ unit: U, state, ...(state === "merging" ? { pr: 3 } : {}) });
    const r = await ruleWith(["release", U], { records: [r0] });
    expect(r.code).toBe(1);
    expect(r.err).toEqual([`xarabot rule: ${U} is ${state}, not parked`]);
    expect(await r.record()).toEqual(r0);
  });

  test("no record: exit 1, has no ledger record", async () => {
    const r = await ruleWith(["rebuild", U], { records: [] });
    expect(r.code).toBe(1);
    expect(r.err).toEqual([`xarabot rule: ${U} has no ledger record`]);
  });
});


describe("xarabot rule: every verb (Story 4.6)", () => {
  const NOW = "2026-10-24T12:00:00Z";
  const ITEM = `retro-item:${itemId(2, 1)}`;
  /** Epic 2's retro rejected with a Maintainer item; Epic 3 a checkpoint whose go waits; Story 2.1 an Infrastructure Story. */
  const WORLD: World = {
    epics: { 1: ["1"], 2: ["1"], 3: ["1"] },
    manifests: [{ id: "1.1" }, { id: "2.1", infra: true }, { id: "3.1" }],
    epicsYaml: "version: 1\nepics:\n  3:\n    depends_on: [2]\n    checkpoint: true\n",
    retro: { 2: "rejected", 3: "accepted" },
    items: { 2: [{ seq: 1, blocking: false, status: "waiting", route: "maintainer" }] },
  };
  const MAIN = worldInput(WORLD).files;
  const WITH_COORDINATOR = hostYaml([{ name: "builder-1" }, { name: "coordinator", role: "coordinator", owner: "carol" }]);
  const CLAIM: CoordinatorRecord = { schema_version: 6, owner: "carol", host: HOST_ID, lane: "coordinator", generation: 1, heartbeat_at: NOW, digest_posted_at: null, rulings_cursor: "9" };
  const needs = rec({ unit: "story:2.1", state: "parked", park: { kind: "needs-approval", reason: null, inbox_owner: "alice", globs_held: [] } });
  const coordinatorOf = async (r: Ran) => {
    const s = await r.fake.forge.snapshot(opts());
    if (!s.ok) throw new Error(s.error.message);
    const l = parseLedger(s.value.ledger.files);
    if (!l.ok) throw new Error(l.error.message);
    return l.value.coordinator;
  };

  test.each([
    ["go", "checkpoint:3"],
    ["go", "retro:2"],
    ["block", ITEM],
    ["unblock", `retro-item:${itemId(2, 1)}`],
    ["done", ITEM],
    ["defer", ITEM],
  ] as const)("%s %s with the coordinator lane: exit 0, the pending entry written as the coordinator, the cursor kept", async (verb, unit) => {
    const isBlocked = verb === "unblock";
    const main = isBlocked ? worldInput({ ...WORLD, items: { 2: [{ seq: 1, blocking: true, status: "waiting", route: "maintainer" }] } }).files : MAIN;
    const r = await ruleWith([verb, unit], { host: WITH_COORDINATOR, main, coordinator: CLAIM, records: [needs] });
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([`recorded ${verb} ${unit} as pending: the next reconcile PR writes it to retro-gates.yaml`]);
    expect(r.forLanes.map((l) => l.role)).toEqual(["coordinator"]);
    const c = await coordinatorOf(r);
    expect(c?.pending_rulings).toEqual([{ verb, unit, by: "edanisko", at: NOW, ruling: "xarabot-rule" }]);
    expect(c?.rulings_cursor).toBe("9");
  });

  test("dismiss with the coordinator lane: exit 0, the dismissal written", async () => {
    const r = await ruleWith(["dismiss", "checkpoint:3"], { host: WITH_COORDINATOR, main: MAIN, coordinator: CLAIM });
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["dismissed checkpoint:3 from the inbox"]);
    expect((await coordinatorOf(r))?.dismissals).toEqual([{ unit: "checkpoint:3", subject: "Epic 3's retro is recorded (accepted)", since: "2026-10-20T00:00:00Z" }]);
  });

  test("approve with builders only: exit 0, released with the Maintainer's approval of the manifest's sha", async () => {
    const r = await ruleWith(["approve", "story:2.1"], { main: MAIN, records: [needs] });
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    const snap = await r.fake.forge.snapshot({ ...opts(), read: () => true });
    const sha = snap.ok ? snap.value.main.blob_shas["stories/2.1.md"] : undefined;
    expect(r.out).toEqual([`approved story:2.1 (manifest ${sha}): released`]);
    expect(await r.record("story:2.1")).toMatchObject({ state: "released", approval: { by: "edanisko", manifest_sha: sha }, lane: "builder-1" });
  });

  test.each(["go", "block", "unblock", "done", "defer", "dismiss"])("%s with no coordinator lane on the host: exit 1 before any forge access", async (verb) => {
    const unit = verb === "go" || verb === "dismiss" ? "checkpoint:3" : ITEM;
    const r = await ruleWith([verb, unit], { main: MAIN, coordinator: CLAIM });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain(`${verb} writes coordinator.json, so it is written as the repo's coordinator lane`);
    expect(r.forLanes).toEqual([]);
  });

  test("a refused target: exit 1 with the reason, nothing written", async () => {
    const r = await ruleWith(["go", "retro:3"], { host: WITH_COORDINATOR, main: MAIN, coordinator: CLAIM });
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["xarabot rule: retro:3's verdict is accepted, not rejected"]);
    expect((await coordinatorOf(r))?.pending_rulings).toBeUndefined();
  });

  test("approve with no manifest on main: exit 1 with the reason", async () => {
    const r = await ruleWith(["approve", "story:2.6"], { main: MAIN, records: [rec({ unit: "story:2.6", state: "parked", park: { kind: "needs-approval", reason: null, inbox_owner: "alice", globs_held: [] } })] });
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["xarabot rule: story:2.6 has no manifest on main"]);
  });
});
