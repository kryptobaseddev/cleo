/**
 * `checkCanonicalRcasdPaths` actually inspects the filesystem (T12704).
 *
 * Both sub-checks called a bare `require('node:fs')`, which throws in the
 * shipped ESM build inside a swallowing `try`, so the check always passed.
 * vitest supplies a `require`, so this test pins the behaviour; the regression
 * itself is caught by arch gate 31 (`scripts/lint-no-esm-bare-require.mjs`).
 *
 * @task T12704
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkCanonicalRcasdPaths } from '../checks.js';

describe('checkCanonicalRcasdPaths', () => {
  let root: string;

  beforeEach(() => {
    // The harness pins CLEO_ROOT/CLEO_DIR to its sandbox; resolve from `root`.
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    root = mkdtempSync(join(tmpdir(), 'rcasd-paths-'));
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, '.cleo', 'rcasd'), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('passes a canonical layout', () => {
    expect(checkCanonicalRcasdPaths(root).status).toBe('passed');
  });

  it('flags a deprecated flat directory with files', () => {
    mkdirSync(join(root, '.cleo', 'research'));
    writeFileSync(join(root, '.cleo', 'research', 'a.md'), 'x');
    const result = checkCanonicalRcasdPaths(root);
    expect(result.status).toBe('warning');
    expect(result.message).toContain('deprecated .cleo/research/');
  });

  it('flags a markdown file at the rcasd root', () => {
    writeFileSync(join(root, '.cleo', 'rcasd', 'audit-1.md'), 'x');
    const result = checkCanonicalRcasdPaths(root);
    expect(result.status).toBe('warning');
    expect(result.message).toContain('misplaced .md files in .cleo/rcasd/');
  });
});
