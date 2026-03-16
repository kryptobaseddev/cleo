/**
 * @cleocode/adapter-cursor
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
 */
export function createAdapter(): CursorAdapter {
  return new CursorAdapter();
}
