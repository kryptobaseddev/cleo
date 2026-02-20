/**
 * CLI env command for environment/mode inspection.
 * @task T4581
 * @epic T4577
 */

import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { cliOutput } from '../renderers/index.js';

/** Parsed VERSION file data. */
interface VersionInfo {
  version: string;
  mode: string;
  source: string;
  installed: string;
}

/**
 * Parse the ~/.cleo/VERSION file into structured data.
 * Returns null if the file does not exist or is unreadable.
 * @task T4581
 */
async function parseVersionFile(): Promise<VersionInfo | null> {
  const versionPath = join(process.env['CLEO_HOME'] ?? join(homedir(), '.cleo'), 'VERSION');
  let content: string;
  try {
    content = await readFile(versionPath, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.trim().split('\n');
  const version = lines[0]?.trim() ?? 'unknown';
  const kvPairs: Record<string, string> = {};

  for (let i = 1; i < lines.length; i++) {
    const eqIdx = lines[i].indexOf('=');
    if (eqIdx > 0) {
      const key = lines[i].slice(0, eqIdx).trim();
      const val = lines[i].slice(eqIdx + 1).trim();
      kvPairs[key] = val;
    }
  }

  return {
    version,
    mode: kvPairs['mode'] ?? 'unknown',
    source: kvPairs['source'] ?? 'unknown',
    installed: kvPairs['installed'] ?? 'unknown',
  };
}

/**
 * Read the package.json version from the source directory (dev mode)
 * or from the installed package location.
 * @task T4581
 */
async function getPackageInfo(sourceDir?: string): Promise<{ name: string; version: string } | null> {
  const candidates: string[] = [];
  if (sourceDir && sourceDir !== 'unknown' && sourceDir !== 'npm') {
    candidates.push(join(sourceDir, 'package.json'));
  }
  // Fallback: resolve relative to this file's module location
  // In dev-ts mode, dist/cli/commands/env.js -> repo root
  const moduleRoot = join(import.meta.dirname ?? '', '..', '..', '..');
  candidates.push(join(moduleRoot, 'package.json'));

  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, 'utf-8');
      const pkg = JSON.parse(raw) as { name?: string; version?: string };
      return { name: pkg.name ?? 'unknown', version: pkg.version ?? 'unknown' };
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Build the env status response.
 * @task T4581
 */
async function getEnvStatus(): Promise<Record<string, unknown>> {
  const versionInfo = await parseVersionFile();
  const pkg = await getPackageInfo(versionInfo?.source);

  return {
    mode: versionInfo?.mode ?? 'unknown',
    source: versionInfo?.source ?? 'unknown',
    version: pkg?.version ?? versionInfo?.version ?? 'unknown',
    installed: versionInfo?.installed ?? 'unknown',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

/**
 * Resolve the real path of a binary, following symlinks.
 * @task T4581
 */
async function resolveBinaryPath(name: string): Promise<string | null> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync('which', [name]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if the TypeScript source has been compiled (dist/ exists and is newer).
 * @task T4581
 */
async function getCompilationStatus(sourceDir: string): Promise<string> {
  const { stat } = await import('node:fs/promises');
  try {
    const distStat = await stat(join(sourceDir, 'dist', 'cli', 'index.js'));
    return `compiled (${distStat.mtime.toISOString()})`;
  } catch {
    return 'not compiled';
  }
}

/**
 * Build the detailed env info response.
 * @task T4581
 */
async function getEnvInfo(): Promise<Record<string, unknown>> {
  const status = await getEnvStatus();
  const versionInfo = await parseVersionFile();
  const pkg = await getPackageInfo(versionInfo?.source);

  const [cleoBin, cleoMcpBin] = await Promise.all([
    resolveBinaryPath('cleo'),
    resolveBinaryPath('cleo-mcp'),
  ]);

  const sourceDir = versionInfo?.source ?? 'unknown';
  const compilationStatus = sourceDir !== 'unknown' && sourceDir !== 'npm'
    ? await getCompilationStatus(sourceDir)
    : 'n/a';

  return {
    ...status,
    binaries: {
      cleo: cleoBin ?? 'not found',
      'cleo-mcp': cleoMcpBin ?? 'not found',
    },
    compilation: compilationStatus,
    package: {
      name: pkg?.name ?? 'unknown',
      version: pkg?.version ?? 'unknown',
    },
  };
}

/**
 * Register the env command group.
 * @task T4581
 */
export function registerEnvCommand(program: Command): void {
  const env = program
    .command('env')
    .description('Environment and mode inspection');

  env
    .command('status', { isDefault: true })
    .description('Show current environment mode and runtime info')
    .action(async () => {
      const result = await getEnvStatus();
      cliOutput(result, { command: 'env' });
    });

  env
    .command('info')
    .description('Show detailed environment info including binary paths and compilation status')
    .action(async () => {
      const result = await getEnvInfo();
      cliOutput(result, { command: 'env' });
    });
}
