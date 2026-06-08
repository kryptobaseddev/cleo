/**
 * Tests for T11762 ST-3 — generic per-op OUTPUT contract derivation (DHQ-057
 * coverage half).
 *
 * Asserts that {@link deriveOutputContract} synthesises a usable contract for:
 *   - a workgraph read op (precise top-level keys from OPERATION_RESULT_SCHEMAS),
 *   - a projection-plan read op (path-rooted pointers),
 *   - a mutate op (the shared minimal-mutate envelope),
 *   - a generic registered query op (object contract, no pointers),
 * and that a genuinely-unknown op resolves `null` (never throws). Also asserts
 * the coverage invariant: the derived path resolves a contract for the large
 * majority of {@link OPERATIONS}, and that {@link getOutputContract} keeps the
 * hand-authored contracts authoritative while delegating to the derived path.
 *
 * @task T11762 ST-3
 * @epic T11679
 */

import { OPERATIONS, OUTPUT_CONTRACTS } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { deriveOutputContract } from '../contracts/derive-output-contract.js';
import { getOutputContract } from '../contracts/output-contracts.js';

describe('deriveOutputContract — per-op output contract derivation (T11762 ST-3)', () => {
  describe('workgraph read op (OPERATION_RESULT_SCHEMAS)', () => {
    it('derives a precise key-rooted contract for tasks.tree', () => {
      const contract = deriveOutputContract('tasks.tree');
      expect(contract).not.toBeNull();
      expect(contract?.operation).toBe('tasks.tree');
      // tasksTreeResultSchema top-level keys: rootId, nodes, edges, pageInfo.
      expect(contract?.fieldPointers).toContain('/data/rootId');
      expect(contract?.fieldPointers).toContain('/data/nodes');
      expect(contract?.fieldPointers).toContain('/data/edges');
      expect(contract?.dataSchema['type']).toBe('object');
      const required = contract?.dataSchema['required'] as string[];
      expect(required).toContain('rootId');
      expect(required).toContain('nodes');
    });

    it('derives a contract for the multi-segment op key tasks.workgraph.audit', () => {
      const contract = deriveOutputContract('tasks.workgraph.audit');
      expect(contract).not.toBeNull();
      expect(contract?.operation).toBe('tasks.workgraph.audit');
      // top-level keys include rootId + hierarchy + traversal + frontier + rollup.
      expect(contract?.fieldPointers).toContain('/data/rootId');
      expect(contract?.fieldPointers).toContain('/data/hierarchy');
    });
  });

  describe('projection-plan read op (PROJECTION_PLANS)', () => {
    it('derives a path-rooted single-record contract for tasks.show', () => {
      // tasks.show plan = { path: 'task', kind: 'task', list: false }.
      const contract = deriveOutputContract('tasks.show');
      expect(contract).not.toBeNull();
      expect(contract?.operation).toBe('tasks.show');
      expect(contract?.fieldPointers).toContain('/data/task/id');
      expect(contract?.fieldPointers).toContain('/data/task/title');
      const props = contract?.dataSchema['properties'] as Record<string, unknown>;
      expect(props['task']).toBeDefined();
    });

    it('derives a path-rooted list contract for docs.list', () => {
      // docs.list plan = { path: 'attachments', kind: 'doc', list: true }.
      const contract = deriveOutputContract('docs.list');
      expect(contract).not.toBeNull();
      expect(contract?.fieldPointers).toContain('/data/attachments/0/id');
      expect(contract?.fieldPointers).toContain('/data/attachments/0/title');
    });
  });

  describe('mutate op (MinimalMutateEnvelope)', () => {
    it('derives the shared minimal-mutate envelope for tasks.add', () => {
      const contract = deriveOutputContract('tasks.add');
      expect(contract).not.toBeNull();
      expect(contract?.operation).toBe('tasks.add');
      expect(contract?.fieldPointers).toContain('/data/created/0');
      expect(contract?.fieldPointers).toContain('/data/count');
      const required = contract?.dataSchema['required'] as string[];
      expect(required).toEqual(expect.arrayContaining(['count', 'created', 'updated', 'deleted']));
    });

    it('derives a mutate contract for every gateway=mutate op', () => {
      const mutateOps = OPERATIONS.filter((op) => op.gateway === 'mutate');
      expect(mutateOps.length).toBeGreaterThan(0);
      for (const op of mutateOps) {
        const key = `${op.domain}.${op.operation}`;
        const contract = deriveOutputContract(key);
        expect(contract, `expected a derived contract for ${key}`).not.toBeNull();
      }
    });
  });

  describe('generic registered query op', () => {
    it('derives a generic object contract for a query op without a plan/schema', () => {
      // Pick a registered query op that is NOT in PROJECTION_PLANS,
      // OPERATION_RESULT_SCHEMAS, or OUTPUT_CONTRACTS.
      const special = new Set([
        'tasks.show',
        'tasks.list',
        'tasks.find',
        'docs.list',
        'docs.fetch',
        'tasks.traverse',
        'tasks.tree',
        'tasks.rollup',
        'tasks.frontier',
        'tasks.workgraph.audit',
      ]);
      const genericQuery = OPERATIONS.find(
        (op) => op.gateway === 'query' && !special.has(`${op.domain}.${op.operation}`),
      );
      expect(genericQuery, 'expected at least one plain query op').toBeDefined();
      const key = `${genericQuery?.domain}.${genericQuery?.operation}`;
      const contract = deriveOutputContract(key);
      expect(contract).not.toBeNull();
      expect(contract?.operation).toBe(key);
      expect(contract?.dataSchema['type']).toBe('object');
      // Generic contracts intentionally carry no specific --field pointers.
      expect(contract?.fieldPointers).toEqual([]);
    });
  });

  describe('genuinely-missing op', () => {
    it('returns null (not error) for an unregistered op', () => {
      expect(deriveOutputContract('does.not-exist')).toBeNull();
      expect(deriveOutputContract('totally-bogus')).toBeNull();
      expect(deriveOutputContract('')).toBeNull();
    });
  });

  describe('coverage invariant', () => {
    it('resolves a derived contract for the large majority of OPERATIONS', () => {
      let resolved = 0;
      for (const op of OPERATIONS) {
        const key = `${op.domain}.${op.operation}`;
        if (deriveOutputContract(key) !== null) resolved += 1;
      }
      const ratio = resolved / OPERATIONS.length;
      // The derived path must cover the large majority of the 411-op registry.
      expect(ratio).toBeGreaterThan(0.9);
    });
  });
});

describe('getOutputContract — hand-authored → derived → null (T11762 ST-3)', () => {
  it('keeps the hand-authored contract authoritative for tasks.show', () => {
    const handAuthored = OUTPUT_CONTRACTS['tasks.show'];
    const resolved = getOutputContract('tasks.show');
    expect(resolved).toBe(handAuthored);
    // hand-authored tasks.show includes priority/type pointers the derived
    // path does not synthesise — proves precedence.
    expect(resolved?.fieldPointers).toContain('/data/task/priority');
  });

  it('falls through to the derived contract for an op without a hand-authored entry', () => {
    // tasks.tree has NO hand-authored entry but IS derivable.
    expect(OUTPUT_CONTRACTS['tasks.tree']).toBeUndefined();
    const resolved = getOutputContract('tasks.tree');
    expect(resolved).not.toBeNull();
    expect(resolved?.operation).toBe('tasks.tree');
    expect(resolved?.fieldPointers).toContain('/data/nodes');
  });

  it('returns null for a genuinely-unknown op', () => {
    expect(getOutputContract('nope.nope')).toBeNull();
  });
});
