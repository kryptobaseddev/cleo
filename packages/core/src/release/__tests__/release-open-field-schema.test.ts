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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

function readWorkflowInputs(): string[] {
  const raw = readFileSync(REPO_WORKFLOW_PATH, 'utf8');
  const parsed = parseYaml(raw) as {
    on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
  };
  const inputs = parsed.on?.workflow_dispatch?.inputs;
  if (inputs === undefined || inputs === null) return [];
  return Object.keys(inputs);
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
  it('release-prepare.yml declares exactly the `version` input', () => {
    const inputs = readWorkflowInputs();
    expect(inputs.sort()).toEqual(['version']);
  });

  it('`cleo release open` passes ONLY fields declared in the workflow YAML', async () => {
    const version = 'v2026.6.0';
    writePlanFile(version);
    writeStubWorkflow();
    await seedReleaseRow(version);

    const runner = makeStubRunner();
    const result = await releaseOpen({ version, projectRoot: testDir }, runner);
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

    const declaredKeys = readWorkflowInputs();

    // EXTRA check — every key passed at runtime MUST be declared in YAML.
    const extra = passedKeys.filter((k) => !declaredKeys.includes(k));
    expect(extra).toEqual([]);

    // MISSING check — every REQUIRED YAML input MUST be passed at runtime.
    // (We assume `required: true` for every declared input today; if that
    //  ever changes, refine to parse the per-key `required:` flag.)
    const missing = declaredKeys.filter((k) => !passedKeys.includes(k));
    expect(missing).toEqual([]);

    // Belt-and-braces: `plan-blob-sha256` MUST NOT be passed (T10105
    // regression lock — this was the v2026.5.100 silent-422 bug).
    expect(passedKeys).not.toContain('plan-blob-sha256');

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
