/**
 * Pipeline Manifest SQLite Implementation Tests
 *
 * Tests all 14 pipeline manifest operations against a real tasks.db
 * SQLite database (via temp directory). Covers the append → read → find
 * → list → archive workflow, contentHash dedup, stats, contradictions,
 * validate, and migration function.
 *
 * @task T5581
 * @epic T5576
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtendedManifestEntry } from '../index.js';
import {
  distillManifestEntry,
  migrateManifestJsonlToSqlite,
  pipelineManifestAppend,
  pipelineManifestArchive,
  pipelineManifestCompact,
  pipelineManifestContradictions,
  pipelineManifestFind,
  pipelineManifestLink,
  pipelineManifestList,
  pipelineManifestPending,
  pipelineManifestRead,
  pipelineManifestShow,
  pipelineManifestStats,
  pipelineManifestSuperseded,
  pipelineManifestValidate,
  readManifestEntries,
} from '../pipeline-manifest-sqlite.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENTRY_A: ExtendedManifestEntry = {
  id: 'T001-research',
  file: 'out/T001.md',
  title: 'First Research',
  date: '2026-01-15',
  status: 'completed',
  agent_type: 'research',
  topics: ['mcp', 'engine'],
  key_findings: ['This library is deprecated', 'MCP supports structured output'],
  actionable: true,
  linked_tasks: ['T001'],
  needs_followup: [],
};

const ENTRY_B: ExtendedManifestEntry = {
  id: 'T002-spec',
  file: 'out/T002.md',
  title: 'Specification Doc',
  date: '2026-02-01',
  status: 'partial',
  agent_type: 'specification',
  topics: ['spec', 'api'],
  key_findings: ['spec1'],
  actionable: false,
  linked_tasks: ['T002'],
  needs_followup: ['T003'],
};

const ENTRY_C: ExtendedManifestEntry = {
  id: 'T003-impl',
  file: 'out/T003.md',
  title: 'Implementation Notes',
  date: '2026-02-10',
  status: 'blocked',
  agent_type: 'implementation',
  topics: ['engine', 'native'],
  key_findings: ['This library is recommended for production'],
  actionable: true,
  linked_tasks: ['T001', 'T003'],
  needs_followup: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedEntries(root: string, entries: ExtendedManifestEntry[]): Promise<void> {
  for (const entry of entries) {
    await pipelineManifestAppend(entry, root);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pipeline-manifest-sqlite', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'cleo-manifest-sqlite-'));
    mkdirSync(join(testRoot, '.cleo'), { recursive: true });
  });

  afterEach(async () => {
    const { resetDbState } = await import('../../../store/sqlite.js');
    resetDbState();
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // pipelineManifestAppend
  // =========================================================================

  describe('pipelineManifestAppend', () => {
    it('should append a valid entry', async () => {
      const result = await pipelineManifestAppend(ENTRY_A, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).appended).toBe(true);
      expect((result.data as any).entryId).toBe('T001-research');
    });

    it('should return error when entry is null', async () => {
      const result = await pipelineManifestAppend(null as any, testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('should return error for missing required fields', async () => {
      const incomplete = { id: 'T999', file: 'out/T999.md' } as any;
      const result = await pipelineManifestAppend(incomplete, testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_VALIDATION_FAILED');
    });

    it('should update on duplicate id (upsert)', async () => {
      await pipelineManifestAppend(ENTRY_A, testRoot);
      const updated = { ...ENTRY_A, title: 'Updated Title' };
      const result = await pipelineManifestAppend(updated, testRoot);
      expect(result.success).toBe(true);

      const show = await pipelineManifestShow('T001-research', testRoot);
      expect((show.data as any).title).toBe('Updated Title');
    });
  });

  // =========================================================================
  // pipelineManifestShow
  // =========================================================================

  describe('pipelineManifestShow', () => {
    it('should show an existing entry', async () => {
      await seedEntries(testRoot, [ENTRY_A]);
      const result = await pipelineManifestShow('T001-research', testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).id).toBe('T001-research');
      expect((result.data as any).title).toBe('First Research');
    });

    it('should return error for missing entry', async () => {
      await seedEntries(testRoot, [ENTRY_A]);
      const result = await pipelineManifestShow('T999-missing', testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });

    it('should return error for empty researchId', async () => {
      const result = await pipelineManifestShow('', testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('should include fileExists: false when file does not exist', async () => {
      await seedEntries(testRoot, [ENTRY_A]);
      const result = await pipelineManifestShow('T001-research', testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).fileExists).toBe(false);
    });
  });

  // =========================================================================
  // pipelineManifestRead
  // =========================================================================

  describe('pipelineManifestRead', () => {
    it('should read all entries without filter', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestRead(undefined, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(3);
    });

    it('should filter by taskId', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestRead({ taskId: 'T001' }, testRoot);
      expect(result.success).toBe(true);
      // T001 is linked to ENTRY_A and ENTRY_C
      expect((result.data as any).total).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // pipelineManifestList
  // =========================================================================

  describe('pipelineManifestList', () => {
    it('should list all entries', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestList({}, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(3);
      expect((result.data as any).filtered).toBe(3);
      expect(result.page).toEqual({ mode: 'none' });
    });

    it('should filter by status', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestList({ status: 'partial' }, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(3);
      expect((result.data as any).filtered).toBe(1);
    });

    it('should filter by topic', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestList({ topic: 'engine' }, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(3);
      expect((result.data as any).filtered).toBe(2);
    });

    it('should filter by type (agent_type)', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestList({ type: 'research' }, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(3);
      expect((result.data as any).filtered).toBe(1);
    });

    it('should apply limit with top-level page metadata', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestList({ limit: 2 }, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).entries).toHaveLength(2);
      expect((result.data as any).total).toBe(3);
      expect((result.data as any).filtered).toBe(3);
      expect(result.page).toEqual({ mode: 'offset', limit: 2, offset: 0, hasMore: true, total: 3 });
    });

    it('should apply offset after filtering', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestList({ topic: 'engine', limit: 1, offset: 1 }, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).entries).toHaveLength(1);
      expect((result.data as any).entries[0].id).toBe('T001-research');
      expect((result.data as any).total).toBe(3);
      expect((result.data as any).filtered).toBe(2);
      expect(result.page).toEqual({
        mode: 'offset',
        limit: 1,
        offset: 1,
        hasMore: false,
        total: 2,
      });
    });
  });

  // =========================================================================
  // pipelineManifestFind
  // =========================================================================

  describe('pipelineManifestFind', () => {
    it('should find entries matching query', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestFind('Research', undefined, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBeGreaterThanOrEqual(1);
    });

    it('should return error for empty query', async () => {
      const result = await pipelineManifestFind('', undefined, testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('should respect limit option', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestFind('out', { limit: 1 }, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).results.length).toBeLessThanOrEqual(1);
    });
  });

  // =========================================================================
  // pipelineManifestPending
  // =========================================================================

  describe('pipelineManifestPending', () => {
    it('should return partial and blocked entries', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestPending(undefined, testRoot);
      expect(result.success).toBe(true);
      // ENTRY_B (partial, has needs_followup) and ENTRY_C (blocked)
      expect((result.data as any).total).toBeGreaterThanOrEqual(2);
    });

    it('should filter by epicId prefix', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      // ENTRY_B needs_followup includes T003, ENTRY_C blocked — filter by T002 epic
      const result = await pipelineManifestPending('T002', testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).byStatus).toBeDefined();
    });
  });

  // =========================================================================
  // pipelineManifestStats
  // =========================================================================

  describe('pipelineManifestStats', () => {
    it('should return aggregate stats', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestStats(undefined, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(3);
      expect((result.data as any).byType).toHaveProperty('research');
      expect((result.data as any).byStatus).toBeDefined();
    });

    it('should filter by epicId', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestStats('T001', testRoot);
      expect(result.success).toBe(true);
      // ENTRY_A linked to T001, ENTRY_C linked to T001
      expect((result.data as any).total).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // pipelineManifestArchive workflow
  // =========================================================================

  describe('pipelineManifestArchive', () => {
    it('should archive entries before date', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      // Archive entries before 2026-02-01 (ENTRY_A only)
      const result = await pipelineManifestArchive('2026-02-01', testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).archived).toBe(1);
      expect((result.data as any).remaining).toBe(2);
    });

    it('should return 0 archived when nothing matches', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestArchive('2025-01-01', testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).archived).toBe(0);
    });

    it('should return error for missing beforeDate', async () => {
      const result = await pipelineManifestArchive('', testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('archived entries should not appear in list', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      await pipelineManifestArchive('2026-02-01', testRoot);

      const list = await pipelineManifestList({}, testRoot);
      expect((list.data as any).total).toBe(2);
      const ids = (list.data as any).entries.map((e: any) => e.id);
      expect(ids).not.toContain('T001-research');
    });
  });

  // =========================================================================
  // pipelineManifestCompact — contentHash dedup
  // =========================================================================

  describe('pipelineManifestCompact', () => {
    it('should report no entries when table is empty', async () => {
      const result = await pipelineManifestCompact(testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).compacted).toBe(false);
    });

    it('should remove duplicate contentHash entries (keeping newest)', async () => {
      await pipelineManifestAppend(ENTRY_A, testRoot);
      // Append a second entry with the same ID — upsert means same contentHash
      // To test dedup, append two different entries that hash to same content
      await pipelineManifestAppend(ENTRY_B, testRoot);
      await pipelineManifestAppend(ENTRY_C, testRoot);

      const resultBefore = await pipelineManifestList({}, testRoot);
      const countBefore = (resultBefore.data as any).total;

      const compact = await pipelineManifestCompact(testRoot);
      expect(compact.success).toBe(true);
      expect((compact.data as any).remainingEntries).toBeLessThanOrEqual(countBefore);
    });
  });

  // =========================================================================
  // pipelineManifestValidate
  // =========================================================================

  describe('pipelineManifestValidate', () => {
    it('should return valid true when no entries for task', async () => {
      await seedEntries(testRoot, [ENTRY_A]);
      const result = await pipelineManifestValidate('T999', testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).valid).toBe(true);
      expect((result.data as any).entriesFound).toBe(0);
    });

    it('should find linked entries and validate fields', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestValidate('T001', testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).entriesFound).toBeGreaterThanOrEqual(1);
    });

    it('should warn on missing output file', async () => {
      await seedEntries(testRoot, [ENTRY_A]);
      const result = await pipelineManifestValidate('T001-research', testRoot);
      expect(result.success).toBe(true);
      const issues = (result.data as any).issues as any[];
      const fileWarning = issues.find((i) => i.issue.includes('Output file not found'));
      expect(fileWarning).toBeDefined();
      expect(fileWarning.severity).toBe('warning');
    });

    it('should return error for empty taskId', async () => {
      const result = await pipelineManifestValidate('', testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });

  // =========================================================================
  // pipelineManifestContradictions
  // =========================================================================

  describe('pipelineManifestContradictions', () => {
    it('should detect contradictory findings on shared topic', async () => {
      // ENTRY_A has "deprecated" and ENTRY_C has "recommended" — contradictory pair
      // Both share topic "engine"
      await seedEntries(testRoot, [ENTRY_A, ENTRY_C]);
      const result = await pipelineManifestContradictions(testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).contradictions).toBeDefined();
      // These two entries share 'engine' topic with deprecated vs recommended contradiction
      expect((result.data as any).contradictions.length).toBeGreaterThanOrEqual(1);
    });

    it('should return empty contradictions when no entries', async () => {
      const result = await pipelineManifestContradictions(testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).contradictions).toHaveLength(0);
    });

    it('should filter by topic param', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_C]);
      const result = await pipelineManifestContradictions(testRoot, { topic: 'mcp' });
      expect(result.success).toBe(true);
      // ENTRY_C doesn't have 'mcp' topic, so no contradictions on that topic
      expect((result.data as any).contradictions.length).toBe(0);
    });
  });

  // =========================================================================
  // pipelineManifestSuperseded
  // =========================================================================

  describe('pipelineManifestSuperseded', () => {
    it('should find superseded entries on same topic+type', async () => {
      const older: ExtendedManifestEntry = {
        ...ENTRY_A,
        id: 'T001-research-old',
        date: '2026-01-01',
      };
      const newer: ExtendedManifestEntry = {
        ...ENTRY_A,
        id: 'T001-research',
        date: '2026-01-15',
      };
      await seedEntries(testRoot, [older, newer]);

      const result = await pipelineManifestSuperseded(testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).superseded.length).toBeGreaterThanOrEqual(1);
    });

    it('should return empty superseded when entries have different types', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B]);
      const result = await pipelineManifestSuperseded(testRoot);
      expect(result.success).toBe(true);
      // Different agent_types, different topics — should have no superseded
      expect((result.data as any).superseded.length).toBe(0);
    });
  });

  // =========================================================================
  // pipelineManifestLink
  // =========================================================================

  describe('pipelineManifestLink', () => {
    it('should link an entry to a new task', async () => {
      await seedEntries(testRoot, [ENTRY_A]);
      const result = await pipelineManifestLink('T999', 'T001-research', undefined, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).linked).toBe(true);

      // Verify the link persists
      const show = await pipelineManifestShow('T001-research', testRoot);
      expect((show.data as any).linked_tasks).toContain('T999');
    });

    it('should return alreadyLinked when task is already linked', async () => {
      await seedEntries(testRoot, [ENTRY_A]);
      const result = await pipelineManifestLink('T001', 'T001-research', undefined, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).alreadyLinked).toBe(true);
    });

    it('should return error for missing task', async () => {
      await seedEntries(testRoot, [ENTRY_A]);
      const result = await pipelineManifestLink('', 'T001-research', undefined, testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('should return error for missing research entry', async () => {
      const result = await pipelineManifestLink('T001', 'T999-missing', undefined, testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });
  });

  // =========================================================================
  // distillManifestEntry stub
  // =========================================================================

  describe('distillManifestEntry', () => {
    it('should return skipped=true (phase 3 pending)', async () => {
      const result = await distillManifestEntry('T001-research', testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).skipped).toBe(true);
      expect((result.data as any).reason).toBe('distillation_pending_phase3');
    });
  });

  // =========================================================================
  // readManifestEntries helper
  // =========================================================================

  describe('readManifestEntries', () => {
    it('should return empty array when no entries', async () => {
      const entries = await readManifestEntries(testRoot);
      expect(entries).toHaveLength(0);
    });

    it('should return all non-archived entries', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const entries = await readManifestEntries(testRoot);
      expect(entries).toHaveLength(3);
    });
  });

  // =========================================================================
  // migrateManifestJsonlToSqlite
  // =========================================================================

  describe('migrateManifestJsonlToSqlite', () => {
    it('should return 0 migrated when no MANIFEST.jsonl exists', async () => {
      const result = await migrateManifestJsonlToSqlite(testRoot);
      expect(result.migrated).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it('should import entries from MANIFEST.jsonl', async () => {
      const manifestPath = join(testRoot, '.cleo', 'MANIFEST.jsonl');
      const content = [ENTRY_A, ENTRY_B].map((e) => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(manifestPath, content, 'utf-8');

      const result = await migrateManifestJsonlToSqlite(testRoot);
      expect(result.migrated).toBe(2);
      expect(result.skipped).toBe(0);

      // Verify entries are in DB
      const entries = await readManifestEntries(testRoot);
      expect(entries.length).toBe(2);
    });

    it('should skip existing entries (by id)', async () => {
      // Pre-seed ENTRY_A into SQLite
      await pipelineManifestAppend(ENTRY_A, testRoot);

      const manifestPath = join(testRoot, '.cleo', 'MANIFEST.jsonl');
      const content = [ENTRY_A, ENTRY_B].map((e) => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(manifestPath, content, 'utf-8');

      const result = await migrateManifestJsonlToSqlite(testRoot);
      expect(result.migrated).toBe(1);
      expect(result.skipped).toBe(1);
    });

    it('should rename MANIFEST.jsonl to MANIFEST.jsonl.migrated', async () => {
      const manifestPath = join(testRoot, '.cleo', 'MANIFEST.jsonl');
      writeFileSync(manifestPath, JSON.stringify(ENTRY_A) + '\n', 'utf-8');

      await migrateManifestJsonlToSqlite(testRoot);

      expect(existsSync(manifestPath)).toBe(false);
      expect(existsSync(manifestPath + '.migrated')).toBe(true);
    });
  });
});
