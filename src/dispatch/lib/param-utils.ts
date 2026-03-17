/**
 * Param derivation utilities (Backward-Compat Re-export)
 *
 * Thin wrapper that re-exports from the canonical location at
 * src/core/validation/param-utils.ts.
 *
 * @task T5706
 */

export type {
  CommanderArgSplit,
  JSONSchemaObject,
  JsonSchemaProperty,
  JsonSchemaType,
} from '../../core/validation/param-utils.js';
export {
  buildCommanderArgs,
  buildCommanderOptionString,
  buildMcpInputSchema,
  camelToKebab,
  validateRequiredParamsDef,
} from '../../core/validation/param-utils.js';
