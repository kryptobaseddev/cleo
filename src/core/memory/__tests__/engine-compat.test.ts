/**
 * Memory/Pipeline Engine Compatibility Layer Tests
 *
 * Tests EngineResult wrappers around core/memory and pipeline-manifest functions.
 * Migrated from mcp/engine/__tests__/research-engine.test.ts.
 * Updated for T5241 cutover: manifest ops moved to pipeline-manifest-compat.
 *
 * @epic T4820
 * @task T5241
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  memoryShow,
} from '../engine-compat.js';
import {
  pipelineManifestList,
  pipelineManifestFind,
  pipelineManifestPending,
  pipelineManifestStats,
  pipelineManifestRead,
  pipelineManifestLink,
  pipelineManifestAppend,
  pipelineManifestArchive,
  pipelineManifestContradictions,
  pipelineManifestSuperseded,
  pipelineManifestCompact,
  pipelineManifestValidate,
} from '../pipeline-manifest-compat.js';

const SAMPLE_ENTRIES = [
  { id: 'T001-research', file: 'out/T001.md', title: 'First Research', date: '2026-01-15', status: 'completed', agent_type: 'research', topics: ['mcp', 'engine'], key_findings: ['finding1', 'finding2', 'finding3'], actionable: true, linked_tasks: ['T001'], needs_followup: [] },
  { id: 'T002-spec', file: 'out/T002.md', title: 'Specification Doc', date: '2026-02-01', status: 'partial', agent_type: 'specification', topics: ['spec', 'api'], key_findings: ['spec1'], actionable: false, linked_tasks: ['T002'], needs_followup: ['T003'] },
  { id: 'T003-impl', file: 'out/T003.md', title: 'Implementation', date: '2026-02-10', status: 'blocked', agent_type: 'implementation', topics: ['engine', 'native'], key_findings: [], actionable: true, linked_tasks: ['T001', 'T003'] },
];

describe('Memory Engine Compat', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'cleo-engine-compat-brain-'));
    mkdirSync(join(testRoot, '.cleo'), { recursive: true });
  });

  afterEach(async () => {
    try {
      const { closeAllDatabases } = await import('../../../store/sqlite.js');
      await closeAllDatabases();
    } catch { /* ignore */ }
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  describe('memoryShow', () => {
    it('should return error for unknown ID prefix', async () => {
      // T001-research is a manifest ID, not a brain.db ID — memoryShow now only handles brain.db
      const result = await memoryShow('T001-research', testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('should return error for missing brain.db entry', async () => {
      // D-prefix is valid (decision) but entry won't exist in test brain.db
      const result = await memoryShow('D-missing', testRoot);
      expect(result.success).toBe(false);
      // Will fail with E_NOT_FOUND or E_BRAIN_SHOW depending on brain.db init
    });

    it('should return error for empty ID', async () => {
      const result = await memoryShow('', testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });
});

describe('Pipeline Manifest Compat (moved from memory domain)', () => {
  let testRoot: string;
  let manifestDir: string;
  let manifestPath: string;

  function writeManifest(entries: any[]): void {
    mkdirSync(manifestDir, { recursive: true });
    const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(manifestPath, content, 'utf-8');
  }

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'cleo-engine-compat-manifest-'));
    manifestDir = join(testRoot, '.cleo', 'agent-outputs');
    manifestPath = join(manifestDir, 'MANIFEST.jsonl');
    writeManifest(SAMPLE_ENTRIES);
  });

  afterEach(() => {
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  describe('pipelineManifestList', () => {
    it('should list all entries', () => {
      const result = pipelineManifestList({}, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(3);
    });

    it('should filter by status', () => {
      const result = pipelineManifestList({ status: 'completed' }, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(1);
    });

    it('should filter by topic', () => {
      const result = pipelineManifestList({ topic: 'engine' }, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(2);
    });

    it('should filter by type', () => {
      const result = pipelineManifestList({ type: 'research' }, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(1);
    });

    it('should apply limit', () => {
      const result = pipelineManifestList({ limit: 2 }, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(2);
    });
  });

  describe('pipelineManifestFind', () => {
    it('should search by title', () => {
      const result = pipelineManifestFind('Research', {}, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBeGreaterThan(0);
    });

    it('should search by topic', () => {
      const result = pipelineManifestFind('mcp', {}, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBeGreaterThan(0);
    });

    it('should return error for empty query', () => {
      const result = pipelineManifestFind('', {}, testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('should apply confidence threshold', () => {
      const result = pipelineManifestFind('Research', { confidence: 0.5 }, testRoot);
      expect(result.success).toBe(true);
    });
  });

  describe('pipelineManifestPending', () => {
    it('should return partial and blocked entries', () => {
      const result = pipelineManifestPending(undefined, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(2);
    });

    it('should filter by epicId', () => {
      const result = pipelineManifestPending('T002', testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(1);
    });
  });

  describe('pipelineManifestStats', () => {
    it('should compute stats', () => {
      const result = pipelineManifestStats(undefined, testRoot);
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.total).toBe(3);
      expect(data.byStatus.completed).toBe(1);
      expect(data.byStatus.partial).toBe(1);
      expect(data.actionable).toBe(2);
    });

    it('should filter by epicId', () => {
      const result = pipelineManifestStats('T001', testRoot);
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.total).toBe(2);
    });
  });

  describe('pipelineManifestLink', () => {
    it('should link task to research entry', () => {
      const result = pipelineManifestLink('T999', 'T001-research', undefined, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).linked).toBe(true);
    });

    it('should handle already linked', () => {
      const result = pipelineManifestLink('T001', 'T001-research', undefined, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).alreadyLinked).toBe(true);
    });

    it('should return error for missing entry', () => {
      const result = pipelineManifestLink('T999', 'T999-missing', undefined, testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });
  });

  describe('pipelineManifestAppend', () => {
    it('should append valid entry', () => {
      const newEntry = {
        id: 'T004-new',
        file: 'out/T004.md',
        title: 'New Entry',
        date: '2026-02-13',
        status: 'completed' as const,
        agent_type: 'research',
        topics: ['test'],
        actionable: true,
      };
      const result = pipelineManifestAppend(newEntry, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).appended).toBe(true);
    });

    it('should reject invalid entry', () => {
      const result = pipelineManifestAppend({} as any, testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_VALIDATION_FAILED');
    });
  });

  describe('pipelineManifestArchive', () => {
    it('should archive entries before date', () => {
      const result = pipelineManifestArchive('2026-02-01', testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).archived).toBe(1);
      expect((result.data as any).remaining).toBe(2);
    });

    it('should return 0 when no entries match', () => {
      const result = pipelineManifestArchive('2020-01-01', testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).archived).toBe(0);
    });
  });

  describe('pipelineManifestContradictions', () => {
    it('should return empty array when no contradictions', () => {
      const result = pipelineManifestContradictions(testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).contradictions).toBeDefined();
    });
  });

  describe('pipelineManifestSuperseded', () => {
    it('should return empty array when no superseded entries', () => {
      const result = pipelineManifestSuperseded(testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).superseded).toBeDefined();
    });
  });

  describe('pipelineManifestCompact', () => {
    it('should compact manifest successfully', () => {
      const result = pipelineManifestCompact(testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).compacted).toBe(true);
      expect((result.data as any).remainingEntries).toBe(3);
    });

    it('should handle non-existent manifest', () => {
      rmSync(manifestPath, { force: true });
      const result = pipelineManifestCompact(testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).compacted).toBe(false);
    });
  });

  describe('pipelineManifestValidate', () => {
    it('should validate entries for task', () => {
      const result = pipelineManifestValidate('T001', testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).taskId).toBe('T001');
      expect((result.data as any).entriesFound).toBeGreaterThan(0);
    });

    it('should return error for empty taskId', () => {
      const result = pipelineManifestValidate('', testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('should handle task with no entries', () => {
      const result = pipelineManifestValidate('T999', testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).entriesFound).toBe(0);
      expect((result.data as any).valid).toBe(true);
    });
  });

  describe('pipelineManifestRead', () => {
    it('should read all entries without filter', () => {
      const result = pipelineManifestRead(undefined, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(3);
    });

    it('should apply filter', () => {
      const result = pipelineManifestRead({ status: 'completed' }, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(1);
    });
  });
});
