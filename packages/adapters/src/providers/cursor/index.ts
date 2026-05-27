/**
 * @packageDocumentation
 *
 * CLEO provider adapter for Cursor AI code editor.
 * Default export is the adapter class for dynamic loading by AdapterManager.
 *
 * @task T5240
 */

import { CursorAdapter } from './adapter.js';

export { CursorAdapter } from './adapter.js';
export { CursorHookProvider } from './hooks.js';
export { CursorInstallProvider } from './install.js';

export default CursorAdapter;

/**
 * Factory function for creating adapter instances.
 * Used by AdapterManager's dynamic import fallback.
 *
 * @remarks
 * This is the primary entry point for dynamic adapter loading.
 * AdapterManager calls this function when it resolves the cursor
 * provider via its import-based discovery mechanism.
 *
 * @returns A new {@link CursorAdapter} instance ready for initialization
 *
 * @example
 * ```typescript
 * import { createAdapter } from '@cleocode/adapters/providers/cursor';
 *
 * const adapter = createAdapter();
 * await adapter.initialize('/path/to/project');
 * ```
 */
export function createAdapter(): CursorAdapter {
  return new CursorAdapter();
}
