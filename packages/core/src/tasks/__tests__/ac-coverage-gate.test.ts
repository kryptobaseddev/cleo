/**
 * Tests for the AC-coverage gate (T10509) — the load-bearing IVTR
 * closure piece that refuses `cleo complete <tid>` when any AC has no
 * `evidence_ac_bindings` row.
 *
 * Covers the six paths called out in T10509 AC #5:
 *   1. complete-with-coverage  (happy path — direct binding satisfies AC)
 *   2. complete-without-coverage (error path — unsatisfied ACs surfaced)
 *   3. waive-with-reason  (waiver recorded to audit jsonl, completion proceeds)
 *   4. waive-without-reason (rejected with structured error)
 *   5. CLEO_OWNER_OVERRIDE  (full bypass, audit row written)
 *   6. mixed coverage  (some satisfied + some not — gate fails on the residue)
 *
 * @task T10509
 * @saga T10377 (SG-IVTR-AC-BINDING)
 * @adr ADR-079-r4
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CleoError } from '../../errors.js';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { getDb, resetDbState } from '../../store/sqlite.js';
import * as schema from '../../store/tasks-schema.js';
import {
  appendAcCoverageForceBypass,
  appendAcWaiverAudit,
  applyWaivers,
  computeAcCoverage,
  readOwnerOverride,
  resolveWaivers,
} from '../ac-coverage-gate.js';
import { addTask } from '../add.js';
import { completeTask } from '../complete.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Insert a binding row directly via the Drizzle schema, mirroring the
 * pattern used by `satisfies-validator.test.ts` (T10507). Used to seed
 * coverage rows that the dispatch layer will later own (T10505/T10506
 * writer wiring is out of scope for T10509).
 */
async function seedBinding(
  cwd: string,
  acId: string,
  bindingType: 'direct' | 'satisfies' | 'coverage' = 'direct',
  atomId: string = `commit:${randomUUID().replace(/-/g, '').slice(0, 12)}`,
): Promise<void> {
  const db = await getDb(cwd);
  await db
    .insert(schema.evidenceAcBindings)
    .values({ id: randomUUID(), evidenceAtomId: atomId, acId, bindingType })
    .run();
}

/**
 * Read all lines from a JSONL audit file. Returns `[]` if the file does
 * not exist (the audit dir is lazily created).
 */
async function readJsonl<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await readFile(filePath, { encoding: 'utf8' });
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Create a task with the given AC list and return both the task and its
 * persisted AC rows (the rows carry the UUIDs we need to seed bindings).
 *
 * Pulls `addTask` from the same code path that writes to
 * `task_acceptance_criteria` so the test always exercises the
 * production AC writer.
 */
async function createTaskWithAcs(
  accessor: DataAccessor,
  projectRoot: string,
  title: string,
  acceptance: string[],
) {
  // T10509: anti-hallucination guard rejects title===description, so
  // give the description a unique prefix.
  const result = await addTask(
    { title, description: `${title} — seeded fixture for the T10509 gate`, acceptance },
    projectRoot,
    accessor,
  );
  const acRows = await accessor.getAcRows(result.task.id);
  return { task: result.task, acRows };
}

