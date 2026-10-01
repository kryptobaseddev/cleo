/**
 * Tests for `scripts/lint-row-identity-coverage.mjs` (T12897, arch gate 37).
 *
 * Fixture registries prove both failure modes: a syncing table with neither a
 * declared uid nor an exemption, and an exemption that is stale (its table is
 * gone, no longer syncs, or is declared). The repository itself must pass.
 *
 * @task T12897
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ROW_IDENTITY_EXEMPT_PINNED,
  rowIdentityExemptionSummary,
} from '../../packages/core/src/store/row-identity-registry.ts';
import { registrySyncTables, scopeProblems } from '../lint-row-identity-coverage.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'lint-row-identity-coverage.mjs');

const entry = (cls, status = 'draft') => ({ class: cls, status, source: 'fixture' });

/** a, b sync; c is local-only; d is a frozen twin; e is derived. */
const REGISTRY = {
  scope: 'project',
  tables: {
    a: entry('portable-project'),
    b: entry('portable-personal'),
    c: entry('local-only'),
    d: entry('local-only', 'frozen-legacy'),
    e: entry('derived'),
    f: entry('portable-project', 'frozen-legacy'),
  },
  patterns: [],
  pending: [],
};

const WHY = { category: 'unscheduled', reason: 'fixture', task: 'T1' };
const kinds = (problems) => problems.map((p) => `${p.kind}:${p.table ?? ''}`);

describe('registrySyncTables', () => {
  it('takes portable, non-frozen entries only', () => {
    expect(registrySyncTables(REGISTRY).sort()).toEqual(['a', 'b']);
  });
});

describe('scopeProblems', () => {
  it('passes when every syncing table is declared or exempt', () => {
    expect(
      scopeProblems({ registry: REGISTRY, declared: [{ table: 'a' }], exempt: { b: WHY } }),
    ).toEqual([]);
  });

  it('fails on a syncing table with neither a declaration nor an exemption', () => {
    expect(
      kinds(scopeProblems({ registry: REGISTRY, declared: [{ table: 'a' }], exempt: {} })),
    ).toEqual(['missing:b']);
    expect(kinds(scopeProblems({ registry: REGISTRY, declared: [], exempt: {} }))).toEqual([
      'missing:a',
      'missing:b',
    ]);
  });

  it('fails on a stale exemption: table gone or no longer syncing', () => {
    const problems = scopeProblems({
      registry: REGISTRY,
      declared: [{ table: 'a' }],
      exempt: { b: WHY, c: WHY, f: WHY, gone: WHY },
    });
    expect(kinds(problems)).toEqual(['stale:c', 'stale:f', 'stale:gone']);
  });

  it('fails on an exemption for a declared table', () => {
    expect(
      kinds(
        scopeProblems({
          registry: REGISTRY,
          declared: [{ table: 'a' }],
          exempt: { a: WHY, b: WHY },
        }),
      ),
    ).toEqual(['declared:a']);
  });

  it('fails on an exemption without a reason or a task', () => {
    const problems = scopeProblems({
      registry: REGISTRY,
      declared: [],
      exempt: { a: { ...WHY, reason: '  ' }, b: { ...WHY, task: 'soon' } },
    });
    expect(kinds(problems)).toEqual(['invalid:a', 'invalid:b']);
  });

  it('fails when the exemption count moves off its pin, either way', () => {
    const run = (pinned) =>
      scopeProblems({ registry: REGISTRY, declared: [], exempt: { a: WHY, b: WHY }, pinned });
    expect(run(2)).toEqual([]);
    expect(run(1).map((p) => p.message)).toEqual([
      expect.stringContaining('declare the new table'),
    ]);
    expect(run(3).map((p) => p.message)).toEqual([
      expect.stringContaining('lower ROW_IDENTITY_EXEMPT_PINNED to 2'),
    ]);
  });

  it('fails on a portable pattern rule, whose tables it cannot enumerate', () => {
    const registry = {
      ...REGISTRY,
      patterns: [{ match: '^x_.+$', class: 'portable-project', reason: 'fixture' }],
    };
    const problems = scopeProblems({ registry, declared: [{ table: 'a' }], exempt: { b: WHY } });
    expect(kinds(problems)).toEqual(['pattern:']);
  });
});

describe('the repository', () => {
  it('summarises exemptions consistently with the pin', () => {
    for (const scope of ['project', 'global']) {
      const summary = rowIdentityExemptionSummary(scope);
      expect(summary.total).toBe(ROW_IDENTITY_EXEMPT_PINNED[scope]);
      const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
      expect(sum(summary.byCategory)).toBe(summary.total);
      expect(sum(summary.byTask)).toBe(summary.total);
    }
  });

  it('passes the gate', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: REPO, encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('every syncing table is declared or exempt');
  });
});
