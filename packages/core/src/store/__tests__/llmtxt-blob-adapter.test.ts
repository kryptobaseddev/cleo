/**
 * Unit tests for the CLEO blob store backed by `llmtxt/blob.BlobFsAdapter`.
 *
 * Each test uses an isolated temp directory so the underlying SQLite
 * manifest and blob bytes are clean per run. Mirrors the isolation
 * pattern used by `attachment-store.test.ts`.
 *
 * These tests require Node 24's built-in `node:sqlite` (DatabaseSync) and
 * `drizzle-orm/node-sqlite` — both ship with the runtime and drizzle-orm
 * v1.0.0-beta respectively, so no optional peer deps are needed. Smoke
 * coverage is also retained via `src/__tests__/llmtxt-subpath-smoke.test.ts`.
 *
 * @epic T947
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Probe whether `node:sqlite` + `drizzle-orm/node-sqlite` are resolvable.
 * Both ship with Node 24 and drizzle-orm v1.0.0-beta — this guard exists
 * only as a defensive fallback.
 */
async function hasNodeSqlite(): Promise<boolean> {
  try {
    await import('node:sqlite');
    await import('drizzle-orm/node-sqlite');
    return true;
  } catch {
    return false;
  }
}

let peerDepsAvailable = false;
beforeAll(async () => {
  peerDepsAvailable = await hasNodeSqlite();
});

