/**
 * Smoke tests for `rollupWaveStatus` and `rollupEpicStatus`.
 *
 * Validates contract shape and evidence selection against isolated canonical
 * project stores. Read failures must reject rather than satisfy assertions
 * through an early return. Deeper conduit integration is covered by T9085.
 *
 * @task T9082
 */

import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtendedManifestEntry } from '../../memory/index.js';
import {
  listMalformedManifestRows,
  pipelineManifestAppend,
  readManifestEntries,
  repairMalformedManifestRows,
  rollbackManifestRepair,
} from '../../memory/pipeline-manifest-sqlite.js';
import { drainWarnings } from '../../output.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { bindTasksDomain } from '../../store/sqlite.js';
import { rollupEpicStatus, rollupWaveStatus } from '../lead-rollup.js';

let env: TestDbEnv;
beforeEach(async () => {
  env = await createTestDb();
});
afterEach(async () => {
  await env.cleanup();
});

describe('rollupWaveStatus — contract shape', () => {
  it('returns a well-formed WaveRollup for a non-existent epic', async () => {
    const result = await rollupWaveStatus('T-DOES-NOT-EXIST', 1, env.tempDir);
    expect(result.epicId).toBe('T-DOES-NOT-EXIST');
    expect(result.waveId).toBe(1);
    expect(Array.isArray(result.workers)).toBe(true);
    expect(Array.isArray(result.blockers)).toBe(true);
    expect(typeof result.readyToAdvance).toBe('boolean');
    expect(result.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('accepts conduit messages without throwing', async () => {
    const result = await rollupWaveStatus('T-DOES-NOT-EXIST', 1, env.tempDir, {
      conduitMessages: [
        {
          taskId: 'T-CHILD-1',
          status: 'partial',
          publishedAt: '2099-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(Array.isArray(result.workers)).toBe(true);
    expect(Array.isArray(result.blockers)).toBe(true);
  });
});

describe('rollupEpicStatus — contract shape', () => {
  it('returns a well-formed EpicRollup', async () => {
    const result = await rollupEpicStatus('T-DOES-NOT-EXIST', env.tempDir);
    expect(result.epicId).toBe('T-DOES-NOT-EXIST');
    expect(typeof result.totalWorkers).toBe('number');
    expect(typeof result.doneWorkers).toBe('number');
    expect(Array.isArray(result.waves)).toBe(true);
    expect(result.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('lead manifest evidence selection', () => {
  beforeEach(async () => {
    await seedTasks(env.accessor, [
      {
        id: 'T0',
        title: 'Epic',
        description: 'Synthetic evidence parent',
        status: 'pending',
        priority: 'medium',
        type: 'epic',
        size: 'medium',
      },
      ...['T1', 'T10', 'T2'].map((id) => ({
        id,
        title: `Worker ${id}`,
        description: 'Synthetic worker',
        status: 'pending' as const,
        priority: 'medium' as const,
        type: 'task' as const,
        size: 'small' as const,
        parentId: 'T0',
      })),
    ]);
    const { native } = await bindTasksDomain(env.tempDir);
    native.exec('PRAGMA foreign_keys=ON');
    expect(native.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });

  async function append(
    id: string,
    taskId: string | null,
    date: string,
  ): Promise<ExtendedManifestEntry> {
    const entry: ExtendedManifestEntry = {
      id,
      file: `out/${id}.md`,
      title: `Evidence ${id}`,
      date,
      status: 'completed',
      agent_type: 'implementation',
      topics: ['evidence'],
      key_findings: ['Verified synthetic task evidence'],
      actionable: true,
      linked_tasks: taskId ? [taskId] : [],
      needs_followup: [],
    };
    expect(await pipelineManifestAppend(entry, env.tempDir)).toMatchObject({ success: true });
    return entry;
  }

  it('selects each task’s exact newest linked evidence without T1/T10 prefix contamination', async () => {
    await append('old-worker-one', 'T1', '2026-01-01');
    await append('new-worker-one', 'T1', '2026-02-01');
    await append('T10-newer-unrelated', 'T10', '2026-03-01');
    await append('T2-unlinked-name', null, '2026-04-01');
    const wave = await rollupWaveStatus('T0', 1, env.tempDir);
    expect(wave.workers).toHaveLength(3);
    expect(wave.workers.find((worker) => worker.taskId === 'T1')).toMatchObject({
      latestManifestEntry: 'new-worker-one',
      latestManifestStatus: 'completed',
      latestManifestAt: '2026-02-01',
    });
    expect(wave.workers.find((worker) => worker.taskId === 'T10')).toMatchObject({
      latestManifestEntry: 'T10-newer-unrelated',
    });
    expect(wave.workers.find((worker) => worker.taskId === 'T2')).toMatchObject({
      latestManifestEntry: null,
      latestManifestStatus: null,
    });
  });

  it('preserves eligible legacy evidence and excludes archived modern entries', async () => {
    const older = await append('old-linked', 'T1', '2026-01-01');
    await append('new-archived', 'T1', '2026-02-01');
    const { native } = await bindTasksDomain(env.tempDir);
    native
      .prepare('UPDATE docs_pipeline_manifest SET archived_at=? WHERE id=?')
      .run('2026-03-01', 'new-archived');
    const historical = { ...older, id: 'historical-worker-two', linked_tasks: ['T2'] };
    native
      .prepare(
        'INSERT INTO pipeline_manifest(id,type,content,status,metadata_json,created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        historical.id,
        'implementation',
        JSON.stringify(historical),
        'active',
        JSON.stringify(historical),
        '2026-03-01',
      );
    const wave = await rollupWaveStatus('T0', 1, env.tempDir);
    expect(wave.workers.find((worker) => worker.taskId === 'T1')).toMatchObject({
      latestManifestEntry: 'old-linked',
    });
    expect(wave.workers.find((worker) => worker.taskId === 'T2')).toMatchObject({
      latestManifestEntry: 'historical-worker-two',
    });
    expect(native.prepare('SELECT count(*) AS n FROM pipeline_manifest').get()).toEqual({ n: 1 });
  });

  it('rejects conflicting histories with their structured evidence instead of hiding the read failure', async () => {
    const entry = await append('conflicting-id', 'T1', '2026-01-01');
    const { native } = await bindTasksDomain(env.tempDir);
    native
      .prepare(
        'INSERT INTO pipeline_manifest(id,type,content,status,metadata_json,created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        entry.id,
        'implementation',
        'Different historical payload',
        'active',
        JSON.stringify(entry),
        '2026-01-01',
      );
    await expect(rollupWaveStatus('T0', 1, env.tempDir)).rejects.toMatchObject({
      code: 'E_MANIFEST_ID_CONFLICT',
      details: {
        entryId: entry.id,
        candidates: expect.arrayContaining([
          expect.objectContaining({ table: 'docs_pipeline_manifest' }),
          expect.objectContaining({ table: 'pipeline_manifest' }),
        ]),
      },
    });
  });

  it('propagates the actual native database read failure', async () => {
    const { native } = await bindTasksDomain(env.tempDir);
    native.exec('DROP TABLE docs_pipeline_manifest');
    await expect(rollupWaveStatus('T0', 1, env.tempDir)).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining('no such table: docs_pipeline_manifest'),
      }),
    });
  });

  /** Corrupt a stored row the way T1171-w2a-10-audit is: actionable is an array. */
  async function corrupt(id: string, metadata: string): Promise<void> {
    const { native } = await bindTasksDomain(env.tempDir);
    native
      .prepare('UPDATE docs_pipeline_manifest SET metadata_json=? WHERE id=?')
      .run(metadata, id);
  }

  it('T12686: roll-up skips a malformed row with a warning naming it and the repair, and reports the rest', async () => {
    await append('good-one', 'T1', '2026-01-01');
    await append('T1171-w2a-10-audit', 'T10', '2026-02-01');
    await corrupt(
      'T1171-w2a-10-audit',
      JSON.stringify({ title: 'audit', actionable: ['do x'], linked_tasks: ['T10'] }),
    );
    drainWarnings();
    const wave = await rollupWaveStatus('T0', 1, env.tempDir);
    expect(wave.workers).toHaveLength(3);
    expect(wave.workers.find((w) => w.taskId === 'T1')).toMatchObject({
      latestManifestEntry: 'good-one',
    });
    expect(wave.workers.find((w) => w.taskId === 'T10')?.latestManifestEntry).toBeNull();
    const warning = drainWarnings()?.find((w) => w.code === 'W_MANIFEST_ROW_MALFORMED');
    expect(warning?.message).toContain("'T1171-w2a-10-audit'");
    expect(warning?.message).toContain('actionable');
    expect(warning?.message).toContain('cleo doctor manifest-rows --repair');
  });

  it('T12686: doctor lists, repairs with a receipt (nothing lost), and rolls back', async () => {
    await append('bad-field', 'T1', '2026-01-01');
    await append('bad-json', 'T2', '2026-01-02');
    await append('fine', 'T10', '2026-01-03');
    const badField = JSON.stringify({ title: 'x', actionable: ['keep me'], linked_tasks: ['T1'] });
    await corrupt('bad-field', badField);
    await corrupt('bad-json', '{not json');

    const listed = await listMalformedManifestRows(env.tempDir);
    expect(listed.map((r) => [r.entryId, r.reason, r.fields])).toEqual([
      ['bad-json', 'invalid-json', ['metadata_json']],
      ['bad-field', 'field-contract', ['actionable']],
    ]);

    const plan = await repairMalformedManifestRows(env.tempDir, { dryRun: true });
    expect(plan.receiptPath).toBeNull();
    expect(await listMalformedManifestRows(env.tempDir)).toHaveLength(2);

    const receipt = await repairMalformedManifestRows(env.tempDir);
    expect(receipt.changes.map((c) => c.entryId).sort()).toEqual(['bad-field', 'bad-json']);
    expect(existsSync(receipt.receiptPath ?? '')).toBe(true);
    expect(JSON.parse(readFileSync(receipt.receiptPath ?? '', 'utf8')).changes).toHaveLength(2);
    expect(await listMalformedManifestRows(env.tempDir)).toEqual([]);
    const entries = await readManifestEntries(env.tempDir);
    expect(entries.find((e) => e.id === 'bad-field')?.linked_tasks).toEqual(['T1']);
    const after = JSON.parse(
      receipt.changes.find((c) => c.entryId === 'bad-field')?.after ?? '{}',
    ) as Record<string, unknown>;
    expect(after['_malformed']).toEqual({ actionable: ['keep me'] });
    expect(after['actionable']).toBeUndefined();

    // A row edited after the repair is not rolled back over the later edit.
    await corrupt('bad-json', JSON.stringify({ title: 'fixed by hand' }));
    const back = await rollbackManifestRepair(receipt.receiptPath ?? '', env.tempDir);
    expect(back).toEqual({ restored: ['bad-field'], skipped: ['bad-json'] });
    expect((await listMalformedManifestRows(env.tempDir)).map((r) => r.entryId)).toEqual([
      'bad-field',
    ]);
  });
});
