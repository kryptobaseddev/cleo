/**
 * Zod validation schemas for hook event payloads.
 *
 * Provides runtime validation for all hook payload types defined in
 * ./types.ts. Each schema mirrors its corresponding TypeScript interface
 * and can be used to validate payloads at dispatch time.
 *
 * @module @cleocode/cleo/hooks/payload-schemas
 */

import { z } from 'zod';
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

/** Zod schema for {@link SessionStartPayload}. */
export const SessionStartPayloadSchema = HookPayloadSchema.extend({
  sessionId: z.string(),
  name: z.string(),
  scope: z.string(),
  agent: z.string().optional(),
});

/** @deprecated Use {@link SessionStartPayloadSchema}. Kept for backward compatibility. */
export const OnSessionStartPayloadSchema = SessionStartPayloadSchema;

/** Zod schema for {@link SessionEndPayload}. */
export const SessionEndPayloadSchema = HookPayloadSchema.extend({
  sessionId: z.string(),
  duration: z.number(),
  tasksCompleted: z.array(z.string()),
});

/** @deprecated Use {@link SessionEndPayloadSchema}. Kept for backward compatibility. */
export const OnSessionEndPayloadSchema = SessionEndPayloadSchema;

/** Zod schema for {@link PreToolUsePayload}. */
export const PreToolUsePayloadSchema = HookPayloadSchema.extend({
  taskId: z.string(),
  taskTitle: z.string(),
  previousTask: z.string().optional(),
  toolName: z.string().optional(),
  toolInput: z.record(z.string(), z.unknown()).optional(),
});

/** @deprecated Use {@link PreToolUsePayloadSchema}. Kept for backward compatibility. */
export const OnToolStartPayloadSchema = PreToolUsePayloadSchema;

/** Zod schema for {@link PostToolUsePayload}. */
export const PostToolUsePayloadSchema = HookPayloadSchema.extend({
  taskId: z.string(),
  taskTitle: z.string(),
  status: z.enum(['done', 'archived', 'cancelled']),
  toolResult: z.record(z.string(), z.unknown()).optional(),
});

/** @deprecated Use {@link PostToolUsePayloadSchema}. Kept for backward compatibility. */
export const OnToolCompletePayloadSchema = PostToolUsePayloadSchema;

/** Zod schema for {@link NotificationPayload}. */
export const NotificationPayloadSchema = HookPayloadSchema.extend({
  filePath: z.string().optional(),
  changeType: z.enum(['write', 'create', 'delete']).optional(),
  sizeBytes: z.number().optional(),
  message: z.string().optional(),
});

/** @deprecated Use {@link NotificationPayloadSchema}. Kept for backward compatibility. */
export const OnFileChangePayloadSchema = NotificationPayloadSchema;

/** Zod schema for {@link PostToolUseFailurePayload}. */
export const PostToolUseFailurePayloadSchema = HookPayloadSchema.extend({
  errorCode: z.union([z.number(), z.string()]),
  message: z.string(),
  domain: z.string().optional(),
  operation: z.string().optional(),
  gateway: z.string().optional(),
  stack: z.string().optional(),
});

/** @deprecated Use {@link PostToolUseFailurePayloadSchema}. Kept for backward compatibility. */
export const OnErrorPayloadSchema = PostToolUseFailurePayloadSchema;

/** Zod schema for {@link PromptSubmitPayload}. */
export const PromptSubmitPayloadSchema = HookPayloadSchema.extend({
  gateway: z.string(),
  domain: z.string(),
  operation: z.string(),
  source: z.string().optional(),
});

/** @deprecated Use {@link PromptSubmitPayloadSchema}. Kept for backward compatibility. */
export const OnPromptSubmitPayloadSchema = PromptSubmitPayloadSchema;

/** Zod schema for {@link ResponseCompletePayload}. */
export const ResponseCompletePayloadSchema = HookPayloadSchema.extend({
  gateway: z.string(),
  domain: z.string(),
  operation: z.string(),
  success: z.boolean(),
  durationMs: z.number().optional(),
  errorCode: z.string().optional(),
});

/** @deprecated Use {@link ResponseCompletePayloadSchema}. Kept for backward compatibility. */
export const OnResponseCompletePayloadSchema = ResponseCompletePayloadSchema;

/** Zod schema for {@link SubagentStartPayload}. */
export const SubagentStartPayloadSchema = HookPayloadSchema.extend({
  agentId: z.string(),
  role: z.string().optional(),
  taskId: z.string().optional(),
});

/** Zod schema for {@link SubagentStopPayload}. */
export const SubagentStopPayloadSchema = HookPayloadSchema.extend({
  agentId: z.string(),
  status: z.enum(['complete', 'partial', 'blocked', 'failed']).optional(),
  taskId: z.string().optional(),
  summary: z.string().optional(),
});

/** Zod schema for {@link PreCompactPayload}. */
export const PreCompactPayloadSchema = HookPayloadSchema.extend({
  tokensBefore: z.number().optional(),
  reason: z.string().optional(),
});

/** Zod schema for {@link PostCompactPayload}. */
export const PostCompactPayloadSchema = HookPayloadSchema.extend({
  tokensBefore: z.number().optional(),
  tokensAfter: z.number().optional(),
  success: z.boolean(),
});

/** Zod schema for {@link ConfigChangePayload}. */
export const ConfigChangePayloadSchema = HookPayloadSchema.extend({
  key: z.string(),
  previousValue: z.unknown().optional(),
  newValue: z.unknown().optional(),
});

// ============================================================================
// CLEO Internal Event Payload Schemas
// ============================================================================

/** Zod schema for {@link OnWorkAvailablePayload}. */
export const OnWorkAvailablePayloadSchema = HookPayloadSchema.extend({
  taskIds: z.array(z.string()),
  epicId: z.string().optional(),
  chainId: z.string().optional(),
  reason: z.enum(['dependency-cleared', 'new-task', 'retry', 'manual', 'patrol']).optional(),
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
  // CAAMP canonical events (16)
  SessionStart: SessionStartPayloadSchema,
  SessionEnd: SessionEndPayloadSchema,
  PreToolUse: PreToolUsePayloadSchema,
  PostToolUse: PostToolUsePayloadSchema,
  Notification: NotificationPayloadSchema,
  PostToolUseFailure: PostToolUseFailurePayloadSchema,
  PromptSubmit: PromptSubmitPayloadSchema,
  ResponseComplete: ResponseCompletePayloadSchema,
  SubagentStart: SubagentStartPayloadSchema,
  SubagentStop: SubagentStopPayloadSchema,
  PreCompact: PreCompactPayloadSchema,
  PostCompact: PostCompactPayloadSchema,
  ConfigChange: ConfigChangePayloadSchema,
  // CLEO internal coordination events (5)
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

  const errors = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);

  return { valid: false, errors };
}
