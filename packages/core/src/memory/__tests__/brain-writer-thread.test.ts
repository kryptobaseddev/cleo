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

import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { buildSync } from 'esbuild';
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
    const nativeDb = getBrainNativeDb(tempDir);
    expect(nativeDb).not.toBeNull();
    if (!nativeDb) return;
    const row = nativeDb.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | undefined;
    expect(row?.integrity_check).toBe('ok');
  }, 30_000);

  it('T10301: concurrent setImmediate writers on the inline default leave brain.db intact', async () => {
    // The T10301 corruption came from writers firing from setImmediate callbacks in
    // one process. Since T13126 a one-shot process writes inline (no worker), so the
    // lease + in-process mutex alone must keep the schema page intact.
    const { enqueueBrainWrite, brainWriterThreadEnabled } = await import(
      '../brain-writer-thread.js'
    );
    expect(brainWriterThreadEnabled()).toBe(false);
    const writes = await new Promise<Promise<unknown>[]>((resolve) => {
      const started: Promise<unknown>[] = [];
      for (let i = 0; i < 20; i++) {
        setImmediate(() => {
          started.push(
            enqueueBrainWrite({
              kind: 'observe',
              projectRoot: tempDir,
              params: {
                text: `immediate-observe-${i} ${'y'.repeat(64)}`,
                title: `imm-${i}`,
                sourceType: 'manual',
              },
            }),
          );
          if (started.length === 20) resolve(started);
        });
      }
    });
    await Promise.all(writes);
    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    await getBrainDb(tempDir);
    const nativeDb = getBrainNativeDb(tempDir);
    expect(nativeDb).not.toBeNull();
    if (!nativeDb) return;
    const row = nativeDb.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | undefined;
    expect(row?.integrity_check).toBe('ok');
    const count = nativeDb
      .prepare("SELECT COUNT(*) AS n FROM brain_observations WHERE title LIKE 'imm-%'")
      .get() as { n: number };
    expect(count.n).toBe(20);
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

describe('worker execution through the bundled writer (T12265, unscoped since T14017)', () => {
  it.each([
    'worker',
    'manager',
  ] as const)('writes an observation through the %s path into the op project only', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'cleo-writer-worker-'));
    const project = join(root, 'A');
    const other = join(root, 'B');
    const artifact = join(root, 'artifact');
    const coreRoot = fileURLToPath(new URL('../../../', import.meta.url));
    await mkdir(join(project, '.cleo'), { recursive: true });
    await mkdir(join(artifact, 'dist'), { recursive: true });
    await symlink(join(coreRoot, 'node_modules'), join(artifact, 'node_modules'));
    await symlink(join(coreRoot, 'migrations'), join(artifact, 'migrations'));
    await writeFile(
      join(artifact, 'package.json'),
      JSON.stringify({ name: '@cleocode/core', type: 'module', exports: './dist/index.js' }),
    );
    buildSync({
      entryPoints: {
        'brain-writer-worker': fileURLToPath(new URL('../brain-writer-worker.ts', import.meta.url)),
        'brain-writer-thread': fileURLToPath(new URL('../brain-writer-thread.ts', import.meta.url)),
      },
      outdir: join(artifact, 'dist'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      logLevel: 'silent',
    });
    const { worktreeScope } = await import('../../paths.js');
    const { generateProjectHash } = await import('../../nexus/hash.js');
    const { closeAllDatabases } = await import('../../store/sqlite.js');
    const { getBrainDb } = await import('../../store/memory-sqlite.js');
    await worktreeScope.run(
      { worktreeRoot: project, projectHash: generateProjectHash(project) },
      () => getBrainDb(project),
    );
    const op = {
      kind: 'observe' as const,
      projectRoot: project,
      params: {
        text: 'Canonical worker payload 😀',
        title: 'Worker writer',
        sourceType: 'agent' as const,
        agent: 'fixture',
        _skipGate: true,
      },
    };
    let worker: Worker | undefined;
    let manager: typeof import('../brain-writer-thread.js') | undefined;
    try {
      let response: import('../brain-writer-thread.js').WriterResponseEnvelope;
      if (mode === 'worker') {
        // The worker's own env points at another project; the op's root must win.
        worker = new Worker(join(artifact, 'dist/brain-writer-worker.js'), {
          resourceLimits: { maxOldGenerationSizeMb: 256 },
          env: { ...process.env, CLEO_ROOT: other, CLEO_DIR: join(other, '.cleo') },
        });
        const reply = once(worker, 'message', { signal: AbortSignal.timeout(10000) });
        worker.postMessage({ seq: 1, op });
        [response] = await reply;
      } else {
        manager = await import(
          /* @vite-ignore */ pathToFileURL(join(artifact, 'dist/brain-writer-thread.js')).href
        );
        // The manager path is the worker path only in an opted-in host (T13126).
        manager!.useBrainWriterThread();
        const result = await manager!.enqueueBrainWrite(op);
        response = { seq: 1, ok: true, result };
      }
      expect(response).toMatchObject({ seq: 1, ok: true });
      const rows = JSON.parse(
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
          import { DatabaseSync } from 'node:sqlite';
          const db = new DatabaseSync(process.argv[1], { readOnly: true });
          process.stdout.write(JSON.stringify(db.prepare('SELECT title, narrative FROM brain_observations').all()));
          db.close();
        `,
            join(project, '.cleo/cleo.db'),
          ],
          { encoding: 'utf8', timeout: 5000 },
        ),
      );
      expect(rows).toEqual([{ title: 'Worker writer', narrative: 'Canonical worker payload 😀' }]);
      if (response.ok && response.result.kind === 'observe')
        expect(response.result.result.id).toMatch(/^O-/);
      expect(existsSync(join(other, '.cleo'))).toBe(false);
    } finally {
      // T14069: drain before terminating, as the manager does. A bare
      // terminate() while the worker loaded the onnxruntime addon for its
      // scheduled embedding aborted this whole fork on CI.
      if (worker) {
        const { drainAndTerminateWriter } = await import('../brain-writer-thread.js');
        await drainAndTerminateWriter(worker);
      }
      await manager?.shutdownBrainWriter();
      await closeAllDatabases();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