describe.skipIf(!(await hasNodeSqlite()))('CleoBlobStore', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-llmtxt-blob-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('attach stores bytes and returns attachmentId + sha256', async () => {
    const { CleoBlobStore } = await import('../llmtxt-blob-adapter.js');
    const store = new CleoBlobStore({ projectRoot: tempDir });
    await store.open();
    try {
      const data = new TextEncoder().encode('Hello, CLEO blobs!');
      const result = await store.attach('T001', 'greeting.txt', data, 'text/plain');
      expect(result.attachmentId).toBeTruthy();
      expect(result.attachmentId).toHaveLength(21); // nanoid length
      expect(result.sha256).toHaveLength(64);
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.size).toBe(data.byteLength);
      expect(result.contentType).toBe('text/plain');
    } finally {
      await store.close();
    }
  });

  it('get returns data matching the original bytes', async () => {
    const { CleoBlobStore } = await import('../llmtxt-blob-adapter.js');
    const store = new CleoBlobStore({ projectRoot: tempDir });
    await store.open();
    try {
      const original = new TextEncoder().encode('Hello, CLEO blobs!');
      await store.attach('T002', 'greeting.txt', original, 'text/plain');
      const fetched = await store.get('T002', 'greeting.txt');
      expect(fetched).not.toBeNull();
      expect(fetched?.data).toBeDefined();
      expect(new Uint8Array(fetched!.data!)).toEqual(new Uint8Array(original));
      expect(fetched?.contentType).toBe('text/plain');
    } finally {
      await store.close();
    }
  });

  it('list returns all active attachments for a task', async () => {
    const { CleoBlobStore } = await import('../llmtxt-blob-adapter.js');
    const store = new CleoBlobStore({ projectRoot: tempDir });
    await store.open();
    try {
      await store.attach('T003', 'a.txt', new TextEncoder().encode('alpha'));
      await store.attach('T003', 'b.txt', new TextEncoder().encode('bravo'));
      await store.attach('T003', 'c.txt', new TextEncoder().encode('charlie'));
      const list = await store.list('T003');
      expect(list).toHaveLength(3);
      const names = list.map((a) => a.blobName).sort();
      expect(names).toEqual(['a.txt', 'b.txt', 'c.txt']);
    } finally {
      await store.close();
    }
  });

  it('detach removes the attachment from list()', async () => {
    const { CleoBlobStore } = await import('../llmtxt-blob-adapter.js');
    const store = new CleoBlobStore({ projectRoot: tempDir });
    await store.open();
    try {
      await store.attach('T004', 'remove-me.txt', new TextEncoder().encode('bye'));
      expect(await store.list('T004')).toHaveLength(1);
      await store.detach('T004', 'remove-me.txt');
      expect(await store.list('T004')).toHaveLength(0);
      // After soft-delete, get() returns null for the same name
      expect(await store.get('T004', 'remove-me.txt')).toBeNull();
    } finally {
      await store.close();
    }
  });

  it('content-addressed: same bytes under different names share sha256', async () => {
    const { CleoBlobStore } = await import('../llmtxt-blob-adapter.js');
    const store = new CleoBlobStore({ projectRoot: tempDir });
    await store.open();
    try {
      const payload = new TextEncoder().encode('identical bytes');
      const a = await store.attach('T005', 'name-a.txt', payload);
      const b = await store.attach('T005', 'name-b.txt', payload);
      expect(a.sha256).toBe(b.sha256);
      // Both entries exist — same content, different names, same hash
      const list = await store.list('T005');
      expect(list).toHaveLength(2);
      const hashes = new Set(list.map((row) => row.hash));
      expect(hashes.size).toBe(1);
      expect(hashes.has(a.sha256)).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('content-addressed: same (task, name) replaces via LWW', async () => {
    const { CleoBlobStore } = await import('../llmtxt-blob-adapter.js');
    const store = new CleoBlobStore({ projectRoot: tempDir });
    await store.open();
    try {
      await store.attach('T006', 'doc.txt', new TextEncoder().encode('v1'));
      const v2 = await store.attach('T006', 'doc.txt', new TextEncoder().encode('v2'));
      const list = await store.list('T006');
      expect(list).toHaveLength(1);
      expect(list[0]?.hash).toBe(v2.sha256);
      const fetched = await store.get('T006', 'doc.txt');
      expect(new TextDecoder().decode(fetched!.data)).toBe('v2');
    } finally {
      await store.close();
    }
  });

  it('hash() static method returns SHA-256 hex without storage', async () => {
    const { CleoBlobStore } = await import('../llmtxt-blob-adapter.js');
    const data = new TextEncoder().encode('hash-only, no store');
    const h = CleoBlobStore.hash(data);
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Calling hash() should not create any store or file — temp dir is empty
    // at this point (we didn't open a store).
    expect(h).toBe(CleoBlobStore.hash(data)); // stable for same bytes
  });

  it('get() returns null for non-existent (task, name)', async () => {
    const { CleoBlobStore } = await import('../llmtxt-blob-adapter.js');
    const store = new CleoBlobStore({ projectRoot: tempDir });
    await store.open();
    try {
      const result = await store.get('T007', 'never-attached.txt');
      expect(result).toBeNull();
    } finally {
      await store.close();
    }
  });

  it('rejects invalid blob names (BlobNameInvalidError)', async () => {
    const { CleoBlobStore, BlobNameInvalidError } = await import('../llmtxt-blob-adapter.js');
    const store = new CleoBlobStore({ projectRoot: tempDir });
    await store.open();
    try {
      const data = new TextEncoder().encode('x');
      // Path traversal
      await expect(() => store.attach('T008', '../escape.txt', data)).rejects.toThrow(
        BlobNameInvalidError,
      );
      // Path separator
      await expect(() => store.attach('T008', 'sub/dir.txt', data)).rejects.toThrow(
        BlobNameInvalidError,
      );
      // Empty
      await expect(() => store.attach('T008', '', data)).rejects.toThrow(BlobNameInvalidError);
    } finally {
      await store.close();
    }
  });

  it('enforces maxBlobSizeBytes (BlobTooLargeError)', async () => {
    const { CleoBlobStore, BlobTooLargeError } = await import('../llmtxt-blob-adapter.js');
    const store = new CleoBlobStore({
      projectRoot: tempDir,
      maxBlobSizeBytes: 16,
    });
    await store.open();
    try {
      const oversize = new Uint8Array(32); // 32 bytes > 16 limit
      await expect(() =>
        store.attach('T009', 'big.bin', oversize, 'application/octet-stream'),
      ).rejects.toThrow(BlobTooLargeError);
    } finally {
      await store.close();
    }
  });

  it('survives open() called twice (idempotent)', async () => {
    const { CleoBlobStore } = await import('../llmtxt-blob-adapter.js');
    const store = new CleoBlobStore({ projectRoot: tempDir });
    await store.open();
    await store.open(); // second call is a no-op
    try {
      const data = new TextEncoder().encode('idempotent-test');
      const result = await store.attach('T010', 'a.txt', data);
      expect(result.sha256).toHaveLength(64);
    } finally {
      await store.close();
      await store.close(); // second close is also a no-op
    }
  });

  it('reports node:sqlite availability in test environment', () => {
    // This test documents the gate for the suite; if it runs at all,
    // node:sqlite was available.
    expect(peerDepsAvailable).toBe(true);
  });
});
