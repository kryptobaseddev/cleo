/**
 * Runtime/channel diagnostics for CLI and MCP surfaces.
 * @task T4889
 * @epic T4881
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

type RuntimeChannel = 'stable' | 'beta' | 'dev';

interface VersionInfo {
  version: string;
  mode: string;
  source: string;
  installed: string;
  path: string;
}

export interface RuntimeDiagnostics {
  channel: RuntimeChannel;
  mode: string;
  source: string;
  version: string;
  installed: string;
  dataRoot: string;
  invocation: {
    executable: string;
    script: string;
    args: string[];
  };
  naming: {
    cli: string;
    mcp: string;
    server: string;
  };
  node: string;
  platform: string;
  arch: string;
  binaries?: Record<string, string>;
  package?: {
    name: string;
    version: string;
  };
  warnings: string[];
}

function normalizeChannel(value: string | undefined): RuntimeChannel | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'stable' || normalized === 'beta' || normalized === 'dev') {
    return normalized;
  }
  return null;
}

function detectFromInvocation(invocationName: string): RuntimeChannel | null {
  if (invocationName.includes('-dev')) return 'dev';
  if (invocationName.includes('-beta')) return 'beta';
  return null;
}

function detectFromDataRoot(dataRoot: string): RuntimeChannel | null {
  const lower = dataRoot.toLowerCase();
  if (lower.endsWith('.cleo-dev')) return 'dev';
  if (lower.endsWith('.cleo-beta')) return 'beta';
  return null;
}

function getExpectedNaming(channel: RuntimeChannel): { cli: string; mcp: string; server: string } {
  switch (channel) {
    case 'dev':
      return { cli: 'cleo-dev', mcp: 'cleo-mcp-dev', server: 'cleo-dev' };
    case 'beta':
      return { cli: 'cleo-beta', mcp: 'cleo-mcp-beta', server: 'cleo-beta' };
    default:
      return { cli: 'cleo', mcp: 'cleo-mcp', server: 'cleo' };
  }
}

async function parseVersionFile(dataRoot: string): Promise<VersionInfo | null> {
  const versionPath = join(dataRoot, 'VERSION');
  if (!existsSync(versionPath)) return null;

  let content: string;
  try {
    content = await readFile(versionPath, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.trim().split('\n');
  const version = lines[0]?.trim() ?? 'unknown';
  const kv: Record<string, string> = {};

  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf('=');
    if (idx > 0) {
      const key = lines[i].slice(0, idx).trim();
      const value = lines[i].slice(idx + 1).trim();
      kv[key] = value;
    }
  }

  return {
    version,
    mode: kv['mode'] ?? 'unknown',
    source: kv['source'] ?? 'unknown',
    installed: kv['installed'] ?? 'unknown',
    path: versionPath,
  };
}

async function getPackageInfo(sourceDir?: string): Promise<{ name: string; version: string } | null> {
  const candidates: string[] = [];
  if (sourceDir && sourceDir !== 'unknown' && sourceDir !== 'npm') {
    candidates.push(join(sourceDir, 'package.json'));
  }
  candidates.push(join(process.cwd(), 'package.json'));

  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, 'utf-8');
      const pkg = JSON.parse(raw) as { name?: string; version?: string };
      return { name: pkg.name ?? 'unknown', version: pkg.version ?? 'unknown' };
    } catch {
      // continue
    }
  }
  return null;
}

async function resolveBinaryPath(name: string): Promise<string | null> {
  const execFileAsync = promisify(execFile);
  const resolver = process.platform === 'win32' ? 'where' : 'which';

  try {
    const { stdout } = await execFileAsync(resolver, [name]);
    const first = stdout.trim().split(/\r?\n/)[0] ?? '';
    return first || null;
  } catch {
    return null;
  }
}

export async function getRuntimeDiagnostics(options?: { detailed?: boolean }): Promise<RuntimeDiagnostics> {
  const scriptPath = process.argv[1] ?? '';
  const invocationName = basename(scriptPath || process.argv0 || 'cleo');
  const envChannel = normalizeChannel(process.env['CLEO_CHANNEL']);
  const dataRoot = process.env['CLEO_HOME'] ?? join(homedir(), '.cleo');

  const versionInfo = await parseVersionFile(dataRoot);
  const packageInfo = await getPackageInfo(versionInfo?.source);

  const channel = envChannel
    ?? detectFromInvocation(invocationName)
    ?? normalizeChannel(versionInfo?.version.includes('-beta') ? 'beta' : undefined)
    ?? detectFromDataRoot(dataRoot)
    ?? normalizeChannel(versionInfo?.mode.startsWith('dev') ? 'dev' : undefined)
    ?? 'stable';

  const naming = getExpectedNaming(channel);
  const warnings: string[] = [];

  if (channel === 'dev' && dataRoot.endsWith('.cleo') && !dataRoot.endsWith('.cleo-dev')) {
    warnings.push('Dev channel detected but data root is not isolated (.cleo-dev).');
  }

  if (channel === 'dev' && invocationName === 'ct') {
    warnings.push('Dev channel should not use ct alias. Use cleo-dev.');
  }

  if (channel === 'dev' && invocationName === 'cleo') {
    warnings.push('Dev channel invoked via cleo. Preferred command is cleo-dev.');
  }

  const result: RuntimeDiagnostics = {
    channel,
    mode: versionInfo?.mode ?? 'unknown',
    source: versionInfo?.source ?? 'unknown',
    version: packageInfo?.version ?? versionInfo?.version ?? 'unknown',
    installed: versionInfo?.installed ?? 'unknown',
    dataRoot,
    invocation: {
      executable: process.argv0,
      script: scriptPath || 'unknown',
      args: process.argv.slice(2),
    },
    naming,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    warnings,
  };

  if (options?.detailed) {
    const binNames = [
      'cleo',
      'ct',
      'cleo-dev',
      'cleo-beta',
      'cleo-mcp',
      'cleo-mcp-dev',
      'cleo-mcp-beta',
    ];
    const entries = await Promise.all(binNames.map(async (name) => [name, await resolveBinaryPath(name)] as const));
    result.binaries = Object.fromEntries(entries.map(([name, path]) => [name, path ?? 'not found']));
    result.package = {
      name: packageInfo?.name ?? 'unknown',
      version: packageInfo?.version ?? 'unknown',
    };
  }

  return result;
}
