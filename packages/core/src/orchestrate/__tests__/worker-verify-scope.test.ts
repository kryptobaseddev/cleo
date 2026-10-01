/**
 * Worker re-verification runs in the WORKER's tree, affected tests first, the
 * full suite only when affected planning refuses (T12962).
 *
 * `defaultRunProjectTests` used to run a full `tool:test` for every worker
 * exit. Its first scoped version still resolved the tree from the daemon's
 * cwd — normally the main checkout — so unrelated dirty edits there decided
 * the affected set and could accept an untested worker change. The tests now
 * run in the worker's worktree, or as a full suite in the project root when
 * that tree is unknown; affected tests never run on a foreign tree.
 *
 * @task T12962
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeProjectHash, resolveTaskWorktreePath } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AffectedTestRun } from '../../tasks/affected-packages.js';
import type { ResolvedToolCommand } from '../../tasks/tool-resolver.js';
import {
  defaultRunProjectTests,
  type ProjectTestDeps,
  resolveWorkerWorktree,
  reVerifyWorkerReport,
} from '../worker-verify.js';

const AFFECTED_CMD: ResolvedToolCommand = {
  canonical: 'test',
  displayName: 'test-affected',
  cmd: 'pnpm',
  args: ['exec', 'vitest', 'run', '--project', 'a'],
  source: 'project-context',
};
const FULL_CMD: ResolvedToolCommand = {
  canonical: 'test',
  displayName: 'test',
  cmd: 'pnpm',
  args: ['run', 'test'],
  source: 'project-context',
};

interface Recorded {
  planned: string[];
  resolved: string[];
  ran: Array<{ display: string; root: string }>;
}

/** Stub deps: `plan` answers affected planning, `exit` is every run's exit code. */
function stubDeps(plan: AffectedTestRun, exit = 0): { rec: Recorded; deps: ProjectTestDeps } {
  const rec: Recorded = { planned: [], resolved: [], ran: [] };
  return {
    rec,
    deps: {
      planAffected: async (_store, root) => {
        rec.planned.push(root);
        return plan;
      },
      resolveTest: (_store, root) => {
        rec.resolved.push(root);
        return { ok: true, command: FULL_CMD };
      },
      runCached: async (command, _store, root) => {
        rec.ran.push({ display: command.displayName, root });
        return { exitCode: exit, timedOut: false, stdoutTail: '', stderrTail: 'boom' };
      },
    },
  };
}

const PLANNED: AffectedTestRun = {
  ok: true,
  command: AFFECTED_CMD,
  packages: ['a'],
  projects: ['a'],
  untested: [],
};

describe('defaultRunProjectTests runs in the worker tree (T12962)', () => {
  it('plans and runs the affected tests in the worker tree, not the project root', async () => {
    const { rec, deps } = stubDeps(PLANNED);
    const r = await defaultRunProjectTests('/main', '/wt/T1', deps);
    expect(r).toEqual({ ok: true, scope: 'affected' });
    expect(rec.planned).toEqual(['/wt/T1']);
    expect(rec.ran).toEqual([{ display: 'test-affected', root: '/wt/T1' }]);
    expect(rec.resolved).toEqual([]);
  });

  it('runs the full suite in the project root, never affected, when the worker tree is unknown', async () => {
    const { rec, deps } = stubDeps(PLANNED);
    const r = await defaultRunProjectTests('/main', null, deps);
    expect(r).toEqual({ ok: true, scope: 'full' });
    expect(rec.planned).toEqual([]);
    expect(rec.ran).toEqual([{ display: 'test', root: '/main' }]);
  });

  it('reports a failing affected run as the verdict without escalating', async () => {
    const { rec, deps } = stubDeps(PLANNED, 1);
    const r = await defaultRunProjectTests('/main', '/wt/T1', deps);
    expect(r.ok).toBe(false);
    expect(r.scope).toBe('affected');
    expect(r.reason).toContain('exited 1: boom');
    expect(rec.ran).toHaveLength(1);
  });

  it.each([
    ['no affectedCommand configured', 'E_EVIDENCE_TOOL_UNAVAILABLE'],
    ['a root-config change', 'E_EVIDENCE_INSUFFICIENT'],
  ] as const)('falls back to the full suite in the worker tree on a refusal (%s)', async (_l, code) => {
    const { rec, deps } = stubDeps({ ok: false, codeName: code, reason: 'refused' });
    const r = await defaultRunProjectTests('/main', '/wt/T1', deps);
    expect(r).toEqual({ ok: true, scope: 'full' });
    expect(rec.ran).toEqual([{ display: 'test', root: '/wt/T1' }]);
  });

  it('treats a busy test slot as retry-later, never as a full run', async () => {
    const { rec, deps } = stubDeps({
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason: 'scope pending: test slot busy',
      pending: true,
    });
    const r = await defaultRunProjectTests('/main', '/wt/T1', deps);
    expect(r).toMatchObject({ ok: false, scope: 'affected', pending: true });
    expect(rec.ran).toEqual([]);
  });
});

