/**
 * Codex CLI Hook Provider
 *
 * Maps Codex CLI's native hook events to CAAMP canonical hook events.
 * Codex CLI supports 3 canonical events through its hook system.
 *
 * Codex CLI event mapping:
 * - SessionStart      -> SessionStart
 * - PromptSubmit      -> UserPromptSubmit
 * - ResponseComplete  -> Stop
 *
 * @task T162
 * @epic T134
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AdapterHookProvider } from '@cleocode/contracts';
import { readLatestTranscript } from '../shared/transcript-reader.js';

/**
 * Mapping from Codex CLI native event names to CAAMP canonical event names.
 */
const CODEX_EVENT_MAP: Record<string, string> = {
  SessionStart: 'SessionStart',
  PromptSubmit: 'UserPromptSubmit',
  ResponseComplete: 'Stop',
};

/**
 * Hook provider for Codex CLI.
 *
 * Codex CLI registers hooks via its configuration system at
 * ~/.codex/. Hook handlers are shell commands or script paths that
 * execute when the corresponding event fires.
 *
 * Since hooks are registered through the config system (managed by
 * the install provider), registerNativeHooks and unregisterNativeHooks
 * track registration state without performing filesystem operations.
 *
 * @remarks
 * Codex CLI has a minimal hook surface with only 3 canonical events.
 * Registration state is tracked in-memory because Codex CLI manages
 * hooks through its own configuration system at `~/.codex/`.
 *
 * @task T162
 * @epic T134
 */
export class CodexHookProvider implements AdapterHookProvider {
  /** Whether hooks have been registered for the current session. */
  private registered = false;

  /**
   * Map a Codex CLI native event name to a CAAMP hook event name.
   *
   * @param providerEvent - Codex CLI event name (e.g. "SessionStart", "PromptSubmit")
   * @returns CAAMP event name or null if unmapped
   * @task T162
   */
  mapProviderEvent(providerEvent: string): string | null {
    return CODEX_EVENT_MAP[providerEvent] ?? null;
  }

  /**
   * Register native hooks for a project.
   *
   * For Codex CLI, hooks are registered via the config system
   * (~/.codex/), which is handled by the install provider.
   * This method marks hooks as registered without performing
   * filesystem operations.
   *
   * @param _projectDir - Project directory (unused; hooks are global)
   * @task T162
   */
  async registerNativeHooks(_projectDir: string): Promise<void> {
    this.registered = true;
  }

  /**
   * Unregister native hooks.
   *
   * For Codex CLI, this is a no-op since hooks are managed through
   * the config system. Unregistration happens via the install
   * provider's uninstall method.
   * @task T162
   */
  async unregisterNativeHooks(): Promise<void> {
    this.registered = false;
  }

  /**
   * Check whether hooks have been registered via registerNativeHooks.
   * @task T162
   */
  isRegistered(): boolean {
    return this.registered;
  }

  /**
   * Get the full event mapping for introspection/debugging.
   * @task T162
   */
  getEventMap(): Readonly<Record<string, string>> {
    return { ...CODEX_EVENT_MAP };
  }

  /**
   * Extract a plain-text transcript from Codex CLI session data.
   *
   * Reads the most recent JSON/JSONL session file under `~/.codex/`
   * and returns its turns as a flat string for brain observation extraction.
   *
   * Returns null when no session data is found or on any read error.
   *
   * @param _sessionId - CLEO session ID (unused; reads the most recent file)
   * @param _projectDir - Project directory (unused; Codex CLI uses global paths)
   * @task T162 @epic T134
   */
  async getTranscript(_sessionId: string, _projectDir: string): Promise<string | null> {
    return readLatestTranscript(join(homedir(), '.codex'));
  }
}
