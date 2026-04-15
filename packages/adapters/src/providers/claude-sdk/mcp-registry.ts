/**
 * MCP Registry for Claude SDK Spawn Provider
 *
 * Resolves available CLEO MCP servers and returns their configurations in the
 * format expected by the SDK's `mcpServers` option. Each server is represented
 * as an `McpStdioServerConfig` (command + optional args/env).
 *
 * Resolution is best-effort: if a server binary cannot be found in PATH or
 * `node_modules/.bin/`, it is silently omitted from the returned map. This
 * ensures agents always spawn even when some MCP servers are unavailable.
 *
 * @task T581
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Minimal stdio MCP server configuration understood by the SDK. */
export interface McpStdioConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Map of server name to its stdio configuration. */
export type McpServerMap = Record<string, McpStdioConfig>;

/**
 * Descriptor for a CLEO-provided MCP server candidate.
 *
 * @internal
 */
interface McpServerCandidate {
  /** Key used in the SDK `mcpServers` map. */
  name: string;
  /** Executable name to look up in PATH and node_modules/.bin/. */
  binary: string;
  /** Resolved extra args to pass after the binary. */
  args?: string[];
}

/** Known CLEO MCP servers, in resolution priority order. */
const CLEO_MCP_CANDIDATES: readonly McpServerCandidate[] = [
  { name: 'brain', binary: 'cleo-mcp-brain' },
  { name: 'nexus', binary: 'cleo-mcp-nexus' },
  { name: 'tasks', binary: 'cleo-mcp-tasks' },
] as const;

/**
 * Locate a binary in `node_modules/.bin/` relative to the given directory.
 *
 * @param binary - Executable name without path
 * @param workingDir - Project root to resolve `.bin/` from
 * @returns Absolute path if found, otherwise undefined
 */
function findInNodeModules(binary: string, workingDir: string): string | undefined {
  const binPath = join(workingDir, 'node_modules', '.bin', binary);
  if (existsSync(binPath)) {
    return binPath;
  }
  return undefined;
}

/**
 * Resolve available CLEO MCP servers for the given working directory.
 *
 * Checks each known CLEO MCP server candidate against `node_modules/.bin/`
 * in the provided directory. Only servers whose binary can be located are
 * included in the returned map.
 *
 * @param workingDirectory - Project root directory for binary resolution
 * @returns Map of available server name to stdio config (may be empty)
 *
 * @example
 * ```typescript
 * const servers = getServers('/path/to/project');
 * // { brain: { type: 'stdio', command: '/path/to/project/node_modules/.bin/cleo-mcp-brain' } }
 * ```
 */
export function getServers(workingDirectory: string): McpServerMap {
  const result: McpServerMap = {};

  for (const candidate of CLEO_MCP_CANDIDATES) {
    const resolvedPath = findInNodeModules(candidate.binary, workingDirectory);
    if (resolvedPath) {
      result[candidate.name] = {
        type: 'stdio',
        command: resolvedPath,
        ...(candidate.args ? { args: candidate.args } : {}),
      };
    }
  }

  return result;
}
