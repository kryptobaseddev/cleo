/**
 * Tests for assertTestEnv — test-DB isolation guard (T1906 / BBTT-W3-4).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertTestEnv } from '../data-accessor.js';

describe('assertTestEnv (T1906)', () => {
  const origTestMode = process.env['CLEO_TEST_MODE'];
  const origOverride = process.env['CLEO_TEST_DB_OVERRIDE'];

  beforeEach(() => {
    delete process.env['CLEO_TEST_MODE'];
    delete process.env['CLEO_TEST_DB_OVERRIDE'];
  });

  afterEach(() => {
    if (origTestMode === undefined) delete process.env['CLEO_TEST_MODE'];
    else process.env['CLEO_TEST_MODE'] = origTestMode;
    if (origOverride === undefined) delete process.env['CLEO_TEST_DB_OVERRIDE'];
    else process.env['CLEO_TEST_DB_OVERRIDE'] = origOverride;
  });

  it('allows any path when CLEO_TEST_MODE is not set', () => {
    expect(() => assertTestEnv('/home/user/.cleo/tasks.db')).not.toThrow();
  });

  it('allows in-memory DB path in test mode', () => {
    process.env['CLEO_TEST_MODE'] = '1';
    expect(() => assertTestEnv(':memory:')).not.toThrow();
  });

  it('allows /tmp paths in test mode', () => {
    process.env['CLEO_TEST_MODE'] = '1';
    expect(() => assertTestEnv('/tmp/cleo-test-abc/tasks.db')).not.toThrow();
  });

  it('throws when production DB path used in test mode', () => {
    process.env['CLEO_TEST_MODE'] = '1';
    expect(() => assertTestEnv('/home/user/projects/myapp/.cleo/tasks.db')).toThrow(
      'E_PROD_DB_WRITE_IN_TEST',
    );
  });

  it('allows prod path when CLEO_TEST_DB_OVERRIDE=1', () => {
    process.env['CLEO_TEST_MODE'] = '1';
    process.env['CLEO_TEST_DB_OVERRIDE'] = '1';
    expect(() => assertTestEnv('/home/user/projects/myapp/.cleo/tasks.db')).not.toThrow();
  });

  it('throws for brain.db prod path in test mode', () => {
    process.env['CLEO_TEST_MODE'] = '1';
    expect(() => assertTestEnv('/home/user/projects/myapp/.cleo/brain.db')).toThrow(
      'E_PROD_DB_WRITE_IN_TEST',
    );
  });

  it('allows vitest temp paths in test mode', () => {
    process.env['CLEO_TEST_MODE'] = '1';
    expect(() => assertTestEnv('/tmp/vitest-1234/tasks.db')).not.toThrow();
  });
});
