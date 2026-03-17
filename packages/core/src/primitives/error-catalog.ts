/**
 * Re-export error catalog from canonical source.
 * Used by packages/core/src/primitives/ to break store→core circular deps.
 *
 * @epic T5716
 */

export {
  ERROR_CATALOG,
  getAllErrorDefinitions,
  getErrorDefinition,
  getErrorDefinitionByLafsCode,
} from '../../../../src/core/error-catalog.js';
export type { ErrorDefinition } from '../../../../src/core/error-catalog.js';
