/**
 * Barrel-export smoke tests for the Task Explorer shelf.
 *
 * Guarantees the public surface of `packages/studio/src/lib/components/tasks/`
 * does not silently regress — downstream waves (T952 store, T953 Hierarchy,
 * T954 Graph, T955 Kanban) all import from this barrel.
 *
 * Svelte component modules cannot be *mounted* in this package (vitest is
 * configured with `environment: 'node'` — see `vitest.config.ts`), but we
 * CAN import their default exports + named type re-exports to assert the
 * module graph compiles, the barrel is complete, and there are no cyclic
 * imports.
 *
 * @task T950
 * @epic T949
 */

import { describe, expect, it } from 'vitest';
import * as shelf from '../index.js';

describe('task explorer barrel', () => {
  it('exports every required component', () => {
    expect(shelf.StatusBadge).toBeDefined();
    expect(shelf.PriorityBadge).toBeDefined();
    expect(shelf.TaskCard).toBeDefined();
    expect(shelf.EpicProgressCard).toBeDefined();
    expect(shelf.RecentActivityFeed).toBeDefined();
    expect(shelf.FilterChipGroup).toBeDefined();
    expect(shelf.TaskSearchBox).toBeDefined();
    expect(shelf.DetailDrawer).toBeDefined();
  });

  it('exports every required format helper', () => {
    expect(shelf.statusIcon).toBeTypeOf('function');
    expect(shelf.statusClass).toBeTypeOf('function');
    expect(shelf.priorityClass).toBeTypeOf('function');
    expect(shelf.gatesFromJson).toBeTypeOf('function');
    expect(shelf.formatTime).toBeTypeOf('function');
    expect(shelf.progressPct).toBeTypeOf('function');
  });

  it('component exports are Svelte component constructors', () => {
    // Svelte 5 components compile to objects/classes with `render`, `$$render`,
    // or a plain function symbol. The only invariant we can assert here
    // (without mounting) is that they are truthy callables or objects —
    // i.e. the barrel is not accidentally exporting `undefined`.
    const components = [
      shelf.StatusBadge,
      shelf.PriorityBadge,
      shelf.TaskCard,
      shelf.EpicProgressCard,
      shelf.RecentActivityFeed,
      shelf.FilterChipGroup,
      shelf.TaskSearchBox,
      shelf.DetailDrawer,
    ];
    for (const c of components) {
      expect(c).toBeTruthy();
      expect(['function', 'object']).toContain(typeof c);
    }
  });
});
