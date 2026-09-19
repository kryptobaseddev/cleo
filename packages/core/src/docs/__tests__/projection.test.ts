/** Real canonical-source and durable-pending proofs for optional docs projection. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationExecutionContext } from '@cleocode/contracts/jobs';
import type { DocsProjectionSource } from '@cleocode/contracts/operations/docs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAttachmentStore } from '../../store/attachment-store.js';
import { createOperationExecutionContext } from '../../store/background-ops.js';
import { closeAllDatabases, closeDb, getNativeDb } from '../../store/sqlite.js';
import {
  prepareDocumentProjection,
  projectDocumentAttachment,
  resumeDocumentProjection,
} from '../projection.js';

let root: string;
let source: DocsProjectionSource;
let context: OperationExecutionContext;
const bytes = Buffer.from('Canonical π | "A | B"\n', 'utf8');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cleo-doc-projection-'));
  await mkdir(join(root, '.cleo'));
  process.env['CLEO_DIR'] = join(root, '.cleo');
  process.env['CLEO_HOME'] = join(root, 'global');
  process.env['CLEO_BRAIN_BYPASS_WRITER_THREAD'] = '1';
  const metadata = await createAttachmentStore().put(
    bytes,
    { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
    'task',
    'T123',
    'fixture',
    root,
    { slug: 'canonical-source', type: 'note' },
  );
  source = {
    attachmentId: metadata.id,
    sha256: metadata.sha256,
    ownerId: 'T123',
    ownerType: 'task',
    label: 'Original',
  };
  context = createOperationExecutionContext(
    {
      projectId: 'fixture-project',
      projectRoot: root,
      actor: 'foreground-test',
      operation: 'docs.projection',
      idempotencyKey: 'same-source',
    },
    { budgetMs: 10000 },
  );
});

afterEach(async () => {
  context.close();
  const { awaitBackgroundOps } = await import('../../store/background-ops.js');
  await awaitBackgroundOps();
  const { shutdownBrainWriter, _resetBrainWriterForTests } = await import(
    '../../memory/brain-writer-thread.js'
  );
  await shutdownBrainWriter();
  _resetBrainWriterForTests();
  await closeAllDatabases();
  delete process.env['CLEO_DIR'];
  delete process.env['CLEO_HOME'];
  delete process.env['CLEO_BRAIN_BYPASS_WRITER_THREAD'];
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/** Read only synthetic persisted state in a separate process. */
function readPending() {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1], {readOnly:true}); process.stdout.write(JSON.stringify(db.prepare('SELECT id,status,proposal_json,proposal_hash,owner_id,attempts,result FROM background_jobs').all())); db.close();",
        join(root, '.cleo', 'cleo.db'),
      ],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
}

