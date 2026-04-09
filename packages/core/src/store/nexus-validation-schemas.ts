/**
 * Drizzle-derived Zod validation schemas for CLEO nexus.db tables.
 *
 * Uses `drizzle-orm/zod` to generate insert/select validation schemas
 * directly from Drizzle table definitions in `./nexus-schema.ts`.
 *
 * Domain types (NexusProject, NexusRegistryFile, etc.) live in
 * `../nexus/registry.ts` as plain interfaces — they have different
 * field names from the DB rows, so they cannot be derived from
 * createSelectSchema. The row-to-domain mapping is handled by
 * `rowToProject()` in `../nexus/registry.ts`.
 *
 * @module nexus-validation-schemas
 */

import { createSchemaFactory } from 'drizzle-orm/zod';
import { z } from 'zod';

// Use factory to bind our zod instance — ensures drizzle-orm/zod uses
// the same z we use everywhere. The type assertion is needed because
// drizzle-orm beta.18's CoerceOptions type doesn't match zod's coerce
// namespace shape (works correctly at runtime).
const { createInsertSchema, createSelectSchema } = createSchemaFactory(
  z as unknown as Parameters<typeof createSchemaFactory>[0],
);

import { nexusAuditLog, nexusSchemaMeta, projectRegistry } from './nexus-schema.js';

// === PROJECT REGISTRY ===

export const insertProjectRegistrySchema = createInsertSchema(projectRegistry, {
  projectId: (s: z.ZodString) => s.min(1),
  projectHash: (s: z.ZodString) => s.regex(/^[a-f0-9]{12}$/),
  projectPath: (s: z.ZodString) => s.min(1),
  name: (s: z.ZodString) => s.min(1).max(64),
});
export const selectProjectRegistrySchema = createSelectSchema(projectRegistry);

// === NEXUS AUDIT LOG ===

export const insertNexusAuditLogSchema = createInsertSchema(nexusAuditLog, {
  id: (s: z.ZodString) => s.min(1),
  action: (s: z.ZodString) => s.min(1).max(100),
});
export const selectNexusAuditLogSchema = createSelectSchema(nexusAuditLog);

// === NEXUS SCHEMA META ===

export const insertNexusSchemaMetaSchema = createInsertSchema(nexusSchemaMeta);
export const selectNexusSchemaMetaSchema = createSelectSchema(nexusSchemaMeta);

// === INFERRED TYPES ===

export type InsertProjectRegistry = z.infer<typeof insertProjectRegistrySchema>;
export type SelectProjectRegistry = z.infer<typeof selectProjectRegistrySchema>;

export type InsertNexusAuditLog = z.infer<typeof insertNexusAuditLogSchema>;
export type SelectNexusAuditLog = z.infer<typeof selectNexusAuditLogSchema>;

export type InsertNexusSchemaMeta = z.infer<typeof insertNexusSchemaMetaSchema>;
export type SelectNexusSchemaMeta = z.infer<typeof selectNexusSchemaMetaSchema>;
