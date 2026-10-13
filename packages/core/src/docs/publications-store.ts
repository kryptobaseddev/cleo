/**
 * Publications ledger store accessors (T13362) — the store-backed replacement
 * for the deprecated `.cleo/docs-publications.json` sidecar.
 *
 * Every read/write of the docs publication ledger goes through this module on
 * the `openDualScopeDb` chokepoint's drizzle handle ({@link getDb}) — gate 3
 * (no raw opens) and gate 28 (no raw SQL writes to the syncing
 * `docs_publications` table; the drizzle upsert compiles to the sanctioned
 * `INSERT … ON CONFLICT … DO UPDATE` form).
 *
 * Semantics:
 *
 *   - Identity is NATURAL over (owner_id, blob_name, published_path): both
 *     devices derive the same row uid for one triple, so a re-publish
 *     coalesces onto one row (gate 37 declaration in
 *     `row-identity-registry.ts`).
 *   - {@link upsertDocsPublication} refreshes `last_blob_sha` /
 *     `published_at` on conflict (latest-publish-wins); nothing is ever
 *     DELETEd here.
 *   - {@link readDocsPublications} carries a one-time, idempotent migration
 *     shim: when the store table is empty and the legacy
 *     `.cleo/docs-publications.json` still holds entries, they are seeded
 *     into the table on first access. The shim is marked for follow-up in
 *     T13362: once the JSON shim has shipped one release, drop the seed path.
 *
 * @module
 * @task T13362
 * @epic T13340
 * @saga T13339
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { naturalRowUid } from '../store/row-identity.js';
import { docsPublications } from '../store/schema/cleo-project/docs.js';
import { getDb } from '../store/sqlite.js';
import type { DocsPublicationRecord } from './docs-ops.js';

/**
 * Marker written next to the legacy JSON once its entries have been seeded
 * into `docs_publications`, so the seed runs at most once per project.
 *
 * Follow-up (T13362): remove the shim — and this marker — one release after
 * the store ledger ships.
 */
const SEED_MARKER = 'docs-publications.json.seeded';

/** Absolute path to the deprecated JSON ledger, for a given project root. */
function legacyLedgerPath(projectRoot: string): string {
  return join(projectRoot, '.cleo', 'docs-publications.json');
}

/** Wire format of `.cleo/docs-publications.json` on disk. */
interface LegacyPublicationsLedger {
  readonly version: 1;
  readonly entries: readonly DocsPublicationRecord[];
}

/**
 * Parse the legacy JSON ledger, tolerating a corrupt or absent file.
 *
 * Only full five-field records survive the filter — a partially-written entry
 * is dropped rather than seeded half-formed.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @returns Validated ledger entries (empty when the file is absent/malformed).
 */
function readLegacyLedger(projectRoot: string): DocsPublicationRecord[] {
  try {
    const raw = readFileSync(legacyLedgerPath(projectRoot), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LegacyPublicationsLedger>;
    if (!parsed || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(
      (e): e is DocsPublicationRecord =>
        !!e &&
        typeof e.ownerId === 'string' &&
        typeof e.blobName === 'string' &&
        typeof e.publishedPath === 'string' &&
        typeof e.lastBlobSha === 'string' &&
        typeof e.publishedAt === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Insert one publication row, coalescing on the natural triple key.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param record - The publication facts (publishedAt is taken as given — the
 *   shim preserves the legacy timestamp, the live path stamps `now`).
 */
async function insertPublicationRow(
  projectRoot: string,
  record: DocsPublicationRecord,
): Promise<void> {
  const db = await getDb(projectRoot);
  await db
    .insert(docsPublications)
    .values({
      ownerId: record.ownerId,
      blobName: record.blobName,
      publishedPath: record.publishedPath,
      lastBlobSha: record.lastBlobSha,
      publishedAt: record.publishedAt,
      uid: naturalRowUid('project', 'docs_publications', [
        record.ownerId,
        record.blobName,
        record.publishedPath,
      ]),
    })
    .onConflictDoNothing()
    .run();
}

/**
 * Record (or refresh) one publication in the store ledger.
 *
 * Upserts on (ownerId, blobName, publishedPath). A conflicting row gets the
 * fresh `lastBlobSha`/`publishedAt` so the ledger always reflects the latest
 * known good publication; the row uid is the natural identity over the triple,
 * so a concurrent publish on another device coalesces onto the same row.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param record - The publication facts; `publishedAt` is stamped here.
 */
export async function upsertDocsPublication(
  projectRoot: string,
  record: Omit<DocsPublicationRecord, 'publishedAt'>,
): Promise<void> {
  const db = await getDb(projectRoot);
  const uid = naturalRowUid('project', 'docs_publications', [
    record.ownerId,
    record.blobName,
    record.publishedPath,
  ]);
  await db
    .insert(docsPublications)
    .values({ ...record, publishedAt: new Date().toISOString(), uid })
    .onConflictDoUpdate({
      target: [docsPublications.ownerId, docsPublications.blobName, docsPublications.publishedPath],
      set: { lastBlobSha: record.lastBlobSha, publishedAt: new Date().toISOString(), uid },
    })
    .run();
}

/**
 * Read every publication row from the store ledger.
 *
 * Legacy shim (T13362 follow-up: remove one release after ship): when the
 * table is empty and `.cleo/docs-publications.json` still holds entries, the
 * entries are seeded idempotently (natural-key insert, `ON CONFLICT DO
 * NOTHING`) and a `.seeded` marker is written so the seed runs once. When the
 * table already holds rows they are authoritative and the JSON is ignored.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @returns All recorded publications (empty when none exist).
 */
export async function readDocsPublications(projectRoot: string): Promise<DocsPublicationRecord[]> {
  let rows: Array<{
    ownerId: string;
    blobName: string;
    publishedPath: string;
    lastBlobSha: string;
    publishedAt: string;
  }>;
  try {
    const db = await getDb(projectRoot);
    rows = await db.select().from(docsPublications).all();
  } catch {
    // Unreadable/absent store — "no publications recorded yet", never a hard
    // error (matches the legacy JSON contract).
    return [];
  }

  if (rows.length > 0) {
    return rows.map((r) => ({
      ownerId: r.ownerId,
      blobName: r.blobName,
      publishedPath: r.publishedPath,
      lastBlobSha: r.lastBlobSha,
      publishedAt: r.publishedAt,
    }));
  }

  const markerPath = join(projectRoot, '.cleo', SEED_MARKER);
  if (existsSync(markerPath)) return [];

  const legacy = readLegacyLedger(projectRoot);
  if (legacy.length === 0) return [];

  for (const record of legacy) {
    await insertPublicationRow(projectRoot, record);
  }
  try {
    writeFileSync(markerPath, `${new Date().toISOString()}\n`, 'utf-8');
  } catch {
    // Best effort: without the marker the seed re-runs, which is idempotent.
  }
  return legacy;
}

/**
 * Read the set of blob SHA-256 hashes named by any publication row.
 *
 * Used by the attachment janitor so a published blob is never declared
 * unreferenced (and GC'd) while its publication lives.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @returns Distinct `last_blob_sha` values across all publications.
 */
export async function readDocsPublicationSha256Set(projectRoot: string): Promise<Set<string>> {
  const db = await getDb(projectRoot);
  const rows = await db
    .select({ lastBlobSha: docsPublications.lastBlobSha })
    .from(docsPublications)
    .all();
  return new Set(rows.map((r) => r.lastBlobSha).filter((sha) => /^[0-9a-f]{64}$/i.test(sha)));
}
