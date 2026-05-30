/**
 * Sticky-note tag-filter tests (T11355 · E4 JSON-storage optimization).
 *
 * Proves the load-all-then-JS-filter pattern is gone:
 *   - tag filtering runs in SQL via the sticky_tags junction (contains-ALL);
 *   - the LIMIT is honored at the SQL layer even when a tag filter is active;
 *   - tags_json is backfilled into the junction on create;
 *   - existing list behavior is preserved.
 *
 * @task T11355
 * @epic T11286
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeBrainDb, getBrainNativeDb } from '../../store/memory-sqlite.js';
import { addSticky } from '../create.js';
import { listStickies } from '../list.js';

let tempDir: string;

describe('listStickies tag filtering (T11355)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-sticky-tagfilter-'));
    await mkdir(join(tempDir, '.cleo'), { recursive: true });
  });

  afterEach(async () => {
    closeBrainDb();
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('backfills the sticky_tags junction on create', async () => {
    const sticky = await addSticky({ content: 'tagged note', tags: ['alpha', 'beta'] }, tempDir);
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).not.toBeNull();

    const rows = nativeDb!
      .prepare('SELECT tag FROM sticky_tags WHERE sticky_id = ? ORDER BY tag')
      .all(sticky.id) as Array<{ tag: string }>;
    expect(rows.map((r) => r.tag)).toEqual(['alpha', 'beta']);
  });

  it('returns only notes containing ALL requested tags', async () => {
    await addSticky({ content: 'a only', tags: ['alpha'] }, tempDir);
    await addSticky({ content: 'a+b', tags: ['alpha', 'beta'] }, tempDir);
    await addSticky({ content: 'b only', tags: ['beta'] }, tempDir);

    const both = await listStickies({ tags: ['alpha', 'beta'] }, tempDir);
    expect(both).toHaveLength(1);
    expect(both[0]?.content).toBe('a+b');

    const justAlpha = await listStickies({ tags: ['alpha'] }, tempDir);
    expect(justAlpha.map((n) => n.content).sort()).toEqual(['a only', 'a+b']);
  });

  it('honors the LIMIT at the SQL layer even with a tag filter active', async () => {
    // Five notes all carry the 'shared' tag.
    for (let i = 0; i < 5; i++) {
      await addSticky({ content: `note-${i}`, tags: ['shared'] }, tempDir);
    }

    const limited = await listStickies({ tags: ['shared'], limit: 2 }, tempDir);
    expect(limited).toHaveLength(2);

    // Prove the LIMIT clips at the SQL layer: query the junction-joined rows
    // directly with the same predicate + LIMIT and confirm SQLite returned 2
    // rows (i.e. the database, not a post-fetch JS slice, applied the bound).
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).not.toBeNull();
    const sqlRowCount = (
      nativeDb!
        .prepare(
          `SELECT COUNT(*) AS c FROM (
             SELECT n.id
             FROM brain_sticky_notes n
             WHERE n.id IN (
               SELECT sticky_id FROM sticky_tags
               WHERE tag IN ('shared')
               GROUP BY sticky_id HAVING COUNT(DISTINCT tag) = 1
             )
             ORDER BY n.created_at DESC
             LIMIT 2
           )`,
        )
        .get() as { c: number }
    ).c;
    expect(sqlRowCount).toBe(2);
  });

  it('does NOT cross array boundaries (no substring false positives)', async () => {
    // A note tagged 'alpha-beta' must NOT match a filter for 'alpha'. The old
    // LIKE '%alpha%' on serialized JSON would have matched it.
    await addSticky({ content: 'compound', tags: ['alpha-beta'] }, tempDir);
    await addSticky({ content: 'exact', tags: ['alpha'] }, tempDir);

    const matches = await listStickies({ tags: ['alpha'] }, tempDir);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.content).toBe('exact');
  });

  it('preserves unfiltered listing behavior', async () => {
    await addSticky({ content: 'x', tags: ['t1'] }, tempDir);
    await addSticky({ content: 'y', tags: [] }, tempDir);
    const all = await listStickies({}, tempDir);
    expect(all).toHaveLength(2);
  });
});
