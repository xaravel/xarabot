import { describe, expect, test } from "bun:test";
import { checkGraphChange } from "../../../src/core/graph/graph-gate.ts";
import { parseRetroGates } from "../../../src/core/graph/retro-gates.ts";
import { renderDigest } from "../../../src/core/inbox/render-digest.ts";
import { planningDue } from "../../../src/core/next/coordinator.ts";
import { next, type NextOutcome } from "../../../src/core/next/next.ts";
import { editRetroGates } from "../../../src/core/reconcile/retro-gates-edit.ts";
import type { CoordinatorRecord } from "../../../src/core/schemas/ledger.ts";
import { GRAPH_RETRO_GATES, graphFiles, treeOf } from "../../lane/graph-stub.ts";
import { COORD } from "../ledger/fixtures.ts";
import { NOW, RETRO, rec, snapshotOf, storyRec, type World } from "./fixtures.ts";

/**
 * Story 4.4's checkpoints (FR5, AR12, AR13, AR14, AD-12). Chain 1 → 2 → 3 → 4,
 * and Epic 5 depends on nothing. Epic 2 is a checkpoint, its Story is `done`,
 * and its retro is recorded, unless a row says otherwise. NOW is
 * 2026-10-22T10:10:00Z; the fixtures' retros are recorded 2026-10-20.
 */

const YAML_CHECKPOINT = "version: 1\nepics:\n  2:\n    checkpoint: true\n  5:\n    depends_on: []\n";
const YAML_PLAIN = "version: 1\nepics:\n  5:\n    depends_on: []\n";

function chain(over: Partial<World> = {}): World {
  return {
    epics: { 1: ["1"], 2: ["1"], 3: ["1", "2"], 4: ["1"], 5: ["1"] },
    status: { "1.1": "done", "2.1": "done" },
    retro: { 1: "accepted", 2: "accepted" },
    epicsYaml: YAML_CHECKPOINT,
    ...over,
  };
}

const pick = (w: World) => next(snapshotOf(w), "builder");

/** The chosen Story id (`unit 3.1`, or `take_over 3.2 claimed`), or the outcome kind when none was chosen. */
function chosen(o: NextOutcome): string {
  if (o.kind === "unit" && o.story.take_over !== null) return `take_over ${o.story.story_id} ${o.story.take_over}`;
  return o.kind === "unit" || o.kind === "park" ? `${o.kind} ${o.story.story_id}` : o.kind;
}

const codes = (o: NextOutcome) => (o.kind === "stop" ? [] : o.reasons.map((r) => `${r.subject} ${r.code}`));
/** The checkpoint reasons, each as `<subject> <maintainer|lane>: <message>`. */
const checkpointReasons = (o: NextOutcome) =>
  o.kind === "stop" ? [] : o.reasons.filter((r) => r.code === "checkpoint").map((r) => `${r.subject} ${r.maintainer === true ? "maintainer" : "lane"}: ${r.message}`);

const NO_GO = (n: number) => `Epic ${n} is held by checkpoint Epic 2 (checkpoint:2), which has no go`;
const NOT_DONE = (n: number) => `Epic ${n} is held by checkpoint Epic 2 (checkpoint:2), whose retro is not done`;
const HELD = [`epic:3 maintainer: ${NO_GO(3)}`, `epic:4 maintainer: ${NO_GO(4)}`];
/** NOW minus 40 min: a stale heartbeat. */
const STALE = "2026-10-22T09:30:00Z";

