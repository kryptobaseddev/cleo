/**
 * Claude Code Hook Provider
 *
 * Maps Claude Code's native hook events to CAAMP canonical hook events.
 * Claude Code supports 14 of 16 canonical events (all except PreModel, PostModel).
 *
 * Event translation uses CAAMP normalizer APIs:
 * - `toCanonical(nativeName, 'claude-code')` for runtime event name resolution
 * - `getSupportedEvents('claude-code')` to enumerate supported canonical events
 * - `getProviderHookProfile('claude-code')` for the full provider profile
 *
 * A static map derived from CAAMP 1.9.1 hook-mappings.json is maintained as
 * a fallback for environments where CAAMP's runtime resolution is unavailable.
 *
 * @task T164
 * @epic T134
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdapterHookProvider } from '@cleocode/contracts';

/** CAAMP provider identifier for Claude Code. */
const PROVIDER_ID = 'claude-code' as const;

/**
 * Fallback map from Claude Code native event names to CAAMP canonical names.
 *
 * Derived from `getProviderHookProfile('claude-code').mappings` in CAAMP 1.9.1.
 * Covers all 14 supported events. PreModel and PostModel are not supported
 * by Claude Code and are absent from this map.
 *
 * Used as fallback when CAAMP runtime is unavailable, and as the synchronous
 * implementation of `mapProviderEvent()`.
 */
const CLAUDE_CODE_EVENT_MAP: Record<string, string> = {
  // CAAMP: toNative('SessionStart',      'claude-code') = 'SessionStart'
  SessionStart: 'SessionStart',
  // CAAMP: toNative('SessionEnd',        'claude-code') = 'SessionEnd'
  SessionEnd: 'SessionEnd',
  // CAAMP: toNative('PromptSubmit',      'claude-code') = 'UserPromptSubmit'
  UserPromptSubmit: 'PromptSubmit',
  // CAAMP: toNative('ResponseComplete',  'claude-code') = 'Stop'
  Stop: 'ResponseComplete',
  // CAAMP: toNative('PreToolUse',        'claude-code') = 'PreToolUse'
  PreToolUse: 'PreToolUse',
  // CAAMP: toNative('PostToolUse',       'claude-code') = 'PostToolUse'
  PostToolUse: 'PostToolUse',
  // CAAMP: toNative('PostToolUseFailure','claude-code') = 'PostToolUseFailure'
  PostToolUseFailure: 'PostToolUseFailure',
  // CAAMP: toNative('PermissionRequest', 'claude-code') = 'PermissionRequest'
  PermissionRequest: 'PermissionRequest',
  // CAAMP: toNative('SubagentStart',     'claude-code') = 'SubagentStart'
  SubagentStart: 'SubagentStart',
  // CAAMP: toNative('SubagentStop',      'claude-code') = 'SubagentStop'
  SubagentStop: 'SubagentStop',
  // CAAMP: toNative('PreCompact',        'claude-code') = 'PreCompact'
  PreCompact: 'PreCompact',
  // CAAMP: toNative('PostCompact',       'claude-code') = 'PostCompact'
  PostCompact: 'PostCompact',
  // CAAMP: toNative('Notification',      'claude-code') = 'Notification'
  Notification: 'Notification',
  // CAAMP: toNative('ConfigChange',      'claude-code') = 'ConfigChange'
  ConfigChange: 'ConfigChange',
};

/**
 * Hook provider for Claude Code.
 *
 * Claude Code registers hooks via its global config at `~/.claude/settings.json`.
 * Supported handler types: command, http, prompt, agent.
 *
 * Event mapping is based on `getProviderHookProfile('claude-code')` from
 * CAAMP 1.9.1. Async accessors (`getSupportedCanonicalEvents`,
 * `getProviderProfile`) call CAAMP directly when available.
 *
 * Since hooks are registered through the config system (managed by the install
 * provider), `registerNativeHooks` and `unregisterNativeHooks` track registration
 * state without performing filesystem operations.
 *
 * @remarks
 * Claude Code is the only provider that supports all 14 of its declared
 * canonical events at runtime. The static event map is maintained as a
 * synchronous fallback; async methods like {@link getSupportedCanonicalEvents}
 * and {@link getProviderProfile} call CAAMP directly when available.
 *
 * @task T164
 * @epic T134
 */
export class ClaudeCodeHookProvider implements AdapterHookProvider {
  /** Whether hooks have been registered for the current session. */
  private registered = false;

