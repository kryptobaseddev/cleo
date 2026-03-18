/**
 * @cleocode/adapter-opencode
 *
 * CLEO provider adapter for OpenCode AI coding assistant.
 * Default export is the adapter class for dynamic loading by AdapterManager.
 *
 * @task T5240
 */
import { OpenCodeAdapter } from './adapter.js';
export { OpenCodeAdapter } from './adapter.js';
export { OpenCodeHookProvider } from './hooks.js';
export { OpenCodeSpawnProvider } from './spawn.js';
export { OpenCodeInstallProvider } from './install.js';
export default OpenCodeAdapter;
/**
 * Factory function for creating adapter instances.
 * Used by AdapterManager's dynamic import fallback.
 */
export declare function createAdapter(): OpenCodeAdapter;
//# sourceMappingURL=index.d.ts.map