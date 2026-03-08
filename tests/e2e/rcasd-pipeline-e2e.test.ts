/**
 * RCASD Pipeline E2E Test - T4912
 *
 * End-to-end test exercising the full RCASD lifecycle pipeline functions
 * with real SQLite database integration.
 *
 * Test Coverage:
 * 1. All 8 pipeline functions against real in-memory SQLite DB
 * 2. Round-trip test (initializePipeline → advanceStage → getPipeline)
 * 3. Stage names match CHECK constraint validation
 * 4. getCurrentStage returns non-null data (required for session.briefing)
 * 5. Stage progression through all 9 stages
 *
 * @task T4912
 * @epic T4798
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Stage } from '../../src/core/lifecycle/stages.js';
import { PIPELINE_STAGES } from '../../src/core/lifecycle/stages.js';
// Import stage definitions to verify against CHECK constraint
import { LIFECYCLE_STAGE_NAMES } from '../../src/store/schema.js';

let testDir: string;
let cleoDir: string;

// Dynamically imported modules (must import after setting CLEO_DIR)
let pipelineModule: typeof import('../../src/core/lifecycle/pipeline.js');
let sqliteModule: typeof import('../../src/store/sqlite.js');

/**
 * Helper: insert a stub task row to satisfy the FK constraint
 * on lifecycle_pipelines.task_id → tasks.id.
 */
/**
 * Insert a stub task row to satisfy FK constraint lifecycle_pipelines.task_id → tasks.id.
 */
