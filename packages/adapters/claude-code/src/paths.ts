/**
 * Claude Code path provider.
 *
 * Implements AdapterPathProvider with Claude Code-specific directory locations.
 *
 * @task T5240
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AdapterPathProvider } from '@cleocode/contracts';

/**
 * Path provider for Anthropic Claude Code CLI.
 *
 * Resolves Claude Code's standard directory layout:
 * - Config dir: ~/.claude (or CLAUDE_HOME)
 * - Settings: ~/.claude/settings.json (or CLAUDE_SETTINGS)
 * - Agents: ~/.claude/agents
 * - Memory DB: ~/.claude-mem/claude-mem.db (or CLAUDE_MEM_DB)
 */
export class ClaudeCodePathProvider implements AdapterPathProvider {
  getProviderDir(): string {
    return process.env['CLAUDE_HOME'] ?? join(homedir(), '.claude');
  }

  getSettingsPath(): string | null {
    return process.env['CLAUDE_SETTINGS'] ?? join(this.getProviderDir(), 'settings.json');
  }

  getAgentInstallDir(): string | null {
    return join(this.getProviderDir(), 'agents');
  }

  getMemoryDbPath(): string | null {
    return process.env['CLAUDE_MEM_DB'] ?? join(homedir(), '.claude-mem', 'claude-mem.db');
  }
}
