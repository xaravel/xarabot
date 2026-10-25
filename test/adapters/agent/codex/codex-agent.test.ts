import { describe, expect, test } from "bun:test";
import {
  CODEX_DEFAULT_MODEL,
  CODEX_MIN_VERSION,
  codexCredentialKind,
  codexEffortValues,
  createCodexAgent,
  MAX_PROMPT_BYTES,
  parseCodexVersion,
} from "../../../../src/adapters/agent/codex/codex-agent.ts";
import { PACKAGE_TEMPLATE } from "../../../../src/core/prompt/template.ts";
import { sanitizeAgentText } from "../../../../src/core/sanitize.ts";
import type { AgentSettings, Effort } from "../../../../src/ports/agent.ts";
import type { LaunchSpec } from "../../../../src/ports/sandbox.ts";

const agent = createCodexAgent({ credential: "auth-json" });
const keyed = createCodexAgent({ credential: "api-key" });
const RESULT = "/lane/tmp/result.json";
const SID = "01a1752b-acea-7ed3-883a-77eb2ba61eae";
const PROMPT = "# Task\n\nBuild Story 1.7 (`1-7-x`)\n";

function spec(a: typeof agent, ...args: Parameters<typeof agent.launchSpec>): LaunchSpec {
  const r = a.launchSpec(...args);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** The options the spec settled on, before any `resume` and the prompt. */
function options(model: string, effort: string): string[] {
  return [
    "codex",
    "exec",
    "-m",
    model,
    "--json",
    "-c",
    `model_reasoning_effort=${effort}`,
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    'commit_attribution=""',
  ];
}

describe("launchSpec", () => {
  test("defaults: gpt-6.1-sol, high, the prompt last after --, no stdin, CODEX_HOME, auth.json in the home", () => {
    const s = spec(agent, { kind: "fresh", prompt: PROMPT }, { effort: "high" }, RESULT);
    expect(s).toEqual({
      argv: [...options("gpt-6.1-sol", "high"), "--", PROMPT],
      vendor: "codex",
      vendorHomeEnv: "CODEX_HOME",
      credential: { file: "auth.json", homeFile: "auth.json" },
      apiHosts: ["chatgpt.com", "ab.chatgpt.com", "auth.openai.com"],
    });
    expect("stdin" in s).toBe(false);
    expect(s.argv).not.toContain("--ephemeral");
  });

  test("API-key mode: CODEX_API_KEY from the api-key file, and api.openai.com", () => {
    const s = spec(keyed, { kind: "fresh", prompt: PROMPT }, { effort: "high" }, RESULT);
    expect(s.credential).toEqual({ file: "api-key", env: "CODEX_API_KEY" });
    expect(s.apiHosts).toEqual(["chatgpt.com", "ab.chatgpt.com", "auth.openai.com", "api.openai.com"]);
  });

  test("no host outside the four named, never files.openai.com", () => {
    for (const a of [agent, keyed]) {
      const hosts = spec(a, { kind: "fresh", prompt: PROMPT }, { effort: "high" }, RESULT).apiHosts;
      expect(hosts).not.toContain("files.openai.com");
      expect(hosts.every((h) => ["chatgpt.com", "ab.chatgpt.com", "auth.openai.com", "api.openai.com"].includes(h))).toBe(true);
    }
  });

  test("the lane's model and effort", () => {
    expect(spec(agent, { kind: "fresh", prompt: PROMPT }, { model: "gpt-6-luna", effort: "xhigh" }, RESULT).argv).toEqual([
      ...options("gpt-6-luna", "xhigh"),
      "--",
      PROMPT,
    ]);
  });

  test("a prompt that starts with a dash stays a prompt: it comes after --", () => {
    const s = spec(agent, { kind: "fresh", prompt: "--help me" }, { effort: "high" }, RESULT);
    expect(s.argv.slice(-2)).toEqual(["--", "--help me"]);
  });

  test("resume: the same options, then resume <id> -- <prompt asking only for the result>, resume true", () => {
    const s = spec(agent, { kind: "resume", sessionId: SID }, { effort: "high" }, RESULT);
    expect(s.argv.slice(0, -1)).toEqual([...options("gpt-6.1-sol", "high"), "resume", SID, "--"]);
    expect(s.resume).toBe(true);
    const prompt = s.argv.at(-1) as string;
    expect(prompt).toContain(`\`${RESULT}\``);
    expect(prompt).toContain("$XARABOT_RESULT");
    expect(prompt).toContain("Do no other work");
    expect(prompt).not.toContain("bmad-");
    expect("stdin" in s).toBe(false);
  });

  test("a prompt of exactly 256 KiB passes; one byte more is invalid (multi-byte characters count as bytes)", () => {
    expect(agent.launchSpec({ kind: "fresh", prompt: "a".repeat(MAX_PROMPT_BYTES) }, { effort: "high" }, RESULT).ok).toBe(true);
    const over = agent.launchSpec({ kind: "fresh", prompt: "a".repeat(MAX_PROMPT_BYTES - 1) + "é" }, { effort: "high" }, RESULT);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.message).toContain("prompt");
  });

  test.each<[string, Parameters<typeof agent.launchSpec>, string]>([
    ["a relative resultPath", [{ kind: "fresh", prompt: PROMPT }, { effort: "high" }, "tmp/result.json"], "resultPath"],
    ["an empty prompt", [{ kind: "fresh", prompt: "" }, { effort: "high" }, RESULT], "prompt"],
    ["a blank prompt", [{ kind: "fresh", prompt: " \n" }, { effort: "high" }, RESULT], "prompt"],
    ["a NUL in the prompt", [{ kind: "fresh", prompt: "a\0b" }, { effort: "high" }, RESULT], "prompt"],
    ["a non-UUID session id", [{ kind: "resume", sessionId: "--last" }, { effort: "high" }, RESULT], "sessionId"],
    ["an empty session id", [{ kind: "resume", sessionId: "" }, { effort: "high" }, RESULT], "sessionId"],
    ["a model that reads as a flag", [{ kind: "fresh", prompt: PROMPT }, { model: "--evil", effort: "high" }, RESULT], "model"],
    ["an empty model", [{ kind: "fresh", prompt: PROMPT }, { model: "", effort: "high" }, RESULT], "model"],
  ])("%s is invalid, naming the field", (_name, args, field) => {
    const r = agent.launchSpec(...args);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("invalid");
      expect(r.error.message).toContain(field);
    }
  });
});

