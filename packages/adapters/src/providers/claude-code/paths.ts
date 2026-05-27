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
 *
 * @remarks
 * All paths respect environment variable overrides for CI and non-standard
 * installations. When env vars are unset, the canonical default paths are used.
 */
export class ClaudeCodePathProvider implements AdapterPathProvider {
  /** Get the provider's root configuration directory. */
  getProviderDir(): string {
    return process.env['CLAUDE_HOME'] ?? join(homedir(), '.claude');
  }

  /** Get the path to the provider's settings file, or null if unavailable. */
  getSettingsPath(): string | null {
    return process.env['CLAUDE_SETTINGS'] ?? join(this.getProviderDir(), 'settings.json');
  }

  /** Get the directory where agents are installed, or null if unsupported. */
  getAgentInstallDir(): string | null {
    return join(this.getProviderDir(), 'agents');
  }

  /** Get the path to the provider's memory database, or null if unsupported. */
  getMemoryDbPath(): string | null {
    return process.env['CLAUDE_MEM_DB'] ?? join(homedir(), '.claude-mem', 'claude-mem.db');
  }
}
