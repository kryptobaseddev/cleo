import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectBackupObservation } from '../backup-inspect.js';
import * as snapshots from '../open-cleo-db.js';

const ID = 'O-mspmgvbg-0';
let root: string;
let source: string;

function fixture(sql: string): void {
  const db = new DatabaseSync(source);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

function sourceIdentity() {
  const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOATIME);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const stat = fs.statSync(source, { bigint: true });
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    atime: stat.atimeNs,
    mtime: stat.mtimeNs,
    ctime: stat.ctimeNs,
    size: stat.size,
    directory: fs.readdirSync(root).sort(),
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), 'snapshot-inspect-fixture-'));
  source = path.join(root, 'tasks-20260919-120000.db');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('exact read-only observation snapshot inspection', () => {
  it('preserves authentic SQLite bytes, source metadata and legacy label beside an empty decoy', async () => {
    fixture(`
      PRAGMA user_version=42;
      CREATE TABLE observations(id TEXT PRIMARY KEY, narrative TEXT);
      CREATE TABLE brain_observations(id TEXT PRIMARY KEY, narrative TEXT, title TEXT, number INTEGER, fraction REAL, payload BLOB, optional TEXT, project TEXT);
      INSERT INTO brain_observations VALUES ('${ID}', 'Literal | text — 日本語', CAST(X'80ff' AS TEXT), 9223372036854775807, 1.25, X'00ff7c', NULL, 'unverified-project-label');
      INSERT INTO brain_observations(id,narrative) VALUES ('${ID}-similar','not the requested record');
    `);
    fs.utimesSync(source, new Date('2001-01-01'), new Date('2002-01-01'));
    const before = sourceIdentity();
    const result = await inspectBackupObservation({
      snapshotPath: source,
      recordId: ID,
      label: 'tasks legacy backup',
      expectedProjectId: 'expected-project',
    });
    expect(result.status).toBe('found');
    expect(result.inspectedTables).toEqual(['brain_observations', 'observations']);
    expect(result.userVersion).toBe(42);
    expect(result.source).toMatchObject({
      path: source,
      label: 'tasks legacy backup',
      sha256: before.sha256,
      atimeNs: before.atime.toString(),
      atimeAfterNs: before.atime.toString(),
      atimeChanged: false,
    });
    expect(result.projectIdentity).toEqual({
      expected: 'expected-project',
      recorded: null,
      status: 'unknown',
      evidence: null,
    });
    expect(result.record?.table).toBe('brain_observations');
    expect(result.record?.payload).toMatchObject({
      narrative: {
        type: 'text',
        bytesBase64: Buffer.from('Literal | text — 日本語').toString('base64'),
      },
      title: { type: 'text', bytesBase64: 'gP8=' },
      number: { type: 'integer', decimal: '9223372036854775807' },
      fraction: { type: 'real', ieee754Hex: '3ff4000000000000' },
      payload: { type: 'blob', bytesBase64: 'AP98' },
      optional: { type: 'null' },
    });
    const entries = Object.entries(result.record!.payload).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    expect(result.record?.payloadSha256).toBe(
      createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    );
    expect(sourceIdentity()).toEqual(before);
  });

  it('reports access-only changes from another reader without rejecting authentic payload', async () => {
    fixture(
      `CREATE TABLE observations(id TEXT PRIMARY KEY, narrative TEXT); INSERT INTO observations VALUES ('${ID}', 'authentic payload');`,
    );
    fs.utimesSync(source, new Date('2001-01-01'), new Date('2002-01-01'));
    const before = sourceIdentity();
    const open = fs.promises.open;
    let externalRead = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (args[1] === 'wx') {
        fs.readFileSync(source);
        externalRead = true;
      }
      return open(...args);
    });
    const result = await inspectBackupObservation({ snapshotPath: source, recordId: ID });
    const after = sourceIdentity();
    expect(externalRead).toBe(true);
    expect(after.atime).not.toBe(before.atime);
    expect({ ...after, atime: before.atime }).toEqual(before);
    expect(result.status).toBe('found');
    expect(result.record?.payload.narrative).toEqual({
      type: 'text',
      bytesBase64: Buffer.from('authentic payload').toString('base64'),
    });
    expect(result.source).toMatchObject({
      sha256: before.sha256,
      atimeNs: before.atime.toString(),
      atimeAfterNs: after.atime.toString(),
      atimeChanged: true,
    });
    expect(result.limitations.join(' ')).toContain('does not establish which reader');
  });

  it('reads a legacy table exactly and scopes genuine absence to the inspected snapshot', async () => {
    fixture(
      `CREATE TABLE observations(id TEXT PRIMARY KEY, narrative TEXT); INSERT INTO observations VALUES ('${ID}', 'authentic legacy payload');`,
    );
    const found = await inspectBackupObservation({ snapshotPath: source, recordId: ID });
    expect(found.record?.table).toBe('observations');
    expect(found.record?.payload.narrative).toEqual({
      type: 'text',
      bytesBase64: Buffer.from('authentic legacy payload').toString('base64'),
    });
    for (const recordId of ['O-mspmgvbg', 'o-mspmgvbg-0', `${ID} `, "' OR 1=1 --"]) {
      const missing = await inspectBackupObservation({ snapshotPath: source, recordId });
      expect(missing.status).toBe('not-found');
      expect(missing.record).toBeNull();
      expect(missing.inspectedTables).toEqual(['observations']);
      expect(missing.limitations.join(' ')).toContain('not exhaustive backup absence');
    }
  });

  it('preserves UTF-16 snapshot text bytes and discloses their encoding', async () => {
    fixture(
      `PRAGMA encoding='UTF-16le'; CREATE TABLE observations(id TEXT PRIMARY KEY, narrative TEXT, project_id TEXT); INSERT INTO observations VALUES ('${ID}', '日本語 historical', 'project-B');`,
    );
    const result = await inspectBackupObservation({
      snapshotPath: source,
      recordId: ID,
      expectedProjectId: 'project-B',
    });
    expect(result.textEncoding).toBe('UTF-16le');
    expect(result.record?.payload.narrative).toEqual({
      type: 'text',
      bytesBase64: Buffer.from('日本語 historical', 'utf16le').toString('base64'),
    });
    expect(result.projectIdentity.status).toBe('matched');
  });

  it('checks recorded project identity without turning it into authority', async () => {
    fixture(
      `CREATE TABLE brain_observations(id TEXT PRIMARY KEY, project_id TEXT, narrative TEXT); INSERT INTO brain_observations VALUES ('${ID}', 'project-B', 'payload');`,
    );
    const result = await inspectBackupObservation({
      snapshotPath: source,
      recordId: ID,
      expectedProjectId: 'project-B',
    });
    expect(result.projectIdentity).toEqual({
      expected: 'project-B',
      recorded: 'project-B',
      status: 'matched',
      evidence: 'brain_observations.project_id',
    });
    expect(result.limitations.join(' ')).toContain('not independently authenticated ownership');
    await expect(
      inspectBackupObservation({
        snapshotPath: source,
        recordId: ID,
        expectedProjectId: 'project-A',
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' });
  });

  it.each([
    [
      'unindexed duplicate IDs',
      `CREATE TABLE observations(id TEXT, narrative TEXT); INSERT INTO observations VALUES ('${ID}','a'),('${ID}','b');`,
    ],
    [
      'case-folding index',
      'CREATE TABLE observations(id TEXT PRIMARY KEY COLLATE NOCASE, narrative TEXT);',
    ],
    ['virtual table', 'CREATE VIRTUAL TABLE observations USING fts5(id,narrative);'],
    ['view', 'CREATE VIEW observations AS SELECT 1 AS id;'],
    [
      'generated column',
      'CREATE TABLE observations(id TEXT PRIMARY KEY, narrative TEXT GENERATED ALWAYS AS (id));',
    ],
    ['integer identity', 'CREATE TABLE observations(id INTEGER PRIMARY KEY, narrative TEXT);'],
    ['no supported table', 'CREATE TABLE other(id TEXT PRIMARY KEY);'],
  ])('refuses unsupported %s without claiming absence', async (_label, sql) => {
    fixture(sql);
    const before = sourceIdentity();
    await expect(
      inspectBackupObservation({ snapshotPath: source, recordId: ID }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_SCHEMA' });
    expect(sourceIdentity()).toEqual(before);
  });

  it('refuses two authentic records with the same ID in different tables', async () => {
    fixture(
      `CREATE TABLE brain_observations(id TEXT PRIMARY KEY, narrative TEXT); CREATE TABLE observations(id TEXT PRIMARY KEY, narrative TEXT); INSERT INTO brain_observations VALUES ('${ID}','current'); INSERT INTO observations VALUES ('${ID}','historical');`,
    );
    await expect(
      inspectBackupObservation({ snapshotPath: source, recordId: ID }),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_RECORD' });
  });

  it.each([
    '-wal',
    '-shm',
    '-journal',
  ])('preserves and refuses unresolved companion %s', async (suffix) => {
    fixture('CREATE TABLE observations(id TEXT PRIMARY KEY);');
    fs.writeFileSync(source + suffix, 'unresolved companion');
    const before = sourceIdentity();
    await expect(
      inspectBackupObservation({ snapshotPath: source, recordId: ID }),
    ).rejects.toMatchObject({ code: 'JOURNAL_PRESENT' });
    expect(fs.readFileSync(source + suffix, 'utf8')).toBe('unresolved companion');
    expect(sourceIdentity()).toEqual(before);
  });

  it('refuses corrupt snapshots, symlink sources and source/payload bounds', async () => {
    fs.writeFileSync(source, 'not SQLite');
    await expect(
      inspectBackupObservation({ snapshotPath: source, recordId: ID }),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
    fs.unlinkSync(source);
    fixture(
      `CREATE TABLE observations(id TEXT PRIMARY KEY,narrative TEXT); INSERT INTO observations VALUES ('${ID}','a payload too large for requested limit');`,
    );
    await expect(
      inspectBackupObservation({ snapshotPath: source, recordId: ID, maxSnapshotBytes: 1 }),
    ).rejects.toMatchObject({ code: 'SOURCE_LIMIT' });
    await expect(
      inspectBackupObservation({ snapshotPath: source, recordId: ID, maxPayloadBytes: 5 }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_LIMIT' });
    const link = path.join(root, 'alias.db');
    fs.symlinkSync(source, link);
    await expect(
      inspectBackupObservation({ snapshotPath: link, recordId: ID }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_SOURCE' });
    await expect(
      inspectBackupObservation({ snapshotPath: source, recordId: ID, maxSnapshotBytes: NaN }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects source replacement between copy and inspection', async () => {
    fixture(
      `CREATE TABLE observations(id TEXT PRIMARY KEY); INSERT INTO observations VALUES ('${ID}');`,
    );
    const lstat = fs.promises.lstat;
    let reads = 0;
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args) => {
      if (String(args[0]) === source && ++reads === 2) {
        fs.renameSync(source, source + '.original');
        fs.copyFileSync(source + '.original', source);
      }
      return lstat(...args);
    });
    await expect(
      inspectBackupObservation({ snapshotPath: source, recordId: ID }),
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });

  it('detects in-place source changes after capture and before copying completes', async () => {
    fixture(
      `CREATE TABLE observations(id TEXT PRIMARY KEY); INSERT INTO observations VALUES ('${ID}');`,
    );
    const open = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (args[1] === 'wx') fs.appendFileSync(source, 'source changed after capture');
      return open(...args);
    });
    await expect(
      inspectBackupObservation({ snapshotPath: source, recordId: ID }),
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });

  it('still rejects same-size content changes when a writer restores modification time', async () => {
    fixture(
      `CREATE TABLE observations(id TEXT PRIMARY KEY); INSERT INTO observations VALUES ('${ID}');`,
    );
    fs.utimesSync(source, new Date('2001-01-01'), new Date('2002-01-01'));
    const before = fs.statSync(source);
    const original = snapshots.openCleoDbSnapshot;
    vi.spyOn(snapshots, 'openCleoDbSnapshot').mockImplementation((file, options) => {
      const descriptor = fs.openSync(source, 'r+');
      try {
        fs.writeSync(descriptor, Buffer.from('X'), 0, 1, 0);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.utimesSync(source, before.atime, before.mtime);
      expect(fs.statSync(source).size).toBe(before.size);
      expect(fs.statSync(source).mtimeMs).toBe(before.mtimeMs);
      return original(file, options);
    });
    await expect(
      inspectBackupObservation({ snapshotPath: source, recordId: ID }),
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });

  it('detects a corrupted private copy before opening it as SQLite', async () => {
    fixture(
      `CREATE TABLE observations(id TEXT PRIMARY KEY); INSERT INTO observations VALUES ('${ID}');`,
    );
    const open = fs.promises.open;
    const opener = vi.spyOn(snapshots, 'openCleoDbSnapshot');
    const before = sourceIdentity();
    let privatePath = '';
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (args[1] === 'r') {
        privatePath = String(args[0]);
        const descriptor = fs.openSync(privatePath, 'r+');
        try {
          fs.writeSync(descriptor, Buffer.from('X'), 0, 1, 0);
        } finally {
          fs.closeSync(descriptor);
        }
      }
      return open(...args);
    });
    await expect(
      inspectBackupObservation({ snapshotPath: source, recordId: ID }),
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(opener).not.toHaveBeenCalled();
    expect(sourceIdentity()).toEqual(before);
    expect(fs.existsSync(path.dirname(privatePath))).toBe(false);
  });

  it.each([
    false,
    true,
  ])('closes only owned private handles and denies writes (failure=%s)', async (fail) => {
    fixture(
      `CREATE TABLE observations(id TEXT PRIMARY KEY); INSERT INTO observations VALUES ('${ID}');`,
    );
    const caller = snapshots.openCleoDbSnapshot(source, { readOnly: true, applyPragmas: false });
    const original = snapshots.openCleoDbSnapshot;
    const owned: Array<ReturnType<typeof original>> = [];
    vi.spyOn(snapshots, 'openCleoDbSnapshot').mockImplementation((file, options) => {
      const handle = original(file, options);
      owned.push(handle);
      expect(file).not.toBe(source);
      expect(options).toEqual({ readOnly: true, applyPragmas: false });
      expect(() => handle.db.exec("INSERT INTO observations VALUES ('forbidden')")).toThrow();
      if (fail)
        vi.spyOn(handle.db, 'prepare').mockImplementationOnce(() => {
          throw new Error('injected private query failure');
        });
      return handle;
    });
    try {
      if (fail)
        await expect(
          inspectBackupObservation({ snapshotPath: source, recordId: ID }),
        ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
      else
        expect(
          (await inspectBackupObservation({ snapshotPath: source, recordId: ID })).status,
        ).toBe('found');
      expect(owned).toHaveLength(1);
      expect(() => owned[0]!.db.prepare('SELECT 1')).toThrow();
      expect(fs.existsSync(path.dirname(owned[0]!.path))).toBe(false);
      expect(caller.db.prepare('SELECT id FROM observations').get()?.id).toBe(ID);
    } finally {
      caller.close();
    }
  });
});