describe('ac-coverage-gate (T10509) — unit helpers', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_OWNER_OVERRIDE'];
    delete process.env['CLEO_OWNER_OVERRIDE_REASON'];
    resetDbState();
    await env.cleanup();
  });

  describe('computeAcCoverage', () => {
    it('returns {ok:true} for a task with zero ACs (no-op gate)', async () => {
      const { task } = await createTaskWithAcs(accessor, env.tempDir, 'No ACs', []);
      const result = await computeAcCoverage(task.id, accessor);
      expect(result.ok).toBe(true);
    });

    it('returns {ok:false} listing every uncovered AC', async () => {
      const { task, acRows } = await createTaskWithAcs(accessor, env.tempDir, 'Three ACs', [
        'A',
        'B',
        'C',
      ]);
      expect(acRows).toHaveLength(3);
      const result = await computeAcCoverage(task.id, accessor);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.unsatisfied).toHaveLength(3);
      expect(result.unsatisfied.map((u) => u.alias).sort()).toEqual(['AC1', 'AC2', 'AC3']);
      expect(result.unsatisfied.map((u) => u.text).sort()).toEqual(['A', 'B', 'C']);
    });

    it('returns {ok:true} when every AC has at least one binding', async () => {
      const { task, acRows } = await createTaskWithAcs(accessor, env.tempDir, 'All covered', [
        'A',
        'B',
      ]);
      for (const row of acRows) await seedBinding(env.tempDir, row.id);
      const result = await computeAcCoverage(task.id, accessor);
      expect(result.ok).toBe(true);
    });

    it('treats all three binding kinds (direct, satisfies, coverage) as satisfying', async () => {
      const { task, acRows } = await createTaskWithAcs(accessor, env.tempDir, 'Mixed kinds', [
        'A',
        'B',
        'C',
      ]);
      await seedBinding(env.tempDir, acRows[0]!.id, 'direct');
      await seedBinding(env.tempDir, acRows[1]!.id, 'satisfies');
      await seedBinding(env.tempDir, acRows[2]!.id, 'coverage');
      const result = await computeAcCoverage(task.id, accessor);
      expect(result.ok).toBe(true);
    });
  });

  describe('resolveWaivers', () => {
    it('resolves UUID tokens against the task AC rows', async () => {
      const { acRows } = await createTaskWithAcs(accessor, env.tempDir, 'Waivers', ['A', 'B']);
      const result = resolveWaivers(`${acRows[0]!.id},${acRows[1]!.id}`, acRows);
      expect(result.acIds).toHaveLength(2);
      expect(result.unresolved).toEqual([]);
      expect(result.aliases).toEqual(['AC1', 'AC2']);
    });

    it('resolves AC<n> alias tokens', async () => {
      const { acRows } = await createTaskWithAcs(accessor, env.tempDir, 'Alias waivers', [
        'A',
        'B',
        'C',
      ]);
      const result = resolveWaivers('AC1,AC3', acRows);
      expect(result.acIds).toEqual([acRows[0]!.id, acRows[2]!.id]);
      expect(result.aliases).toEqual(['AC1', 'AC3']);
      expect(result.unresolved).toEqual([]);
    });

    it('surfaces unresolved tokens without crashing', async () => {
      const { acRows } = await createTaskWithAcs(accessor, env.tempDir, 'Unresolved', ['A']);
      const result = resolveWaivers('AC1,AC99,not-a-uuid', acRows);
      expect(result.aliases).toEqual(['AC1']);
      expect(result.unresolved).toEqual(['AC99', 'not-a-uuid']);
    });

    it('returns empty descriptor for empty/undefined input', () => {
      expect(resolveWaivers(undefined, [])).toEqual({
        acIds: [],
        aliases: [],
        texts: [],
        unresolved: [],
      });
      expect(resolveWaivers('   ', [])).toEqual({
        acIds: [],
        aliases: [],
        texts: [],
        unresolved: [],
      });
    });

    it('deduplicates the same AC referenced twice', async () => {
      const { acRows } = await createTaskWithAcs(accessor, env.tempDir, 'Dedupe', ['A']);
      const result = resolveWaivers(`AC1,${acRows[0]!.id}`, acRows);
      expect(result.acIds).toHaveLength(1);
    });
  });

  describe('applyWaivers', () => {
    it('subtracts waived AC ids from the unsatisfied list', () => {
      const unsatisfied = [
        { acId: 'a', alias: 'AC1', text: 'a' },
        { acId: 'b', alias: 'AC2', text: 'b' },
      ];
      const residual = applyWaivers(unsatisfied, new Set(['a']));
      expect(residual).toEqual([{ acId: 'b', alias: 'AC2', text: 'b' }]);
    });

    it('is a no-op when the waiver set is empty', () => {
      const unsatisfied = [{ acId: 'a', alias: 'AC1', text: 'a' }];
      const residual = applyWaivers(unsatisfied, new Set());
      expect(residual).toEqual(unsatisfied);
    });
  });

  describe('readOwnerOverride', () => {
    it('returns the reason when both env vars are set', () => {
      const env = {
        CLEO_OWNER_OVERRIDE: '1',
        CLEO_OWNER_OVERRIDE_REASON: 'incident 1234',
      } as NodeJS.ProcessEnv;
      expect(readOwnerOverride(env)).toBe('incident 1234');
    });

    it('returns null when the flag is missing', () => {
      const env = { CLEO_OWNER_OVERRIDE_REASON: 'r' } as NodeJS.ProcessEnv;
      expect(readOwnerOverride(env)).toBeNull();
    });

    it('returns null when the reason is missing or blank', () => {
      expect(readOwnerOverride({ CLEO_OWNER_OVERRIDE: '1' } as NodeJS.ProcessEnv)).toBeNull();
      expect(
        readOwnerOverride({
          CLEO_OWNER_OVERRIDE: '1',
          CLEO_OWNER_OVERRIDE_REASON: '   ',
        } as NodeJS.ProcessEnv),
      ).toBeNull();
    });

    it('accepts the alternate truthy spelling', () => {
      expect(
        readOwnerOverride({
          CLEO_OWNER_OVERRIDE: 'true',
          CLEO_OWNER_OVERRIDE_REASON: 'r',
        } as NodeJS.ProcessEnv),
      ).toBe('r');
    });
  });

  describe('audit-log writers', () => {
    it('appends an AC waiver entry to .cleo/audit/ac-waiver.jsonl', async () => {
      await appendAcWaiverAudit(
        {
          timestamp: '2026-05-24T00:00:00Z',
          taskId: 'T9999',
          waivedAcs: ['ac-1'],
          waivedAliases: ['AC1'],
          reason: 'self-bootstrap test',
          actor: 'test',
          unresolvedTokens: [],
        },
        env.tempDir,
      );
      const rows = await readJsonl<Record<string, unknown>>(
        join(env.tempDir, '.cleo', 'audit', 'ac-waiver.jsonl'),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.['taskId']).toBe('T9999');
      expect(rows[0]?.['reason']).toBe('self-bootstrap test');
    });

    it('appends an AC-coverage bypass entry to .cleo/audit/force-bypass.jsonl', async () => {
      await appendAcCoverageForceBypass(
        {
          kind: 'ac-coverage',
          timestamp: '2026-05-24T00:00:00Z',
          taskId: 'T9999',
          reason: 'owner approved',
          actor: 'owner',
          unsatisfied: [{ acId: 'a', alias: 'AC1', text: 'a' }],
        },
        env.tempDir,
      );
      const rows = await readJsonl<Record<string, unknown>>(
        join(env.tempDir, '.cleo', 'audit', 'force-bypass.jsonl'),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.['kind']).toBe('ac-coverage');
      expect(rows[0]?.['unsatisfied']).toHaveLength(1);
    });
  });
});

