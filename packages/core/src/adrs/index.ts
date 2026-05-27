/**
 * ADR Core Module (ADR-017)
 *
 * Barrel export for ADR operations.
 *
 * @task T4792
 */

export { findAdrs } from './find.js';
export type { PipelineAdrLinkResult } from './link-pipeline.js';
export { linkPipelineAdr } from './link-pipeline.js';
export { listAdrs } from './list.js';
export { extractAdrId, extractTitle, parseAdrFile, parseFrontmatter } from './parse.js';
export { showAdr } from './show.js';
export { syncAdrsToDb } from './sync.js';
export type {
  AdrFindResult,
  AdrFrontmatter,
  AdrListResult,
  AdrRecord,
  AdrSyncResult,
} from './types.js';
export type { AdrValidationError, AdrValidationResult } from './validate.js';
export { validateAllAdrs } from './validate.js';
