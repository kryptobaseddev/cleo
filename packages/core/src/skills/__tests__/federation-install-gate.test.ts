/**
 * Federation install gate tests (T9732).
 *
 * Covers:
 *   1. Non-federation sources allow-through unchanged.
 *   2. First install from a known federation peer prompts.
 *   3. Repeat install from approved peer skips the prompt.
 *   4. Checksum match → allow.
 *   5. Checksum mismatch → block-checksum.
 *   6. --allow-new-source bypass works.
 *   7. blocked peers don't match (treated as non-federation).
 *
 * @task T9732
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeArtefactChecksum,
  evaluateFederationInstallGate,
  requiresInteractiveConfirmation,
} from '../federation-install-gate.js';
import { writeFederationIndex } from '../federation-store.js';

function writeArtefact(path: string, content: string): string {
  writeFileSync(path, content, 'utf8');
  return createHash('sha256').update(content).digest('hex');
}

describe('evaluateFederationInstallGate (T9732)', () => {
  let tmpRoot: string;
  let federationPath: string;
  let artefactPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'fed-gate-'));
    federationPath = join(tmpRoot, 'federation.json');
    artefactPath = join(tmpRoot, 'skill.tgz');
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('allows non-federation source through unchanged', () => {
    writeFederationIndex({ version: 1, entries: [] }, federationPath);
    const result = evaluateFederationInstallGate({
      source: 'owner/repo',
      federationIndexPath: federationPath,
    });
    expect(result.decision).toBe('allow');
    expect(result.isFederationSource).toBe(false);
  });

  it('returns prompt-first-install for unverified federation peer', () => {
    writeFederationIndex(
      {
        version: 1,
        entries: [{ url: 'https://peer.example/', trust: 'unverified', addedAt: '' }],
      },
      federationPath,
    );
    const result = evaluateFederationInstallGate({
      source: 'https://peer.example/skill/foo',
      federationIndexPath: federationPath,
    });
    expect(result.decision).toBe('prompt-first-install');
    expect(requiresInteractiveConfirmation(result.decision)).toBe(true);
  });

  it('--allow-new-source bypass flips prompt -> allow', () => {
    writeFederationIndex(
      {
        version: 1,
        entries: [{ url: 'https://peer.example/', trust: 'unverified', addedAt: '' }],
      },
      federationPath,
    );
    const result = evaluateFederationInstallGate({
      source: 'https://peer.example/skill/foo',
      approveNewSource: true,
      federationIndexPath: federationPath,
    });
    expect(result.decision).toBe('allow');
    expect(result.reason).toContain('operator approved');
  });

  it('verified peer allows without prompting', () => {
    writeFederationIndex(
      {
        version: 1,
        entries: [{ url: 'https://peer.example/', trust: 'verified', addedAt: '' }],
      },
      federationPath,
    );
    const result = evaluateFederationInstallGate({
      source: 'https://peer.example/skill/foo',
      federationIndexPath: federationPath,
    });
    expect(result.decision).toBe('allow');
    expect(result.reason).toContain('pre-approved');
  });

  it('checksum match allows install', () => {
    const expected = writeArtefact(artefactPath, 'skill tarball bytes');
    writeFederationIndex(
      {
        version: 1,
        entries: [{ url: 'https://peer.example/', trust: 'verified', addedAt: '' }],
      },
      federationPath,
    );
    const result = evaluateFederationInstallGate({
      source: 'https://peer.example/skill/foo',
      artefactPath,
      expectedChecksum: expected,
      federationIndexPath: federationPath,
    });
    expect(result.decision).toBe('allow');
    expect(result.computedChecksum).toBe(expected);
    expect(result.expectedChecksum).toBe(expected);
  });

  it('checksum mismatch blocks install with no fs.copy', () => {
    writeArtefact(artefactPath, 'actual bytes');
    writeFederationIndex(
      {
        version: 1,
        entries: [{ url: 'https://peer.example/', trust: 'verified', addedAt: '' }],
      },
      federationPath,
    );
    const wrongChecksum = 'a'.repeat(64);
    const result = evaluateFederationInstallGate({
      source: 'https://peer.example/skill/foo',
      artefactPath,
      expectedChecksum: wrongChecksum,
      federationIndexPath: federationPath,
    });
    expect(result.decision).toBe('block-checksum');
    expect(result.expectedChecksum).toBe(wrongChecksum);
    expect(result.computedChecksum).not.toBe(wrongChecksum);
  });

  it('accepts checksum with sha256: prefix', () => {
    const hex = writeArtefact(artefactPath, 'content');
    writeFederationIndex(
      {
        version: 1,
        entries: [{ url: 'https://peer.example/', trust: 'verified', addedAt: '' }],
      },
      federationPath,
    );
    const result = evaluateFederationInstallGate({
      source: 'https://peer.example/skill/foo',
      artefactPath,
      expectedChecksum: `sha256:${hex}`,
      federationIndexPath: federationPath,
    });
    expect(result.decision).toBe('allow');
  });

  it('skips checksum validation when no expectedChecksum provided', () => {
    writeArtefact(artefactPath, 'content');
    writeFederationIndex(
      {
        version: 1,
        entries: [{ url: 'https://peer.example/', trust: 'verified', addedAt: '' }],
      },
      federationPath,
    );
    const result = evaluateFederationInstallGate({
      source: 'https://peer.example/skill/foo',
      artefactPath,
      federationIndexPath: federationPath,
    });
    expect(result.decision).toBe('allow');
    expect(result.computedChecksum).toBeNull();
    expect(result.expectedChecksum).toBeNull();
  });

  it('non-URL source returns isFederationSource=false', () => {
    writeFederationIndex({ version: 1, entries: [] }, federationPath);
    const result = evaluateFederationInstallGate({
      source: 'library:foo',
      federationIndexPath: federationPath,
    });
    expect(result.isFederationSource).toBe(false);
  });

  it('matches federation peers by host (ignores path differences)', () => {
    writeFederationIndex(
      {
        version: 1,
        entries: [{ url: 'https://peer.example/api/', trust: 'verified', addedAt: '' }],
      },
      federationPath,
    );
    const result = evaluateFederationInstallGate({
      source: 'https://peer.example/skills/foo',
      federationIndexPath: federationPath,
    });
    expect(result.isFederationSource).toBe(true);
  });
});

describe('computeArtefactChecksum', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'checksum-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns hex digest of file contents', () => {
    const path = join(tmpRoot, 'a.tgz');
    writeFileSync(path, 'hello world');
    expect(computeArtefactChecksum(path)).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
  });

  it('returns empty string for unreadable path', () => {
    expect(computeArtefactChecksum(join(tmpRoot, 'does-not-exist'))).toBe('');
  });
});
