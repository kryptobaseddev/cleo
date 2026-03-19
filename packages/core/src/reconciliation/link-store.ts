/**
 * External task link persistence — DB-backed link tracking for reconciliation.
 *
 * Manages the external_task_links table in tasks.db. Used by the reconciliation
 * engine to match external tasks to existing CLEO tasks and track sync history.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import type { ExternalTaskLink } from '@cleocode/contracts';
import { getDb } from '../store/sqlite.js';
import { externalTaskLinks } from '../store/tasks-schema.js';

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
export async function getLinksByTaskId(
  taskId: string,
  cwd?: string,
): Promise<ExternalTaskLink[]> {
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(externalTaskLinks)
    .where(eq(externalTaskLinks.taskId, taskId));
  return rows.map(rowToLink);
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Create a new external task link.
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
export async function removeLinksByProvider(
  providerId: string,
  cwd?: string,
): Promise<number> {
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
    metadata: row.metadataJson ? (JSON.parse(row.metadataJson) as Record<string, unknown>) : undefined,
    linkedAt: row.linkedAt,
    lastSyncAt: row.lastSyncAt,
  };
}
