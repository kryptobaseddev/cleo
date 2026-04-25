/**
 * Tests for backup-pack.ts (T347).
 *
 * Covers: bundle creation, manifest.json as first tar entry, manifest field
 * correctness, checksums.sha256 coverage, database SHA-256 + size entries,
 * encrypted bundle magic header, validation errors, and scope filtering.
 *
 * Uses real node:sqlite DatabaseSync to seed minimal test databases.
 * All filesystem interactions occur in temp directories; the real user's
 * project root is never touched.
 *
 * @task T347
 * @epic T311
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { extract as tarExtract, list as tarList } from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packBundle } from '../backup-pack.js';

// ---------------------------------------------------------------------------
// node:sqlite interop
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal SQLite database with one table and one row at the given path.
 */
function createMinimalDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);');
  db.close();
}

/**
 * Seed a project root with the minimal .cleo layout required by packBundle.
 * Creates: tasks.db, brain.db, conduit.db, config.json, project-info.json,
 * project-context.json.
 */
function seedProject(projectRoot: string): void {
  const cleoDir = path.join(projectRoot, '.cleo');
  fs.mkdirSync(cleoDir, { recursive: true });
  for (const name of ['tasks', 'brain', 'conduit']) {
    createMinimalDb(path.join(cleoDir, `${name}.db`));
  }
  fs.writeFileSync(path.join(cleoDir, 'config.json'), JSON.stringify({ projectRoot }));
  fs.writeFileSync(
    path.join(cleoDir, 'project-info.json'),
    JSON.stringify({ name: 'test-project' }),
  );
  fs.writeFileSync(path.join(cleoDir, 'project-context.json'), JSON.stringify({ env: 'test' }));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('T347 backup-pack', () => {
  let tmpRoot: string;
  let outputDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-t347-root-'));
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-t347-out-'));
    seedProject(tmpRoot);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Basic bundle creation
  // -------------------------------------------------------------------------

  it('creates a project-scope bundle at the output path', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    const result = await packBundle({
      scope: 'project',
      projectRoot: tmpRoot,
      outputPath: bundlePath,
    });
    expect(result.bundlePath).toBe(bundlePath);
    expect(fs.existsSync(bundlePath)).toBe(true);
    expect(result.size).toBeGreaterThan(0);
  });

  it('result.size matches the actual file size on disk', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    const result = await packBundle({
      scope: 'project',
      projectRoot: tmpRoot,
      outputPath: bundlePath,
    });
    const diskSize = fs.statSync(bundlePath).size;
    expect(result.size).toBe(diskSize);
  });

  // -------------------------------------------------------------------------
  // Archive structure
  // -------------------------------------------------------------------------

  it('bundle contains manifest.json, schemas/, databases/, json/, checksums.sha256', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    await packBundle({ scope: 'project', projectRoot: tmpRoot, outputPath: bundlePath });

    const entries: string[] = [];
    await tarList({
      file: bundlePath,
      onReadEntry: (entry) => entries.push(entry.path),
    });

    expect(entries).toContain('manifest.json');
    expect(entries.some((e) => e.startsWith('schemas/'))).toBe(true);
    expect(entries.some((e) => e.startsWith('databases/'))).toBe(true);
    expect(entries.some((e) => e.startsWith('json/'))).toBe(true);
    expect(entries).toContain('checksums.sha256');
  });

  it('manifest.json is the first tar entry', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    await packBundle({ scope: 'project', projectRoot: tmpRoot, outputPath: bundlePath });

    const entries: string[] = [];
    await tarList({
      file: bundlePath,
      onReadEntry: (entry) => entries.push(entry.path),
    });
    expect(entries[0]).toBe('manifest.json');
  });

  // -------------------------------------------------------------------------
  // Manifest field correctness
  // -------------------------------------------------------------------------

  it('manifest.backup.scope matches input scope', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    const result = await packBundle({
      scope: 'project',
      projectRoot: tmpRoot,
      outputPath: bundlePath,
    });
    expect(result.manifest.backup.scope).toBe('project');
  });

  it('manifest.$schema is "./schemas/manifest-v1.json"', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    const result = await packBundle({
      scope: 'project',
      projectRoot: tmpRoot,
      outputPath: bundlePath,
    });
    expect(result.manifest.$schema).toBe('./schemas/manifest-v1.json');
  });

  it('manifest.manifestVersion is "1.0.0"', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    const result = await packBundle({
      scope: 'project',
      projectRoot: tmpRoot,
      outputPath: bundlePath,
    });
    expect(result.manifest.manifestVersion).toBe('1.0.0');
  });

  it('manifest.integrity.algorithm is "sha256"', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    const result = await packBundle({
      scope: 'project',
      projectRoot: tmpRoot,
      outputPath: bundlePath,
    });
    expect(result.manifest.integrity.algorithm).toBe('sha256');
  });

  it('manifest.integrity.checksumsFile is "checksums.sha256"', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    const result = await packBundle({
      scope: 'project',
      projectRoot: tmpRoot,
      outputPath: bundlePath,
    });
    expect(result.manifest.integrity.checksumsFile).toBe('checksums.sha256');
  });

  it('manifest.integrity.manifestHash is a 64-char hex string', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    const result = await packBundle({
      scope: 'project',
      projectRoot: tmpRoot,
      outputPath: bundlePath,
    });
    expect(result.manifest.integrity.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('manifest.backup.encrypted is false when not encrypting', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    const result = await packBundle({
      scope: 'project',
      projectRoot: tmpRoot,
      outputPath: bundlePath,
    });
    expect(result.manifest.backup.encrypted).toBe(false);
  });

  it('manifest.backup.encrypted is true when encrypting', async () => {
    const bundlePath = path.join(outputDir, 'test.enc.cleobundle.tar.gz');
    const result = await packBundle({
      scope: 'project',
      projectRoot: tmpRoot,
      outputPath: bundlePath,
      encrypt: true,
      passphrase: 'test-pass',
    });
    expect(result.manifest.backup.encrypted).toBe(true);
  });

  it('manifest.backup.projectName is set when provided', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    const result = await packBundle({
      scope: 'project',
      projectRoot: tmpRoot,
      outputPath: bundlePath,
      projectName: 'my-test-project',
    });
    expect(result.manifest.backup.projectName).toBe('my-test-project');
  });

  it('manifest.backup.machineFingerprint is a 64-char hex string', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    const result = await packBundle({
      scope: 'project',
      projectRoot: tmpRoot,
      outputPath: bundlePath,
    });
    expect(result.manifest.backup.machineFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('manifest.backup.projectFingerprint is a 64-char hex for project scope', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    const result = await packBundle({
      scope: 'project',
      projectRoot: tmpRoot,
      outputPath: bundlePath,
    });
    expect(result.manifest.backup.projectFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  // -------------------------------------------------------------------------
  // Database manifest entries
  // -------------------------------------------------------------------------

  it('manifest.databases has at least 3 entries for project scope', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    const result = await packBundle({
      scope: 'project',
      projectRoot: tmpRoot,
      outputPath: bundlePath,
    });
    expect(result.manifest.databases.length).toBeGreaterThanOrEqual(3);
  });

  it('manifest.databases entries each have a valid sha256 and positive size', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    const result = await packBundle({
      scope: 'project',
      projectRoot: tmpRoot,
      outputPath: bundlePath,
    });
    for (const entry of result.manifest.databases) {
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.size).toBeGreaterThan(0);
    }
  });

  it('manifest.databases entries include tasks, brain, conduit for project scope', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    const result = await packBundle({
      scope: 'project',
      projectRoot: tmpRoot,
      outputPath: bundlePath,
    });
    const names = result.manifest.databases.map((d) => d.name);
    expect(names).toContain('tasks');
    expect(names).toContain('brain');
    expect(names).toContain('conduit');
  });

  it('manifest.databases entries include rowCounts', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    const result = await packBundle({
      scope: 'project',
      projectRoot: tmpRoot,
      outputPath: bundlePath,
    });
    for (const entry of result.manifest.databases) {
      expect(entry.rowCounts).toBeDefined();
    }
  });

  // -------------------------------------------------------------------------
  // JSON manifest entries
  // -------------------------------------------------------------------------

  it('manifest.json entries include config.json, project-info.json, project-context.json', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    const result = await packBundle({
      scope: 'project',
      projectRoot: tmpRoot,
      outputPath: bundlePath,
    });
    const filenames = result.manifest.json.map((j) => j.filename);
    expect(filenames).toContain('json/config.json');
    expect(filenames).toContain('json/project-info.json');
    expect(filenames).toContain('json/project-context.json');
  });

  // -------------------------------------------------------------------------
  // Checksums file
  // -------------------------------------------------------------------------

  it('checksums.sha256 contains entries for databases and json files', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    await packBundle({ scope: 'project', projectRoot: tmpRoot, outputPath: bundlePath });

    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-t347-extract-'));
    try {
      await tarExtract({ file: bundlePath, cwd: extractDir });
      const checksumContent = fs.readFileSync(path.join(extractDir, 'checksums.sha256'), 'utf-8');
      expect(checksumContent).toMatch(/databases\/tasks\.db/);
      expect(checksumContent).toMatch(/databases\/brain\.db/);
      expect(checksumContent).toMatch(/databases\/conduit\.db/);
      expect(checksumContent).toMatch(/json\/config\.json/);
      expect(checksumContent).toMatch(/json\/project-info\.json/);
      expect(checksumContent).toMatch(/json\/project-context\.json/);
    } finally {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  });

  it('checksums.sha256 does NOT contain an entry for manifest.json', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    await packBundle({ scope: 'project', projectRoot: tmpRoot, outputPath: bundlePath });

    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-t347-extract2-'));
    try {
      await tarExtract({ file: bundlePath, cwd: extractDir });
      const checksumContent = fs.readFileSync(path.join(extractDir, 'checksums.sha256'), 'utf-8');
      // manifest.json must NOT appear in checksums (covered by manifestHash)
      expect(checksumContent).not.toMatch(/^[a-f0-9]{64} {2}manifest\.json/m);
    } finally {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  });

  it('checksums.sha256 entries use GNU format: "<hash>  <path>"', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    await packBundle({ scope: 'project', projectRoot: tmpRoot, outputPath: bundlePath });

    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-t347-extract3-'));
    try {
      await tarExtract({ file: bundlePath, cwd: extractDir });
      const checksumContent = fs.readFileSync(path.join(extractDir, 'checksums.sha256'), 'utf-8');
      const lines = checksumContent.trim().split('\n');
      // Every non-empty line must match: 64 hex chars + two spaces + relative path
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        expect(line).toMatch(/^[a-f0-9]{64} {2}\S+/);
      }
    } finally {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Encryption
  // -------------------------------------------------------------------------

  it('encrypted bundle has magic header "CLEOENC1"', async () => {
    const bundlePath = path.join(outputDir, 'test.enc.cleobundle.tar.gz');
    await packBundle({
      scope: 'project',
      projectRoot: tmpRoot,
      outputPath: bundlePath,
      encrypt: true,
      passphrase: 'test-phrase',
    });
    const header = fs.readFileSync(bundlePath).subarray(0, 8);
    expect(header.toString('utf8')).toBe('CLEOENC1');
  });

  it('throws when encrypt=true without passphrase', async () => {
    await expect(
      packBundle({
        scope: 'project',
        projectRoot: tmpRoot,
        outputPath: path.join(outputDir, 'x.enc.cleobundle.tar.gz'),
        encrypt: true,
      }),
    ).rejects.toThrow(/passphrase/);
  });

  // -------------------------------------------------------------------------
  // Validation errors
  // -------------------------------------------------------------------------

  it('throws when scope is "project" but projectRoot is not provided', async () => {
    await expect(
      packBundle({
        scope: 'project',
        outputPath: path.join(outputDir, 'x.cleobundle.tar.gz'),
      }),
    ).rejects.toThrow(/projectRoot/);
  });

  // -------------------------------------------------------------------------
  // Staging cleanup
  // -------------------------------------------------------------------------

  it('cleans up the staging dir even on success', async () => {
    // This test exercises the normal success path; we verify there are no
    // stale cleo-pack-* directories in os.tmpdir() after the call.
    //
    // T1434: under parallel test runs (multiple vitest workers running
    // packBundle concurrently across this and sibling describe blocks),
    // sibling tests' staging dirs can transiently appear in os.tmpdir()
    // between our pre-snapshot and post-snapshot. To avoid spurious
    // failures from interleaved sibling work, we capture the set of
    // pre-existing dirs and the dirs present after our packBundle call,
    // then check that any dir we saw post-call which was created during
    // OUR packBundle (i.e., wasn't preExisting) is also no longer present
    // by the time we record the final state. We do that by re-reading
    // tmpdir a second time after a microtask boundary so any sibling
    // workers that allocated mid-call have a chance to clean up too.
    const preExisting = new Set(
      fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('cleo-pack-')),
    );

    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    await packBundle({ scope: 'project', projectRoot: tmpRoot, outputPath: bundlePath });

    // Allow sibling workers' pending cleanups to settle (microtask + 50ms
    // grace period for fs flush under heavy parallel-test load).
    await new Promise((resolve) => setTimeout(resolve, 50));

    const postCall = fs
      .readdirSync(os.tmpdir())
      .filter((n) => n.startsWith('cleo-pack-'))
      .filter((d) => !preExisting.has(d));

    // After our call returns and any concurrent siblings have settled,
    // there should be no staging dirs we left behind. We do not assert
    // about dirs created+deleted by siblings during our call because
    // those are the sibling's responsibility, not ours.
    //
    // To remain robust, we additionally verify by re-scanning after a
    // second 50ms grace and only fail if the post-call dirs persist.
    if (postCall.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const persistent = fs
        .readdirSync(os.tmpdir())
        .filter((n) => n.startsWith('cleo-pack-'))
        .filter((d) => postCall.includes(d));
      expect(persistent).toHaveLength(0);
    } else {
      expect(postCall).toHaveLength(0);
    }
  });

  // -------------------------------------------------------------------------
  // Manifest JSON schema conformance (shape check)
  // -------------------------------------------------------------------------

  it('manifest conforms to expected top-level shape', async () => {
    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    const result = await packBundle({
      scope: 'project',
      projectRoot: tmpRoot,
      outputPath: bundlePath,
    });
    const m = result.manifest;
    expect(m.$schema).toBe('./schemas/manifest-v1.json');
    expect(m.manifestVersion).toBe('1.0.0');
    expect(typeof m.backup.createdAt).toBe('string');
    expect(typeof m.backup.createdBy).toBe('string');
    expect(Array.isArray(m.databases)).toBe(true);
    expect(Array.isArray(m.json)).toBe(true);
    expect(typeof m.integrity).toBe('object');
    expect(m.integrity.algorithm).toBe('sha256');
  });

  // -------------------------------------------------------------------------
  // Missing source files — graceful skip
  // -------------------------------------------------------------------------

  it('skips missing conduit.db without throwing', async () => {
    // Remove conduit.db to simulate a project where it was not created
    const cleoDir = path.join(tmpRoot, '.cleo');
    fs.unlinkSync(path.join(cleoDir, 'conduit.db'));

    const bundlePath = path.join(outputDir, 'test.cleobundle.tar.gz');
    // Should not throw — missing file is skipped with a warning
    const result = await packBundle({
      scope: 'project',
      projectRoot: tmpRoot,
      outputPath: bundlePath,
    });
    const names = result.manifest.databases.map((d) => d.name);
    expect(names).not.toContain('conduit');
    expect(names).toContain('tasks');
    expect(names).toContain('brain');
  });
});
