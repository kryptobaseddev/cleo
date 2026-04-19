/**
 * Tests for /brain/causal (T990 Wave 1D).
 *
 * @task T990
 * @wave 1D
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CausalPageData } from '../causal/+page.server.js';
import { load } from '../causal/+page.server.js';

/** Narrow PageServerLoad's `void | payload` union to our declared payload. */
function run(event: Parameters<typeof load>[0]): CausalPageData {
  const r = load(event);
  return r as CausalPageData;
}

const ROUTES_DIR = resolve(import.meta.dirname, '..');

describe('/brain/causal — route tree', () => {
  it('page component exists', () => {
    expect(existsSync(resolve(ROUTES_DIR, 'causal/+page.svelte'))).toBe(true);
  });

  it('server load exists', () => {
    expect(existsSync(resolve(ROUTES_DIR, 'causal/+page.server.ts'))).toBe(true);
  });
});

describe('/brain/causal — server load', () => {
  it('returns empty initialTaskId without ?taskId', () => {
    const ev = { url: new URL('http://localhost/brain/causal') };
    const r = run(ev as unknown as Parameters<typeof load>[0]);
    expect(r.initialTaskId).toBe('');
  });

  it('forwards the ?taskId param trimmed', () => {
    const ev = { url: new URL('http://localhost/brain/causal?taskId=%20T123%20') };
    const r = run(ev as unknown as Parameters<typeof load>[0]);
    expect(r.initialTaskId).toBe('T123');
  });
});
