/**
 * topics/related_tasks derivation + wikilinks rebuild on the write path — T13357.
 *
 * Before T13357 no runtime writer populated `attachments.topics` /
 * `attachments.related_tasks` (0 wikilinks edges fleet-wide). Now
 * `store.put` derives them from text content at the write chokepoint and
 * refreshes `docs_wikilinks` after every slugged write; `docs update`
 * re-derives mentions from the new body.
 *
 * Isolated temp `.cleo/` per test (same harness as
 * docs-update-docversion.test.ts).
 *
 * @task T13357 (Epic T13340 / Saga T13339)
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deriveDocLinks,
  extractTaskMentions,
  isScannableTextMime,
  linksJsonOrNull,
} from '../derive-links.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-links-'));
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

/** Read the slugged row's provenance columns straight from the store. */
async function provenanceOf(
  slug: string,
): Promise<{ topics: string | null; relatedTasks: string | null } | undefined> {
  const { eq } = await import('drizzle-orm');
  const { getDb } = await import('../../store/sqlite.js');
  const { attachments } = await import('../../store/tasks-schema.js');
  const db = await getDb(tempDir);
  return db
    .select({ topics: attachments.topics, relatedTasks: attachments.relatedTasks })
    .from(attachments)
    .where(eq(attachments.slug, slug))
    .get();
}

/** Current wikilinks edges for a slug. */
async function edgesFrom(
  slug: string,
): Promise<Array<{ toSlug: string; relation: string; toIsTask: boolean }>> {
  const { eq } = await import('drizzle-orm');
  const { getDb } = await import('../../store/sqlite.js');
  const { docsWikilinks } = await import('../../store/schema/attachments.js');
  const db = await getDb(tempDir);
  return db
    .select({
      toSlug: docsWikilinks.toSlug,
      relation: docsWikilinks.relation,
      toIsTask: docsWikilinks.toIsTask,
    })
    .from(docsWikilinks)
    .where(eq(docsWikilinks.fromSlug, slug))
    .all();
}

describe('derive-links units (T13357)', () => {
  it('extracts word-bounded T#### mentions, de-duplicated and numerically sorted', () => {
    expect(extractTaskMentions('See T123 and T0456; T123 again. Not XT999 or T12.')).toEqual([
      'T123',
      'T0456',
    ]);
    expect(extractTaskMentions('no mentions')).toEqual([]);
  });

  it('derives topics from labels, de-duplicated and sorted', () => {
    expect(deriveDocLinks('body T100', ['perf', 'plan', 'perf'])).toEqual({
      relatedTasks: ['T100'],
      topics: ['perf', 'plan'],
    });
  });

  it('persists empty arrays as NULL (JSON-or-null policy)', () => {
    expect(linksJsonOrNull([])).toBeNull();
    expect(linksJsonOrNull(['T1'])).toBe('["T1"]');
  });

  it('only scans text mimes', () => {
    expect(isScannableTextMime('text/markdown')).toBe(true);
    expect(isScannableTextMime('application/json')).toBe(true);
    expect(isScannableTextMime('application/octet-stream')).toBe(false);
    expect(isScannableTextMime(undefined)).toBe(false);
  });
});

describe('write-path provenance (T13357)', () => {
  it('store.put populates topics/related_tasks and rebuilds wikilinks edges', async () => {
    const { createAttachmentStore } = await import('../../store/attachment-store.js');
    const store = createAttachmentStore();
    await store.put(
      Buffer.from('# Plan\n\nBuilds on T123 and T456.\n', 'utf-8'),
      {
        kind: 'blob',
        storageKey: '',
        mime: 'text/markdown',
        size: 40,
        labels: ['perf', 'plan'],
      },
      'task',
      'T9999',
      'derive-links-test',
      tempDir,
      { slug: 'linked-doc', type: 'note' },
    );

    const row = await provenanceOf('linked-doc');
    expect(row?.topics).toBe('["perf","plan"]');
    expect(row?.relatedTasks).toBe('["T123","T456"]');

    const edges = await edgesFrom('linked-doc');
    const taskEdges = edges.filter((e) => e.toIsTask).map((e) => e.toSlug);
    expect(taskEdges.sort()).toEqual(['T123', 'T456']);
  });

  it('docs update re-derives mentions from the new body and keeps edges fresh', async () => {
    const { createAttachmentStore } = await import('../../store/attachment-store.js');
    const store = createAttachmentStore();
    await store.put(
      Buffer.from('# Doc\n\nAbout T100.\n', 'utf-8'),
      { kind: 'blob', storageKey: '', mime: 'text/markdown', size: 20 },
      'task',
      'T9999',
      'derive-links-test',
      tempDir,
      { slug: 'updating-doc', type: 'note' },
    );

    const { updateDocBySlug } = await import('../docs-update.js');
    const res = await updateDocBySlug(tempDir, {
      slug: 'updating-doc',
      content: '# Doc\n\nNow about T200 instead.\n',
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const row = await provenanceOf('updating-doc');
    expect(row?.relatedTasks).toBe('["T200"]');

    const edges = await edgesFrom('updating-doc');
    expect(edges.filter((e) => e.toIsTask).map((e) => e.toSlug)).toEqual(['T200']);
  });

  it('leaves provenance columns NULL for binary blobs', async () => {
    const { createAttachmentStore } = await import('../../store/attachment-store.js');
    const store = createAttachmentStore();
    await store.put(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      { kind: 'blob', storageKey: '', mime: 'image/png', size: 4 },
      'task',
      'T9999',
      'derive-links-test',
      tempDir,
      { slug: 'binary-doc' },
    );
    const row = await provenanceOf('binary-doc');
    expect(row?.topics).toBeNull();
    expect(row?.relatedTasks).toBeNull();
  });
});
