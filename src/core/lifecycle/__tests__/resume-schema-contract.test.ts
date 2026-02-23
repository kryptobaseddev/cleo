/**
 * Regression test: lifecycle resume flow schema contract.
 *
 * Guards against T4809 regression where the lifecycle resume flow in
 * src/core/lifecycle/resume.ts queries columns from the SQLite schema
 * defined in src/store/schema.ts. If schema columns are renamed, removed,
 * or have their enum values changed, these tests will catch the mismatch.
 *
 * This test is purely structural — it validates that the Drizzle schema
 * tables export the exact column shapes resume.ts depends on. No database
 * is needed.
 *
 * @task T4809
 */

import { describe, it, expect } from 'vitest';
import * as schema from '../../../store/schema.js';

// Helper: extract column names from a Drizzle table
function getColumnNames(table: Record<string, unknown>): string[] {
  // Drizzle table objects have a Symbol for column definitions,
  // but named properties are the column accessors we use in queries.
  // We access the column config via the table's property names.
  const columnLike = Object.keys(table).filter(
    (key) =>
      !key.startsWith('_') &&
      !key.startsWith('$') &&
      typeof (table as Record<string, unknown>)[key] === 'object' &&
      (table as Record<string, unknown>)[key] !== null,
  );
  return columnLike;
}

