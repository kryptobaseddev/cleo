/**
 * Re-export parity test for the Studio agent-lifecycle lane shim.
 *
 * The full behavioural coverage of the resolver now lives with the SSoT in
 * `@cleocode/core/tasks/agent-lifecycle-lane` (see
 * `packages/core/src/tasks/__tests__/agent-lifecycle-lane.test.ts`). This test
 * confirms the Studio re-export shim (T11934) forwards the same symbols and
 * precedence behaviour, so the `/tasks/kanban` route + `KanbanView` keep
 * resolving lanes identically to the `cleo tui` board. Browser-platform bundle
 * checks also keep both lane consumers outside the server-capable task graph.
 *
 * @task T11934 — lane model lifted to core; Studio re-exports it
 * @task T11926 — original Studio resolver
 * @epic T11559
 */

import { fileURLToPath } from 'node:url';
import { resolveAgentLifecycleLane as coreResolve } from '@cleocode/core/tasks/agent-lifecycle-lane';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { cleoWorkspaceSubpathAliases } from '../../../../../../../vitest-workspace-resolver.js';

describe('Studio agent-lifecycle-lane re-export shim (T11934)', () => {
  it('re-exports the canonical resolver from the core leaf (same function identity)', async () => {
    const { resolveAgentLifecycleLane } = await import('../agent-lifecycle-lane.js');
    expect(resolveAgentLifecycleLane).toBe(coreResolve);
  });

  it('re-exports the canonical seven-lane taxonomy in order', async () => {
    const { AGENT_LIFECYCLE_LANES } = await import('../agent-lifecycle-lane.js');
    expect(AGENT_LIFECYCLE_LANES).toEqual([
      'backlog',
      'ready',
      'running',
      'review',
      'blocked',
      'done',
      'cancelled',
    ]);
  });

  it('resolves the precedence ladder through the shim', async () => {
    const { resolveAgentLifecycleLane } = await import('../agent-lifecycle-lane.js');
    expect(resolveAgentLifecycleLane({ status: 'cancelled' })).toBe('cancelled');
    expect(resolveAgentLifecycleLane({ status: 'done' })).toBe('done');
    expect(resolveAgentLifecycleLane({ status: 'blocked' })).toBe('blocked');
    expect(
      resolveAgentLifecycleLane({
        status: 'active',
        gates: { implemented: true, testsPassed: true, qaPassed: true },
      }),
    ).toBe('review');
    expect(resolveAgentLifecycleLane({ status: 'active' })).toBe('running');
    expect(resolveAgentLifecycleLane({ status: 'pending', nextAction: 'spawn-worker' })).toBe(
      'ready',
    );
    expect(resolveAgentLifecycleLane({ status: 'pending' })).toBe('backlog');
  });
});

describe('Studio lane consumers stay inside the browser boundary (T12255)', () => {
  it.each([
    ['lane shim', '../agent-lifecycle-lane.ts'],
    ['saga board store', '../../../stores/saga-board.svelte.ts'],
  ])('%s bundles without server modules or external imports', async (_name, entry) => {
    // Exercise the real source import graph without executing output or needing
    // stale dist files. Rune execution is covered by the existing Svelte suite;
    // this check does not replace the release-shaped Vite/packed-install oracle.
    const result = await build({
      absWorkingDir: fileURLToPath(new URL('../../../../../../../', import.meta.url)),
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      metafile: true,
      logLevel: 'silent',
      plugins: [
        {
          name: 'workspace-source-browser-boundary',
          setup(bundler) {
            for (const alias of cleoWorkspaceSubpathAliases()) {
              bundler.onResolve({ filter: alias.find }, (args) => {
                const path = alias.customResolver(args.path);
                return path ? { path } : undefined;
              });
            }
            // Reject this known server-capable barrel before traversing its
            // large mutation/LLM graph. Other Node dependencies still fail the
            // browser-platform build; nothing is stubbed or externalized.
            bundler.onLoad({ filter: /\/core\/src\/tasks\/index\.ts$/ }, () => ({
              errors: [{ text: 'Browser graph reached the server-capable task barrel' }],
            }));
          },
        },
      ],
    });

    const inputs = Object.entries(result.metafile.inputs);
    expect(
      inputs.map(([path]) => path).filter((path) => path.startsWith('packages/core/')),
    ).toEqual(['packages/core/src/tasks/agent-lifecycle-lane.ts']);
    expect(inputs.flatMap(([, input]) => input.imports).filter((edge) => edge.external)).toEqual(
      [],
    );
    expect(Object.values(result.metafile.outputs).flatMap((output) => output.imports)).toEqual([]);
    expect(result.outputFiles).toHaveLength(1);
    expect(result.outputFiles[0]?.contents.byteLength).toBeGreaterThan(0);
  });
});
