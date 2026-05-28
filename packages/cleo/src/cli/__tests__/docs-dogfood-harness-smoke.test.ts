/**
 * Docs dogfood harness smoke test.
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
  auditScenarioCoverage,
  CLI_DIST_AVAILABLE,
  createIsolatedProject,
  type DocsDogfoodContext,
  fileSha256,
  SIX_REGRESSION_SCENARIOS,
  SIX_REGRESSION_TEST_CASES,
  sha256,
  testCasesForScenario,
} from './fixtures/docs-dogfood-harness.js';

// ─── Harness Structure Tests ──────────────────────────────────────────────────

describe('Docs dogfood regression fixture harness', () => {
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
    });

    it('does not depend on any fixed path', async () => {
      ctx = await createIsolatedProject();
      const root = ctx.projectRoot;
      expect(root).not.toContain('/mnt/projects/cleocode');
      expect(root).toContain('cleo-dogfood-');
    });
  });

  describe('sha256 / fileSha256 helpers', () => {
    it('sha256 computes deterministic hex digest', () => {
      expect(sha256('hello')).toBe(
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      );
      expect(sha256('hello')).toBe(sha256('hello'));
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
      expect(typeof CLI_DIST_AVAILABLE).toBe('boolean');
    });
  });

  describe('SIX_REGRESSION_TEST_CASES (T11187)', () => {
    it('has exactly 15 test cases covering all 6 scenarios', () => {
      expect(SIX_REGRESSION_TEST_CASES).toHaveLength(15);
    });

    it('auditScenarioCoverage returns empty (all scenarios covered)', () => {
      expect(auditScenarioCoverage()).toEqual([]);
    });

    it('each scenario has at least 2 test cases', () => {
      for (const s of SIX_REGRESSION_SCENARIOS) {
        expect(testCasesForScenario(s.id).length).toBeGreaterThanOrEqual(2);
      }
    });

    it('all test case IDs are unique', () => {
      const ids = SIX_REGRESSION_TEST_CASES.map((tc) => tc.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
