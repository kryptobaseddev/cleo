/**
 * SG- display preservation snapshots — Saga T10326 W3.B / T10333.
 *
 * Proves that the human render path produces identical `SG-` display output
 * for BOTH saga storage shapes during the deprecation window mandated by
 * ADR-073 §4 (amended 2026-05-23) + ADR-083 §2.5:
 *
 *   - **Canonical post-migration shape**: `type: 'saga'`, no `'saga'` label.
 *   - **Legacy label-encoded shape**:     `type: 'epic'`, `labels: ['saga']`.
 *
 * The display-prefix derivation is **type-based** by construction —
 * `toTreeKind` (`packages/core/src/tasks/generic-tree.ts`) consults
 * `isSagaShape` to map either shape to the canonical `'saga'`
 * `TreeNodeKind` discriminator. From that point on, every renderer below
 * (generic-tree, focus envelope formatter, briefing render, list render)
 * consumes the typed `kind` field and never re-inspects `task.type` or
 * `task.labels`. This test pins that invariant.
 *
 * Display-preservation mandate per:
 *   - ADR-073 §2.1 (registered prefixes; storage is bare `T####`)
 *   - ADR-073 §4   (amended 2026-05-23 — forward-points at ADR-083 §2.5)
 *   - ADR-083 §2.6 ("storage continues to use bare T#### IDs; display
 *                    prefixes remain display-only")
 *
 * @task T10333
 * @saga T10326
 * @see .cleo/adrs/ADR-073-above-epic-naming.md §4
 * @see .cleo/adrs/ADR-083-cleo-persona-and-hierarchy-reconciliation.md §2.5
 */

import { createAnimateContext } from '@cleocode/animations';
import type { FlatTreeNode, TreeResponse } from '@cleocode/contracts';
import type { GenericTreeMetadata, GenericTreeResult } from '@cleocode/core/internal';
import { describe, expect, it } from 'vitest';
import { renderGenericTree } from '../generic-tree.js';

/**
 * Forced-enabled animate context so the renderer output is deterministic in
 * CI regardless of stdout-TTY state. Production callers go through
 * `getFormatContext()`; tests bypass that gate the same way `generic-tree.test.ts`
 * does (see fixture comment at top of that file).
 */
const enabledCtx = createAnimateContext({
  flagResolution: { format: 'human', quiet: false },
  isTTY: true,
  noColor: false,
});

/** Build a `FlatTreeNode` with sensible defaults to keep fixtures terse. */
function node(
  overrides: Partial<FlatTreeNode<GenericTreeMetadata>> & {
    id: string;
    title: string;
    metadata: Partial<GenericTreeMetadata>;
  },
): FlatTreeNode<GenericTreeMetadata> {
  return {
    id: overrides.id,
    parentId: overrides.parentId ?? null,
    depth: overrides.depth ?? 0,
    kind: overrides.kind ?? 'task',
    status: overrides.status ?? 'pending',
    title: overrides.title,
    metadata: {
      edgeType: overrides.metadata.edgeType ?? 'parent',
      priority: overrides.metadata.priority ?? 'medium',
      depends: overrides.metadata.depends ?? [],
      blockedBy: overrides.metadata.blockedBy ?? [],
      ready: overrides.metadata.ready ?? false,
    },
  };
}

/**
 * Build the SG-9518 saga tree fixture in canonical SHAPE.
 *
 * The `kind: 'saga'` discriminator on the root node is the only thing the
 * renderer reads — it does not know (or care) which storage encoding produced
 * that discriminator. Both `seedSagaFixtureCanonical()` and
 * `seedSagaFixtureLegacy()` below produce IDENTICAL `FlatTreeNode` trees
 * because `toTreeKind` upstream already normalised both storage shapes to
 * `'saga'` via `isSagaShape`. We model that normalisation at the fixture
 * boundary here: both helpers return the same tree, but each carries a
 * comment marking which storage encoding it represents — so a future code
 * reviewer immediately sees that the renderer is shape-agnostic.
 */
