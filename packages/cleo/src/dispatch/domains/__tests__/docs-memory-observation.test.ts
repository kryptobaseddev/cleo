/**
 * Tests for T9976 — auto-emit memory observation on `cleo docs add`.
 *
 * Covers:
 *   - AC1/AC2: retired by T13985 (owner decision D11180): `cleo docs add`
 *          records the link as an `llmtxt --documents--> owner` edge and no
 *          longer writes a "Doc attached" observation.
 *   - AC3: `cleo memory verify <id>` round-trips a legacy doc-attachment
 *          observation and warns on a missing attachment.
 *   - AC4: `cleo memory backfill-docs` sweeps existing attachments; since
 *          T13985 it writes the missing `llmtxt --documents--> owner` edges.
 *
 * Strategy: real tasks.db + real brain.db via temp CLEO_DIR so FTS search
 * and brain writes exercise the actual storage layer without CLI overhead.
 * Each test suite gets an isolated temp directory.
 *
 * Note on memory.find search path: `searchBrainCompact` uses an RRF
 * fusion path by default that requires both FTS and vector hits. In fresh
 * temp databases (no vector index), the RRF path may return zero results
 * even when FTS finds the entry. AC2 is therefore verified directly against
 * the brain SQLite database for reliability, mirroring how the CLI
 * `cleo memory find` works when using `--table observations`.
 *
 * @task T9976
 * @epic T9964
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocAttachmentObservationPayload } from '@cleocode/contracts';
import type { DocsAddResult } from '@cleocode/contracts/operations/docs';
import {
  _resetBrainWriterForTests,
  shutdownBrainWriter,
} from '@cleocode/core/memory/brain-writer-thread';
import { awaitBackgroundOps, pendingBackgroundOpCount } from '@cleocode/core/store/background-ops';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocsHandler } from '../docs.js';
import { MemoryHandler } from '../memory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Search brain_observations directly via SQLite for doc-attachment entries.
 *
 * Uses LIKE on `title` and `narrative` to reliably find the entry in fresh
 * test databases where FTS/vector indexes are not yet built.
 */
