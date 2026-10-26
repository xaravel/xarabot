import { describe, expect, test } from "bun:test";
import { addProvider, chooseReviewer, PROVIDERS, readProviders, REVIEWER_ORDER, sessionProvider, type Provider, type SessionAdapter } from "../../../src/core/review/reviewer.ts";
import type { AdapterName } from "../../../src/core/schemas/policy.ts";

describe("sessionProvider", () => {
  test.each([
    ["claude", "claude-opus-5-5", "anthropic"],
    ["claude", "claude-sonnet-5", "anthropic"],
    ["claude", "anything-at-all", "anthropic"],
    ["codex", "gpt-6.1-sol", "openai"],
    ["codex", "gpt-6-luna", "openai"],
    ["codex", "claude-opus-5-5", "openai"],
  ] as const)("%s with model %s: %s", (adapter, model, provider) => {
    expect(sessionProvider({ adapter, model })).toBe(provider);
  });

  test("every vendor id is lowercase and listed", () => {
    expect(PROVIDERS).toEqual(["anthropic", "openai"]);
    for (const p of PROVIDERS) expect(p).toMatch(/^[a-z]+$/);
    expect(REVIEWER_ORDER).toEqual(["claude", "codex"]);
  });
});

describe("addProvider", () => {
  test.each([
    [[], "anthropic", ["anthropic"]],
    [[], "openai", ["openai"]],
    [["anthropic"], "anthropic", ["anthropic"]],
    [["anthropic"], "openai", ["anthropic", "openai"]],
    [["openai"], "anthropic", ["anthropic", "openai"]],
    [["anthropic", "openai"], "openai", ["anthropic", "openai"]],
    [["zeta", "acme"], "openai", ["acme", "openai", "zeta"]],
    [["openai", "anthropic", "openai"], "anthropic", ["anthropic", "openai"]],
  ] as const)("%j + %s: %j", (set, p, want) => {
    expect(addProvider(set, p)).toEqual([...want]);
  });

  test("never removes, and leaves its input as it was", () => {
    const set = ["openai", "x-vendor"];
    const out = addProvider(set, "anthropic" satisfies Provider);
    expect(out).toEqual(["anthropic", "openai", "x-vendor"]);
    expect(set).toEqual(["openai", "x-vendor"]);
    expect(out).not.toBe(set);
  });
});

describe("readProviders (retro item 27)", () => {
  test.each([
    ["a legacy claude set", ["claude"], ["anthropic"]],
    ["a legacy codex set", ["codex"], ["openai"]],
    ["a legacy set of both", ["claude", "codex"], ["anthropic", "openai"]],
    ["a mixed set", ["anthropic", "codex"], ["anthropic", "openai"]],
    ["a mixed set, the same vendor twice", ["anthropic", "claude"], ["anthropic", "anthropic"]],
    ["a vendor set", ["anthropic", "openai"], ["anthropic", "openai"]],
    ["an unknown name", ["acme"], ["acme"]],
    ["an unknown name beside a legacy one", ["acme", "codex"], ["acme", "openai"]],
    ["a name only cased like a legacy one", ["Claude", "CODEX"], ["Claude", "CODEX"]],
    ["pi, no 0.x vendor", ["pi"], ["pi"]],
    ["an empty set", [], []],
  ] as const)("%s: %j -> %j", (_name, set, want) => {
    expect(readProviders(set)).toEqual([...want]);
  });

  test("leaves its input as it was", () => {
    const set = ["claude", "codex"];
    const out = readProviders(set);
    expect(out).toEqual(["anthropic", "openai"]);
    expect(set).toEqual(["claude", "codex"]);
    expect(out).not.toBe(set);
  });
});

describe("chooseReviewer", () => {
  const cross = (adapter: SessionAdapter) => ({ adapter, crossVendor: true });
  const same = (adapter: SessionAdapter) => ({ adapter, crossVendor: false });

  test.each([
    // agent-adapters.md § Cross-vendor review: claude → codex, codex → claude.
    ["cross, claude-built", ["anthropic"], ["claude", "codex"], cross("codex")],
    ["cross, codex-built", ["openai"], ["claude", "codex"], cross("claude")],
    ["cross, claude-built, policy order reversed", ["anthropic"], ["codex", "claude"], cross("codex")],
    ["cross, codex-built, policy order reversed", ["openai"], ["codex", "claude"], cross("claude")],
    ["both built", ["anthropic", "openai"], ["claude", "codex"], same("claude")],
    ["an empty set", [], ["claude", "codex"], cross("claude")],
    ["an unknown vendor only", ["acme"], ["claude", "codex"], cross("claude")],
    ["an unknown vendor and anthropic", ["acme", "anthropic"], ["claude", "codex"], cross("codex")],
    ["claude-only", ["anthropic"], ["claude"], same("claude")],
    ["claude-only, codex-built", ["openai"], ["claude"], cross("claude")],
    ["claude and pi", ["anthropic"], ["claude", "pi"], same("claude")],
    ["pi and claude", ["anthropic"], ["pi", "claude"], same("claude")],
    ["codex-only", ["openai"], ["codex"], same("codex")],
    ["codex-only, claude-built", ["anthropic"], ["codex"], cross("codex")],
    ["codex and pi, codex-built", ["openai"], ["codex", "pi"], same("codex")],
    ["neither: an empty policy", ["anthropic"], [], null],
    ["neither: pi only", ["openai"], ["pi"], null],
    ["neither, an empty set", [], [], null],
    // Retro item 27: runner-11 and earlier wrote adapter names, not vendors.
    ["a legacy claude set", ["claude"], ["claude", "codex"], cross("codex")],
    ["a legacy claude set, policy order reversed", ["claude"], ["codex", "claude"], cross("codex")],
    ["a legacy claude set, claude-only", ["claude"], ["claude"], same("claude")],
    ["a legacy codex set", ["codex"], ["claude", "codex"], cross("claude")],
    ["a legacy codex set, codex-only", ["codex"], ["codex"], same("codex")],
    ["a legacy set of both", ["claude", "codex"], ["claude", "codex"], same("claude")],
    ["a mixed set: anthropic and a legacy codex", ["anthropic", "codex"], ["claude", "codex"], same("claude")],
    ["a mixed set: a legacy claude and openai", ["claude", "openai"], ["claude", "codex"], same("claude")],
    ["a mixed set: a legacy claude and anthropic", ["anthropic", "claude"], ["claude", "codex"], cross("codex")],
    ["a mixed set: a legacy codex and openai", ["codex", "openai"], ["claude", "codex"], cross("claude")],
    ["an unknown name and a legacy claude", ["acme", "claude"], ["claude", "codex"], cross("codex")],
    ["a legacy name, neither allowed", ["claude"], ["pi"], null],
  ] as const)("%s: %j, %j", (_name, set, allowed, want) => {
    expect(chooseReviewer(set, allowed as readonly AdapterName[])).toEqual(want);
  });

  test("pi is never chosen, whatever the builders", () => {
    for (const set of [[], ["anthropic"], ["openai"], ["anthropic", "openai"]]) {
      expect(chooseReviewer(set, ["pi"])).toBeNull();
      expect(chooseReviewer(set, ["pi", "claude"])?.adapter).toBe("claude");
      expect(chooseReviewer(set, ["pi", "codex"])?.adapter).toBe("codex");
    }
  });

  test("never rewrites the set it reads", () => {
    const set = ["claude", "codex"];
    chooseReviewer(set, ["claude", "codex"]);
    expect(set).toEqual(["claude", "codex"]);
  });
});
