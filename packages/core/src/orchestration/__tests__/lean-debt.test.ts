/**
 * T13664 — `cleo lean debt`: marker parsing, git-tracked scan, and idempotent
 * filing into `lean-debt` tasks.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryTasks = vi.fn();
const addTask = vi.fn();
vi.mock('../../store/data-accessor.js', () => ({
  getTaskAccessor: async () => ({ queryTasks }),
}));
vi.mock('../../tasks/add.js', () => ({ addTask }));
const requireActiveSession = vi.fn();
vi.mock('../../sessions/session-enforcement.js', () => ({ requireActiveSession }));

const { leanDebtKeyLine, leanDebtReport, parseLeanDebtLine, scanLeanDebt } = await import(
  '../lean-debt.js'
);

const MARKERS = ['shortcut', 'ponytail'];

describe('parseLeanDebtLine (T13664)', () => {
  it('splits ceiling and upgrade trigger at the first comma', () => {
    const item = parseLeanDebtLine(
      'src/cache.ts:12:  // shortcut: no TTL, add one if the data becomes config-driven',
      MARKERS,
    );
    expect(item).toMatchObject({
      file: 'src/cache.ts',
      line: 12,
      marker: 'shortcut',
      ceiling: 'no TTL',
      upgrade: 'add one if the data becomes config-driven',
      noTrigger: false,
    });
    expect(item?.key).toMatch(/^[0-9a-f]{12}$/);
  });

  it('flags a marker with no upgrade trigger, and reads the older ponytail marker', () => {
    const item = parseLeanDebtLine('app.py:3:# ponytail: regex, not a parser', MARKERS);
    expect(item).toMatchObject({ marker: 'ponytail', ceiling: 'regex', upgrade: 'not a parser' });
    const bare = parseLeanDebtLine('app.py:4:# shortcut: global lock', MARKERS);
    expect(bare).toMatchObject({ ceiling: 'global lock', upgrade: null, noTrigger: true });
  });

  it('ignores prose that only mentions the convention, and a keyboard shortcut', () => {
    expect(
      parseLeanDebtLine('README.md:9:Mark limits with shortcut: comments.', MARKERS),
    ).toBeNull();
    expect(parseLeanDebtLine('ui.ts:2:const keyboardShortcut = "ctrl+k";', MARKERS)).toBeNull();
  });

  it('keeps the key stable when the line moves', () => {
    const a = parseLeanDebtLine('a.ts:1:// shortcut: x, y', MARKERS);
    const b = parseLeanDebtLine('a.ts:40:// shortcut: x, y', MARKERS);
    expect(a?.key).toBe(b?.key);
  });
});

describe('scanLeanDebt over a git repo (T13664)', () => {
  let repo: string;

  beforeEach(() => {
    vi.clearAllMocks();
    requireActiveSession.mockResolvedValue({ allowed: true });
    repo = mkdtempSync(join(tmpdir(), 'lean-debt-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    git('init', '-q');
    mkdirSync(join(repo, 'src'));
    mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(
      join(repo, 'src', 'b.ts'),
      '// shortcut: in-memory map, move to sqlite past 10k rows\n',
    );
    writeFileSync(join(repo, 'src', 'a.py'), 'x = 1\n# shortcut: single process only\n');
    writeFileSync(join(repo, 'node_modules', 'dep', 'i.js'), '// shortcut: vendored, ignored\n');
    writeFileSync(join(repo, 'untracked.ts'), '// shortcut: not tracked, not scanned\n');
    git('add', 'src', 'node_modules');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('lists tracked markers in path order, skipping vendored and untracked files', () => {
    const items = scanLeanDebt(repo);
    expect(items.map((i) => `${i.file}:${i.line}`)).toEqual(['src/a.py:2', 'src/b.ts:1']);
    expect(items.filter((i) => i.noTrigger).map((i) => i.file)).toEqual(['src/a.py']);
  });

  it('returns an empty ledger when nothing matches', () => {
    expect(scanLeanDebt(repo, ['nothinghere'])).toEqual([]);
  });

  it('files one task per new marker and skips keys already filed', async () => {
    const items = scanLeanDebt(repo);
    const known = items[0];
    queryTasks.mockResolvedValue({
      tasks: [{ id: 'T1', description: `x\n${leanDebtKeyLine(known?.key ?? '')}` }],
      total: 1,
    });
    addTask.mockResolvedValue({ task: { id: 'T2' } });
    const report = await leanDebtReport({ projectRoot: repo, fileTasks: true, parentId: 'T100' });
    expect(report.alreadyFiled).toEqual([known?.key]);
    expect(report.filed).toEqual([{ key: items[1]?.key, taskId: 'T2' }]);
    expect(report.noTriggerCount).toBe(1);
    const [options] = addTask.mock.calls[0] ?? [];
    expect(options).toMatchObject({ labels: ['lean-debt'], parentId: 'T100' });
    expect(options.description).toContain(leanDebtKeyLine(items[1]?.key ?? ''));
    expect(queryTasks).toHaveBeenCalledWith({ label: 'lean-debt', excludeStatus: [] });
  });

  it('files nothing when no session is bound', async () => {
    const unbound = Object.assign(new Error("Operation 'tasks.add' requires an active session"), {
      code: 36,
    });
    requireActiveSession.mockRejectedValue(unbound);
    await expect(
      leanDebtReport({ projectRoot: repo, fileTasks: true, parentId: 'T100' }),
    ).rejects.toBe(unbound);
    expect(requireActiveSession).toHaveBeenCalledWith('tasks.add', repo);
    expect(queryTasks).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });
});
