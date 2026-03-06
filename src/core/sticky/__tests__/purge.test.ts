/**
 * Sticky Note Purge Tests
 *
 * Tests for the sticky note purge (permanent deletion) functionality.
 *
 * @task T5363
 */

import { describe, it, expect } from 'vitest';
import { purgeSticky } from '../purge.js';
import { addSticky } from '../create.js';
import { getSticky } from '../show.js';
import { archiveSticky } from '../archive.js';
import { getProjectRoot } from '../../../core/paths.js';

describe('purgeSticky', () => {
  const projectRoot = getProjectRoot();

  it('should permanently delete an active sticky note', async () => {
    // Create a sticky note
    const sticky = await addSticky(
      { content: 'Test sticky to purge', tags: ['test'] },
      projectRoot,
    );

    // Verify it exists
    const beforePurge = await getSticky(sticky.id, projectRoot);
    expect(beforePurge).not.toBeNull();
    expect(beforePurge?.id).toBe(sticky.id);

    // Purge it
    const purged = await purgeSticky(sticky.id, projectRoot);
    expect(purged).not.toBeNull();
    expect(purged?.id).toBe(sticky.id);
    expect(purged?.content).toBe('Test sticky to purge');

    // Verify it's permanently deleted
    const afterPurge = await getSticky(sticky.id, projectRoot);
    expect(afterPurge).toBeNull();
  });

  it('should permanently delete an archived sticky note', async () => {
    // Create and archive a sticky note
    const sticky = await addSticky(
      { content: 'Test archived sticky to purge', tags: ['test'] },
      projectRoot,
    );

    await archiveSticky(sticky.id, projectRoot);

    // Verify it's archived
    const archived = await getSticky(sticky.id, projectRoot);
    expect(archived).not.toBeNull();
    expect(archived?.status).toBe('archived');

    // Purge it
    const purged = await purgeSticky(sticky.id, projectRoot);
    expect(purged).not.toBeNull();
    expect(purged?.id).toBe(sticky.id);

    // Verify it's permanently deleted
    const afterPurge = await getSticky(sticky.id, projectRoot);
    expect(afterPurge).toBeNull();
  });

  it('should return null for non-existent sticky note', async () => {
    const result = await purgeSticky('SN-NONEXISTENT', projectRoot);
    expect(result).toBeNull();
  });
});
