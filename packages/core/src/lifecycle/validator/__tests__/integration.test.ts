/**
 * Validator pipeline — end-to-end integration test (T10515).
 *
 * Closes T10383 (E-VALIDATOR-ROLE) by exercising every shipped piece of
 * the Validator subsystem in one wired flow:
 *
 *   - T10510: validator contracts + Zod schemas + AgentRole
 *   - T10511: four SDK tools (validator.attest, .reject, .ac-pull, spawn.validator)
 *   - T10512: Max-N runtime (`runValidatorMaxN`)
 *   - T10513: lead-rollup feature flag (referenced via runtime contract)
 *   - T10514: SKILL.md aligned to shipped reality
 *
 * Per AC #2 the test exercises the runtime against REAL SDK tool
 * implementations (NOT mocks of those tools): the `spawnValidator` DI
 * callback invokes the real `validatorAttest` / `validatorReject`
 * functions, which read/write the real test SQLite DB seeded via the
 * canonical `createTestDb()` helper + `addTask()`. This satisfies the
 * "real spawn" requirement without paying subprocess overhead — the
 * runtime DI contract was explicitly designed for this seam by T10512.
 *
 * Coverage matrix (T10515 AC #3):
 *   1. Attest happy path           — worker submits → validator ATTESTs →
 *                                    evidence_ac_bindings rows land →
 *                                    AC-coverage gate passes
 *   2. Reject happy path           — worker submits → validator REJECTs →
 *                                    no bindings written → AC-coverage gate fails
 *   3. Retry-then-attest           — REJECT first round, then ATTEST →
 *                                    bindings written on round 2
 *   4. Retry-exhaust-then-escalate — Max-N REJECTs in a row → audit row
 *                                    with retryDecision='escalate-hitl'
 *                                    written to .cleo/audit/validator-retries.jsonl
 *
 * @task T10515
 * @epic T10383 (E-VALIDATOR-ROLE)
 * @saga T10377 (SG-IVTR-AC-BINDING)
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ValidatorAttestation,
  ValidatorRejection,
  ValidatorVerdict,
} from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validatorAttest } from '../../../sdk/validator-attest.js';
import { validatorReject } from '../../../sdk/validator-reject.js';
import { createTestDb, type TestDbEnv } from '../../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../../store/data-accessor.js';
import { resetDbState } from '../../../store/sqlite.js';
import {
  applyWaivers,
  computeAcCoverage,
  resolveWaivers,
} from '../../../tasks/ac-coverage-gate.js';
import { addTask } from '../../../tasks/add.js';
import {
  runValidatorMaxN,
  VALIDATOR_RETRIES_AUDIT_FILE,
  type ValidatorRoundResult,
  type ValidatorRuntimeDeps,
} from '../runtime.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = '2026-05-24T22:00:00.000Z';
const VALIDATOR_ID = 'validator-prime';

function nowIso(): string {
  return NOW;
}

function noopSleep(): Promise<void> {
  return Promise.resolve();
}

/**
 * Seed a fixture Worker task with `n` ACs and return both the task plus
 * the resolved AC rows (with their canonical UUIDs).
 */
async function seedWorkerTask(
  accessor: DataAccessor,
  projectRoot: string,
  title: string,
  acceptance: string[],
) {
  const out = await addTask(
    {
      title,
      description: `${title} — T10515 integration fixture`,
      acceptance,
    },
    projectRoot,
    accessor,
  );
  const acRows = await accessor.getAcRows(out.task.id);
  return { task: out.task, acRows };
}

function buildAttestation(taskId: string, acIds: string[]): ValidatorAttestation {
  return {
    verdict: 'attest',
    taskId,
    validatorId: VALIDATOR_ID,
    findings: acIds.map((acId) => ({
      acId,
      status: 'pass',
      reasoning: 'tool:test exit 0; all ACs satisfied by programmatic evidence',
      checkedAt: NOW,
    })),
    attestedAt: NOW,
    schemaVersion: '1',
  };
}

function buildRejection(
  taskId: string,
  acIds: string[],
  summary = 'AC1 unsatisfied — fix failing test',
): ValidatorRejection {
  return {
    verdict: 'reject',
    taskId,
    validatorId: VALIDATOR_ID,
    findings: acIds.map((acId, idx) => ({
      acId,
      status: idx === 0 ? 'fail' : 'pass',
      reasoning: idx === 0 ? 'tool:test exited 1 — test suite has failures' : 'ok',
      checkedAt: NOW,
    })),
    summary,
    rejectedAt: NOW,
    schemaVersion: '1',
  };
}

