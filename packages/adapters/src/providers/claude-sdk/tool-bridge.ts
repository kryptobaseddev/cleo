/**
 * Tool Bridge for Claude SDK Spawn Provider
 *
 * Maps CLEO's tool allowlist (string names) to the SDK's `allowedTools`
 * option format. The SDK accepts plain tool name strings such as
 * `"Read"`, `"Bash"`, `"Edit"` for built-in Claude Code tools and
 * `"mcp__<server>__<tool>"` for MCP-backed tools.
 *
 * @task T581
 */

/**
 * Default CLEO tool set passed to the SDK when no explicit allowlist
 * is provided in `SpawnContext.options.toolAllowlist`.
 *
 * Mirrors the standard agent tool surface used by the Claude Code CLI
 * `--dangerously-skip-permissions` mode.
 */
export const DEFAULT_TOOLS: readonly string[] = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
] as const;

/**
 * Resolves a CLEO tool allowlist to the SDK `allowedTools` array.
 *
 * When `allowlist` is undefined or empty, the default CLEO tool set is
 * returned. When an explicit list is provided, it is returned as-is so
 * callers can pass MCP tool strings (`mcp__server__tool`) alongside
 * built-in names without transformation.
 *
 * @param allowlist - Optional array of tool names from `SpawnContext.options`
 * @returns Array of SDK-compatible tool name strings
 *
 * @example
 * ```typescript
 * resolveTools(); // ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']
 * resolveTools(['Read', 'Bash']); // ['Read', 'Bash']
 * resolveTools(['mcp__brain__search']); // ['mcp__brain__search']
 * ```
 */
export function resolveTools(allowlist?: string[]): string[] {
  if (!allowlist || allowlist.length === 0) {
    return [...DEFAULT_TOOLS];
  }
  return [...allowlist];
}
