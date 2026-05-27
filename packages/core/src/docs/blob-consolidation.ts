/**
 * Blob Consolidation — migrates legacy attachments (tasks.db + filesystem)
 * into the unified blob store (manifest.db + .cleo/blobs/blobs/).
 *
 * Consolidation strategy:
 *   1. Read every attachment from tasks.db (with its refs for owner mapping).
 *   2. Find the legacy blob file on disk at .cleo/attachments/sha256/<pref>/<rest>.<ext>.
 *   3. Read bytes and re-attach via CleoBlobStore — this naturally deduplicates
 *      (SHA-256 is content-addressed) and writes to both the new filesystem path
 *      and the manifest.db row.
 *   4. Track statistics: total, migrated, already-present, missing-files, errors.
 *
 * Idempotent: re-running skips blobs already registered in the new blob store.
 *
 * @task T11183 (Epic T10519 / Saga T10516)
 */

import { type Dirent, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { getProjectRoot } from '../paths.js';
import { CleoBlobStore } from '../store/llmtxt-blob-adapter.js';
import { attachmentRefs, attachments as attachmentsTable } from '../store/schema/attachments.js';
import { getDb } from '../store/sqlite.js';

export interface ConsolidationStats {
  total: number;
  migrated: number;
  alreadyPresent: number;
  missingFiles: number;
  errors: number;
  errorDetails: Array<{ attachmentId: string; sha256: string; message: string }>;
}

export interface ConsolidationOptions {
  projectRoot?: string;
  dryRun?: boolean;
  limit?: number;
}

function findLegacyBlobPath(projectRoot: string, sha256: string): string | null {
  const prefix = sha256.slice(0, 2);
  const rest = sha256.slice(2);
  const dir = join(projectRoot, '.cleo', 'attachments', 'sha256', prefix);
  try {
    const entries: Dirent[] = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith(rest)) return join(dir, entry.name);
    }
  } catch {
    /* dir may not exist */
  }
  return null;
}

function buildExistingShaSet(projectRoot: string): Set<string> {
  const shas = new Set<string>();
  const blobsDir = join(projectRoot, '.cleo', 'blobs', 'blobs');
  try {
    for (const entry of readdirSync(blobsDir)) {
      if (entry.length === 64 && /^[0-9a-f]{64}$/.test(entry)) shas.add(entry);
    }
  } catch {
    /* dir may not exist */
  }
  return shas;
}

function deriveBlobName(slug: string | null, _type: string | null, attachmentId: string): string {
  if (slug) return slug.includes('.') ? slug : `${slug}.md`;
  return `${attachmentId}.md`;
}

function deriveContentType(blobName: string): string {
  if (blobName.endsWith('.md')) return 'text/markdown';
  if (blobName.endsWith('.txt')) return 'text/plain';
  if (blobName.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

export async function consolidateBlobs(
  options: ConsolidationOptions = {},
): Promise<ConsolidationStats> {
  const root = options.projectRoot ?? getProjectRoot();
  const dryRun = options.dryRun ?? false;
  const limit = options.limit ?? Infinity;

  const stats: ConsolidationStats = {
    total: 0,
    migrated: 0,
    alreadyPresent: 0,
    missingFiles: 0,
    errors: 0,
    errorDetails: [],
  };

  let rows: Array<{
    attachmentId: string;
    sha256: string;
    slug: string | null;
    type: string | null;
    ownerId: string | null;
  }> = [];
  try {
    const db = await getDb();
    rows = db
      .select({
        attachmentId: attachmentsTable.id,
        sha256: attachmentsTable.sha256,
        slug: attachmentsTable.slug,
        type: attachmentsTable.type,
        ownerId: attachmentRefs.ownerId,
      })
      .from(attachmentsTable)
      .leftJoin(attachmentRefs, eq(attachmentsTable.id, attachmentRefs.attachmentId))
      .all();
  } catch (err) {
    stats.errors++;
    stats.errorDetails.push({
      attachmentId: 'N/A',
      sha256: 'N/A',
      message: `Failed to read attachments: ${String(err)}`,
    });
    return stats;
  }

  stats.total = Math.min(rows.length, limit);
  const existingShas = dryRun ? new Set<string>() : buildExistingShaSet(root);

  let blobStore: CleoBlobStore | null = null;
  if (!dryRun) {
    blobStore = new CleoBlobStore({ projectRoot: root });
    await blobStore.open();
  }

  try {
    let processed = 0;
    for (const row of rows) {
      if (processed >= limit) break;
      processed++;
      const { attachmentId, sha256, slug, type, ownerId } = row;
      const docSlug = ownerId ?? '__project__';
      const blobName = deriveBlobName(slug, type, attachmentId);

      if (existingShas.has(sha256)) {
        stats.alreadyPresent++;
        continue;
      }

      const legacyPath = findLegacyBlobPath(root, sha256);
      if (!legacyPath) {
        stats.missingFiles++;
        continue;
      }

      try {
        const bytes = await readFile(legacyPath);
        if (!dryRun && blobStore) {
          await blobStore.attach(
            docSlug,
            blobName,
            new Uint8Array(bytes),
            deriveContentType(blobName),
          );
        }
        stats.migrated++;
      } catch (err) {
        stats.errors++;
        if (stats.errorDetails.length < 50) {
          stats.errorDetails.push({
            attachmentId,
            sha256,
            message: `Migration failed: ${String(err)}`,
          });
        }
      }
    }
  } finally {
    if (blobStore) {
      try {
        await blobStore.close();
      } catch {
        /* cleanup */
      }
    }
  }
  return stats;
}

export async function verifyConsolidation(options: { projectRoot?: string } = {}): Promise<{
  consistent: boolean;
  total: number;
  matched: number;
  missing: Array<{ attachmentId: string; sha256: string; slug: string | null }>;
}> {
  const root = options.projectRoot ?? getProjectRoot();
  const result = {
    consistent: true,
    total: 0,
    matched: 0,
    missing: [] as Array<{ attachmentId: string; sha256: string; slug: string | null }>,
  };

  try {
    const db = await getDb();
    const rows = db
      .select({
        attachmentId: attachmentsTable.id,
        sha256: attachmentsTable.sha256,
        slug: attachmentsTable.slug,
        ownerId: attachmentRefs.ownerId,
      })
      .from(attachmentsTable)
      .leftJoin(attachmentRefs, eq(attachmentsTable.id, attachmentRefs.attachmentId))
      .where(sql`${attachmentsTable.slug} IS NOT NULL`)
      .all();

    const blobStore = new CleoBlobStore({ projectRoot: root });
    await blobStore.open();
    try {
      for (const row of rows) {
        result.total++;
        try {
          const blob = await blobStore.get(row.ownerId ?? '__project__', row.slug!);
          if (blob && blob.hash === row.sha256) result.matched++;
          else {
            result.consistent = false;
            result.missing.push({
              attachmentId: row.attachmentId,
              sha256: row.sha256,
              slug: row.slug,
            });
          }
        } catch {
          result.consistent = false;
          result.missing.push({
            attachmentId: row.attachmentId,
            sha256: row.sha256,
            slug: row.slug,
          });
        }
      }
    } finally {
      await blobStore.close();
    }
  } catch (err) {
    result.consistent = false;
    result.missing.push({ attachmentId: 'N/A', sha256: 'N/A', slug: `Error: ${String(err)}` });
  }
  return result;
}
