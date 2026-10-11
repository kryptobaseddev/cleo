/**
 * `buildDocsFetchResult` envelope contract — T13352.
 *
 * The fetch/view envelope surfaces decoded UTF-8 `content` for text docs
 * (no base64 round-trip), the REAL `refCount` from the read model, and a
 * storage path resolved against the doc's actual backing store. Binary
 * docs keep `bytesBase64`.
 *
 * Pure builder tests — fabricated ResolvedDoc records, no DB.
 *
 * @task T13352
 */

import { describe, expect, it } from 'vitest';
import type { ResolvedDoc } from '../docs-read-model.js';
import { buildDocsFetchResult, docsStoragePath, isTextMime } from '../fetch-result.js';

const SHA = 'a'.repeat(64);
const ROOT = '/tmp/t13352-project';

function makeDoc(overrides: Partial<ResolvedDoc> = {}): ResolvedDoc {
  return {
    id: 'att-1',
    sha256: SHA,
    kind: 'spec',
    title: 'A spec',
    slug: 'a-spec',
    displayNumber: null,
    ownerId: 'T1',
    ownerType: 'task',
    blobName: 'a-spec.md',
    sizeBytes: 42,
    refCount: 3,
    mimeType: 'text/markdown',
    summary: null,
    lifecycleStatus: 'draft',
    createdAt: '2026-10-10T00:00:00.000Z',
    publishedPath: null,
    publishedAt: null,
    lastPublishedBlobSha: null,
    publicationDrift: 'unpublished',
    source: 'tasks-db',
    ...overrides,
  };
}

describe('isTextMime (T13352)', () => {
  it('treats text/*, common text application/* types and null as text', () => {
    expect(isTextMime('text/markdown')).toBe(true);
    expect(isTextMime('text/plain; charset=utf-8')).toBe(true);
    expect(isTextMime('application/json')).toBe(true);
    expect(isTextMime('application/yaml')).toBe(true);
    expect(isTextMime(null)).toBe(true);
  });

  it('treats binary types as non-text', () => {
    expect(isTextMime('application/pdf')).toBe(false);
    expect(isTextMime('application/octet-stream')).toBe(false);
    expect(isTextMime('image/png')).toBe(false);
  });
});

describe('docsStoragePath (T13352)', () => {
  it('resolves manifest-db docs into the blob store', () => {
    const path = docsStoragePath(makeDoc({ source: 'manifest-db' }), '/p/.cleo');
    expect(path).toBe(`/p/.cleo/blobs/blobs/${SHA}`);
  });

  it('resolves tasks-db docs into the legacy attachment tree with the MIME extension', () => {
    const path = docsStoragePath(makeDoc(), '/p/.cleo');
    expect(path).toBe(`/p/.cleo/attachments/sha256/aa/${'a'.repeat(62)}.md`);
  });
});

describe('buildDocsFetchResult (T13352)', () => {
  it('surfaces decoded content (not base64) and the real refCount for a text doc', () => {
    const result = buildDocsFetchResult({
      doc: makeDoc(),
      content: '# A spec\n\nBody.\n',
      projectRoot: ROOT,
    });
    expect(result.content).toBe('# A spec\n\nBody.\n');
    expect(result.bytesBase64).toBeUndefined();
    expect(result.inlined).toBe(true);
    expect(result.metadata.refCount).toBe(3);
    expect(result.metadata.mime).toBe('text/markdown');
    expect(result.metadata.type).toBe('spec');
    expect(result.path).toContain('.cleo/attachments/sha256/aa/');
    expect(result.path).toMatch(/\.md$/);
  });

  it('keeps bytesBase64 (not content) for a binary doc', () => {
    const result = buildDocsFetchResult({
      doc: makeDoc({ mimeType: 'application/pdf', blobName: 'scan.pdf' }),
      content: '%PDF-1.7 fake',
      projectRoot: ROOT,
    });
    expect(result.content).toBeUndefined();
    expect(result.bytesBase64).toBe(Buffer.from('%PDF-1.7 fake', 'utf-8').toString('base64'));
    expect(result.inlined).toBe(true);
  });

  it('points manifest-db docs at the blob store path', () => {
    const result = buildDocsFetchResult({
      doc: makeDoc({ source: 'manifest-db' }),
      content: 'body',
      projectRoot: ROOT,
    });
    expect(result.path).toContain(`.cleo/blobs/blobs/${SHA}`);
  });

  it('inlines nothing above the 1 MB cap', () => {
    const result = buildDocsFetchResult({
      doc: makeDoc(),
      content: 'x'.repeat(1024 * 1024 + 1),
      projectRoot: ROOT,
    });
    expect(result.content).toBeUndefined();
    expect(result.bytesBase64).toBeUndefined();
    expect(result.inlined).toBe(false);
  });
});
