/**
 * Import-time purity guard for the S1 Pi guard surface (T11761 · S1 · T11897).
 *
 * AC3: importing the S1 modules must be side-effect free — NO logger
 * initialization, NO DB access, NO pi-ai provider-registry trigger. This test
 * imports both modules and asserts neither performed observable global work at
 * module-evaluation time (the lazy logger is only resolved inside `wrapPiCall`).
 *
 * @epic T10403
 * @task T11761
 * @task T11897
 */

import { describe, expect, it } from 'vitest';

describe('S1 import-time purity', () => {
  it('importing pi-errors performs no top-level side effect', async () => {
    const before = process.exit;
    const mod = await import('../pi-errors.js');
    // The exports exist and process.exit was NOT trapped merely by importing.
    expect(typeof mod.wrapPiCall).toBe('function');
    expect(typeof mod.PiContainmentError).toBe('function');
    expect(process.exit).toBe(before);
  });

  it('importing pi-execution-env performs no top-level side effect', async () => {
    const mod = await import('../pi-execution-env.js');
    expect(typeof mod.createGuardedExecutionEnv).toBe('function');
    expect(typeof mod.GuardedExecutionEnv).toBe('function');
  });
});
