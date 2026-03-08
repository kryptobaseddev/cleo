/**
 * Tests for sqlite-vec extension loading and vec0 virtual table in brain.db.
 *
 * Verifies that the sqlite-vec extension loads successfully and that
 * the brain_embeddings vec0 virtual table is created and functional.
 *
 * @epic T5149
 * @task T5157
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;
let cleoDir: string;

describe('brain.db sqlite-vec integration', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-brain-vec-'));
    cleoDir = join(tempDir, '.cleo');
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../brain-sqlite.js');
    closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loads sqlite-vec extension successfully', async () => {
    const {
      getBrainDb,
      isBrainVecLoaded,
      closeBrainDb: close,
    } = await import('../brain-sqlite.js');
    close();

    await getBrainDb();
    expect(isBrainVecLoaded()).toBe(true);
  });

  it('creates brain_embeddings vec0 virtual table', async () => {
    const {
      getBrainDb,
      getBrainNativeDb,
      closeBrainDb: close,
    } = await import('../brain-sqlite.js');
    close();

    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    // vec0 virtual tables appear in sqlite_master as type='table'
    const result = nativeDb!
      .prepare("SELECT name, type FROM sqlite_master WHERE name = 'brain_embeddings'")
      .get() as { name: string; type: string } | undefined;

    expect(result).toBeTruthy();
    expect(result!.name).toBe('brain_embeddings');
  });

  it('vec_version() returns a version string', async () => {
    const {
      getBrainDb,
      getBrainNativeDb,
      closeBrainDb: close,
    } = await import('../brain-sqlite.js');
    close();

    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    const result = nativeDb!.prepare('SELECT vec_version()').get() as Record<string, string>;
    const version = Object.values(result)[0];
    expect(version).toMatch(/^v?\d+\.\d+/);
  });

  it('can insert and query vectors in brain_embeddings', async () => {
    const {
      getBrainDb,
      getBrainNativeDb,
      closeBrainDb: close,
    } = await import('../brain-sqlite.js');
    close();

    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    // Insert a test vector (384 dimensions, all zeros except first few)
    const dims = 384;
    const vec = new Float32Array(dims);
    vec[0] = 1.0;
    vec[1] = 0.5;
    vec[2] = 0.25;

    nativeDb!
      .prepare('INSERT INTO brain_embeddings (id, embedding) VALUES (?, ?)')
      .run('test-obs-1', Buffer.from(vec.buffer));

    // Query: check we can read it back
    const rows = nativeDb!
      .prepare('SELECT id FROM brain_embeddings WHERE id = ?')
      .all('test-obs-1') as Array<{ id: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('test-obs-1');
  });

  it('isBrainVecLoaded returns false after closeBrainDb', async () => {
    const {
      getBrainDb,
      isBrainVecLoaded,
      closeBrainDb: close,
    } = await import('../brain-sqlite.js');
    close();

    await getBrainDb();
    expect(isBrainVecLoaded()).toBe(true);

    close();
    expect(isBrainVecLoaded()).toBe(false);
  });
});
