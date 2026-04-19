/**
 * Sticky Note Purge Tests
 *
 * Tests for the sticky note purge (permanent deletion) functionality.
 *
 * @task T5363
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeBrainDb } from '../../store/memory-sqlite.js';
import { archiveSticky } from '../archive.js';
import { addSticky } from '../create.js';
import { purgeSticky } from '../purge.js';
import { getSticky } from '../show.js';

let tempDir: string;

describe('purgeSticky', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-purge-test-'));
    await mkdir(join(tempDir, '.cleo'), { recursive: true });
  });

  afterEach(async () => {
    closeBrainDb();
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('should permanently delete an active sticky note', async () => {
    // Create a sticky note
    const sticky = await addSticky({ content: 'Test sticky to purge', tags: ['test'] }, tempDir);

    // Verify it exists
    const beforePurge = await getSticky(sticky.id, tempDir);
    expect(beforePurge).not.toBeNull();
    expect(beforePurge?.id).toBe(sticky.id);

    // Purge it
    const purged = await purgeSticky(sticky.id, tempDir);
    expect(purged).not.toBeNull();
    expect(purged?.id).toBe(sticky.id);
    expect(purged?.content).toBe('Test sticky to purge');

    // Verify it's permanently deleted
    const afterPurge = await getSticky(sticky.id, tempDir);
    expect(afterPurge).toBeNull();
  });

  it('should permanently delete an archived sticky note', async () => {
    // Create and archive a sticky note
    const sticky = await addSticky(
      { content: 'Test archived sticky to purge', tags: ['test'] },
      tempDir,
    );

    await archiveSticky(sticky.id, tempDir);

    // Verify it's archived
    const archived = await getSticky(sticky.id, tempDir);
    expect(archived).not.toBeNull();
    expect(archived?.status).toBe('archived');

    // Purge it
    const purged = await purgeSticky(sticky.id, tempDir);
    expect(purged).not.toBeNull();
    expect(purged?.id).toBe(sticky.id);

    // Verify it's permanently deleted
    const afterPurge = await getSticky(sticky.id, tempDir);
    expect(afterPurge).toBeNull();
  });

  it('should return null for non-existent sticky note', async () => {
    const result = await purgeSticky('SN-NONEXISTENT', tempDir);
    expect(result).toBeNull();
  });
});
