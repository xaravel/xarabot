/** Agent config at any depth: every repo protects it (AR22), and a builder never writes it (FR18). */
export const AGENT_CONFIG_PATHS: readonly string[] = [
  "**/.agents/**",
  "**/.claude/**",
  "**/.codex/**",
  "**/.pi/**",
  "**/.mcp.json",
  "**/AGENTS.md",
  "**/CLAUDE.md",
];

/** Protected Paths every repo has; a policy can add to them, never remove (AR22). */
export const MANDATORY_PROTECTED_PATHS: readonly string[] = [".xarabot/**", ".github/**", ...AGENT_CONFIG_PATHS];

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
