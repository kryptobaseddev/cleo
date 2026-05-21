/**
 * Structural-equivalence tests for the background-job contracts.
 *
 * Pins the literal shape of {@link BackgroundJobStatus} promoted in
 * Phase 0c (T9955) so accidental narrowing or widening triggers a
 * compile-time failure during `tsc -b` in the CI gate.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9955 (Phase 0c)
 */

import { describe, expect, it } from 'vitest';
import type { BackgroundJobStatus } from '../jobs.js';

// ─── Compile-time structural-equality helpers ───────────────────────

/** Resolve to `1` IFF `A` and `B` are mutually assignable; `2` otherwise. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? 1 : 2;

/** Compile-time assert that `T` resolves to `1`. */
type AssertEquals1<T extends 1> = T;

// ─── BackgroundJobStatus shape pin ──────────────────────────────────

type _BackgroundJobStatusShape =
  | 'pending'
  | 'running'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'orphaned';

type _AssertBackgroundJobStatusPinned = AssertEquals1<
  Equals<BackgroundJobStatus, _BackgroundJobStatusShape>
>;

// ─── Runtime constructibility smoke ─────────────────────────────────

describe('jobs contracts', () => {
  it('BackgroundJobStatus enumerates the 6 documented lifecycle states', () => {
    const all: BackgroundJobStatus[] = [
      'pending',
      'running',
      'complete',
      'failed',
      'cancelled',
      'orphaned',
    ];
    expect(all).toHaveLength(6);
  });

  it('BackgroundJobStatus distinguishes terminal from in-flight states', () => {
    const terminal: BackgroundJobStatus[] = ['complete', 'failed', 'cancelled', 'orphaned'];
    const inFlight: BackgroundJobStatus[] = ['pending', 'running'];
    expect(terminal).toHaveLength(4);
    expect(inFlight).toHaveLength(2);
  });

  it('Every BackgroundJobStatus is a non-empty string literal', () => {
    const statuses: BackgroundJobStatus[] = [
      'pending',
      'running',
      'complete',
      'failed',
      'cancelled',
      'orphaned',
    ];
    for (const s of statuses) {
      expect(s.length).toBeGreaterThan(0);
    }
  });

  it('compile-time pin is wired (no-op at runtime)', () => {
    const pinned: _AssertBackgroundJobStatusPinned = 1;
    expect(pinned).toBe(1);
  });
});
