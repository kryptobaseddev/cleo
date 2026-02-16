/**
 * Claude Code CLI alias management.
 *
 * Detects shells, generates alias blocks, and manages injection
 * into shell RC files for CLEO CLI shortcuts (ct, cleo, etc.).
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

/** Marker constants for idempotent injection. */
const MARKER_START = '# CLEO-CLAUDE-ALIASES:START';
const MARKER_END = '# CLEO-CLAUDE-ALIASES:END';

/** Current alias version. */
export const ALIASES_VERSION = '1.0.0';

/** Supported shell types. */
export type ShellType = 'bash' | 'zsh' | 'powershell' | 'cmd';

/** Environment variables for Claude aliases. */
const CLAUDE_ENV_VARS = [
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=true',
  'ENABLE_BACKGROUND_TASKS=true',
  'FORCE_AUTO_BACKGROUND_TASKS=true',
  'CLAUDE_CODE_ENABLE_UNIFIED_READ_TOOL=true',
];

/** Detect the current shell. */
export function getCurrentShell(): ShellType {
  const shell = process.env.SHELL ?? '';
  if (shell.includes('zsh')) return 'zsh';
  if (shell.includes('bash')) return 'bash';
  if (platform() === 'win32') return 'powershell';
  return 'bash';
}

/** Get the RC file path for a shell. */
export function getRcFilePath(shell?: ShellType): string {
  const home = homedir();
  const sh = shell ?? getCurrentShell();

  switch (sh) {
    case 'bash': return join(home, '.bashrc');
    case 'zsh': return join(home, '.zshrc');
    case 'powershell': return join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
    case 'cmd': return ''; // CMD doesn't have a standard RC
    default: return join(home, '.bashrc');
  }
}

/** Detect which shells are available on the system. */
export function detectAvailableShells(): ShellType[] {
  const shells: ShellType[] = [];

  if (existsSync(getRcFilePath('bash')) || existsSync('/bin/bash')) shells.push('bash');
  if (existsSync(getRcFilePath('zsh')) || existsSync('/bin/zsh')) shells.push('zsh');
  if (platform() === 'win32') shells.push('powershell');

  return shells;
}

/** Generate bash/zsh alias content. */
export function generateBashAliases(cleoPath?: string): string {
  const cleo = cleoPath ?? 'cleo';
  const envExports = CLAUDE_ENV_VARS.map(v => `export ${v}`).join('\n');

  return [
    MARKER_START,
    `# CLEO CLI aliases (v${ALIASES_VERSION})`,
    envExports,
    `alias ct='${cleo}'`,
    `alias ct-add='${cleo} add'`,
    `alias ct-done='${cleo} complete'`,
    `alias ct-list='${cleo} list'`,
    `alias ct-find='${cleo} find'`,
    `alias ct-show='${cleo} show'`,
    MARKER_END,
  ].join('\n');
}

/** Generate PowerShell alias content. */
export function generatePowershellAliases(cleoPath?: string): string {
  const cleo = cleoPath ?? 'cleo';

  return [
    '# CLEO CLI aliases',
    ...CLAUDE_ENV_VARS.map(v => {
      const [key, val] = v.split('=');
      return `$env:${key} = "${val}"`;
    }),
    `Set-Alias -Name ct -Value ${cleo}`,
  ].join('\n');
}

/** Check if aliases are already injected in a file. */
export function hasAliasBlock(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, 'utf-8');
  return content.includes(MARKER_START) && content.includes(MARKER_END);
}

/** Get the installed alias version from an RC file. */
export function getInstalledVersion(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  const match = content.match(/CLEO CLI aliases \(v([^)]+)\)/);
  return match?.[1] ?? null;
}

/** Inject aliases into a shell RC file. */
export function injectAliases(
  filePath: string,
  shell: ShellType = 'bash',
  cleoPath?: string,
): { action: 'created' | 'updated' | 'added'; version: string } {
  const content = shell === 'powershell'
    ? generatePowershellAliases(cleoPath)
    : generateBashAliases(cleoPath);

  if (!existsSync(filePath)) {
    writeFileSync(filePath, content + '\n', 'utf-8');
    return { action: 'created', version: ALIASES_VERSION };
  }

  const existing = readFileSync(filePath, 'utf-8');

  if (hasAliasBlock(filePath)) {
    // Replace existing block
    const startIdx = existing.indexOf(MARKER_START);
    const endIdx = existing.indexOf(MARKER_END) + MARKER_END.length;
    const updated = existing.slice(0, startIdx) + content + existing.slice(endIdx);
    writeFileSync(filePath, updated, 'utf-8');
    return { action: 'updated', version: ALIASES_VERSION };
  }

  // Append
  writeFileSync(filePath, existing + '\n' + content + '\n', 'utf-8');
  return { action: 'added', version: ALIASES_VERSION };
}

/** Remove aliases from a shell RC file. */
export function removeAliases(filePath: string): boolean {
  if (!existsSync(filePath) || !hasAliasBlock(filePath)) return false;

  const existing = readFileSync(filePath, 'utf-8');
  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END) + MARKER_END.length;

  // Remove the block plus any surrounding blank lines
  let before = existing.slice(0, startIdx).replace(/\n+$/, '\n');
  const after = existing.slice(endIdx).replace(/^\n+/, '\n');
  writeFileSync(filePath, before + after, 'utf-8');
  return true;
}

/** Get alias status for the current shell. */
export function checkAliasesStatus(shell?: ShellType): {
  shell: ShellType;
  rcFile: string;
  installed: boolean;
  version: string | null;
  needsUpdate: boolean;
} {
  const sh = shell ?? getCurrentShell();
  const rcFile = getRcFilePath(sh);

  if (!rcFile || !existsSync(rcFile)) {
    return { shell: sh, rcFile, installed: false, version: null, needsUpdate: false };
  }

  const installed = hasAliasBlock(rcFile);
  const version = installed ? getInstalledVersion(rcFile) : null;
  const needsUpdate = installed && version !== ALIASES_VERSION;

  return { shell: sh, rcFile, installed, version, needsUpdate };
}
