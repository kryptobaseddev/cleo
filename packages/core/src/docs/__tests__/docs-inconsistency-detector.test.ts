/**
 * Tests for docs-inconsistency-detector.ts — cross-store SHA consistency.
 *
 * All DB access and blob-store operations are mocked so tests run offline.
 *
 * @task T11051 (Epic T10519 / Saga T10516)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const list = vi.fn<() => Promise<unknown[]>>();
  const open = vi.fn<() => Promise<void>>();
  const close = vi.fn<() => Promise<void>>();
  const access = vi.fn<() => Promise<void>>();
  const readdirSync = vi.fn<() => unknown[]>();
  return { list, open, close, access, readdirSync };
});

vi.mock('../../store/llmtxt-blob-adapter.js', () => ({
  CleoBlobStore: vi.fn().mockImplementation(function (this: unknown) {
    return {
      open: mocks.open,
      close: mocks.close,
      list: mocks.list,
      get: vi.fn(),
      attach: vi.fn(),
      detach: vi.fn(),
    };
  }),
}));

vi.mock('../../store/sqlite.js', () => ({
  getDb: vi.fn(),
  getNativeTasksDb: vi.fn(() => ({ exec: vi.fn() })),
}));

vi.mock('../../paths.js', () => ({
  getProjectRoot: vi.fn(() => '/tmp/test-project'),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readdirSync: mocks.readdirSync,
  Dirent: class { name = ''; isFile() { return true; } isDirectory() { return false; } },
}));

vi.mock('node:fs/promises', () => ({
  access: mocks.access,
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

import { checkDocsConsistency } from '../docs-inconsistency-detector.js';
import { getDb } from '../../store/sqlite.js';

// ─── Drizzle chain — minimal mock that returns configured arrays ──────────────

type MockRow = Record<string, unknown>;

function makeDb(calls: MockRow[][]) {
  let idx = 0;
  const all = vi.fn(() => {
    const r = calls[idx] ?? [];
    idx++;
    return r;
  });
  const get = vi.fn(() => ({ n: calls[0]?.length ?? 0 }));
  const where = vi.fn(() => ({ all, get }));
  const from = vi.fn(() => ({ all, get, where }));
  const select = vi.fn(() => ({ from, all, get, where }));
  return { select, from, where, all, get } as unknown as ReturnType<typeof getDb>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pub(overrides: MockRow = {}) {
  return {
    id: 'att_1',
    sha256: 'a'.repeat(64),
    slug: 'test-slug',
    type: 'adr',
    lifecycleStatus: 'accepted',
    refCount: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([]);
  mocks.open.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
  mocks.access.mockRejectedValue(new Error('ENOENT'));
  mocks.readdirSync.mockImplementation(() => { throw new Error('ENOENT'); });
});

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('checkDocsConsistency', () => {
  it('clean: no published docs', async () => {
    vi.mocked(getDb).mockReturnValue(makeDb([[], [], []]));

    const r = await checkDocsConsistency('/tmp/x');
    expect(r.consistent).toBe(true);
    expect(r.docsChecked).toBe(0);
    expect(r.findings).toHaveLength(0);
  });

  it('clean: published doc with all stores agreeing', async () => {
    const sha = 'a'.repeat(64);
    const att = [pub({ sha256: sha })];
    vi.mocked(getDb).mockReturnValue(makeDb([att, /*orphans*/[], /*zeroRef*/[]]));

    mocks.list.mockResolvedValue([{ hash: sha }]);
    mocks.access.mockResolvedValue(undefined);

    const r = await checkDocsConsistency('/tmp/x');
    expect(r.consistent).toBe(true);
    expect(r.docsChecked).toBe(1);
    expect(r.findings).toHaveLength(0);
  });

  it('sha-mismatch: manifest has different hash', async () => {
    const tasksSha = 'a'.repeat(64);
    const manifestSha = 'b'.repeat(64);
    const att = [pub({ sha256: tasksSha })];
    vi.mocked(getDb).mockReturnValue(makeDb([att, [], []]));

    // First list() call (__docs__) returns empty, second (att_1) returns different hash
    mocks.list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ hash: manifestSha }]);
    mocks.access.mockResolvedValue(undefined);

    const r = await checkDocsConsistency('/tmp/x');
    const mismatches = r.findings.filter((f) => f.kind === 'sha-mismatch');
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].slug).toBe('test-slug');
    expect(r.consistent).toBe(false);
  });

  it('missing-blob-filesystem: no blob on disk', async () => {
    const att = [pub()];
    vi.mocked(getDb).mockReturnValue(makeDb([att, [], []]));

    mocks.list.mockResolvedValue([]);
    // ENOENT on both legacy and new paths
    mocks.access.mockRejectedValue(new Error('ENOENT'));

    const r = await checkDocsConsistency('/tmp/x');
    const missing = r.findings.filter(
      (f) => f.kind === 'missing-blob-filesystem' && f.severity === 'error',
    );
    expect(missing).toHaveLength(1);
    expect(r.consistent).toBe(false);
  });

  it('missing-blob-filesystem: legacy-only warns', async () => {
    const sha = 'a'.repeat(64);
    const att = [pub({ sha256: sha })];
    vi.mocked(getDb).mockReturnValue(makeDb([att, [], []]));

    mocks.list.mockResolvedValue([]);
    mocks.access.mockRejectedValue(new Error('ENOENT')); // new path missing
    mocks.readdirSync.mockReturnValue([{ isFile: () => true, isDirectory: () => false, name: sha.slice(2) + '.md' }]);

    const r = await checkDocsConsistency('/tmp/x');
    const warnings = r.findings.filter(
      (f) => f.kind === 'missing-blob-filesystem' && f.severity === 'warning',
    );
    expect(warnings).toHaveLength(1);
  });

  it('orphaned-refs detected', async () => {
    const att = [pub()];
    const orphans = [{ attachmentId: 'orph', ownerType: 'task', ownerId: 'T99' }];
    vi.mocked(getDb).mockReturnValue(makeDb([att, orphans, []]));

    mocks.list.mockResolvedValue([]);
    mocks.access.mockResolvedValue(undefined);

    const r = await checkDocsConsistency('/tmp/x');
    const o = r.findings.filter((f) => f.kind === 'orphaned-ref');
    expect(o).toHaveLength(1);
    expect(o[0].attachmentId).toBe('orph');
  });

  it('zero-ref attachments detected', async () => {
    const att = [pub({ refCount: 0 })];
    vi.mocked(getDb).mockReturnValue(makeDb([att, [], att]));

    mocks.list.mockResolvedValue([]);
    mocks.access.mockResolvedValue(undefined);

    const r = await checkDocsConsistency('/tmp/x');
    const z = r.findings.filter((f) => f.kind === 'zero-ref-attachment');
    expect(z).toHaveLength(1);
    expect(z[0].attachmentId).toBe('att_1');
  });

  it('slug-disagreement: same slug, different SHA', async () => {
    const sha1 = 'a'.repeat(64);
    const sha2 = 'b'.repeat(64);
    const atts = [
      pub({ sha256: sha1 }),
      pub({ sha256: sha2, id: 'att_2' }),
    ];
    vi.mocked(getDb).mockReturnValue(makeDb([atts, [], []]));

    mocks.list.mockResolvedValue([]);
    mocks.access.mockResolvedValue(undefined);

    const r = await checkDocsConsistency('/tmp/x');
    const d = r.findings.filter((f) => f.kind === 'slug-disagreement');
    expect(d).toHaveLength(1);
    expect(r.consistent).toBe(false);
  });

  it('slug-disagreement: same SHA with same slug is fine', async () => {
    const sha = 'a'.repeat(64);
    const atts = [pub({ sha256: sha }), pub({ sha256: sha, id: 'att_2' })];
    vi.mocked(getDb).mockReturnValue(makeDb([atts, [], []]));

    mocks.list.mockResolvedValue([]);
    mocks.access.mockResolvedValue(undefined);

    const r = await checkDocsConsistency('/tmp/x');
    expect(r.findings.filter((f) => f.kind === 'slug-disagreement')).toHaveLength(0);
  });

  it('skips drafts', async () => {
    vi.mocked(getDb).mockReturnValue(makeDb([[pub({ lifecycleStatus: 'draft' })], [], []]));

    const r = await checkDocsConsistency('/tmp/x');
    expect(r.docsChecked).toBe(0);
  });

  it('skips slugless', async () => {
    vi.mocked(getDb).mockReturnValue(makeDb([[pub({ slug: null })], [], []]));

    const r = await checkDocsConsistency('/tmp/x');
    expect(r.docsChecked).toBe(0);
  });

  it('handles DB errors gracefully', async () => {
    vi.mocked(getDb).mockImplementation(() => { throw new Error('locked'); });

    const r = await checkDocsConsistency('/tmp/x');
    expect(r.consistent).toBe(false);
    expect(r.findings.some((f) => f.kind === 'missing-blob-manifest')).toBe(true);
  });

  it('handles blob store unavailable', async () => {
    const att = [pub()];
    vi.mocked(getDb).mockReturnValue(makeDb([att, [], []]));

    mocks.open.mockRejectedValue(new Error('no manifest.db'));
    mocks.access.mockResolvedValue(undefined);

    const r = await checkDocsConsistency('/tmp/x');
    expect(r.docsChecked).toBe(1);
  });
});