async function insertStubTask(taskId: string): Promise<void> {
  const db = await sqliteModule.getDb();
  const { tasks } = await import('../../src/store/schema.js');
  await db.insert(tasks).values({
    id: taskId,
    title: `Stub task ${taskId}`,
    status: 'pending',
    priority: 'medium',
    type: 'subtask',
    position: 1,
    positionVersion: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Wrapper: create stub task then initialize pipeline.
 * Satisfies the FK constraint automatically.
 */
async function initPipeline(
  taskId: string,
  opts?: Parameters<typeof pipelineModule.initializePipeline>[1],
) {
  await insertStubTask(taskId);
  return pipelineModule.initializePipeline(taskId, opts);
}

describe('RCASD Pipeline E2E Tests (T4912)', () => {
  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'cleo-pipeline-e2e-'));
    cleoDir = join(testDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;

    // Dynamically import modules after setting CLEO_DIR
    pipelineModule = await import('../../src/core/lifecycle/pipeline.js');
    sqliteModule = await import('../../src/store/sqlite.js');
  });

  afterEach(async () => {
    if (sqliteModule) {
      sqliteModule.closeDb();
    }
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  // =============================================================================
  // STAGE NAMES MATCH CHECK CONSTRAINT
  // =============================================================================

  describe('stage names match DB CHECK constraint', () => {
    it('should use canonical stage names from schema', () => {
      // Verify that the stage names we use match the CHECK constraint
      const expectedStages = [
        'research',
        'consensus',
        'architecture_decision',
        'specification',
        'decomposition',
        'implementation',
        'validation',
        'testing',
        'release',
      ];

      expect(PIPELINE_STAGES).toEqual(expectedStages);

      // Verify all pipeline stages are in the schema's allowed values
      for (const stage of PIPELINE_STAGES) {
        expect(LIFECYCLE_STAGE_NAMES).toContain(stage);
      }
    });

    it('should create stages with valid stage names', async () => {
      const taskId = 'T4912-001';

      await initPipeline(taskId);

      const stages = await pipelineModule.getPipelineStages(taskId);

      // Verify all 9 stages were created
      expect(stages).toHaveLength(9);

      // Verify each stage name is valid
      const stageNames = stages.map((s) => s.stage);
      for (const name of stageNames) {
        expect(LIFECYCLE_STAGE_NAMES).toContain(name);
      }

      // Verify stage order
      expect(stageNames).toEqual([
        'research',
        'consensus',
        'architecture_decision',
        'specification',
        'decomposition',
        'implementation',
        'validation',
        'testing',
        'release',
      ]);
    });
  });

  // =============================================================================
  // ROUND-TRIP TEST
  // =============================================================================

  describe('round-trip: initialize → advance → get', () => {
    it('should initialize pipeline and retrieve it', async () => {
      const taskId = 'T4912-002';

      // Initialize
      const created = await initPipeline(taskId, {
        startStage: 'research',
      });

      expect(created.id).toBe(taskId);
      expect(created.currentStage).toBe('research');
      expect(created.status).toBe('active');
      expect(created.isActive).toBe(true);
      expect(created.transitionCount).toBe(0);

      // Retrieve
      const retrieved = await pipelineModule.getPipeline(taskId);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(taskId);
      expect(retrieved!.currentStage).toBe('research');
      expect(retrieved!.status).toBe('active');
    });

    it('should advance stage and reflect in getPipeline', async () => {
      const taskId = 'T4912-003';

      // Initialize
      await initPipeline(taskId);

      // Advance
      await pipelineModule.advanceStage(taskId, {
        toStage: 'consensus',
        initiatedBy: 'test-agent',
        reason: 'Research complete',
      });

      // Verify with getPipeline
      const pipeline = await pipelineModule.getPipeline(taskId);

      expect(pipeline).not.toBeNull();
      expect(pipeline!.currentStage).toBe('consensus');
      expect(pipeline!.transitionCount).toBe(1);
    });

    it('should complete full round-trip through all stages', async () => {
      const taskId = 'T4912-004';

      // Initialize
      await initPipeline(taskId);

      const stageFlow: Stage[] = [
        'consensus',
        'architecture_decision',
        'specification',
        'decomposition',
        'implementation',
        'validation',
        'testing',
        'release',
      ];

      // Advance through all stages
      for (const stage of stageFlow) {
        await pipelineModule.advanceStage(taskId, {
          toStage: stage,
          initiatedBy: 'test-agent',
          reason: `Advancing to ${stage}`,
        });

        // Verify after each advance
        const current = await pipelineModule.getCurrentStage(taskId);
        expect(current).toBe(stage);
      }

      // Complete the pipeline
      await pipelineModule.completePipeline(taskId, 'All stages completed successfully');

      // Verify completion
      const completed = await pipelineModule.getPipeline(taskId);
      expect(completed).not.toBeNull();
      expect(completed!.status).toBe('completed');
      expect(completed!.isActive).toBe(false);
      expect(completed!.transitionCount).toBe(8); // 8 transitions to get to release
    });
  });

  // =============================================================================
  // ALL 8 FUNCTIONS TESTED
  // =============================================================================

  describe('all 8 pipeline functions', () => {
    it('should test initializePipeline', async () => {
      const taskId = 'T4912-005';

      const pipeline = await initPipeline(taskId, {
        startStage: 'research',
        assignedAgent: 'test-agent',
      });

      expect(pipeline.id).toBe(taskId);
      expect(pipeline.currentStage).toBe('research');
      expect(pipeline.status).toBe('active');
      expect(pipeline.version).toBe(1);
    });

    it('should test getPipeline', async () => {
      const taskId = 'T4912-006';

      // Returns null for non-existent
      const nonExistent = await pipelineModule.getPipeline(taskId);
      expect(nonExistent).toBeNull();

      // Returns pipeline after initialization
      await initPipeline(taskId);
      const existing = await pipelineModule.getPipeline(taskId);

      expect(existing).not.toBeNull();
      expect(existing!.id).toBe(taskId);
    });

    it('should test advanceStage', async () => {
      const taskId = 'T4912-007';

      await initPipeline(taskId);

      await pipelineModule.advanceStage(taskId, {
        toStage: 'consensus',
        initiatedBy: 'test-agent',
        reason: 'Research completed',
      });

      const pipeline = await pipelineModule.getPipeline(taskId);
      expect(pipeline!.currentStage).toBe('consensus');
    });

    it('should test getCurrentStage', async () => {
      const taskId = 'T4912-008';

      await initPipeline(taskId);

      // Returns non-null data (required for session.briefing)
      const currentStage = await pipelineModule.getCurrentStage(taskId);

      expect(currentStage).toBeDefined();
      expect(currentStage).not.toBeNull();
      expect(typeof currentStage).toBe('string');
      expect(currentStage).toBe('research');
    });

    it('should test listPipelines', async () => {
      // Create multiple pipelines
      await initPipeline('T4912-009A');
      await initPipeline('T4912-009B');
      await initPipeline('T4912-009C');

      // List all
      const all = await pipelineModule.listPipelines();
      expect(all.length).toBeGreaterThanOrEqual(3);

      // List with limit
      const limited = await pipelineModule.listPipelines({ limit: 2 });
      expect(limited.length).toBeLessThanOrEqual(2);

      // List by status
      const active = await pipelineModule.listPipelines({ status: 'active' });
      expect(active.every((p) => p.status === 'active')).toBe(true);
    });

    it('should test completePipeline', async () => {
      const taskId = 'T4912-010';

      await initPipeline(taskId);

      // Advance to release stage
      const stages: Stage[] = [
        'consensus',
        'architecture_decision',
        'specification',
        'decomposition',
        'implementation',
        'validation',
        'testing',
        'release',
      ];

      for (const stage of stages) {
        await pipelineModule.advanceStage(taskId, {
          toStage: stage,
          initiatedBy: 'test-agent',
        });
      }

      // Complete
      await pipelineModule.completePipeline(taskId, 'All done!');

      const completed = await pipelineModule.getPipeline(taskId);
      expect(completed!.status).toBe('completed');
      expect(completed!.completedAt).toBeDefined();
    });

    it('should test cancelPipeline', async () => {
      const taskId = 'T4912-011';

      await initPipeline(taskId);

      await pipelineModule.cancelPipeline(taskId, 'Testing cancellation');

      const cancelled = await pipelineModule.getPipeline(taskId);
      expect(cancelled!.status).toBe('cancelled');
      expect(cancelled!.isActive).toBe(false);
    });

    it('should test getPipelineStatistics', async () => {
      // Create some test data
      await initPipeline('T4912-012A');
      await initPipeline('T4912-012B');
      const taskIdC = 'T4912-012C';
      await initPipeline(taskIdC);
      await pipelineModule.cancelPipeline(taskIdC, 'Test cancellation');

      const stats = await pipelineModule.getPipelineStatistics();

      expect(stats.total).toBeGreaterThanOrEqual(3);
      expect(stats.byStatus.active).toBeGreaterThanOrEqual(2);
      expect(stats.byStatus.cancelled).toBeGreaterThanOrEqual(1);
      expect(stats.byStage.research).toBeGreaterThanOrEqual(3);
    });
  });

  // =============================================================================
  // GETCURRENTSTAGE NON-NULL VALIDATION
  // =============================================================================

  describe('getCurrentStage returns non-null (session.briefing requirement)', () => {
    it('should always return a valid stage string', async () => {
      const taskId = 'T4912-013';

      await initPipeline(taskId);

      // This is critical for session.briefing - must return non-null
      const stage = await pipelineModule.getCurrentStage(taskId);

      expect(stage).toBeTruthy();
      expect(typeof stage).toBe('string');
      expect(stage.length).toBeGreaterThan(0);

      // Verify it's a valid stage name
      expect(PIPELINE_STAGES).toContain(stage);
    });

    it('should return correct stage after each advancement', async () => {
      const taskId = 'T4912-014';

      await initPipeline(taskId, { startStage: 'research' });
      expect(await pipelineModule.getCurrentStage(taskId)).toBe('research');

      await pipelineModule.advanceStage(taskId, { toStage: 'consensus', initiatedBy: 'agent' });
      expect(await pipelineModule.getCurrentStage(taskId)).toBe('consensus');

      await pipelineModule.advanceStage(taskId, {
        toStage: 'architecture_decision',
        initiatedBy: 'agent',
      });
      expect(await pipelineModule.getCurrentStage(taskId)).toBe('architecture_decision');

      await pipelineModule.advanceStage(taskId, { toStage: 'specification', initiatedBy: 'agent' });
      expect(await pipelineModule.getCurrentStage(taskId)).toBe('specification');
    });

    it('should throw NOT_FOUND for non-existent pipeline', async () => {
      await expect(pipelineModule.getCurrentStage('T4912-NONEXISTENT')).rejects.toThrow(
        'No pipeline found',
      );
    });
  });

  // =============================================================================
  // ERROR HANDLING
  // =============================================================================

  describe('error handling', () => {
    it('should throw when initializing duplicate pipeline', async () => {
      const taskId = 'T4912-015';

      await initPipeline(taskId);

      await expect(pipelineModule.initializePipeline(taskId)).rejects.toThrow('already exists');
    });

    it('should throw when advancing non-existent pipeline', async () => {
      await expect(
        pipelineModule.advanceStage('T4912-NONEXISTENT', {
          toStage: 'consensus',
          initiatedBy: 'agent',
        }),
      ).rejects.toThrow('No pipeline found');
    });

    it('should throw when advancing without toStage', async () => {
      const taskId = 'T4912-016';
      await initPipeline(taskId);

      await expect(
        pipelineModule.advanceStage(taskId, { initiatedBy: 'agent' } as any),
      ).rejects.toThrow('target stage');
    });

    it('should throw when advancing without initiatedBy', async () => {
      const taskId = 'T4912-017';
      await initPipeline(taskId);

      await expect(
        pipelineModule.advanceStage(taskId, { toStage: 'consensus' } as any),
      ).rejects.toThrow('initiatedBy');
    });

    it('should throw when cancelling non-existent pipeline', async () => {
      await expect(pipelineModule.cancelPipeline('T4912-NONEXISTENT', 'reason')).rejects.toThrow(
        'No pipeline found',
      );
    });

    it('should throw when cancelling completed pipeline', async () => {
      const taskId = 'T4912-018';
      await initPipeline(taskId);

      // Advance to release
      const stages: Stage[] = [
        'consensus',
        'architecture_decision',
        'specification',
        'decomposition',
        'implementation',
        'validation',
        'testing',
        'release',
      ];
      for (const stage of stages) {
        await pipelineModule.advanceStage(taskId, { toStage: stage, initiatedBy: 'agent' });
      }
      await pipelineModule.completePipeline(taskId);

      // Try to cancel completed
      await expect(pipelineModule.cancelPipeline(taskId, 'too late')).rejects.toThrow(
        'Cannot cancel completed pipeline',
      );
    });
  });

  // =============================================================================
  // PIPELINE STAGES TRACKING
  // =============================================================================

  describe('pipeline stages tracking', () => {
    it('should track stage status correctly', async () => {
      const taskId = 'T4912-019';

      await initPipeline(taskId);

      // Initially research is in_progress, others not_started
      let stages = await pipelineModule.getPipelineStages(taskId);
      const researchStage = stages.find((s) => s.stage === 'research');
      const consensusStage = stages.find((s) => s.stage === 'consensus');

      expect(researchStage!.status).toBe('in_progress');
      expect(consensusStage!.status).toBe('not_started');

      // Advance to consensus
      await pipelineModule.advanceStage(taskId, { toStage: 'consensus', initiatedBy: 'agent' });

      stages = await pipelineModule.getPipelineStages(taskId);
      const researchAfter = stages.find((s) => s.stage === 'research');
      const consensusAfter = stages.find((s) => s.stage === 'consensus');

      expect(researchAfter!.status).toBe('completed');
      expect(researchAfter!.completedAt).toBeDefined();
      expect(consensusAfter!.status).toBe('in_progress');
      expect(consensusAfter!.startedAt).toBeDefined();
    });

    it('should maintain correct stage order', async () => {
      const taskId = 'T4912-020';

      await initPipeline(taskId);

      const stages = await pipelineModule.getPipelineStages(taskId);

      // Verify sequence numbers
      stages.forEach((stage, index) => {
        expect(stage.order).toBe(index + 1);
      });
    });
  });

  // =============================================================================
  // PIPELINE EXISTS UTILITY
  // =============================================================================

  describe('pipelineExists utility', () => {
    it('should return false for non-existent pipeline', async () => {
      const exists = await pipelineModule.pipelineExists('T4912-NONEXISTENT');
      expect(exists).toBe(false);
    });

    it('should return true for existing pipeline', async () => {
      const taskId = 'T4912-021';
      await initPipeline(taskId);

      const exists = await pipelineModule.pipelineExists(taskId);
      expect(exists).toBe(true);
    });
  });
});
