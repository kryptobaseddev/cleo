/**
 * Tests for `auditInvariantRegistry` (T10340 / Saga T10326 R6).
 *
 * Covers:
 *   1. Empty DB → every entry reports `documented` or `not-applicable`;
 *      zero failures.
 *   2. Seeded I5 violation (saga with parent_id != null) → ADR-073.I5 entry
 *      transitions to status='fail' with severity='error' AND `errorCount`
 *      rises above zero.
 *   3. `adrFilter='ADR-073'` returns ONLY ADR-073 entries — used by the
 *      `--audit-sagas` focused alias.
 *   4. Output is deterministic: entries sorted by (adr, code).
 *
 * @task T10340
 * @saga T10326
 * @epic T10327
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

interface NativeDbForTest {
  prepare: (sql: string) => {
    run: (...args: (string | number | null)[]) => void;
    get: (...args: (string | number | null)[]) => unknown;
  };
  exec: (sql: string) => void;
}

/**
 * Neutralize the PM-Core V2 structural guards (parent-type-matrix triggers +
 * the `chk_tasks_saga_no_parent` CHECK) so this audit test can seed the
 * DELIBERATELY invariant-violating saga-with-parent row that ADR-073.I5
 * detection must catch. Mirrors saga-audit.test.ts. (T11280)
 */
function neutralizeSagaStructuralGuards(db: NativeDbForTest): void {
  db.exec('DROP TRIGGER IF EXISTS tasks_parent_type_matrix_insert');
  db.exec('DROP TRIGGER IF EXISTS tasks_parent_type_matrix_update');

  // Disable CHECK-constraint enforcement (incl. chk_tasks_saga_no_parent) on
  // THIS connection so the audit fixtures can seed deliberately
  // invariant-violating rows (e.g. a saga carrying a parent_id). Replaces the
  // former `PRAGMA writable_schema=ON; UPDATE sqlite_master …` schema surgery,
  // which node:sqlite @ SQLite 3.53.0 rejects with "table sqlite_master may not
  // be modified" — DEFENSIVE mode blocks sqlite_master writes even under
  // writable_schema=ON. `ignore_check_constraints` is version-agnostic and
  // needs no schema mutation. (node:sqlite 3.53.0 standardization — 6620e8e96.)
  db.exec('PRAGMA ignore_check_constraints=ON');
}

/**
 * Insert a single task row directly. Mirrors the helper in
 * `saga-audit.test.ts` so the seeded shapes line up exactly.
 */
function insertTask(
  db: NativeDbForTest,
  row: {
    id: string;
    title: string;
    type: 'saga' | 'epic' | 'task' | 'subtask';
    status?: 'pending' | 'active' | 'done' | 'blocked';
    parentId?: string | null;
    labels?: string[];
  },
): void {
  const status = row.status ?? 'pending';
  const pipelineStage = status === 'done' ? 'contribution' : null;
  db.prepare(
    'INSERT INTO tasks (id, title, type, status, parent_id, labels_json, pipeline_stage) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    row.id,
    row.title,
    row.type,
    status,
    row.parentId ?? null,
    JSON.stringify(row.labels ?? []),
    pipelineStage,
  );
}

