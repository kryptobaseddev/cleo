/**
 * Zod schema for audit log insert payloads (T4848).
 *
 * A leaf: the audit middleware validates every row it writes against it, and
 * importing it from `./validation-schemas.ts` built all ~40 table schemas on
 * every CLI mutation (T13126). `./validation-schemas.ts` re-exports it.
 *
 * @module
 * @task T4848
 * @task T13126
 */

import type { z } from 'zod';
import { auditLog } from './tasks-schema.js';
import { createInsertSchema } from './zod-schema-factory.js';

/**
 * Zod schema for validating audit log insert payloads.
 * @task T4848
 */
export const insertAuditLogSchema = createInsertSchema(auditLog, {
  id: (s: z.ZodString) => s.uuid(),
  timestamp: (s: z.ZodString) =>
    s.datetime({ offset: true }).or(s.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)),
  action: (s: z.ZodString) => s.min(1).max(100),
  taskId: (s: z.ZodString) => s.min(1).max(20),
  actor: (s: z.ZodString) => s.min(1).max(50),
});

/**
 * Canonical named export for audit log insert schema (T4848).
 * Alias for insertAuditLogSchema.
 */
export const AuditLogInsertSchema = insertAuditLogSchema;
