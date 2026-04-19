/**
 * Tests for /brain/learnings (T990 Wave 1D).
 *
 * @task T990
 * @wave 1D
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BrainLearningsResponse } from '../../api/memory/learnings/+server.js';
import type { LearningsPageData } from '../learnings/+page.server.js';
import { load } from '../learnings/+page.server.js';

/** Narrow PageServerLoad's `void | payload` union to our declared payload. */
async function run(event: Parameters<typeof load>[0]): Promise<LearningsPageData> {
  const r = await load(event);
  return r as LearningsPageData;
}

const ROUTES_DIR = resolve(import.meta.dirname, '..');

describe('/brain/learnings — route tree', () => {
  it('page component exists', () => {
    expect(existsSync(resolve(ROUTES_DIR, 'learnings/+page.svelte'))).toBe(true);
  });

  it('server load exists', () => {
    expect(existsSync(resolve(ROUTES_DIR, 'learnings/+page.server.ts'))).toBe(true);
  });
});

describe('/brain/learnings — server load', () => {
  interface FakeLoadEvent {
    fetch: (url: string) => Promise<Response>;
  }

  it('returns null when API errors', async () => {
    const ev: FakeLoadEvent = { fetch: async () => new Response(null, { status: 500 }) };
    const r = await run(ev as unknown as Parameters<typeof load>[0]);
    expect(r.initial).toBeNull();
  });

  it('parses the response when OK', async () => {
    const fixture: BrainLearningsResponse = {
      learnings: [
        {
          id: 'L-1',
          insight: 'Sample insight',
          source: 'task/T1',
          confidence: 0.75,
          actionable: 1,
          application: null,
          applicable_types: JSON.stringify(['refactor']),
          quality_score: 0.5,
          memory_tier: 'short',
          verified: 0,
          valid_at: null,
          invalid_at: null,
          prune_candidate: 0,
          citation_count: 0,
          created_at: '2026-04-19T00:00:00Z',
        },
      ],
      total: 1,
      filtered: 1,
    };
    const ev: FakeLoadEvent = {
      fetch: async () =>
        new Response(JSON.stringify(fixture), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    };
    const r = await run(ev as unknown as Parameters<typeof load>[0]);
    expect(r.initial?.learnings).toHaveLength(1);
    expect(r.initial?.learnings[0]?.actionable).toBe(1);
  });
});
