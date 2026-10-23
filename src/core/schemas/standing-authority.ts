import { z } from "zod";
import { GitHubLogin, IsoDate, RepoSlug, SchemaVersion } from "./common.ts";

/** The Standing Authority file's YAML frontmatter (AR22); the body is free prose. */
export const StandingAuthorityFrontmatterSchema = z.strictObject({
  schema_version: SchemaVersion,
  granted_by: GitHubLogin,
  granted_at: IsoDate,
  repo: RepoSlug,
  expires: IsoDate.optional(),
});

export type StandingAuthorityFrontmatter = z.infer<typeof StandingAuthorityFrontmatterSchema>;

export type StandingAuthority = {
  readonly frontmatter: StandingAuthorityFrontmatter;
  readonly body: string;
};
