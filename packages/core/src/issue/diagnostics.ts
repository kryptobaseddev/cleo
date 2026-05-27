/**
 * System diagnostics collection for issue reports.
 *
 * Extracted from CLI issue command to core for shared use
 * by both CLI and dispatch layer.
 *
 * @task T4555
 * @epic T4820
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { getCleoHome } from '../paths.js';
import { getCleoVersion } from '../scaffold.js';
import { getSystemInfo } from '../system/platform-paths.js';

/**
 * Resolve the runtime CLEO CLI version that `cleo --version` reports.
 *
 * Reads `@cleocode/cleo/package.json` via Node module resolution so the value
 * matches whatever copy of the CLI is currently loaded — whether installed
 * globally under `<npm-global>/lib/node_modules/@cleocode/cleo/` or running
 * from the monorepo source tree at `packages/cleo/`.
 *
 * Falls back to `getCleoVersion()` (the @cleocode/core version, which is
 * released in lockstep with the CLI) when module resolution fails, and to
 * `'unknown'` if even that fails. Replaces a hardcoded `'2026.2.1'` literal
 * that drifted ~3 months stale before being caught (gh-402).
 *
 * @internal
 */
function resolveCleoVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve('@cleocode/cleo/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
  } catch {
    // Not resolvable (e.g. core running without cleo on the resolution path) —
    // fall through to the core version, which is released in lockstep.
  }
  try {
    const v = getCleoVersion();
    if (v && v !== '0.0.0') return v;
  } catch {
    // ignore
  }
  return 'unknown';
}

/**
 * Collect system diagnostics for bug reports.
 */
export function collectDiagnostics(): Record<string, string> {
  const getVersion = (cmd: string, args: string[]): string => {
    try {
      return execFileSync(cmd, args, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return 'not installed';
    }
  };

  const cleoLocation = getVersion('which', ['cleo']);
  const ghVersion = getVersion('gh', ['--version']).split('\n')[0] ?? 'not installed';
  const sysInfo = getSystemInfo();

  return {
    cleoVersion: resolveCleoVersion(),
    nodeVersion: process.version,
    os: `${sysInfo.platform} ${sysInfo.release} ${sysInfo.arch}`,
    arch: sysInfo.arch,
    shell: process.env['SHELL'] ?? 'unknown',
    cleoHome: getCleoHome(),
    ghVersion,
    installLocation: cleoLocation || 'not found',
  };
}

/**
 * Format diagnostics as markdown table.
 */
export function formatDiagnosticsTable(diag: Record<string, string>): string {
  const rows = [
    '## Environment',
    '| Component | Version |',
    '|-----------|---------|',
    `| CLEO | ${diag.cleoVersion} |`,
    `| Node.js | ${diag.nodeVersion} |`,
    `| OS | ${diag.os}${diag.arch ? ` (${diag.arch})` : ''} |`,
    `| Shell | ${diag.shell} |`,
    `| gh CLI | ${diag.ghVersion} |`,
    `| Install | ${diag.installLocation} |`,
  ];
  return rows.join('\n');
}
