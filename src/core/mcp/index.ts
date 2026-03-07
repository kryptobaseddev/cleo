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

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoHome } from '../paths.js';

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
  // Prefer runtime package invocation detection over persisted metadata.
  // This prevents stale ~/.cleo/VERSION mode flags from overriding npm runtime channel.
  // Resolve symlinks: cleo-dev is a symlink chain, process.argv[1] may be the symlink
  // path (~/.local/bin/cleo-dev), not the real path (dist/cli/index.js).
  const rawScriptPath = process.argv[1] ?? '';
  let scriptPath: string;
  try {
    scriptPath = realpathSync(rawScriptPath).replace(/\\/g, '/');
  } catch {
    scriptPath = rawScriptPath.replace(/\\/g, '/');
  }
  const marker = '/node_modules/@cleocode/cleo/';
  const markerIdx = scriptPath.indexOf(marker);
  if (markerIdx >= 0) {
    const pkgRoot = scriptPath.slice(0, markerIdx + marker.length);
    let channel: McpEnvMode['channel'] = 'stable';
    try {
      const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8')) as { version?: string };
      channel = (pkg.version ?? '').includes('-beta') ? 'beta' : 'stable';
    } catch {
      channel = 'stable';
    }
    return { mode: 'prod-npm', source: 'npm', channel };
  }

  // ADR-016 §2.3: probe ~/.cleo-dev/VERSION first.
  // When the dev installer runs, it writes mode=dev-ts + source=<repo> to ~/.cleo-dev/VERSION.
  // If the current script path matches that source directory, we are running as cleo-dev.
  const devVersionPath = join(
    process.env['HOME'] ?? '',
    '.cleo-dev',
    'VERSION',
  );
  try {
    const devContent = readFileSync(devVersionPath, 'utf-8');
    const devKv: Record<string, string> = {};
    const devLines = devContent.trim().split('\n');
    for (let i = 1; i < devLines.length; i++) {
      const eq = devLines[i].indexOf('=');
      if (eq > 0) devKv[devLines[i].slice(0, eq).trim()] = devLines[i].slice(eq + 1).trim();
    }
    if (devKv['mode'] === 'dev-ts' && devKv['source']) {
      const devSource = devKv['source'].replace(/\\/g, '/');
      // Match if the running script is inside the registered dev source tree
      if (scriptPath.startsWith(devSource) || scriptPath.includes(devSource)) {
        return { mode: 'dev-ts', source: devKv['source'], channel: 'dev' };
      }
    }
  } catch {
    // ~/.cleo-dev/VERSION not present — not in dev mode via this path
  }

  const versionPath = join(
    getCleoHome(),
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
