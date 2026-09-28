/**
 * Pre-destructive checkpoints must finish their SQLite snapshot BEFORE they
 * resolve, so the snapshot never interleaves with the destructive step the
 * caller runs next (e.g. `upgrade.ts` storage migration).
 *
 * The snapshot module is mocked with a deferred promise: the checkpoint
 * function must not resolve until that promise settles, and it must request
 * the gate's `required` mode (not debounced, waits for the lock).
 *
 * @task T12508
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../git-checkpoint.js', () => ({
  gitCheckpoint: vi.fn().mockResolvedValue(undefined),
}));

/** Records the order of events across the mocked snapshot and the caller. */
const events: string[] = [];
const vacuumCalls: Array<{ cwd?: string; mode?: string }> = [];

vi.mock('../sqlite-backup.js', () => ({
  vacuumIntoBackup: vi.fn(async (opts: { cwd?: string; mode?: string }) => {
    vacuumCalls.push(opts);
    events.push('snapshot:start');
    // Yield several macrotasks: a fire-and-forget caller would resolve first.
    await new Promise((r) => setTimeout(r, 30));
    events.push('snapshot:done');
    return { snapshotted: ['tasks'], linked: [], absent: [], failed: [], skipped: null };
  }),
}));

describe('pre-destructive checkpoints await the snapshot (T12508 HIGH-2)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cleo-t12508-order-'));
    events.length = 0;
    vacuumCalls.length = 0;
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('forceCheckpointBeforeOperation resolves only after the snapshot completes', async () => {
    const { forceCheckpointBeforeOperation } = await import('../data-safety-central.js');
    await forceCheckpointBeforeOperation('storage-migration', projectRoot);
    events.push('caller:destructive-step');

    expect(events).toEqual(['snapshot:start', 'snapshot:done', 'caller:destructive-step']);
    expect(vacuumCalls).toHaveLength(1);
    expect(vacuumCalls[0]?.mode).toBe('required');
  });

  it('forceSafetyCheckpoint resolves only after the snapshot completes', async () => {
    const { forceSafetyCheckpoint } = await import('../data-safety-central.js');
    await forceSafetyCheckpoint('pre-bulk-update', projectRoot);
    events.push('caller:destructive-step');

    expect(events).toEqual(['snapshot:start', 'snapshot:done', 'caller:destructive-step']);
    expect(vacuumCalls[0]?.mode).toBe('required');
  });
});
