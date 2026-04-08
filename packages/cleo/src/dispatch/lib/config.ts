/**
 * Configuration for the dispatch layer.
 *
 * Re-exports shared configuration utilities from config-loader.ts
 * and defaults.ts.
 *
 * @task T4830
 */

export {
  ConfigValidationError,
  getConfig,
  loadConfig,
  resetConfig,
  validateConfig,
} from './config-loader.js';

export type { DispatchConfig } from './defaults.js';
