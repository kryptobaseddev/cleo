/** Exact database resources own migration markers and archived sources (T12260). */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  archiveMigratedSources,
  exodusMarkerPath,
  hasExodusCompleteMarker,
  writeExodusCompleteMarker,
} from '../exodus/archive.js';
import { maybeRunExodusOnOpen } from '../exodus/on-open.js';

let root: string;
let unrelated: string;
let target: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-exodus-resources-'));
  unrelated = join(root, 'unrelated', '.cleo');
  target = join(root, 'selected', 'cleo.db');
  mkdirSync(unrelated, { recursive: true });
  mkdirSync(join(root, 'selected'));
  vi.stubEnv('CLEO_DIR', unrelated);
  vi.stubEnv('CLEO_HOME', join(root, 'unrelated-global'));
  vi.stubEnv('CLEO_DISABLE_EXODUS_ON_OPEN', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('does not apply an unrelated project marker to the explicitly opened database', async () => {
  writeExodusCompleteMarker('project', ['unrelated']);
  expect(hasExodusCompleteMarker('project', root, target)).toBe(false);
  const db = new DatabaseSync(target);
  try {
    db.exec("CREATE TABLE tasks_tasks(id TEXT PRIMARY KEY); INSERT INTO tasks_tasks VALUES ('T1')");
    const result = await maybeRunExodusOnOpen('project', target, db, root);
    expect(result).toEqual({
      outcome: 'skipped',
      reason: 'consolidated cleo.db already populated',
    });
  } finally {
    db.close();
  }
});

it('archives consumed sources and seals the target without changing another project marker', () => {
  const originalMarker = writeExodusCompleteMarker('project', ['unrelated']);
  const originalBytes = readFileSync(originalMarker);
  const source = join(root, 'selected', 'tasks.db');
  writeFileSync(source, 'authentic-source');
  archiveMigratedSources([{ name: 'tasks', path: source, targetScope: 'project' }], root, {
    projectDbPath: target,
    globalDbPath: join(root, 'selected-global', 'cleo.db'),
  });
  expect(readFileSync(join(root, 'selected', '_archive', 'tasks.db'), 'utf8')).toBe(
    'authentic-source',
  );
  expect(existsSync(source)).toBe(false);
  expect(readFileSync(originalMarker)).toEqual(originalBytes);
  expect(exodusMarkerPath('project', root, target)).toBe(join(root, 'selected', 'exodus-complete'));
  expect(hasExodusCompleteMarker('project', root, target)).toBe(true);
  expect(JSON.parse(readFileSync(exodusMarkerPath('project', root, target), 'utf8'))).toMatchObject(
    { scope: 'project', targetDbPath: target },
  );
});

it('separates markers for distinct database resources sharing one directory', () => {
  const first = join(root, 'selected', 'first.db');
  const second = join(root, 'selected', 'second.db');
  writeExodusCompleteMarker('project', ['first'], root, first);
  expect(hasExodusCompleteMarker('project', root, first)).toBe(true);
  expect(hasExodusCompleteMarker('project', root, second)).toBe(false);
});

it('does not accept a marker copied from another exact database target', () => {
  const first = join(root, 'selected', 'first.db');
  const second = join(root, 'selected', 'second.db');
  const marker = writeExodusCompleteMarker('project', ['first'], root, first);
  writeFileSync(exodusMarkerPath('project', root, second), readFileSync(marker));
  expect(hasExodusCompleteMarker('project', root, second)).toBe(false);
});

it('reports diagnostic read failure as an abort instead of an empty migration target', async () => {
  const db = new DatabaseSync(target);
  db.close();
  const result = await maybeRunExodusOnOpen('project', target, db, root);
  expect(result.outcome).toBe('aborted');
  expect(result.reason).toMatch(/assessment failed/);
});

it('reports malformed marker evidence rather than silently attempting migration', async () => {
  writeFileSync(exodusMarkerPath('project', root, target), 'not json');
  const db = new DatabaseSync(target);
  try {
    const result = await maybeRunExodusOnOpen('project', target, db, root);
    expect(result.outcome).toBe('aborted');
    expect(result.reason).toMatch(/assessment failed/);
  } finally {
    db.close();
  }
});

it('refuses a cwd-discovered migration plan targeting another database', async () => {
  const db = new DatabaseSync(target);
  try {
    db.exec('CREATE TABLE tasks_tasks(id TEXT PRIMARY KEY)');
    const result = await maybeRunExodusOnOpen('project', target, db, root);
    expect(result.outcome).toBe('aborted');
    expect(result.reason).toMatch(/does not match opened database/);
  } finally {
    db.close();
  }
});
