import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';

/**
 * Snapshot drift detection test suite (T11210)
 *
 * Strategy: compute a sha256 hash of the source file(s) that feed a snapshot,
 * store the hash alongside the snapshot, and verify on pre-commit that the
 * stored hash matches the current source hash.
 */

const FIXTURES_DIR = join(__dirname, '__fixtures__', 'drift-detection');

function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function hashString(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Detects drift between a source file and its recorded snapshot hash.
 * Returns { drifted: boolean, sourceHash: string, recordedHash?: string }
 */
function detectDrift(
  sourcePath: string,
  snapshotHashPath: string,
): { drifted: boolean; sourceHash: string; recordedHash?: string; message?: string } {
  if (!existsSync(sourcePath)) {
    return { drifted: true, sourceHash: '', message: `Source file missing: ${sourcePath}` };
  }

  const sourceHash = hashFile(sourcePath);

  if (!existsSync(snapshotHashPath)) {
    return {
      drifted: true,
      sourceHash,
      message: `Snapshot hash file missing: ${snapshotHashPath} — snapshots may need regeneration`,
    };
  }

  const recordedHash = readFileSync(snapshotHashPath, 'utf-8').trim();

  if (sourceHash !== recordedHash) {
    return {
      drifted: true,
      sourceHash,
      recordedHash,
      message: `Snapshot drift detected: source hash ${sourceHash} !== recorded hash ${recordedHash}`,
    };
  }

  return { drifted: false, sourceHash, recordedHash };
}

describe('snapshot drift detection (T11210)', () => {
  beforeEach(() => {
    ensureDir(FIXTURES_DIR);
    // Clean up any leftover fixture files
    try {
      rmSync(FIXTURES_DIR, { recursive: true, force: true });
      ensureDir(FIXTURES_DIR);
    } catch { /* ignore */ }
  });

  afterEach(() => {
    try {
      rmSync(FIXTURES_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('reports no drift when source hash matches recorded hash', () => {
    const sourceFile = join(FIXTURES_DIR, 'source.ts');
    const hashFilePath = join(FIXTURES_DIR, 'source.ts.hash');

    writeFileSync(sourceFile, 'export const x = 1;\n');
    writeFileSync(hashFilePath, hashFile(sourceFile));

    const result = detectDrift(sourceFile, hashFilePath);
    expect(result.drifted).toBe(false);
    expect(result.sourceHash).toBeDefined();
    expect(result.recordedHash).toBe(result.sourceHash);
  });

  it('reports drift when source file changes after snapshot', () => {
    const sourceFile = join(FIXTURES_DIR, 'source.ts');
    const hashFilePath = join(FIXTURES_DIR, 'source.ts.hash');

    writeFileSync(sourceFile, 'export const x = 1;\n');
    writeFileSync(hashFilePath, hashFile(sourceFile));

    // Simulate source change (developer edits file)
    writeFileSync(sourceFile, 'export const x = 2;\n');

    const result = detectDrift(sourceFile, hashFilePath);
    expect(result.drifted).toBe(true);
    expect(result.message).toMatch(/drift detected/);
    expect(result.sourceHash).not.toBe(result.recordedHash);
  });

  it('reports drift when snapshot hash file is missing', () => {
    const sourceFile = join(FIXTURES_DIR, 'source.ts');
    const hashFilePath = join(FIXTURES_DIR, 'source.ts.hash');

    writeFileSync(sourceFile, 'export const x = 1;\n');
    // Deliberately do NOT write hash file

    const result = detectDrift(sourceFile, hashFilePath);
    expect(result.drifted).toBe(true);
    expect(result.message).toMatch(/Snapshot hash file missing/);
  });

  it('reports drift when source file is missing', () => {
    const sourceFile = join(FIXTURES_DIR, 'missing.ts');
    const hashFilePath = join(FIXTURES_DIR, 'missing.ts.hash');

    writeFileSync(hashFilePath, 'deadbeef');

    const result = detectDrift(sourceFile, hashFilePath);
    expect(result.drifted).toBe(true);
    expect(result.message).toMatch(/Source file missing/);
  });

  it('handles multiple source files in a registry (operations-registry pattern)', () => {
    // The real operations-registry.ts depends on operation-def.ts and docs.ts
    // We simulate a multi-source snapshot where the hash is a composite.
    const sourceA = join(FIXTURES_DIR, 'operation-def.ts');
    const sourceB = join(FIXTURES_DIR, 'docs.ts');
    const hashFilePath = join(FIXTURES_DIR, 'composite.hash');

    writeFileSync(sourceA, 'export interface Op { name: string }\n');
    writeFileSync(sourceB, 'export const STATUSES = ["draft"]\n');

    const compositeHash = hashString(
      readFileSync(sourceA, 'utf-8') + readFileSync(sourceB, 'utf-8'),
    );
    writeFileSync(hashFilePath, compositeHash);

    // Verify composite hash matches
    const currentComposite = hashString(
      readFileSync(sourceA, 'utf-8') + readFileSync(sourceB, 'utf-8'),
    );
    expect(currentComposite).toBe(compositeHash);

    // Change one dependency → composite hash changes
    writeFileSync(sourceB, 'export const STATUSES = ["draft", "published"]\n');
    const newComposite = hashString(
      readFileSync(sourceA, 'utf-8') + readFileSync(sourceB, 'utf-8'),
    );
    expect(newComposite).not.toBe(compositeHash);
  });

  it('can regenerate hash file (simulating snapshot update)', () => {
    const sourceFile = join(FIXTURES_DIR, 'source.ts');
    const hashFilePath = join(FIXTURES_DIR, 'source.ts.hash');

    writeFileSync(sourceFile, 'export const x = 1;\n');
    writeFileSync(hashFilePath, hashFile(sourceFile));

    // Source changes
    writeFileSync(sourceFile, 'export const x = 2;\n');
    expect(detectDrift(sourceFile, hashFilePath).drifted).toBe(true);

    // Regenerate hash (developer runs snapshot update)
    writeFileSync(hashFilePath, hashFile(sourceFile));
    expect(detectDrift(sourceFile, hashFilePath).drifted).toBe(false);
  });
});
