/**
 * BrainAccessorImpl — concrete implementation of {@link BrainAccessor}.
 *
 * Delegates to the existing brain-retrieval module (observeBrain + searchBrainCompact)
 * but exposes a role-typed interface that UmbrellaDataAccessor.getSubAccessor
 * can return without coupling the call site to brain internals.
 *
 * @task T9188
 * @epic T9048
 * @see packages/contracts/src/sub-accessors.ts (BrainAccessor interface)
 * @see packages/core/src/memory/brain-retrieval.ts (underlying implementation)
 */

import type { BrainAccessor, BrainMemoryHit, BrainObserveParams } from '@cleocode/contracts';
import { getProjectRoot } from '../paths.js';

/**
 * Create a BrainAccessor for the given project root.
 *
 * All operations delegate to the canonical brain-retrieval module.
 * The accessor holds no DB handles directly — brain-retrieval manages
 * its own singleton connections.
 *
 * @param projectRoot - Project root (defaults to CWD resolution).
 * @returns A BrainAccessor instance.
 * @task T9188
 */
export function createBrainAccessor(projectRoot?: string): BrainAccessor {
  const root = projectRoot ?? getProjectRoot();

  return {
    async observe(text: string, params?: Omit<BrainObserveParams, 'text'>): Promise<string> {
      const { observeBrain } = await import('../memory/brain-retrieval.js');
      const result = await observeBrain(root, {
        text,
        title: params?.title,
        // params.type is a generic string from the public interface; cast to the
        // internal enum type — observeBrain defaults to 'observation' on invalid values.
        type: params?.type as import('../memory/brain-retrieval.js').BrainObservationType | undefined,
        sourceSessionId: params?.sourceSessionId,
        agent: params?.agent,
        _skipGate: true, // bypass extraction gate for programmatic API calls
      });
      return result.id;
    },

    async find(query: string, limit = 10): Promise<BrainMemoryHit[]> {
      const { searchBrainCompact } = await import('../memory/brain-retrieval.js');
      const result = await searchBrainCompact(root, { query, limit });
      return result.results.map((r) => ({
        id: r.id,
        text: r.title ?? '',
        title: r.title ?? null,
        score: r.rrfScore ?? r.relevance ?? 0,
        type: r.type ?? null,
      }));
    },

    async close(): Promise<void> {
      // brain-retrieval manages singleton lifecycle; no explicit close needed.
    },
  };
}
