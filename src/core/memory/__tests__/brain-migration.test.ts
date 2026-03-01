/**
 * Tests for JSONL to brain.db migration.
 *
 * @task T5129
 * @epic T5149
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;
let cleoDir: string;
let memoryDir: string;

describe('Brain Migration', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-brain-migration-'));
    cleoDir = join(tempDir, '.cleo');
    memoryDir = join(cleoDir, 'memory');
    await mkdir(memoryDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should migrate patterns from JSONL to brain.db', async () => {
    const { migrateBrainData } = await import('../brain-migration.js');
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();

    const patterns = [
      {
        id: 'P001',
        type: 'workflow',
        pattern: 'Always validate input',
        context: 'API handlers',
        frequency: 3,
        successRate: 0.9,
        impact: 'high',
        antiPattern: null,
        mitigation: null,
        examples: ['example1'],
        extractedAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
      {
        id: 'P002',
        type: 'blocker',
        pattern: 'Missing test coverage',
        context: 'PR reviews',
        frequency: 5,
        successRate: null,
        impact: 'medium',
        antiPattern: 'Skip tests',
        mitigation: 'Require 80% coverage',
        examples: [],
        extractedAt: '2026-01-05T00:00:00Z',
        updatedAt: null,
      },
    ];

    const jsonl = patterns.map((p) => JSON.stringify(p)).join('\n') + '\n';
    await writeFile(join(memoryDir, 'patterns.jsonl'), jsonl);

    const result = await migrateBrainData(tempDir);
    expect(result.patternsImported).toBe(2);
    expect(result.learningsImported).toBe(0);
    expect(result.duplicatesSkipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('should migrate learnings from JSONL to brain.db', async () => {
    const { migrateBrainData } = await import('../brain-migration.js');
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();

    const learnings = [
      {
        id: 'L001',
        insight: 'Atomic writes prevent data corruption',
        source: 'T4500 completion',
        confidence: 0.95,
        actionable: true,
        application: 'All file write operations',
        applicableTypes: ['file-io', 'storage'],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
    ];

    const jsonl = learnings.map((l) => JSON.stringify(l)).join('\n') + '\n';
    await writeFile(join(memoryDir, 'learnings.jsonl'), jsonl);

    const result = await migrateBrainData(tempDir);
    expect(result.patternsImported).toBe(0);
    expect(result.learningsImported).toBe(1);
    expect(result.duplicatesSkipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('should skip duplicates on re-run (idempotent)', async () => {
    const { migrateBrainData } = await import('../brain-migration.js');
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();

    const patterns = [
      {
        id: 'P001',
        type: 'workflow',
        pattern: 'Always validate',
        context: 'All operations',
        frequency: 1,
        successRate: null,
        impact: null,
        antiPattern: null,
        mitigation: null,
        examples: [],
        extractedAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
    ];

    const jsonl = patterns.map((p) => JSON.stringify(p)).join('\n') + '\n';
    await writeFile(join(memoryDir, 'patterns.jsonl'), jsonl);

    const first = await migrateBrainData(tempDir);
    expect(first.patternsImported).toBe(1);
    expect(first.duplicatesSkipped).toBe(0);

    const second = await migrateBrainData(tempDir);
    expect(second.patternsImported).toBe(0);
    expect(second.duplicatesSkipped).toBe(1);
  });

  it('should handle missing JSONL files gracefully', async () => {
    const { migrateBrainData } = await import('../brain-migration.js');
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();

    // No JSONL files exist
    const result = await migrateBrainData(tempDir);
    expect(result.patternsImported).toBe(0);
    expect(result.learningsImported).toBe(0);
    expect(result.duplicatesSkipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('should handle malformed JSONL lines', async () => {
    const { migrateBrainData } = await import('../brain-migration.js');
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();

    const content = '{"id":"P001","type":"workflow","pattern":"test","context":"ctx","frequency":1,"successRate":null,"impact":null,"antiPattern":null,"mitigation":null,"examples":[],"extractedAt":"2026-01-01T00:00:00Z","updatedAt":null}\n{bad json\n';
    await writeFile(join(memoryDir, 'patterns.jsonl'), content);

    const result = await migrateBrainData(tempDir);
    expect(result.patternsImported).toBe(1);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should migrate both patterns and learnings together', async () => {
    const { migrateBrainData } = await import('../brain-migration.js');
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();

    await writeFile(
      join(memoryDir, 'patterns.jsonl'),
      JSON.stringify({
        id: 'P001', type: 'workflow', pattern: 'Test pattern',
        context: 'Test', frequency: 1, successRate: null, impact: null,
        antiPattern: null, mitigation: null, examples: [],
        extractedAt: '2026-01-01T00:00:00Z', updatedAt: null,
      }) + '\n',
    );

    await writeFile(
      join(memoryDir, 'learnings.jsonl'),
      JSON.stringify({
        id: 'L001', insight: 'Test insight', source: 'test',
        confidence: 0.8, actionable: false, application: null,
        applicableTypes: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: null,
      }) + '\n',
    );

    const result = await migrateBrainData(tempDir);
    expect(result.patternsImported).toBe(1);
    expect(result.learningsImported).toBe(1);
    expect(result.errors).toHaveLength(0);
  });
});
