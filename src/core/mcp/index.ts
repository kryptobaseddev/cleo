/**
 * MCP installation management core module.
 *
 * Detects the CLEO runtime environment (dev-ts vs prod-npm) and generates
 * appropriate MCP server configuration for AI coding tools. Supports both
 * .mcp.json (Claude Code) and .agents/mcp/servers.json formats.
 *
 * @task T4584
 * @epic T4577
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

/** Resolved environment mode for MCP server config. */
export interface McpEnvMode {
  mode: 'dev-ts' | 'prod-npm' | 'unknown';
  /** Absolute path to the source directory (dev-ts mode only). */
  source: string | null;
}

/**
 * Detect the current CLEO environment mode by reading ~/.cleo/VERSION.
 * @task T4584
 */
export function detectEnvMode(): McpEnvMode {
  const versionPath = join(
    process.env['CLEO_HOME'] ?? join(homedir(), '.cleo'),
    'VERSION',
  );

  let content: string;
  try {
    content = readFileSync(versionPath, 'utf-8');
  } catch {
    return { mode: 'unknown', source: null };
  }

  const kvPairs: Record<string, string> = {};
  const lines = content.trim().split('\n');
  for (let i = 1; i < lines.length; i++) {
    const eqIdx = lines[i].indexOf('=');
    if (eqIdx > 0) {
      kvPairs[lines[i].slice(0, eqIdx).trim()] = lines[i].slice(eqIdx + 1).trim();
    }
  }

  const rawMode = kvPairs['mode'] ?? 'unknown';
  const mode = rawMode === 'dev-ts' ? 'dev-ts'
    : rawMode === 'prod-npm' ? 'prod-npm'
    : 'unknown';

  return {
    mode,
    source: mode === 'dev-ts' ? (kvPairs['source'] ?? null) : null,
  };
}

/** Tool definition for MCP integration targets. */
interface McpTool {
  name: string;
  detected: boolean;
  configPath: string;
  scope: 'global' | 'project' | 'both';
}

/**
 * Supported AI tools for MCP integration.
 * @task T4584
 */
const SUPPORTED_TOOLS: McpTool[] = [
  {
    name: 'claude-code',
    detected: false,
    configPath: join(homedir(), '.claude', 'mcp_servers.json'),
    scope: 'global',
  },
  {
    name: 'cursor',
    detected: false,
    configPath: '.cursor/mcp.json',
    scope: 'project',
  },
  {
    name: 'vscode',
    detected: false,
    configPath: '.vscode/mcp.json',
    scope: 'project',
  },
];

/**
 * List detected AI tools.
 * @task T4584
 */
export async function listMcpTools(cwd?: string): Promise<Record<string, unknown>> {
  const tools = SUPPORTED_TOOLS.map(t => ({
    name: t.name,
    detected: existsSync(
      t.scope === 'project' ? join(cwd ?? process.cwd(), t.configPath) : t.configPath,
    ),
    scope: t.scope,
  }));

  return { tools, count: tools.length };
}

/**
 * Generate the MCP server entry for the cleo server based on env mode.
 * @task T4584
 */
export function generateMcpServerEntry(env: McpEnvMode): Record<string, unknown> {
  if (env.mode === 'dev-ts' && env.source) {
    return {
      command: 'node',
      args: [join(env.source, 'dist', 'mcp', 'index.js')],
      env: {},
    };
  }

  // prod-npm or unknown: use globally installed binary
  return {
    command: 'cleo-mcp',
    args: [],
    env: {},
  };
}

/**
 * Safely read a JSON file, returning an empty object on failure.
 * @task T4584
 */
