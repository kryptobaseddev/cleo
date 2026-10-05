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

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { updateJsonConfigFile } from '@cleocode/caamp';
import type { AdapterHookProvider } from '@cleocode/contracts';
import { excludeLocalSettingsFromGit } from '../shared/heavy-command-hook-install.js';
import { appendHookEntry, hookMap, isPlainObject, projectClaudeSettingsPath } from './paths.js';

/** The `Stop` hook command: end the CLEO session when Claude Code stops. */
export const NATIVE_STOP_HOOK_COMMAND = 'cleo session end --quiet # cleo-hook';

/** The `PostToolUse` (`Write|Edit`) hook command: a brain observation per file write. */
export const NATIVE_OBSERVE_HOOK_COMMAND =
  'cleo observe "File modified via $TOOL_NAME" --title "tool-use" --quiet # cleo-hook';

/**
 * The `PostToolUse` (`Write|Edit`) NEXUS post-check: re-index changed files and
 * flag regressions. `$TOOL_INPUT_file_path` is populated by Claude Code for
 * Write/Edit events.
 */
export const NATIVE_NEXUS_HOOK_COMMAND =
  'cleo nexus analyze --incremental --json > /dev/null 2>&1 && cleo observe "NEXUS re-indexed after $TOOL_NAME on $TOOL_INPUT_file_path" --title "nexus-post-check" --quiet # cleo-hook';

/** Every command {@link ClaudeCodeHookProvider.registerNativeHooks} writes, and alone may remove. */
const NATIVE_HOOK_COMMANDS: ReadonlySet<string> = new Set([
  NATIVE_STOP_HOOK_COMMAND,
  NATIVE_OBSERVE_HOOK_COMMAND,
  NATIVE_NEXUS_HOOK_COMMAND,
]);

/** Whether a hook object is one of the adapter's native hooks (never the heavy-command hook or a user's). */
function isNativeHookObject(hook: unknown): boolean {
  return (
    isPlainObject(hook) &&
    typeof hook.command === 'string' &&
    NATIVE_HOOK_COMMANDS.has(hook.command)
  );
}

/** Whether any event of a `hooks` map already holds a native hook. */
function hasNativeHooks(hooks: Record<string, unknown>): boolean {
  return Object.values(hooks).some(
    (entries) =>
      Array.isArray(entries) &&
      entries.some(
        (entry) =>
          isPlainObject(entry) &&
          Array.isArray(entry.hooks) &&
          entry.hooks.some(isNativeHookObject),
      ),
  );
}

/**
 * Remove the native hook objects from every event, then any entry left with
 * no hooks and any event left with no entries. Other hooks sharing an entry
 * (the heavy-command hook, the user's own) stay.
 */
