/**
 * Tests for /brain/search (T990 Wave 1D).
 *
 * @task T990
 * @wave 1D
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SearchPageData } from '../search/+page.server.js';
import { load } from '../search/+page.server.js';

/** Narrow PageServerLoad's `void | payload` union to our declared payload. */
function run(event: Parameters<typeof load>[0]): SearchPageData {
  const r = load(event);
  return r as SearchPageData;
}

const ROUTES_DIR = resolve(import.meta.dirname, '..');

describe('/brain/search — route tree', () => {
  it('page component exists', () => {
    expect(existsSync(resolve(ROUTES_DIR, 'search/+page.svelte'))).toBe(true);
  });

  it('server load exists', () => {
    expect(existsSync(resolve(ROUTES_DIR, 'search/+page.server.ts'))).toBe(true);
  });
});

describe('/brain/search — server load', () => {
  it('returns empty initialQuery when no ?q param is present', () => {
    const ev = { url: new URL('http://localhost/brain/search') };
    const r = run(ev as unknown as Parameters<typeof load>[0]);
    expect(r.initialQuery).toBe('');
  });

  it('forwards the ?q param trimmed', () => {
    const ev = { url: new URL('http://localhost/brain/search?q=%20nexus%20') };
    const r = run(ev as unknown as Parameters<typeof load>[0]);
    expect(r.initialQuery).toBe('nexus');
  });
});
