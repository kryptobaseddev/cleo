/**
 * Claude Code Hook Provider
 *
 * Maps Claude Code's native hook events to CAAMP canonical hook events.
 * Claude Code uses: SessionStart, PostToolUse, UserPromptSubmit, Stop
 * CAAMP canonical: SessionStart, PostToolUse, PromptSubmit, SessionEnd
 *
 * @task T5240
 * @task T144
 * @epic T134
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdapterHookProvider } from '@cleocode/contracts';

/**
 * Mapping from Claude Code native event names to CAAMP canonical event names.
 */
const CLAUDE_CODE_EVENT_MAP: Record<string, string> = {
  SessionStart: 'SessionStart',
  PostToolUse: 'PostToolUse',
  UserPromptSubmit: 'PromptSubmit',
  Stop: 'SessionEnd',
  PreToolUse: 'PreToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  Notification: 'Notification',
  SubagentStart: 'SubagentStart',
  SubagentStop: 'SubagentStop',
};

/**
 * Hook provider for Claude Code.
 *
 * Claude Code registers hooks via a plugin directory
 * with a hooks.json descriptor. The actual hook scripts are shell scripts
 * that invoke CLEO's brain observation system.
 *
 * Since hooks are registered through the plugin system (installed via
 * the install provider), registerNativeHooks and unregisterNativeHooks
 * are effectively no-ops here — the plugin installer handles registration.
 */
export class ClaudeCodeHookProvider implements AdapterHookProvider {
  private registered = false;

  /**
   * Map a Claude Code native event name to a CAAMP hook event name.
   *
   * @param providerEvent - Claude Code event name (e.g. "SessionStart", "PostToolUse")
   * @returns CAAMP event name or null if unmapped
   */
  mapProviderEvent(providerEvent: string): string | null {
    return CLAUDE_CODE_EVENT_MAP[providerEvent] ?? null;
  }

  /**
   * Register native hooks for a project.
   *
   * For Claude Code, hooks are registered via the plugin system
   * (hooks.json descriptor), which is handled by the
   * install provider. This method is a no-op since registration
   * is managed through the plugin install lifecycle.
   *
   * @param _projectDir - Project directory (unused; hooks are global)
   */
  async registerNativeHooks(_projectDir: string): Promise<void> {
    this.registered = true;
  }

  /**
   * Unregister native hooks.
   *
   * For Claude Code, this is a no-op since hooks are managed through
   * the plugin system. Unregistration happens via the install provider's
   * uninstall method.
   */
  async unregisterNativeHooks(): Promise<void> {
    this.registered = false;
  }

  /**
   * Check whether hooks have been registered via registerNativeHooks.
   */
  isRegistered(): boolean {
    return this.registered;
  }

  /**
   * Get the full event mapping for introspection/debugging.
   */
  getEventMap(): Readonly<Record<string, string>> {
    return { ...CLAUDE_CODE_EVENT_MAP };
  }

  /**
   * Extract a plain-text transcript from Claude Code session JSONL files.
   *
   * Reads the most recent .jsonl file under ~/.claude/projects/ and
   * extracts user/assistant turn text into a flat string for brain
   * observation extraction.
   *
   * Returns null when no session data is found or on any read error.
   *
   * @param _sessionId - CLEO session ID (unused; reads the most recent file)
   * @param _projectDir - Project directory (unused; Claude Code uses global paths)
   * @task T144 @epic T134
   */
  async getTranscript(_sessionId: string, _projectDir: string): Promise<string | null> {
    try {
      const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? '/root';
      const projectsDir = join(homeDir, '.claude', 'projects');

      // Find all JSONL files across project subdirectories
      let allFiles: Array<{ path: string; mtime: number }> = [];
      try {
        const projectDirs = await readdir(projectsDir, { withFileTypes: true });
        for (const entry of projectDirs) {
          if (!entry.isDirectory()) continue;
          const subDir = join(projectsDir, entry.name);
          try {
            const files = await readdir(subDir);
            for (const file of files) {
              if (!file.endsWith('.jsonl')) continue;
              const filePath = join(subDir, file);
              // Use file path modification heuristic (filename usually includes timestamp)
              allFiles.push({ path: filePath, mtime: 0 });
            }
          } catch {
            // Skip unreadable subdirectories
          }
        }
      } catch {
        return null;
      }

      if (allFiles.length === 0) return null;

      // Sort by path descending (timestamps in filenames sort naturally)
      allFiles = allFiles.sort((a, b) => b.path.localeCompare(a.path));
      const mostRecent = allFiles[0];
      if (!mostRecent) return null;

      const raw = await readFile(mostRecent.path, 'utf-8');
      const lines = raw.split('\n').filter((l) => l.trim());

      const turns: string[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          const role = entry.role as string | undefined;
          const content = entry.content;
          if (role === 'assistant' && typeof content === 'string') {
            turns.push(`assistant: ${content}`);
          } else if (role === 'user' && typeof content === 'string') {
            turns.push(`user: ${content}`);
          }
        } catch {
          // Skip malformed lines
        }
      }

      return turns.length > 0 ? turns.join('\n') : null;
    } catch {
      return null;
    }
  }
}
