/**
 * `cleo done --plan` — the read-only evidence planner (T12623).
 *
 * The fixture is a real CLEO store inside a real git repository with a real
 * `origin`, so the plan is derived from the same git state `cleo verify`
 * validates. Pinned here:
 *
 *  1. conservative AC mapping — a criterion maps only when every path it
 *     names is in the diff; everything else is asked, never guessed;
 *  2. the planned atoms pass the EXISTING `validateAtom` and
 *     `checkTaskEvidenceContext`, so the plan is not a second validator;
 *  3. zero writes — task row, audit rows, `.cleo/audit` and the tool cache are
 *     byte-identical after planning;
 *  4. research and no-change-set tasks.
 *
 * @task T12623
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { EvidenceAtom, VerificationGate } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineSuccess } from '../../engine-result.js';
import { ResourceMonitor } from '../../resources/monitor.js';
import { _resetMemoryGateForTest } from '../../resources/pressure-gate.js';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { getTaskAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { validateGateVerify } from '../../validation/engine-ops.js';
import { addTask } from '../add.js';
import type { ChangeSetDeps } from '../change-set.js';
import { satisfyGatesFromMergedCi } from '../complete-ci.js';
import { type DeriveTaskEvidenceOptions, deriveTaskEvidence } from '../done-plan.js';
import { recordTaskDone } from '../done-record.js';
import {
  checkGateEvidenceMinimum,
  checkTaskEvidenceContext,
  parseEvidence,
  validateAtom,
} from '../evidence.js';
import { captureTreeHash, runToolCached } from '../tool-cache.js';
import { resolveToolCommand } from '../tool-resolver.js';
import { acquireGlobalSlot } from '../tool-semaphore.js';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
}

const deps: ChangeSetDeps = {
  listMergedPrs: async () => ({ ok: true, prs: [] }),
  listPrsForCommit: async () => [],
  listTaskDocs: async () => [],
  listTaskDecisions: async () => [],
  env: {},
};

let env: TestDbEnv;
let root: string;

/** Turn the fixture store into a git repo with an origin whose HEAD is main. */
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
  // Deterministic tools: every gate command resolves from project-context.
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

async function seedTask(acceptance: string[], kind: 'work' | 'research' = 'work') {
  const result = await addTask(
    {
      title: `plan fixture ${acceptance.length}`,
      description: `seeded fixture for the done planner (${kind})`,
      acceptance,
      kind,
      skipContainmentInvariant: true,
    },
    root,
    env.accessor,
  );
  return result.task.id;
}

/** Commit work on task/<id> touching src/a.ts. */
function commitOnTaskBranch(taskId: string): string {
  git(root, ['switch', '-q', '-c', `task/${taskId}`]);
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2;\n');
  git(root, ['commit', '-q', '-am', `${taskId}: change a`]);
  return git(root, ['rev-parse', 'HEAD']);
}

/** Hash every file under a directory (missing directory → empty map). */
function snapshotDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const path = join(dir, name);
    try {
      out[name] = createHash('sha256').update(readFileSync(path)).digest('hex');
    } catch {
      out[name] = 'dir';
    }
  }
  return out;
}

beforeEach(async () => {
  env = await createTestDb();
  root = env.tempDir;
  process.env['CLEO_DIR'] = env.cleoDir;
  initRepo(root);
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  resetDbState();
  await env.cleanup();
  rmSync(`${root}-origin.git`, { recursive: true, force: true });
});

