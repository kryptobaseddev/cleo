/**
 * Tests for the `docs_publications` store ledger (T13362) — publication
 * round-trip through the store rows, the legacy-JSON seed shim, and the
 * janitor's publication-sha set.
 *
 * Each test gets an isolated temp `.cleo/` (CLEO_DIR + closeDb pattern,
 * same harness as docs-doctor.test.ts). The real user's project root is
 * never touched.
 *
 * @task T13362 (Epic T13340 / Saga T13339)
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

const SHA_A = createHash('sha256').update('a').digest('hex');
const SHA_B = createHash('sha256').update('b').digest('hex');

/** Count rows in the docs_publications table directly. */
async function rowCount(): Promise<number> {
  const { getDb } = await import('../../store/sqlite.js');
  const { docsPublications } = await import('../../store/schema/cleo-project/docs.js');
  const db = await getDb(tempDir);
  return (await db.select().from(docsPublications).all()).length;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-pubs-'));
  process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
  delete process.env['CLEO_DIR'];
  await rm(tempDir, { recursive: true, force: true });
});

describe('publications store (T13362)', () => {
  it('round-trips a publication through the store rows', async () => {
    const { upsertDocsPublication, readDocsPublications } = await import(
      '../publications-store.js'
    );
    await upsertDocsPublication(tempDir, {
      ownerId: 'T13362',
      blobName: 'spec.md',
      publishedPath: 'docs/spec.md',
      lastBlobSha: SHA_A,
    });

    const rows = await readDocsPublications(tempDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerId: 'T13362',
      blobName: 'spec.md',
      publishedPath: 'docs/spec.md',
      lastBlobSha: SHA_A,
    });
    expect(rows[0]?.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await rowCount()).toBe(1);
  });

  it('upsert refreshes lastBlobSha/publishedAt on the same triple (one row)', async () => {
    const { upsertDocsPublication, readDocsPublications } = await import(
      '../publications-store.js'
    );
    await upsertDocsPublication(tempDir, {
      ownerId: 'T1',
      blobName: 'a.md',
      publishedPath: 'docs/a.md',
      lastBlobSha: SHA_A,
    });
    await upsertDocsPublication(tempDir, {
      ownerId: 'T1',
      blobName: 'a.md',
      publishedPath: 'docs/a.md',
      lastBlobSha: SHA_B,
    });

    const rows = await readDocsPublications(tempDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastBlobSha).toBe(SHA_B);
    expect(await rowCount()).toBe(1);
  });

  it('treats a different publishedPath as a second row', async () => {
    const { upsertDocsPublication, readDocsPublications } = await import(
      '../publications-store.js'
    );
    await upsertDocsPublication(tempDir, {
      ownerId: 'T1',
      blobName: 'a.md',
      publishedPath: 'docs/a.md',
      lastBlobSha: SHA_A,
    });
    await upsertDocsPublication(tempDir, {
      ownerId: 'T1',
      blobName: 'a.md',
      publishedPath: 'docs/archive/a.md',
      lastBlobSha: SHA_A,
    });
    expect(await readDocsPublications(tempDir)).toHaveLength(2);
  });

  it('exposes the publication sha set for the janitor', async () => {
    const { upsertDocsPublication, readDocsPublicationSha256Set } = await import(
      '../publications-store.js'
    );
    await upsertDocsPublication(tempDir, {
      ownerId: 'T1',
      blobName: 'a.md',
      publishedPath: 'docs/a.md',
      lastBlobSha: SHA_A,
    });
    await upsertDocsPublication(tempDir, {
      ownerId: 'T2',
      blobName: 'b.md',
      publishedPath: 'docs/b.md',
      lastBlobSha: SHA_B,
    });

    const shas = await readDocsPublicationSha256Set(tempDir);
    expect(shas).toEqual(new Set([SHA_A, SHA_B]));
  });

  it('seeds legacy JSON entries into the table on first access (idempotent)', async () => {
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
    writeFileSync(
      join(tempDir, '.cleo', 'docs-publications.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            ownerId: 'T9',
            blobName: 'old.md',
            publishedPath: 'docs/old.md',
            lastBlobSha: SHA_A,
            publishedAt: '2026-01-02T03:04:05.000Z',
          },
          { ownerId: 'broken' }, // malformed entry — dropped
        ],
      }),
    );

    const { readDocsPublications } = await import('../publications-store.js');
    const first = await readDocsPublications(tempDir);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      ownerId: 'T9',
      blobName: 'old.md',
      publishedAt: '2026-01-02T03:04:05.000Z',
    });
    // Seeded rows land in the table and the marker is written…
    expect(await rowCount()).toBe(1);
    expect(existsSync(join(tempDir, '.cleo', 'docs-publications.json.seeded'))).toBe(true);

    // …so a second read is served from the store without reseeding.
    const second = await readDocsPublications(tempDir);
    expect(second).toHaveLength(1);
    expect(await rowCount()).toBe(1);
  });

  it('store rows are authoritative over the legacy JSON', async () => {
    const { upsertDocsPublication, readDocsPublications } = await import(
      '../publications-store.js'
    );
    await upsertDocsPublication(tempDir, {
      ownerId: 'T1',
      blobName: 'new.md',
      publishedPath: 'docs/new.md',
      lastBlobSha: SHA_B,
    });

    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
    writeFileSync(
      join(tempDir, '.cleo', 'docs-publications.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            ownerId: 'T9',
            blobName: 'stale.md',
            publishedPath: 'docs/stale.md',
            lastBlobSha: SHA_A,
            publishedAt: '2026-01-02T03:04:05.000Z',
          },
        ],
      }),
    );

    const rows = await readDocsPublications(tempDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.blobName).toBe('new.md');
    expect(await rowCount()).toBe(1);
  });

  it('returns an empty ledger when neither store nor JSON has entries', async () => {
    const { readDocsPublications } = await import('../publications-store.js');
    expect(await readDocsPublications(tempDir)).toEqual([]);
  });
});

describe('docs-ops ledger surface over the store (T13362)', () => {
  it('recordPublication → listPublications round-trip via store rows', async () => {
    const { recordPublication, listPublications } = await import('../docs-ops.js');
    await recordPublication({
      ownerId: 'T13362',
      blobName: 'ops.md',
      publishedPath: 'docs/ops.md',
      lastBlobSha: SHA_A,
      projectRoot: tempDir,
    });

    const rows = await listPublications({ projectRoot: tempDir });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerId: 'T13362',
      blobName: 'ops.md',
      publishedPath: 'docs/ops.md',
      lastBlobSha: SHA_A,
    });
    expect(await rowCount()).toBe(1);
  });
});

describe('legacy JSON shim marker (T13362)', () => {
  it('marker content records the seed instant', async () => {
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
    writeFileSync(
      join(tempDir, '.cleo', 'docs-publications.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            ownerId: 'T9',
            blobName: 'old.md',
            publishedPath: 'docs/old.md',
            lastBlobSha: SHA_A,
            publishedAt: '2026-01-02T03:04:05.000Z',
          },
        ],
      }),
    );
    const { readDocsPublications } = await import('../publications-store.js');
    await readDocsPublications(tempDir);
    const marker = readFileSync(join(tempDir, '.cleo', 'docs-publications.json.seeded'), 'utf-8');
    expect(marker.trim()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
