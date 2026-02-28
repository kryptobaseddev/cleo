/**
 * MCP environment detection - CLEO-specific runtime mode resolution.
 *
 * Detects dev-ts vs prod-npm mode by reading ~/.cleo/VERSION.
 * This is the only CLEO-specific concern here — all provider detection,
 * config writing, and MCP server installation is delegated to @cleocode/caamp.
 *
 * @task T4676
 * @epic T4663
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Resolved environment mode for MCP server config. */
export interface McpEnvMode {
  mode: 'dev-ts' | 'prod-npm' | 'unknown';
  /** Absolute path to the source directory (dev-ts mode only). */
  source: string | null;
}

/**
 * Detect the current CLEO environment mode by reading ~/.cleo/VERSION.
 *
 * The VERSION file format:
 *   Line 1: version number
 *   Lines 2+: key=value pairs (mode, source, etc.)
 *
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

/**
 * Generate the MCP server entry for the cleo server based on env mode.
 *
 * Returns a config object compatible with CAAMP's McpServerConfig:
 * - dev-ts: { command: 'node', args: ['<source>/dist/mcp/index.js'] }
 * - prod-npm: { command: 'npx', args: ['-y', '@cleocode/cleo@latest', 'mcp'] }
 *
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

  // prod-npm or unknown: canonical npx invocation
  return {
    command: 'npx',
    args: ['-y', '@cleocode/cleo@latest', 'mcp'],
    env: {},
  };
}
