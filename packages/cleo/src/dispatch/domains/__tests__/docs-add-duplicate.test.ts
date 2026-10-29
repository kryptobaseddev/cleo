/**
 * Update before create (T14109, D11210): docs.add refuses a likely duplicate
 * and routes to docs update; --new-because adds it anyway and is recorded.
 *
 * @task T14109
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocsListResult } from '@cleocode/contracts/operations/docs';
import { awaitBackgroundOps } from '@cleocode/core/store/background-ops';
import { closeAllDatabases } from '@cleocode/core/store/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocsHandler } from '../docs.js';

let tempDir: string;

const body = (title: string, seed: string): string =>
  `# ${title}\n\n${Array.from({ length: 80 }, (_, i) => `${seed}${i % 13} step${i}`).join(' ')}\n`;

/** Seed `n` slugged docs straight into the store, oldest first. */
async function seed(n: number, kindOf: (i: number) => string): Promise<void> {
  const { createAttachmentStore } = await import('@cleocode/core/store/attachment-store');
  const store = createAttachmentStore();
  for (let i = 0; i < n; i++) {
    const text =
      i === 0 ? body('How the release flow works', 'release') : `# Seed doc ${i}\n\nseed ${i}\n`;
    await store.put(
      Buffer.from(text, 'utf-8'),
      { kind: 'blob', storageKey: '', mime: 'text/markdown', size: text.length },
      'task',
      'T980',
      'seed',
      tempDir,
      { slug: i === 0 ? 'release-flow' : `seed-doc-${i}`, type: kindOf(i) },
    );
  }
}

describe('docs.add update-before-create (T14109)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-add-duplicate-'));
    vi.stubEnv('CLEO_ROOT', tempDir);
    vi.stubEnv('CLEO_DIR', join(tempDir, '.cleo'));
    vi.stubEnv('CLEO_BRAIN_BYPASS_WRITER_THREAD', '1');
    await mkdir(join(tempDir, '.cleo'));
    await writeFile(
      join(tempDir, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'duplicate-check', projectRoot: tempDir }),
    );
  });

  afterEach(async () => {
    await awaitBackgroundOps();
    const { shutdownBrainWriter, _resetBrainWriterForTests } = await import(
      '@cleocode/core/memory/brain-writer-thread'
    );
    await shutdownBrainWriter();
    _resetBrainWriterForTests();
    await closeAllDatabases();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('refuses a likely duplicate, naming the existing doc, its title and the update command', async () => {
    const handler = new DocsHandler();
    const first = await handler.mutate('add', {
      ownerId: 'T970',
      content: body('How the release flow works', 'release'),
      slug: 'release-flow',
      type: 'spec',
      attachedBy: 'dup-test',
    });
    expect(first.success, JSON.stringify(first.error)).toBe(true);

    const again = await handler.mutate('add', {
      ownerId: 'T971',
      content: body('Release flow, how it works', 'release'),
      slug: 'release-flow-guide',
      type: 'spec',
      attachedBy: 'dup-test',
    });
    expect(again.success).toBe(false);
    expect(again.error?.code).toBe('E_DOC_DUPLICATE');
    expect(again.error?.message).toContain('"release-flow" (title: "How the release flow works")');
    expect(again.error?.message).toContain('cleo docs fetch release-flow');
    expect(again.error?.fix).toBe('cleo docs fetch release-flow && cleo docs update release-flow');
  });

  it('accepts a distinct doc', async () => {
    const handler = new DocsHandler();
    await handler.mutate('add', {
      ownerId: 'T972',
      content: body('How the release flow works', 'release'),
      slug: 'release-flow',
      type: 'spec',
      attachedBy: 'dup-test',
    });
    const other = await handler.mutate('add', {
      ownerId: 'T973',
      content: body('The Nexus symbol graph', 'graph'),
      slug: 'nexus-graph',
      type: 'research',
      attachedBy: 'dup-test',
    });
    expect(other.success, JSON.stringify(other.error)).toBe(true);
  });

  it('adds it anyway with --new-because, and records the reason', async () => {
    const handler = new DocsHandler();
    await handler.mutate('add', {
      ownerId: 'T974',
      content: body('How the release flow works', 'release'),
      slug: 'release-flow',
      type: 'spec',
      attachedBy: 'dup-test',
    });
    const short = await handler.mutate('add', {
      ownerId: 'T975',
      content: body('How the release flow works', 'hotfix'),
      slug: 'hotfix-release-flow',
      type: 'spec',
      newBecause: 'different',
    });
    expect(short.error?.code).toBe('E_INVALID_INPUT');
    const forced = await handler.mutate('add', {
      ownerId: 'T975',
      content: body('How the release flow works', 'hotfix'),
      slug: 'hotfix-release-flow',
      type: 'spec',
      attachedBy: 'dup-test',
      newBecause: 'covers the hotfix path the release flow guide never did',
    });
    expect(forced.success, JSON.stringify(forced.error)).toBe(true);
    const audit = JSON.parse(
      (await readFile(join(tempDir, '.cleo', 'audit', 'docs-new-because.jsonl'), 'utf-8')).trim(),
    );
    expect(audit).toMatchObject({
      slug: 'hotfix-release-flow',
      resembles: { slug: 'release-flow', rule: 'title' },
      reason: 'covers the hotfix path the release flow guide never did',
    });
  });

  it('T14115: the duplicate check searches the whole store, beyond 200 docs', async () => {
    await seed(205, (i) => (i === 0 ? 'spec' : 'note'));
    const handler = new DocsHandler();
    const again = await handler.mutate('add', {
      ownerId: 'T981',
      content: body('How the release flow works', 'ship'),
      slug: 'shipping-flow',
      type: 'spec',
      attachedBy: 'dup-test',
    });
    expect(again.error?.code).toBe('E_DOC_DUPLICATE');
    expect(again.error?.message).toContain('"release-flow"');
  }, 300_000);
});

describe('docs.list --limit 0 returns every match (T14115)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-list-all-'));
    vi.stubEnv('CLEO_ROOT', tempDir);
    vi.stubEnv('CLEO_DIR', join(tempDir, '.cleo'));
    vi.stubEnv('CLEO_BRAIN_BYPASS_WRITER_THREAD', '1');
    await mkdir(join(tempDir, '.cleo'));
    await writeFile(
      join(tempDir, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'list-all', projectRoot: tempDir }),
    );
  });

  afterEach(async () => {
    await awaitBackgroundOps();
    await closeAllDatabases();
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns all 205 docs with and without --type, and reports the population', async () => {
    await seed(205, (i) => (i % 2 === 0 ? 'note' : 'spec'));
    const handler = new DocsHandler();
    const all = await handler.query('list', { project: true, limit: 0 });
    expect(all.success, JSON.stringify(all.error)).toBe(true);
    const allData = all.data as DocsListResult;
    expect(allData.count).toBe(205);
    expect(allData.population).toEqual({
      matched: 205,
      returned: 205,
      truncated: false,
      limit: null,
    });

    const notes = await handler.query('list', { project: true, limit: 0, type: 'note' });
    const noteData = notes.data as DocsListResult;
    expect(noteData.count).toBe(103);
    expect(noteData.population).toEqual({
      matched: 103,
      returned: 103,
      truncated: false,
      limit: null,
    });

    const paged = await handler.query('list', { project: true });
    const pagedData = paged.data as DocsListResult;
    expect(pagedData.population).toEqual({
      matched: 205,
      returned: 50,
      truncated: true,
      limit: 50,
    });
    expect(pagedData.hint).toMatch(/showing 50 of 205/);
  }, 300_000);
});
