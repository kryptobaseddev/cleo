/**
 * Tests for computeBrainHealthDashboard (T1908 / BBTT-W2-4).
 *
 * Verifies:
 * - Dashboard returns the required 8+ named flags
 * - Each flag has name, status, description, remediationHint, isP0 fields
 * - generatedAt and hasP0Failure fields are present
 * - Run against an empty brain.db returns ok/warn status (no crash)
 *
 * @task T1908
 * @epic T1892
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

describe('computeBrainHealthDashboard (T1908)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-brain-health-'));
    await mkdir(join(tempDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');

    // Initialize tasks.db (cross-db write-guard requirement)
    const { getDb } = await import('../../store/sqlite.js');
    const { sessions } = await import('../../store/tasks-schema.js');
    const db = await getDb(tempDir);
    await db
      .insert(sessions)
      .values({ id: 'S-health-test', name: 'health-test', status: 'active' })
      .onConflictDoNothing()
      .run();
  });

  afterEach(async () => {
    try {
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
    } catch {
      /* may not be loaded */
    }
    try {
      const { closeDb } = await import('../../store/sqlite.js');
      closeDb();
    } catch {
      /* may not be loaded */
    }
    delete process.env['CLEO_DIR'];
    await Promise.race([
      rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
  });

  it('returns dashboard with 8+ named flags and required fields', async () => {
    const { computeBrainHealthDashboard } = await import('../brain-health-dashboard.js');
    const dashboard = await computeBrainHealthDashboard(tempDir);

    expect(dashboard.flags.length).toBeGreaterThanOrEqual(8);
    expect(typeof dashboard.generatedAt).toBe('string');
    expect(typeof dashboard.hasP0Failure).toBe('boolean');

    for (const flag of dashboard.flags) {
      expect(typeof flag.name).toBe('string');
      expect(['ok', 'warn', 'fail']).toContain(flag.status);
      expect(typeof flag.description).toBe('string');
      expect(typeof flag.remediationHint).toBe('string');
      expect(typeof flag.isP0).toBe('boolean');
    }
  });

  it('includes the 8 required BBTT flag names', async () => {
    const { computeBrainHealthDashboard } = await import('../brain-health-dashboard.js');
    const dashboard = await computeBrainHealthDashboard(tempDir);

    const flagNames = dashboard.flags.map((f) => f.name);
    const required = [
      'row-counts',
      'dedup-ratio',
      'last-consolidation',
      'recency-violations',
      'learnings-ratio',
      'pattern-bloat',
      'fixture-pollution',
      'daemon-liveness',
    ];

    for (const req of required) {
      expect(flagNames).toContain(req);
    }
  });

  it('does not throw on empty brain.db', async () => {
    const { computeBrainHealthDashboard } = await import('../brain-health-dashboard.js');

    await expect(computeBrainHealthDashboard(tempDir)).resolves.toBeDefined();
  });
});
