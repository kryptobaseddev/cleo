/**
 * Hooks System - Barrel Export
 *
 * Central export point for the CLEO hooks system.
 * Import from here to access the hook registry, types, handlers, and
 * Zod payload validation schemas.
 *
 * @module @cleocode/cleo/hooks
 */

export * from './handlers/index.js';
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
export type { PayloadValidationResult } from './payload-schemas.js';
export { HookRegistry, hooks } from './registry.js';
export type * from './types.js';
