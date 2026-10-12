/**
 * T13568 — a typed gate in a git worktree created outside CLEO (no
 * `.cleo/project-info.json` of its own) reads the primary checkout's identity
 * through the git common dir, and runs with the worktree as its root.
 *
 * @task T13568
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcRow, Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureProjectScope, readProjectInfoAtDirectorySync } from '../../project-scope.js';
import { _forceSystemdRunAvailable } from '../../resources/spawn-wrapper.js';
import { createOperationExecutionContext } from '../../store/background-ops.js';
import { buildFreshAcRows } from '../ac-table.js';
import { runTaskGates } from '../gate-runner.js';

let base: string;
let primary: string;
let worktree: string;

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

beforeEach(() => {
  _forceSystemdRunAvailable(false);
  base = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-wt-info-')));
  primary = join(base, 'primary');
  worktree = join(base, 'external-wt');
  mkdirSync(join(primary, '.cleo'), { recursive: true });
  git(primary, ['init', '-q', '-b', 'main']);
  git(primary, ['config', 'user.name', 'Test']);
  git(primary, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(primary, 'check.mjs'), 'process.exit(0);\n');
  git(primary, ['add', 'check.mjs']);
  git(primary, ['commit', '-q', '-m', 'base']);
  // Untracked, as in a real checkout: only the primary has it.
  writeFileSync(
    join(primary, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: 'wt-fixture', projectHash: 'wt-fixture-hash' }),
  );
  git(primary, ['worktree', 'add', '-q', worktree, '-b', 'external']);
});

afterEach(() => {
  _forceSystemdRunAvailable(undefined);
  rmSync(base, { recursive: true, force: true });
});

describe('typed gates in an externally created worktree (T13568)', () => {
  it('reads the primary checkout identity, keeping the worktree as its root', () => {
    expect(existsSync(join(worktree, '.cleo', 'project-info.json'))).toBe(false);
    const info = readProjectInfoAtDirectorySync(worktree, join(worktree, '.cleo'));
    expect(info).toMatchObject({ projectId: 'wt-fixture', projectRoot: worktree });
    // Nothing was written into the worktree.
    expect(existsSync(join(worktree, '.cleo', 'project-info.json'))).toBe(false);
  });

  it('a typed gate runs there and records its result', async () => {
    const execution = createOperationExecutionContext(
      {
        projectId: 'wt-fixture',
        projectRoot: worktree,
        actor: 'external-agent',
        operation: 'check.gate.verify',
        idempotencyKey: 'external-worktree',
      },
      { budgetMs: 30_000 },
    );
    try {
      // The ENOENT the report hit came from here.
      expect(() =>
        captureProjectScope(worktree, { worktreeRoot: worktree, projectHash: '', execution }),
      ).not.toThrow();
      const task: Task = {
        id: 'T901',
        title: 'External worktree gate',
        description: 'Typed gate in a worktree CLEO did not provision',
        status: 'active',
        type: 'task',
        priority: 'medium',
        createdAt: '2026-10-11T00:00:00.000Z',
        files: ['check.mjs'],
        acceptance: [
          {
            kind: 'test',
            command: process.execPath,
            args: ['check.mjs'],
            expect: 'exit0',
            req: 'EXT-901',
            description: 'harness runs in the external worktree',
          },
        ],
      };
      const rows: AcRow[] = buildFreshAcRows(task.id, task.acceptance).map((row) => ({
        ...row,
        kind: row.kind ?? 'text',
        sourceKey: row.sourceKey ?? '',
        projection: row.projection ?? 'legacy',
        targetTaskId: row.targetTaskId ?? null,
        contentHash: row.contentHash ?? null,
        createdAt: task.createdAt,
        updatedAt: null,
      }));
      const [result] = await runTaskGates(task, rows, { execution, projectRoot: worktree });
      expect(result?.result, result?.errorMessage).toBe('pass');
      expect(result?.binding?.identity.projectRoot).toBe(worktree);
    } finally {
      execution.close();
    }
  });
});
