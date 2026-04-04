/**
 * @packageDocumentation
 *
 * CLEO provider adapter for Google Gemini CLI.
 * Default export is the adapter class for dynamic loading by AdapterManager.
 *
 * @task T161
 * @epic T134
 */

import { GeminiCliAdapter } from './adapter.js';

export { GeminiCliAdapter } from './adapter.js';
export { GeminiCliHookProvider } from './hooks.js';
export { GeminiCliInstallProvider } from './install.js';

export default GeminiCliAdapter;

/**
 * Factory function for creating adapter instances.
 * Used by AdapterManager's dynamic import fallback.
 *
 * @remarks
 * This is the primary entry point for dynamic adapter loading.
 * AdapterManager calls this function when it resolves the gemini-cli
 * provider via its import-based discovery mechanism.
 *
 * @returns A new {@link GeminiCliAdapter} instance ready for initialization
 *
 * @example
 * ```typescript
 * import { createAdapter } from '@cleocode/adapters/providers/gemini-cli';
 *
 * const adapter = createAdapter();
 * await adapter.initialize('/path/to/project');
 * ```
 *
 * @task T161
 */
export function createAdapter(): GeminiCliAdapter {
  return new GeminiCliAdapter();
}
