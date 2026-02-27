/**
 * ADR Core Module (ADR-017)
 *
 * Barrel export for ADR operations.
 *
 * @task T4792
 */

export { parseAdrFile, parseFrontmatter, extractAdrId, extractTitle } from './parse.js';
export { validateAllAdrs } from './validate.js';
export type { AdrValidationError, AdrValidationResult } from './validate.js';
export { syncAdrsToDb } from './sync.js';
export { listAdrs } from './list.js';
export { showAdr } from './show.js';
export type { AdrFrontmatter, AdrRecord, AdrSyncResult, AdrListResult } from './types.js';
