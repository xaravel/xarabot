import { describe, expect, test } from "bun:test";
import { COORDINATOR_PATH, parseLedger, serializeCoordinator, serializeUnitRecord } from "../../../src/core/ledger/codec.ts";
import { COORD, rec, T0, tip } from "./fixtures.ts";

const COORDINATOR = {
  schema_version: 1 as const,
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
      builder_providers: ["codex", "claude", "codex"],
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
      "pr", "pr_owner", "base_sha", "head_sha", "reviewed_sha", "passed_sha", "approved_sha",
      "builder_providers", "park", "attempts", "loopbacks", "ci_fixes", "approval",
    ]);
    expect(parsed.globs).toEqual(["src/a/**", "src/b/**"]);
    expect(parsed.builder_providers).toEqual(["claude", "codex"]);
    expect(Object.keys(parsed.park)).toEqual(["kind", "reason", "inbox_owner", "globs_held"]);
    expect(parsed.park.globs_held).toEqual(["a.ts", "z.ts"]);
    expect(text).toContain('\n  "schema_version": 1,\n');
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
      rec({ state: "parked", park: { kind: "awaiting-approval", reason: null, inbox_owner: "alice", globs_held: ["a.ts", "b.ts"] }, builder_providers: ["claude"] }),
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

  const v = (n: number) => serializeUnitRecord(rec()).replace('"schema_version": 1', `"schema_version": ${n}`);
  const stop: readonly [string, Record<string, string>][] = [
    ["unit schema_version 2", { "units/story__1.5.json": v(2) }],
    ["unit schema_version 0", { "units/story__1.5.json": v(0) }],
    ["coordinator schema_version 2", { [COORDINATOR_PATH]: serializeCoordinator(COORDINATOR).replace('"schema_version": 1', '"schema_version": 2') }],
    ["coordinator schema_version 0", { [COORDINATOR_PATH]: serializeCoordinator(COORDINATOR).replace('"schema_version": 1', '"schema_version": 0') }],
    ["stop wins over an earlier invalid file", { "units/a__1.json": "{", "units/story__1.5.json": v(2) }],
  ];
  for (const [name, files] of stop) {
    test(`${name} -> stop`, () => {
      const r = parseLedger(files);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("stop");
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
    ["string schema_version", { "units/story__1.5.json": good.replace('"schema_version": 1', '"schema_version": "1"') }],
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
