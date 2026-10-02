/**
 * Helpers for JSON hook configs shaped like Claude Code's `settings.json`
 * `hooks` map: `{ "<Event>": [{ "matcher": "...", "hooks": [{ "type":
 * "command", "command": "..." }] }] }`. Codex's `hooks.json` uses the same
 * shape. Every command CLEO owns carries the `# cleo-hook` marker so CLEO can
 * find (and remove) its own entries without touching user-authored ones.
 *
 * Moved from `claude-code/paths.ts` (T12385) so the Codex installer can share
 * them (T12983); `claude-code/paths.ts` re-exports them.
 *
 * @task T12385
 * @task T12983
 */

/** Marker CLEO puts in every hook command it owns. */
export const CLEO_HOOK_MARKER = '# cleo-hook';

/**
 * Whether a parsed settings value is a plain JSON object.
 *
 * @param value - Any parsed JSON value
 * @returns `true` for a non-null, non-array object
 *
 * @example
 * ```typescript
 * isPlainObject(settings.enabledPlugins);
 * ```
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a settings.json hook entry carries a CLEO-owned command.
 *
 * @param entry - One element of a `hooks.<Event>` array
 * @param commandIncludes - Extra substring the CLEO command must contain
 * @returns `true` when one of the entry's commands has the `# cleo-hook` marker
 *
 * @example
 * ```typescript
 * isCleoHookEntry({ hooks: [{ type: "command", command: "x # cleo-hook" }] }); // true
 * ```
 */
export function isCleoHookEntry(entry: unknown, commandIncludes?: string): boolean {
  if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(
    (hook) =>
      isPlainObject(hook) &&
      typeof hook.command === 'string' &&
      hook.command.includes(CLEO_HOOK_MARKER) &&
      (commandIncludes === undefined || hook.command.includes(commandIncludes)),
  );
}

/**
 * Whether a `hooks.<Event>` value holds a CLEO-owned entry.
 *
 * @param entries - The event's value (non-arrays hold none)
 * @param commandIncludes - Extra substring the CLEO command must contain
 * @returns `true` when a CLEO entry is present
 *
 * @example
 * ```typescript
 * hasCleoHook(hookMap(settings).Stop);
 * ```
 */
export function hasCleoHook(entries: unknown, commandIncludes?: string): boolean {
  return Array.isArray(entries) && entries.some((e) => isCleoHookEntry(e, commandIncludes));
}

/**
 * Return the settings object's `hooks` map, creating an empty one if absent.
 *
 * @param settings - Parsed settings.json
 * @returns The live `hooks` object (mutations apply to `settings`)
 * @throws Error when `hooks` exists but is not an object — the caller's write
 *   is aborted and the file left untouched
 *
 * @example
 * ```typescript
 * const hooks = hookMap(settings);
 * ```
 */
export function hookMap(settings: Record<string, unknown>): Record<string, unknown> {
  const existing = settings.hooks;
  if (existing === undefined) {
    const created: Record<string, unknown> = {};
    settings.hooks = created;
    return created;
  }
  if (!isPlainObject(existing)) {
    throw new Error('settings.json "hooks" is not an object; not modifying it');
  }
  return existing;
}

/**
 * Append a hook entry to `hooks[event]`, preserving existing entries.
 *
 * @param hooks - The settings `hooks` map
 * @param event - Native event name (e.g. `Stop`, `PreCompact`)
 * @param entry - Entry to append
 * @throws Error when `hooks[event]` exists but is not an array
 *
 * @example
 * ```typescript
 * appendHookEntry(hookMap(settings), "Stop", { matcher: "", hooks: [] });
 * ```
 */
export function appendHookEntry(
  hooks: Record<string, unknown>,
  event: string,
  entry: Record<string, unknown>,
): void {
  const existing = hooks[event];
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new Error(`settings.json "hooks.${event}" is not an array; not modifying it`);
  }
  hooks[event] = [...(existing ?? []), entry];
}

/**
 * Remove every CLEO-owned entry from every event array in `hooks`.
 *
 * @param hooks - The settings `hooks` map
 * @returns Whether anything was removed
 *
 * @example
 * ```typescript
 * const changed = removeCleoHookEntries(hookMap(settings));
 * ```
 */
export function removeCleoHookEntries(hooks: Record<string, unknown>): boolean {
  let changed = false;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((e) => !isCleoHookEntry(e));
    if (kept.length !== entries.length) {
      hooks[event] = kept;
      changed = true;
    }
  }
  return changed;
}
