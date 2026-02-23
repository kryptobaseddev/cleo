/**
 * Memory Engine Compatibility Layer Tests
 *
 * Tests EngineResult wrappers around core/memory functions.
 * Migrated from mcp/engine/__tests__/research-engine.test.ts.
 *
 * @epic T4820
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import {
  memoryShow,
  memoryList,
  memoryQuery,
  memoryPending,
  memoryStats,
  memoryManifestRead,
  memoryLink,
  memoryManifestAppend,
  memoryManifestArchive,
  memoryContradictions,
  memorySuperseded,
  memoryCompact,
  memoryValidate,
} from '../engine-compat.js';

const TEST_ROOT = join(process.cwd(), '.test-memory-engine-compat');
const MANIFEST_DIR = join(TEST_ROOT, '.cleo', 'agent-outputs');
const MANIFEST_PATH = join(MANIFEST_DIR, 'MANIFEST.jsonl');

const SAMPLE_ENTRIES = [
  { id: 'T001-research', file: 'out/T001.md', title: 'First Research', date: '2026-01-15', status: 'complete', agent_type: 'research', topics: ['mcp', 'engine'], key_findings: ['finding1', 'finding2', 'finding3'], actionable: true, linked_tasks: ['T001'], needs_followup: [] },
  { id: 'T002-spec', file: 'out/T002.md', title: 'Specification Doc', date: '2026-02-01', status: 'partial', agent_type: 'specification', topics: ['spec', 'api'], key_findings: ['spec1'], actionable: false, linked_tasks: ['T002'], needs_followup: ['T003'] },
  { id: 'T003-impl', file: 'out/T003.md', title: 'Implementation', date: '2026-02-10', status: 'blocked', agent_type: 'implementation', topics: ['engine', 'native'], key_findings: [], actionable: true, linked_tasks: ['T001', 'T003'] },
];

function writeManifest(entries: any[]): void {
  mkdirSync(MANIFEST_DIR, { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(MANIFEST_PATH, content, 'utf-8');
}

describe('Memory Engine Compat', () => {
  beforeEach(() => {
    mkdirSync(MANIFEST_DIR, { recursive: true });
    writeManifest(SAMPLE_ENTRIES);
  });

  afterEach(() => {
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
  });

  describe('memoryShow', () => {
    it('should find entry by ID', () => {
      const result = memoryShow('T001-research', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).id).toBe('T001-research');
      expect((result.data as any).title).toBe('First Research');
    });

    it('should return error for missing entry', () => {
      const result = memoryShow('T999-missing', TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });

    it('should return error for empty ID', () => {
      const result = memoryShow('', TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });

  describe('memoryList', () => {
    it('should list all entries', () => {
      const result = memoryList({}, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(3);
    });

    it('should filter by status', () => {
      const result = memoryList({ status: 'complete' }, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(1);
    });

    it('should filter by topic', () => {
      const result = memoryList({ topic: 'engine' }, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(2);
    });

    it('should filter by type', () => {
      const result = memoryList({ type: 'research' }, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(1);
    });

    it('should apply limit', () => {
      const result = memoryList({ limit: 2 }, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(2);
    });
  });

  describe('memoryQuery', () => {
    it('should search by title', () => {
      const result = memoryQuery('Research', {}, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBeGreaterThan(0);
    });

    it('should search by topic', () => {
      const result = memoryQuery('mcp', {}, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBeGreaterThan(0);
    });

    it('should return error for empty query', () => {
      const result = memoryQuery('', {}, TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('should apply confidence threshold', () => {
      const result = memoryQuery('Research', { confidence: 0.5 }, TEST_ROOT);
      expect(result.success).toBe(true);
    });
  });

  describe('memoryPending', () => {
    it('should return partial and blocked entries', () => {
      const result = memoryPending(undefined, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(2);
    });

    it('should filter by epicId', () => {
      const result = memoryPending('T002', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(1);
    });
  });

  describe('memoryStats', () => {
    it('should compute stats', () => {
      const result = memoryStats(undefined, TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.total).toBe(3);
      expect(data.byStatus.complete).toBe(1);
      expect(data.byStatus.partial).toBe(1);
      expect(data.actionable).toBe(2);
    });

    it('should filter by epicId', () => {
      const result = memoryStats('T001', TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.total).toBe(2);
    });
  });

  describe('memoryLink', () => {
    it('should link task to research entry', () => {
      const result = memoryLink('T999', 'T001-research', undefined, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).linked).toBe(true);
    });

    it('should handle already linked', () => {
      const result = memoryLink('T001', 'T001-research', undefined, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).alreadyLinked).toBe(true);
    });

    it('should return error for missing entry', () => {
      const result = memoryLink('T999', 'T999-missing', undefined, TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });
  });

  describe('memoryManifestAppend', () => {
    it('should append valid entry', () => {
      const newEntry = {
        id: 'T004-new',
        file: 'out/T004.md',
        title: 'New Entry',
        date: '2026-02-13',
        status: 'complete' as const,
        agent_type: 'research',
        topics: ['test'],
        actionable: true,
      };
      const result = memoryManifestAppend(newEntry, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).appended).toBe(true);
    });

    it('should reject invalid entry', () => {
      const result = memoryManifestAppend({} as any, TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_VALIDATION_FAILED');
    });
  });

  describe('memoryManifestArchive', () => {
    it('should archive entries before date', () => {
      const result = memoryManifestArchive('2026-02-01', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).archived).toBe(1);
      expect((result.data as any).remaining).toBe(2);
    });

    it('should return 0 when no entries match', () => {
      const result = memoryManifestArchive('2020-01-01', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).archived).toBe(0);
    });
  });

  describe('memoryContradictions', () => {
    it('should return empty array when no contradictions', () => {
      const result = memoryContradictions(TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).contradictions).toBeDefined();
    });
  });

  describe('memorySuperseded', () => {
    it('should return empty array when no superseded entries', () => {
      const result = memorySuperseded(TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).superseded).toBeDefined();
    });
  });

  describe('memoryCompact', () => {
    it('should compact manifest successfully', () => {
      const result = memoryCompact(TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).compacted).toBe(true);
      expect((result.data as any).remainingEntries).toBe(3);
    });

    it('should handle non-existent manifest', () => {
      rmSync(MANIFEST_PATH, { force: true });
      const result = memoryCompact(TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).compacted).toBe(false);
    });
  });

  describe('memoryValidate', () => {
    it('should validate entries for task', () => {
      const result = memoryValidate('T001', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).taskId).toBe('T001');
      expect((result.data as any).entriesFound).toBeGreaterThan(0);
    });

    it('should return error for empty taskId', () => {
      const result = memoryValidate('', TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('should handle task with no entries', () => {
      const result = memoryValidate('T999', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).entriesFound).toBe(0);
      expect((result.data as any).valid).toBe(true);
    });
  });

  describe('memoryManifestRead', () => {
    it('should read all entries without filter', () => {
      const result = memoryManifestRead(undefined, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(3);
    });

    it('should apply filter', () => {
      const result = memoryManifestRead({ status: 'complete' }, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(1);
    });
  });
});
