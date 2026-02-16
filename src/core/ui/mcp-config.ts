/**
 * MCP server configuration for multi-tool auto-detection.
 *
 * Detects installed AI coding tools (Claude Code, Cursor, Gemini CLI, etc.)
 * and generates MCP server configuration entries for each.
 *
 * NOTE: For CAAMP-managed MCP config, use @cleocode/caamp imports.
 * This module provides CLEO-specific detection and configuration logic.
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform as osPlatform } from 'node:os';

/** Known tool keys (ordered). */
export const MCP_TOOL_KEYS = [
  'claude-code',
  'claude-desktop',
  'cursor',
  'gemini-cli',
  'kimi',
  'windsurf',
  'goose',
  'vscode',
  'zed',
  'codex',
] as const;

export type MCPToolKey = (typeof MCP_TOOL_KEYS)[number];

/** Tool metadata. */
export interface MCPToolInfo {
  key: MCPToolKey;
  displayName: string;
  format: 'json5' | 'json';
  globalPath: string;
  projectPath: string;
  detected: boolean;
}

const TOOL_DISPLAY_NAMES: Record<MCPToolKey, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  'cursor': 'Cursor',
  'gemini-cli': 'Gemini CLI',
  'kimi': 'Kimi Code',
  'windsurf': 'Windsurf',
  'goose': 'Goose',
  'vscode': 'VS Code',
  'zed': 'Zed',
  'codex': 'Codex',
};

const TOOL_FORMATS: Record<MCPToolKey, 'json5' | 'json'> = {
  'claude-code': 'json',
  'claude-desktop': 'json',
  'cursor': 'json',
  'gemini-cli': 'json',
  'kimi': 'json',
  'windsurf': 'json',
  'goose': 'json',
  'vscode': 'json',
  'zed': 'json',
  'codex': 'json',
};

/** Get global config path for a tool. */
function getGlobalConfigPath(key: MCPToolKey): string {
  const home = homedir();
  const plat = osPlatform();

  switch (key) {
    case 'claude-code':
      return join(home, '.claude', 'settings.json');
    case 'claude-desktop':
      if (plat === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      if (plat === 'win32') return join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
      return join(home, '.config', 'claude-desktop', 'config.json');
    case 'cursor':
      if (plat === 'darwin') return join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'cursor.mcp', 'mcp.json');
      return join(home, '.config', 'cursor', 'mcp.json');
    case 'gemini-cli':
      return join(home, '.gemini', 'settings.json');
    case 'vscode':
      if (plat === 'darwin') return join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
      return join(home, '.config', 'Code', 'User', 'settings.json');
    default:
      return join(home, `.${key}`, 'config.json');
  }
}

/** Get project-level config path for a tool. */
function getProjectConfigPath(key: MCPToolKey, projectDir: string): string {
  switch (key) {
    case 'claude-code': return join(projectDir, '.mcp.json');
    case 'cursor': return join(projectDir, '.cursor', 'mcp.json');
    case 'vscode': return join(projectDir, '.vscode', 'mcp.json');
    default: return join(projectDir, `.${key}`, 'mcp.json');
  }
}

/** Detect if a tool is installed. */
function detectTool(key: MCPToolKey): boolean {
  const globalPath = getGlobalConfigPath(key);

  // Check global config exists
  if (existsSync(globalPath)) return true;

  // Check for app bundles on macOS
  if (osPlatform() === 'darwin') {
    const appNames: Partial<Record<MCPToolKey, string>> = {
      'claude-desktop': '/Applications/Claude.app',
      'cursor': '/Applications/Cursor.app',
      'windsurf': '/Applications/Windsurf.app',
      'vscode': '/Applications/Visual Studio Code.app',
      'zed': '/Applications/Zed.app',
    };
    const appPath = appNames[key];
    if (appPath && existsSync(appPath)) return true;
  }

  return false;
}

/** Detect all installed tools. */
export function detectAllTools(projectDir?: string): MCPToolInfo[] {
  const projDir = projectDir ?? process.cwd();

  return MCP_TOOL_KEYS.map(key => ({
    key,
    displayName: TOOL_DISPLAY_NAMES[key],
    format: TOOL_FORMATS[key],
    globalPath: getGlobalConfigPath(key),
    projectPath: getProjectConfigPath(key, projDir),
    detected: detectTool(key),
  }));
}

/** Generate an MCP server entry for CLEO. */
export function generateMCPEntry(
  cleoPath?: string,
): Record<string, unknown> {
  const cleo = cleoPath ?? join(homedir(), '.cleo', 'bin', 'cleo-mcp');

  return {
    cleo: {
      command: cleo,
      args: ['serve'],
      env: {},
    },
  };
}

/** Write MCP config to a tool's config file. */
export function writeMCPConfig(
  tool: MCPToolKey,
  entry: Record<string, unknown>,
  options: { project?: boolean; projectDir?: string; dryRun?: boolean } = {},
): { action: string; path: string } {
  const configPath = options.project
    ? getProjectConfigPath(tool, options.projectDir ?? process.cwd())
    : getGlobalConfigPath(tool);

  if (options.dryRun) {
    return { action: 'would_write', path: configPath };
  }

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      // Start fresh if parse fails
    }
  }

  // Merge MCP server entry
  if (!config.mcpServers) config.mcpServers = {};
  Object.assign(config.mcpServers as Record<string, unknown>, entry);

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return { action: 'wrote', path: configPath };
}

/** Get detection summary for all tools. */
export function getDetectionSummary(projectDir?: string): Record<string, unknown> {
  const tools = detectAllTools(projectDir);
  const detected = tools.filter(t => t.detected);
  const notDetected = tools.filter(t => !t.detected);

  return {
    total: tools.length,
    detected: detected.length,
    notDetected: notDetected.length,
    tools: tools.map(t => ({
      key: t.key,
      name: t.displayName,
      detected: t.detected,
    })),
  };
}
