import { describe, expect, test } from "bun:test";
import { COORDINATOR_PATH, parseLedger, serializeCoordinator, serializeUnitRecord } from "../../../src/core/ledger/codec.ts";
import { COORD, rec, T0, tip } from "./fixtures.ts";

const COORDINATOR = {
  schema_version: 2 as const,
  owner: COORD.owner,
  host: COORD.host,
  lane: "coordinator" as const,
  generation: 2,
  heartbeat_at: T0,
  digest_posted_at: null,
  rulings_cursor: "abc",
};

describe("serializeUnitRecord", () => {
  test("fixed key order, 2-space indent, trailing newline, sorted de-duplicated sets", () => {
    const r = rec({
      globs: ["src/b/**", "src/a/**", "src/b/**"],
      builder_providers: ["openai", "anthropic", "openai"],
      state: "parked",
      park: { kind: "awaiting-approval", reason: null, inbox_owner: "alice", globs_held: ["z.ts", "a.ts", "a.ts"] },
    });
    // Same record, keys in a scrambled order.
    const scrambled = Object.fromEntries(Object.entries(r).reverse()) as typeof r;
    const text = serializeUnitRecord(scrambled);
    expect(text).toBe(serializeUnitRecord(r));
    expect(text.endsWith("}\n")).toBe(true);
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed)).toEqual([
      "schema_version", "unit", "state", "owner", "host", "lane", "generation", "globs", "heartbeat_at",
      "pr", "pr_owner", "base_sha", "head_sha", "reviewed_sha", "passed_sha", "enqueued_sha", "approved_sha",
      "approved_graph", "retro_result", "builder_providers", "park", "attempts", "loopbacks", "ci_fixes", "approval",
    ]);
    expect(parsed.globs).toEqual(["src/a/**", "src/b/**"]);
    expect(parsed.builder_providers).toEqual(["anthropic", "openai"]);
    expect(Object.keys(parsed.park)).toEqual(["kind", "reason", "inbox_owner", "globs_held"]);
    expect(parsed.park.globs_held).toEqual(["a.ts", "z.ts"]);
    expect(text).toContain('\n  "schema_version": 6,\n');
  });

  test("a park's text comes last, after graph_posted, and round-trips (Story 4.2, ledger v6)", () => {
    const blocked = rec({ state: "parked", park: { text: "Which inbox?", globs_held: [], inbox_owner: "alice", reason: "intent-gap", kind: "blocked" } });
    const text = serializeUnitRecord(blocked);
    expect(Object.keys(JSON.parse(text).park)).toEqual(["kind", "reason", "inbox_owner", "globs_held", "text"]);
    const graph = `sha256:${"9".repeat(64)}`;
    const awaiting = rec({ state: "parked", park: { text: "t", graph_posted: graph, kind: "awaiting-approval", reason: null, inbox_owner: "alice", globs_held: [] } });
    expect(Object.keys(JSON.parse(serializeUnitRecord(awaiting)).park)).toEqual(["kind", "reason", "inbox_owner", "globs_held", "graph_posted", "text"]);
    const parsed = parseLedger({ "units/story__1.5.json": text });
    expect(parsed.ok && parsed.value.units.get("story:1.5")?.park).toEqual({ kind: "blocked", reason: "intent-gap", inbox_owner: "alice", globs_held: [], text: "Which inbox?" });
  });

  test("a v5 record with no park text still reads", () => {
    const v5 = serializeUnitRecord(rec({ state: "parked", park: { kind: "blocked", reason: "other", inbox_owner: "alice", globs_held: [] } })).replace('"schema_version": 6', '"schema_version": 5');
    const parsed = parseLedger({ "units/story__1.5.json": v5 });
    expect(parsed.ok && parsed.value.units.get("story:1.5")?.park).toEqual({ kind: "blocked", reason: "other", inbox_owner: "alice", globs_held: [] });
  });
});

