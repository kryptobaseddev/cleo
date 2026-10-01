/**
 * Worker re-verification runs affected tests first, the full suite only when
 * affected planning refuses (T12962).
 *
 * `defaultRunProjectTests` used to run a full `tool:test` for every worker
 * exit, whatever the worker claimed. With several agents finishing at once
 * that was N full suites. It now asks for `tool:test-affected`, falls back to
 * `tool:test` only on a planning refusal, and both atoms go through the ADR-061
 * cache, so a result already recorded for the same tree is reused.
 *
 * @task T12962
 */

import { describe, expect, it } from 'vitest';
import type { AtomValidation } from '../../tasks/evidence.js';
import { defaultRunProjectTests, reVerifyWorkerReport } from '../worker-verify.js';

/** A validator stub that answers per atom and records the order it was asked. */
function stubValidator(answers: Record<string, AtomValidation>) {
  const calls: string[] = [];
  const validate = async (atom: string): Promise<AtomValidation> => {
    calls.push(atom);
    const answer = answers[atom];
    if (!answer) throw new Error(`unexpected atom ${atom}`);
    return answer;
  };
  return { calls, validate };
}

const PASS: AtomValidation = { ok: true, atom: { kind: 'tool', tool: 'test', exitCode: 0 } };

describe('defaultRunProjectTests scope (T12962)', () => {
  it('accepts on a passing affected run and never runs the full suite', async () => {
    const { calls, validate } = stubValidator({ 'tool:test-affected': PASS });
    const r = await defaultRunProjectTests('/repo', validate);
    expect(r).toEqual({ ok: true, scope: 'affected' });
    expect(calls).toEqual(['tool:test-affected']);
  });

  it('reports a failing affected run as the verdict without escalating to the full suite', async () => {
    const { calls, validate } = stubValidator({
      'tool:test-affected': {
        ok: false,
        codeName: 'E_EVIDENCE_TOOL_FAILED',
        reason: 'vitest exited 1',
      },
    });
    const r = await defaultRunProjectTests('/repo', validate);
    expect(r).toEqual({ ok: false, reason: 'vitest exited 1', scope: 'affected' });
    expect(calls).toEqual(['tool:test-affected']);
  });

  it.each([
    ['no affectedCommand configured', 'E_EVIDENCE_TOOL_UNAVAILABLE'],
    ['a root-config change', 'E_EVIDENCE_INSUFFICIENT'],
  ])('falls back to the full tool:test when affected planning refuses (%s)', async (_l, code) => {
    const { calls, validate } = stubValidator({
      'tool:test-affected': { ok: false, codeName: code, reason: 'refused' },
      'tool:test': PASS,
    });
    const r = await defaultRunProjectTests('/repo', validate);
    expect(r).toEqual({ ok: true, scope: 'full' });
    expect(calls).toEqual(['tool:test-affected', 'tool:test']);
  });

  it('reports a failing full run after a refusal', async () => {
    const { validate } = stubValidator({
      'tool:test-affected': { ok: false, codeName: 'E_EVIDENCE_INSUFFICIENT', reason: 'refused' },
      'tool:test': { ok: false, codeName: 'E_EVIDENCE_TOOL_FAILED', reason: 'suite red' },
    });
    expect(await defaultRunProjectTests('/repo', validate)).toEqual({
      ok: false,
      reason: 'suite red',
      scope: 'full',
    });
  });

  it('names the scope that failed in the mismatch it records', async () => {
    const result = await reVerifyWorkerReport(
      { taskId: 'T1', selfReportSuccess: true, evidenceAtoms: ['tool:test'], touchedFiles: [] },
      {
        projectRoot: '/nonexistent-worker-verify-scope',
        runProjectTests: async () => ({ ok: false, reason: 'red', scope: 'affected' }),
        listChangedFiles: async () => [],
      },
    );
    expect(result.accepted).toBe(false);
    expect(result.auditEntry?.mismatches[0]?.actual).toBe('tool:test-affected failed: red');
  });
});
