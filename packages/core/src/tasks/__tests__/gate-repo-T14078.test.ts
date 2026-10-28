/**
 * Cross-repo typed gates (T14078): a project declares a further evidence
 * repository (an SDK in its own git repository) in project-context.json, and
 * a typed gate naming it runs there, captures its inputs there and is
 * revalidated there. A repository the project does not declare is refused.
 *
 * @task T14078
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcceptanceGate, AcRow, Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _forceSystemdRunAvailable } from '../../resources/spawn-wrapper.js';
import { awaitBackgroundOps, createOperationExecutionContext } from '../../store/background-ops.js';
import { closeDb } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { buildFreshAcRows } from '../ac-table.js';
import { resolveEvidenceRepository } from '../evidence-tree.js';
import { previewTaskGates } from '../gate-preview.js';
import { runTaskGates, typedResultDrift } from '../gate-runner.js';
import { reqAdd } from '../req.js';

let base: string;
let project: string;
let sdk: string;

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

function repo(dir: string, file: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, file), body);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
}

beforeEach(() => {
  _forceSystemdRunAvailable(false);
  base = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-gate-repo-')));
  project = join(base, 'app');
  sdk = join(base, 'sdk');
  repo(project, 'README.md', 'app\n');
  repo(sdk, 'check.mjs', 'process.exit(0);\n');
  mkdirSync(join(project, '.cleo'), { recursive: true });
  writeFileSync(
    join(project, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: 'gate-repo', projectHash: 'gate-repo-hash' }),
  );
  writeFileSync(
    join(project, '.cleo', 'project-context.json'),
    JSON.stringify({
      evidence: { repositories: [{ name: 'sdk', path: '../sdk', purpose: 'the client SDK' }] },
    }),
  );
});

afterEach(() => {
  _forceSystemdRunAvailable(undefined);
  rmSync(base, { recursive: true, force: true });
});

function taskWith(gate: AcceptanceGate): { task: Task; rows: AcRow[] } {
  const task: Task = {
    id: 'T950',
    title: 'SDK gate',
    description: 'Typed gate run in a declared evidence repository',
    status: 'active',
    type: 'task',
    priority: 'medium',
    createdAt: '2026-10-27T00:00:00.000Z',
    acceptance: [gate],
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
  return { task, rows };
}

function sdkGate(name: string): AcceptanceGate {
  return {
    kind: 'test',
    command: process.execPath,
    args: ['check.mjs'],
    expect: 'exit0',
    req: 'SDK-1',
    description: 'the SDK harness passes',
    repo: name,
  };
}

async function withExecution<T>(
  fn: (execution: ReturnType<typeof createOperationExecutionContext>) => Promise<T>,
): Promise<T> {
  const execution = createOperationExecutionContext(
    {
      projectId: 'gate-repo',
      projectRoot: project,
      actor: 'test-agent',
      operation: 'check.gate.verify',
      idempotencyKey: `gate-repo-${Math.random()}`,
    },
    { budgetMs: 30_000 },
  );
  try {
    return await fn(execution);
  } finally {
    execution.close();
  }
}

describe('typed gates in a declared evidence repository (T14078)', () => {
  it('a declared repository resolves to its checkout; an undeclared one is refused', () => {
    expect(resolveEvidenceRepository(project, 'sdk')).toEqual({ ok: true, root: sdk });
    const other = resolveEvidenceRepository(project, 'other');
    expect(other.ok).toBe(false);
    expect(!other.ok && other.reason).toMatch(/"other" is not declared/);
  });

  it('runs in the declared repository and captures its inputs there', async () => {
    const { task, rows } = taskWith(sdkGate('sdk'));
    const [result] = await withExecution((execution) =>
      runTaskGates(task, rows, { execution, projectRoot: project }),
    );
    expect(result?.result, result?.errorMessage).toBe('pass');
    expect(result?.binding?.invocation?.cwd).toBe(sdk);
    expect(result?.binding?.artifacts.map((a) => a.path)).toEqual([join(sdk, 'check.mjs')]);
  });

  it('a gate naming an undeclared repository is refused, never run elsewhere', async () => {
    const { task, rows } = taskWith(sdkGate('other'));
    const [result] = await withExecution((execution) =>
      runTaskGates(task, rows, { execution, projectRoot: project }),
    );
    expect(result?.result).toBe('error');
    expect(result?.errorMessage).toMatch(/evidence repository "other" is not declared/);
  });

  it('is revalidated in the declared repository: a moved input there is drift', async () => {
    const { task, rows } = taskWith(sdkGate('sdk'));
    const results = await withExecution((execution) =>
      runTaskGates(task, rows, { execution, projectRoot: project }),
    );
    expect(results[0]?.result).toBe('pass');
    const verified: Task = {
      ...task,
      verification: {
        passed: false,
        round: 1,
        gates: {},
        failureLog: [],
        lastAgent: null,
        lastUpdated: null,
        gateResults: results,
      },
    };
    const stands = await withExecution((execution) =>
      typedResultDrift(verified, rows, { execution, projectRoot: project }, project),
    );
    expect([...stands.keys()]).toEqual([]);

    writeFileSync(join(sdk, 'check.mjs'), 'process.exit(0); // changed\n');
    git(sdk, ['commit', '-q', '-am', 'move the harness']);
    const moved = await withExecution((execution) =>
      typedResultDrift(verified, rows, { execution, projectRoot: project }, project),
    );
    expect(moved.get(0)?.reason).toMatch(/check\.mjs/);
  });

  it("gate preview reports a repo-scoped gate's cache state from its declared repository", async () => {
    vi.stubEnv('CLEO_ROOT', project);
    vi.stubEnv('CLEO_DIR', join(project, '.cleo'));
    vi.stubEnv('CLEO_DISABLE_PROJECT_AUTOREGISTER', '1');
    try {
      const accessor = await createSqliteDataAccessor(project);
      const { task } = taskWith(sdkGate('sdk'));
      const textOnly: Task = { ...task, acceptance: ['the SDK ships'] };
      await accessor.transaction(async (tx) => {
        await tx.upsertSingleTask(textOnly);
        await tx.insertAcRows(buildFreshAcRows(task.id, ['the SDK ships']));
      });
      await reqAdd(project, task.id, sdkGate('sdk'), accessor);
      const preview = await previewTaskGates(project, { taskId: task.id });
      const sdkHead = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: sdk,
        encoding: 'utf-8',
      }).trim();
      expect(preview.results[0]?.result, preview.results[0]?.errorMessage).toBe('pass');
      expect(preview.cache?.entries[0]).toMatchObject({ repo: 'sdk', head: sdkHead, cached: true });
      expect(preview.cache?.head).not.toBe(sdkHead);
    } finally {
      await awaitBackgroundOps();
      closeDb();
      vi.unstubAllEnvs();
    }
  });
});
