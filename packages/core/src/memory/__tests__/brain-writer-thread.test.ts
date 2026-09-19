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
import { createHash } from 'node:crypto';
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

describe('scoped source worker execution (T12265)', () => {
  it.each([
    'current',
    'manager',
    'cancel-after-commit',
    'cancelled',
    'stale-owner',
    'malformed',
  ] as const)('reports %s through the actual worker without writing another project', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'cleo-scoped-writer-'));
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
      JSON.stringify({
        name: '@cleocode/core',
        type: 'module',
        exports: './dist/index.js',
      }),
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
    const { getDb, closeAllDatabases } = await import('../../store/sqlite.js');
    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const { DurableJobStore } = await import('../../store/background-jobs.js');
    const { createOperationExecutionContext, bindOperationWriteFence, transferOperationContext } =
      await import('../../store/background-ops.js');
    const db = await worktreeScope.run({ worktreeRoot: project }, () => getDb(project));
    await worktreeScope.run({ worktreeRoot: project }, () => getBrainDb(project));
    const native = worktreeScope.run({ worktreeRoot: project }, () => getBrainNativeDb(project))!;
    const jobs = new DurableJobStore(db, { projectId: 'A', actor: 'fixture' });
    const proposalJson = JSON.stringify({ document: 'source 😀', project: 'A' });
    const job = jobs.defer('worker-proof', 'docs.projection', Date.now(), {
      projectId: 'A',
      idempotencyKey: mode,
      proposalJson,
    });
    const original = createOperationExecutionContext(
      {
        projectId: 'A',
        projectRoot: project,
        actor: 'fixture',
        operation: 'docs.projection',
        idempotencyKey: mode,
      },
      { budgetMs: 15000 },
    );
    const execution = bindOperationWriteFence(original, {
      dbPath: join(project, '.cleo/cleo.db'),
      proposalHash: createHash('sha256').update(proposalJson).digest('hex'),
      lease: jobs.claim(job.id, Date.now()),
    });
    const link = transferOperationContext(execution, { items: 1 });
    if (mode === 'cancelled') original.close();
    if (mode === 'stale-owner') {
      native.prepare('UPDATE main.background_jobs SET lease_expires_at=0 WHERE id=?').run(job.id);
      new DurableJobStore(db, { projectId: 'A' }).claim(job.id, Date.now());
    }
    const committed = mode === 'current' || mode === 'manager' || mode === 'cancel-after-commit';
    const latch = new SharedArrayBuffer(4);
    const wrapper = join(artifact, 'dist/worker-wrapper.js');
    await writeFile(
      wrapper,
      `
        import { parentPort, workerData } from 'node:worker_threads';
        const post = parentPort.postMessage.bind(parentPort);
        parentPort.postMessage = (message) => {
          if (message.ok && workerData.pause) {
            post({ committed: true });
            Atomics.wait(new Int32Array(workerData.latch), 0, 0, 5000);
          }
          post(message);
        };
        await import('./brain-writer-worker.js');
      `,
    );
    const worker =
      mode === 'manager'
        ? undefined
        : new Worker(wrapper, {
            resourceLimits: { maxOldGenerationSizeMb: 256 },
            workerData: { pause: mode === 'cancel-after-commit', latch },
            env: { ...process.env, CLEO_ROOT: other, CLEO_DIR: join(other, '.cleo') },
          });
    let manager: typeof import('../brain-writer-thread.js') | undefined;
    try {
      const envelope = {
        seq: 1,
        execution: mode === 'malformed' ? { ...link.transfer, deadlineAt: NaN } : link.transfer,
        op: {
          kind: 'observe' as const,
          projectRoot: project,
          params: {
            text: 'Canonical worker payload 😀',
            title: 'Scoped writer',
            sourceType: 'agent' as const,
            agent: 'fixture',
            _skipGate: true,
          },
        },
      };
      let response: import('../brain-writer-thread.js').WriterResponseEnvelope;
      if (worker) {
        const reply = once(worker, 'message', { signal: AbortSignal.timeout(10000) });
        worker.postMessage(envelope);
        if (mode === 'cancel-after-commit') {
          expect((await reply)[0]).toEqual({ committed: true });
          const final = once(worker, 'message', { signal: AbortSignal.timeout(10000) });
          original.close();
          Atomics.store(new Int32Array(latch), 0, 1);
          Atomics.notify(new Int32Array(latch), 0);
          [response] = await final;
        } else [response] = await reply;
      } else {
        manager = await import(
          /* @vite-ignore */ pathToFileURL(join(artifact, 'dist/brain-writer-thread.js')).href
        );
        const result = await manager!.enqueueBrainWrite(envelope.op, execution);
        response = { seq: 1, ok: true, result };
      }
      expect(response.seq).toBe(1);
      expect(response.ok).toBe(committed);
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
      if (response.ok) {
        expect(rows).toEqual([
          { title: 'Scoped writer', narrative: 'Canonical worker payload 😀' },
        ]);
        expect(response.result.kind).toBe('observe');
        if (response.result.kind === 'observe') expect(response.result.result.id).toMatch(/^O-/);
      } else {
        expect(rows).toEqual([]);
        expect(response.error).toBeTruthy();
      }
      expect(existsSync(join(other, '.cleo'))).toBe(false);
    } finally {
      await worker?.terminate();
      await manager?.shutdownBrainWriter();
      link.release();
      original.close();
      await closeAllDatabases();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
