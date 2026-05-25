/**
 * Tests for the Validator Max-N runtime (T10512).
 *
 * Coverage matrix (AC6):
 *   - Happy path: attest first try
 *   - Happy path: reject → fix → attest
 *   - Each infra-fault row:
 *       * timeout (exponential backoff 5s/30s, retryCount=2)
 *       * conduit-drop (immediate, retryCount=3)
 *       * validator-OOM (immediate-downgrade, retryCount=1, transient-then-permanent)
 *   - Counter exhaustion → escalate to Lead (shared cap)
 *   - Shared-counter adversarial alternation (REJECT → timeout → REJECT → ...)
 *   - Permanent classification short-circuits
 *   - Audit JSONL append-only behaviour + suppressAudit
 *   - Worker respawn failure handling
 *
 * @task T10512
 * @epic T10383
 * @saga T10377
 */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ValidatorAttestation,
  ValidatorRejection,
  ValidatorVerdict,
} from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveBackoffMs,
  runValidatorMaxN,
  VALIDATOR_RETRIES_AUDIT_FILE,
  type ValidatorRoundResult,
  type ValidatorRuntimeDeps,
  type ValidatorSpawnRequest,
} from '../runtime.js';

// ===========================================================================
// Test fixtures
// ===========================================================================

const NOW = '2026-05-24T22:00:00.000Z';
const TASK_ID = 'T1234';

function fixedNow(): string {
  return NOW;
}

function noopSleep(): Promise<void> {
  return Promise.resolve();
}

function buildAttestation(): ValidatorAttestation {
  return {
    verdict: 'attest',
    taskId: TASK_ID,
    validatorId: 'validator-prime',
    findings: [
      {
        acId: '11111111-2222-3333-4444-555555555555',
        status: 'pass',
        reasoning: 'AC1 passed: tool:test exit 0',
        checkedAt: NOW,
      },
    ],
    attestedAt: NOW,
    schemaVersion: '1',
  };
}

function buildRejection(summary = 'AC1 failed'): ValidatorRejection {
  return {
    verdict: 'reject',
    taskId: TASK_ID,
    validatorId: 'validator-prime',
    findings: [
      {
        acId: '11111111-2222-3333-4444-555555555555',
        status: 'fail',
        reasoning: 'tool:test exited 1 with 3 test failures',
        checkedAt: NOW,
      },
    ],
    summary,
    rejectedAt: NOW,
    schemaVersion: '1',
  };
}

interface ScriptedSpawn {
  result: ValidatorRoundResult;
  /** Optional assertion to run against the spawn request when invoked. */
  expect?: (req: ValidatorSpawnRequest) => void;
}

function scriptedSpawnValidator(script: ScriptedSpawn[]): ValidatorRuntimeDeps['spawnValidator'] {
  let i = 0;
  return async (req) => {
    const next = script[i++];
    if (!next) {
      throw new Error(`scriptedSpawnValidator: ran out of scripted responses (call #${i})`);
    }
    if (next.expect) next.expect(req);
    return next.result;
  };
}

function scriptedRespawnWorker(
  results: Array<{ ok: true } | { ok: false; fault: { kind: 'timeout'; message: string } }>,
): ValidatorRuntimeDeps['respawnWorker'] {
  let i = 0;
  return async () => {
    const next = results[i++];
    if (!next) {
      throw new Error(`scriptedRespawnWorker: ran out of scripted responses (call #${i})`);
    }
    return next;
  };
}

// ===========================================================================
// Test setup / teardown
// ===========================================================================

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-validator-runtime-'));
  await mkdir(join(testDir, '.cleo'), { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ===========================================================================
// AC1 — Happy path: attest first try
// ===========================================================================

describe('runValidatorMaxN — happy path', () => {
  it('AC1: returns attest on first round and writes one audit row', async () => {
    const deps: ValidatorRuntimeDeps = {
      spawnValidator: scriptedSpawnValidator([
        { result: { ok: true, verdict: buildAttestation() } },
      ]),
      respawnWorker: scriptedRespawnWorker([]),
      sleep: noopSleep,
      now: fixedNow,
    };

    const result = await runValidatorMaxN(TASK_ID, deps, { projectRoot: testDir });

    expect(result.outcome).toBe('attest');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.retryDecision).toBe('attest');
    expect(result.attempts[0]?.faultKind).toBeNull();

    // Audit JSONL contains exactly one row.
    const auditPath = join(testDir, VALIDATOR_RETRIES_AUDIT_FILE);
    const contents = await readFile(auditPath, 'utf-8');
    const lines = contents.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.taskId).toBe(TASK_ID);
    expect(parsed.attemptNumber).toBe(1);
    expect(parsed.retryDecision).toBe('attest');
  });
});

