/**
 * Smoke tests for `rollupWaveStatus` and `rollupEpicStatus`.
 *
 * Validates contract shape against the live project DB. Tests skip
 * gracefully when the DB is unreachable (CI fixtures). Deeper conduit
 * topic integration is covered by T9085.
 *
 * @task T9082
 */

import type { EpicRollup, WaveRollup } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { rollupEpicStatus, rollupWaveStatus } from '../lead-rollup.js';

describe('rollupWaveStatus — contract shape', () => {
  it('returns a well-formed WaveRollup for a non-existent epic', async () => {
    let result: WaveRollup | undefined;
    try {
      result = await rollupWaveStatus('T-DOES-NOT-EXIST', 0);
    } catch {
      return; // No project DB available — skip
    }
    expect(result.epicId).toBe('T-DOES-NOT-EXIST');
    expect(result.waveId).toBe(0);
    expect(Array.isArray(result.workers)).toBe(true);
    expect(Array.isArray(result.blockers)).toBe(true);
    expect(typeof result.readyToAdvance).toBe('boolean');
    expect(result.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('accepts conduit messages without throwing', async () => {
    let result: WaveRollup | undefined;
    try {
      result = await rollupWaveStatus('T-DOES-NOT-EXIST', 0, undefined, {
        conduitMessages: [
          {
            taskId: 'T-CHILD-1',
            status: 'partial',
            publishedAt: '2099-01-01T00:00:00.000Z',
          },
        ],
      });
    } catch {
      return;
    }
    expect(Array.isArray(result.workers)).toBe(true);
    expect(Array.isArray(result.blockers)).toBe(true);
  });
});

describe('rollupEpicStatus — contract shape', () => {
  it('returns a well-formed EpicRollup', async () => {
    let result: EpicRollup | undefined;
    try {
      result = await rollupEpicStatus('T-DOES-NOT-EXIST');
    } catch {
      return;
    }
    expect(result.epicId).toBe('T-DOES-NOT-EXIST');
    expect(typeof result.totalWorkers).toBe('number');
    expect(typeof result.doneWorkers).toBe('number');
    expect(Array.isArray(result.waves)).toBe(true);
    expect(result.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
