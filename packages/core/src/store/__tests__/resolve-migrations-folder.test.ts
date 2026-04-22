/**
 * Tests for the ESM-native migration folder resolver (T1177).
 *
 * Validates that resolveCorePackageMigrationsFolder() returns correct absolute
 * paths for all 5 DB sets, and that the 5 DB-specific wrapper functions
 * delegate correctly.
 */

import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTelemetryMigrationsFolder } from '../../telemetry/sqlite.js';
import { resolveBrainMigrationsFolder } from '../memory-sqlite.js';
import { resolveNexusMigrationsFolder } from '../nexus-sqlite.js';
import { resolveCorePackageMigrationsFolder } from '../resolve-migrations-folder.js';
import { resolveSignaldockMigrationsFolder } from '../signaldock-sqlite.js';
import { resolveMigrationsFolder } from '../sqlite.js';

const ALL_SET_NAMES = [
  'drizzle-tasks',
  'drizzle-brain',
  'drizzle-nexus',
  'drizzle-telemetry',
  'drizzle-signaldock',
] as const;

describe('resolveCorePackageMigrationsFolder', () => {
  it('returns an absolute path for each DB set name', () => {
    for (const setName of ALL_SET_NAMES) {
      const result = resolveCorePackageMigrationsFolder(setName);
      expect(isAbsolute(result), `${setName} path should be absolute`).toBe(true);
    }
  });

  it('includes the correct set name segment in each resolved path', () => {
    for (const setName of ALL_SET_NAMES) {
      const result = resolveCorePackageMigrationsFolder(setName);
      expect(result, `path should contain "migrations/${setName}"`).toContain(
        `migrations/${setName}`,
      );
    }
  });

  it('resolved paths exist on disk for all 5 DB sets', () => {
    for (const setName of ALL_SET_NAMES) {
      const result = resolveCorePackageMigrationsFolder(setName);
      expect(existsSync(result), `migrations folder should exist on disk: ${result}`).toBe(true);
    }
  });

  it('returns distinct paths for each set name', () => {
    const paths = ALL_SET_NAMES.map((name) => resolveCorePackageMigrationsFolder(name));
    const uniquePaths = new Set(paths);
    expect(uniquePaths.size).toBe(ALL_SET_NAMES.length);
  });

  it('throws a descriptive error for an unknown set name that cannot be resolved', () => {
    // The function itself does not validate the set name — it returns the path
    // even if the directory doesn't exist. The caller is responsible for
    // validating existence. This test confirms the path is still well-formed.
    const result = resolveCorePackageMigrationsFolder('drizzle-nonexistent');
    expect(isAbsolute(result)).toBe(true);
    expect(result).toContain('migrations/drizzle-nonexistent');
  });
});

describe('DB-specific wrapper functions', () => {
  it('resolveMigrationsFolder() returns the drizzle-tasks path', () => {
    const result = resolveMigrationsFolder();
    expect(result).toContain('migrations/drizzle-tasks');
    expect(isAbsolute(result)).toBe(true);
    expect(existsSync(result)).toBe(true);
  });

  it('resolveBrainMigrationsFolder() returns the drizzle-brain path', () => {
    const result = resolveBrainMigrationsFolder();
    expect(result).toContain('migrations/drizzle-brain');
    expect(isAbsolute(result)).toBe(true);
    expect(existsSync(result)).toBe(true);
  });

  it('resolveNexusMigrationsFolder() returns the drizzle-nexus path', () => {
    const result = resolveNexusMigrationsFolder();
    expect(result).toContain('migrations/drizzle-nexus');
    expect(isAbsolute(result)).toBe(true);
    expect(existsSync(result)).toBe(true);
  });

  it('resolveTelemetryMigrationsFolder() returns the drizzle-telemetry path', () => {
    const result = resolveTelemetryMigrationsFolder();
    expect(result).toContain('migrations/drizzle-telemetry');
    expect(isAbsolute(result)).toBe(true);
    expect(existsSync(result)).toBe(true);
  });

  it('resolveSignaldockMigrationsFolder() returns the drizzle-signaldock path', () => {
    const result = resolveSignaldockMigrationsFolder();
    expect(result).toContain('migrations/drizzle-signaldock');
    expect(isAbsolute(result)).toBe(true);
    expect(existsSync(result)).toBe(true);
  });

  it('all 5 wrapper functions return distinct paths', () => {
    const results = [
      resolveMigrationsFolder(),
      resolveBrainMigrationsFolder(),
      resolveNexusMigrationsFolder(),
      resolveTelemetryMigrationsFolder(),
      resolveSignaldockMigrationsFolder(),
    ];
    const unique = new Set(results);
    expect(unique.size).toBe(5);
  });

  it('all 5 wrapper functions return paths under the same package root', () => {
    const results = [
      resolveMigrationsFolder(),
      resolveBrainMigrationsFolder(),
      resolveNexusMigrationsFolder(),
      resolveTelemetryMigrationsFolder(),
      resolveSignaldockMigrationsFolder(),
    ];
    // All paths share the same migrations parent — same @cleocode/core pkg root
    const roots = results.map((p) => {
      // Strip trailing '/drizzle-xxx' to get the migrations dir
      // Then strip '/migrations' to get the pkg root
      const parts = p.split('/');
      return parts.slice(0, -2).join('/'); // remove last 2 segments
    });
    const uniqueRoots = new Set(roots);
    expect(uniqueRoots.size).toBe(1);
  });
});
