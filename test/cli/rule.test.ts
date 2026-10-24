import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { ruleCommand } from "../../src/cli/rule.ts";
import { parseLedger } from "../../src/core/ledger/codec.ts";
import type { Lane } from "../../src/core/schemas/host.ts";
import type { Park, UnitRecord } from "../../src/core/schemas/ledger.ts";
import { rec, tip } from "../core/ledger/fixtures.ts";
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
  o: { readonly host?: string | null; readonly records?: readonly UnitRecord[]; readonly openPr?: boolean; readonly forgeFails?: string; readonly noHome?: boolean; readonly closeFails?: boolean } = {},
): Promise<Ran> {
  const w = world(dirs);
  if (o.host !== null) {
    mkdirSync(dirname(w.hostYaml), { recursive: true });
    writeFileSync(w.hostYaml, o.host ?? hostYaml([{ name: "builder-1" }]));
  }
  const fake = createFakeForge({ now: "2026-10-24T12:00:00Z", firstPrNumber: 7 });
  if (o.openPr === true) {
    const sha = fake.control.makeCommit();
    const pushed = await fake.forge.pushBranch({ branch: "story/2.6", expected_sha: null, sha }, opts());
    if (!pushed.ok) throw new Error(pushed.error.message);
    const pr = await fake.forge.openPr({ branch: "story/2.6", base: "main", title: "t", body: "b" }, opts());
    if (!pr.ok) throw new Error(pr.error.message);
  }
  if (o.records !== undefined) fake.control.writeForeignLedger({ message: "seed [skip ci]", writes: tip(o.records), deletes: [] });
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
  test.each([
    [["approve", "story:2.6"], "approve"],
    [["go", "checkpoint:2"], "go"],
    [["reject", "nonsense"], "reject"],
  ])("%j: exit 1 naming Story 4.6, before any file or forge access", async (args, verb) => {
    // No HOME and no host.yaml: the refusal comes first.
    const r = await ruleWith(args, { noHome: true, host: null });
    expect(r.code).toBe(1);
    expect(r.err).toEqual([`xarabot rule: ${verb}: not before Story 4.6`]);
    expect(r.forLanes).toEqual([]);
    expect(r.out).toEqual([]);
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
    const parked = rec({ unit: U, state: "parked", park: blocked, attempts: 2, loopbacks: 1, ci_fixes: 1, builder_providers: ["claude"], generation: 2 });
    const r = await ruleWith(["release", U], { records: [parked] });
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([`released ${U} (blocked attempts-cap)`]);
    expect(await r.record()).toMatchObject({ state: "released", park: null, attempts: 0, loopbacks: 0, ci_fixes: 0, builder_providers: ["claude"], generation: 2 });
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
      builder_providers: ["claude"],
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

