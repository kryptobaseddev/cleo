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
import { platform, release, arch } from 'node:os';

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

  return {
    cleoVersion: '2026.2.1',
    nodeVersion: process.version,
    os: `${platform()} ${release()} ${arch()}`,
    shell: process.env['SHELL'] ?? 'unknown',
    cleoHome: process.env['CLEO_HOME'] ?? `${process.env['HOME']}/.cleo`,
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
    `| OS | ${diag.os} |`,
    `| Shell | ${diag.shell} |`,
    `| gh CLI | ${diag.ghVersion} |`,
    `| Install | ${diag.installLocation} |`,
  ];
  return rows.join('\n');
}
