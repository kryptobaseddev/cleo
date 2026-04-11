/**
 * External task link persistence — DB-backed link tracking for reconciliation.
 *
 * Manages the external_task_links table in tasks.db. Used by the reconciliation
 * engine to match external tasks to existing CLEO tasks and track sync history.
 */

import { randomUUID } from 'node:crypto';
import type { ExternalTaskLink } from '@cleocode/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { getLogger } from '../logger.js';
import { getDb } from '../store/sqlite.js';
import { externalTaskLinks } from '../store/tasks-schema.js';

const log = getLogger('link-store');

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Find all links for a given provider.
 */
export async function getLinksByProvider(
  providerId: string,
  cwd?: string,
): Promise<ExternalTaskLink[]> {
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(externalTaskLinks)
    .where(eq(externalTaskLinks.providerId, providerId));
  return rows.map(rowToLink);
}

/**
 * Find a link by provider + external ID.
 */
export async function getLinkByExternalId(
  providerId: string,
  externalId: string,
  cwd?: string,
): Promise<ExternalTaskLink | null> {
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(externalTaskLinks)
    .where(
      and(
        eq(externalTaskLinks.providerId, providerId),
        eq(externalTaskLinks.externalId, externalId),
      ),
    );
  return rows.length > 0 ? rowToLink(rows[0]!) : null;
}

/**
 * Find all links for a given CLEO task.
 */
export async function getLinksByTaskId(taskId: string, cwd?: string): Promise<ExternalTaskLink[]> {
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(externalTaskLinks)
    .where(eq(externalTaskLinks.taskId, taskId));
  return rows.map(rowToLink);
}

// ---------------------------------------------------------------------------
// Table safety
// ---------------------------------------------------------------------------

/**
 * Ensure the external_task_links table exists in the given database.
 *
 * Older project databases (created before the wave0-schema-hardening migration)
 * may lack this table. Rather than aborting operations like nexus transfer,
 * we create the table on demand using CREATE TABLE IF NOT EXISTS.
 *
 * This is idempotent — safe to call on every write operation.
 */
async function ensureExternalTaskLinksTable(cwd?: string): Promise<void> {
  const db = await getDb(cwd);
  try {
    db.run(
      sql.raw(`
        CREATE TABLE IF NOT EXISTS external_task_links (
          id text PRIMARY KEY NOT NULL,
          task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          provider_id text NOT NULL,
          external_id text NOT NULL,
          external_url text,
          external_title text,
          link_type text NOT NULL,
          sync_direction text NOT NULL DEFAULT 'inbound',
          metadata_json text DEFAULT '{}',
          linked_at text NOT NULL DEFAULT (datetime('now')),
          last_sync_at text
        )
      `),
    );
    db.run(
      sql.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_ext_links_task_provider_external ON external_task_links(task_id, provider_id, external_id)`,
      ),
    );
    db.run(
      sql.raw(`CREATE INDEX IF NOT EXISTS idx_ext_links_task_id ON external_task_links(task_id)`),
    );
    db.run(
      sql.raw(
        `CREATE INDEX IF NOT EXISTS idx_ext_links_provider_id ON external_task_links(provider_id)`,
      ),
    );
  } catch (err) {
    log.warn({ err }, 'Failed to ensure external_task_links table exists');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Create a new external task link.
 *
 * Ensures the external_task_links table exists before inserting, providing
 * graceful degradation for older project databases that predate the
 * wave0-schema-hardening migration.
 */
export async function createLink(
  params: {
    taskId: string;
    providerId: string;
    externalId: string;
    externalUrl?: string;
    externalTitle?: string;
    linkType: ExternalTaskLink['linkType'];
    syncDirection?: ExternalTaskLink['syncDirection'];
    metadata?: Record<string, unknown>;
  },
  cwd?: string,
): Promise<ExternalTaskLink> {
  await ensureExternalTaskLinksTable(cwd);
  const db = await getDb(cwd);
  const now = new Date().toISOString();
  const id = randomUUID();

  await db.insert(externalTaskLinks).values({
    id,
    taskId: params.taskId,
    providerId: params.providerId,
    externalId: params.externalId,
    externalUrl: params.externalUrl ?? null,
    externalTitle: params.externalTitle ?? null,
    linkType: params.linkType,
    syncDirection: params.syncDirection ?? 'inbound',
    metadataJson: params.metadata ? JSON.stringify(params.metadata) : '{}',
    linkedAt: now,
    lastSyncAt: now,
  });

  return {
    id,
    taskId: params.taskId,
    providerId: params.providerId,
    externalId: params.externalId,
    externalUrl: params.externalUrl ?? null,
    externalTitle: params.externalTitle ?? null,
    linkType: params.linkType,
    syncDirection: params.syncDirection ?? 'inbound',
    metadata: params.metadata,
    linkedAt: now,
    lastSyncAt: now,
  };
}

/**
 * Update the lastSyncAt and optionally the title/metadata for an existing link.
 */
export async function touchLink(
  linkId: string,
  updates?: {
    externalTitle?: string;
    metadata?: Record<string, unknown>;
  },
  cwd?: string,
): Promise<void> {
  const db = await getDb(cwd);
  const now = new Date().toISOString();
  const values: Record<string, unknown> = { lastSyncAt: now };
  if (updates?.externalTitle !== undefined) {
    values.externalTitle = updates.externalTitle;
  }
  if (updates?.metadata !== undefined) {
    values.metadataJson = JSON.stringify(updates.metadata);
  }

  await db.update(externalTaskLinks).set(values).where(eq(externalTaskLinks.id, linkId));
}

/**
 * Remove all links for a provider (used during provider deregistration).
 */
export async function removeLinksByProvider(providerId: string, cwd?: string): Promise<number> {
  const db = await getDb(cwd);
  const result = await db
    .delete(externalTaskLinks)
    .where(eq(externalTaskLinks.providerId, providerId));
  return Number(result.changes);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToLink(row: typeof externalTaskLinks.$inferSelect): ExternalTaskLink {
  return {
    id: row.id,
    taskId: row.taskId,
    providerId: row.providerId,
    externalId: row.externalId,
    externalUrl: row.externalUrl,
    externalTitle: row.externalTitle,
    linkType: row.linkType as ExternalTaskLink['linkType'],
    syncDirection: row.syncDirection as ExternalTaskLink['syncDirection'],
    metadata: row.metadataJson
      ? (JSON.parse(row.metadataJson) as Record<string, unknown>)
      : undefined,
    linkedAt: row.linkedAt,
    lastSyncAt: row.lastSyncAt,
  };
}
