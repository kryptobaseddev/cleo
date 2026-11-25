/**
 * Regression test for `cleo check canon` exit status (T14591).
 *
 * Removing a heading the canon check requires turned its result to
 * `passed:false`, yet the command exited 0, so the CI step never failed.
 * The check now returns an `E_CANON_VIOLATION` error envelope, which the CLI
 * adapter maps to exit 1.
 *
 * @task T14591
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARCHITECTURE_GUIDE_DOC, OPERATION_CONSTITUTION_DOC } from '../paths.js';

const invoking = vi.hoisted(() => ({ root: '' }));

vi.mock('@cleocode/core/core-paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/core/core-paths')>()),
  resolveInvokingCheckout: () => invoking.root,
}));

import { reportRawError } from '../../dispatch/adapters/cli.js';
import { CheckHandler } from '../../dispatch/domains/check.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** Files the canon check reads, copied from the repo into a throwaway root. */
const CANON_INPUTS = [
  'packages/cleo/src/dispatch/types.ts',
  'packages/cleo/src/dispatch/registry.ts',
  ARCHITECTURE_GUIDE_DOC,
  OPERATION_CONSTITUTION_DOC,
];

describe('cleo check canon — exit status (T14591)', () => {
  let savedExitCode: typeof process.exitCode;

  beforeEach(async () => {
    savedExitCode = process.exitCode;
    invoking.root = await mkdtemp(join(tmpdir(), 'cleo-check-canon-'));
    for (const rel of CANON_INPUTS) {
      mkdirSync(dirname(join(invoking.root, rel)), { recursive: true });
      copyFileSync(join(REPO_ROOT, rel), join(invoking.root, rel));
    }
  });

  afterEach(async () => {
    process.exitCode = savedExitCode;
    await rm(invoking.root, { recursive: true, force: true });
  });

  it('passes on the repo docs as they are', async () => {
    const response = await new CheckHandler().query('canon', {});
    expect(response.success).toBe(true);
    expect((response.data as { passed: boolean }).passed).toBe(true);
  });

  it('reports passed:false and exits non-zero when a required heading is removed', async () => {
    const guide = join(invoking.root, ARCHITECTURE_GUIDE_DOC);
    const text = readFileSync(guide, 'utf8');
    expect(text).toContain('## The Six Great Systems');
    writeFileSync(guide, text.replaceAll('Six Great Systems', 'Systems'), 'utf8');

    const response = await new CheckHandler().query('canon', {});

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('E_CANON_VIOLATION');
    const result = (response.error?.details as { result: { passed: boolean } }).result;
    expect(result.passed).toBe(false);
    expect(response.error?.message).toContain('Contains "Six Great Systems"');
    expect(reportRawError(response, { operation: 'check.canon' })).toBe(1);
    expect(process.exitCode).toBe(1);
  });
});
