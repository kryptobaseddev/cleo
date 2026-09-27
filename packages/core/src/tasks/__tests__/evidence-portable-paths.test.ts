/**
 * Evidence paths that survive a move without loosening the tamper check (T12476).
 *
 * - New `files:` / `test-run:` atoms keep `path` exactly as supplied and pin
 *   the hashed file in `resolvedPath`, so re-validation reads the attested
 *   file whatever directory `cleo complete` runs from.
 * - A gone absolute path is rebased ONLY through a vanished, recorded
 *   checkout root of this project; the sha256 still decides.
 *
 * @task T12476
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { EvidenceAtom, GateEvidence } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recorded = vi.hoisted(() => ({ roots: [] as string[] }));
vi.mock('../evidence-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../evidence-paths.js')>();
  return { ...actual, loadRecordedProjectRoots: async () => recorded.roots };
});

import { composeGateEvidence, revalidateEvidence, validateAtom } from '../evidence.js';
import { rebaseLegacyEvidencePath } from '../evidence-paths.js';

const VITEST_JSON = JSON.stringify({
  numTotalTests: 2,
  numPassedTests: 2,
  numFailedTests: 0,
  testResults: [{ status: 'passed' }],
});
const TAMPERED_JSON = JSON.stringify({ numTotalTests: 9 });

/** A root that cannot exist: the "old device" layout. */
const OLD_ROOT = '/nonexistent-t12476/mnt/projects/app';

function evidenceOf(atom: EvidenceAtom): GateEvidence {
  return composeGateEvidence([atom], 'test');
}

afterEach(() => {
  recorded.roots = [];
});

