/**
 * Tests for Manifest Integration System
 *
 * @task T2919
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ManifestReader, ManifestEntry, ManifestFilter } from '../../src/lib/manifest';
import { parseManifestLine, validateEntry, serializeEntry, extractTaskId, needsFollowup } from '../../src/lib/manifest-parser';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { resolve } from 'path';

const TEST_MANIFEST_PATH = '.test-manifest.jsonl';
const TEST_BASE_DIR = resolve(__dirname, '../fixtures');

describe('ManifestReader', () => {
  let reader: ManifestReader;

  beforeEach(() => {
    reader = new ManifestReader(TEST_MANIFEST_PATH, TEST_BASE_DIR);
  });

  afterEach(async () => {
    try {
      await unlink(resolve(TEST_BASE_DIR, TEST_MANIFEST_PATH));
    } catch {
      // Ignore if file doesn't exist
    }
  });

  describe('readManifest', () => {
    it('should read and parse valid manifest entries', async () => {
      const entry1: ManifestEntry = {
        id: 'T2919-manifest-integration',
        file: 'lib/manifest.ts',
        title: 'Manifest Integration',
        date: '2026-02-03',
        status: 'complete',
        agent_type: 'implementation',
        topics: ['manifest', 'integration', 'mcp'],
        key_findings: ['Created reader', 'Added validation', 'Integrated with domains'],
        actionable: true,
        linked_tasks: ['T2908', 'T2919'],
      };

      const entry2: ManifestEntry = {
        id: 'T2920-test-suite',
        file: 'tests/manifest.test.ts',
        title: 'Manifest Tests',
        date: '2026-02-03',
        status: 'complete',
        agent_type: 'testing',
        topics: ['testing', 'manifest'],
        actionable: false,
        linked_tasks: ['T2919'],
      };

      const content = `${JSON.stringify(entry1)}\n${JSON.stringify(entry2)}\n`;
      await mkdir(TEST_BASE_DIR, { recursive: true });
      await writeFile(resolve(TEST_BASE_DIR, TEST_MANIFEST_PATH), content);

      const entries = await reader.readManifest();

      expect(entries).toHaveLength(2);
      expect(entries[0].id).toBe('T2919-manifest-integration');
      expect(entries[1].id).toBe('T2920-test-suite');
    });

    it('should skip empty lines', async () => {
      const entry: ManifestEntry = {
        id: 'T2919-test',
        file: 'test.ts',
        title: 'Test',
        date: '2026-02-03',
        status: 'complete',
        agent_type: 'testing',
        topics: ['test'],
        actionable: false,
      };

      const content = `\n${JSON.stringify(entry)}\n\n`;
      await mkdir(TEST_BASE_DIR, { recursive: true });
      await writeFile(resolve(TEST_BASE_DIR, TEST_MANIFEST_PATH), content);

      const entries = await reader.readManifest();

      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe('T2919-test');
    });

    it('should return empty array for non-existent file', async () => {
      const entries = await reader.readManifest();
      expect(entries).toEqual([]);
    });
  });

  describe('filterEntries', () => {
    const entries: ManifestEntry[] = [
      {
        id: 'T2919-manifest',
        file: 'lib/manifest.ts',
        title: 'Manifest',
        date: '2026-02-03',
        status: 'complete',
        agent_type: 'implementation',
        topics: ['manifest'],
        actionable: true,
        linked_tasks: ['T2908'],
      },
      {
        id: 'T2920-tests',
        file: 'tests/manifest.test.ts',
        title: 'Tests',
        date: '2026-02-04',
        status: 'partial',
        agent_type: 'testing',
        topics: ['testing'],
        actionable: false,
        linked_tasks: ['T2919'],
      },
    ];

    it('should filter by task ID', () => {
      const filter: ManifestFilter = { taskId: 'T2919' };
      const filtered = reader.filterEntries(entries, filter);
      expect(filtered).toHaveLength(2);
    });

    it('should filter by agent type', () => {
      const filter: ManifestFilter = { agent_type: 'implementation' };
      const filtered = reader.filterEntries(entries, filter);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('T2919-manifest');
    });

    it('should filter by status', () => {
      const filter: ManifestFilter = { status: 'complete' };
      const filtered = reader.filterEntries(entries, filter);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].status).toBe('complete');
    });

    it('should filter by date range', () => {
      const filter: ManifestFilter = { dateAfter: '2026-02-03' };
      const filtered = reader.filterEntries(entries, filter);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].date).toBe('2026-02-04');
    });

    it('should filter by topic', () => {
      const filter: ManifestFilter = { topic: 'manifest' };
      const filtered = reader.filterEntries(entries, filter);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('T2919-manifest');
    });

    it('should filter by actionable', () => {
      const filter: ManifestFilter = { actionable: true };
      const filtered = reader.filterEntries(entries, filter);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].actionable).toBe(true);
    });

    it('should apply limit', () => {
      const filter: ManifestFilter = { limit: 1 };
      const filtered = reader.filterEntries(entries, filter);
      expect(filtered).toHaveLength(1);
    });
  });

  describe('validateEntry', () => {
    it('should validate complete entry', () => {
      const entry: ManifestEntry = {
        id: 'T2919-test',
        file: 'test.ts',
        title: 'Test',
        date: '2026-02-03',
        status: 'complete',
        agent_type: 'testing',
        topics: ['test'],
        actionable: false,
      };

      const validation = reader.validateEntry(entry);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should reject missing required fields', () => {
      const entry = {
        id: 'T2919-test',
        // Missing other required fields
      } as ManifestEntry;

      const validation = reader.validateEntry(entry);
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    });

    it('should validate ID format', () => {
      const entry: ManifestEntry = {
        id: 'invalid-id',
        file: 'test.ts',
        title: 'Test',
        date: '2026-02-03',
        status: 'complete',
        agent_type: 'testing',
        topics: ['test'],
        actionable: false,
      };

      const validation = reader.validateEntry(entry);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.field === 'id')).toBe(true);
    });

    it('should validate date format', () => {
      const entry: ManifestEntry = {
        id: 'T2919-test',
        file: 'test.ts',
        title: 'Test',
        date: 'invalid-date',
        status: 'complete',
        agent_type: 'testing',
        topics: ['test'],
        actionable: false,
      };

      const validation = reader.validateEntry(entry);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.field === 'date')).toBe(true);
    });

    it('should validate status enum', () => {
      const entry: ManifestEntry = {
        id: 'T2919-test',
        file: 'test.ts',
        title: 'Test',
        date: '2026-02-03',
        status: 'invalid' as any,
        agent_type: 'testing',
        topics: ['test'],
        actionable: false,
      };

      const validation = reader.validateEntry(entry);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.field === 'status')).toBe(true);
    });
  });
});

describe('ManifestParser', () => {
  describe('parseManifestLine', () => {
    it('should parse valid JSON line', () => {
      const entry: ManifestEntry = {
        id: 'T2919-test',
        file: 'test.ts',
        title: 'Test',
        date: '2026-02-03',
        status: 'complete',
        agent_type: 'testing',
        topics: ['test'],
        actionable: false,
      };

      const line = JSON.stringify(entry);
      const parsed = parseManifestLine(line);

      expect(parsed.id).toBe('T2919-test');
      expect(parsed.status).toBe('complete');
    });

    it('should throw on empty line', () => {
      expect(() => parseManifestLine('')).toThrow('Empty line');
    });

    it('should throw on invalid JSON', () => {
      expect(() => parseManifestLine('not json')).toThrow('Invalid JSON');
    });
  });

  describe('validateEntry', () => {
    it('should validate confidence range', () => {
      const entry: ManifestEntry = {
        id: 'T2919-test',
        file: 'test.ts',
        title: 'Test',
        date: '2026-02-03',
        status: 'complete',
        agent_type: 'testing',
        topics: ['test'],
        actionable: false,
        confidence: 1.5,
      };

      const validation = validateEntry(entry);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.field === 'confidence')).toBe(true);
    });

    it('should warn on key_findings count', () => {
      const entry: ManifestEntry = {
        id: 'T2919-test',
        file: 'test.ts',
        title: 'Test',
        date: '2026-02-03',
        status: 'complete',
        agent_type: 'research',
        topics: ['test'],
        actionable: true,
        key_findings: ['Only one finding'],
      };

      const validation = validateEntry(entry);
      expect(validation.errors.some((e) => e.field === 'key_findings' && e.severity === 'warning')).toBe(true);
    });
  });

  describe('serializeEntry', () => {
    it('should serialize valid entry to JSON', () => {
      const entry: ManifestEntry = {
        id: 'T2919-test',
        file: 'test.ts',
        title: 'Test',
        date: '2026-02-03',
        status: 'complete',
        agent_type: 'testing',
        topics: ['test'],
        actionable: false,
      };

      const serialized = serializeEntry(entry);
      const parsed = JSON.parse(serialized);

      expect(parsed.id).toBe('T2919-test');
      expect(serialized).not.toContain('\n');
    });

    it('should throw on invalid entry', () => {
      const entry = {
        id: 'invalid',
        // Missing required fields
      } as ManifestEntry;

      expect(() => serializeEntry(entry)).toThrow();
    });
  });

  describe('extractTaskId', () => {
    it('should extract task ID from entry ID', () => {
      expect(extractTaskId('T2919-manifest-integration')).toBe('T2919');
      expect(extractTaskId('T123-test')).toBe('T123');
    });

    it('should return null for invalid format', () => {
      expect(extractTaskId('invalid')).toBeNull();
      expect(extractTaskId('2919-test')).toBeNull();
    });
  });

  describe('needsFollowup', () => {
    it('should return true for partial status', () => {
      const entry: ManifestEntry = {
        id: 'T2919-test',
        file: 'test.ts',
        title: 'Test',
        date: '2026-02-03',
        status: 'partial',
        agent_type: 'testing',
        topics: ['test'],
        actionable: false,
      };

      expect(needsFollowup(entry)).toBe(true);
    });

    it('should return true for needs_followup items', () => {
      const entry: ManifestEntry = {
        id: 'T2919-test',
        file: 'test.ts',
        title: 'Test',
        date: '2026-02-03',
        status: 'complete',
        agent_type: 'testing',
        topics: ['test'],
        actionable: false,
        needs_followup: ['T2920'],
      };

      expect(needsFollowup(entry)).toBe(true);
    });

    it('should return false for complete with no followup', () => {
      const entry: ManifestEntry = {
        id: 'T2919-test',
        file: 'test.ts',
        title: 'Test',
        date: '2026-02-03',
        status: 'complete',
        agent_type: 'testing',
        topics: ['test'],
        actionable: false,
      };

      expect(needsFollowup(entry)).toBe(false);
    });
  });
});
