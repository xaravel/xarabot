import { sanitizeAgentText } from "../sanitize.ts";
import type { ReviewFinding } from "../schemas/session-result.ts";

/**
 * The loopback session's findings file (Story 3.5, FR8), pure: a heading
 * naming the subject and the reviewed SHA, then one line per finding
 * (severity, blocking or not, the file and the text, as the posted review
 * lists them), or "No findings.". A blocking round with no blocking finding
 * (blocked by its `changes-requested` verdict) says so first, and that every
 * finding listed must be fixed. Agent text is sanitized and redacted.
 */

export type FindingsTextInput = {
  /** The step texts' subject: `Story <id>` or `Unit <unit>`. */
  readonly subject: string;
  /** The reviewed SHA. */
  readonly sha: string;
  /** Whether the round blocked: by a blocking finding, or by its verdict. */
  readonly blocking: boolean;
  readonly findings: readonly Pick<ReviewFinding, "severity" | "blocking" | "file" | "text">[];
  /** Credentials to redact from the agent's text; default none. */
  readonly secrets?: readonly string[];
};

/** Agent text on one line: sanitized, redacted, whitespace runs as one space. */
function oneLine(text: string, secrets: readonly string[]): string {
  return sanitizeAgentText(text, { secrets }).replace(/\s+/g, " ").trim();
}

export function findingsText(input: FindingsTextInput): string {
  const secrets = input.secrets ?? [];
  const lines = [`# Review findings for ${oneLine(input.subject, secrets)} at ${input.sha}`, ""];
  if (input.blocking && !input.findings.some((f) => f.blocking)) {
    lines.push("No finding is marked blocking, but the review's verdict requested changes: fix every finding listed.", "");
  }
  if (input.findings.length === 0) lines.push("No findings.");
  for (const f of input.findings) {
    const path = oneLine(f.file, secrets).replaceAll("`", "'");
    lines.push(`- ${f.severity}, ${f.blocking ? "blocking" : "not blocking"}, \`${path}\`: ${oneLine(f.text, secrets)}`);
  }
  return `${lines.join("\n")}\n`;
}
