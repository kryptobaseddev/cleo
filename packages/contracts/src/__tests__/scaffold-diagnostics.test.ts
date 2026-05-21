/**
 * Structural-equivalence tests for the scaffold-diagnostics contracts.
 *
 * These tests pin the field shapes of {@link ScaffoldResult},
 * {@link CheckStatus}, {@link CheckResult}, and {@link HookCheckResult}
 * so accidental narrowing or widening triggers a compile-time failure
 * during `tsc -b` in the CI gate.
 *
 * The compile-time assertions use the conditional-equality trick
 * (`Equals<A, B>`) so any structural drift produces a TS2322 or TS2344
 * at build time. The runtime `expect` shape sanity check below is a
 * thin smoke verification that constructible literals satisfy each
 * interface — it does NOT exercise behavior (these are pure type
 * contracts with no runtime).
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 (Phase 0a)
 */

import { describe, expect, it } from 'vitest';
import type {
  CheckResult,
  CheckStatus,
  HookCheckResult,
  ScaffoldResult,
} from '../scaffold-diagnostics.js';

// ─── Compile-time structural-equality helpers ───────────────────────

/** Resolve to `1` IFF `A` and `B` are mutually assignable; `2` otherwise. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? 1 : 2;

/** Compile-time assert that `T` resolves to `1`. */
type AssertEquals1<T extends 1> = T;

// ─── ScaffoldResult shape pin ───────────────────────────────────────

type _ScaffoldResultShape = {
  action: 'created' | 'repaired' | 'skipped';
  path: string;
  details?: string;
};

type _AssertScaffoldResultPinned = AssertEquals1<Equals<ScaffoldResult, _ScaffoldResultShape>>;

// ─── CheckStatus shape pin ──────────────────────────────────────────

type _CheckStatusShape = 'passed' | 'failed' | 'warning' | 'info';

type _AssertCheckStatusPinned = AssertEquals1<Equals<CheckStatus, _CheckStatusShape>>;

// ─── CheckResult shape pin ──────────────────────────────────────────

type _CheckResultShape = {
  id: string;
  category: string;
  status: CheckStatus;
  message: string;
  details: Record<string, unknown>;
  fix: string | null;
};

type _AssertCheckResultPinned = AssertEquals1<Equals<CheckResult, _CheckResultShape>>;

// ─── HookCheckResult shape pin ──────────────────────────────────────

type _HookCheckResultShape = {
  hook: string;
  installed: boolean;
  current: boolean;
  sourcePath: string;
  installedPath: string;
};

type _AssertHookCheckResultPinned = AssertEquals1<Equals<HookCheckResult, _HookCheckResultShape>>;

// ─── Runtime constructibility smoke ─────────────────────────────────

describe('scaffold-diagnostics contracts', () => {
  it('ScaffoldResult is constructible with the canonical shape', () => {
    const r: ScaffoldResult = { action: 'created', path: '/tmp/x' };
    expect(r.action).toBe('created');
    expect(r.path).toBe('/tmp/x');
    expect(r.details).toBeUndefined();
  });

  it('ScaffoldResult accepts the optional details field', () => {
    const r: ScaffoldResult = {
      action: 'repaired',
      path: '/tmp/y',
      details: 'rewrote stale entry',
    };
    expect(r.details).toBe('rewrote stale entry');
  });

  it('CheckResult is constructible with the canonical shape', () => {
    const r: CheckResult = {
      id: 'cleo_structure',
      category: 'scaffold',
      status: 'passed',
      message: 'All subdirs present',
      details: { missing: [] },
      fix: null,
    };
    expect(r.status).toBe('passed');
    expect(r.fix).toBeNull();
  });

  it('CheckStatus union covers exactly the 4 documented values', () => {
    const statuses: CheckStatus[] = ['passed', 'failed', 'warning', 'info'];
    expect(statuses).toHaveLength(4);
  });

  it('HookCheckResult is constructible with the canonical shape', () => {
    const r: HookCheckResult = {
      hook: 'pre-commit',
      installed: true,
      current: false,
      sourcePath: '/pkg/templates/git-hooks/pre-commit',
      installedPath: '/proj/.git/hooks/pre-commit',
    };
    expect(r.installed).toBe(true);
    expect(r.current).toBe(false);
  });

  // The four `_Assert…Pinned` aliases above will fail compilation if
  // any shape drifts. The following references prevent unused-locals
  // diagnostics from removing them.
  it('compile-time pins are wired (no-op at runtime)', () => {
    const pinned: [
      _AssertScaffoldResultPinned,
      _AssertCheckStatusPinned,
      _AssertCheckResultPinned,
      _AssertHookCheckResultPinned,
    ] = [1, 1, 1, 1];
    expect(pinned).toEqual([1, 1, 1, 1]);
  });
});