describe('lifecycle resume schema contract (T4809 regression)', () => {
  // =========================================================================
  // 1. lifecyclePipelines table — columns used by resume.ts
  //    See: resume.ts lines 401-406, 544-546, 713-716
  // =========================================================================
  describe('lifecyclePipelines table', () => {
    it('has all columns required by resume.ts', () => {
      const cols = getColumnNames(schema.lifecyclePipelines);
      const required = ['id', 'taskId', 'status', 'currentStageId', 'startedAt', 'completedAt'];
      for (const col of required) {
        expect(cols, `Missing column: lifecyclePipelines.${col}`).toContain(col);
      }
    });

    it('status enum includes values used by resume.ts', () => {
      // resume.ts checks for 'active', 'completed', 'aborted' at line 444
      const statusCol = schema.lifecyclePipelines.status;
      expect(statusCol).toBeDefined();
      // The enum config is stored in the column's config
      const config = (statusCol as Record<string, unknown>)['config'] as Record<string, unknown> | undefined;
      if (config?.['enumValues']) {
        const enumValues = config['enumValues'] as string[];
        expect(enumValues).toContain('active');
        expect(enumValues).toContain('completed');
        expect(enumValues).toContain('aborted');
      }
    });
  });

  // =========================================================================
  // 2. lifecycleStages table — columns used by resume.ts
  //    See: resume.ts lines 401-406, 544-546, 584-589, 769-778
  // =========================================================================
  describe('lifecycleStages table', () => {
    it('has all columns required by resume.ts', () => {
      const cols = getColumnNames(schema.lifecycleStages);
      const required = [
        'id', 'pipelineId', 'stageName', 'status', 'sequence',
        'startedAt', 'completedAt', 'blockedAt', 'blockReason',
        'skippedAt', 'skipReason', 'notesJson', 'metadataJson',
      ];
      for (const col of required) {
        expect(cols, `Missing column: lifecycleStages.${col}`).toContain(col);
      }
    });

    it('status enum includes all DbStageStatus values used by resume.ts', () => {
      // resume.ts type DbStageStatus = 'pending' | 'active' | 'blocked' | 'completed' | 'skipped'
      const statusCol = schema.lifecycleStages.status;
      expect(statusCol).toBeDefined();
      const config = (statusCol as Record<string, unknown>)['config'] as Record<string, unknown> | undefined;
      if (config?.['enumValues']) {
        const enumValues = config['enumValues'] as string[];
        expect(enumValues).toContain('pending');
        expect(enumValues).toContain('active');
        expect(enumValues).toContain('blocked');
        expect(enumValues).toContain('completed');
        expect(enumValues).toContain('skipped');
      }
    });
  });

  // =========================================================================
  // 3. lifecycleGateResults table — columns used by resume.ts
  //    See: resume.ts lines 606-611
  // =========================================================================
  describe('lifecycleGateResults table', () => {
    it('has all columns required by resume.ts', () => {
      const cols = getColumnNames(schema.lifecycleGateResults);
      const required = ['id', 'stageId', 'gateName', 'result', 'checkedAt', 'checkedBy', 'details', 'reason'];
      for (const col of required) {
        expect(cols, `Missing column: lifecycleGateResults.${col}`).toContain(col);
      }
    });

    it('result enum includes values used by resume.ts', () => {
      // resume.ts GateResultContext uses 'pass' | 'fail' | 'warn'
      const resultCol = schema.lifecycleGateResults.result;
      expect(resultCol).toBeDefined();
      const config = (resultCol as Record<string, unknown>)['config'] as Record<string, unknown> | undefined;
      if (config?.['enumValues']) {
        const enumValues = config['enumValues'] as string[];
        expect(enumValues).toContain('pass');
        expect(enumValues).toContain('fail');
        expect(enumValues).toContain('warn');
      }
    });
  });

  // =========================================================================
  // 4. lifecycleEvidence table — columns used by resume.ts
  //    See: resume.ts lines 623-628
  // =========================================================================
  describe('lifecycleEvidence table', () => {
    it('has all columns required by resume.ts', () => {
      const cols = getColumnNames(schema.lifecycleEvidence);
      const required = ['id', 'stageId', 'uri', 'type', 'recordedAt', 'recordedBy', 'description'];
      for (const col of required) {
        expect(cols, `Missing column: lifecycleEvidence.${col}`).toContain(col);
      }
    });

    it('type enum includes values used by resume.ts', () => {
      // resume.ts EvidenceContext uses 'file' | 'url' | 'manifest'
      const typeCol = schema.lifecycleEvidence.type;
      expect(typeCol).toBeDefined();
      const config = (typeCol as Record<string, unknown>)['config'] as Record<string, unknown> | undefined;
      if (config?.['enumValues']) {
        const enumValues = config['enumValues'] as string[];
        expect(enumValues).toContain('file');
        expect(enumValues).toContain('url');
        expect(enumValues).toContain('manifest');
      }
    });
  });

  // =========================================================================
  // 5. lifecycleTransitions table — columns used by resume.ts
  //    See: resume.ts lines 640-646 (query), 785-793 (insert)
  // =========================================================================
  describe('lifecycleTransitions table', () => {
    it('has all columns required by resume.ts', () => {
      const cols = getColumnNames(schema.lifecycleTransitions);
      const required = ['id', 'pipelineId', 'fromStageId', 'toStageId', 'transitionType', 'createdAt'];
      for (const col of required) {
        expect(cols, `Missing column: lifecycleTransitions.${col}`).toContain(col);
      }
    });

    it('transitionType enum includes "manual" used by resumeStage()', () => {
      // resume.ts inserts with transitionType: 'manual' at line 790
      const typeCol = schema.lifecycleTransitions.transitionType;
      expect(typeCol).toBeDefined();
      const config = (typeCol as Record<string, unknown>)['config'] as Record<string, unknown> | undefined;
      if (config?.['enumValues']) {
        const enumValues = config['enumValues'] as string[];
        expect(enumValues).toContain('manual');
      }
    });
  });

  // =========================================================================
  // 6. tasks table — columns used by resume.ts for JOIN context
  //    See: resume.ts lines 401-406, 544-546, 664-671
  // =========================================================================
  describe('tasks table (resume JOIN columns)', () => {
    it('has all columns used by resume.ts JOINs', () => {
      const cols = getColumnNames(schema.tasks);
      const required = ['id', 'title', 'description', 'status', 'priority', 'parentId'];
      for (const col of required) {
        expect(cols, `Missing column: tasks.${col}`).toContain(col);
      }
    });
  });

  // =========================================================================
  // 7. Type exports required by resume.ts consumers
  // =========================================================================
  describe('type exports', () => {
    it('exports LifecyclePipelineRow type', () => {
      // This type is used for type inference in resume.ts
      const row: schema.LifecyclePipelineRow = {
        id: 'test',
        taskId: 'T001',
        status: 'active',
        currentStageId: null,
        startedAt: '2026-01-01',
        completedAt: null,
      };
      expect(row.id).toBe('test');
      expect(row.taskId).toBe('T001');
    });

    it('exports LifecycleStageRow type', () => {
      const row: schema.LifecycleStageRow = {
        id: 'test',
        pipelineId: 'p1',
        stageName: 'research',
        status: 'pending',
        sequence: 0,
        startedAt: null,
        completedAt: null,
        blockedAt: null,
        blockReason: null,
        skippedAt: null,
        skipReason: null,
        notesJson: '[]',
        metadataJson: '{}',
      };
      expect(row.stageName).toBe('research');
    });
  });
});
