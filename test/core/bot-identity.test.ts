import { describe, expect, test } from "bun:test";
import { botIdentity, isBotIdentity } from "../../src/core/bot-identity.ts";

describe("botIdentity", () => {
  test("edanisko, 123", () => {
    expect(botIdentity("edanisko", 123)).toEqual({
      ok: true,
      value: { name: "edanisko-xarabot[bot]", email: "123+edanisko-xarabot[bot]@users.noreply.github.com" },
    });
  });
  const bad: readonly [string, number][] = [
    ["", 1],
    ["-x", 1],
    ["a--b", 1],
    ["a b", 1],
    ["x".repeat(40), 1],
    ["ok", 0],
    ["ok", -1],
    ["ok", 1.5],
    ["ok", Number.NaN],
    ["ok", Number.POSITIVE_INFINITY],
  ];
  for (const [login, id] of bad) {
    test(`refuses ${JSON.stringify(login)}, ${id}`, () => {
      const r = botIdentity(login, id);
      expect(r.ok ? "ok" : r.error.kind).toBe("invalid");
    });
  }
});

describe("isBotIdentity", () => {
  test("accepts what botIdentity returns", () => {
    const r = botIdentity("a-b", 42);
    if (!r.ok) throw new Error("unexpected");
    expect(isBotIdentity(r.value)).toBe(true);
  });
  const bad: readonly { name: string; email: string }[] = [
    { name: "a[bot]", email: "1+a[bot]@users.noreply.github.com" },
    { name: "a-xarabot[bot]", email: "1+b-xarabot[bot]@users.noreply.github.com" },
    { name: "a-xarabot[bot]", email: "0+a-xarabot[bot]@users.noreply.github.com" },
    { name: "a-xarabot[bot]", email: "a-xarabot[bot]@users.noreply.github.com" },
    { name: "a-xarabot[bot]", email: "1+a-xarabot[bot]@example.com" },
    { name: "Someone", email: "s@x" },
  ];
  for (const id of bad) test(`refuses ${id.name} <${id.email}>`, () => expect(isBotIdentity(id)).toBe(false));
});
