/**
 * Tests for {@link DocsReadModel.fetchContent} after the T13362 retirement of
 * the legacy attachment byte store.
 *
 * Content must come from the blob store (by content address) with NO
 * fallback to the legacy `.cleo/attachments/sha256/` tree: when the blob
 * store misses, the result is `null` and the legacy `AttachmentStore.get`
 * is never consulted.
 *
 * @task T13362
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../store/blob-ops.js', () => ({
  blobList: vi.fn(),
  blobRead: vi.fn(),
  blobReadBySha: vi.fn(),
}));

vi.mock('../../store/attachment-store.js', () => ({
  createAttachmentStore: vi.fn(() => ({
    get: vi.fn(),
    getMetadata: vi.fn(),
    findBySlug: vi.fn(),
    getExtras: vi.fn(),
    listByOwner: vi.fn(),
    listRefs: vi.fn(),
    listAllInProject: vi.fn(),
  })),
}));

vi.mock('../publications-store.js', () => ({
  readDocsPublications: vi.fn(async () => []),
}));

import { createAttachmentStore } from '../../store/attachment-store.js';
import { blobReadBySha } from '../../store/blob-ops.js';
import { DocsReadModel, type ResolvedDoc } from '../docs-read-model.js';

function makeDoc(overrides: Partial<ResolvedDoc> = {}): ResolvedDoc {
  return {
    id: 'att_content',
    sha256: 'a'.repeat(64),
    kind: 'note',
    title: 'My Note',
    slug: 'my-note',
    ownerId: 'T1',
    ownerType: 'task',
    blobName: 'my-note',
    sizeBytes: 12,
    refCount: 1,
    mimeType: 'text/markdown',
    summary: null,
    lifecycleStatus: 'active',
    createdAt: new Date(0).toISOString(),
    publishedPath: null,
    publishedAt: null,
    lastPublishedBlobSha: null,
    publicationDrift: 'unpublished',
    source: 'tasks-db',
    ...overrides,
  };
}

describe('DocsReadModel.fetchContent (T13362 — no legacy fallback)', () => {
  it('reads content from the blob store by content address', async () => {
    const model = new DocsReadModel({ projectRoot: '/tmp/x' });
    vi.mocked(blobReadBySha).mockResolvedValue(new TextEncoder().encode('# Hello\n'));

    const content = await model.fetchContent(makeDoc());

    expect(content).toBe('# Hello\n');
    expect(blobReadBySha).toHaveBeenCalledWith('a'.repeat(64), '/tmp/x');
  });

  it('returns null when the blob store misses — never the legacy byte tree', async () => {
    const model = new DocsReadModel({ projectRoot: '/tmp/x' });
    vi.mocked(blobReadBySha).mockResolvedValue(null);

    const content = await model.fetchContent(makeDoc());

    expect(content).toBeNull();
    // The legacy fallback (attachmentStore.get) must NOT be consulted.
    const store = vi.mocked(createAttachmentStore)();
    expect(vi.mocked(store.get)).not.toHaveBeenCalled();
  });
});