async function findDocObservationBySlug(
  slug: string,
): Promise<{ id: string; narrative: string | null } | undefined> {
  const { getBrainDb, getBrainNativeDb } = await import('@cleocode/core/internal');
  await getBrainDb();
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return undefined;
  const likePattern = `%${slug}%`;
  const row = nativeDb
    .prepare(
      `SELECT id, narrative FROM brain_observations
       WHERE (title LIKE ? OR narrative LIKE ?)
         AND invalid_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(likePattern, likePattern) as { id: string; narrative: string | null } | undefined;
  return row;
}

/** Seed a legacy (pre-T13985) Doc attached observation for `memory verify` round-trips. */
async function seedLegacyDocObservation(
  attachmentId: string,
  slug: string,
): Promise<{ id: string }> {
  const { getBrainAccessor } = await import('@cleocode/core/internal');
  const payload: DocAttachmentObservationPayload = {
    kind: 'doc-attachment',
    attachmentId,
    ownerId: 'T9976',
    addedAt: new Date().toISOString(),
    slug,
  };
  const id = `O-doc-legacy-${slug}`;
  await (await getBrainAccessor(tempDir)).addObservation({
    id,
    type: 'feature',
    title: `Doc attached: ${slug}`,
    narrative: JSON.stringify(payload),
    sourceType: 'agent',
  });
  return { id };
}

/** `llmtxt --documents--> owner` edges pointing at an owner node (T13985). */
async function documentsEdgesFor(ownerNodeId: string): Promise<Array<{ from_id: string }>> {
  const { getBrainDb, getBrainNativeDb } = await import('@cleocode/core/internal');
  await getBrainDb();
  const db = getBrainNativeDb();
  if (!db) return [];
  return db
    .prepare("SELECT from_id FROM brain_page_edges WHERE to_id = ? AND edge_type = 'documents'")
    .all(ownerNodeId) as Array<{ from_id: string }>;
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let tempDir: string;
let fixtureFile: string;
const docsHandler = new DocsHandler();
const memoryHandler = new MemoryHandler();

beforeEach(async () => {
  // T12090: `realpath` is load-bearing on macOS. `os.tmpdir()` there is
  // `/var/folders/...`, which is a SYMLINK to `/private/var/folders/...`. Code
  // under test that resolves a real path (SQLite open, project-root walk) lands
  // on the `/private/...` spelling, so the write and the read end up in two
  // different `.cleo` directories: `memory.find` legitimately finds nothing, and
  // the `rm` of the symlinked path leaves the real one behind as ENOTEMPTY.
  // Both macOS-only symptoms are this one cause. Linux tmpdir is not symlinked,
  // which is why it never reproduced there.
  tempDir = await realpath(await mkdtemp(join(tmpdir(), 'cleo-docs-mem-')));
  vi.stubEnv('CLEO_ROOT', tempDir);
  vi.stubEnv('CLEO_DIR', join(tempDir, '.cleo'));
  vi.stubEnv('CLEO_BRAIN_BYPASS_WRITER_THREAD', '1');
  await mkdir(join(tempDir, '.cleo'));
  await writeFile(
    join(tempDir, '.cleo/project-info.json'),
    JSON.stringify({ projectId: 'observation-fixture', projectRoot: tempDir }),
  );

  fixtureFile = join(tempDir, 'spec.md');
  await writeFile(fixtureFile, '# Spec\n\nT9976 doc-attachment observation test', 'utf-8');
});

afterEach(async () => {
  await awaitBackgroundOps();
  await shutdownBrainWriter();
  _resetBrainWriterForTests();
  const { closeAllDatabases } = await import('@cleocode/core/internal');
  await closeAllDatabases();
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1 + AC2 — retired by T13985 (D11180): docs.add writes a documents edge
// ---------------------------------------------------------------------------

describe('T9976/T13985 — docs.add records the documents link', () => {
  it('docs.add records a documents edge and no Doc attached observation (T13985)', async () => {
    const slug = 'my-spec';

    const addResp = await docsHandler.mutate('add', {
      ownerId: 'T9976',
      file: fixtureFile,
      slug,
      type: 'spec',
      attachedBy: 'test',
    });
    expect(addResp.success, `docs.add failed: ${JSON.stringify(addResp.error)}`).toBe(true);
    const projection = (addResp.data as DocsAddResult).projection;
    expect(projection, JSON.stringify(addResp.data)).toMatchObject({ status: 'completed' });
    expect(projection?.receipt).toMatchObject({ documents: true });

    // D11180 retired T9976 AC1: the link is the edge, not an observation.
    expect(await findDocObservationBySlug(slug)).toBeUndefined();
    const edges = await documentsEdgesFor('task:T9976');
    expect(edges).toHaveLength(1);
    expect(edges[0]?.from_id).toMatch(/^llmtxt:[a-f0-9]{64}$/);
  });

  it('drains actual memory.find retrieval writes before fixture teardown', async () => {
    const retrieval = await import('@cleocode/core/memory/retrieval/log-retrieval');
    const original = retrieval.logRetrieval;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const spy = vi.spyOn(retrieval, 'logRetrieval').mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      try {
        await original(...args);
      } finally {
        finished.resolve();
      }
    });
    const slug = 'retrieval-lifetime';
    let drain: Promise<void> | undefined;
    try {
      // A real observation: doc-attachment rows are excluded from recall (T13946).
      const { getBrainAccessor } = await import('@cleocode/core/internal');
      await (await getBrainAccessor(tempDir)).addObservation({
        id: 'O-t12283',
        type: 'discovery',
        title: `Retrieval lifetime ${slug}`,
        narrative: `memory find drains its retrieval log write ${slug}`,
        sourceType: 'agent',
      });
      await awaitBackgroundOps();
      const found = await memoryHandler.query('find', { query: slug, tables: ['observations'] });
      expect(found.success).toBe(true);
      await entered.promise;
      expect(pendingBackgroundOpCount()).toBeGreaterThan(0);
      let drained = false;
      drain = awaitBackgroundOps().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      release.resolve();
      await drain;
      expect(pendingBackgroundOpCount()).toBe(0);
      const { getBrainNativeDb } = await import('@cleocode/core/internal');
      expect(
        getBrainNativeDb(tempDir)
          ?.prepare('SELECT query FROM brain_retrieval_log WHERE query = ?')
          .get(slug),
      ).toMatchObject({ query: slug });
    } finally {
      release.resolve();
      if (spy.mock.calls.length > 0) await finished.promise;
      await drain;
      spy.mockRestore();
    }
  });

  it('writes no Doc attached observation for URL attachments (T13985)', async () => {
    const slug = 'url-slug';

    const addResp = await docsHandler.mutate('add', {
      ownerId: 'T9976',
      url: 'https://example.com/t9976-url-fixture',
      slug,
      attachedBy: 'test',
    });
    expect(addResp.success, `docs.add URL failed: ${JSON.stringify(addResp.error)}`).toBe(true);
    expect((addResp.data as DocsAddResult).projection, JSON.stringify(addResp.data)).toMatchObject({
      status: 'completed',
    });
    expect(await findDocObservationBySlug(slug)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC3 — memory.verify round-trips against docs store
// ---------------------------------------------------------------------------

describe('T9976 — memory.verify round-trips against docs store (AC3)', () => {
  it('verify on a doc-attachment observation sets attachmentMissing=false when attachment exists', async () => {
    const slug = 'verify-present-test';

    const addResp = await docsHandler.mutate('add', {
      ownerId: 'T9976',
      file: fixtureFile,
      slug,
      attachedBy: 'test',
    });
    expect(addResp.success).toBe(true);
    expect((addResp.data as DocsAddResult).projection, JSON.stringify(addResp.data)).toMatchObject({
      status: 'completed',
    });

    // Since T13985 docs add writes no observation; verify keeps its round-trip
    // for the legacy Doc attached rows still in stores, so seed one.
    const foundRow = await seedLegacyDocObservation(
      (addResp.data as DocsAddResult).attachmentId,
      slug,
    );

    const verifyResp = await memoryHandler.mutate('verify', { id: foundRow.id });
    expect(verifyResp.success).toBe(true);
    const verifyData = verifyResp.data as {
      id: string;
      verified: boolean;
      attachmentMissing?: boolean;
      warning?: string;
    };
    expect(verifyData.verified).toBe(true);
    // Attachment exists — attachmentMissing should be false (not true)
    expect(verifyData.attachmentMissing).not.toBe(true);
    expect(verifyData.warning).toBeUndefined();
  });

  it('verify warns when attachment has been removed', async () => {
    const slug = 'verify-missing-test';

    const addResp = await docsHandler.mutate('add', {
      ownerId: 'T9976',
      file: fixtureFile,
      slug,
      attachedBy: 'test',
    });
    expect(addResp.success).toBe(true);
    expect((addResp.data as DocsAddResult).projection, JSON.stringify(addResp.data)).toMatchObject({
      status: 'completed',
    });
    const addData = addResp.data as DocsAddResult;
    const foundRow = await seedLegacyDocObservation(addData.attachmentId, slug);

    // Remove the attachment so the next verify finds it missing
    const removeResp = await docsHandler.mutate('remove', {
      attachmentRef: addData.attachmentId,
      from: 'T9976',
    });
    expect(removeResp.success).toBe(true);

    // Verify should now warn that the attachment is missing
    const verifyResp = await memoryHandler.mutate('verify', { id: foundRow.id });
    expect(verifyResp.success).toBe(true);
    const verifyData = verifyResp.data as {
      verified: boolean;
      attachmentMissing?: boolean;
      attachmentId?: string;
      warning?: string;
    };
    expect(verifyData.verified).toBe(true);
    expect(verifyData.attachmentMissing).toBe(true);
    expect(verifyData.warning).toBeDefined();
    expect(verifyData.warning).toContain(addData.attachmentId);
  });
});

// ---------------------------------------------------------------------------
// AC4 — memory.backfill-docs sweeps existing attachments
// ---------------------------------------------------------------------------

describe('T9976 — memory.backfill-docs sweeps existing attachments (AC4)', () => {
  it('backfill-docs writes missing documents edges and is idempotent (T13985)', async () => {
    const addA = await docsHandler.mutate('add', {
      ownerId: 'T9976',
      file: fixtureFile,
      attachedBy: 'test',
    });
    expect(addA.success).toBe(true);
    const added = addA.data as DocsAddResult;
    expect(added.projection, JSON.stringify(added)).toMatchObject({ status: 'completed' });

    // docs add already wrote the canonical edge, so the first backfill writes nothing.
    const first = await memoryHandler.mutate('backfill-docs', {});
    expect(first.success, `backfill-docs failed: ${JSON.stringify(first.error)}`).toBe(true);
    const firstData = first.data as { total: number; written: number; skipped: number };
    expect(firstData.total).toBeGreaterThanOrEqual(1);
    expect(firstData.written).toBe(0);
    expect(firstData.skipped).toBe(firstData.total);

    // An attachment that lost (or predates) its edge gets it back, once.
    const { getBrainNativeDb } = await import('@cleocode/core/internal');
    const db = getBrainNativeDb(tempDir)!;
    expect(await documentsEdgesFor('task:T9976')).toHaveLength(1);
    db.prepare("DELETE FROM brain_page_edges WHERE edge_type = 'documents'").run();
    const second = await memoryHandler.mutate('backfill-docs', {});
    expect((second.data as { written: number; writtenAttachmentIds: string[] }).written).toBe(1);
    expect(await documentsEdgesFor('task:T9976')).toHaveLength(1);
    const third = await memoryHandler.mutate('backfill-docs', {});
    expect((third.data as { written: number }).written).toBe(0);
  });

  it('docs add writes the documents edge even with brain.autoCapture off (T13985)', async () => {
    await writeFile(
      join(tempDir, '.cleo/config.json'),
      JSON.stringify({ brain: { autoCapture: false } }),
    );
    const added = await docsHandler.mutate('add', {
      ownerId: 'T9976',
      file: fixtureFile,
      slug: 'autocapture-off',
      attachedBy: 'test',
    });
    expect(added.success).toBe(true);
    expect((added.data as DocsAddResult).projection).toMatchObject({ status: 'completed' });
    expect(await documentsEdgesFor('task:T9976')).toHaveLength(1);
  });
});
