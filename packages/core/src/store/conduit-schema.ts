/**
 * Drizzle ORM schema for CLEO conduit.db (project-tier messaging database).
 *
 * Reverse-engineered from the inline `CONDUIT_SCHEMA_SQL` constant that lived
 * in conduit-sqlite.ts (T344, T1252). Replaces the bare-SQL bootstrap with
 * Drizzle table objects so drizzle-kit generate / check can operate on this
 * database, and so it can be unified under the canonical `migration-manager.ts`
 * runner alongside tasks/brain/nexus/signaldock/telemetry (T1407 follow-up to
 * T1166 + T1176 unification work).
 *
 * Tables (17 logical, 16 modelled here):
 *   - conversations              — LocalTransport DM threads
 *   - messages                   — Project-scoped agent-to-agent messages
 *   - delivery_jobs              — Async delivery queue
 *   - dead_letters               — Messages that exceeded max delivery attempts
 *   - message_pins               — Pinned messages within a conversation
 *   - attachments                — File/blob attachments
 *   - attachment_versions        — Version history for collaborative editing
 *   - attachment_approvals       — Approval records for content review
 *   - attachment_contributors    — Contributor statistics per attachment
 *   - project_agent_refs         — Per-project agent reference overrides (ADR-037 §3)
 *   - topics                     — A2A pub-sub channels (T1252)
 *   - topic_subscriptions        — Topic subscription bindings
 *   - topic_messages             — Broadcast messages published to a topic
 *   - topic_message_acks         — Per-subscriber delivery tracking
 *   - _conduit_meta              — Schema metadata (key-value)
 *   - _conduit_migrations        — Legacy migration tracking (pre-Drizzle)
 *
 * Not modelled here (handled as raw SQL in baseline migration):
 *   - messages_fts (FTS5 virtual table) + 3 triggers (messages_ai/ad/au)
 *     — drizzle-orm sqlite-core does not model FTS5 virtual tables. The
 *       baseline marker leaves these in place because reconcileJournal
 *       Scenario 1 detects the existing schema; for fresh DBs, the legacy
 *       `applyConduitSchema()` path bootstraps the FTS5 table + triggers
 *       via `CREATE VIRTUAL TABLE IF NOT EXISTS` before the Drizzle
 *       runner takes over.
 *
 * Project-tier ONLY. This schema MUST NOT include tables from signaldock.db
 * (global identity: agents, capabilities, skills, etc.).
 *
 * @task T1407 (DB SSoT — split conduit-sqlite into schema + sqlite)
 * @related T344 (original conduit-sqlite implementation)
 * @related T1166 (signaldock unification — pattern reference)
 * @related T1252 (A2A topic tables)
 * @related ADR-037 (signaldock/conduit split)
 */

import { sql } from 'drizzle-orm';
import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// Conversations & messages
// ---------------------------------------------------------------------------

/**
 * Project-scoped conversations (LocalTransport DM threads).
 *
 * @task T344
 */
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  participants: text('participants').notNull(),
  visibility: text('visibility').notNull().default('private'),
  messageCount: integer('message_count').notNull().default(0),
  lastMessageAt: integer('last_message_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Project-scoped agent-to-agent messages (LocalTransport content).
 *
 * Partial indexes on `group_id` and `reply_to` (WHERE ... IS NOT NULL) are
 * preserved in the baseline migration SQL — drizzle-orm sqlite-core does not
 * surface a typed WHERE-clause API for index definitions. The drizzle index
 * declarations below cover the full-column variant; the partial WHERE
 * clauses are recreated by raw SQL in the baseline migration.
 *
 * @task T344
 */
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id),
    fromAgentId: text('from_agent_id').notNull(),
    toAgentId: text('to_agent_id').notNull(),
    content: text('content').notNull(),
    contentType: text('content_type').notNull().default('text'),
    status: text('status').notNull().default('pending'),
    attachments: text('attachments').notNull().default('[]'),
    groupId: text('group_id'),
    metadata: text('metadata').default('{}'),
    replyTo: text('reply_to'),
    createdAt: integer('created_at').notNull(),
    deliveredAt: integer('delivered_at'),
    readAt: integer('read_at'),
  },
  (table) => [
    index('messages_conversation_idx').on(table.conversationId),
    index('messages_from_agent_idx').on(table.fromAgentId),
    index('messages_to_agent_idx').on(table.toAgentId),
    index('messages_created_at_idx').on(table.createdAt),
    index('idx_messages_group_id').on(table.groupId),
    index('idx_messages_reply_to').on(table.replyTo),
  ],
);

// ---------------------------------------------------------------------------
// Delivery queue
// ---------------------------------------------------------------------------

/**
 * Async delivery queue for deferred message dispatch.
 *
 * @task T344
 */
