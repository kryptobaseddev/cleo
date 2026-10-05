/**
 * Tests for scripts/sync-gate-b.mjs (T12987): the snapshot arguments, and the
 * refusal of a live project store as input.
 *
 * @task T12987
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('refuses a live project store', () => {
    expect(() => parseSnapshots([`cleocode=${live}`])).toThrow(/live project store/);
  });

  it('refuses a relative path, a missing file, a bad name and no snapshot at all', () => {
    expect(() => parseSnapshots(['x=relative.db'])).toThrow(/absolute/);
    expect(() => parseSnapshots([`x=${join(root, 'missing.db')}`])).toThrow(/no snapshot file/);
    expect(() => parseSnapshots([`Bad_Name=${snapshot}`])).toThrow(/kebab-case/);
    expect(() => parseSnapshots([])).toThrow(/at least one/);
  });
});
