/**
 * Adapter management: discovery, lifecycle, and dynamic loading.
 *
 * @task T5240
 */

export { isValidAdapter, loadAdapterFromManifest } from './adapter-registry.js';
export { detectProvider, discoverAdapterManifests } from './discovery.js';
export type { AdapterInfo } from './manager.js';
export { AdapterManager } from './manager.js';