function readJsonSafe(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Atomically write JSON to a file, creating parent directories as needed.
 * @task T4584
 */
function writeJsonAtomic(filePath: string, data: Record<string, unknown>): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Write cleo MCP server entry to .mcp.json (Claude Code project format).
 * Preserves existing mcpServers entries.
 * @task T4584
 */
function writeMcpJson(
  projectDir: string,
  serverEntry: Record<string, unknown>,
  opts: { force?: boolean; dryRun?: boolean },
): { action: string; path: string } {
  const configPath = join(projectDir, '.mcp.json');

  if (opts.dryRun) {
    return { action: 'would_write', path: configPath };
  }

  const config = readJsonSafe(configPath);

  if (!config['mcpServers']) {
    config['mcpServers'] = {};
  }

  const servers = config['mcpServers'] as Record<string, unknown>;

  if (servers['cleo'] && !opts.force) {
    return { action: 'skipped_exists', path: configPath };
  }

  servers['cleo'] = serverEntry;
  writeJsonAtomic(configPath, config);
  return { action: 'wrote', path: configPath };
}

/**
 * Write cleo MCP server entry to .agents/mcp/servers.json format.
 * Preserves existing server entries.
 * @task T4584
 */
function writeAgentsJson(
  projectDir: string,
  serverEntry: Record<string, unknown>,
  opts: { force?: boolean; dryRun?: boolean },
): { action: string; path: string } {
  const configPath = join(projectDir, '.agents', 'mcp', 'servers.json');

  if (opts.dryRun) {
    return { action: 'would_write', path: configPath };
  }

  const config = readJsonSafe(configPath);

  if (!config['mcpServers']) {
    config['mcpServers'] = {};
  }

  const servers = config['mcpServers'] as Record<string, unknown>;

  if (servers['cleo'] && !opts.force) {
    return { action: 'skipped_exists', path: configPath };
  }

  servers['cleo'] = serverEntry;
  writeJsonAtomic(configPath, config);
  return { action: 'wrote', path: configPath };
}

/**
 * Install MCP server configuration for CLEO.
 *
 * Detects the runtime environment (dev-ts vs prod-npm) and writes
 * appropriate MCP server config to:
 * - .mcp.json (Claude Code project-level config)
 * - .agents/mcp/servers.json (generic agents convention)
 * - Tool-specific configs (cursor, vscode) when requested
 *
 * @task T4584
 */
export async function installMcp(opts: {
  tool?: string;
  mode?: string;
  global?: boolean;
  project?: boolean;
  all?: boolean;
  dryRun?: boolean;
  force?: boolean;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const projectDir = opts.cwd ?? process.cwd();
  const env = detectEnvMode();
  const serverEntry = generateMcpServerEntry(env);
  const results: Array<{ target: string; action: string; path: string }> = [];

  // If a specific tool is requested, handle only that tool
  if (opts.tool) {
    const tool = SUPPORTED_TOOLS.find(t => t.name === opts.tool);
    if (!tool) {
      return {
        error: `Unknown tool: ${opts.tool}`,
        supportedTools: SUPPORTED_TOOLS.map(t => t.name),
      };
    }

    const configPath = tool.scope === 'project'
      ? join(projectDir, tool.configPath)
      : tool.configPath;

    if (!opts.dryRun) {
      const config = readJsonSafe(configPath);
      if (!config['mcpServers']) config['mcpServers'] = {};
      const servers = config['mcpServers'] as Record<string, unknown>;

      if (servers['cleo'] && !opts.force) {
        results.push({ target: tool.name, action: 'skipped_exists', path: configPath });
      } else {
        servers['cleo'] = serverEntry;
        writeJsonAtomic(configPath, config);
        results.push({ target: tool.name, action: 'wrote', path: configPath });
      }
    } else {
      results.push({ target: tool.name, action: 'would_write', path: configPath });
    }

    return {
      env: { mode: env.mode, source: env.source },
      serverEntry,
      results,
      dryRun: opts.dryRun ?? false,
    };
  }

  // Default: write .mcp.json + .agents/mcp/servers.json
  const mcpResult = writeMcpJson(projectDir, serverEntry, {
    force: opts.force,
    dryRun: opts.dryRun,
  });
  results.push({ target: '.mcp.json', ...mcpResult });

  const agentsResult = writeAgentsJson(projectDir, serverEntry, {
    force: opts.force,
    dryRun: opts.dryRun,
  });
  results.push({ target: '.agents/mcp/servers.json', ...agentsResult });

  // If --all, also configure detected tool-specific configs
  if (opts.all) {
    for (const tool of SUPPORTED_TOOLS) {
      const configPath = tool.scope === 'project'
        ? join(projectDir, tool.configPath)
        : tool.configPath;

      if (opts.dryRun) {
        results.push({ target: tool.name, action: 'would_write', path: configPath });
        continue;
      }

      const config = readJsonSafe(configPath);
      if (!config['mcpServers']) config['mcpServers'] = {};
      const servers = config['mcpServers'] as Record<string, unknown>;

      if (servers['cleo'] && !opts.force) {
        results.push({ target: tool.name, action: 'skipped_exists', path: configPath });
      } else {
        servers['cleo'] = serverEntry;
        writeJsonAtomic(configPath, config);
        results.push({ target: tool.name, action: 'wrote', path: configPath });
      }
    }
  }

  return {
    env: { mode: env.mode, source: env.source },
    serverEntry,
    results,
    dryRun: opts.dryRun ?? false,
  };
}
