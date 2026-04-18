/**
 * Path utilities for adapter install providers.
 *
 * These helpers mirror the equivalent functions in `@cleocode/core/paths`
 * but are duplicated here to avoid a circular dependency
 * (`@cleocode/core` → `@cleocode/adapters` → `@cleocode/core`).
 *
 * @remarks
 * Keep the implementation in sync with `getCleoTemplatesTildePath` in
 * `packages/core/src/paths.ts` if the logic ever changes.
 *
 * @task T916
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the XDG / OS-appropriate global CLEO data directory.
 *
 * Respects `CLEO_HOME` env var; otherwise uses the platform default:
 * - Linux:   `~/.local/share/cleo`
 * - macOS:   `~/Library/Application Support/cleo`
 * - Windows: `%LOCALAPPDATA%\cleo\Data` (approximate)
 *
 * @returns Absolute path to the CLEO data directory
 *
 * @internal
 */
function getAdapterCleoHome(): string {
  if (process.env['CLEO_HOME']) {
    return process.env['CLEO_HOME'];
  }
  const home = homedir();
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'cleo');
  }
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'];
    if (localAppData) {
      return join(localAppData, 'cleo', 'Data');
    }
    return join(home, 'AppData', 'Local', 'cleo', 'Data');
  }
  // Linux / XDG
  const xdgData = process.env['XDG_DATA_HOME'];
  if (xdgData) {
    return join(xdgData, 'cleo');
  }
  return join(home, '.local', 'share', 'cleo');
}

/**
 * Get the CLEO templates directory as a tilde-prefixed path for use in
 * `@` references (AGENTS.md, CLAUDE.md, etc.). Cross-platform: replaces
 * the user's home directory with `~` so the reference works when loaded
 * by LLM providers that resolve `~` at runtime.
 *
 * @returns Tilde-prefixed path like `"~/.local/share/cleo/templates"` on Linux,
 *   `"~/Library/Application Support/cleo/templates"` on macOS, etc.
 *
 * @example
 * ```typescript
 * const ref = `@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`;
 * // "@~/.local/share/cleo/templates/CLEO-INJECTION.md"  (Linux)
 * ```
 *
 * @task T916
 */
export function getCleoTemplatesTildePath(): string {
  const absPath = join(getAdapterCleoHome(), 'templates');
  const home = homedir();
  if (absPath.startsWith(home)) {
    // Always use forward slash after tilde for cross-platform @-reference resolution
    const relative = absPath.slice(home.length).replace(/\\/g, '/');
    return `~${relative}`;
  }
  return absPath;
}