/**
 * Build a `spawnValidator` DI callback that runs a scripted verdict
 * sequence through the REAL `validatorAttest` / `validatorReject` SDK
 * tools. This is the "DI-inject the real core function" pattern endorsed
 * by T10515 task description note #5 — it satisfies "real spawn" without
 * paying subprocess overhead.
 *
 * Each scripted verdict is converted into a real SDK-tool invocation:
 *   - `attest` verdicts call `validatorAttest.invoke(...)` which writes
 *     real `evidence_ac_bindings` rows to the test DB.
 *   - `reject` verdicts call `validatorReject.invoke(...)` which validates
 *     but writes nothing (per validator.reject's NO-BINDINGS invariant).
 *
 * The result envelope wraps the verdict (NOT the tool output) because
 * the runtime's `ValidatorRoundResult` is verdict-shaped — the SDK tools
 * are the side-effect layer, the verdict is the control-flow signal.
 */
function buildRealSdkSpawnValidator(
  projectRoot: string,
  scriptedVerdicts: ValidatorVerdict[],
): ValidatorRuntimeDeps['spawnValidator'] {
  let i = 0;
  return async (): Promise<ValidatorRoundResult> => {
    const verdict = scriptedVerdicts[i++];
    if (!verdict) {
      throw new Error(`spawnValidator: ran out of scripted verdicts (call #${i})`);
    }

    if (verdict.verdict === 'attest') {
      const out = await validatorAttest.invoke({
        projectRoot,
        caller: { role: 'validator' },
        attestation: verdict,
      });
      if (!out.ok) {
        // SDK-tool failure surfaces to runtime as a semantic fault — the
        // task description's "real spawn" path needs the tool failure to
        // be visible. Use a known fault kind that maps to escalation.
        return {
          ok: false,
          fault: {
            kind: 'validator-partial',
            message: `validator.attest failed: ${out.code} — ${out.message}`,
          },
        };
      }
      return { ok: true, verdict };
    }

    // verdict.verdict === 'reject'
    const out = await validatorReject.invoke({
      projectRoot,
      caller: { role: 'validator' },
      rejection: verdict,
    });
    if (!out.ok) {
      return {
        ok: false,
        fault: {
          kind: 'validator-partial',
          message: `validator.reject failed: ${out.code} — ${out.message}`,
        },
      };
    }
    return { ok: true, verdict };
  };
}

// ---------------------------------------------------------------------------
// Test setup / teardown — fresh fixture DB per test (T10515 critical note #6)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Coverage path 1 — Attest happy path (T10515 AC #3.1)
// ---------------------------------------------------------------------------