describe("checkpoints: builder next (AC 1, 3, 4)", () => {
  const cases: { name: string; world: World; expect: string; codes: string[]; checkpoint: string[] }[] = [
    {
      name: "no go: Epics 3 (d1) and 4 (d2) held by checkpoint, as Maintainer causes; Epic 5 picked",
      world: chain(),
      expect: "unit 5.1",
      codes: ["epic:3 checkpoint", "epic:4 dependency-epic", "epic:4 checkpoint"],
      checkpoint: HELD,
    },
    {
      name: "go recorded: Story 3.1 picked, no checkpoint reason",
      world: chain({ checkpointGo: [2] }),
      expect: "unit 3.1",
      codes: ["epic:4 dependency-epic"],
      checkpoint: [],
    },
    {
      name: "in flight: a fresh claimed 3.1 keeps its record and 3.2 is not picked",
      world: chain({ records: [storyRec("3.1", { generation: 3 })] }),
      expect: "unit 5.1",
      codes: ["epic:3 checkpoint", "epic:4 dependency-epic", "epic:4 checkpoint"],
      checkpoint: HELD,
    },
    {
      name: "stale in flight: a stale claimed 3.2 is taken over, the hold among the reasons",
      world: chain({ records: [storyRec("3.2", { generation: 5, heartbeat_at: STALE })] }),
      expect: "take_over 3.2 claimed",
      codes: ["epic:3 checkpoint", "epic:4 dependency-epic", "epic:4 checkpoint"],
      checkpoint: HELD,
    },
    {
      name: "stale in flight: a stale builder-held merging 3.2 is taken over, the hold among the reasons",
      world: chain({ records: [storyRec("3.2", { state: "merging", pr: 7, generation: 5, heartbeat_at: STALE })] }),
      expect: "take_over 3.2 merging",
      codes: ["epic:3 checkpoint", "epic:4 dependency-epic", "epic:4 checkpoint"],
      checkpoint: HELD,
    },
    {
      name: "retro not done: 3 and 4 held by checkpoint, not as Maintainer causes, alongside the dependency hold",
      world: chain({ retro: { 1: "accepted" } }),
      expect: "unit 5.1",
      codes: ["epic:3 dependency-epic", "epic:3 checkpoint", "epic:4 dependency-epic", "epic:4 checkpoint"],
      checkpoint: [`epic:3 lane: ${NOT_DONE(3)}`, `epic:4 lane: ${NOT_DONE(4)}`],
    },
    {
      name: "bootstrapped C: 2 bootstrapped with no retro record holds 3 and 4, as Maintainer causes",
      world: chain({ bootstrapped: [2], retro: { 1: "accepted" } }),
      expect: "unit 5.1",
      codes: ["epic:3 checkpoint", "epic:4 dependency-epic", "epic:4 checkpoint"],
      checkpoint: HELD,
    },
    {
      name: "retired: checkpoint: true removed with the go kept holds nothing",
      world: chain({ epicsYaml: YAML_PLAIN, checkpointGo: [2] }),
      expect: "unit 3.1",
      codes: ["epic:4 dependency-epic"],
      checkpoint: [],
    },
    {
      name: "C's own retro rejected with no go: 3 and 4 get both a checkpoint and a retro-rejected reason, both Maintainer causes",
      world: chain({ retro: { 1: "accepted", 2: "rejected" } }),
      expect: "unit 5.1",
      codes: ["epic:3 checkpoint", "epic:3 retro-rejected", "epic:4 dependency-epic", "epic:4 checkpoint", "epic:4 retro-rejected"],
      checkpoint: HELD,
    },
    {
      name: "C itself is never held by its own checkpoint, and an Epic not reaching C never is",
      world: chain({ status: { "1.1": "done" }, retro: { 1: "accepted" } }),
      expect: "unit 2.1",
      codes: ["epic:3 dependency-epic", "epic:3 checkpoint", "epic:4 dependency-epic", "epic:4 checkpoint"],
      checkpoint: [`epic:3 lane: ${NOT_DONE(3)}`, `epic:4 lane: ${NOT_DONE(4)}`],
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const o = pick(c.world);
      expect(chosen(o)).toBe(c.expect);
      expect(codes(o)).toEqual(c.codes);
      expect(checkpointReasons(o)).toEqual(c.checkpoint);
    });
  }

  test("in flight: the fresh claimed 3.1's record is unchanged", () => {
    const records = [storyRec("3.1", { generation: 3 })];
    const snap = snapshotOf(chain({ records }));
    next(snap, "builder");
    expect(snap.ledger.units.find((r) => r.unit === "story:3.1")).toEqual(records[0]);
  });

  test("only held: a lane idle only for the checkpoint is waiting on the Maintainer", () => {
    // Epic 5 done too, and no Epic 4.
    const o = pick(chain({ epics: { 1: ["1"], 2: ["1"], 3: ["1", "2"], 5: ["1"] }, status: { "1.1": "done", "2.1": "done", "5.1": "done" } }));
    expect(o).toEqual({
      kind: "idle",
      reason: `waiting-on-maintainer: ${NO_GO(3)}`,
      reasons: [{ subject: "epic:3", code: "checkpoint", message: NO_GO(3), maintainer: true }],
    });
  });

  test("only held, the full chain: Epic 4's wait on held Epic 3 is a Maintainer cause too, so the lane waits on the Maintainer", () => {
    const o = pick(chain({ status: { "1.1": "done", "2.1": "done", "5.1": "done" } }));
    const WAITS = "Epic 4 waits on Epic 3: Story 3.1 is not done (no status), Story 3.2 is not done (no status), its retro is not recorded";
    expect(o).toEqual({
      kind: "idle",
      reason: `waiting-on-maintainer: ${NO_GO(3)}; ${WAITS}; ${NO_GO(4)}`,
      reasons: [
        { subject: "epic:3", code: "checkpoint", message: NO_GO(3), maintainer: true },
        { subject: "epic:4", code: "dependency-epic", message: WAITS, maintainer: true },
        { subject: "epic:4", code: "checkpoint", message: NO_GO(4), maintainer: true },
      ],
    });
  });

  test("only held, a deeper chain: every Epic past the checkpoint waits on the Maintainer", () => {
    const o = pick(chain({ epics: { 1: ["1"], 2: ["1"], 3: ["1"], 4: ["1"], 5: ["1"], 6: ["1"] }, status: { "1.1": "done", "2.1": "done", "5.1": "done" }, epicsYaml: "version: 1\nepics:\n  2:\n    checkpoint: true\n  5:\n    depends_on: []\n  6:\n    depends_on: [4]\n" }));
    expect(o.kind === "idle" ? o.reason.startsWith("waiting-on-maintainer: ") : o.kind).toBe(true);
    expect(codes(o)).toEqual(["epic:3 checkpoint", "epic:4 dependency-epic", "epic:4 checkpoint", "epic:6 dependency-epic", "epic:6 checkpoint"]);
  });

  test("only held by a rejected retro, no checkpoint: Epic 4's wait on held Epic 3 is a Maintainer cause too", () => {
    const o = pick(chain({ epicsYaml: YAML_PLAIN, retro: { 1: "accepted", 2: "rejected" }, status: { "1.1": "done", "2.1": "done", "5.1": "done" } }));
    expect(o.kind === "idle" ? o.reason.startsWith("waiting-on-maintainer: ") : o.kind).toBe(true);
    expect(codes(o)).toEqual(["epic:3 retro-rejected", "epic:4 dependency-epic", "epic:4 retro-rejected"]);
  });

  test("only held, with a lane cause too: Epic 4 also waits on Epic 6's retro, which no go releases", () => {
    // Epic 6 depends on nothing and its Story is done, but its retro is not recorded.
    const o = pick(
      chain({
        epics: { 1: ["1"], 2: ["1"], 3: ["1"], 4: ["1"], 5: ["1"], 6: ["1"] },
        status: { "1.1": "done", "2.1": "done", "5.1": "done", "6.1": "done" },
        epicsYaml: "version: 1\nepics:\n  2:\n    checkpoint: true\n  4:\n    depends_on: [3, 6]\n  5:\n    depends_on: []\n  6:\n    depends_on: []\n",
      }),
    );
    expect(o.kind === "idle" ? o.reason : o.kind).toBe(
      `${NO_GO(3)}; Epic 4 waits on Epic 3: Story 3.1 is not done (no status), its retro is not recorded; Epic 4 waits on Epic 6: its retro is not recorded; ${NO_GO(4)}`,
    );
    expect(o.kind === "stop" ? [] : o.reasons.filter((r) => r.code === "dependency-epic").map((r) => r.maintainer === true)).toEqual([true, false]);
  });

  test("only held, the held Epic's Stories done but its retro not: Epic 4's wait on that retro is a lane cause", () => {
    // Epic 3 is finished, so the checkpoint no longer holds it; Epic 4 waits on Epic 3's retro, which the coordinator runs.
    const o = pick(chain({ status: { "1.1": "done", "2.1": "done", "3.1": "done", "3.2": "done", "5.1": "done" } }));
    expect(o.kind === "idle" ? o.reason : o.kind).toBe(`Epic 4 waits on Epic 3: its retro is not recorded; ${NO_GO(4)}`);
  });

  test("dependents already finished when the checkpoint is added: nothing is held, the lane has nothing left", () => {
    const o = pick(chain({ status: { "1.1": "done", "2.1": "done", "3.1": "done", "3.2": "done", "4.1": "done", "5.1": "done" }, retro: { 1: "accepted", 2: "accepted", 3: "accepted" } }));
    expect(o).toEqual({ kind: "idle", reason: "no Story left to build", reasons: [] });
  });

  test("a finished dependent is not held, an unfinished one past it still is", () => {
    const o = pick(chain({ status: { "1.1": "done", "2.1": "done", "3.1": "done", "3.2": "done" }, retro: { 1: "accepted", 2: "accepted", 3: "accepted" } }));
    expect(chosen(o)).toBe("unit 5.1");
    expect(checkpointReasons(o)).toEqual([`epic:4 maintainer: ${NO_GO(4)}`]);
  });

  test("late checkpoint: the same retro, first without and then with checkpoint: true; the hold starts on the next call", () => {
    const before = pick(chain({ epicsYaml: YAML_PLAIN }));
    expect(chosen(before)).toBe("unit 3.1");
    expect(checkpointReasons(before)).toEqual([]);
    const after = pick(chain());
    expect(chosen(after)).toBe("unit 5.1");
    expect(checkpointReasons(after)).toEqual(HELD);
  });

  test("retro not done, lane idle while C's Story is in flight: not waiting on the Maintainer", () => {
    const o = pick(chain({ epics: { 1: ["1"], 2: ["1"], 3: ["1"], 5: ["1"] }, status: { "1.1": "done", "5.1": "done" }, retro: { 1: "accepted" }, records: [storyRec("2.1")] }));
    expect(o.kind === "idle" ? o.reason : o.kind).toBe(
      `story:2.1 is claimed; Epic 3 waits on Epic 2: Story 2.1 is not done (no status), its retro is not recorded; ${NOT_DONE(3)}`,
    );
  });

  test("a coordinator-held stale merging 3.2 is not taken over", () => {
    const o = pick(chain({ records: [storyRec("3.2", { state: "merging", pr: 7, ...COORD, heartbeat_at: STALE })] }));
    expect(chosen(o)).toBe("unit 5.1");
  });
});

