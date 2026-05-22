/**
 * Attachment storage tables: attachments, attachment_refs.
 *
 * @epic T760
 * @task T796
 */

import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const ATTACHMENT_OWNER_TYPES = [
  'task',
  'observation',
  'session',
  'decision',
  'learning',
  'pattern',
] as const;

/**
 * Registry of stored attachments (blob content).
 *
 * Storage path: `.cleo/attachments/sha256/<sha256[0..2]>/<sha256[2..]>.<ext>`
 *
 * @epic T760
 * @task T796
 */
export const attachments = sqliteTable(
  'attachments',
  {
    /** Unique attachment identifier (UUID v4). */
    id: text('id').primaryKey(),
    /** SHA-256 hex digest of the uncompressed content. Unique across the registry. */
    sha256: text('sha256').notNull().unique(),
    /** Serialised `Attachment` discriminated union (all kind-specific fields). */
    attachmentJson: text('attachment_json').notNull(),
    /** ISO 8601 timestamp when this attachment was first registered. */
    createdAt: text('created_at').notNull(),
    /**
     * How many `attachment_refs` rows point at this attachment.
     *
     * When `ref_count` drops to zero the blob is eligible for GC.
     * Blobs are NEVER auto-deleted — use `cleo docs attachments gc`.
     */
    refCount: integer('ref_count').notNull().default(0),
    /**
     * Optional human-friendly slug for the attachment, unique per project.
     *
     * @task T9636 (Epic T9627 / Saga T9625)
     */
    slug: text('slug'),
    /**
     * Optional taxonomy classification for the attachment.
     *
     * @task T9637 (Epic T9627 / Saga T9625)
     */
    type: text('type'),
  },
  (table) => [index('idx_attachments_sha256').on(table.sha256)],
);

/**
 * Ref-counted junction table linking attachments to owner entities.
 *
 * @epic T760
 * @task T796
 */
export const attachmentRefs = sqliteTable(
  'attachment_refs',
  {
    /** ID of the attachment (→ `attachments.id`). */
    attachmentId: text('attachment_id').notNull(),
    /**
     * The domain entity type that owns this ref.
     */
    ownerType: text('owner_type', { enum: ATTACHMENT_OWNER_TYPES }).notNull(),
    /** The ID of the owning entity. */
    ownerId: text('owner_id').notNull(),
    /** ISO 8601 timestamp when this ref was created. */
    attachedAt: text('attached_at').notNull(),
    /** Agent identity (or `"human"`) that created this ref. */
    attachedBy: text('attached_by'),
  },
  (table) => [
    primaryKey({ columns: [table.attachmentId, table.ownerType, table.ownerId] }),
    index('idx_attachment_refs_attachment_id').on(table.attachmentId),
    index('idx_attachment_refs_owner').on(table.ownerType, table.ownerId),
  ],
);

// === TYPE EXPORTS ===

export type AttachmentRow = typeof attachments.$inferSelect;
export type NewAttachmentRow = typeof attachments.$inferInsert;
export type AttachmentRefRow = typeof attachmentRefs.$inferSelect;
export type NewAttachmentRefRow = typeof attachmentRefs.$inferInsert;
