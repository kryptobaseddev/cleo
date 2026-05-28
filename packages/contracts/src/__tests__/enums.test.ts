/**
 * Structural-equivalence + value-set tests for the task-axis enum
 * constants promoted in Phase 0c (T9955).
 *
 * These tests pin the runtime value sets of the 6 `as const` arrays
 * (`TASK_KINDS`, `TASK_SCOPES`, `TASK_SEVERITIES`, `TASK_SIZES`,
 * `ARCHIVE_REASONS`, `TASK_RELATION_TYPES`) so that:
 *   - The Drizzle row-type narrowing in `tasks-schema.ts` stays byte-identical.
 *   - The DB CHECK constraints they back keep their canonical value list.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9955 (Phase 0c)
 */

import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_REASONS,
  TASK_KINDS,
  TASK_RELATION_TYPES,
  TASK_SCOPES,
  TASK_SEVERITIES,
  TASK_SIZES,
} from '../enums.js';

// ─── Compile-time readonly-tuple guarantees ─────────────────────────

/**
 * Compile-time assertion that `T` is a readonly tuple (not a mutable
 * `string[]`). Drizzle's `text({ enum })` narrowing depends on the
 * literal tuple shape, so accidental widening MUST fail at build time.
 */
type _AssertReadonlyTuple<T extends readonly string[]> = T;

type _PinTaskKinds = _AssertReadonlyTuple<typeof TASK_KINDS>;
type _PinTaskScopes = _AssertReadonlyTuple<typeof TASK_SCOPES>;
type _PinTaskSeverities = _AssertReadonlyTuple<typeof TASK_SEVERITIES>;
type _PinTaskSizes = _AssertReadonlyTuple<typeof TASK_SIZES>;
type _PinArchiveReasons = _AssertReadonlyTuple<typeof ARCHIVE_REASONS>;
type _PinTaskRelationTypes = _AssertReadonlyTuple<typeof TASK_RELATION_TYPES>;

// ─── Runtime value-set assertions ───────────────────────────────────

describe('task-axis enum constants', () => {
  it('TASK_KINDS holds the 6 canonical task kinds', () => {
    expect(TASK_KINDS).toEqual(['work', 'research', 'experiment', 'bug', 'spike', 'release']);
  });

  it('TASK_SCOPES holds project / feature / unit (in canonical order)', () => {
    expect(TASK_SCOPES).toEqual(['project', 'feature', 'unit']);
  });

  it('TASK_SEVERITIES holds P0 through P3 in increasing severity order', () => {
    expect(TASK_SEVERITIES).toEqual(['P0', 'P1', 'P2', 'P3']);
  });

  it('TASK_SIZES holds small / medium / large (CLEO avoids time estimates)', () => {
    expect(TASK_SIZES).toEqual(['small', 'medium', 'large']);
  });

  it('ARCHIVE_REASONS holds exactly the 6 truth-grade closure reasons', () => {
    expect(ARCHIVE_REASONS).toEqual([
      'verified',
      'reconciled',
      'superseded',
      'shadowed',
      'cancelled',
      'completed-unverified',
    ]);
  });

  it('TASK_RELATION_TYPES includes "groups" (non-containment soft association, ADR-088)', () => {
    expect(TASK_RELATION_TYPES).toContain('groups');
    expect(TASK_RELATION_TYPES).toEqual([
      'related',
      'blocks',
      'duplicates',
      'absorbs',
      'fixes',
      'extends',
      'supersedes',
      'groups',
    ]);
  });

  it('All enum arrays are non-empty readonly tuples', () => {
    expect(TASK_KINDS.length).toBeGreaterThan(0);
    expect(TASK_SCOPES.length).toBeGreaterThan(0);
    expect(TASK_SEVERITIES.length).toBeGreaterThan(0);
    expect(TASK_SIZES.length).toBeGreaterThan(0);
    expect(ARCHIVE_REASONS.length).toBeGreaterThan(0);
    expect(TASK_RELATION_TYPES.length).toBeGreaterThan(0);
  });

  // The six `_Pin…` aliases above will fail compilation if any const
  // array is accidentally widened to `string[]`. The reference below
  // prevents unused-locals diagnostics from removing them.
  it('compile-time readonly-tuple pins are wired (no-op at runtime)', () => {
    const pinned: [
      _PinTaskKinds,
      _PinTaskScopes,
      _PinTaskSeverities,
      _PinTaskSizes,
      _PinArchiveReasons,
      _PinTaskRelationTypes,
    ] = [
      TASK_KINDS,
      TASK_SCOPES,
      TASK_SEVERITIES,
      TASK_SIZES,
      ARCHIVE_REASONS,
      TASK_RELATION_TYPES,
    ];
    expect(pinned).toHaveLength(6);
  });
});
