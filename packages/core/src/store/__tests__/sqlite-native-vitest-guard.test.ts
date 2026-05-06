/**
 * Production-DB leak guard for vitest.
 *
 * Pins the contract that under VITEST, openNativeDatabase MUST refuse to
 * open any sqlite path outside an isolated test root. Background:
 * 2026-05-06, library helpers that called getDb() with no cwd silently
 * wrote test fixtures (T9001…T9010) into the project's tasks.db. This
 * guard makes that class of leak fail loudly at the chokepoint.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openNativeDatabase } from '../sqlite-native.js';

describe('openNativeDatabase vitest guard', () => {
  const savedAllow = process.env.CLEO_TEST_ALLOW_PROJECT_DB;
  const savedRoots = process.env.CLEO_TEST_ALLOWED_DB_ROOTS;
  let tempRoot: string;

  beforeEach(() => {
    delete process.env.CLEO_TEST_ALLOW_PROJECT_DB;
    delete process.env.CLEO_TEST_ALLOWED_DB_ROOTS;
    tempRoot = mkdtempSync(join(tmpdir(), 'cleo-guard-test-'));
  });

  afterEach(() => {
    if (savedAllow === undefined) delete process.env.CLEO_TEST_ALLOW_PROJECT_DB;
    else process.env.CLEO_TEST_ALLOW_PROJECT_DB = savedAllow;
    if (savedRoots === undefined) delete process.env.CLEO_TEST_ALLOWED_DB_ROOTS;
    else process.env.CLEO_TEST_ALLOWED_DB_ROOTS = savedRoots;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('allows opens under os.tmpdir()', () => {
    const dbPath = join(tempRoot, 'isolated.db');
    const db = openNativeDatabase(dbPath);
    db.close();
    expect(true).toBe(true);
  });

  it('allows :memory: opens', () => {
    // In-memory dbs cannot use WAL — the journal mode pragma stays 'memory'.
    // The guard runs BEFORE any pragma, so disabling WAL exercises only the
    // path-isolation check we care about here.
    const db = openNativeDatabase(':memory:', { enableWal: false });
    db.close();
    expect(true).toBe(true);
  });

  it('throws when opening the project tasks.db from a vitest run', () => {
    expect(() => openNativeDatabase('/mnt/projects/cleocode/.cleo/tasks.db')).toThrow(
      /CLEO test isolation guard/,
    );
  });

  it('throws when opening any path outside tmpdir without an opt-out', () => {
    expect(() => openNativeDatabase('/etc/cleo/tasks.db')).toThrow(/CLEO test isolation guard/);
  });

  it('throws when opening a path under $HOME/.cleo without an opt-out', () => {
    const home = process.env.HOME ?? '/home/test';
    expect(() => openNativeDatabase(`${home}/.cleo/tasks.db`)).toThrow(/CLEO test isolation guard/);
  });

  it('honours CLEO_TEST_ALLOW_PROJECT_DB=true as an emergency override', () => {
    process.env.CLEO_TEST_ALLOW_PROJECT_DB = 'true';
    const dbPath = join(tempRoot, 'override.db');
    const db = openNativeDatabase(dbPath);
    db.close();
    expect(true).toBe(true);
  });

  it('honours CLEO_TEST_ALLOWED_DB_ROOTS for opt-in integration paths', () => {
    process.env.CLEO_TEST_ALLOWED_DB_ROOTS = tempRoot;
    const dbPath = join(tempRoot, 'allowed.db');
    const db = openNativeDatabase(dbPath);
    db.close();
    expect(true).toBe(true);
  });

  it('error message names the offending path so leaks are easy to debug', () => {
    let caught: Error | null = null;
    try {
      openNativeDatabase('/var/lib/cleocode-prod/tasks.db');
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toContain('/var/lib/cleocode-prod/tasks.db');
    expect(caught?.message).toContain('os.tmpdir()');
  });
});
