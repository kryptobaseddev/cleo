/**
 * T10105 — keep `cleo release open --field` lockstep with
 * `.github/workflows/release-prepare.yml workflow_dispatch.inputs`.
 *
 * The pre-T10105 implementation passed a `plan-blob-sha256` field that the
 * workflow does not declare; the GitHub Actions API rejects unknown
 * inputs with HTTP 422 "Unexpected inputs provided". This test parses
 * both the YAML and the runtime call list and asserts they agree.
 *
 * Failure modes covered:
 *   - YAML declares an input not passed by `cleo release open` → MISSING.
 *   - `cleo release open` passes a `--field foo=bar` whose key is not in
 *     the YAML → EXTRA.
 *
 * @task T10105
 * @epic E-RELEASE-PLAN-CHANGELOG
 * @saga T10099
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ReleasePlan } from '@cleocode/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { closeDb, getDb, resetDbState } from '../../store/sqlite.js';
import * as schema from '../../store/tasks-schema.js';
import { DEFAULT_OPEN_WORKFLOW, type ReleaseOpenRunner, releaseOpen } from '../open.js';

let testDir: string;

// Canonical path to release-prepare.yml in the actual repo. Resolved from
// __dirname so the test works in any cwd.
const REPO_WORKFLOW_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '.github',
  'workflows',
  'release-prepare.yml',
);

type WorkflowInputSchema = Record<string, { required?: boolean } | null | undefined>;

function readWorkflowInputs(): WorkflowInputSchema {
  const raw = readFileSync(REPO_WORKFLOW_PATH, 'utf8');
  const parsed = parseYaml(raw) as {
    on?: { workflow_dispatch?: { inputs?: WorkflowInputSchema } };
  };
  return parsed.on?.workflow_dispatch?.inputs ?? {};
}

function readWorkflowInputKeys(): string[] {
  return Object.keys(readWorkflowInputs());
}

function readRequiredWorkflowInputKeys(): string[] {
  return Object.entries(readWorkflowInputs())
    .filter(([, config]) => config?.required === true)
    .map(([key]) => key);
}

function makePlan(version: string): ReleasePlan {
  const nowIso = new Date().toISOString();
  return {
    $schema: 'https://cleocode.io/schemas/release-plan/v1.json',
    version,
    resolvedVersion: version,
    suffixApplied: false,
    scheme: 'calver',
    channel: 'latest',
    epicId: 'T9999',
    releaseKind: 'regular',
    createdAt: nowIso,
    createdBy: 'test',
    previousVersion: null,
    previousTag: null,
    previousShippedAt: null,
    tasks: [
      {
        id: 'T10001',
        kind: 'feat',
        impact: 'minor',
        userFacingSummary: 'Test feature',
        evidenceAtoms: ['commit:abc1234567'],
        epicAncestor: 'T9999',
      },
    ],
    changelog: { features: ['T10001'], fixes: [], chores: [], breaking: [] },
    gates: [
      { name: 'test', atom: 'tool:test', status: 'passed', lastVerifiedAt: nowIso },
      { name: 'build', atom: 'tool:build', status: 'passed', lastVerifiedAt: nowIso },
      { name: 'lint', atom: 'tool:lint', status: 'passed', lastVerifiedAt: nowIso },
      { name: 'typecheck', atom: 'tool:typecheck', status: 'passed', lastVerifiedAt: nowIso },
      { name: 'audit', atom: 'tool:audit', status: 'skipped', lastVerifiedAt: nowIso },
      {
        name: 'security-scan',
        atom: 'tool:security-scan',
        status: 'skipped',
        lastVerifiedAt: nowIso,
      },
    ],
    platformMatrix: [{ platform: 'any', publisher: 'npm', package: '@cleocode/cleo' }],
    preflightSummary: {
      esbuildExternalsDrift: false,
      lockfileDrift: false,
      epicCompletenessClean: true,
      doubleListingClean: true,
      preflightWarnings: [],
    },
    workflowRunUrl: null,
    prUrl: null,
    mergeCommitSha: null,
    status: 'planned',
    meta: { firstEverRelease: true, archetype: 'node' },
  };
}

function writePlanFile(version: string): string {
  const releaseDir = join(testDir, '.cleo', 'release');
  mkdirSync(releaseDir, { recursive: true });
  const planPath = join(releaseDir, `${version}.plan.json`);
  writeFileSync(planPath, `${JSON.stringify(makePlan(version), null, 2)}\n`, 'utf-8');
  return planPath;
}

/**
 * Put the plan on `origin/main`, as a merged release-plan PR does: `cleo
 * release open --no-commit-plan` dispatches only a plan verified there
 * (T13050).
 */