describe('rebaseLegacyEvidencePath', () => {
  let live: string;
  beforeEach(() => {
    live = mkdtempSync(join(tmpdir(), 'evidence-rebase-'));
    mkdirSync(join(live, 'src'), { recursive: true });
    writeFileSync(join(live, 'src', 'a.ts'), 'a');
    writeFileSync(join(live, 'LICENSE'), 'l');
  });
  afterEach(() => rmSync(live, { recursive: true, force: true }));

  it('returns null for relative paths and paths that still exist', () => {
    expect(rebaseLegacyEvidencePath('src/a.ts', [live], [OLD_ROOT])).toBeNull();
    expect(rebaseLegacyEvidencePath(join(live, 'src', 'a.ts'), [live], [OLD_ROOT])).toBeNull();
  });

  it('rebases through a vanished recorded root, including a root-level file', () => {
    expect(rebaseLegacyEvidencePath(`${OLD_ROOT}/src/a.ts`, [live], [OLD_ROOT])).toBe(
      join(live, 'src', 'a.ts'),
    );
    expect(rebaseLegacyEvidencePath(`${OLD_ROOT}/LICENSE`, [live], [OLD_ROOT])).toBe(
      join(live, 'LICENSE'),
    );
  });

  it('never rebases without a recorded root (no tail heuristic)', () => {
    expect(rebaseLegacyEvidencePath(`${OLD_ROOT}/src/a.ts`, [live], [])).toBeNull();
  });

  it('returns null when the rebased file does not exist', () => {
    expect(rebaseLegacyEvidencePath(`${OLD_ROOT}/src/gone.ts`, [live], [OLD_ROOT])).toBeNull();
  });

  it('never rebases a file that moved inside a project that did not move', () => {
    // <live>/pkg/sub/a.ts is gone; <live>/sub/a.ts exists. The project root
    // is live, so this is a removal, not a move.
    mkdirSync(join(live, 'sub'), { recursive: true });
    writeFileSync(join(live, 'sub', 'a.ts'), 'a');
    const moved = join(live, 'pkg', 'sub', 'a.ts');
    expect(rebaseLegacyEvidencePath(moved, [live], [])).toBeNull();
    expect(rebaseLegacyEvidencePath(moved, [live], [live])).toBeNull();
    expect(rebaseLegacyEvidencePath(moved, [live], [join(live, 'pkg')])).toBeNull();
  });

  it('rejects traversal segments', () => {
    expect(
      rebaseLegacyEvidencePath('/gone/root/../../etc/hosts', [live], ['/gone/root']),
    ).toBeNull();
    expect(rebaseLegacyEvidencePath(`${OLD_ROOT}/./src/a.ts`, [live], [OLD_ROOT])).toBeNull();
  });

  it('rejects a rebased path whose realpath escapes the live root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'evidence-rebase-outside-'));
    try {
      mkdirSync(join(outside, 'secret'), { recursive: true });
      writeFileSync(join(outside, 'secret', 'key.pem'), 'k');
      symlinkSync(join(outside, 'secret'), join(live, 'secret'));
      expect(rebaseLegacyEvidencePath(`${OLD_ROOT}/secret/key.pem`, [live], [OLD_ROOT])).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(sep !== '/')('treats a backslash as a file-name character on POSIX', () => {
    // `x\y.ts` is ONE segment on POSIX: it must not map onto <live>/x/y.ts.
    mkdirSync(join(live, 'x'), { recursive: true });
    writeFileSync(join(live, 'x', 'y.ts'), 'y');
    expect(rebaseLegacyEvidencePath(`${OLD_ROOT}/x\\y.ts`, [live], [OLD_ROOT])).toBeNull();
    // ...but it does map onto a file literally named `x\y.ts`.
    writeFileSync(join(live, 'x\\y.ts'), 'literal');
    expect(rebaseLegacyEvidencePath(`${OLD_ROOT}/x\\y.ts`, [live], [OLD_ROOT])).toBe(
      join(live, 'x\\y.ts'),
    );
    // A backslash-dotdot name is a literal name, not traversal.
    expect(rebaseLegacyEvidencePath(`${OLD_ROOT}/..\\etc`, [live], [OLD_ROOT])).toBeNull();
  });
});

describe('new atoms keep the supplied path and pin the hashed file', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'evidence-portable-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'out.json'), VITEST_JSON);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('files: relative input stays verbatim; resolvedPath is absolute', async () => {
    const r = await validateAtom({ kind: 'files', paths: ['src/a.ts'] }, root);
    expect(r.ok).toBe(true);
    if (r.ok && r.atom.kind === 'files') {
      expect(r.atom.files[0]?.path).toBe('src/a.ts');
      expect(r.atom.files[0]?.resolvedPath).toBe(join(root, 'src', 'a.ts'));
    }
  });

  it('files: absolute input stays absolute byte for byte', async () => {
    const input = `${root}/src//a.ts`;
    const r = await validateAtom({ kind: 'files', paths: [input] }, root);
    expect(r.ok).toBe(true);
    if (r.ok && r.atom.kind === 'files') expect(r.atom.files[0]?.path).toBe(input);
  });

  it('test-run: path verbatim, resolvedPath absolute', async () => {
    const r = await validateAtom({ kind: 'test-run', path: 'out.json' }, root);
    expect(r.ok).toBe(true);
    if (r.ok && r.atom.kind === 'test-run') {
      expect(r.atom.path).toBe('out.json');
      expect(r.atom.resolvedPath).toBe(join(root, 'out.json'));
    }
  });
});

