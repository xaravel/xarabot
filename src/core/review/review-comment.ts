import { capText, FORGE_TEXT_LIMITS, sanitizeAgentText } from "../sanitize.ts";
import type { ReviewResult } from "../schemas/session-result.ts";
import type { ReviewPass } from "../prompt/build-prompt.ts";
import type { SessionAdapter } from "./reviewer.ts";

/**
 * A review pass's verdict and its posted body (Story 3.4, FR8, AR16). Pure.
 */

/** A pass blocks when any finding is blocking or its verdict is not `pass`. */
export function isBlocking(result: Pick<ReviewResult, "verdict" | "findings">): boolean {
  return result.verdict !== "pass" || result.findings.some((f) => f.blocking);
}

export type ReviewCommentInput = {
  /** The step texts' subject: `Story <id>` or `Unit <unit>`. */
  readonly subject: string;
  /** The SHA the runner checked out and reviewed; never the agent's own `reviewed_sha`. */
  readonly sha: string;
  readonly crossVendor: boolean;
  readonly adapter: SessionAdapter;
  /** The model the reviewer ran. */
  readonly model: string;
  readonly pass: ReviewPass;
  readonly result: Pick<ReviewResult, "verdict" | "findings" | "denied_actions">;
  /** Credentials to redact from the agent's text; default none. */
  readonly secrets?: readonly string[];
};

/** Agent text on one line: sanitized, redacted, whitespace runs as one space. */
function oneLine(text: string, secrets: readonly string[]): string {
  return sanitizeAgentText(text, { secrets }).replace(/\s+/g, " ").trim();
}

/**
 * The body of one pass's review: a 🤖 line naming the subject, whether the
 * reviewer's vendor built none of the unit (`cross-vendor`) or some of it
 * (`same-vendor`), the pass, the reviewer adapter and model, and the full
 * reviewed SHA; then the verdict, the runner's outcome for the pass
 * (`isBlocking`: a `pass` verdict with a blocking finding still blocks),
 * each finding (severity, blocking or not, path and text), or "Findings:
 * none.", and the reviewer's denied actions, one line each, or "Denied
 * actions: none.". Agent text is sanitized and
 * redacted, and the body capped at `FORGE_TEXT_LIMITS.comment`.
 */
export function reviewComment(input: ReviewCommentInput): string {
  const secrets = input.secrets ?? [];
  const vendor = input.crossVendor ? "cross-vendor" : "same-vendor";
  const what = input.pass === "followup" ? "follow-up review" : "review";
  const model = oneLine(input.model, secrets).replaceAll("`", "'");
  const head = `🤖 ${input.subject}: ${vendor} ${what} by ${input.adapter} (${model}) of ${input.sha}.`;
  const verdict = `Verdict: ${input.result.verdict === "pass" ? "pass" : "changes requested"}.\nOutcome: ${isBlocking(input.result) ? "blocking" : "not blocking"}.`;
  const findings = input.result.findings.map((f) => {
    const path = oneLine(f.file, secrets).replaceAll("`", "'");
    return `- ${f.severity}, ${f.blocking ? "blocking" : "not blocking"}, \`${path}\`: ${oneLine(f.text, secrets)}`;
  });
  const listed = findings.length === 0 ? "Findings: none." : ["Findings:", ...findings].join("\n");
  const denied = input.result.denied_actions.map((a) => oneLine(a, secrets)).filter((a) => a !== "");
  const deniedText = denied.length === 0 ? "Denied actions: none." : ["Denied actions:", ...denied.map((a) => `- ${a}`)].join("\n");
  return capText([head, "", verdict, "", listed, "", deniedText, ""].join("\n"), FORGE_TEXT_LIMITS.comment);
}