function publishPlan(planPath: string): void {
  const remote = join(
    testDir,
    '..',
    `remote-${Date.now()}-${Math.random().toString(16).slice(2)}.git`,
  );
  execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', remote]);
  execFileSync('git', ['-C', testDir, 'remote', 'add', 'origin', remote]);
  execFileSync('git', ['-C', testDir, 'checkout', '-q', '-B', 'main']);
  execFileSync('git', ['-C', testDir, 'add', '-f', planPath]);
  execFileSync('git', ['-C', testDir, 'commit', '-q', '-m', 'chore(release): plan']);
  execFileSync('git', ['-C', testDir, 'push', '-q', '-u', 'origin', 'main']);
}

function writeStubWorkflow(): void {
  const workflowDir = join(testDir, '.github', 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    join(workflowDir, DEFAULT_OPEN_WORKFLOW),
    'name: release-prepare\non: workflow_dispatch\njobs: {}\n',
    'utf-8',
  );
}

async function seedReleaseRow(version: string): Promise<void> {
  const db = await getDb(testDir);
  await db
    .insert(schema.releases)
    .values({
      id: `testhash:${version}`,
      version,
      scheme: 'calver',
      channel: 'latest',
      epicId: null,
      releaseKind: 'regular',
      status: 'planned',
      plannedAt: new Date().toISOString(),
      projectHash: 'testhash',
    })
    .run();
}

function makeStubRunner(): ReleaseOpenRunner & {
  calls: Array<{ cmd: string; args: readonly string[] }>;
} {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  return {
    calls,
    checkGhAuth: () => {
      calls.push({ cmd: 'gh', args: ['auth', 'status'] });
      return true;
    },
    runGh: (args) => {
      calls.push({ cmd: 'gh', args });
      if (args[0] === 'workflow' && args[1] === 'run') return '';
      if (args[0] === 'repo' && args[1] === 'view') return 'main';
      if (args[0] === 'run' && args[1] === 'list') {
        return JSON.stringify([
          {
            url: 'https://github.com/cleocode/cleo/actions/runs/12345',
            databaseId: 12345,
            status: 'in_progress',
          },
        ]);
      }
      return '';
    },
  };
}

// Validate release state from each explicitly initialized fixture project.
beforeEach(() => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});
afterEach(() => vi.unstubAllEnvs());

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-open-field-schema-'));
  await mkdir(join(testDir, '.cleo'), { recursive: true });
  writeFileSync(
    join(testDir, '.cleo', 'config.json'),
    JSON.stringify({
      enforcement: { session: { requiredForMutate: false } },
      lifecycle: { mode: 'off' },
      verification: { enabled: false },
    }),
  );
  writeFileSync(
    join(testDir, '.cleo', 'project-info.json'),
    JSON.stringify({
      projectHash: 'testhash',
      projectId: 'test-project-id',
      projectRoot: testDir,
      projectName: 'test',
    }),
  );
  execFileSync('git', ['init', '--quiet', testDir], { encoding: 'utf-8' });
  execFileSync('git', ['-C', testDir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', testDir, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', testDir, 'config', 'commit.gpgsign', 'false']);
  resetDbState();
});

afterEach(async () => {
  try {
    closeDb();
  } catch {
    /* best-effort */
  }
  await rm(testDir, { recursive: true, force: true });
});