export const deliveryJobs = sqliteTable(
  'delivery_jobs',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').notNull(),
    payload: text('payload').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(6),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('idx_delivery_jobs_status').on(table.status, table.nextAttemptAt)],
);

/**
 * Dead-letter queue for messages that exceeded max delivery attempts.
 *
 * @task T344
 */
export const deadLetters = sqliteTable(
  'dead_letters',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').notNull(),
    jobId: text('job_id').notNull(),
    reason: text('reason').notNull(),
    attempts: integer('attempts').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('idx_dead_letters_message').on(table.messageId)],
);

// ---------------------------------------------------------------------------
// Message pins
// ---------------------------------------------------------------------------

/**
 * Pinned messages within a conversation.
 *
 * @task T344
 */
export const messagePins = sqliteTable(
  'message_pins',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    pinnedBy: text('pinned_by').notNull(),
    note: text('note'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    unique('message_pins_message_pinned_by_unique').on(table.messageId, table.pinnedBy),
    index('idx_pins_conversation').on(table.conversationId),
    index('idx_pins_agent').on(table.pinnedBy),
  ],
);

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * File/blob attachments associated with messages.
 *
 * `content` stores the compressed blob bytes inline (BLOB column).
 *
 * @task T344
 */
export const attachments = sqliteTable(
  'attachments',
  {
    slug: text('slug').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    fromAgentId: text('from_agent_id').notNull(),
    content: blob('content', { mode: 'buffer' }).notNull(),
    originalSize: integer('original_size').notNull(),
    compressedSize: integer('compressed_size').notNull(),
    contentHash: text('content_hash').notNull(),
    format: text('format').notNull().default('text'),
    title: text('title'),
    tokens: integer('tokens').notNull().default(0),
    expiresAt: integer('expires_at').notNull().default(0),
    storageKey: text('storage_key'),
    mode: text('mode').notNull().default('draft'),
    versionCount: integer('version_count').notNull().default(1),
    currentVersion: integer('current_version').notNull().default(1),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('attachments_conversation_idx').on(table.conversationId),
    index('attachments_agent_idx').on(table.fromAgentId),
  ],
);

/**
 * Version history for attachments (collaborative editing).
 *
 * @task T344
 */
