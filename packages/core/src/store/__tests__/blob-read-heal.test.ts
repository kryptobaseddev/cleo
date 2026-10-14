/**
 * A blob-store miss heals from hash-verified legacy bytes (T13705).
 *
 * After #2210 the read paths consult only the blob store, so a doc whose
 * bytes predate it (they live only in `.cleo/attachments/sha256/`) failed
 * `docs fetch` until `cleo docs doctor --repair` ran. The first read now runs
 * the same hash-verified single-sha backfill and serves the bytes; bytes that
 * do not hash to the recorded sha are never written or served.
 *
 * @task T13705
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocsReadModel, type ResolvedDoc } from '../../docs/docs-read-model.js';
import { blobReadBySha } from '../blob-ops.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'blob-read-heal-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write `body` where a pre-blob-store writer left it: the legacy sha256 tree. */
function legacyDoc(body: string, sha = createHash('sha256').update(body).digest('hex')): string {
  const dir = join(root, '.cleo', 'attachments', 'sha256', sha.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sha.slice(2)}.md`), body);
  return sha;
}

const blobStoreFile = (sha: string): string => join(root, '.cleo', 'blobs', 'blobs', sha);

function doc(sha256: string): ResolvedDoc {
  return {
    id: 'att_legacy',
    sha256,
    kind: 'note',
    title: 'Legacy Note',
    slug: 'legacy-note',
    ownerId: 'T1',
    ownerType: 'task',
    blobName: 'legacy-note',
    sizeBytes: 0,
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
  };
}

describe('blob-store miss self-heal (T13705)', () => {
  it('a doc whose bytes exist only in the legacy tree fetches, and leaves the blob-store file behind', async () => {
    const body = '# May-era doc\n\nwritten before the blob store held every body.\n';
    const sha = legacyDoc(body);
    expect(existsSync(blobStoreFile(sha))).toBe(false);

    const content = await new DocsReadModel({ projectRoot: root }).fetchContent(doc(sha));

    expect(content).toBe(body);
    expect(readFileSync(blobStoreFile(sha), 'utf-8')).toBe(body);
  });

  it('legacy bytes that do not hash to the recorded sha are refused: nothing is served or written', async () => {
    const recorded = createHash('sha256').update('the original body\n').digest('hex');
    legacyDoc('tampered or truncated body\n', recorded);

    expect(await blobReadBySha(recorded, root)).toBeNull();
    expect(existsSync(blobStoreFile(recorded))).toBe(false);
  });

  it('a heal write that fails still serves the verified bytes, with a warning, and never throws (T13706)', async () => {
    const body = '# legacy doc on a read-only store\n';
    const sha = legacyDoc(body);
    const blobs = join(root, '.cleo', 'blobs', 'blobs');
    mkdirSync(blobs, { recursive: true });
    chmodSync(blobs, 0o555); // the atomic writer cannot create its tmp file here
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      const content = await new DocsReadModel({ projectRoot: root }).fetchContent(doc(sha));
      expect(content).toBe(body);
      expect(existsSync(blobStoreFile(sha))).toBe(false);
      expect(String(warn.mock.calls[0]?.[0])).toContain('cleo docs doctor --repair');
    } finally {
      warn.mockRestore();
      chmodSync(blobs, 0o755);
    }
  });

  it('a sha with no legacy bytes at all stays a miss', async () => {
    expect(await blobReadBySha('b'.repeat(64), root)).toBeNull();
  });
});