// ===========================================================================
// AC1 — Happy path: reject → fix → attest
// ===========================================================================

describe('runValidatorMaxN — reject then attest', () => {
  it('AC1: re-spawns worker on reject, then attests on second round', async () => {
    const deps: ValidatorRuntimeDeps = {
      spawnValidator: scriptedSpawnValidator([
        { result: { ok: true, verdict: buildRejection('AC1 failed initial') } },
        {
          result: { ok: true, verdict: buildAttestation() },
          expect: (req) => {
            expect(req.attemptNumber).toBe(2);
          },
        },
      ]),
      respawnWorker: scriptedRespawnWorker([{ ok: true }]),
      sleep: noopSleep,
      now: fixedNow,
    };

    const result = await runValidatorMaxN(TASK_ID, deps, { projectRoot: testDir });

    expect(result.outcome).toBe('attest');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.retryDecision).toBe('retry-worker');
    expect(result.attempts[0]?.faultKind).toBe('validator-partial');
    expect(result.attempts[1]?.retryDecision).toBe('attest');
  });
});

// ===========================================================================
// AC4 + AC6 — Each infra-fault row
// ===========================================================================

describe('runValidatorMaxN — timeout row (exponential 5s/30s, retryCount=2)', () => {
  it('AC4+AC6: retries with exponential backoff 5s then 30s, attests on 3rd attempt', async () => {
    const sleeps: number[] = [];
    const deps: ValidatorRuntimeDeps = {
      spawnValidator: scriptedSpawnValidator([
        { result: { ok: false, fault: { kind: 'timeout', message: 'subagent exceeded 300s' } } },
        { result: { ok: false, fault: { kind: 'timeout', message: 'subagent exceeded 300s' } } },
        { result: { ok: true, verdict: buildAttestation() } },
      ]),
      respawnWorker: scriptedRespawnWorker([]),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: fixedNow,
    };

    const result = await runValidatorMaxN(TASK_ID, deps, { projectRoot: testDir });

    expect(result.outcome).toBe('attest');
    expect(sleeps).toEqual([5_000, 30_000]);
    expect(result.attempts.map((a) => a.retryDecision)).toEqual([
      'retry-validator',
      'retry-validator',
      'attest',
    ]);
    expect(result.attempts[0]?.backoffMs).toBe(5_000);
    expect(result.attempts[1]?.backoffMs).toBe(30_000);
  });
});

describe('runValidatorMaxN — conduit-drop row (immediate, retryCount=3)', () => {
  it('AC4+AC6: zero backoff between retries; classification = transient', async () => {
    const sleeps: number[] = [];
    const deps: ValidatorRuntimeDeps = {
      spawnValidator: scriptedSpawnValidator([
        {
          result: {
            ok: false,
            fault: { kind: 'conduit-drop', message: 'verdict lost on transport' },
          },
        },
        {
          result: {
            ok: false,
            fault: { kind: 'conduit-drop', message: 'verdict lost on transport' },
          },
        },
        { result: { ok: true, verdict: buildAttestation() } },
      ]),
      respawnWorker: scriptedRespawnWorker([]),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: fixedNow,
    };

    const result = await runValidatorMaxN(TASK_ID, deps, { projectRoot: testDir });

    expect(result.outcome).toBe('attest');
    // backoffMs is 0 → sleep never called (runtime skips sleep when backoffMs===0).
    expect(sleeps).toEqual([]);
    expect(result.attempts[0]?.backoffMs).toBe(0);
    expect(result.attempts[1]?.backoffMs).toBe(0);
    expect(result.attempts[0]?.classification).toBe('transient');
  });
});

