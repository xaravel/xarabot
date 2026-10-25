import { describe, expect, test } from "bun:test";
import { parseRetroGates } from "../../../src/core/graph/retro-gates.ts";

const P = "_bmad-output/implementation-artifacts/retro-gates.yaml";

const RETRO_REJECTED = [
  "schema_version: 1",
  "epics:",
  "  2:",
  "    retro:",
  "      verdict: rejected",
  '      unit: "retro:2"',
  "      recorded_at: 2026-11-01T10:00:00Z",
  "      go:",
  "        by: edanisko",
  "        at: 2026-11-02T09:00:00Z",
  "        ruling: RULING",
  "    items:",
  "      - id: epic-2-retro-item-1-fix-polling",
  "        text: Fix CI polling",
  "        route: lane",
  "        blocking: true",
  "        globs: [./src/lane/**]",
  "        status: open",
  "  3:",
  "    checkpoint:",
  "      go: {by: edanisko, at: 2026-11-03T09:00:00Z, ruling: maintainer-pr}",
];

function file(ruling = '"4512345"', replace?: [string, string]): string {
  let text = `${RETRO_REJECTED.join("\n").replace("RULING", ruling)}\n`;
  if (replace !== undefined) text = text.replace(replace[0], replace[1]);
  return text;
}

describe("parseRetroGates", () => {
  test.each([['"4512345"', "4512345"], ["maintainer-pr", "maintainer-pr"]])("rejected retro's go with ruling %s", (ruling, expected) => {
    const r = parseRetroGates(P, file(ruling));
    if (!r.ok) throw new Error(r.error.message);
    const two = r.value.epics["2"];
    expect(two?.retro?.go).toEqual({ by: "edanisko", at: "2026-11-02T09:00:00Z", ruling: expected });
    expect(two?.items?.[0]?.globs).toEqual(["src/lane/**"]);
    expect(r.value.epics["3"]?.checkpoint?.go.ruling).toBe("maintainer-pr");
  });

  test.each(["epic-2-retro-item-3-add-a-retro_result-test", "epic-2-retro-item-4-réviser-l-écran-日本"])("an item id the stock slug makes: %s", (id) => {
    const r = parseRetroGates(P, file(undefined, ["epic-2-retro-item-1-fix-polling", `"${id}"`]));
    expect(r.ok && r.value.epics["2"]?.items?.[0]?.id).toBe(id);
  });

  test("retro with no go yet, and an empty file shape", () => {
    const noGo = parseRetroGates(P, file(undefined, ['      go:\n        by: edanisko\n        at: 2026-11-02T09:00:00Z\n        ruling: "4512345"\n', ""]));
    expect(noGo.ok && noGo.value.epics["2"]?.retro).toEqual({ verdict: "rejected", unit: "retro:2", recorded_at: "2026-11-01T10:00:00Z" });
    expect(parseRetroGates(P, "schema_version: 1\nepics: {}\n")).toEqual({ ok: true, value: { schema_version: 1, epics: {} } });
  });

  const bad: readonly [string, string, string][] = [
    ["go on accepted", file(undefined, ["verdict: rejected", "verdict: accepted"]), "go is allowed only for a rejected verdict"],
    ["unit under another key", file(undefined, ['unit: "retro:2"', 'unit: "retro:3"']), 'must be "retro:2"'],
    ["bad unit", file(undefined, ['unit: "retro:2"', "unit: story:2"]), "retro:<N>"],
    ["bad id", file(undefined, ["epic-2-retro-item-1-fix-polling", "item-1"]), "epic-<N>-retro-item"],
    ["id under another key", file(undefined, ["epic-2-retro-item-1-fix-polling", "epic-3-retro-item-1-fix"]), 'must start with "epic-2-"'],
    ["bad status", file(undefined, ["status: open", "status: closed"]), "status"],
    ["bad route", file(undefined, ["route: lane", "route: bot"]), "route"],
    ["bad glob", file(undefined, ["[./src/lane/**]", "[../x]"]), "glob"],
    ["numeric ruling", file("4512345"), "ruling"],
    ["bad login", file(undefined, ["by: edanisko\n        at", "by: -bad\n        at"]), "GitHub login"],
    ["bad date", file(undefined, ["recorded_at: 2026-11-01T10:00:00Z", "recorded_at: yesterday"]), "date-time"],
    ["extra entry key", file(undefined, ["  3:\n", "  3:\n    notes: x\n"]), "notes"],
    ["duplicate key", file(undefined, ["  3:\n", "  2:\n"]), "duplicate"],
    [
      "repeated item id",
      file(undefined, ["        status: open\n", "        status: open\n      - id: epic-2-retro-item-1-fix-polling\n        text: Again\n        route: lane\n        blocking: false\n        globs: []\n        status: done\n"]),
      'repeats item id "epic-2-retro-item-1-fix-polling"',
    ],
    ["wrong version", "schema_version: 2\nepics: {}\n", "unsupported schema_version"],
  ];
  test.each(bad)("%s is refused", (_name, text, fragment) => {
    const r = parseRetroGates(P, text);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message.startsWith(`${P}: `)).toBe(true);
      expect(r.error.message).toContain(fragment);
    }
  });
});
