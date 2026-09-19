/**
 * T759 regression tests: brain_observations provenance column hotfix.
 *
 * Root cause: packages/cleo/migrations/drizzle-brain/ only shipped the initial
 * migration. On a fresh install, brain_page_edges lacked the `provenance` column
 * (added by T528). The T626 post-migration guard ran an UPDATE using
 * `WHERE provenance LIKE ...` which threw "no such column: provenance".
 * That error propagated through observeBrain → memoryObserve and surfaced as
 * E_BRAIN_OBSERVE: no such column: provenance.
 *
 * Fix:
 *   1. All brain migrations are now synced to packages/cleo/migrations/drizzle-brain/
 *      by the build.mjs syncMigrationsToCleoPackage() step.
 *   2. memory-sqlite.ts T626 guard now calls ensureColumns for `provenance` on
 *      brain_page_edges before running the UPDATE, so the guard is safe even if
 *      T528 migration somehow hasn't run yet.
 *
 * Test plan:
 *   OBS-1: observeBrain succeeds on a fresh brain.db (all migrations run)
 *   OBS-2: brain_observations has agent + quality_score + memory_tier columns
 *   OBS-3: brain_page_edges has provenance column after DB init
 *   OBS-4: The T626 guard UPDATE runs without error (provenance column present)
 *   OBS-5: session.end memory-bridge write does not throw provenance error
 *   OBS-6: Simulate pre-T528 brain.db state: ensureColumns adds provenance
 *          and T626 guard runs without error
 *
 * @task T759
 * @epic T569
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DurableJobStore } from '../../store/background-jobs.js';
import {
  bindOperationWriteFence,
  createOperationExecutionContext,
} from '../../store/background-ops.js';
import * as accessorModule from '../../store/memory-accessor.js';
import { ensureLlmtxtNodeScoped } from '../graph-auto-populate.js';
import { observeBrain } from '../retrieval/observe.js';

vi.setConfig({ testTimeout: 30_000 });

import { vi } from 'vitest';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-t759-'));
  const cleoDir = join(tempDir, '.cleo');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(cleoDir, { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;
});

afterEach(async () => {
  const { closeBrainDb } = await import('../../store/memory-sqlite.js');
  closeBrainDb();
  const { resetBrainDbState } = await import('../../store/memory-sqlite.js');
  resetBrainDbState();
  delete process.env['CLEO_DIR'];
  await rm(tempDir, { recursive: true, force: true });
});

async function getTableColumns(tableName: string): Promise<Set<string>> {
  const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) throw new Error('nativeDb is null after getBrainDb()');
  type PragmaRow = { name: string };
  const rows = nativeDb.prepare(`PRAGMA table_info(${tableName})`).all() as PragmaRow[];
  return new Set(rows.map((r) => r.name));
}

describe('T759: brain_observations provenance hotfix', () => {
  describe('OBS-1: observeBrain succeeds on fresh brain.db', () => {
    it('should store an observation without error', async () => {
      const { observeBrain } = await import('../brain-retrieval.js');
      const result = await observeBrain(tempDir, {
        text: 'T759 regression test observation',
        title: 'T759 test',
        sourceType: 'manual',
      });
      expect(result).toBeDefined();
      expect(result.id).toMatch(/^O-/);
      expect(result.type).toBe('discovery');
      expect(result.createdAt).toBeTruthy();
    });
  });

  describe('OBS-2: brain_observations has all required columns after migration', () => {
    it('should have agent, quality_score, memory_tier, source_confidence, citation_count', async () => {
      const { getBrainDb } = await import('../../store/memory-sqlite.js');
      await getBrainDb(tempDir);
      const cols = await getTableColumns('brain_observations');
      // T417 columns
      expect(cols.has('agent'), 'agent column missing (T417)').toBe(true);
      // T531 columns
      expect(cols.has('quality_score'), 'quality_score column missing (T531)').toBe(true);
      // T549 columns
      expect(cols.has('memory_tier'), 'memory_tier column missing (T549)').toBe(true);
      expect(cols.has('memory_type'), 'memory_type column missing (T549)').toBe(true);
      expect(cols.has('verified'), 'verified column missing (T549)').toBe(true);
      expect(cols.has('source_confidence'), 'source_confidence column missing (T549)').toBe(true);
      expect(cols.has('citation_count'), 'citation_count column missing (T549)').toBe(true);
      // T726 columns
      expect(cols.has('tier_promoted_at'), 'tier_promoted_at column missing (T726)').toBe(true);
      expect(cols.has('tier_promotion_reason'), 'tier_promotion_reason column missing (T726)').toBe(
        true,
      );
      // provenance MUST NOT appear — it is on brain_page_edges, not brain_observations
      expect(cols.has('provenance'), 'provenance should NOT be on brain_observations').toBe(false);
    });
  });

  describe('OBS-3: brain_page_edges has provenance column after DB init', () => {
    it('should have provenance column on brain_page_edges (added by T528 migration)', async () => {
      const { getBrainDb } = await import('../../store/memory-sqlite.js');
      await getBrainDb(tempDir);
      const cols = await getTableColumns('brain_page_edges');
      expect(cols.has('provenance'), 'provenance column missing from brain_page_edges').toBe(true);
    });
  });

  describe('OBS-4: T626 guard UPDATE runs without error', () => {
    it('should not throw when running the co_retrieved normalization UPDATE', async () => {
      const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      await getBrainDb(tempDir);
      const nativeDb = getBrainNativeDb(tempDir);
      expect(nativeDb, 'nativeDb should be set after getBrainDb()').not.toBeNull();
      // The T626 guard UPDATE should have already run successfully during getBrainDb().
      // Verify it can run again without error (idempotent).
      expect(() => {
        nativeDb!
          .prepare(
            `UPDATE brain_page_edges
             SET edge_type = 'co_retrieved'
             WHERE edge_type = 'relates_to'
               AND provenance LIKE 'consolidation:%'`,
          )
          .run();
      }).not.toThrow();
    });
  });

  describe('OBS-5: memory bridge generation does not throw provenance error', () => {
    it('should generate memory bridge content without E_BRAIN_OBSERVE', async () => {
      // First write an observation so the bridge has content to read
      const { observeBrain } = await import('../brain-retrieval.js');
      await observeBrain(tempDir, {
        text: 'Memory bridge test observation for T759',
        title: 'T759 bridge test',
        sourceType: 'manual',
      });

      // Generating the memory bridge triggers queryRecentObservations which reads
      // brain_observations. This should not fail with "no such column: provenance".
      const { writeMemoryBridge } = await import('../memory-bridge.js');
      const result = await writeMemoryBridge(tempDir);
      expect(result, 'writeMemoryBridge should return a result object').toBeDefined();
      expect(result.path, 'result should have a path').toBeTruthy();
    });
  });

  describe('OBS-6: ensureColumns adds provenance to brain_page_edges when missing', () => {
    it('should add provenance column via ensureColumns and allow T626 guard UPDATE', async () => {
      const { DatabaseSync } = await import('node:sqlite');

      // Build an in-memory brain_page_edges table WITHOUT provenance (pre-T528 state)
      const db = new DatabaseSync(':memory:');
      db.exec(`
        CREATE TABLE brain_page_edges (
          from_id text NOT NULL, to_id text NOT NULL, edge_type text NOT NULL,
          weight real DEFAULT 1, created_at text DEFAULT (datetime('now')) NOT NULL,
          CONSTRAINT brain_page_edges_pk PRIMARY KEY(from_id, to_id, edge_type)
        );
      `);

      // Confirm provenance is absent
      type PragmaRow = { name: string };
      const colsBefore = db.prepare('PRAGMA table_info(brain_page_edges)').all() as PragmaRow[];
      expect(
        colsBefore.some((c) => c.name === 'provenance'),
        'provenance should be absent before ensureColumns',
      ).toBe(false);

      // Spy on the logger to capture the expected "Adding missing column" WARN.
      // ensureColumns emits this warning by design when adding a column to a legacy DB.
      // We capture it so the T9170 schema-warning gate does not flag this intentional
      // call as a violation in parallel shard output. (T9185)
      const loggerModule = await import('../../logger.js');
      const logSpy = vi.spyOn(loggerModule, 'getLogger');
      const warnSpy = vi.fn();
      logSpy.mockReturnValue({
        warn: warnSpy,
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      } as unknown as ReturnType<typeof loggerModule.getLogger>);

      // ensureColumns should add provenance without error
      const { ensureColumns } = await import('../../store/migration-manager.js');
      expect(() => {
        ensureColumns(db, 'brain_page_edges', [{ name: 'provenance', ddl: 'text' }], 'brain');
      }).not.toThrow();

      // Verify the expected warn was called (confirms ensureColumns detected the missing column)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ column: 'provenance', context: 'legacy-upgrade' }),
        expect.stringContaining('Adding missing column brain_page_edges.provenance'),
      );

      // Restore logger so subsequent tests use the real logger
      logSpy.mockRestore();

      // Confirm provenance is now present
      const colsAfter = db.prepare('PRAGMA table_info(brain_page_edges)').all() as PragmaRow[];
      expect(
        colsAfter.some((c) => c.name === 'provenance'),
        'provenance should exist after ensureColumns',
      ).toBe(true);

      // T626 guard UPDATE must not throw
      expect(() => {
        db.prepare(
          `UPDATE brain_page_edges
           SET edge_type = 'co_retrieved'
           WHERE edge_type = 'relates_to'
             AND provenance LIKE 'consolidation:%'`,
        ).run();
      }).not.toThrow();

      db.close();
    });
  });
});

describe('captured observation write boundary', () => {
  function context() {
    return createOperationExecutionContext({
      projectId: 'observation-fixture',
      projectRoot: tempDir,
      actor: 'fixture',
      operation: 'docs.projection',
      idempotencyKey: 'observation-boundary',
    });
  }

  it('keeps all supplied provenance and canonical text without detached enrichment', async () => {
    const execution = context();
    const attachments = ['a'.repeat(64)];
    try {
      const stored = await observeBrain(
        tempDir,
        {
          text: 'Unicode 😀 | canonical documentary statement',
          title: 'Sourced document',
          type: 'decision',
          project: 'observation-fixture',
          sourceType: 'agent',
          agent: 'fixture',
          sourceConfidence: 'agent',
          attachmentRefs: attachments,
          provenanceChain: ['O-source'],
          origin: 'test',
          crossRef: ['T12265'],
          _skipGate: true,
          _skipQueue: true,
        },
        execution,
      );
      const accessor = await accessorModule.getBrainAccessor(tempDir);
      const row = await accessor.getObservation(stored.id);
      expect(row).toMatchObject({
        narrative: 'Unicode 😀 | canonical documentary statement',
        title: 'Sourced document',
        type: 'decision',
        project: 'observation-fixture',
        agent: 'fixture',
        sourceType: 'agent',
        sourceConfidence: 'agent',
        origin: 'test',
        verified: false,
        attachmentsJson: JSON.stringify(attachments),
        provenanceChain: JSON.stringify(['O-source']),
        memoryTier: 'medium',
      });
      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      const native = getBrainNativeDb(tempDir)!;
      expect(
        native
          .prepare('SELECT count(*) AS count FROM brain_page_nodes WHERE id=?')
          .get('observation:' + stored.id)?.count,
      ).toBe(0);
      execution.close();
      const { closeAllDatabases } = await import('../../store/sqlite.js');
      await closeAllDatabases();
      await rm(join(tempDir, '.cleo'), { recursive: true });
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(existsSync(join(tempDir, '.cleo'))).toBe(false);
    } finally {
      execution.close();
    }
  });

  it('rejects a borrowed native transaction and preserves its unrelated write', async () => {
    const accessor = await accessorModule.getBrainAccessor(tempDir);
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const native = getBrainNativeDb(tempDir)!;
    const execution = context();
    native.exec(
      "CREATE TABLE observation_owner_proof (value TEXT); BEGIN; INSERT INTO observation_owner_proof VALUES ('unrelated')",
    );
    try {
      await expect(
        accessor.addObservation(
          { id: 'O-refused', type: 'discovery', title: 'refused' },
          execution,
        ),
      ).rejects.toThrow();
      expect(native.prepare('SELECT value FROM observation_owner_proof').get()?.value).toBe(
        'unrelated',
      );
      expect(await accessor.getObservation('O-refused')).toBeNull();
    } finally {
      native.exec('ROLLBACK');
      execution.close();
    }
  });

  it('retains the committed result when cancellation arrives inside admitted synchronous SQL', async () => {
    const accessor = await accessorModule.getBrainAccessor(tempDir);
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const native = getBrainNativeDb(tempDir)!;
    const execution = context();
    native.function('fixture_cancel_observation', () => {
      execution.close();
      return 0;
    });
    native.exec(
      'CREATE TRIGGER cancel_observation_after_insert AFTER INSERT ON brain_observations BEGIN SELECT fixture_cancel_observation(); END',
    );
    try {
      const stored = await accessor.addObservation(
        { id: 'O-committed', type: 'discovery', title: 'committed' },
        execution,
      );
      expect(execution.signal.aborted).toBe(true);
      expect(stored.id).toBe('O-committed');
      expect(await accessor.getObservation(stored.id)).toMatchObject({ title: 'committed' });
    } finally {
      execution.close();
      native.exec('DROP TRIGGER cancel_observation_after_insert');
    }
  });

  it('rolls back a failed insert and preserves diagnostic failure', async () => {
    const accessor = await accessorModule.getBrainAccessor(tempDir);
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const native = getBrainNativeDb(tempDir)!;
    const execution = context();
    native.exec(
      "CREATE TRIGGER fail_observation_after_insert AFTER INSERT ON brain_observations BEGIN SELECT RAISE(ABORT,'observation fault'); END",
    );
    try {
      await expect(
        accessor.addObservation({ id: 'O-fault', type: 'discovery', title: 'fault' }, execution),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ message: expect.stringContaining('observation fault') }),
      });
      expect(await accessor.getObservation('O-fault')).toBeNull();
    } finally {
      execution.close();
      native.exec('DROP TRIGGER fail_observation_after_insert');
    }
  });

  it('pins actual storage while mutable CLEO_DIR and CLEO_ROOT move to another project', async () => {
    const execution = context();
    const original = accessorModule.getBrainAccessor;
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const spy = vi.spyOn(accessorModule, 'getBrainAccessor').mockImplementation(async (root) => {
      entered();
      await gate;
      return original(root);
    });
    const other = join(tempDir, 'other-project');
    const pending = observeBrain(
      tempDir,
      { text: 'Project A evidence', _skipGate: true, _skipQueue: true },
      execution,
    );
    try {
      await ready;
      vi.stubEnv('CLEO_DIR', join(other, '.cleo'));
      vi.stubEnv('CLEO_ROOT', other);
      release();
      const stored = await pending;
      const { DatabaseSync } = await import('node:sqlite');
      const fresh = new DatabaseSync(join(tempDir, '.cleo', 'cleo.db'), { readOnly: true });
      try {
        expect(
          fresh.prepare('SELECT narrative FROM brain_observations WHERE id=?').get(stored.id)
            ?.narrative,
        ).toBe('Project A evidence');
      } finally {
        fresh.close();
      }
      expect(existsSync(join(other, '.cleo'))).toBe(false);
    } finally {
      release();
      await Promise.allSettled([pending]);
      execution.close();
      spy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    'current',
    'cancel',
    'stale-owner',
  ] as const)('fences actual observation and graph writes after persisted %s', async (kind) => {
    const { getDb } = await import('../../store/sqlite.js');
    const db = await getDb(tempDir);
    const jobs = new DurableJobStore(db, { projectId: 'observation-fixture', actor: 'fixture' });
    const proposalJson = JSON.stringify({ attachment: 'b'.repeat(64), owner: 'T12265' });
    const job = jobs.defer('observation-job', 'docs.projection', Date.now(), {
      projectId: 'observation-fixture',
      idempotencyKey: 'observation-boundary',
      proposalJson,
    });
    const original = context();
    const execution = bindOperationWriteFence(original, {
      dbPath: join(tempDir, '.cleo', 'cleo.db'),
      proposalHash: createHash('sha256').update(proposalJson).digest('hex'),
      lease: jobs.claim(job.id, Date.now()),
    });
    const accessor = await accessorModule.getBrainAccessor(tempDir);
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const native = getBrainNativeDb(tempDir)!;
    if (kind === 'cancel') jobs.requestCancel(job.id, Date.now());
    else if (kind === 'stale-owner') {
      native.prepare('UPDATE main.background_jobs SET lease_expires_at=0 WHERE id=?').run(job.id);
      new DurableJobStore(db, { projectId: 'observation-fixture' }).claim(job.id, Date.now());
    }
    try {
      if (kind === 'current') {
        const stored = await accessor.addObservation(
          { id: 'O-job-fenced', type: 'discovery', title: 'allowed' },
          execution,
        );
        expect(stored.title).toBe('allowed');
        expect(
          await ensureLlmtxtNodeScoped(execution, 'b'.repeat(64), 'T12265', 'allowed'),
        ).toMatchObject({ status: 'completed' });
        expect(
          native
            .prepare('SELECT count(*) AS count FROM brain_page_nodes WHERE id=?')
            .get('llmtxt:' + 'b'.repeat(64))?.count,
        ).toBe(1);
        return;
      }

      await expect(
        accessor.addObservation(
          { id: 'O-job-fenced', type: 'discovery', title: 'forbidden' },
          execution,
        ),
      ).rejects.toThrow('Domain write refused');
      await expect(
        ensureLlmtxtNodeScoped(execution, 'b'.repeat(64), 'T12265', 'forbidden'),
      ).rejects.toThrow('Domain write refused');
      expect(await accessor.getObservation('O-job-fenced')).toBeNull();
      expect(
        native
          .prepare('SELECT count(*) AS count FROM brain_page_nodes WHERE id=?')
          .get('llmtxt:' + 'b'.repeat(64))?.count,
      ).toBe(0);
    } finally {
      execution.close();
      original.close();
    }
  });

  it('replays a committed fenced observation across a new lease epoch without replacing evidence', async () => {
    const { getDb } = await import('../../store/sqlite.js');
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const db = await getDb(tempDir);
    const jobs = new DurableJobStore(db, { projectId: 'observation-fixture', actor: 'fixture' });
    const proposalJson = JSON.stringify({ attachment: 'b'.repeat(64), owner: 'T12265' });
    const job = jobs.defer('replay-job', 'docs.projection', Date.now(), {
      projectId: 'observation-fixture',
      idempotencyKey: 'observation-boundary',
      proposalJson,
    });
    const first = context();
    const fence = {
      dbPath: join(tempDir, '.cleo', 'cleo.db'),
      proposalHash: createHash('sha256').update(proposalJson).digest('hex'),
      lease: jobs.claim(job.id, Date.now()),
    };
    const params = {
      text: 'Sourced immutable 😀',
      title: 'Replay proof',
      sourceType: 'agent' as const,
      _skipGate: true,
      _skipQueue: true,
    };
    const stored = await observeBrain(tempDir, params, bindOperationWriteFence(first, fence));
    first.close(); // Simulated caller loss after the domain commit, before recording a result.
    const native = getBrainNativeDb(tempDir)!;
    native.prepare('UPDATE main.background_jobs SET lease_expires_at=0 WHERE id=?').run(job.id);
    const resumedStore = new DurableJobStore(db, {
      projectId: 'observation-fixture',
      actor: 'resumer',
    });
    const resumed = context();
    const execution = bindOperationWriteFence(resumed, {
      ...fence,
      lease: resumedStore.claim(job.id, Date.now()),
    });
    try {
      expect(execution.writeFence!.lease.epoch).toBeGreaterThan(fence.lease.epoch);
      const repeated = await observeBrain(tempDir, params, execution);
      expect(repeated).toEqual(stored);
      await expect(
        observeBrain(tempDir, { ...params, text: 'Conflicting payload' }, execution),
      ).rejects.toThrow('replay conflicts');
      expect(native.prepare('SELECT count(*) AS n FROM brain_observations').get()?.n).toBe(1);
      expect(
        native.prepare('SELECT narrative FROM brain_observations WHERE id=?').get(stored.id)
          ?.narrative,
      ).toBe(params.text);
      native
        .prepare('UPDATE brain_observations SET invalid_at=? WHERE id=?')
        .run('2020-01-01 00:00:00', stored.id);
      await expect(observeBrain(tempDir, params, execution)).rejects.toThrow('retracted');
      native.prepare('UPDATE brain_observations SET invalid_at=NULL WHERE id=?').run(stored.id);
      resumedStore.requestCancel(job.id, Date.now());
      await expect(observeBrain(tempDir, params, execution)).rejects.toThrow(
        'Domain write refused',
      );
    } finally {
      resumed.close();
    }
  });

  it('refuses delayed accessor continuation after cancellation and cleanup', async () => {
    const accessor = await accessorModule.getBrainAccessor(tempDir);
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const spy = vi.spyOn(accessorModule, 'getBrainAccessor').mockImplementation(async () => {
      entered();
      await gate;
      return accessor;
    });
    const execution = context();
    const pending = observeBrain(
      tempDir,
      { text: 'Cancelled continuation', _skipGate: true, _skipQueue: true },
      execution,
    );
    try {
      await ready;
      execution.close();
      const { closeAllDatabases } = await import('../../store/sqlite.js');
      await closeAllDatabases();
      await rm(join(tempDir, '.cleo'), { recursive: true });
      const rejected = expect(pending).rejects.toThrow();
      release();
      await rejected;
      expect(existsSync(join(tempDir, '.cleo'))).toBe(false);
    } finally {
      release();
      await Promise.allSettled([pending]);
      execution.close();
      spy.mockRestore();
    }
  });
});
