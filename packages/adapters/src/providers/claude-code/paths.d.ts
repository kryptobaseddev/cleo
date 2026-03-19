/**
 * Claude Code path provider.
 *
 * Implements AdapterPathProvider with Claude Code-specific directory locations.
 *
 * @task T5240
 */
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
export declare class ClaudeCodePathProvider implements AdapterPathProvider {
  getProviderDir(): string;
  getSettingsPath(): string | null;
  getAgentInstallDir(): string | null;
  getMemoryDbPath(): string | null;
}
//# sourceMappingURL=paths.d.ts.map
