/** Real-store regressions for bounded, transactional staged graph reconstruction. */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeTempDirSync } from '../../__tests__/test-cleanup.js';
import { getBrainDb, getBrainNativeDb, resetBrainDbState } from '../../store/memory-sqlite.js';
import {
  approveBackfillRun,
  listBackfillRuns,
  rollbackBackfillRun,
  stagedBackfillRun,
} from '../brain-backfill.js';

let root: string;
let oldDir: string | undefined;
let oldHome: string | undefined;

function native() {
  const db = getBrainNativeDb(root);
  if (!db) throw new Error('Missing fixture database');
  return db;
}
function seed(id: string, narrative = 'Sourced incident knowledge'): void {
  native()
    .prepare(
      "INSERT INTO main.brain_observations (id,type,title,narrative) VALUES (?,'bugfix',?,?)",
    )
    .run(id, `Incident ${id}`, narrative);
}
function nodeCount(): number {
  return Number(
    native().prepare('SELECT COUNT(*) AS total FROM main.brain_page_nodes').get()?.total,
  );
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cleo-safe-backfill-'));
  mkdirSync(join(root, '.cleo'));
  oldDir = process.env['CLEO_DIR'];
  oldHome = process.env['CLEO_HOME'];
  process.env['CLEO_DIR'] = join(root, '.cleo');
  process.env['CLEO_HOME'] = join(root, 'home');
  await getBrainDb(root);
});
afterEach(() => {
  resetBrainDbState();
  if (oldDir === undefined) delete process.env['CLEO_DIR'];
  else process.env['CLEO_DIR'] = oldDir;
  if (oldHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = oldHome;
  removeTempDirSync(root);
});

describe('staged backfill exact-source lifecycle', () => {
  it('stages source-bound missing nodes without changing live graph rows', async () => {
    seed('O-first');
    const staged = await stagedBackfillRun(root, { source: 'fixture-review' });
    expect(staged.run).toMatchObject({
      status: 'staged',
      source: 'fixture-review',
      rowsAffected: 1,
      targetTable: 'brain_page_nodes',
    });
    expect(staged.empty).toBe(false);
    expect(nodeCount()).toBe(0);
    expect(JSON.parse(staged.run.rollbackSnapshotJson ?? '{}')).toMatchObject({
      version: 2,
      projectRoot: root,
      created: [],
      candidates: [
        { id: 'observation:O-first', sourceId: 'O-first', sourceTable: 'brain_observations' },
      ],
    });
  });

  it('approves only reviewed IDs and preserves all pre-existing historical edges', async () => {
    seed('O-first');
    native()
      .prepare(
        "INSERT INTO main.brain_page_edges (from_id,to_id,edge_type) VALUES ('observation:O-first','observation:missing-history','supersedes')",
      )
      .run();
    const originalEdges = native().prepare('SELECT * FROM main.brain_page_edges').all();
    const staged = await stagedBackfillRun(root);
    seed('O-added-later');
    const approved = await approveBackfillRun(root, staged.run.id, 'calling-agent');
    expect(approved.run).toMatchObject({ status: 'approved', approvedBy: 'calling-agent' });
    expect(approved.backfillResult).toMatchObject({
      before: { observations: 2 },
      nodesInserted: 1,
      edgesInserted: 0,
      stubsCreated: 0,
    });
    expect(native().prepare('SELECT id FROM main.brain_page_nodes').all()).toEqual([
      { id: 'observation:O-first' },
    ]);
    expect(native().prepare('SELECT * FROM main.brain_page_edges').all()).toEqual(originalEdges);
    expect((await approveBackfillRun(root, staged.run.id)).alreadySettled).toBe(true);
    const rollback = await rollbackBackfillRun(root, staged.run.id);
    expect(rollback.deletedRows).toBe(1);
    expect(nodeCount()).toBe(0);
    expect(native().prepare('SELECT * FROM main.brain_page_edges').all()).toEqual(originalEdges);
    expect((await rollbackBackfillRun(root, staged.run.id)).alreadySettled).toBe(true);
  });

  it('preserves typed learning content when reconstructing its derived node', async () => {
    native()
      .prepare(
        "INSERT INTO main.brain_learnings (id,insight,source,confidence) VALUES ('L-fixture','Verify image links after expiry','incident evidence',0.8)",
      )
      .run();
    const staged = await stagedBackfillRun(root);
    const approved = await approveBackfillRun(root, staged.run.id);
    expect(approved.backfillResult?.before.learnings).toBe(1);
    expect(
      native()
        .prepare("SELECT label,node_type FROM main.brain_page_nodes WHERE id='learning:L-fixture'")
        .get(),
    ).toEqual({ label: 'Verify image links after expiry', node_type: 'learning' });
  });

  it('rejects changed source content before applying any staged node', async () => {
    seed('O-first');
    seed('O-second');
    const staged = await stagedBackfillRun(root);
    const concurrent = new DatabaseSync(join(root, '.cleo', 'cleo.db'));
    try {
      concurrent
        .prepare(
          "UPDATE main.brain_observations SET narrative='Corrected incident source' WHERE id='O-second'",
        )
        .run();
    } finally {
      concurrent.close();
    }
    await expect(approveBackfillRun(root, staged.run.id)).rejects.toThrow('stale');
    expect(nodeCount()).toBe(0);
    expect((await listBackfillRuns(root))[0]?.status).toBe('staged');
  });

  it('rejects a concurrent node insertion or incident-edge edit', async () => {
    seed('O-first');
    const staged = await stagedBackfillRun(root);
    native()
      .prepare(
        "INSERT INTO main.brain_page_nodes (id,node_type,label) VALUES ('observation:O-first','observation','Another caller')",
      )
      .run();
    await expect(approveBackfillRun(root, staged.run.id)).rejects.toThrow('stale');
    expect(nodeCount()).toBe(1);
    native().prepare("DELETE FROM main.brain_page_nodes WHERE id='observation:O-first'").run();
    native()
      .prepare(
        "INSERT INTO main.brain_page_edges (from_id,to_id,edge_type) VALUES ('observation:O-first','new-target','supersedes')",
      )
      .run();
    await expect(approveBackfillRun(root, staged.run.id)).rejects.toThrow('stale');
    expect(nodeCount()).toBe(0);
  });

  it('serializes competing approvals so only one staged run inserts the missing node', async () => {
    seed('O-first');
    const first = await stagedBackfillRun(root);
    const second = await stagedBackfillRun(root);
    const results = await Promise.allSettled([
      approveBackfillRun(root, first.run.id),
      approveBackfillRun(root, second.run.id),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(nodeCount()).toBe(1);
  });

  it.each(['node', 'edge'])('refuses rollback after concurrent %s changes', async (kind) => {
    seed('O-first');
    const staged = await stagedBackfillRun(root);
    await approveBackfillRun(root, staged.run.id);
    if (kind === 'node')
      native()
        .prepare(
          "UPDATE main.brain_page_nodes SET label='User correction' WHERE id='observation:O-first'",
        )
        .run();
    else
      native()
        .prepare(
          "INSERT INTO main.brain_page_edges (from_id,to_id,edge_type) VALUES ('observation:O-first','new-history','supersedes')",
        )
        .run();
    await expect(rollbackBackfillRun(root, staged.run.id)).rejects.toThrow('rollback is stale');
    expect(nodeCount()).toBe(1);
    expect((await listBackfillRuns(root))[0]?.status).toBe('approved');
  });

  it('rolls back every insert if receipt publication fails', async () => {
    seed('O-first');
    const staged = await stagedBackfillRun(root);
    native().exec(
      "CREATE TRIGGER fail_receipt BEFORE UPDATE ON brain_backfill_runs BEGIN SELECT RAISE(ABORT,'receipt failed'); END",
    );
    await expect(approveBackfillRun(root, staged.run.id)).rejects.toThrow('receipt failed');
    expect(nodeCount()).toBe(0);
  });

  it('discards staged runs without mutation and rejects untrustworthy legacy approved snapshots', async () => {
    seed('O-first');
    const staged = await stagedBackfillRun(root);
    expect((await rollbackBackfillRun(root, staged.run.id)).deletedRows).toBe(0);
    const legacy = await stagedBackfillRun(root);
    native()
      .prepare("UPDATE main.brain_backfill_runs SET rollback_snapshot_json='[]' WHERE id=?")
      .run(legacy.run.id);
    await expect(approveBackfillRun(root, legacy.run.id)).rejects.toThrow('lacks exact source');
    native()
      .prepare("UPDATE main.brain_backfill_runs SET status='approved' WHERE id=?")
      .run(legacy.run.id);
    await expect(rollbackBackfillRun(root, legacy.run.id)).rejects.toThrow('lacks exact source');
  });

  it('supports empty runs, status listing and repeat approval without extra mutations', async () => {
    const staged = await stagedBackfillRun(root);
    expect(staged.empty).toBe(true);
    expect((await approveBackfillRun(root, staged.run.id)).backfillResult?.nodesInserted).toBe(0);
    expect((await listBackfillRuns(root, { status: 'approved' })).map((run) => run.id)).toEqual([
      staged.run.id,
    ]);
    expect(await listBackfillRuns(root, { status: 'staged' })).toEqual([]);
  });

  it('stages only selected IDs even beyond the first 501 missing rows', async () => {
    const db = native();
    db.exec('BEGIN');
    try {
      for (let index = 0; index < 502; index++) seed(`O-${String(index).padStart(4, '0')}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const nodeIds = ['observation:O-0000', 'observation:O-0501'];
    const staged = await stagedBackfillRun(root, { nodeIds });
    expect(staged.run.rowsAffected).toBe(2);
    const approved = await approveBackfillRun(root, staged.run.id);
    expect(approved.backfillResult?.nodesInserted).toBe(2);
    expect(db.prepare('SELECT id FROM main.brain_page_nodes ORDER BY id').all()).toEqual(
      nodeIds.map((id) => ({ id })),
    );
    await expect(stagedBackfillRun(root, { nodeIds })).rejects.toThrow('already indexed');
  });

  it('rejects duplicate, unavailable and ineligible selections without staging a partial repair', async () => {
    seed('O-first');
    seed('O-retired');
    native()
      .prepare(
        "UPDATE main.brain_observations SET invalid_at='2026-09-18T00:00:00Z' WHERE id='O-retired'",
      )
      .run();
    await expect(
      stagedBackfillRun(root, { nodeIds: ['observation:O-first', 'observation:O-first'] }),
    ).rejects.toThrow('duplicates');
    await expect(
      stagedBackfillRun(root, { nodeIds: ['observation:O-first', 'observation:absent'] }),
    ).rejects.toThrow('missing');
    await expect(
      stagedBackfillRun(root, { nodeIds: ['observation:O-first', 'observation:O-retired'] }),
    ).rejects.toThrow('not currently eligible');
    await expect(stagedBackfillRun(root, { nodeIds: [] })).rejects.toThrow();
    expect(await listBackfillRuns(root)).toEqual([]);
    expect(nodeCount()).toBe(0);
  });

  it('rejects unsupported target tables and missing run IDs', async () => {
    await expect(stagedBackfillRun(root, { targetTable: 'brain_observations' })).rejects.toThrow(
      'derived brain_page_nodes',
    );
    await expect(approveBackfillRun(root, 'absent')).rejects.toThrow(
      "Backfill run 'absent' not found",
    );
    await expect(rollbackBackfillRun(root, 'absent')).rejects.toThrow(
      "Backfill run 'absent' not found",
    );
  });
});
