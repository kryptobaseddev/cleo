/**
 * @cleocode/core — CLEO core business logic package.
 *
 * Re-exports all public APIs from src/core/ via the root barrel export.
 * This package is a thin wrapper that makes the core layer consumable
 * as a standalone npm workspace package.
 *
 * Consumers: @cleocode/cleo (cli + mcp + dispatch layers)
 *
 * @package @cleocode/core
 * @epic T5701
 * @task T5713
 */

export * from '../../../src/core/index.js';

// Cleo facade class for project-bound API access
export { Cleo } from './cleo.js';
export type { CleoTasksApi } from './cleo.js';
