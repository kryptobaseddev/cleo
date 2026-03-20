/**
 * Zod validation schemas for hook event payloads.
 *
 * Provides runtime validation for all hook payload types defined in
 * ./types.ts. Each schema mirrors its corresponding TypeScript interface
 * and can be used to validate payloads at dispatch time.
 *
 * @module @cleocode/cleo/hooks/payload-schemas
 */

import { z } from 'zod/v4';
import type { HookEvent } from './types.js';

// ============================================================================
// Base Payload Schema
// ============================================================================

/** Zod schema for {@link HookPayload}. */
export const HookPayloadSchema = z.object({
  timestamp: z.iso.datetime(),
  sessionId: z.string().optional(),
  taskId: z.string().optional(),
  providerId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================================
// CAAMP-mapped Event Payload Schemas
// ============================================================================

/** Zod schema for {@link OnSessionStartPayload}. */
export const OnSessionStartPayloadSchema = HookPayloadSchema.extend({
  sessionId: z.string(),
  name: z.string(),
  scope: z.string(),
  agent: z.string().optional(),
});

/** Zod schema for {@link OnSessionEndPayload}. */
export const OnSessionEndPayloadSchema = HookPayloadSchema.extend({
  sessionId: z.string(),
  duration: z.number(),
  tasksCompleted: z.array(z.string()),
});

/** Zod schema for {@link OnToolStartPayload}. */
export const OnToolStartPayloadSchema = HookPayloadSchema.extend({
  taskId: z.string(),
  taskTitle: z.string(),
  previousTask: z.string().optional(),
});

/** Zod schema for {@link OnToolCompletePayload}. */
export const OnToolCompletePayloadSchema = HookPayloadSchema.extend({
  taskId: z.string(),
  taskTitle: z.string(),
  status: z.enum(['done', 'archived', 'cancelled']),
});

/** Zod schema for {@link OnFileChangePayload}. */
export const OnFileChangePayloadSchema = HookPayloadSchema.extend({
  filePath: z.string(),
  changeType: z.enum(['write', 'create', 'delete']),
  sizeBytes: z.number().optional(),
});

/** Zod schema for {@link OnErrorPayload}. */
export const OnErrorPayloadSchema = HookPayloadSchema.extend({
  errorCode: z.union([z.number(), z.string()]),
  message: z.string(),
  domain: z.string().optional(),
  operation: z.string().optional(),
  gateway: z.string().optional(),
  stack: z.string().optional(),
});

/** Zod schema for {@link OnPromptSubmitPayload}. */
export const OnPromptSubmitPayloadSchema = HookPayloadSchema.extend({
  gateway: z.string(),
  domain: z.string(),
  operation: z.string(),
  source: z.string().optional(),
});

/** Zod schema for {@link OnResponseCompletePayload}. */
export const OnResponseCompletePayloadSchema = HookPayloadSchema.extend({
  gateway: z.string(),
  domain: z.string(),
  operation: z.string(),
  success: z.boolean(),
  durationMs: z.number().optional(),
  errorCode: z.string().optional(),
});

// ============================================================================
// CLEO Internal Event Payload Schemas
// ============================================================================

/** Zod schema for {@link OnWorkAvailablePayload}. */
export const OnWorkAvailablePayloadSchema = HookPayloadSchema.extend({
  taskIds: z.array(z.string()),
  epicId: z.string().optional(),
  chainId: z.string().optional(),
  reason: z
    .enum(['dependency-cleared', 'new-task', 'retry', 'manual', 'patrol'])
    .optional(),
});

/** Zod schema for {@link OnAgentSpawnPayload}. */
export const OnAgentSpawnPayloadSchema = HookPayloadSchema.extend({
  agentId: z.string(),
  role: z.string(),
  adapterId: z.string().optional(),
  taskId: z.string().optional(),
});

/** Zod schema for {@link OnAgentCompletePayload}. */
export const OnAgentCompletePayloadSchema = HookPayloadSchema.extend({
  agentId: z.string(),
  role: z.string(),
  status: z.enum(['complete', 'partial', 'blocked', 'failed']),
  taskId: z.string().optional(),
  summary: z.string().optional(),
});

/** Zod schema for {@link OnCascadeStartPayload}. */
export const OnCascadeStartPayloadSchema = HookPayloadSchema.extend({
  cascadeId: z.string(),
  chainId: z.string().optional(),
  tesseraId: z.string().optional(),
  taskIds: z.array(z.string()).optional(),
});

/** Zod schema for {@link OnPatrolPayload}. */
export const OnPatrolPayloadSchema = HookPayloadSchema.extend({
  watcherId: z.string(),
  patrolType: z.enum(['health', 'sweep', 'refinery', 'watcher', 'custom']),
  scope: z.string().optional(),
});

// ============================================================================
// Event -> Schema Mapping
// ============================================================================

/**
 * Map from hook event name to its corresponding Zod schema.
 *
 * Used by {@link validatePayload} for runtime dispatch. Events not in
 * this map fall back to the base {@link HookPayloadSchema}.
 */
const EVENT_SCHEMA_MAP: Partial<Record<HookEvent, z.ZodType>> = {
  onSessionStart: OnSessionStartPayloadSchema,
  onSessionEnd: OnSessionEndPayloadSchema,
  onToolStart: OnToolStartPayloadSchema,
  onToolComplete: OnToolCompletePayloadSchema,
  onFileChange: OnFileChangePayloadSchema,
  onError: OnErrorPayloadSchema,
  onPromptSubmit: OnPromptSubmitPayloadSchema,
  onResponseComplete: OnResponseCompletePayloadSchema,
  onWorkAvailable: OnWorkAvailablePayloadSchema,
  onAgentSpawn: OnAgentSpawnPayloadSchema,
  onAgentComplete: OnAgentCompletePayloadSchema,
  onCascadeStart: OnCascadeStartPayloadSchema,
  onPatrol: OnPatrolPayloadSchema,
};

// ============================================================================
// Validator Function
// ============================================================================

/** Result of payload validation. */
export interface PayloadValidationResult {
  /** Whether the payload passed validation. */
  valid: boolean;
  /** Validation errors (empty when valid). */
  errors: string[];
}

/**
 * Validate a hook payload against its event-specific Zod schema.
 *
 * Falls back to the base {@link HookPayloadSchema} for events without
 * a dedicated schema. Returns a result object rather than throwing,
 * so callers can decide how to handle validation failures.
 *
 * @param event - The hook event name
 * @param payload - The payload to validate
 * @returns Validation result with any error messages
 */
export function validatePayload(event: HookEvent, payload: unknown): PayloadValidationResult {
  const schema = EVENT_SCHEMA_MAP[event] ?? HookPayloadSchema;
  const result = schema.safeParse(payload);

  if (result.success) {
    return { valid: true, errors: [] };
  }

  const errors = result.error.issues.map(
    (issue) => `${issue.path.join('.')}: ${issue.message}`,
  );

  return { valid: false, errors };
}
