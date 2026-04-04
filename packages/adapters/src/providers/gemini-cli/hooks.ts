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

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AdapterHookProvider } from '@cleocode/contracts';
import { readLatestTranscript } from '../shared/transcript-reader.js';

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
 * @remarks
 * Gemini CLI uses its own event naming convention (e.g. BeforeAgent,
 * AfterTool, PreCompress) which differs from both the PascalCase CAAMP
 * canonical names and other providers' conventions. The static event map
 * covers all 10 supported canonical events.
 *
 * @task T161
 * @epic T134
 */
export class GeminiCliHookProvider implements AdapterHookProvider {
  /** Whether hooks have been registered for the current session. */
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
   * Reads the most recent JSON/JSONL session file under `~/.gemini/`
   * and returns its turns as a flat string for brain observation extraction.
   *
   * Returns null when no session data is found or on any read error.
   *
   * @param _sessionId - CLEO session ID (unused; reads the most recent file)
   * @param _projectDir - Project directory (unused; Gemini CLI uses global paths)
   * @task T161 @epic T134
   */
  async getTranscript(_sessionId: string, _projectDir: string): Promise<string | null> {
    return readLatestTranscript(join(homedir(), '.gemini'));
  }
}
