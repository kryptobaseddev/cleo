/**
 * SG- display preservation at the data layer — Saga T10326 W3.B / T10333.
 *
 * Proves that `buildGenericTaskTree` produces a `TreeNodeKind` of `'saga'`
 * for the canonical first-class saga storage shape (`type: 'saga'`).
 *
 * T10638 (PM-Core V2) removed the deprecation-window dual acceptance:
 * `isSagaShape` (`packages/core/src/sagas/enforcement.ts`) now keys SOLELY on
 * `type === 'saga'`. The legacy label-encoded shape (`type: 'epic'`,
 * `labels: ['saga']`) is therefore NO LONGER recognized as a saga — it renders
 * as a plain epic. This test pins both the canonical-saga invariant AND the
 * intentional retirement of the label-encoded shape at the data-layer
 * boundary.
 *
 * The display-prefix derivation is **type-based** by construction —
 * `toTreeKind` consults `isSagaShape`. All downstream renderers (focus
 * envelope, briefing roll-up, list pipe, generic tree) consume the typed
 * `kind` field and never re-inspect `task.type` or `task.labels`.
 *
 * Mandate: ADR-073 §4 (amended 2026-05-23) + ADR-083 §2.5 + ADR-083 §2.6;
 * label-shape retirement per T10638.
 *
 * @task T10333
 * @task T10638
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
 * Seed a structurally-identical tree using the **retired legacy label-encoded
 * shape** (`type: 'epic'`, `labels: ['saga']`). Post-T10638 this is NO LONGER
 * recognized as a saga — it renders as a plain epic. Used to assert the
 * retirement, not dual acceptance.
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

  it('retired legacy label shape (type=epic + label=saga) is NO LONGER a saga (T10638)', async () => {
    await seedLegacySaga();

    const result = await buildGenericTaskTree(env.tempDir, 'SG-LEG');
    const root = result.tree.tree[0];

    expect(root?.id).toBe('SG-LEG');
    // T10638 retired the label-encoded shape: isSagaShape keys solely on
    // type==='saga', so a type=epic node renders as a plain epic.
    expect(root?.kind).toBe('epic');
    expect(root?.title).toBe('Legacy saga');
    expect(root?.metadata.edgeType).toBe('root');
  });

  it('canonical saga is kind=saga while the retired label shape is kind=epic (T10638)', async () => {
    await seedCanonicalSaga();
    await seedLegacySaga();

    const canonical = await buildGenericTaskTree(env.tempDir, 'SG-CAN');
    const legacy = await buildGenericTaskTree(env.tempDir, 'SG-LEG');

    // Same structural shape (node count + depth) across both fixtures.
    expect(legacy.tree.totalNodes).toBe(canonical.tree.totalNodes);
    expect(legacy.tree.maxDepth).toBe(canonical.tree.maxDepth);

    const canonicalKinds = canonical.tree.tree.map((n) => n.kind);
    const legacyKinds = legacy.tree.tree.map((n) => n.kind);

    // Canonical root is kind=saga; the retired label shape's root is a plain
    // epic (only the root kind differs — both have 2 member epics).
    expect(canonicalKinds).toEqual(['saga', 'epic', 'epic']);
    expect(legacyKinds).toEqual(['epic', 'epic', 'epic']);
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
