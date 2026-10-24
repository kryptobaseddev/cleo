/** Real canonical-source and durable-pending proofs for optional docs projection. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationExecutionContext } from '@cleocode/contracts/jobs';
import {
  DOCS_PROJECTION_RECEIPT_SCHEMA,
  type DocsProjectionSource,
} from '@cleocode/contracts/operations/docs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAttachmentStore } from '../../store/attachment-store.js';
import { createOperationExecutionContext } from '../../store/background-ops.js';
import { closeAllDatabases, closeDb, getNativeDb } from '../../store/sqlite.js';
import {
  captureDocumentProjection,
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
  it('verifies the documents link and graph before recording completion without changing canonical bytes', async () => {
    const result = await projectDocumentAttachment(context, source);
    expect(result).toMatchObject({
      status: 'completed',
      coverage: 'current',
    });
    expect(result.diagnostics).toEqual([]);
    // T13985 (D11180): the link is a documents edge; no "Doc attached" observation.
    expect(result.receipt?.documents).toBe(true);
    expect(result.receipt?.observationId).toBeUndefined();
    expect(getNativeDb(root)!.prepare('SELECT id FROM brain_observations').all()).toEqual([]);
    const pending = readPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('complete');
    expect(JSON.parse(pending[0].result)).toEqual(result.receipt);
    expect(await resumeDocumentProjection(context, result.jobId!)).toEqual(result.receipt);
    expect((await createAttachmentStore().get(source.sha256, root))?.bytes).toEqual(bytes);
  });

  it('still verifies a legacy receipt that names its Doc attached observation (T13985)', async () => {
    const result = await projectDocumentAttachment(context, source);
    expect(result.status).toBe('completed');
    const [job] = readPending();
    const proposal = JSON.parse(job.proposal_json) as { observation: unknown };
    const { getBrainAccessor } = await import('../../store/memory-accessor.js');
    await (await getBrainAccessor(root)).addObservation({
      id: 'O-doc-legacy',
      type: 'feature',
      title: 'Doc attached: legacy',
      narrative: JSON.stringify(proposal.observation),
      project: context.identity.projectId,
      sourceType: 'agent',
    });
    const { documents: _documents, ...rest } = result.receipt!;
    const legacy = { ...rest, observationId: 'O-doc-legacy' };
    getNativeDb(root)!
      .prepare('UPDATE main.background_jobs SET result=? WHERE id=?')
      .run(JSON.stringify(legacy), result.jobId!);
    expect(await resumeDocumentProjection(context, result.jobId!)).toEqual(legacy);
  });

  it('rejects a receipt that records neither its documents edge nor a legacy observation (T13992)', () => {
    const base = {
      version: 1,
      sourceHash: 'a'.repeat(64),
      graph: 'completed',
      verifiedAt: '2026-10-24T00:00:00.000Z',
      actor: 'fixture',
    };
    expect(DOCS_PROJECTION_RECEIPT_SCHEMA.safeParse(base).success).toBe(false);
    expect(DOCS_PROJECTION_RECEIPT_SCHEMA.safeParse({ ...base, documents: true }).success).toBe(
      true,
    );
    expect(
      DOCS_PROJECTION_RECEIPT_SCHEMA.safeParse({ ...base, observationId: 'O-1' }).success,
    ).toBe(true);
  });

  it('completes a job the old code left at stage observation, with its observation written (T13992)', async () => {
    // Leave a prepared job running mid-way, as an interrupted pre-T13985 run did.
    const native = getNativeDb(root)!;
    native.exec(`CREATE TRIGGER hold_projection BEFORE UPDATE ON background_jobs
      WHEN NEW.status='complete' BEGIN SELECT RAISE(ABORT, 'interrupted'); END`);
    const result = await projectDocumentAttachment(context, source);
    expect(result.status).toBe('failed');
    native.exec('DROP TRIGGER hold_projection');
    const [job] = readPending();
    const proposal = JSON.parse(job.proposal_json) as { observation: unknown };
    const { getBrainAccessor } = await import('../../store/memory-accessor.js');
    await (await getBrainAccessor(root)).addObservation({
      id: 'O-doc-interrupted',
      type: 'feature',
      title: 'Doc attached: interrupted',
      narrative: JSON.stringify(proposal.observation),
      project: context.identity.projectId,
      sourceType: 'agent',
    });
    native
      .prepare(
        "UPDATE main.background_jobs SET checkpoint_json=?, lease_expires_at=0, status='running' WHERE id=?",
      )
      .run(JSON.stringify({ stage: 'observation', sourceHash: source.sha256 }), result.jobId!);

    const receipt = await resumeDocumentProjection(context, result.jobId!);

    expect(receipt).toMatchObject({ documents: true, graph: 'completed' });
    expect(receipt.observationId).toBeUndefined();
    expect(readPending()[0].status).toBe('complete');
    const edges = native
      .prepare("SELECT edge_type FROM brain_page_edges WHERE edge_type = 'documents'")
      .all();
    expect(edges).toHaveLength(1);
    // The legacy observation is left for the auto-row quarantine, not rewritten.
    expect(
      native.prepare("SELECT id FROM brain_observations WHERE id = 'O-doc-interrupted'").all(),
    ).toHaveLength(1);
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
    const edges = 'SELECT from_id,to_id,edge_type FROM brain_page_edges ORDER BY edge_type';
    const before = native.prepare(edges).all();
    expect(before.map((edge) => edge.edge_type)).toEqual(['documents', 'embeds']);
    native.exec('DROP TRIGGER refuse_projection_receipt');
    native
      .prepare('UPDATE main.background_jobs SET lease_expires_at=0 WHERE id=?')
      .run(result.jobId!);
    const receipt = await resumeDocumentProjection(context, result.jobId!);
    expect(native.prepare(edges).all()).toEqual(before);
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
    expect(result.diagnostics.join(' ')).toContain('link verification failed');
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

describe('canonical projection identity capture', () => {
  it('rejects invalid budgets without emitting an invalid deadline', async () => {
    await expect(captureDocumentProjection(root, 'foreground', 'key', Number.NaN)).rejects.toThrow(
      RangeError,
    );
    expect(readPending()).toEqual([]);
  });

  it('captures the explicit root and charges metadata reads to the original deadline', async () => {
    await writeFile(
      join(root, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'portable-A', projectRoot: root }),
    );
    const before = Date.now();
    const pending = captureDocumentProjection(root, 'foreground', 'invocation', 10000);
    vi.stubEnv('CLEO_ROOT', join(root, 'B'));
    vi.stubEnv('CLEO_DIR', join(root, 'B/.cleo'));
    try {
      const captured = await pending;
      expect(captured.status).toBe('ready');
      if (captured.status !== 'ready') throw new Error(captured.outcome.diagnostics.join(' '));
      try {
        expect(captured.context.identity).toMatchObject({
          projectId: 'portable-A',
          projectRoot: root,
        });
        expect(captured.context.deadlineAt).toBeLessThanOrEqual(before + 10010);
      } finally {
        captured.context.close();
      }
      await expect(access(join(root, 'B'))).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    'missing',
    'malformed',
    'expired',
  ] as const)('reports %s identity or scope without creating optional work', async (mode) => {
    if (mode !== 'missing')
      await writeFile(
        join(root, '.cleo/project-info.json'),
        mode === 'malformed'
          ? '{bad-json'
          : JSON.stringify({ projectId: 'portable-A', projectRoot: root }),
      );
    const captured = await captureDocumentProjection(
      root,
      'foreground',
      'invocation',
      mode === 'expired' ? 0 : 2000,
    );
    expect(captured).toMatchObject({
      status: 'unavailable',
      outcome: { coverage: 'missing', projectId: null },
    });
    if (captured.status === 'unavailable')
      expect(captured.outcome.diagnostics.length).toBeGreaterThan(0);
    expect(readPending()).toEqual([]);
    expect((await createAttachmentStore().get(source.sha256, root))?.bytes).toEqual(bytes);
  });

  // T12557: identity is the projectId. A persisted projectRoot is a legacy
  // path-derived value (written by `project move`, or `/mnt/...` in old Linux
  // stores) that goes stale on every move and must never fail the capture.
  it('captures a legacy stale persisted projectRoot by projectId (T12557)', async () => {
    await writeFile(
      join(root, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'portable-A', projectRoot: '/mnt/projects/legacy' }),
    );
    const captured = await captureDocumentProjection(root, 'foreground', 'invocation', 10000);
    if (captured.status !== 'ready') throw new Error(captured.outcome.diagnostics.join(' '));
    try {
      expect(captured.context.identity).toMatchObject({
        projectId: 'portable-A',
        projectRoot: root,
      });
    } finally {
      captured.context.close();
    }
  });

  it('projects a doc after the project directory is moved (T12557)', async () => {
    await writeFile(
      join(root, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'portable-A', projectRoot: root }),
    );
    await closeAllDatabases();
    const moved = `${root}-moved`;
    await rename(root, moved);
    root = moved;
    process.env['CLEO_DIR'] = join(root, '.cleo');
    process.env['CLEO_HOME'] = join(root, 'global');
    const captured = await captureDocumentProjection(root, 'foreground', 'after-move', 10000);
    if (captured.status !== 'ready') throw new Error(captured.outcome.diagnostics.join(' '));
    try {
      expect(captured.context.identity).toMatchObject({
        projectId: 'portable-A',
        projectRoot: root,
      });
      const result = await projectDocumentAttachment(captured.context, source);
      expect(result).toMatchObject({ status: 'completed', coverage: 'current', projectRoot: root });
      expect(result.diagnostics).toEqual([]);
    } finally {
      captured.context.close();
    }
  });
});
