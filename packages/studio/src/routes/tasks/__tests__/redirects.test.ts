/**
 * T957 — 301 redirects from deprecated `/tasks/tree/[epicId]` and
 * `/tasks/graph` to the new Task Explorer hash routes on `/tasks` (T956).
 *
 * SvelteKit's `redirect()` helper throws a `Redirect` instance whose `status`
 * and `location` fields we can assert against. These tests invoke each
 * loader's `load()` with a minimal `LoadEvent` shape, catch the redirect, and
 * verify:
 *
 *   1. `/tasks/tree/T949`          → 301 `/tasks?view=hierarchy&epic=T949#hierarchy`
 *   2. `/tasks/graph`              → 301 `/tasks?view=graph#graph`
 *   3. `/tasks/graph?archived=1`   → 301 `/tasks?archived=1&view=graph#graph`
 *                                     (caller's query params preserved)
 *   4. `/tasks/tree/T949?labels=bug` → 301 with `labels=bug` preserved
 *
 * @task T957
 * @epic T949
 */

import { isRedirect } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { load as graphLoad } from '../graph/+page.server.js';
import type { PageServerLoad as GraphLoad } from '../graph/$types';
import { load as treeLoad } from '../tree/[epicId]/+page.server.js';
import type { PageServerLoad as TreeLoad } from '../tree/[epicId]/$types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Shape of the redirect thrown by SvelteKit's `redirect()` helper.
 *
 * We narrow `unknown` into this after `isRedirect()` passes so TypeScript stops
 * complaining about property access.
 */
interface RedirectLike {
  status: number;
  location: string;
}

/**
 * Build a minimal stub compatible with a `PageServerLoad` event. Both loaders
 * only read `params` and `url`, so filling in the other ~20 fields would be
 * needless ceremony; we cast through `unknown` instead.
 */
function buildGraphEvent(pathname: string): Parameters<GraphLoad>[0] {
  const url = new URL(`http://localhost:3456${pathname}`);
  return { url } as unknown as Parameters<GraphLoad>[0];
}

function buildTreeEvent(pathname: string, epicId: string): Parameters<TreeLoad>[0] {
  const url = new URL(`http://localhost:3456${pathname}`);
  return { url, params: { epicId } } as unknown as Parameters<TreeLoad>[0];
}

/**
 * Run a loader, catch its redirect, and return the normalised redirect
 * details. Throws if the loader didn't redirect (tests would rather fail
 * loudly than silently return `undefined`).
 */
function captureRedirect(fn: () => unknown): RedirectLike {
  try {
    fn();
  } catch (thrown) {
    if (isRedirect(thrown)) {
      return thrown as unknown as RedirectLike;
    }
    throw thrown;
  }
  throw new Error('loader did not throw a redirect');
}

// ---------------------------------------------------------------------------
// /tasks/tree/[epicId] redirects
// ---------------------------------------------------------------------------

describe('T957 · /tasks/tree/[epicId] → /tasks hierarchy tab', () => {
  it('301 redirects GET /tasks/tree/T949 with epic + view + hash', () => {
    const event = buildTreeEvent('/tasks/tree/T949', 'T949');
    const redirect = captureRedirect(() => treeLoad(event));

    expect(redirect.status).toBe(301);
    expect(redirect.location).toBe('/tasks?view=hierarchy&epic=T949#hierarchy');
  });

  it('preserves caller-provided query params across the redirect', () => {
    const event = buildTreeEvent('/tasks/tree/T949?labels=bug', 'T949');
    const redirect = captureRedirect(() => treeLoad(event));

    expect(redirect.status).toBe(301);
    const target = new URL(redirect.location, 'http://localhost:3456');
    expect(target.pathname).toBe('/tasks');
    expect(target.searchParams.get('view')).toBe('hierarchy');
    expect(target.searchParams.get('epic')).toBe('T949');
    expect(target.searchParams.get('labels')).toBe('bug');
    expect(target.hash).toBe('#hierarchy');
  });

  it('view + epic win even if the caller passed stale copies of those keys', () => {
    const event = buildTreeEvent('/tasks/tree/T949?view=kanban&epic=T001', 'T949');
    const redirect = captureRedirect(() => treeLoad(event));

    const target = new URL(redirect.location, 'http://localhost:3456');
    expect(target.searchParams.get('view')).toBe('hierarchy');
    expect(target.searchParams.get('epic')).toBe('T949');
    expect(target.hash).toBe('#hierarchy');
  });

  it('URL-encodes unusual epic IDs safely', () => {
    const event = buildTreeEvent('/tasks/tree/T%20949', 'T 949');
    const redirect = captureRedirect(() => treeLoad(event));

    // The URL constructor will encode the space — assert via parsed getters.
    const target = new URL(redirect.location, 'http://localhost:3456');
    expect(target.searchParams.get('epic')).toBe('T 949');
  });
});

// ---------------------------------------------------------------------------
// /tasks/graph redirects
// ---------------------------------------------------------------------------

describe('T957 · /tasks/graph → /tasks graph tab', () => {
  it('301 redirects GET /tasks/graph to the graph tab', () => {
    const event = buildGraphEvent('/tasks/graph');
    const redirect = captureRedirect(() => graphLoad(event));

    expect(redirect.status).toBe(301);
    expect(redirect.location).toBe('/tasks?view=graph#graph');
  });

  it('preserves a caller-provided archived filter across the redirect', () => {
    const event = buildGraphEvent('/tasks/graph?archived=1');
    const redirect = captureRedirect(() => graphLoad(event));

    const target = new URL(redirect.location, 'http://localhost:3456');
    expect(redirect.status).toBe(301);
    expect(target.searchParams.get('archived')).toBe('1');
    expect(target.searchParams.get('view')).toBe('graph');
    expect(target.hash).toBe('#graph');
  });

  it('preserves an arbitrary filter query (e.g. q=foo) across the redirect', () => {
    const event = buildGraphEvent('/tasks/graph?q=foo');
    const redirect = captureRedirect(() => graphLoad(event));

    const target = new URL(redirect.location, 'http://localhost:3456');
    expect(redirect.status).toBe(301);
    expect(target.searchParams.get('q')).toBe('foo');
    expect(target.searchParams.get('view')).toBe('graph');
    expect(target.hash).toBe('#graph');
  });

  it('preserves an epic focus across the redirect', () => {
    const event = buildGraphEvent('/tasks/graph?epic=T949');
    const redirect = captureRedirect(() => graphLoad(event));

    const target = new URL(redirect.location, 'http://localhost:3456');
    expect(target.searchParams.get('epic')).toBe('T949');
    expect(target.searchParams.get('view')).toBe('graph');
    expect(target.hash).toBe('#graph');
  });
});