describe('releaseOpen — workflow input schema parity (T10105)', () => {
  it('forwards the plan SCOPE, and both scope keys are declared in the YAML (T12089)', async () => {
    // Why this case exists: `release open` used to dispatch ONLY `version`. The
    // workflow then regenerated the plan, and `cleo release plan` requires
    // `--saga | --epic | --tasks`, so it exited 2 at "Prepare bump-PR" — AFTER
    // lint, typecheck, both test shards and build had all passed. Every release
    // died there.
    //
    // The pre-existing parity case cannot catch this: it dispatches without a
    // scope, so `epic`/`tasks` never appear among the passed keys and an
    // undeclared input would sail through to a live HTTP 422.
    const version = 'v2026.6.1';
    publishPlan(writePlanFile(version));
    writeStubWorkflow();
    await seedReleaseRow(version);

    const runner = makeStubRunner();
    const result = await releaseOpen(
      { version, projectRoot: testDir, commitPlan: false, epic: 'T9999', tasks: 'T101,T102' },
      runner,
    );
    expect(result.success).toBe(true);

    const dispatched = runner.calls.find((c) => c.args[0] === 'workflow' && c.args[1] === 'run');
    expect(dispatched).toBeDefined();

    const passed = new Map<string, string>();
    const args = dispatched?.args ?? [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--field' && typeof args[i + 1] === 'string') {
        const pair = args[i + 1] as string;
        const eq = pair.indexOf('=');
        if (eq > 0) passed.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    }

    // The scope actually rides along...
    expect(passed.get('epic')).toBe('T9999');
    expect(passed.get('tasks')).toBe('T101,T102');

    // ...and both keys are declared in the REAL workflow, so the GitHub Actions
    // API cannot reject the dispatch with "Unexpected inputs provided".
    const declared = readWorkflowInputKeys();
    expect(declared).toContain('epic');
    expect(declared).toContain('tasks');
  });

  it('omits the scope fields entirely when no scope was supplied', async () => {
    // An empty `--field epic=` would be sent as a real (empty) input, and the
    // workflow's `-n` guard would treat it as absent anyway — but passing empty
    // values muddies the audit trail of what was actually dispatched.
    const version = 'v2026.6.2';
    publishPlan(writePlanFile(version));
    writeStubWorkflow();
    await seedReleaseRow(version);

    const runner = makeStubRunner();
    await releaseOpen(
      { version, projectRoot: testDir, commitPlan: false, epic: '', tasks: '' },
      runner,
    );

    const dispatched = runner.calls.find((c) => c.args[0] === 'workflow' && c.args[1] === 'run');
    const joined = (dispatched?.args ?? []).join(' ');
    expect(joined).not.toContain('epic=');
    expect(joined).not.toContain('tasks=');
  });

  it('forwards the preflight skip decision for main HEAD, and every key is declared in the YAML', async () => {
    // `cleo release open` skips release-prepare's test suites whose result
    // GitHub already holds for the commit the workflow will check out. The
    // decision rides along as inputs — so each of them must be declared, or
    // the dispatch is rejected with HTTP 422 "Unexpected inputs provided".
    const version = 'v2026.6.3';
    publishPlan(writePlanFile(version));
    writeStubWorkflow();
    await seedReleaseRow(version);

    const sha = 'c'.repeat(40);
    const base = makeStubRunner();
    const runner: ReleaseOpenRunner & { calls: Array<{ cmd: string; args: readonly string[] }> } = {
      calls: base.calls,
      checkGhAuth: base.checkGhAuth,
      runGh: (args, cwd) => {
        const endpoint = args[1] ?? '';
        if (args[0] === 'repo' && args[1] === 'view') {
          base.calls.push({ cmd: 'gh', args });
          return 'main';
        }
        if (args[0] === 'api') {
          base.calls.push({ cmd: 'gh', args });
          if (endpoint.includes('/commits/main')) return sha;
          const run = (id: number, event: string) => ({
            id,
            head_sha: sha,
            status: 'completed',
            conclusion: 'success',
            event,
            html_url: `https://github.com/o/r/actions/runs/${id}`,
          });
          if (endpoint.includes('/actions/workflows/ci.yml/runs')) {
            return JSON.stringify({ workflow_runs: [run(1, 'push')] });
          }
          if (endpoint.includes('event=schedule')) {
            return JSON.stringify({ workflow_runs: [run(2, 'schedule')] });
          }
          if (endpoint.includes('/actions/runs/1/jobs')) {
            // A green push run skips Linux tests only if its Linux Unit Tests
            // shards actually ran (a docs-only push is green with none).
            return JSON.stringify({
              jobs: [
                { name: 'Unit Tests (ubuntu-latest, shard 1)', conclusion: 'success' },
                { name: 'Unit Tests (ubuntu-latest, shard 2)', conclusion: 'success' },
              ],
            });
          }
          if (endpoint.includes('/actions/runs/2/jobs')) {
            return JSON.stringify({
              jobs: [{ name: 'Unit Tests (macos-latest, shard 1)', conclusion: 'success' }],
            });
          }
          return JSON.stringify({ jobs: [] });
        }
        return base.runGh(args, cwd);
      },
    };

    const result = await releaseOpen({ version, projectRoot: testDir, commitPlan: false }, runner);
    expect(result.success).toBe(true);
    expect(result.data?.preflight).toMatchObject({
      verifiedSha: sha,
      skipTests: true,
      skipMacosTests: true,
    });

    const dispatched = runner.calls.find((c) => c.args[0] === 'workflow' && c.args[1] === 'run');
    const passed = new Map<string, string>();
    const args = dispatched?.args ?? [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--field' && typeof args[i + 1] === 'string') {
        const pair = args[i + 1] as string;
        const eq = pair.indexOf('=');
        if (eq > 0) passed.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    }
    expect(passed.get('skip-tests')).toBe('true');
    expect(passed.get('skip-macos-tests')).toBe('true');
    expect(passed.get('verified-sha')).toBe(sha);
    expect(passed.get('skip-reason')).toContain('Linux tests skipped');

    const declared = readWorkflowInputKeys();
    for (const key of passed.keys()) expect(declared).toContain(key);
  });

  it('release-prepare.yml declares `version` as the only required input', () => {
    const requiredInputs = readRequiredWorkflowInputKeys();
    expect(requiredInputs.sort()).toEqual(['version']);
  });

  it('`cleo release open` passes ONLY fields declared in the workflow YAML', async () => {
    const version = 'v2026.6.0';
    publishPlan(writePlanFile(version));
    writeStubWorkflow();
    await seedReleaseRow(version);

    const runner = makeStubRunner();
    const result = await releaseOpen({ version, projectRoot: testDir, commitPlan: false }, runner);
    expect(result.success).toBe(true);

    const dispatched = runner.calls.find((c) => c.args[0] === 'workflow' && c.args[1] === 'run');
    expect(dispatched).toBeDefined();

    // Collect every `--field key=val` pair.
    const passedKeys: string[] = [];
    if (dispatched) {
      const args = dispatched.args;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--field' && typeof args[i + 1] === 'string') {
          const eq = (args[i + 1] as string).indexOf('=');
          if (eq > 0) passedKeys.push((args[i + 1] as string).slice(0, eq));
        }
      }
    }

    const declaredKeys = readWorkflowInputKeys();
    const requiredKeys = readRequiredWorkflowInputKeys();

    // EXTRA check — every key passed at runtime MUST be declared in YAML.
    const extra = passedKeys.filter((k) => !declaredKeys.includes(k));
    expect(extra).toEqual([]);

    // MISSING check — every REQUIRED YAML input MUST be passed at runtime.
    const missing = requiredKeys.filter((k) => !passedKeys.includes(k));
    expect(missing).toEqual([]);

    // T10105's 422 was `plan-blob-sha256` sent while the YAML did not declare
    // it; the EXTRA check above is what locks that out. The YAML declares it
    // now, and the verified plan's hash MUST ride along (T12092, T13050):
    // without it the workflow regenerates the plan, which cannot work.
    expect(passedKeys).toContain('plan-blob-sha256');
    expect(declaredKeys).toContain('plan-blob-sha256');

    // The releases row was nevertheless updated — the dispatch succeeded.
    const db = await getDb(testDir);
    const rows = await db
      .select()
      .from(schema.releases)
      .where(eq(schema.releases.version, version))
      .all();
    expect(rows[0]?.status).toBe('pr-opened');
  });
});
