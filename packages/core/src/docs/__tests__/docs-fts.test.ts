/**
 * T14197 — the docs full-text index: kept in step with the docs store,
 * rebuilt when missing, ranked with BRAIN hits, and fast on a 3k+ doc store.
 *
 * @task T14197
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BlobAttachment } from '@cleocode/contracts';
import type { SearchBrainCompactResult } from '@cleocode/contracts/memory/search.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttachmentStore } from '../../store/attachment-store.js';
import { bindTasksDomain, closeDb, getDbPath } from '../../store/sqlite.js';
import { DOCS_FTS_TABLE, docsFtsMatch, searchDocsFts, syncDocsFts } from '../docs-fts.js';
import { updateDocBySlug } from '../docs-update.js';
import { findCurrentDocs } from '../lineage.js';
import { supersedeDoc } from '../supersede.js';

describe('T14197 — docs full-text index', () => {
  let projectRoot: string;
  let prevCleoDir: string | undefined;
  let prevCwd: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cleo-docs-fts-'));
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    mkdirSync(join(projectRoot, '.git'), { recursive: true });
    prevCleoDir = process.env['CLEO_DIR'];
    process.env['CLEO_DIR'] = join(projectRoot, '.cleo');
    prevCwd = process.cwd();
    process.chdir(projectRoot);
  });

  afterEach(() => {
    closeDb();
    process.chdir(prevCwd);
    if (prevCleoDir === undefined) delete process.env['CLEO_DIR'];
    else process.env['CLEO_DIR'] = prevCleoDir;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  async function seed(slug: string, body: string, owner = 'T100'): Promise<void> {
    const bytes = Buffer.from(body, 'utf-8');
    const blob: Omit<BlobAttachment, 'sha256'> = {
      kind: 'blob',
      storageKey: '',
      mime: 'text/markdown',
      size: bytes.byteLength,
    };
    await createAttachmentStore().put(bytes, blob, 'task', owner, 'test', projectRoot, {
      slug,
      type: 'note',
    });
  }

  it('quotes every word of the query, so FTS5 syntax in it is inert', () => {
    expect(docsFtsMatch('backup "retention" OR NEAR(x)')).toBe(
      '"backup" OR "retention" OR "or" OR "near"',
    );
    expect(docsFtsMatch('  - ! ')).toBeNull();
  });

  it('AC1: follows docs add, update and supersede, re-reading only what changed', async () => {
    await seed('retention', '# Retention\n\nbackup retention keeps ten snapshots\n');
    await seed('kanban', '# Kanban\n\nboard columns and swimlanes\n');
    expect(await syncDocsFts(projectRoot)).toMatchObject({ indexed: 2, removed: 0, total: 2 });
    expect(await syncDocsFts(projectRoot)).toMatchObject({ indexed: 0, removed: 0, total: 2 });
    expect(await searchDocsFts(projectRoot, 'snapshots', 10)).toEqual(['retention']);

    const updated = await updateDocBySlug(projectRoot, {
      slug: 'retention',
      content: '# Retention\n\nbackup retention keeps twenty archives\n',
    });
    expect(updated.ok).toBe(true);
    expect(await syncDocsFts(projectRoot)).toMatchObject({ indexed: 1, removed: 1, total: 2 });
    expect(await searchDocsFts(projectRoot, 'snapshots', 10)).toEqual([]);
    expect(await searchDocsFts(projectRoot, 'archives', 10)).toEqual(['retention']);

    // A superseded doc stays indexed: a match on it surfaces its current doc.
    await seed('boards', '# Boards\n\nkanban boards replaced\n');
    await supersedeDoc(projectRoot, { oldSlug: 'kanban', newSlug: 'boards' });
    expect(await searchDocsFts(projectRoot, 'swimlanes', 10)).toEqual(['kanban']);
    const docs = await findCurrentDocs(projectRoot, 'swimlanes');
    expect(docs.map((h) => [h.id, h.replaces])).toEqual([['boards', 'kanban']]);
  });

  it('AC1: rebuilds from the store when the index is missing', async () => {
    await seed('retention', '# Retention\n\nbackup retention keeps ten snapshots\n');
    await seed('kanban', '# Kanban\n\nboard columns and swimlanes\n');
    expect(await searchDocsFts(projectRoot, 'swimlanes', 10)).toEqual(['kanban']);
    const { native } = await bindTasksDomain(projectRoot);
    native.exec(`DROP TABLE ${DOCS_FTS_TABLE}`);
    expect(await syncDocsFts(projectRoot)).toMatchObject({ indexed: 2, removed: 0, total: 2 });
    expect(await searchDocsFts(projectRoot, 'snapshots', 10)).toEqual(['retention']);
  });

  it('a store locked by another writer never fails or blocks a search', async () => {
    await seed('retention', '# Retention\n\nbackup retention keeps ten snapshots\n');
    const { storeDecision } = await import('../../memory/decisions.js');
    await storeDecision(projectRoot, {
      type: 'technical',
      decision: 'Backup retention keeps ten snapshots',
      rationale: 'Enough history for a week.',
      confidence: 'high',
      confirmationState: 'accepted',
    });
    const { memoryFind } = await import('../../memory/engine-compat.js');
    const tables = ['decisions', 'patterns', 'learnings', 'observations', 'docs'];
    // Warm up: build the docs index and the BRAIN FTS tables before the lock.
    expect((await memoryFind({ query: 'backup retention', tables }, projectRoot)).success).toBe(
      true,
    );
    await seed('kanban', '# Kanban\n\nboard columns and swimlanes\n');

    const locker = new DatabaseSync(getDbPath(projectRoot));
    locker.exec('BEGIN IMMEDIATE');
    try {
      const start = performance.now();
      // The index cannot catch up, so it is searched as it stands.
      expect(await searchDocsFts(projectRoot, 'snapshots', 10)).toEqual(['retention']);
      expect(await searchDocsFts(projectRoot, 'swimlanes', 10)).toEqual([]);
      expect(performance.now() - start).toBeLessThan(5_000);

      const found = await memoryFind({ query: 'backup retention', tables }, projectRoot);
      expect(found.success, JSON.stringify(found.error)).toBe(true);
      const hits = (found.data as SearchBrainCompactResult).results;
      expect(hits.map((h) => h.type)).toContain('decision');
      expect(hits.filter((h) => h.type === 'doc').map((h) => h.id)).toEqual(['retention']);
      await expect(syncDocsFts(projectRoot, { busyTimeoutMs: 50 })).rejects.toThrow();
    } finally {
      locker.exec('ROLLBACK');
      locker.close();
    }
    // Once the writer is gone the next search catches up.
    expect(await searchDocsFts(projectRoot, 'swimlanes', 10)).toEqual(['kanban']);
  });

  it('with no index and a locked store, a search falls back instead of failing', async () => {
    await seed('retention', '# Retention\n\nbackup retention keeps ten snapshots\n');
    expect(await searchDocsFts(projectRoot, 'snapshots', 10)).toEqual(['retention']);
    const { native } = await bindTasksDomain(projectRoot);
    native.exec(`DROP TABLE ${DOCS_FTS_TABLE}`);

    const locker = new DatabaseSync(getDbPath(projectRoot));
    locker.exec('BEGIN IMMEDIATE');
    try {
      expect(await searchDocsFts(projectRoot, 'snapshots', 10)).toBeNull();
      const docs = await findCurrentDocs(projectRoot, 'backup retention snapshots');
      expect(docs.every((h) => h.type === 'doc')).toBe(true);
      const { memoryFind } = await import('../../memory/engine-compat.js');
      const found = await memoryFind(
        { query: 'backup retention', tables: ['decisions', 'docs'] },
        projectRoot,
      );
      expect(found.success, JSON.stringify(found.error)).toBe(true);
    } finally {
      locker.exec('ROLLBACK');
      locker.close();
    }
  });

  it('AC5: ranks doc hits with BRAIN hits, current docs only', async () => {
    await seed('retention-old', '# Retention\n\nbackup retention keeps ten snapshots\n');
    await seed('retention', '# Retention\n\nbackup retention keeps twenty snapshots\n');
    await supersedeDoc(projectRoot, { oldSlug: 'retention-old', newSlug: 'retention' });
    const { storeDecision } = await import('../../memory/decisions.js');
    await storeDecision(projectRoot, {
      type: 'technical',
      decision: 'Backup retention keeps twenty snapshots',
      rationale: 'Ten snapshots lost a week of history.',
      confidence: 'high',
      confirmationState: 'accepted',
    });
    const { memoryFind } = await import('../../memory/engine-compat.js');
    const found = await memoryFind(
      {
        query: 'backup retention snapshots',
        tables: ['decisions', 'patterns', 'learnings', 'observations', 'docs'],
      },
      projectRoot,
    );
    expect(found.success).toBe(true);
    const hits = (found.data as SearchBrainCompactResult).results;
    expect(hits.map((h) => h.type)).toEqual(expect.arrayContaining(['decision', 'doc']));
    const docHits = hits.filter((h) => h.type === 'doc');
    expect(docHits.map((h) => h.id)).toEqual(['retention']);
    expect(docHits[0]?.replaces).toBe('retention-old');
  });

  it('AC2: answers in well under 300 ms on a 3,300-doc store', async () => {
    const words =
      'release pipeline merge sweep backup retention snapshot index ranking evidence gate commit branch worktree session memory decision pattern sync device migration schema trigger audit verdict review changeset publish canary lifecycle'.split(
        ' ',
      );
    for (let i = 0; i < 3300; i++) {
      const body = Array.from({ length: 120 }, (_, j) => words[(i * 7 + j * 13) % words.length]);
      await seed(`doc-${i}`, `# Doc ${i}\n\n${body.join(' ')} marker${i}\n`, `T${1000 + (i % 50)}`);
    }
    const built = performance.now();
    expect(await syncDocsFts(projectRoot)).toMatchObject({ total: 3300 });
    const buildMs = performance.now() - built;

    const timings: number[] = [];
    for (const query of ['backup retention snapshot', 'canary publish lifecycle', 'marker3141']) {
      const start = performance.now();
      const docs = await findCurrentDocs(projectRoot, query);
      timings.push(performance.now() - start);
      expect(docs.length).toBeGreaterThan(0);
    }
    // Recorded in the test log (T14197 AC2).
    console.info(
      `docs-fts: built 3300 docs in ${buildMs.toFixed(0)} ms; findCurrentDocs ${timings.map((t) => t.toFixed(1)).join(' / ')} ms`,
    );
    expect(Math.max(...timings)).toBeLessThan(300);
  }, 300_000);
});