export const attachmentVersions = sqliteTable(
  'attachment_versions',
  {
    id: text('id').primaryKey(),
    slug: text('slug')
      .notNull()
      .references(() => attachments.slug, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    authorAgentId: text('author_agent_id').notNull(),
    changeType: text('change_type').notNull().default('patch'),
    patchText: text('patch_text'),
    storageKey: text('storage_key').notNull(),
    contentHash: text('content_hash').notNull(),
    originalSize: integer('original_size').notNull(),
    compressedSize: integer('compressed_size').notNull(),
    tokens: integer('tokens').notNull(),
    changeSummary: text('change_summary'),
    sectionsModified: text('sections_modified').notNull().default('[]'),
    tokensAdded: integer('tokens_added').notNull().default(0),
    tokensRemoved: integer('tokens_removed').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    unique('attachment_versions_slug_version_unique').on(table.slug, table.versionNumber),
    index('idx_attachment_versions_slug').on(table.slug),
    index('idx_attachment_versions_author').on(table.authorAgentId),
  ],
);

/**
 * Approval records for attachment content review.
 *
 * @task T344
 */
export const attachmentApprovals = sqliteTable(
  'attachment_approvals',
  {
    id: text('id').primaryKey(),
    slug: text('slug')
      .notNull()
      .references(() => attachments.slug, { onDelete: 'cascade' }),
    reviewerAgentId: text('reviewer_agent_id').notNull(),
    status: text('status').notNull().default('pending'),
    comment: text('comment'),
    versionReviewed: integer('version_reviewed').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('attachment_approvals_slug_reviewer_unique').on(table.slug, table.reviewerAgentId),
    index('idx_attachment_approvals_slug').on(table.slug),
  ],
);

/**
 * Contributor statistics per attachment (who edited, how much).
 *
 * @task T344
 */
export const attachmentContributors = sqliteTable(
  'attachment_contributors',
  {
    slug: text('slug')
      .notNull()
      .references(() => attachments.slug, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    versionCount: integer('version_count').notNull().default(0),
    totalTokensAdded: integer('total_tokens_added').notNull().default(0),
    totalTokensRemoved: integer('total_tokens_removed').notNull().default(0),
    firstContributionAt: integer('first_contribution_at').notNull(),
    lastContributionAt: integer('last_contribution_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.slug, table.agentId] })],
);

// ---------------------------------------------------------------------------
// Per-project agent reference overrides
// ---------------------------------------------------------------------------

/**
 * Per-project agent reference overrides (ADR-037 §3, Q6=A).
 *
 * `agentId` is a SOFT FK to global signaldock.db:agents.agent_id.
 * Cross-DB FK enforcement is not possible in SQLite; the accessor layer
 * (T355) validates on every cross-DB join.
 *
 * Partial index on `enabled` (WHERE enabled = 1) is preserved as raw SQL
 * in the baseline migration since drizzle-orm does not surface partial
 * indexes via its typed API.
 *
 * @task T353
 * @epic T310
 */
export const projectAgentRefs = sqliteTable('project_agent_refs', {
  agentId: text('agent_id').primaryKey(),
  attachedAt: text('attached_at').notNull(),
  role: text('role'),
  capabilitiesOverride: text('capabilities_override'),
  lastUsedAt: text('last_used_at'),
  enabled: integer('enabled').notNull().default(1),
});

// ---------------------------------------------------------------------------
// A2A topics (T1252 — Wave 9 Agent-to-Agent coordination pub-sub)
// ---------------------------------------------------------------------------

/**
 * A2A Topics — named channels that agents can publish to / subscribe from.
 * Topic names follow `<epicId>.<waveId>` or `<epicId>.coordination`.
 *
 * @task T1252
 */
export const topics = sqliteTable(
  'topics',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(),
    epicId: text('epic_id').notNull(),
    waveId: integer('wave_id'),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('idx_topics_epic').on(table.epicId)],
);

/**
 * A2A Topic subscriptions — links an agent_id to a topic_id.
 * Created by `subscribeTopic()`; removed by `unsubscribeTopic()`.
 *
 * @task T1252
 */
export const topicSubscriptions = sqliteTable(
  'topic_subscriptions',
  {
    topicId: text('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    subscribedAt: integer('subscribed_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.topicId, table.agentId] }),
    index('idx_topic_subscriptions_agent').on(table.agentId),
  ],
);

/**
 * A2A Topic messages — broadcast messages published to a topic.
 * `payload` is stored as JSON text.
 *
 * @task T1252
 */
export const topicMessages = sqliteTable(
  'topic_messages',
  {
    id: text('id').primaryKey(),
    topicId: text('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    fromAgentId: text('from_agent_id').notNull(),
    kind: text('kind').notNull().default('message'),
    content: text('content').notNull(),
    payload: text('payload'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('idx_topic_messages_topic_created').on(table.topicId, table.createdAt)],
);

/**
 * A2A Topic message ACKs — per-subscriber delivery tracking.
 *
 * @task T1252
 */
export const topicMessageAcks = sqliteTable(
  'topic_message_acks',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => topicMessages.id, { onDelete: 'cascade' }),
    subscriberAgentId: text('subscriber_agent_id').notNull(),
    deliveredAt: integer('delivered_at'),
    readAt: integer('read_at'),
  },
  (table) => [primaryKey({ columns: [table.messageId, table.subscriberAgentId] })],
);

// ---------------------------------------------------------------------------
// Schema tracking tables (legacy — pre-Drizzle, retained for backwards-compat)
// ---------------------------------------------------------------------------

/**
 * Legacy meta key-value store. Pre-dates the Drizzle journal — retained so
 * older CLEO installs continue to function during the transition window.
 * New code should rely on `__drizzle_migrations` instead.
 *
 * @task T344
 */
export const conduitMeta = sqliteTable('_conduit_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull().default(sql`(strftime('%s', 'now'))`),
});

/**
 * Legacy migration tracking. Pre-dates the Drizzle journal — retained so
 * older CLEO installs continue to function during the transition window.
 * New code should rely on `__drizzle_migrations` instead.
 *
 * @task T344
 */
export const conduitMigrations = sqliteTable('_conduit_migrations', {
  name: text('name').primaryKey(),
  appliedAt: integer('applied_at').notNull().default(sql`(strftime('%s', 'now'))`),
});

// ---------------------------------------------------------------------------
// Re-export inferred types for downstream use
// ---------------------------------------------------------------------------

/** Row type for the `conversations` table. */
export type Conversation = typeof conversations.$inferSelect;
/** Insert type for the `conversations` table. */
export type NewConversation = typeof conversations.$inferInsert;

/** Row type for the `messages` table. */
export type Message = typeof messages.$inferSelect;
/** Insert type for the `messages` table. */
export type NewMessage = typeof messages.$inferInsert;

/** Row type for the `delivery_jobs` table. */
export type DeliveryJob = typeof deliveryJobs.$inferSelect;

/** Row type for the `attachments` table. */
export type Attachment = typeof attachments.$inferSelect;

/** Row type for the `project_agent_refs` table. */
export type ProjectAgentRefRow = typeof projectAgentRefs.$inferSelect;
/** Insert type for the `project_agent_refs` table. */
export type NewProjectAgentRef = typeof projectAgentRefs.$inferInsert;

/** Row type for the `topics` table. */
export type Topic = typeof topics.$inferSelect;