describe("checkpoints: coordinator next never returns a checkpoint unit (AC 2)", () => {
  /** A live coordinator claim with today's digest posted, so the digest slot is no work. */
  const coordinator: CoordinatorRecord = {
    schema_version: 2,
    owner: COORD.owner,
    host: COORD.host,
    lane: "coordinator",
    generation: 1,
    heartbeat_at: NOW,
    digest_posted_at: "2026-10-22T08:00:00Z",
    rulings_cursor: null,
  };
  const reconciled = rec({ unit: "reconcile:4", ...COORD, globs: [], state: "merged", heartbeat_at: "2026-10-22T10:09:00Z" });
  const planned = { "epic-2": "done", "2.1": "done", "1.1": "done", "epic-3": "backlog", "3.1": "backlog", "3.2": "backlog", "epic-4": "backlog", "4.1": "backlog", "epic-5": "backlog", "5.1": "backlog" };
  const coordWorld = (over: Partial<World> = {}): World => chain({ role: "coordinator", coordinator, records: [reconciled], status: planned, ...over });

  // No checkpoint unit ever runs: see "a checkpoint record with its PR open is never a coordinator unit" in coordinator.test.ts.

  test("a held Epic's missing context is not due for status planning; with the go it is", () => {
    const held = planningDue(snapshotOf(coordWorld({ contexts: { 3: null } })));
    expect(held.status.contexts).toEqual([]);
    const released = planningDue(snapshotOf(coordWorld({ contexts: { 3: null }, checkpointGo: [2] })));
    expect(released.status.contexts).toEqual([3]);
    const o = next(snapshotOf(coordWorld({ contexts: { 3: null }, checkpointGo: [2] })), "coordinator");
    expect(o.kind === "coordinator" ? o.unit.kind : o.kind).toBe("planning");
  });
});

