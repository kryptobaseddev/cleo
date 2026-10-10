/**
 * Tests for scripts/sync-gate-b.mjs (T12987): the snapshot arguments, and the
 * refusal of a live project store as input.
 *
 * @task T12987
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseSnapshots } from '../sync-gate-b.mjs';

const root = mkdtempSync(join(tmpdir(), 'cleo-sync-gate-b-args-'));
const snapshot = join(root, 'backups', 'cleo-20261004.db');
const live = join(root, 'project', '.cleo', 'cleo.db');
mkdirSync(join(root, 'backups'), { recursive: true });
mkdirSync(join(root, 'project', '.cleo'), { recursive: true });
writeFileSync(snapshot, '');
writeFileSync(live, '');

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('sync-gate-b snapshot arguments (T12987)', () => {
  it('accepts name=/abs/snapshot entries', () => {
    expect(parseSnapshots([`llmtxt=${snapshot}`])).toEqual([{ name: 'llmtxt', file: snapshot }]);
  });

  it('refuses a live project store, through a symlink and in any letter case', () => {
    expect(() => parseSnapshots([`cleocode=${live}`])).toThrow(/live store/);
    const link = join(root, 'link.db');
    symlinkSync(live, link);
    expect(() => parseSnapshots([`cleocode=${link}`])).toThrow(/live store/);
    const upper = join(root, 'upper', '.CLEO', 'CLEO.db');
    mkdirSync(join(root, 'upper', '.CLEO'), { recursive: true });
    writeFileSync(upper, '');
    expect(() => parseSnapshots([`cleocode=${upper}`])).toThrow(/live store/);
  });

  it('refuses any file named cleo.db (the global store at any home) and a non-empty -wal', () => {
    const elsewhere = join(root, 'Library', 'Application Support', 'cleo');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'cleo.db'), '');
    expect(() => parseSnapshots([`global=${join(elsewhere, 'cleo.db')}`])).toThrow(/live store/);
    const home = join(root, 'cleo-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'cleo.db'), '');
    const prev = process.env.CLEO_HOME;
    process.env.CLEO_HOME = home;
    try {
      expect(() => parseSnapshots([`global=${join(home, 'cleo.db')}`])).toThrow(/live store/);
    } finally {
      if (prev === undefined) delete process.env.CLEO_HOME;
      else process.env.CLEO_HOME = prev;
    }
    const busy = join(root, 'backups', 'busy.db');
    writeFileSync(busy, '');
    writeFileSync(`${busy}-wal`, 'x');
    expect(() => parseSnapshots([`busy=${busy}`])).toThrow(/not a quiesced snapshot/);
  });

  it('refuses a relative path, a missing file, a bad name and no snapshot at all', () => {
    expect(() => parseSnapshots(['x=relative.db'])).toThrow(/absolute/);
    expect(() => parseSnapshots([`x=${join(root, 'missing.db')}`])).toThrow(/no snapshot file/);
    expect(() => parseSnapshots([`Bad_Name=${snapshot}`])).toThrow(/kebab-case/);
    expect(() => parseSnapshots([])).toThrow(/at least one/);
  });
});
