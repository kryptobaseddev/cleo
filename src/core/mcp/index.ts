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
  /** Resolved install channel for npm package invocation. */
  channel: 'stable' | 'beta' | 'dev' | 'unknown';
}

/** Resolve MCP server name by channel. */
export function getMcpServerName(env: McpEnvMode): string {
  if (env.channel === 'dev') return 'cleo-dev';
  if (env.channel === 'beta') return 'cleo-beta';
  return 'cleo';
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
    return { mode: 'unknown', source: null, channel: 'unknown' };
  }

  const kvPairs: Record<string, string> = {};
  const lines = content.trim().split('\n');
  const installedVersion = lines[0]?.trim() ?? '';
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

  const channel = mode === 'dev-ts'
    ? 'dev'
    : installedVersion.includes('-beta')
      ? 'beta'
      : mode === 'prod-npm'
        ? 'stable'
        : 'unknown';

  return {
    mode,
    source: mode === 'dev-ts' ? (kvPairs['source'] ?? null) : null,
    channel,
  };
}

/**
 * Generate the MCP server entry for the cleo server based on env mode.
 *
 * Returns a config object compatible with CAAMP's McpServerConfig:
 * - dev-ts: { command: 'node', args: ['<source>/dist/mcp/index.js'] }
 * - prod-npm stable: { command: 'npx', args: ['-y', '@cleocode/cleo@latest', 'mcp'] }
 * - prod-npm beta: { command: 'npx', args: ['-y', '@cleocode/cleo@beta', 'mcp'] }
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

  if (env.channel === 'beta') {
    return {
      command: 'npx',
      args: ['-y', '@cleocode/cleo@beta', 'mcp'],
      env: {},
    };
  }

  // prod-npm stable (or unknown fallback): canonical npx invocation
  return {
    command: 'npx',
    args: ['-y', '@cleocode/cleo@latest', 'mcp'],
    env: {},
  };
}
