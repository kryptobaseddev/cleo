/**
 * Release reconcile recovers the existing BRAIN entry when `cleo memory
 * observe` refuses a duplicate on a re-run (T13949, T13988).
 *
 * @task T13988
 */

import { describe, expect, it } from 'vitest';
import { existingObservationId } from '../reconcile.js';

/** An `execFile` rejection whose stdout holds a CLI error envelope. */
function failed(error: Record<string, unknown>): Error & { stdout: string } {
  return Object.assign(new Error('Command failed'), {
    stdout: `${JSON.stringify({ success: false, error, meta: {} })}\n`,
  });
}

describe('existingObservationId (T13988)', () => {
  it('returns the existing id of a merged duplicate', () => {
    const err = failed({
      code: 110,
      codeName: 'E_OBSERVE_NOT_STORED',
      message: 'Nothing stored',
      details: { id: 'O-existing', gateAction: 'merged' },
    });
    expect(existingObservationId(err)).toBe('O-existing');
  });

  it('returns null for a deferred or rejected write, another error, or no envelope', () => {
    const pending = failed({
      code: 110,
      codeName: 'E_OBSERVE_NOT_STORED',
      details: { id: 'O-gate-placeholder', gateAction: 'pending' },
    });
    expect(existingObservationId(pending)).toBeNull();
    expect(existingObservationId(failed({ code: 1, codeName: 'E_INTERNAL' }))).toBeNull();
    expect(existingObservationId(new Error('spawn cleo ENOENT'))).toBeNull();
    expect(existingObservationId(Object.assign(new Error('x'), { stdout: 'not json' }))).toBeNull();
  });
});
