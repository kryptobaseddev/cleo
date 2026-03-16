/**
 * Adapter management: discovery, lifecycle, and registry.
 *
 * @task T5240
 */

export { ADAPTER_REGISTRY } from './adapter-registry.js';
export { AdapterManager } from './manager.js';
export type { AdapterInfo } from './manager.js';
export { detectProvider, discoverAdapterManifests } from './discovery.js';
