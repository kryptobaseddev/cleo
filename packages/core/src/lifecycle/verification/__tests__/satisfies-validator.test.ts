/**
 * Unit tests for the ADR-079-r2 5-check satisfies-atom validator (T10507).
 *
 * Coverage:
 *   - Each of the 5 failure paths (malformed, target-not-found,
 *     target-terminal, ac-not-found, out-of-scope).
 *   - The happy path for both UUID and alias atom forms.
 *   - First-failure-wins ordering — a malformed atom never escalates
 *     to a target-not-found check.
 *   - Alias drift detection — when a previously-persisted binding
 *     resolves the same `(source, target, alias)` triple to a different
 *     UUID, the validator returns `E_AC_ALIAS_DRIFTED`.
 *   - Same-saga scope is resolved via `task_relations.relation_type='groups'`
 *     edges, with a same-root-epic fallback when neither side is a saga
 *     member.
 *
 * @task T10507
 * @epic T10381
 * @saga T10377
 * @adr ADR-079-r2
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  seedTasks,
  type TestDbEnv,
} from '../../../store/__tests__/test-db-helper.js';
import { getDb } from '../../../store/sqlite.js';
import * as schema from '../../../store/tasks-schema.js';
import { validateAtom } from '../../../tasks/evidence.js';
import { validateSatisfiesAtom } from '../satisfies-validator.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Generate a strict lowercase UUIDv4 — the canonical AC id form per
 * ADR-079-r2 §2.1 (the `ac-uuid` production). Wraps `crypto.randomUUID()`
 * which already emits lowercase UUIDv4s with the correct version + variant
 * nibbles.
 */
function uuid(): string {
  return randomUUID();
}

/**
 * Insert an AC row directly into `task_acceptance_criteria`. The test-db
 * helper does not expose a high-level AC writer (none ships in T10502
 * MVP), so we hit the table directly via drizzle.
 */
async function insertAc(
  cwd: string,
  acId: string,
  taskId: string,
  ordinal: number,
  text = `AC body ${ordinal}`,
): Promise<void> {
  const db = await getDb(cwd);
  await db.insert(schema.taskAcceptanceCriteria).values({ id: acId, taskId, ordinal, text }).run();
}

/**
 * Insert an `evidence_ac_bindings` row to simulate a previously-persisted
 * binding. Used by the alias-drift test.
 */
async function insertBinding(
  cwd: string,
  atomId: string,
  acUuid: string,
  bindingType: 'direct' | 'satisfies' | 'coverage' = 'satisfies',
): Promise<void> {
  const db = await getDb(cwd);
  await db
    .insert(schema.evidenceAcBindings)
    .values({ id: uuid(), evidenceAtomId: atomId, acId: acUuid, bindingType })
    .run();
}

/**
 * Add a `task_relations.relation_type='groups'` edge from `sagaId` → `memberId`.
 * Mirrors `accessor.addRelation` without going through the DataAccessor.
 */
