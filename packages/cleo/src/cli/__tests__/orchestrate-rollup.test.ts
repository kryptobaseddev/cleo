/**
 * Smoke tests for `cleo orchestrate roll-up` formatter.
 *
 * Validates that {@link formatRollupTable} renders both EpicRollup and
 * WaveRollup shapes correctly, including header columns and a trailing
 * Blockers section.
 *
 * @task T9083
 * @adr ADR-070
 */

import type { EpicRollup, WaveRollup } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { formatRollupTable } from '../commands/orchestrate.js';

const sampleWave: WaveRollup = {
  epicId: 'T9999',
  waveId: 0,
  workers: [
    {
      taskId: 'T1',
      title: 'Sample worker',
      status: 'done',
      gates: { implemented: true, testsPassed: true },
      verificationPassed: true,
      evidence: [],
      latestManifestEntry: 'pm-1',
      latestManifestStatus: 'complete',
      latestManifestAt: '2026-05-06T12:00:00.000Z',
    },
  ],
  blockers: [],
  readyToAdvance: true,
  capturedAt: '2026-05-06T12:00:01.000Z',
};

describe('formatRollupTable', () => {
  it('renders header columns for a WaveRollup', () => {
    const out = formatRollupTable(sampleWave);
    expect(out).toContain('WAVE');
    expect(out).toContain('TASK');
    expect(out).toContain('TITLE');
    expect(out).toContain('STATUS');
    expect(out).toContain('GATES');
    expect(out).toContain('LATEST');
    expect(out).toContain('T1');
    expect(out).toContain('Sample worker');
  });

  it('renders blockers section when present', () => {
    const wave: WaveRollup = {
      ...sampleWave,
      blockers: [{ taskId: 'T2', reason: 'gate-failure', detail: 'Failed: testsPassed' }],
    };
    const out = formatRollupTable(wave);
    expect(out).toContain('Blockers:');
    expect(out).toContain('T2');
    expect(out).toContain('gate-failure');
  });

  it('renders an EpicRollup by iterating over waves', () => {
    const epic: EpicRollup = {
      epicId: 'T9999',
      waves: [sampleWave],
      totalWorkers: 1,
      doneWorkers: 1,
      capturedAt: '2026-05-06T12:00:02.000Z',
    };
    const out = formatRollupTable(epic);
    expect(out).toContain('T1');
    expect(out).toContain('Sample worker');
  });
});