describe("effortValues", () => {
  const ALL: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
  test.each(["gpt-6.1-sol", "gpt-6-luna"])("%s offers low through max", (model) => {
    expect(codexEffortValues(model)).toEqual(ALL);
  });

  test.each(["gpt-6-astra", "gpt-5.6-sol", "claude-opus-5-5", "", "toString", "__proto__"])("%j offers none (fails closed)", (model) => {
    expect(codexEffortValues(model)).toEqual([]);
  });

  test("ultra, none and minimal are not on the scale", () => {
    for (const e of ["ultra", "none", "minimal"]) expect(codexEffortValues("gpt-6.1-sol")).not.toContain(e as Effort);
  });
});

describe("startCheck", () => {
  const V = "codex-cli 0.163.0";

  test("accepts the defaults on the minimum CLI", () => {
    expect(agent.startCheck({ effort: "high" }, V)).toEqual({ ok: true, value: { model: CODEX_DEFAULT_MODEL, version: "0.163.0" } });
  });

  test("gpt-6.1-sol with xhigh passes", () => {
    expect(agent.startCheck({ model: "gpt-6.1-sol", effort: "xhigh" }, V).ok).toBe(true);
  });

  test.each<[string, AgentSettings, string[]]>([
    ["an unknown model", { model: "gpt-6-astra", effort: "high" }, ["gpt-6-astra", "high", "none"]],
    ["a claude model", { model: "claude-opus-5-5", effort: "high" }, ["claude-opus-5-5", "none"]],
  ])("refuses %s, naming model, effort and the offered list", (_name, settings, fragments) => {
    const r = agent.startCheck(settings, V);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("refused");
      for (const f of fragments) expect(r.error.message).toContain(f);
    }
  });

  test.each(["codex-cli 0.162.9", "garbage", "", "codex-cli", "0.163", "codex-cli 0.163.x", "claude 2.1.309"])("refuses the version output %j", (out) => {
    const r = agent.startCheck({ effort: "high" }, out);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("refused");
  });

  test.each(["codex-cli 0.163.0", "codex-cli 0.163.1\n", "0.163.0", "0.200.0", "1.0.0", "  codex-cli 0.164.0-alpha.2\n"])("accepts %j", (out) => {
    expect(agent.startCheck({ effort: "max" }, out).ok).toBe(true);
  });

  test("minVersion is 0.163.0 and parses", () => {
    expect(agent.minVersion).toBe(CODEX_MIN_VERSION);
    expect(parseCodexVersion(CODEX_MIN_VERSION)).toEqual([0, 163, 0]);
    expect(parseCodexVersion("codex-cli 0.163.0")).toEqual([0, 163, 0]);
  });
});

