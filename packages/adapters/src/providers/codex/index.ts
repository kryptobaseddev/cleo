/**
 * @packageDocumentation
 *
 * CLEO provider adapter for OpenAI Codex CLI.
 * Default export is the adapter class for dynamic loading by AdapterManager.
 *
 * @task T162
 * @epic T134
 */

import { CodexAdapter } from './adapter.js';

export { CodexAdapter } from './adapter.js';
export { CodexHookProvider } from './hooks.js';
export { CodexInstallProvider } from './install.js';

export default CodexAdapter;

/**
 * Factory function for creating adapter instances.
 * Used by AdapterManager's dynamic import fallback.
 *
 * @remarks
 * This is the primary entry point for dynamic adapter loading.
 * AdapterManager calls this function when it resolves the codex
 * provider via its import-based discovery mechanism.
 *
 * @returns A new {@link CodexAdapter} instance ready for initialization
 *
 * @example
 * ```typescript
 * import { createAdapter } from '@cleocode/adapters/providers/codex';
 *
 * const adapter = createAdapter();
 * await adapter.initialize('/path/to/project');
 * ```
 *
 * @task T162
 */
export function createAdapter(): CodexAdapter {
  return new CodexAdapter();
}
