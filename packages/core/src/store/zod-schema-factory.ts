/**
 * The drizzle-to-zod schema factory, bound to the zod instance CLEO uses.
 *
 * A leaf, so a module that needs one table's schema (the audit middleware's
 * `AuditLogInsertSchema`) does not evaluate every table schema in
 * `./validation-schemas.ts` (T13126).
 *
 * @module
 * @task T3.4
 * @task T13126
 */

import { createSchemaFactory } from 'drizzle-orm/zod';
import { z } from 'zod';

// Use factory to bind our zod instance — ensures drizzle-orm/zod uses
// the same z we use everywhere. The type assertion is needed because
// drizzle-orm beta.18's CoerceOptions type doesn't match zod's coerce
// namespace shape (works correctly at runtime).
const factory = createSchemaFactory(z as unknown as Parameters<typeof createSchemaFactory>[0]);

/** drizzle-orm/zod's insert-schema builder, bound to CLEO's zod. */
export const createInsertSchema = factory.createInsertSchema;

/** drizzle-orm/zod's select-schema builder, bound to CLEO's zod. */
export const createSelectSchema = factory.createSelectSchema;
