/**
 * Observation formatter for brain hook events.
 * Originally extracted from the legacy .claude-plugin/ brain-worker.cjs summarizeTool logic.
 *
 * Converts raw tool-use events into human-readable observation summaries
 * suitable for storage in brain.db.
 *
 * @task T5240
 */

/** Tools that are too noisy or meta to record as observations. */
const SKIP_TOOLS: ReadonlySet<string> = new Set([
  'ListMcpResourcesTool',
  'SlashCommand',
  'Skill',
  'TodoWrite',
  'AskUserQuestion',
  'TaskList',
  'TaskUpdate',
  'TaskCreate',
  'TeamCreate',
  'SendMessage',
  'ToolSearch',
]);

/** Tool name prefixes to skip (internal CLEO/plugin tools). */
const SKIP_PREFIXES: readonly string[] = [
  'mcp__cleo',
  'mcp__claude-mem',
  'mcp__plugin_claude-mem',
];

/** Raw tool input from a hook event. */
export interface ToolInput {
  command?: string;
  file_path?: string;
  path?: string;
  pattern?: string;
  prompt?: string;
  description?: string;
  url?: string;
  query?: string;
  [key: string]: unknown;
}

/** Formatted observation ready for brain.db storage. */
export interface FormattedObservation {
  summary: string;
  title: string;
}

/**
 * Check whether a tool should be skipped (too noisy or meta).
 */
export function shouldSkipTool(toolName: string): boolean {
  if (SKIP_TOOLS.has(toolName)) return true;
  for (const prefix of SKIP_PREFIXES) {
    if (toolName.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Summarize a tool invocation into a concise human-readable string.
 */
export function summarizeToolUse(toolName: string, toolInput?: ToolInput): string {
  const inp = toolInput ?? {};
  switch (toolName) {
    case 'Bash':
      return `Ran: ${String(inp.command ?? '').slice(0, 120)}`;
    case 'Write':
      return `Wrote: ${inp.file_path ?? inp.path ?? 'unknown'}`;
    case 'Edit':
      return `Edited: ${inp.file_path ?? inp.path ?? 'unknown'}`;
    case 'Read':
      return `Read: ${inp.file_path ?? inp.path ?? 'unknown'}`;
    case 'Glob':
      return `Glob: ${String(inp.pattern ?? '').slice(0, 80)}`;
    case 'Grep':
      return `Grep: ${String(inp.pattern ?? '').slice(0, 60)} in ${String(inp.path ?? '.').slice(0, 60)}`;
    case 'Agent':
      return `Spawned agent: ${String(inp.prompt ?? inp.description ?? '').slice(0, 80)}`;
    case 'WebFetch':
      return `Fetched: ${String(inp.url ?? '').slice(0, 120)}`;
    case 'WebSearch':
      return `Searched: ${String(inp.query ?? '').slice(0, 80)}`;
    default:
      return `${toolName} called`;
  }
}

/**
 * Format a tool-use hook event into a brain observation.
 * Returns null if the tool should be skipped.
 */
export function formatObservation(
  toolName: string,
  toolInput?: ToolInput,
): FormattedObservation | null {
  if (shouldSkipTool(toolName)) return null;
  return {
    summary: summarizeToolUse(toolName, toolInput),
    title: `[hook] ${toolName}`,
  };
}
