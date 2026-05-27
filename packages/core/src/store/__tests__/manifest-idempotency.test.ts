/**
 * Manifest DB idempotency contract test.
 *
 * Saga T10281 / Epic T10283 E2-DB-INTEGRITY / Task T10314.
 *
 * `manifest.db` is the blob-attachment manifest SQLite database
 * registered as `role: "manifest"` in
 * `packages/core/src/store/db-inventory.json`. It lives at
 * `<projectRoot>/.cleo/blobs/manifest.db` and is opened indirectly via
 * the canonical chokepoint {@link CleoBlobStore.open}, which wraps
 * llmtxt's `BlobFsAdapter` over a Drizzle handle.
 *
 * This test pins the manifest-DB idempotency invariants:
 *
 *   1. `open()` is idempotent within a single instance — a second call
 *      is a no-op.
 *   2. Opening a fresh store against the same `projectRoot` after
 *      `close()` finds the existing `manifest.db` AND its existing
 *      content-addressed blob bytes without recreating either.
 *   3. Calling `attach(taskId, name, data)` twice with identical bytes
 *      under the same `(taskId, name)` key resolves to the SAME
 *      content-address SHA-256, and the underlying blob bytes do NOT
 *      double-store on disk (BlobFsAdapter dedupes by hash).
 *   4. The manifest survives across opens — `list(taskId)` after
 *      reopen returns the attachment seeded in the first open cycle.
 *
 * Sandboxing: every test runs inside an `mkdtempSync` directory.
 *
 * Cross-link: ADR-013 §9 — `manifest.db` is the third project-tier
 * SQLite database CLEO writes to (alongside tasks.db and brain.db).
 * It joins the four originally-listed runtime files as a git-untracked
 * runtime file; the reopen-after-branch-switch invariant must hold here
 * too.
 *
 * @task T10314
 * @epic T10283
 * @saga T10281
 * @adr ADR-013
 */

import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Probe whether `node:sqlite` + `drizzle-orm/node-sqlite` are resolvable.
 * Both ship with Node 24 and drizzle-orm v1.0.0-beta — this guard
 * mirrors the existing llmtxt-blob-adapter.test.ts skip-if pattern.
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

describe.skipIf(!(await hasNodeSqlite()))('manifest.db idempotency contract (T10314)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-manifest-idempotency-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('open() is idempotent within a single instance', async () => {
    const { CleoBlobStore } = await import('../llmtxt-blob-adapter.js');
    const store = new CleoBlobStore({ projectRoot: tempDir });

    await store.open();
    // Second open() must be a no-op — must not throw, must not
    // re-bootstrap the manifest table.
    await store.open();

    // Smoke probe — store is still usable after the second open.
    const data = new TextEncoder().encode('idempotency probe');
    const first = await store.attach('T999', 'probe.txt', data, 'text/plain');
    expect(first.attachmentId).toBeTruthy();

    await store.close();
  });

  it('identical attach calls dedupe to the same SHA-256 and do not duplicate bytes', async () => {
    const { CleoBlobStore } = await import('../llmtxt-blob-adapter.js');
    const store = new CleoBlobStore({ projectRoot: tempDir });
    await store.open();
    try {
      const data = new TextEncoder().encode('CLEO idempotency contract bytes');

      const first = await store.attach('T314', 'doc.txt', data, 'text/plain');
      const second = await store.attach('T314', 'doc.txt', data, 'text/plain');

      // Same bytes ⇒ same content-address. (Attachment-id is per-row
      // and may differ — LWW semantics — but the hash MUST be stable.)
      expect(second.sha256).toBe(first.sha256);
      expect(second.size).toBe(first.size);
      expect(second.contentType).toBe(first.contentType);

      // BlobFsAdapter stores bytes at `<storagePath>/blobs/<sha>` — a
      // single file regardless of how many manifest rows reference it.
      const blobsDir = join(tempDir, '.cleo', 'blobs', 'blobs');
      expect(existsSync(blobsDir)).toBe(true);
      const blobsOnDisk = readdirSync(blobsDir);
      expect(blobsOnDisk).toHaveLength(1);

      // The active manifest row for (taskId, name) returns the latest
      // attachment.
      const fetched = await store.get('T314', 'doc.txt');
      expect(fetched).not.toBeNull();
      expect(fetched!.hash).toBe(first.sha256);
    } finally {
      await store.close();
    }
  });

  it('manifest.db survives close + reopen against the same projectRoot', async () => {
    const { CleoBlobStore } = await import('../llmtxt-blob-adapter.js');

    // First open cycle — seed an attachment.
    const storeA = new CleoBlobStore({ projectRoot: tempDir });
    await storeA.open();
    const data = new TextEncoder().encode('persistence probe');
    await storeA.attach('T315', 'note.txt', data, 'text/plain');
    await storeA.close();

    // Sanity: manifest.db exists on disk.
    const manifestPath = join(tempDir, '.cleo', 'blobs', 'manifest.db');
    expect(existsSync(manifestPath)).toBe(true);

    // Second open cycle — fresh store instance, same projectRoot.
    const storeB = new CleoBlobStore({ projectRoot: tempDir });
    await storeB.open();
    try {
      // The list() call must return the attachment seeded in cycle A.
      const items = await storeB.list('T315');
      expect(items).toHaveLength(1);
      expect(items[0].blobName).toBe('note.txt');

      // Reissuing the same attach against the same bytes must not
      // duplicate blob bytes on disk.
      await storeB.attach('T315', 'note.txt', data, 'text/plain');

      const blobsDir = join(tempDir, '.cleo', 'blobs', 'blobs');
      const blobsOnDisk = readdirSync(blobsDir);
      expect(blobsOnDisk).toHaveLength(1);
    } finally {
      await storeB.close();
    }
  });
});

// Reference the probe to silence "value assigned but never read" complaints
// from analyzers that don't see vitest's lazy skip-if semantics. The variable
// is set in `beforeAll` for diagnostic clarity.
void peerDepsAvailable;
