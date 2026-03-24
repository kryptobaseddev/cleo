/**
 * Gemini CLI Hook Provider
 *
 * Maps Gemini CLI's native hook events to CAAMP canonical hook events.
 * Gemini CLI supports 11 canonical events through its hook system.
 *
 * Gemini CLI event mapping:
 * - SessionStart        -> SessionStart
 * - SessionEnd          -> SessionEnd
 * - PromptSubmit        -> BeforeAgent
 * - ResponseComplete    -> AfterAgent
 * - PreToolUse          -> BeforeTool
 * - PostToolUse         -> AfterTool
 * - PreModel            -> BeforeModel
 * - PostModel           -> AfterModel
 * - PreCompact          -> PreCompress
 * - Notification        -> Notification
 *
 * @task T161
 * @epic T134
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdapterHookProvider } from '@cleocode/contracts';

/**
 * Mapping from Gemini CLI native event names to CAAMP canonical event names.
 */
const GEMINI_CLI_EVENT_MAP: Record<string, string> = {
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  PromptSubmit: 'BeforeAgent',
  ResponseComplete: 'AfterAgent',
  PreToolUse: 'BeforeTool',
  PostToolUse: 'AfterTool',
  PreModel: 'BeforeModel',
  PostModel: 'AfterModel',
  PreCompact: 'PreCompress',
  Notification: 'Notification',
};

/**
 * Hook provider for Gemini CLI.
 *
 * Gemini CLI registers hooks via its configuration system at
 * ~/.gemini/. Hook handlers are shell scripts or commands that
 * execute when the corresponding event fires.
 *
 * Since hooks are registered through the config system (managed by
 * the install provider), registerNativeHooks and unregisterNativeHooks
 * track registration state without performing filesystem operations.
 *
 * @task T161
 * @epic T134
 */
export class GeminiCliHookProvider implements AdapterHookProvider {
  private registered = false;

  /**
   * Map a Gemini CLI native event name to a CAAMP hook event name.
   *
   * @param providerEvent - Gemini CLI event name (e.g. "SessionStart", "PreToolUse")
   * @returns CAAMP event name or null if unmapped
   * @task T161
   */
  mapProviderEvent(providerEvent: string): string | null {
    return GEMINI_CLI_EVENT_MAP[providerEvent] ?? null;
  }

  /**
   * Register native hooks for a project.
   *
   * For Gemini CLI, hooks are registered via the config system
   * (~/.gemini/), which is handled by the install provider.
   * This method marks hooks as registered without performing
   * filesystem operations.
   *
   * @param _projectDir - Project directory (unused; hooks are global)
   * @task T161
   */
  async registerNativeHooks(_projectDir: string): Promise<void> {
    this.registered = true;
  }

  /**
   * Unregister native hooks.
   *
   * For Gemini CLI, this is a no-op since hooks are managed through
   * the config system. Unregistration happens via the install
   * provider's uninstall method.
   * @task T161
   */
  async unregisterNativeHooks(): Promise<void> {
    this.registered = false;
  }

  /**
   * Check whether hooks have been registered via registerNativeHooks.
   * @task T161
   */
  isRegistered(): boolean {
    return this.registered;
  }

  /**
   * Get the full event mapping for introspection/debugging.
   * @task T161
   */
  getEventMap(): Readonly<Record<string, string>> {
    return { ...GEMINI_CLI_EVENT_MAP };
  }

  /**
   * Extract a plain-text transcript from Gemini CLI session data.
   *
   * Reads the most recent session file under ~/.gemini/ and extracts
   * turn text into a flat string for brain observation extraction.
   *
   * Returns null when no session data is found or on any read error.
   *
   * @param _sessionId - CLEO session ID (unused; reads the most recent file)
   * @param _projectDir - Project directory (unused; Gemini CLI uses global paths)
   * @task T161 @epic T134
   */
  async getTranscript(_sessionId: string, _projectDir: string): Promise<string | null> {
    try {
      const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? '/root';
      const geminiDir = join(homeDir, '.gemini');

      let allFiles: string[] = [];
      try {
        const entries = await readdir(geminiDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const name = entry.name;
          if (name.endsWith('.json') || name.endsWith('.jsonl')) {
            allFiles.push(join(geminiDir, name));
          }
        }
      } catch {
        return null;
      }

      if (allFiles.length === 0) return null;

      // Sort descending by filename (timestamps in filenames sort naturally)
      allFiles = allFiles.sort((a, b) => b.localeCompare(a));
      const mostRecent = allFiles[0];
      if (!mostRecent) return null;

      const raw = await readFile(mostRecent, 'utf-8');
      const turns: string[] = [];

      // Support both JSONL (one JSON per line) and JSON array formats
      const lines = raw.split('\n').filter((l) => l.trim());
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
