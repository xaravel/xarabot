import { describe, expect, test } from "bun:test";
import { unattendedRefusal } from "../../../src/core/lane/runner.ts";
import { allowanceRefusal } from "../../../src/core/review/allowance.ts";
import type { AdapterName } from "../../../src/core/schemas/policy.ts";

const NO_REVIEWER = "no reviewer: .xarabot/policy.yaml unattended_adapters allows neither claude nor codex";

describe("allowanceRefusal (Story 3.5)", () => {
  const refusal = (allowed: readonly AdapterName[], agent: string) => {
    const r = unattendedRefusal({ unattended_adapters: [...allowed] }, agent);
    return r.ok ? null : r.error.message;
  };
  test.each([
    ["claude allowed, claude lane", ["claude"], "claude", [], null],
    ["claude allowed, claude lane, a unit claude built", ["claude"], "claude", ["anthropic"], null],
    ["both allowed, codex lane, a unit both built", ["claude", "codex"], "codex", ["anthropic", "openai"], null],
    ["an empty set of builders is no special case", ["codex"], "codex", [], null],
    ["the lane's agent dropped from the policy", ["codex"], "claude", ["anthropic"], refusal(["codex"], "claude")],
    ["an empty policy", [], "claude", [], refusal([], "claude")],
    ["the agent allowed, but no reviewer: pi only besides", ["pi"], "pi", [], NO_REVIEWER],
  ] as const)("%s", (_name, allowed, agent, builders, want) => {
    expect(allowanceRefusal({ unattended_adapters: [...allowed] }, agent, builders)).toBe(want);
  });
  test("the agent refusal is unattendedRefusal's text, naming the allowed adapters", () => {
    expect(allowanceRefusal({ unattended_adapters: ["codex"] }, "claude", [])).toBe("agent claude is not in .xarabot/policy.yaml unattended_adapters (allowed: codex)");
  });
});
