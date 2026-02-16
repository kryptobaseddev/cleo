/**
 * Statusline setup helper - Claude Code status line integration.
 *
 * Checks and configures Claude Code status line for context monitoring.
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function getClaudeSettingsPath(): string {
  return process.env.CLAUDE_SETTINGS ?? join(homedir(), '.claude', 'settings.json');
}

/** Statusline integration status. */
export type StatuslineStatus = 'configured' | 'not_configured' | 'custom_no_cleo' | 'no_settings';

/**
 * Check if statusline integration is configured.
 * Returns the current integration status.
 */
export function checkStatuslineIntegration(): StatuslineStatus {
  const settingsPath = getClaudeSettingsPath();

  if (!existsSync(settingsPath)) return 'no_settings';

  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const statusLine = settings.statusLine;

    if (!statusLine?.type) return 'not_configured';
    if (statusLine.type !== 'command') return 'custom_no_cleo';

    const cmd = statusLine.command ?? '';

    // Check if it's a CLEO statusline integration
    if (
      cmd.includes('context-monitor.sh') ||
      cmd.includes('cleo-statusline') ||
      cmd.includes('.context-state.json') ||
      cmd.includes('context-states')
    ) {
      return 'configured';
    }

    // Check if the script writes to CLEO state file
    const scriptPath = cmd.startsWith('~')
      ? cmd.replace('~', homedir())
      : cmd;

    if (existsSync(scriptPath)) {
      try {
        const content = readFileSync(scriptPath, 'utf-8');
        if (content.includes('context-state.json')) return 'configured';
      } catch { /* unreadable */ }
    }

    return 'custom_no_cleo';
  } catch {
    return 'no_settings';
  }
}

/**
 * Get the statusline setup command for Claude Code settings.
 */
export function getStatuslineConfig(): Record<string, unknown> {
  const cleoHome = process.env.CLEO_HOME ?? join(homedir(), '.cleo');

  return {
    statusLine: {
      type: 'command',
      command: join(cleoHome, 'lib', 'session', 'context-monitor.sh'),
    },
  };
}

/**
 * Get human-readable setup instructions.
 */
export function getSetupInstructions(): string {
  const settingsPath = getClaudeSettingsPath();

  return [
    'To enable context monitoring, add to your Claude Code settings:',
    `File: ${settingsPath}`,
    '',
    JSON.stringify(getStatuslineConfig(), null, 2),
    '',
    'This enables real-time context window tracking in the CLI.',
  ].join('\n');
}
