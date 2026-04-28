/**
 * Unit tests for T832 / ADR-051 evidence validators.
 *
 * Covers:
 * - parseEvidence (syntax)
 * - validateAtom for each atom kind
 * - checkGateEvidenceMinimum for each gate
 * - composeGateEvidence canonicalisation
 * - revalidateEvidence staleness detection
 *
 * @task T832
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkGateEvidenceMinimum,
  composeGateEvidence,
  parseEvidence,
  revalidateEvidence,
  validateAtom,
} from '../evidence.js';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString();
}

function initGitRepo(dir: string): void {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'user.email', 'test@example.com']);
}

function gitCommit(dir: string, filename: string, content: string, message: string): string {
  writeFileSync(join(dir, filename), content);
  git(dir, ['add', filename]);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

describe('parseEvidence (T832)', () => {
  it('parses a commit atom', () => {
    const r = parseEvidence('commit:abc1234');
    expect(r.atoms).toEqual([{ kind: 'commit', sha: 'abc1234' }]);
  });

  it('parses multiple atoms separated by semicolon', () => {
    const r = parseEvidence('commit:abc1234;files:a.ts,b.ts;tool:biome');
    expect(r.atoms).toHaveLength(3);
    expect(r.atoms[0]).toEqual({ kind: 'commit', sha: 'abc1234' });
    expect(r.atoms[1]).toEqual({ kind: 'files', paths: ['a.ts', 'b.ts'] });
    expect(r.atoms[2]).toEqual({ kind: 'tool', tool: 'biome' });
  });

  it('rejects empty input', () => {
    expect(() => parseEvidence('')).toThrow(/empty/i);
  });

  it('rejects malformed atoms', () => {
    expect(() => parseEvidence('notanatom')).toThrow(/malformed|kind/i);
  });

  it('rejects unknown kinds', () => {
    expect(() => parseEvidence('bogus:value')).toThrow(/Unknown evidence kind/);
  });

  it('strips empty segments between semicolons', () => {
    const r = parseEvidence(';commit:abc;;note:hi;');
    expect(r.atoms).toHaveLength(2);
  });

  it('parses test-run atoms', () => {
    const r = parseEvidence('test-run:/tmp/out.json');
    expect(r.atoms[0]).toEqual({ kind: 'test-run', path: '/tmp/out.json' });
  });

  it('parses url atoms', () => {
    const r = parseEvidence('url:https://example.com/doc');
    expect(r.atoms[0]).toEqual({ kind: 'url', url: 'https://example.com/doc' });
  });

  it('parses note atoms', () => {
    const r = parseEvidence('note:waiver for scan');
    expect(r.atoms[0]).toEqual({ kind: 'note', note: 'waiver for scan' });
  });
});

describe('validateAtom - files (T832)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'evidence-files-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns sha256 for an existing file', async () => {
    await writeFile(join(tmpDir, 'a.txt'), 'hello\n');
    const r = await validateAtom({ kind: 'files', paths: ['a.txt'] }, tmpDir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.atom.kind).toBe('files');
      if (r.atom.kind === 'files') {
        expect(r.atom.files).toHaveLength(1);
        expect(r.atom.files[0].path).toBe('a.txt');
        expect(r.atom.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it('rejects missing file', async () => {
    const r = await validateAtom({ kind: 'files', paths: ['nope.txt'] }, tmpDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/does not exist/);
  });

  it('rejects empty paths list', async () => {
    const r = await validateAtom({ kind: 'files', paths: [] }, tmpDir);
    expect(r.ok).toBe(false);
  });
});

describe('validateAtom - url, note (T832)', () => {
  it('accepts https url', async () => {
    const r = await validateAtom({ kind: 'url', url: 'https://example.com' }, '/tmp');
    expect(r.ok).toBe(true);
  });

  it('accepts http url', async () => {
    const r = await validateAtom({ kind: 'url', url: 'http://example.com' }, '/tmp');
    expect(r.ok).toBe(true);
  });

  it('rejects non-http url', async () => {
    const r = await validateAtom({ kind: 'url', url: 'ftp://example.com' }, '/tmp');
    expect(r.ok).toBe(false);
  });

  it('accepts short note', async () => {
    const r = await validateAtom({ kind: 'note', note: 'hello' }, '/tmp');
    expect(r.ok).toBe(true);
  });

  it('rejects empty note', async () => {
    const r = await validateAtom({ kind: 'note', note: '' }, '/tmp');
    expect(r.ok).toBe(false);
  });

  it('rejects over-long note', async () => {
    const r = await validateAtom({ kind: 'note', note: 'x'.repeat(513) }, '/tmp');
    expect(r.ok).toBe(false);
  });
});

describe('validateAtom - test-run (T832)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'evidence-testrun-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts a passing vitest JSON', async () => {
    const path = join(tmpDir, 'out.json');
    await writeFile(
      path,
      JSON.stringify({
        numTotalTests: 10,
        numPassedTests: 10,
        numFailedTests: 0,
        numPendingTests: 0,
        testResults: [{ status: 'passed' }],
      }),
    );
    const r = await validateAtom({ kind: 'test-run', path: 'out.json' }, tmpDir);
    expect(r.ok).toBe(true);
    if (r.ok && r.atom.kind === 'test-run') {
      expect(r.atom.passCount).toBe(10);
      expect(r.atom.failCount).toBe(0);
    }
  });

  it('rejects failing test-run', async () => {
    const path = join(tmpDir, 'out.json');
    await writeFile(
      path,
      JSON.stringify({
        numTotalTests: 10,
        numPassedTests: 7,
        numFailedTests: 3,
      }),
    );
    const r = await validateAtom({ kind: 'test-run', path: 'out.json' }, tmpDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codeName).toBe('E_EVIDENCE_TESTS_FAILED');
  });

  it('rejects zero-test runs', async () => {
    const path = join(tmpDir, 'out.json');
    await writeFile(path, JSON.stringify({ numTotalTests: 0, numPassedTests: 0 }));
    const r = await validateAtom({ kind: 'test-run', path: 'out.json' }, tmpDir);
    expect(r.ok).toBe(false);
  });

  it('rejects invalid JSON', async () => {
    const path = join(tmpDir, 'out.json');
    await writeFile(path, 'not json');
    const r = await validateAtom({ kind: 'test-run', path: 'out.json' }, tmpDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not valid JSON/);
  });

  it('rejects missing path', async () => {
    const r = await validateAtom({ kind: 'test-run', path: 'missing.json' }, tmpDir);
    expect(r.ok).toBe(false);
  });
});

describe('validateAtom - tool (T832 / T1534, project-agnostic resolver)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'evidence-tool-'));
    initGitRepo(tmpDir);
    gitCommit(tmpDir, 'a.txt', 'one\n', 'first');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects unknown tool names with E_EVIDENCE_INVALID', async () => {
    writeFileSync(join(tmpDir, 'package.json'), '{}');
    const r = await validateAtom({ kind: 'tool', tool: 'frobnicate' }, tmpDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codeName).toBe('E_EVIDENCE_INVALID');
  });

  it('uses project-context.json testing.command for canonical `test`', async () => {
    // Set up project-context.json that overrides `test` to a passing noop.
    const cleoDir = join(tmpDir, '.cleo');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(cleoDir, { recursive: true });
    writeFileSync(
      join(cleoDir, 'project-context.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        detectedAt: new Date().toISOString(),
        projectTypes: ['node'],
        primaryType: 'node',
        testing: { command: 'true' }, // Always exits 0 — no real toolchain needed.
      }),
    );
    const r = await validateAtom({ kind: 'tool', tool: 'test' }, tmpDir);
    expect(r.ok).toBe(true);
    if (r.ok && r.atom.kind === 'tool') {
      expect(r.atom.tool).toBe('test');
      expect(r.atom.exitCode).toBe(0);
    }
  });

  it('reports tool failure with E_EVIDENCE_TOOL_FAILED when exit != 0', async () => {
    const cleoDir = join(tmpDir, '.cleo');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(cleoDir, { recursive: true });
    writeFileSync(
      join(cleoDir, 'project-context.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        detectedAt: new Date().toISOString(),
        projectTypes: ['node'],
        primaryType: 'node',
        testing: { command: 'false' }, // Always exits 1.
      }),
    );
    const r = await validateAtom({ kind: 'tool', tool: 'test' }, tmpDir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codeName).toBe('E_EVIDENCE_TOOL_FAILED');
    }
  });
});

describe('validateAtom - commit (T832, with git repo)', () => {
  let tmpDir: string;
  let firstSha: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'evidence-git-'));
    initGitRepo(tmpDir);
    firstSha = gitCommit(tmpDir, 'a.txt', 'first\n', 'first');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts a reachable commit', async () => {
    const r = await validateAtom({ kind: 'commit', sha: firstSha }, tmpDir);
    expect(r.ok).toBe(true);
    if (r.ok && r.atom.kind === 'commit') {
      expect(r.atom.sha).toBe(firstSha);
      expect(r.atom.shortSha).toHaveLength(7);
    }
  });

  it('accepts short SHA', async () => {
    const short = firstSha.slice(0, 7);
    const r = await validateAtom({ kind: 'commit', sha: short }, tmpDir);
    expect(r.ok).toBe(true);
  });

  it('rejects non-existent SHA', async () => {
    const r = await validateAtom(
      { kind: 'commit', sha: '0000000000000000000000000000000000000000' },
      tmpDir,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects invalid SHA format', async () => {
    const r = await validateAtom({ kind: 'commit', sha: 'not-a-sha' }, tmpDir);
    expect(r.ok).toBe(false);
  });
});

describe('checkGateEvidenceMinimum (T832)', () => {
  it('implemented gate accepts commit AND files (standard path)', () => {
    expect(
      checkGateEvidenceMinimum('implemented', [
        { kind: 'commit', sha: 'abc', shortSha: 'abc' },
        { kind: 'files', files: [{ path: 'a.ts', sha256: 'x'.repeat(64) }] },
      ]),
    ).toBeNull();

    expect(
      checkGateEvidenceMinimum('implemented', [{ kind: 'commit', sha: 'abc', shortSha: 'abc' }]),
    ).not.toBeNull();

    expect(
      checkGateEvidenceMinimum('implemented', [
        { kind: 'files', files: [{ path: 'a.ts', sha256: 'x'.repeat(64) }] },
      ]),
    ).not.toBeNull();
  });

  it('implemented gate accepts commit AND note (deletion-safe path, T1515)', () => {
    // Deletion tasks have no files to anchor evidence — commit+note is the
    // deletion-safe alternative that does NOT require CLEO_OWNER_OVERRIDE.
    expect(
      checkGateEvidenceMinimum('implemented', [
        { kind: 'commit', sha: 'abc', shortSha: 'abc' },
        { kind: 'note', note: 'deleted packages/legacy/src/old-module.ts' },
      ]),
    ).toBeNull();

    // note alone is NOT sufficient — commit is always required.
    expect(
      checkGateEvidenceMinimum('implemented', [
        { kind: 'note', note: 'deleted packages/legacy/src/old-module.ts' },
      ]),
    ).not.toBeNull();

    // files alone is NOT sufficient — commit is always required.
    expect(
      checkGateEvidenceMinimum('implemented', [
        { kind: 'files', files: [{ path: 'a.ts', sha256: 'x'.repeat(64) }] },
      ]),
    ).not.toBeNull();
  });

  it('testsPassed accepts test-run OR tool', () => {
    expect(
      checkGateEvidenceMinimum('testsPassed', [
        {
          kind: 'test-run',
          path: '/tmp/out.json',
          sha256: 'x'.repeat(64),
          passCount: 10,
          failCount: 0,
          skipCount: 0,
        },
      ]),
    ).toBeNull();

    expect(
      checkGateEvidenceMinimum('testsPassed', [
        { kind: 'tool', tool: 'pnpm-test', exitCode: 0, stdoutTail: '' },
      ]),
    ).toBeNull();

    expect(
      checkGateEvidenceMinimum('testsPassed', [{ kind: 'note', note: 'I promise' }]),
    ).not.toBeNull();
  });

  it('documented accepts files or url', () => {
    expect(
      checkGateEvidenceMinimum('documented', [
        { kind: 'files', files: [{ path: 'README.md', sha256: 'x'.repeat(64) }] },
      ]),
    ).toBeNull();
    expect(
      checkGateEvidenceMinimum('documented', [{ kind: 'url', url: 'https://docs.ex.com' }]),
    ).toBeNull();
  });

  it('cleanupDone accepts a note', () => {
    expect(checkGateEvidenceMinimum('cleanupDone', [{ kind: 'note', note: 'cleaned' }])).toBeNull();
  });
});

describe('composeGateEvidence (T832)', () => {
  it('captures atoms + timestamp + agent', () => {
    const ev = composeGateEvidence([{ kind: 'note', note: 'hi' }], 'opus');
    expect(ev.atoms).toHaveLength(1);
    expect(ev.capturedBy).toBe('opus');
    expect(ev.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ev.override).toBeUndefined();
  });

  it('records override flag', () => {
    const ev = composeGateEvidence(
      [{ kind: 'override', reason: 'emergency' }],
      'owner',
      true,
      'emergency',
    );
    expect(ev.override).toBe(true);
    expect(ev.overrideReason).toBe('emergency');
  });
});

describe('revalidateEvidence (T832)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'evidence-reval-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns stillValid=true when files are unchanged', async () => {
    const path = 'f.txt';
    await writeFile(join(tmpDir, path), 'content');
    // Compute the real sha256 manually.
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update('content').digest('hex');
    const r = await revalidateEvidence(
      {
        atoms: [{ kind: 'files', files: [{ path, sha256: sha }] }],
        capturedAt: new Date().toISOString(),
        capturedBy: 'test',
      },
      tmpDir,
    );
    expect(r.stillValid).toBe(true);
    expect(r.failedAtoms).toHaveLength(0);
  });

  it('returns stillValid=false when a file has been modified', async () => {
    const path = 'f.txt';
    await writeFile(join(tmpDir, path), 'original');
    const { createHash } = await import('node:crypto');
    const originalSha = createHash('sha256').update('original').digest('hex');
    // Modify the file after evidence was captured.
    await writeFile(join(tmpDir, path), 'tampered');
    const r = await revalidateEvidence(
      {
        atoms: [{ kind: 'files', files: [{ path, sha256: originalSha }] }],
        capturedAt: new Date().toISOString(),
        capturedBy: 'test',
      },
      tmpDir,
    );
    expect(r.stillValid).toBe(false);
    expect(r.failedAtoms[0].reason).toMatch(/modified/);
  });

  it('returns stillValid=false when a file has been deleted', async () => {
    const r = await revalidateEvidence(
      {
        atoms: [{ kind: 'files', files: [{ path: 'gone.txt', sha256: 'x'.repeat(64) }] }],
        capturedAt: new Date().toISOString(),
        capturedBy: 'test',
      },
      tmpDir,
    );
    expect(r.stillValid).toBe(false);
  });

  it('override evidence is never re-validated', async () => {
    const r = await revalidateEvidence(
      {
        atoms: [{ kind: 'override', reason: 'emergency' }],
        capturedAt: new Date().toISOString(),
        capturedBy: 'owner',
        override: true,
        overrideReason: 'emergency',
      },
      tmpDir,
    );
    expect(r.stillValid).toBe(true);
  });

  it('notes and urls pass through', async () => {
    const r = await revalidateEvidence(
      {
        atoms: [
          { kind: 'note', note: 'ok' },
          { kind: 'url', url: 'https://x.com' },
        ],
        capturedAt: new Date().toISOString(),
        capturedBy: 'test',
      },
      tmpDir,
    );
    expect(r.stillValid).toBe(true);
  });
});