describe("serializeCoordinator", () => {
  test("fixed key order", () => {
    const scrambled = Object.fromEntries(Object.entries(COORDINATOR).reverse()) as typeof COORDINATOR;
    const text = serializeCoordinator(scrambled);
    expect(Object.keys(JSON.parse(text))).toEqual(Object.keys(COORDINATOR));
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("coordinator.json's pending rulings and dismissals (Story 4.6, ledger v6)", () => {
  const PENDING = [{ verb: "go" as const, unit: "checkpoint:4", by: "edanisko", at: T0, ruling: "1234567" }];
  const DISMISSALS = [{ unit: "story:2.1", subject: "blocked `intent-gap`", since: T0 }, { unit: "story:7.1", subject: "Epic 7's heading has no manifest", since: null }];

  test("written after rulings_cursor, in key order, and round-tripped byte for byte", () => {
    const c = { ...COORDINATOR, schema_version: 6 as const, pending_rulings: PENDING, dismissals: DISMISSALS };
    const text = serializeCoordinator(c);
    expect(Object.keys(JSON.parse(text))).toEqual([...Object.keys(COORDINATOR), "pending_rulings", "dismissals"]);
    expect(Object.keys(JSON.parse(text).pending_rulings[0])).toEqual(["verb", "unit", "by", "at", "ruling"]);
    expect(Object.keys(JSON.parse(text).dismissals[0])).toEqual(["unit", "subject", "since"]);
    const parsed = parseLedger({ [COORDINATOR_PATH]: text });
    if (!parsed.ok || parsed.value.coordinator === null) throw new Error("expected a coordinator");
    expect(parsed.value.coordinator).toEqual(c);
    expect(serializeCoordinator(parsed.value.coordinator)).toBe(text);
  });

  test("empty or absent lists are not written: an older record's text is unchanged", () => {
    const old = serializeCoordinator(COORDINATOR);
    expect(old).not.toContain("pending_rulings");
    expect(serializeCoordinator({ ...COORDINATOR, pending_rulings: [], dismissals: [] })).toBe(old);
    const parsed = parseLedger({ [COORDINATOR_PATH]: old });
    if (!parsed.ok || parsed.value.coordinator === null) throw new Error("expected a coordinator");
    expect(serializeCoordinator(parsed.value.coordinator)).toBe(old);
  });

  test.each([
    ["a go on a retro item", { pending_rulings: [{ ...PENDING[0], unit: "retro-item:epic-2-retro-item-1-a" }] }],
    ["a done on a checkpoint", { pending_rulings: [{ ...PENDING[0], verb: "done" }] }],
    ["an unknown verb", { pending_rulings: [{ ...PENDING[0], verb: "approve" }] }],
    ["a dismissal with no subject", { dismissals: [{ unit: "story:2.1", subject: "", since: null }] }],
    ["a dismissal of a non-unit", { dismissals: [{ unit: "1.1-d1", subject: "x", since: null }] }],
  ])("%s is invalid", (_name, extra) => {
    const text = JSON.stringify({ ...COORDINATOR, ...extra });
    const r = parseLedger({ [COORDINATOR_PATH]: text });
    expect(r.ok ? "ok" : r.error.kind).toBe("invalid");
  });
});

describe("parseLedger", () => {
  test("round-trips units and the coordinator, ignoring other paths", () => {
    const a = rec();
    const b = rec({ unit: "planning:sprint.1", globs: [] });
    const files = tip([a, b], { [COORDINATOR_PATH]: serializeCoordinator(COORDINATOR), "README.md": "not json" });
    const r = parseLedger(files);
    if (!r.ok) throw new Error(r.error.message);
    expect([...r.value.units.keys()].sort()).toEqual(["planning:sprint.1", "story:1.5"]);
    expect(r.value.units.get("story:1.5")).toEqual(a);
    expect(r.value.coordinator).toEqual(COORDINATOR);
  });

  test("canonical text round-trips byte for byte", () => {
    const unitText = serializeUnitRecord(
      rec({ state: "parked", park: { kind: "awaiting-approval", reason: null, inbox_owner: "alice", globs_held: ["a.ts", "b.ts"] }, builder_providers: ["anthropic"] }),
    );
    const coordText = serializeCoordinator(COORDINATOR);
    const r = parseLedger({ "units/story__1.5.json": unitText, [COORDINATOR_PATH]: coordText });
    if (!r.ok) throw new Error(r.error.message);
    expect(serializeUnitRecord(r.value.units.get("story:1.5") as never)).toBe(unitText);
    if (r.value.coordinator === null) throw new Error("expected a coordinator");
    expect(serializeCoordinator(r.value.coordinator)).toBe(coordText);
  });

  test("an empty tip", () => {
    expect(parseLedger({})).toEqual({ ok: true, value: { units: new Map(), coordinator: null } });
  });

  const v = (n: number) => serializeUnitRecord(rec()).replace('"schema_version": 6', `"schema_version": ${n}`);
  const cv = (n: number) => serializeCoordinator(COORDINATOR).replace('"schema_version": 2', `"schema_version": ${n}`);

  test.each([1, 2, 3, 4, 5, 6])("unit and coordinator records at schema_version %p both parse (Stories 2.7, 2.8, 2.9, 3.5, 4.2)", (n) => {
    const r = parseLedger({ "units/story__1.5.json": v(n), [COORDINATOR_PATH]: cv(n) });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.units.get("story:1.5")?.schema_version).toBe(n as 1 | 2 | 3 | 4 | 5);
    expect(r.value.coordinator?.schema_version).toBe(n as 1 | 2 | 3 | 4 | 5);
  });

  describe("enqueued_sha (Story 3.5)", () => {
    const S = "a".repeat(40);
    const E = "b".repeat(40);
    /** A record at `n` with `passed_sha` S, and `enqueued_sha` dropped or set. */
    const raw = (n: number, enqueued: string | null | undefined): string => {
      const o = JSON.parse(serializeUnitRecord(rec({ pr: 7, head_sha: S, passed_sha: S }))) as Record<string, unknown>;
      o["schema_version"] = n;
      if (enqueued === undefined) delete o["enqueued_sha"];
      else o["enqueued_sha"] = enqueued;
      return JSON.stringify(o);
    };
    const read = (text: string) => {
      const r = parseLedger({ "units/story__1.5.json": text });
      if (!r.ok) throw new Error(r.error.message);
      return r.value.units.get("story:1.5");
    };

    test.each([1, 2, 3, 4])("a schema_version %p record with no enqueued_sha key reads passed_sha as enqueued_sha, passed_sha null", (n) => {
      const text = raw(n, undefined);
      const got = read(text);
      expect(got?.enqueued_sha).toBe(S);
      expect(got?.passed_sha).toBeNull();
      // The stored text is never rewritten by the reader.
      expect(JSON.parse(text)).toMatchObject({ passed_sha: S });
    });
    test("a schema_version 4 record with no enqueued_sha and no passed_sha reads both null", () => {
      const o = JSON.parse(raw(4, undefined)) as Record<string, unknown>;
      o["passed_sha"] = null;
      const got = read(JSON.stringify(o));
      expect(got?.enqueued_sha).toBeNull();
      expect(got?.passed_sha).toBeNull();
    });
    test("a schema_version 4 record that has the enqueued_sha key is read as it is", () => {
      const got = read(raw(4, E));
      expect(got?.enqueued_sha).toBe(E);
      expect(got?.passed_sha).toBe(S);
    });
    test("a schema_version 5 record with no enqueued_sha key reads it as null and keeps passed_sha", () => {
      const got = read(raw(5, undefined));
      expect(got?.enqueued_sha).toBeNull();
      expect(got?.passed_sha).toBe(S);
    });
    test("a schema_version 5 record round-trips both, enqueued_sha right after passed_sha", () => {
      const text = serializeUnitRecord(rec({ pr: 7, head_sha: S, passed_sha: S, enqueued_sha: E }));
      const keys = Object.keys(JSON.parse(text) as object);
      expect(keys.indexOf("enqueued_sha")).toBe(keys.indexOf("passed_sha") + 1);
      const got = read(text);
      expect(got?.passed_sha).toBe(S);
      expect(got?.enqueued_sha).toBe(E);
      expect(serializeUnitRecord(got as never)).toBe(text);
    });
    test("a bad enqueued_sha is invalid", () => {
      const r = parseLedger({ "units/story__1.5.json": raw(5, "nope") });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("invalid");
    });
  });

  test.each([1, 2, 3])("a schema_version %p record with no retro_result reads it as null, and a write stamps 4 with it (Story 2.9)", (n) => {
    const raw = JSON.parse(v(n)) as Record<string, unknown>;
    delete raw["retro_result"];
    const r = parseLedger({ "units/story__1.5.json": JSON.stringify(raw) });
    if (!r.ok) throw new Error(r.error.message);
    const got = r.value.units.get("story:1.5");
    expect(got?.retro_result).toBeNull();
    if (got === undefined) throw new Error("no record");
    const text = serializeUnitRecord({ ...got, schema_version: 4 });
    expect(JSON.parse(text)).toMatchObject({ schema_version: 4, retro_result: null });
  });

  test("retro_result round-trips in key order after approved_graph; a bad item is invalid", () => {
    const result = {
      items: [{ globs: ["src/x/**"], blocking: true, route: "lane" as const, text: "Fix it", id: "epic-2-retro-item-1-fix-it" }],
      verdict: "accepted-with-open-items" as const,
    };
    const text = serializeUnitRecord(rec({ unit: "retro:2", retro_result: result }));
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    expect(keys.indexOf("retro_result")).toBe(keys.indexOf("approved_graph") + 1);
    expect(Object.keys(parsed["retro_result"] as object)).toEqual(["verdict", "items"]);
    expect(Object.keys((parsed["retro_result"] as { items: object[] }).items[0] as object)).toEqual(["id", "text", "route", "blocking", "globs"]);
    const r = parseLedger({ "units/retro__2.json": text });
    expect(r.ok && r.value.units.get("retro:2")?.retro_result).toEqual(result);
    const bad = text.replace("epic-2-retro-item-1-fix-it", "not-an-item");
    expect(parseLedger({ "units/retro__2.json": bad }).ok).toBe(false);
  });

  test.each([1, 2])("a schema_version %p record with no approved_graph reads it as null, and a write stamps 4 with it (Story 2.8)", (n) => {
    const raw = JSON.parse(v(n)) as Record<string, unknown>;
    delete raw["approved_graph"];
    const r = parseLedger({ "units/story__1.5.json": JSON.stringify(raw) });
    if (!r.ok) throw new Error(r.error.message);
    const got = r.value.units.get("story:1.5");
    expect(got?.approved_graph).toBeNull();
    if (got === undefined) throw new Error("no record");
    const text = serializeUnitRecord({ ...got, schema_version: 4 });
    expect(JSON.parse(text)).toMatchObject({ schema_version: 4, approved_graph: null });
  });

  test("approved_graph round-trips as sha256:<64 hex>; anything else is invalid", () => {
    const hash = `sha256:${"e".repeat(64)}`;
    const r = parseLedger({ "units/story__1.5.json": serializeUnitRecord(rec({ approved_graph: hash })) });
    expect(r.ok && r.value.units.get("story:1.5")?.approved_graph).toBe(hash);
    for (const bad of ["e".repeat(64), `sha256:${"E".repeat(64)}`, `sha256:${"e".repeat(63)}`]) {
      const b = parseLedger({ "units/story__1.5.json": serializeUnitRecord(rec({ approved_graph: bad })) });
      expect(b.ok).toBe(false);
    }
  });

  describe("park.graph_posted (retro item 24)", () => {
    const hash = `sha256:${"e".repeat(64)}`;
    const awaiting = { kind: "awaiting-approval" as const, reason: null, inbox_owner: "edanisko", globs_held: ["src/b.ts", "src/a.ts"] };
    const parkOf = (text: string) => (JSON.parse(text) as { park: Record<string, unknown> }).park;

    test("round-trips after globs_held, byte for byte", () => {
      const text = serializeUnitRecord(rec({ state: "parked", park: { ...awaiting, graph_posted: hash } }));
      expect(Object.keys(parkOf(text))).toEqual(["kind", "reason", "inbox_owner", "globs_held", "graph_posted"]);
      const r = parseLedger({ "units/story__1.5.json": text });
      if (!r.ok) throw new Error(r.error.message);
      const got = r.value.units.get("story:1.5");
      expect(got?.park?.graph_posted).toBe(hash);
      expect(serializeUnitRecord(got as never)).toBe(text);
    });

    test("a park with none posted has no graph_posted key, and a schema_version 5 park without it reads as none posted", () => {
      const text = serializeUnitRecord(rec({ state: "parked", park: awaiting }));
      expect(Object.keys(parkOf(text))).toEqual(["kind", "reason", "inbox_owner", "globs_held"]);
      const r = parseLedger({ "units/story__1.5.json": text });
      if (!r.ok) throw new Error(r.error.message);
      expect(r.value.units.get("story:1.5")?.park?.graph_posted).toBeUndefined();
    });

    test("a bad hash, or one on a park that is not awaiting approval, is invalid", () => {
      for (const park of [
        { ...awaiting, graph_posted: "e".repeat(64) },
        { ...awaiting, graph_posted: null },
        { kind: "blocked" as const, reason: "other" as const, inbox_owner: "alice", globs_held: [], graph_posted: hash },
      ]) {
        const raw = JSON.parse(serializeUnitRecord(rec({ state: "parked", park: awaiting }))) as Record<string, unknown>;
        const r = parseLedger({ "units/story__1.5.json": JSON.stringify({ ...raw, park }) });
        expect(r.ok === false && r.error.kind).toBe("invalid");
      }
    });
  });

  test("a tip mixing schema_version 2 and 6 records parses", () => {
    const r = parseLedger({ "units/story__1.5.json": v(2), "units/story__1.6.json": serializeUnitRecord(rec({ unit: "story:1.6" })), [COORDINATOR_PATH]: cv(2) });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.units.get("story:1.5")?.schema_version).toBe(2);
    expect(r.value.units.get("story:1.6")?.schema_version).toBe(6);
  });

  test("a tip mixing schema_version 1 and 6 records parses", () => {
    const r = parseLedger({ "units/story__1.5.json": v(1), "units/story__1.6.json": serializeUnitRecord(rec({ unit: "story:1.6" })), [COORDINATOR_PATH]: cv(1) });
    expect(r.ok).toBe(true);
  });

  const stop: readonly [string, Record<string, string>][] = [
    ["unit schema_version 7", { "units/story__1.5.json": v(7) }],
    ["unit schema_version 0", { "units/story__1.5.json": v(0) }],
    ["coordinator schema_version 7", { [COORDINATOR_PATH]: cv(7) }],
    ["coordinator schema_version 0", { [COORDINATOR_PATH]: cv(0) }],
    ["stop wins over an earlier invalid file", { "units/a__1.json": "{", "units/story__1.5.json": v(7) }],
  ];
  for (const [name, files] of stop) {
    test(`${name} -> stop`, () => {
      const r = parseLedger(files);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("stop");
      if (!r.ok) expect(r.error.message).toContain("this runner reads 1, 2, 3, 4, 5 and 6");
    });
  }

  const good = serializeUnitRecord(rec());
  const invalid: readonly [string, Record<string, string>][] = [
    ["bad JSON", { "units/story__1.5.json": "{" }],
    ["a JSON array", { "units/story__1.5.json": "[]" }],
    ["file-name/unit mismatch", { "units/story__1.6.json": good }],
    ["bad file name", { "units/story:1.5.json": good }],
    ["nested path", { "units/x/story__1.5.json": good }],
    ["bad park.reason", { "units/story__1.5.json": serializeUnitRecord(rec({ state: "parked", park: { kind: "blocked", reason: "x" as never, inbox_owner: "alice", globs_held: [] } })) }],
    ["park on a non-parked record", { "units/story__1.5.json": serializeUnitRecord(rec({ park: { kind: "needs-approval", reason: null, inbox_owner: "alice", globs_held: [] } })) }],
    ["string schema_version", { "units/story__1.5.json": good.replace('"schema_version": 6', '"schema_version": "5"') }],
    ["bad coordinator", { [COORDINATOR_PATH]: "{}" }],
  ];
  for (const [name, files] of invalid) {
    test(`${name} -> invalid`, () => {
      const r = parseLedger(files);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("invalid");
    });
  }
});
