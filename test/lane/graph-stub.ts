import type { GraphTree } from "../../src/core/graph/graph-gate.ts";
import { err, ok } from "../../src/core/result.ts";
import type { GraphTrees, GraphTreesOutcome, GraphTreesRequest } from "../../src/lane/graph-trees.ts";

/** Stub `GraphTrees` ports and graph trees for the step tests (no git, no mocks). */

export const GRAPH_EPICS = "_bmad-output/planning-artifacts/epics.md";
export const GRAPH_STATUS = "_bmad-output/implementation-artifacts/sprint-status.yaml";
export const GRAPH_RETRO_GATES = "_bmad-output/implementation-artifacts/retro-gates.yaml";

export const GRAPH_CONFIG = [
  "schema_version: 1",
  'runner_version: "0.1.0"',
  "maintainer: edanisko",
  "standing_authority_path: docs/standing-authority.md",
  "manifests:",
  "  dir: stories",
  "",
].join("\n");

/** A manifest of Story `id` in Epic `epic`. */
export function manifest(id: string, epic: number, sprintKey = `${id.replace(".", "-")}-s`): string {
  return `---\nstory_id: "${id}"\nepic: ${epic}\nsprint_key: ${sprintKey}\ntitle: Story ${id}\nglobs: ["src/${id}/**"]\n---\n`;
}

/** `epics.md` with these Epics and Story ids. */
export function epicsMd(epics: Readonly<Record<number, readonly string[]>>): string {
  const out = ["# Epics", ""];
  for (const [n, ids] of Object.entries(epics)) {
    out.push(`## Epic ${n}: Epic ${n}`, "");
    for (const id of ids) out.push(`### Story ${id}: Story ${id}`, "", "Body.", "");
  }
  return out.join("\n");
}

/** Graph files: a config, `epics.md` and a manifest for each Story listed, plus `extra`. */
export function graphFiles(epics: Readonly<Record<number, readonly string[]>>, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const files: Record<string, string> = { ".xarabot/config.yaml": GRAPH_CONFIG, [GRAPH_EPICS]: epicsMd(epics) };
  for (const [n, ids] of Object.entries(epics)) for (const id of ids) files[`stories/${id}.md`] = manifest(id, Number(n));
  return { ...files, ...extra };
}

export function treeOf(files: Readonly<Record<string, string>>): GraphTree {
  return { tree: Object.keys(files).sort(), files: { ...files } };
}

/** One Epic, one Story: an unchanged graph when both sides use it. */
export const BASE_GRAPH = graphFiles({ 1: ["1.1"] });

/** What a stub returns for one call: graph files for both sides, a conflict, or an error. */
export type StubAnswer =
  | { readonly main: Readonly<Record<string, string>>; readonly merged: Readonly<Record<string, string>> }
  | { readonly conflict: readonly string[] }
  | { readonly error: string };

export type StubGraph = { readonly trees: GraphTrees; readonly calls: GraphTreesRequest[] };

/** A stub port answering each call with `answer` (or `answer(request, i)`); the default is an unchanged graph. */
export function stubGraphTrees(answer: StubAnswer | ((r: GraphTreesRequest, i: number) => StubAnswer) = { main: BASE_GRAPH, merged: BASE_GRAPH }): StubGraph {
  const calls: GraphTreesRequest[] = [];
  const trees: GraphTrees = async (r) => {
    const a = typeof answer === "function" ? answer(r, calls.length) : answer;
    calls.push(r);
    if ("error" in a) return err("git", a.error);
    if ("conflict" in a) return ok<GraphTreesOutcome>({ kind: "conflict", paths: a.conflict });
    return ok<GraphTreesOutcome>({ kind: "clean", main: treeOf(a.main), merged: treeOf(a.merged) });
  };
  return { trees, calls };
}

/** The default stub's port: an unchanged graph. */
export const unchangedGraph = (): GraphTrees => stubGraphTrees().trees;
