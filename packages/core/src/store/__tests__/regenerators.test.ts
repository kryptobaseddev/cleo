/**
 * Tests for T352 dry-run JSON file generators.
 *
 * Verifies:
 *   1. All generators return the correct `filename` field.
 *   2. No generator writes anything to disk.
 *   3. Machine-local fields reflect the `projectRoot` argument.
 *   4. Different `projectRoot` values produce distinguishable output.
 *   5. `regenerateAllJson` returns all three files.
 *
 * @task T352
 * @epic T311
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  regenerateAllJson,
  regenerateConfigJson,
  regenerateProjectContextJson,
  regenerateProjectInfoJson,
} from '../regenerators.js';

describe('T352 regenerators (dry-run init JSON generators)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-t352-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ── regenerateConfigJson ────────────────────────────────────────────

  describe('regenerateConfigJson', () => {
    it('returns filename="config.json"', () => {
      const result = regenerateConfigJson(tmpRoot);
      expect(result.filename).toBe('config.json');
    });

    it('returns a non-null object as content', () => {
      const result = regenerateConfigJson(tmpRoot);
      expect(result.content).toBeTypeOf('object');
      expect(result.content).not.toBeNull();
    });

    it('does NOT write config.json to disk', () => {
      regenerateConfigJson(tmpRoot);
      expect(fs.existsSync(path.join(tmpRoot, '.cleo', 'config.json'))).toBe(false);
      expect(fs.existsSync(path.join(tmpRoot, '.cleo'))).toBe(false);
    });

    it('content has expected top-level keys from createDefaultConfig', () => {
      const result = regenerateConfigJson(tmpRoot);
      const content = result.content as Record<string, unknown>;
      // These keys mirror createDefaultConfig() in scaffold.ts
      expect(content).toHaveProperty('version');
      expect(content).toHaveProperty('output');
      expect(content).toHaveProperty('backup');
      expect(content).toHaveProperty('hierarchy');
      expect(content).toHaveProperty('session');
      expect(content).toHaveProperty('lifecycle');
    });

    it('is stable across two calls to the same projectRoot (modulo timestamps)', () => {
      const a = regenerateConfigJson(tmpRoot);
      const b = regenerateConfigJson(tmpRoot);
      // All non-timestamp fields must be identical
      expect(typeof a.content).toBe(typeof b.content);
      expect((a.content as Record<string, unknown>)['version']).toBe(
        (b.content as Record<string, unknown>)['version'],
      );
    });
  });

  // ── regenerateProjectInfoJson ───────────────────────────────────────

  describe('regenerateProjectInfoJson', () => {
    it('returns filename="project-info.json"', () => {
      const result = regenerateProjectInfoJson(tmpRoot);
      expect(result.filename).toBe('project-info.json');
    });

    it('returns a non-null object as content', () => {
      const result = regenerateProjectInfoJson(tmpRoot);
      expect(result.content).toBeTypeOf('object');
      expect(result.content).not.toBeNull();
    });

    it('does NOT write project-info.json to disk', () => {
      regenerateProjectInfoJson(tmpRoot);
      expect(fs.existsSync(path.join(tmpRoot, '.cleo', 'project-info.json'))).toBe(false);
      expect(fs.existsSync(path.join(tmpRoot, '.cleo'))).toBe(false);
    });

    it('content includes required machine-local fields', () => {
      const result = regenerateProjectInfoJson(tmpRoot);
      const content = result.content as Record<string, unknown>;
      expect(content).toHaveProperty('projectHash');
      expect(content).toHaveProperty('projectId');
      expect(content).toHaveProperty('cleoVersion');
      expect(content).toHaveProperty('lastUpdated');
      expect(content).toHaveProperty('schemas');
    });

    it('projectHash reflects the resolved projectRoot path', () => {
      const result = regenerateProjectInfoJson(tmpRoot);
      const content = result.content as Record<string, unknown>;
      // projectHash must be a non-empty string (SHA-256 prefix)
      expect(typeof content['projectHash']).toBe('string');
      expect((content['projectHash'] as string).length).toBeGreaterThan(0);
    });

    it('produces different projectHash for different projectRoots', () => {
      const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-t352-other-'));
      try {
        const a = regenerateProjectInfoJson(tmpRoot);
        const b = regenerateProjectInfoJson(root2);
        expect((a.content as Record<string, unknown>)['projectHash']).not.toBe(
          (b.content as Record<string, unknown>)['projectHash'],
        );
      } finally {
        fs.rmSync(root2, { recursive: true, force: true });
      }
    });

    it('schemas block contains config, sqlite, and projectContext keys', () => {
      const result = regenerateProjectInfoJson(tmpRoot);
      const schemas = (result.content as Record<string, unknown>)['schemas'] as Record<
        string,
        unknown
      >;
      expect(schemas).toHaveProperty('config');
      expect(schemas).toHaveProperty('sqlite');
      expect(schemas).toHaveProperty('projectContext');
    });
  });

  // ── regenerateProjectContextJson ───────────────────────────────────

  describe('regenerateProjectContextJson', () => {
    it('returns filename="project-context.json"', () => {
      const result = regenerateProjectContextJson(tmpRoot);
      expect(result.filename).toBe('project-context.json');
    });

    it('returns a non-null object as content', () => {
      const result = regenerateProjectContextJson(tmpRoot);
      expect(result.content).toBeTypeOf('object');
      expect(result.content).not.toBeNull();
    });

    it('does NOT write project-context.json to disk', () => {
      regenerateProjectContextJson(tmpRoot);
      expect(fs.existsSync(path.join(tmpRoot, '.cleo', 'project-context.json'))).toBe(false);
      expect(fs.existsSync(path.join(tmpRoot, '.cleo'))).toBe(false);
    });

    it('content has required schema fields from detectProjectType', () => {
      const result = regenerateProjectContextJson(tmpRoot);
      const content = result.content as Record<string, unknown>;
      expect(content).toHaveProperty('schemaVersion');
      expect(content).toHaveProperty('detectedAt');
      expect(content).toHaveProperty('projectTypes');
      expect(content).toHaveProperty('monorepo');
    });

    it('detectedAt is a valid ISO timestamp', () => {
      const result = regenerateProjectContextJson(tmpRoot);
      const content = result.content as Record<string, unknown>;
      const detectedAt = content['detectedAt'] as string;
      expect(typeof detectedAt).toBe('string');
      const parsed = new Date(detectedAt);
      expect(Number.isNaN(parsed.getTime())).toBe(false);
    });
  });

  // ── regenerateAllJson ───────────────────────────────────────────────

  describe('regenerateAllJson', () => {
    it('returns all three files', () => {
      const all = regenerateAllJson(tmpRoot);
      expect(all.config.filename).toBe('config.json');
      expect(all.projectInfo.filename).toBe('project-info.json');
      expect(all.projectContext.filename).toBe('project-context.json');
    });

    it('does NOT write any files to disk', () => {
      regenerateAllJson(tmpRoot);
      expect(fs.existsSync(path.join(tmpRoot, '.cleo'))).toBe(false);
    });

    it('all three content values are non-null objects', () => {
      const all = regenerateAllJson(tmpRoot);
      for (const file of [all.config, all.projectInfo, all.projectContext]) {
        expect(file.content).toBeTypeOf('object');
        expect(file.content).not.toBeNull();
      }
    });
  });

  // ── Cross-projectRoot differentiation ──────────────────────────────

  describe('cross-projectRoot differentiation', () => {
    it('regenerated project-info differs across different projectRoots', () => {
      const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-t352-other-'));
      try {
        const a = regenerateProjectInfoJson(tmpRoot);
        const b = regenerateProjectInfoJson(root2);
        // At minimum the projectHash must differ (different paths)
        expect(JSON.stringify(a.content)).not.toBe(JSON.stringify(b.content));
      } finally {
        fs.rmSync(root2, { recursive: true, force: true });
      }
    });
  });

  // ── Stability / shape ───────────────────────────────────────────────

  describe('stability', () => {
    it('config content has the same type shape across two calls', () => {
      const a = regenerateConfigJson(tmpRoot);
      const b = regenerateConfigJson(tmpRoot);
      expect(typeof a.content).toBe(typeof b.content);
      expect(Object.keys(a.content as Record<string, unknown>).sort()).toEqual(
        Object.keys(b.content as Record<string, unknown>).sort(),
      );
    });
  });
});
