/**
 * Unit tests for the unified attachment store (T947 Wave B).
 *
 * Exercises both the preferred llmtxt-backed path and the legacy fallback.
 * Tests that need `node:sqlite` + `drizzle-orm/node-sqlite` + `llmtxt/blob`
 * are gated via a runtime probe; the legacy path tests always run so the
 * tests so the fallback is always covered.
 *
 * Each test uses an isolated temp directory so the underlying SQLite
 * databases are fresh per run.
 *
 * @epic T947
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Probe whether the llmtxt-backed path is loadable in this process.
 * Mirrors the `canUseLlmtxtBackend` helper inside the SUT.
 */
async function hasLlmtxtPeerDeps(): Promise<boolean> {
  try {
    await import('node:sqlite');
    await import('drizzle-orm/node-sqlite');
    await import('llmtxt/blob');
    return true;
  } catch {
    return false;
  }
}

let peerDepsAvailable = false;
beforeAll(async () => {
  peerDepsAvailable = await hasLlmtxtPeerDeps();
});

// ──────────────────────────────────────────────────────────────────────────
// Backend probe
// ──────────────────────────────────────────────────────────────────────────

describe('resolveAttachmentBackend', () => {
  it('returns "llmtxt" when node:sqlite is available, otherwise "legacy"', async () => {
    const { resolveAttachmentBackend } = await import('../attachment-store-v2.js');
    const backend = await resolveAttachmentBackend();
    if (peerDepsAvailable) {
      expect(backend).toBe('llmtxt');
    } else {
      expect(backend).toBe('legacy');
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// llmtxt-backed path — requires peer deps
// ──────────────────────────────────────────────────────────────────────────

describe.skipIf(!(await hasLlmtxtPeerDeps()))('createAttachmentStoreV2 (llmtxt backend - node:sqlite)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-attach-v2-llmtxt-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('put + get roundtrip succeeds via llmtxt path', async () => {
    const { createAttachmentStoreV2 } = await import('../attachment-store-v2.js');
    const store = createAttachmentStoreV2(tempDir);

    const original = new TextEncoder().encode('Hello, v2 attachments!');
    const putResult = await store.put('T100', {
      name: 'greeting.txt',
      data: original,
      contentType: 'text/plain',
    });

    expect(putResult.backend).toBe('llmtxt');
    expect(putResult.attachmentId).toBeTruthy();
    expect(putResult.sha256).toMatch(/^[0-9a-f]{64}$/);

    const fetched = await store.get(putResult.attachmentId);
    expect(fetched).not.toBeNull();
    expect(new Uint8Array(fetched!.data)).toEqual(original);
    expect(fetched?.name).toBe('greeting.txt');
    expect(fetched?.contentType).toBe('text/plain');
  });

  it('backend field in response matches actual path (llmtxt)', async () => {
    const { createAttachmentStoreV2 } = await import('../attachment-store-v2.js');
    const store = createAttachmentStoreV2(tempDir);
    const result = await store.put('T101', {
      name: 'report.md',
      data: new TextEncoder().encode('# Report'),
      contentType: 'text/markdown',
    });
    expect(result.backend).toBe('llmtxt');
  });

  it('list returns all attachments for a task (llmtxt path)', async () => {
    const { createAttachmentStoreV2 } = await import('../attachment-store-v2.js');
    const store = createAttachmentStoreV2(tempDir);

    await store.put('T102', { name: 'a.txt', data: new TextEncoder().encode('alpha') });
    await store.put('T102', { name: 'b.txt', data: new TextEncoder().encode('bravo') });
    await store.put('T102', { name: 'c.txt', data: new TextEncoder().encode('charlie') });

    const entries = await store.list('T102');
    expect(entries).toHaveLength(3);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['a.txt', 'b.txt', 'c.txt']);
    for (const e of entries) {
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.attachmentId).toHaveLength(21); // nanoid
    }
  });

  it('remove soft-deletes the attachment (llmtxt LWW)', async () => {
    const { createAttachmentStoreV2 } = await import('../attachment-store-v2.js');
    const store = createAttachmentStoreV2(tempDir);

    const putResult = await store.put('T103', {
      name: 'ephemeral.txt',
      data: new TextEncoder().encode('transient'),
    });
    expect(await store.list('T103')).toHaveLength(1);

    await store.remove(putResult.attachmentId);
    expect(await store.list('T103')).toHaveLength(0);
  });

  it('content-addressed: two tasks can reference the same bytes', async () => {
    const { createAttachmentStoreV2 } = await import('../attachment-store-v2.js');
    const store = createAttachmentStoreV2(tempDir);

    const payload = new TextEncoder().encode('shared content');
    const a = await store.put('T104', { name: 'shared.txt', data: payload });
    const b = await store.put('T105', { name: 'shared.txt', data: payload });

    expect(a.sha256).toBe(b.sha256);
    expect(a.attachmentId).not.toBe(b.attachmentId);
    // Each task sees its own entry
    expect(await store.list('T104')).toHaveLength(1);
    expect(await store.list('T105')).toHaveLength(1);
  });

  it('put returns 64-char hex sha256 consistent with bytes', async () => {
    const { createAttachmentStoreV2 } = await import('../attachment-store-v2.js');
    const { CleoBlobStore } = await import('../llmtxt-blob-adapter.js');
    const store = createAttachmentStoreV2(tempDir);
    const data = new TextEncoder().encode('hash-check-bytes');
    const expected = CleoBlobStore.hash(data);
    const result = await store.put('T106', { name: 'hash.txt', data });
    expect(result.sha256).toBe(expected);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Legacy fallback — works regardless of peer deps
// ──────────────────────────────────────────────────────────────────────────

describe('createAttachmentStoreV2 (legacy backend, forced)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-attach-v2-legacy-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  });

  afterEach(async () => {
    const { closeDb } = await import('../sqlite.js');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('put + get roundtrip succeeds via legacy fallback', async () => {
    const { createAttachmentStoreV2 } = await import('../attachment-store-v2.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStoreV2(tempDir, { backend: 'legacy' });

    const original = new TextEncoder().encode('legacy fallback payload');
    const putResult = await store.put('T200', {
      name: 'legacy.txt',
      data: original,
      contentType: 'text/plain',
    });

    expect(putResult.backend).toBe('legacy');
    expect(putResult.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(putResult.attachmentId).toBeTruthy();

    const fetched = await store.get(putResult.attachmentId);
    expect(fetched).not.toBeNull();
    expect(Buffer.from(fetched!.data).toString('utf-8')).toBe('legacy fallback payload');
    expect(fetched?.contentType).toBe('text/plain');
  });

  it('backend field in response matches actual path (legacy)', async () => {
    const { createAttachmentStoreV2 } = await import('../attachment-store-v2.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStoreV2(tempDir, { backend: 'legacy' });
    const result = await store.put('T201', {
      name: 'legacy-tag.txt',
      data: new TextEncoder().encode('tag'),
    });
    expect(result.backend).toBe('legacy');
  });

  it('list returns attachments for a task via legacy path', async () => {
    const { createAttachmentStoreV2 } = await import('../attachment-store-v2.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStoreV2(tempDir, { backend: 'legacy' });

    await store.put('T202', { name: 'a.txt', data: new TextEncoder().encode('a') });
    await store.put('T202', { name: 'b.txt', data: new TextEncoder().encode('b') });

    const entries = await store.list('T202');
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.attachmentId).toBeTruthy();
    }
  });

  it('two tasks with identical bytes share one row — remove(id, taskId) decrements refcount', async () => {
    const { createAttachmentStoreV2 } = await import('../attachment-store-v2.js');
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStoreV2(tempDir, { backend: 'legacy' });
    const legacy = createAttachmentStore();

    // Attach identical bytes to two tasks.
    const payload = new TextEncoder().encode('shared-legacy-bytes');
    const a = await store.put('T300', { name: 'shared.txt', data: payload });
    const b = await store.put('T301', { name: 'shared.txt', data: payload });

    // Same content → same attachment row → same id.
    expect(a.sha256).toBe(b.sha256);
    expect(a.attachmentId).toBe(b.attachmentId);

    // Refcount == 2 after two puts.
    const metaBefore = await legacy.getMetadata(a.attachmentId);
    expect(metaBefore?.refCount).toBe(2);

    // Remove from T300 only — refcount drops to 1, row survives.
    await store.remove(a.attachmentId, 'T300');
    const metaAfter = await legacy.getMetadata(a.attachmentId);
    expect(metaAfter?.refCount).toBe(1);

    // Remove from T301 — refcount hits 0, row purged.
    await store.remove(a.attachmentId, 'T301');
    const metaGone = await legacy.getMetadata(a.attachmentId);
    expect(metaGone).toBeNull();
  });

  it('get returns null for unknown attachment id via legacy', async () => {
    const { createAttachmentStoreV2 } = await import('../attachment-store-v2.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStoreV2(tempDir, { backend: 'legacy' });
    const result = await store.get('no-such-attachment-id');
    expect(result).toBeNull();
  });

  it('remove with unknown id is a no-op (legacy)', async () => {
    const { createAttachmentStoreV2 } = await import('../attachment-store-v2.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStoreV2(tempDir, { backend: 'legacy' });
    await expect(store.remove('unknown-id', 'T999')).resolves.toBeUndefined();
  });
});
