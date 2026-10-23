import { describe, expect, test } from "bun:test";
import { loadHostConfig, type HostConfigErrorKind } from "../../../src/core/config/load-host-config.ts";
import { HostConfigSchema, LaneSchema, REPO_LAYER_KEYS } from "../../../src/core/schemas/host.ts";

const LANE = "    repo: xaravel/xarabot\n    role: builder\n    owner: edanisko\n    agent: claude\n";
const HOST = `schema_version: 1\nhost_id: 3f2b8c1e-7a4d-4b9e-9c2a-1d5e6f7a8b9c\nlanes:\n  builder-1:\n${LANE}`;

describe("loadHostConfig", () => {
  test("a valid host.yaml parses, effort defaults to high", () => {
    const r = loadHostConfig(HOST);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value).toEqual({
      schema_version: 1,
      host_id: "3f2b8c1e-7a4d-4b9e-9c2a-1d5e6f7a8b9c",
      lanes: {
        "builder-1": { repo: "xaravel/xarabot", role: "builder", owner: "edanisko", agent: "claude", effort: "high" },
      },
    });
  });

  test("model and effort are kept; host_id is optional", () => {
    const r = loadHostConfig(`schema_version: 1\nlanes:\n  c:\n${LANE}    model: opus\n    effort: max\n`);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.lanes["c"]).toMatchObject({ model: "opus", effort: "max" });
    expect(r.value.host_id).toBeUndefined();
  });

  const cases: readonly { name: string; text: string; kind: HostConfigErrorKind; reason?: string }[] = [
    { name: "top-level repo key", text: `${HOST}maintainer: edanisko\n`, kind: "repo-key-in-host", reason: "maintainer" },
    { name: "lane repo key", text: `${HOST}    expected_checks: [ci]\n`, kind: "repo-key-in-host", reason: "lanes.builder-1.expected_checks" },
    { name: "top-level human-live-steps key", text: `${HOST}steps: []\n`, kind: "repo-key-in-host", reason: "steps" },
    { name: "invalid YAML", text: "a: [1", kind: "invalid-yaml" },
    { name: "newer version", text: HOST.replace("schema_version: 1", "schema_version: 2"), kind: "unsupported-version" },
    { name: "unknown top-level key", text: `${HOST}colour: blue\n`, kind: "invalid", reason: "colour" },
    { name: "unknown lane key", text: `${HOST}    colour: blue\n`, kind: "invalid", reason: "colour" },
    { name: "bad host_id", text: HOST.replace("3f2b8c1e-7a4d-4b9e-9c2a-1d5e6f7a8b9c", "not-a-uuid"), kind: "invalid", reason: "host_id" },
    { name: "bad role", text: HOST.replace("role: builder", "role: boss"), kind: "invalid", reason: "role" },
    { name: "bad agent", text: HOST.replace("agent: claude", "agent: gpt"), kind: "invalid", reason: "agent" },
    { name: "bad effort", text: `${HOST}    effort: extreme\n`, kind: "invalid", reason: "effort" },
    { name: "bad repo slug", text: HOST.replace("xaravel/xarabot", "xarabot"), kind: "invalid", reason: "repo" },
    ...["../x", "a/b", "a b", "-a", ""].map((name) => ({
      name: `bad lane name ${JSON.stringify(name)}`,
      text: HOST.replace("builder-1:", `${JSON.stringify(name)}:`),
      kind: "invalid" as const,
      reason: `lanes.${name}: Invalid key`,
    })),
    { name: "lanes missing", text: "schema_version: 1\n", kind: "invalid", reason: "lanes" },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const r = loadHostConfig(c.text);
      if (r.ok) throw new Error("expected an error");
      expect(r.error.kind).toBe(c.kind);
      expect(r.error.message.startsWith("host.yaml: ")).toBe(true);
      if (c.reason !== undefined) expect(r.error.message).toContain(c.reason);
    });
  }

  test("no host or lane key is a repo-layer key", () => {
    const hostKeys = [...Object.keys(HostConfigSchema.shape), ...Object.keys(LaneSchema.shape)];
    expect(hostKeys.filter((k) => REPO_LAYER_KEYS.has(k))).toEqual([]);
    expect(REPO_LAYER_KEYS.size).toBeGreaterThan(0);
  });

  test("messages name the given path", () => {
    const r = loadHostConfig("a: [1", "/etc/xarabot/host.yaml");
    expect(r.ok ? "" : r.error.message.startsWith("/etc/xarabot/host.yaml: ")).toBe(true);
  });
});