describe('completeTask — AC-coverage gate end-to-end (T10509)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
    // The default test config disables session enforcement + acceptance
    // enforcement so the gate runs against the AC-coverage check alone.
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_OWNER_OVERRIDE'];
    delete process.env['CLEO_OWNER_OVERRIDE_REASON'];
    delete process.env['CLEO_AGENT_ID'];
    resetDbState();
    await env.cleanup();
  });

  it('AC-1: happy path — all ACs covered → completion proceeds', async () => {
    const { task, acRows } = await createTaskWithAcs(accessor, env.tempDir, 'Coverage happy path', [
      'First AC',
      'Second AC',
    ]);
    for (const row of acRows) {
      await seedBinding(env.tempDir, row.id, 'direct');
    }
    const result = await completeTask({ taskId: task.id }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
  });

  it('AC-2: error path — uncovered AC → E_AC_COVERAGE_INCOMPLETE', async () => {
    const { task } = await createTaskWithAcs(accessor, env.tempDir, 'Uncovered', ['Only AC']);
    let caught: unknown;
    try {
      await completeTask({ taskId: task.id }, env.tempDir, accessor);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CleoError);
    const ce = caught as CleoError;
    expect(ce.code).toBe(ExitCode.AC_COVERAGE_INCOMPLETE);
    expect(ce.details?.['codeName']).toBe('E_AC_COVERAGE_INCOMPLETE');
    const unsat = ce.details?.['unsatisfied'] as Array<{ alias: string }>;
    expect(unsat).toHaveLength(1);
    expect(unsat[0]?.alias).toBe('AC1');
  });

  it('AC-3: --waive-ac with --waive-reason → audit row written + completion proceeds', async () => {
    const { task, acRows } = await createTaskWithAcs(accessor, env.tempDir, 'Waiver path', [
      'Only AC',
    ]);
    process.env['CLEO_AGENT_ID'] = 'test-agent';
    const result = await completeTask(
      {
        taskId: task.id,
        waiveAc: acRows[0]!.id,
        waiveReason: 'genuinely unverifiable in this codepath',
      },
      env.tempDir,
      accessor,
    );
    expect(result.task.status).toBe('done');

    const rows = await readJsonl<Record<string, unknown>>(
      join(env.tempDir, '.cleo', 'audit', 'ac-waiver.jsonl'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['taskId']).toBe(task.id);
    expect(rows[0]?.['reason']).toBe('genuinely unverifiable in this codepath');
    expect(rows[0]?.['actor']).toBe('test-agent');
    expect(rows[0]?.['waivedAliases']).toEqual(['AC1']);
  });

  it('AC-4: --waive-ac WITHOUT --waive-reason → rejected with structured error', async () => {
    const { task, acRows } = await createTaskWithAcs(accessor, env.tempDir, 'Missing reason', [
      'Only AC',
    ]);
    let caught: unknown;
    try {
      await completeTask({ taskId: task.id, waiveAc: acRows[0]!.id }, env.tempDir, accessor);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CleoError);
    const ce = caught as CleoError;
    expect(ce.code).toBe(ExitCode.AC_COVERAGE_INCOMPLETE);
    expect(ce.details?.['missingFlag']).toBe('waiveReason');
    // Audit log was NOT written (no resolved waiver, no completion).
    const rows = await readJsonl<unknown>(join(env.tempDir, '.cleo', 'audit', 'ac-waiver.jsonl'));
    expect(rows).toHaveLength(0);
  });

  it('AC-5: CLEO_OWNER_OVERRIDE → bypass + force-bypass.jsonl entry', async () => {
    const { task } = await createTaskWithAcs(accessor, env.tempDir, 'Owner override bypass', [
      'First AC',
      'Second AC',
    ]);
    process.env['CLEO_OWNER_OVERRIDE'] = '1';
    process.env['CLEO_OWNER_OVERRIDE_REASON'] = 'incident-1234 hotfix';
    process.env['CLEO_AGENT_ID'] = 'owner';

    const result = await completeTask({ taskId: task.id }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');

    const rows = await readJsonl<Record<string, unknown>>(
      join(env.tempDir, '.cleo', 'audit', 'force-bypass.jsonl'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['kind']).toBe('ac-coverage');
    expect(rows[0]?.['reason']).toBe('incident-1234 hotfix');
    expect(rows[0]?.['actor']).toBe('owner');
    expect(rows[0]?.['unsatisfied']).toHaveLength(2);
  });

  it('AC-6: mixed coverage — some ACs satisfied, others not → only the unsatisfied surface', async () => {
    const { task, acRows } = await createTaskWithAcs(accessor, env.tempDir, 'Mixed coverage', [
      'Covered',
      'Not covered 1',
      'Not covered 2',
    ]);
    // Seed binding for AC1 only.
    await seedBinding(env.tempDir, acRows[0]!.id, 'direct');

    let caught: unknown;
    try {
      await completeTask({ taskId: task.id }, env.tempDir, accessor);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CleoError);
    const ce = caught as CleoError;
    expect(ce.code).toBe(ExitCode.AC_COVERAGE_INCOMPLETE);
    const unsat = ce.details?.['unsatisfied'] as Array<{ alias: string }>;
    expect(unsat.map((u) => u.alias).sort()).toEqual(['AC2', 'AC3']);
  });

  it('partial waiver that leaves at least one AC unaddressed → still fails', async () => {
    const { task, acRows } = await createTaskWithAcs(accessor, env.tempDir, 'Partial waiver', [
      'A',
      'B',
    ]);
    let caught: unknown;
    try {
      await completeTask(
        {
          taskId: task.id,
          waiveAc: acRows[0]!.id, // only waive AC1
          waiveReason: 'partial — AC2 still unaddressed',
        },
        env.tempDir,
        accessor,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CleoError);
    const ce = caught as CleoError;
    expect(ce.code).toBe(ExitCode.AC_COVERAGE_INCOMPLETE);
    const unsat = ce.details?.['unsatisfied'] as Array<{ alias: string }>;
    expect(unsat.map((u) => u.alias)).toEqual(['AC2']);
    // Audit row was written for the partial waiver attempt — forensic record.
    const rows = await readJsonl<unknown>(join(env.tempDir, '.cleo', 'audit', 'ac-waiver.jsonl'));
    expect(rows).toHaveLength(1);
  });

  it('satisfies-binding kind satisfies the gate (cross-task evidence)', async () => {
    const { task, acRows } = await createTaskWithAcs(accessor, env.tempDir, 'satisfies binding', [
      'Only AC',
    ]);
    await seedBinding(env.tempDir, acRows[0]!.id, 'satisfies', 'satisfies:T200#AC1');
    const result = await completeTask({ taskId: task.id }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
  });

  it('task with zero ACs is a no-op for the gate', async () => {
    const { task } = await createTaskWithAcs(accessor, env.tempDir, 'No ACs', []);
    const result = await completeTask({ taskId: task.id }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
  });
});
