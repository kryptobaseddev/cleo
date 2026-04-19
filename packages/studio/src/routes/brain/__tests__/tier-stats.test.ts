/**
 * Tests for /brain/tier-stats (T990 Wave 1D).
 *
 * File existence + server-load smoke test. Component DOM assertions
 * live in e2e; these tests verify the route tree and the load function's
 * fetch-and-shape contract.
 *
 * @task T990
 * @wave 1D
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TierStatsResponse } from '../../api/memory/tier-stats/+server.js';
import type { TierStatsPageData } from '../tier-stats/+page.server.js';
import { load } from '../tier-stats/+page.server.js';

/**
 * Narrow the SvelteKit PageServerLoad signature (which is `void | payload`) to
 * our declared payload shape. Safe at runtime because our load always resolves
 * a {@link TierStatsPageData}.
 */
async function run(event: Parameters<typeof load>[0]): Promise<TierStatsPageData> {
  const r = await load(event);
  return r as TierStatsPageData;
}

const ROUTES_DIR = resolve(import.meta.dirname, '..');

describe('/brain/tier-stats — route tree', () => {
  it('page component exists', () => {
    expect(existsSync(resolve(ROUTES_DIR, 'tier-stats/+page.svelte'))).toBe(true);
  });

  it('server load exists', () => {
    expect(existsSync(resolve(ROUTES_DIR, 'tier-stats/+page.server.ts'))).toBe(true);
  });
});

describe('/brain/tier-stats — server load', () => {
  /**
   * Minimal fake SvelteKit load event — only `fetch` is read. The load
   * function must cope with any combination of network failures.
   */
  interface FakeLoadEvent {
    fetch: (url: string) => Promise<Response>;
  }

  it('returns null stats when the API errors', async () => {
    const ev: FakeLoadEvent = {
      fetch: async () => new Response(null, { status: 500 }),
    };
    // Cast is safe — server load only reads `fetch`.
    const result = await run(ev as unknown as Parameters<typeof load>[0]);
    expect(result.stats).toBeNull();
    expect(typeof result.loadedAt).toBe('string');
  });

  it('returns stats and a loadedAt stamp on success', async () => {
    const fixture: TierStatsResponse = {
      tables: [
        { table: 'brain_observations', short: 5, medium: 2, long: 1 },
        { table: 'brain_decisions', short: 3, medium: 1, long: 0 },
        { table: 'brain_patterns', short: 0, medium: 0, long: 0 },
        { table: 'brain_learnings', short: 2, medium: 1, long: 0 },
      ],
      upcomingLongPromotions: [
        { id: 'O-abc', table: 'brain_observations', daysUntil: 2.5, track: 'citation (7)' },
      ],
    };
    const ev: FakeLoadEvent = {
      fetch: async () =>
        new Response(JSON.stringify(fixture), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    };
    const result = await run(ev as unknown as Parameters<typeof load>[0]);
    expect(result.stats).not.toBeNull();
    expect(result.stats?.tables).toHaveLength(4);
    expect(result.stats?.upcomingLongPromotions).toHaveLength(1);
    expect(() => new Date(result.loadedAt).toISOString()).not.toThrow();
  });

  it('survives a thrown fetch', async () => {
    const ev: FakeLoadEvent = {
      fetch: async () => {
        throw new Error('offline');
      },
    };
    const result = await run(ev as unknown as Parameters<typeof load>[0]);
    expect(result.stats).toBeNull();
  });
});
