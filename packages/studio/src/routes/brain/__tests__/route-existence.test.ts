/**
 * Route existence tests for the /brain route umbrella (T649).
 *
 * Asserts that the target route tree is present on disk after the
 * /living-brain → /brain and /nexus → /code renames.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Absolute path to packages/studio/src/routes.
 * The test file lives at routes/brain/__tests__/ — 3 levels up from here gives src/,
 * then we append 'routes' to land in the routes directory.
 */
const ROUTES_DIR = resolve(import.meta.dirname, '../../..', 'routes');

/** Resolve a path relative to packages/studio/src/routes. */
function route(rel: string): string {
  return resolve(ROUTES_DIR, rel);
}

describe('route tree — T649 route rename', () => {
  describe('/brain — canvas umbrella', () => {
    it('canvas page exists at /brain/+page.svelte', () => {
      expect(existsSync(route('brain/+page.svelte'))).toBe(true);
    });

    it('canvas server load exists at /brain/+page.server.ts', () => {
      expect(existsSync(route('brain/+page.server.ts'))).toBe(true);
    });

    it('overview page exists at /brain/overview/+page.svelte', () => {
      expect(existsSync(route('brain/overview/+page.svelte'))).toBe(true);
    });

    it('overview server load exists at /brain/overview/+page.server.ts', () => {
      expect(existsSync(route('brain/overview/+page.server.ts'))).toBe(true);
    });

    it('decisions page preserved at /brain/decisions/+page.svelte', () => {
      expect(existsSync(route('brain/decisions/+page.svelte'))).toBe(true);
    });

    it('graph page preserved at /brain/graph/+page.svelte', () => {
      expect(existsSync(route('brain/graph/+page.svelte'))).toBe(true);
    });

    it('observations page preserved at /brain/observations/+page.svelte', () => {
      expect(existsSync(route('brain/observations/+page.svelte'))).toBe(true);
    });

    it('quality page preserved at /brain/quality/+page.svelte', () => {
      expect(existsSync(route('brain/quality/+page.svelte'))).toBe(true);
    });
  });

  describe('/code — was /nexus', () => {
    it('/code/+page.svelte exists', () => {
      expect(existsSync(route('code/+page.svelte'))).toBe(true);
    });

    it('/code/+page.server.ts exists', () => {
      expect(existsSync(route('code/+page.server.ts'))).toBe(true);
    });

    it('/code/community/[id]/+page.svelte exists', () => {
      expect(existsSync(route('code/community/[id]/+page.svelte'))).toBe(true);
    });

    it('/code/community/[id]/+page.server.ts exists', () => {
      expect(existsSync(route('code/community/[id]/+page.server.ts'))).toBe(true);
    });

    it('/code/symbol/[name]/+page.svelte exists', () => {
      expect(existsSync(route('code/symbol/[name]/+page.svelte'))).toBe(true);
    });
  });

  describe('old routes removed', () => {
    it('/living-brain directory is gone', () => {
      expect(existsSync(route('living-brain'))).toBe(false);
    });

    it('/nexus directory is gone', () => {
      expect(existsSync(route('nexus'))).toBe(false);
    });
  });

  describe('unchanged routes preserved', () => {
    it('/projects/+page.svelte still exists (admin-only, no nav item)', () => {
      expect(existsSync(route('projects/+page.svelte'))).toBe(true);
    });

    it('/tasks directory still exists', () => {
      expect(existsSync(route('tasks'))).toBe(true);
    });

    it('API super-graph route renamed — /api/brain present (formerly /api/living-brain)', () => {
      expect(existsSync(route('api/brain'))).toBe(true);
    });

    it('API super-graph route — /api/living-brain is gone (renamed to /api/brain)', () => {
      expect(existsSync(route('api/living-brain'))).toBe(false);
    });

    it('API memory surface present — /api/memory (formerly /api/brain for observations)', () => {
      expect(existsSync(route('api/memory'))).toBe(true);
    });
  });
});
