/**
 * Unit tests for the llmtxt attachment mirror (T947 Wave C — legacy fallback retired).
 *
 * Tests the llmtxt-backed path exclusively. The legacy fallback path was
 * retired in T11141 (Wave C). Tests that need `node:sqlite` +
 * `drizzle-orm/node-sqlite` + `llmtxt/blob` are gated via a runtime probe.
 *
 * Each test uses an isolated temp directory so the underlying SQLite
 * databases are fresh per run.
 *
 * @epic T947
 * @task T11141 (Wave C)
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

// ──────────────────────────────────────────────────────────────────────────
// Backend probe
// ──────────────────────────────────────────────────────────────────────────

describe('resolveAttachmentBackend', () => {
  it('always returns "llmtxt" (Wave C — legacy fallback retired)', async () => {
    const { resolveAttachmentBackend } = await import('../attachment-store.js');
    const backend = await resolveAttachmentBackend();
    expect(backend).toBe('llmtxt');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// llmtxt-backed path — requires peer deps
// ──────────────────────────────────────────────────────────────────────────

describe.skipIf(!(await hasLlmtxtPeerDeps()))(
  'createAttachmentBlobStore (llmtxt backend - node:sqlite)',
  () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'cleo-attach-llmtxt-'));
    });

    afterEach(async () => {
      // maxRetries: Windows WAL sidecar files (.db-shm/.db-wal) stay locked
      // briefly after close(). 5 retries × 500 ms = 2.5 s max wait.
      await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    });

    it('put + get roundtrip succeeds via llmtxt path', async () => {
      const { createAttachmentBlobStore } = await import('../attachment-store.js');
      const store = createAttachmentBlobStore(tempDir);

      const original = new TextEncoder().encode('Hello, llmtxt attachments!');
      const putResult = await store.put('T100', {
        name: 'greeting.txt',
        data: original,
        contentType: 'text/plain',
      });

      expect(putResult.backend).toBe('llmtxt');
      expect(putResult.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(putResult.attachmentId).toBeTruthy();

      const fetched = await store.get(putResult.attachmentId);
      expect(fetched).not.toBeNull();
      expect(Buffer.from(fetched!.data).toString('utf-8')).toBe('Hello, llmtxt attachments!');
      expect(fetched?.contentType).toBe('text/plain');
      expect(fetched?.name).toBe('greeting.txt');
    });

    it('put + get roundtrip with binary data', async () => {
      const { createAttachmentBlobStore } = await import('../attachment-store.js');
      const store = createAttachmentBlobStore(tempDir);

      const original = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
      const putResult = await store.put('T101', {
        name: 'binary.bin',
        data: original,
        contentType: 'application/octet-stream',
      });

      expect(putResult.backend).toBe('llmtxt');

      const fetched = await store.get(putResult.attachmentId);
      expect(fetched).not.toBeNull();
      expect(Array.from(fetched!.data)).toEqual(Array.from(original));
      expect(fetched?.contentType).toBe('application/octet-stream');
    });

    it('list returns attachments for a task', async () => {
      const { createAttachmentBlobStore } = await import('../attachment-store.js');
      const store = createAttachmentBlobStore(tempDir);

      await store.put('T102', { name: 'a.txt', data: new TextEncoder().encode('a') });
      await store.put('T102', { name: 'b.txt', data: new TextEncoder().encode('b') });

      const entries = await store.list('T102');
      expect(entries).toHaveLength(2);
      for (const e of entries) {
        expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(e.attachmentId).toBeTruthy();
      }
    });

    it('list returns empty array for task with no attachments', async () => {
      const { createAttachmentBlobStore } = await import('../attachment-store.js');
      const store = createAttachmentBlobStore(tempDir);

      const entries = await store.list('T999');
      expect(entries).toEqual([]);
    });

    it('get returns null for unknown attachment id', async () => {
      const { createAttachmentBlobStore } = await import('../attachment-store.js');
      const store = createAttachmentBlobStore(tempDir);

      const result = await store.get('no-such-attachment-id');
      expect(result).toBeNull();
    });

    it('remove with unknown id is a no-op', async () => {
      const { createAttachmentBlobStore } = await import('../attachment-store.js');
      const store = createAttachmentBlobStore(tempDir);

      await expect(store.remove('unknown-id', 'T999')).resolves.toBeUndefined();
    });

    it('remove detaches a known attachment', async () => {
      const { createAttachmentBlobStore } = await import('../attachment-store.js');
      const store = createAttachmentBlobStore(tempDir);

      const payload = new TextEncoder().encode('detach-me');
      const { attachmentId } = await store.put('T103', {
        name: 'detach.txt',
        data: payload,
      });

      await store.remove(attachmentId, 'T103');
      const after = await store.get(attachmentId);
      expect(after).toBeNull();
    });

    it('sha256 matches CleoBlobStore.hash', async () => {
      const { createAttachmentBlobStore } = await import('../attachment-store.js');
      const { CleoBlobStore } = await import('../llmtxt-blob-adapter.js');
      const store = createAttachmentBlobStore(tempDir);

      const data = new TextEncoder().encode('hash-verification');
      const expected = CleoBlobStore.hash(data);
      const result = await store.put('T106', { name: 'hash.txt', data });
      expect(result.sha256).toBe(expected);
    });
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Wave C — store throws when llmtxt peer deps are unavailable
// ──────────────────────────────────────────────────────────────────────────

describe.skipIf(await hasLlmtxtPeerDeps())(
  'createAttachmentBlobStore (no llmtxt peer deps — throws)',
  () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'cleo-attach-llmtxt-nodeps-'));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    });

    it('put throws when llmtxt peer deps are unavailable (Wave C — no legacy fallback)', async () => {
      const { createAttachmentBlobStore } = await import('../attachment-store.js');
      const store = createAttachmentBlobStore(tempDir);

      await expect(
        store.put('T400', {
          name: 'test.txt',
          data: new TextEncoder().encode('payload'),
        }),
      ).rejects.toThrow(/llmtxt backend unavailable/);
    });
  },
);

// ──────────────────────────────────────────────────────────────────────────
// T9901 / gh-#98 — cleo docs add does NOT raise E_INTERNAL
//
// The original bug (filed 2026-04-21 against cleo 2026.4.101) was a
// `better-sqlite3` binding failure inside the drizzle template surface.
// T1041 (commit 885a4e5d0, Apr 20 2026) migrated the mirror surface to
// Node 24's built-in `node:sqlite` + `drizzle-orm/node-sqlite`.
//
// These tests assert the regression-locked behaviour on the llmtxt path.
// The legacy fallback was retired in Wave C (T11141).
//
// @bug gh-#98
// @task T9901
// @saga T9862
// ──────────────────────────────────────────────────────────────────────────

describe.skipIf(!hasLlmtxtPeerDeps())(
  'T9901 / gh-#98 — cleo docs add does NOT raise E_INTERNAL',
  () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'cleo-t9901-regression-'));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    });

    it('llmtxt backend put does not throw and returns a populated envelope', async () => {
      const { createAttachmentBlobStore } = await import('../attachment-store.js');

      const store = createAttachmentBlobStore(tempDir);

      // The bug surfaced as a SQLite query-failure thrown synchronously from
      // the drizzle template surface — capture the entire put() invocation
      // and assert no error is thrown AND the response matches the contract.
      const payload = new TextEncoder().encode('# Auth Design\n\nJWT with ES256 signing.\n');
      const result = await store.put('T9901', {
        name: 'auth.md',
        data: payload,
        contentType: 'text/markdown',
      });

      expect(result).toBeDefined();
      expect(result.backend).toBe('llmtxt');
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.attachmentId).toBeTruthy();
      expect(result.attachmentId.length).toBeGreaterThan(0);
    });

    it('llmtxt backend put does not surface a bare-newline SQL error', async () => {
      const { createAttachmentBlobStore } = await import('../attachment-store.js');

      const store = createAttachmentBlobStore(tempDir);

      // The original bug raised `Failed to run the query '\\n'` — a bare
      // newline SQL string. Even if some unrelated error were to leak, this
      // exact message MUST never appear in the llmtxt mirror path on HEAD.
      let caughtError: Error | null = null;
      try {
        await store.put('T9901', {
          name: 'regression.md',
          data: new TextEncoder().encode('regression-anchor'),
        });
      } catch (err) {
        if (!(err instanceof Error)) throw err;
        caughtError = err;
      }
      if (caughtError !== null) {
        expect(caughtError.message).not.toMatch(/Failed to run the query\s*'\n'/);
        expect(caughtError.message).not.toContain("'\\n'");
      }
    });
  },
);
