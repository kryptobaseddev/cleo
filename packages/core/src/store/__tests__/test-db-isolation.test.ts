/**
 * Unit tests for T1906 — assertTestEnv prod-DB write guard.
 *
 * Verifies:
 * - assertTestEnv throws E_PROD_DB_WRITE_IN_TEST when CLEO_TEST_MODE=1
 *   and path is NOT a temp/in-memory path
 * - assertTestEnv allows /tmp/ paths under test mode
 * - assertTestEnv allows :memory: under test mode
 * - assertTestEnv is a no-op when CLEO_TEST_MODE is not set
 * - CLEO_TEST_DB_OVERRIDE=1 suppresses the throw
 *
 * @task T1906
 * @epic T1892
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('assertTestEnv (T1906)', () => {
  let originalTestMode: string | undefined;
  let originalOverride: string | undefined;

  beforeEach(() => {
    originalTestMode = process.env['CLEO_TEST_MODE'];
    originalOverride = process.env['CLEO_TEST_DB_OVERRIDE'];
  });

  afterEach(() => {
    if (originalTestMode === undefined) {
      delete process.env['CLEO_TEST_MODE'];
    } else {
      process.env['CLEO_TEST_MODE'] = originalTestMode;
    }
    if (originalOverride === undefined) {
      delete process.env['CLEO_TEST_DB_OVERRIDE'];
    } else {
      process.env['CLEO_TEST_DB_OVERRIDE'] = originalOverride;
    }
  });

  it('throws E_PROD_DB_WRITE_IN_TEST when CLEO_TEST_MODE=1 and path is production DB', async () => {
    const { assertTestEnv } = await import('../data-accessor.js');
    process.env['CLEO_TEST_MODE'] = '1';
    delete process.env['CLEO_TEST_DB_OVERRIDE'];

    expect(() => {
      assertTestEnv('/mnt/projects/cleocode/.cleo/tasks.db');
    }).toThrow('E_PROD_DB_WRITE_IN_TEST');
  });

  it('does NOT throw for /tmp/ paths under CLEO_TEST_MODE=1', async () => {
    const { assertTestEnv } = await import('../data-accessor.js');
    process.env['CLEO_TEST_MODE'] = '1';

    expect(() => {
      assertTestEnv('/tmp/cleo-test-1234/tasks.db');
    }).not.toThrow();
  });

  it('does NOT throw for :memory: under CLEO_TEST_MODE=1', async () => {
    const { assertTestEnv } = await import('../data-accessor.js');
    process.env['CLEO_TEST_MODE'] = '1';

    expect(() => {
      assertTestEnv(':memory:');
    }).not.toThrow();
  });

  it('is a no-op when CLEO_TEST_MODE is not set', async () => {
    const { assertTestEnv } = await import('../data-accessor.js');
    delete process.env['CLEO_TEST_MODE'];

    // Should not throw even for a production-looking path
    expect(() => {
      assertTestEnv('/mnt/projects/cleocode/.cleo/tasks.db');
    }).not.toThrow();
  });

  it('suppresses throw when CLEO_TEST_DB_OVERRIDE=1', async () => {
    const { assertTestEnv } = await import('../data-accessor.js');
    process.env['CLEO_TEST_MODE'] = '1';
    process.env['CLEO_TEST_DB_OVERRIDE'] = '1';

    expect(() => {
      assertTestEnv('/mnt/projects/cleocode/.cleo/tasks.db');
    }).not.toThrow();
  });
});
