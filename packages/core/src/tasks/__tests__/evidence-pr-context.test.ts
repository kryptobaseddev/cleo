/** Task-specific PR and criterion evidence regressions for T12254. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceAtom, EvidenceValidationContext } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PrAtomResolution, resolvePrEvidenceAtom } from '../../release/pr-evidence.js';
import * as accessorModule from '../../store/data-accessor.js';
import { closeDb } from '../../store/sqlite.js';

import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { validateGateVerify } from '../../validation/engine-ops.js';
import {
  checkTaskEvidenceContext,
  composeGateEvidence,
  revalidateEvidence,
  validateAtom,
} from '../evidence.js';

vi.mock('../../release/pr-evidence.js', () => ({ resolvePrEvidenceAtom: vi.fn() }));
let root: string;
let context: EvidenceValidationContext;
let pr: Extract<PrAtomResolution, { ok: true }>;
const files: EvidenceAtom = {
  kind: 'files',
  files: [{ path: 'src/fix.ts', sha256: 'f'.repeat(64) }],
};
const link: EvidenceAtom = {
  kind: 'satisfies',
  targetTaskId: 'T12254',
  targetAcAlias: 'AC1',
  resolvedAcUuid: 'criterion-one',
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cleo-evidence-context-'));
  context = {
    task: { id: 'T12254', kind: 'bug', files: ['src/fix.ts'] },
    gates: ['implemented'],
    criteria: [{ id: 'criterion-one', text: 'Reject unrelated proof', updatedAt: null }],
  };
  pr = {
    ok: true,
    prNumber: 42,
    mergeCommitSha: 'a'.repeat(40),
    mergedAt: '2026-09-19T00:00:00Z',
    successCount: 3,
    totalChecks: 3,
    cacheHit: false,
    title: 'fix(T12254): implementation',
    body: 'Task T12254',
    headRefName: 'task/T12254',
    changedPaths: ['src/fix.ts'],
    changedFileCount: 1,
  };
  vi.mocked(resolvePrEvidenceAtom).mockImplementation(async () => pr);
});
afterEach(async () => {
  closeDb();
  await rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
const validate = () =>
  validateAtom({ kind: 'pr', prNumber: 42 }, root, 'T12254', undefined, context);

describe('PR context', () => {
  it('refuses to infer task completion from a context-free PR', async () => {
    expect(await validateAtom({ kind: 'pr', prNumber: 42 }, root)).toMatchObject({ ok: false });
    expect(resolvePrEvidenceAtom).not.toHaveBeenCalled();
  });
  it('records actual changed files and canonical task identity', async () => {
    expect(await validate()).toMatchObject({
      ok: true,
      atom: {
        kind: 'pr',
        taskId: 'T12254',
        changedPaths: ['src/fix.ts'],
        mergeCommitSha: 'a'.repeat(40),
      },
    });
  });
  it('rejects unrelated declared scope despite a task mention and green CI', async () => {
    pr.changedPaths = ['src/unrelated.ts'];
    expect(await validate()).toMatchObject({ ok: false, codeName: 'E_EVIDENCE_CONTENT_MISMATCH' });
  });
  it('does not confuse T122540 with T12254 when scope is undeclared', async () => {
    context.task.files = [];
    pr.title = 'T122540';
    pr.body = '';
    pr.headRefName = 'task/T122540';
    expect(await validate()).toMatchObject({ ok: false });
  });
  it('rejects documentation-only proof for a code bug even with a documentation label', async () => {
    context.task.files = [];
    context.task.labels = ['documentation'];
    pr.changedPaths = ['docs/fix.md'];
    expect(await validate()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('only documentation'),
    });
  });
  it.each([
    'research',
    'spike',
    'work',
    'bug',
  ] as const)('accepts documentary artifacts for explicitly scoped %s work', async (kind) => {
    context.task.kind = kind;
    context.task.files = ['docs/findings.md'];
    pr.changedPaths = ['docs/findings.md'];
    expect(await validate()).toMatchObject({ ok: true });
  });
  it('rejects incomplete changed-file coverage', async () => {
    pr.changedFileCount = 101;
    expect(await validate()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('incomplete'),
    });
  });
});

describe('criterion proof', () => {
  it('requires explicit criterion linkage instead of guessing from prose', () => {
    expect(
      checkTaskEvidenceContext(context, 'implemented', [
        files,
        { kind: 'commit', sha: 'a'.repeat(40), shortSha: 'aaaaaaa' },
      ]),
    ).toContain('satisfies:T12254#AC');
  });
  it('rejects a link to a criterion absent from the current task', () => {
    expect(
      checkTaskEvidenceContext(context, 'implemented', [
        files,
        { ...link, resolvedAcUuid: 'absent' },
      ]),
    ).toContain('not in the current task');
  });
  it('requires inspected artifacts to overlap the changed PR artifacts', () => {
    const atom: EvidenceAtom = {
      kind: 'pr',
      prNumber: 42,
      mergeCommitSha: 'a'.repeat(40),
      mergedAt: pr.mergedAt,
      successCount: 3,
      totalChecks: 3,
      taskId: 'T12254',
      changedPaths: ['src/other.ts'],
    };
    expect(checkTaskEvidenceContext(context, 'implemented', [atom, files, link])).toContain(
      'actually changed',
    );
  });
  it('retains criterion text hash, inspected artifacts and actual result reference', () => {
    const evidence = composeGateEvidence(
      [
        files,
        {
          kind: 'test-run',
          path: 'report.json',
          sha256: 'a'.repeat(64),
          passCount: 1,
          failCount: 0,
          skipCount: 0,
        },
        link,
      ],
      'reviewer',
      undefined,
      undefined,
      context,
      'testsPassed',
    );
    expect(evidence.scope).toEqual({
      taskId: 'T12254',
      gate: 'testsPassed',
      classification: 'code',
      criteria: [
        {
          criterionId: 'criterion-one',
          criterionHash: createHash('sha256').update('Reject unrelated proof').digest('hex'),
          artifactPaths: ['src/fix.ts'],
          resultAtomIndices: [1],
        },
      ],
    });
  });
});

describe('persisted contextual gate evidence', () => {
  it('records an explicit criterion/artifact link and refuses changed criteria at completion', async () => {
    await mkdir(join(root, '.cleo'));
    await mkdir(join(root, 'src'));
    await writeFile(
      join(root, '.cleo', 'config.json'),
      JSON.stringify({
        enforcement: { session: { requiredForMutate: false } },
        lifecycle: { mode: 'off' },
      }),
    );
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git(['init', '-q']);
    git(['config', 'user.name', 'Evidence fixture']);
    git(['config', 'user.email', 'evidence@example.test']);
    git(['config', 'commit.gpgsign', 'false']);
    await writeFile(join(root, 'src/fix.ts'), 'export const fixed = true;\n');
    git(['add', '.']);
    git(['commit', '-qm', 'fix(T12254): verified fixture']);
    pr.mergeCommitSha = git(['rev-parse', 'HEAD']);
    const accessor = await createSqliteDataAccessor(root);
    await accessor.upsertSingleTask({
      id: 'T12254',
      title: 'Fix criterion proof',
      description: 'Contextual gate regression',
      status: 'pending',
      priority: 'medium',
      kind: 'bug',
      files: ['src/fix.ts'],
      createdAt: new Date().toISOString(),
    });
    const criterionId = randomUUID();
    await accessor.transaction((tx) =>
      tx.insertAcRows([
        { id: criterionId, taskId: 'T12254', ordinal: 1, text: 'Reject unrelated proof' },
      ]),
    );
    const result = await validateGateVerify(root, {
      taskId: 'T12254',
      gate: 'implemented',
      evidence: 'files:src/fix.ts;pr:42;satisfies:T12254#AC1',
      agent: 'coder',
    });
    expect(result, JSON.stringify(result)).toMatchObject({ success: true });
    const stored = (await accessor.loadSingleTask('T12254'))?.verification?.evidence?.implemented;
    expect(stored?.scope?.criteria).toEqual([
      {
        criterionId,
        criterionHash: createHash('sha256').update('Reject unrelated proof').digest('hex'),
        artifactPaths: ['src/fix.ts'],
        resultAtomIndices: [0],
      },
    ]);
    expect((await accessor.getAcBindings([criterionId])).length).toBe(1);
    if (!stored) throw new Error('Missing receipt');
    expect((await revalidateEvidence(stored, root, 'implemented', 'T12254')).stillValid).toBe(true);
    const diagnostic = vi
      .spyOn(accessorModule, 'getTaskAccessor')
      .mockRejectedValueOnce(new Error('diagnostic read failure'));
    await expect(revalidateEvidence(stored, root, 'implemented', 'T12254')).rejects.toThrow(
      'diagnostic read failure',
    );
    diagnostic.mockRestore();
    await accessor.transaction(async (tx) => {
      await tx.deleteAcRowsForTask('T12254');
      await tx.insertAcRows([
        { id: criterionId, taskId: 'T12254', ordinal: 1, text: 'New unverified behavior' },
      ]);
    });
    const stale = await revalidateEvidence(stored, root, 'implemented', 'T12254');
    expect(stale.stillValid).toBe(false);
    expect(stale.failedAtoms[0]?.reason).toContain('changed after verification');
  });
  it('does not substitute current checkout content for a missing PR merge artifact', async () => {
    await writeFile(join(root, 'fix.ts'), 'unrelated bytes');
    const result = await validateAtom(
      { kind: 'files', paths: ['fix.ts'] },
      root,
      'T12254',
      undefined,
      { ...context, artifactCommitSha: 'a'.repeat(40) },
    );
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Current checkout bytes cannot substitute'),
    });
  });
});
