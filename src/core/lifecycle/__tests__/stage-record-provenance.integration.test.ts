/**
 * Integration tests for stage.record artifact + provenance wiring.
 *
 * @task T5217
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const syncAdrsToDbMock = vi.hoisted(() => vi.fn(async () => ({ inserted: 0, updated: 0, skipped: 0, errors: [] })));
const linkPipelineAdrMock = vi.hoisted(() => vi.fn(async () => ({ linked: [], synced: 0, skipped: 0, errors: [] })));

vi.mock('../../adrs/sync.js', () => ({
  syncAdrsToDb: syncAdrsToDbMock,
}));

vi.mock('../../adrs/link-pipeline.js', () => ({
  linkPipelineAdr: linkPipelineAdrMock,
}));

describe('stage.record provenance integration', () => {
  let testDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'cleo-stage-record-'));
    cleoDir = join(testDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await mkdir(join(cleoDir, 'rcasd'), { recursive: true });
    await mkdir(join(cleoDir, 'adrs'), { recursive: true });
    await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
    syncAdrsToDbMock.mockClear();
    linkPipelineAdrMock.mockClear();
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('scaffolds stage markdown and persists provenance to SQLite', async () => {
    const { recordStageProgress } = await import('../index.js');
    const { getDb } = await import('../../../store/sqlite.js');
    const schema = await import('../../../store/schema.js');
    const { eq } = await import('drizzle-orm');

    await recordStageProgress('T9001', 'research', 'completed', 'Initial research complete', testDir);

    const artifactPath = join(cleoDir, 'rcasd', 'T9001', 'research', 'T9001-research.md');
    expect(existsSync(artifactPath)).toBe(true);

    const content = await readFile(artifactPath, 'utf-8');
    expect(content).toContain('epic: T9001');
    expect(content).toContain('stage: research');
    expect(content).toContain('- type: task');
    expect(content).toContain('id: T9001');

    const db = await getDb(testDir);
    const stageRows = await db
      .select()
      .from(schema.lifecycleStages)
      .where(eq(schema.lifecycleStages.id, 'stage-T9001-research'))
      .all();

    expect(stageRows.length).toBe(1);
    expect(stageRows[0]?.outputFile).toBe('.cleo/rcasd/T9001/research/T9001-research.md');

    const provenance = JSON.parse(stageRows[0]?.provenanceChainJson ?? '{}') as Record<string, unknown>;
    expect(provenance['stage']).toBe('research');
    expect(provenance['status']).toBe('completed');

    const evidenceRows = await db
      .select()
      .from(schema.lifecycleEvidence)
      .where(eq(schema.lifecycleEvidence.stageId, 'stage-T9001-research'))
      .all();

    expect(evidenceRows.length).toBe(1);
    expect(evidenceRows[0]?.type).toBe('file');
    expect(evidenceRows[0]?.uri).toBe('rcasd/T9001/research/T9001-research.md');
  });

  it('writes frontmatter backlinks to prerequisite stage artifacts', async () => {
    const { recordStageProgress } = await import('../index.js');

    await recordStageProgress('T9002', 'research', 'completed', 'Research done', testDir);
    await recordStageProgress('T9002', 'consensus', 'completed', 'Consensus done', testDir);

    const consensusPath = join(cleoDir, 'rcasd', 'T9002', 'consensus', 'T9002-consensus.md');
    const consensusContent = await readFile(consensusPath, 'utf-8');

    expect(consensusContent).toContain('- type: research');
    expect(consensusContent).toContain('path: ../research/T9002-research.md');
  });

  it('auto-triggers ADR sync and linking on architecture_decision completion', async () => {
    const { recordStageProgress } = await import('../index.js');

    await recordStageProgress('T9003', 'architecture_decision', 'completed', 'Architecture finalized', testDir);

    expect(syncAdrsToDbMock).toHaveBeenCalledWith(testDir);
    expect(linkPipelineAdrMock).toHaveBeenCalledWith(testDir, 'T9003');
  });
});
