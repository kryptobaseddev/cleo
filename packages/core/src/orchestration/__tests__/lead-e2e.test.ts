/**
 * Lead-tier e2e integration test for the 3-tier orchestration swarm pattern (ADR-070).
 *
 * Verifies:
 *  - A mock Lead (role=orchestrator) with 3 mock workers (role=leaf) can be simulated.
 *  - Worker completion is simulated via pipeline_manifest entries.
 *  - rollupWaveStatus returns 3 workers, 0 blockers, readyToAdvance=true, all verificationPassed.
 *  - rollupEpicStatus returns totalWorkers=3, doneWorkers=3.
 *  - Uses in-memory temp project with real SQLite DBs.
 *
 * @task T9085
 * @adr ADR-070
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pipelineManifestAppend } from '../../memory/pipeline-manifest-sqlite.js';
import type { TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { createTestDb, seedTasks } from '../../store/__tests__/test-db-helper.js';
import { rollupEpicStatus, rollupWaveStatus } from '../lead-rollup.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EPIC_ID = 'T-E2E-EPIC';
const WORKER_IDS = ['T-E2E-1', 'T-E2E-2', 'T-E2E-3'];

function makeManifestEntry(taskId: string): {
  id: string;
  file: string;
  title: string;
  date: string;
  status: string;
  agent_type: string;
  topics: string[];
  key_findings: string[];
  actionable: boolean;
  linked_tasks: string[];
  needs_followup: string[];
} {
  return {
    id: `${taskId}-manifest`,
    file: `out/${taskId}.md`,
    title: `Worker output for ${taskId}`,
    date: new Date().toISOString().slice(0, 10),
    status: 'completed',
    agent_type: 'implementation',
    topics: ['e2e', 'orchestration'],
    key_findings: [`Completed ${taskId}`],
    actionable: false,
    linked_tasks: [taskId],
    needs_followup: [],
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('lead-e2e — 3-tier orchestration swarm pattern (T9085)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();

    // Seed epic + 3 child tasks (status=pending so computeWaves includes them in wave 0)
    await seedTasks(env.accessor, [
      {
        id: EPIC_ID,
        title: 'E2E Epic',
        description: 'Parent epic for e2e swarm test.',
        status: 'pending',
        priority: 'medium',
        type: 'epic',
        size: 'medium',
      },
      {
        id: WORKER_IDS[0],
        title: 'Worker 1',
        description: 'First worker task.',
        status: 'pending',
        priority: 'medium',
        type: 'task',
        size: 'small',
        parentId: EPIC_ID,
        verification: {
          passed: true,
          gates: { implemented: true, testsPassed: true, qaPassed: true },
        },
      },
      {
        id: WORKER_IDS[1],
        title: 'Worker 2',
        description: 'Second worker task.',
        status: 'pending',
        priority: 'medium',
        type: 'task',
        size: 'small',
        parentId: EPIC_ID,
        verification: {
          passed: true,
          gates: { implemented: true, testsPassed: true, qaPassed: true },
        },
      },
      {
        id: WORKER_IDS[2],
        title: 'Worker 3',
        description: 'Third worker task.',
        status: 'pending',
        priority: 'medium',
        type: 'task',
        size: 'small',
        parentId: EPIC_ID,
        verification: {
          passed: true,
          gates: { implemented: true, testsPassed: true, qaPassed: true },
        },
      },
    ]);

    // Write pipeline_manifest entries for each child simulating worker completion
    for (const workerId of WORKER_IDS) {
      const result = await pipelineManifestAppend(makeManifestEntry(workerId), env.tempDir);
      expect(result.success).toBe(true);
    }
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('rollupWaveStatus returns 3 workers, 0 blockers, readyToAdvance=true, all verificationPassed', async () => {
    const wave = await rollupWaveStatus(EPIC_ID, 0, env.tempDir);

    expect(wave.epicId).toBe(EPIC_ID);
    expect(wave.waveId).toBe(0);
    expect(wave.workers).toHaveLength(3);
    expect(wave.blockers).toHaveLength(0);
    expect(wave.readyToAdvance).toBe(true);

    for (const worker of wave.workers) {
      expect(worker.verificationPassed).toBe(true);
      expect(WORKER_IDS).toContain(worker.taskId);
    }
  });

  it('rollupEpicStatus returns totalWorkers=3 and doneWorkers=3', async () => {
    const epic = await rollupEpicStatus(EPIC_ID, env.tempDir);

    expect(epic.epicId).toBe(EPIC_ID);
    expect(epic.totalWorkers).toBe(3);
    expect(epic.doneWorkers).toBe(3);
    expect(epic.waves).toHaveLength(1);
    expect(epic.waves[0]!.workers).toHaveLength(3);
  });

  it('each worker has a linked manifest entry', async () => {
    const wave = await rollupWaveStatus(EPIC_ID, 0, env.tempDir);

    for (const worker of wave.workers) {
      expect(worker.latestManifestEntry).not.toBeNull();
      expect(worker.latestManifestStatus).toBe('completed');
    }
  });
});
