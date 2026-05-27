/**
 * Adapter manifest and discovery contracts for CLEO provider adapters.
 *
 * @task T5240
 */

import type { AdapterCapabilities } from './capabilities.js';

export interface AdapterManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Provider identifier, e.g. "claude-code", "opencode", "cursor" */
  provider: string;
  /** Relative path to the main adapter module */
  entryPoint: string;
  /**
   * Resolved absolute path to the adapter package root.
   * Populated at discovery time by discoverAdapterManifests().
   */
  packagePath: string;
  capabilities: AdapterCapabilities;
  detectionPatterns: DetectionPattern[];
}

export interface DetectionPattern {
  type: 'env' | 'file' | 'process' | 'cli';
  pattern: string;
  description: string;
}