describe('runValidatorMaxN — validator-OOM row (immediate-downgrade, retryCount=1)', () => {
  it('AC4+AC6: sets downgradeModelTier on retry; second OOM becomes permanent', async () => {
    const downgradeFlags: Array<boolean | undefined> = [];
    const deps: ValidatorRuntimeDeps = {
      spawnValidator: scriptedSpawnValidator([
        {
          result: { ok: false, fault: { kind: 'validator-OOM', message: 'heap OOM' } },
          expect: (req) => downgradeFlags.push(req.downgradeModelTier),
        },
        {
          // Second attempt should request a downgrade.
          result: { ok: false, fault: { kind: 'validator-OOM', message: 'heap OOM again' } },
          expect: (req) => downgradeFlags.push(req.downgradeModelTier),
        },
      ]),
      respawnWorker: scriptedRespawnWorker([]),
      sleep: noopSleep,
      now: fixedNow,
    };

    const result = await runValidatorMaxN(TASK_ID, deps, { projectRoot: testDir });

    // First spawn: no downgrade. Second spawn: downgrade requested.
    expect(downgradeFlags[0]).toBeUndefined();
    expect(downgradeFlags[1]).toBe(true);

    // Second OOM exhausts the per-row retryCount=1 of the
    // transient-then-permanent row → escalate permanent.
    expect(result.outcome).toBe('escalate-permanent');
    if (result.outcome === 'escalate-permanent') {
      expect(result.fault.kind).toBe('validator-OOM');
    }
  });
});

// ===========================================================================
// AC3 + AC6 — Shared retry-counter accounting (adversarial alternation)
// ===========================================================================

describe('runValidatorMaxN — shared counter prevents adversarial alternation', () => {
  it('AC3+AC6: REJECT → timeout → REJECT exhausts shared counter (N=3) and escalates', async () => {
    const deps: ValidatorRuntimeDeps = {
      spawnValidator: scriptedSpawnValidator([
        { result: { ok: true, verdict: buildRejection('round 1 reject') } },
        { result: { ok: false, fault: { kind: 'timeout', message: 'round 2 timeout' } } },
        { result: { ok: true, verdict: buildRejection('round 3 reject') } },
      ]),
      respawnWorker: scriptedRespawnWorker([{ ok: true }, { ok: true }]),
      sleep: noopSleep,
      now: fixedNow,
    };

    const result = await runValidatorMaxN(TASK_ID, deps, { projectRoot: testDir });

    expect(result.outcome).toBe('escalate-hitl');
    // Shared counter incremented on EVERY fault — semantic + infra share the cap.
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts.map((a) => a.faultKind)).toEqual([
      'validator-partial',
      'timeout',
      'validator-partial',
    ]);
    expect(result.attempts.at(-1)?.retryDecision).toBe('escalate-hitl');
  });

  it('AC3+AC6: shared counter exhausts even with mixed transient infra faults', async () => {
    const deps: ValidatorRuntimeDeps = {
      spawnValidator: scriptedSpawnValidator([
        { result: { ok: false, fault: { kind: 'timeout', message: 't1' } } },
        { result: { ok: false, fault: { kind: 'conduit-drop', message: 'c1' } } },
        { result: { ok: false, fault: { kind: 'timeout', message: 't2' } } },
      ]),
      respawnWorker: scriptedRespawnWorker([]),
      sleep: noopSleep,
      now: fixedNow,
    };

    const result = await runValidatorMaxN(TASK_ID, deps, { projectRoot: testDir });

    expect(result.outcome).toBe('escalate-hitl');
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts.at(-1)?.retryDecision).toBe('escalate-hitl');
  });
});

// ===========================================================================
// AC2 + AC6 — Permanent classification short-circuits
// ===========================================================================

describe('runValidatorMaxN — permanent classification', () => {
  it('AC2+AC6: validator-rejected-no-acs short-circuits on first occurrence', async () => {
    const deps: ValidatorRuntimeDeps = {
      spawnValidator: scriptedSpawnValidator([
        {
          result: {
            ok: false,
            fault: {
              kind: 'validator-rejected-no-acs',
              message: 'task has zero ACs',
            },
          },
        },
      ]),
      respawnWorker: scriptedRespawnWorker([]),
      sleep: noopSleep,
      now: fixedNow,
    };

    const result = await runValidatorMaxN(TASK_ID, deps, { projectRoot: testDir });

    expect(result.outcome).toBe('escalate-permanent');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.retryDecision).toBe('escalate-permanent');
    expect(result.attempts[0]?.classification).toBe('permanent');
  });

  it('AC2+AC6: tool-not-resolved escalates permanent immediately', async () => {
    const deps: ValidatorRuntimeDeps = {
      spawnValidator: scriptedSpawnValidator([
        {
          result: {
            ok: false,
            fault: { kind: 'tool-not-resolved', message: 'testing.command missing' },
          },
        },
      ]),
      respawnWorker: scriptedRespawnWorker([]),
      sleep: noopSleep,
      now: fixedNow,
    };

    const result = await runValidatorMaxN(TASK_ID, deps, { projectRoot: testDir });

    expect(result.outcome).toBe('escalate-permanent');
  });
});

