/**
 * Portable evidence paths (T12476).
 *
 * New `files:` / `test-run:` atoms persist root-relative paths; legacy
 * absolute atoms re-validate after a project move by rebasing onto the live
 * root — and the sha256 tamper check still decides.
 *
 * @task T12476
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceAtom, GateEvidence } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeGateEvidence, revalidateEvidence, validateAtom } from '../evidence.js';
import { rebaseLegacyEvidencePath, toPortableEvidencePath } from '../evidence-paths.js';

const VITEST_JSON = JSON.stringify({
  numTotalTests: 2,
  numPassedTests: 2,
  numFailedTests: 0,
  testResults: [{ status: 'passed' }],
});

/** A path that cannot exist: the "old device" layout. */
const OLD_ROOT = '/nonexistent-t12476/mnt/projects/app';

function evidenceOf(atom: EvidenceAtom): GateEvidence {
  return composeGateEvidence([atom], 'test');
}

describe('toPortableEvidencePath', () => {
  it('keeps relative paths unchanged', () => {
    expect(toPortableEvidencePath('src/a.ts', ['/root'])).toBe('src/a.ts');
  });

  it('relativises an absolute path under the first matching root', () => {
    expect(toPortableEvidencePath('/root/pkg/src/a.ts', ['/root/pkg', '/root'])).toBe('src/a.ts');
    expect(toPortableEvidencePath('/root/other/a.ts', ['/root/pkg', '/root'])).toBe('other/a.ts');
  });

  it('keeps a path outside every root absolute', () => {
    expect(toPortableEvidencePath('/elsewhere/report.json', ['/root'])).toBe(
      '/elsewhere/report.json',
    );
  });

  it('does not treat a sibling with a shared prefix as inside the root', () => {
    expect(toPortableEvidencePath('/root-two/a.ts', ['/root'])).toBe('/root-two/a.ts');
  });

  it('does not relativise the root itself', () => {
    expect(toPortableEvidencePath('/root', ['/root'])).toBe('/root');
  });
});