  /**
   * Map a Claude Code native event name to a CAAMP canonical hook event name.
   *
   * Looks up the native event name in the map derived from
   * `getProviderHookProfile('claude-code').mappings` (CAAMP 1.9.1).
   * Returns null for unrecognised events (e.g. PreModel, PostModel which
   * Claude Code does not support).
   *
   * @param providerEvent - Claude Code native event (e.g. "UserPromptSubmit", "Stop")
   * @returns CAAMP canonical event name, or null if unmapped
   * @task T164
   */
  mapProviderEvent(providerEvent: string): string | null {
    return CLAUDE_CODE_EVENT_MAP[providerEvent] ?? null;
  }

  /**
   * Register native hooks for a project.
   *
   * For Claude Code, hooks are registered via the config system
   * (`~/.claude/settings.json`), managed by the install provider.
   * This method marks hooks as registered without performing filesystem operations.
   *
   * Iterating supported events is handled at install time using
   * `getSupportedCanonicalEvents()` to enumerate all 14 supported hooks.
   *
   * @param _projectDir - Project directory (unused; Claude Code uses global config)
   * @task T164
   */
  async registerNativeHooks(_projectDir: string): Promise<void> {
    this.registered = true;
  }

  /**
   * Unregister native hooks.
   *
   * For Claude Code, this is a no-op since hooks are managed through the config
   * system. Unregistration happens via the install provider's uninstall method.
   *
   * @task T164
   */
  async unregisterNativeHooks(): Promise<void> {
    this.registered = false;
  }

  /**
   * Check whether hooks have been registered via `registerNativeHooks`.
   */
  isRegistered(): boolean {
    return this.registered;
  }

  /**
   * Get the native→canonical event mapping for introspection and debugging.
   *
   * Returns the map derived from `getProviderHookProfile('claude-code').mappings`
   * (CAAMP 1.9.1). Use `getSupportedCanonicalEvents()` to enumerate canonical
   * names via live CAAMP APIs.
   *
   * @returns Immutable record of native event name → canonical event name
   */
  getEventMap(): Readonly<Record<string, string>> {
    return { ...CLAUDE_CODE_EVENT_MAP };
  }

  /**
   * Enumerate supported canonical events via CAAMP's `getSupportedEvents()`.
   *
   * Calls `getSupportedEvents('claude-code')` from the CAAMP normalizer to
   * get the authoritative list. Claude Code supports 14 of 16 canonical events
   * (PreModel and PostModel are not supported). Falls back to the values of
   * the static event map when CAAMP is unavailable at runtime.
   *
   * @returns Array of CAAMP canonical event names supported by Claude Code
   * @task T164
   */
  async getSupportedCanonicalEvents(): Promise<string[]> {
    try {
      const { getSupportedEvents } = await import('@cleocode/caamp');
      return getSupportedEvents(PROVIDER_ID) as string[];
    } catch {
      return [...new Set(Object.values(CLAUDE_CODE_EVENT_MAP))];
    }
  }

  /**
   * Retrieve the full provider hook profile from CAAMP.
   *
   * Calls `getProviderHookProfile('claude-code')` from the CAAMP normalizer to
   * get the complete profile: hook system type (`config`), config path
   * (`~/.claude/settings.json`), handler types, and all event mappings.
   * Returns null when CAAMP is unavailable at runtime.
   *
   * @returns Provider hook profile or null if CAAMP is unavailable
   * @task T164
   */
  async getProviderProfile(): Promise<unknown | null> {
    try {
      const { getProviderHookProfile } = await import('@cleocode/caamp');
      return getProviderHookProfile(PROVIDER_ID) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Translate a CAAMP canonical event to its Claude Code native name via CAAMP.
   *
   * Calls `toNative(canonical, 'claude-code')` from the CAAMP normalizer.
   * Returns null for unsupported events (PreModel, PostModel) or when
   * CAAMP is unavailable.
   *
   * @param canonical - CAAMP canonical event name (e.g. "PromptSubmit")
   * @returns Claude Code native event name or null
   * @task T164
   */
  async toNativeEvent(canonical: string): Promise<string | null> {
    try {
      const { toNative } = await import('@cleocode/caamp');
      return toNative(canonical as Parameters<typeof toNative>[0], PROVIDER_ID);
    } catch {
      // Invert the static map as fallback
      const entry = Object.entries(CLAUDE_CODE_EVENT_MAP).find(([, v]) => v === canonical);
      return entry?.[0] ?? null;
    }
  }

  /**
   * Extract a plain-text transcript from Claude Code session JSONL files.
   *
   * Reads the most recent .jsonl file under `~/.claude/projects/` and
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
