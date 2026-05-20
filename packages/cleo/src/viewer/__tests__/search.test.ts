/**
 * T9647 — viewer `/api/search` route tests.
 *
 * Spins up the viewer against a temp project + publishes a couple of
 * markdown docs through the AttachmentStore, then exercises the
 * search endpoint over real HTTP.
 *
 * `llmtxt/similarity.rankBySimilarity` is mocked to a deterministic order
 * so we can assert the LAFS envelope shape, snippet windowing, score
 * ordering, and validation behaviour without depending on the actual WASM
 * ranking implementation.
 *
 * @task T9647
 * @epic T9631
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttachmentStore } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('llmtxt/similarity', () => ({
  rankBySimilarity: vi.fn(),
}));

import * as simMod from 'llmtxt/similarity';
import { startViewer } from '../server.js';

let tmpProjectRoot: string;
let prevCleoHome: string | undefined;
let prevCwd: string;

beforeEach(async () => {
  tmpProjectRoot = await mkdtemp(join(tmpdir(), 'cleo-viewer-search-'));
  prevCleoHome = process.env.CLEO_HOME;
  process.env.CLEO_HOME = join(tmpProjectRoot, 'cleo-home');
  prevCwd = process.cwd();
  await mkdir(join(tmpProjectRoot, '.cleo'), { recursive: true });
  await mkdir(join(tmpProjectRoot, '.git'), { recursive: true });
  process.chdir(tmpProjectRoot);
  vi.mocked(simMod.rankBySimilarity).mockReset();
});

afterEach(async () => {
  process.chdir(prevCwd);
  if (prevCleoHome === undefined) delete process.env.CLEO_HOME;
  else process.env.CLEO_HOME = prevCleoHome;
  await rm(tmpProjectRoot, { recursive: true, force: true });
});

async function fetchJson(host: string, port: number, path: string) {
  const res = await fetch(`http://${host}:${port}${path}`, {
    headers: { Accept: 'application/json' },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, contentType: res.headers.get('content-type') };
}

async function publish(slug: string, body: string, type: string) {
  const store = createAttachmentStore();
  await store.put(
    Buffer.from(body, 'utf8'),
    { kind: 'blob', mime: 'text/markdown' } as Parameters<typeof store.put>[1],
    'task',
    'T9647',
    'viewer-search-test',
    tmpProjectRoot,
    { slug, type },
  );
}

describe('T9647 — /api/search route', () => {
  it('rejects a missing query with E_VALIDATION (400)', async () => {
    const handle = await startViewer({
      startPort: 0,
      endPort: 0,
      autoIncrement: false,
      projectRoot: tmpProjectRoot,
    });
    try {
      const { status, body, contentType } = await fetchJson(
        handle.host,
        handle.port,
        '/api/search',
      );
      expect(status).toBe(400);
      expect(contentType).toContain('application/json');
      expect(body?.success).toBe(false);
      expect(body?.error?.code).toBe('E_VALIDATION');
      expect(body?.error?.fix).toContain('?q=');
    } finally {
      handle.server.close();
    }
  });

  it('rejects an empty query string with E_VALIDATION (400)', async () => {
    const handle = await startViewer({
      startPort: 0,
      endPort: 0,
      autoIncrement: false,
      projectRoot: tmpProjectRoot,
    });
    try {
      const { status, body } = await fetchJson(handle.host, handle.port, '/api/search?q=');
      expect(status).toBe(400);
      expect(body?.error?.code).toBe('E_VALIDATION');
    } finally {
      handle.server.close();
    }
  });

  it('returns a LAFS success envelope with empty hits on a fresh project', async () => {
    const handle = await startViewer({
      startPort: 0,
      endPort: 0,
      autoIncrement: false,
      projectRoot: tmpProjectRoot,
    });
    try {
      const { status, body } = await fetchJson(handle.host, handle.port, '/api/search?q=anything');
      expect(status).toBe(200);
      expect(body?.success).toBe(true);
      expect(body?.data?.query).toBe('anything');
      expect(body?.data?.totalDocs).toBe(0);
      expect(body?.data?.hits).toEqual([]);
      // No candidates → never ranks.
      expect(simMod.rankBySimilarity).not.toHaveBeenCalled();
    } finally {
      handle.server.close();
    }
  });

  it('ranks published docs and returns LAFS-shaped hits with slug, type, snippet, score', async () => {
    await publish(
      'release-pipeline',
      [
        '# Release pipeline',
        '',
        'This is the release pipeline spec. It documents the release flow end to end.',
      ].join('\n'),
      'spec',
    );
    await publish(
      'auth-flow',
      '# Auth flow\n\nLogin happens through OAuth and short-lived sessions.\n',
      'note',
    );

    vi.mocked(simMod.rankBySimilarity).mockImplementation((_q, candidates) => {
      const idxRelease = candidates.findIndex((c) => c.includes('release pipeline'));
      const idxOther = idxRelease === 0 ? 1 : 0;
      return [
        { index: idxRelease, score: 0.91 },
        { index: idxOther, score: 0.18 },
      ];
    });

    const handle = await startViewer({
      startPort: 0,
      endPort: 0,
      autoIncrement: false,
      projectRoot: tmpProjectRoot,
    });
    try {
      const { status, body } = await fetchJson(
        handle.host,
        handle.port,
        '/api/search?q=release%20pipeline&limit=5',
      );
      expect(status).toBe(200);
      expect(body?.success).toBe(true);
      expect(body?.data?.totalDocs).toBe(2);
      const hits = body?.data?.hits as Array<{
        slug: string;
        type: string;
        snippet: string;
        score: number;
      }>;
      expect(hits).toHaveLength(2);
      expect(hits[0].score).toBeGreaterThan(hits[1].score);
      expect(hits[0].slug).toBe('release-pipeline');
      expect(hits[0].type).toBe('spec');
      expect(typeof hits[0].snippet).toBe('string');
      expect(hits[0].snippet.length).toBeGreaterThan(0);
    } finally {
      handle.server.close();
    }
  });

  it('clamps `limit` into [1, 50]', async () => {
    await publish('one', 'doc one body content', 'note');
    await publish('two', 'doc two body content', 'note');

    vi.mocked(simMod.rankBySimilarity).mockImplementation((_q, candidates) =>
      candidates.map((_c, i) => ({ index: i, score: 1 - i * 0.1 })),
    );

    const handle = await startViewer({
      startPort: 0,
      endPort: 0,
      autoIncrement: false,
      projectRoot: tmpProjectRoot,
    });
    try {
      // Negative limit clamps to 1.
      const negative = await fetchJson(handle.host, handle.port, '/api/search?q=doc&limit=-5');
      expect(negative.status).toBe(200);
      expect((negative.body?.data?.hits as unknown[]).length).toBe(1);

      // Huge limit clamps to corpus size (the function caps via Math.min(50, n)).
      const huge = await fetchJson(handle.host, handle.port, '/api/search?q=doc&limit=9999');
      expect(huge.status).toBe(200);
      expect((huge.body?.data?.hits as unknown[]).length).toBe(2);
    } finally {
      handle.server.close();
    }
  });

  it('filters by `type` query parameter', async () => {
    await publish('a-spec', 'spec doc content', 'spec');
    await publish('a-note', 'note doc content', 'note');

    vi.mocked(simMod.rankBySimilarity).mockImplementation((_q, candidates) =>
      candidates.map((_c, i) => ({ index: i, score: 1 - i * 0.1 })),
    );

    const handle = await startViewer({
      startPort: 0,
      endPort: 0,
      autoIncrement: false,
      projectRoot: tmpProjectRoot,
    });
    try {
      const { status, body } = await fetchJson(
        handle.host,
        handle.port,
        '/api/search?q=doc&type=spec',
      );
      expect(status).toBe(200);
      const hits = body?.data?.hits as Array<{ type: string }>;
      expect(hits).toHaveLength(1);
      expect(hits[0].type).toBe('spec');
    } finally {
      handle.server.close();
    }
  });

  it('rejects POST with E_METHOD_NOT_ALLOWED', async () => {
    const handle = await startViewer({
      startPort: 0,
      endPort: 0,
      autoIncrement: false,
      projectRoot: tmpProjectRoot,
    });
    try {
      const res = await fetch(`http://${handle.host}:${handle.port}/api/search?q=x`, {
        method: 'POST',
      });
      expect(res.status).toBe(405);
      const body = (await res.json()) as { success: boolean; error: { code: string } };
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('E_METHOD_NOT_ALLOWED');
    } finally {
      handle.server.close();
    }
  });

  it('renders LAFS error envelope (500) when llmtxt similarity throws', async () => {
    await publish('any', '# any body content', 'note');
    vi.mocked(simMod.rankBySimilarity).mockImplementationOnce(() => {
      const err = new Error('boom') as Error & { code: string };
      err.code = 'E_RANK_FAILED';
      throw err;
    });

    const handle = await startViewer({
      startPort: 0,
      endPort: 0,
      autoIncrement: false,
      projectRoot: tmpProjectRoot,
    });
    try {
      const { status, body } = await fetchJson(handle.host, handle.port, '/api/search?q=x');
      expect(status).toBe(500);
      expect(body?.success).toBe(false);
      expect(body?.error?.message).toContain('boom');
    } finally {
      handle.server.close();
    }
  });
});
