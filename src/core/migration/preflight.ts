/**
 * Backward-compatible pre-flight migration exports.
 *
 * Runtime callers should import from src/core/system/storage-preflight.ts.
 *
 * @task T5305
 */

export { checkStorageMigration } from '../system/storage-preflight.js';
export type { PreflightResult } from '../system/storage-preflight.js';
