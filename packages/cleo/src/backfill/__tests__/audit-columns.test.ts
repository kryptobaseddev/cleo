/** Consumer regression tests; CLI legacy SDK placement is tracked for core relocation. */
import * as childProcess from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReconstructResult, Task } from '@cleocode/contracts';
import * as auditSdk from '@cleocode/core/audit/reconstruct';
import { awaitBackgroundOps } from '@cleocode/core/store/background-ops';
import { getTaskAccessor } from '@cleocode/core/store/data-accessor';
import { closeAllDatabases } from '@cleocode/core/store/sqlite';
import { createTask } from '@cleocode/core/store/tasks-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backfillAuditColumns } from '../audit-columns.js';

let root: string;
let sha: string;
const task = (id: string): Task => ({
  id,
  title: id,
  description: 'Independent durable provenance fixture',
  status: 'done',
  priority: 'medium',
  type: 'task',
  createdAt: '2026-01-01T00:00:00Z',
});
const evidence = (coverage: 'current' | 'partial' | 'failed'): ReconstructResult => ({
  taskId: 'T100',
  directCommits: [
    {
      sha,
      subject: 'T100: genuine work',
      author: 'Recorded author',
      authorDate: '2026-01-01T00:00:00Z',
    },
  ],
  childIdRange: null,
  childCommits: {},
  releaseTags: [],
  releaseCommitShas: [],
  firstSeenAt: null,
  lastSeenAt: null,
  inferredChildren: [],
  assessment: {
    repositoryRoot: root,
    deadlineAt: Date.now() + 10000,
    coverage,
    shallow: false,
    observedCommits: 1,
    historyComplete: coverage !== 'failed',
    tagsComplete: coverage === 'current',
    commands: [],
    limitations: [],
    diagnostics:
      coverage === 'current'
        ? []
        : [{ code: 'E_GIT_READ_FAILED', stage: 'history', message: 'Denied history' }],
  },
});
const fresh = async (id: string) => {
  await awaitBackgroundOps();
  await closeAllDatabases();
  return (await getTaskAccessor(root)).loadSingleTask(id);
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'audit-backfill-'));
  await mkdir(join(root, '.cleo'));
  vi.stubEnv('CLEO_ROOT', root);
  vi.stubEnv('CLEO_DIR', join(root, '.cleo'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Recorded author',
    GIT_COMMITTER_NAME: 'Recorded author',
    GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_EMAIL: 'fixture@example.test',
  };
  childProcess.execFileSync('git', ['init', '--initial-branch=main'], {
    cwd: root,
    env,
    stdio: 'ignore',
    timeout: 5000,
  });
  childProcess.execFileSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'T100: genuine work'],
    { cwd: root, env, stdio: 'ignore', timeout: 5000 },
  );
  sha = childProcess
    .execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, env, encoding: 'utf8', timeout: 5000 })
    .trim();
  await createTask(task('T100'), root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await awaitBackgroundOps();
  await closeAllDatabases();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('audit provenance writes require complete recorded evidence', () => {
  it.each([
    'failed',
    'partial',
  ] as const)('does not write an author or session from %s assessment', async (coverage) => {
    vi.spyOn(auditSdk, 'reconstructLineage').mockResolvedValue(evidence(coverage));
    const before = await fresh('T100');
    const result = await backfillAuditColumns(root);
    expect(result.entries).toEqual([
      expect.objectContaining({
        taskId: 'T100',
        written: false,
        modifiedBy: null,
        sessionId: null,
        error: expect.stringContaining('E_AUDIT_INCOMPLETE'),
      }),
    ]);
    expect(await fresh('T100')).toEqual(before);
  });

  it('does not treat absent legacy assessment as trusted provenance', async () => {
    const legacy = evidence('current');
    delete legacy.assessment;
    vi.spyOn(auditSdk, 'reconstructLineage').mockResolvedValue(legacy);
    const before = await fresh('T100');
    const result = await backfillAuditColumns(root);
    expect(result.entries[0]).toMatchObject({ written: false, modifiedBy: null });
    expect(await fresh('T100')).toEqual(before);
  });

  it('preserves a source read exception instead of inventing an unknown marker', async () => {
    vi.spyOn(auditSdk, 'reconstructLineage').mockRejectedValue(new Error('history unavailable'));
    const before = await fresh('T100');
    const result = await backfillAuditColumns(root);
    expect(result.entries[0]).toMatchObject({
      written: false,
      modifiedBy: null,
      error: 'history unavailable',
    });
    expect(await fresh('T100')).toEqual(before);
  });

  it('does not backfill an assessed empty history', async () => {
    const empty = evidence('current');
    empty.directCommits = [];
    vi.spyOn(auditSdk, 'reconstructLineage').mockResolvedValue(empty);
    const before = await fresh('T100');
    const result = await backfillAuditColumns(root);
    expect(result.gapTaskIds).toEqual(['T100']);
    expect(result.entries[0]).toMatchObject({
      written: false,
      modifiedBy: null,
      error: expect.stringContaining('NO_AUTHORED_EVIDENCE'),
    });
    expect(await fresh('T100')).toEqual(before);
  });

  it('does not fall back to author metadata when a required trailer read fails', async () => {
    const missingObject = evidence('current');
    missingObject.directCommits[0]!.sha = '0'.repeat(40);
    vi.spyOn(auditSdk, 'reconstructLineage').mockResolvedValue(missingObject);
    const before = await fresh('T100');
    const result = await backfillAuditColumns(root);
    expect(result.entries[0]).toMatchObject({
      written: false,
      modifiedBy: null,
      error: expect.stringContaining('bad object'),
    });
    expect(await fresh('T100')).toEqual(before);
  });

  it('does not invent provenance for commits without recorded authors', async () => {
    const unnamed = evidence('current');
    unnamed.directCommits[0]!.author = '   ';
    vi.spyOn(auditSdk, 'reconstructLineage').mockResolvedValue(unnamed);
    const before = await fresh('T100');
    const result = await backfillAuditColumns(root);
    expect(result.entries[0]).toMatchObject({
      written: false,
      modifiedBy: null,
      error: expect.stringContaining('NO_AUTHORED_EVIDENCE'),
    });
    expect(await fresh('T100')).toEqual(before);
  });

  it('does not grant trailer reads a new deadline after assessment expires', async () => {
    const expired = evidence('current');
    if (!expired.assessment) throw new Error('Fixture assessment required');
    expired.assessment.deadlineAt = 0;
    vi.spyOn(auditSdk, 'reconstructLineage').mockResolvedValue(expired);
    const before = await fresh('T100');
    const result = await backfillAuditColumns(root);
    expect(result.entries[0]).toMatchObject({
      written: false,
      modifiedBy: null,
      error: expect.stringContaining('E_OPERATION_DEADLINE'),
    });
    expect(await fresh('T100')).toEqual(before);
  });

  it('keeps complete inferred evidence read-only in preview mode', async () => {
    vi.spyOn(auditSdk, 'reconstructLineage').mockResolvedValue(evidence('current'));
    const before = await fresh('T100');
    const result = await backfillAuditColumns(root, { dryRun: true });
    expect(result.entries[0]).toMatchObject({ written: false, modifiedBy: 'Recorded author' });
    expect(await fresh('T100')).toEqual(before);
  });

  it('persists genuine complete author evidence while retaining a later failed task as an explicit gap', async () => {
    await createTask(task('T101'), root);
    vi.spyOn(auditSdk, 'reconstructLineage').mockImplementation(async (id) =>
      id === 'T100' ? evidence('current') : evidence('partial'),
    );
    const result = await backfillAuditColumns(root);
    expect(result.entries.find((entry) => entry.taskId === 'T100')).toMatchObject({
      written: true,
      modifiedBy: 'Recorded author',
    });
    expect(result.entries.find((entry) => entry.taskId === 'T101')).toMatchObject({
      written: false,
      modifiedBy: null,
    });
    expect((await fresh('T100'))?.provenance?.modifiedBy).toBe('Recorded author');
    expect((await fresh('T101'))?.provenance?.modifiedBy).toBeUndefined();
  });

  it('preserves prior authored provenance without rescanning or replacing it', async () => {
    await (await getTaskAccessor(root)).updateTaskFields('T100', {
      modifiedBy: 'Historical owner',
    });
    const before = await fresh('T100');
    const spy = vi.spyOn(auditSdk, 'reconstructLineage');
    const result = await backfillAuditColumns(root);
    expect(result.tasksInScope).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(await fresh('T100')).toEqual(before);
  });
});