describe("checkpoints: the Maintainer's digest (AC 2, 4)", () => {
  const REPO = "https://github.com/xaravel/xarabot";
  const GATES = `${REPO}/blob/main/${RETRO}`;
  const lines = (w: World) => {
    const d = renderDigest({ snapshot: snapshotOf(w), files: {}, repoUrl: REPO });
    return (d.get("edanisko")?.body ?? "").split("\n").filter((l) => l.startsWith("- "));
  };

  const cases: { name: string; world: World; lines: string[] }[] = [
    {
      name: "retro done, no go: checkpoint:2 once, with its age and the go verb",
      world: chain(),
      lines: [`- [checkpoint:2](${GATES}) · Epic 2's retro is recorded (accepted) · 2d · \`/xarabot go checkpoint:2\``],
    },
    { name: "go recorded: nothing for Epic 2", world: chain({ checkpointGo: [2] }), lines: [] },
    {
      name: "C's own retro rejected with no go: both the checkpoint go and the retro go",
      world: chain({ retro: { 1: "accepted", 2: "rejected" } }),
      lines: [
        `- [checkpoint:2](${GATES}) · Epic 2's retro is recorded (rejected) · 2d · \`/xarabot go checkpoint:2\``,
        `- [retro:2](${GATES}) · rejected, no go · 2d · \`/xarabot go retro:2\``,
      ],
    },
    { name: "retro not done: the go is not due, nothing listed", world: chain({ retro: { 1: "accepted" } }), lines: [] },
    {
      name: "bootstrapped C with no retro record: listed as bootstrapped, with no age",
      world: chain({ bootstrapped: [2], retro: { 1: "accepted" } }),
      lines: [`- [checkpoint:2](${GATES}) · Epic 2 is bootstrapped · \`/xarabot go checkpoint:2\``],
    },
    {
      name: "bootstrapped C with a retro record: the recorded line and age",
      world: chain({ bootstrapped: [2] }),
      lines: [`- [checkpoint:2](${GATES}) · Epic 2's retro is recorded (accepted) · 2d · \`/xarabot go checkpoint:2\``],
    },
    { name: "bootstrapped C with a go: nothing listed", world: chain({ bootstrapped: [2], retro: { 1: "accepted" }, checkpointGo: [2] }), lines: [] },
    { name: "retired with the go kept: nothing listed", world: chain({ epicsYaml: YAML_PLAIN, checkpointGo: [2] }), lines: [] },
  ];
  for (const c of cases) {
    test(c.name, () => {
      expect(lines(c.world)).toEqual(c.lines);
    });
  }
});

