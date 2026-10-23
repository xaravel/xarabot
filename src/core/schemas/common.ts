import { z } from "zod";
import { err, ok, type Result } from "../result.ts";

/** The only `schema_version` this package reads. */
export const SCHEMA_VERSION = 1;

export const SchemaVersion = z.literal(SCHEMA_VERSION);

/** A GitHub login: alphanumerics and single inner hyphens, at most 39 characters. */
const LOGIN = "[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}";

export const GitHubLogin = z.string().regex(new RegExp(`^${LOGIN}$`), "must be a GitHub login");

/** A repo slug, `owner/name`; the owner follows the login rule. */
export const RepoSlug = z
  .string()
  .regex(new RegExp(`^${LOGIN}\\/[A-Za-z0-9._-]{1,100}$`), 'must be a repo slug "owner/name"')
  .refine((s) => !s.endsWith("/.") && !s.endsWith("/.."), 'must be a repo slug "owner/name"');

/** An ISO 8601 date (`YYYY-MM-DD`) or date-time. */
export const IsoDate = z.union([z.iso.date(), z.iso.datetime({ offset: true })], {
  error: "must be an ISO 8601 date (YYYY-MM-DD) or date-time",
});

/** An ISO 8601 date-time. */
export const IsoDateTime = z.iso.datetime({ offset: true, error: "must be an ISO 8601 date-time" });

/** A relative path inside the repo: no leading `/`, no `.` or `..` segment, no backslash. */
export function isRepoRelative(p: string): boolean {
  return !p.startsWith("/") && !p.includes("\\") && p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

export const RepoPath = z.string().min(1).refine(isRepoRelative, "must be a repo-relative path");

/** A non-empty string. */
export const NonEmpty = z.string().min(1);

/** Turns zod issues into one reason that names each offending field. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.map(String).join(".");
      return field === "" ? issue.message : `${field}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Pre-check for a versioned file, run before the strict parse: the top level
 * must be a mapping, and an integer `schema_version` other than 1 is
 * `unsupported-version`. A missing or non-integer version is left to the
 * strict parse, which reports it as `invalid`.
 */
export function checkVersioned(
  path: string,
  parsed: unknown,
): Result<Record<string, unknown>, "invalid" | "unsupported-version"> {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return err("invalid", `${path}: top level must be a YAML mapping`);
  }
  const record = parsed as Record<string, unknown>;
  const version = record["schema_version"];
  if (typeof version === "number" && Number.isInteger(version) && version !== SCHEMA_VERSION) {
    return err("unsupported-version", `${path}: unsupported schema_version ${version} (this runner reads ${SCHEMA_VERSION})`);
  }
  return ok(record);
}

/** Parses YAML text without throwing. */
export function parseYaml(path: string, text: string): Result<unknown, "invalid-yaml"> {
  try {
    return ok(Bun.YAML.parse(text));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err("invalid-yaml", `${path}: invalid YAML: ${reason}`);
  }
}

/**
 * Parses a versioned YAML file against its strict schema: YAML, then the
 * version pre-check, then the schema.
 */
export function parseVersionedYaml<S extends z.ZodType>(
  path: string,
  text: string,
  schema: S,
): Result<z.infer<S>, "invalid-yaml" | "invalid" | "unsupported-version"> {
  const yaml = parseYaml(path, text);
  if (!yaml.ok) return yaml;
  return parseVersioned(path, yaml.value, schema);
}

/** The version pre-check and strict parse of an already-parsed value. */
export function parseVersioned<S extends z.ZodType>(
  path: string,
  value: unknown,
  schema: S,
): Result<z.infer<S>, "invalid" | "unsupported-version"> {
  const pre = checkVersioned(path, value);
  if (!pre.ok) return pre;
  const parsed = schema.safeParse(pre.value);
  if (!parsed.success) return err("invalid", `${path}: ${describeIssues(parsed.error)}`);
  return ok(parsed.data);
}
