/**
 * Tests for T10351 — brain writer-thread chokepoint.
 *
 * Validates that concurrent `enqueueBrainWrite` calls serialize correctly
 * and that the resulting `brain.db` passes `PRAGMA integrity_check`. The
 * inline-fallback path is used (no worker file at test time) — that path
 * uses the same `inlineQueueTail` async mutex the bypass path uses, so it
 * exercises the public contract.
 *
 * @task T10351
 * @epic T10286
 * @saga T10281
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;
let cleoDir: string;

describe('enqueueBrainWrite — concurrent writes', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-brain-writer-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;

    // Initialize tasks.db (required by cross-db write-guard) and a session row.
    const { getDb } = await import('../../store/sqlite.js');
    const { sessions } = await import('../../store/tasks-schema.js');
    const db = await getDb(tempDir);
    await db
      .insert(sessions)
      .values({ id: 'S-writer-test', name: 'writer-test', status: 'active' })
      .onConflictDoNothing()
      .run();
  });

  afterEach(async () => {
    try {
      const { shutdownBrainWriter, _resetBrainWriterForTests } = await import(
        '../brain-writer-thread.js'
      );
      await shutdownBrainWriter();
      _resetBrainWriterForTests();
    } catch {
      /* may not be loaded */
    }
    try {
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
    } catch {
      /* may not be loaded */
    }
    try {
      const { closeDb } = await import('../../store/sqlite.js');
      closeDb();
    } catch {
      /* may not be loaded */
    }
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_BRAIN_BYPASS_WRITER_THREAD'];
    await Promise.race([
      rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
  });

  it('serializes 20 parallel observe ops and leaves brain.db integrity intact', async () => {
    const { enqueueBrainWrite } = await import('../brain-writer-thread.js');

    // Fan out 20 concurrent observe ops.
    const ops = Array.from({ length: 20 }, (_unused, i) =>
      enqueueBrainWrite({
        kind: 'observe',
        projectRoot: tempDir,
        params: {
          text: `concurrent-observe-${i} ${'x'.repeat(64)}`,
          title: `obs-${i}`,
          sourceType: 'manual',
        },
      }),
    );

    const results = await Promise.all(ops);

    // Each op resolves with kind:'observe' + a result.
    for (const r of results) {
      expect(r.kind).toBe('observe');
      if (r.kind === 'observe') {
        expect(typeof r.result.id).toBe('string');
      }
    }

    // PRAGMA integrity_check must report 'ok' — the chokepoint's whole point.
    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    await getBrainDb(tempDir);
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).not.toBeNull();
    if (!nativeDb) return;
    const row = nativeDb.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | undefined;
    expect(row?.integrity_check).toBe('ok');
  }, 30_000);

  it('honors CLEO_BRAIN_BYPASS_WRITER_THREAD env var (inline path still serializes)', async () => {
    process.env['CLEO_BRAIN_BYPASS_WRITER_THREAD'] = '1';
    const { enqueueBrainWrite } = await import('../brain-writer-thread.js');

    const ops = Array.from({ length: 5 }, (_unused, i) =>
      enqueueBrainWrite({
        kind: 'observe',
        projectRoot: tempDir,
        params: {
          text: `bypass-observe-${i}`,
          title: `obs-bypass-${i}`,
          sourceType: 'manual',
        },
      }),
    );
    const results = await Promise.all(ops);
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.kind === 'observe')).toBe(true);
  }, 30_000);
});