// ===========================================================================
// AC6 — Counter exhaustion via single fault kind
// ===========================================================================

describe('runValidatorMaxN — counter exhaustion', () => {
  it('AC6: timeout exhausts per-row cap (2 retries) then escalates HITL', async () => {
    const sleeps: number[] = [];
    const deps: ValidatorRuntimeDeps = {
      spawnValidator: scriptedSpawnValidator([
        { result: { ok: false, fault: { kind: 'timeout', message: 't1' } } },
        { result: { ok: false, fault: { kind: 'timeout', message: 't2' } } },
        { result: { ok: false, fault: { kind: 'timeout', message: 't3' } } },
      ]),
      respawnWorker: scriptedRespawnWorker([]),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: fixedNow,
    };

    const result = await runValidatorMaxN(TASK_ID, deps, { projectRoot: testDir });

    expect(result.outcome).toBe('escalate-hitl');
    expect(result.attempts).toHaveLength(3);
    expect(sleeps).toEqual([5_000, 30_000]);
    expect(result.attempts.at(-1)?.retryDecision).toBe('escalate-hitl');
  });

  it('AC6: respects custom validatorRetryMax (N=2) — escalates on 2nd reject', async () => {
    const deps: ValidatorRuntimeDeps = {
      spawnValidator: scriptedSpawnValidator([
        { result: { ok: true, verdict: buildRejection('r1') } },
        { result: { ok: true, verdict: buildRejection('r2') } },
      ]),
      respawnWorker: scriptedRespawnWorker([{ ok: true }]),
      sleep: noopSleep,
      now: fixedNow,
    };

    const result = await runValidatorMaxN(TASK_ID, deps, {
      projectRoot: testDir,
      validatorRetryMax: 2,
    });

    expect(result.outcome).toBe('escalate-hitl');
    expect(result.attempts).toHaveLength(2);
  });
});

// ===========================================================================
// AC5 — Audit JSONL behaviour
// ===========================================================================

describe('runValidatorMaxN — audit JSONL', () => {
  it('AC5: each retry attempt appends exactly one JSONL line', async () => {
    const deps: ValidatorRuntimeDeps = {
      spawnValidator: scriptedSpawnValidator([
        { result: { ok: false, fault: { kind: 'conduit-drop', message: 'd1' } } },
        { result: { ok: false, fault: { kind: 'conduit-drop', message: 'd2' } } },
        { result: { ok: true, verdict: buildAttestation() } },
      ]),
      respawnWorker: scriptedRespawnWorker([]),
      sleep: noopSleep,
      now: fixedNow,
    };

    await runValidatorMaxN(TASK_ID, deps, { projectRoot: testDir });

    const auditPath = join(testDir, VALIDATOR_RETRIES_AUDIT_FILE);
    const contents = await readFile(auditPath, 'utf-8');
    const lines = contents.trim().split('\n');
    expect(lines).toHaveLength(3);
    // Each line is standalone valid JSON.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].faultKind).toBe('conduit-drop');
    expect(parsed[1].faultKind).toBe('conduit-drop');
    expect(parsed[2].faultKind).toBeNull();
    expect(parsed[2].retryDecision).toBe('attest');
    // All rows carry timestamp + taskId.
    for (const row of parsed) {
      expect(row.timestamp).toBe(NOW);
      expect(row.taskId).toBe(TASK_ID);
    }
  });

  it('AC5: suppressAudit suppresses file writes entirely', async () => {
    const deps: ValidatorRuntimeDeps = {
      spawnValidator: scriptedSpawnValidator([
        { result: { ok: true, verdict: buildAttestation() } },
      ]),
      respawnWorker: scriptedRespawnWorker([]),
      sleep: noopSleep,
      now: fixedNow,
    };

    const result = await runValidatorMaxN(TASK_ID, deps, {
      projectRoot: testDir,
      suppressAudit: true,
    });

    expect(result.outcome).toBe('attest');
    // No audit file should exist.
    await expect(readFile(join(testDir, VALIDATOR_RETRIES_AUDIT_FILE), 'utf-8')).rejects.toThrow();
    // In-memory trail is still populated.
    expect(result.attempts).toHaveLength(1);
  });
});

