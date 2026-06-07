/**
 * Tests for {@link DocsReadModel.fetchDecoded} (T10970).
 *
 * The decoded accessor is a thin orchestration over the existing
 * resolve → fetchContent two-step, so these tests stub the underlying
 * resolution + content methods and assert the discriminated result shape
 * (`ok` / `not-found` / `no-content`) and resolution precedence
 * (slug before attachment ID).
 *
 * @task T10970
 */

import { describe, expect, it, vi } from 'vitest';
import { DocsReadModel, type ResolvedDoc } from '../docs-read-model.js';

function makeDoc(overrides: Partial<ResolvedDoc> = {}): ResolvedDoc {
  return {
    id: 'att_decoded',
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

describe('DocsReadModel.fetchDecoded (T10970)', () => {
  it('returns the decoded UTF-8 body when the ref resolves by slug', async () => {
    const model = new DocsReadModel({ projectRoot: '/tmp/x' });
    const doc = makeDoc();
    vi.spyOn(model, 'resolveBySlug').mockResolvedValue(doc);
    const byId = vi.spyOn(model, 'resolveByAttachmentId').mockResolvedValue(null);
    vi.spyOn(model, 'fetchContent').mockResolvedValue('# Hello\nworld');

    const result = await model.fetchDecoded('my-note');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe('# Hello\nworld');
      expect(result.doc).toBe(doc);
    }
    // Slug resolution wins — attachment-id lookup must NOT be consulted.
    expect(byId).not.toHaveBeenCalled();
  });

  it('falls back to attachment-id resolution when slug misses', async () => {
    const model = new DocsReadModel({ projectRoot: '/tmp/x' });
    const doc = makeDoc({ slug: null });
    vi.spyOn(model, 'resolveBySlug').mockResolvedValue(null);
    vi.spyOn(model, 'resolveByAttachmentId').mockResolvedValue(doc);
    vi.spyOn(model, 'fetchContent').mockResolvedValue('body');

    const result = await model.fetchDecoded('att_decoded');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe('body');
  });

  it('returns not-found when neither resolver matches', async () => {
    const model = new DocsReadModel({ projectRoot: '/tmp/x' });
    vi.spyOn(model, 'resolveBySlug').mockResolvedValue(null);
    vi.spyOn(model, 'resolveByAttachmentId').mockResolvedValue(null);
    const fetchSpy = vi.spyOn(model, 'fetchContent');

    const result = await model.fetchDecoded('missing');

    expect(result).toEqual({ ok: false, reason: 'not-found' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns no-content with the doc when the blob is unreadable', async () => {
    const model = new DocsReadModel({ projectRoot: '/tmp/x' });
    const doc = makeDoc();
    vi.spyOn(model, 'resolveBySlug').mockResolvedValue(doc);
    vi.spyOn(model, 'fetchContent').mockResolvedValue(null);

    const result = await model.fetchDecoded('my-note');

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'no-content') {
      expect(result.doc).toBe(doc);
    } else {
      throw new Error(`expected no-content, got ${JSON.stringify(result)}`);
    }
  });
});
