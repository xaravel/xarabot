import { describe, expect, test } from "bun:test";
import { err, ok, type Result } from "../../src/core/result.ts";

describe("Result", () => {
  test("ok carries the value", () => {
    const r: Result<number> = ok(3);
    expect(r).toEqual({ ok: true, value: 3 });
  });

  test("err carries kind and message", () => {
    const r: Result<number, "not-found"> = err("not-found", "no such unit");
    expect(r).toEqual({ ok: false, error: { kind: "not-found", message: "no such unit" } });
  });

  test("narrows on ok", () => {
    const cases: readonly Result<string, "bad">[] = [ok("a"), err("bad", "b")];
    const seen = cases.map((r) => (r.ok ? `value:${r.value}` : `error:${r.error.kind}:${r.error.message}`));
    expect(seen).toEqual(["value:a", "error:bad:b"]);
  });
});
