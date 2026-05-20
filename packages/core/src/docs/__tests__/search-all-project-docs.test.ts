/**
 * T9647 — project-wide doc search tests.
 *
 * Exercises `searchAllProjectDocs` end-to-end against a real temp project
 * root (so the AttachmentStore + blob filesystem layer participate) with
 * `llmtxt/similarity.rankBySimilarity` mocked to a deterministic ordering.
 *
 * @task T9647
 * @epic T9631
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('llmtxt/similarity', () => ({
  rankBySimilarity: vi.fn(),
}));

import * as simMod from 'llmtxt/similarity';
import { createAttachmentStore } from '../../store/attachment-store.js';
import { searchAllProjectDocs } from '../docs-ops.js';

let tmpRoot: string;
let prevCwd: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'cleo-search-test-'));
  prevCwd = process.cwd();
  await mkdir(join(tmpRoot, '.cleo'), { recursive: true });
  await mkdir(join(tmpRoot, '.git'), { recursive: true });
  process.chdir(tmpRoot);
  vi.mocked(simMod.rankBySimilarity).mockReset();
});

afterEach(async () => {
  process.chdir(prevCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

async function publishDoc(
  store: ReturnType<typeof createAttachmentStore>,
  body: string,
  slug: string,
  type: string,
  mime = 'text/markdown',
) {
  await store.put(
    Buffer.from(body, 'utf8'),
    { kind: 'blob', mime } as Parameters<typeof store.put>[1],
    'task',
    'T9647',
    'search-test',
    tmpRoot,
    { slug, type },
  );
}

describe('T9647 — searchAllProjectDocs', () => {
  it('returns an empty hit list with totalDocs=0 on a fresh project', async () => {
    const result = await searchAllProjectDocs('anything', { projectRoot: tmpRoot });
    expect(result.query).toBe('anything');
    expect(result.totalDocs).toBe(0);
    expect(result.hits).toEqual([]);
    expect(simMod.rankBySimilarity).not.toHaveBeenCalled();
  });

  it('passes text content (not just slugs) to rankBySimilarity', async () => {
    const store = createAttachmentStore();
    await publishDoc(
      store,
      '# Release pipeline\n\nThis spec describes the release flow.\n',
      'release-pipeline',
      'spec',
    );
    await publishDoc(store, '# Auth flow\n\nLogin via OAuth.\n', 'auth-flow', 'note');

    vi.mocked(simMod.rankBySimilarity).mockImplementation((q, candidates) => {
      // Order: by index — first doc first.
      return candidates.map((_c, i) => ({ index: i, score: 1 - i * 0.1 }));
    });

    const result = await searchAllProjectDocs('release', { projectRoot: tmpRoot, limit: 10 });

    expect(simMod.rankBySimilarity).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(simMod.rankBySimilarity).mock.calls[0];
    expect(callArgs[0]).toBe('release');
    // Two text docs ranked by content; both bodies should appear in candidate list.
    expect(callArgs[1]).toHaveLength(2);
    expect(callArgs[1].some((c: string) => c.includes('release flow'))).toBe(true);
    expect(callArgs[1].some((c: string) => c.includes('Login via OAuth'))).toBe(true);

    expect(result.totalDocs).toBe(2);
    expect(result.hits).toHaveLength(2);
  });

  it('returns hits ordered by score with slug, type, name, and a snippet', async () => {
    const store = createAttachmentStore();
    const bodyA =
      'Lots of leading filler so the snippet has to be windowed around the matching term. '.repeat(
        4,
      ) + 'The marker term is RELEASE PIPELINE and here is more context after it.';
    const bodyB = '# Auth flow\n\nOAuth login details.\n';
    await publishDoc(store, bodyA, 'release-pipeline', 'spec');
    await publishDoc(store, bodyB, 'auth-flow', 'note');

    // Force the release doc to rank higher (whichever index it landed at).
    vi.mocked(simMod.rankBySimilarity).mockImplementation((_q, candidates) => {
      const idxRelease = candidates.findIndex((c) => c.includes('RELEASE PIPELINE'));
      const idxOther = idxRelease === 0 ? 1 : 0;
      return [
        { index: idxRelease, score: 0.92 },
        { index: idxOther, score: 0.31 },
      ];
    });

    const result = await searchAllProjectDocs('release pipeline', {
      projectRoot: tmpRoot,
      limit: 10,
    });

    expect(result.hits).toHaveLength(2);
    expect(result.hits[0].score).toBeGreaterThan(result.hits[1].score);
    expect(result.hits[0].slug).toBe('release-pipeline');
    expect(result.hits[0].type).toBe('spec');
    expect(result.hits[0].ownerType).toBe('task');
    expect(result.hits[0].ownerId).toBe('T9647');
    expect(result.hits[0].snippet).toContain('RELEASE PIPELINE');
    // Long bodies are windowed.
    expect(result.hits[0].snippet.length).toBeLessThan(bodyA.length);
  });

  it('honors limit by slicing the ranked list', async () => {
    const store = createAttachmentStore();
    await publishDoc(store, 'doc one body', 'one', 'note');
    await publishDoc(store, 'doc two body', 'two', 'note');
    await publishDoc(store, 'doc three body', 'three', 'note');

    vi.mocked(simMod.rankBySimilarity).mockImplementation((_q, candidates) =>
      candidates.map((_c, i) => ({ index: i, score: 1 - i * 0.1 })),
    );

    const result = await searchAllProjectDocs('doc', { projectRoot: tmpRoot, limit: 2 });
    expect(result.totalDocs).toBe(3);
    expect(result.hits).toHaveLength(2);
  });

  it('filters by type when opts.type is set', async () => {
    const store = createAttachmentStore();
    await publishDoc(store, 'spec body content', 'a-spec', 'spec');
    await publishDoc(store, 'note body content', 'a-note', 'note');

    vi.mocked(simMod.rankBySimilarity).mockImplementation((_q, candidates) =>
      candidates.map((_c, i) => ({ index: i, score: 1 - i * 0.1 })),
    );

    const result = await searchAllProjectDocs('body', {
      projectRoot: tmpRoot,
      type: 'spec',
      limit: 10,
    });

    expect(result.totalDocs).toBe(1);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].type).toBe('spec');
  });

  it('skips non-text attachments so binary bytes never enter the corpus', async () => {
    const store = createAttachmentStore();
    await publishDoc(store, 'real markdown text', 'md-doc', 'note', 'text/markdown');
    // PNG-like bytes — not a real PNG but mime is image/png so it must be skipped.
    await store.put(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      { kind: 'blob', mime: 'image/png' } as Parameters<typeof store.put>[1],
      'task',
      'T9647',
      'binary-test',
      tmpRoot,
      { slug: 'logo', type: 'note' },
    );

    vi.mocked(simMod.rankBySimilarity).mockImplementation((_q, candidates) =>
      candidates.map((_c, i) => ({ index: i, score: 1 - i * 0.1 })),
    );

    const result = await searchAllProjectDocs('markdown', { projectRoot: tmpRoot, limit: 10 });

    // totalDocs counts every dedup-distinct attachment, but only text ones go
    // to rankBySimilarity.
    expect(result.totalDocs).toBe(2);
    const rankArgs = vi.mocked(simMod.rankBySimilarity).mock.calls[0];
    expect(rankArgs[1]).toHaveLength(1);
    expect(rankArgs[1][0]).toContain('real markdown text');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].slug).toBe('md-doc');
  });

  it('returns hits=[] without calling rankBySimilarity for an empty query string', async () => {
    const store = createAttachmentStore();
    await publishDoc(store, 'a body', 'a-doc', 'note');
    const result = await searchAllProjectDocs('   ', { projectRoot: tmpRoot });
    expect(result.hits).toEqual([]);
    expect(simMod.rankBySimilarity).not.toHaveBeenCalled();
  });
});