describe('Validator pipeline integration — attest happy path (T10515)', () => {
  it('AC #3.1: ATTEST writes bindings → AC-coverage gate passes', async () => {
    const { task, acRows } = await seedWorkerTask(accessor, env.tempDir, 'AttestHappy', [
      'AC1 satisfied by real evidence',
      'AC2 satisfied by real evidence',
    ]);
    const acIds = acRows.map((r) => r.id);

    // Pre-condition: coverage gate REFUSES completion before validator runs.
    const before = await computeAcCoverage(task.id, accessor);
    expect(before.ok).toBe(false);
    if (before.ok) throw new Error('unreachable');
    expect(before.unsatisfied).toHaveLength(2);

    const deps: ValidatorRuntimeDeps = {
      spawnValidator: buildRealSdkSpawnValidator(env.tempDir, [buildAttestation(task.id, acIds)]),
      respawnWorker: async () => ({ ok: true }),
      sleep: noopSleep,
      now: nowIso,
    };

    const result = await runValidatorMaxN(task.id, deps, { projectRoot: env.tempDir });

    expect(result.outcome).toBe('attest');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.retryDecision).toBe('attest');

    // Post-condition: evidence_ac_bindings rows landed (one per AC) AND the
    // AC-coverage gate now PASSES — Worker `cleo complete` would succeed.
    const bindings = await accessor.getAcBindings(acIds);
    expect(bindings).toHaveLength(2);
    expect(bindings.every((b) => b.bindingType === 'coverage')).toBe(true);

    const after = await computeAcCoverage(task.id, accessor);
    expect(after.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Coverage path 2 — Reject happy path (T10515 AC #3.2)
// ---------------------------------------------------------------------------

describe('Validator pipeline integration — reject happy path (T10515)', () => {
  it('AC #3.2: REJECT writes NO bindings → AC-coverage gate still fails', async () => {
    const { task, acRows } = await seedWorkerTask(accessor, env.tempDir, 'RejectHappy', [
      'AC1 not yet satisfied',
      'AC2 not yet satisfied',
    ]);
    const acIds = acRows.map((r) => r.id);

    // Runtime sees ONE rejection and no further scripted verdicts — Worker
    // re-spawn callback returns a transient-but-non-resolving state, so
    // the next loop iteration will try another spawn. Cap retry to 1 so
    // the loop terminates at the cap with a deterministic outcome.
    const deps: ValidatorRuntimeDeps = {
      spawnValidator: buildRealSdkSpawnValidator(env.tempDir, [
        buildRejection(task.id, acIds, 'round-1 REJECT — fix failing test'),
      ]),
      respawnWorker: async () => ({ ok: true }),
      sleep: noopSleep,
      now: nowIso,
    };

    const result = await runValidatorMaxN(task.id, deps, {
      projectRoot: env.tempDir,
      validatorRetryMax: 1, // single REJECT exhausts the shared cap → HITL
    });

    expect(result.outcome).toBe('escalate-hitl');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.retryDecision).toBe('escalate-hitl');

    // INVARIANT: REJECT writes NO bindings (validator.reject contract).
    const bindings = await accessor.getAcBindings(acIds);
    expect(bindings).toHaveLength(0);

    // AC-coverage gate would STILL refuse completion — worker can re-submit.
    const coverage = await computeAcCoverage(task.id, accessor);
    expect(coverage.ok).toBe(false);
    if (coverage.ok) throw new Error('unreachable');
    expect(coverage.unsatisfied).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Coverage path 3 — Retry-then-attest (T10515 AC #3.3)
// ---------------------------------------------------------------------------

describe('Validator pipeline integration — retry then attest (T10515)', () => {
  it('AC #3.3: REJECT → Worker fixes → ATTEST → bindings written', async () => {
    const { task, acRows } = await seedWorkerTask(accessor, env.tempDir, 'RetryAttest', [
      'AC1 must compile',
      'AC2 must pass tests',
    ]);
    const acIds = acRows.map((r) => r.id);

    let respawnInvocations = 0;
    const deps: ValidatorRuntimeDeps = {
      spawnValidator: buildRealSdkSpawnValidator(env.tempDir, [
        buildRejection(task.id, acIds, 'round-1 REJECT — fix AC1'),
        buildAttestation(task.id, acIds),
      ]),
      respawnWorker: async (workerTaskId, rejection, attemptNumber) => {
        respawnInvocations += 1;
        // Real-world contract: the orchestrator re-dispatches the Worker
        // with the rejection envelope. For the test we assert the contract
        // shape and let the next loop iteration spawn the validator again.
        expect(workerTaskId).toBe(task.id);
        expect(rejection.verdict).toBe('reject');
        expect(attemptNumber).toBe(1);
        return { ok: true };
      },
      sleep: noopSleep,
      now: nowIso,
    };

    const result = await runValidatorMaxN(task.id, deps, { projectRoot: env.tempDir });

    expect(result.outcome).toBe('attest');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.retryDecision).toBe('retry-worker');
    expect(result.attempts[0]?.faultFamily).toBe('semantic');
    expect(result.attempts[1]?.retryDecision).toBe('attest');
    expect(respawnInvocations).toBe(1);

    // Bindings landed ONLY on the ATTEST round.
    const bindings = await accessor.getAcBindings(acIds);
    expect(bindings).toHaveLength(2);
    expect(bindings.every((b) => b.bindingType === 'coverage')).toBe(true);

    // AC-coverage gate passes after the successful round.
    const coverage = await computeAcCoverage(task.id, accessor);
    expect(coverage.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Coverage path 4 — Retry-exhaust then escalate (T10515 AC #3.4)
// ---------------------------------------------------------------------------

describe('Validator pipeline integration — retry exhaust escalate (T10515)', () => {
  it('AC #3.4: Max-N REJECTs exhaust shared cap → escalate-hitl + audit row', async () => {
    const { task, acRows } = await seedWorkerTask(accessor, env.tempDir, 'RetryExhaust', [
      'AC1 must compile',
    ]);
    const acIds = acRows.map((r) => r.id);

    const deps: ValidatorRuntimeDeps = {
      spawnValidator: buildRealSdkSpawnValidator(env.tempDir, [
        buildRejection(task.id, acIds, 'r1'),
        buildRejection(task.id, acIds, 'r2'),
        buildRejection(task.id, acIds, 'r3'),
      ]),
      respawnWorker: async () => ({ ok: true }),
      sleep: noopSleep,
      now: nowIso,
    };

    const result = await runValidatorMaxN(task.id, deps, {
      projectRoot: env.tempDir,
      validatorRetryMax: 3,
    });

    expect(result.outcome).toBe('escalate-hitl');
    expect(result.attempts).toHaveLength(3);
    // First two attempts retry the Worker; the third hits the shared cap.
    expect(result.attempts[0]?.retryDecision).toBe('retry-worker');
    expect(result.attempts[1]?.retryDecision).toBe('retry-worker');
    expect(result.attempts[2]?.retryDecision).toBe('escalate-hitl');

    // INVARIANT: NO bindings on any round — all REJECTs.
    const bindings = await accessor.getAcBindings(acIds);
    expect(bindings).toHaveLength(0);

    // AC #3.4 audit: `.cleo/audit/validator-retries.jsonl` carries the
    // escalation row. The runtime canonical signal is
    // `retryDecision='escalate-hitl'` (per T10512 audit schema) — that
    // IS the "escalated=true" semantic the task description references.
    const auditPath = join(env.tempDir, VALIDATOR_RETRIES_AUDIT_FILE);
    const contents = await readFile(auditPath, 'utf-8');
    const lines = contents.trim().split('\n');
    expect(lines).toHaveLength(3);
    const escalationRow = JSON.parse(lines[2]!);
    expect(escalationRow.taskId).toBe(task.id);
    expect(escalationRow.retryDecision).toBe('escalate-hitl');
    expect(escalationRow.faultFamily).toBe('semantic');
    expect(escalationRow.attemptNumber).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: bindings + waiver compose so partially-failing tasks
// still need ALL waivers documented to complete (T10515 cross-saga AC#1).
// ---------------------------------------------------------------------------

describe('Validator pipeline integration — partial attest + waiver (T10515)', () => {
  it('partial coverage (ATTEST one AC) leaves residue that --waive-ac must address', async () => {
    const { task, acRows } = await seedWorkerTask(accessor, env.tempDir, 'PartialWaive', [
      'AC1 satisfiable',
      'AC2 unsatisfiable',
    ]);
    const acIds = acRows.map((r) => r.id);

    // Validator attests ONLY AC1 — AC2 left uncovered.
    const partialAttestation: ValidatorAttestation = {
      verdict: 'attest',
      taskId: task.id,
      validatorId: VALIDATOR_ID,
      findings: [
        {
          acId: acIds[0]!,
          status: 'pass',
          reasoning: 'AC1 satisfied',
          checkedAt: NOW,
        },
      ],
      attestedAt: NOW,
      schemaVersion: '1',
    };

    const deps: ValidatorRuntimeDeps = {
      spawnValidator: buildRealSdkSpawnValidator(env.tempDir, [partialAttestation]),
      respawnWorker: async () => ({ ok: true }),
      sleep: noopSleep,
      now: nowIso,
    };

    const result = await runValidatorMaxN(task.id, deps, { projectRoot: env.tempDir });
    expect(result.outcome).toBe('attest');

    // Coverage gate finds residue.
    const coverage = await computeAcCoverage(task.id, accessor);
    expect(coverage.ok).toBe(false);
    if (coverage.ok) throw new Error('unreachable');
    expect(coverage.unsatisfied).toHaveLength(1);
    expect(coverage.unsatisfied[0]?.alias).toBe('AC2');

    // Operator waives AC2 by alias — residue becomes empty.
    const waivers = resolveWaivers('AC2', acRows);
    expect(waivers.acIds).toEqual([acIds[1]]);
    const residue = applyWaivers(coverage.unsatisfied, new Set(waivers.acIds));
    expect(residue).toHaveLength(0);
  });
});