describe('auditInvariantRegistry (T10340)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-invariant-audit-'));
    await mkdir(join(tempDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');

    const { getDb, getNativeDb } = await import('../../store/sqlite.js');
    await getDb(tempDir);
    const nativeDb = getNativeDb() as NativeDbForTest | null;
    if (nativeDb) neutralizeSagaStructuralGuards(nativeDb);
  });

  afterEach(async () => {
    try {
      const { closeDb } = await import('../../store/sqlite.js');
      closeDb();
    } catch {
      /* may not be loaded */
    }
    delete process.env['CLEO_DIR'];
    await Promise.race([
      rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
  });

  it('walks every registered invariant on a clean DB with zero failures', async () => {
    const { auditInvariantRegistry } = await import('../invariant-audit.js');
    const result = await auditInvariantRegistry(tempDir);

    expect(result.totalCount).toBeGreaterThan(0);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(result.infoCount).toBe(0);
    expect(result.filteredByAdr).toBeNull();

    // Every entry is one of the four legal statuses.
    for (const entry of result.entries) {
      expect(['pass', 'fail', 'not-applicable', 'documented']).toContain(entry.status);
      expect(entry.violations.length).toBe(entry.status === 'fail' ? entry.violations.length : 0);
    }

    // The walk visited at least ADR-073 + ADR-070 + ADR-056 entries.
    const adrs = new Set(result.entries.map((e) => e.adr));
    expect(adrs.has('ADR-073')).toBe(true);
    expect(adrs.has('ADR-070')).toBe(true);
    expect(adrs.has('ADR-056')).toBe(true);
  });

  it('flags ADR-073.I5 as a fail when a saga carries a non-null parentId', async () => {
    const { getNativeDb } = await import('../../store/sqlite.js');
    const db = getNativeDb() as NativeDbForTest | null;
    if (!db) throw new Error('nativeDb not initialized');

    // Seed a saga with an illegal parent_id (ADR-073 §1.2 I5 violation).
    insertTask(db, { id: 'E_PARENT', title: 'Parent Epic', type: 'epic' });
    insertTask(db, {
      id: 'SG_BAD',
      title: 'Saga with parent',
      type: 'saga',
      parentId: 'E_PARENT',
    });

    const { auditInvariantRegistry } = await import('../invariant-audit.js');
    const result = await auditInvariantRegistry(tempDir);

    const i5Entry = result.entries.find((e) => e.invariantKey === 'ADR-073.I5');
    expect(i5Entry).toBeDefined();
    expect(i5Entry?.status).toBe('fail');
    expect(i5Entry?.severity).toBe('error');
    expect(i5Entry?.violations.length).toBeGreaterThan(0);

    const offender = i5Entry?.violations.find((v) => v.offendingId === 'SG_BAD');
    expect(offender).toBeDefined();
    expect(offender?.message).toContain('I5');
    expect(offender?.repairCommand).toBe('cleo saga repair SG_BAD');

    // Aggregate counts reflect the failure.
    expect(result.errorCount).toBeGreaterThanOrEqual(1);
  });

  it('filters to ADR-073 only when adrFilter is set (--audit-sagas alias)', async () => {
    const { auditInvariantRegistry } = await import('../invariant-audit.js');
    const result = await auditInvariantRegistry(tempDir, { adrFilter: 'ADR-073' });

    expect(result.filteredByAdr).toBe('ADR-073');
    expect(result.entries.length).toBeGreaterThan(0);
    for (const entry of result.entries) {
      expect(entry.adr).toBe('ADR-073');
    }
    const adrs = new Set(result.entries.map((e) => e.adr));
    expect(adrs.size).toBe(1);
  });

  it('returns entries sorted by (adr, code) for deterministic output', async () => {
    const { auditInvariantRegistry } = await import('../invariant-audit.js');
    const result = await auditInvariantRegistry(tempDir);

    for (let i = 1; i < result.entries.length; i++) {
      const prev = result.entries[i - 1];
      const curr = result.entries[i];
      if (prev === undefined || curr === undefined) continue;
      if (prev.adr === curr.adr) {
        expect(curr.code.localeCompare(prev.code)).toBeGreaterThanOrEqual(0);
      } else {
        expect(curr.adr.localeCompare(prev.adr)).toBeGreaterThan(0);
      }
    }
  });

  it('marks runtimeGate-null entries as documented (gap analysis)', async () => {
    const { auditInvariantRegistry } = await import('../invariant-audit.js');
    const result = await auditInvariantRegistry(tempDir);

    // ADR-073.I1 carries runtimeGate:null by design (DB CHECK + ID convention).
    const i1 = result.entries.find((e) => e.invariantKey === 'ADR-073.I1');
    expect(i1).toBeDefined();
    expect(i1?.status).toBe('documented');
    expect(i1?.runtimeGate).toBeNull();
    expect(result.documentedCount).toBeGreaterThan(0);
  });

  it('reports spawn-bound runtime gates as not-applicable', async () => {
    const { auditInvariantRegistry } = await import('../invariant-audit.js');
    const result = await auditInvariantRegistry(tempDir);

    // ORC-012 (thin-agent) IS hard-enforced but is spawn-time, not DB-scan.
    const orc012 = result.entries.find((e) => e.invariantKey === 'ADR-070.ORC-012');
    expect(orc012).toBeDefined();
    expect(orc012?.status).toBe('not-applicable');
    expect(orc012?.runtimeGate).toBe('enforceThinAgent');
    expect(result.notApplicableCount).toBeGreaterThan(0);
  });
});
