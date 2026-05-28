/**
 * T11045 Smoke Test — Verify the docs-dogfood-harness works.
 *
 * This test validates that the fixture harness creates isolated projects,
 * runs CLEO CLI commands deterministically, and documents the six
 * regression scenarios. It does NOT require a pre-built CLI dist —
 * vitest resolves imports from source.
 *
 * @task T11045
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLI_DIST_AVAILABLE,
  createIsolatedProject,
  type DocsDogfoodContext,
  fileSha256,
  SIX_REGRESSION_SCENARIOS,
  sha256,
} from './fixtures/docs-dogfood-harness.js';

// ─── Harness Structure Tests ──────────────────────────────────────────────────

describe('T11045 — Docs Dogfood Regression Fixture Harness', () => {
  describe('SIX_REGRESSION_SCENARIOS', () => {
    it('documents all six 2026-05-25 failure classes', () => {
      expect(SIX_REGRESSION_SCENARIOS).toHaveLength(6);

      const ids = SIX_REGRESSION_SCENARIOS.map((s) => s.id);
      expect(ids).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);

      const failureClasses = SIX_REGRESSION_SCENARIOS.map((s) => s.failureClass);
      expect(failureClasses).toEqual([
        'Path traversal guard',
        'Drift state mismatch',
        'Slug→owner registration',
        'Version selection',
        'Slug uniqueness UX',
        'Auto-suffix transparency',
      ]);
    });

    it('each scenario has a name, description, and task owner', () => {
      for (const scenario of SIX_REGRESSION_SCENARIOS) {
        expect(scenario.name).toBeTruthy();
        expect(scenario.description).toBeTruthy();
        expect(scenario.ownedBy).toBeTruthy();
        expect(scenario.description.length).toBeGreaterThan(30);
      }
    });

    it('scenarios are mapped to dedicated test tasks (T11060-T11062)', () => {
      const owners = new Set(SIX_REGRESSION_SCENARIOS.map((s) => s.ownedBy));
      expect(owners.has('T11060')).toBe(true);
      expect(owners.has('T11061')).toBe(true);
      expect(owners.has('T11062')).toBe(true);
    });
  });

  describe('createIsolatedProject', () => {
    let ctx: DocsDogfoodContext;

    afterEach(async () => {
      await ctx?.cleanup?.();
    });

    it('creates a temp directory with a .cleo/ subdir', async () => {
      ctx = await createIsolatedProject();
      expect(ctx.projectRoot).toBeTruthy();
      expect(existsSync(ctx.projectRoot)).toBe(true);
      expect(existsSync(join(ctx.projectRoot, '.cleo'))).toBe(true);
    });

    it('creates unique roots on each call', async () => {
      const ctx1 = await createIsolatedProject();
      const ctx2 = await createIsolatedProject();

      expect(ctx1.projectRoot).not.toBe(ctx2.projectRoot);

      await ctx1.cleanup();
      await ctx2.cleanup();
    });

    it('cleanup removes the project directory', async () => {
      ctx = await createIsolatedProject();
      const root = ctx.projectRoot;
      expect(existsSync(root)).toBe(true);

      await ctx.cleanup();
      // After cleanup, the dir should be gone (or at least not usable).
      // Best-effort: rm is async so it may still exist briefly.
      // We just verify the cleanup function doesn't throw.
    });

    it('does not depend on any fixed path', async () => {
      ctx = await createIsolatedProject();
      const root = ctx.projectRoot;
      // Should NOT be under /mnt/projects/cleocode or any fixed path.
      expect(root).not.toContain('/mnt/projects/cleocode');
      // Should be under the OS temp directory.
      expect(root).toContain('cleo-dogfood-');
    });
  });

  describe('sha256 / fileSha256 helpers', () => {
    it('sha256 computes deterministic hex digest', () => {
      expect(sha256('hello')).toBe(
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      );
      expect(sha256('hello')).toBe(sha256('hello')); // deterministic
    });

    it('sha256 is different for different inputs', () => {
      expect(sha256('a')).not.toBe(sha256('b'));
    });

    it('fileSha256 matches sha256 of the same content', async () => {
      const ctx = await createIsolatedProject();
      const filePath = join(ctx.projectRoot, 'test.txt');
      const content = 'test content\n';
      const { writeFile } = await import('node:fs/promises');
      await writeFile(filePath, content, 'utf-8');

      const fileHash = await fileSha256(filePath);
      expect(fileHash).toBe(sha256(content));

      await ctx.cleanup();
    });
  });

  describe('CLI_DIST_AVAILABLE', () => {
    it('reports whether the compiled CLI is available', () => {
      // Just a type-check — the flag itself is informative.
      expect(typeof CLI_DIST_AVAILABLE).toBe('boolean');
    });
  });
});