describe("checkpoints: the graph gate on a retired checkpoint (AC 5)", () => {
  const YAML = ".xarabot/epics.yaml";
  const EPICS = { 1: ["1.1"], 2: ["2.1"], 3: ["3.1", "3.2"], 4: ["4.1"], 5: ["5.1"] };
  const RETRO_2 = 'schema_version: 1\nepics:\n  2:\n    retro:\n      verdict: accepted\n      unit: "retro:2"\n      recorded_at: "2026-10-20T00:00:00Z"\n';
  const GO = '    checkpoint:\n      go:\n        by: edanisko\n        at: "2026-10-21T00:00:00Z"\n        ruling: maintainer-pr\n';
  const main = (gates: string) => graphFiles(EPICS, { [YAML]: YAML_CHECKPOINT, [GRAPH_RETRO_GATES]: gates });
  const retired = (gates: string): Record<string, string> => ({ ...main(gates), [YAML]: YAML_PLAIN });

  const cases: { name: string; gates: string; refusals: string[] }[] = [
    { name: "retired without go: refused", gates: RETRO_2, refusals: ["Epic 2's checkpoint is removed, but its go is not recorded"] },
    { name: "retired with go: allowed", gates: `${RETRO_2}${GO}`, refusals: [] },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const r = checkGraphChange({ main: treeOf(main(c.gates)), merged: treeOf(retired(c.gates)), ledgerUnits: [] });
      if (r.kind !== "checked") throw new Error(`${r.kind}: ${r.message}`);
      expect(r.refusals).toEqual(c.refusals);
      expect(r.changed).toBe(true);
      expect(r.delta.checkpointsRemoved).toEqual([2]);
      expect(r.delta.holds).toEqual([]);
    });
  }

  test("retired with go: reconcile's rewrite of retro-gates.yaml keeps Epic 2's checkpoint go", () => {
    // Epic 2 is no longer a checkpoint; reconcile rewrites the file for an unrelated change: Epic 3's item ruled done.
    const item = "epic-3-retro-item-1-x";
    const text = `${RETRO_2}${GO}  3:\n    items:\n      - id: ${item}\n        text: Do it.\n        route: maintainer\n        blocking: false\n        globs: []\n        status: waiting\n`;
    const before = parseRetroGates(GRAPH_RETRO_GATES, text);
    if (!before.ok) throw new Error(before.error.message);
    const edit = editRetroGates(GRAPH_RETRO_GATES, text, [], [], [{ epic: 3, id: item, status: "done" }]);
    if (!edit.ok) throw new Error(edit.error.message);
    expect(edit.value.summary).toEqual([`epics.3.items: ${item} waiting -> done`]);
    const after = parseRetroGates(GRAPH_RETRO_GATES, edit.value.text);
    if (!after.ok) throw new Error(after.error.message);
    expect(after.value.epics["3"]?.items?.[0]?.status).toBe("done");
    expect(after.value.epics["2"]?.checkpoint).toEqual({ go: { by: "edanisko", at: "2026-10-21T00:00:00Z", ruling: "maintainer-pr" } });
    expect(after.value.epics["2"]?.checkpoint).toEqual(before.value.epics["2"]?.checkpoint);
  });

  test("the delta reports the same reach as the hold: an unrecorded checkpoint holds 3 and 4, not 5", () => {
    const files = main(RETRO_2);
    const r = checkGraphChange({ main: treeOf(files), merged: treeOf(files), ledgerUnits: [] });
    if (r.kind !== "checked") throw new Error(`${r.kind}: ${r.message}`);
    expect(r.delta.holds).toEqual([{ checkpoint: 2, epics: [3, 4] }]);
  });
});
