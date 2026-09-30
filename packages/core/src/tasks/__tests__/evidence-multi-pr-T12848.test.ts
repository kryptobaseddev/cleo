/**
 * T12848: several `pr:` atoms in ONE evidence write. Each `files:` path must be
 * read at the merge commit of the PR that changed it — never at the first PR's
 * merge — and a file list that does not cover every PR still refuses.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PrAtomResolution, resolvePrEvidenceAtom } from '../../release/pr-evidence.js';
import { closeDb } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { validateGateVerify } from '../../validation/engine-ops.js';
import { prMergeCommitForPath, revalidateEvidence } from '../evidence.js';

vi.mock('../../release/pr-evidence.js', () => ({ resolvePrEvidenceAtom: vi.fn() }));

const TASK = 'T12848';
let root: string;
const prs = new Map<number, Extract<PrAtomResolution, { ok: true }>>();

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function mergedPr(
  prNumber: number,
  mergeCommitSha: string,
  mergedAt: string,
  changedPaths: string[],
): Extract<PrAtomResolution, { ok: true }> {
  return {
    ok: true,
    prNumber,
    mergeCommitSha,
    mergedAt,
    successCount: 3,
    totalChecks: 3,
    cacheHit: false,
    title: `fix(${TASK}): part ${prNumber}`,
    body: `Task ${TASK}`,
    headRefName: `task/${TASK}-${prNumber}`,
    changedPaths,
    changedFileCount: changedPaths.length,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cleo-evidence-multi-pr-'));
  await mkdir(join(root, '.cleo'));
  await mkdir(join(root, 'src'));
  await writeFile(
    join(root, '.cleo', 'config.json'),
    JSON.stringify({
      enforcement: { session: { requiredForMutate: false } },
      lifecycle: { mode: 'off' },
    }),
  );
  git(['init', '-q']);
  git(['config', 'user.name', 'Evidence fixture']);
  git(['config', 'user.email', 'evidence@example.test']);
  git(['config', 'commit.gpgsign', 'false']);
  // PR #41 lands src/a.ts; PR #42 lands src/b.ts afterwards. src/b.ts does not
  // exist at PR #41's merge commit.
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
  git(['add', '.']);
  git(['commit', '-qm', `fix(${TASK}): part one`]);
  const first = git(['rev-parse', 'HEAD']);
  await writeFile(join(root, 'src/b.ts'), 'export const b = 2;\n');
  git(['add', '.']);
  git(['commit', '-qm', `fix(${TASK}): part two`]);
  const second = git(['rev-parse', 'HEAD']);
  prs.set(41, mergedPr(41, first, '2026-09-29T00:00:00Z', ['src/a.ts']));
  prs.set(42, mergedPr(42, second, '2026-09-29T01:00:00Z', ['src/b.ts']));
  vi.mocked(resolvePrEvidenceAtom).mockImplementation(async (prNumber: number) => {
    const found = prs.get(prNumber);
    if (!found) throw new Error(`unexpected PR ${prNumber}`);
    return found;
  });

  const accessor = await createSqliteDataAccessor(root);
  await accessor.upsertSingleTask({
    id: TASK,
    title: 'Two PRs in one write',
    description: 'Multi-PR evidence regression',
    status: 'pending',
    priority: 'medium',
    kind: 'bug',
    files: ['src/a.ts', 'src/b.ts'],
    createdAt: new Date().toISOString(),
  });
  await accessor.transaction((tx) =>
    tx.insertAcRows([{ id: randomUUID(), taskId: TASK, ordinal: 1, text: 'Ship both parts' }]),
  );
});

afterEach(async () => {
  closeDb();
  await rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
  prs.clear();
});

describe('several pr: atoms in one evidence write (T12848)', () => {
  it('validates each file at the merge commit of the PR that changed it', async () => {
    const result = await validateGateVerify(root, {
      taskId: TASK,
      gate: 'implemented',
      evidence: `pr:41;pr:42;files:src/a.ts,src/b.ts;satisfies:${TASK}#AC1`,
      agent: 'coder',
    });
    expect(result, JSON.stringify(result)).toMatchObject({ success: true });

    const accessor = await createSqliteDataAccessor(root);
    const stored = (await accessor.loadSingleTask(TASK))?.verification?.evidence?.implemented;
    if (!stored) throw new Error('Missing receipt');
    const prNumbers = stored.atoms.flatMap((atom) => (atom.kind === 'pr' ? [atom.prNumber] : []));
    expect(prNumbers.sort()).toEqual([41, 42]);
    // Complete-time re-validation reads each file at its own PR's merge too.
    expect((await revalidateEvidence(stored, root, 'implemented', TASK)).stillValid).toBe(true);
  });

  it('still refuses a file list that covers no artifact of one of the PRs', async () => {
    const result = await validateGateVerify(root, {
      taskId: TASK,
      gate: 'implemented',
      evidence: `pr:41;pr:42;files:src/a.ts;satisfies:${TASK}#AC1`,
      agent: 'coder',
    });
    expect(result).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('PR #42 requires files evidence') },
    });
  });

  it('accepts a "./"-prefixed path for a PR-changed file (review LOW)', async () => {
    const result = await validateGateVerify(root, {
      taskId: TASK,
      gate: 'implemented',
      evidence: `pr:41;pr:42;files:src/a.ts,./src/b.ts;satisfies:${TASK}#AC1`,
      agent: 'coder',
    });
    expect(result, JSON.stringify(result)).toMatchObject({ success: true });
  });

  it('refuses a PR whose every listed file is read at a later PR merge (review MEDIUM)', async () => {
    // Both PRs changed src/b.ts, so it is read at #42's merge only: #41's
    // merge tree is never inspected and #41 is not proven by this write.
    const accessor = await createSqliteDataAccessor(root);
    const task = await accessor.loadSingleTask(TASK);
    if (!task) throw new Error('fixture task missing');
    await accessor.upsertSingleTask({ ...task, files: ['src/b.ts'] });
    const first = prs.get(41);
    if (!first) throw new Error('fixture PR missing');
    prs.set(41, { ...first, changedPaths: ['src/a.ts', 'src/b.ts'], changedFileCount: 2 });
    const result = await validateGateVerify(root, {
      taskId: TASK,
      gate: 'implemented',
      evidence: `pr:41;pr:42;files:src/b.ts;satisfies:${TASK}#AC1`,
      agent: 'coder',
    });
    expect(result).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('PR #41') },
    });
  });

  it('still refuses a file absent from every PR merge tree', async () => {
    const result = await validateGateVerify(root, {
      taskId: TASK,
      gate: 'implemented',
      evidence: `pr:41;pr:42;files:src/a.ts,src/b.ts,src/missing.ts;satisfies:${TASK}#AC1`,
      agent: 'coder',
    });
    expect(result).toMatchObject({ success: false });
  });
});

describe('prMergeCommitForPath (T12848)', () => {
  const pr = (sha: string, mergedAt: string, changedPaths: string[]) => ({
    mergeCommitSha: sha,
    mergedAt,
    changedPaths,
  });
  it('prefers the PR that changed the path, the latest merge when several did', () => {
    const atoms = [
      pr('a', '2026-09-29T00:00:00Z', ['x.ts', 'y.ts']),
      pr('b', '2026-09-29T02:00:00Z', ['y.ts']),
      pr('c', '2026-09-29T01:00:00Z', ['z.ts']),
    ];
    expect(prMergeCommitForPath(atoms, 'x.ts')).toBe('a');
    expect(prMergeCommitForPath(atoms, './y.ts')).toBe('b');
    expect(prMergeCommitForPath(atoms, 'z.ts')).toBe('c');
    // A path no PR changed is read at the latest merge.
    expect(prMergeCommitForPath(atoms, 'other.ts')).toBe('b');
    expect(prMergeCommitForPath([], 'x.ts')).toBeUndefined();
  });
});
