/**
 * T14025: a PR of a multi-PR evidence write whose listed files were all edited
 * by a later cited PR is still proven while the version read there carries its
 * own hunks — the T659 shape (`pr:55;pr:82;pr:161;files:…`). Hunks a later PR
 * rewrote prove nothing, and the refusal names only fixes that exist.
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
import { revalidateEvidence } from '../evidence.js';

vi.mock('../../release/pr-evidence.js', () => ({ resolvePrEvidenceAtom: vi.fn() }));

const TASK = 'T14025';
let root: string;
const prs = new Map<number, Extract<PrAtomResolution, { ok: true }>>();
const merges = new Map<number, string>();

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

/** Twelve numbered lines, with `edits` replacing lines by 1-based number. */
function lines(name: string, edits: Record<number, string> = {}): string {
  return Array.from({ length: 12 }, (_, i) => edits[i + 1] ?? `${name} line ${i + 1}`).join('\n');
}

async function commit(files: Record<string, string>, message: string): Promise<string> {
  for (const [path, body] of Object.entries(files)) await writeFile(join(root, path), `${body}\n`);
  git(['add', '.']);
  git(['commit', '-qm', message]);
  return git(['rev-parse', 'HEAD']);
}

function mergedPr(prNumber: number, mergedAt: string, changedPaths: string[]) {
  const mergeCommitSha = merges.get(prNumber);
  if (!mergeCommitSha) throw new Error(`fixture merge ${prNumber} missing`);
  prs.set(prNumber, {
    ok: true,
    prNumber,
    mergeCommitSha,
    mergedAt,
    successCount: 3,
    totalChecks: 3,
    cacheHit: false,
    title: `feat(${TASK}): part ${prNumber}`,
    body: `Task ${TASK}`,
    headRefName: `task/${TASK}-${prNumber}`,
    changedPaths,
    changedFileCount: changedPaths.length,
  });
}

function verify(evidence: string) {
  return validateGateVerify(root, {
    taskId: TASK,
    gate: 'implemented',
    evidence: `${evidence};satisfies:${TASK}#AC1`,
    agent: 'coder',
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cleo-evidence-hunks-'));
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
  await commit(
    { 'src/engine.ts': lines('engine'), 'src/portal.ts': lines('portal') },
    'chore: base',
  );
  // #55 edits line 2 of both files and adds a file no later PR touches.
  merges.set(
    55,
    await commit(
      {
        'src/engine.ts': lines('engine', { 2: 'engine by 55' }),
        'src/portal.ts': lines('portal', { 2: 'portal by 55' }),
        'src/only55.ts': 'export const only55 = true;',
      },
      `feat(${TASK}): part 55`,
    ),
  );
  // #82 touches an unrelated file.
  merges.set(82, await commit({ 'src/kiosk.ts': lines('kiosk') }, `feat(${TASK}): part 82`));
  // #161 edits engine.ts far from #55's hunk, and rewrites #55's portal.ts line.
  merges.set(
    161,
    await commit(
      {
        'src/engine.ts': lines('engine', { 2: 'engine by 55', 11: 'engine by 161' }),
        'src/portal.ts': lines('portal', { 2: 'portal by 161' }),
      },
      `feat(${TASK}): part 161`,
    ),
  );
  mergedPr(55, '2026-10-22T17:41:12Z', ['src/engine.ts', 'src/portal.ts', 'src/only55.ts']);
  mergedPr(82, '2026-10-22T22:58:10Z', ['src/kiosk.ts']);
  mergedPr(161, '2026-10-24T20:30:51Z', ['src/engine.ts', 'src/portal.ts']);
  vi.mocked(resolvePrEvidenceAtom).mockImplementation(async (prNumber: number) => {
    const found = prs.get(prNumber);
    if (!found) throw new Error(`unexpected PR ${prNumber}`);
    return found;
  });

  const accessor = await createSqliteDataAccessor(root);
  await accessor.upsertSingleTask({
    id: TASK,
    title: 'Three PRs in one write',
    description: 'Own-hunks multi-PR evidence regression',
    status: 'pending',
    priority: 'medium',
    kind: 'bug',
    files: ['src/engine.ts', 'src/portal.ts', 'src/kiosk.ts', 'src/only55.ts'],
    createdAt: new Date().toISOString(),
  });
  await accessor.transaction((tx) =>
    tx.insertAcRows([{ id: randomUUID(), taskId: TASK, ordinal: 1, text: 'Ship every part' }]),
  );
});

afterEach(async () => {
  closeDb();
  await rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
  prs.clear();
  merges.clear();
});

describe('own hunks prove an earlier PR in a multi-PR write (T14025)', () => {
  it('accepts the T659 shape: every listed #55 file was edited later, its hunks still apply', async () => {
    const result = await verify('pr:55;pr:82;pr:161;files:src/engine.ts,src/kiosk.ts');
    expect(result, JSON.stringify(result)).toMatchObject({ success: true });

    const accessor = await createSqliteDataAccessor(root);
    const stored = (await accessor.loadSingleTask(TASK))?.verification?.evidence?.implemented;
    if (!stored) throw new Error('Missing receipt');
    const files = stored.atoms.flatMap((atom) => (atom.kind === 'files' ? atom.files : []));
    expect(files.find((file) => file.path === 'src/engine.ts')?.carries).toEqual([merges.get(55)]);
    expect(files.find((file) => file.path === 'src/kiosk.ts')?.carries).toBeUndefined();
    // Complete-time re-validation honours the recorded credit.
    expect((await revalidateEvidence(stored, root, 'implemented', TASK)).stillValid).toBe(true);
  });

  it('refuses a PR whose listed hunks were all rewritten, naming each file and why', async () => {
    const result = await verify('pr:55;pr:82;pr:161;files:src/portal.ts,src/kiosk.ts');
    expect(result).toMatchObject({ success: false });
    const message = result.success ? '' : result.error.message;
    expect(message).toContain('PR #55 is not proven');
    expect(message).toContain("src/portal.ts (read at PR #161's merge)");
    expect(message).toContain('rewrote or reverted');
    // A file only #55 changed exists, so listing it is a real fix.
    expect(message).toContain('src/only55.ts');
  });

  it('never suggests listing a file when every file the PR changed was changed later', async () => {
    mergedPr(55, '2026-10-22T17:41:12Z', ['src/engine.ts', 'src/portal.ts']);
    const result = await verify('pr:55;pr:82;pr:161;files:src/portal.ts,src/kiosk.ts');
    expect(result).toMatchObject({ success: false });
    const message = result.success ? '' : result.error.message;
    expect(message).not.toContain('List a file');
    expect(message).toContain('record PR #55 in its own cleo verify write');
  });

  it('accepts PR #55 recorded in its own write, the fix the refusal names', async () => {
    const result = await verify('pr:55;files:src/portal.ts');
    expect(result, JSON.stringify(result)).toMatchObject({ success: true });
  });
});
