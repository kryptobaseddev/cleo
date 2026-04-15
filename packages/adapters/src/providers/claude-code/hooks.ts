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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
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

  /** Project directory this hook provider was registered for. */
  private projectDir: string | null = null;

  /**
   * Register native hooks for a project.
   *
   * Writes CLEO hook entries to `~/.claude/settings.json` so that Claude Code's
   * native event system calls cleo CLI commands when events fire. This bridges
   * Claude Code's event loop to CLEO's internal hook dispatch.
   *
   * Idempotent: skips writing if CLEO hooks already exist in settings.json.
   *
   * Hook entries registered:
   * - `Stop` → `cleo session end --quiet` (triggers LLM extraction, reflector, consolidation)
   * - `PostToolUse` (Write|Edit) → brain observation for file modifications
   * - `SubagentStop` → brain observation for agent completion
   *
   * @param projectDir - Project directory for context-scoped hook commands
   * @task T164 @task T555
   */
  async registerNativeHooks(projectDir: string): Promise<void> {
    this.projectDir = projectDir;
    this.registered = true;

    // Write CLEO hook entries to ~/.claude/settings.json (idempotent)
    try {
      const home = homedir();
      const settingsPath = join(home, '.claude', 'settings.json');

      let settings: Record<string, unknown> = {};
      if (existsSync(settingsPath)) {
        try {
          settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        } catch {
          // Start fresh if settings.json is corrupt
        }
      }

      const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;

      // Check if CLEO hooks already registered (look for our marker comment in commands)
      const alreadyRegistered = Object.values(hooks).some(
        (entries) =>
          Array.isArray(entries) &&
          entries.some(
            (e) =>
              typeof e === 'object' &&
              e !== null &&
              Array.isArray((e as Record<string, unknown>).hooks) &&
              ((e as Record<string, unknown>).hooks as Array<Record<string, string>>).some(
                (h) => typeof h.command === 'string' && h.command.includes('# cleo-hook'),
              ),
          ),
      );

      if (alreadyRegistered) {
        return; // Already wired — idempotent
      }

      // Register Stop hook → triggers cleo session end (LLM extraction, reflector, consolidation)
      if (!hooks.Stop) hooks.Stop = [];
      (hooks.Stop as unknown[]).push({
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: `cleo session end --quiet # cleo-hook`,
          },
        ],
      });

      // Register PostToolUse hook → brain observation for file writes + NEXUS post-check (T625)
      if (!hooks.PostToolUse) hooks.PostToolUse = [];
      (hooks.PostToolUse as unknown[]).push({
        matcher: 'Write|Edit',
        hooks: [
          {
            type: 'command',
            command: `cleo observe "File modified via $TOOL_NAME" --title "tool-use" --quiet # cleo-hook`,
          },
          {
            // NEXUS post-modification check: re-index changed files and flag regressions.
            // $TOOL_INPUT_file_path is populated by Claude Code for Write/Edit events.
            type: 'command',
            command: `cleo nexus analyze --incremental --json > /dev/null 2>&1 && cleo observe "NEXUS re-indexed after $TOOL_NAME on $TOOL_INPUT_file_path" --title "nexus-post-check" --quiet # cleo-hook`,
          },
        ],
      });

      settings.hooks = hooks;
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    } catch {
      // Settings write failure is non-fatal — hooks can be registered manually
    }
  }

  /**
   * Unregister native hooks.
   *
   * Removes CLEO hook entries from `~/.claude/settings.json` by filtering out
   * entries containing the `# cleo-hook` marker.
   *
   * @task T164 @task T555
   */
  async unregisterNativeHooks(): Promise<void> {
    this.registered = false;
    this.projectDir = null;

    try {
      const home = homedir();
      const settingsPath = join(home, '.claude', 'settings.json');
      if (!existsSync(settingsPath)) return;

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
      const hooks = settings.hooks as Record<string, unknown[]> | undefined;
      if (!hooks) return;

      // Filter out entries with the cleo-hook marker
      let changed = false;
      for (const [event, entries] of Object.entries(hooks)) {
        if (!Array.isArray(entries)) continue;
        const filtered = entries.filter(
          (e) =>
            !(
              typeof e === 'object' &&
              e !== null &&
              Array.isArray((e as Record<string, unknown>).hooks) &&
              ((e as Record<string, unknown>).hooks as Array<Record<string, string>>).some(
                (h) => typeof h.command === 'string' && h.command.includes('# cleo-hook'),
              )
            ),
        );
        if (filtered.length !== entries.length) {
          hooks[event] = filtered;
          changed = true;
        }
      }

      if (changed) {
        settings.hooks = hooks;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
      }
    } catch {
      // Cleanup failure is non-fatal
    }
  }

  /**
   * Check whether hooks have been registered via `registerNativeHooks`.
   */
  isRegistered(): boolean {
    return this.registered;
  }

  /**
   * Get the project directory this hook provider was registered for.
   *
   * Returns null if hooks have not been registered yet.
   */
  getProjectDir(): string | null {
    return this.projectDir;
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
