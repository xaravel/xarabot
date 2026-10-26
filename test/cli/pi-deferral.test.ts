import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CredentialEnv } from "../../src/adapters/forge/github/credentials.ts";
import { AGENT_COMMANDS, laneTools } from "../../src/cli/lane-install.ts";
import { adapterFor } from "../../src/cli/lane-run.ts";
import { PI_DEFERRAL, piAgentRefusal, piReviewerRefusal } from "../../src/cli/pi-deferral.ts";
import { parseVersionedYaml } from "../../src/core/schemas/common.ts";
import { PolicySchema, type AdapterName } from "../../src/core/schemas/policy.ts";

const ROOT = join(import.meta.dir, "..", "..");

describe("the pi deferral", () => {
  test("the deferral text, verbatim", () => {
    expect(PI_DEFERRAL).toBe("the `pi` adapter is deferred to v1: stock pi 1.4.0 gives `bmad-build-auto` no subagents");
  });

  test.each([
    ["pi", null],
    ["claude", "claude"],
    ["codex", "codex"],
  ] as const)("piAgentRefusal(%s)", (agent, allowed) => {
    const r = piAgentRefusal(agent);
    if (allowed === null) expect(r).toEqual({ ok: false, error: { kind: "refused", message: `agent pi: ${PI_DEFERRAL}` } });
    else expect(r).toEqual({ ok: true, value: allowed });
  });

  test.each([
    [[], "none"],
    [["pi"], "pi"],
    [["claude"], null],
    [["codex"], null],
    [["claude", "pi"], null],
    [["pi", "codex"], null],
  ] as const)("piReviewerRefusal(%j)", (unattended, refusedAllowed) => {
    const r = piReviewerRefusal({ unattended_adapters: [...unattended] as AdapterName[] });
    if (refusedAllowed === null) expect(r).toEqual({ ok: true, value: undefined });
    else {
      expect(r).toEqual({
        ok: false,
        error: {
          kind: "refused",
          message: `.xarabot/policy.yaml unattended_adapters allows neither claude nor codex (allowed: ${refusedAllowed}), so the only reviewer would be pi: ${PI_DEFERRAL}`,
        },
      });
    }
  });

  test("a policy listing pi still parses", () => {
    const r = parseVersionedYaml(".xarabot/policy.yaml", "schema_version: 1\nunattended_adapters: [claude, pi]\n", PolicySchema);
    expect(r.ok && r.value.unattended_adapters).toEqual(["claude", "pi"]);
  });

  test("there is no pi adapter, and no pi agent command", () => {
    expect(existsSync(join(ROOT, "src", "adapters", "agent", "pi"))).toBe(false);
    expect(Object.keys(AGENT_COMMANDS).sort()).toEqual(["claude", "codex"]);
  });

  test("adapterFor and laneTools do not take pi (type-checked by tsc)", () => {
    // Never called: tsc fails if `pi` becomes a session adapter.
    const typeCheck = (env: CredentialEnv): void => {
      // @ts-expect-error `pi` is not a SessionAdapter.
      adapterFor("pi", env);
      // @ts-expect-error `pi` is not a SessionAdapter.
      laneTools("pi");
    };
    expect(typeof typeCheck).toBe("function");
  });
});
