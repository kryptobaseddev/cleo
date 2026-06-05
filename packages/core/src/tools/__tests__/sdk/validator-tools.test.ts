/**
 * Validator SDK tools — unit tests (T10511).
 *
 * Covers all four tools shipped by T10511:
 *   1. validator.attest    — auth path, happy path, AC-not-found path
 *   2. validator.reject    — auth path, happy path, NO-bindings invariant
 *   3. validator.ac-pull   — happy path with mixed binding status
 *   4. spawn.validator     — auth (role + tier), input shape
 *
 * @task T10511
 * @epic T10383 (E-VALIDATOR-ROLE)
 * @saga T10377 (SG-IVTR-AC-BINDING)
 */

import { randomUUID } from 'node:crypto';
import type { AgentRole, ValidatorAttestation, ValidatorRejection } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnValidator } from '../../../sdk/spawn-validator.js';
import { validatorAcPull } from '../../../sdk/validator-ac-pull.js';
import { validatorAttest } from '../../../sdk/validator-attest.js';
import { validatorReject } from '../../../sdk/validator-reject.js';
import { createTestDb, type TestDbEnv } from '../../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../../store/data-accessor.js';
import { resetDbState } from '../../../store/sqlite.js';
import { addTask } from '../../../tasks/add.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTaskWithAcs(
  accessor: DataAccessor,
  projectRoot: string,
  title: string,
  acceptance: string[],
) {
  // T11811: fixture-seed (standalone task under test) — bypass strict-spine guard.
  const out = await addTask(
    {
      title,
      description: `${title} — seeded fixture for T10511 tests`,
      acceptance,
      skipContainmentInvariant: true,
    },
    projectRoot,
    accessor,
  );
  const acRows = await accessor.getAcRows(out.task.id);
  return { task: out.task, acRows };
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildAttestation(
  taskId: string,
  acIds: string[],
  validatorId = 'validator-prime',
): ValidatorAttestation {
  return {
    verdict: 'attest',
    taskId,
    validatorId,
    findings: acIds.map((acId) => ({
      acId,
      status: 'pass',
      reasoning: 'ok',
      checkedAt: nowIso(),
    })),
    attestedAt: nowIso(),
    schemaVersion: '1',
  };
}

function buildRejection(
  taskId: string,
  acIds: string[],
  validatorId = 'validator-prime',
): ValidatorRejection {
  return {
    verdict: 'reject',
    taskId,
    validatorId,
    findings: acIds.map((acId, idx) => ({
      acId,
      status: idx === 0 ? 'fail' : 'pass',
      reasoning: idx === 0 ? 'test missing' : 'ok',
      checkedAt: nowIso(),
    })),
    summary: 'AC1 unsatisfied — test missing.',
    rejectedAt: nowIso(),
    schemaVersion: '1',
  };
}

// ---------------------------------------------------------------------------
// Registration sanity (mirrors brain-tools.test.ts style)
// ---------------------------------------------------------------------------

describe('Validator SDK tools — registration sanity (T10511)', () => {
  it('validatorAttest has stable identity + schemas', () => {
    expect(validatorAttest.identity.name).toBe('validator-attest');
    expect(validatorAttest.identity.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(validatorAttest.inputSchema.type).toBe('object');
    expect(validatorAttest.outputSchema.type).toBe('object');
    expect(validatorAttest.inputSchema.required).toEqual(['projectRoot', 'caller', 'attestation']);
  });

  it('validatorReject has stable identity + schemas', () => {
    expect(validatorReject.identity.name).toBe('validator-reject');
    expect(validatorReject.identity.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(validatorReject.inputSchema.required).toEqual(['projectRoot', 'caller', 'rejection']);
  });

  it('validatorAcPull has stable identity + schemas', () => {
    expect(validatorAcPull.identity.name).toBe('validator-ac-pull');
    expect(validatorAcPull.identity.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(validatorAcPull.inputSchema.required).toEqual(['projectRoot', 'taskId']);
  });

  it('spawnValidator has stable identity + schemas', () => {
    expect(spawnValidator.identity.name).toBe('spawn-validator');
    expect(spawnValidator.identity.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(spawnValidator.inputSchema.required).toEqual(['projectRoot', 'caller', 'taskId']);
  });
});

// ---------------------------------------------------------------------------
// validator.attest
// ---------------------------------------------------------------------------

describe('validator.attest (T10511)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  it('rejects callers that are not the validator role (auth)', async () => {
    const { task, acRows } = await makeTaskWithAcs(accessor, env.tempDir, 'Auth test', ['A']);
    const attestation = buildAttestation(
      task.id,
      acRows.map((r) => r.id),
    );
    const wrongRoles: AgentRole[] = ['orchestrator', 'lead', 'worker'];
    for (const role of wrongRoles) {
      const out = await validatorAttest.invoke({
        projectRoot: env.tempDir,
        caller: { role },
        attestation,
      });
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.code).toBe('E_VALIDATOR_AUTH_ROLE');
    }
  });

  it('writes one coverage binding per AC on happy path', async () => {
    const { task, acRows } = await makeTaskWithAcs(accessor, env.tempDir, 'Happy', ['A', 'B', 'C']);
    const out = await validatorAttest.invoke({
      projectRoot: env.tempDir,
      caller: { role: 'validator' },
      attestation: buildAttestation(
        task.id,
        acRows.map((r) => r.id),
      ),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('unreachable');
    expect(out.bindingsWritten).toBe(3);
    expect(out.bindingIds).toHaveLength(3);

    const bindings = await accessor.getAcBindings(acRows.map((r) => r.id));
    expect(bindings).toHaveLength(3);
    expect(bindings.every((b) => b.bindingType === 'coverage')).toBe(true);
  });

  it('re-attest is idempotent — UNIQUE index collapses re-inserts', async () => {
    const { task, acRows } = await makeTaskWithAcs(accessor, env.tempDir, 'Idempotent', ['A', 'B']);
    const att = buildAttestation(
      task.id,
      acRows.map((r) => r.id),
    );
    await validatorAttest.invoke({
      projectRoot: env.tempDir,
      caller: { role: 'validator' },
      attestation: att,
    });
    await validatorAttest.invoke({
      projectRoot: env.tempDir,
      caller: { role: 'validator' },
      attestation: att,
    });
    const bindings = await accessor.getAcBindings(acRows.map((r) => r.id));
    expect(bindings).toHaveLength(2); // not 4 — re-inserts collapsed
  });

  it('returns E_VALIDATOR_AC_NOT_FOUND when attestation references unknown AC ids', async () => {
    const { task } = await makeTaskWithAcs(accessor, env.tempDir, 'Unknown', ['A']);
    const bogus = randomUUID();
    const out = await validatorAttest.invoke({
      projectRoot: env.tempDir,
      caller: { role: 'validator' },
      attestation: buildAttestation(task.id, [bogus]),
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.code).toBe('E_VALIDATOR_AC_NOT_FOUND');
    expect(out.message).toContain(bogus);
  });

  it('returns E_VALIDATOR_ATTESTATION_INVALID for malformed envelopes', async () => {
    const out = await validatorAttest.invoke({
      projectRoot: env.tempDir,
      caller: { role: 'validator' },
      attestation: {
        verdict: 'attest',
        taskId: 'T1',
      } as unknown as ValidatorAttestation,
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.code).toBe('E_VALIDATOR_ATTESTATION_INVALID');
  });
});

// ---------------------------------------------------------------------------
// validator.reject
// ---------------------------------------------------------------------------

describe('validator.reject (T10511)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  it('rejects callers that are not the validator role (auth)', async () => {
    const { task, acRows } = await makeTaskWithAcs(accessor, env.tempDir, 'RejectAuth', ['A', 'B']);
    const rejection = buildRejection(
      task.id,
      acRows.map((r) => r.id),
    );
    const out = await validatorReject.invoke({
      projectRoot: env.tempDir,
      caller: { role: 'worker' },
      rejection,
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.code).toBe('E_VALIDATOR_AUTH_ROLE');
  });

  it('emits structured envelope WITHOUT writing any bindings (negative invariant)', async () => {
    const { task, acRows } = await makeTaskWithAcs(accessor, env.tempDir, 'NoBinds', ['A', 'B']);
    const out = await validatorReject.invoke({
      projectRoot: env.tempDir,
      caller: { role: 'validator' },
      rejection: buildRejection(
        task.id,
        acRows.map((r) => r.id),
      ),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('unreachable');
    expect(out.failingFindingCount).toBe(1);
    expect(out.failingAcIds).toEqual([acRows[0]!.id]);
    expect(out.rejection.verdict).toBe('reject');

    // CRITICAL invariant — NO bindings exist after a rejection.
    const bindings = await accessor.getAcBindings(acRows.map((r) => r.id));
    expect(bindings).toHaveLength(0);
  });

  it('returns E_VALIDATOR_REJECTION_INVALID for malformed envelopes', async () => {
    const out = await validatorReject.invoke({
      projectRoot: env.tempDir,
      caller: { role: 'validator' },
      rejection: {
        verdict: 'reject',
        taskId: 'T1',
      } as unknown as ValidatorRejection,
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.code).toBe('E_VALIDATOR_REJECTION_INVALID');
  });
});

// ---------------------------------------------------------------------------
// validator.ac-pull
// ---------------------------------------------------------------------------

describe('validator.ac-pull (T10511)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  it('returns ordered AC roster with bindingStatus=unsatisfied when no bindings exist', async () => {
    const { task } = await makeTaskWithAcs(accessor, env.tempDir, 'PullEmpty', [
      'first',
      'second',
      'third',
    ]);
    const out = await validatorAcPull.invoke({ projectRoot: env.tempDir, taskId: task.id });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('unreachable');
    expect(out.acs).toHaveLength(3);
    expect(out.acs.map((a) => a.alias)).toEqual(['AC1', 'AC2', 'AC3']);
    expect(out.acs.map((a) => a.text)).toEqual(['first', 'second', 'third']);
    expect(out.acs.every((a) => a.bindingStatus === 'unsatisfied')).toBe(true);
  });

  it('flips bindingStatus to satisfied for ACs that have at least one binding', async () => {
    const { task, acRows } = await makeTaskWithAcs(accessor, env.tempDir, 'PullMixed', [
      'A',
      'B',
      'C',
    ]);
    // Attest only AC1+AC3 via the validator-attest tool — leave AC2 uncovered.
    await validatorAttest.invoke({
      projectRoot: env.tempDir,
      caller: { role: 'validator' },
      attestation: buildAttestation(task.id, [acRows[0]!.id, acRows[2]!.id]),
    });

    const out = await validatorAcPull.invoke({ projectRoot: env.tempDir, taskId: task.id });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('unreachable');
    const byAlias = new Map(out.acs.map((a) => [a.alias, a.bindingStatus]));
    expect(byAlias.get('AC1')).toBe('satisfied');
    expect(byAlias.get('AC2')).toBe('unsatisfied');
    expect(byAlias.get('AC3')).toBe('satisfied');
  });

  it('returns empty acs array for an unknown taskId (no crash)', async () => {
    const out = await validatorAcPull.invoke({
      projectRoot: env.tempDir,
      taskId: 'T-does-not-exist',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('unreachable');
    expect(out.acs).toEqual([]);
  });

  it('returns E_INVALID_INPUT for empty taskId', async () => {
    const out = await validatorAcPull.invoke({ projectRoot: env.tempDir, taskId: '' });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.code).toBe('E_INVALID_INPUT');
  });
});

// ---------------------------------------------------------------------------
// spawn.validator — auth-only tests (delegating to orchestrateSpawn is
// integration-tested elsewhere; here we cover the gating logic).
// ---------------------------------------------------------------------------

describe('spawn.validator (T10511)', () => {
  it('rejects non-orchestrator callers with E_VALIDATOR_SPAWN_AUTH_ROLE', async () => {
    const wrongRoles: AgentRole[] = ['lead', 'worker', 'validator'];
    for (const role of wrongRoles) {
      const out = await spawnValidator.invoke({
        projectRoot: '/tmp/does-not-matter',
        caller: { role, tier: 1 },
        taskId: 'T1234',
      });
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.code).toBe('E_VALIDATOR_SPAWN_AUTH_ROLE');
    }
  });

  it('rejects tier-0 orchestrators with E_VALIDATOR_SPAWN_AUTH_TIER', async () => {
    const out = await spawnValidator.invoke({
      projectRoot: '/tmp/does-not-matter',
      caller: { role: 'orchestrator', tier: 0 },
      taskId: 'T1234',
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.code).toBe('E_VALIDATOR_SPAWN_AUTH_TIER');
  });

  it('rejects empty taskId with E_INVALID_INPUT', async () => {
    const out = await spawnValidator.invoke({
      projectRoot: '/tmp/does-not-matter',
      caller: { role: 'orchestrator', tier: 1 },
      taskId: '',
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.code).toBe('E_INVALID_INPUT');
  });
});