describe('rebaseLegacyEvidencePath', () => {
  let live: string;
  beforeEach(() => {
    live = mkdtempSync(join(tmpdir(), 'evidence-rebase-'));
    mkdirSync(join(live, 'src'), { recursive: true });
    writeFileSync(join(live, 'src', 'a.ts'), 'a');
    writeFileSync(join(live, 'LICENSE'), 'decoy');
  });
  afterEach(() => rmSync(live, { recursive: true, force: true }));

  it('returns null for relative paths and paths that still exist', () => {
    expect(rebaseLegacyEvidencePath('src/a.ts', [live])).toBeNull();
    expect(rebaseLegacyEvidencePath(join(live, 'src', 'a.ts'), [live])).toBeNull();
  });

  it('rebases through a vanished recorded root', () => {
    expect(rebaseLegacyEvidencePath(`${OLD_ROOT}/src/a.ts`, [live], [OLD_ROOT])).toBe(
      join(live, 'src', 'a.ts'),
    );
  });

  it('a vanished recorded root may rebase a root-level file', () => {
    // The recorded root pins the exact position, so a one-segment tail is safe.
    expect(rebaseLegacyEvidencePath(`${OLD_ROOT}/LICENSE`, [live], [OLD_ROOT])).toBe(
      join(live, 'LICENSE'),
    );
  });

  it('rebases through the longest tail whose former root is gone', () => {
    expect(rebaseLegacyEvidencePath(`${OLD_ROOT}/src/a.ts`, [live])).toBe(
      join(live, 'src', 'a.ts'),
    );
  });

  it('returns null when no tail exists under any live root', () => {
    expect(rebaseLegacyEvidencePath(`${OLD_ROOT}/src/missing.ts`, [live])).toBeNull();
  });

  it('never rebases onto a bare file name', () => {
    // Only a one-segment tail (`LICENSE`) exists under the live root.
    expect(rebaseLegacyEvidencePath(`${OLD_ROOT}/LICENSE`, [live])).toBeNull();
  });

  it('never rebases a file deleted from a project that did not move', () => {
    // The live root still exists, so a missing file is REMOVED, not moved —
    // even though `LICENSE` and `src/a.ts`-shaped tails exist elsewhere.
    const other = mkdtempSync(join(tmpdir(), 'evidence-rebase-other-'));
    try {
      mkdirSync(join(other, 'packages', 'a'), { recursive: true });
      writeFileSync(join(other, 'packages', 'a', 'LICENSE'), 'x');
      mkdirSync(join(live, 'packages', 'a'), { recursive: true });
      const deleted = join(live, 'packages', 'a', 'LICENSE');
      expect(rebaseLegacyEvidencePath(deleted, [other])).toBeNull();
      expect(rebaseLegacyEvidencePath(deleted, [other], [live])).toBeNull();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('rejects traversal segments', () => {
    expect(rebaseLegacyEvidencePath('/gone/root/../../etc/hosts', [live])).toBeNull();
    expect(rebaseLegacyEvidencePath(`${OLD_ROOT}/./src/a.ts`, [live])).toBeNull();
  });

  it('rejects a rebased path whose realpath escapes the live root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'evidence-rebase-outside-'));
    try {
      mkdirSync(join(outside, 'secret'), { recursive: true });
      writeFileSync(join(outside, 'secret', 'key.pem'), 'k');
      symlinkSync(join(outside, 'secret'), join(live, 'secret'));
      expect(rebaseLegacyEvidencePath(`${OLD_ROOT}/secret/key.pem`, [live])).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('new atoms persist root-relative paths', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'evidence-portable-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'out.json'), VITEST_JSON);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('files: stores an absolute input as a relative path', async () => {
    const r = await validateAtom({ kind: 'files', paths: [join(root, 'src', 'a.ts')] }, root);
    expect(r.ok).toBe(true);
    if (r.ok && r.atom.kind === 'files') {
      expect(r.atom.files[0]?.path).toBe('src/a.ts');
    }
  });

  it('test-run: stores an absolute input as a relative path', async () => {
    const r = await validateAtom({ kind: 'test-run', path: join(root, 'out.json') }, root);
    expect(r.ok).toBe(true);
    if (r.ok && r.atom.kind === 'test-run') expect(r.atom.path).toBe('out.json');
  });

  it('test-run: a report outside the project stays absolute', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'evidence-outside-'));
    try {
      const report = join(outside, 'r.json');
      writeFileSync(report, VITEST_JSON);
      const r = await validateAtom({ kind: 'test-run', path: report }, root);
      expect(r.ok).toBe(true);
      if (r.ok && r.atom.kind === 'test-run') expect(r.atom.path).toBe(report);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a relative atom still re-validates after the project moves', async () => {
    const r = await validateAtom({ kind: 'files', paths: ['src/a.ts'] }, root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const moved = mkdtempSync(join(tmpdir(), 'evidence-moved-'));
    try {
      mkdirSync(join(moved, 'src'), { recursive: true });
      writeFileSync(join(moved, 'src', 'a.ts'), 'export const a = 1;\n');
      const rv = await revalidateEvidence(evidenceOf(r.atom), moved);
      expect(rv.stillValid).toBe(true);
    } finally {
      rmSync(moved, { recursive: true, force: true });
    }
  });
});

describe('legacy absolute atoms re-validate by rebasing', () => {
  let live: string;
  let fileSha: string;
  let reportSha: string;
  beforeEach(async () => {
    live = mkdtempSync(join(tmpdir(), 'evidence-legacy-'));
    mkdirSync(join(live, 'src'), { recursive: true });
    writeFileSync(join(live, 'src', 'a.ts'), 'export const a = 1;\n');
    mkdirSync(join(live, 'reports'), { recursive: true });
    writeFileSync(join(live, 'reports', 'out.json'), VITEST_JSON);
    const f = await validateAtom({ kind: 'files', paths: ['src/a.ts'] }, live);
    const t = await validateAtom({ kind: 'test-run', path: 'reports/out.json' }, live);
    if (!f.ok || f.atom.kind !== 'files' || !t.ok || t.atom.kind !== 'test-run') {
      throw new Error('fixture validation failed');
    }
    fileSha = f.atom.files[0]?.sha256 ?? '';
    reportSha = t.atom.sha256;
  });
  afterEach(() => rmSync(live, { recursive: true, force: true }));

  it('files: an old absolute path re-validates against the live root', async () => {
    const atom: EvidenceAtom = {
      kind: 'files',
      files: [{ path: `${OLD_ROOT}/src/a.ts`, sha256: fileSha }],
    };
    const rv = await revalidateEvidence(evidenceOf(atom), live);
    expect(rv.stillValid).toBe(true);
  });

  it('files: rebasing never bypasses the tamper check', async () => {
    writeFileSync(join(live, 'src', 'a.ts'), 'export const a = 2; // tampered\n');
    const atom: EvidenceAtom = {
      kind: 'files',
      files: [{ path: `${OLD_ROOT}/src/a.ts`, sha256: fileSha }],
    };
    const rv = await revalidateEvidence(evidenceOf(atom), live);
    expect(rv.stillValid).toBe(false);
    expect(rv.failedAtoms[0]?.reason).toMatch(/modified since verify/);
  });

  it('files: an old absolute path with no live counterpart is reported removed', async () => {
    const atom: EvidenceAtom = {
      kind: 'files',
      files: [{ path: `${OLD_ROOT}/src/missing.ts`, sha256: fileSha }],
    };
    const rv = await revalidateEvidence(evidenceOf(atom), live);
    expect(rv.stillValid).toBe(false);
    expect(rv.failedAtoms[0]?.reason).toMatch(/removed since verify/);
  });

  it('test-run: an old absolute path re-validates against the live root', async () => {
    const atom: EvidenceAtom = {
      kind: 'test-run',
      path: `${OLD_ROOT}/reports/out.json`,
      sha256: reportSha,
      passCount: 2,
      failCount: 0,
      skipCount: 0,
    };
    const rv = await revalidateEvidence(evidenceOf(atom), live);
    expect(rv.stillValid).toBe(true);
  });

  it('test-run: rebasing never bypasses the tamper check', async () => {
    writeFileSync(join(live, 'reports', 'out.json'), JSON.stringify({ numTotalTests: 9 }));
    const atom: EvidenceAtom = {
      kind: 'test-run',
      path: `${OLD_ROOT}/reports/out.json`,
      sha256: reportSha,
      passCount: 2,
      failCount: 0,
      skipCount: 0,
    };
    const rv = await revalidateEvidence(evidenceOf(atom), live);
    expect(rv.stillValid).toBe(false);
    expect(rv.failedAtoms[0]?.reason).toMatch(/modified since verify/);
  });
});

/**
 * Regression for the independent review of PR #1570: in a worktree layout
 * (execution root != store root), an absolute path under the STORE root must
 * not be re-validated against the worktree's identical copy — tampering with
 * the store file has to be detected.
 */
describe('worktree layout keeps the tamper check on the recorded file', () => {
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
    process.chdir(worktree);
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

  it('files: an absolute store-root path stays absolute and catches tampering', async () => {
    const storeFile = join(storeRoot, 'README.md');
    const r = await validateAtom({ kind: 'files', paths: [storeFile] }, storeRoot);
    expect(r.ok).toBe(true);
    if (!r.ok || r.atom.kind !== 'files') return;
    expect(r.atom.files[0]?.path).toBe(storeFile);

    writeFileSync(storeFile, 'tampered');
    const rv = await revalidateEvidence(evidenceOf(r.atom), storeRoot);
    expect(rv.stillValid).toBe(false);
    expect(rv.failedAtoms[0]?.reason).toMatch(/modified since verify/);
  });

  it('test-run: an absolute store-root report re-validates against the store copy', async () => {
    const storeReport = join(storeRoot, 'out.json');
    const r = await validateAtom({ kind: 'test-run', path: storeReport }, storeRoot);
    expect(r.ok).toBe(true);
    if (!r.ok || r.atom.kind !== 'test-run') return;

    writeFileSync(storeReport, JSON.stringify({ numTotalTests: 9 }));
    const rv = await revalidateEvidence(evidenceOf(r.atom), storeRoot);
    expect(rv.stillValid).toBe(false);
    expect(rv.failedAtoms[0]?.reason).toMatch(/modified since verify/);
  });

  it('test-run: a worktree report stays absolute and catches tampering', async () => {
    const wtReport = join(worktree, 'out.json');
    const r = await validateAtom({ kind: 'test-run', path: wtReport }, storeRoot);
    expect(r.ok).toBe(true);
    if (!r.ok || r.atom.kind !== 'test-run') return;
    expect(r.atom.path).toBe(wtReport);

    writeFileSync(wtReport, JSON.stringify({ numTotalTests: 9 }));
    const rv = await revalidateEvidence(evidenceOf(r.atom), storeRoot);
    expect(rv.stillValid).toBe(false);
  });
});
