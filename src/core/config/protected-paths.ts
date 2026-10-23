/** Protected Paths every repo has; a policy can add to them, never remove (AR22). */
export const MANDATORY_PROTECTED_PATHS: readonly string[] = [
  ".xarabot/**",
  ".github/**",
  "**/.agents/**",
  "**/.claude/**",
  "**/.codex/**",
  "**/.pi/**",
  "**/.mcp.json",
  "**/AGENTS.md",
  "**/CLAUDE.md",
];

/**
 * The effective Protected Paths: the mandatory list with the Standing
 * Authority path after `.xarabot/**`, then the policy's own entries, each
 * kept once in first-seen order.
 */
export function effectiveProtectedPaths(policyPaths: readonly string[], authorityPath: string): string[] {
  const [first, ...rest] = MANDATORY_PROTECTED_PATHS;
  const all = [first as string, authorityPath, ...rest, ...policyPaths];
  return [...new Set(all)];
}
