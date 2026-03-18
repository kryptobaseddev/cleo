/**
 * Re-export error catalog from canonical source.
 * Used by packages/core/src/primitives/ to break store→core circular deps.
 *
 * @epic T5716
 */

export type { ErrorDefinition } from '../core/error-catalog.js';
export {
  ERROR_CATALOG,
  getAllErrorDefinitions,
  getErrorDefinition,
  getErrorDefinitionByLafsCode,
} from '../core/error-catalog.js';
