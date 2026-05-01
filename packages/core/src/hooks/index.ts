/**
 * Hooks System - Barrel Export
 *
 * Central export point for the CLEO hooks system.
 * Import from here to access the hook registry, types, handlers, and
 * Zod payload validation schemas.
 *
 * @module @cleocode/core/hooks
 */

export * from './handlers/index.js';
// Hooks engine-ops (ENG-MIG-12 / T1579) — EngineResult wrappers for hook operations
export type { HookMatrixResult, ProviderMatrixEntry } from './engine-ops.js';
export { queryCommonHooks, queryHookProviders, systemHooksMatrix } from './engine-ops.js';
export type { PayloadValidationResult } from './payload-schemas.js';
export {
  HookPayloadSchema,
  OnAgentCompletePayloadSchema,
  OnAgentSpawnPayloadSchema,
  OnCascadeStartPayloadSchema,
  OnErrorPayloadSchema,
  OnFileChangePayloadSchema,
  OnPatrolPayloadSchema,
  OnPromptSubmitPayloadSchema,
  OnResponseCompletePayloadSchema,
  OnSessionEndPayloadSchema,
  OnSessionStartPayloadSchema,
  OnToolCompletePayloadSchema,
  OnToolStartPayloadSchema,
  OnWorkAvailablePayloadSchema,
  validatePayload,
} from './payload-schemas.js';
export { HookRegistry, hooks } from './registry.js';
export type * from './types.js';
