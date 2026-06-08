/**
 * Tests for scripts/lint-output-contract-coverage.mjs (T11762 ST-3b · T11904 · DHQ-057).
 *
 * The gate is a deterministic static scan that enumerates the OPERATIONS
 * registry and asserts every op resolves an output contract under the
 * `getOutputContract` resolution tiers (hand-authored → derived → generic
 * fallback). These tests exercise the parser + classifier against synthetic
 * registry fixtures, then assert the real repo tree is fully covered.
 *
 * @task T11904
 * @epic T11679
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countOperationEntries,
  parseOperations,
  scanUncovered,
} from '../lint-output-contract-coverage.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Minimal synthetic operations-registry.ts fixture body. */
const REGISTRY_FIXTURE = `export const OPERATIONS = [
  { gateway: 'query', domain: 'tasks', operation: 'show', tier: 0 },
  { gateway: 'mutate', domain: 'tasks', operation: 'add', tier: 1 },
  { gateway: 'query', domain: 'sessions', operation: 'status', tier: 0 },
];`;

const OUTPUT_CONTRACTS_FIXTURE = `export const OUTPUT_CONTRACTS = {
  'tasks.show': { operation: 'tasks.show' },
};`;
const RESULT_SCHEMAS_FIXTURE = `export const OPERATION_RESULT_SCHEMAS = new Map([
  ['tasks.tree', someSchema],
]);`;
const PROJECTION_PLANS_FIXTURE = `export const PROJECTION_PLANS = {
  'tasks.show': { path: 'task', list: false },
};`;

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-output-coverage-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a file at a repo-relative path under the synthetic root. */
function writeFile(rel, content) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

/** Lay down the four registry source files the scan reads. */
function seedRegistry(overrides = {}) {
  writeFile(
    'packages/contracts/src/dispatch/operations-registry.ts',
    overrides.registry ?? REGISTRY_FIXTURE,
  );
  writeFile(
    'packages/contracts/src/operations/output-contracts-data.ts',
    overrides.outputContracts ?? OUTPUT_CONTRACTS_FIXTURE,
  );
  writeFile(
    'packages/contracts/src/operation-envelope-validation.ts',
    overrides.resultSchemas ?? RESULT_SCHEMAS_FIXTURE,
  );
  writeFile(
    'packages/core/src/dispatch/mvi-projection.ts',
    overrides.projectionPlans ?? PROJECTION_PLANS_FIXTURE,
  );
}

describe('parseOperations', () => {
  it('recovers (key, gateway) for every entry in order', () => {
    expect(parseOperations(REGISTRY_FIXTURE)).toEqual([
      { key: 'tasks.show', gateway: 'query' },
      { key: 'tasks.add', gateway: 'mutate' },
      { key: 'sessions.status', gateway: 'query' },
    ]);
  });

  it('returns [] for source with no operations', () => {
    expect(parseOperations('export const X = 1;')).toEqual([]);
  });
});

describe('countOperationEntries', () => {
  it("counts one per `operation: '...'` entry", () => {
    expect(countOperationEntries(REGISTRY_FIXTURE)).toBe(3);
  });

  it('counts only `operation:` properties assigned a quoted string (ignores prose/type refs)', () => {
    const src = `// the operation: field is documented here\nconst x = { operation: 'real' };`;
    // The comment text `operation:` has no following quoted string, and a type
    // ref like `operation: string` is not quoted — only the quoted property
    // assignment counts. This matches the triple regex's third capture group.
    expect(countOperationEntries("  operation: 'a'\n  operation: 'b'\n")).toBe(2);
    expect(countOperationEntries(src)).toBe(1);
    expect(countOperationEntries('interface Op { operation: string }')).toBe(0);
  });
});

describe('scanUncovered', () => {
  it('reports 100% coverage for a well-formed registry (no uncovered, no drift)', () => {
    seedRegistry();
    const { uncovered, total, covered, registryCount, parseDrift } = scanUncovered(root);
    expect(parseDrift).toBeNull();
    expect(total).toBe(3);
    expect(registryCount).toBe(3);
    expect(covered).toBe(3);
    expect(uncovered).toEqual([]);
  });

  it('covers a mutate op via the shared minimal-mutate contract', () => {
    seedRegistry({
      registry: `export const OPERATIONS = [
        { gateway: 'mutate', domain: 'docs', operation: 'publish' },
      ];`,
      outputContracts: 'export const OUTPUT_CONTRACTS = {};',
      resultSchemas: 'export const OPERATION_RESULT_SCHEMAS = new Map([]);',
      projectionPlans: 'export const PROJECTION_PLANS = {};',
    });
    const { uncovered, parseDrift } = scanUncovered(root);
    expect(parseDrift).toBeNull();
    expect(uncovered).toEqual([]);
  });

  it('covers a query op via the generic object fallback', () => {
    seedRegistry({
      registry: `export const OPERATIONS = [
        { gateway: 'query', domain: 'nexus', operation: 'report' },
      ];`,
      outputContracts: 'export const OUTPUT_CONTRACTS = {};',
      resultSchemas: 'export const OPERATION_RESULT_SCHEMAS = new Map([]);',
      projectionPlans: 'export const PROJECTION_PLANS = {};',
    });
    const { uncovered, parseDrift } = scanUncovered(root);
    expect(parseDrift).toBeNull();
    expect(uncovered).toEqual([]);
  });

  it('flags PARSE DRIFT when an entry has a non-(query|mutate) gateway (triple regex skips it)', () => {
    // A gateway value the ordered triple regex does not match (e.g. a future
    // 'stream' gateway) is skipped by parseOperations but still counted by
    // countOperationEntries → the gate must fail closed rather than report 100%.
    seedRegistry({
      registry: `export const OPERATIONS = [
        { gateway: 'query', domain: 'tasks', operation: 'show' },
        { gateway: 'stream', domain: 'tasks', operation: 'watch' },
      ];`,
    });
    const { parseDrift } = scanUncovered(root);
    expect(parseDrift).not.toBeNull();
    expect(parseDrift).toContain('parse drift');
  });
});

describe('real repository tree', () => {
  it('resolves a contract for EVERY registered operation (zero uncovered, zero drift)', () => {
    const { uncovered, total, covered, registryCount, parseDrift } = scanUncovered(REPO_ROOT);
    expect(parseDrift, parseDrift ?? undefined).toBeNull();
    // The triple parse and the authoritative entry count agree.
    expect(total).toBe(registryCount);
    // 100% coverage by design (every registered op resolves a contract).
    expect(uncovered).toEqual([]);
    expect(covered).toBe(total);
    // Sanity floor: the registry is large; guards against a parse that recovers
    // a trivially-small set and still "passes".
    expect(total).toBeGreaterThan(300);
  });
});
