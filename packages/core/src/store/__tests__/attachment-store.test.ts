/**
 * Unit tests for the content-addressed attachment store.
 *
 * Each test uses an isolated temporary directory so the tasks.db singleton is
 * reset between runs (same pattern as brain-accessor.test.ts).
 *
 * @epic T760
 * @task T796
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

describe('AttachmentStore', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-attachment-store-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  });

  afterEach(async () => {
    // Reset the tasks.db singleton so subsequent tests get a fresh database.
    const { closeDb } = await import('../sqlite.js');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // put → get round-trip
  // ──────────────────────────────────────────────────────────────────────────

  it('put stores bytes and get retrieves the same bytes', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const content = 'Hello, attachments!';
    const bytes = Buffer.from(content, 'utf-8');

    const meta = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T001',
    );

    expect(meta.id).toBeTruthy();
    expect(meta.sha256).toHaveLength(64);
    expect(meta.refCount).toBe(1);
    expect(meta.attachment.kind).toBe('blob');

    const result = await store.get(meta.sha256);
    expect(result).not.toBeNull();
    expect(result!.bytes.toString('utf-8')).toBe(content);
    expect(result!.metadata.id).toBe(meta.id);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // put twice same content → one row, refCount=2
  // ──────────────────────────────────────────────────────────────────────────

  it('put twice with identical content shares one row and increments refCount', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('# RFC draft v3\n\nShared content.', 'utf-8');

    const meta1 = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/markdown', size: bytes.length },
      'task',
      'T001',
    );

    const meta2 = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/markdown', size: bytes.length },
      'task',
      'T002',
    );

    // Same blob → same id and sha256.
    expect(meta1.id).toBe(meta2.id);
    expect(meta1.sha256).toBe(meta2.sha256);

    // Two distinct refs → refCount = 2.
    expect(meta2.refCount).toBe(2);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // deref drops refCount; when refCount reaches 0 blob file is removed
  // ──────────────────────────────────────────────────────────────────────────

  it('deref decrements refCount and purges blob when refCount reaches 0', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('Ephemeral content', 'utf-8');

    // Put with one ref.
    const meta = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T010',
    );

    expect(meta.refCount).toBe(1);

    // Verify blob file exists.
    const sha256 = meta.sha256;
    const prefix = sha256.slice(0, 2);
    const rest = sha256.slice(2);
    const blobFile = join(process.env['CLEO_DIR']!, 'attachments', 'sha256', prefix, `${rest}.txt`);
    await expect(stat(blobFile)).resolves.toBeTruthy();

    // Deref — last ref, should purge.
    const result = await store.deref(meta.id, 'task', 'T010');
    expect(result.status).toBe('removed');

    // Blob file should be gone.
    await expect(stat(blobFile)).rejects.toThrow();

    // get should return null.
    const fetched = await store.get(sha256);
    expect(fetched).toBeNull();
  });

  it('deref with remaining refs keeps blob and returns { status: "derefd" }', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('Shared blob', 'utf-8');

    // Two refs.
    const meta1 = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T020',
    );
    await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T021',
    );

    // Remove one ref.
    const result = await store.deref(meta1.id, 'task', 'T020');
    expect(result.status).toBe('derefd');
    expect(result.status === 'derefd' && result.refCountAfter).toBe(1);

    // Blob still retrievable.
    const fetched = await store.get(meta1.sha256);
    expect(fetched).not.toBeNull();
    expect(fetched!.metadata.refCount).toBe(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // get non-existent → null
  // ──────────────────────────────────────────────────────────────────────────

  it('get returns null for a non-existent SHA-256', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const result = await store.get('a'.repeat(64));
    expect(result).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // getMetadata non-existent → null
  // ──────────────────────────────────────────────────────────────────────────

  it('getMetadata returns null for an unknown attachment ID', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const result = await store.getMetadata('no-such-id');
    expect(result).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // listByOwner returns correct attachments
  // ──────────────────────────────────────────────────────────────────────────

  it('listByOwner returns all attachments for a given owner', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes1 = Buffer.from('Doc A', 'utf-8');
    const bytes2 = Buffer.from('Doc B', 'utf-8');

    await store.put(
      bytes1,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes1.length },
      'task',
      'T050',
    );
    await store.put(
      bytes2,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes2.length },
      'task',
      'T050',
    );

    const list = await store.listByOwner('task', 'T050');
    expect(list).toHaveLength(2);
    for (const m of list) {
      expect(m.attachment.kind).toBe('blob');
    }
  });

  it('listByOwner returns empty array when owner has no attachments', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const list = await store.listByOwner('task', 'TXXX');
    expect(list).toEqual([]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // ref / deref explicit flow
  // ──────────────────────────────────────────────────────────────────────────

  it('explicit ref increases refCount, deref decrements it', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('Ref test content', 'utf-8');

    const meta = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T060',
    );
    expect(meta.refCount).toBe(1);

    // Add an explicit extra ref.
    await store.ref(meta.id, 'session', 'ses_abc', 'test-agent');

    const updated = await store.getMetadata(meta.id);
    expect(updated!.refCount).toBe(2);

    // Deref one.
    const r1 = await store.deref(meta.id, 'session', 'ses_abc');
    expect(r1.status).toBe('derefd');
    expect(r1.status === 'derefd' && r1.refCountAfter).toBe(1);

    const after1 = await store.getMetadata(meta.id);
    expect(after1!.refCount).toBe(1);

    // Deref last.
    const r2 = await store.deref(meta.id, 'task', 'T060');
    expect(r2.status).toBe('removed');

    const gone = await store.getMetadata(meta.id);
    expect(gone).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TOCTOU race: concurrent put of same content → refCount = 2, one row
  // ──────────────────────────────────────────────────────────────────────────

  it('concurrent put of same content from 2 workers results in refCount=2 and one row', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('Concurrent shared content', 'utf-8');

    // Simulate two concurrent workers putting identical content.
    const [meta1, meta2] = await Promise.all([
      store.put(
        bytes,
        { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
        'task',
        'T070',
      ),
      store.put(
        bytes,
        { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
        'task',
        'T071',
      ),
    ]);

    // Both should return the same attachment ID and SHA-256 (content-addressed).
    expect(meta1.id).toBe(meta2.id);
    expect(meta1.sha256).toBe(meta2.sha256);

    // refCount should be 2 (both refs exist).
    expect(meta2.refCount).toBe(2);

    // Verify only one blob exists in storage.
    const result = await store.get(meta1.sha256);
    expect(result).not.toBeNull();
    expect(result!.metadata.refCount).toBe(2);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Integrity check: corrupted blob detected on get
  // ──────────────────────────────────────────────────────────────────────────

  it('get throws AttachmentIntegrityError when blob is corrupted', async () => {
    const { createAttachmentStore, AttachmentIntegrityError } = await import(
      '../attachment-store.js'
    );
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('Original content', 'utf-8');

    const meta = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T080',
    );

    // Tamper with the stored blob file: replace with random bytes.
    const sha256 = meta.sha256;
    const prefix = sha256.slice(0, 2);
    const rest = sha256.slice(2);
    const blobFile = join(process.env['CLEO_DIR']!, 'attachments', 'sha256', prefix, `${rest}.txt`);
    const { writeFile: overwrite } = await import('node:fs/promises');
    await overwrite(blobFile, Buffer.from('Corrupted bytes', 'utf-8'));

    // Attempting get should throw AttachmentIntegrityError.
    await expect(store.get(sha256)).rejects.toThrow(AttachmentIntegrityError);

    try {
      await store.get(sha256);
      throw new Error('Expected AttachmentIntegrityError');
    } catch (err) {
      if (err instanceof AttachmentIntegrityError) {
        expect(err.expectedSha256).toBe(sha256);
        expect(err.actualSha256).not.toBe(sha256);
        expect(err.path).toContain(prefix);
      } else {
        throw err;
      }
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Discriminated deref return type
  // ──────────────────────────────────────────────────────────────────────────

  it('deref returns correct discriminated result for each case', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('Test discriminated union', 'utf-8');

    const meta = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T090',
    );

    // Case 1: deref unknown ID → { status: 'not-found' }
    const notFoundResult = await store.deref('no-such-id', 'task', 'T099');
    expect(notFoundResult).toEqual({ status: 'not-found' });

    // Case 2: deref with remaining refs → { status: 'derefd', refCountAfter: N }
    await store.ref(meta.id, 'session', 'ses_extra');
    expect(meta.refCount).toBe(1); // Original ref from put

    const derefResult = await store.deref(meta.id, 'session', 'ses_extra');
    expect(derefResult.status).toBe('derefd');
    expect(derefResult.status === 'derefd' && derefResult.refCountAfter).toBe(1);

    // Case 3: deref last remaining ref → { status: 'removed' }
    const removeResult = await store.deref(meta.id, 'task', 'T090');
    expect(removeResult).toEqual({ status: 'removed' });
  });
});
