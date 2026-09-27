/**
 * Portable evidence paths (T12476).
 *
 * New `files:` / `test-run:` atoms persist root-relative paths; legacy
 * absolute atoms re-validate after a project move by rebasing onto the live
 * root — and the sha256 tamper check still decides.
 *
 * @task T12476
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    writeFileSync(join(live, 'a.ts'), 'decoy');
  });
  afterEach(() => rmSync(live, { recursive: true, force: true }));

  it('returns null for relative paths and paths that still exist', () => {
    expect(rebaseLegacyEvidencePath('src/a.ts', [live])).toBeNull();
    expect(rebaseLegacyEvidencePath(join(live, 'src', 'a.ts'), [live])).toBeNull();
  });

  it('uses a recorded former root exactly, even when the tail is gone', () => {
    expect(rebaseLegacyEvidencePath(`${OLD_ROOT}/src/a.ts`, [live], [OLD_ROOT])).toBe('src/a.ts');
    expect(rebaseLegacyEvidencePath(`${OLD_ROOT}/src/gone.ts`, [live], [OLD_ROOT])).toBe(
      'src/gone.ts',
    );
  });

  it('prefers the longest existing tail under the live root', () => {
    // `a.ts` exists at the root too; the longer `src/a.ts` must win.
    expect(rebaseLegacyEvidencePath(`${OLD_ROOT}/src/a.ts`, [live])).toBe('src/a.ts');
  });

  it('returns null when no tail exists under any live root', () => {
    expect(rebaseLegacyEvidencePath(`${OLD_ROOT}/src/missing.ts`, [live])).toBeNull();
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
      path: `${OLD_ROOT}/out.json`,
      sha256: reportSha,
      passCount: 2,
      failCount: 0,
      skipCount: 0,
    };
    const rv = await revalidateEvidence(evidenceOf(atom), live);
    expect(rv.stillValid).toBe(true);
  });

  it('test-run: rebasing never bypasses the tamper check', async () => {
    writeFileSync(join(live, 'out.json'), JSON.stringify({ numTotalTests: 9 }));
    const atom: EvidenceAtom = {
      kind: 'test-run',
      path: `${OLD_ROOT}/out.json`,
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