// ===========================================================================
// Worker-respawn failure handling
// ===========================================================================

describe('runValidatorMaxN — worker respawn failures', () => {
  it('escalates HITL when respawnWorker returns ok=false', async () => {
    const deps: ValidatorRuntimeDeps = {
      spawnValidator: scriptedSpawnValidator([{ result: { ok: true, verdict: buildRejection() } }]),
      respawnWorker: scriptedRespawnWorker([
        { ok: false, fault: { kind: 'timeout', message: 'worker spawn timed out' } },
      ]),
      sleep: noopSleep,
      now: fixedNow,
    };

    const result = await runValidatorMaxN(TASK_ID, deps, { projectRoot: testDir });

    expect(result.outcome).toBe('escalate-hitl');
    if (result.outcome === 'escalate-hitl') {
      expect(result.reason).toContain('Worker re-spawn failed');
    }
  });

  it('escalates HITL when respawnWorker throws', async () => {
    const deps: ValidatorRuntimeDeps = {
      spawnValidator: scriptedSpawnValidator([{ result: { ok: true, verdict: buildRejection() } }]),
      respawnWorker: async () => {
        throw new Error('worker spawn crashed');
      },
      sleep: noopSleep,
      now: fixedNow,
    };

    const result = await runValidatorMaxN(TASK_ID, deps, { projectRoot: testDir });

    expect(result.outcome).toBe('escalate-hitl');
  });
});

// ===========================================================================
// Defensive: thrown errors from spawnValidator are translated to timeout
// ===========================================================================

describe('runValidatorMaxN — defensive error handling', () => {
  it('treats thrown errors from spawnValidator as timeout faults', async () => {
    let throws = 2;
    const deps: ValidatorRuntimeDeps = {
      spawnValidator: async (): Promise<ValidatorRoundResult> => {
        if (throws-- > 0) throw new Error('subagent ETIMEDOUT');
        return { ok: true, verdict: buildAttestation() };
      },
      respawnWorker: scriptedRespawnWorker([]),
      sleep: noopSleep,
      now: fixedNow,
    };

    const result = await runValidatorMaxN(TASK_ID, deps, { projectRoot: testDir });

    expect(result.outcome).toBe('attest');
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts[0]?.faultKind).toBe('timeout');
  });
});

// ===========================================================================
// resolveBackoffMs unit tests
// ===========================================================================

describe('resolveBackoffMs', () => {
  it('immediate strategy returns 0 regardless of attempt number', () => {
    expect(resolveBackoffMs({ kind: 'immediate' }, 1)).toBe(0);
    expect(resolveBackoffMs({ kind: 'immediate' }, 5)).toBe(0);
  });

  it('immediate-downgrade strategy returns 0', () => {
    expect(resolveBackoffMs({ kind: 'immediate-downgrade' }, 1)).toBe(0);
  });

  it('exponential strategy returns firstMs on first retry, secondMs on subsequent', () => {
    const s = { kind: 'exponential' as const, firstMs: 5_000, secondMs: 30_000 };
    expect(resolveBackoffMs(s, 1)).toBe(5_000);
    expect(resolveBackoffMs(s, 2)).toBe(30_000);
    expect(resolveBackoffMs(s, 3)).toBe(30_000);
  });
});

// ===========================================================================
// Type/discriminant integrity — verdict types narrow correctly
// ===========================================================================

describe('runValidatorMaxN — result discriminant', () => {
  it('attest outcome carries a typed attestation verdict', async () => {
    const att = buildAttestation();
    const deps: ValidatorRuntimeDeps = {
      spawnValidator: scriptedSpawnValidator([{ result: { ok: true, verdict: att } }]),
      respawnWorker: scriptedRespawnWorker([]),
      sleep: noopSleep,
      now: fixedNow,
    };

    const result = await runValidatorMaxN(TASK_ID, deps, {
      projectRoot: testDir,
      suppressAudit: true,
    });

    expect(result.outcome).toBe('attest');
    if (result.outcome === 'attest') {
      const narrowed: ValidatorVerdict = result.verdict;
      expect(narrowed.verdict).toBe('attest');
    }
  });
});