describe('prepareDocumentProjection', () => {
  it('persists sourced Unicode payload without scheduling and coalesces an exact retry', async () => {
    const result = await prepareDocumentProjection(context, source);
    expect(result.jobStatus).toBe('pending');
    expect(result.deadlineAt).toBe(context.deadlineAt);
    expect(result.deadlineExceeded).toBe(false);
    const rows = readPending();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.jobId,
      status: 'pending',
      owner_id: null,
      attempts: 0,
    });
    expect(createHash('sha256').update(rows[0].proposal_json).digest('hex')).toBe(
      result.proposalHash,
    );
    expect(rows[0].proposal_hash).toBe(result.proposalHash);
    expect(JSON.parse(rows[0].proposal_json)).toMatchObject({
      version: 1,
      operation: 'docs.projection',
      source,
      identity: { projectId: 'fixture-project', projectRoot: root, actor: 'foreground-test' },
      observation: {
        slug: 'canonical-source',
        type: 'note',
        attachmentId: source.attachmentId,
        ownerId: 'T123',
      },
    });
    expect((await prepareDocumentProjection(context, source)).jobId).toBe(result.jobId);
    expect(readPending()).toHaveLength(1);
    expect((await createAttachmentStore().get(source.sha256, root))?.bytes).toEqual(bytes);
  });

  it('captures input before awaits and pins storage despite mutable CLEO_DIR', async () => {
    const mutable = { ...source };
    const pending = prepareDocumentProjection(context, mutable);
    mutable.label = 'Wrong project';
    process.env['CLEO_DIR'] = join(root, 'other', '.cleo');
    const result = await pending;
    expect(result.projectRoot).toBe(root);
    expect(JSON.parse(readPending()[0].proposal_json).source.label).toBe('Original');
    await expect(access(join(root, 'other'))).rejects.toThrow();
  });

  it('cancels a paused canonical read without later pending writes or directory recreation', async () => {
    const attachmentModule = await import('../../store/attachment-store.js');
    const original = attachmentModule.createAttachmentStore;
    let release = () => {};
    let reached = () => {};
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    vi.spyOn(attachmentModule, 'createAttachmentStore').mockImplementation(() => {
      const store = original();
      return {
        ...store,
        get: async (hash, cwd) => {
          const result = await store.get(hash, cwd);
          reached();
          await paused;
          return result;
        },
      };
    });
    const pending = prepareDocumentProjection(context, source);
    await entered;
    context.close();
    closeDb();
    await rm(join(root, '.cleo'), { recursive: true });
    release();
    await expect(pending).rejects.toThrow();
    await expect(access(join(root, '.cleo'))).rejects.toThrow();
  });

  it('rejects stale hashes and unrelated owners before inserting pending work', async () => {
    await expect(
      prepareDocumentProjection(context, { ...source, sha256: 'f'.repeat(64) }),
    ).rejects.toThrow('canonical evidence');
    await expect(
      prepareDocumentProjection(context, { ...source, ownerId: 'T999' }),
    ).rejects.toThrow('canonical evidence');
    expect(readPending()).toEqual([]);
  });

  it('preserves canonical bytes when pending persistence rolls back', async () => {
    getNativeDb(root)!.exec(
      "CREATE TRIGGER refuse_projection AFTER INSERT ON background_jobs BEGIN SELECT RAISE(ABORT, 'outbox fault'); END",
    );
    await expect(prepareDocumentProjection(context, source)).rejects.toThrow();
    expect(readPending()).toEqual([]);
    expect((await createAttachmentStore().get(source.sha256, root))?.bytes).toEqual(bytes);
  });

  it('refuses cancellation and changed immutable inputs without deleting the original pending record', async () => {
    await prepareDocumentProjection(context, source);
    await expect(
      prepareDocumentProjection(context, { ...source, label: 'Changed' }),
    ).rejects.toThrow();
    expect(readPending()).toHaveLength(1);
    context.close();
    await expect(prepareDocumentProjection(context, source)).rejects.toThrow();
    expect(readPending()).toHaveLength(1);
  });
});