describe('reVerifyWorkerReport hands the runner the worker tree (T12962)', () => {
  it('passes the resolved worker tree to the runner and to git status', async () => {
    const seen: { tests?: string | null; files?: string } = {};
    await reVerifyWorkerReport(
      { taskId: 'T1', selfReportSuccess: true, evidenceAtoms: ['tool:test'], touchedFiles: [] },
      {
        projectRoot: '/main',
        resolveWorkerTree: () => '/wt/T1',
        runProjectTests: async (_root, tree) => {
          seen.tests = tree;
          return { ok: true };
        },
        listChangedFiles: async (root) => {
          seen.files = root;
          return [];
        },
      },
    );
    expect(seen).toEqual({ tests: '/wt/T1', files: '/wt/T1' });
  });

  it('honours an explicit null worktreePath as unknown', async () => {
    let tree: string | null | undefined;
    await reVerifyWorkerReport(
      {
        taskId: 'T1',
        selfReportSuccess: true,
        evidenceAtoms: ['tool:test'],
        touchedFiles: [],
        worktreePath: null,
      },
      {
        projectRoot: '/main',
        resolveWorkerTree: () => '/wt/T1',
        runProjectTests: async (_root, t) => {
          tree = t;
          return { ok: true };
        },
        listChangedFiles: async () => [],
      },
    );
    expect(tree).toBeNull();
  });

  it('names the pending state as retry-later in the mismatch', async () => {
    const result = await reVerifyWorkerReport(
      {
        taskId: 'T1',
        selfReportSuccess: true,
        evidenceAtoms: ['tool:test'],
        touchedFiles: [],
        worktreePath: '/wt/T1',
      },
      {
        projectRoot: '/nonexistent-worker-verify-scope',
        runProjectTests: async () => ({
          ok: false,
          scope: 'affected',
          pending: true,
          reason: 'busy',
        }),
        listChangedFiles: async () => [],
      },
    );
    expect(result.accepted).toBe(false);
    expect(result.mismatches[0]).toMatch(/retry later/);
    expect(result.auditEntry?.mismatches[0]?.actual).toBe('tool:test-affected failed: busy');
  });
});

describe('resolveWorkerWorktree (T12962)', () => {
  let home: string;
  let project: string;
  const savedHome = process.env.CLEO_HOME;

  function git(cwd: string, args: string[]): void {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wv-home-'));
    project = mkdtempSync(join(tmpdir(), 'wv-project-'));
    process.env.CLEO_HOME = home;
    git(project, ['init', '-q', '-b', 'main']);
    git(project, [
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ]);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.CLEO_HOME;
    else process.env.CLEO_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('returns null when the task has no worktree, even with dirty edits in the project root', () => {
    // The main checkout is dirty; those edits must never stand in for the worker's tree.
    writeFileSync(join(project, 'unrelated.ts'), 'export const x = 1;\n');
    expect(resolveWorkerWorktree(project, 'T42')).toBeNull();
  });

  it('returns the canonical task worktree when it is a checkout toplevel', () => {
    const path = resolveTaskWorktreePath(computeProjectHash(project), 'T42');
    mkdirSync(join(path, '..'), { recursive: true });
    git(project, ['worktree', 'add', '-q', '-b', 'task/T42', path]);
    expect(resolveWorkerWorktree(project, 'T42')).toBe(path);
  });

  it('rejects a plain directory at the worktree path', () => {
    const path = resolveTaskWorktreePath(computeProjectHash(project), 'T43');
    mkdirSync(path, { recursive: true });
    expect(resolveWorkerWorktree(project, 'T43')).toBeNull();
  });
});