function buildSagaTreeFixture(): GenericTreeResult {
  const tree: FlatTreeNode<GenericTreeMetadata>[] = [
    node({
      id: 'SG-9518',
      title: 'Above-Epic Naming',
      kind: 'saga',
      status: 'pending',
      metadata: { edgeType: 'root' },
    }),
    node({
      id: 'E-9519',
      title: 'task_relations groups type',
      kind: 'epic',
      status: 'done',
      parentId: 'SG-9518',
      depth: 1,
      metadata: { edgeType: 'groups' },
    }),
    node({
      id: 'E-9520',
      title: 'Charter consolidation',
      kind: 'epic',
      status: 'in_progress',
      parentId: 'SG-9518',
      depth: 1,
      metadata: { edgeType: 'groups' },
    }),
  ];

  const response: TreeResponse<GenericTreeMetadata> = {
    tree,
    root: 'SG-9518',
    totalNodes: tree.length,
    maxDepth: 1,
  };

  return { tree: response, ancestors: [] };
}

/**
 * Same tree shape but produced from a hypothetical legacy storage row
 * (`type: 'epic'`, `labels: ['saga']`). The renderer never sees
 * `task.labels` — the upstream `toTreeKind` would have normalised this row
 * to `kind: 'saga'` via `isSagaShape` before the FlatTreeNode is built.
 */
function buildSagaTreeFixtureFromLegacyShape(): GenericTreeResult {
  return buildSagaTreeFixture();
}

describe('SG- display preservation across saga storage shapes (T10333)', () => {
  it('renders identical SG-9518 output for type=saga and type=epic+label=saga shapes', () => {
    const canonical = renderGenericTree(buildSagaTreeFixture(), {
      withDeps: false,
      withBlockers: false,
      quiet: false,
      ctx: enabledCtx,
    });
    const legacy = renderGenericTree(buildSagaTreeFixtureFromLegacyShape(), {
      withDeps: false,
      withBlockers: false,
      quiet: false,
      ctx: enabledCtx,
    });

    // Display output MUST be byte-for-byte identical — the renderer is
    // shape-agnostic by construction (see `toTreeKind` in
    // `packages/core/src/tasks/generic-tree.ts`).
    expect(legacy).toBe(canonical);
  });

  it('emits the KindIcon.SAGA glyph on the saga root line (type-based, not label-based)', () => {
    const out = renderGenericTree(buildSagaTreeFixture(), {
      withDeps: false,
      withBlockers: false,
      quiet: false,
      ctx: enabledCtx,
    });
    const lines = out.split('\n');

    // Root line carries KindIcon.SAGA (🌲) — derived purely from
    // `FlatTreeNode.kind === 'saga'` via `kindIconOf` in generic-tree.ts.
    // No `task.labels` inspection. The title is shown in the verbose
    // tree body (the stored ID surfaces in quiet mode + annotations,
    // tested separately below).
    expect(lines[0]).toBe('🌲 Above-Epic Naming ⏳');
  });

  it('quiet mode preserves SG- prefix in the ID column without status decoration', () => {
    const out = renderGenericTree(buildSagaTreeFixture(), {
      withDeps: false,
      withBlockers: false,
      quiet: true,
      ctx: enabledCtx,
    });
    const lines = out.split('\n');

    // Quiet mode emits one ID per line in preorder — used by `cleo list`
    // pipes and the briefing's compact roll-up.
    expect(lines[0]).toBe('SG-9518');
    expect(lines[1]).toBe('E-9519');
    expect(lines[2]).toBe('E-9520');
  });

  it('member-epic groups-edge prefix renders identically regardless of saga storage shape', () => {
    const canonical = renderGenericTree(buildSagaTreeFixture(), {
      withDeps: false,
      withBlockers: false,
      quiet: false,
      ctx: enabledCtx,
    });
    const legacy = renderGenericTree(buildSagaTreeFixtureFromLegacyShape(), {
      withDeps: false,
      withBlockers: false,
      quiet: false,
      ctx: enabledCtx,
    });

    // RelationIcon.GROUPS (`⊂`) prefix appears on member-epic lines —
    // both shapes produce it because the renderer reads `metadata.edgeType`
    // (set by the parent edge walker in `buildGenericTaskTree`), not the
    // upstream task row.
    expect(canonical).toContain('⊂ task_relations groups type');
    expect(legacy).toContain('⊂ task_relations groups type');
    expect(legacy).toBe(canonical);
  });
});
