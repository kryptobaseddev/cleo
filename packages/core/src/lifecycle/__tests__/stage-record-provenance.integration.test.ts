/**
 * Integration tests for stage.record artifact + provenance wiring.
 *
 * @task T5217
 */

import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const syncAdrsToDbMock = vi.hoisted(() =>
  vi.fn(async () => ({ inserted: 0, updated: 0, skipped: 0, errors: [] })),
);
const linkPipelineAdrMock = vi.hoisted(() =>
  vi.fn(async () => ({ linked: [], synced: 0, skipped: 0, errors: [] })),
);

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
    // Close ALL SQLite connections before cleanup — Windows locks open files
    try {
      const { closeAllDatabases } = await import('../../store/sqlite.js');
      await closeAllDatabases();
    } catch {
      /* module may not be loaded */
    }
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes a stage artifact given real content and persists provenance to SQLite', async () => {
    const { recordStageProgress } = await import('../index.js');
    const { getDb } = await import('../../store/sqlite.js');
    const schema = await import('../../store/tasks-schema.js');
    const { eq } = await import('drizzle-orm');

    await recordStageProgress(
      testDir,
      {
        taskId: 'T9001',
        stage: 'research',
        status: 'completed',
        notes: 'Initial research complete',
      },
      { artifactContent: '# Research (T9001)\n\nFindings.\n' },
    );

    const artifactPath = join(cleoDir, 'rcasd', 'T9001', 'research', 'T9001-research.md');
    expect(existsSync(artifactPath)).toBe(true);

    const content = await readFile(artifactPath, 'utf-8');
    expect(content).toContain('epic: T9001');
    expect(content).toContain('stage: research');
    expect(content).toContain('- type: task');
    expect(content).toContain('id: T9001');
    expect(content).toContain('Findings.');

    const db = await getDb(testDir);
    const stageRows = await db
      .select()
      .from(schema.lifecycleStages)
      .where(eq(schema.lifecycleStages.id, 'stage-T9001-research'))
      .all();

    expect(stageRows.length).toBe(1);
    expect(stageRows[0]?.outputFile?.replaceAll('\\', '/')).toBe(
      '.cleo/rcasd/T9001/research/T9001-research.md',
    );

    const provenance = JSON.parse(stageRows[0]?.provenanceChainJson ?? '{}') as Record<
      string,
      unknown
    >;
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

    await recordStageProgress(
      testDir,
      { taskId: 'T9002', stage: 'research', status: 'completed', notes: 'Research done' },
      { artifactContent: '# Research\n' },
    );
    await recordStageProgress(
      testDir,
      { taskId: 'T9002', stage: 'consensus', status: 'completed', notes: 'Consensus done' },
      { artifactContent: '# Consensus\n' },
    );

    const consensusPath = join(cleoDir, 'rcasd', 'T9002', 'consensus', 'T9002-consensus.md');
    const consensusContent = await readFile(consensusPath, 'utf-8');

    expect(consensusContent).toContain('- type: research');
    expect(consensusContent).toContain('path: ../research/T9002-research.md');
  });

  it('T14277: a stage transition without content writes no file and leaves git status clean', async () => {
    const { execFileSync } = await import('node:child_process');
    const { readdirSync } = await import('node:fs');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: testDir, encoding: 'utf-8', stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    // The project's own .cleo/.gitignore, as `cleo init` installs it.
    const { readFileSync, writeFileSync } = await import('node:fs');
    writeFileSync(
      join(cleoDir, '.gitignore'),
      readFileSync(new URL('../../../templates/cleo-gitignore', import.meta.url), 'utf-8'),
    );
    git('add', '.cleo/.gitignore');
    git('-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', 'init');
    const { recordStageProgress } = await import('../index.js');

    for (const stage of ['research', 'consensus', 'architecture_decision'] as const) {
      await recordStageProgress(testDir, { taskId: 'T9004', stage, status: 'completed' });
    }

    expect(readdirSync(join(cleoDir, 'rcasd'))).toEqual([]);
    // A file someone does write under rcasd/ stays ignored (no `!rcasd/**`).
    mkdirSync(join(cleoDir, 'rcasd', 'T9004'), { recursive: true });
    writeFileSync(join(cleoDir, 'rcasd', 'T9004', 'stray.md'), 'x');
    expect(git('status', '--porcelain', '--untracked-files=all', '--', '.cleo/rcasd')).toBe('');
  });

  it('auto-triggers ADR sync and linking on architecture_decision completion', async () => {
    const { recordStageProgress } = await import('../index.js');

    await recordStageProgress(testDir, {
      taskId: 'T9003',
      stage: 'architecture_decision',
      status: 'completed',
      notes: 'Architecture finalized',
    });

    expect(syncAdrsToDbMock).toHaveBeenCalledWith(testDir);
    expect(linkPipelineAdrMock).toHaveBeenCalledWith(testDir, 'T9003');
  });
});
