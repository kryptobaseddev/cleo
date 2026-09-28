/**
 * `cleo done` record path (T12625).
 *
 * Real CLEO store in a real git repository with a real `origin`, so the gates
 * are recorded by the SAME `validateGateVerify` a `cleo verify --evidence`
 * uses. Pinned here:
 *
 *  1. one call records implemented + testsPassed + qaPassed, and the task then
 *     completes (AC1);
 *  2. every slow step — tools, typed gates — finishes before the write starts
 *     (AC2), with lint and typecheck in parallel ahead of test;
 *  3. the atoms are the validators' own: a stale commit is refused by them,
 *     not by a second check (AC3);
 *  4. CLEO_OWNER_OVERRIDE is refused and never audited as a bypass (AC4);
 *  5. blockers stop before any tool runs and before anything is written.
 *
 * @task T12625
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DoneBlockedDetails } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { addTask } from '../add.js';
import type { ChangeSetDeps } from '../change-set.js';
import { completeTask } from '../complete.js';
import { type RecordTaskDoneOptions, recordTaskDone } from '../done-record.js';
import { parseGateJson, reqAdd } from '../req.js';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
}

const deps: ChangeSetDeps = {
  listMergedPrs: async () => ({ ok: true, prs: [] }),
  listTaskDocs: async () => [],
  listTaskDecisions: async () => [],
  env: {},
};

let env: TestDbEnv;
let root: string;

function initRepo(dir: string): void {
  rmSync(join(dir, '.git'), { recursive: true, force: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(dir, '.gitignore'), '.cleo/\n.cleo-home/\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  const origin = `${dir}-origin.git`;
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git(dir, ['remote', 'add', 'origin', origin]);
  git(dir, ['push', '-q', '-u', 'origin', 'main']);
  git(dir, ['remote', 'set-head', 'origin', 'main']);
  writeFileSync(
    join(dir, '.cleo', 'project-context.json'),
    JSON.stringify({
      primaryType: 'node',
      testing: { command: 'node -e 0' },
      lint: { command: 'node -e 0' },
      typecheck: { command: 'node -e 0' },
    }),
  );
}

async function seedTask(acceptance: string[]): Promise<string> {
  const result = await addTask(
    {
      title: `done fixture ${acceptance.length}`,
      description: 'seeded fixture for the done record path',
      acceptance,
      skipContainmentInvariant: true,
    },
    root,
    env.accessor,
  );
  return result.task.id;
}

function commitOnTaskBranch(taskId: string): string {
  git(root, ['switch', '-q', '-c', `task/${taskId}`]);
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2;\n');
  git(root, ['commit', '-q', '-am', `${taskId}: change a`]);
  return git(root, ['rev-parse', 'HEAD']);
}

function opts(extra: Partial<RecordTaskDoneOptions> = {}): RecordTaskDoneOptions {
  return { projectRoot: root, cwd: root, deps, satisfies: 'all', agent: 'test', ...extra };
}

function gatesJsonl(): string {
  const path = join(root, '.cleo', 'audit', 'gates.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

beforeEach(async () => {
  env = await createTestDb();
  root = env.tempDir;
  process.env['CLEO_DIR'] = env.cleoDir;
  delete process.env['CLEO_OWNER_OVERRIDE'];
  delete process.env['CLEO_OWNER_OVERRIDE_REASON'];
  initRepo(root);
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  delete process.env['CLEO_OWNER_OVERRIDE'];
  delete process.env['CLEO_OWNER_OVERRIDE_REASON'];
  resetDbState();
  await env.cleanup();
  rmSync(`${root}-origin.git`, { recursive: true, force: true });
});

describe('one call records every required gate (AC1)', () => {
  it('records implemented, testsPassed and qaPassed, then the task completes', async () => {
    const id = await seedTask(['Change src/a.ts to return 2', 'Handles every edge case']);
    commitOnTaskBranch(id);

    const r = await recordTaskDone(id, opts());
    expect(r.success, JSON.stringify(r)).toBe(true);
    if (!r.success) return;
    expect(r.data.recordedGates).toEqual(['implemented', 'testsPassed', 'qaPassed']);
    expect(r.data.toolResults.map((t) => [t.tool, t.exitCode])).toEqual([
      ['lint', 0],
      ['typecheck', 0],
      ['test', 0],
    ]);
    expect(r.data.verificationPassed).toBe(true);

    const task = await env.accessor.loadSingleTask(id);
    expect(task?.verification?.gates).toMatchObject({
      implemented: true,
      testsPassed: true,
      qaPassed: true,
    });
    // Each gate carries its OWN atoms, not one string written three times.
    const kinds = (gate: 'implemented' | 'testsPassed' | 'qaPassed') =>
      task?.verification?.evidence?.[gate]?.atoms.map((a) => a.kind);
    expect(kinds('implemented')).toEqual(['commit', 'files', 'satisfies', 'satisfies']);
    expect(kinds('testsPassed')).toEqual(['tool', 'satisfies', 'satisfies']);
    expect(kinds('qaPassed')).toEqual(['tool', 'tool', 'satisfies', 'satisfies']);
    // One audit line per gate, like three single-gate writes.
    const lines = gatesJsonl()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { gate: string });
    expect(lines.map((l) => l.gate)).toEqual(['implemented', 'testsPassed', 'qaPassed']);

    await completeTask({ taskId: id }, root, env.accessor);
    expect((await env.accessor.loadSingleTask(id))?.status).toBe('done');
  });

  it('a second call records nothing new and leaves passed gates untouched', async () => {
    const id = await seedTask(['Change src/a.ts to return 2']);
    commitOnTaskBranch(id);
    expect((await recordTaskDone(id, opts())).success).toBe(true);
    const before = JSON.stringify((await env.accessor.loadSingleTask(id))?.verification);
    const again = await recordTaskDone(id, opts());
    expect(again.success && again.data.recordedGates).toEqual([]);
    expect(JSON.stringify((await env.accessor.loadSingleTask(id))?.verification)).toBe(before);
  });
});

describe('slow work finishes before the write (AC2)', () => {
  it('runs lint+typecheck in parallel, then test, then typed gates, and only then writes', async () => {
    const id = await seedTask(['Change src/a.ts to return 2']);
    await reqAdd(
      root,
      id,
      parseGateJson(
        JSON.stringify({
          kind: 'command',
          cmd: 'node',
          args: ['-e', '0'],
          req: 'R1',
          description: 'fixture gate',
        }),
      ),
      env.accessor,
    );
    commitOnTaskBranch(id);
    const log: string[] = [];
    let inFlight = 0;
    let maxParallel = 0;
    const r = await recordTaskDone(
      id,
      opts({
        steps: {
          runTool: async (tool) => {
            log.push(`start:${tool}`);
            inFlight++;
            maxParallel = Math.max(maxParallel, inFlight);
            await new Promise((res) => setTimeout(res, 30));
            inFlight--;
            log.push(`end:${tool}`);
            return { exitCode: 0, cacheHit: false, durationMs: 30, timedOut: false, tail: '' };
          },
          runTypedGates: async () => {
            log.push('typed');
            return { gateCount: 1, passed: true, failing: [] };
          },
          write: async (_root, params) => {
            log.push(`write:${Object.keys(params.gateEvidence).join(',')}:noRun=${params.noRun}`);
            return { success: true, data: { passed: true } };
          },
        },
      }),
    );
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(maxParallel).toBe(2);
    expect(log.slice(0, 4).sort()).toEqual([
      'end:lint',
      'end:typecheck',
      'start:lint',
      'start:typecheck',
    ]);
    expect(log.slice(4)).toEqual([
      'start:test',
      'end:test',
      'typed',
      'write:implemented,testsPassed,qaPassed:noRun=true',
    ]);
  });

  it('a failing tool stops before test and before any write', async () => {
    const id = await seedTask(['Change src/a.ts to return 2']);
    commitOnTaskBranch(id);
    const log: string[] = [];
    const r = await recordTaskDone(
      id,
      opts({
        steps: {
          runTool: async (tool) => {
            log.push(tool);
            return {
              exitCode: tool === 'lint' ? 1 : 0,
              cacheHit: false,
              durationMs: 1,
              timedOut: false,
              tail: 'lint: 3 errors',
            };
          },
          write: async () => {
            log.push('write');
            return { success: true, data: { passed: true } };
          },
        },
      }),
    );
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.code).toBe('E_DONE_BLOCKED');
    const details = r.error.details as DoneBlockedDetails;
    expect(details.blocker).toBe('tool-failed');
    expect(details.cause).toBe('E_EVIDENCE_TOOL_FAILED');
    expect(details.next.command).toContain('node -e 0');
    expect(log).not.toContain('test');
    expect(log).not.toContain('write');
  });
});

describe('blockers and the validators decide (AC3, AC4)', () => {
  it('a plan blocker stops before any tool runs, with one next step', async () => {
    const id = await seedTask(['Change src/a.ts to return 2', 'Handles every edge case']);
    commitOnTaskBranch(id);
    let ran = false;
    const r = await recordTaskDone(
      id,
      opts({
        satisfies: undefined,
        steps: {
          runTool: async () => {
            ran = true;
            return { exitCode: 0, cacheHit: false, durationMs: 0, timedOut: false, tail: '' };
          },
        },
      }),
    );
    expect(ran).toBe(false);
    expect(r.success).toBe(false);
    if (r.success) return;
    const details = r.error.details as DoneBlockedDetails;
    expect(details.blocker).toBe('ac-mapping-needed');
    expect(details.next.command).toBe(`cleo done ${id} --plan --satisfies AC2`);
    expect(r.error.fix).toBe(details.next.command);
  });

  it('evidence the validators refuse is E_DONE_BLOCKED with their code as the cause, and nothing is recorded', async () => {
    const id = await seedTask(['Change src/a.ts to return 2']);
    commitOnTaskBranch(id);
    // Rewrite history after planning would be racy; instead point the task at a
    // file the commit did not touch, which the EXISTING content-intersect check refuses.
    await env.accessor.updateTaskFields(id, { filesJson: JSON.stringify(['src/other.ts']) });
    const r = await recordTaskDone(id, opts());
    expect(r.success).toBe(false);
    if (r.success) return;
    const details = r.error.details as DoneBlockedDetails;
    expect(details.blocker).toBe('evidence-refused');
    expect(details.cause).toMatch(/^E_EVIDENCE_/);
    expect((await env.accessor.loadSingleTask(id))?.verification?.gates?.implemented).not.toBe(
      true,
    );
  });

  it('refuses CLEO_OWNER_OVERRIDE and writes no bypass line', async () => {
    const id = await seedTask(['Change src/a.ts to return 2']);
    commitOnTaskBranch(id);
    process.env['CLEO_OWNER_OVERRIDE'] = '1';
    process.env['CLEO_OWNER_OVERRIDE_REASON'] = 'test';
    const r = await recordTaskDone(id, opts());
    expect(r.success).toBe(false);
    if (r.success) return;
    expect((r.error.details as DoneBlockedDetails).cause).toBe('E_OVERRIDE_NOT_ACCEPTED');
    expect(existsSync(join(root, '.cleo', 'audit', 'force-bypass.jsonl'))).toBe(false);
    expect(gatesJsonl()).toBe('');
  });
});
