/**
 * Contract tests for the CLEO database inventory SSoT.
 *
 * Asserts the structural invariants the inventory MUST hold:
 *
 * 1. Every {@link DbInventoryEntry.role} is unique across the array.
 * 2. Every {@link DbInventoryEntry.tier} is a valid member of the
 *    {@link DbTier} union.
 * 3. Every non-null {@link DbInventoryEntry.drizzleSchemaPath} resolves
 *    to a real file on disk relative to the monorepo root.
 * 4. Every non-null {@link DbInventoryEntry.migrationsDir} resolves to a
 *    real directory on disk relative to the monorepo root.
 * 5. The list is non-empty and covers the AC1-mandated role set.
 *
 * These invariants are the gating contract for downstream saga tasks
 * (T10307 fleet survey, T10310 pragma drift, T10311 migration coverage,
 * T10312 doctor integrity, T10320 cross-DB invariants). If this suite
 * fails, the inventory has drifted from disk reality and CI MUST block.
 *
 * @task T10305
 * @epic T10282
 * @saga T10281
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DB_INVENTORY, type DbInventoryEntry, type DbTier } from '../db-inventory.js';

/**
 * Resolve the monorepo root from this test file.
 *
 * `__tests__/db-inventory.test.ts` lives at
 * `packages/contracts/src/__tests__/` — four levels above the repo root.
 */
const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), '..', '..', '..', '..');

const VALID_TIERS: ReadonlySet<DbTier> = new Set<DbTier>(['project', 'global', 'derived']);

/**
 * Roles AC1 of T10305 explicitly requires the inventory to enumerate.
 * The set must be covered exactly; extras are acceptable when documented.
 */
const REQUIRED_ROLES: readonly string[] = [
  'tasks',
  'brain',
  'conduit',
  'manifest',
  'llmtxt',
  'nexus',
  'signaldock-project',
  'signaldock-global',
  'telemetry',
  'skills',
  'global-brain',
  'global-tasks',
];

describe('CLEO database inventory (T10305 SSoT)', () => {
  it('is non-empty', () => {
    expect(DB_INVENTORY.length).toBeGreaterThan(0);
  });

  it('covers every role required by T10305 AC1', () => {
    const seen = new Set<string>(DB_INVENTORY.map((e) => e.role));
    for (const role of REQUIRED_ROLES) {
      expect(seen.has(role), `inventory missing role '${role}'`).toBe(true);
    }
  });

  it('has unique role IDs across all entries', () => {
    const roles = DB_INVENTORY.map((e) => e.role);
    const unique = new Set(roles);
    expect(unique.size).toBe(roles.length);
  });

  it('uses only valid tier literals', () => {
    for (const entry of DB_INVENTORY) {
      expect(
        VALID_TIERS.has(entry.tier),
        `role '${entry.role}' has invalid tier '${entry.tier}'`,
      ).toBe(true);
    }
  });

  it('uses valid path tokens in filePathTemplate', () => {
    // Project tier MUST use <projectRoot>/ prefix; global tier MUST use
    // $XDG_DATA_HOME/cleo/ prefix. Derived tier may use either.
    for (const entry of DB_INVENTORY) {
      const t = entry.filePathTemplate;
      if (entry.tier === 'project') {
        expect(
          t.startsWith('<projectRoot>/'),
          `project-tier entry '${entry.role}' uses non-canonical path '${t}'`,
        ).toBe(true);
      } else if (entry.tier === 'global') {
        expect(
          t.startsWith('$XDG_DATA_HOME/cleo/'),
          `global-tier entry '${entry.role}' uses non-canonical path '${t}'`,
        ).toBe(true);
      }
    }
  });

  it('resolves every non-null drizzleSchemaPath to a real file', () => {
    for (const entry of DB_INVENTORY) {
      if (entry.drizzleSchemaPath === null) continue;
      const absolutePath = resolve(REPO_ROOT, entry.drizzleSchemaPath);
      expect(
        existsSync(absolutePath),
        `role '${entry.role}' schema path missing: ${entry.drizzleSchemaPath}`,
      ).toBe(true);
      expect(
        statSync(absolutePath).isFile(),
        `role '${entry.role}' schema path is not a file: ${entry.drizzleSchemaPath}`,
      ).toBe(true);
    }
  });

  it('resolves every non-null migrationsDir to a real directory', () => {
    for (const entry of DB_INVENTORY) {
      if (entry.migrationsDir === null) continue;
      const absolutePath = resolve(REPO_ROOT, entry.migrationsDir);
      expect(
        existsSync(absolutePath),
        `role '${entry.role}' migrations dir missing: ${entry.migrationsDir}`,
      ).toBe(true);
      expect(
        statSync(absolutePath).isDirectory(),
        `role '${entry.role}' migrations path is not a directory: ${entry.migrationsDir}`,
      ).toBe(true);
    }
  });

  it('omits migrationsDir only for derived or reserved roles', () => {
    // A null migrationsDir is only valid for:
    //  - derived tier (schema owned by upstream lib — e.g. manifest)
    //  - reserved roles whose opener throws not-yet-implemented (e.g. llmtxt)
    for (const entry of DB_INVENTORY) {
      if (entry.migrationsDir !== null) continue;
      const isDerived = entry.tier === 'derived';
      const isReserved = /reserved|not yet implemented/i.test(entry.openedVia);
      expect(
        isDerived || isReserved,
        `role '${entry.role}' has null migrationsDir but is neither derived nor reserved`,
      ).toBe(true);
    }
  });

  it('exposes a readonly array type at compile time', () => {
    // Compile-time check: assigning to an index must be rejected.
    // Runtime check: Object.isFrozen is not guaranteed by `readonly` but the
    // type-system reject is the primary defence. We only assert the runtime
    // shape is array-like here.
    expect(Array.isArray(DB_INVENTORY)).toBe(true);
  });

  it('keeps each entry self-consistent (sample-fields populated)', () => {
    // Sanity: every entry must populate the structural fields. The contract
    // forbids `null` placeholders on non-optional fields.
    const sampleRequiredKeys: ReadonlyArray<keyof DbInventoryEntry> = [
      'role',
      'tier',
      'filePathTemplate',
      'ownerPackage',
      'openedVia',
      'concurrency',
      'privacy',
      'backupPath',
      'documentedIn',
    ];
    for (const entry of DB_INVENTORY) {
      for (const key of sampleRequiredKeys) {
        const value = entry[key];
        expect(
          typeof value === 'string' && value.length > 0,
          `role '${entry.role}' field '${String(key)}' is empty or non-string`,
        ).toBe(true);
      }
    }
  });
});
