/**
 * T14201 — `cleo verify` and `cleo complete` attached the FULL repo-wide
 * knowledge-coverage assessment to every envelope: thousands of per-file
 * reasons (8,385 on this repository, ~330k tokens measured by axiom). They now
 * carry the bounded summary orientation already uses; `cleo doctor knowledge`
 * keeps the full report.
 *
 * @task T14201
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgeCoverage } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { validateGateVerify } from '../../validation/engine-ops.js';
import { completeTask } from '../complete.js';

/** Thousands of reasons and evidence refs, as a stale repo-wide index reports (hoisted with vi.mock). */
const { REASONS } = vi.hoisted(() => ({ REASONS: 5000 }));

vi.mock('../../nexus/knowledge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../nexus/knowledge.js')>();
  const huge: KnowledgeCoverage = {
    status: 'failed',
    maintenanceState: 'pending',
    nextAction: 'cleo doctor knowledge',
    projectId: 'p-t14201',
    assessedRevision: null,
    indexedRevision: null,
    assessedAt: '2026-11-02T00:00:00.000Z',
    reasons: Array.from(
      { length: REASONS },
      (_, i) => `src/file-${i}.ts: unresolved reference ${'x'.repeat(60)}`,
    ),
    evidence: Array.from({ length: REASONS }, (_, i) => ({
      id: `src/file-${i}.ts`,
      projectId: 'p-t14201',
      source: 'file' as const,
      revision: null,
      precision: 'file' as const,
      excerpt: 'y'.repeat(200),
    })),
    limitations: Array.from({ length: 50 }, (_, i) => `limitation ${i}`),
  };
  return { ...actual, assessKnowledgeCoverage: vi.fn(async () => huge) };
});

/** Bytes an envelope's `data` may take with that coverage attached. */
const BUDGET_BYTES = 16 * 1024;

describe('T14201: verify and complete carry a bounded knowledge-coverage summary', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    process.env['CLEO_DIR'] = env.cleoDir;
    await writeFile(
      join(env.cleoDir, 'config.json'),
      JSON.stringify({
        enforcement: { session: { requiredForMutate: false }, acceptance: { mode: 'off' } },
        lifecycle: { mode: 'off' },
        verification: { enabled: false },
      }),
    );
    await seedTasks(env.accessor, [
      { id: 'T001', title: 'Budget', status: 'pending', priority: 'medium' },
    ]);
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  /** The summary keeps status, next step and the true count, with a few samples. */
  function expectSummary(coverage: KnowledgeCoverage | undefined): void {
    expect(coverage).toMatchObject({
      status: 'failed',
      maintenanceState: 'pending',
      nextAction: 'cleo doctor knowledge',
      reasonCount: REASONS,
      evidenceCount: REASONS,
      detailsCommand: 'cleo doctor knowledge',
    });
    expect(coverage?.reasons.length).toBeLessThanOrEqual(2);
    expect(coverage?.evidence.length).toBeLessThanOrEqual(1);
  }

  it('cleo verify stays under the byte budget', async () => {
    const verified = await validateGateVerify(env.tempDir, {
      taskId: 'T001',
      gate: 'cleanupDone',
      evidence: 'note:T14201 budget fixture',
    });
    if (!verified.success) throw new Error(verified.error.message);
    expectSummary(verified.data.knowledgeCoverage);
    expect(Buffer.byteLength(JSON.stringify(verified.data))).toBeLessThan(BUDGET_BYTES);
  });

  it('cleo complete stays under the byte budget, including the already-done reply', async () => {
    const completed = await completeTask({ taskId: 'T001' }, env.tempDir, env.accessor);
    expectSummary(completed.knowledgeCoverage);
    expect(Buffer.byteLength(JSON.stringify(completed))).toBeLessThan(BUDGET_BYTES);
    const again = await completeTask({ taskId: 'T001' }, env.tempDir, env.accessor);
    expectSummary(again.knowledgeCoverage);
    expect(Buffer.byteLength(JSON.stringify(again))).toBeLessThan(BUDGET_BYTES);
  });
});