describe('AC mapping is conservative', () => {
  it('maps an AC whose every named file is in the diff, and asks for the rest', async () => {
    const id = await seedTask(['Change src/a.ts to return 2', 'Handles every edge case']);
    commitOnTaskBranch(id);

    const plan = await deriveTaskEvidence(id, { projectRoot: root, cwd: root, deps });

    expect(plan.changeSet.source).toBe('branch');
    const [ac1, ac2] = plan.acMapping;
    expect(ac1).toMatchObject({ alias: 'AC1', mapped: true, basis: 'files-in-diff' });
    expect(ac1?.gates).toEqual(['implemented']);
    // "test"-like wording is NOT a mapping signal.
    expect(ac2).toMatchObject({ alias: 'AC2', mapped: false, basis: 'none', gates: [] });
    expect(plan.needsSatisfies).toEqual(['AC2']);
    expect(plan.ready).toBe(false);
    expect(plan.blockers.map((b) => b.code)).toEqual(['ac-mapping-needed']);
    expect(plan.next?.command).toBe(`cleo done ${id} --plan --satisfies AC2`);
  });

  it('an AC naming a file outside the diff stays unmapped', async () => {
    const id = await seedTask(['Change src/a.ts and src/b.ts together']);
    commitOnTaskBranch(id);
    const plan = await deriveTaskEvidence(id, { projectRoot: root, cwd: root, deps });
    expect(plan.acMapping[0]).toMatchObject({ mapped: false, basis: 'none' });
    expect(plan.acMapping[0]?.files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('a path-suffix match is not a match: src/a.ts does not map when only pkg/x/src/a.ts changed', async () => {
    const id = await seedTask(['Change src/a.ts to return 2']);
    git(root, ['switch', '-q', '-c', `task/${id}`]);
    mkdirSync(join(root, 'pkg', 'x', 'src'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'x', 'src', 'a.ts'), 'export const x = 1;\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', `${id}: nested a.ts only`]);

    const plan = await deriveTaskEvidence(id, { projectRoot: root, cwd: root, deps });
    expect(plan.changeSet.files).toEqual(['pkg/x/src/a.ts']);
    expect(plan.acMapping[0]).toMatchObject({ mapped: false, basis: 'none' });
    expect(plan.needsSatisfies).toEqual(['AC1']);
  });

  it('--satisfies fans the answer out to every gate and yields runnable commands', async () => {
    const id = await seedTask(['Change src/a.ts to return 2', 'Handles every edge case']);
    const head = commitOnTaskBranch(id);

    const plan = await deriveTaskEvidence(id, {
      projectRoot: root,
      cwd: root,
      deps,
      satisfies: ['ac2'],
    });

    expect(plan.acMapping[1]).toMatchObject({ basis: 'agent', mapped: true });
    expect(plan.acMapping[1]?.gates).toEqual(['implemented', 'testsPassed', 'qaPassed']);
    expect(plan.blockers).toEqual([]);
    expect(plan.ready).toBe(true);
    expect(plan.commands).toEqual([
      `cleo verify ${id} --gate implemented --evidence 'commit:${head};files:src/a.ts;satisfies:${id}#AC1;satisfies:${id}#AC2'`,
      `cleo verify ${id} --gate testsPassed --evidence 'tool:test;satisfies:${id}#AC2'`,
      `cleo verify ${id} --gate qaPassed --evidence 'tool:lint;tool:typecheck;satisfies:${id}#AC2'`,
      `cleo complete ${id}`,
    ]);
  });

  it('rejects a --satisfies alias the task does not have', async () => {
    const id = await seedTask(['Change src/a.ts']);
    await expect(
      deriveTaskEvidence(id, { projectRoot: root, cwd: root, deps, satisfies: ['AC9'] }),
    ).rejects.toThrow(/AC9/);
  });
});

describe('planned atoms pass the existing validators (T12623 AC3)', () => {
  it('validateAtom + gate minimum + checkTaskEvidenceContext accept the implemented plan', async () => {
    const id = await seedTask(['Change src/a.ts to return 2']);
    commitOnTaskBranch(id);
    const plan = await deriveTaskEvidence(id, { projectRoot: root, cwd: root, deps });
    const planned = plan.gates.find((g) => g.gate === 'implemented')?.evidence;
    expect(planned).toBeTruthy();

    const parsed = parseEvidence(planned ?? '');
    const context = {
      task: (await env.accessor.loadSingleTask(id))!,
      gates: ['implemented'] as VerificationGate[],
      criteria: await env.accessor.getAcRows(id),
    };
    const commitSha = parsed.atoms.find((a) => a.kind === 'commit');
    const atoms: EvidenceAtom[] = [];
    for (const atom of parsed.atoms) {
      const result = await validateAtom(
        atom,
        root,
        id,
        commitSha?.kind === 'commit' ? commitSha.sha : undefined,
        context,
      );
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      if (result.ok) atoms.push(result.atom);
    }
    expect(checkGateEvidenceMinimum('implemented', atoms)).toBeNull();
    expect(checkTaskEvidenceContext(context, 'implemented', atoms)).toBeNull();
  });
});

describe('tool runs are planned, never executed', () => {
  it('reports a fresh cached pass for a tool already run on this tree, and a miss otherwise', async () => {
    const id = await seedTask(['Change src/a.ts']);
    commitOnTaskBranch(id);
    const test = resolveToolCommand('test', root);
    if (!test.ok) throw new Error(test.reason);
    await runToolCached(test.command, root, { executionRoot: root, skipGlobalSemaphore: true });

    const plan = await deriveTaskEvidence(id, { projectRoot: root, cwd: root, deps });
    const byTool = Object.fromEntries(plan.toolRuns.map((r) => [r.tool, r.cache]));
    expect(byTool).toEqual({ test: 'fresh-pass', lint: 'miss', typecheck: 'miss' });
  });
});

describe('zero writes (T12623 AC2)', () => {
  it('leaves the task row, audit rows, .cleo/audit and the tool cache unchanged', async () => {
    const id = await seedTask(['Change src/a.ts to return 2', 'Handles every edge case']);
    commitOnTaskBranch(id);

    const before = {
      task: JSON.stringify(await env.accessor.loadSingleTask(id)),
      auditRows: JSON.stringify(await env.accessor.queryAuditLog({ taskIds: [id] })),
      auditDir: snapshotDir(join(root, '.cleo', 'audit')),
      cache: snapshotDir(join(root, '.cleo', 'cache')),
    };

    await deriveTaskEvidence(id, { projectRoot: root, cwd: root, deps });
    await deriveTaskEvidence(id, { projectRoot: root, cwd: root, deps, satisfies: 'all' });

    const after = {
      task: JSON.stringify(await env.accessor.loadSingleTask(id)),
      auditRows: JSON.stringify(await env.accessor.queryAuditLog({ taskIds: [id] })),
      auditDir: snapshotDir(join(root, '.cleo', 'audit')),
      cache: snapshotDir(join(root, '.cleo', 'cache')),
    };
    expect(after).toEqual(before);
  });
});

describe('merged-PR CI replaces local tool runs when the project opts in (T12634)', () => {
  async function mergedPrPlan(optIn: boolean, prepare?: (id: string) => Promise<void>) {
    const { id, prDeps } = await mergedPrSetup(optIn, prepare);
    return deriveTaskEvidence(id, { projectRoot: root, cwd: root, satisfies: 'all', deps: prDeps });
  }

  async function mergedPrSetup(optIn: boolean, prepare?: (id: string) => Promise<void>) {
    const id = await seedTask(['Change src/a.ts to return 2']);
    if (prepare) await prepare(id);
    commitOnTaskBranch(id);
    git(root, ['switch', '-q', 'main']);
    git(root, ['merge', '-q', '--squash', `task/${id}`]);
    git(root, ['commit', '-q', '-m', `${id}: squash (#42)`]);
    const merge = git(root, ['rev-parse', 'HEAD']);
    const ctxPath = join(root, '.cleo', 'project-context.json');
    const ctx = JSON.parse(readFileSync(ctxPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(
      ctxPath,
      JSON.stringify({
        ...ctx,
        evidence: {
          ciSatisfies: optIn,
          ciChecks: {
            tests: ['CI'],
            qa: ['CI'],
            jobs: { tests: ['Unit Tests*'], qa: ['Type Check'] },
          },
        },
      }),
    );
    const prDeps: ChangeSetDeps = {
      ...deps,
      listMergedPrs: async () => ({
        ok: true,
        prs: [{ number: 42, title: `${id}: work`, body: '', headRefName: `task/${id}` }],
      }),
      viewPr: async (n) => ({
        number: n,
        title: '',
        headRefName: `task/${id}`,
        baseRefName: 'main',
        state: 'MERGED',
        mergedAt: '2026-09-28T00:00:00Z',
        headRefOid: null,
        mergeCommitSha: merge,
      }),
      findPrByHead: async () => null,
      resolvePr: async (n) => ({
        ok: true,
        prNumber: n,
        mergeCommitSha: merge,
        mergedAt: '2026-09-28T00:00:00Z',
        successCount: 1,
        totalChecks: 1,
        cacheHit: false,
        title: '',
        body: '',
        headRefName: `task/${id}`,
        changedPaths: ['src/a.ts'],
        changedFileCount: 1,
      }),
    };
    return { id, prDeps };
  }

  /** Component #42 (task/<id>) merged into integration/i, which #41 squash-landed on main. */
  async function integrationSetup() {
    const id = await seedTask(['Change src/a.ts to return 2']);
    git(root, ['switch', '-q', '-c', 'integration/i']);
    writeFileSync(join(root, 'src', 'i.ts'), 'export const i = 1;\n');
    git(root, ['add', 'src/i.ts']);
    git(root, ['commit', '-q', '-m', 'integration work']);
    commitOnTaskBranch(id);
    git(root, ['switch', '-q', 'integration/i']);
    git(root, ['merge', '-q', '--no-ff', '-m', `Merge #42 ${id}`, `task/${id}`]);
    const componentMerge = git(root, ['rev-parse', 'HEAD']);
    git(root, ['switch', '-q', 'main']);
    git(root, ['merge', '-q', '--squash', 'integration/i']);
    git(root, ['commit', '-q', '-m', 'integration (#41)']);
    const integrationMerge = git(root, ['rev-parse', 'HEAD']);
    const ctxPath = join(root, '.cleo', 'project-context.json');
    const ctx = JSON.parse(readFileSync(ctxPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(
      ctxPath,
      JSON.stringify({
        ...ctx,
        evidence: {
          ciSatisfies: true,
          ciChecks: {
            tests: ['CI'],
            qa: ['CI'],
            jobs: { tests: ['Unit Tests*'], qa: ['Type Check'] },
          },
        },
      }),
    );
    const integration = {
      number: 41,
      title: 'integration',
      headRefName: 'integration/i',
      baseRefName: 'main',
      state: 'MERGED',
      mergedAt: '2026-09-28T00:00:00Z',
      headRefOid: componentMerge,
      mergeCommitSha: integrationMerge,
    };
    const prDeps: ChangeSetDeps = {
      ...deps,
      listMergedPrs: async () => ({
        ok: true,
        prs: [
          { number: 42, title: `${id}: work`, body: '', headRefName: `task/${id}` },
          { number: 41, title: 'integration', body: `lands ${id}`, headRefName: 'integration/i' },
        ],
      }),
      viewPr: async (n) =>
        n === 41
          ? integration
          : {
              ...integration,
              number: 42,
              title: `${id}: work`,
              headRefName: `task/${id}`,
              baseRefName: 'integration/i',
              headRefOid: null,
              mergeCommitSha: componentMerge,
            },
      findPrByHead: async () => integration,
      resolvePr: async (n) => ({
        ok: true,
        prNumber: n,
        mergeCommitSha: integrationMerge,
        mergedAt: '2026-09-28T00:00:00Z',
        successCount: 1,
        totalChecks: 1,
        cacheHit: false,
        title: 'integration',
        body: `lands ${id}`,
        headRefName: 'integration/i',
        headRefOid: componentMerge,
        changedPaths: ['src/a.ts', 'src/i.ts'],
        changedFileCount: 2,
      }),
    };
    return { id, prDeps };
  }

  it("a component landed by an integration PR uses the integration PR's CI: no tool run, not stacked (T12672)", async () => {
    const { id, prDeps } = await integrationSetup();
    for (const prNumber of [undefined, 41, 42]) {
      const plan = await deriveTaskEvidence(id, {
        projectRoot: root,
        cwd: root,
        satisfies: 'all',
        deps: prDeps,
        previewEvidence: async () => ({ ok: true }),
        ...(prNumber !== undefined ? { prNumber } : {}),
      });
      const label = `--pr ${prNumber ?? '(discovered)'}`;
      expect(plan.changeSet.stackedOn, label).toBeUndefined();
      expect(plan.changeSet.prNumber, label).toBe(41);
      expect(plan.changeSet.componentPrNumber, label).toBe(42);
      expect(plan.toolRuns, label).toEqual([]);
      expect(plan.blockers, label).toEqual([]);
      const ev = Object.fromEntries(plan.gates.map((g) => [g.gate, g.evidence]));
      // Both PR numbers, and the component's file only (not src/i.ts).
      expect(ev['implemented'], label).toBe(`pr:42@41;files:src/a.ts;satisfies:${id}#AC1`);
      expect(ev['testsPassed'], label).toBe(`ci:42@41;satisfies:${id}#AC1`);
      expect(ev['qaPassed'], label).toBe(`ci:42@41;satisfies:${id}#AC1`);
    }
  });

  it("--pr <component> GitHub marked MERGED (or closed by hand) plans the integration PR's CI, never its own (T12710)", async () => {
    const id = await seedTask(['Change src/a.ts to return 2']);
    const componentHead = commitOnTaskBranch(id);
    git(root, ['switch', '-q', 'main']);
    git(root, ['switch', '-q', '-c', 'integration/i']);
    writeFileSync(join(root, 'src', 'i.ts'), 'export const i = 1;\n');
    git(root, ['add', 'src/i.ts']);
    git(root, ['commit', '-q', '-m', 'integration work']);
    git(root, ['merge', '-q', '--no-ff', '-m', `Merge task/${id}`, `task/${id}`]);
    const intoIntegration = git(root, ['rev-parse', 'HEAD']);
    git(root, ['switch', '-q', 'main']);
    git(root, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #41', 'integration/i']);
    const landing = git(root, ['rev-parse', 'HEAD']);
    git(root, ['push', '-q', 'origin', 'main']);
    const ctxPath = join(root, '.cleo', 'project-context.json');
    const ctx = JSON.parse(readFileSync(ctxPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(
      ctxPath,
      JSON.stringify({
        ...ctx,
        evidence: {
          ciSatisfies: true,
          ciChecks: {
            tests: ['CI'],
            qa: ['CI'],
            jobs: { tests: ['Unit Tests*'], qa: ['Type Check'] },
          },
        },
      }),
    );
    const component = {
      number: 42,
      title: `${id}: work`,
      headRefName: `task/${id}`,
      baseRefName: 'main',
      mergedAt: null,
      headRefOid: componentHead,
      commits: [componentHead],
    };
    for (const shape of [
      { state: 'MERGED', mergeCommitSha: intoIntegration },
      { state: 'CLOSED', mergeCommitSha: null },
    ]) {
      const resolved: number[] = [];
      const plan = await deriveTaskEvidence(id, {
        projectRoot: root,
        cwd: root,
        satisfies: 'all',
        prNumber: 42,
        previewEvidence: async () => ({ ok: true }),
        deps: {
          ...deps,
          viewPr: async () => ({ ...component, ...shape }),
          findPrByHead: async () => null,
          resolvePr: async (n) => {
            resolved.push(n);
            return { ok: false, codeName: 'E_EVIDENCE_TESTS_FAILED', reason: 'own CI incomplete' };
          },
          landing: {
            prsByMergeCommit: async (sha) => ({
              ok: true,
              prs: [
                {
                  number: 41,
                  headRefName: 'integration/i',
                  baseRefName: 'main',
                  state: 'MERGED',
                  headRefOid: intoIntegration,
                  mergeCommitSha: sha,
                  body: `| #42 | ${id} |`,
                },
              ],
            }),
            prsListingComponent: async () => ({ ok: true, prs: [] }),
          },
        },
      });
      const label = shape.state;
      expect(resolved, label).toEqual([]);
      expect(plan.changeSet.prNumber, label).toBe(41);
      expect(plan.changeSet.componentPrNumber, label).toBe(42);
      expect(plan.changeSet.mergeCommitSha, label).toBe(landing);
      expect(plan.toolRuns, label).toEqual([]);
      expect(plan.blockers, label).toEqual([]);
      const ev = Object.fromEntries(plan.gates.map((g) => [g.gate, g.evidence]));
      expect(ev['implemented'], label).toBe(`pr:42@41;files:src/a.ts;satisfies:${id}#AC1`);
      expect(ev['testsPassed'], label).toBe(`ci:42@41;satisfies:${id}#AC1`);
      expect(ev['qaPassed'], label).toBe(`ci:42@41;satisfies:${id}#AC1`);
    }
  });

  it('a ci:/pr:-only close needs no task worktree, even when one is registered (T12671)', async () => {
    const { id, prDeps } = await mergedPrSetup(true);
    // A stale worktree still holds task/<id> after the merge.
    const stale = `${root}-wt`;
    git(root, ['worktree', 'add', '-q', stale, `task/${id}`]);
    try {
      const writes: string[] = [];
      const r = await recordTaskDone(id, {
        projectRoot: root,
        cwd: root,
        satisfies: 'all',
        deps: prDeps,
        previewEvidence: async () => ({ ok: true }),
        steps: {
          write: async (_root, params) => {
            writes.push(JSON.stringify(params.gateEvidence));
            return engineSuccess({ passed: true });
          },
        },
      });
      expect(r.success, JSON.stringify(r)).toBe(true);
      expect(r.success && r.data.plan.changeSet.rootSource).toBe('task-worktree');
      expect(r.success && r.data.toolResults).toEqual([]);
      expect(writes[0]).toMatch(/ci:42/);
    } finally {
      git(root, ['worktree', 'remove', '--force', stale]);
    }
  });

  it('with evidence.ciSatisfies, testsPassed and qaPassed plan ci:<pr> and no tool runs', async () => {
    const plan = await mergedPrPlan(true);
    expect(plan.changeSet.source).toBe('pr');
    expect(plan.toolRuns).toEqual([]);
    const ev = Object.fromEntries(plan.gates.map((g) => [g.gate, g.evidence]));
    expect(ev['testsPassed']).toBe(`ci:42;satisfies:${plan.taskId}#AC1`);
    expect(ev['qaPassed']).toBe(`ci:42;satisfies:${plan.taskId}#AC1`);
  });

  it('after merge, an affected-scope testsPassed is superseded: re-planned from merged CI (T12635)', async () => {
    const plan = await mergedPrPlan(true, async (id) => {
      const verification = {
        passed: false,
        round: 1,
        gates: { testsPassed: true },
        failureLog: [],
        lastAgent: null,
        lastUpdated: null,
        evidence: {
          testsPassed: {
            atoms: [
              {
                kind: 'tool',
                tool: 'test-affected',
                exitCode: 0,
                scope: 'affected',
                affectedPackages: ['@x/a'],
              },
            ],
            capturedAt: '2026-09-28T00:00:00Z',
            capturedBy: 'test',
          },
        },
      };
      await env.accessor.updateTaskFields(id, { verificationJson: JSON.stringify(verification) });
    });
    const tests = plan.gates.find((g) => g.gate === 'testsPassed');
    expect(tests?.passed).toBe(false);
    expect(tests?.evidence).toBe(`ci:42;satisfies:${plan.taskId}#AC1`);
    expect(plan.changeSet.warnings.join(' ')).toMatch(/scoped run/);
  });

  it('without the opt-in, the same PR still plans local tool runs', async () => {
    const plan = await mergedPrPlan(false);
    expect(plan.toolRuns.map((r) => r.tool)).toEqual(['test', 'lint', 'typecheck']);
    expect(plan.gates.find((g) => g.gate === 'testsPassed')?.evidence).toMatch(/^tool:test;/);
  });
});

describe('cleo done and cleo complete judge the merge alike (T12656 AC2, T12959 review)', () => {
  it('a fix commit made after the task PR merged: neither plans nor records ci:<that PR>', async () => {
    const id = await seedTask(['Change src/a.ts to return 2']);
    const first = commitOnTaskBranch(id);
    git(root, ['switch', '-q', 'main']);
    git(root, ['merge', '-q', '--squash', `task/${id}`]);
    git(root, ['commit', '-q', '-m', `${id}: squash (#42)`]);
    const merge = git(root, ['rev-parse', 'HEAD']);
    git(root, ['push', '-q', 'origin', 'main']);
    // New work on top of #42's merge, not merged anywhere.
    git(root, ['switch', '-q', '-c', `task/${id}-fix`]);
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 3;\n');
    git(root, ['commit', '-q', '-am', `${id}: fix`]);
    const fix = git(root, ['rev-parse', 'HEAD']);
    const ctxPath = join(root, '.cleo', 'project-context.json');
    const ctx = JSON.parse(readFileSync(ctxPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(
      ctxPath,
      JSON.stringify({
        ...ctx,
        evidence: {
          ciSatisfies: true,
          ciChecks: {
            tests: ['CI'],
            qa: ['CI'],
            jobs: { tests: ['Unit Tests*'], qa: ['Type Check'] },
          },
        },
      }),
    );
    await env.accessor.updateTaskFields(id, {
      verificationJson: JSON.stringify({
        passed: false,
        round: 1,
        gates: { implemented: true },
        failureLog: [],
        lastAgent: null,
        lastUpdated: null,
        evidence: {
          implemented: {
            atoms: [{ kind: 'commit', sha: fix, shortSha: fix.slice(0, 7) }],
            capturedAt: '2026-09-28T00:00:00Z',
            capturedBy: 'test',
          },
        },
      }),
    });
    const prDeps: ChangeSetDeps = {
      ...deps,
      listMergedPrs: async () => ({
        ok: true,
        prs: [{ number: 42, title: `${id}: work`, body: '', headRefName: `task/${id}` }],
      }),
      viewPr: async (n) => ({
        number: n,
        title: '',
        headRefName: `task/${id}`,
        baseRefName: 'main',
        state: 'MERGED',
        mergedAt: '2026-09-28T00:00:00Z',
        headRefOid: first,
        mergeCommitSha: merge,
        commits: [first],
      }),
      findPrByHead: async () => null,
      resolvePr: async (n) => ({
        ok: true,
        prNumber: n,
        mergeCommitSha: merge,
        mergedAt: '2026-09-28T00:00:00Z',
        successCount: 1,
        totalChecks: 1,
        cacheHit: false,
        title: '',
        body: '',
        headRefName: `task/${id}`,
        changedPaths: ['src/a.ts'],
        changedFileCount: 1,
      }),
    };

    const plan = await deriveTaskEvidence(id, {
      projectRoot: root,
      cwd: root,
      satisfies: 'all',
      deps: prDeps,
    });
    expect(plan.changeSet.prNumber).toBe(42);
    expect(plan.gates.find((g) => g.gate === 'testsPassed')?.evidence).toMatch(/^tool:test;/);

    const task = await env.accessor.loadSingleTask(id);
    if (!task) throw new Error('fixture task vanished');
    const ci = await satisfyGatesFromMergedCi(task, root, ['implemented', 'testsPassed'], {
      ciSatisfies: () => true,
      merge: { changeSet: prDeps },
      recordGates: async () => {
        throw new Error('must not record ci:42 for a fix #42 never ran');
      },
    });
    expect(ci).toEqual({ kind: 'skipped', testsPassedReason: null });
  });
});

describe('a worktree-bound test-run is judged in one root (T12965 review M2)', () => {
  it('bound in the task worktree; done --plan and complete, run from the main checkout, agree it stands', async () => {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "pkgs/*"\n');
    mkdirSync(join(root, 'pkgs', 'a'), { recursive: true });
    writeFileSync(join(root, 'pkgs', 'a', 'package.json'), JSON.stringify({ name: '@w/a' }));
    writeFileSync(join(root, 'pkgs', 'a', 'i.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'pkgs', 'a', 'a.test.ts'), 'export {};\n');
    writeFileSync(join(root, '.gitignore'), '.cleo/\n.cleo-home/\nreports/\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'workspace']);
    git(root, ['push', '-q', 'origin', 'main']);
    const id = await seedTask(['Change pkgs/a/i.ts']);
    git(root, ['branch', `task/${id}`]);
    const wt = `${root}-wt`;
    git(root, ['worktree', 'add', '-q', wt, `task/${id}`]);
    try {
      writeFileSync(join(wt, 'pkgs', 'a', 'i.ts'), 'export const x = 2;\n');
      git(wt, ['commit', '-q', '-am', `${id}: a`]);
      mkdirSync(join(wt, 'reports'), { recursive: true });
      const reportPath = join(wt, 'reports', 'vitest.json');
      writeFileSync(
        reportPath,
        JSON.stringify({
          startTime: Date.now() + 5_000,
          numTotalTests: 1,
          numPassedTests: 1,
          numFailedTests: 0,
          testResults: [
            {
              name: join(wt, 'pkgs', 'a', 'a.test.ts'),
              status: 'passed',
              assertionResults: [{ fullName: 'x', status: 'passed' }],
            },
          ],
        }),
      );
      const wtTree = await captureTreeHash(wt);
      expect(wtTree).not.toBe(await captureTreeHash(root));

      // Bound from the main checkout: the task's worktree is the tree bound.
      const bound = await validateAtom({ kind: 'test-run', path: reportPath }, root, id);
      expect(bound.ok, JSON.stringify(bound)).toBe(true);
      if (!bound.ok) return;
      expect(bound.atom).toMatchObject({ treeHash: wtTree });
      const verification = {
        passed: false,
        round: 1,
        gates: { testsPassed: true },
        failureLog: [],
        lastAgent: null,
        lastUpdated: null,
        evidence: {
          testsPassed: {
            atoms: [bound.atom],
            capturedAt: '2026-10-01T00:00:00Z',
            capturedBy: 'test',
          },
        },
      };
      await env.accessor.updateTaskFields(id, { verificationJson: JSON.stringify(verification) });

      const plan = await deriveTaskEvidence(id, { projectRoot: root, cwd: root, deps });
      expect(plan.changeSet.rootSource).toBe('task-worktree');
      expect(plan.gates.find((g) => g.gate === 'testsPassed')?.passed).toBe(true);
      expect(plan.changeSet.warnings.join(' ')).not.toMatch(/no longer describes/);

      const task = await env.accessor.loadSingleTask(id);
      if (!task) throw new Error('fixture task vanished');
      const ci = await satisfyGatesFromMergedCi(task, root, ['testsPassed'], {
        ciSatisfies: () => false,
        merge: { changeSet: deps },
      });
      expect(ci).toEqual({ kind: 'skipped', testsPassedReason: null });
    } finally {
      git(root, ['worktree', 'remove', '--force', wt]);
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe('affected-scope test runs (T12635, D11150)', () => {
  function workspaceWithPackages(withVitest = true): void {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "pkgs/*"\n');
    if (withVitest) {
      // The workspace's own vitest names the projects (a directory glob here).
      const vitestDir = dirname(createRequire(import.meta.url).resolve('vitest/package.json'));
      mkdirSync(join(root, 'node_modules'), { recursive: true });
      symlinkSync(vitestDir, join(root, 'node_modules', 'vitest'), 'dir');
      writeFileSync(join(root, '.gitignore'), '.cleo/\n.cleo-home/\nnode_modules/\n');
      writeFileSync(
        join(root, 'vitest.config.mjs'),
        "export default { test: { projects: ['pkgs/*'] } };\n",
      );
    }
    for (const [dir, name, deps] of [
      ['pkgs/a', '@w/a', {}],
      ['pkgs/b', '@w/b', { '@w/a': 'workspace:*' }],
      ['pkgs/c', '@w/c', {}],
    ] as const) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name, dependencies: deps }));
      writeFileSync(join(root, dir, 'i.ts'), 'export const x = 1;\n');
    }
    const ctxPath = join(root, '.cleo', 'project-context.json');
    const ctx = JSON.parse(readFileSync(ctxPath, 'utf-8')) as { testing: Record<string, unknown> };
    writeFileSync(
      ctxPath,
      JSON.stringify({
        ...ctx,
        testing: { ...ctx.testing, affectedCommand: 'pnpm exec vitest run {projects}' },
      }),
    );
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'workspace']);
    git(root, ['push', '-q', 'origin', 'main']);
  }

  it('before merge, testsPassed plans tool:test-affected over the changed package and its dependents', async () => {
    workspaceWithPackages();
    const id = await seedTask(['Change pkgs/a/i.ts']);
    git(root, ['switch', '-q', '-c', `task/${id}`]);
    writeFileSync(join(root, 'pkgs', 'a', 'i.ts'), 'export const x = 2;\n');
    git(root, ['commit', '-q', '-am', `${id}: a`]);
    const plan = await deriveTaskEvidence(id, {
      projectRoot: root,
      cwd: root,
      deps,
      satisfies: 'all',
    });
    const run = plan.toolRuns.find((r) => r.gate === 'testsPassed');
    expect(run).toMatchObject({
      tool: 'test-affected',
      command: 'pnpm exec vitest run --project @w/a --project @w/b',
    });
    expect(plan.gates.find((g) => g.gate === 'testsPassed')?.evidence).toBe(
      `tool:test-affected;satisfies:${id}#AC1`,
    );
  });

  it('T12959 review (L4): testing.preferAffected false plans the full tool:test, as tool:test runs it', async () => {
    workspaceWithPackages();
    const ctxPath = join(root, '.cleo', 'project-context.json');
    const ctx = JSON.parse(readFileSync(ctxPath, 'utf-8')) as { testing: Record<string, unknown> };
    writeFileSync(
      ctxPath,
      JSON.stringify({ ...ctx, testing: { ...ctx.testing, preferAffected: false } }),
    );
    const id = await seedTask(['Change pkgs/a/i.ts']);
    git(root, ['switch', '-q', '-c', `task/${id}`]);
    writeFileSync(join(root, 'pkgs', 'a', 'i.ts'), 'export const x = 2;\n');
    git(root, ['commit', '-q', '-am', `${id}: a`]);
    const plan = await deriveTaskEvidence(id, {
      projectRoot: root,
      cwd: root,
      deps,
      satisfies: 'all',
    });
    expect(plan.toolRuns.find((r) => r.gate === 'testsPassed')?.tool).toBe('test');
    expect(plan.gates.find((g) => g.gate === 'testsPassed')?.evidence).toBe(
      `tool:test;satisfies:${id}#AC1`,
    );
  });

  it('when vitest cannot name the projects, testsPassed falls back to the full tool:test', async () => {
    workspaceWithPackages(false);
    const id = await seedTask(['Change pkgs/a/i.ts']);
    git(root, ['switch', '-q', '-c', `task/${id}`]);
    writeFileSync(join(root, 'pkgs', 'a', 'i.ts'), 'export const x = 2;\n');
    git(root, ['commit', '-q', '-am', `${id}: a`]);
    const plan = await deriveTaskEvidence(id, {
      projectRoot: root,
      cwd: root,
      deps,
      satisfies: 'all',
    });
    expect(plan.toolRuns.find((r) => r.gate === 'testsPassed')?.tool).toBe('test');
  });

  it('T12656: when gh is unreachable the merge state is unknown, so testsPassed plans the full tool:test', async () => {
    workspaceWithPackages();
    const id = await seedTask(['Change pkgs/a/i.ts']);
    git(root, ['switch', '-q', '-c', `task/${id}`]);
    writeFileSync(join(root, 'pkgs', 'a', 'i.ts'), 'export const x = 2;\n');
    git(root, ['commit', '-q', '-am', `${id}: a`]);
    const plan = await deriveTaskEvidence(id, {
      projectRoot: root,
      cwd: root,
      satisfies: 'all',
      deps: { ...deps, listMergedPrs: async () => ({ ok: false, reason: 'gh timed out' }) },
    });
    expect(plan.changeSet.mergeState).toBe('unknown');
    expect(plan.toolRuns.find((r) => r.gate === 'testsPassed')?.tool).toBe('test');
  });

  it('T12656: --plan never waits for a busy machine budget; it reports the scope as pending', async () => {
    workspaceWithPackages();
    const id = await seedTask(['Change pkgs/a/i.ts']);
    git(root, ['switch', '-q', '-c', `task/${id}`]);
    writeFileSync(join(root, 'pkgs', 'a', 'i.ts'), 'export const x = 3;\n');
    git(root, ['commit', '-q', '-am', `${id}: a`]);
    // T13133: one run that fills the whole machine budget leaves no room for the probe.
    const release = await acquireGlobalSlot('test', { footprintBytes: Number.MAX_SAFE_INTEGER });
    try {
      const started = Date.now();
      const plan = await deriveTaskEvidence(id, {
        projectRoot: root,
        cwd: root,
        satisfies: 'all',
        deps,
      });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(plan.toolRuns.find((r) => r.gate === 'testsPassed')).toMatchObject({
        tool: 'test-affected',
        command: null,
        reason: 'scope pending: the machine budget is in use',
      });
    } finally {
      await release();
    }
  }, 30_000);

  it('T13133: under memory pressure --plan reports pressure, not a busy budget', async () => {
    workspaceWithPackages();
    const id = await seedTask(['Change pkgs/a/i.ts']);
    git(root, ['switch', '-q', '-c', `task/${id}`]);
    writeFileSync(join(root, 'pkgs', 'a', 'i.ts'), 'export const x = 4;\n');
    git(root, ['commit', '-q', '-am', `${id}: a`]);
    const saved = process.env['CLEO_ADMISSION_PRESSURE'];
    delete process.env['CLEO_ADMISSION_PRESSURE'];
    const line = { avg10: 40, avg60: 40, avg300: 40, totalUs: 0 };
    const spy = vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue({
      sampledAtMs: 1,
      pressureAvailable: true,
      memAvailableBytes: 1024 ** 3,
      globalPressure: { some: line, full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 } },
      slicePressure: null,
      walObservations: [],
    });
    try {
      const plan = await deriveTaskEvidence(id, {
        projectRoot: root,
        cwd: root,
        satisfies: 'all',
        deps,
      });
      expect(plan.toolRuns.find((r) => r.gate === 'testsPassed')).toMatchObject({
        tool: 'test-affected',
        command: null,
        reason: 'scope pending: memory pressure',
      });
    } finally {
      spy.mockRestore();
      _resetMemoryGateForTest();
      if (saved === undefined) delete process.env['CLEO_ADMISSION_PRESSURE'];
      else process.env['CLEO_ADMISSION_PRESSURE'] = saved;
    }
  }, 30_000);

  it('a workspace-wide change falls back to the full tool:test', async () => {
    workspaceWithPackages();
    const id = await seedTask(['Change the lockfile']);
    git(root, ['switch', '-q', '-c', `task/${id}`]);
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    git(root, ['add', 'pnpm-lock.yaml']);
    git(root, ['commit', '-q', '-m', `${id}: lock`]);
    const plan = await deriveTaskEvidence(id, {
      projectRoot: root,
      cwd: root,
      deps,
      satisfies: 'all',
    });
    expect(plan.toolRuns.find((r) => r.gate === 'testsPassed')?.tool).toBe('test');
  });
});

describe('the plan and done share one readiness check (T12672)', () => {
  async function researchWithUnknownDecision(): Promise<{
    id: string;
    opts: DeriveTaskEvidenceOptions;
  }> {
    const id = await seedTask(['Report the findings'], 'research');
    const content = '# findings\n';
    const sha = createHash('sha256').update(content).digest('hex');
    mkdirSync(join(root, '.cleo', 'blobs', 'blobs'), { recursive: true });
    writeFileSync(join(root, '.cleo', 'blobs', 'blobs', sha), content);
    return {
      id,
      opts: {
        projectRoot: root,
        cwd: root,
        satisfies: 'all',
        deps: {
          ...deps,
          listTaskDocs: async () => [{ id: 'att', slug: 'findings', sha256: sha }],
          listTaskDecisions: async () => ['D900'],
        },
      },
    };
  }

  it('evidence the validators refuse is a plan blocker, not a surprise at done', async () => {
    const { id, opts } = await researchWithUnknownDecision();
    const plan = await deriveTaskEvidence(id, opts);
    expect(plan.ready).toBe(false);
    expect(plan.blockers[0]).toMatchObject({
      code: 'evidence-refused',
      cause: 'E_EVIDENCE_INVALID_DECISION',
    });
    // done refuses for the SAME plan-visible reason, before any write.
    let wrote = false;
    const r = await recordTaskDone(id, {
      ...opts,
      steps: {
        write: async () => {
          wrote = true;
          return engineSuccess({ passed: true });
        },
      },
    });
    expect(!r.success && r.error.details).toMatchObject({
      blocker: 'evidence-refused',
      cause: 'E_EVIDENCE_INVALID_DECISION',
    });
    expect(wrote).toBe(false);
  });

  it('validateGateVerify preview validates without running a tool or writing (T12672)', async () => {
    const id = await seedTask(['Change src/a.ts to return 2']);
    const sha = commitOnTaskBranch(id);
    // A test command that would leave a marker (and fail) if it ever ran.
    writeFileSync(
      join(root, 'mark.cjs'),
      "require('fs').writeFileSync('ran', '1'); process.exit(1);\n",
    );
    const ctxPath = join(root, '.cleo', 'project-context.json');
    const ctx = JSON.parse(readFileSync(ctxPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(ctxPath, JSON.stringify({ ...ctx, testing: { command: 'node mark.cjs' } }));
    const before = JSON.stringify((await env.accessor.loadSingleTask(id))?.verification ?? null);
    const r = await validateGateVerify(root, {
      taskId: id,
      preview: true,
      gateEvidence: {
        implemented: `commit:${sha};files:src/a.ts;satisfies:${id}#AC1`,
        testsPassed: `tool:test;satisfies:${id}#AC1`,
      },
    });
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(r.success && r.data.action).toBe('preview');
    expect(existsSync(join(root, 'ran'))).toBe(false);
    resetDbState();
    const after = JSON.stringify(
      (await (await getTaskAccessor(root)).loadSingleTask(id))?.verification ?? null,
    );
    expect(after).toBe(before);
  });

  it('the preview never runs a tool', async () => {
    const id = await seedTask(['Change src/a.ts to return 2']);
    commitOnTaskBranch(id);
    const seen: string[] = [];
    const plan = await deriveTaskEvidence(id, {
      projectRoot: root,
      cwd: root,
      deps,
      satisfies: 'all',
      previewEvidence: async (_root, _id, gateEvidence) => {
        seen.push(...Object.keys(gateEvidence));
        return { ok: true };
      },
    });
    expect(plan.ready).toBe(true);
    expect(seen).toEqual(['implemented', 'testsPassed', 'qaPassed']);
    expect(plan.toolRuns.every((r) => r.cache !== 'hit')).toBe(true);
  });
});

describe('research and no-change-set tasks', () => {
  it('a research task with a doc and a decision plans decision-only gates with no tool runs', async () => {
    const id = await seedTask(['Report the findings'], 'research');
    const content = '# findings\n';
    const sha = createHash('sha256').update(content).digest('hex');
    mkdirSync(join(root, '.cleo', 'blobs', 'blobs'), { recursive: true });
    writeFileSync(join(root, '.cleo', 'blobs', 'blobs', sha), content);

    const plan = await deriveTaskEvidence(id, {
      projectRoot: root,
      cwd: root,
      satisfies: 'all',
      // The planned gates are under test here; D900 is not a stored decision.
      previewEvidence: async () => ({ ok: true }),
      deps: {
        ...deps,
        listTaskDocs: async () => [{ id: 'att', slug: 'findings', sha256: sha }],
        listTaskDecisions: async () => ['D900'],
      },
    });
    expect(plan.changeSet.source).toBe('docs');
    expect(plan.toolRuns).toEqual([]);
    const evidence = Object.fromEntries(plan.gates.map((g) => [g.gate, g.evidence]));
    expect(evidence['implemented']).toBe(
      `decision:D900;files:.cleo/blobs/blobs/${sha};note:Deliverable: findings;satisfies:${id}#AC1`,
    );
    expect(evidence['testsPassed']).toBe(
      `note:decision-only implementation, no code changed;satisfies:${id}#AC1`,
    );
    expect(plan.blockers).toEqual([]);
  });

  it('a task with no change set is blocked on it, with no complete command', async () => {
    const id = await seedTask(['Change src/a.ts']);
    const plan = await deriveTaskEvidence(id, { projectRoot: root, cwd: root, deps });
    expect(plan.changeSet.source).toBe('none');
    expect(plan.blockers[0]?.code).toBe('no-change-set');
    expect(plan.next?.command).toBe(`git switch -c task/${id}`);
    expect(plan.commands.some((c) => c.startsWith('cleo complete'))).toBe(false);
    expect(plan.ready).toBe(false);
  });
});
