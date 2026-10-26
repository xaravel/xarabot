import { describe, expect, test } from "bun:test";
import { createFakeForge, type FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { parseLedger } from "../../src/core/ledger/codec.ts";
import type { Park, UnitRecord } from "../../src/core/schemas/ledger.ts";
import { applyHostRuling, type HostRuling } from "../../src/lane/rule.ts";
import { ALICE, BOB, rec, SHA_A, SHA_B, SHA_D, tip } from "../core/ledger/fixtures.ts";

const U = "story:2.6";
const NOW = "2026-10-24T12:00:00Z";
const opts = () => ({ signal: AbortSignal.timeout(5000) });

const blocked: Park = { kind: "blocked", reason: "attempts-cap", inbox_owner: "alice", globs_held: [] };
const awaiting: Park = { kind: "awaiting-approval", reason: null, inbox_owner: "alice", globs_held: ["src/a.ts"] };

/** A fake forge seeded with `records`; with `openPr`, PR #7 is open on `story/2.6`. */
async function seeded(records: readonly UnitRecord[], o: { readonly openPr?: boolean } = {}): Promise<FakeForge> {
  const fake = createFakeForge({ now: NOW, firstPrNumber: 7 });
  if (o.openPr === true) {
    const sha = fake.control.makeCommit();
    const pushed = await fake.forge.pushBranch({ branch: "story/2.6", expected_sha: null, sha }, opts());
    if (!pushed.ok) throw new Error(pushed.error.message);
    const pr = await fake.forge.openPr({ branch: "story/2.6", base: "main", title: "t", body: "b" }, opts());
    if (!pr.ok) throw new Error(pr.error.message);
  }
  fake.control.writeForeignLedger({ message: "seed [skip ci]", writes: tip(records), deletes: [] });
  return fake;
}

async function record(fake: FakeForge, unit = U): Promise<UnitRecord | undefined> {
  const s = await fake.forge.snapshot(opts());
  if (!s.ok) throw new Error(s.error.message);
  const l = parseLedger(s.value.ledger.files);
  if (!l.ok) throw new Error(l.error.message);
  return l.value.units.get(unit);
}

const rule = (fake: FakeForge, ruling: HostRuling, unit = U) =>
  applyHostRuling({ forge: fake.forge, identity: BOB, unit, ruling, sleep: async () => {}, random: () => 0 });

describe("applyHostRuling", () => {
  test("release: one ledger commit, released, counters 0, providers kept, park null, generation unchanged, written by the identity", async () => {
    const parked = rec({ unit: U, state: "parked", generation: 3, park: blocked, attempts: 2, loopbacks: 1, ci_fixes: 1, builder_providers: ["anthropic"], passed_sha: SHA_A });
    const fake = await seeded([parked]);
    const before = fake.control.ledgerLog().length;
    const r = await rule(fake, "release");
    expect(r).toEqual({ ok: true, value: { unit: U, generation: 3, park: blocked, closedPr: null } });
    expect(fake.control.ledgerLog().slice(before).map((c) => c.message)).toEqual([`ledger: applyRuling ${U} [skip ci]`]);
    expect(await record(fake)).toEqual({
      ...parked,
      state: "released",
      park: null,
      attempts: 0,
      loopbacks: 0,
      ci_fixes: 0,
      owner: BOB.owner,
      host: BOB.host,
      lane: BOB.lane,
      heartbeat_at: NOW,
    });
  });

  test("release leaves an open PR open", async () => {
    const fake = await seeded([rec({ unit: U, state: "parked", park: awaiting, pr: 7 })], { openPr: true });
    const r = await rule(fake, "release");
    expect(r.ok && r.value.closedPr).toBe(null);
    const prs = await fake.forge.listPrsByBranch("story/2.6", opts());
    expect(prs.ok && prs.value.map((p) => p.state)).toEqual(["open"]);
  });

  test("rebuild: the open PR is closed first, then released with counters 0, providers [] and SHAs null", async () => {
    const parked = rec({
      unit: U,
      state: "parked",
      park: awaiting,
      pr: 7,
      pr_owner: "alice",
      head_sha: SHA_B,
      reviewed_sha: SHA_A,
      passed_sha: SHA_B,
      approved_sha: SHA_D,
      attempts: 1,
      loopbacks: 2,
      ci_fixes: 1,
      builder_providers: ["anthropic"],
    });
    const fake = await seeded([parked], { openPr: true });
    const r = await rule(fake, "rebuild");
    expect(r).toEqual({ ok: true, value: { unit: U, generation: 1, park: awaiting, closedPr: 7 } });
    const prs = await fake.forge.listPrsByBranch("story/2.6", opts());
    expect(prs.ok && prs.value.map((p) => [p.number, p.state])).toEqual([[7, "closed"]]);
    expect(await record(fake)).toMatchObject({
      state: "released",
      park: null,
      pr: 7,
      attempts: 0,
      loopbacks: 0,
      ci_fixes: 0,
      builder_providers: [],
      reviewed_sha: null,
      passed_sha: null,
      approved_sha: null,
      generation: 1,
    });
  });

  test("rebuild with the PR already closed: no close, released", async () => {
    const fake = await seeded([rec({ unit: U, state: "parked", park: blocked, pr: 7 })], { openPr: true });
    const closed = await fake.forge.closePr(7, opts());
    expect(closed.ok).toBe(true);
    const r = await rule(fake, "rebuild");
    expect(r.ok && r.value.closedPr).toBe(null);
    expect((await record(fake))?.state).toBe("released");
  });

  test("rebuild whose close lands but whose swap fails: a ledger error naming the closed PR, the record still parked; a re-run skips the close and edits", async () => {
    const parked = rec({ unit: U, state: "parked", park: awaiting, pr: 7, approved_sha: SHA_D });
    const fake = await seeded([parked], { openPr: true });
    fake.control.injectError("ledgerSwap", { kind: "rejected", message: "422" });
    const r = await rule(fake, "rebuild");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("ledger");
      expect(r.error.message.endsWith("(PR #7 was closed)")).toBe(true);
    }
    const prs = await fake.forge.listPrsByBranch("story/2.6", opts());
    expect(prs.ok && prs.value.map((p) => p.state)).toEqual(["closed"]);
    expect(await record(fake)).toEqual(parked);
    const again = await rule(fake, "rebuild");
    expect(again.ok && again.value.closedPr).toBe(null);
    expect(await record(fake)).toMatchObject({ state: "released", approved_sha: null });
  });

  test("rebuild whose close fails: refused, the ledger unchanged", async () => {
    const parked = rec({ unit: U, state: "parked", park: awaiting, pr: 7, passed_sha: SHA_B });
    const fake = await seeded([parked], { openPr: true });
    fake.control.injectError("closePr", { kind: "transient", message: "502" });
    const before = fake.control.ledgerLog().length;
    const r = await rule(fake, "rebuild");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("closePr #7 transient");
    expect(fake.control.ledgerLog()).toHaveLength(before);
    expect(await record(fake)).toEqual(parked);
  });

  test.each(["claimed", "merging", "released", "merged"] as const)("a %s record is refused: not parked, the ledger unchanged", async (state) => {
    const r0 = rec({ unit: U, state, ...(state === "merging" ? { pr: 3 } : {}) });
    const fake = await seeded([r0]);
    const before = fake.control.ledgerLog().length;
    for (const ruling of ["release", "rebuild"] as const) {
      const r = await rule(fake, ruling);
      expect(r).toEqual({ ok: false, error: { kind: "refused", message: `${U} is ${state}, not parked` } });
    }
    expect(fake.control.ledgerLog()).toHaveLength(before);
    expect(await record(fake)).toEqual(r0);
  });

  test("no record: refused, the ledger unchanged", async () => {
    const fake = await seeded([rec({ unit: "story:2.5" })]);
    const before = fake.control.ledgerLog().length;
    const r = await rule(fake, "release");
    expect(r).toEqual({ ok: false, error: { kind: "refused", message: `${U} has no ledger record` } });
    expect(fake.control.ledgerLog()).toHaveLength(before);
  });

  test("a race: the generation moves between the snapshot and the swap, so the edit's precondition refuses and nothing is written", async () => {
    const parked = rec({ unit: U, state: "parked", park: blocked });
    const fake = await seeded([parked]);
    const taken = { ...parked, generation: 2, owner: ALICE.owner };
    fake.control.beforeSwap(({ n }) => {
      if (n === 1) fake.control.writeForeignLedger({ message: "foreign [skip ci]", writes: tip([taken]), deletes: [] });
    });
    const r = await rule(fake, "release");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("ledger");
      expect(r.error.message).toContain("precondition");
      expect(r.error.message).toContain("generation 2");
    }
    expect(fake.control.ledgerLog().filter((c) => c.message.startsWith("ledger: applyRuling"))).toEqual([]);
    expect(await record(fake)).toEqual(taken);
  });

  test("a snapshot failure is refused before any edit", async () => {
    const fake = await seeded([rec({ unit: U, state: "parked", park: blocked })]);
    fake.control.injectError("snapshot", { kind: "auth", message: "bad token" });
    const r = await rule(fake, "release");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe("snapshot auth: bad token");
  });
});
