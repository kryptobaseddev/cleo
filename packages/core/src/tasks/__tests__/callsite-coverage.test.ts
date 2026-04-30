/**
 * Unit tests for the `callsite-coverage` evidence atom (T1605).
 *
 * Covers:
 * - parseEvidence: valid atom, malformed format, empty symbolName, empty path
 * - validateAtom: green path (hit found), no hits, ripgrep excludes test/dist files
 * - checkCallsiteCoverageAtom: missing atom, atom present
 * - hasCallsiteCoverageLabel: present, absent, null/undefined input
 *
 * @task T1605
 */

import crypto from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CALLSITE_COVERAGE_GATE_LABEL,
  hasCallsiteCoverageLabel,
} from '../../verification/evidence-atoms.js';
import { checkCallsiteCoverageAtom, parseEvidence, validateAtom } from '../evidence.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `cleo-callsite-test-${crypto.randomBytes(6).toString('hex')}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/**
 * Write a file relative to `tmpDir` and create parent directories as needed.
 */
async function writeTestFile(relativePath: string, content: string): Promise<void> {
  const abs = join(tmpDir, relativePath);
  await mkdir(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  await writeFile(abs, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// parseEvidence — callsite-coverage syntax
// ---------------------------------------------------------------------------

describe('parseEvidence — callsite-coverage atom (T1605)', () => {
  it('parses a valid callsite-coverage atom', () => {
    const result = parseEvidence('callsite-coverage:myFunction:packages/core/src/myFunction.ts');
    expect(result.atoms).toHaveLength(1);
    expect(result.atoms[0]).toEqual({
      kind: 'callsite-coverage',
      symbolName: 'myFunction',
      relativeSourcePath: 'packages/core/src/myFunction.ts',
    });
  });

  it('parses callsite-coverage combined with other atoms', () => {
    const result = parseEvidence(
      'commit:abc1234;note:wired to production;callsite-coverage:myFn:src/myFn.ts',
    );
    expect(result.atoms).toHaveLength(3);
    const csAtom = result.atoms[2];
    expect(csAtom).toEqual({
      kind: 'callsite-coverage',
      symbolName: 'myFn',
      relativeSourcePath: 'src/myFn.ts',
    });
  });

  it('rejects callsite-coverage with missing relativeSourcePath', () => {
    expect(() => parseEvidence('callsite-coverage:myFn')).toThrow(/callsite-coverage/i);
  });

  it('rejects callsite-coverage with empty symbolName (colon at start)', () => {
    expect(() => parseEvidence('callsite-coverage::src/file.ts')).toThrow(/callsite-coverage/i);
  });

  it('rejects callsite-coverage with empty relativeSourcePath (colon at end)', () => {
    expect(() => parseEvidence('callsite-coverage:myFn:')).toThrow(/callsite-coverage/i);
  });

  it('accepts symbolName with dots (class.method-style paths in source)', () => {
    const result = parseEvidence('callsite-coverage:MyClass:packages/pkg/src/my-class.ts');
    expect(result.atoms[0]).toMatchObject({ kind: 'callsite-coverage', symbolName: 'MyClass' });
  });

  it('unknown atom kinds still throw (regression guard)', () => {
    expect(() => parseEvidence('callsite-coveragee:myFn:src/file.ts')).toThrow(
      /Unknown evidence kind/,
    );
  });
});

// ---------------------------------------------------------------------------
// validateAtom — callsite-coverage validation (uses real filesystem + ripgrep)
// ---------------------------------------------------------------------------

describe('validateAtom — callsite-coverage (T1605)', () => {
  it('passes when a production callsite exists outside the definition file', async () => {
    // Definition file — must NOT count as a callsite.
    await writeTestFile('packages/core/src/my-fn.ts', `export function myFn() { return 42; }\n`);

    // Production callsite — NOT a test file, NOT in dist.
    await writeTestFile(
      'packages/cleo/src/cmd.ts',
      `import { myFn } from '../core/src/my-fn.js';\nmyFn();\n`,
    );

    const result = await validateAtom(
      {
        kind: 'callsite-coverage',
        symbolName: 'myFn',
        relativeSourcePath: 'packages/core/src/my-fn.ts',
      },
      tmpDir,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.atom.kind).toBe('callsite-coverage');
      expect(result.atom.symbolName).toBe('myFn');
      expect(result.atom.hitCount).toBeGreaterThanOrEqual(1);
    }
  });

  it('fails when the only reference is in the definition file itself', async () => {
    // Definition file only — no other references.
    await writeTestFile(
      'packages/core/src/orphan-fn.ts',
      `export function orphanFn() { return 0; }\n`,
    );

    const result = await validateAtom(
      {
        kind: 'callsite-coverage',
        symbolName: 'orphanFn',
        relativeSourcePath: 'packages/core/src/orphan-fn.ts',
      },
      tmpDir,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.codeName).toBe('E_EVIDENCE_INSUFFICIENT');
      expect(result.reason).toMatch(/no production callsite|orphanFn/i);
    }
  });

  it('fails when the only references are in test files (*.test.ts)', async () => {
    await writeTestFile(
      'packages/core/src/my-gate.ts',
      `export function myGate() { return true; }\n`,
    );
    // Only in a test file — should NOT count.
    await writeTestFile(
      'packages/core/src/__tests__/my-gate.test.ts',
      `import { myGate } from '../my-gate.js';\nit('works', () => { myGate(); });\n`,
    );

    const result = await validateAtom(
      {
        kind: 'callsite-coverage',
        symbolName: 'myGate',
        relativeSourcePath: 'packages/core/src/my-gate.ts',
      },
      tmpDir,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.codeName).toBe('E_EVIDENCE_INSUFFICIENT');
    }
  });

  it('fails when the only references are in spec files (*.spec.ts)', async () => {
    await writeTestFile(
      'packages/core/src/my-util.ts',
      `export function myUtil() { return 'ok'; }\n`,
    );
    // Only in a spec file — should NOT count.
    await writeTestFile(
      'packages/core/src/my-util.spec.ts',
      `import { myUtil } from './my-util.js';\nit('ok', () => { myUtil(); });\n`,
    );

    const result = await validateAtom(
      {
        kind: 'callsite-coverage',
        symbolName: 'myUtil',
        relativeSourcePath: 'packages/core/src/my-util.ts',
      },
      tmpDir,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.codeName).toBe('E_EVIDENCE_INSUFFICIENT');
    }
  });

  it('fails when the only references are in dist directories', async () => {
    await writeTestFile(
      'packages/core/src/built-fn.ts',
      `export function builtFn() { return 1; }\n`,
    );
    // Only in a dist file — should NOT count.
    await writeTestFile(
      'packages/core/dist/built-fn.js',
      `"use strict";\nexport function builtFn() { return 1; }\n`,
    );

    const result = await validateAtom(
      {
        kind: 'callsite-coverage',
        symbolName: 'builtFn',
        relativeSourcePath: 'packages/core/src/built-fn.ts',
      },
      tmpDir,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.codeName).toBe('E_EVIDENCE_INSUFFICIENT');
    }
  });

  it('passes when callsite is in production src even with test-file sibling', async () => {
    await writeTestFile('packages/core/src/useful.ts', `export function useful() { return 7; }\n`);
    // Test file — should NOT count.
    await writeTestFile(
      'packages/core/src/__tests__/useful.test.ts',
      `import { useful } from '../useful.js';\nit('x', () => { useful(); });\n`,
    );
    // Production callsite — SHOULD count.
    await writeTestFile(
      'packages/cleo/src/cmd-useful.ts',
      `import { useful } from '@cleocode/core';\nuseful();\n`,
    );

    const result = await validateAtom(
      {
        kind: 'callsite-coverage',
        symbolName: 'useful',
        relativeSourcePath: 'packages/core/src/useful.ts',
      },
      tmpDir,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.atom.hitCount).toBeGreaterThanOrEqual(1);
    }
  });

  it('counts all production hits (multiple callsites)', async () => {
    await writeTestFile('packages/core/src/shared.ts', `export function shared() {}\n`);
    // Two production callers.
    await writeTestFile(
      'packages/cleo/src/caller-a.ts',
      `import { shared } from '../core/src/shared.js';\nshared();\n`,
    );
    await writeTestFile(
      'packages/cleo/src/caller-b.ts',
      `import { shared } from '../core/src/shared.js';\nconst x = shared;\n`,
    );

    const result = await validateAtom(
      {
        kind: 'callsite-coverage',
        symbolName: 'shared',
        relativeSourcePath: 'packages/core/src/shared.ts',
      },
      tmpDir,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // At least 2 hits across 2 files.
      expect(result.atom.hitCount).toBeGreaterThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------
// checkCallsiteCoverageAtom
// ---------------------------------------------------------------------------

describe('checkCallsiteCoverageAtom (T1605)', () => {
  it('returns null when a callsite-coverage atom is present', () => {
    const atoms = [
      {
        kind: 'callsite-coverage' as const,
        symbolName: 'myFn',
        relativeSourcePath: 'packages/core/src/myFn.ts',
        hitCount: 3,
      },
    ];
    expect(checkCallsiteCoverageAtom(atoms)).toBeNull();
  });

  it('returns an error string when no callsite-coverage atom is present', () => {
    const atoms = [
      { kind: 'note' as const, note: 'added function' },
      {
        kind: 'commit' as const,
        sha: 'abc1234abc1234abc1234abc1234abc1234abc1234',
        shortSha: 'abc1234',
      },
    ];
    const result = checkCallsiteCoverageAtom(atoms);
    expect(result).not.toBeNull();
    expect(result).toMatch(/callsite-coverage/i);
  });

  it('returns null when mixed atoms include callsite-coverage', () => {
    const atoms = [
      { kind: 'note' as const, note: 'wired fn' },
      {
        kind: 'callsite-coverage' as const,
        symbolName: 'fn',
        relativeSourcePath: 'src/fn.ts',
        hitCount: 1,
      },
    ];
    expect(checkCallsiteCoverageAtom(atoms)).toBeNull();
  });

  it('returns error string for empty atoms array', () => {
    const result = checkCallsiteCoverageAtom([]);
    expect(result).not.toBeNull();
    expect(result).toMatch(/callsite-coverage/i);
  });
});

// ---------------------------------------------------------------------------
// hasCallsiteCoverageLabel
// ---------------------------------------------------------------------------

describe('hasCallsiteCoverageLabel (T1605)', () => {
  it('returns true when callsite-coverage label is present', () => {
    expect(hasCallsiteCoverageLabel(['foundation', 'callsite-coverage', 't-found-v2'])).toBe(true);
  });

  it('returns true when callsite-coverage is the only label', () => {
    expect(hasCallsiteCoverageLabel(['callsite-coverage'])).toBe(true);
  });

  it('returns false when callsite-coverage label is absent', () => {
    expect(hasCallsiteCoverageLabel(['foundation', 'engine-migration'])).toBe(false);
  });

  it('returns false for empty labels array', () => {
    expect(hasCallsiteCoverageLabel([])).toBe(false);
  });

  it('returns false for null labels', () => {
    expect(hasCallsiteCoverageLabel(null)).toBe(false);
  });

  it('returns false for undefined labels', () => {
    expect(hasCallsiteCoverageLabel(undefined)).toBe(false);
  });

  it('CALLSITE_COVERAGE_GATE_LABEL is the expected string constant', () => {
    expect(CALLSITE_COVERAGE_GATE_LABEL).toBe('callsite-coverage');
  });

  it('does not match partial label strings', () => {
    expect(hasCallsiteCoverageLabel(['callsite', 'coverage', 'callsite-coverages'])).toBe(false);
  });
});
