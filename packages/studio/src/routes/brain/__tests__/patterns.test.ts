/**
 * Tests for /brain/patterns (T990 Wave 1D).
 *
 * Route-tree + server-load shape. Component filter / modal behaviour
 * lives in e2e.
 *
 * @task T990
 * @wave 1D
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BrainPatternsResponse } from '../../api/memory/patterns/+server.js';
import type { PatternsPageData } from '../patterns/+page.server.js';
import { load } from '../patterns/+page.server.js';

/** Narrow PageServerLoad's `void | payload` union to our declared payload. */
async function run(event: Parameters<typeof load>[0]): Promise<PatternsPageData> {
  const r = await load(event);
  return r as PatternsPageData;
}

const ROUTES_DIR = resolve(import.meta.dirname, '..');

describe('/brain/patterns — route tree', () => {
  it('page component exists', () => {
    expect(existsSync(resolve(ROUTES_DIR, 'patterns/+page.svelte'))).toBe(true);
  });

  it('server load exists', () => {
    expect(existsSync(resolve(ROUTES_DIR, 'patterns/+page.server.ts'))).toBe(true);
  });
});

describe('/brain/patterns — server load', () => {
  interface FakeLoadEvent {
    fetch: (url: string) => Promise<Response>;
  }

  it('returns null initial when API errors', async () => {
    const ev: FakeLoadEvent = { fetch: async () => new Response(null, { status: 500 }) };
    const r = await run(ev as unknown as Parameters<typeof load>[0]);
    expect(r.initial).toBeNull();
  });

  it('parses the response when OK', async () => {
    const fixture: BrainPatternsResponse = {
      patterns: [
        {
          id: 'P-1',
          type: 'workflow',
          pattern: 'Sample',
          context: 'Ctx',
          impact: 'medium',
          anti_pattern: null,
          mitigation: null,
          success_rate: null,
          frequency: 3,
          quality_score: 0.6,
          memory_tier: 'short',
          verified: 0,
          valid_at: null,
          invalid_at: null,
          prune_candidate: 0,
          citation_count: 0,
          extracted_at: '2026-04-19T00:00:00Z',
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
    expect(r.initial).not.toBeNull();
    expect(r.initial?.patterns).toHaveLength(1);
    expect(r.initial?.patterns[0]?.type).toBe('workflow');
  });

  it('includes the expected query string on the first load', async () => {
    let capturedUrl = '';
    const ev: FakeLoadEvent = {
      fetch: async (url) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ patterns: [], total: 0, filtered: 0 }), {
          status: 200,
        });
      },
    };
    await load(ev as unknown as Parameters<typeof load>[0]);
    expect(capturedUrl).toContain('limit=50');
    expect(capturedUrl).toContain('offset=0');
    expect(capturedUrl).toContain('sort=created_desc');
  });
});