async function linkSagaMember(cwd: string, sagaId: string, memberId: string): Promise<void> {
  const db = await getDb(cwd);
  await db
    .insert(schema.taskRelations)
    .values({ taskId: sagaId, relatedTo: memberId, relationType: 'groups' })
    .run();
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('validateSatisfiesAtom — 5-check pipeline (T10507 · ADR-079-r2 §2.4)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // ---------------------------------------------------------------------
  // Check 1 — malformed
  // ---------------------------------------------------------------------

  describe('Check 1 — E_AC_BINDING_MALFORMED', () => {
    it('rejects a targetTaskId that does not match /^T[0-9]{1,7}$/', async () => {
      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'NOT_A_TASK_ID',
          targetAcAlias: 'AC1',
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.codeName).toBe('E_AC_BINDING_MALFORMED');
      expect(result.reason).toMatch(/targetTaskId/);
    });

    it('rejects when both UUID and alias are set', async () => {
      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T100',
          targetAcId: uuid(),
          targetAcAlias: 'AC1',
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.codeName).toBe('E_AC_BINDING_MALFORMED');
    });

    it('rejects when neither UUID nor alias is set', async () => {
      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T100',
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.codeName).toBe('E_AC_BINDING_MALFORMED');
    });

    it('rejects mixed-case UUIDs (ADR-079-r2 §2.2)', async () => {
      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T100',
          targetAcId: 'A1B2C3D4-5E6F-4890-ABCD-EF1234567890',
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.codeName).toBe('E_AC_BINDING_MALFORMED');
    });

    it('rejects malformed version-pin (not 14 digits)', async () => {
      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T100',
          targetAcAlias: 'AC1',
          versionPin: 'not-a-pin',
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.codeName).toBe('E_AC_BINDING_MALFORMED');
    });

    it('first-failure-wins — malformed atom does NOT escalate to target-not-found', async () => {
      // T999999999 (9 digits) is malformed AND the task does not exist.
      // The validator MUST surface E_AC_BINDING_MALFORMED, NOT E_AC_BINDING_TARGET_NOT_FOUND.
      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T999999999',
          targetAcAlias: 'AC1',
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.codeName).toBe('E_AC_BINDING_MALFORMED');
    });
  });

  // ---------------------------------------------------------------------
  // Check 2 — target task not found
  // ---------------------------------------------------------------------

  describe('Check 2 — E_AC_BINDING_TARGET_NOT_FOUND', () => {
    it('rejects when target task does not exist in tasks table', async () => {
      // Seed only the source task — target T200 is intentionally absent.
      await seedTasks(env.accessor, [
        { id: 'T100', title: 'source', type: 'task', status: 'pending', priority: 'medium' },
      ]);

      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T200',
          targetAcAlias: 'AC1',
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.codeName).toBe('E_AC_BINDING_TARGET_NOT_FOUND');
      expect(result.reason).toMatch(/T200/);
    });
  });

  // ---------------------------------------------------------------------
  // Check 3 — target task terminal
  // ---------------------------------------------------------------------

  describe('Check 3 — E_AC_BINDING_TARGET_TERMINAL', () => {
    it('rejects when target task status is "cancelled"', async () => {
      await seedTasks(env.accessor, [
        { id: 'T100', title: 'source', type: 'task', status: 'pending', priority: 'medium' },
        {
          id: 'T200',
          title: 'cancelled target',
          type: 'task',
          status: 'cancelled',
          priority: 'medium',
        },
      ]);

      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T200',
          targetAcAlias: 'AC1',
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.codeName).toBe('E_AC_BINDING_TARGET_TERMINAL');
      expect(result.reason).toMatch(/cancelled/);
    });

    it('rejects when target task status is "archived"', async () => {
      await seedTasks(env.accessor, [
        { id: 'T100', title: 'source', type: 'task', status: 'pending', priority: 'medium' },
        {
          id: 'T200',
          title: 'archived target',
          type: 'task',
          status: 'archived',
          priority: 'medium',
        },
      ]);

      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T200',
          targetAcAlias: 'AC1',
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.codeName).toBe('E_AC_BINDING_TARGET_TERMINAL');
    });

    it('ACCEPTS targets with status "done" (ADR-079-r2 §2.4 row 3)', async () => {
      // done is allowed — workers routinely satisfy ACs on already-shipped tasks.
      const acId = uuid();
      await seedTasks(env.accessor, [
        { id: 'T100', title: 'source', type: 'task', status: 'pending', priority: 'medium' },
        {
          id: 'T200',
          title: 'done target',
          type: 'task',
          status: 'done',
          priority: 'medium',
          parentId: undefined,
        },
      ]);
      // Both T100 and T200 are top-level (no parent), so they share root
      // epic anchors of themselves — out-of-scope. Wire them into the same
      // saga to pass check 5.
      await seedTasks(env.accessor, [
        {
          id: 'TS-SAGA-1',
          title: 'saga',
          type: 'epic',
          status: 'pending',
          priority: 'high',
          labels: ['saga'],
        },
      ]);
      await linkSagaMember(env.tempDir, 'TS-SAGA-1', 'T100');
      await linkSagaMember(env.tempDir, 'TS-SAGA-1', 'T200');
      await insertAc(env.tempDir, acId, 'T200', 1);

      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T200',
          targetAcAlias: 'AC1',
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`expected ok, got ${result.codeName}: ${result.reason}`);
      expect(result.atom.resolvedAcUuid).toBe(acId);
    });
  });

  // ---------------------------------------------------------------------
  // Check 4 — AC not found
  // ---------------------------------------------------------------------

  describe('Check 4 — E_AC_BINDING_TARGET_AC_NOT_FOUND', () => {
    it('rejects when UUID does not exist on the target task', async () => {
      await seedTasks(env.accessor, [
        { id: 'T100', title: 'source', type: 'task', status: 'pending', priority: 'medium' },
        { id: 'T200', title: 'target', type: 'task', status: 'pending', priority: 'medium' },
      ]);

      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T200',
          targetAcId: uuid(),
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.codeName).toBe('E_AC_BINDING_TARGET_AC_NOT_FOUND');
    });

    it('rejects when alias does not resolve on the target task', async () => {
      await seedTasks(env.accessor, [
        { id: 'T100', title: 'source', type: 'task', status: 'pending', priority: 'medium' },
        { id: 'T200', title: 'target', type: 'task', status: 'pending', priority: 'medium' },
      ]);
      await insertAc(env.tempDir, uuid(), 'T200', 1); // only AC1 exists

      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T200',
          targetAcAlias: 'AC42', // no AC at ordinal 42
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.codeName).toBe('E_AC_BINDING_TARGET_AC_NOT_FOUND');
      expect(result.reason).toMatch(/AC42/);
    });

    it('rejects when UUID exists on a different task than the target', async () => {
      const ac200 = uuid();
      await seedTasks(env.accessor, [
        { id: 'T100', title: 'source', type: 'task', status: 'pending', priority: 'medium' },
        { id: 'T200', title: 'target', type: 'task', status: 'pending', priority: 'medium' },
        { id: 'T300', title: 'other', type: 'task', status: 'pending', priority: 'medium' },
      ]);
      // AC belongs to T300, not the target T200.
      await insertAc(env.tempDir, ac200, 'T300', 1);

      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T200',
          targetAcId: ac200,
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.codeName).toBe('E_AC_BINDING_TARGET_AC_NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------
  // Check 5 — out of scope
  // ---------------------------------------------------------------------

  describe('Check 5 — E_AC_BINDING_OUT_OF_SCOPE', () => {
    it('rejects when source and target are not members of the same saga', async () => {
      const acId = uuid();
      await seedTasks(env.accessor, [
        {
          id: 'TS-SAGA-A',
          title: 'saga A',
          type: 'epic',
          status: 'pending',
          priority: 'high',
          labels: ['saga'],
        },
        {
          id: 'TS-SAGA-B',
          title: 'saga B',
          type: 'epic',
          status: 'pending',
          priority: 'high',
          labels: ['saga'],
        },
        { id: 'T100', title: 'source', type: 'task', status: 'pending', priority: 'medium' },
        { id: 'T200', title: 'target', type: 'task', status: 'pending', priority: 'medium' },
      ]);
      await linkSagaMember(env.tempDir, 'TS-SAGA-A', 'T100');
      await linkSagaMember(env.tempDir, 'TS-SAGA-B', 'T200');
      await insertAc(env.tempDir, acId, 'T200', 1);

      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T200',
          targetAcAlias: 'AC1',
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.codeName).toBe('E_AC_BINDING_OUT_OF_SCOPE');
    });

    it('rejects when neither task is in any saga AND their root epics differ', async () => {
      const acId = uuid();
      await seedTasks(env.accessor, [
        { id: 'E-A', title: 'epic A', type: 'epic', status: 'pending', priority: 'high' },
        { id: 'E-B', title: 'epic B', type: 'epic', status: 'pending', priority: 'high' },
        {
          id: 'T100',
          title: 'source',
          type: 'task',
          status: 'pending',
          priority: 'medium',
          parentId: 'E-A',
        },
        {
          id: 'T200',
          title: 'target',
          type: 'task',
          status: 'pending',
          priority: 'medium',
          parentId: 'E-B',
        },
      ]);
      await insertAc(env.tempDir, acId, 'T200', 1);

      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T200',
          targetAcAlias: 'AC1',
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.codeName).toBe('E_AC_BINDING_OUT_OF_SCOPE');
    });
  });

  // ---------------------------------------------------------------------
  // Happy path — UUID + alias forms
  // ---------------------------------------------------------------------

  describe('Happy path', () => {
    it('accepts canonical UUID form when same-saga + AC exists + target non-terminal', async () => {
      const acId = uuid();
      await seedTasks(env.accessor, [
        {
          id: 'TS-SAGA-1',
          title: 'saga',
          type: 'epic',
          status: 'pending',
          priority: 'high',
          labels: ['saga'],
        },
        { id: 'T100', title: 'source', type: 'task', status: 'pending', priority: 'medium' },
        { id: 'T200', title: 'target', type: 'task', status: 'pending', priority: 'medium' },
      ]);
      await linkSagaMember(env.tempDir, 'TS-SAGA-1', 'T100');
      await linkSagaMember(env.tempDir, 'TS-SAGA-1', 'T200');
      await insertAc(env.tempDir, acId, 'T200', 1);

      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T200',
          targetAcId: acId,
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`expected ok, got ${result.codeName}: ${result.reason}`);
      expect(result.atom.kind).toBe('satisfies');
      expect(result.atom.targetTaskId).toBe('T200');
      expect(result.atom.targetAcId).toBe(acId);
      expect(result.atom.resolvedAcUuid).toBe(acId);
    });

    it('accepts deterministic UUIDv5-shaped AC ids when same-saga + AC exists', async () => {
      const acId = '8f4a2c1e-b09d-5f6a-9c3e-7a1d4f8c0b2e';
      await seedTasks(env.accessor, [
        {
          id: 'TS-SAGA-1',
          title: 'saga',
          type: 'epic',
          status: 'pending',
          priority: 'high',
          labels: ['saga'],
        },
        { id: 'T100', title: 'source', type: 'task', status: 'pending', priority: 'medium' },
        { id: 'T200', title: 'target', type: 'task', status: 'pending', priority: 'medium' },
      ]);
      await linkSagaMember(env.tempDir, 'TS-SAGA-1', 'T100');
      await linkSagaMember(env.tempDir, 'TS-SAGA-1', 'T200');
      await insertAc(env.tempDir, acId, 'T200', 1);

      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T200',
          targetAcId: acId,
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`expected ok, got ${result.codeName}: ${result.reason}`);
      expect(result.atom.resolvedAcUuid).toBe(acId);
    });

    it('accepts alias form and populates resolvedAcUuid from the alias lookup', async () => {
      const acId = uuid();
      await seedTasks(env.accessor, [
        {
          id: 'TS-SAGA-1',
          title: 'saga',
          type: 'epic',
          status: 'pending',
          priority: 'high',
          labels: ['saga'],
        },
        { id: 'T100', title: 'source', type: 'task', status: 'pending', priority: 'medium' },
        { id: 'T200', title: 'target', type: 'task', status: 'pending', priority: 'medium' },
      ]);
      await linkSagaMember(env.tempDir, 'TS-SAGA-1', 'T100');
      await linkSagaMember(env.tempDir, 'TS-SAGA-1', 'T200');
      await insertAc(env.tempDir, acId, 'T200', 2);

      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T200',
          targetAcAlias: 'AC2',
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`expected ok, got ${result.codeName}: ${result.reason}`);
      expect(result.atom.resolvedAcUuid).toBe(acId);
      expect(result.atom.targetAcAlias).toBe('AC2');
      expect(result.atom.targetAcId).toBeUndefined();
    });

    it('accepts when sourceTaskId is undefined (scope check skipped)', async () => {
      const acId = uuid();
      await seedTasks(env.accessor, [
        { id: 'T200', title: 'target', type: 'task', status: 'pending', priority: 'medium' },
      ]);
      await insertAc(env.tempDir, acId, 'T200', 1);

      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T200',
          targetAcAlias: 'AC1',
        },
        undefined, // sourceTaskId omitted — scope check skipped
        env.tempDir,
      );
      expect(result.ok).toBe(true);
    });

    it('accepts self-binding (source == target) without scope check', async () => {
      const acId = uuid();
      await seedTasks(env.accessor, [
        { id: 'T100', title: 'self', type: 'task', status: 'pending', priority: 'medium' },
      ]);
      await insertAc(env.tempDir, acId, 'T100', 1);

      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T100',
          targetAcAlias: 'AC1',
        },
        'T100', // same as target — scope check short-circuits
        env.tempDir,
      );
      expect(result.ok).toBe(true);
    });

    it('accepts cross-epic atoms when both tasks share the same root epic (fallback)', async () => {
      const acId = uuid();
      await seedTasks(env.accessor, [
        { id: 'E-ROOT', title: 'root epic', type: 'epic', status: 'pending', priority: 'high' },
        {
          id: 'T100',
          title: 'source',
          type: 'task',
          status: 'pending',
          priority: 'medium',
          parentId: 'E-ROOT',
        },
        {
          id: 'T200',
          title: 'target',
          type: 'task',
          status: 'pending',
          priority: 'medium',
          parentId: 'E-ROOT',
        },
      ]);
      await insertAc(env.tempDir, acId, 'T200', 1);

      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T200',
          targetAcAlias: 'AC1',
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // Alias drift detection (ADR-079-r2 §3)
  // ---------------------------------------------------------------------

  describe('E_AC_ALIAS_DRIFTED', () => {
    it('fires when alias resolves to a different UUID than the previously-persisted binding', async () => {
      const oldAcId = uuid();
      const newAcId = uuid();
      await seedTasks(env.accessor, [
        {
          id: 'TS-SAGA-1',
          title: 'saga',
          type: 'epic',
          status: 'pending',
          priority: 'high',
          labels: ['saga'],
        },
        { id: 'T100', title: 'source', type: 'task', status: 'pending', priority: 'medium' },
        { id: 'T200', title: 'target', type: 'task', status: 'pending', priority: 'medium' },
      ]);
      await linkSagaMember(env.tempDir, 'TS-SAGA-1', 'T100');
      await linkSagaMember(env.tempDir, 'TS-SAGA-1', 'T200');
      // AC1 on T200 now resolves to newAcId, but the old binding pointed at oldAcId.
      await insertAc(env.tempDir, newAcId, 'T200', 1);

      // Simulate the previously-persisted binding: atom id encodes
      // source=T100, target=T200, alias=AC1; previously resolved to oldAcId.
      await insertBinding(env.tempDir, 'satisfies:T100->T200#AC1', oldAcId);

      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T200',
          targetAcAlias: 'AC1',
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.codeName).toBe('E_AC_ALIAS_DRIFTED');
      expect(result.reason).toMatch(/drifted/i);
      expect(result.reason).toMatch(newAcId);
    });

    it('does NOT fire when previously-persisted binding matches the current resolution', async () => {
      const acId = uuid();
      await seedTasks(env.accessor, [
        {
          id: 'TS-SAGA-1',
          title: 'saga',
          type: 'epic',
          status: 'pending',
          priority: 'high',
          labels: ['saga'],
        },
        { id: 'T100', title: 'source', type: 'task', status: 'pending', priority: 'medium' },
        { id: 'T200', title: 'target', type: 'task', status: 'pending', priority: 'medium' },
      ]);
      await linkSagaMember(env.tempDir, 'TS-SAGA-1', 'T100');
      await linkSagaMember(env.tempDir, 'TS-SAGA-1', 'T200');
      await insertAc(env.tempDir, acId, 'T200', 1);
      // Previous binding pointed at the SAME UUID — no drift.
      await insertBinding(env.tempDir, 'satisfies:T100->T200#AC1', acId);

      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T200',
          targetAcAlias: 'AC1',
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(true);
    });

    it('integration — validateAtom dispatch delegates to the satisfies validator (no PENDING placeholder)', async () => {
      // Regression guard: T10506 inserted an E_AC_BINDING_VALIDATOR_PENDING
      // placeholder that T10507 must replace. This test fails if the
      // placeholder is still in place.
      const acId = uuid();
      await seedTasks(env.accessor, [
        {
          id: 'TS-SAGA-1',
          title: 'saga',
          type: 'epic',
          status: 'pending',
          priority: 'high',
          labels: ['saga'],
        },
        { id: 'T100', title: 'source', type: 'task', status: 'pending', priority: 'medium' },
        { id: 'T200', title: 'target', type: 'task', status: 'pending', priority: 'medium' },
      ]);
      await linkSagaMember(env.tempDir, 'TS-SAGA-1', 'T100');
      await linkSagaMember(env.tempDir, 'TS-SAGA-1', 'T200');
      await insertAc(env.tempDir, acId, 'T200', 1);

      const result = await validateAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T200',
          targetAcAlias: 'AC1',
        },
        env.tempDir,
        'T100',
      );
      // Must NOT return the PENDING placeholder code.
      if (!result.ok) {
        expect(result.codeName).not.toBe('E_AC_BINDING_VALIDATOR_PENDING');
      }
      expect(result.ok).toBe(true);
    });

    it('integration — validateAtom dispatch rejects out-of-scope cross-saga atom', async () => {
      const acId = uuid();
      await seedTasks(env.accessor, [
        {
          id: 'TS-SAGA-A',
          title: 'saga A',
          type: 'epic',
          status: 'pending',
          priority: 'high',
          labels: ['saga'],
        },
        {
          id: 'TS-SAGA-B',
          title: 'saga B',
          type: 'epic',
          status: 'pending',
          priority: 'high',
          labels: ['saga'],
        },
        { id: 'T100', title: 'source', type: 'task', status: 'pending', priority: 'medium' },
        { id: 'T200', title: 'target', type: 'task', status: 'pending', priority: 'medium' },
      ]);
      await linkSagaMember(env.tempDir, 'TS-SAGA-A', 'T100');
      await linkSagaMember(env.tempDir, 'TS-SAGA-B', 'T200');
      await insertAc(env.tempDir, acId, 'T200', 1);

      const result = await validateAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T200',
          targetAcAlias: 'AC1',
        },
        env.tempDir,
        'T100',
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.codeName).toBe('E_AC_BINDING_OUT_OF_SCOPE');
    });

    it('does NOT fire on UUID-form atoms (only alias form is drift-prone)', async () => {
      const acId = uuid();
      const otherAcId = uuid();
      await seedTasks(env.accessor, [
        {
          id: 'TS-SAGA-1',
          title: 'saga',
          type: 'epic',
          status: 'pending',
          priority: 'high',
          labels: ['saga'],
        },
        { id: 'T100', title: 'source', type: 'task', status: 'pending', priority: 'medium' },
        { id: 'T200', title: 'target', type: 'task', status: 'pending', priority: 'medium' },
      ]);
      await linkSagaMember(env.tempDir, 'TS-SAGA-1', 'T100');
      await linkSagaMember(env.tempDir, 'TS-SAGA-1', 'T200');
      await insertAc(env.tempDir, acId, 'T200', 1);
      // Even with a conflicting previous binding under an alias atom, the
      // UUID-form atom should NOT trigger drift detection.
      await insertBinding(env.tempDir, 'satisfies:T100->T200#AC1', otherAcId);

      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: 'T200',
          targetAcId: acId, // canonical form
        },
        'T100',
        env.tempDir,
      );
      expect(result.ok).toBe(true);
    });
  });
});