describe('captured document projection execution', () => {
  it('verifies graph and sourced observation before recording completion without changing canonical bytes', async () => {
    const result = await projectDocumentAttachment(context, source);
    expect(result).toMatchObject({
      status: 'completed',
      coverage: 'current',
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.receipt?.observationId).toMatch(/^O-doc-/);
    const pending = readPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('complete');
    expect(JSON.parse(pending[0].result)).toEqual(result.receipt);
    expect(await resumeDocumentProjection(context, result.jobId!)).toEqual(result.receipt);
    expect((await createAttachmentStore().get(source.sha256, root))?.bytes).toEqual(bytes);
  });

  it('preserves accepted bytes and prepared work when final receipt persistence fails, then resumes once', async () => {
    getNativeDb(
      root,
    )!.exec(`CREATE TRIGGER refuse_projection_receipt BEFORE UPDATE ON background_jobs
      WHEN NEW.status='complete' BEGIN SELECT RAISE(ABORT, 'receipt fault'); END`);
    const result = await projectDocumentAttachment(context, source);
    expect(result).toMatchObject({ status: 'failed', coverage: 'failed' });
    expect(result.diagnostics.join(' ')).toContain('receipt fault');
    const pending = readPending();
    expect(pending[0].status).toBe('running');
    expect(pending[0].result).toBeNull();
    const native = getNativeDb(root)!;
    const before = native.prepare('SELECT id,created_at FROM brain_observations').all();
    expect(before).toHaveLength(1);
    native.exec('DROP TRIGGER refuse_projection_receipt');
    native
      .prepare('UPDATE main.background_jobs SET lease_expires_at=0 WHERE id=?')
      .run(result.jobId!);
    const receipt = await resumeDocumentProjection(context, result.jobId!);
    expect(native.prepare('SELECT id,created_at FROM brain_observations').all()).toEqual(before);
    expect(readPending()[0].status).toBe('complete');
    expect(JSON.parse(readPending()[0].result)).toEqual(receipt);
    expect((await createAttachmentStore().get(source.sha256, root))?.bytes).toEqual(bytes);
  });

  it('refuses completion when a successful graph return is not backed by graph records', async () => {
    const graph = await import('../../memory/graph-auto-populate.js');
    vi.spyOn(graph, 'ensureLlmtxtNodeScoped').mockResolvedValue({
      status: 'completed',
      projectId: context.identity.projectId,
      projectRoot: root,
    });
    const result = await projectDocumentAttachment(context, source);
    expect(result.status).toBe('failed');
    expect(result.diagnostics.join(' ')).toContain('graph verification failed');
    expect(readPending()[0].status).toBe('running');
    expect(readPending()[0].result).toBeNull();
    expect((await createAttachmentStore().get(source.sha256, root))?.bytes).toEqual(bytes);
  });

  it('keeps captured identity through mutable CLEO_ROOT and CLEO_DIR during actual projection', async () => {
    const result = projectDocumentAttachment(context, source);
    vi.stubEnv('CLEO_ROOT', join(root, 'B'));
    vi.stubEnv('CLEO_DIR', join(root, 'B', '.cleo'));
    try {
      expect(await result).toMatchObject({ status: 'completed', projectRoot: root });
      expect(readPending()[0].status).toBe('complete');
      await expect(access(join(root, 'B'))).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects malformed persisted proposals even when their stored hash matches', async () => {
    const prepared = await prepareDocumentProjection(context, source);
    const json = JSON.stringify({
      version: 1,
      operation: 'docs.projection',
      source: 'unsupported',
    });
    getNativeDb(root)!
      .prepare('UPDATE main.background_jobs SET proposal_json=?,proposal_hash=? WHERE id=?')
      .run(json, createHash('sha256').update(json).digest('hex'), prepared.jobId);
    await expect(resumeDocumentProjection(context, prepared.jobId)).rejects.toThrow();
    expect(readPending()[0].status).toBe('pending');
    expect(readPending()[0].attempts).toBe(0);
  });

  it('does not create a pending record under an unrelated operation identity', async () => {
    const wrong = createOperationExecutionContext({ ...context.identity, operation: 'tasks.add' });
    try {
      await expect(prepareDocumentProjection(wrong, source)).rejects.toThrow('docs.projection');
    } finally {
      wrong.close();
    }
    expect(readPending()).toEqual([]);
  });

  it('returns unresolved pending work and prevents a late graph continuation from reopening cleaned storage', async () => {
    const graph = await import('../../memory/graph-auto-populate.js');
    const original = graph.ensureLlmtxtNodeScoped;
    let release = () => {};
    let enter = () => {};
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      enter = resolve;
    });
    vi.spyOn(graph, 'ensureLlmtxtNodeScoped').mockImplementation(async (...args) => {
      enter();
      await pause;
      return original(...args);
    });
    const pending = projectDocumentAttachment(context, source);
    try {
      await ready;
      context.close();
      const observed = await pending;
      expect(observed).toMatchObject({ status: 'pending', coverage: 'partial' });
      expect(observed.jobId).toBeTruthy();
      expect(readPending()[0].status).toBe('running');
      await closeAllDatabases();
      await rm(join(root, '.cleo'), { recursive: true });
      release();
      const { awaitBackgroundOps } = await import('../../store/background-ops.js');
      await awaitBackgroundOps();
      await expect(access(join(root, '.cleo'))).rejects.toThrow();
    } finally {
      release();
      await pending;
    }
  });
});
