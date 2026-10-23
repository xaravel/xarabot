import { describe, expect, test } from "bun:test";
import { loadManifests, parseManifest, resolveManifestGlobs } from "../../../src/core/manifests/parse-manifest.ts";
import type { ManifestsConfig } from "../../../src/core/schemas/config.ts";

const PATH = "manifests/2.6a.md";
const KEYED: ManifestsConfig = { dir: "manifests", path_key: "component", path_map: { core: ["./src/core/**"], bad: ["../x"] } };
const PLAIN: ManifestsConfig = { dir: "manifests" };

function manifest(lines: readonly string[], body = "Notes.\n"): string {
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

const BASE = ['story_id: "2.6a"', "epic: 2", "sprint_key: 2-6a-thing", "title: A thing"];

function kindOf(r: { ok: boolean; error?: { kind: string } }): string {
  return r.ok ? "ok" : (r.error?.kind ?? "?");
}

describe("parseManifest", () => {
  test("valid manifest with extra keys", () => {
    const r = parseManifest(PATH, manifest([...BASE, "globs: [./src/a/**]", "status: done", "component_owner: x"]), PLAIN);
    expect(r).toEqual({
      ok: true,
      value: {
        path: PATH,
        story_id: "2.6a",
        epic: 2,
        sprint_key: "2-6a-thing",
        title: "A thing",
        paths: { kind: "globs", globs: ["src/a/**"] },
        depends_on: [],
        infrastructure: false,
      },
    });
    expect(r.ok && "status" in r.value).toBe(false);
  });

  test("depends_on and infrastructure", () => {
    const r = parseManifest(PATH, manifest([...BASE, "globs: []", 'depends_on: ["2.5", "1.17a"]', "infrastructure: true"]));
    expect(r.ok && r.value.depends_on).toEqual(["2.5", "1.17a"]);
    expect(r.ok && r.value.infrastructure).toBe(true);
  });

  test("CRLF and BOM", () => {
    const text = `\uFEFF${manifest([...BASE, "globs: [src/**]"])}`.replaceAll("\n", "\r\n");
    expect(kindOf(parseManifest(PATH, text))).toBe("ok");
  });

  test("only globs under a path-key config", () => {
    const r = parseManifest(PATH, manifest([...BASE, "globs: [src/**]"]), KEYED);
    expect(r.ok && r.value.paths).toEqual({ kind: "globs", globs: ["src/**"] });
  });

  test("path key", () => {
    const r = parseManifest(PATH, manifest([...BASE, "component: core"]), KEYED);
    expect(r.ok && r.value.paths).toEqual({ kind: "key", key: "component", value: "core" });
  });

  const invalid: readonly [string, readonly string[], ManifestsConfig | undefined, string][] = [
    ["missing sprint_key", [BASE[0]!, BASE[1]!, BASE[3]!, "globs: []"], undefined, "sprint_key"],
    ["missing title", [BASE[0]!, BASE[1]!, BASE[2]!, "globs: []"], undefined, "title"],
    ["missing epic", [BASE[0]!, BASE[2]!, BASE[3]!, "globs: []"], undefined, "epic"],
    ["missing story_id", [BASE[1]!, BASE[2]!, BASE[3]!, "globs: []"], undefined, "story_id"],
    ["empty title", [...BASE.slice(0, 3), 'title: ""', "globs: []"], undefined, "title"],
    ["bad id", ["story_id: 1.7A", "epic: 1", BASE[2]!, BASE[3]!, "globs: []"], undefined, "story_id"],
    ["unquoted numeric id", ["story_id: 1.3", "epic: 1", BASE[2]!, BASE[3]!, "globs: []"], undefined, "quoted"],
    ["bad depends_on", [...BASE, "globs: []", "depends_on: [x]"], undefined, "depends_on"],
    ["epic zero", ['story_id: "0.1"', "epic: 0", BASE[2]!, BASE[3]!, "globs: []"], undefined, "epic"],
    ["epic not integer", [BASE[0]!, "epic: 2.5", BASE[2]!, BASE[3]!, "globs: []"], undefined, "epic"],
    ["epic mismatch", ['story_id: "1.3"', "epic: 2", BASE[2]!, BASE[3]!, "globs: []"], undefined, "does not match"],
    ["infrastructure not boolean", [...BASE, "globs: []", "infrastructure: yes please"], undefined, "infrastructure"],
    ["neither globs nor key", BASE, KEYED, "globs or component"],
    ["neither, no path_key", BASE, PLAIN, "globs"],
    ["key ignored without path_key", [...BASE, "component: core"], PLAIN, "globs"],
    ["both globs and key", [...BASE, "globs: [src/**]", "component: core"], KEYED, "not both"],
    ["empty key value", [...BASE, 'component: ""'], KEYED, "component"],
    ["non-string key value", [...BASE, "component: 3"], KEYED, "component"],
    ["globs not a list", [...BASE, "globs: src/**"], undefined, "globs"],
    ["glob not a string", [...BASE, "globs: [1]"], undefined, "globs"],
    ["unquoted depends_on", [...BASE, "globs: []", "depends_on: [1.2]"], undefined, "quoted"],
    ["bad glob !", [...BASE, 'globs: ["!src/**"]'], undefined, '"!src/**"'],
    ["bad glob ..", [...BASE, "globs: [../x]"], undefined, '"../x"'],
    ["bad glob /abs", [...BASE, "globs: [/abs]"], undefined, '"/abs"'],
    ["bad glob inner ..", [...BASE, "globs: [src/../x]"], undefined, '"src/../x"'],
  ];
  for (const [name, lines, config, needle] of invalid) {
    test(name, () => {
      const r = parseManifest(PATH, manifest(lines), config);
      expect(kindOf(r)).toBe("invalid");
      if (!r.ok) {
        expect(r.error.message.startsWith(`${PATH}: `)).toBe(true);
        expect(r.error.message).toContain(needle);
      }
    });
  }

  test("no frontmatter", () => {
    expect(kindOf(parseManifest(PATH, "# Just a heading\n"))).toBe("invalid");
  });
  test("bad YAML", () => {
    const r = parseManifest(PATH, manifest(["story_id: [unclosed"]));
    expect(kindOf(r)).toBe("invalid-yaml");
    expect(!r.ok && r.error.message.startsWith(`${PATH}: `)).toBe(true);
  });
  test("frontmatter not a mapping", () => {
    expect(kindOf(parseManifest(PATH, manifest(["- a", "- b"])))).toBe("invalid");
  });
});

describe("resolveManifestGlobs", () => {
  function parsed(lines: readonly string[], config?: ManifestsConfig) {
    const r = parseManifest(PATH, manifest([...BASE, ...lines]), config);
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  }

  test("own globs", () => {
    expect(resolveManifestGlobs(parsed(["globs: [./src/a/**, src/b.ts]"]))).toEqual({ ok: true, value: ["src/a/**", "src/b.ts"] });
  });
  test("mapped key, normalized", () => {
    expect(resolveManifestGlobs(parsed(["component: core"], KEYED), KEYED)).toEqual({ ok: true, value: ["src/core/**"] });
  });
  test("unmapped key", () => {
    const r = resolveManifestGlobs(parsed(["component: nope"], KEYED), KEYED);
    expect(kindOf(r)).toBe("unclaimable");
    if (!r.ok) {
      expect(r.error.message.startsWith(`${PATH}: `)).toBe(true);
      expect(r.error.message).toContain("component");
      expect(r.error.message).toContain("nope");
    }
  });
  test("inherited object key is unmapped", () => {
    expect(kindOf(resolveManifestGlobs(parsed(["component: toString"], KEYED), KEYED))).toBe("unclaimable");
  });
  test("key without config", () => {
    expect(kindOf(resolveManifestGlobs(parsed(["component: core"], KEYED)))).toBe("unclaimable");
  });
  test("empty globs", () => {
    const m = parsed(["globs: []"]);
    const r = resolveManifestGlobs(m);
    expect(kindOf(r)).toBe("unclaimable");
    expect(!r.ok && r.error.message).toContain("empty");
  });
  test("bad path_map glob makes the config invalid", () => {
    const r = resolveManifestGlobs(parsed(["component: bad"], KEYED), KEYED);
    expect(kindOf(r)).toBe("invalid");
    expect(!r.ok && r.error.message.startsWith(".xarabot/config.yaml: ")).toBe(true);
  });
});

describe("loadManifests", () => {
  const one = manifest(['story_id: "1.1"', "epic: 1", "sprint_key: 1-1-a", "title: A", "globs: [src/a/**]"]);
  const two = manifest(['story_id: "1.2"', "epic: 1", "sprint_key: 1-2-b", "title: B", "globs: [src/b/**]"]);

  test("reads .md files directly inside the dir, sorted", () => {
    const r = loadManifests(
      {
        tree: ["manifests/1.2.md", "manifests/README.txt", "manifests/sub/x.md", "manifests/1.1.md", "other/1.3.md", "manifestsx/1.4.md"],
        files: { "manifests/1.1.md": one, "manifests/1.2.md": two },
      },
      PLAIN,
    );
    expect(r.ok && r.value.map((m) => [m.path, m.story_id])).toEqual([
      ["manifests/1.1.md", "1.1"],
      ["manifests/1.2.md", "1.2"],
    ]);
  });
  test("upper-case .MD files are skipped", () => {
    const r = loadManifests({ tree: ["manifests/1.1.md", "manifests/1.2.MD"], files: { "manifests/1.1.md": one, "manifests/1.2.MD": two } }, PLAIN);
    expect(r.ok && r.value.map((m) => m.path)).toEqual(["manifests/1.1.md"]);
  });
  test("a bad path_map glob fails the load even when no manifest uses it", () => {
    const r = loadManifests({ tree: ["manifests/1.1.md"], files: { "manifests/1.1.md": one } }, KEYED);
    expect(kindOf(r)).toBe("invalid");
    expect(!r.ok && r.error.message.startsWith(".xarabot/config.yaml: manifests.path_map.bad: ")).toBe(true);
  });
  test("no manifests config", () => {
    expect(loadManifests({ tree: ["manifests/1.1.md"], files: { "manifests/1.1.md": one } })).toEqual({ ok: true, value: [] });
  });
  test("listed but unread", () => {
    const r = loadManifests({ tree: ["manifests/1.1.md"], files: {} }, PLAIN);
    expect(kindOf(r)).toBe("unreadable");
    expect(!r.ok && r.error.message.startsWith("manifests/1.1.md: ")).toBe(true);
  });
  test("duplicate story id", () => {
    const r = loadManifests({ tree: ["manifests/a.md", "manifests/b.md"], files: { "manifests/a.md": one, "manifests/b.md": one } }, PLAIN);
    expect(kindOf(r)).toBe("duplicate-story");
    expect(!r.ok && r.error.message).toBe('manifests/b.md: story_id "1.1" is already used by manifests/a.md');
  });
  test("an invalid manifest fails the load", () => {
    const r = loadManifests({ tree: ["manifests/a.md"], files: { "manifests/a.md": "no frontmatter" } }, PLAIN);
    expect(kindOf(r)).toBe("invalid");
  });
});
