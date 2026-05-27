/**
 * SG- display preservation at the data layer — Saga T10326 W3.B / T10333.
 *
 * Proves that `buildGenericTaskTree` produces a `TreeNodeKind` of `'saga'`
 * for BOTH saga storage shapes during the deprecation window:
 *
 *   - **Canonical post-migration shape**: `type: 'saga'`, no `'saga'` label.
 *   - **Legacy label-encoded shape**:     `type: 'epic'`, `labels: ['saga']`.
 *
 * The display-prefix derivation is **type-based** by construction —
 * `toTreeKind` consults `isSagaShape`
 * (`packages/core/src/sagas/enforcement.ts`) to map either shape to the
 * canonical `'saga'` discriminator. All downstream renderers (focus
 * envelope, briefing roll-up, list pipe, generic tree) consume the typed
 * `kind` field and never re-inspect `task.type` or `task.labels`. This
 * test pins that invariant at the data-layer boundary, complementing the
 * renderer-level snapshot at
 * `packages/cleo/src/cli/renderers/__tests__/sg-display-preservation.test.ts`.
 *
 * Mandate: ADR-073 §4 (amended 2026-05-23) + ADR-083 §2.5 + ADR-083 §2.6.
 *
 * @task T10333
 * @saga T10326
 * @see .cleo/adrs/ADR-073-above-epic-naming.md §4
 * @see .cleo/adrs/ADR-083-cleo-persona-and-hierarchy-reconciliation.md §2.5
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SAGA_GROUPS_RELATION } from '../../sagas/constants.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { buildGenericTaskTree } from '../generic-tree.js';

let env: TestDbEnv;

beforeEach(async () => {
  env = await createTestDb();
});

afterEach(async () => {
  await env.cleanup();
});

/**
 * Seed a saga + 2 member-epics using the **canonical post-migration shape**
 * (`type: 'saga'`).
 */
async function seedCanonicalSaga(): Promise<void> {
  await seedTasks(env.accessor, [
    {
      id: 'SG-CAN',
      title: 'Canonical saga',
      type: 'saga',
      status: 'pending',
      priority: 'high',
    },
    {
      id: 'E-CAN-01',
      title: 'Member Epic 01',
      type: 'epic',
      status: 'pending',
      priority: 'medium',
    },
    {
      id: 'E-CAN-02',
      title: 'Member Epic 02',
      type: 'epic',
      status: 'pending',
      priority: 'medium',
    },
  ]);

  await env.accessor.addRelation('SG-CAN', 'E-CAN-01', SAGA_GROUPS_RELATION);
  await env.accessor.addRelation('SG-CAN', 'E-CAN-02', SAGA_GROUPS_RELATION);
}

/**
 * Seed a structurally-identical saga using the **legacy label-encoded shape**
 * (`type: 'epic'`, `labels: ['saga']`). Tests the deprecation-window dual
 * acceptance.
 */
async function seedLegacySaga(): Promise<void> {
  await seedTasks(env.accessor, [
    {
      id: 'SG-LEG',
      title: 'Legacy saga',
      type: 'epic',
      status: 'pending',
      priority: 'high',
      labels: ['saga'],
    },
    {
      id: 'E-LEG-01',
      title: 'Member Epic 01',
      type: 'epic',
      status: 'pending',
      priority: 'medium',
    },
    {
      id: 'E-LEG-02',
      title: 'Member Epic 02',
      type: 'epic',
      status: 'pending',
      priority: 'medium',
    },
  ]);

  await env.accessor.addRelation('SG-LEG', 'E-LEG-01', SAGA_GROUPS_RELATION);
  await env.accessor.addRelation('SG-LEG', 'E-LEG-02', SAGA_GROUPS_RELATION);
}

describe('SG- display preservation at toTreeKind boundary (T10333)', () => {
  it('canonical saga shape (type=saga) yields kind=saga', async () => {
    await seedCanonicalSaga();

    const result = await buildGenericTaskTree(env.tempDir, 'SG-CAN');
    const root = result.tree.tree[0];

    expect(root?.id).toBe('SG-CAN');
    expect(root?.kind).toBe('saga');
    expect(root?.title).toBe('Canonical saga');
    expect(root?.metadata.edgeType).toBe('root');
  });

  it('legacy saga shape (type=epic + label=saga) also yields kind=saga', async () => {
    await seedLegacySaga();

    const result = await buildGenericTaskTree(env.tempDir, 'SG-LEG');
    const root = result.tree.tree[0];

    expect(root?.id).toBe('SG-LEG');
    expect(root?.kind).toBe('saga');
    expect(root?.title).toBe('Legacy saga');
    expect(root?.metadata.edgeType).toBe('root');
  });

  it('both shapes produce identical TreeNodeKind discriminators across the entire tree', async () => {
    await seedCanonicalSaga();
    await seedLegacySaga();

    const canonical = await buildGenericTaskTree(env.tempDir, 'SG-CAN');
    const legacy = await buildGenericTaskTree(env.tempDir, 'SG-LEG');

    // Same shape, same node count, same kind/status/depth/edgeType per row.
    expect(legacy.tree.totalNodes).toBe(canonical.tree.totalNodes);
    expect(legacy.tree.maxDepth).toBe(canonical.tree.maxDepth);

    const canonicalKinds = canonical.tree.tree.map((n) => n.kind);
    const legacyKinds = legacy.tree.tree.map((n) => n.kind);
    expect(legacyKinds).toEqual(canonicalKinds);

    // Both root nodes are kind=saga; both 2 member epics are kind=epic.
    expect(canonicalKinds).toEqual(['saga', 'epic', 'epic']);
    expect(legacyKinds).toEqual(['saga', 'epic', 'epic']);
  });

  it('member-epic walk produces identical edge metadata across shapes', async () => {
    await seedCanonicalSaga();
    await seedLegacySaga();

    const canonical = await buildGenericTaskTree(env.tempDir, 'SG-CAN');
    const legacy = await buildGenericTaskTree(env.tempDir, 'SG-LEG');

    const canonicalEdges = canonical.tree.tree.map((n) => n.metadata.edgeType);
    const legacyEdges = legacy.tree.tree.map((n) => n.metadata.edgeType);
    expect(legacyEdges).toEqual(canonicalEdges);
    expect(canonicalEdges).toEqual(['root', 'groups', 'groups']);
  });

  it('a saga ID without the SG- display prefix still receives kind=saga', async () => {
    // ADR-073 §1.2 I2: the SG- prefix is display + import only. Storage IDs
    // are bare `T####`. Verify a bare-ID saga still gets the saga
    // discriminator via type-based dispatch.
    await seedTasks(env.accessor, [
      {
        id: 'T19518',
        title: 'Bare-ID saga',
        type: 'saga',
        status: 'pending',
        priority: 'high',
      },
    ]);

    const result = await buildGenericTaskTree(env.tempDir, 'T19518');
    const root = result.tree.tree[0];

    expect(root?.id).toBe('T19518');
    expect(root?.kind).toBe('saga');
  });
});
