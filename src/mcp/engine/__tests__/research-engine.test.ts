/**
 * Research Engine Tests
 *
 * Tests native TypeScript research operations.
 *
 * @task T4474
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import {
  researchShow,
  researchList,
  researchQuery,
  researchPending,
  researchStats,
  researchManifestRead,
  researchLink,
  researchManifestAppend,
  researchManifestArchive,
} from '../research-engine.js';

const TEST_ROOT = join(process.cwd(), '.test-research-engine');
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

describe('Research Engine', () => {
  beforeEach(() => {
    mkdirSync(MANIFEST_DIR, { recursive: true });
    writeManifest(SAMPLE_ENTRIES);
  });

  afterEach(() => {
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
  });

  describe('researchShow', () => {
    it('should find entry by ID', () => {
      const result = researchShow('T001-research', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).id).toBe('T001-research');
      expect((result.data as any).title).toBe('First Research');
    });

    it('should return error for missing entry', () => {
      const result = researchShow('T999-missing', TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });

    it('should return error for empty ID', () => {
      const result = researchShow('', TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });

  describe('researchList', () => {
    it('should list all entries', () => {
      const result = researchList({}, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(3);
    });

    it('should filter by status', () => {
      const result = researchList({ status: 'complete' }, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(1);
    });

    it('should filter by topic', () => {
      const result = researchList({ topic: 'engine' }, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(2);
    });

    it('should filter by type', () => {
      const result = researchList({ type: 'research' }, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(1);
    });

    it('should apply limit', () => {
      const result = researchList({ limit: 2 }, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(2);
    });
  });

  describe('researchQuery', () => {
    it('should search by title', () => {
      const result = researchQuery('Research', {}, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBeGreaterThan(0);
    });

    it('should search by topic', () => {
      const result = researchQuery('mcp', {}, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBeGreaterThan(0);
    });

    it('should return error for empty query', () => {
      const result = researchQuery('', {}, TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('should apply confidence threshold', () => {
      const result = researchQuery('Research', { confidence: 0.5 }, TEST_ROOT);
      expect(result.success).toBe(true);
    });
  });

  describe('researchPending', () => {
    it('should return partial and blocked entries', () => {
      const result = researchPending(undefined, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(2); // partial + blocked
    });

    it('should filter by epicId', () => {
      const result = researchPending('T002', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(1);
    });
  });

  describe('researchStats', () => {
    it('should compute stats', () => {
      const result = researchStats(undefined, TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.total).toBe(3);
      expect(data.byStatus.complete).toBe(1);
      expect(data.byStatus.partial).toBe(1);
      expect(data.actionable).toBe(2);
    });

    it('should filter by epicId', () => {
      const result = researchStats('T001', TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.total).toBe(2); // T001-research and T003-impl (linked to T001)
    });
  });

  describe('researchLink', () => {
    it('should link task to research entry', () => {
      const result = researchLink('T999', 'T001-research', undefined, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).linked).toBe(true);
    });

    it('should handle already linked', () => {
      const result = researchLink('T001', 'T001-research', undefined, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).alreadyLinked).toBe(true);
    });

    it('should return error for missing entry', () => {
      const result = researchLink('T999', 'T999-missing', undefined, TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });
  });

  describe('researchManifestAppend', () => {
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
      const result = researchManifestAppend(newEntry, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).appended).toBe(true);
    });

    it('should reject invalid entry', () => {
      const result = researchManifestAppend({} as any, TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_VALIDATION_FAILED');
    });
  });

  describe('researchManifestArchive', () => {
    it('should archive entries before date', () => {
      const result = researchManifestArchive('2026-02-01', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).archived).toBe(1);
      expect((result.data as any).remaining).toBe(2);
    });

    it('should return 0 when no entries match', () => {
      const result = researchManifestArchive('2020-01-01', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).archived).toBe(0);
    });
  });
});