describe('a moved project re-validates only through a recorded root', () => {
  let live: string;
  let fileSha: string;
  let reportSha: string;
  beforeEach(async () => {
    live = mkdtempSync(join(tmpdir(), 'evidence-legacy-'));
    mkdirSync(join(live, 'src'), { recursive: true });
    writeFileSync(join(live, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(live, 'out.json'), VITEST_JSON);
    const f = await validateAtom({ kind: 'files', paths: ['src/a.ts'] }, live);
    const t = await validateAtom({ kind: 'test-run', path: 'out.json' }, live);
    if (!f.ok || f.atom.kind !== 'files' || !t.ok || t.atom.kind !== 'test-run') {
      throw new Error('fixture validation failed');
    }
    fileSha = f.atom.files[0]?.sha256 ?? '';
    reportSha = t.atom.sha256;
  });
  afterEach(() => rmSync(live, { recursive: true, force: true }));

  const filesAtom = (path: string, resolvedPath?: string): EvidenceAtom => ({
    kind: 'files',
    files: [{ path, sha256: fileSha, ...(resolvedPath ? { resolvedPath } : {}) }],
  });
  const reportAtom = (path: string): EvidenceAtom => ({
    kind: 'test-run',
    path,
    sha256: reportSha,
    passCount: 2,
    failCount: 0,
    skipCount: 0,
  });

  it('files: a legacy absolute path rebases through the recorded old root', async () => {
    recorded.roots = [OLD_ROOT];
    const rv = await revalidateEvidence(evidenceOf(filesAtom(`${OLD_ROOT}/src/a.ts`)), live);
    expect(rv.stillValid).toBe(true);
  });

  it('files: a new atom whose resolvedPath moved rebases too', async () => {
    recorded.roots = [OLD_ROOT];
    const rv = await revalidateEvidence(
      evidenceOf(filesAtom('src/a.ts', `${OLD_ROOT}/src/a.ts`)),
      live,
    );
    expect(rv.stillValid).toBe(true);
  });

  it('files: without a recorded root the move is reported, not guessed', async () => {
    const rv = await revalidateEvidence(evidenceOf(filesAtom(`${OLD_ROOT}/src/a.ts`)), live);
    expect(rv.stillValid).toBe(false);
    expect(rv.failedAtoms[0]?.reason).toMatch(/removed since verify/);
  });

  it('files: rebasing never bypasses the tamper check', async () => {
    recorded.roots = [OLD_ROOT];
    writeFileSync(join(live, 'src', 'a.ts'), 'export const a = 2; // tampered\n');
    const rv = await revalidateEvidence(evidenceOf(filesAtom(`${OLD_ROOT}/src/a.ts`)), live);
    expect(rv.stillValid).toBe(false);
    expect(rv.failedAtoms[0]?.reason).toMatch(/modified since verify/);
  });

  it('test-run: rebases through the recorded root and still checks the hash', async () => {
    recorded.roots = [OLD_ROOT];
    const ok = await revalidateEvidence(evidenceOf(reportAtom(`${OLD_ROOT}/out.json`)), live);
    expect(ok.stillValid).toBe(true);
    writeFileSync(join(live, 'out.json'), TAMPERED_JSON);
    const bad = await revalidateEvidence(evidenceOf(reportAtom(`${OLD_ROOT}/out.json`)), live);
    expect(bad.stillValid).toBe(false);
    expect(bad.failedAtoms[0]?.reason).toMatch(/modified since verify/);
  });
});

/**
 * Regression for the re-reviews of PR #1570: the attested file must not
 * depend on the cwd of `cleo verify` vs `cleo complete`. The store checkout
 * and a worktree hold identical copies; tampering with the ATTESTED copy must
 * fail, and tampering with the OTHER copy must not.
 */
describe('verify and complete from different trees keep the attested file', () => {
  let storeRoot: string;
  let worktree: string;
  let originalCwd: string;
  const git = (dir: string, args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });

  beforeEach(() => {
    originalCwd = process.cwd();
    storeRoot = mkdtempSync(join(tmpdir(), 'evidence-wt-store-'));
    git(storeRoot, ['init', '-q', '-b', 'main']);
    git(storeRoot, ['config', 'user.name', 'Test']);
    git(storeRoot, ['config', 'user.email', 'test@example.com']);
    writeFileSync(join(storeRoot, 'README.md'), 'base');
    writeFileSync(join(storeRoot, 'out.json'), VITEST_JSON);
    git(storeRoot, ['add', 'README.md', 'out.json']);
    git(storeRoot, ['commit', '-q', '-m', 'base']);
    worktree = `${storeRoot}-wt`;
    git(storeRoot, ['worktree', 'add', '-q', '-b', 'feature', worktree]);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try {
      git(storeRoot, ['worktree', 'remove', '--force', worktree]);
    } catch {
      // best effort
    }
    rmSync(storeRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  /** Verify from `verifyCwd`, tamper `tamper`, re-validate from `completeCwd`. */
  async function filesRoundTrip(
    input: string,
    verifyCwd: string,
    completeCwd: string,
    tamper: string,
  ): Promise<boolean> {
    process.chdir(verifyCwd);
    const r = await validateAtom({ kind: 'files', paths: [input] }, storeRoot);
    if (!r.ok) throw new Error(`verify failed: ${r.reason}`);
    writeFileSync(tamper, 'tampered');
    process.chdir(completeCwd);
    return (await revalidateEvidence(evidenceOf(r.atom), storeRoot)).stillValid;
  }

  async function testRunRoundTrip(
    input: string,
    verifyCwd: string,
    completeCwd: string,
    tamper: string,
  ): Promise<boolean> {
    process.chdir(verifyCwd);
    const r = await validateAtom({ kind: 'test-run', path: input }, storeRoot);
    if (!r.ok) throw new Error(`verify failed: ${r.reason}`);
    writeFileSync(tamper, TAMPERED_JSON);
    process.chdir(completeCwd);
    return (await revalidateEvidence(evidenceOf(r.atom), storeRoot)).stillValid;
  }

  /**
   * ADR-055 lifecycle: verify in the worktree, remove the worktree after
   * merge, complete from the store checkout. The pinned `resolvedPath` is gone
   * and no recorded root explains it, so re-validation falls back to the
   * pre-T12476 resolution of `path` — and the sha256 decides.
   */
  async function removedWorktreeLifecycle(
    atom: { kind: 'files'; paths: string[] } | { kind: 'test-run'; path: string },
    tamperStore: string | null,
  ): Promise<boolean> {
    process.chdir(worktree);
    const r = await validateAtom(atom, storeRoot);
    if (!r.ok) throw new Error(`verify failed: ${r.reason}`);
    process.chdir(storeRoot);
    git(storeRoot, ['worktree', 'remove', '--force', worktree]);
    rmSync(worktree, { recursive: true, force: true });
    if (tamperStore !== null) writeFileSync(tamperStore, TAMPERED_JSON);
    return (await revalidateEvidence(evidenceOf(r.atom), storeRoot)).stillValid;
  }

  it('files: worktree removed after merge, store copy identical: valid', async () => {
    expect(await removedWorktreeLifecycle({ kind: 'files', paths: ['README.md'] }, null)).toBe(
      true,
    );
  });

  it('files: worktree removed after merge, store copy tampered: fails', async () => {
    expect(
      await removedWorktreeLifecycle(
        { kind: 'files', paths: ['README.md'] },
        join(storeRoot, 'README.md'),
      ),
    ).toBe(false);
  });

  it('test-run: worktree removed after merge, store report identical: valid', async () => {
    expect(await removedWorktreeLifecycle({ kind: 'test-run', path: 'out.json' }, null)).toBe(true);
  });

  it('test-run: worktree removed after merge, store report tampered: fails', async () => {
    expect(
      await removedWorktreeLifecycle(
        { kind: 'test-run', path: 'out.json' },
        join(storeRoot, 'out.json'),
      ),
    ).toBe(false);
  });

  it('files: absolute store path, verify@store complete@worktree, store tampered: fails', async () => {
    const f = join(storeRoot, 'README.md');
    expect(await filesRoundTrip(f, storeRoot, worktree, f)).toBe(false);
  });

  it('files: relative, verify@store complete@worktree, store tampered: fails', async () => {
    expect(
      await filesRoundTrip('README.md', storeRoot, worktree, join(storeRoot, 'README.md')),
    ).toBe(false);
  });

  it('files: relative, verify@store complete@worktree, only worktree tampered: valid', async () => {
    expect(
      await filesRoundTrip('README.md', storeRoot, worktree, join(worktree, 'README.md')),
    ).toBe(true);
  });

  it('files: relative, verify@worktree complete@store, worktree tampered: fails', async () => {
    expect(
      await filesRoundTrip('README.md', worktree, storeRoot, join(worktree, 'README.md')),
    ).toBe(false);
  });

  it('files: relative, verify@worktree complete@store, only store tampered: valid', async () => {
    expect(
      await filesRoundTrip('README.md', worktree, storeRoot, join(storeRoot, 'README.md')),
    ).toBe(true);
  });

  it('test-run: verify@store complete@worktree, store report tampered: fails', async () => {
    expect(
      await testRunRoundTrip('out.json', storeRoot, worktree, join(storeRoot, 'out.json')),
    ).toBe(false);
  });

  it('test-run: verify@worktree complete@store, worktree report tampered: fails', async () => {
    expect(
      await testRunRoundTrip('out.json', worktree, storeRoot, join(worktree, 'out.json')),
    ).toBe(false);
  });

  it('test-run: absolute store report, verify@worktree, store tampered: fails', async () => {
    const f = join(storeRoot, 'out.json');
    expect(await testRunRoundTrip(f, worktree, worktree, f)).toBe(false);
  });
});
