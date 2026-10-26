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
    expect(text).toContain('\n  "schema_version": 5,\n');
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

  const v = (n: number) => serializeUnitRecord(rec()).replace('"schema_version": 5', `"schema_version": ${n}`);
  const cv = (n: number) => serializeCoordinator(COORDINATOR).replace('"schema_version": 2', `"schema_version": ${n}`);

  test.each([1, 2, 3, 4, 5])("unit and coordinator records at schema_version %p both parse (Stories 2.7, 2.8, 2.9, 3.5)", (n) => {
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

  test("a tip mixing schema_version 2 and 5 records parses", () => {
    const r = parseLedger({ "units/story__1.5.json": v(2), "units/story__1.6.json": serializeUnitRecord(rec({ unit: "story:1.6" })), [COORDINATOR_PATH]: cv(2) });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.units.get("story:1.5")?.schema_version).toBe(2);
    expect(r.value.units.get("story:1.6")?.schema_version).toBe(5);
  });

  test("a tip mixing schema_version 1 and 5 records parses", () => {
    const r = parseLedger({ "units/story__1.5.json": v(1), "units/story__1.6.json": serializeUnitRecord(rec({ unit: "story:1.6" })), [COORDINATOR_PATH]: cv(1) });
    expect(r.ok).toBe(true);
  });

  const stop: readonly [string, Record<string, string>][] = [
    ["unit schema_version 6", { "units/story__1.5.json": v(6) }],
    ["unit schema_version 0", { "units/story__1.5.json": v(0) }],
    ["coordinator schema_version 6", { [COORDINATOR_PATH]: cv(6) }],
    ["coordinator schema_version 0", { [COORDINATOR_PATH]: cv(0) }],
    ["stop wins over an earlier invalid file", { "units/a__1.json": "{", "units/story__1.5.json": v(6) }],
  ];
  for (const [name, files] of stop) {
    test(`${name} -> stop`, () => {
      const r = parseLedger(files);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("stop");
      if (!r.ok) expect(r.error.message).toContain("this runner reads 1, 2, 3, 4 and 5");
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
    ["string schema_version", { "units/story__1.5.json": good.replace('"schema_version": 5', '"schema_version": "5"') }],
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
