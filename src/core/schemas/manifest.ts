import { z } from "zod";
import { StoryId } from "../story-id.ts";
import { NonEmpty } from "./common.ts";

/**
 * A Story manifest's frontmatter (AD-10). Loose: other keys (`status`, the
 * configured path key, anything else) pass the parse; the parser reads the
 * path key itself and drops the rest.
 */
export const ManifestFrontmatterSchema = z.looseObject({
  story_id: StoryId,
  epic: z.int().positive(),
  sprint_key: NonEmpty,
  title: NonEmpty,
  globs: z.array(z.string()).optional(),
  depends_on: z.array(StoryId).default([]),
  infrastructure: z.boolean().default(false),
});

export type ManifestFrontmatter = z.infer<typeof ManifestFrontmatterSchema>;

/** Where a Story's paths come from: its own normalized globs, or a key looked up in `manifests.path_map`. */
export type ManifestPaths =
  | { readonly kind: "globs"; readonly globs: readonly string[] }
  | { readonly kind: "key"; readonly key: string; readonly value: string };

/** One parsed Story manifest. */
export type Manifest = {
  /** The manifest file's repo path. */
  readonly path: string;
  readonly story_id: string;
  readonly epic: number;
  readonly sprint_key: string;
  readonly title: string;
  readonly paths: ManifestPaths;
  readonly depends_on: readonly string[];
  readonly infrastructure: boolean;
};
