/**
 * Crash-safety tests for T11997.
 *
 * Tests prove atomicity via black-box observable properties:
 *   (a) Config: after `atomicWriteJson`, only valid JSON exists at target path.
 *   (b) Config helpers: `setConfigValue` and `applyStrictnessPreset` create
 *       valid JSON files atomically when the file does not yet exist.
 *   (c) Attachment store ordering: a `put` followed by an immediate
 *       manual deletion of the blob file leaves a detectable orphan row.
 *   (d) Repair routine: `repairAttachmentStore` finds and marks row-without-file
 *       orphans, skips rows with blob files, and deletes unreferenced blobs.
 *   (e) Config repair: `repairConfigFile` quarantines corrupt files and restores
 *       from the newest valid backup.
 *
 * Fault injection uses only synchronous file-system mutations (delete/truncate
 * after a successful write) rather than mocking ESM modules — this avoids the
 * deadlock pattern observed with `vi.spyOn` on dynamic node:fs/promises mocks.
 *
 * @task T11997
 * @epic T11992
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ─── Test harness ──────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-t11997-'));
  process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  process.env['CLEO_HOME'] = tempDir;
});

afterEach(async () => {
  const { closeDb } = await import('../sqlite.js');
  closeDb();
  delete process.env['CLEO_DIR'];
  delete process.env['CLEO_HOME'];
  await rm(tempDir, { recursive: true, force: true });
});

// ─── (a) atomicWriteJson — basic crash-safety property ────────────────────────

describe('atomicWriteJson — crash-safety', () => {
  it('produces valid JSON at the target path', async () => {
    const { atomicWriteJson } = await import('../atomic.js');
    const configPath = join(tempDir, 'config.json');

    await atomicWriteJson(configPath, { version: '1.0.0', nested: { flag: true } });

    expect(existsSync(configPath)).toBe(true);
    const raw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed['version']).toBe('1.0.0');
    expect((parsed['nested'] as Record<string, unknown>)?.['flag']).toBe(true);
  });

  it('overwrites an existing file without leaving tmp artifacts', async () => {
    const { atomicWriteJson } = await import('../atomic.js');
    const configPath = join(tempDir, 'config.json');

    await atomicWriteJson(configPath, { version: '1.0.0' });
    await atomicWriteJson(configPath, { version: '2.0.0' });

    const raw = await readFile(configPath, 'utf-8');
    expect((JSON.parse(raw) as Record<string, unknown>)['version']).toBe('2.0.0');

    // No .tmp artifact should remain
    expect(existsSync(`${configPath}.tmp`)).toBe(false);
  });
});

// ─── (b) setConfigValue and applyStrictnessPreset ─────────────────────────────

describe('setConfigValue — atomic first-write', () => {
  it('creates a valid JSON config file atomically on first write', async () => {
    const { setConfigValue } = await import('../../config.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const configPath = join(tempDir, '.cleo', 'config.json');
    expect(existsSync(configPath)).toBe(false);

    await setConfigValue('output.showColor', true, tempDir);

    expect(existsSync(configPath)).toBe(true);
    const raw = await readFile(configPath, 'utf-8');
    // File must parse as valid JSON — no truncation or corruption
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect((parsed['output'] as Record<string, unknown>)?.['showColor']).toBe(true);
  });

  it('overwrites config atomically and retains all keys', async () => {
    const { setConfigValue } = await import('../../config.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    await setConfigValue('output.showColor', true, tempDir);
    await setConfigValue('output.showUnicode', false, tempDir);

    const configPath = join(tempDir, '.cleo', 'config.json');
    const raw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const output = parsed['output'] as Record<string, unknown>;
    expect(output?.['showColor']).toBe(true);
    expect(output?.['showUnicode']).toBe(false);
  });
});

describe('applyStrictnessPreset — atomic first-write', () => {
  it('creates a valid JSON config file atomically on first write', async () => {
    const { applyStrictnessPreset } = await import('../../config.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const configPath = join(tempDir, '.cleo', 'config.json');
    expect(existsSync(configPath)).toBe(false);

    const result = await applyStrictnessPreset('strict', tempDir);
    expect(result.preset).toBe('strict');

    expect(existsSync(configPath)).toBe(true);
    const raw = await readFile(configPath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

// ─── (c) registry.unsetConfigValue uses atomicWriteJson ───────────────────────

describe('registry.unsetConfigValue — atomic write', () => {
  it('writes updated config as valid JSON', async () => {
    const { unsetConfigValue } = await import('../../config/registry.js');

    const projectRoot = tempDir;
    const cleoDir = join(projectRoot, '.cleo');
    await import('node:fs/promises').then((m) => m.mkdir(cleoDir, { recursive: true }));
    await writeFile(join(cleoDir, 'config.json'), '{"foo":"bar","baz":"qux"}\n', 'utf-8');

    const result = await unsetConfigValue('foo', { projectRoot });
    expect(result.removed).toBe(true);

    const raw = await readFile(join(cleoDir, 'config.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed['foo']).toBeUndefined();
    expect(parsed['baz']).toBe('qux');
  });

  it('is idempotent when key is absent', async () => {
    const { unsetConfigValue } = await import('../../config/registry.js');

    const projectRoot = tempDir;
    const cleoDir = join(projectRoot, '.cleo');
    await import('node:fs/promises').then((m) => m.mkdir(cleoDir, { recursive: true }));
    await writeFile(join(cleoDir, 'config.json'), '{"baz":"qux"}\n', 'utf-8');

    const result = await unsetConfigValue('nonexistent', { projectRoot });
    expect(result.removed).toBe(false);

    // File should be unchanged
    const raw = await readFile(join(cleoDir, 'config.json'), 'utf-8');
    expect((JSON.parse(raw) as Record<string, unknown>)['baz']).toBe('qux');
  });
});

// ─── (d) Repair routine ────────────────────────────────────────────────────────

describe('repairAttachmentStore', () => {
  it('healthy store returns mutated=false with zero actions', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { repairAttachmentStore } = await import('../attachment-repair.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('healthy-blob', 'utf-8');

    await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T11997-healthy',
    );
    closeDb();

    const result = await repairAttachmentStore({ cwd: tempDir, dryRun: false });
    expect(result.rowsWithoutFilesCount).toBe(0);
    expect(result.unreferencedBlobsDeletedCount).toBe(0);
    expect(result.mutated).toBe(false);
    closeDb();
  });

  it('dry-run detects row-without-file orphan without making changes', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { repairAttachmentStore } = await import('../attachment-repair.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('orphan-test', 'utf-8');
    const meta = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T11997-orphan',
    );

    // Simulate crash after row committed but before file written: delete the file
    const sha256 = meta.sha256;
    const cleoDir = join(tempDir, '.cleo');
    const filePath = join(
      cleoDir,
      'attachments',
      'sha256',
      sha256.slice(0, 2),
      `${sha256.slice(2)}.txt`,
    );
    await import('node:fs/promises').then((m) => m.unlink(filePath));
    closeDb();

    // Dry-run should detect but not mutate
    const result = await repairAttachmentStore({ cwd: tempDir, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.rowsWithoutFilesCount).toBe(1);
    expect(result.mutated).toBe(false);
    const action = result.actions.find((a) => a.kind === 'mark-row-without-file');
    expect(action).toBeDefined();
    expect(action?.sha256).toBe(sha256);
    closeDb();
  });

  it('repair marks row-without-file as archived and writes audit log', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { repairAttachmentStore } = await import('../attachment-repair.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('mark-row-test', 'utf-8');
    const meta = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T11997-mark',
    );

    // Delete the on-disk blob to simulate crash
    const sha256 = meta.sha256;
    const cleoDir = join(tempDir, '.cleo');
    const filePath = join(
      cleoDir,
      'attachments',
      'sha256',
      sha256.slice(0, 2),
      `${sha256.slice(2)}.txt`,
    );
    await import('node:fs/promises').then((m) => m.unlink(filePath));
    closeDb();

    const result = await repairAttachmentStore({ cwd: tempDir, dryRun: false });
    expect(result.mutated).toBe(true);
    expect(result.rowsWithoutFilesCount).toBe(1);

    // Audit log should exist
    const auditPath = join(tempDir, '.cleo', 'audit', 'attachment-repair.jsonl');
    expect(existsSync(auditPath)).toBe(true);
    const lines = (await readFile(auditPath, 'utf-8')).trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    expect(entry['event']).toBe('attachment-repair:mark-row-without-file');
    expect(entry['sha256']).toBe(sha256);

    // Verify the DB row was marked archived
    const { getDb } = await import('../sqlite.js');
    const db = await getDb(tempDir);
    const { attachments: attachmentsTable } = await import('../tasks-schema.js');
    const { eq } = await import('drizzle-orm');
    const row = await db
      .select()
      .from(attachmentsTable)
      .where(eq(attachmentsTable.id, meta.id))
      .get();
    expect(row?.lifecycleStatus).toBe('archived');
    expect(row?.summary).toContain('[repair:missing-blob]');
    closeDb();
  });

  it('deletes unreferenced blob older than grace period', async () => {
    const { repairAttachmentStore } = await import('../attachment-repair.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    // Create a blob file with no corresponding DB row
    const cleoDir = join(tempDir, '.cleo');
    const sha256 = 'a'.repeat(64);
    const prefix = sha256.slice(0, 2);
    const rest = sha256.slice(2);
    const blobDir = join(cleoDir, 'attachments', 'sha256', prefix);
    await import('node:fs/promises').then((m) => m.mkdir(blobDir, { recursive: true }));
    const filePath = join(blobDir, `${rest}.bin`);
    await writeFile(filePath, 'orphan-bytes', 'utf-8');

    // Set mtime to far in the past (older than grace period)
    const pastTime = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
    await utimes(filePath, pastTime, pastTime);

    const result = await repairAttachmentStore({
      cwd: tempDir,
      dryRun: false,
      gracePeriodMs: 5 * 60 * 1000, // 5 min grace
    });

    expect(result.unreferencedBlobsDeletedCount).toBe(1);
    expect(existsSync(filePath)).toBe(false);

    // Audit log should record the deletion
    const auditPath = join(tempDir, '.cleo', 'audit', 'attachment-repair.jsonl');
    expect(existsSync(auditPath)).toBe(true);
    closeDb();
  });

  it('skips blob within grace period', async () => {
    const { repairAttachmentStore } = await import('../attachment-repair.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    // Create a fresh blob file with no row
    const cleoDir = join(tempDir, '.cleo');
    const sha256 = 'b'.repeat(64);
    const prefix = sha256.slice(0, 2);
    const rest = sha256.slice(2);
    const blobDir = join(cleoDir, 'attachments', 'sha256', prefix);
    await import('node:fs/promises').then((m) => m.mkdir(blobDir, { recursive: true }));
    const filePath = join(blobDir, `${rest}.bin`);
    await writeFile(filePath, 'fresh-blob', 'utf-8');
    // mtime is now — well within the 5-min grace period

    const result = await repairAttachmentStore({
      cwd: tempDir,
      dryRun: false,
      gracePeriodMs: 5 * 60 * 1000,
    });

    expect(result.gracePeriodSkipCount).toBe(1);
    expect(existsSync(filePath)).toBe(true); // NOT deleted
    closeDb();
  });

  it('repair converges: second run on already-marked row still counts it as row-without-file', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { repairAttachmentStore } = await import('../attachment-repair.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('converge-test', 'utf-8');
    const meta = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T11997-converge',
    );
    const sha256 = meta.sha256;
    const cleoDir = join(tempDir, '.cleo');
    const filePath = join(
      cleoDir,
      'attachments',
      'sha256',
      sha256.slice(0, 2),
      `${sha256.slice(2)}.txt`,
    );
    await import('node:fs/promises').then((m) => m.unlink(filePath));
    closeDb();

    const first = await repairAttachmentStore({ cwd: tempDir, dryRun: false });
    closeDb();
    const second = await repairAttachmentStore({ cwd: tempDir, dryRun: false });
    closeDb();

    // Both runs see 1 row-without-file (file is still missing)
    expect(first.rowsWithoutFilesCount).toBe(1);
    expect(second.rowsWithoutFilesCount).toBe(1);
    // The summary prefix is not doubled on second run
    const { getDb } = await import('../sqlite.js');
    const db = await getDb(tempDir);
    const { attachments: attachmentsTable } = await import('../tasks-schema.js');
    const { eq } = await import('drizzle-orm');
    const row = await db
      .select()
      .from(attachmentsTable)
      .where(eq(attachmentsTable.id, meta.id))
      .get();
    const summaryOccurrences = (row?.summary ?? '').split('[repair:missing-blob]').length - 1;
    expect(summaryOccurrences).toBe(1); // only one prefix, not doubled
    closeDb();
  });
});

// ─── (e) Attachment store tmp+rename ordering (observational) ─────────────────

describe('attachment store — put ordering', () => {
  it('put round-trip succeeds and file exists on disk after commit', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('ordering-test', 'utf-8');

    const meta = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T11997-ordering',
    );

    // File must exist at the expected path after put completes
    const sha256 = meta.sha256;
    const cleoDir = join(tempDir, '.cleo');
    const filePath = join(
      cleoDir,
      'attachments',
      'sha256',
      sha256.slice(0, 2),
      `${sha256.slice(2)}.txt`,
    );
    expect(existsSync(filePath)).toBe(true);

    // And no .tmp artifact should remain
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
    closeDb();
  });

  it('no .tmp artifact remains at final path after successful put', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('no-tmp-test', 'utf-8');

    const meta = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T11997-no-tmp',
    );

    const sha256 = meta.sha256;
    const cleoDir = join(tempDir, '.cleo');
    const blobDir = join(cleoDir, 'attachments', 'sha256', sha256.slice(0, 2));

    // Read all files in the blob dir
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(blobDir);
    const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
    closeDb();
  });

  it('simulated crash (delete file after put) creates detectable orphan for repair', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { repairAttachmentStore } = await import('../attachment-repair.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('orphan-simulation', 'utf-8');
    const meta = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T11997-sim-crash',
    );

    // Simulate crash: row committed but file deleted (old pre-T11997 behaviour)
    const sha256 = meta.sha256;
    const cleoDir = join(tempDir, '.cleo');
    const filePath = join(
      cleoDir,
      'attachments',
      'sha256',
      sha256.slice(0, 2),
      `${sha256.slice(2)}.txt`,
    );
    await import('node:fs/promises').then((m) => m.unlink(filePath));
    closeDb();

    // Repair routine should detect exactly 1 orphan
    const result = await repairAttachmentStore({ cwd: tempDir, dryRun: true });
    expect(result.rowsWithoutFilesCount).toBe(1);
    expect(result.actions[0]?.sha256).toBe(sha256);
    closeDb();
  });

  it('put twice with same content is idempotent and leaves exactly one file', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('dedup-test', 'utf-8');

    const meta1 = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T11997-dedup-1',
    );
    const meta2 = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T11997-dedup-2',
    );

    expect(meta1.sha256).toBe(meta2.sha256);
    expect(meta2.refCount).toBe(2);

    const sha256 = meta1.sha256;
    const cleoDir = join(tempDir, '.cleo');
    const filePath = join(
      cleoDir,
      'attachments',
      'sha256',
      sha256.slice(0, 2),
      `${sha256.slice(2)}.txt`,
    );
    expect(existsSync(filePath)).toBe(true);
    closeDb();
  });
});

// ─── (f) Config repair ────────────────────────────────────────────────────────

describe('repairConfigFile', () => {
  it('returns healthy for a valid config file', async () => {
    const { repairConfigFile } = await import('../../config/config-repair.js');
    const configPath = join(tempDir, 'config.json');
    await writeFile(configPath, '{"version":"1.0.0"}\n', 'utf-8');

    const result = await repairConfigFile(configPath, null, tempDir);
    expect(result.outcome).toBe('healthy');
  });

  it('returns healthy for a missing config file', async () => {
    const { repairConfigFile } = await import('../../config/config-repair.js');
    const configPath = join(tempDir, 'nonexistent.json');

    const result = await repairConfigFile(configPath, null, tempDir);
    expect(result.outcome).toBe('healthy');
  });

  it('restores from backup when config is corrupt JSON', async () => {
    const { repairConfigFile } = await import('../../config/config-repair.js');
    const configPath = join(tempDir, 'config.json');
    const backupDir = join(tempDir, 'backups');

    // Write a corrupt config
    await writeFile(configPath, 'NOT_VALID_JSON', 'utf-8');

    // Write a valid backup (.1 = newest)
    await import('node:fs/promises').then((m) => m.mkdir(backupDir, { recursive: true }));
    await writeFile(join(backupDir, 'config.json.1'), '{"version":"0.9.0"}\n', 'utf-8');

    const result = await repairConfigFile(configPath, backupDir, tempDir);
    expect(result.outcome).toBe('restored-from-backup');
    expect(result.restoredFrom).toBeTruthy();

    // The config file should now be valid JSON
    const raw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed['version']).toBe('0.9.0');

    // Audit log must exist
    const auditPath = join(tempDir, '.cleo', 'audit', 'config-repair.jsonl');
    expect(existsSync(auditPath)).toBe(true);
  });

  it('quarantines corrupt config when no backup exists', async () => {
    const { repairConfigFile } = await import('../../config/config-repair.js');
    const configPath = join(tempDir, 'config.json');

    await writeFile(configPath, '{CORRUPT', 'utf-8');

    const result = await repairConfigFile(configPath, null, tempDir);
    expect(result.outcome).toBe('quarantined-no-candidate');
    expect(result.quarantinedTo).toBeTruthy();
    expect(existsSync(result.quarantinedTo!)).toBe(true);

    // A fallback empty config should now be at the original path
    const raw = await readFile(configPath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('restores from surviving .tmp file (completed but not renamed)', async () => {
    const { repairConfigFile } = await import('../../config/config-repair.js');
    const configPath = join(tempDir, 'config.json');
    const tmpPath = `${configPath}.tmp`;

    // Corrupt the live file, leave a valid .tmp (very old, not an active write)
    await writeFile(configPath, 'BAD_JSON', 'utf-8');
    await writeFile(tmpPath, '{"version":"recovered"}\n', 'utf-8');

    // Make the .tmp file old (older than TMP_SURVIVOR_MAX_AGE_MS = 1 min)
    const oldTime = new Date(Date.now() - 2 * 60 * 1000);
    await utimes(tmpPath, oldTime, oldTime);

    const result = await repairConfigFile(configPath, null, tempDir);
    expect(result.outcome).toBe('restored-from-tmp');
    expect(result.restoredFrom).toBe(tmpPath);

    const raw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed['version']).toBe('recovered');
  });

  it('skips restore when .tmp is too new (active write window)', async () => {
    const { repairConfigFile } = await import('../../config/config-repair.js');
    const configPath = join(tempDir, 'config.json');
    const tmpPath = `${configPath}.tmp`;

    await writeFile(configPath, 'BAD_JSON', 'utf-8');
    // Write a fresh .tmp file — simulates an active write in progress
    await writeFile(tmpPath, '{"version":"in-progress"}\n', 'utf-8');
    // mtime is now — within the 60s window

    const result = await repairConfigFile(configPath, null, tempDir);
    expect(result.outcome).toBe('skipped-active-write');
  });

  it('selects newest valid backup over an older corrupt backup', async () => {
    const { repairConfigFile } = await import('../../config/config-repair.js');
    const configPath = join(tempDir, 'config.json');
    const backupDir = join(tempDir, 'backups');

    await writeFile(configPath, 'CORRUPT', 'utf-8');
    await import('node:fs/promises').then((m) => m.mkdir(backupDir, { recursive: true }));

    // .1 is newest but corrupt, .2 is older and valid
    await writeFile(join(backupDir, 'config.json.1'), 'ALSO_CORRUPT', 'utf-8');
    await writeFile(join(backupDir, 'config.json.2'), '{"version":"fallback"}\n', 'utf-8');

    const result = await repairConfigFile(configPath, backupDir, tempDir);
    expect(result.outcome).toBe('restored-from-backup');
    expect(result.restoredFrom).toContain('config.json.2');

    const raw = await readFile(configPath, 'utf-8');
    expect((JSON.parse(raw) as Record<string, unknown>)['version']).toBe('fallback');
  });

  it('writes audit record for every repair action', async () => {
    const { repairConfigFile } = await import('../../config/config-repair.js');
    const configPath = join(tempDir, 'config.json');
    const backupDir = join(tempDir, 'backups');
    const auditPath = join(tempDir, '.cleo', 'audit', 'config-repair.jsonl');

    await writeFile(configPath, 'CORRUPT', 'utf-8');
    await import('node:fs/promises').then((m) => m.mkdir(backupDir, { recursive: true }));
    await writeFile(join(backupDir, 'config.json.1'), '{"version":"backup"}\n', 'utf-8');

    await repairConfigFile(configPath, backupDir, tempDir);

    expect(existsSync(auditPath)).toBe(true);
    const raw = await readFile(auditPath, 'utf-8');
    const entries = raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(
      entries.some((e) => typeof e['event'] === 'string' && e['event'].includes('repair')),
    ).toBe(true);
  });
});

// ─── (g) File stat — no .tmp artifacts survive ────────────────────────────────

describe('no lingering .tmp artifacts', () => {
  it('atomicWriteJson leaves no .tmp at target path', async () => {
    const { atomicWriteJson } = await import('../atomic.js');
    const configPath = join(tempDir, 'clean.json');

    await atomicWriteJson(configPath, { x: 1 });

    // Check no .tmp next to the file
    const dirEntries = await import('node:fs/promises').then((m) => m.readdir(tempDir));
    const tmps = dirEntries.filter((e) => e.endsWith('.tmp') || e.endsWith('.tmp~'));
    expect(tmps).toHaveLength(0);
  });

  it('setConfigValue creates .cleo dir and config without leaving .tmp', async () => {
    const { setConfigValue } = await import('../../config.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    await setConfigValue('foo', 'bar', tempDir);

    const cleoDir = join(tempDir, '.cleo');
    const cleoEntries = await import('node:fs/promises').then((m) => m.readdir(cleoDir));
    const tmps = cleoEntries.filter((e) => e.endsWith('.tmp') || e.endsWith('.tmp~'));
    expect(tmps).toHaveLength(0);
    closeDb();
  });
});

// ─── (h) attachment store — stat confirms file sizes after put ─────────────────

describe('attachment store — file integrity after put', () => {
  it('stored file has expected size matching the buffer', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const content = 'Hello, T11997 crash-safety!';
    const bytes = Buffer.from(content, 'utf-8');

    const meta = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T11997-size-check',
    );

    const sha256 = meta.sha256;
    const cleoDir = join(tempDir, '.cleo');
    const filePath = join(
      cleoDir,
      'attachments',
      'sha256',
      sha256.slice(0, 2),
      `${sha256.slice(2)}.txt`,
    );

    const fileStat = await stat(filePath);
    expect(fileStat.size).toBe(bytes.length);
    closeDb();
  });
});
