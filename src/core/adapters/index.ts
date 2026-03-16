/**
 * Adapter management: discovery, lifecycle, and registry.
 *
 * @task T5240
 */

export { AdapterManager } from './manager.js';
export type { AdapterInfo } from './manager.js';
export { detectProvider, discoverAdapterManifests } from './discovery.js';
