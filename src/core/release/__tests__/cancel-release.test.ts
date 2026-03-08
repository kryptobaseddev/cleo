/**
 * Tests for cancelRelease().
 *
 * Verifies that only draft/prepared releases can be cancelled (deleted),
 * and that committed/tagged/pushed releases are rejected with a helpful message.
 *
 * @task T5602
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../store/sqlite.js';
import * as schema from '../../../store/tasks-schema.js';
import { cancelRelease, prepareRelease, showManifestRelease } from '../release-manifest.js';

let testDir: string;

async function loadTasks(): Promise<[]> {
  return [];
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-cancel-release-'));
  await mkdir(join(testDir, '.cleo'), { recursive: true });
});

afterEach(async () => {
  // Close the DB before removing the directory to avoid file-lock issues on Windows
  try {
    const { closeDb } = await import('../../../store/sqlite.js');
    closeDb();
  } catch {
    // best-effort
  }
  await rm(testDir, { recursive: true, force: true });
});

describe('cancelRelease', () => {
  it('cancels and removes a prepared release', async () => {
    // Arrange: create a prepared release
    await prepareRelease('1.2.3', [], undefined, loadTasks, testDir);

    // Act
    const result = await cancelRelease('1.2.3', testDir);

    // Assert
    expect(result.success).toBe(true);
    expect(result.version).toBe('v1.2.3');
    expect(result.message).toContain('cancelled');

    // Verify the row was actually deleted
    const db = await getDb(testDir);
    const rows = await db.select().from(schema.releaseManifests).all();
    expect(rows).toHaveLength(0);
  });

  it('accepts version with leading v prefix', async () => {
    await prepareRelease('2.0.0', [], undefined, loadTasks, testDir);

    const result = await cancelRelease('v2.0.0', testDir);

    expect(result.success).toBe(true);
    expect(result.version).toBe('v2.0.0');
  });

  it('returns failure for a non-existent release', async () => {
    const result = await cancelRelease('9.9.9', testDir);

    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
    expect(result.version).toBe('v9.9.9');
  });

  it('rejects a committed release with a helpful message', async () => {
    // Insert a committed release directly into the DB
    const db = await getDb(testDir);
    await db
      .insert(schema.releaseManifests)
      .values({
        id: 'rel-v3-0-0',
        version: 'v3.0.0',
        status: 'committed',
        tasksJson: '[]',
        notes: null,
        changelog: null,
        previousVersion: null,
        createdAt: new Date().toISOString(),
        preparedAt: new Date().toISOString(),
        committedAt: new Date().toISOString(),
        taggedAt: null,
        pushedAt: null,
      })
      .run();

    const result = await cancelRelease('v3.0.0', testDir);

    expect(result.success).toBe(false);
    expect(result.message).toContain("'committed'");
    expect(result.message).toContain('rollback');
  });

  it('rejects a pushed release with a helpful message', async () => {
    const db = await getDb(testDir);
    await db
      .insert(schema.releaseManifests)
      .values({
        id: 'rel-v4-0-0',
        version: 'v4.0.0',
        status: 'pushed',
        tasksJson: '[]',
        notes: null,
        changelog: null,
        previousVersion: null,
        createdAt: new Date().toISOString(),
        preparedAt: new Date().toISOString(),
        committedAt: new Date().toISOString(),
        taggedAt: new Date().toISOString(),
        pushedAt: new Date().toISOString(),
      })
      .run();

    const result = await cancelRelease('v4.0.0', testDir);

    expect(result.success).toBe(false);
    expect(result.message).toContain("'pushed'");
    expect(result.message).toContain('rollback');
  });

  it('rejects a tagged release with a helpful message', async () => {
    const db = await getDb(testDir);
    await db
      .insert(schema.releaseManifests)
      .values({
        id: 'rel-v5-0-0',
        version: 'v5.0.0',
        status: 'tagged',
        tasksJson: '[]',
        notes: null,
        changelog: null,
        previousVersion: null,
        createdAt: new Date().toISOString(),
        preparedAt: new Date().toISOString(),
        committedAt: new Date().toISOString(),
        taggedAt: new Date().toISOString(),
        pushedAt: null,
      })
      .run();

    const result = await cancelRelease('v5.0.0', testDir);

    expect(result.success).toBe(false);
    expect(result.message).toContain("'tagged'");
    expect(result.message).toContain('rollback');
  });

  it('throws when version is empty string', async () => {
    await expect(cancelRelease('', testDir)).rejects.toThrow('version is required');
  });

  it('does not delete other releases when cancelling one', async () => {
    // Create two releases
    await prepareRelease('1.0.0', [], undefined, loadTasks, testDir);
    await prepareRelease('1.0.1', [], undefined, loadTasks, testDir);

    const result = await cancelRelease('1.0.0', testDir);
    expect(result.success).toBe(true);

    // The other release should still exist
    const remaining = await showManifestRelease('1.0.1', testDir);
    expect(remaining.version).toBe('v1.0.1');
    expect(remaining.status).toBe('prepared');

    // Confirm only one row remains
    const db = await getDb(testDir);
    const rows = await db.select().from(schema.releaseManifests).all();
    expect(rows).toHaveLength(1);
  });
});
