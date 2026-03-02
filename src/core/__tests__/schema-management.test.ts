/**
 * Tests for centralized schema management.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We mock the two dependency functions so schema-management uses our temp dirs.
let mockGlobalSchemasDir: string;
let mockPackageRoot: string;

vi.mock('../paths.js', () => ({
  getCleoSchemasDir: () => mockGlobalSchemasDir,
}));

vi.mock('../scaffold.js', () => ({
  getPackageRoot: () => mockPackageRoot,
}));

import {
  resolveSchemaPath,
  getSchemaVersion,
  ensureGlobalSchemas,
  checkGlobalSchemas,
  checkSchemaStaleness,
  listInstalledSchemas,
  cleanProjectSchemas,
} from '../schema-management.js';

// Helper: create a minimal schema JSON with a version
function makeSchema(version: string, useMeta = false): string {
  if (useMeta) {
    return JSON.stringify({ _meta: { schemaVersion: version } }, null, 2);
  }
  return JSON.stringify({ schemaVersion: version }, null, 2);
}

describe('schema-management', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-schema-mgmt-'));
    mockGlobalSchemasDir = join(tempDir, 'global-schemas');
    mockPackageRoot = join(tempDir, 'package');
    // Create the bundled schemas dir inside the fake package root
    mkdirSync(join(mockPackageRoot, 'schemas'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // resolveSchemaPath
  // ==========================================================================

  describe('resolveSchemaPath', () => {
    it('returns global path when schema exists there', () => {
      mkdirSync(mockGlobalSchemasDir, { recursive: true });
      writeFileSync(join(mockGlobalSchemasDir, 'todo.schema.json'), makeSchema('1.0.0'));
      // Also put it in bundled so we can verify global wins
      writeFileSync(join(mockPackageRoot, 'schemas', 'todo.schema.json'), makeSchema('1.0.0'));

      const result = resolveSchemaPath('todo.schema.json');
      expect(result).toBe(join(mockGlobalSchemasDir, 'todo.schema.json'));
    });

    it('falls back to package schemas when global not found', () => {
      // No global dir at all
      writeFileSync(join(mockPackageRoot, 'schemas', 'config.schema.json'), makeSchema('2.0.0'));

      const result = resolveSchemaPath('config.schema.json');
      expect(result).toBe(join(mockPackageRoot, 'schemas', 'config.schema.json'));
    });

    it('returns null when schema not found anywhere', () => {
      const result = resolveSchemaPath('nonexistent.schema.json');
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // getSchemaVersion
  // ==========================================================================

  describe('getSchemaVersion', () => {
    it('returns version string from top-level schemaVersion', () => {
      mkdirSync(mockGlobalSchemasDir, { recursive: true });
      writeFileSync(join(mockGlobalSchemasDir, 'todo.schema.json'), makeSchema('3.5.0'));

      expect(getSchemaVersion('todo.schema.json')).toBe('3.5.0');
    });

    it('handles _meta.schemaVersion format', () => {
      mkdirSync(mockGlobalSchemasDir, { recursive: true });
      writeFileSync(
        join(mockGlobalSchemasDir, 'config.schema.json'),
        makeSchema('2.10.0', true),
      );

      expect(getSchemaVersion('config.schema.json')).toBe('2.10.0');
    });

    it('returns null for missing schemas', () => {
      expect(getSchemaVersion('nonexistent.schema.json')).toBeNull();
    });

    it('returns null for schema without a version field', () => {
      mkdirSync(mockGlobalSchemasDir, { recursive: true });
      writeFileSync(
        join(mockGlobalSchemasDir, 'bare.schema.json'),
        JSON.stringify({ type: 'object' }),
      );

      expect(getSchemaVersion('bare.schema.json')).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      mkdirSync(mockGlobalSchemasDir, { recursive: true });
      writeFileSync(join(mockGlobalSchemasDir, 'bad.schema.json'), '{{not json}}');

      expect(getSchemaVersion('bad.schema.json')).toBeNull();
    });
  });

  // ==========================================================================
  // ensureGlobalSchemas
  // ==========================================================================

  describe('ensureGlobalSchemas', () => {
    it('copies schemas from package to global dir', () => {
      writeFileSync(join(mockPackageRoot, 'schemas', 'todo.schema.json'), makeSchema('1.0.0'));
      writeFileSync(join(mockPackageRoot, 'schemas', 'config.schema.json'), makeSchema('2.0.0'));

      const result = ensureGlobalSchemas();

      expect(result.installed).toBe(2);
      expect(result.updated).toBe(0);
      expect(result.total).toBe(2);
      expect(existsSync(join(mockGlobalSchemasDir, 'todo.schema.json'))).toBe(true);
      expect(existsSync(join(mockGlobalSchemasDir, 'config.schema.json'))).toBe(true);
    });

    it('creates global schemas directory if missing', () => {
      writeFileSync(join(mockPackageRoot, 'schemas', 'todo.schema.json'), makeSchema('1.0.0'));

      expect(existsSync(mockGlobalSchemasDir)).toBe(false);
      ensureGlobalSchemas();
      expect(existsSync(mockGlobalSchemasDir)).toBe(true);
    });

    it('is idempotent: skips schemas that already match', () => {
      writeFileSync(join(mockPackageRoot, 'schemas', 'todo.schema.json'), makeSchema('1.0.0'));

      // First call installs
      const first = ensureGlobalSchemas();
      expect(first.installed).toBe(1);

      // Second call skips (same version)
      const second = ensureGlobalSchemas();
      expect(second.installed).toBe(0);
      expect(second.updated).toBe(0);
      expect(second.total).toBe(1);
    });

    it('updates stale schemas with version mismatch', () => {
      // Install version 1.0.0
      writeFileSync(join(mockPackageRoot, 'schemas', 'todo.schema.json'), makeSchema('1.0.0'));
      ensureGlobalSchemas();

      // Now bump bundled to 2.0.0
      writeFileSync(join(mockPackageRoot, 'schemas', 'todo.schema.json'), makeSchema('2.0.0'));
      const result = ensureGlobalSchemas();

      expect(result.installed).toBe(0);
      expect(result.updated).toBe(1);
      expect(result.total).toBe(1);
    });

    it('returns zeros when no bundled schemas exist', () => {
      // Empty schemas dir (no .schema.json files)
      const result = ensureGlobalSchemas();
      expect(result).toEqual({ installed: 0, updated: 0, total: 0 });
    });
  });

  // ==========================================================================
  // checkGlobalSchemas
  // ==========================================================================

  describe('checkGlobalSchemas', () => {
    it('returns ok: true when all schemas installed and current', () => {
      writeFileSync(join(mockPackageRoot, 'schemas', 'todo.schema.json'), makeSchema('1.0.0'));
      writeFileSync(join(mockPackageRoot, 'schemas', 'config.schema.json'), makeSchema('2.0.0'));
      ensureGlobalSchemas();

      const result = checkGlobalSchemas();
      expect(result.ok).toBe(true);
      expect(result.installed).toBe(2);
      expect(result.bundled).toBe(2);
      expect(result.missing).toEqual([]);
      expect(result.stale).toEqual([]);
    });

    it('reports missing schemas', () => {
      writeFileSync(join(mockPackageRoot, 'schemas', 'todo.schema.json'), makeSchema('1.0.0'));
      writeFileSync(join(mockPackageRoot, 'schemas', 'config.schema.json'), makeSchema('2.0.0'));
      // Only install one
      mkdirSync(mockGlobalSchemasDir, { recursive: true });
      writeFileSync(join(mockGlobalSchemasDir, 'todo.schema.json'), makeSchema('1.0.0'));

      const result = checkGlobalSchemas();
      expect(result.ok).toBe(false);
      expect(result.missing).toEqual(['config.schema.json']);
      expect(result.installed).toBe(1);
    });

    it('reports stale schemas', () => {
      writeFileSync(join(mockPackageRoot, 'schemas', 'todo.schema.json'), makeSchema('2.0.0'));
      // Install an older version globally
      mkdirSync(mockGlobalSchemasDir, { recursive: true });
      writeFileSync(join(mockGlobalSchemasDir, 'todo.schema.json'), makeSchema('1.0.0'));

      const result = checkGlobalSchemas();
      expect(result.ok).toBe(false);
      expect(result.stale).toEqual(['todo.schema.json']);
    });
  });

  // ==========================================================================
  // checkSchemaStaleness
  // ==========================================================================

  describe('checkSchemaStaleness', () => {
    it('correctly identifies stale schemas', () => {
      writeFileSync(join(mockPackageRoot, 'schemas', 'todo.schema.json'), makeSchema('2.0.0'));
      mkdirSync(mockGlobalSchemasDir, { recursive: true });
      writeFileSync(join(mockGlobalSchemasDir, 'todo.schema.json'), makeSchema('1.0.0'));

      const report = checkSchemaStaleness();
      expect(report.stale).toEqual(['todo.schema.json']);
      expect(report.current).toEqual([]);
      expect(report.missing).toEqual([]);
    });

    it('correctly identifies current schemas', () => {
      writeFileSync(join(mockPackageRoot, 'schemas', 'todo.schema.json'), makeSchema('1.0.0'));
      mkdirSync(mockGlobalSchemasDir, { recursive: true });
      writeFileSync(join(mockGlobalSchemasDir, 'todo.schema.json'), makeSchema('1.0.0'));

      const report = checkSchemaStaleness();
      expect(report.stale).toEqual([]);
      expect(report.current).toEqual(['todo.schema.json']);
      expect(report.missing).toEqual([]);
    });

    it('correctly identifies missing schemas', () => {
      writeFileSync(join(mockPackageRoot, 'schemas', 'todo.schema.json'), makeSchema('1.0.0'));
      // No global dir at all

      const report = checkSchemaStaleness();
      expect(report.stale).toEqual([]);
      expect(report.current).toEqual([]);
      expect(report.missing).toEqual(['todo.schema.json']);
    });

    it('handles mixed states', () => {
      writeFileSync(join(mockPackageRoot, 'schemas', 'a.schema.json'), makeSchema('1.0.0'));
      writeFileSync(join(mockPackageRoot, 'schemas', 'b.schema.json'), makeSchema('2.0.0'));
      writeFileSync(join(mockPackageRoot, 'schemas', 'c.schema.json'), makeSchema('3.0.0'));

      mkdirSync(mockGlobalSchemasDir, { recursive: true });
      writeFileSync(join(mockGlobalSchemasDir, 'a.schema.json'), makeSchema('1.0.0')); // current
      writeFileSync(join(mockGlobalSchemasDir, 'b.schema.json'), makeSchema('1.0.0')); // stale
      // c.schema.json is missing

      const report = checkSchemaStaleness();
      expect(report.current).toEqual(['a.schema.json']);
      expect(report.stale).toEqual(['b.schema.json']);
      expect(report.missing).toEqual(['c.schema.json']);
    });
  });

  // ==========================================================================
  // listInstalledSchemas
  // ==========================================================================

  describe('listInstalledSchemas', () => {
    it('lists all schemas in global dir', () => {
      mkdirSync(mockGlobalSchemasDir, { recursive: true });
      writeFileSync(join(mockGlobalSchemasDir, 'todo.schema.json'), makeSchema('1.0.0'));
      writeFileSync(join(mockGlobalSchemasDir, 'config.schema.json'), makeSchema('2.0.0', true));

      const result = listInstalledSchemas();
      expect(result).toHaveLength(2);

      const names = result.map(s => s.name).sort();
      expect(names).toEqual(['config.schema.json', 'todo.schema.json']);

      const todoEntry = result.find(s => s.name === 'todo.schema.json')!;
      expect(todoEntry.version).toBe('1.0.0');
      expect(todoEntry.path).toBe(join(mockGlobalSchemasDir, 'todo.schema.json'));

      const configEntry = result.find(s => s.name === 'config.schema.json')!;
      expect(configEntry.version).toBe('2.0.0');
    });

    it('returns empty array when directory does not exist', () => {
      // mockGlobalSchemasDir was never created
      expect(listInstalledSchemas()).toEqual([]);
    });

    it('returns empty array when directory is empty', () => {
      mkdirSync(mockGlobalSchemasDir, { recursive: true });
      expect(listInstalledSchemas()).toEqual([]);
    });

    it('ignores non-schema files', () => {
      mkdirSync(mockGlobalSchemasDir, { recursive: true });
      writeFileSync(join(mockGlobalSchemasDir, 'readme.txt'), 'hello');
      writeFileSync(join(mockGlobalSchemasDir, 'todo.schema.json'), makeSchema('1.0.0'));

      const result = listInstalledSchemas();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('todo.schema.json');
    });
  });

  // ==========================================================================
  // cleanProjectSchemas
  // ==========================================================================

  describe('cleanProjectSchemas', () => {
    it('backs up and removes .cleo/schemas/ directory', async () => {
      const projectRoot = join(tempDir, 'myproject');
      const projectSchemasDir = join(projectRoot, '.cleo', 'schemas');
      mkdirSync(projectSchemasDir, { recursive: true });
      writeFileSync(join(projectSchemasDir, 'todo.schema.json'), makeSchema('1.0.0'));

      const result = await cleanProjectSchemas(projectRoot);

      expect(result.cleaned).toBe(true);
      // Original dir should be gone
      expect(existsSync(projectSchemasDir)).toBe(false);
      // Backup should exist
      const backupDir = join(projectRoot, '.cleo', 'backups', 'schemas');
      expect(existsSync(backupDir)).toBe(true);
      const backups = readdirSync(backupDir);
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatch(/^schemas-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
    });

    it('returns cleaned: false when dir does not exist', async () => {
      const projectRoot = join(tempDir, 'noschemas');
      mkdirSync(join(projectRoot, '.cleo'), { recursive: true });

      const result = await cleanProjectSchemas(projectRoot);
      expect(result.cleaned).toBe(false);
    });

    it('returns cleaned: false when path is a file, not directory', async () => {
      const projectRoot = join(tempDir, 'fileinstead');
      mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
      // Create a file where directory is expected
      writeFileSync(join(projectRoot, '.cleo', 'schemas'), 'not a directory');

      const result = await cleanProjectSchemas(projectRoot);
      expect(result.cleaned).toBe(false);
    });
  });
});
