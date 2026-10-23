import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseSprintStatus } from "../../../src/core/next/sprint-status.ts";

const P = "sprint-status.yaml";

describe("parseSprintStatus", () => {
  const cases: { name: string; text: string; ok?: Record<string, string>; err?: RegExp }[] = [
    { name: "stock shape, other keys ignored", text: "# c\nproject: x\ndevelopment_status:\n  epic-1: backlog\n  1-1-a: done\naction_items: []\n", ok: { "epic-1": "backlog", "1-1-a": "done" } },
    { name: "no development_status", text: "project: x\n", ok: {} },
    { name: "bad YAML", text: "development_status: [\n", err: /invalid YAML/ },
    { name: "top level a list", text: "- a\n", err: /top level must be a YAML mapping/ },
    { name: "empty file", text: "", err: /top level must be a YAML mapping/ },
    { name: "a non-string status", text: "development_status:\n  1-1-a: [done]\n", err: /development_status\.1-1-a/ },
    { name: "development_status a list", text: "development_status: [a]\n", err: /development_status/ },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const r = parseSprintStatus(P, c.text);
      if (c.ok !== undefined) {
        expect(r).toEqual({ ok: true, value: { development_status: c.ok } });
      } else {
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.kind).toBe("invalid");
          expect(r.error.message).toMatch(c.err as RegExp);
        }
      }
    });
  }

  test("this repo's sprint-status.yaml", async () => {
    const path = join(import.meta.dir, "../../../_bmad-output/implementation-artifacts/sprint-status.yaml");
    const r = parseSprintStatus(P, await Bun.file(path).text());
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.development_status["1-1-package-scaffold-and-test-harness"]).toBe("done");
  });
});
