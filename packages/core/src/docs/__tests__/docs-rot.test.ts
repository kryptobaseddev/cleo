/**
 * Docs rot (T14111): covers declarations, merge flagging, and the
 * stale / duplicate / orphaned report over a real git fixture.
 *
 * @task T14111
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateTask = vi.fn(async () => ({ task: {}, changes: [] }));
vi.mock('../../tasks/update.js', () => ({ updateTask }));

const { DOCS_ROT_LABEL, flagDocsRotOnTasks, readDocCovers, scanDocsRot } = await import(
  '../rot.js'
);

let root: string;

function git(args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8' },
  ).trim();
}

function write(path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function commit(message: string): string {
  git(['add', '-A']);
  git(['commit', '-q', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

const COVERING_DOC = '---\ncovers:\n  - src/release/**\n---\n# Release flow\n\nSee guide.md.\n';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-docs-rot-'));
  git(['init', '-q', '-b', 'main']);
  write('src/release/cut.ts', 'export const a = 1;\n');
  write('src/other.ts', 'export const b = 1;\n');
  write('docs/release.md', COVERING_DOC);
  write('docs/guide.md', '# Guide\n\nRead release.md.\n');
  commit('base');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  updateTask.mockClear();
});

describe('readDocCovers', () => {
  it('reads the covers list from frontmatter and ignores everything else', () => {
    expect(readDocCovers(COVERING_DOC)).toEqual(['src/release/**']);
    expect(readDocCovers('# No frontmatter\n')).toEqual([]);
    expect(readDocCovers('---\ncovers: [unclosed\n---\n')).toEqual([]);
  });
});

describe('scanDocsRot', () => {
  it('AC1: flags the doc whose covered code a merged change touched', () => {
    const base = git(['rev-parse', 'HEAD']);
    write('src/release/cut.ts', 'export const a = 2;\n');
    write('src/other.ts', 'export const b = 2;\n');
    const head = commit('change covered code');
    const report = scanDocsRot({ projectRoot: root, changed: `${base}..${head}` });
    expect(report.flagged).toEqual([{ doc: 'docs/release.md', files: ['src/release/cut.ts'] }]);
  });

  it('AC1: a change that updates the doc with its code flags nothing', () => {
    const base = git(['rev-parse', 'HEAD']);
    write('src/release/cut.ts', 'export const a = 3;\n');
    write('docs/release.md', `${COVERING_DOC}\nUpdated.\n`);
    const head = commit('code and doc together');
    const report = scanDocsRot({ projectRoot: root, changed: `${base}..${head}` });
    expect(report.flagged).toEqual([]);
    expect(report.stale).toEqual([]);
  });

  it('AC2: reports stale, duplicate and orphaned docs', () => {
    write('src/release/cut.ts', 'export const a = 4;\n');
    write('docs/dead.md', '---\ncovers:\n  - src/gone/**\n---\n# Dead covers\n\nSee guide.md.\n');
    write('docs/copy-a.md', '# Same body\n\nText.\n');
    write('docs/copy-b.md', '# Same body\n\nText.\n');
    write('docs/notes.md', '# Notes\n\nCopies: copy-a.md copy-b.md dead.md\n');
    commit('code moves on without its doc');
    const report = scanDocsRot({ projectRoot: root });
    expect(report.stale).toEqual([{ doc: 'docs/release.md', files: ['src/release/cut.ts'] }]);
    expect(report.duplicates).toEqual([
      { reason: 'content', docs: ['docs/copy-a.md', 'docs/copy-b.md'] },
    ]);
    expect(report.orphans).toEqual([
      { doc: 'docs/dead.md', reason: 'dead-covers', globs: ['src/gone/**'] },
      { doc: 'docs/notes.md', reason: 'unreferenced' },
    ]);
    expect(report.covering).toBe(2);
  });

  it('AC3: scans in well under a second', () => {
    expect(scanDocsRot({ projectRoot: root }).durationMs).toBeLessThan(1_000);
  });
});

describe('flagDocsRotOnTasks', () => {
  it('AC1: labels each task of the merged change and notes the stale doc', async () => {
    const flagged = [{ doc: 'docs/release.md', files: ['src/release/cut.ts'] }];
    const updated = await flagDocsRotOnTasks(root, ['T1', 'T2'], flagged, 'PR #9');
    expect(updated).toEqual(['T1', 'T2']);
    expect(updateTask).toHaveBeenCalledWith(
      {
        taskId: 'T1',
        addLabels: [DOCS_ROT_LABEL],
        notes:
          'docs-rot: docs/release.md covers src/release/cut.ts, changed in PR #9; update the doc',
      },
      root,
    );
    expect(await flagDocsRotOnTasks(root, ['T1'], [], 'PR #9')).toEqual([]);
  });
});
