/**
 * Round-trip guard for the daemon health contracts (T11366 AC5).
 *
 * Proves a {@link HealthStatus} aggregate projects onto the FROZEN
 * `supervisor-ipc` {@link MonitorResponseSchema} shape **without a lossy cast**:
 * `toMonitorChildren` yields rows that validate against the supervisor's own
 * `MonitorResponse.children` schema, and a `monitor` response carrying them
 * round-trips through `MonitorResponseSchema.parse`.
 *
 * @task T11366
 */

import {
  type HealthStatus,
  MonitorResponseSchema,
  type SubsystemHealth,
  SubsystemHealthSchema,
  summarizeHealth,
  toMonitorChildren,
} from '../../index.js';

import { describe, expect, it } from 'vitest';

describe('daemon HealthStatus ↔ supervisor-ipc MonitorResponse (T11366)', () => {
  const rows: SubsystemHealth[] = [
    { child_id: 'studio', pid: 4242, state: 'running', restart_count: 0 },
    {
      child_id: 'gc-cron',
      pid: 0,
      state: 'stopped',
      restart_count: 2,
      detail: 'awaiting next scheduled run',
    },
  ];

  it('summarizeHealth computes allHealthy from row states', () => {
    expect(summarizeHealth(rows).allHealthy).toBe(false);
    expect(
      summarizeHealth([{ child_id: 'studio', pid: 1, state: 'running', restart_count: 0 }])
        .allHealthy,
    ).toBe(true);
  });

  it('toMonitorChildren projects onto MonitorResponse.children without lossy casts', () => {
    const health: HealthStatus = summarizeHealth(rows);
    const children = toMonitorChildren(health);

    // Each projected row must validate against the FROZEN supervisor schema.
    const monitor = {
      kind: 'monitor' as const,
      children,
    };
    const parsed = MonitorResponseSchema.safeParse(monitor);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.children).toHaveLength(2);
      // The daemon-only `detail` field is stripped on projection.
      expect(parsed.data.children[1]).not.toHaveProperty('detail');
      expect(parsed.data.children[0]?.child_id).toBe('studio');
    }
  });

  it('a SubsystemHealth row is a structural superset of a supervisor ChildStatus', () => {
    // Validating with the daemon schema accepts the supervisor fields verbatim.
    const row = SubsystemHealthSchema.parse({
      child_id: 'web',
      pid: 9000,
      state: 'running',
      restart_count: 0,
    });
    expect(row.child_id).toBe('web');
    // detail is optional and absent here.
    expect(row.detail).toBeUndefined();
  });

  it('rejects a health row with a state outside the frozen ChildState enum', () => {
    const bad = SubsystemHealthSchema.safeParse({
      child_id: 'x',
      pid: 0,
      state: 'paused',
      restart_count: 0,
    });
    expect(bad.success).toBe(false);
  });
});