describe("codexCredentialKind", () => {
  const has = (...files: string[]) => (f: string) => files.includes(f);

  test("only auth.json: the ChatGPT login", () => {
    expect(codexCredentialKind(has("auth.json"))).toEqual({ ok: true, value: "auth-json" });
  });

  test("only api-key: the API key", () => {
    expect(codexCredentialKind(has("api-key"))).toEqual({ ok: true, value: "api-key" });
  });

  test("both refuse; none refuses as missing, naming the folder", () => {
    const both = codexCredentialKind(has("auth.json", "api-key"), "/c/xarabot/vendors/codex");
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.error.message).toContain("both auth.json and api-key exist in /c/xarabot/vendors/codex");
    const none = codexCredentialKind(has(), "/c/xarabot/vendors/codex");
    expect(none.ok).toBe(false);
    if (!none.ok) {
      expect(none.error.kind).toBe("refused");
      expect(none.error.message).toContain("missing");
      expect(none.error.message).toContain("/c/xarabot/vendors/codex");
    }
  });

  test("other files in the folder don't count", () => {
    expect(codexCredentialKind(has("auth.json.bak", "notes")).ok).toBe(false);
  });
});

describe("AR42 spike record", () => {
  test("the agent's own sandbox and approvals are off, and attribution is off", () => {
    const argv = spec(agent, { kind: "fresh", prompt: PROMPT }, { effort: "high" }, RESULT).argv;
    expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv[argv.indexOf('commit_attribution=""') - 1]).toBe("-c");
    expect(argv).toContain("--json");
  });

  test("outcome mapping: the shared build prompt maps ready-for-dev to blocked/other and never offers no-op", () => {
    expect(PACKAGE_TEMPLATE.result_build).toMatch(/`ready-for-dev`[^\n]*`outcome` `blocked` with `blocked\.kind` `other`/);
    expect(PACKAGE_TEMPLATE.result_build).toContain("It halted `done`: `outcome` `done`.");
    expect(PACKAGE_TEMPLATE.result_build).toContain("`bmad-build-auto` has no `no-op` outcome, so never report `no-op` after it.");
  });

  test("resume: resume <thread_id> after the fresh options, in the kept vendor home", () => {
    const fresh = spec(agent, { kind: "fresh", prompt: PROMPT }, { effort: "low" }, RESULT);
    const resume = spec(agent, { kind: "resume", sessionId: SID }, { effort: "low" }, RESULT);
    expect(resume.argv.slice(0, fresh.argv.length - 2)).toEqual(fresh.argv.slice(0, -2));
    expect(resume.argv.slice(fresh.argv.length - 2, fresh.argv.length)).toEqual(["resume", SID]);
    expect(fresh.resume).toBeUndefined();
    expect(resume.resume).toBe(true);
    expect(resume.vendorHomeEnv).toBe(fresh.vendorHomeEnv);
  });
});

describe("codex's attribution strings", () => {
  test("the sanitizer strips the Co-authored-by trailer and the Generated with line from a summary and a body", () => {
    const summary = "Built Story 3.1.\n\nCo-authored-by: Codex <noreply@openai.com>\n";
    const body = "## Summary\n\nThe codex adapter.\n\nGenerated with [Codex](https://openai.com/codex/).\n";
    const s = sanitizeAgentText(summary);
    const b = sanitizeAgentText(body);
    expect(s).not.toContain("Co-authored-by");
    expect(s).not.toContain("noreply@openai.com");
    expect(s).toContain("Built Story 3.1.");
    expect(b).not.toContain("Generated with");
    expect(b).not.toContain("openai.com/codex");
    expect(b).toContain("The codex adapter.");
  });
});
