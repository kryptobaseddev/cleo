/**
 * Tests for {@link boundedErrorMessage} (T13711).
 *
 * drizzle interpolates the full SQL text and every bound parameter into
 * `error.message` (~900 KB observed on axiom-app). The helper must surface the
 * small driver cause, cap everything, and never let a parameter dump through.
 *
 * @task T13711
 */

import { describe, expect, it } from 'vitest';
import { boundedErrorMessage } from '../error-message.js';

describe('boundedErrorMessage (T13711)', () => {
  it('prefers the wrapped driver cause over the params-laden outer message', () => {
    const driverCause = new Error('too many SQL variables');
    const drizzleErr = new Error(
      'Failed query: insert into docs_wikilinks values (?, ?, ?, ?, ?), (?, … params: ["a","b",…900KB…]',
    );
    drizzleErr.cause = driverCause;

    const out = boundedErrorMessage(drizzleErr);

    expect(out).toContain('too many SQL variables');
    expect(out).not.toContain('params:');
    expect(out).not.toContain('?, ?');
  });

  it('caps a long fallback message and collapses whitespace to one line', () => {
    const err = new Error(`line one\n${'x'.repeat(5000)}`);
    const out = boundedErrorMessage(err);

    expect(out).not.toContain('\n');
    expect(out.length).toBeLessThan(600);
    expect(out).toContain('[truncated');
  });

  it('respects a custom cap', () => {
    const err = new Error('0123456789');
    expect(boundedErrorMessage(err, 5)).toBe('01234… [truncated 10 chars]');
  });

  it('formats non-Error thrown values', () => {
    expect(boundedErrorMessage('plain string')).toBe('plain string');
    expect(boundedErrorMessage(42)).toBe('42');
  });

  it('keeps short messages untouched', () => {
    expect(boundedErrorMessage(new Error('constraint failed'))).toBe('constraint failed');
  });
});
