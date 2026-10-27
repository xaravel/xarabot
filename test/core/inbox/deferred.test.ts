import { describe, expect, test } from "bun:test";
import { openDeferred, storySpecFiles, widenedSpecGlob } from "../../../src/core/inbox/deferred.ts";
import { CONFIG_DEFAULTS } from "../../../src/core/schemas/config.ts";

const PATTERN = CONFIG_DEFAULTS.story_spec_path;
const DIR = "_bmad-output/implementation-artifacts";
const at = (name: string) => `${DIR}/${name}`;

/** A Story spec: frontmatter lines (YAML) and a body. */
const spec = (...frontmatter: string[]) => ["---", "title: 'A spec'", ...frontmatter, "---", "", "Body.", ""].join("\n");

const S41 = at("spec-4-1-retro-item-distance-gates.md");
const S42 = at("spec-4-2-owner-inboxes.md");
const S43 = at("spec-4-3-waiting-items.md");
const S116A = at("spec-1-16a-opening-the-pr.md");

const TWO_UNNAMED = spec(
  "created: '2026-10-20'",
  "deferred:",
  "  - summary: >-",
  "      First thing left.",
  "    severity: medium",
  "  - summary: Second thing left.",
);

const ids = (files: Record<string, string>) => openDeferred(PATTERN, Object.keys(files), files).open.map((e) => e.id);
const skippedPaths = (files: Record<string, string>) => openDeferred(PATTERN, Object.keys(files), files).skipped.map((s) => s.path);

describe("openDeferred", () => {
  test.each([
    ["no spec: nothing", {}, [], []],
    ["unnamed entries get <story id>-d<n>", { [S41]: TWO_UNNAMED }, ["4.1-d1", "4.1-d2"], []],
    ["a later spec resolving 4.1-d1 leaves 4.1-d2", { [S41]: TWO_UNNAMED, [S43]: spec("created: '2026-10-27'", 'resolves: ["4.1-d1"]') }, ["4.1-d2"], []],
    ["resolving both lists none", { [S41]: TWO_UNNAMED, [S43]: spec('resolves: ["4.1-d1", "4.1-d2"]') }, [], []],
    ["a spec cannot resolve its own entry", { [S41]: spec("deferred:", "  - summary: x", 'resolves: ["4.1-d1"]') }, ["4.1-d1"], []],
    ["an explicit id is kept", { [S42]: spec("deferred:", '  - id: "4.2-d1"', "    summary: x", '  - id: "custom-7"', "    summary: y") }, ["4.2-d1", "custom-7"], []],
    ["an explicit id resolves by that id", { [S42]: spec("deferred:", '  - id: "custom-7"', "    summary: y"), [S43]: spec('resolves: ["custom-7"]') }, [], []],
    ["a suffixed Story id", { [S116A]: spec("deferred:", "  - summary: x") }, ["1.16a-d1"], []],
    ["an empty deferred list", { [S41]: spec("deferred: []") }, [], []],
    ["a text entry counts", { [S41]: spec("deferred:", "  - plain words") }, ["4.1-d1"], []],
    ["by Story id order: 1.16a before 4.1", { [S41]: TWO_UNNAMED, [S116A]: spec("deferred:", "  - summary: x") }, ["1.16a-d1", "4.1-d1", "4.1-d2"], []],
    ["bad frontmatter YAML: skipped, the rest still listed", { [S41]: TWO_UNNAMED, [S42]: spec("deferred: [unclosed") }, ["4.1-d1", "4.1-d2"], [S42]],
    ["no frontmatter: skipped", { [S42]: "# No frontmatter\n" }, [], [S42]],
    ["deferred not a list: skipped", { [S42]: spec("deferred: nope") }, [], [S42]],
    ["resolves not a list of ids: skipped, so it resolves nothing", { [S41]: TWO_UNNAMED, [S43]: spec("resolves: 4.1-d1") }, ["4.1-d1", "4.1-d2"], [S43]],
    ["an entry that is a number: skipped", { [S42]: spec("deferred:", "  - 7") }, [], [S42]],
    ["a path outside the pattern is not a spec", { "docs/spec-4-1-x.md": TWO_UNNAMED, [at("notes.md")]: TWO_UNNAMED }, [], []],
    ["a name matching the widened glob with no Story id: skipped", { [at("spec-x-y-z.md")]: TWO_UNNAMED }, [], [at("spec-x-y-z.md")]],
  ] as const)("%s", (_name, files, wantIds, wantSkipped) => {
    expect(ids(files as Record<string, string>)).toEqual([...wantIds]);
    expect(skippedPaths(files as Record<string, string>)).toEqual([...wantSkipped]);
  });

  test("an entry carries its spec, summary and the spec's created", () => {
    const scan = openDeferred(PATTERN, [S41], { [S41]: TWO_UNNAMED });
    expect(scan.open).toEqual([
      { id: "4.1-d1", spec: S41, summary: "First thing left.", created: "2026-10-20" },
      { id: "4.1-d2", spec: S41, summary: "Second thing left.", created: "2026-10-20" },
    ]);
  });

  test("an unquoted created date and a missing one", () => {
    const unquoted = openDeferred(PATTERN, [S41], { [S41]: spec("created: 2026-10-21", "deferred:", "  - summary: x") }).open[0];
    expect(unquoted?.created).toBe("2026-10-21");
    const none = openDeferred(PATTERN, [S41], { [S41]: spec("deferred:", "  - summary: x") }).open[0];
    expect(none?.created).toBeNull();
  });

  test("a listed spec whose text was not read is skipped", () => {
    expect(openDeferred(PATTERN, [S41], {}).skipped).toEqual([{ path: S41, message: `${S41}: its text was not read` }]);
  });
});

describe("storySpecFiles", () => {
  test.each([
    [PATTERN, at("spec-4-1-x.md"), "4.1"],
    [PATTERN, at("spec-1-17a-approval-gate.md"), "1.17a"],
    [PATTERN, at("spec-10-2-x-y-z.md"), "10.2"],
    ["specs/<epic>/<story>/**/*.md", "specs/3/4/a/b.md", "3.4"],
    ["specs/<epic>/<story>/**/*.md", "specs/3/4/b.md", "3.4"],
    ["**/spec-<epic>-<story>.md", "spec-5-1.md", "5.1"],
    ["s-<story>-of-<epic>.md", "s-2b-of-7.md", "7.2b"],
  ] as const)("%s: %s gives %s", (pattern, path, id) => {
    expect(storySpecFiles(pattern, [path]).specs).toEqual([{ path, storyId: id }]);
  });

  test("the widened glob", () => {
    expect(widenedSpecGlob(PATTERN)).toBe(`${DIR}/spec-*-*-*.md`);
  });
});
