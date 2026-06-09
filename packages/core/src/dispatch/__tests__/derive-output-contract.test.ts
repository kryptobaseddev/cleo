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
import { MUTATE_PROJECTION_PLANS } from '../mutate-projection.js';

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

    it('derives a path-rooted list contract for docs.list with the doc-kind /slug pointer (NOT /title)', () => {
      // docs.list plan = { path: 'attachments', kind: 'doc', list: true }.
      // Doc records have NO `title` — their handle is `slug` (AttachmentMetadata
      // + the doc MVI field-set expose slug/description, never title). The
      // secondary pointer MUST be /slug, else `--field …/title` is E_FIELD_NOT_FOUND.
      const contract = deriveOutputContract('docs.list');
      expect(contract).not.toBeNull();
      expect(contract?.fieldPointers).toContain('/data/attachments/0/id');
      expect(contract?.fieldPointers).toContain('/data/attachments/0/slug');
      expect(contract?.fieldPointers).not.toContain('/data/attachments/0/title');
    });

    it('derives the doc-kind /slug single-record pointer for docs.fetch (NOT /title)', () => {
      // docs.fetch plan = { path: 'metadata', kind: 'doc', list: false }.
      const contract = deriveOutputContract('docs.fetch');
      expect(contract).not.toBeNull();
      expect(contract?.fieldPointers).toContain('/data/metadata/id');
      expect(contract?.fieldPointers).toContain('/data/metadata/slug');
      expect(contract?.fieldPointers).not.toContain('/data/metadata/title');
    });

    it('keeps the task-kind /title pointer for task projection plans', () => {
      // tasks.list plan = { path: 'tasks', kind: 'task', list: true } — tasks
      // DO have a title, so the secondary pointer stays /title for task kinds.
      const contract = deriveOutputContract('tasks.list');
      expect(contract).not.toBeNull();
      expect(contract?.fieldPointers).toContain('/data/tasks/0/id');
      expect(contract?.fieldPointers).toContain('/data/tasks/0/title');
      expect(contract?.fieldPointers).not.toContain('/data/tasks/0/slug');
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

    it('derives the minimal-mutate envelope ONLY for the planned mutate ops', () => {
      // Exactly the 6 ops in MUTATE_PROJECTION_PLANS are rewritten into the
      // {count, created[], updated[], deleted[]} envelope by the dispatch
      // middleware. Each MUST advertise the /data/created/0 pointer.
      const plannedMutateKeys = Object.keys(MUTATE_PROJECTION_PLANS);
      expect(plannedMutateKeys.length).toBe(6);
      for (const key of plannedMutateKeys) {
        const contract = deriveOutputContract(key);
        expect(contract, `expected a planned-mutate contract for ${key}`).not.toBeNull();
        expect(contract?.fieldPointers, key).toContain('/data/count');
        expect(contract?.fieldPointers, key).toContain('/data/created/0');
      }
    });

    it('does NOT advertise minimal-mutate pointers for UNPLANNED mutate ops', () => {
      // An unplanned gateway=mutate op (e.g. memory.observe, docs.add,
      // release.plan) returns its own domain payload untouched — the dispatch
      // middleware short-circuits via `if (!hasPlan) return response`. Deriving
      // /data/created/0 for it would steer agents at a pointer that resolves
      // nothing, perpetuating the DHQ-057 --field remediation loop.
      const plannedMutateKeys = new Set(Object.keys(MUTATE_PROJECTION_PLANS));
      const unplannedMutateOps = OPERATIONS.filter(
        (op) => op.gateway === 'mutate' && !plannedMutateKeys.has(`${op.domain}.${op.operation}`),
      );
      expect(unplannedMutateOps.length).toBeGreaterThan(0);
      for (const op of unplannedMutateOps) {
        const key = `${op.domain}.${op.operation}`;
        const contract = deriveOutputContract(key);
        // Still non-null (generic object contract — coverage stays high)…
        expect(contract, `expected a generic contract for ${key}`).not.toBeNull();
        // …but it must NOT claim the minimal-mutate pointers.
        expect(contract?.fieldPointers, key).not.toContain('/data/created/0');
        expect(contract?.fieldPointers, key).not.toContain('/data/updated/0');
        expect(contract?.fieldPointers, key).not.toContain('/data/deleted/0');
        // Generic object contracts carry no specific --field pointers.
        expect(contract?.fieldPointers, key).toEqual([]);
        expect(contract?.dataSchema['type'], key).toBe('object');
      }
    });

    it('still resolves a non-null contract for EVERY gateway=mutate op (planned or not)', () => {
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
      // The derived path must cover the large majority of the 412-op registry.
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
