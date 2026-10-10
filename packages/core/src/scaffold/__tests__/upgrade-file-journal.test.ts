/**
 * Backed-up, change-only writes and the append-only rule-file merge (T13409).
 *
 * @task T13409
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureGitignore } from '../ensure-config.js';
import {
  appendMissingLines,
  createUpgradeFileJournal,
  writeIfChanged,
} from '../upgrade-file-journal.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'upgrade-journal-'));
  mkdirSync(join(root, '.cleo'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('appendMissingLines', () => {
  it('keeps every existing line and order, and appends only the missing rules', () => {
    const existing = '# mine\nb\na\n';
    const { content, added } = appendMissingLines(existing, '# t\na\nc\nb\nd\n', '# added');
    expect(added).toEqual(['c', 'd']);
    expect(content).toBe('# mine\nb\na\n\n# added\nc\nd\n');
  });

  it('returns the input unchanged when nothing is missing', () => {
    const existing = 'a\nb';
    expect(appendMissingLines(existing, 'b\n# c\na\n', '# added')).toEqual({
      content: existing,
      added: [],
    });
  });
});

describe('writeIfChanged', () => {
  it('writes nothing when the content is already there', async () => {
    const path = join(root, 'f.txt');
    writeFileSync(path, 'same');
    const journal = createUpgradeFileJournal(root, join(root, '.cleo'));
    expect(await writeIfChanged(path, 'same', journal)).toBe(false);
    expect(journal.changes).toEqual([]);
  });

  it('backs the previous bytes up before replacing them, and lists the file', async () => {
    const path = join(root, 'f.txt');
    writeFileSync(path, 'old');
    const journal = createUpgradeFileJournal(root, join(root, '.cleo'));
    expect(await writeIfChanged(path, 'new', journal)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe('new');
    expect(journal.changes).toHaveLength(1);
    const [change] = journal.changes;
    expect(change?.path).toBe(path);
    expect(change?.backupPath?.startsWith(join(root, '.cleo', 'backups', 'upgrade'))).toBe(true);
    expect(readFileSync(change?.backupPath ?? '', 'utf-8')).toBe('old');
  });

  it('records a created file with no backup', async () => {
    const path = join(root, 'new.txt');
    const journal = createUpgradeFileJournal(root, join(root, '.cleo'));
    await writeIfChanged(path, 'x', journal);
    expect(journal.changes).toEqual([{ path, backupPath: null }]);
    expect(existsSync(path)).toBe(true);
  });
});

describe('ensureGitignore on an existing file (T13409)', () => {
  it('never appends a bare deny-all `*` to a file whose owner left it out', async () => {
    const path = join(root, '.cleo', '.gitignore');
    writeFileSync(path, '!keep-me.txt\n');
    await ensureGitignore(root);
    const lines = readFileSync(path, 'utf-8').split('\n');
    expect(lines[0]).toBe('!keep-me.txt');
    expect(lines).not.toContain('*');
  });

  it('is a no-op on a second run', async () => {
    const path = join(root, '.cleo', '.gitignore');
    writeFileSync(path, '# user\n');
    await ensureGitignore(root);
    const once = readFileSync(path, 'utf-8');
    const again = await ensureGitignore(root);
    expect(again.action).toBe('skipped');
    expect(readFileSync(path, 'utf-8')).toBe(once);
  });
});