function removeNativeHooks(hooks: Record<string, unknown>): boolean {
  let changed = false;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept: unknown[] = [];
    let eventChanged = false;
    for (const entry of entries) {
      if (
        !isPlainObject(entry) ||
        !Array.isArray(entry.hooks) ||
        !entry.hooks.some(isNativeHookObject)
      ) {
        kept.push(entry);
        continue;
      }
      eventChanged = true;
      const rest = entry.hooks.filter((hook) => !isNativeHookObject(hook));
      if (rest.length > 0) kept.push({ ...entry, hooks: rest });
    }
    if (!eventChanged) continue;
    changed = true;
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  return changed;
}

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
 * CLEO registers its Claude Code hooks in the project's per-machine
 * `<project>/.claude/settings.local.json`, never in the user-global
 * `~/.claude/settings.json` (T13227). Supported handler types: command, http,
 * prompt, agent.
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
   * Writes CLEO hook entries to the project's per-machine
   * `<project>/.claude/settings.local.json` so that Claude Code's native event
   * system calls cleo CLI commands when events fire in this project. This
   * bridges Claude Code's event loop to CLEO's internal hook dispatch.
   * CLEO never writes the user-global `~/.claude/settings.json` (T13227): a
   * project that is the home directory, or whose settings file resolves into
   * the user-global Claude config, is refused and nothing is written. When
   * git does not ignore `settings.local.json` yet, a marked `info/exclude`
   * block keeps it out of git (the T12983 heavy-command rule).
   *
   * Idempotent: skips writing if the native hooks are already present.
   *
   * Hook entries registered:
   * - `Stop` → `cleo session end --quiet` (triggers LLM extraction, reflector, consolidation)
   * - `PostToolUse` (Write|Edit) → brain observation for file modifications
   *   and the NEXUS post-check
   *
   * @param projectDir - Project whose Claude Code settings receive the hooks
   * @task T164 @task T555 @task T13227
   */
  async registerNativeHooks(projectDir: string): Promise<void> {
    this.projectDir = projectDir;
    this.registered = true;

    // T12385: locked, atomic, and a malformed file is reported and left
    // untouched — never replaced with an object holding only CLEO's entries.
    const wrote = await this.updateSettings(projectDir, (settings) => {
      const hooks = hookMap(settings);
      if (hasNativeHooks(hooks)) return false; // Already wired — idempotent

      appendHookEntry(hooks, 'Stop', {
        matcher: '',
        hooks: [{ type: 'command', command: NATIVE_STOP_HOOK_COMMAND }],
      });
      appendHookEntry(hooks, 'PostToolUse', {
        matcher: 'Write|Edit',
        hooks: [
          { type: 'command', command: NATIVE_OBSERVE_HOOK_COMMAND },
          { type: 'command', command: NATIVE_NEXUS_HOOK_COMMAND },
        ],
      });
      return true;
    });
    if (wrote) excludeLocalSettingsFromGit(projectDir);
  }

  /**
   * Unregister native hooks.
   *
   * Removes the hook objects {@link registerNativeHooks} wrote from the
   * project's `settings.local.json`, and nothing else: the heavy-command hook
   * and the user's own hooks stay, and an entry or event is dropped only when
   * left empty. Same locking, atomicity, parse-error and project-scope rules
   * as {@link registerNativeHooks}.
   *
   * @task T164 @task T555 @task T13227
   */
  async unregisterNativeHooks(): Promise<void> {
    const projectDir = this.projectDir;
    this.registered = false;
    this.projectDir = null;
    if (projectDir === null) return;

    let settingsPath: string;
    try {
      settingsPath = projectClaudeSettingsPath(projectDir);
    } catch {
      return; // Never written there, so nothing to remove.
    }
    if (!existsSync(settingsPath)) return;
    await this.updateSettings(projectDir, (settings) => {
      if (settings.hooks === undefined) return false;
      return removeNativeHooks(hookMap(settings));
    });
  }

  /** The last settings.json failure, or `null` when the last update succeeded. */
  private settingsError: string | null = null;

  /**
   * Why the last settings update did not happen, or `null`.
   *
   * @remarks
   * Hook registration stays non-fatal for adapter initialisation, so a
   * refused write (malformed settings file, lock timeout, a user-global
   * target) is surfaced here and on stderr instead of being swallowed
   * (T12385, T13227).
   *
   * @returns The failure message, or `null`
   */
  getSettingsError(): string | null {
    return this.settingsError;
  }

  /**
   * Apply `mutate` to the project's `settings.local.json` via CAAMP's locked,
   * atomic JSON writer.
   *
   * @returns whether the file was written.
   */
  private async updateSettings(
    projectDir: string,
    mutate: (settings: Record<string, unknown>) => boolean,
  ): Promise<boolean> {
    let settingsPath = `${projectDir}/.claude/settings.local.json`;
    try {
      settingsPath = projectClaudeSettingsPath(projectDir);
      const wrote = await updateJsonConfigFile(settingsPath, mutate);
      this.settingsError = null;
      return wrote;
    } catch (err) {
      this.settingsError = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[cleo:claude-code] hooks not written to ${settingsPath}: ${this.settingsError}\n`,
      );
      return false;
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
   * Claude Code stores session data under `~/.claude/projects/<project-slug>/`:
   *   - Root-level session JSONLs: `<sessionId>.jsonl` (primary transcript)
   *   - UUID subdirectories contain `subagents/agent-*.jsonl` (subagent turns)
   *
   * Reads the most-recent root-level JSONL plus all subagent JSONLs and
   * extracts user/assistant turn text into a flat string for brain
   * observation extraction.
   *
   * Returns null when no session data is found or on any read error.
   *
   * @param sessionId - CLEO session ID (available for future subagent filtering)
   * @param _projectDir - Project directory (unused; Claude Code uses global paths)
   * @task T729 @task T144 @epic T134
   */
  async getTranscript(sessionId: string, _projectDir: string): Promise<string | null> {
    try {
      const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? '/root';
      const projectsDir = join(homeDir, '.claude', 'projects');

      // Collect root-level session JSONLs (siblings to UUID subdirs).
      // Claude Code layout: ~/.claude/projects/<project>/<sessionId>.jsonl
      // UUID subdirs contain only subagents/ and tool-results/, not JSONLs.
      let rootFiles: Array<{ path: string }> = [];
      const subagentFiles: Array<{ path: string }> = [];

      try {
        const projectDirs = await readdir(projectsDir, { withFileTypes: true });
        for (const projectEntry of projectDirs) {
          if (!projectEntry.isDirectory()) continue;
          const projectDir = join(projectsDir, projectEntry.name);

          try {
            const projectContents = await readdir(projectDir, { withFileTypes: true });
            for (const entry of projectContents) {
              // Root-level JSONL: direct child file ending in .jsonl
              if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                rootFiles.push({ path: join(projectDir, entry.name) });
                continue;
              }

              // UUID subdir: check for subagent JSONLs
              if (entry.isDirectory()) {
                const subagentsDir = join(projectDir, entry.name, 'subagents');
                try {
                  const subagentEntries = await readdir(subagentsDir);
                  for (const sa of subagentEntries) {
                    if (sa.startsWith('agent-') && sa.endsWith('.jsonl')) {
                      subagentFiles.push({ path: join(subagentsDir, sa) });
                    }
                  }
                } catch {
                  // No subagents dir in this subdir — skip
                }
              }
            }
          } catch {
            // Skip unreadable project directories
          }
        }
      } catch {
        return null;
      }

      if (rootFiles.length === 0 && subagentFiles.length === 0) return null;

      // Sort root files by path descending (timestamps in filenames sort naturally)
      rootFiles = rootFiles.sort((a, b) => b.path.localeCompare(a.path));

      // Collect all JSONL paths: most-recent root file first, then subagent files
      const allPaths = [
        ...(rootFiles[0] ? [rootFiles[0].path] : []),
        ...subagentFiles.map((f) => f.path),
      ];

      // Suppress unused variable warning — sessionId available for future filtering
      void sessionId;

      const turns: string[] = [];
      for (const filePath of allPaths) {
        try {
          const raw = await readFile(filePath, 'utf-8');
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
        } catch {
          // Skip unreadable files
        }
      }

      return turns.length > 0 ? turns.join('\n') : null;
    } catch {
      return null;
    }
  }
}
